/** Regression: batch creation must go through BatchService, not a raw insert. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadGs, ROOT } from './helpers/gas-harness.js';

const CTX = { requestId: 'req-batch', ip: '192.0.2.4', actor: { userId: 'admin', role: 'ADMIN' } };

function harness() {
  const audits = [];
  const h = loadGs(
    [
      'apps-script/utils/errors.gs',
      'apps-script/utils/helpers.gs',
      'apps-script/services/batch-service.gs'
    ],
    {
      TABLES: { book_batches: { id: 'batch_id' }, books: { id: 'book_id' } },
      AuditService: {
        write(ctx, entry) { audits.push({ ctx, entry }); return entry; }
      }
    }
  );
  return { ...h, audits };
}

test('router doInsert routes book_batches to BatchService before the generic insert', () => {
  const source = fs.readFileSync(`${ROOT}/apps-script/router.gs`, 'utf8');
  const start = source.indexOf('function doInsert(');
  const end = source.indexOf('function doUpdate(', start);
  assert.ok(start >= 0 && end > start, 'doInsert() not found');
  const body = source.slice(start, end);

  const batchRoute = body.search(/entity\s*===\s*'book_batches'[^;]*BatchService\.create\(ctx,\s*data\)/);
  const genericInsert = body.indexOf('SheetsAdapter.insertRow(');
  assert.ok(batchRoute >= 0, 'missing book_batches -> BatchService.create route');
  assert.ok(genericInsert >= 0, 'generic insert branch is expected for other entities');
  assert.ok(batchRoute < genericInsert,
    'book_batches must return before the generic insert + duplicate audit');

  // Guarding this in doInsert mirrors books/cheques/guarantees; the service
  // itself owns defaults, variance and its CREATE audit row.
  assert.match(body, /if \(entity === 'book_batches'\) return BatchService\.create\(ctx, data\);/);
});

test('BatchService.create seeds a valid EXPECTED batch with calculated variance', () => {
  const h = harness();
  const batch = h.sandbox.BatchService.create(CTX, {
    batch_number: 'BAT-TEST-001', supplier: 'Test Press', delivery_date: '2026-11-21',
    serial_from: 910000, serial_to: 910004, expected_quantity: 5, notes: 'unit'
  });

  assert.match(batch.batch_id, /^BAT_/);
  assert.equal(batch.status, 'EXPECTED');
  assert.equal(batch.registered_quantity, 0);
  assert.equal(batch.expected_quantity, 5);
  assert.equal(batch.variance, -5);
  assert.equal(batch.serial_from, 910000);
  assert.equal(batch.serial_to, 910004);
  assert.equal(h.audits.length, 1, 'service writes exactly one CREATE audit row');
  assert.equal(h.audits[0].entry.operation, 'CREATE');
  assert.equal(h.audits[0].entry.entityType, 'book_batches');
  assert.equal(h.audits[0].entry.entityId, batch.batch_id);
});

test('BatchService.create defaults expected_quantity and rejects invalid ranges', () => {
  const h = harness();
  const { BatchService } = h.sandbox;
  const batch = BatchService.create(CTX, {
    batch_number: 'BAT-TEST-002', supplier: 'Test Press', delivery_date: '2026-11-21',
    serial_from: 100, serial_to: 149
  });
  assert.equal(batch.expected_quantity, 50);
  assert.equal(batch.variance, -50);

  assert.throws(
    () => BatchService.create(CTX, {
      batch_number: 'BAT-BAD', supplier: 'X', delivery_date: '2026-11-21',
      serial_from: 20, serial_to: 10
    }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => BatchService.create(CTX, {
      batch_number: '', supplier: 'X', delivery_date: '2026-11-21',
      serial_from: 1, serial_to: 2
    }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
});

test('range guard and variance bookkeeping work on a service-created batch', () => {
  const h = harness();
  const { BatchService } = h.sandbox;
  const batch = BatchService.create(CTX, {
    batch_number: 'BAT-TEST-003', supplier: 'Test Press', delivery_date: '2026-11-21',
    serial_from: 200, serial_to: 204, expected_quantity: 5
  });

  assert.throws(
    () => BatchService.assertRange(batch, 200, 204),
    (error) => error.code === 'BATCH_NOT_ACTIVE'
  );
  assert.throws(
    () => BatchService.assertRange({ ...batch, status: 'ACTIVE' }, 199, 204),
    (error) => error.code === 'SERIAL_OUT_OF_RANGE'
  );
  assert.doesNotThrow(() => BatchService.assertRange({ ...batch, status: 'ACTIVE' }, 200, 204));

  const registered = BatchService.registerBooks(batch.batch_id, 5);
  assert.equal(registered.registered_quantity, 5);
  assert.equal(registered.variance, 0);
  assert.doesNotThrow(() => BatchService.assertCanClose(registered));
  assert.throws(
    () => BatchService.assertCanClose({ ...registered, registered_quantity: 4 }),
    (error) => error.code === 'VARIANCE_BLOCKS_CLOSE'
  );
});
