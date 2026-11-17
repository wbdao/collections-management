/**
 * Scope-based access enforcement.
 * ADMIN is global. AUDITOR is global but read-only (enforced by RBAC).
 * BRANCH_MANAGER and TREASURY are limited to assigned warehouse/branch scopes.
 * COLLECTOR is limited to their own holder records.
 */

import { ROLES } from '../../shared/constants/enums.js';

export function scopeSummary(ctx) {
  const scopes = ctx.actor?.scopes || [];
  return {
    role: ctx.actor?.role,
    warehouseIds: scopes.filter((s) => s.type === 'WAREHOUSE').map((s) => s.id),
    branchIds: scopes.filter((s) => s.type === 'BRANCH').map((s) => s.id),
    userId: ctx.actor?.userId
  };
}

/**
 * Adds implicit scope constraints to a repository query.
 * Never weakens an explicit query — scope filters are intersected.
 */
export function applyScope(ctx, query = {}) {
  const role = ctx.actor?.role;
  if (role === ROLES.ADMIN || role === ROLES.AUDITOR) return query;

  const summary = scopeSummary(ctx);
  const scoped = { ...query };

  if (role === ROLES.COLLECTOR) {
    scoped.collectorId = ctx.actor.userId;
    scoped.holderId = ctx.actor.userId;
    return scoped;
  }

  if (summary.warehouseIds.length) scoped.warehouseIds = summary.warehouseIds;
  if (summary.branchIds.length) scoped.branchIds = summary.branchIds;
  return scoped;
}

/**
 * Verifies that a target entity belongs to the caller's scope.
 * Throws 403 otherwise. Used before mutations on a known record.
 */
export function assertScope(ctx, target = {}) {
  const role = ctx.actor?.role;
  if (role === ROLES.ADMIN || role === ROLES.AUDITOR) return true;

  const summary = scopeSummary(ctx);

  if (role === ROLES.COLLECTOR) {
    // Rows returned by the adapter use the snake_case column names from the
    // spreadsheet (e.g. collector_id, current_holder_id). Accept both shapes.
    const holderIds = [
      target.collector_id, target.collectorId,
      target.current_holder_id, target.holder_id, target.holderId
    ].filter(Boolean);
    if (holderIds.some(function (id) { return String(id) !== String(ctx.actor.userId); })) denied();
    return true;
  }

  // Warehouse Group is denormalized onto documents as `warehouse`; older rows
  // may expose warehouse_id/warehouseId. Branch ids remain snake_case in rows.
  const warehouse = target.warehouse || target.warehouse_id || target.warehouseId;
  if (warehouse && summary.warehouseIds.length &&
      !summary.warehouseIds.includes(String(warehouse))) denied();
  const branch = target.branch_id || target.branchId;
  if (branch && summary.branchIds.length &&
      !summary.branchIds.includes(String(branch))) denied();
  return true;
}

function denied() {
  throw Object.assign(new Error('Resource outside caller scope'), { code: 'FORBIDDEN', status: 403 });
}
