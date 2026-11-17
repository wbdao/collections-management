/** Receipt-level rules: customer inheritance, collection, cancellation, loss. */

var ReceiptService = (function () {

  /**
   * Applies customer master values onto a receipt. A blank account is allowed
   * for the UNUSED stubs auto-generated when a book is created; the real
   * validation happens when the receipt is collected (see collect()).
   */
  function applyCustomer(data, receipt) {
    var account = CustomerMasterService.accountFrom(data);
    if (!account) return receipt;
    var customer = CustomerMasterService.getCustomer(account);
    receipt.customer_code = customer.customer_code;
    receipt.customer_name = customer.customer_name;
    receipt.warehouse = customer.warehouse;
    receipt.department = customer.department;
    return receipt;
  }

  function beforeInsert(data) {
    var receipt = Helpers.clone(data);
    if (receipt.status !== 'UNUSED') Errors.fail('VALIDATION_ERROR', 'Receipts are created as UNUSED');
    return applyCustomer(receipt, receipt);
  }

  function getByNumber(number) {
    var row = SheetsAdapter.findRow('receipts', 'receipt_number', number);
    if (!row) Errors.notFound('receipts', number);
    return row;
  }

  /** Wrapped in one transaction by Router (action = receipt.collect). */
  function collect(ctx, receiptId, data) {
    var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', receiptId);
    if (!receipt) Errors.notFound('receipts', receiptId);
    if (receipt.status !== 'UNUSED') Errors.fail('INVALID_STATE', 'Receipt must be UNUSED to collect');

    // Account is mandatory at collection time. Unknown accounts are rejected
    // with CUSTOMER_NOT_FOUND by CustomerMasterService.
    var account = CustomerMasterService.accountFrom(data) || CustomerMasterService.accountFrom(receipt);
    if (!account) Errors.fail('VALIDATION_ERROR', 'Account is required to collect a receipt');
    var customer = CustomerMasterService.getCustomer(account);

    var book = SheetsAdapter.findRow('books', 'book_id', receipt.book_id);
    var collectorId = data.collector_id || (ctx.actor && ctx.actor.userId) || receipt.collector_id;

    var collection = CollectionService.createForReceipt(ctx, {
      collector_id: collectorId,
      book_id: receipt.book_id,
      account: customer.customer_code,
      collection_date: data.collection_date || Helpers.todayIso(),
      amount_minor: Number(data.amount_minor),
      notes: data.notes || ''
    });

    var patch = {
      customer_code: customer.customer_code,
      customer_name: customer.customer_name,
      warehouse: customer.warehouse,
      department: customer.department,
      collector_id: collectorId,
      collection_date: data.collection_date || Helpers.todayIso(),
      amount_minor: Number(data.amount_minor),
      payment_method: data.payment_method || 'CASH',
      collection_id: collection.collection_id
    };
    SheetsAdapter.updateRow('receipts', receiptId, patch, receipt.version);

    StateMachine.transition(ctx, 'receipts', receiptId, 'COLLECTED', {
      fromLocation: 'WAREHOUSE',
      toLocation: 'COLLECTOR',
      toHolderId: collectorId,
      reason: 'RECEIPT_COLLECTED',
      notes: data.notes || '',
      account: customer.customer_code,
      amountMinor: Number(data.amount_minor)
    });

    CustodyService.record(ctx, {
      holderId: collectorId, holderType: 'COLLECTOR', documentType: 'RECEIPT', documentId: receiptId,
      documentNumber: receipt.receipt_number, eventType: 'RECEIPT_COLLECTED', direction: 'IN',
      countDelta: 0, amountDelta: Number(data.amount_minor)
    });

    AuditService.write(ctx, {
      operation: 'RECEIPT_COLLECTED', entityType: 'receipts', entityId: receiptId,
      oldValue: { status: 'UNUSED', amount_minor: 0 },
      newValue: {
        status: 'COLLECTED', amount_minor: Number(data.amount_minor),
        customer_code: customer.customer_code
      },
      result: 'SUCCESS'
    });

    return {
      receipt: SheetsAdapter.findRow('receipts', 'receipt_id', receiptId),
      collection: collection,
      bookNumber: book ? book.book_number : ''
    };
  }

  function cancel(ctx, receiptId, reason) {
    var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', receiptId);
    if (!receipt) Errors.notFound('receipts', receiptId);
    var updated = StateMachine.transition(ctx, 'receipts', receiptId, 'CANCELLED', {
      reason: 'RECEIPT_CANCELLED', notes: reason || ''
    });
    if (receipt.status === 'COLLECTED' && receipt.collector_id) {
      CustodyService.record(ctx, {
        holderId: receipt.collector_id, holderType: 'COLLECTOR', documentType: 'RECEIPT', documentId: receiptId,
        documentNumber: receipt.receipt_number, eventType: 'RECEIPT_CANCELLED', direction: 'OUT',
        countDelta: -1, amountDelta: -Number(receipt.amount_minor || 0)
      });
    }
    AuditService.write(ctx, {
      operation: 'RECEIPT_CANCELLED', entityType: 'receipts', entityId: receiptId,
      oldValue: { status: receipt.status }, newValue: { status: 'CANCELLED', reason: reason || '' }, result: 'SUCCESS'
    });
    return updated;
  }

  function markLost(ctx, receiptId, reason) {
    var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', receiptId);
    if (!receipt) Errors.notFound('receipts', receiptId);
    var updated = StateMachine.transition(ctx, 'receipts', receiptId, 'LOST', {
      reason: 'RECEIPT_LOST', notes: reason || ''
    });
    AuditService.write(ctx, {
      operation: 'RECEIPT_LOST', entityType: 'receipts', entityId: receiptId,
      oldValue: { status: receipt.status }, newValue: { status: 'LOST', reason: reason || '' }, result: 'SUCCESS'
    });
    return updated;
  }

  return {
    beforeInsert: beforeInsert,
    getByNumber: getByNumber,
    collect: collect,
    cancel: cancel,
    markLost: markLost
  };
})();
