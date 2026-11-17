/** Idempotent alerts: guarantee expiry 30/15/7, overdue cheques, custody variance. */

var AlertService = (function () {

  function findExisting(alertType, entityType, entityId, bucket) {
    return SheetsAdapter.readRows('alerts').filter(function (row) {
      return row.alert_type === alertType && row.entity_type === entityType &&
        row.entity_id === entityId && row.bucket === bucket;
    })[0] || null;
  }

  /** Idempotent: one alert per (type, entity, bucket) for the lifetime of the record. */
  function raise(ctx, input) {
    Errors.assert(ALERT_TYPES.indexOf(input.alertType) >= 0, 'VALIDATION_ERROR', 'Invalid alertType');
    var existing = findExisting(input.alertType, input.entityType, input.entityId, input.bucket || 'NA');
    if (existing) return { alert: existing, created: false };

    var alert = SheetsAdapter.insertRow('alerts', {
      alert_id: Helpers.id('ALT'),
      alert_type: input.alertType,
      entity_type: input.entityType,
      entity_id: input.entityId,
      bucket: input.bucket || 'NA',
      due_date: input.dueDate || Helpers.todayIso(),
      status: 'ACTIVE',
      created_at: Helpers.nowIso(),
      acknowledged_by: '',
      acknowledged_at: ''
    });
    AuditService.write(ctx, {
      operation: 'ALERT_RAISED', entityType: 'alerts', entityId: alert.alert_id,
      oldValue: null, newValue: { alert_type: alert.alert_type, bucket: alert.bucket }, result: 'SUCCESS'
    });
    return { alert: alert, created: true };
  }

  function acknowledge(ctx, alertId) {
    var alert = SheetsAdapter.findRow('alerts', 'alert_id', alertId);
    if (!alert) Errors.notFound('alerts', alertId);
    var updated = SheetsAdapter.updateRow('alerts', alertId, {
      status: 'ACKNOWLEDGED',
      acknowledged_by: ctx.actor && ctx.actor.userId ? ctx.actor.userId : '',
      acknowledged_at: Helpers.nowIso()
    }, alert.version);
    AuditService.write(ctx, {
      operation: 'ALERT_ACKNOWLEDGE', entityType: 'alerts', entityId: alertId,
      oldValue: { status: alert.status }, newValue: { status: 'ACKNOWLEDGED' }, result: 'SUCCESS'
    });
    return updated;
  }

  /** Daily scan — all writes occur inside Router's transaction. */
  function dailyScan(ctx) {
    var created = 0;
    var today = Helpers.todayIso();

    SheetsAdapter.readRows('guarantees', {
      where: function (r) { return ['RELEASED', 'CLOSED'].indexOf(r.status) < 0; }
    }).forEach(function (guarantee) {
      var bucket = GuaranteeService.bucket(guarantee.expiry_date);
      if (['DUE_30', 'DUE_15', 'DUE_7', 'EXPIRED'].indexOf(bucket) >= 0) {
        var result = raise(ctx, {
          alertType: 'GUARANTEE_EXPIRY', entityType: 'guarantees',
          entityId: guarantee.guarantee_id, bucket: bucket, dueDate: guarantee.expiry_date
        });
        if (result.created) created++;
      }
    });

    SheetsAdapter.readRows('cheques', {
      where: function (r) {
        return r.due_date && r.due_date < today && ['CLEARED', 'RETURNED'].indexOf(r.status) < 0;
      }
    }).forEach(function (cheque) {
      var result = raise(ctx, {
        alertType: 'CHEQUE_OVERDUE', entityType: 'cheques',
        entityId: cheque.cheque_id, bucket: 'NA', dueDate: cheque.due_date
      });
      if (result.created) created++;
    });

    SheetsAdapter.readRows('reconciliation_exceptions', {
      where: function (r) { return r.status === 'OPEN'; }
    }).forEach(function (exception) {
      var result = raise(ctx, {
        alertType: 'CUSTODY_VARIANCE', entityType: 'reconciliation_exceptions',
        entityId: exception.exception_id, bucket: 'NA', dueDate: today
      });
      if (result.created) created++;
    });

    AuditService.write(ctx, {
      operation: 'ALERT_SCAN', entityType: 'alerts', entityId: 'daily',
      oldValue: null, newValue: { created: created, scannedAt: Helpers.nowIso() }, result: 'SUCCESS'
    });
    return { created: created, scannedAt: Helpers.nowIso() };
  }

  function list(query) {
    return SheetsAdapter.readRows('alerts', {
      where: function (row) {
        if (query.alertType && row.alert_type !== query.alertType) return false;
        if (query.bucket && row.bucket !== query.bucket) return false;
        if (query.status && row.status !== query.status) return false;
        if (query.entityType && row.entity_type !== query.entityType) return false;
        return true;
      },
      orderBy: 'created_at'
    });
  }

  function summary() {
    var rows = SheetsAdapter.readRows('alerts', { where: function (r) { return r.status === 'ACTIVE'; } });
    var result = { GUARANTEE_EXPIRY: {}, CHEQUE_OVERDUE: 0, CUSTODY_VARIANCE: 0 };
    rows.forEach(function (row) {
      if (row.alert_type === 'GUARANTEE_EXPIRY') {
        result.GUARANTEE_EXPIRY[row.bucket] = (result.GUARANTEE_EXPIRY[row.bucket] || 0) + 1;
      } else if (row.alert_type === 'CHEQUE_OVERDUE') {
        result.CHEQUE_OVERDUE++;
      } else if (row.alert_type === 'CUSTODY_VARIANCE') {
        result.CUSTODY_VARIANCE++;
      }
    });
    return result;
  }

  return { raise: raise, acknowledge: acknowledge, dailyScan: dailyScan, list: list, summary: summary };
})();
