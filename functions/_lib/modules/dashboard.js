/** Dashboard module with 30s KV cache. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';
import { cached } from '../cache.js';

// Cloudflare KV requires expirationTtl >= 60 seconds. A 30s TTL made every
// cached write throw and turned dashboard responses into 500s.
const TTL = 60;

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
