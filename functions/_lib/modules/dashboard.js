/** Dashboard module with 30s KV cache. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';
import { cached } from '../cache.js';

const TTL = 30;

export async function summary(env, ctx, query = {}) {
  requirePermission(ctx, 'dashboard.read');
  const repo = createRepository(env, ctx);
  return cached(env, 'dashboard:summary', TTL, async () =>
    (await repo.aggregate('dashboardSummary', applyScope(ctx, query))).data
  );
}

export async function custody(env, ctx, query = {}) {
  requirePermission(ctx, 'custody.read');
  const repo = createRepository(env, ctx);
  return cached(env, 'dashboard:custody', TTL, async () =>
    (await repo.aggregate('custodyDashboard', applyScope(ctx, query))).data
  );
}

export async function structure(env, ctx) {
  requirePermission(ctx, 'dashboard.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('warehouseStructure', {})).data;
}
