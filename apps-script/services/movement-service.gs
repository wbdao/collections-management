/** Movement records for BOOK, RECEIPT, CHEQUE and GUARANTEE. */

var MovementService = (function () {

  var ENTITY_FOR_TYPE = {
    BOOK: 'books', RECEIPT: 'receipts', CHEQUE: 'cheques', GUARANTEE: 'guarantees'
  };

  function create(ctx, input) {
    Errors.assert(DOCUMENT_TYPES.indexOf(input.documentType) >= 0, 'VALIDATION_ERROR', 'Invalid documentType');
    var treasuryId = input.treasuryId || TreasuryService.resolveForLegacy(
      input.toHolderId, input.warehouse || input.toLocation || '');
    var movement = SheetsAdapter.insertRow('movements', {
      treasury_id: treasuryId,
      movement_id: Helpers.id('MOV'),
      document_type: input.documentType,
      document_id: input.documentId || '',
      document_number: input.documentNumber || '',
      from_location: input.fromLocation || '',
      to_location: input.toLocation || '',
      from_holder_id: input.fromHolderId || '',
      to_holder_id: input.toHolderId || '',
      movement_date: input.movementDate || Helpers.nowIso(),
      performed_by: input.performedBy || (ctx.actor && ctx.actor.userId) || 'system',
      authorized_by: input.authorizedBy || '',
      reason: input.reason || '',
      notes: input.notes || '',
      related_deposit_id: input.relatedDepositId || '',
      request_id: ctx.requestId || ''
    });

    var entity = ENTITY_FOR_TYPE[input.documentType];
    var idField = TABLES[entity].id;
    var doc = input.documentId ? SheetsAdapter.findRow(entity, idField, input.documentId) : null;
    if (doc) {
      SheetsAdapter.updateRow(entity, doc[idField], { last_movement_id: movement.movement_id }, doc.version);
    }
    TrackingService.touchMovement(input.documentType, input.documentNumber, movement.movement_date);

    AuditService.write(ctx, {
      operation: 'MOVEMENT_CREATE', entityType: 'movements', entityId: movement.movement_id,
      oldValue: null,
      newValue: {
        document_type: movement.document_type, document_number: movement.document_number,
        from_location: movement.from_location, to_location: movement.to_location
      },
      result: 'SUCCESS'
    });
    return movement;
  }

  function list(query) {
    return SheetsAdapter.readRows('movements', {
      where: function (row) {
        if (query.documentType && row.document_type !== query.documentType) return false;
        if (query.documentId && row.document_id !== query.documentId) return false;
        if (query.documentNumber && row.document_number !== query.documentNumber) return false;
        if (query.from && row.movement_date < query.from) return false;
        if (query.to && row.movement_date > query.to) return false;
        return true;
      },
      orderBy: 'movement_date'
    });
  }

  function history(documentType, documentNumber) {
    return SheetsAdapter.readRows('movements', {
      where: function (row) {
        return row.document_type === documentType && row.document_number === documentNumber;
      },
      orderBy: 'movement_date', descending: false
    });
  }

  return { create: create, list: list, history: history };
})();
