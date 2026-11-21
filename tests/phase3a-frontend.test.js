/** Phase 3A — source-level regression checks for the Batches and Books screens. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATE_MACHINES } from '../shared/constants/enums.js';
import { BATCH_TRANSITIONS, BOOK_TRANSITIONS } from '../frontend/js/config.js';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const app = read('../frontend/js/app.js');
const batches = read('../frontend/js/pages/batches.js');
const books = read('../frontend/js/pages/books.js');
const shell = read('../frontend/js/components/shell.js');

test('app.js mounts real Batches and Books pages instead of stubs', () => {
  assert.match(app, /import batches from '\.\/pages\/batches\.js'/);
  assert.match(app, /import books from '\.\/pages\/books\.js'/);
  assert.match(app, /\{ path: '\/batches', page: batches \}/);
  assert.match(app, /\{ path: '\/books', page: books \}/);
  assert.doesNotMatch(app, /stubPage\('Book Batches'/);
  assert.doesNotMatch(app, /stubPage\('Books'/);
  // Every other stub stays untouched for later phases.
  assert.match(app, /stubPage\('Receipts'/);
  assert.match(app, /stubPage\('Collections'/);
});

test('navigation still exposes both workspaces with their README permissions', () => {
  assert.match(shell, /path: '\/batches',[\s\S]*?permission: 'batches\.read'/);
  assert.match(shell, /path: '\/books',[\s\S]*?permission: 'books\.read'/);
  assert.match(batches, /permission: 'batches\.read'/);
  assert.match(books, /permission: 'books\.read'/);
});

test('batches page covers list, create, report-relevant fields and transitions', () => {
  for (const endpoint of [
    "api.get('/batches'", '/batches/${encodeURIComponent(id)}/books',
    "api.post('/batches', body)", '/batches/${encodeURIComponent(id)}/transition'
  ]) {
    assert.ok(batches.includes(endpoint), `batches.js missing ${endpoint}`);
  }
  for (const field of ['batch_number', 'supplier', 'delivery_date', 'serial_from', 'serial_to', 'expected_quantity']) {
    assert.ok(batches.includes(field), `batches.js missing create field ${field}`);
  }
  assert.match(batches, /variance/);
  assert.match(batches, /can\('batches\.create'\)/);
  assert.match(batches, /can\('batches\.manage'\)/);
});

test('books page covers create, receipts, assign, return and transition', () => {
  for (const endpoint of [
    "api.get('/books'", "api.post('/books', body)",
    '/books/${encodeURIComponent(id)}/receipts',
    '/books/${encodeURIComponent(book.book_id)}/assign',
    '/books/${encodeURIComponent(node.dataset.bookId)}/return',
    '/books/${encodeURIComponent(node.dataset.bookId)}/transition'
  ]) {
    assert.ok(books.includes(endpoint), `books.js missing ${endpoint}`);
  }
  for (const field of ['batch_id', 'serial_from', 'serial_to', 'issue_date']) {
    assert.ok(books.includes(field), `books.js missing create field ${field}`);
  }
  assert.ok(books.includes('UNUSED'), 'books.js must explain that generated receipts start UNUSED');
  assert.match(books, /can\('books\.assign'\)/);
  assert.match(books, /can\('books\.return'\)/);
  assert.match(books, /can\('books\.transition'\)/);
  assert.match(books, /batchFromHash\(\)/);
});

test('frontend transition maps mirror the shared state machine', () => {
  assert.deepEqual({ ...BATCH_TRANSITIONS }, { ...STATE_MACHINES.book_batches });
  // ASSIGNED/AVAILABLE transfers use the dedicated assign/return endpoints.
  const expectedBooks = Object.fromEntries(Object.entries(STATE_MACHINES.books).map(
    ([status, next]) => [status, next.filter((s) => s !== 'ASSIGNED' && s !== 'AVAILABLE')]
  ));
  assert.deepEqual({ ...BOOK_TRANSITIONS }, expectedBooks);
});

test('browser pages never import server-only shared modules', () => {
  for (const source of [batches, books]) {
    assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/shared\//);
    assert.doesNotMatch(source, /\brequire\(/);
  }
});
