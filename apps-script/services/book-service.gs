/** Book lifecycle: creation with auto-generated receipts, assignment, return. */

var BookService = (function () {

  function nextBookNumber(data, batch) {
    if (!Helpers.isEmpty(data.book_number)) return data.book_number;
    return 'BK-' + String(batch.batch_number || 'BATCH') + '-' + String(data.serial_from);
  }

  /** Wrapped in one transaction by Router (entity = books). */
  function create(ctx, data) {
    Errors.assert(!Helpers.isEmpty(data.batch_id), 'VALIDATION_ERROR', 'batch_id is required');
    var batch = SheetsAdapter.findRow('book_batches', 'batch_id', data.batch_id);
    if (!batch) Errors.notFound('book_batches', data.batch_id);
    BatchService.assertRange(batch, data.serial_from, data.serial_to);

    var from = Number(data.serial_from);
    var to = Number(data.serial_to);
    Errors.assert(to >= from, 'VALIDATION_ERROR', 'serial_to must be >= serial_from');
    Errors.assert((to - from + 1) <= 10000, 'VALIDATION_ERROR', 'A book cannot exceed 10000 receipts');

    var book = SheetsAdapter.insertRow('books', {
      book_id: Helpers.id('BK'),
      book_number: nextBookNumber(data, batch),
      batch_id: data.batch_id,
      serial_from: from,
      serial_to: to,
      total_receipts: to - from + 1,
      issue_date: data.issue_date || Helpers.todayIso(),
      status: 'AVAILABLE',
      current_holder_id: '',
      current_holder_type: 'WAREHOUSE',
      current_location: 'WAREHOUSE',
      last_movement_id: '',
      notes: data.notes || ''
    });

    var receipts = [];
    for (var serial = from; serial <= to; serial++) {
      receipts.push({
        receipt_id: Helpers.id('RCP'),
        receipt_number: String(serial),
        book_id: book.book_id,
        sequence_in_book: serial - from + 1,
        // Blank stubs: Account/customer fields are validated and populated
        // by ReceiptService.collect() against the external customer master.
        customer_code: '',
        customer_name: '',
        warehouse: '',
        department: '',
        collector_id: '',
        collection_date: '',
        amount_minor: 0,
        payment_method: '',
        status: 'UNUSED',
        collection_id: '',
        branch_deposit_id: '',
        hq_deposit_id: '',
        cancelled_reason: '',
        last_receipt_movement_id: ''
      });
    }
    var inserted = SheetsAdapter.insertRows('receipts', receipts);

    inserted.forEach(function (receipt) {
      TrackingService.upsertFromEntity('receipts', receipt);
    });
    TrackingService.upsertFromEntity('books', book);
    BatchService.registerBooks(book.batch_id, inserted.length);

    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'books', entityId: book.book_id,
      oldValue: null,
      newValue: { book_number: book.book_number, receiptsCreated: inserted.length },
      result: 'SUCCESS'
    });
    return Object.assign({}, book, { receiptsCreated: inserted.length });
  }

  /** Wrapped in one transaction by Router (action = book.assign). */
  function assign(ctx, bookId, data) {
    var book = SheetsAdapter.findRow('books', 'book_id', bookId);
    if (!book) Errors.notFound('books', bookId);
    Errors.assert(book.status === 'AVAILABLE', 'INVALID_STATE', 'Only AVAILABLE books can be assigned');
    var collector = SheetsAdapter.findRow('users', 'user_id', data.assigned_to);
    if (!collector) Errors.notFound('users', data.assigned_to);
    Errors.assert(collector.role_id === 'ROLE_COLLECTOR', 'VALIDATION_ERROR', 'assign_to must be a COLLECTOR');

    var assignment = SheetsAdapter.insertRow('book_assignments', {
      assignment_id: Helpers.id('ASG'),
      book_id: bookId,
      assigned_to: data.assigned_to,
      assigned_by: ctx.actor && ctx.actor.userId ? ctx.actor.userId : '',
      assigned_at: data.assigned_at || Helpers.nowIso(),
      due_return_at: data.due_return_at || '',
      returned_at: '',
      received_by: '',
      condition_notes: data.notes || '',
      status: 'ACTIVE'
    });

    StateMachine.transition(ctx, 'books', bookId, 'ASSIGNED', {
      fromLocation: 'WAREHOUSE',
      toLocation: 'COLLECTOR',
      toHolderId: data.assigned_to,
      reason: 'BOOK_ASSIGNED',
      notes: data.notes || ''
    });

    // StateMachine only flips status for books; custody fields belong to this
    // service. Patch after the guarded transition succeeds so a rejected
    // transition can never leave a half-updated book, then refresh the tracking
    // index with the corrected holder/location.
    var updated = SheetsAdapter.updateRow('books', bookId, {
      current_holder_id: data.assigned_to,
      current_holder_type: 'COLLECTOR',
      current_location: 'COLLECTOR'
    });
    TrackingService.upsertFromEntity('books', updated);
    CustodyService.record(ctx, {
      holderId: '', holderType: 'WAREHOUSE', documentType: 'BOOK', documentId: bookId,
      documentNumber: book.book_number, eventType: 'BOOK_ASSIGNED', direction: 'OUT',
      countDelta: -1, amountDelta: 0
    });
    CustodyService.record(ctx, {
      holderId: data.assigned_to, holderType: 'COLLECTOR', documentType: 'BOOK', documentId: bookId,
      documentNumber: book.book_number, eventType: 'BOOK_ASSIGNED', direction: 'IN',
      countDelta: 1, amountDelta: 0
    });
    CustodyService.record(ctx, {
      holderId: data.assigned_to, holderType: 'COLLECTOR', documentType: 'RECEIPT', documentId: bookId,
      documentNumber: book.book_number, eventType: 'BOOK_ASSIGNED', direction: 'IN',
      countDelta: Number(book.total_receipts), amountDelta: 0
    });

    AuditService.write(ctx, {
      operation: 'BOOK_ASSIGNED', entityType: 'books', entityId: bookId,
      oldValue: { status: 'AVAILABLE', holder: '' },
      newValue: { status: 'ASSIGNED', holder: data.assigned_to, assignmentId: assignment.assignment_id },
      result: 'SUCCESS'
    });
    return { assignment: assignment, book: updated };
  }

  /** Wrapped in one transaction by Router (action = book.return). */
  function returnBook(ctx, bookId, data) {
    var book = SheetsAdapter.findRow('books', 'book_id', bookId);
    if (!book) Errors.notFound('books', bookId);
    Errors.assert(book.status === 'ASSIGNED', 'INVALID_STATE', 'Only ASSIGNED books can be returned');
    var assignment = SheetsAdapter.readRows('book_assignments', {
      where: function (r) { return r.book_id === bookId && r.status === 'ACTIVE'; },
      orderBy: 'assigned_at'
    })[0];
    if (!assignment) Errors.fail('NOT_FOUND', 'No active assignment for book ' + bookId);

    var unused = SheetsAdapter.readRows('receipts', {
      where: function (r) { return r.book_id === bookId && r.status === 'UNUSED'; }
    }).length;
    var unsettled = SheetsAdapter.readRows('receipts', {
      where: function (r) {
        return r.book_id === bookId && ['UNUSED', 'COLLECTED', 'DEPOSITED_BRANCH'].indexOf(r.status) >= 0;
      }
    }).length;
    var targetStatus = unsettled === 0 ? 'COMPLETED' : 'AVAILABLE';

    SheetsAdapter.updateRow('book_assignments', assignment.assignment_id, {
      returned_at: data.returned_at || Helpers.nowIso(),
      received_by: ctx.actor && ctx.actor.userId ? ctx.actor.userId : '',
      condition_notes: data.notes || assignment.condition_notes,
      status: 'RETURNED'
    }, assignment.version);

    StateMachine.transition(ctx, 'books', bookId, targetStatus, {
      fromLocation: 'COLLECTOR',
      toLocation: 'WAREHOUSE',
      fromHolderId: assignment.assigned_to,
      reason: 'BOOK_RETURNED',
      notes: data.notes || ''
    });

    // Mirror assign(): the guarded transition only changes status, so this
    // service clears custody back to the warehouse and refreshes tracking.
    var returned = SheetsAdapter.updateRow('books', bookId, {
      current_holder_id: '',
      current_holder_type: 'WAREHOUSE',
      current_location: 'WAREHOUSE'
    });
    TrackingService.upsertFromEntity('books', returned);

    CustodyService.record(ctx, {
      holderId: assignment.assigned_to, holderType: 'COLLECTOR', documentType: 'BOOK', documentId: bookId,
      documentNumber: book.book_number, eventType: 'BOOK_RETURNED', direction: 'OUT',
      countDelta: -1, amountDelta: 0
    });
    CustodyService.record(ctx, {
      holderId: '', holderType: 'WAREHOUSE', documentType: 'BOOK', documentId: bookId,
      documentNumber: book.book_number, eventType: 'BOOK_RETURNED', direction: 'IN',
      countDelta: 1, amountDelta: 0
    });
    if (unused > 0) {
      CustodyService.record(ctx, {
        holderId: assignment.assigned_to, holderType: 'COLLECTOR', documentType: 'RECEIPT', documentId: bookId,
        documentNumber: book.book_number, eventType: 'BOOK_RETURNED', direction: 'OUT',
        countDelta: -unused, amountDelta: 0
      });
    }

    AuditService.write(ctx, {
      operation: 'BOOK_RETURNED', entityType: 'books', entityId: bookId,
      oldValue: { status: 'ASSIGNED' },
      newValue: { status: targetStatus, unusedReceipts: unused },
      result: 'SUCCESS'
    });
    return { book: returned, unusedReceipts: unused, status: targetStatus };
  }

  return { create: create, assign: assign, returnBook: returnBook };
})();
