/** PHASE 2 / Step 7 — approval gates, decisions and error mapping. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';
import { mapCode } from '../functions/_lib/gas-client.js';

const REQUESTER = { requestId: 'req-1', ip: '192.0.2.1', actor: { userId: 'treasurer', role: 'TREASURY' } };
const APPROVER = { requestId: 'req-2', ip: '192.0.2.2', actor: { userId: 'admin', role: 'ADMIN' } };

function harness() {
  return loadGs(
    [
      'apps-script/utils/errors.gs',
      'apps-script/utils/helpers.gs',
      'apps-script/services/approval-service.gs'
    ],
    {
      AuditService: { write() { return {}; } },
      SecurityEventService: { write() { return {}; } }
    }
  );
}

function enable(h, value = true) {
  h.sandbox.SheetsAdapter.setSetting('approvals.enabled', value);
}

test('gate() is a no-op while approvals.enabled is false (default)', () => {
  const h = harness();
  const result = h.sandbox.ApprovalService.gate(REQUESTER, 'HQ_DEPOSIT', 'DEP1', 'CONFIRM', {});
  assert.equal(result.allowed, true);
  assert.equal(result.gated, false);
  assert.equal(h.store.rows.approvals, undefined);
});

test('first gated action creates one pending approval and raises APPROVAL_REQUIRED', () => {
  const h = harness();
  enable(h);
  const service = h.sandbox.ApprovalService;

  assert.throws(
    () => service.gate(REQUESTER, 'HQ_DEPOSIT', 'DEP1', 'CONFIRM', { description: 'Confirm HQ deposit' }),
    (err) => err.code === 'APPROVAL_REQUIRED'
  );
  assert.equal(h.store.rows.approvals.length, 1);
  const row = h.store.rows.approvals[0];
  assert.equal(row.entity_type, 'HQ_DEPOSIT');
  assert.equal(row.entity_id, 'DEP1');
  assert.equal(row.action, 'CONFIRM');
  assert.equal(row.status, 'PENDING_APPROVAL');
  assert.equal(row.requested_by, 'treasurer');
  assert.ok(new Date(row.expires_at).getTime() > Date.now());

  // Repeated attempts must not create duplicate open requests.
  assert.throws(() => service.gate(REQUESTER, 'HQ_DEPOSIT', 'DEP1', 'CONFIRM', {}),
    (err) => err.code === 'APPROVAL_REQUIRED');
  assert.equal(h.store.rows.approvals.length, 1);
});

test('approval decision releases the gate and records approver/notes', () => {
  const h = harness();
  enable(h);
  const service = h.sandbox.ApprovalService;

  assert.throws(() => service.gate(REQUESTER, 'CHEQUE_STATUS_CHANGE', 'CHQ1', 'TRANSITION_CLEARING', {}),
    (err) => err.code === 'APPROVAL_REQUIRED');
  const id = h.store.rows.approvals[0].approval_id;

  const decided = service.decide(APPROVER, id, 'APPROVED', 'Bank statement checked');
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.approver_id, 'admin');
  assert.equal(decided.decision_notes, 'Bank statement checked');
  assert.ok(decided.decided_at);

  const retry = service.gate(REQUESTER, 'CHEQUE_STATUS_CHANGE', 'CHQ1', 'TRANSITION_CLEARING', {});
  assert.equal(retry.allowed, true);
  assert.equal(retry.gated, true);
  assert.equal(service.list({ status: 'APPROVED' }).length, 1);
});

test('rejection blocks the gated action permanently', () => {
  const h = harness();
  enable(h);
  const service = h.sandbox.ApprovalService;

  assert.throws(() => service.gate(REQUESTER, 'GUARANTEE_RELEASE', 'GRT1', 'RELEASE', {}),
    (err) => err.code === 'APPROVAL_REQUIRED');
  const id = h.store.rows.approvals[0].approval_id;
  service.decide(APPROVER, id, 'REJECTED', 'Contract not settled');

  assert.throws(() => service.gate(REQUESTER, 'GUARANTEE_RELEASE', 'GRT1', 'RELEASE', {}),
    (err) => err.code === 'APPROVAL_REJECTED' && /Contract not settled/.test(err.message));
});

test('a requester cannot decide their own approval; double decisions are rejected', () => {
  const h = harness();
  enable(h);
  const service = h.sandbox.ApprovalService;
  assert.throws(() => service.gate(REQUESTER, 'HQ_DEPOSIT', 'DEP2', 'CONFIRM', {}),
    (err) => err.code === 'APPROVAL_REQUIRED');
  const id = h.store.rows.approvals[0].approval_id;

  assert.throws(() => service.decide(REQUESTER, id, 'APPROVED', 'self'),
    (err) => err.code === 'FORBIDDEN');
  service.decide(APPROVER, id, 'APPROVED', 'ok');
  assert.throws(() => service.decide(APPROVER, id, 'REJECTED', 'late'),
    (err) => err.code === 'APPROVAL_DECIDED');
});

test('an expired approval is replaced with a fresh request', () => {
  const h = harness();
  enable(h);
  const service = h.sandbox.ApprovalService;
  assert.throws(() => service.gate(REQUESTER, 'HQ_DEPOSIT', 'DEP3', 'CONFIRM', {}),
    (err) => err.code === 'APPROVAL_REQUIRED');
  h.store.rows.approvals[0].expires_at = new Date(Date.now() - 1000).toISOString();

  assert.throws(() => service.gate(REQUESTER, 'HQ_DEPOSIT', 'DEP3', 'CONFIRM', {}),
    (err) => err.code === 'APPROVAL_REQUIRED');
  assert.equal(h.store.rows.approvals.length, 2);
});

test('approval API codes map to HTTP 409', () => {
  for (const code of ['APPROVAL_REQUIRED', 'APPROVAL_DECIDED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED']) {
    assert.equal(mapCode(code), 409, code);
  }
});
