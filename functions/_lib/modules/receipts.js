/** Receipt business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope, assertScope, guardScope, scopeForCreate } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'receipts.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('receipts', applyScope(ctx, query), { orderBy: 'collection_date' })).data;
}

export async function get(env, ctx, receiptNumber) {
  requirePermission(ctx, 'receipts.read');
  const repo = createRepository(env, ctx);
  const receipt = (await repo.call('receipt.getByNumber', 'receipts', { number: receiptNumber })).data;
  assertScope(ctx, receipt);
  return receipt;
}

export async function insert(env, ctx, data) {
  requirePermission(ctx, 'receipts.collect');
  const repo = createRepository(env, ctx);
  return (await repo.insert('receipts', scopeForCreate(ctx, data))).data;
}

export async function update(env, ctx, id, patch, version) {
  requirePermission(ctx, 'receipts.collect');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'receipts', id);
  return (await repo.update('receipts', id, patch, version)).data;
}

export async function collect(env, ctx, id, data) {
  requirePermission(ctx, 'receipts.collect');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'receipts', id);
  return (await repo.call('receipt.collect', 'receipts', { id, ...data })).data;
}

export async function cancel(env, ctx, id, reason) {
  requirePermission(ctx, 'receipts.cancel');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'receipts', id);
  return (await repo.call('receipt.cancel', 'receipts', { id, reason })).data;
}

export async function markLost(env, ctx, id, reason) {
  requirePermission(ctx, 'receipts.mark_lost');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'receipts', id);
  return (await repo.call('receipt.markLost', 'receipts', { id, reason })).data;
}

export async function history(env, ctx, id) {
  requirePermission(ctx, 'receipts.read');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'receipts', id);
  return (await repo.list('movements', {
    documentType: 'RECEIPT', documentId: id
  }, { orderBy: 'movement_date' })).data;
}
