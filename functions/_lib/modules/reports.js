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

/* ---- PHASE 2 / Step 8 — advanced reporting ------------------------------- */

/** Receivables aging buckets (d0_7/d8_30/d31_60/d60plus). */
export async function aging(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.advanced.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('report.aging', 'reports', applyScope(ctx, query))).data;
}

/** Per-collector productivity, cash and risk flag. */
export async function collectorPerformance(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.advanced.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('report.collectorPerformance', 'reports', applyScope(ctx, query))).data;
}

/** Per-treasury expected vs actual with open reconciliation exceptions. */
export async function treasuryReconciliation(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.advanced.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('report.treasuryReconciliation', 'reports', applyScope(ctx, query))).data;
}

/** Latest verifyAuditChain() result — requires explicit audit.verify. */
export async function auditExceptions(env, ctx, query = {}) {
  requirePermission(ctx, 'audit.verify');
  const repo = createRepository(env, ctx);
  return (await repo.call('report.auditExceptions', 'reports', applyScope(ctx, query))).data;
}

/** Five headline KPIs — available to any reports.read holder. */
export async function kpis(env, ctx, query = {}) {
  requirePermission(ctx, 'reports.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('report.kpis', 'reports', applyScope(ctx, query))).data;
}
