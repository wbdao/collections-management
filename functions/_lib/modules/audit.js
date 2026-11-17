/** Audit read module (edge side). Audit writes are performed by domain services only. */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'audit.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('audit_logs', applyScope(ctx, query), { orderBy: 'timestamp' })).data;
}
