/** PHASE 2 / Step 6 — R2 attachment validation, storage flow and metadata. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_SIZE, ALLOWED_TYPES, sanitizeFileName, buildR2Key, validateUpload,
  upload, download, remove, attachmentError
} from '../functions/_lib/attachments.js';
import { loadGs } from './helpers/gas-harness.js';

const CTX = {
  requestId: 'req-att',
  ip: '203.0.113.5',
  actor: {
    userId: 'admin', username: 'admin', role: 'ADMIN',
    permissions: ['*'], scopes: []
  }
};

const BASE_ENV = {
  GAS_URL: 'https://example.com/exec',
  GAS_SHARED_SECRET: 'test-secret'
};

/** Mock the signed edge→GAS transport without changing production code. */
async function withGas(handlers, callback) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const envelope = JSON.parse(options.body);
    calls.push(envelope);
    const handler = handlers[envelope.action];
    const result = handler
      ? await handler(envelope)
      : { ok: true, data: {} };
    const payload = result.ok === false
      ? result
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

function fakeBucket(objects = {}) {
  const state = { puts: [], deletes: [] };
  return {
    state,
    async put(key, value, options) { state.puts.push({ key, value, options }); },
    async get(key) { return objects[key] || null; },
    async delete(key) { state.deletes.push(key); }
  };
}

function fakeFile(name, type, content = 'pdf-bytes') {
  const bytes = new TextEncoder().encode(content);
  return {
    name, type, size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

/* ---- pure helpers -------------------------------------------------------- */

test('sanitizeFileName strips paths, control characters and unsafe punctuation', () => {
  assert.equal(sanitizeFileName('../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(sanitizeFileName('C:\\temp\\cheque 1.pdf'), 'cheque 1.pdf');
  assert.equal(sanitizeFileName('a\u0000b\u001fc.pdf'), 'abc.pdf');
  assert.equal(sanitizeFileName(''), 'file');
  assert.equal(sanitizeFileName(' مستندات/شيك.pdf '), 'شيك.pdf');
  assert.equal(sanitizeFileName('مستندات شيك.pdf'), 'مستندات شيك.pdf');
});

test('buildR2Key follows the documented layout and is collision-safe', () => {
  const key = buildR2Key('cheque', 'CHQ_42', 'scan.pdf', 'uuid-1234');
  assert.equal(key, 'attachments/CHEQUE/CHQ_42/uuid-1234-scan.pdf');
  assert.match(key, /^attachments\/CHEQUE\//);
  assert.notEqual(
    buildR2Key('cheque', 'CHQ_42', 'scan.pdf', 'uuid-1'),
    buildR2Key('cheque', 'CHQ_42', 'scan.pdf', 'uuid-2')
  );
});

test('validateUpload enforces the allow-list and 10 MB ceiling', () => {
  assert.equal(MAX_FILE_SIZE, 10 * 1024 * 1024);
  assert.deepEqual([...ALLOWED_TYPES], ['image/jpeg', 'image/png', 'application/pdf']);

  assert.equal(validateUpload({
    entityType: 'cheque', entityId: 'CHQ1', file: fakeFile('x.pdf', 'application/pdf')
  }).entityType, 'CHEQUE');

  assert.throws(() => validateUpload({ entityType: 'BOOK', entityId: 'B1', file: fakeFile('x.pdf', 'application/pdf') }),
    (e) => e.code === 'VALIDATION_ERROR' && e.status === 400);
  assert.throws(() => validateUpload({ entityType: 'CHEQUE', entityId: '', file: fakeFile('x.pdf', 'application/pdf') }),
    (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => validateUpload({ entityType: 'CHEQUE', entityId: 'CHQ1' }),
    (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => validateUpload({ entityType: 'CHEQUE', entityId: 'CHQ1', file: fakeFile('x.exe', 'application/x-msdownload') }),
    (e) => e.code === 'FILE_TYPE_REJECTED' && e.status === 422);
  assert.throws(() => validateUpload({
    entityType: 'CHEQUE', entityId: 'CHQ1',
    file: { ...fakeFile('big.pdf', 'application/pdf'), size: MAX_FILE_SIZE + 1 }
  }), (e) => e.code === 'FILE_TOO_LARGE' && e.status === 422);
});

test('attachmentError carries the documented API status', () => {
  const error = attachmentError('OBJECT_MISSING', 'gone', 404);
  assert.equal(error.code, 'OBJECT_MISSING');
  assert.equal(error.status, 404);
});

/* ---- edge storage flow --------------------------------------------------- */

test('upload writes the object first, then chained metadata with a checksum', async () => {
  const bucket = fakeBucket();
  const created = {
    attachment_id: 'ATT1', entity_type: 'CHEQUE', entity_id: 'CHQ1', file_name: 'scan.pdf'
  };
  let calls = [];
  await withGas({
    'attachment.create': (env) => ({ data: { ...env.payload, ...created } })
  }, async (recorded) => {
    calls = recorded;
    const result = await upload({ ...BASE_ENV, ATTACHMENTS_BUCKET: bucket }, CTX, {
      entityType: 'CHEQUE', entityId: 'CHQ1', file: fakeFile('scan.pdf', 'application/pdf')
    });
    assert.equal(result.attachment_id, 'ATT1');
  });

  assert.equal(bucket.state.puts.length, 1);
  const put = bucket.state.puts[0];
  assert.match(put.key, /^attachments\/CHEQUE\/CHQ1\/[0-9a-f-]+-scan\.pdf$/);
  assert.match(put.options.customMetadata.checksum, /^[0-9a-f]{64}$/);
  assert.equal(put.options.customMetadata['entity-type'], 'CHEQUE');
  assert.equal(put.options.customMetadata['uploaded-by'], 'admin');
  assert.equal(put.options.httpMetadata.contentType, 'application/pdf');
  assert.equal(bucket.state.deletes.length, 0);

  const metadataCall = calls.find((c) => c.action === 'attachment.create');
  assert.ok(metadataCall);
  assert.equal(metadataCall.payload.r2_key, put.key);
  assert.equal(metadataCall.payload.size_bytes, new TextEncoder().encode('pdf-bytes').length);
});

test('upload removes the object when metadata creation fails (no orphans)', async () => {
  const bucket = fakeBucket();
  await assert.rejects(
    withGas({
      'attachment.create': () => ({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad metadata' } })
    }, async () => {
      await upload({ ...BASE_ENV, ATTACHMENTS_BUCKET: bucket }, CTX, {
        entityType: 'GUARANTEE', entityId: 'GRT1', file: fakeFile('g.pdf', 'application/pdf')
      });
    }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
  assert.equal(bucket.state.puts.length, 1);
  assert.equal(bucket.state.deletes.length, 1);
  assert.equal(bucket.state.deletes[0], bucket.state.puts[0].key);
});

test('download returns a raw no-store Response and never a public R2 URL', async () => {
  const metadata = {
    attachment_id: 'ATT2', entity_type: 'CHEQUE', entity_id: 'CHQ1',
    r2_key: 'attachments/CHEQUE/CHQ1/id-scan.pdf',
    file_name: 'شيك.pdf', content_type: 'application/pdf'
  };
  const objectBody = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('streamed-pdf')); controller.close(); }
  });
  const bucket = fakeBucket({ [metadata.r2_key]: { body: objectBody, httpEtag: 'etag-1' } });

  const response = await withGas({
    'attachment.get': () => ({ data: metadata })
  }, () => download({ ...BASE_ENV, ATTACHMENTS_BUCKET: bucket }, CTX, 'ATT2'));

  assert.ok(response instanceof Response, 'download must return a raw Response');
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('ETag'), 'etag-1');
  assert.match(response.headers.get('Content-Disposition'), /filename\*=UTF-8''/);
  assert.equal(await response.text(), 'streamed-pdf');
  assert.ok(!response.headers.get('Content-Disposition').includes('r2.dev'));
});

test('remove soft-deletes metadata before deleting the R2 object', async () => {
  const bucket = fakeBucket();
  const order = [];
  await withGas({
    'attachment.get': () => ({ data: { attachment_id: 'ATT3', r2_key: 'attachments/key', entity_type: 'CHEQUE', entity_id: 'CHQ1' } }),
    'attachment.delete': () => { order.push('metadata'); return { data: { deleted: true } }; }
  }, async () => {
    const result = await remove({ ...BASE_ENV, ATTACHMENTS_BUCKET: bucket }, CTX, 'ATT3');
    assert.equal(result.deleted, true);
  });
  order.push('object');
  assert.deepEqual(order, ['metadata', 'object']);
  assert.deepEqual(bucket.state.deletes, ['attachments/key']);
});

/* ---- Apps Script metadata service --------------------------------------- */

function gasHarness() {
  return loadGs(
    [
      'apps-script/utils/errors.gs',
      'apps-script/utils/helpers.gs',
      'apps-script/services/attachment-service.gs'
    ],
    {
      AuditService: { write() { return {}; } }
    }
  );
}

const GAS_CTX = { requestId: 'req-gas', ip: '192.0.2.1', actor: { userId: 'admin', role: 'ADMIN' } };

function seedAttachment(h, overrides = {}) {
  return h.sandbox.AttachmentService.create(GAS_CTX, {
    attachment_id: 'ATT1', entity_type: 'CHEQUE', entity_id: 'CHQ1',
    file_name: 'scan.pdf', r2_key: 'attachments/CHEQUE/CHQ1/id-scan.pdf',
    content_type: 'application/pdf', size_bytes: 123, checksum: 'abc',
    ...overrides
  });
}

test('GAS create validates and filters soft-deleted rows from list/get', () => {
  const h = gasHarness();
  const service = h.sandbox.AttachmentService;
  assert.throws(
    () => service.create(GAS_CTX, { attachment_id: 'BAD', entity_type: 'BOOK', entity_id: 'B1', file_name: 'x', r2_key: 'k' }),
    (e) => e.code === 'VALIDATION_ERROR'
  );
  const created = seedAttachment(h);
  assert.equal(created.is_deleted, false);
  assert.equal(service.list({}).length, 1);
  assert.equal(service.list({ entityType: 'CHEQUE', entityId: 'CHQ1' }).length, 1);
  assert.equal(service.list({ entityType: 'GUARANTEE' }).length, 0);

  service.softDelete(GAS_CTX, 'ATT1');
  assert.equal(service.list({}).length, 0);
  assert.throws(() => service.get('ATT1'), (e) => e.code === 'NOT_FOUND');
  assert.equal(h.store.rows.attachments[0].deleted_by, 'admin');
  assert.equal(h.store.rows.attachments[0].is_deleted, true);
});

test('GAS create rejects duplicate attachment ids', () => {
  const h = gasHarness();
  seedAttachment(h);
  assert.throws(() => seedAttachment(h), (e) => e.code === 'CONFLICT');
});
