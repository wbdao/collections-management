/** Book custody fields must follow assign/return, not just the status flag. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';

const CTX = { requestId: 'req-book', ip: '192.0.2.4', actor: { userId: 'USR_ADMIN', role: 'ADMIN' } };

function harness() {
  const custody = [];
  const tracking = [];
  const h = loadGs(
    [
      'apps-script/utils/errors.gs',
      'apps-script/utils/helpers.gs',
      'apps-script/constants.gs',
      'apps-script/data/tables.gs',
      'apps-script/services/batch-service.gs',
      'apps-script/services/state-machine.gs',
      'apps-script/services/book-service.gs'
    ],
    {
      AuditService: { write() { return {}; } },
      CustodyService: { record(ctx, entry) { custody.push(entry); return entry; } },
      MovementService: { create() { return { movement_id: 'MOV_TEST' }; } },
      TrackingService: {
        upsertFromEntity(entity, row) {
          tracking.push({ entity, row: { ...row } });
          return {};
        }
      }
    }
  );
  return { ...h, custody, tracking };
}

function seed(h) {
  const { SheetsAdapter } = h.sandbox;
  SheetsAdapter.insertRow('users', {
    user_id: 'COL_1', username: 'collector1', role_id: 'ROLE_COLLECTOR', status: 'ACTIVE'
  });
  const book = SheetsAdapter.insertRow('books', {
    book_id: 'BK_1', book_number: 'BK-1', batch_id: 'BAT_1',
    serial_from: 100, serial_to: 104, total_receipts: 5,
    issue_date: '2026-11-21', status: 'AVAILABLE',
    current_holder_id: '', current_holder_type: 'WAREHOUSE', current_location: 'WAREHOUSE',
    last_movement_id: '', notes: '', version: 1
  });
  for (let i = 0; i < 5; i++) {
    SheetsAdapter.insertRow('receipts', {
      receipt_id: `RCP_${i + 1}`, receipt_number: String(100 + i),
      book_id: book.book_id, status: 'UNUSED', amount_minor: 0, version: 1
    });
  }
  return book;
}

test('assign sets collector holder/location and refreshes the tracking index', () => {
  const h = harness();
  seed(h);

  const result = h.sandbox.BookService.assign(CTX, 'BK_1', { assigned_to: 'COL_1', notes: 'unit' });

  assert.equal(result.book.status, 'ASSIGNED');
  assert.equal(result.book.current_holder_id, 'COL_1');
  assert.equal(result.book.current_holder_type, 'COLLECTOR');
  assert.equal(result.book.current_location, 'COLLECTOR');
  assert.equal(result.assignment.assigned_to, 'COL_1');

  const indexed = h.tracking.filter((t) => t.entity === 'books').at(-1);
  assert.ok(indexed, 'tracking index was refreshed for the book');
  assert.equal(indexed.row.current_holder_id, 'COL_1');
  assert.equal(indexed.row.current_location, 'COLLECTOR');
  assert.equal(h.custody.length, 3, 'warehouse OUT + collector BOOK/RECEIPT IN');
});

test('return clears holder/location back to the warehouse', () => {
  const h = harness();
  seed(h);
  h.sandbox.BookService.assign(CTX, 'BK_1', { assigned_to: 'COL_1', notes: 'unit' });

  const result = h.sandbox.BookService.returnBook(CTX, 'BK_1', { notes: 'unit return' });

  assert.equal(result.status, 'AVAILABLE', 'all receipts still UNUSED -> AVAILABLE');
  assert.equal(result.book.status, 'AVAILABLE');
  assert.equal(result.book.current_holder_id, '');
  assert.equal(result.book.current_holder_type, 'WAREHOUSE');
  assert.equal(result.book.current_location, 'WAREHOUSE');

  const indexed = h.tracking.filter((t) => t.entity === 'books').at(-1);
  assert.equal(indexed.row.current_holder_id, '');
  assert.equal(indexed.row.current_location, 'WAREHOUSE');
  assert.equal(h.custody.length, 6, '3 on assign + 3 on return');
});

test('a rejected transition never writes custody fields', () => {
  const h = harness();
  seed(h);
  // Force the row out of the state assign() accepts, without touching holder.
  h.sandbox.SheetsAdapter.updateRow('books', 'BK_1', { status: 'LOST' });
  const before = h.sandbox.SheetsAdapter.findRow('books', 'book_id', 'BK_1');

  assert.throws(
    () => h.sandbox.BookService.assign(CTX, 'BK_1', { assigned_to: 'COL_1' }),
    (error) => error.code === 'INVALID_STATE'
  );

  const after = h.sandbox.SheetsAdapter.findRow('books', 'book_id', 'BK_1');
  assert.equal(after.current_holder_id, before.current_holder_id);
  assert.equal(after.current_location, before.current_location);
  assert.equal(h.tracking.length, 0, 'no tracking refresh on a failed transition');
});
