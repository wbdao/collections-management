/** Reports module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope } from '../scope.js';

export async function outstandingCollections(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('outstandingCollections', applyScope(ctx, query))).data;
}

export async function receiptsInTransit(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('receiptsInTransit', applyScope(ctx, query))).data;
}

/** Warehouse Group report (customer master value, no warehouse master table). */
export async function byWarehouse(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('warehouseReport', applyScope(ctx, query))).data;
}

/** Customer group report (customer master value, no department master table). */
export async function byDepartment(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.read');
  const repo = createRepository(env, ctx);
  return (await repo.aggregate('departmentReport', applyScope(ctx, query))).data;
}
