/** Movement business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'movements.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('movements', applyScope(ctx, query), { orderBy: 'movement_date' })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'movements.read');
  const repo = createRepository(env, ctx);
  return (await repo.get('movements', id)).data;
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'movements.create');
  const repo = createRepository(env, ctx);
  return (await repo.call('movement.create', 'movements', data)).data;
}

export async function history(env, ctx, type, number) {
  requirePermission(ctx, 'movements.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('movementHistory', applyScope(ctx, { documentType: type, documentNumber: number }))).data;
}
