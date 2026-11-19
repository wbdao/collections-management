/**
 * PHASE 2 / Step 12 — R2 backup orchestration (DORMANT / NOT DEPLOYED).
 *
 * R2 is skipped in this rollout: the routes are not mounted in the API router,
 * no BACKUPS_BUCKET binding exists, and the daily trigger is inert. This module
 * is retained only as reference code and for its unit tests. Google Sheets is
 * the only production storage backend.
 */
import { callGas } from './gas-client.js';
import { requirePermission } from './rbac.js';

export const RETENTION_DAYS = 90;
export const CHECKPOINT_RETENTION_DAYS = 180;

export function backupError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}

/** backups/<yyyy>/<mm>/<dd>/<backup-id>.json */
export function backupKey(backupId, generatedAt) {
  const date = new Date(generatedAt || Date.now());
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const safeId = String(backupId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `backups/${yyyy}/${mm}/${dd}/${safeId}.json`;
}

/** backups/checkpoints/audit-tip-<yyyy-mm-dd>.txt */
export function checkpointKey(generatedAt) {
  const date = new Date(generatedAt || Date.now());
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `backups/checkpoints/audit-tip-${yyyy}-${mm}-${dd}.txt`;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => ('0' + b.toString(16)).slice(-2)).join('');
}

async function sha256Hex(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** BACKUP_SIGNING_KEY proves a backup was produced by this platform. */
async function signature(env, checksum) {
  if (!env.BACKUP_SIGNING_KEY) return '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.BACKUP_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(checksum)));
}

function bucketFor(env) {
  if (!env.BACKUPS_BUCKET) {
    throw backupError('STORAGE_UNAVAILABLE', 'Backup storage is not configured.', 503);
  }
  return env.BACKUPS_BUCKET;
}

async function markFailed(env, ctx, backupId, error) {
  try {
    await callGas(env, ctx, 'backup.fail', 'backups', {
      backupId: backupId || '',
      errorCode: error?.code || 'BACKUP_FAILED',
      message: error?.message || 'Backup failed',
      stage: 'r2-write'
    });
  } catch (logError) {
    // The ledger write is best-effort here; the caller still receives the error.
  }
}

/**
 * POST /admin/backups.
 *
 * `input` may carry a pre-collected payload from the Apps Script daily trigger
 * (`backupId` + `payload` + `checksum`). An ADMIN calling manually without a
 * payload causes the edge to collect one through `backup.start` first.
 */
export async function create(env, ctx, input = {}) {
  requirePermission(ctx, 'backups.create');
  const bucket = bucketFor(env);

  let backup;
  let payload;
  let expectedChecksum;
  let auditTip;
  let generatedAt;

  if (input.backupId && input.payload && input.checksum) {
    backup = { backup_id: input.backupId };
    payload = input.payload;
    expectedChecksum = input.checksum;
    auditTip = input.auditTip || '';
    generatedAt = input.generatedAt || new Date().toISOString();
  } else {
    const collected = (await callGas(env, ctx, 'backup.start', 'backups', {})).data;
    backup = collected.backup;
    payload = collected.payload;
    expectedChecksum = collected.checksum;
    auditTip = collected.auditTip || '';
    generatedAt = collected.generatedAt || new Date().toISOString();
  }

  const bytes = new TextEncoder().encode(payload);
  const actualChecksum = await sha256Hex(bytes);
  if (actualChecksum !== expectedChecksum) {
    const error = backupError('CHECKSUM_MISMATCH', 'Backup payload checksum mismatch', 422);
    await markFailed(env, ctx, backup.backup_id, error);
    throw error;
  }

  const key = backupKey(backup.backup_id, generatedAt);
  const retentionUntil = new Date(Date.parse(generatedAt) + RETENTION_DAYS * 86400000).toISOString();
  const sig = await signature(env, expectedChecksum);
  const actor = ctx.actor?.userId || 'system';

  try {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        'entity-type': 'BACKUP',
        'backup-id': backup.backup_id,
        'uploaded-by': actor,
        checksum: expectedChecksum,
        'backup-signature': sig,
        'retention-days': String(RETENTION_DAYS),
        'audit-tip': auditTip
      }
    });

    // External audit anchor: survives independently of the audit sheet.
    await bucket.put(checkpointKey(generatedAt), auditTip, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: {
        'entity-type': 'AUDIT_CHECKPOINT',
        'retention-days': String(CHECKPOINT_RETENTION_DAYS),
        'backup-id': backup.backup_id,
        checksum: expectedChecksum
      }
    });

    return (await callGas(env, ctx, 'backup.complete', 'backups', {
      backupId: backup.backup_id,
      r2Key: key,
      sizeBytes: bytes.byteLength,
      checksum: expectedChecksum,
      retentionUntil,
      auditTip
    })).data;
  } catch (error) {
    // No half-written backup: remove the object if the metadata step failed.
    try { await bucket.delete(key); } catch (cleanupError) { /* best effort */ }
    await markFailed(env, ctx, backup.backup_id, error);
    throw error;
  }
}

/** GET /admin/backups — ledger plus 90-day retention status. */
export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'backups.read');
  const result = await callGas(env, ctx, 'backup.list', 'backups', {
    status: query.status || '',
    limit: query.limit ? Number(query.limit) : 200
  });
  return result.data;
}
