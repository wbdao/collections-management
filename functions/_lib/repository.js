/**
 * Repository Interface implementation for Cloudflare Functions.
 * Business modules import this class only; they never call Apps Script directly.
 */
import { callGas } from './gas-client.js';
import { assertRepository } from '../../shared/contracts/repository.js';
import { D1RepositoryAdapter } from './d1-repository-adapter.js';

export class Transaction {
  constructor(repository) {
    this.repository = repository;
    this.operations = [];
    this.committed = false;
  }

  insert(entity, data) {
    this.operations.push({ kind: 'call', action: 'insert', entity, payload: { data } });
    return this;
  }

  update(entity, id, patch, expectedVersion) {
    this.operations.push({ kind: 'call', action: 'update', entity, payload: { id, patch, expectedVersion } });
    return this;
  }

  transition(entity, id, toStatus, payload = {}) {
    this.operations.push({ kind: 'call', action: 'transition', entity, payload: { id, toStatus, ...payload } });
    return this;
  }

  appendLedger(entry) {
    this.operations.push({
      kind: 'call', action: 'appendLedger', entity: 'custody_ledger', payload: { entry }
    });
    return this;
  }

  call(action, entity, payload = {}) {
    this.operations.push({ kind: 'call', action, entity, payload });
    return this;
  }

  async commit() {
    if (this.committed) throw new Error('Transaction already committed');
    this.committed = true;
    if (!this.operations.length) return { ok: true, data: {}, meta: { rowsAffected: 0 } };
    return this.repository.call('transaction', null, { operations: this.operations });
  }
}

export class Repository {
  constructor(env, ctx) {
    this.env = env;
    this.ctx = ctx;
  }

  call(action, entity, payload = {}) {
    return callGas(this.env, this.ctx, action, entity, payload);
  }

  list(entity, query = {}, options = {}) {
    return this.call('list', entity, { query, options });
  }

  get(entity, id) {
    return this.call('get', entity, { id });
  }

  insert(entity, data) {
    return this.call('insert', entity, { data });
  }

  update(entity, id, patch, expectedVersion) {
    return this.call('update', entity, { id, patch, expectedVersion });
  }

  transition(entity, id, toStatus, payload = {}) {
    return this.call('transition', entity, { id, toStatus, ...payload });
  }

  aggregate(name, params = {}) {
    return this.call('aggregate', name, { params });
  }

  appendLedger(entry) {
    return this.call('appendLedger', 'custody_ledger', { entry });
  }

  withTransaction() {
    return new Transaction(this);
  }
}

assertRepository(Repository.prototype);

export function createRepository(env, ctx) {
  // PHASE 2 / Step 10 — D1 is a reference adapter only. It is selected solely
  // by an explicit, non-production flag; Sheets/GAS remains the default.
  if (env && env.REPOSITORY_ADAPTER === 'd1') {
    return assertRepository(new D1RepositoryAdapter(env.DB, { ...ctx, env }));
  }
  return new Repository(env, ctx);
}
