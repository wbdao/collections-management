/** Custody business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function balances(env, ctx, query = {}) {
  requirePermission(ctx, 'custody.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('custody_balances', applyScope(ctx, query))).data;
}

export async function ledger(env, ctx, query = {}) {
  requirePermission(ctx, 'custody.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('custody_ledger', applyScope(ctx, query), { orderBy: 'occurred_at' })).data;
}

export async function exceptions(env, ctx, query = {}) {
  requirePermission(ctx, 'custody.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('reconciliation_exceptions', applyScope(ctx, query))).data;
}

export async function reconcile(env, ctx) {
  requirePermission(ctx, 'custody.reconcile');
  const repo = createRepository(env, ctx);
  return (await repo.call('custody.reconcile', 'custody_balances', {})).data;
}
