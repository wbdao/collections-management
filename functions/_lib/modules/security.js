/** PHASE 2 / Step 11 — security event visibility and self-service summary. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { assertExplicitScope } from '../scope.js';

/**
 * ADMIN / AUDITOR (or any explicitly scoped role) may read the append-only
 * security event log. Filters are passed straight to SecurityEventService.list.
 */
export async function events(env, ctx, query = {}) {
  requirePermission(ctx, 'security.read');
  assertExplicitScope(ctx);
  const repo = createRepository(env, ctx);
  const result = await repo.call('security.events', 'security_events', {
    eventType: query.eventType || '',
    userId: query.userId || '',
    severity: query.severity || '',
    from: query.from || '',
    limit: query.limit ? Number(query.limit) : 200
  });
  return result.data?.items || [];
}

/** Any authenticated user may inspect their own security posture. */
export async function me(env, ctx) {
  const repo = createRepository(env, ctx);
  return (await repo.call('security.me', 'users', { userId: ctx.actor?.userId })).data;
}
