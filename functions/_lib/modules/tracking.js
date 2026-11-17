/** Universal tracking module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';

export async function track(env, ctx, number) {
  requirePermission(ctx, 'tracking.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('tracking.track', 'idx_tracking', { number })).data;
}

export async function trackTyped(env, ctx, type, number) {
  requirePermission(ctx, 'tracking.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('tracking.trackTyped', 'idx_tracking', { type, number })).data;
}
