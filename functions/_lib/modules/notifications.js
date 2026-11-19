/** PHASE 2 / Step 5 — notifications (edge side). */
import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'notifications.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('notification.list', 'notifications', {
    status: query.status || '', type: query.type || '', limit: query.limit ? Number(query.limit) : 200
  })).data;
}

export async function summary(env, ctx) {
  requirePermission(ctx, 'notifications.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('notification.summary', 'notifications', {})).data;
}

export async function markRead(env, ctx, id) {
  requirePermission(ctx, 'notifications.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('notification.markRead', 'notifications', { notificationId: id })).data;
}

export async function markAllRead(env, ctx) {
  requirePermission(ctx, 'notifications.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('notification.markAllRead', 'notifications', {})).data;
}
