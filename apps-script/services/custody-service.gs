/** Custody ledger, materialized balances and reconciliation exceptions. */

var CustodyService = (function () {

  function balanceKey(holderId, documentType) {
    return String(holderId || 'WAREHOUSE') + '|' + documentType;
  }

  function getBalance(holderId, documentType) {
    return SheetsAdapter.findRow('custody_balances', 'balance_id', balanceKey(holderId, documentType));
  }

  /** Appends one immutable ledger row and refreshes the materialized balance. */
  function record(ctx, entry) {
    Errors.assert(DOCUMENT_TYPES.indexOf(entry.documentType) >= 0, 'VALIDATION_ERROR', 'Invalid documentType');
    Errors.assert(entry.direction === 'IN' || entry.direction === 'OUT', 'VALIDATION_ERROR', 'Invalid direction');
    var holder = entry.holderId || entry.holderType;
    var balance = getBalance(holder, entry.documentType);
    var currentCount = balance ? Number(balance.document_count || 0) : 0;
    var currentAmount = balance ? Number(balance.total_amount_minor || 0) : 0;
    var nextCount = currentCount + Number(entry.countDelta || 0);
    var nextAmount = currentAmount + Number(entry.amountDelta || 0);
    var ts = Helpers.nowIso();

    var ledger = SheetsAdapter.insertRow('custody_ledger', {
      ledger_id: Helpers.id('LED'),
      holder_id: holder,
      holder_type: entry.holderType,
      document_type: entry.documentType,
      document_id: entry.documentId || '',
      document_number: entry.documentNumber || '',
      event_type: entry.eventType,
      direction: entry.direction,
      count_delta: Number(entry.countDelta || 0),
      amount_minor_delta: Number(entry.amountDelta || 0),
      balance_count_after: nextCount,
      balance_amount_after: nextAmount,
      occurred_at: entry.occurredAt || ts,
      recorded_by: ctx.actor && ctx.actor.userId ? ctx.actor.userId : '',
      request_id: ctx.requestId || '',
      created_at: ts
    });

    var status = 'BALANCED';
    if (nextCount < 0 || nextAmount < 0) status = 'SHORT';

    var updated = SheetsAdapter.upsert('custody_balances', 'balance_id', balanceKey(holder, entry.documentType), {
      holder_id: holder,
      holder_type: entry.holderType,
      document_type: entry.documentType,
      document_count: nextCount,
      total_amount_minor: nextAmount,
      last_event_at: entry.occurredAt || ts,
      calculated_at: ts,
      balance_status: status,
      version: balance ? Number(balance.version || 1) + 1 : 1,
      updated_at: ts
    });
    return { ledger: ledger, balance: updated };
  }

  /** Ledger effects for document status transitions (deposits handle their own lines). */
  function onTransition(ctx, entity, before, after, payload) {
    if (entity === 'receipts') return null; // receipt custody changes are explicit in collection/deposit services
    var holder = payload.toHolderId || (ctx.actor && ctx.actor.userId) || 'WAREHOUSE';
    var numberField = entity === 'cheques' ? 'cheque_number' : 'guarantee_number';
    var docNumber = after[numberField] || after.guarantee_id || after.cheque_id;
    var fromHolder = before.current_holder || 'BRANCH_TREASURY';
    var toHolder = payload.toLocation || (entity === 'cheques' ? 'BRANCH_TREASURY' : 'BRANCH_TREASURY');

    if (entity === 'cheques') {
      if (after.status === 'SENT_TO_HQ') {
        CustodyService.record(ctx, {
          holderId: fromHolder, holderType: 'BRANCH_TREASURY', documentType: 'CHEQUE',
          documentId: after.cheque_id, documentNumber: docNumber, eventType: 'CHEQUE_SENT',
          direction: 'OUT', countDelta: -1, amountDelta: -Number(after.amount_minor || 0)
        });
        CustodyService.record(ctx, {
          holderId: 'HQ_TREASURY', holderType: 'HQ_TREASURY', documentType: 'CHEQUE',
          documentId: after.cheque_id, documentNumber: docNumber, eventType: 'CHEQUE_SENT',
          direction: 'IN', countDelta: 1, amountDelta: Number(after.amount_minor || 0)
        });
      }
      if (after.status === 'AT_BANK') {
        CustodyService.record(ctx, {
          holderId: 'HQ_TREASURY', holderType: 'HQ_TREASURY', documentType: 'CHEQUE',
          documentId: after.cheque_id, documentNumber: docNumber, eventType: 'CHEQUE_TO_BANK',
          direction: 'OUT', countDelta: -1, amountDelta: -Number(after.amount_minor || 0)
        });
        CustodyService.record(ctx, {
          holderId: 'BANK', holderType: 'BANK', documentType: 'CHEQUE',
          documentId: after.cheque_id, documentNumber: docNumber, eventType: 'CHEQUE_TO_BANK',
          direction: 'IN', countDelta: 1, amountDelta: Number(after.amount_minor || 0)
        });
      }
      if (after.status === 'RETURNED' && before.status === 'CLEARING') {
        CustodyService.record(ctx, {
          holderId: 'BANK', holderType: 'BANK', documentType: 'CHEQUE',
          documentId: after.cheque_id, documentNumber: docNumber, eventType: 'CHEQUE_RETURNED',
          direction: 'OUT', countDelta: -1, amountDelta: -Number(after.amount_minor || 0)
        });
        CustodyService.record(ctx, {
          holderId: 'BRANCH_TREASURY', holderType: 'BRANCH_TREASURY', documentType: 'CHEQUE',
          documentId: after.cheque_id, documentNumber: docNumber, eventType: 'CHEQUE_RETURNED',
          direction: 'IN', countDelta: 1, amountDelta: Number(after.amount_minor || 0)
        });
      }
    }

    if (entity === 'guarantees' && after.status !== before.status) {
      var target = { AT_HQ: 'HQ_TREASURY', LEGAL_DEPARTMENT: 'LEGAL', RELEASED: 'WAREHOUSE', CLOSED: 'WAREHOUSE' }[after.status];
      if (target) {
        CustodyService.record(ctx, {
          holderId: fromHolder, holderType: 'BRANCH_TREASURY', documentType: 'GUARANTEE',
          documentId: after.guarantee_id, documentNumber: docNumber, eventType: 'GUARANTEE_MOVED',
          direction: 'OUT', countDelta: -1, amountDelta: -Number(after.amount_minor || 0)
        });
        CustodyService.record(ctx, {
          holderId: target, holderType: target === 'LEGAL' ? 'LEGAL' : 'WAREHOUSE', documentType: 'GUARANTEE',
          documentId: after.guarantee_id, documentNumber: docNumber, eventType: 'GUARANTEE_MOVED',
          direction: 'IN', countDelta: 1, amountDelta: Number(after.amount_minor || 0)
        });
      }
    }
    return { holder: holder, to: toHolder };
  }

  /** Compares balances against source tables; writes reconciliation exceptions on variance. */
  function reconcile(ctx) {
    var exceptions = [];
    var balances = SheetsAdapter.readRows('custody_balances');
    balances.forEach(function (balance) {
      var holder = balance.holder_id;
      var expectedCount = 0;
      var expectedAmount = 0;
      if (balance.document_type === 'BOOK') {
        expectedCount = SheetsAdapter.readRows('book_assignments', {
          where: function (r) { return r.assigned_to === holder && r.status === 'ACTIVE'; }
        }).length;
      } else if (balance.document_type === 'RECEIPT') {
        var receipts = SheetsAdapter.readRows('receipts', {
          where: function (r) {
            return r.collector_id === holder && ['UNUSED', 'COLLECTED'].indexOf(r.status) >= 0;
          }
        });
        expectedCount = receipts.length;
        expectedAmount = receipts.reduce(function (sum, r) {
          return sum + (r.status === 'COLLECTED' ? Number(r.amount_minor || 0) : 0);
        }, 0);
      } else if (balance.document_type === 'CHEQUE') {
        var cheques = SheetsAdapter.readRows('cheques', { where: function (r) { return r.current_holder === holder; } });
        expectedCount = cheques.length;
        expectedAmount = cheques.reduce(function (s, r) { return s + Number(r.amount_minor || 0); }, 0);
      } else if (balance.document_type === 'GUARANTEE') {
        var guarantees = SheetsAdapter.readRows('guarantees', { where: function (r) { return r.current_holder === holder; } });
        expectedCount = guarantees.length;
        expectedAmount = guarantees.reduce(function (s, r) { return s + Number(r.amount_minor || 0); }, 0);
      }

      var countVariance = expectedCount - Number(balance.document_count || 0);
      var amountVariance = expectedAmount - Number(balance.total_amount_minor || 0);
      if (countVariance !== 0 || amountVariance !== 0) {
        exceptions.push(SheetsAdapter.insertRow('reconciliation_exceptions', {
          exception_id: Helpers.id('REC'),
          holder_id: holder,
          document_type: balance.document_type,
          expected_count: expectedCount,
          actual_count: Number(balance.document_count || 0),
          expected_amount_minor: expectedAmount,
          actual_amount_minor: Number(balance.total_amount_minor || 0),
          detected_at: Helpers.nowIso(),
          resolved_at: '',
          resolution_notes: '',
          status: 'OPEN'
        }));
        SheetsAdapter.updateRow('custody_balances', balance.balance_id, {
          balance_status: (countVariance < 0 || amountVariance < 0) ? 'SHORT' : 'OVER'
        }, balance.version);
        AlertService.raise(ctx, {
          alertType: 'CUSTODY_VARIANCE', entityType: balance.document_type, entityId: holder,
          bucket: 'NA', dueDate: Helpers.todayIso()
        });
      }
    });
    if (exceptions.length) {
      // PHASE 2 / Step 5: a failed reconciliation is its own alert category.
      AlertService.raise(ctx, {
        alertType: 'FAILED_RECONCILIATION', entityType: 'reconciliation_exceptions',
        entityId: 'RUN_' + Helpers.todayIso(), bucket: 'NA', dueDate: Helpers.todayIso()
      });
    }
    AuditService.write(ctx, {
      operation: 'CUSTODY_RECONCILE', entityType: 'custody_balances', entityId: 'all',
      oldValue: null, newValue: { exceptionsCreated: exceptions.length }, result: 'SUCCESS'
    });
    return { exceptionsCreated: exceptions.length, exceptions: exceptions };
  }

  return { record: record, getBalance: getBalance, onTransition: onTransition, reconcile: reconcile };
})();
