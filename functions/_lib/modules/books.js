/** Book business module (edge side). */

import { createRepository } from '../repository.js';
import { requirePermission } from '../rbac.js';
import { applyScope, getInScope, guardScope, scopeForCreate } from '../scope.js';

export async function list(env, ctx, query = {}) {
  requirePermission(ctx, 'books.read');
  const repo = createRepository(env, ctx);
  return (await repo.list('books', applyScope(ctx, query), { orderBy: 'issue_date' })).data;
}

export async function get(env, ctx, id) {
  requirePermission(ctx, 'books.read');
  const repo = createRepository(env, ctx);
  return getInScope(repo, ctx, 'books', id);
}

export async function create(env, ctx, data) {
  requirePermission(ctx, 'books.create');
  const repo = createRepository(env, ctx);
  return (await repo.insert('books', scopeForCreate(ctx, data))).data;
}

export async function update(env, ctx, id, patch, version) {
  requirePermission(ctx, 'books.create');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'books', id);
  return (await repo.update('books', id, patch, version)).data;
}

export async function transition(env, ctx, id, status, payload = {}) {
  requirePermission(ctx, 'books.transition');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'books', id);
  return (await repo.transition('books', id, status, payload)).data;
}

export async function assign(env, ctx, id, data) {
  requirePermission(ctx, 'books.assign');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'books', id);
  return (await repo.call('book.assign', 'books', { id, ...data })).data;
}

export async function returnBook(env, ctx, id, data = {}) {
  requirePermission(ctx, 'books.return');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'books', id);
  return (await repo.call('book.return', 'books', { id, ...data })).data;
}

export async function receipts(env, ctx, id) {
  requirePermission(ctx, 'books.read');
  const repo = createRepository(env, ctx);
  await guardScope(repo, ctx, 'books', id);
  return (await repo.list('receipts', { bookId: id }, { orderBy: 'sequence_in_book', descending: false })).data;
}
