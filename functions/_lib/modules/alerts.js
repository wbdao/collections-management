/** Alert business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'alerts.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('alerts', applyScope(ctx, query), { orderBy: 'created_at' })).data;
}

export async function acknowledge(env, ctx, id) {
  requirePermission(ctx, 'alerts.acknowledge');
  const repo = createRepository(env, ctx);
  return (await repo.call('alert.acknowledge', 'alerts', { id })).data;
}

export async function scan(env, ctx) {
  requirePermission(ctx, 'alerts.scan');
  const repo = createRepository(env, ctx);
  return (await repo.call('alert.scan', 'alerts', {})).data;
}

export async function summary(env, ctx) {
  requirePermission(ctx, 'alerts.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('alertSummary', applyScope(ctx, {}))).data;
}
