/** Central Apps Script action router. Business services call SheetsAdapter, never SpreadsheetApp. */

var Router = (function () {

  var READ_ACTIONS = [
    'ping', 'list', 'get', 'aggregate', 'auth.me', 'tracking.track', 'tracking.trackTyped',
    'customer.get', 'customer.search', 'customer.warehouse', 'customer.department',
    // PHASE 2 read-only actions
    'audit.chainStatus', 'security.events', 'security.me', 'migration.status',
    'mfa.policy', 'mfa.secret.get',
    'treasury.list', 'notification.list', 'notification.summary',
    'attachment.list', 'attachment.get', 'approval.list', 'approval.get',
    'session.list', 'session.lookup', 'report.aging', 'report.collectorPerformance',
    'report.treasuryReconciliation', 'report.auditExceptions', 'report.kpis',
    'backup.list', 'registry.status'
  ];

  var FIELD_MAP = {
    id: null, bookId: 'book_id', batchId: 'batch_id', receiptId: 'receipt_id',
    depositId: 'deposit_id', collectorId: 'collector_id', holderId: 'holder_id',
    customerId: 'customer_code', account: 'customer_code',
    warehouseId: 'warehouse', warehouse: 'warehouse',
    departmentId: 'department', department: 'department',
    branchId: 'branch_id', documentType: 'document_type', documentId: 'document_id',
    documentNumber: 'document_number', status: 'status', alertType: 'alert_type',
    bucket: 'bucket', entityType: 'entity_type', entityId: 'entity_id',
    number: 'receipt_number', lineId: 'line_id', assignmentId: 'assignment_id'
  };

  var SEARCH_FIELDS = [
    'customer_name', 'customer_code', 'warehouse', 'department',
    'book_number', 'batch_number', 'receipt_number',
    'cheque_number', 'guarantee_number', 'deposit_number', 'username', 'document_number', 'name'
  ];

  function contextFrom(envelope) {
    var actor = envelope.actor || {};
    return {
      requestId: envelope.requestId || '',
      idempotencyKey: envelope.idempotencyKey || '',
      ip: actor.ip || '',
      actor: actor,
      inTransaction: false
    };
  }

  function cachedIdempotency(ctx) {
    if (!ctx.idempotencyKey) return null;
    var row = SheetsAdapter.findRow('processed_requests', 'idempotency_key', ctx.idempotencyKey);
    if (!row) return null;
    if (row.expires_at && row.expires_at < Helpers.nowIso()) return null;
    return Helpers.fromJson(row.result_json);
  }

  function storeIdempotency(ctx, result) {
    if (!ctx.idempotencyKey) return;
    SheetsAdapter.insertRow('processed_requests', {
      idempotency_key: ctx.idempotencyKey,
      request_id: ctx.requestId,
      action: 'mutation',
      entity: '',
      result_json: Helpers.toJson(result),
      created_at: Helpers.nowIso(),
      expires_at: new Date(Date.now() + 86400000).toISOString()
    });
  }

  function queryRows(entity, query, options) {
    var q = query || {};
    var opts = options || {};
    var rows = SheetsAdapter.readRows(entity, { includeDeleted: !!q.includeDeleted });

    Object.keys(q).forEach(function (key) {
      if (['limit', 'offset', 'orderBy', 'descending', 'includeDeleted', 'filters',
        'warehouseIds', 'branchIds', 'search'].indexOf(key) >= 0) return;
      var field = key === 'id' ? TABLES[entity].id : (FIELD_MAP[key] || key);
      if (q[key] === undefined || q[key] === null || q[key] === '') return;
      if (Array.isArray(q[key])) {
        rows = rows.filter(function (row) { return q[key].map(String).indexOf(String(row[field])) >= 0; });
      } else {
        rows = rows.filter(function (row) { return String(row[field]) === String(q[key]); });
      }
    });

    if (q.warehouseIds && q.warehouseIds.length) {
      rows = rows.filter(function (row) {
        return q.warehouseIds.indexOf(row.warehouse) >= 0;
      });
    }
    if (q.branchIds && q.branchIds.length) {
      rows = rows.filter(function (row) { return q.branchIds.indexOf(row.branch_id) >= 0; });
    }
    if (q.filters) {
      Object.keys(q.filters).forEach(function (field) {
        rows = rows.filter(function (row) { return String(row[field]) === String(q.filters[field]); });
      });
    }
    if (q.search) {
      var term = String(q.search).toLowerCase();
      rows = rows.filter(function (row) {
        return SEARCH_FIELDS.some(function (field) {
          return row[field] && String(row[field]).toLowerCase().indexOf(term) >= 0;
        });
      });
    }

    var orderBy = opts.orderBy || q.orderBy;
    if (orderBy) {
      var dir = (opts.descending !== undefined ? opts.descending : q.descending) === false ? 1 : -1;
      rows.sort(function (a, b) {
        if (a[orderBy] === b[orderBy]) return 0;
        return (a[orderBy] > b[orderBy] ? 1 : -1) * dir;
      });
    }
    var offset = Number(opts.offset || q.offset || 0);
    var limit = Number(opts.limit || q.limit || 0);
    if (offset) rows = rows.slice(offset);
    if (limit) rows = rows.slice(0, limit);
    return rows;
  }

  function doInsert(ctx, entity, data) {
    if (entity === 'books') return BookService.create(ctx, data);
    if (entity === 'cheques') return ChequeService.create(ctx, data);
    if (entity === 'guarantees') return GuaranteeService.create(ctx, data);
    var prepared = entity === 'receipts' ? ReceiptService.beforeInsert(data) : data;
    var row = SheetsAdapter.insertRow(entity, prepared);
    if (TrackingService && ['books', 'receipts', 'cheques', 'guarantees'].indexOf(entity) >= 0) {
      TrackingService.upsertFromEntity(entity, row);
    }
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: entity, entityId: row[TABLES[entity].id],
      oldValue: null, newValue: row, result: 'SUCCESS'
    });
    return row;
  }

  function doUpdate(ctx, entity, id, patch, version) {
    if (entity === 'cheques') return ChequeService.update(ctx, id, patch, version);
    if (entity === 'guarantees') return GuaranteeService.update(ctx, id, patch, version);
    var updated = SheetsAdapter.updateRow(entity, id, patch, version);
    if (['books', 'receipts'].indexOf(entity) >= 0) TrackingService.upsertFromEntity(entity, updated);
    AuditService.write(ctx, {
      operation: 'UPDATE', entityType: entity, entityId: id,
      oldValue: null, newValue: patch, result: 'SUCCESS'
    });
    return updated;
  }

  function doTransition(ctx, entity, id, toStatus, payload) {
    if (entity === 'cheques') return ChequeService.transition(ctx, id, toStatus, payload);
    if (entity === 'guarantees') return GuaranteeService.transition(ctx, id, toStatus, payload);
    return StateMachine.transition(ctx, entity, id, toStatus, payload);
  }

  function aggregate(ctx, name, params) {
    switch (name) {
      case 'bookBatchReport': return { items: BatchService.report(params) };
      case 'chequeOverdue': return { items: ChequeService.overdue(params) };
      case 'chequeClearing': return { items: ChequeService.clearing(params) };
      case 'guaranteeExpiring': return { items: GuaranteeService.expiring(params) };
      case 'alertSummary': return AlertService.summary();
      case 'movementHistory': return { items: MovementService.history(params.documentType, params.documentNumber) };
      case 'dashboardSummary': return DashboardService.summary(params);
      case 'custodyDashboard': return DashboardService.custody(params);
      case 'outstandingCollections': return ReportService.outstandingCollections(params);
      case 'receiptsInTransit': return ReportService.receiptsInTransit(params);
      case 'warehouseReport': return ReportService.byWarehouse(params);
      case 'departmentReport': return ReportService.byDepartment(params);
      case 'warehouseStructure': return DashboardService.structure();
      // PHASE 2 / Step 8 — advanced reporting (also reachable as service actions).
      case 'report.aging': return ReportService.aging(params);
      case 'report.collectorPerformance': return ReportService.collectorPerformance(params);
      case 'report.treasuryReconciliation': return ReportService.treasuryReconciliation(params);
      case 'report.auditExceptions': return ReportService.auditExceptions(params);
      case 'report.kpis': return ReportService.kpis(params);
      default: Errors.fail('UNKNOWN_AGGREGATE', 'Unknown aggregate: ' + name);
    }
  }

  function serviceAction(ctx, action, entity, payload) {
    switch (action) {
      case 'auth.login': return AuthService.login(payload.username, payload.password, ctx.ip);
      case 'auth.me': return AuthService.currentUser(payload.userId);
      case 'auth.logout':
        AuditService.write(ctx, {
          operation: 'LOGOUT', entityType: 'users', entityId: payload.userId || 'unknown',
          oldValue: null, newValue: null, result: 'SUCCESS'
        });
        return { loggedOut: true };
      // Customer master is external and read-only. All four actions resolve
      // data by Account through CustomerMasterService (cached for 5 minutes).
      case 'customer.get': return CustomerMasterService.getCustomer(
        payload.account || payload.id || payload.q);
      case 'customer.search': return {
        items: CustomerMasterService.searchCustomers(payload.query || payload.q || payload.search || '')
      };
      case 'customer.warehouse': return {
        account: String(payload.account || payload.id || '').trim(),
        warehouse: CustomerMasterService.getCustomerWarehouse(payload.account || payload.id)
      };
      case 'customer.department': return {
        account: String(payload.account || payload.id || '').trim(),
        department: CustomerMasterService.getCustomerDepartment(payload.account || payload.id)
      };
      case 'book.assign': return BookService.assign(ctx, payload.id, payload);
      case 'book.return': return BookService.returnBook(ctx, payload.id, payload);
      case 'receipt.getByNumber': return ReceiptService.getByNumber(payload.number);
      case 'receipt.collect': return ReceiptService.collect(ctx, payload.id, payload);
      case 'receipt.cancel': return ReceiptService.cancel(ctx, payload.id, payload.reason);
      case 'receipt.markLost': return ReceiptService.markLost(ctx, payload.id, payload.reason);
      case 'collection.create': return CollectionService.create(ctx, payload);
      case 'collection.reconcile': return CollectionService.reconcile(ctx, payload.id);
      case 'deposit.create': return DepositService.create(ctx, entity, payload);
      case 'deposit.confirm': return DepositService.confirm(ctx, payload.id, entity);
      case 'cheque.create': return ChequeService.create(ctx, payload);
      case 'cheque.update': return ChequeService.update(ctx, payload.id, payload.patch, payload.version);
      case 'cheque.transition': return ChequeService.transition(ctx, payload.id, payload.toStatus, payload);
      case 'guarantee.create': return GuaranteeService.create(ctx, payload);
      case 'guarantee.update': return GuaranteeService.update(ctx, payload.id, payload.patch, payload.version);
      case 'guarantee.transition': return GuaranteeService.transition(ctx, payload.id, payload.toStatus, payload);
      case 'custody.reconcile': return CustodyService.reconcile(ctx);
      case 'alert.acknowledge': return AlertService.acknowledge(ctx, payload.id);
      case 'alert.scan': return AlertService.dailyScan(ctx);
      case 'movement.create': return MovementService.create(ctx, payload);
      case 'tracking.track': return TrackingService.track(payload.number);
      case 'tracking.trackTyped': return TrackingService.trackTyped(payload.type, payload.number);

      /* ---- PHASE 2 / Step 7 — approvals ---------------------------------- */
      case 'approval.list': return { items: ApprovalService.list(payload) };
      case 'approval.get': return ApprovalService.get(payload.approvalId || payload.id);
      case 'approval.approve': return ApprovalService.decide(
        ctx, payload.approvalId || payload.id, 'APPROVED', payload.notes);
      case 'approval.reject': return ApprovalService.decide(
        ctx, payload.approvalId || payload.id, 'REJECTED', payload.reason || payload.notes);

      /* ---- PHASE 2 / Step 6 — attachments -------------------------------- */
      case 'attachment.list': return { items: AttachmentService.list(payload) };
      case 'attachment.get': return AttachmentService.get(payload.attachmentId || payload.id);
      case 'attachment.create': return AttachmentService.create(ctx, payload);
      case 'attachment.delete': return AttachmentService.softDelete(ctx, payload.attachmentId || payload.id);

      /* ---- PHASE 2 / Step 5 — notifications ------------------------------ */
      case 'notification.list': return {
        items: NotificationService.list(ctx.actor.userId, payload)
      };
      case 'notification.summary': return NotificationService.summary(ctx.actor.userId);
      case 'notification.markRead': return NotificationService.markRead(ctx.actor.userId, payload.notificationId);
      case 'notification.markAllRead': return NotificationService.markAllRead(ctx.actor.userId);
      case 'notification.raise': return NotificationService.raise(ctx, payload);

      /* ---- PHASE 2 / Step 4 — treasuries --------------------------------- */
      case 'treasury.list': return { items: TreasuryService.list(payload) };
      case 'treasury.get': return TreasuryService.get(payload.treasuryId || payload.id);
      case 'treasury.create': return TreasuryService.create(ctx, payload);
      case 'treasury.update': return TreasuryService.update(ctx, payload.treasuryId, payload.patch || {});

      /* ---- PHASE 2 / Step 3 — MFA ---------------------------------------- */
      case 'mfa.policy': return AuthService.mfaPolicy();
      case 'mfa.secret.get': return AuthService.getMfaSecret(payload.userId);
      case 'mfa.secret.set': return AuthService.setMfaSecret(payload.userId, payload.secret);
      case 'mfa.enable': return AuthService.setMfaEnabled(payload.userId, true);
      case 'mfa.disable': return AuthService.setMfaEnabled(payload.userId, false);
      case 'mfa.deliverOtp': return AuthService.deliverOtp({
        userId: payload.userId, email: payload.email, code: payload.code, ip: ctx.ip
      });
      case 'mfa.recovery.set': return AuthService.setRecoveryCodes(payload.userId, payload.hashes);
      case 'mfa.recovery.verify': return AuthService.verifyRecoveryCode(payload.userId, payload.hash);
      case 'security.event':
        return { written: SecurityEventService.write({
          eventType: payload.eventType, userId: payload.userId, ip: payload.ip || ctx.ip,
          requestId: payload.requestId || ctx.requestId, details: payload.details,
          severity: payload.severity
        }) != null };

      /* ---- PHASE 2 / Step 2 — sessions ----------------------------------- */
      case 'session.lookup': return SessionService.lookup(payload.refreshTokenHash);
      case 'session.create': return {
        session: SessionService.create(ctx, {
          sessionId: payload.sessionId, userId: payload.userId,
          refreshTokenHash: payload.refreshTokenHash, deviceInfo: payload.deviceInfo,
          ip: payload.ip || ctx.ip, expiresAt: payload.expiresAt
        })
      };
      case 'session.refresh': {
        var rotated = SessionService.rotate(ctx, {
          refreshTokenHash: payload.refreshTokenHash, userId: payload.userId,
          newSessionId: payload.newSessionId, newRefreshTokenHash: payload.newRefreshTokenHash,
          deviceInfo: payload.deviceInfo, ip: payload.ip || ctx.ip, expiresAt: payload.expiresAt
        });
        if (rotated.error) Errors.fail(rotated.error, 'Refresh token rejected: ' + rotated.error);
        var identity = AuthService.currentUser(payload.userId);
        return {
          session: rotated.session, previousSessionId: rotated.previousSessionId,
          user: identity.user, permissions: identity.permissions
        };
      }
      case 'session.revoke': return {
        revoked: SessionService.revoke(payload.sessionId, { reason: payload.reason || 'LOGOUT', ip: ctx.ip }),
        count: payload.sessionId ? 1 : 0
      };
      case 'session.revokeAll': return SessionService.revokeAll(payload.userId, payload.reason || 'LOGOUT_ALL');
      case 'session.list': return { items: SessionService.list(ctx.actor.userId) };

      /* ---- PHASE 2 / Step 8 — advanced reporting ------------------------ */
      case 'report.aging': return ReportService.aging(payload);
      case 'report.collectorPerformance': return ReportService.collectorPerformance(payload);
      case 'report.treasuryReconciliation': return ReportService.treasuryReconciliation(payload);
      case 'report.auditExceptions': return ReportService.auditExceptions(payload);
      case 'report.kpis': return ReportService.kpis(payload);

      /* ---- PHASE 2 service actions -------------------------------------- */
      case 'audit.verify': return AuditService.verifyChain();
      case 'audit.chainStatus': return AuditService.chainStatus();
      case 'security.events': return { items: SecurityEventService.list(payload) };

      /* ---- PHASE 2 / Step 11 — security self-service & lockout ------------ */
      case 'security.me': {
        var meId = payload.userId || (ctx.actor && ctx.actor.userId);
        var meUser = SheetsAdapter.findRow('users', 'user_id', meId);
        var meLock = AuthService.lockStatus(meUser);
        return {
          userId: meId,
          role: meUser ? meUser.role_id : '',
          mfaEnabled: !!meUser && (meUser.mfa_enabled === true || meUser.mfa_enabled === 'TRUE'),
          lock: meLock,
          sessions: SessionService.list(meId),
          recentEvents: SecurityEventService.list({ userId: meId, limit: 20 })
        };
      }
      case 'security.unlock':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Account unlock requires ADMIN actor');
        return AuthService.unlockUser(payload.userId, ctx);

      case 'migration.run':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Migrations require ADMIN actor');
        return MigrationRunner.run(ctx, payload);
      case 'migration.verify':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Migrations require ADMIN actor');
        return MigrationRunner.verify(ctx, payload);
      case 'migration.status': return MigrationRunner.status();

      /* ---- PHASE 2 / Step 12 — backup lifecycle -------------------------- */
      case 'backup.start':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Backup start requires ADMIN actor');
        return BackupService.start(ctx);
      case 'backup.complete':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Backup completion requires ADMIN actor');
        return BackupService.complete(ctx, payload);
      case 'backup.fail':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Backup failure logging requires ADMIN actor');
        return BackupService.fail(ctx, payload);
      case 'backup.list': return BackupService.list(payload);

      /* ---- PHASE 2 / Step 9 — workbook split administration -------------- */
      case 'registry.status':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Registry status requires ADMIN actor');
        return WorkbookRegistryService.status();
      case 'registry.setSplit':
        if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Workbook split requires ADMIN actor');
        return WorkbookRegistryService.setSplit(ctx, payload.enabled === true);
      default: Errors.fail('UNKNOWN_ACTION', 'Unknown action: ' + action);
    }
  }

  function execute(ctx, envelope) {
    var action = envelope.action;
    var entity = envelope.entity;
    var payload = envelope.payload || {};
    var options = payload.options || {};

    switch (action) {
      case 'ping': return { data: { ok: true, time: Helpers.nowIso() }, meta: {} };
      case 'bootstrap': return { data: Bootstrap.run(ctx.actor), meta: {} };
      case 'list': return { data: { items: queryRows(entity, payload.query || {}, options), total: null }, meta: {} };
      case 'get':
        var row = SheetsAdapter.findRow(entity, TABLES[entity].id, payload.id);
        if (!row) Errors.notFound(entity, payload.id);
        return { data: row, meta: { version: row.version } };
      case 'insert': return { data: doInsert(ctx, entity, payload.data || {}), meta: {} };
      case 'update': return { data: doUpdate(ctx, entity, payload.id, payload.patch || {}, payload.expectedVersion), meta: {} };
      case 'transition': return { data: doTransition(ctx, entity, payload.id, payload.toStatus, payload), meta: {} };
      case 'appendLedger': return { data: CustodyService.record(ctx, payload.entry), meta: {} };
      case 'aggregate': return { data: aggregate(ctx, entity, payload.params || {}), meta: {} };
      case 'transaction':
        var results = [];
        (payload.operations || []).forEach(function (op) {
          results.push(execute(ctx, {
            action: op.action, entity: op.entity, payload: op.payload || {}
          }));
        });
        return { data: { results: results, rowsAffected: results.length }, meta: {} };
      default: return { data: serviceAction(ctx, action, entity, payload), meta: {} };
    }
  }

  function handle(envelope) {
    var ctx = contextFrom(envelope);
    var action = envelope.action;
    var readOnly = READ_ACTIONS.indexOf(action) >= 0;

    if (action === 'bootstrap') {
      if (!ctx.actor || ctx.actor.role !== 'ADMIN') Errors.forbidden('Bootstrap requires ADMIN actor');
    }

    if (!readOnly) {
      var cached = cachedIdempotency(ctx);
      if (cached) return { data: cached, meta: { idempotentReplay: true } };
    }

    var result;
    if (readOnly) {
      result = execute(ctx, envelope);
    } else {
      result = SheetsAdapter.withTransaction(function () {
        ctx.inTransaction = true;
        return execute(ctx, envelope);
      });
      storeIdempotency(ctx, result.data);
    }
    return result;
  }

  return { handle: handle, queryRows: queryRows, execute: execute };
})();
