/** PHASE 2 / Step 1 — audit hash-chain tests against the REAL Apps Script source. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';

function harness() {
  return loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/audit-service.gs'
  ]);
}

const CTX = { requestId: 'req-chain', ip: '203.0.113.7', actor: { userId: 'admin', role: 'ADMIN' } };

function seed(h, count) {
  for (let i = 0; i < count; i++) {
    h.AuditService.write(CTX, { operation: 'OP_' + i, entityType: 'books', entityId: 'BK_' + i });
  }
}

test('write() links every record from the genesis hash and advances the tip', () => {
  const h = harness();
  assert.equal(h.AuditService.tip(), h.AuditService.genesis());

  const a = h.AuditService.write(CTX, { operation: 'LOGIN', entityType: 'users', entityId: 'USR1' });
  const b = h.AuditService.write(CTX, { operation: 'CREATE', entityType: 'books', entityId: 'BK1' });

  assert.equal(a.previous_hash, h.AuditService.genesis());
  assert.equal(b.previous_hash, a.audit_hash);
  assert.match(a.audit_hash, /^[0-9a-f]{64}$/);
  assert.equal(h.AuditService.tip(), b.audit_hash);
  assert.equal(h.store.rows.audit_logs.length, 2);
  assert.equal(a.ip_address, '203.0.113.7');
});

test('canonical payload is deterministic and escapes non-ASCII', () => {
  const h = harness();
  const row = {
    audit_id: 'AUD_1', request_id: 'r', user_id: 'admin', operation: 'تحديث',
    entity_type: 'books', entity_id: 'BK1', old_value: '', new_value: '{}',
    changed_fields: '[]', timestamp: '2026-01-01T00:00:00.000Z',
    ip_address: '1.2.3.4', result: 'SUCCESS', previous_hash: h.AuditService.genesis()
  };
  const payload = h.AuditService.canonicalPayload(row);
  assert.equal(payload, h.AuditService.canonicalPayload({ ...row }));
  assert.match(payload, /\\u[0-9a-f]{4}/);
  assert.doesNotMatch(payload, /تحديث/);
  assert.match(h.AuditService.computeHash(row), /^[0-9a-f]{64}$/);
});

test('verifyChain() passes on a healthy chain', () => {
  const h = harness();
  seed(h, 5);
  const result = h.AuditService.verifyChain();
  assert.equal(result.valid, true);
  assert.equal(result.recordsChecked, 5);
  assert.equal(result.issues.length, 0);
  assert.equal(h.securityEvents.length, 0);
});

test('verifyChain() detects a MODIFIED record (HASH_MISMATCH)', () => {
  const h = harness();
  seed(h, 4);
  const rows = h.store.rows.audit_logs;
  rows[2].new_value = '{"tampered":true}';

  const result = h.AuditService.verifyChain();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.type === 'HASH_MISMATCH' && issue.auditId === rows[2].audit_id));
  assert.equal(h.securityEvents.some((event) => event.eventType === 'AUDIT_VERIFY_FAILED'), true);
});

test('verifyChain() detects a DELETED middle record (DELETED_ENTRIES_SUSPECTED)', () => {
  const h = harness();
  seed(h, 4);
  const rows = h.store.rows.audit_logs;
  rows.splice(2, 1); // delete the middle record entirely
  rows.forEach((row, index) => { row._row = index + 2; });

  const result = h.AuditService.verifyChain();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) =>
    issue.type === 'DELETED_ENTRIES_SUSPECTED' && issue.auditId === rows[2].audit_id));
});

test('verifyChain() detects TAIL TRUNCATION via the settings tip anchor (TIP_MISMATCH)', () => {
  const h = harness();
  seed(h, 3);
  const rows = h.store.rows.audit_logs;
  rows.pop(); // remove the last record; remaining chain is internally consistent

  const result = h.AuditService.verifyChain();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.type === 'TIP_MISMATCH'));
});
