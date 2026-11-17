/** User/role/settings administration module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { ROLE_PERMISSIONS } from '../../../shared/constants/enums.js';

export async function users(env, ctx, query = {}) {
  requirePermission(ctx, 'users.manage');
  const repo = createRepository(env, ctx);
  return (await repo.list('users', query)).data;
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
