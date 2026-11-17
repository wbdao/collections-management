/** Cheques: customer inheritance, full lifecycle including CLEARING, overdue tracking. */

var ChequeService = (function () {

  /**
   * Applies customer master values onto a cheque. Used for both create and
   * update; on update an omitted account simply leaves the stored values.
   */
  function applyCustomer(data) {
    var cheque = Helpers.clone(data);
    var account = CustomerMasterService.accountFrom(cheque);
    if (!account) return cheque;
    var customer = CustomerMasterService.getCustomer(account);
    cheque.customer_code = customer.customer_code;
    cheque.customer_name = customer.customer_name;
    cheque.warehouse = customer.warehouse;
    cheque.department = customer.department;
    return cheque;
  }

  /** Warehouse Group filter (no warehouse master table). */
  function matchesWarehouse(row, query) {
    var wanted = query.warehouse || query.warehouseGroup || query.warehouseId || '';
    if (!wanted && query.warehouseIds && query.warehouseIds.length) wanted = query.warehouseIds;
    if (!wanted || (Array.isArray(wanted) && !wanted.length)) return true;
    if (Array.isArray(wanted)) return wanted.indexOf(row.warehouse) >= 0;
    return row.warehouse === wanted;
  }

  function create(ctx, data) {
    Errors.assert(!Helpers.isEmpty(data.cheque_number), 'VALIDATION_ERROR', 'cheque_number is required');
    var account = CustomerMasterService.accountFrom(data);
    if (!account) Errors.fail('VALIDATION_ERROR', 'Account is required to create a cheque');
    // Validates existence up front; unknown accounts raise CUSTOMER_NOT_FOUND.
    CustomerMasterService.getCustomer(account);

    var cheque = applyCustomer(data);
    var row = SheetsAdapter.insertRow('cheques', {
      cheque_id: Helpers.id('CHQ'),
      cheque_number: cheque.cheque_number,
      customer_code: cheque.customer_code,
      customer_name: cheque.customer_name,
      warehouse: cheque.warehouse,
      department: cheque.department,
      cheque_date: cheque.cheque_date || Helpers.todayIso(),
      due_date: cheque.due_date || '',
      bank: cheque.bank || '',
      amount_minor: Number(cheque.amount_minor || 0),
      status: 'AT_BRANCH',
      clearing_started_at: '',
      expected_clear_date: '',
      bank_reference: '',
      cleared_at: '',
      return_reason: '',
      current_holder: 'BRANCH_TREASURY',
      current_location: 'BRANCH_TREASURY',
      last_movement_id: ''
    });
    TrackingService.upsertFromEntity('cheques', row);
    CustodyService.record(ctx, {
      holderId: 'BRANCH_TREASURY', holderType: 'BRANCH_TREASURY', documentType: 'CHEQUE',
      documentId: row.cheque_id, documentNumber: row.cheque_number, eventType: 'CHEQUE_RECEIVED',
      direction: 'IN', countDelta: 1, amountDelta: Number(row.amount_minor || 0)
    });
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'cheques', entityId: row.cheque_id,
      oldValue: null, newValue: row, result: 'SUCCESS'
    });
    return row;
  }

  function update(ctx, id, patch, version) {
    var current = SheetsAdapter.findRow('cheques', 'cheque_id', id);
    if (!current) Errors.notFound('cheques', id);
    var next = applyCustomer(patch);
    var updated = SheetsAdapter.updateRow('cheques', id, next, version);
    TrackingService.upsertFromEntity('cheques', updated);
    AuditService.write(ctx, {
      operation: 'UPDATE', entityType: 'cheques', entityId: id,
      oldValue: current, newValue: updated, result: 'SUCCESS'
    });
    return updated;
  }

  function transition(ctx, id, toStatus, payload) {
    var result = StateMachine.transition(ctx, 'cheques', id, toStatus, payload);
    var cheque = SheetsAdapter.findRow('cheques', 'cheque_id', id);
    var holder = {
      SENT_TO_HQ: 'HQ_TREASURY', AT_BANK: 'BANK', CLEARING: 'BANK',
      CLEARED: 'BANK', RETURNED: 'BRANCH_TREASURY'
    }[toStatus];
    if (holder) {
      SheetsAdapter.updateRow('cheques', id, {
        current_holder: holder,
        current_location: holder
      }, cheque.version);
      TrackingService.upsertFromEntity('cheques',
        SheetsAdapter.findRow('cheques', 'cheque_id', id));
    }
    return result;
  }

  function overdue(query) {
    var today = Helpers.todayIso();
    return SheetsAdapter.readRows('cheques', {
      where: function (row) {
        if (!row.due_date || row.due_date >= today) return false;
        if (['CLEARED', 'RETURNED'].indexOf(row.status) >= 0) return false;
        return matchesWarehouse(row, query);
      },
      orderBy: 'due_date', descending: false
    });
  }

  function clearing(query) {
    return SheetsAdapter.readRows('cheques', {
      where: function (row) {
        return row.status === 'CLEARING' && matchesWarehouse(row, query);
      },
      orderBy: 'expected_clear_date', descending: false
    });
  }

  return {
    applyCustomer: applyCustomer,
    create: create, update: update, transition: transition,
    overdue: overdue, clearing: clearing
  };
})();
