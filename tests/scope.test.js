/** Scope checks must work against the snake_case rows returned by SheetsAdapter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScope, applyScope } from '../functions/_lib/scope.js';

const manager = {
  actor: {
    userId: 'U1', role: 'BRANCH_MANAGER',
    scopes: [{ type: 'WAREHOUSE', id: 'WH_CAIRO' }]
  }
};
const collector = {
  actor: { userId: 'COL1', role: 'COLLECTOR', scopes: [] }
};

test('assertScope reads the denormalized warehouse field', () => {
  assert.doesNotThrow(() => assertScope(manager, { warehouse: 'WH_CAIRO' }));
  assert.throws(() => assertScope(manager, { warehouse: 'WH_ALEX' }), { code: 'FORBIDDEN' });
});

test('assertScope reads snake_case holder columns for collectors', () => {
  assert.doesNotThrow(() => assertScope(collector, { collector_id: 'COL1' }));
  assert.throws(() => assertScope(collector, { collector_id: 'COL2' }), { code: 'FORBIDDEN' });
  assert.doesNotThrow(() => assertScope(collector, { current_holder_id: 'COL1' }));
  assert.throws(() => assertScope(collector, { current_holder_id: 'COL2' }), { code: 'FORBIDDEN' });
});

test('applyScope constrains collectors and preserves explicit queries for admins', () => {
  assert.equal(applyScope(collector, {}).collectorId, 'COL1');
  const admin = { actor: { userId: 'A', role: 'ADMIN', scopes: [] } };
  assert.deepEqual(applyScope(admin, { status: 'UNUSED' }), { status: 'UNUSED' });
});
