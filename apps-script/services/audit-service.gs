/**
 * Append-only audit with SHA-256 hash chain (PHASE 2 / M001).
 *
 * Column order is FIXED and appended at the end of tbl_audit_logs:
 *   audit_id, request_id, user_id, operation, entity_type, entity_id,
 *   old_value, new_value, changed_fields, timestamp, ip_address, result,
 *   audit_hash, previous_hash
 *
 * The canonical payload is ASCII-escaped JSON (same convention as the edge/GAS
 * HMAC envelope) so a row hashes identically in Apps Script and in Node tests.
 * Every write happens inside the Router's LockService transaction, so the
 * chain tip in tbl_settings is read/updated without races.
 */
var AuditService = (function () {

  var AUDIT_FIELDS = [
    'audit_id', 'request_id', 'user_id', 'operation', 'entity_type', 'entity_id',
    'old_value', 'new_value', 'changed_fields', 'timestamp', 'ip_address', 'result'
  ];
  var GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';
  var SETTING_GENESIS = 'audit_chain_genesis';
  var SETTING_TIP = 'audit_chain_tip';
  var SETTING_VERIFIED = 'audit_chain_last_verified';

  /** Escape non-ASCII so Utilities.computeDigest sees identical bytes to JS. */
  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007F-\uFFFF]/g, function (ch) {
      return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      out += ('0' + b.toString(16)).slice(-2);
    }
    return out;
  }

  /** Fixed field order + the previous hash; never includes audit_hash itself. */
  function canonicalPayload(row) {
    var values = AUDIT_FIELDS.map(function (field) {
      var value = row && row[field] !== undefined && row[field] !== null ? row[field] : '';
      return String(value);
    });
    values.push(String((row && row.previous_hash) || ''));
    return asciiJson(values);
  }

  function hashHex(payload) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload);
    return bytesToHex(bytes);
  }

  function computeHash(row) {
    return hashHex(canonicalPayload(row));
  }

  function genesis() {
    return String(SheetsAdapter.getSetting(SETTING_GENESIS) || GENESIS);
  }

  function tip() {
    return String(SheetsAdapter.getSetting(SETTING_TIP) || genesis());
  }

  function setTip(value) {
    SheetsAdapter.setSetting(SETTING_TIP, value, 'SHA-256 audit chain tip', 'audit-service');
  }

  /** Append one audit row and extend the chain. Returns the stored row. */
  function write(ctx, input) {
    var actor = ctx && ctx.actor ? ctx.actor : (ctx || {});
    var oldValue = Helpers.toJson(input.oldValue === undefined ? null : input.oldValue);
    var newValue = Helpers.toJson(input.newValue === undefined ? null : input.newValue);
    var changed = input.changed_fields || Helpers.changedFields(
      Helpers.fromJson(oldValue), Helpers.fromJson(newValue)
    );
    var previous = tip();
    var row = {
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
      result: input.result || 'SUCCESS',
      previous_hash: previous
    };
    row.audit_hash = computeHash(row);
    var stored = SheetsAdapter.insertRow('audit_logs', row);
    setTip(row.audit_hash);
    return stored;
  }

  /**
   * Verify the whole chain.
   * Detects:
   *   HASH_MISMATCH            - a row was modified
   *   CHAIN_BROKEN             - previous_hash does not link to the prior row
   *   DELETED_ENTRIES_SUSPECTED - row is internally consistent but its predecessor vanished
   *   TIP_MISMATCH             - tail truncation (checked against tbl_settings anchor)
   */
  function verifyChain() {
    var rows = SheetsAdapter.readRows('audit_logs', { includeDeleted: true });
    var expectedPrevious = genesis();
    var issues = [];
    var firstFailure = null;

    function issue(type, row, detail) {
      var found = {
        auditId: row ? row.audit_id : null,
        type: type,
        detail: detail,
        at: row ? row.timestamp : null
      };
      if (!firstFailure) firstFailure = found;
      issues.push(found);
    }

    rows.forEach(function (row) {
      var selfHash = computeHash(row); // uses row's own previous_hash
      var selfConsistent = String(row.audit_hash || '') === selfHash;
      if (!selfConsistent) {
        issue('HASH_MISMATCH', row, 'Stored audit_hash does not match canonical payload');
      }
      if (String(row.previous_hash || '') !== String(expectedPrevious)) {
        issue(selfConsistent ? 'DELETED_ENTRIES_SUSPECTED' : 'CHAIN_BROKEN', row,
          'previous_hash does not link to prior audit record');
      }
      expectedPrevious = String(row.audit_hash || '');
    });

    var storedTip = tip();
    if (storedTip && storedTip !== expectedPrevious) {
      issue('TIP_MISMATCH', null, 'Chain tip differs from settings anchor (possible tail deletion)');
    }

    var result = {
      valid: issues.length === 0,
      recordsChecked: rows.length,
      firstFailure: firstFailure,
      issues: issues,
      checkedAt: Helpers.nowIso()
    };
    SheetsAdapter.setSetting(SETTING_VERIFIED, result, 'Latest audit chain verification', 'audit-service');
    if (!result.valid) {
      SecurityEventService.write({
        eventType: 'AUDIT_VERIFY_FAILED', userId: 'system', ip: '',
        details: { issues: issues.slice(0, 20), recordsChecked: rows.length }, severity: 'CRITICAL'
      });
      // The failure itself is recorded in the chain with result FAILURE.
      write({ requestId: 'audit-verify', actor: { userId: 'system', role: 'SYSTEM' } }, {
        operation: 'AUDIT_VERIFY', entityType: 'audit_logs', entityId: 'chain',
        newValue: { valid: false, issues: issues.length }, result: 'FAILURE'
      });
    }
    return result;
  }

  function chainStatus() {
    return {
      genesis: genesis(),
      tip: tip(),
      lastVerified: SheetsAdapter.getSetting(SETTING_VERIFIED),
      records: SheetsAdapter.readRows('audit_logs', { includeDeleted: true }).length
    };
  }

  function list(query) {
    query = query || {};
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

  return {
    asciiJson: asciiJson,
    canonicalPayload: canonicalPayload,
    computeHash: computeHash,
    hashHex: hashHex,
    genesis: genesis,
    tip: tip,
    setTip: setTip,
    write: write,
    verifyChain: verifyChain,
    chainStatus: chainStatus,
    list: list,
    SETTING_GENESIS: SETTING_GENESIS,
    SETTING_TIP: SETTING_TIP
  };
})();
