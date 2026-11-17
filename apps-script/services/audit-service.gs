/**
 * Append-only audit. Phase 1 columns exactly as approved:
 * audit_id, request_id, user_id, operation, entity_type, entity_id,
 * old_value, new_value, changed_fields, timestamp, ip_address, result.
 * No hash chain in Phase 1.
 */
var AuditService = (function () {

  function write(ctx, input) {
    var actor = ctx && ctx.actor ? ctx.actor : (ctx || {});
    var oldValue = Helpers.toJson(input.oldValue === undefined ? null : input.oldValue);
    var newValue = Helpers.toJson(input.newValue === undefined ? null : input.newValue);
    var changed = input.changed_fields || Helpers.changedFields(
      Helpers.fromJson(oldValue), Helpers.fromJson(newValue)
    );
    return SheetsAdapter.insertRow('audit_logs', {
      audit_id: Helpers.id('AUD'),
      request_id: (ctx && ctx.requestId) || '',
      user_id: actor.userId || 'anonymous',
      operation: input.operation || 'UNKNOWN',
      entity_type: input.entityType || '',
      entity_id: input.entityId || '',
      old_value: oldValue,
      new_value: newValue,
      changed_fields: Helpers.toJson(changed),
      timestamp: Helpers.nowIso(),
      ip_address: (ctx && ctx.ip) || actor.ip || '',
      result: input.result || 'SUCCESS'
    });
  }

  function list(query) {
    return SheetsAdapter.readRows('audit_logs', {
      where: function (row) {
        if (query.userId && row.user_id !== query.userId) return false;
        if (query.entityType && row.entity_type !== query.entityType) return false;
        if (query.entityId && row.entity_id !== query.entityId) return false;
        if (query.operation && row.operation !== query.operation) return false;
        if (query.from && row.timestamp < query.from) return false;
        if (query.to && row.timestamp > query.to) return false;
        return true;
      },
      orderBy: 'timestamp'
    });
  }

  return { write: write, list: list };
})();
