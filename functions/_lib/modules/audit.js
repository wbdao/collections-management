/** Audit read + integrity module (edge side). Audit writes are performed by domain services only. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

/** PHASE 1 — preserved unchanged. */
export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'audit.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('audit_logs', applyScope(ctx, query), { orderBy: 'timestamp' })).data;
}

/** PHASE 2 / Step 1 — hash-chain verification. */
export async function verify(env, ctx) {
  requirePermission(ctx, 'audit.verify');
  const repo = createRepository(env, ctx);
  return (await repo.call('audit.verify', 'audit_logs', {})).data;
}

/** PHASE 2 / Step 1 — cached chain tip / last verification status. */
export async function chainStatus(env, ctx) {
  requirePermission(ctx, 'audit.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('audit.chainStatus', 'audit_logs', {})).data;
}
