/** Role Based Access Control helpers used by every API module. */

import { ROLE_PERMISSIONS, ROLES } from '../../shared/constants/enums.js';

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

export function hasPermission(ctx, permission) {
  if (!ctx || !ctx.actor) return false;
  const claims = ctx.actor.permissions || permissionsFor(ctx.actor.role);
  return claims.includes(permission);
}

export function requirePermission(ctx, permission) {
  if (!hasPermission(ctx, permission)) {
    throw Object.assign(new Error(`Permission required: ${permission}`), { code: 'FORBIDDEN', status: 403 });
  }
  return true;
}

export function requireAny(ctx, permissions) {
  if (!permissions.some((p) => hasPermission(ctx, p))) {
    throw Object.assign(new Error('Insufficient permissions'), { code: 'FORBIDDEN', status: 403 });
  }
}

export function requireRole(ctx, roles) {
  if (!roles.includes(ctx.actor?.role)) {
    throw Object.assign(new Error('Role not allowed'), { code: 'FORBIDDEN', status: 403 });
  }
}

export function isAdmin(ctx) {
  return ctx.actor?.role === ROLES.ADMIN;
}

export function isReadContext(ctx) {
  return ctx.actor?.role === ROLES.AUDITOR;
}
