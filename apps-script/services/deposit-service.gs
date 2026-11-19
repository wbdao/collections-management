/**
 * Branch and HQ deposits.
 * confirm() performs all six required effects inside ONE LockService transaction
 * (wrapped by Router): receipt status, receipt movement, custody ledger,
 * custody balances, tracking index, audit record.
 */

var DepositService = (function () {

  function tableFor(level) {
    return level === 'HQ' ? 'deposits_hq' : 'deposits_branch';
  }

  function create(ctx, level, data) {
    Errors.assert(level === 'BRANCH' || level === 'HQ', 'VALIDATION_ERROR', 'Invalid deposit level');
    var lines = data.lines || [];
    Errors.assert(lines.length > 0, 'VALIDATION_ERROR', 'Deposit requires at least one line');
    var total = 0;
    lines.forEach(function (line) {
      var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', line.receipt_id);
      if (!receipt) Errors.notFound('receipts', line.receipt_id);
      total += Number(line.amount_minor || receipt.amount_minor || 0);
    });

    // PHASE 2 / Step 4: structured treasury reference alongside legacy text.
    var treasuryId = data.treasury_id || TreasuryService.resolveOrDefault(
      level === 'HQ' ? 'HQ_TREASURY' : 'BRANCH_TREASURY',
      data.branch_id || data.warehouse || '');
    TreasuryService.get(treasuryId); // validate the foreign key

    var common = {
      treasury_id: treasuryId,
      deposit_number: (level === 'HQ' ? 'DH-' : 'DB-') + String(Helpers.sequence(level === 'HQ' ? 'DEP_H' : 'DEP_B')).padStart(5, '0'),
      branch_id: data.branch_id,
      deposit_date: data.deposit_date || Helpers.todayIso(),
      prepared_by: ctx.actor && ctx.actor.userId ? ctx.actor.userId : '',
      receipt_count: lines.length,
      total_minor: total,
      status: 'DRAFT',
      notes: data.notes || ''
    };
    var deposit = level === 'HQ'
      ? SheetsAdapter.insertRow('deposits_hq', Object.assign({
          deposit_id: Helpers.id('DEH'), hq_reference: data.hq_reference || '',
          approved_by: '', received_by: ''
        }, common))
      : SheetsAdapter.insertRow('deposits_branch', Object.assign({
          deposit_id: Helpers.id('DEB'), approved_by: '', received_by: ''
        }, common));

    lines.forEach(function (line) {
      SheetsAdapter.insertRow('deposit_lines', {
        line_id: Helpers.id('DLN'),
        deposit_id: deposit.deposit_id,
        deposit_level: level,
        receipt_id: line.receipt_id,
        amount_minor: Number(line.amount_minor || 0),
        line_status: 'PENDING',
        rejection_reason: ''
      });
    });

    AuditService.write(ctx, {
      operation: 'CREATE', entityType: tableFor(level), entityId: deposit.deposit_id,
      oldValue: null, newValue: deposit, result: 'SUCCESS'
    });
    return deposit;
  }

  /** Runs inside Router's withTransaction. */
  function confirm(ctx, depositId, level) {
    var entity = tableFor(level);
    var deposit = SheetsAdapter.findRow(entity, TABLES[entity].id, depositId);
    if (!deposit) Errors.notFound(entity, depositId);
    Errors.assert(['DRAFT', 'SUBMITTED', 'PARTIAL'].indexOf(deposit.status) >= 0,
      'INVALID_STATE', 'Deposit cannot be confirmed from ' + deposit.status);

    // PHASE 2 / Step 7: HQ deposits are gated when approvals.enabled is true.
    if (level === 'HQ' && typeof ApprovalService !== 'undefined') {
      ApprovalService.gate(ctx, 'HQ_DEPOSIT', depositId, 'CONFIRM', {
        description: 'Confirm HQ deposit ' + (deposit.deposit_number || depositId)
      });
    }

    var lines = SheetsAdapter.readRows('deposit_lines', {
      where: function (row) { return row.deposit_id === depositId && row.line_status !== 'REJECTED'; },
      orderBy: 'line_id', descending: false
    });
    Errors.assert(lines.length > 0, 'VALIDATION_ERROR', 'Deposit has no confirmable lines');

    var expected = level === 'HQ' ? 'DEPOSITED_BRANCH' : 'COLLECTED';
    var targetStatus = level === 'HQ' ? 'DEPOSITED_HQ' : 'DEPOSITED_BRANCH';
    var accepted = 0;
    var rejected = 0;
    var reason = level === 'HQ' ? 'DEPOSIT_TO_HQ' : 'DEPOSIT_TO_BRANCH';

    lines.forEach(function (line) {
      var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', line.receipt_id);
      if (!receipt || receipt.status !== expected) {
        SheetsAdapter.updateRow('deposit_lines', line.line_id, {
          line_status: 'REJECTED',
          rejection_reason: receipt ? 'Expected ' + expected + ', found ' + receipt.status : 'Receipt not found'
        }, line.version);
        rejected++;
        return;
      }

      // (1) receipt lineage fields; status change is applied by StateMachine below
      var lineage = level === 'HQ'
        ? { hq_deposit_id: depositId }
        : { branch_deposit_id: depositId };
      var patched = SheetsAdapter.updateRow('receipts', receipt.receipt_id, lineage, receipt.version);

      // (2) receipt movement + (5) tracking index + (6) audit are created by StateMachine
      StateMachine.transition(ctx, 'receipts', receipt.receipt_id, targetStatus, {
        fromLocation: level === 'HQ' ? 'BRANCH_TREASURY' : 'COLLECTOR',
        toLocation: level === 'HQ' ? 'HQ_TREASURY' : 'BRANCH_TREASURY',
        fromHolderId: level === 'HQ' ? (deposit.branch_id || 'BRANCH_TREASURY') : (receipt.collector_id || 'COLLECTOR'),
        toHolderId: level === 'HQ' ? 'HQ_TREASURY' : (deposit.branch_id || 'BRANCH_TREASURY'),
        relatedDepositId: depositId,
        reason: reason,
        notes: deposit.notes || ''
      });

      // (3) custody ledger + (4) custody balances
      var fromHolder = level === 'HQ' ? (deposit.branch_id || 'BRANCH_TREASURY') : (receipt.collector_id || 'COLLECTOR');
      var fromType = level === 'HQ' ? 'BRANCH_TREASURY' : 'COLLECTOR';
      var toHolder = level === 'HQ' ? 'HQ_TREASURY' : (deposit.branch_id || 'BRANCH_TREASURY');
      var toType = level === 'HQ' ? 'HQ_TREASURY' : 'BRANCH_TREASURY';
      var amount = Number(receipt.amount_minor || 0);
      CustodyService.record(ctx, {
        holderId: fromHolder, holderType: fromType, documentType: 'RECEIPT',
        documentId: receipt.receipt_id, documentNumber: receipt.receipt_number,
        eventType: reason, direction: 'OUT', countDelta: -1, amountDelta: -amount
      });
      CustodyService.record(ctx, {
        holderId: toHolder, holderType: toType, documentType: 'RECEIPT',
        documentId: receipt.receipt_id, documentNumber: receipt.receipt_number,
        eventType: reason, direction: 'IN', countDelta: 1, amountDelta: amount
      });

      // explicit tracking refresh after all fields are final
      TrackingService.upsertFromEntity('receipts',
        SheetsAdapter.findRow('receipts', 'receipt_id', receipt.receipt_id));

      SheetsAdapter.updateRow('deposit_lines', line.line_id, { line_status: 'ACCEPTED' }, line.version);
      accepted++;
    });

    var finalStatus = rejected === 0 ? 'CONFIRMED' : (accepted > 0 ? 'PARTIAL' : 'REJECTED');
    var headerPatch = { status: finalStatus, approved_by: ctx.actor && ctx.actor.userId ? ctx.actor.userId : '' };
    if (level === 'HQ') headerPatch.received_by = ctx.actor && ctx.actor.userId ? ctx.actor.userId : '';
    SheetsAdapter.updateRow(entity, depositId, headerPatch, deposit.version);

    AuditService.write(ctx, {
      operation: 'DEPOSIT_CONFIRMED', entityType: entity, entityId: depositId,
      oldValue: { status: deposit.status },
      newValue: { status: finalStatus, accepted: accepted, rejected: rejected, level: level },
      result: 'SUCCESS'
    });

    return {
      depositId: depositId,
      level: level,
      status: finalStatus,
      accepted: accepted,
      rejected: rejected,
      balances: [CustodyService.getBalance(receiptHolder(lines, level), 'RECEIPT')]
    };
  }

  function receiptHolder(lines, level) {
    if (!lines.length) return '';
    var receipt = SheetsAdapter.findRow('receipts', 'receipt_id', lines[0].receipt_id);
    return level === 'HQ' ? 'HQ_TREASURY' : (receipt ? receipt.collector_id : '');
  }

  return { create: create, confirm: confirm, tableFor: tableFor };
})();
