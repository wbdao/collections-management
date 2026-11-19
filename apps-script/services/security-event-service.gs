/**
 * PHASE 2 / M008 — append-only security event log.
 * Kept separate from tbl_audit_logs so verifyAuditChain() can log failures
 * without extending the chain it is verifying.
 */
var SecurityEventService = (function () {

  function write(input) {
    var event = {
      event_id: Helpers.id('SEC'),
      event_type: input.eventType || 'UNKNOWN',
      user_id: input.userId || 'anonymous',
      ip_address: input.ip || '',
      request_id: input.requestId || '',
      details_json: Helpers.toJson(input.details || null),
      severity: input.severity || 'INFO',
      created_at: Helpers.nowIso()
    };
    try {
      return SheetsAdapter.insertRow('security_events', event);
    } catch (err) {
      // Security logging must never break the operation that triggered it.
      return event;
    }
  }

  function list(query) {
    query = query || {};
    return SheetsAdapter.readRows('security_events', {
      where: function (row) {
        if (query.eventType && row.event_type !== query.eventType) return false;
        if (query.userId && row.user_id !== query.userId) return false;
        if (query.severity && row.severity !== query.severity) return false;
        if (query.from && row.created_at < query.from) return false;
        return true;
      },
      orderBy: 'created_at',
      limit: query.limit || 200
    });
  }

  return { write: write, list: list };
})();
