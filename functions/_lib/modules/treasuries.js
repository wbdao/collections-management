/** PHASE 2 / Step 4 — treasury master (edge side). */
import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { assertExplicitScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'treasuries.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('treasury.list', 'treasuries', {
    type: query.type || '', status: query.status || '', warehouse: query.warehouse || ''
  })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'treasuries.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('treasury.get', 'treasuries', { treasuryId: id })).data;
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'treasuries.manage');
  assertExplicitScope(ctx);
  const repo = createRepository(env, ctx);
  return (await repo.call('treasury.create', 'treasuries', data)).data;
}

export async function update(env, ctx, id, patch) {
  requirePermission(ctx, 'treasuries.manage');
  assertExplicitScope(ctx);
  const repo = createRepository(env, ctx);
  return (await repo.call('treasury.update', 'treasuries', { treasuryId: id, patch })).data;
}
