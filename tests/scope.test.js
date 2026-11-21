/** Scope checks must work against the snake_case rows returned by SheetsAdapter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScope, applyScope, getInScope, guardScope, scopeForCreate
} from '../functions/_lib/scope.js';

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

test('getInScope returns an in-scope row and denies an out-of-scope row', async () => {
  const repo = {
    async get() { return { data: { book_id: 'B1', warehouse: 'WH_CAIRO' } }; }
  };
  assert.equal((await getInScope(repo, manager, 'books', 'B1')).book_id, 'B1');
  const other = {
    async get() { return { data: { book_id: 'B2', warehouse: 'WH_ALEX' } }; }
  };
  await assert.rejects(() => getInScope(other, manager, 'books', 'B2'), { code: 'FORBIDDEN' });
});

test('guardScope skips the extra read for global roles but checks scoped roles', async () => {
  let reads = 0;
  const repo = {
    async get() { reads++; return { data: { book_id: 'B1', warehouse: 'WH_ALEX' } }; }
  };
  const admin = { actor: { userId: 'A', role: 'ADMIN', scopes: [] } };
  await guardScope(repo, admin, 'books', 'B1');
  assert.equal(reads, 0);
  await assert.rejects(() => guardScope(repo, manager, 'books', 'B1'), { code: 'FORBIDDEN' });
  assert.equal(reads, 1);
});

test('scopeForCreate forces the collector identity and blocks forged holders', () => {
  const forged = scopeForCreate(collector, { collector_id: 'COL2', account: 'CUST1' });
  assert.equal(forged.collector_id, 'COL1');
  assert.equal(forged.account, 'CUST1');
  const missing = scopeForCreate(collector, { account: 'CUST1' });
  assert.equal(missing.collector_id, 'COL1');
});

test('scopeForCreate rejects a branch outside the manager scope', () => {
  const branchManager = {
    actor: { userId: 'U2', role: 'BRANCH_MANAGER', scopes: [{ type: 'BRANCH', id: 'BR_CAIRO' }] }
  };
  assert.doesNotThrow(() => scopeForCreate(branchManager, { branch_id: 'BR_CAIRO' }));
  assert.throws(() => scopeForCreate(branchManager, { branch_id: 'BR_ALEX' }), { code: 'FORBIDDEN' });
});
