/** PHASE 2 / Step 4 — treasury master service and legacy resolution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';

const CTX = { requestId: 'req-treasury', ip: '192.0.2.4', actor: { userId: 'admin', role: 'ADMIN' } };

function harness() {
  const h = loadGs(
    [
      'apps-script/utils/errors.gs',
      'apps-script/utils/helpers.gs',
      'apps-script/services/treasury-service.gs'
    ],
    {
      TREASURY_TYPES: ['BRANCH', 'HQ'],
      TREASURY_STATUSES: ['ACTIVE', 'INACTIVE'],
      AuditService: { write() { return {}; } },
      M004Treasuries: { branchIdFor(warehouse) { return warehouse ? 'TR_BR_' + warehouse : 'TR_BRANCH'; } }
    }
  );
  return h;
}

function seed(h) {
  h.sandbox.SheetsAdapter.insertRow('treasuries', {
    treasury_id: 'TR_HQ', treasury_name: 'HQ Treasury', treasury_type: 'HQ',
    warehouse: '', status: 'ACTIVE'
  });
  h.sandbox.SheetsAdapter.insertRow('treasuries', {
    treasury_id: 'TR_BR_W1', treasury_name: 'Branch W1', treasury_type: 'BRANCH',
    warehouse: 'W1', status: 'ACTIVE'
  });
  h.sandbox.SheetsAdapter.insertRow('treasuries', {
    treasury_id: 'TR_OLD', treasury_name: 'Old', treasury_type: 'BRANCH',
    warehouse: 'W9', status: 'INACTIVE'
  });
}

test('list() filters by type, status and warehouse', () => {
  const h = harness();
  seed(h);
  const TreasuryService = h.sandbox.TreasuryService;
  assert.equal(TreasuryService.list({}).length, 3);
  assert.equal(TreasuryService.list({ type: 'HQ' }).length, 1);
  assert.equal(TreasuryService.list({ status: 'ACTIVE' }).length, 2);
  assert.equal(TreasuryService.list({ warehouse: 'W1' }).length, 1);
});

test('create() validates input, rejects duplicates and writes an audit row', () => {
  const h = harness();
  seed(h);
  const TreasuryService = h.sandbox.TreasuryService;
  assert.throws(
    () => TreasuryService.create(CTX, { treasury_id: 'bad id', treasury_name: 'X', treasury_type: 'HQ' }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => TreasuryService.create(CTX, { treasury_id: 'TR_HQ', treasury_name: 'X', treasury_type: 'HQ' }),
    (error) => error.code === 'CONFLICT'
  );
  const created = TreasuryService.create(CTX, {
    treasury_id: 'tr_new', treasury_name: 'New Treasury', treasury_type: 'BRANCH', warehouse: 'W2'
  });
  assert.equal(created.treasury_id, 'TR_NEW');
  assert.equal(created.status, 'ACTIVE');
  assert.equal(TreasuryService.list({}).length, 4);
});

test('update() enforces the immutable id and supports rename/deactivation', () => {
  const h = harness();
  seed(h);
  const TreasuryService = h.sandbox.TreasuryService;
  assert.throws(
    () => TreasuryService.update(CTX, 'TR_HQ', { treasury_id: 'TR_OTHER' }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  const updated = TreasuryService.update(CTX, 'TR_HQ', { treasury_name: 'Main', status: 'INACTIVE' });
  assert.equal(updated.treasury_name, 'Main');
  assert.equal(updated.status, 'INACTIVE');
  assert.equal(TreasuryService.get('TR_HQ').treasury_id, 'TR_HQ');
  assert.throws(() => TreasuryService.get('MISSING'), (error) => error.code === 'NOT_FOUND');
});

test('legacy holders resolve to HQ/branch treasuries, other holders are blank', () => {
  const h = harness();
  const TreasuryService = h.sandbox.TreasuryService;
  assert.equal(TreasuryService.resolveForLegacy('HQ_TREASURY', ''), 'TR_HQ');
  assert.equal(TreasuryService.resolveForLegacy('BRANCH_TREASURY', 'W1'), 'TR_BR_W1');
  assert.equal(TreasuryService.resolveForLegacy('BANK', ''), '');
  assert.equal(TreasuryService.resolveOrDefault('BANK', ''), 'TR_BRANCH');
});
