/** Printing-house batch management. Variance is always calculated and stored. */

var BatchService = (function () {

  function calculateVariance(batch) {
    return Number(batch.registered_quantity || 0) - Number(batch.expected_quantity || 0);
  }

  function create(ctx, data) {
    Errors.assert(!Helpers.isEmpty(data.batch_number), 'VALIDATION_ERROR', 'batch_number is required');
    Errors.assert(!Helpers.isEmpty(data.serial_from) && !Helpers.isEmpty(data.serial_to), 'VALIDATION_ERROR', 'serial range is required');
    Errors.assert(Number(data.serial_to) >= Number(data.serial_from), 'VALIDATION_ERROR', 'serial_to must be >= serial_from');
    var batch = SheetsAdapter.insertRow('book_batches', {
      batch_id: Helpers.id('BAT'),
      batch_number: data.batch_number,
      supplier: data.supplier || '',
      delivery_date: data.delivery_date || '',
      invoice_reference: data.invoice_reference || '',
      serial_from: Number(data.serial_from),
      serial_to: Number(data.serial_to),
      expected_quantity: Number(data.expected_quantity || (Number(data.serial_to) - Number(data.serial_from) + 1)),
      registered_quantity: 0,
      variance: 0,
      received_by: '',
      inspected_by: '',
      status: 'EXPECTED',
      notes: data.notes || ''
    });
    batch.variance = calculateVariance(batch);
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'book_batches', entityId: batch.batch_id,
      oldValue: null, newValue: batch, result: 'SUCCESS'
    });
    return batch;
  }

  function assertCanClose(batch) {
    var variance = calculateVariance(batch);
    Errors.assert(variance === 0, 'VARIANCE_BLOCKS_CLOSE',
      'Batch variance must be zero before CLOSE (current variance: ' + variance + ')');
  }

  function assertRange(batch, serialFrom, serialTo) {
    Errors.assert(batch.status === 'ACTIVE', 'BATCH_NOT_ACTIVE', 'Books require an ACTIVE batch');
    Errors.assert(Number(serialFrom) >= Number(batch.serial_from) && Number(serialTo) <= Number(batch.serial_to),
      'SERIAL_OUT_OF_RANGE', 'Book serial range must fall inside the ACTIVE batch range');
  }

  function registerBooks(batchId, count) {
    var batch = SheetsAdapter.findRow('book_batches', 'batch_id', batchId);
    if (!batch) return null;
    var registered = Number(batch.registered_quantity || 0) + Number(count || 0);
    var patch = { registered_quantity: registered, variance: registered - Number(batch.expected_quantity || 0) };
    return SheetsAdapter.updateRow('book_batches', batchId, patch, batch.version);
  }

  function afterTransition(ctx, before, after) {
    AuditService.write(ctx, {
      operation: 'BATCH_TRANSITION', entityType: 'book_batches', entityId: after.batch_id,
      oldValue: { status: before.status, variance: before.variance },
      newValue: { status: after.status, variance: after.variance },
      result: 'SUCCESS'
    });
  }

  function books(batchId) {
    return SheetsAdapter.readRows('books', {
      where: function (row) { return row.batch_id === batchId; },
      orderBy: 'serial_from', descending: false
    });
  }

  function report(query) {
    return SheetsAdapter.readRows('book_batches', {
      where: function (row) {
        return !query.status || row.status === query.status;
      },
      orderBy: 'delivery_date'
    }).map(function (row) {
      return Object.assign({}, row, { computed_variance: calculateVariance(row) });
    });
  }

  return {
    create: create,
    calculateVariance: calculateVariance,
    assertCanClose: assertCanClose,
    assertRange: assertRange,
    registerBooks: registerBooks,
    afterTransition: afterTransition,
    books: books,
    report: report
  };
})();
