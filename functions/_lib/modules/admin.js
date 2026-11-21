/** User/role/settings administration module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { ROLE_PERMISSIONS } from '../../../shared/constants/enums.js';

/** Public projection: credentials and MFA secrets must never leave the edge. */
const PUBLIC_USER_FIELDS = [
  'user_id', 'username', 'full_name', 'email', 'role_id', 'status',
  'scopes', 'failed_attempts', 'last_login_at', 'version',
  'created_at', 'updated_at'
];

export function publicUser(row) {
  const safe = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (row && row[field] !== undefined) safe[field] = row[field];
  }
  return safe;
}

export async function users(env, ctx, query = {}) {
  requirePermission(ctx, 'users.manage');
  const repo = createRepository(env, ctx);
  const result = await repo.list('users', query);
  return {
    ...result.data,
    items: (result.data?.items || []).map(publicUser)
  };
}

export async function roles(env, ctx) {
  requirePermission(ctx, 'users.manage');
  const repo = createRepository(env, ctx);
  return (await repo.list('roles', {})).data;
}

export async function rolePermissions(env, ctx) {
  requirePermission(ctx, 'users.manage');
  return { items: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({ role, permissions })) };
}

export async function settings(env, ctx) {
  requirePermission(ctx, 'settings.manage');
  const repo = createRepository(env, ctx);
  return (await repo.list('settings', {})).data;
}

/* ---- PHASE 2 / Step 11 — account lockout administration ------------------ */

/** ADMIN-only: clear a user's failed-attempt counter and lockout window. */
export async function unlockUser(env, ctx, userId) {
  requirePermission(ctx, 'users.manage');
  if (!userId) {
    throw Object.assign(new Error('userId is required'), {
      code: 'VALIDATION_ERROR', status: 400
    });
  }
  const repo = createRepository(env, ctx);
  return (await repo.call('security.unlock', 'users', { userId })).data;
}

/* ---- PHASE 2 / Step 9 — workbook split administration -------------------- */

/** Effective workbook placement for every entity (ADMIN only). */
export async function registryStatus(env, ctx) {
  requirePermission(ctx, 'settings.manage');
  const repo = createRepository(env, ctx);
  return (await repo.call('registry.status', 'settings', {})).data;
}

/** Flip the split routing flags. `enabled` must be an explicit boolean. */
export async function registrySetSplit(env, ctx, enabled) {
  requirePermission(ctx, 'settings.manage');
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('enabled must be a boolean'), {
      code: 'VALIDATION_ERROR', status: 400
    });
  }
  const repo = createRepository(env, ctx);
  return (await repo.call('registry.setSplit', 'settings', { enabled })).data;
}
