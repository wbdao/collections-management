/**
 * Collection sessions. A collector collects against a receipt and a customer.
 *
 * tbl_collections intentionally has no customer columns — customer master data
 * is never stored here. The Account is still validated against the external
 * customer master before a collection is created (CUSTOMER_NOT_FOUND on miss).
 */

var CollectionService = (function () {

  /** Validates the account and returns the resolved master customer. */
  function requireCustomer(data, receipts) {
    var account = CustomerMasterService.accountFrom(data);
    if (!account && receipts && receipts.length) {
      account = CustomerMasterService.accountFrom(receipts[0]);
    }
    if (!account) Errors.fail('VALIDATION_ERROR', 'Account is required to create a collection');
    return CustomerMasterService.getCustomer(account);
  }

  function createForReceipt(ctx, data) {
    requireCustomer(data);
    return SheetsAdapter.insertRow('collections', {
      collection_id: Helpers.id('COL'),
      collector_id: data.collector_id,
      book_id: data.book_id || '',
      collection_date: data.collection_date || Helpers.todayIso(),
      receipt_count: 1,
      total_minor: Number(data.amount_minor || 0),
      status: 'SUBMITTED',
      notes: data.notes || ''
    });
  }

  function create(ctx, data) {
    var receipts = data.receipt_ids || [];
    var resolved = receipts.map(function (id) {
      var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', id);
      if (!receipt) Errors.notFound('receipts', id);
      if (receipt.status !== 'UNUSED') Errors.fail('INVALID_STATE', 'Receipt ' + id + ' is not UNUSED');
      return receipt;
    });
    requireCustomer(data, resolved);

    var total = resolved.reduce(function (sum, receipt) {
      return sum + Number(data.amounts && data.amounts[receipt.receipt_id]
        ? data.amounts[receipt.receipt_id] : (receipt.amount_minor || 0));
    }, 0);

    var collection = SheetsAdapter.insertRow('collections', {
      collection_id: Helpers.id('COL'),
      collector_id: data.collector_id || (ctx.actor && ctx.actor.userId) || '',
      book_id: data.book_id || '',
      collection_date: data.collection_date || Helpers.todayIso(),
      receipt_count: resolved.length,
      total_minor: total,
      status: 'SUBMITTED',
      notes: data.notes || ''
    });
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'collections', entityId: collection.collection_id,
      oldValue: null, newValue: collection, result: 'SUCCESS'
    });
    return collection;
  }

  function reconcile(ctx, collectionId) {
    var collection = SheetsAdapter.findRow('collections', 'collection_id', collectionId);
    if (!collection) Errors.notFound('collections', collectionId);
    var linked = SheetsAdapter.readRows('receipts', {
      where: function (r) { return r.collection_id === collectionId; }
    });
    var total = linked.reduce(function (s, r) { return s + Number(r.amount_minor || 0); }, 0);
    var status = total === Number(collection.total_minor || 0) ? 'RECONCILED' : 'VARIANCE';
    var updated = SheetsAdapter.updateRow('collections', collectionId, {
      receipt_count: linked.length, total_minor: total, status: status
    }, collection.version);
    if (status === 'VARIANCE') {
      AlertService.raise(ctx, {
        alertType: 'CUSTODY_VARIANCE', entityType: 'collections', entityId: collectionId,
        bucket: 'NA', dueDate: Helpers.todayIso()
      });
    }
    AuditService.write(ctx, {
      operation: 'COLLECTION_RECONCILE', entityType: 'collections', entityId: collectionId,
      oldValue: { status: collection.status, total_minor: collection.total_minor },
      newValue: { status: status, total_minor: total }, result: 'SUCCESS'
    });
    return updated;
  }

  return { createForReceipt: createForReceipt, create: create, reconcile: reconcile };
})();
