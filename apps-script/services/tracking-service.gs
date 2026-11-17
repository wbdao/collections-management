/** Universal tracking index across BOOK, RECEIPT, CHEQUE and GUARANTEE. */

var TrackingService = (function () {

  var MAP = {
    books: { type: 'BOOK', number: 'book_number', holder: 'current_holder_id', location: 'current_location' },
    receipts: { type: 'RECEIPT', number: 'receipt_number', holder: 'collector_id', location: '' },
    cheques: { type: 'CHEQUE', number: 'cheque_number', holder: 'current_holder', location: 'current_location' },
    guarantees: { type: 'GUARANTEE', number: 'guarantee_number', holder: 'current_holder', location: 'current_location' }
  };

  function key(type, number) {
    return String(type) + '|' + String(number);
  }

  function locationFor(entity, row) {
    var map = MAP[entity];
    if (map.location && row[map.location]) return row[map.location];
    if (entity === 'receipts') {
      if (row.status === 'DEPOSITED_HQ') return 'HQ_TREASURY';
      if (row.status === 'DEPOSITED_BRANCH') return 'BRANCH_TREASURY';
      return row.collector_id ? 'COLLECTOR' : 'WAREHOUSE';
    }
    return row.status === 'AVAILABLE' ? 'WAREHOUSE' : '';
  }

  function holderFor(entity, row) {
    var map = MAP[entity];
    var holder = row[map.holder];
    if (entity === 'receipts' && !holder) {
      if (row.status === 'DEPOSITED_HQ') return 'HQ_TREASURY';
      if (row.status === 'DEPOSITED_BRANCH') return row.branch_deposit_id || 'BRANCH_TREASURY';
      return 'WAREHOUSE';
    }
    return holder || '';
  }

  function upsertFromEntity(entity, row) {
    var map = MAP[entity];
    if (!map || Helpers.isEmpty(row[map.number])) return null;
    return SheetsAdapter.upsert('idx_tracking', 'track_key', key(map.type, row[map.number]), {
      entity_type: map.type,
      entity_id: row[TABLES[entity].id],
      current_status: row.status || '',
      current_holder: holderFor(entity, row),
      current_location: locationFor(entity, row),
      last_movement_at: row.last_movement_id ? (SheetsAdapter.findRow('movements', 'movement_id', row.last_movement_id) || {}).movement_date || '' : '',
      updated_at: Helpers.nowIso()
    });
  }

  function touchMovement(type, number, movementDate) {
    var row = SheetsAdapter.findRow('idx_tracking', 'track_key', key(type, number));
    if (!row) return null;
    return SheetsAdapter.updateRow('idx_tracking', row.track_key, {
      last_movement_at: movementDate || Helpers.nowIso(), updated_at: Helpers.nowIso()
    });
  }

  function related(entityType, entityId) {
    if (entityType === 'RECEIPT') {
      var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', entityId);
      if (!receipt) return {};
      return {
        bookId: receipt.book_id,
        account: receipt.customer_code,
        collectionId: receipt.collection_id,
        branchDepositId: receipt.branch_deposit_id,
        hqDepositId: receipt.hq_deposit_id
      };
    }
    if (entityType === 'BOOK') {
      var book = SheetsAdapter.findRow('books', 'book_id', entityId);
      return book ? { batchId: book.batch_id } : {};
    }
    if (entityType === 'CHEQUE' || entityType === 'GUARANTEE') {
      var entity = entityType === 'CHEQUE' ? 'cheques' : 'guarantees';
      var doc = SheetsAdapter.findRow(entity, TABLES[entity].id, entityId);
      return doc ? { account: doc.customer_code, warehouse: doc.warehouse, department: doc.department } : {};
    }
    return {};
  }

  /** Customer master view required on every tracking result. */
  function customerInfo(entityType, entityId) {
    var blank = {
      account: '', name: '', warehouseGroup: '', customerGroup: '',
      account_status: '', accountStatus: ''
    };
    var entity = {
      BOOK: 'books', RECEIPT: 'receipts', CHEQUE: 'cheques', GUARANTEE: 'guarantees'
    }[entityType];
    if (!entity || entity === 'books') return blank;

    var doc = SheetsAdapter.findRow(entity, TABLES[entity].id, entityId);
    if (!doc) return blank;

    var info = {
      account: doc.customer_code || '',
      name: doc.customer_name || '',
      warehouseGroup: doc.warehouse || '',
      customerGroup: doc.department || '',
      account_status: '',
      accountStatus: ''
    };
    if (!info.account) return info;

    try {
      var customer = CustomerMasterService.getCustomer(info.account);
      var status = customer.account_status || customer.customer_status || '';
      return {
        account: customer.customer_code,
        name: customer.customer_name || info.name,
        warehouseGroup: customer.warehouse || info.warehouseGroup,
        customerGroup: customer.department || info.customerGroup,
        account_status: status,
        accountStatus: status
      };
    } catch (e) {
      // Master temporarily unavailable (or account removed): still show the
      // values denormalized onto the document at creation time.
      return info;
    }
  }

  function buildResult(row) {
    if (!row) return null;
    return {
      match: {
        type: row.entity_type,
        number: String(row.track_key).split('|').slice(1).join('|'),
        entityId: row.entity_id,
        status: row.current_status,
        currentHolder: row.current_holder,
        currentLocation: row.current_location,
        lastMovementAt: row.last_movement_at
      },
      customer: customerInfo(row.entity_type, row.entity_id),
      movements: MovementService.history(row.entity_type, String(row.track_key).split('|').slice(1).join('|')),
      timeline: MovementService.history(row.entity_type, String(row.track_key).split('|').slice(1).join('|')).map(function (m) {
        return {
          at: m.movement_date, event: m.reason || 'MOVEMENT', actor: m.performed_by,
          from: m.from_location, to: m.to_location, notes: m.notes
        };
      }),
      related: related(row.entity_type, row.entity_id)
    };
  }

  function track(number) {
    var rows = SheetsAdapter.readRows('idx_tracking', {
      where: function (row) { return String(row.track_key).endsWith('|' + String(number)); },
      limit: 10
    });
    if (!rows.length) Errors.notFound('tracking', number);
    return buildResult(rows[0]);
  }

  function trackTyped(type, number) {
    var row = SheetsAdapter.findRow('idx_tracking', 'track_key', key(type, number));
    if (!row) Errors.notFound('tracking', type + '|' + number);
    return buildResult(row);
  }

  return {
    upsertFromEntity: upsertFromEntity,
    touchMovement: touchMovement,
    track: track,
    trackTyped: trackTyped
  };
})();
