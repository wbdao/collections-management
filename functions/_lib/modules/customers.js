/**
 * Customer master module (edge side).
 *
 * Customers are NOT managed here. The external, daily-updated customer sheet
 * is the system of record; this module exposes read-only lookup/autocomplete
 * through CustomerMasterService in Apps Script.
 */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';

/** Autocomplete across Account, Name and الاسم الموحد (Arabic unified name). */
export async function search(env, ctx, query = {}) {
  requirePermission(ctx, 'customers.read');
  const repo = createRepository(env, ctx);
  const term = typeof query === 'string'
    ? query
    : (query.q ?? query.query ?? query.term ?? query.search ?? '');
  const limit = query && query.limit ? Number(query.limit) : undefined;
  const result = (await repo.call('customer.search', 'customers', {
    query: term,
    limit
  })).data;
  // Apps Script's Router returns { items: [...] } for customer.search.
  // Older adapters returned a bare array, so accept both shapes.
  const items = Array.isArray(result)
    ? result
    : (result && Array.isArray(result.items) ? result.items : []);
  // The production Apps Script router drops `limit` and uses its own default.
  // Enforce the requested limit here so autocomplete stays responsive.
  const capped = Number.isFinite(limit) && limit >= 1
    ? items.slice(0, Math.min(Math.floor(limit), 100))
    : items;
  return { items: capped };
}

/** Backwards-compatible alias used by generic list consumers. */
export async function list(env, ctx, query = {}) {
  return search(env, ctx, query);
}

/** Full customer record by Account (the unique identifier). */
export async function get(env, ctx, account) {
  requirePermission(ctx, 'customers.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('customer.get', 'customers', { account })).data;
}

export async function warehouse(env, ctx, account) {
  requirePermission(ctx, 'customers.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('customer.warehouse', 'customers', { account })).data;
}

export async function department(env, ctx, account) {
  requirePermission(ctx, 'customers.read');
  const repo = createRepository(env, ctx);
  return (await repo.call('customer.department', 'customers', { account })).data;
}
