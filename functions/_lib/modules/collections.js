/** Collection business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'collections.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('collections', applyScope(ctx, query), { orderBy: 'collection_date' })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'collections.read');
  const repo = createRepository(env, ctx);
  return (await repo.get('collections', id)).data;
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'collections.create');
  const repo = createRepository(env, ctx);
  return (await repo.call('collection.create', 'collections', data)).data;
}

export async function update(env, ctx, id, patch, version) {
  requirePermission(ctx, 'collections.create');
  const repo = createRepository(env, ctx);
  return (await repo.update('collections', id, patch, version)).data;
}

export async function reconcile(env, ctx, id) {
  requirePermission(ctx, 'collections.reconcile');
  const repo = createRepository(env, ctx);
  return (await repo.call('collection.reconcile', 'collections', { id })).data;
}
