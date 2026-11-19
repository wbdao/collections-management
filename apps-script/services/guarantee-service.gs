/** Guarantees: customer inheritance, lifecycle, expiry bucket calculation. */

var GuaranteeService = (function () {

  /** Applies customer master values onto a guarantee (create or update). */
  function applyCustomer(data) {
    var guarantee = Helpers.clone(data);
    var account = CustomerMasterService.accountFrom(guarantee);
    if (!account) return guarantee;
    var customer = CustomerMasterService.getCustomer(account);
    guarantee.customer_code = customer.customer_code;
    guarantee.customer_name = customer.customer_name;
    guarantee.warehouse = customer.warehouse;
    guarantee.department = customer.department;
    return guarantee;
  }

  /** Warehouse Group filter (no warehouse master table). */
  function matchesWarehouse(row, query) {
    var wanted = query.warehouse || query.warehouseGroup || query.warehouseId || '';
    if (!wanted && query.warehouseIds && query.warehouseIds.length) wanted = query.warehouseIds;
    if (!wanted || (Array.isArray(wanted) && !wanted.length)) return true;
    if (Array.isArray(wanted)) return wanted.indexOf(row.warehouse) >= 0;
    return row.warehouse === wanted;
  }

  function bucket(expiryDate) {
    if (Helpers.isEmpty(expiryDate)) return 'NA';
    var days = Helpers.daysUntil(expiryDate);
    if (days < 0) return 'EXPIRED';
    if (days <= 7) return 'DUE_7';
    if (days <= 15) return 'DUE_15';
    if (days <= 30) return 'DUE_30';
    return 'NA';
  }

  function create(ctx, data) {
    Errors.assert(!Helpers.isEmpty(data.guarantee_number), 'VALIDATION_ERROR', 'guarantee_number is required');
    var account = CustomerMasterService.accountFrom(data);
    if (!account) Errors.fail('VALIDATION_ERROR', 'Account is required to create a guarantee');
    CustomerMasterService.getCustomer(account);

    var guarantee = applyCustomer(data);
    var treasuryId = data.treasury_id || TreasuryService.resolveOrDefault('BRANCH_TREASURY', guarantee.warehouse);
    TreasuryService.get(treasuryId);
    var row = SheetsAdapter.insertRow('guarantees', {
      treasury_id: treasuryId,
      guarantee_id: Helpers.id('GRT'),
      guarantee_number: guarantee.guarantee_number,
      customer_code: guarantee.customer_code,
      customer_name: guarantee.customer_name,
      warehouse: guarantee.warehouse,
      department: guarantee.department,
      contract_number: guarantee.contract_number || '',
      amount_minor: Number(guarantee.amount_minor || 0),
      issue_date: guarantee.issue_date || Helpers.todayIso(),
      expiry_date: guarantee.expiry_date || '',
      status: 'AT_BRANCH',
      current_holder: 'BRANCH_TREASURY',
      current_location: 'BRANCH_TREASURY',
      last_movement_id: ''
    });
    TrackingService.upsertFromEntity('guarantees', row);
    CustodyService.record(ctx, {
      holderId: 'BRANCH_TREASURY', holderType: 'BRANCH_TREASURY', documentType: 'GUARANTEE',
      documentId: row.guarantee_id, documentNumber: row.guarantee_number, eventType: 'GUARANTEE_RECEIVED',
      direction: 'IN', countDelta: 1, amountDelta: Number(row.amount_minor || 0)
    });
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'guarantees', entityId: row.guarantee_id,
      oldValue: null, newValue: row, result: 'SUCCESS'
    });
    return row;
  }

  function update(ctx, id, patch, version) {
    var current = SheetsAdapter.findRow('guarantees', 'guarantee_id', id);
    if (!current) Errors.notFound('guarantees', id);
    var updated = SheetsAdapter.updateRow('guarantees', id, applyCustomer(patch), version);
    TrackingService.upsertFromEntity('guarantees', updated);
    AuditService.write(ctx, {
      operation: 'UPDATE', entityType: 'guarantees', entityId: id,
      oldValue: current, newValue: updated, result: 'SUCCESS'
    });
    return updated;
  }

  function transition(ctx, id, toStatus, payload) {
    // PHASE 2 / Step 7: releasing a guarantee is gated.
    if (toStatus === 'RELEASED' && typeof ApprovalService !== 'undefined') {
      ApprovalService.gate(ctx, 'GUARANTEE_RELEASE', id, 'RELEASE', {
        description: 'Release guarantee ' + id
      });
    }
    var result = StateMachine.transition(ctx, 'guarantees', id, toStatus, payload);
    var guarantee = SheetsAdapter.findRow('guarantees', 'guarantee_id', id);
    var holder = { AT_HQ: 'HQ_TREASURY', LEGAL_DEPARTMENT: 'LEGAL', RELEASED: 'WAREHOUSE', CLOSED: 'WAREHOUSE' }[toStatus];
    if (holder) {
      SheetsAdapter.updateRow('guarantees', id, {
        current_holder: holder,
        current_location: holder,
        treasury_id: TreasuryService.resolveForLegacy(holder, guarantee.warehouse) || guarantee.treasury_id || ''
      }, guarantee.version);
      TrackingService.upsertFromEntity('guarantees', SheetsAdapter.findRow('guarantees', 'guarantee_id', id));
    }
    return result;
  }

  function expiring(query) {
    var wanted = query.bucket ? [query.bucket] : ['DUE_30', 'DUE_15', 'DUE_7', 'EXPIRED'];
    return SheetsAdapter.readRows('guarantees', {
      where: function (row) {
        if (['RELEASED', 'CLOSED'].indexOf(row.status) >= 0) return false;
        return wanted.indexOf(bucket(row.expiry_date)) >= 0 && matchesWarehouse(row, query);
      },
      orderBy: 'expiry_date', descending: false
    }).map(function (row) { return Object.assign({}, row, { alert_bucket: bucket(row.expiry_date) }); });
  }

  return {
    applyCustomer: applyCustomer,
    create: create, update: update, transition: transition,
    expiring: expiring, bucket: bucket
  };
})();
