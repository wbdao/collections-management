/** Central transition guard + side effects for every stateful entity. */

var StateMachine = (function () {

  function allowed(entity, from, to) {
    var machine = STATE_MACHINES[entity];
    if (!machine) Errors.fail('UNKNOWN_ENTITY', 'No state machine for ' + entity);
    var targets = machine[from];
    if (!targets) Errors.fail('INVALID_STATE', 'Unknown current status: ' + from);
    return targets.indexOf(to) >= 0;
  }

  function beforeGuard(entity, id, row, toStatus, payload) {
    if (entity === 'book_batches' && toStatus === 'CLOSED') {
      BatchService.assertCanClose(row);
    }
    if (entity === 'book_batches' && toStatus === 'ACTIVE') {
      Errors.assert(row.status === 'INSPECTED', 'INVALID_TRANSITION', 'Batch must be INSPECTED before ACTIVE');
    }
    if (entity === 'cheques' && toStatus === 'CLEARING') {
      Errors.assert(!Helpers.isEmpty(payload.bankReference) && !Helpers.isEmpty(payload.expectedClearDate),
        'VALIDATION_ERROR', 'bankReference and expectedClearDate are required for CLEARING');
    }
    if (entity === 'cheques' && toStatus === 'CLEARED') {
      Errors.assert(!Helpers.isEmpty(payload.bankReference) && !Helpers.isEmpty(payload.clearedAt),
        'VALIDATION_ERROR', 'CLEARING -> CLEARED requires bank_reference and cleared_at');
    }
    if (entity === 'cheques' && toStatus === 'RETURNED') {
      Errors.assert(!Helpers.isEmpty(payload.returnReason), 'VALIDATION_ERROR', 'returnReason is required');
    }
    if (entity === 'receipts' && toStatus === 'COLLECTED') {
      Errors.assert(!Helpers.isEmpty(payload.account) && !Helpers.isEmpty(payload.amountMinor),
        'VALIDATION_ERROR', 'Account and amountMinor are required for collection');
    }
  }

  /** Runs inside one LockService transaction (Router wraps it). */
  function transition(ctx, entity, id, toStatus, payload) {
    payload = payload || {};
    var row = SheetsAdapter.findRow(entity, TABLES[entity].id, id);
    if (!row) Errors.notFound(entity, id);
    var from = row.status;

    if (!allowed(entity, from, toStatus)) {
      Errors.fail('INVALID_TRANSITION', 'Cannot move ' + entity + ' from ' + from + ' to ' + toStatus);
    }
    beforeGuard(entity, id, row, toStatus, payload);

    var patch = { status: toStatus };
    ['bankReference', 'expectedClearDate', 'clearedAt', 'returnReason'].forEach(function (key) {
      var column = key.replace(/[A-Z]/g, function (m) { return '_' + m.toLowerCase(); });
      if (payload[key] !== undefined) patch[column] = payload[key];
    });
    if (toStatus === 'CLEARING' && !Helpers.isEmpty(payload.bankReference)) {
      patch.clearing_started_at = Helpers.nowIso();
    }
    if (entity === 'books' && ['ASSIGNED', 'COMPLETED', 'CANCELLED', 'LOST'].indexOf(toStatus) >= 0) {
      // holder/location are maintained by BookService when custody actually changes
    }

    var updated = SheetsAdapter.updateRow(entity, id, patch, payload.expectedVersion);

    var label = ENTITY_LABEL[entity] || entity.toUpperCase();
    var numberField = {
      book_batches: 'batch_number', books: 'book_number', receipts: 'receipt_number',
      cheques: 'cheque_number', guarantees: 'guarantee_number'
    }[entity];
    var docNumber = row[numberField] || id;

    if (['books', 'receipts', 'cheques', 'guarantees'].indexOf(entity) >= 0) {
      MovementService.create(ctx, {
        documentType: label,
        documentId: id,
        documentNumber: docNumber,
        fromLocation: payload.fromLocation || row.current_location || 'WAREHOUSE',
        toLocation: payload.toLocation || row.current_location || 'WAREHOUSE',
        fromHolderId: payload.fromHolderId || row.current_holder_id || '',
        toHolderId: payload.toHolderId || payload.holderId || '',
        movementDate: payload.movementDate || Helpers.nowIso(),
        performedBy: ctx.actor && ctx.actor.userId ? ctx.actor.userId : (payload.performedBy || 'system'),
        reason: payload.reason || ('STATUS_' + toStatus),
        notes: payload.notes || '',
        relatedDepositId: payload.relatedDepositId || ''
      });
      TrackingService.upsertFromEntity(entity, updated);
      if (entity !== 'books') CustodyService.onTransition(ctx, entity, row, updated, payload);
    }

    if (entity === 'book_batches') {
      BatchService.afterTransition(ctx, row, updated);
    }

    AuditService.write(ctx, {
      operation: 'TRANSITION',
      entityType: entity,
      entityId: id,
      oldValue: { status: from },
      newValue: { status: toStatus },
      changed_fields: ['status'],
      result: 'SUCCESS'
    });

    return updated;
  }

  return { allowed: allowed, transition: transition };
})();
