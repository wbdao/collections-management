/**
 * PHASE 2 / Step 7 — approval gates for sensitive transitions.
 *
 * Flag-gated by `approvals.enabled` (default false). When enabled, the first
 * attempt at a gated action creates a PENDING_APPROVAL row and raises
 * APPROVAL_REQUIRED; after an ADMIN/TREASURY decision the original action can
 * be retried and will pass. One open request per (entity, id, action).
 */
var ApprovalService = (function () {

  var ENTITY_TYPES = ['HQ_DEPOSIT', 'CHEQUE_STATUS_CHANGE', 'GUARANTEE_RELEASE'];
  var STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'];
  var APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

  function enabled() {
    var value = SheetsAdapter.getSetting('approvals.enabled');
    return value === true || value === 'TRUE';
  }

  function list(query) {
    query = query || {};
    return SheetsAdapter.readRows('approvals', {
      where: function (row) {
        if (query.status && row.status !== query.status) return false;
        if (query.entityType && row.entity_type !== query.entityType) return false;
        if (query.entityId && String(row.entity_id) !== String(query.entityId)) return false;
        return true;
      },
      orderBy: 'requested_at',
      descending: true,
      limit: query.limit || 200
    });
  }

  function get(id) {
    var row = SheetsAdapter.findRow('approvals', 'approval_id', id);
    if (!row) Errors.notFound('approvals', id);
    return row;
  }

  function findLatest(entityType, entityId, action) {
    return SheetsAdapter.readRows('approvals', {
      where: function (row) {
        return row.entity_type === entityType && String(row.entity_id) === String(entityId) &&
          row.action === action;
      },
      orderBy: 'requested_at',
      descending: true,
      limit: 1
    })[0] || null;
  }

  function expired(row) {
    return !!row.expires_at && new Date(row.expires_at).getTime() < Date.now();
  }

  /**
   * Called from gated business services. Throws APPROVAL_* errors via Errors.fail
   * so the surrounding Router transaction records the request before returning.
   */
  function gate(ctx, entityType, entityId, action, options) {
    if (!enabled()) return { allowed: true, gated: false };
    Errors.assert(ENTITY_TYPES.indexOf(entityType) >= 0, 'VALIDATION_ERROR', 'Invalid approval entity type');
    Errors.assert(!Helpers.isEmpty(entityId) && !Helpers.isEmpty(action),
      'VALIDATION_ERROR', 'entityId and action are required');

    var existing = findLatest(entityType, entityId, action);
    if (existing && !expired(existing)) {
      if (existing.status === 'APPROVED') {
        return { allowed: true, gated: true, approval: existing };
      }
      if (existing.status === 'REJECTED') {
        Errors.fail('APPROVAL_REJECTED',
          'This action was rejected: ' + (existing.decision_notes || 'no reason provided'));
      }
      Errors.fail('APPROVAL_REQUIRED', 'A decision is pending for this action.');
    }

    var approvalId = Helpers.id('APR');
    var row = SheetsAdapter.insertRow('approvals', {
      approval_id: approvalId,
      entity_type: entityType,
      entity_id: String(entityId),
      action: action,
      requested_by: (ctx.actor && ctx.actor.userId) || 'system',
      requested_at: Helpers.nowIso(),
      status: 'PENDING_APPROVAL',
      approver_id: '',
      decided_at: '',
      decision_notes: options && options.description ? String(options.description) : '',
      expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
    });
    AuditService.write(ctx, {
      operation: 'APPROVAL_REQUESTED', entityType: 'approvals', entityId: approvalId,
      oldValue: null, newValue: { entity_type: entityType, entity_id: entityId, action: action },
      result: 'SUCCESS'
    });
    Errors.fail('APPROVAL_REQUIRED', 'Approval is required before this action can proceed.');
    return { allowed: false, approval: row }; // unreachable; documents the contract
  }

  function decide(ctx, id, decision, notes) {
    Errors.assert(decision === 'APPROVED' || decision === 'REJECTED',
      'VALIDATION_ERROR', 'Decision must be APPROVED or REJECTED');
    var current = get(id);
    if (current.status !== 'PENDING_APPROVAL') {
      Errors.fail('APPROVAL_DECIDED', 'This approval has already been decided.');
    }
    if (expired(current)) {
      Errors.fail('APPROVAL_EXPIRED', 'This approval request has expired.');
    }
    if (String(current.requested_by) === String(ctx.actor && ctx.actor.userId)) {
      Errors.forbidden('You cannot decide your own approval request.');
    }

    var approverId = (ctx.actor && ctx.actor.userId) || 'system';
    var next = Helpers.clone(current);
    delete next._row;
    next.status = decision;
    next.approver_id = approverId;
    next.decided_at = Helpers.nowIso();
    next.decision_notes = String(notes || (decision === 'REJECTED' ? 'Rejected' : 'Approved'));
    var updated = SheetsAdapter.writeRowByNumber('approvals', current._row, next);

    AuditService.write(ctx, {
      operation: 'APPROVAL_DECIDED', entityType: 'approvals', entityId: id,
      oldValue: { status: current.status }, newValue: { status: decision, notes: next.decision_notes },
      result: 'SUCCESS'
    });
    if (typeof SecurityEventService !== 'undefined') {
      SecurityEventService.write({
        eventType: 'APPROVAL_DECIDED', userId: approverId, ip: ctx.ip || '',
        severity: decision === 'APPROVED' ? 'INFO' : 'WARNING',
        details: { approvalId: id, decision: decision, entityType: current.entity_type }
      });
    }
    return updated;
  }

  return {
    enabled: enabled, list: list, get: get, gate: gate, decide: decide
  };
})();
