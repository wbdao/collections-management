/** Guarantee business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope, assertScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'guarantees.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('guarantees', applyScope(ctx, query), { orderBy: 'expiry_date' })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'guarantees.read');
  const repo = createRepository(env, ctx);
  const guarantee = (await repo.get('guarantees', id)).data;
  assertScope(ctx, guarantee);
  return guarantee;
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'guarantees.create');
  const repo = createRepository(env, ctx);
  return (await repo.call('guarantee.create', 'guarantees', data)).data;
}

export async function update(env, ctx, id, patch, version) {
  requirePermission(ctx, 'guarantees.update');
  const repo = createRepository(env, ctx);
  return (await repo.call('guarantee.update', 'guarantees', { id, patch, version })).data;
}

export async function transition(env, ctx, id, status, payload = {}) {
  requirePermission(ctx, 'guarantees.transition');
  const repo = createRepository(env, ctx);
  return (await repo.call('guarantee.transition', 'guarantees', { id, toStatus: status, ...payload })).data;
}

export async function alerts(env, ctx, query = {}) {
  requirePermission(ctx, 'guarantees.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('guaranteeExpiring', applyScope(ctx, query))).data;
}
