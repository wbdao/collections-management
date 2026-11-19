/** PHASE 2 / Step 12 — GAS backup payload/ledger and edge R2 orchestration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  RETENTION_DAYS, CHECKPOINT_RETENTION_DAYS, backupError,
  backupKey, checkpointKey, create, list
} from '../functions/_lib/backups.js';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import { loadGs } from './helpers/gas-harness.js';

const CTX = {
  requestId: 'req-bak', ip: '203.0.113.5',
  actor: { userId: 'admin', username: 'admin', role: 'ADMIN', permissions: ['*'], scopes: [] }
};

const BASE_ENV = {
  GAS_URL: 'https://example.com/exec',
  GAS_SHARED_SECRET: 'test-secret',
  BACKUP_SIGNING_KEY: 'signing-key'
};

/* -------------------------------------------------------------------------- */
/* Mock signed edge→GAS transport                                               */
/* -------------------------------------------------------------------------- */

async function withGas(handlers, callback) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const envelope = JSON.parse(options.body);
    calls.push(envelope);
    const handler = handlers[envelope.action];
    const result = handler ? await handler(envelope) : { ok: true, data: {} };
    const payload = result.ok === false ? result
      : { ok: true, data: result.data || {}, meta: result.meta || {} };
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ...payload }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function fakeBucket(opts = {}) {
  const state = { puts: [], deletes: [] };
  return {
    state,
    async put(key, value, options) {
      if (opts.failOn && opts.failOn(key)) throw new Error('R2 put failed');
      state.puts.push({ key, value, options });
    },
    async get(key) { return (opts.objects || {})[key] || null; },
    async delete(key) { state.deletes.push(key); }
  };
}

function sha256Hex(payload) {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function collectedPayload(backupId = 'BAK-1') {
  const payload = JSON.stringify({ schema: 'cms-backup/v1', backupId, workbooks: [] });
  return {
    backupId,
    backup: { backup_id: backupId },
    payload,
    checksum: sha256Hex(payload),
    auditTip: 'AUDIT-TIP-ABC',
    generatedAt: '2026-01-15T02:00:00.000Z'
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                 */
/* -------------------------------------------------------------------------- */

test('retention constants match the documented policy', () => {
  assert.equal(RETENTION_DAYS, 90);
  assert.equal(CHECKPOINT_RETENTION_DAYS, 180);
});

test('backupKey and checkpointKey follow the documented layout', () => {
  assert.equal(backupKey('BAK-1', '2026-01-15T02:00:00.000Z'),
    'backups/2026/01/15/BAK-1.json');
  assert.equal(backupKey('BAK/1 weird', '2026-12-31T23:59:00.000Z'),
    'backups/2026/12/31/BAK_1_weird.json');
  assert.equal(checkpointKey('2026-01-15T02:00:00.000Z'),
    'backups/checkpoints/audit-tip-2026-01-15.txt');
});

test('backupError carries a stable API-safe code', () => {
  const err = backupError('STORAGE_UNAVAILABLE', 'no bucket');
  assert.equal(err.code, 'STORAGE_UNAVAILABLE');
  assert.equal(err.status, 503);
});

/* -------------------------------------------------------------------------- */
/* Edge orchestration                                                           */
/* -------------------------------------------------------------------------- */

test('create() verifies checksum, writes R2 objects, then finalises the ledger', async () => {
  const bucket = fakeBucket();
  const collected = collectedPayload();
  await withGas({
    'backup.start': () => ({ ok: true, data: collected }),
    'backup.complete': (e) => {
      assert.equal(e.payload.backupId, 'BAK-1');
      assert.equal(e.payload.r2Key, 'backups/2026/01/15/BAK-1.json');
      assert.equal(e.payload.checksum, collected.checksum);
      assert.equal(e.payload.sizeBytes, new TextEncoder().encode(collected.payload).byteLength);
      assert.equal(e.payload.retentionUntil, '2026-04-15T02:00:00.000Z');
      return { ok: true, data: { backup_id: 'BAK-1', status: 'COMPLETED' } };
    }
  }, async (calls) => {
    const result = await create({ ...BASE_ENV, BACKUPS_BUCKET: bucket }, CTX, {});
    assert.equal(result.status, 'COMPLETED');
    assert.equal(calls[0].action, 'backup.start');
    assert.equal(calls[1].action, 'backup.complete');
  });

  assert.equal(bucket.state.puts.length, 2);
  const [objectPut, checkpointPut] = bucket.state.puts;
  assert.equal(objectPut.key, 'backups/2026/01/15/BAK-1.json');
  assert.equal(objectPut.options.httpMetadata.contentType, 'application/json');
  assert.equal(objectPut.options.customMetadata['entity-type'], 'BACKUP');
  assert.equal(objectPut.options.customMetadata['backup-id'], 'BAK-1');
  assert.equal(objectPut.options.customMetadata['uploaded-by'], 'admin');
  assert.equal(objectPut.options.customMetadata.checksum, collected.checksum);
  assert.equal(objectPut.options.customMetadata['retention-days'], '90');
  assert.equal(objectPut.options.customMetadata['audit-tip'], 'AUDIT-TIP-ABC');
  assert.match(objectPut.options.customMetadata['backup-signature'], /^[0-9a-f]{64}$/);
  assert.equal(checkpointPut.key, 'backups/checkpoints/audit-tip-2026-01-15.txt');
  assert.equal(checkpointPut.value, 'AUDIT-TIP-ABC');
  assert.equal(checkpointPut.options.customMetadata['entity-type'], 'AUDIT_CHECKPOINT');
  assert.equal(checkpointPut.options.customMetadata['retention-days'], '180');
  assert.equal(bucket.state.deletes.length, 0);
});

test('create() accepts a pre-collected payload from the daily trigger (no backup.start)', async () => {
  const bucket = fakeBucket();
  const collected = collectedPayload('BAK-TRIGGER');
  await withGas({
    'backup.start': () => { throw new Error('should not be called'); },
    'backup.complete': () => ({ ok: true, data: { backup_id: 'BAK-TRIGGER', status: 'COMPLETED' } })
  }, async (calls) => {
    await create({ ...BASE_ENV, BACKUPS_BUCKET: bucket }, CTX, collected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'backup.complete');
  });
  assert.equal(bucket.state.puts[0].key, 'backups/2026/01/15/BAK-TRIGGER.json');
});

test('a checksum mismatch fails the ledger and writes nothing to R2', async () => {
  const bucket = fakeBucket();
  const collected = collectedPayload();
  collected.checksum = '0'.repeat(64); // deliberately wrong
  let failed = null;
  await withGas({
    'backup.complete': () => { throw new Error('should not be called'); },
    'backup.fail': (e) => {
      failed = e.payload;
      return { ok: true, data: {} };
    }
  }, async () => {
    await assert.rejects(
      () => create({ ...BASE_ENV, BACKUPS_BUCKET: bucket }, CTX, collected),
      (err) => err.code === 'CHECKSUM_MISMATCH' && err.status === 422
    );
  });
  assert.equal(bucket.state.puts.length, 0);
  assert.ok(failed);
  assert.equal(failed.backupId, 'BAK-1');
  assert.equal(failed.errorCode, 'CHECKSUM_MISMATCH');
});

test('an R2 write failure removes the partial object and records BACKUP_FAILED', async () => {
  const bucket = fakeBucket({ failOn: (key) => key.endsWith('.json') && !key.includes('checkpoints') });
  const collected = collectedPayload('BAK-FAIL');
  let failed = null;
  await withGas({
    'backup.complete': () => { throw new Error('should not be called'); },
    'backup.fail': (e) => { failed = e.payload; return { ok: true, data: {} }; }
  }, async () => {
    await assert.rejects(
      () => create({ ...BASE_ENV, BACKUPS_BUCKET: bucket }, CTX, collected),
      (err) => /R2 put failed/.test(err.message)
    );
  });
  assert.deepEqual(bucket.state.deletes, ['backups/2026/01/15/BAK-FAIL.json']);
  assert.equal(failed.errorCode, 'BACKUP_FAILED');
  assert.equal(failed.stage, 'r2-write');
});

test('create() requires a configured bucket and backups.create permission', async () => {
  await assert.rejects(() => create(BASE_ENV, CTX, collectedPayload()),
    (err) => err.code === 'STORAGE_UNAVAILABLE');
  await assert.rejects(
    () => create({ ...BASE_ENV, BACKUPS_BUCKET: fakeBucket() },
      { ...CTX, actor: { userId: 'u', role: 'COLLECTOR', permissions: [] } }, collectedPayload()),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('list() requires backups.read and forwards filters', async () => {
  await assert.rejects(
    () => list(BASE_ENV, { ...CTX, actor: { userId: 'u', role: 'COLLECTOR', permissions: [] } }),
    (err) => err.code === 'FORBIDDEN'
  );
  await withGas({
    'backup.list': (e) => {
      assert.equal(e.payload.status, 'COMPLETED');
      assert.equal(e.payload.limit, 5);
      return { ok: true, data: { items: [], retention: { policyDays: 90 } } };
    }
  }, async () => {
    const data = await list(BASE_ENV, CTX, { status: 'COMPLETED', limit: '5' });
    assert.equal(data.retention.policyDays, 90);
  });
});

/* -------------------------------------------------------------------------- */
/* Middleware service-token auth                                                */
/* -------------------------------------------------------------------------- */

test('POST /admin/backups accepts the Apps Script service token without a JWT', async () => {
  const env = { BACKUP_SERVICE_TOKEN: 'svc-token' };
  let captured = null;
  const context = {
    request: new Request('https://example.com/api/v1/admin/backups', {
      method: 'POST', headers: { 'X-Backup-Token': 'svc-token' }
    }),
    env,
    data: {},
    next: () => { captured = context.data.cms; return new Response('ok'); }
  };
  const response = await middleware(context);
  assert.equal(response.status, 200);
  assert.ok(captured);
  assert.equal(captured.actor.userId, 'SYSTEM');
  assert.equal(captured.actor.role, 'ADMIN');
  assert.deepEqual(captured.actor.permissions, ['*']);
  assert.equal(captured.backupServiceCall, true);
});

test('POST /admin/backups rejects a wrong service token when no Bearer token exists', async () => {
  const env = { BACKUP_SERVICE_TOKEN: 'svc-token' };
  const response = await middleware({
    request: new Request('https://example.com/api/v1/admin/backups', {
      method: 'POST', headers: { 'X-Backup-Token': 'wrong' }
    }),
    env,
    data: {},
    next: () => new Response('ok')
  });
  assert.equal(response.status, 401);
  assert.equal(await response.json().then((b) => b.error.code), 'UNAUTHORIZED');
});

/* -------------------------------------------------------------------------- */
/* GAS BackupService                                                            */
/* -------------------------------------------------------------------------- */

function backupHarness() {
  // Do NOT load the real audit-service.gs: its `var AuditService` would
  // overwrite the capturing mock below (VM harness caveat).
  const h = loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/backup-service.gs'
  ], {
    AuditService: {
      write() { return {}; },
      chainStatus() { return { tip: 'TIP-123', records: 42 }; }
    },
    CONFIG: {
      coreSpreadsheetId: 'CORE', docsSpreadsheetId: 'DOCS', auditSpreadsheetId: 'AUDIT'
    },
    TABLES: {
      backups: { sheet: 'tbl_backups', id: 'backup_id', columns: ['backup_id'] },
      settings: { sheet: 'tbl_settings', columns: ['key'] },
      books: { sheet: 'tbl_books', columns: ['book_id'] }
    }
  });
  h.sandbox.SheetsAdapter.insertRow('settings', {
    key: 'auth.mfa.enforce', value_json: 'false', updated_by: 'system', updated_at: '2026-01-01T00:00:00.000Z'
  });
  return h;
}

const GAS_CTX = { requestId: 'REQ-B', ip: 'scheduler', actor: { role: 'ADMIN', userId: 'SYSTEM' } };

test('GAS backup.start collects an ASCII payload, checksum and RUNNING ledger row', () => {
  const h = backupHarness();
  const result = h.sandbox.BackupService.start(GAS_CTX);

  assert.match(result.payload, /^[\x00-\x7F]*$/);
  const snapshot = JSON.parse(result.payload);
  assert.equal(snapshot.schema, 'cms-backup/v1');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.backupId, result.backup.backup_id);
  assert.equal(snapshot.auditTip, 'TIP-123');
  assert.equal(snapshot.auditRecords, 42);
  assert.equal(snapshot.settings.length, 1);
  assert.equal(snapshot.workbooks.length, 3);
  assert.deepEqual(snapshot.workbooks.map((w) => w.workbookId), ['CORE', 'DOCS', 'AUDIT']);
  const core = snapshot.workbooks.find((w) => w.workbookId === 'CORE');
  assert.ok(core.sheets.some((s) => s.entity === 'books'));
  assert.match(result.checksum, /^[0-9a-f]{64}$/);
  assert.equal(sha256Hex(result.payload), result.checksum);

  assert.equal(result.backup.status, 'RUNNING');
  assert.equal(result.backup.scope, 'FULL_WORKBOOKS');
  assert.equal(result.checkpointRetentionDays, 180);
  const days = (Date.parse(result.backup.retention_until) - Date.parse(result.backup.started_at)) / 86400000;
  assert.equal(Math.round(days), 90);
  assert.equal(h.store.rows.backups.length, 1);
});

test('GAS backup.complete finalises after checksum verification and is idempotent', () => {
  const h = backupHarness();
  const started = h.sandbox.BackupService.start(GAS_CTX);
  const input = {
    backupId: started.backup.backup_id,
    checksum: started.checksum,
    r2Key: 'backups/2026/01/15/x.json',
    sizeBytes: 123
  };
  const done = h.sandbox.BackupService.complete(GAS_CTX, input);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.r2_key, input.r2Key);
  assert.equal(done.size_bytes, 123);
  assert.equal(Number(h.store.rows.backups[0].version), 2);

  // Idempotent retry is a no-op on the ledger.
  const again = h.sandbox.BackupService.complete(GAS_CTX, input);
  assert.equal(again.status, 'COMPLETED');
  assert.equal(Number(h.store.rows.backups[0].version), 2);

  // A tampered checksum is rejected.
  assert.throws(
    () => h.sandbox.BackupService.complete(GAS_CTX, { ...input, backupId: 'BAK-OTHER', checksum: 'bad' }),
    (err) => err.code === 'NOT_FOUND'
  );
  h.sandbox.SheetsAdapter.insertRow('backups', {
    backup_id: 'BAK-X', status: 'RUNNING', checksum: 'expected', version: 1
  });
  assert.throws(
    () => h.sandbox.BackupService.complete(GAS_CTX, { backupId: 'BAK-X', checksum: 'wrong' }),
    (err) => err.code === 'CHECKSUM_MISMATCH'
  );
});

test('GAS backup.fail creates a FAILED ledger row and CRITICAL security event', () => {
  const h = backupHarness();
  const result = h.sandbox.BackupService.fail(GAS_CTX, {
    errorCode: 'BACKUP_EDGE_ERROR', message: 'HTTP 500', stage: 'dispatch'
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(h.store.rows.backups.length, 1);
  assert.equal(h.securityEvents.length, 1);
  assert.equal(h.securityEvents[0].eventType, 'BACKUP_FAILED');
  assert.equal(h.securityEvents[0].severity, 'CRITICAL');
  assert.equal(h.securityEvents[0].details.stage, 'dispatch');
});

test('GAS backup.fail updates an existing RUNNING row to FAILED', () => {
  const h = backupHarness();
  const started = h.sandbox.BackupService.start(GAS_CTX);
  const result = h.sandbox.BackupService.fail(GAS_CTX, {
    backupId: started.backup.backup_id, errorCode: 'R2_ERROR', stage: 'r2-write'
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(h.store.rows.backups.length, 1);
  assert.equal(Number(h.store.rows.backups[0].version), 2);
  assert.equal(h.securityEvents[0].details.stage, 'r2-write');
});

test('GAS backup.list exposes a 90-day retention summary and expiry flags', () => {
  const h = backupHarness();
  const started = h.sandbox.BackupService.start(GAS_CTX);
  h.sandbox.BackupService.complete(GAS_CTX, {
    backupId: started.backup.backup_id, checksum: started.checksum
  });
  h.sandbox.SheetsAdapter.insertRow('backups', {
    backup_id: 'BAK-OLD', scope: 'FULL_WORKBOOKS', workbook_ids: '[]',
    r2_key: '', size_bytes: 0, checksum: '', status: 'COMPLETED',
    started_at: '2020-01-01T00:00:00.000Z', completed_at: '2020-01-01T00:00:01.000Z',
    retention_until: '2020-04-01T00:00:00.000Z'
  });

  const all = h.sandbox.BackupService.list({});
  assert.equal(all.retention.policyDays, 90);
  assert.equal(all.retention.checkpointPolicyDays, 180);
  assert.equal(all.retention.completed, 2);
  assert.equal(all.retention.expired, 1);
  assert.equal(all.items.find((r) => r.backup_id === 'BAK-OLD').expired, true);
  assert.equal(all.items.find((r) => r.backup_id === started.backup.backup_id).expired, false);
  assert.equal(h.sandbox.BackupService.list({ status: 'FAILED' }).items.length, 0);
});
