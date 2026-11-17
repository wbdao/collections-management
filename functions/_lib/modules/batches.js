/** Book batch business module (edge side). All persistence goes through Repository. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'batches.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('book_batches', applyScope(ctx, query), { orderBy: 'delivery_date' })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'batches.read');
  const repo = createRepository(env, ctx);
  return (await repo.get('book_batches', id)).data;
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'batches.create');
  const repo = createRepository(env, ctx);
  return (await repo.insert('book_batches', data)).data;
}

export async function update(env, ctx, id, patch, version) {
  requirePermission(ctx, 'batches.manage');
  const repo = createRepository(env, ctx);
  return (await repo.update('book_batches', id, patch, version)).data;
}

export async function transition(env, ctx, id, status, payload = {}) {
  requirePermission(ctx, 'batches.manage');
  const repo = createRepository(env, ctx);
  return (await repo.transition('book_batches', id, status, payload)).data;
}

export async function books(env, ctx, id) {
  requirePermission(ctx, 'batches.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('books', { batchId: id }, { orderBy: 'serial_from', descending: false })).data;
}

export async function report(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('bookBatchReport', applyScope(ctx, query))).data;
}
