/**
 * PHASE 2 / Step 6 — R2 attachment storage (DORMANT / NOT DEPLOYED).
 *
 * R2 is skipped in this rollout: the routes are not mounted in the API router
 * and no ATTACHMENTS_BUCKET binding exists. This module is retained only as
 * reference code and for its unit tests. Google Sheets is the only production
 * storage backend.
 */
import { callGas } from './gas-client.js';
import { createRepository } from './repository.js';
import { requirePermission } from './rbac.js';
import { assertScope } from './scope.js';

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const ALLOWED_TYPES = Object.freeze([
  'image/jpeg', 'image/png', 'application/pdf'
]);

const ENTITY_TYPES = new Set(['CHEQUE', 'GUARANTEE', 'DEPOSIT']);
const ENTITY_TABLES = { CHEQUE: 'cheques', GUARANTEE: 'guarantees' };

export function attachmentError(code, message, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

/** Strip paths, control characters and unsafe punctuation; keep Unicode letters. */
export function sanitizeFileName(name) {
  const cleaned = String(name || 'file')
    .replace(/^.*[\\/]/, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

/** attachments/<ENTITY>/<entityId>/<uuid>-<safeName> */
export function buildR2Key(entityType, entityId, fileName, uuid) {
  const safeEntity = String(entityType).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const safeId = String(entityId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const safeName = sanitizeFileName(fileName).replace(/\s+/g, '_');
  return `attachments/${safeEntity}/${safeId}/${uuid}-${safeName}`;
}

export function validateUpload(input = {}) {
  const entityType = String(input.entityType || '').toUpperCase();
  const entityId = String(input.entityId || '').trim();
  if (!ENTITY_TYPES.has(entityType) || !entityId) {
    throw attachmentError('VALIDATION_ERROR', 'A valid entityType and entityId are required.', 400);
  }
  const file = input.file;
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw attachmentError('VALIDATION_ERROR', 'A file is required.', 400);
  }
  const type = String(file.type || '').toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) {
    throw attachmentError('FILE_TYPE_REJECTED',
      'Only JPEG, PNG and PDF files are allowed.', 422);
  }
  if (Number(file.size || 0) > MAX_FILE_SIZE) {
    throw attachmentError('FILE_TOO_LARGE', 'Files must be 10 MB or smaller.', 422);
  }
  return { entityType, entityId, file, type };
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => ('0' + b.toString(16)).slice(-2)).join('');
}

function bucketFor(env) {
  if (!env.ATTACHMENTS_BUCKET) {
    throw attachmentError('STORAGE_UNAVAILABLE', 'Attachment storage is not configured.', 503);
  }
  return env.ATTACHMENTS_BUCKET;
}

/**
 * Scope is checked against the parent document, not the metadata row (which
 * has no warehouse column). Deposits may live in either deposits table.
 */
async function assertParentScope(env, ctx, repo, attachment) {
  const role = ctx.actor?.role;
  if (role === 'ADMIN' || role === 'AUDITOR') return;

  const table = ENTITY_TABLES[attachment.entity_type];
  const candidates = table ? [table] : ['deposits_hq', 'deposits_branch'];
  for (const entity of candidates) {
    try {
      const parent = (await repo.get(entity, String(attachment.entity_id))).data;
      assertScope(ctx, parent);
      return;
    } catch (err) {
      if (err.code === 'FORBIDDEN') throw err;
      // NOT_FOUND / upstream errors: try the next candidate.
    }
  }
  throw attachmentError('FORBIDDEN', 'Attachment parent is outside your scope.', 403);
}

/** Parse multipart/form-data (route is flagged `multipart` in the router). */
export async function readUploadRequest(request) {
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    throw attachmentError('VALIDATION_ERROR', 'Expected multipart/form-data.', 400);
  }
  return {
    entityType: String(form.get('entityType') || ''),
    entityId: String(form.get('entityId') || ''),
    file: form.get('file')
  };
}

export async function upload(env, ctx, input = {}) {
  requirePermission(ctx, 'attachments.create');
  const { entityType, entityId, file, type } = validateUpload(input);
  const bucket = bucketFor(env);
  const repo = createRepository(env, ctx);

  // Fail closed for scoped roles before writing any object.
  await assertParentScope(env, ctx, repo, { entity_type: entityType, entity_id: entityId });

  const attachmentId = crypto.randomUUID();
  const r2Key = buildR2Key(entityType, entityId, file.name, attachmentId);
  const bytes = await file.arrayBuffer();
  const checksum = await sha256Hex(bytes);
  const uploadedBy = ctx.actor?.userId || 'system';

  await bucket.put(r2Key, bytes, {
    httpMetadata: { contentType: type },
    customMetadata: {
      'entity-type': entityType,
      'entity-id': entityId,
      'uploaded-by': uploadedBy,
      checksum
    }
  });

  try {
    const result = await callGas(env, ctx, 'attachment.create', 'attachments', {
      attachment_id: attachmentId,
      entity_type: entityType,
      entity_id: entityId,
      file_name: sanitizeFileName(file.name),
      r2_key: r2Key,
      uploaded_by: uploadedBy,
      content_type: type,
      size_bytes: bytes.byteLength,
      checksum
    });
    return result.data;
  } catch (err) {
    // No orphan objects: metadata is the source of truth.
    try { await bucket.delete(r2Key); } catch (cleanupError) { /* best effort */ }
    throw err;
  }
}

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'attachments.read');
  const repo = createRepository(env, ctx);
  const result = await repo.call('attachment.list', 'attachments', {
    entityType: String(query.entityType || '').toUpperCase(),
    entityId: String(query.entityId || ''),
    limit: query.limit ? Number(query.limit) : 200
  });

  const role = ctx.actor?.role;
  if (role === 'ADMIN' || role === 'AUDITOR') return result.data || [];

  // Scoped roles: keep only attachments whose parent document is in scope.
  const allowed = [];
  for (const attachment of result.data || []) {
    try {
      await assertParentScope(env, ctx, repo, attachment);
      allowed.push(attachment);
    } catch (err) {
      // Skip out-of-scope rows instead of leaking their metadata.
    }
  }
  return allowed;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'attachments.read');
  const repo = createRepository(env, ctx);
  const attachment = (await repo.call('attachment.get', 'attachments', { attachmentId: id })).data;
  await assertParentScope(env, ctx, repo, attachment);
  return attachment;
}

function contentDisposition(fileName) {
  const ascii = String(fileName).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Authorised streaming proxy — returns a raw Response (not an API envelope). */
export async function download(env, ctx, id) {
  const attachment = await get(env, ctx, id);
  const bucket = bucketFor(env);
  const object = await bucket.get(attachment.r2_key);
  if (!object) {
    throw attachmentError('OBJECT_MISSING', 'The attachment file is missing.', 404);
  }
  const headers = new Headers({
    'Content-Type': attachment.content_type || 'application/octet-stream',
    'Content-Disposition': contentDisposition(attachment.file_name),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    Vary: 'Origin'
  });
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

export async function remove(env, ctx, id) {
  requirePermission(ctx, 'attachments.delete');
  const repo = createRepository(env, ctx);
  const attachment = (await repo.call('attachment.get', 'attachments', { attachmentId: id })).data;
  await assertParentScope(env, ctx, repo, attachment);

  const result = (await repo.call('attachment.delete', 'attachments', { attachmentId: id })).data;
  try {
    await bucketFor(env).delete(attachment.r2_key);
  } catch (err) {
    // Metadata is already revoked; a lifecycle sweep will remove the object.
  }
  return result;
}
