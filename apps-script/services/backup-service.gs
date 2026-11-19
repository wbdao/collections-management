/**
 * PHASE 2 / Step 12 — backup lifecycle metadata (DORMANT / NOT DEPLOYED).
 *
 * R2 is skipped in this rollout. This service and its signed GAS actions are
 * retained as reference code; no edge route, bucket or daily trigger is active.
 * Google Sheets is the only production storage backend.
 */
var BackupService = (function () {
  var SCOPE = 'FULL_WORKBOOKS';
  var RETENTION_DAYS = 90;
  var CHECKPOINT_RETENTION_DAYS = 180;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var VALID_STATUS = ['RUNNING', 'COMPLETED', 'FAILED'];

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += ('0' + ((bytes[i] < 0 ? bytes[i] + 256 : bytes[i]).toString(16))).slice(-2);
    }
    return out;
  }

  /** ASCII-escaped JSON so GAS SHA-256 bytes match the Workers TextEncoder. */
  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007F-\uFFFF]/g, function (ch) {
      return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function sha256Hex(value) {
    return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value)));
  }

  function publicRow(row) {
    if (!row) return null;
    return {
      backup_id: row.backup_id,
      scope: row.scope,
      workbook_ids: Helpers.fromJson(row.workbook_ids || '[]'),
      r2_key: row.r2_key || '',
      size_bytes: Number(row.size_bytes || 0),
      checksum: row.checksum || '',
      status: row.status,
      started_at: row.started_at,
      completed_at: row.completed_at || '',
      retention_until: row.retention_until || '',
      expired: !!(row.retention_until && Date.parse(row.retention_until) <= Date.now()),
      retention_days: RETENTION_DAYS
    };
  }

  function distinctWorkbooks() {
    var ids = [];
    function add(id) {
      var value = String(id || CONFIG.coreSpreadsheetId);
      if (ids.indexOf(value) < 0) ids.push(value);
    }
    add(CONFIG.coreSpreadsheetId);
    add(CONFIG.docsSpreadsheetId);
    add(CONFIG.auditSpreadsheetId);
    var registry = SheetsAdapter.getWorkbookRegistry && SheetsAdapter.getWorkbookRegistry();
    if (registry) {
      add(registry.CORE); add(registry.DOCS); add(registry.AUDIT);
    }
    return ids;
  }

  function allSettings() {
    return SheetsAdapter.readRows('settings', {}).map(function (row) {
      return { key: row.key, value: row.value_json, updated_by: row.updated_by, updated_at: row.updated_at };
    });
  }

  function securityEvent(eventType, ctx, details, severity) {
    if (typeof SecurityEventService === 'undefined' || !SecurityEventService.write) return;
    try {
      SecurityEventService.write({
        eventType: eventType,
        userId: (ctx && ctx.actor && ctx.actor.userId) || 'system',
        ip: (ctx && ctx.ip) || 'scheduler',
        requestId: (ctx && ctx.requestId) || '',
        severity: severity || 'WARNING',
        details: details || null
      });
    } catch (err) { /* logging must never break the backup response */ }
  }

  /**
   * `backup.start` — serialise all workbooks, compute the checksum and open a
   * RUNNING ledger row. Returns the payload for the edge to place in R2.
   */
  function start(ctx) {
    var now = new Date();
    var startedAt = now.toISOString();
    var backupId = Helpers.id('BAK');
    var workbookIds = distinctWorkbooks();
    var audit = (typeof AuditService !== 'undefined' && AuditService.chainStatus)
      ? AuditService.chainStatus() : { tip: '', records: 0 };

    var snapshot = {
      schema: 'cms-backup/v1',
      version: 1,
      backupId: backupId,
      generatedAt: startedAt,
      auditTip: audit.tip || '',
      auditRecords: audit.records || 0,
      settings: allSettings(),
      workbooks: []
    };

    workbookIds.forEach(function (workbookId) {
      var sheets = [];
      Object.keys(TABLES).forEach(function (entity) {
        // Placement-aware: each entity is serialised exactly once, in the
        // workbook the registry currently routes it to (CORE by default).
        var owner = SheetsAdapter.workbookIdFor ? SheetsAdapter.workbookIdFor(entity) : CONFIG.coreSpreadsheetId;
        if (String(owner) !== String(workbookId)) return;
        var rows = SheetsAdapter.readRows(entity, { includeDeleted: true });
        sheets.push({
          entity: entity,
          sheet: TABLES[entity].sheet,
          columns: TABLES[entity].columns,
          rowCount: rows.length,
          rows: rows
        });
      });
      snapshot.workbooks.push({ workbookId: workbookId, sheets: sheets });
    });

    var payload = asciiJson(snapshot);
    var checksum = sha256Hex(payload);
    var retentionUntil = new Date(now.getTime() + RETENTION_DAYS * DAY_MS).toISOString();

    var row = SheetsAdapter.insertRow('backups', {
      backup_id: backupId,
      scope: SCOPE,
      workbook_ids: Helpers.toJson(workbookIds),
      r2_key: '',
      size_bytes: 0,
      checksum: checksum,
      status: 'RUNNING',
      started_at: startedAt,
      completed_at: '',
      retention_until: retentionUntil
    });
    AuditService.write(ctx, {
      operation: 'BACKUP_START', entityType: 'backups', entityId: backupId,
      oldValue: null, newValue: { checksum: checksum, workbook_ids: workbookIds },
      result: 'SUCCESS'
    });
    return {
      backup: publicRow(row),
      payload: payload,
      checksum: checksum,
      auditTip: snapshot.auditTip,
      generatedAt: startedAt,
      checkpointRetentionDays: CHECKPOINT_RETENTION_DAYS
    };
  }

  /** `backup.complete` — flip the ledger row to COMPLETED after a verified R2 write. */
  function complete(ctx, input) {
    Errors.assert(!Helpers.isEmpty(input.backupId), 'VALIDATION_ERROR', 'backupId is required');
    var row = SheetsAdapter.findRow('backups', 'backup_id', input.backupId);
    if (!row) Errors.notFound('backups', input.backupId);
    if (row.status === 'COMPLETED') return publicRow(row); // idempotent retry
    if (String(input.checksum || '') !== String(row.checksum || '')) {
      Errors.fail('CHECKSUM_MISMATCH', 'Backup checksum does not match the collected payload');
    }
    if (VALID_STATUS.indexOf(input.status || 'COMPLETED') < 0) {
      Errors.fail('VALIDATION_ERROR', 'Invalid backup status');
    }
    var updated = SheetsAdapter.updateRow('backups', input.backupId, {
      r2_key: input.r2Key || '',
      size_bytes: Number(input.sizeBytes || 0),
      checksum: row.checksum,
      status: input.status || 'COMPLETED',
      completed_at: Helpers.nowIso(),
      retention_until: input.retentionUntil || row.retention_until
    }, row.version);
    AuditService.write(ctx, {
      operation: 'BACKUP_COMPLETE', entityType: 'backups', entityId: input.backupId,
      oldValue: { status: row.status },
      newValue: { status: updated.status, r2_key: updated.r2_key, size_bytes: updated.size_bytes },
      result: 'SUCCESS'
    });
    return publicRow(updated);
  }

  /** `backup.fail` — record a failed attempt and a BACKUP_FAILED security event. */
  function fail(ctx, input) {
    input = input || {};
    var backupId = input.backupId || '';
    var row = backupId ? SheetsAdapter.findRow('backups', 'backup_id', backupId) : null;
    if (!row) {
      // A dispatch can fail before collection produced a row; still ledger it.
      var startedAt = Helpers.nowIso();
      row = SheetsAdapter.insertRow('backups', {
        backup_id: backupId || Helpers.id('BAK'),
        scope: SCOPE,
        workbook_ids: Helpers.toJson([]),
        r2_key: '', size_bytes: 0, checksum: '', status: 'FAILED',
        started_at: startedAt, completed_at: startedAt,
        retention_until: new Date(Date.now() + RETENTION_DAYS * DAY_MS).toISOString()
      });
    } else {
      row = SheetsAdapter.updateRow('backups', row.backup_id, {
        status: 'FAILED', completed_at: Helpers.nowIso()
      }, row.version);
    }
    securityEvent('BACKUP_FAILED', ctx, {
      backupId: row.backup_id,
      errorCode: input.errorCode || 'BACKUP_FAILED',
      message: String(input.message || 'Backup failed').slice(0, 500),
      stage: input.stage || 'unknown'
    }, 'CRITICAL');
    AuditService.write(ctx, {
      operation: 'BACKUP_FAILED', entityType: 'backups', entityId: row.backup_id,
      oldValue: null,
      newValue: { errorCode: input.errorCode || 'BACKUP_FAILED', stage: input.stage || 'unknown' },
      result: 'FAILURE', errorCode: input.errorCode || 'BACKUP_FAILED'
    });
    return publicRow(row);
  }

  function list(query) {
    query = query || {};
    var rows = SheetsAdapter.readRows('backups', {
      orderBy: 'started_at', descending: true, limit: query.limit || 200
    });
    var items = rows.map(publicRow);
    if (query.status) {
      items = items.filter(function (row) { return row.status === query.status; });
    }
    var retention = {
      policyDays: RETENTION_DAYS,
      checkpointPolicyDays: CHECKPOINT_RETENTION_DAYS,
      total: items.length,
      completed: items.filter(function (r) { return r.status === 'COMPLETED'; }).length,
      failed: items.filter(function (r) { return r.status === 'FAILED'; }).length,
      running: items.filter(function (r) { return r.status === 'RUNNING'; }).length,
      expired: items.filter(function (r) { return r.expired; }).length
    };
    return { items: items, retention: retention };
  }

  return {
    start: start,
    complete: complete,
    fail: fail,
    list: list,
    RETENTION_DAYS: RETENTION_DAYS,
    CHECKPOINT_RETENTION_DAYS: CHECKPOINT_RETENTION_DAYS
  };
})();
