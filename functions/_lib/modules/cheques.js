/** Cheque business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope, assertScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'cheques.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('cheques', applyScope(ctx, query), { orderBy: 'cheque_date' })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'cheques.read');
  const repo = createRepository(env, ctx);
  const cheque = (await repo.get('cheques', id)).data;
  assertScope(ctx, cheque);
  return cheque;
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'cheques.create');
  const repo = createRepository(env, ctx);
  return (await repo.call('cheque.create', 'cheques', data)).data;
}

export async function update(env, ctx, id, patch, version) {
  requirePermission(ctx, 'cheques.update');
  const repo = createRepository(env, ctx);
  return (await repo.call('cheque.update', 'cheques', { id, patch, version })).data;
}

export async function transition(env, ctx, id, status, payload = {}) {
  requirePermission(ctx, 'cheques.transition');
  const repo = createRepository(env, ctx);
  return (await repo.call('cheque.transition', 'cheques', { id, toStatus: status, ...payload })).data;
}

export async function overdue(env, ctx, query = {}) {
  requirePermission(ctx, 'cheques.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('chequeOverdue', applyScope(ctx, query))).data;
}

export async function clearing(env, ctx, query = {}) {
  requirePermission(ctx, 'cheques.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('chequeClearing', applyScope(ctx, query))).data;
}
