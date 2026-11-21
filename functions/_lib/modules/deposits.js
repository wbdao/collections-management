/** Deposit business module (edge side). Branch and HQ share the same flow. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope, getInScope, guardScope, scopeForCreate } from '../scope.js';

function levelFrom(pathLevel) {
  return pathLevel === 'hq' ? 'HQ' : 'BRANCH';
}

export async function list(env, ctx, pathLevel, query = {}) {
  const level = levelFrom(pathLevel);
  requirePermission(ctx, `deposits.${level.toLowerCase()}.read`);
  const repo = createRepository(env, ctx);
  const entity = level === 'HQ' ? 'deposits_hq' : 'deposits_branch';
  return (await repo.list(entity, applyScope(ctx, query), { orderBy: 'deposit_date' })).data;
}

export async function get(env, ctx, pathLevel, id) {
  const level = levelFrom(pathLevel);
  requirePermission(ctx, `deposits.${level.toLowerCase()}.read`);
  const repo = createRepository(env, ctx);
  const entity = level === 'HQ' ? 'deposits_hq' : 'deposits_branch';
  return getInScope(repo, ctx, entity, id);
}

export async function create(env, ctx, pathLevel, data) {
  const level = levelFrom(pathLevel);
  requirePermission(ctx, `deposits.${level.toLowerCase()}.create`);
  const repo = createRepository(env, ctx);
  return (await repo.call('deposit.create', level, scopeForCreate(ctx, data))).data;
}

export async function confirm(env, ctx, pathLevel, id) {
  const level = levelFrom(pathLevel);
  requirePermission(ctx, `deposits.${level.toLowerCase()}.confirm`);
  const repo = createRepository(env, ctx);
  const entity = level === 'HQ' ? 'deposits_hq' : 'deposits_branch';
  await guardScope(repo, ctx, entity, id);
  return (await repo.call('deposit.confirm', level, { id })).data;
}

export async function lines(env, ctx, pathLevel, id) {
  await get(env, ctx, pathLevel, id);
  const repo = createRepository(env, ctx);
  return (await repo.list('deposit_lines', { depositId: id })).data;
}
