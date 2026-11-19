/**
 * Authoritative sheet catalog for the operational Phase 1 spreadsheet.
 *
 * IMPORTANT (current scope):
 *   - Customer master data, warehouses and departments are NOT stored here.
 *     They live in a separate, daily-updated spreadsheet and are inherited by
 *     value (customer_code/customer_name/warehouse/department) onto documents.
 *   - The following sheets are therefore deliberately ABSENT from this catalog:
 *       tbl_customers, tbl_customer_warehouse_history, tbl_warehouses,
 *       tbl_departments, tbl_branches, tbl_locations
 *   - Only operational system tables are defined below.
 *
 * Only sheets-adapter.gs reads these definitions to build sheets and map rows.
 */
function table(sheet, columns, options) {
  var t = {
    sheet: sheet,
    columns: columns,
    id: (options && options.id) || columns[0],
    unique: (options && options.unique) || [],
    versioned: !!(options && options.versioned),
    softDelete: !!(options && options.softDelete),
    appendOnly: !!(options && options.appendOnly),
    seed: (options && options.seed) || false
  };
  return t;
}

var STANDARD_SOFT = ['is_deleted', 'deleted_at', 'deleted_by'];
var STANDARD_TIME = ['created_at', 'updated_at'];

var TABLES = {
  /* ---- Identity & access ------------------------------------------------ */
  users: table('tbl_users', [
    'user_id', 'username', 'password_hash', 'full_name', 'email',
    'role_id', 'status', 'failed_attempts', 'last_login_at'
  ].concat(STANDARD_TIME, ['version'], STANDARD_SOFT,
    // PHASE 2 (M003) — appended at the END so existing row data never shifts.
    ['mfa_enabled', 'mfa_secret', 'locked_until']),
    { unique: ['username', 'email'], versioned: true, softDelete: true }),

  roles: table('tbl_roles', ['role_id', 'name', 'description'], { unique: ['name'] }),

  permissions: table('tbl_permissions', ['permission_id', 'code', 'module', 'action'], { unique: ['code'] }),

  role_permissions: table('tbl_role_permissions', ['role_id', 'permission_id'], { id: 'role_id' }),

  user_scopes: table('tbl_user_scopes', [
    'scope_id', 'user_id', 'scope_type', 'scope_id_value', 'created_at'
  ], { id: 'scope_id' }),

  /* ---- Books ------------------------------------------------------------ */
  book_batches: table('tbl_book_batches', [
    'batch_id', 'batch_number', 'supplier', 'delivery_date', 'invoice_reference',
    'serial_from', 'serial_to', 'expected_quantity', 'registered_quantity', 'variance',
    'received_by', 'inspected_by', 'status', 'notes'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT),
    { unique: ['batch_number'], versioned: true, softDelete: true }),

  books: table('tbl_books', [
    'book_id', 'book_number', 'batch_id', 'serial_from', 'serial_to',
    'total_receipts', 'issue_date', 'status', 'current_holder_id',
    'current_holder_type', 'current_location', 'last_movement_id', 'notes'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT),
    { unique: ['book_number'], versioned: true, softDelete: true }),

  receipts: table('tbl_receipts', [
    'receipt_id', 'receipt_number', 'book_id', 'sequence_in_book', 'collector_id',
    'customer_code', 'customer_name', 'warehouse', 'department',
    'collection_date', 'amount_minor', 'payment_method', 'status',
    'collection_id', 'branch_deposit_id', 'hq_deposit_id',
    'last_receipt_movement_id', 'cancelled_reason'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT),
    { unique: ['receipt_number'], versioned: true, softDelete: true }),

  book_assignments: table('tbl_book_assignments', [
    'assignment_id', 'book_id', 'assigned_to', 'assigned_by', 'assigned_at',
    'due_return_at', 'returned_at', 'received_by', 'condition_notes', 'status'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT),
    { versioned: true, softDelete: true }),

  collections: table('tbl_collections', [
    'collection_id', 'collector_id', 'book_id', 'collection_date',
    'receipt_count', 'total_minor', 'status', 'notes'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT),
    { versioned: true, softDelete: true }),

  /* ---- Deposits --------------------------------------------------------- */
  deposits_branch: table('tbl_deposits_branch', [
    'deposit_id', 'deposit_number', 'deposit_date', 'prepared_by', 'approved_by',
    'receipt_count', 'total_minor', 'status', 'notes'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT, ['treasury_id']),
    { unique: ['deposit_number'], versioned: true, softDelete: true }),

  deposits_hq: table('tbl_deposits_hq', [
    'deposit_id', 'deposit_number', 'hq_reference', 'deposit_date', 'prepared_by',
    'received_by', 'receipt_count', 'total_minor', 'status', 'notes'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT, ['treasury_id']),
    { unique: ['deposit_number'], versioned: true, softDelete: true }),

  deposit_lines: table('tbl_deposit_lines', [
    'line_id', 'deposit_id', 'deposit_level', 'receipt_id', 'amount_minor',
    'line_status', 'rejection_reason'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT),
    { versioned: true, softDelete: true }),

  /* ---- Instruments ------------------------------------------------------ */
  cheques: table('tbl_cheques', [
    'cheque_id', 'cheque_number', 'customer_code', 'customer_name',
    'warehouse', 'department', 'cheque_date', 'due_date', 'amount_minor', 'bank',
    'status', 'clearing_started_at', 'expected_clear_date', 'bank_reference',
    'cleared_at', 'return_reason', 'current_holder', 'current_location', 'last_movement_id'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT, ['treasury_id']),
    { unique: ['cheque_number'], versioned: true, softDelete: true }),

  guarantees: table('tbl_guarantees', [
    'guarantee_id', 'guarantee_number', 'customer_code', 'customer_name',
    'warehouse', 'department', 'contract_number', 'amount_minor', 'issue_date',
    'expiry_date', 'status', 'current_holder', 'current_location', 'last_movement_id'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT, ['treasury_id']),
    { unique: ['guarantee_number'], versioned: true, softDelete: true }),

  /* ---- Movement, custody & reconciliation ------------------------------- */
  movements: table('tbl_movements', [
    'movement_id', 'document_type', 'document_id', 'document_number',
    'from_location', 'to_location', 'from_holder_id', 'to_holder_id',
    'movement_date', 'performed_by', 'authorized_by', 'reason', 'notes',
    'related_deposit_id', 'request_id'
  ].concat(['version'], STANDARD_TIME, STANDARD_SOFT, ['treasury_id']),
    { versioned: true, softDelete: true }),

  custody_ledger: table('tbl_custody_ledger', [
    'ledger_id', 'holder_id', 'holder_type', 'document_type', 'document_id',
    'document_number', 'event_type', 'direction', 'count_delta', 'amount_minor_delta',
    'balance_count_after', 'balance_amount_after', 'occurred_at', 'recorded_by',
    'request_id', 'created_at'
  ], { appendOnly: true }),

  custody_balances: table('tbl_custody_balances', [
    'balance_id', 'holder_id', 'holder_type', 'document_type', 'document_count',
    'total_amount_minor', 'last_event_at', 'calculated_at', 'balance_status',
    'version', 'updated_at'
  ], { versioned: true }),

  reconciliation_exceptions: table('tbl_reconciliation_exceptions', [
    'exception_id', 'holder_id', 'document_type', 'expected_count', 'actual_count',
    'expected_amount_minor', 'actual_amount_minor', 'detected_at', 'resolved_at',
    'resolution_notes', 'status'
  ], {}),

  /* ---- Alerts, audit & infrastructure ----------------------------------- */
  alerts: table('tbl_alerts', [
    'alert_id', 'alert_type', 'entity_type', 'entity_id', 'bucket', 'due_date',
    'status', 'created_at', 'acknowledged_by', 'acknowledged_at'
  ], {}),

  audit_logs: table('tbl_audit_logs', [
    'audit_id', 'request_id', 'user_id', 'operation', 'entity_type', 'entity_id',
    'old_value', 'new_value', 'changed_fields', 'timestamp', 'ip_address', 'result'
    // PHASE 2 (M001) — hash chain. Appended at the END; existing rows keep their
    // physical columns and are backfilled by migration M001.
    , 'audit_hash', 'previous_hash'
  ], { appendOnly: true }),

  processed_requests: table('tbl_processed_requests', [
    'idempotency_key', 'request_id', 'action', 'entity', 'result_json',
    'created_at', 'expires_at'
  ], { id: 'idempotency_key', appendOnly: true }),

  integration_errors: table('tbl_integration_errors', [
    'error_id', 'request_id', 'action', 'envelope_json', 'error_code', 'message',
    'retry_count', 'created_at', 'resolved_at'
  ], {}),

  idx_tracking: table('idx_tracking', [
    'track_key', 'entity_type', 'entity_id', 'current_status', 'current_holder',
    'current_location', 'last_movement_at', 'updated_at'
  ], { id: 'track_key' }),

  idx_id_map: table('idx_id_map', ['public_id', 'sheet_name', 'row_number', 'updated_at'], { id: 'public_id' }),

  sequences: table('tbl_sequences', ['name', 'next_value', 'updated_at'], { id: 'name' }),

  settings: table('tbl_settings', ['key', 'value_json', 'description', 'updated_by', 'updated_at'], { id: 'key' }),

  /* ---- PHASE 2 tables (additive — created by M002..M009) ----------------- */
  sessions: table('tbl_sessions', [
    'session_id', 'user_id', 'refresh_token_hash', 'device_info', 'ip_address',
    'created_at', 'expires_at', 'revoked_at'
  ], { id: 'session_id', unique: ['session_id'] }),

  treasuries: table('tbl_treasuries', [
    'treasury_id', 'treasury_name', 'treasury_type', 'warehouse', 'status'
  ], { id: 'treasury_id', unique: ['treasury_id'] }),

  attachments: table('tbl_attachments', [
    'attachment_id', 'entity_type', 'entity_id', 'file_name', 'r2_key',
    'uploaded_by', 'uploaded_at',
    // PHASE 2 / Step 6 — appended at end only (migration-safe).
    'content_type', 'size_bytes', 'checksum', 'is_deleted', 'deleted_at', 'deleted_by'
  ], { id: 'attachment_id', unique: ['attachment_id'], softDelete: true }),

  notifications: table('tbl_notifications', [
    'notification_id', 'user_id', 'notification_type', 'entity_type', 'entity_id',
    'title', 'body', 'channel', 'status', 'created_at', 'read_at', 'delivery_status'
  ], { id: 'notification_id', unique: ['notification_id'] }),

  approvals: table('tbl_approvals', [
    'approval_id', 'entity_type', 'entity_id', 'action', 'requested_by', 'requested_at',
    'status', 'approver_id', 'decided_at', 'decision_notes', 'expires_at'
  ], { id: 'approval_id', unique: ['approval_id'] }),

  security_events: table('tbl_security_events', [
    'event_id', 'event_type', 'user_id', 'ip_address', 'request_id',
    'details_json', 'severity', 'created_at'
  ], { id: 'event_id', appendOnly: true }),

  backups: table('tbl_backups', [
    'backup_id', 'scope', 'workbook_ids', 'r2_key', 'size_bytes', 'checksum',
    'status', 'started_at', 'completed_at', 'retention_until'
  ], { id: 'backup_id', unique: ['backup_id'] })
};

/**
 * Dropdown lists applied by the bootstrap to status / categorical columns.
 * Keyed by entity, then column name. Values mirror apps-script/constants.gs.
 */
var COLUMN_VALIDATIONS = {
  users: { status: ['ACTIVE', 'DISABLED', 'LOCKED'], mfa_enabled: [true, false, 'TRUE', 'FALSE'] },
  roles: { name: ['ADMIN', 'BRANCH_MANAGER', 'COLLECTOR', 'TREASURY', 'AUDITOR'] },
  user_scopes: { scope_type: ['WAREHOUSE', 'BRANCH', 'USER'] },

  book_batches: { status: BATCH_STATUSES },
  books: { status: BOOK_STATUSES, current_holder_type: CUSTODY_HOLDER_TYPES },
  receipts: { status: RECEIPT_STATUSES, payment_method: PAYMENT_METHODS },
  book_assignments: { status: ['ACTIVE', 'ASSIGNED', 'RETURNED', 'OVERDUE', 'CANCELLED'] },
  collections: { status: ['DRAFT', 'SUBMITTED', 'RECONCILED', 'CANCELLED'] },

  deposits_branch: { status: ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'REJECTED'] },
  deposits_hq: { status: ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'REJECTED'] },
  deposit_lines: {
    deposit_level: ['BRANCH', 'HQ'],
    line_status: ['PENDING', 'ACCEPTED', 'REJECTED']
  },

  cheques: { status: CHEQUE_STATUSES },
  guarantees: { status: GUARANTEE_STATUSES },

  movements: { document_type: DOCUMENT_TYPES },
  custody_ledger: {
    document_type: DOCUMENT_TYPES,
    holder_type: CUSTODY_HOLDER_TYPES,
    direction: ['IN', 'OUT'],
    event_type: [
      'ISSUE', 'RECEIVE', 'TRANSFER', 'COLLECT', 'DEPOSIT_BRANCH', 'DEPOSIT_HQ',
      'CLEAR', 'RETURN', 'RELEASE', 'ADJUST'
    ]
  },
  custody_balances: {
    document_type: DOCUMENT_TYPES,
    holder_type: CUSTODY_HOLDER_TYPES,
    balance_status: ['BALANCED', 'SHORT', 'OVER', 'VARIANCE']
  },
  reconciliation_exceptions: {
    document_type: DOCUMENT_TYPES,
    status: ['OPEN', 'RESOLVED']
  },

  alerts: {
    alert_type: ALERT_TYPES,
    entity_type: DOCUMENT_TYPES,
    bucket: ALERT_BUCKETS,
    status: ['OPEN', 'ACKNOWLEDGED', 'CLOSED']
  },
  audit_logs: { result: ['SUCCESS', 'FAILURE'] },

  /* ---- PHASE 2 validations ---------------------------------------------- */
  treasuries: { treasury_type: ['BRANCH', 'HQ'], status: ['ACTIVE', 'INACTIVE'] },
  attachments: { entity_type: ['CHEQUE', 'GUARANTEE', 'DEPOSIT'] },
  notifications: {
    notification_type: ['GUARANTEE_EXPIRY', 'CHEQUE_OVERDUE', 'CUSTODY_VARIANCE', 'FAILED_RECONCILIATION'],
    channel: ['IN_APP', 'EMAIL', 'SMS'],
    status: ['UNREAD', 'READ', 'ARCHIVED'],
    delivery_status: ['N/A', 'PENDING', 'SENT', 'FAILED']
  },
  approvals: {
    entity_type: ['HQ_DEPOSIT', 'CHEQUE_STATUS_CHANGE', 'GUARANTEE_RELEASE'],
    status: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED']
  },
  security_events: { severity: ['INFO', 'WARNING', 'CRITICAL'] },
  backups: { status: ['RUNNING', 'COMPLETED', 'FAILED'] }
};

/** The five default operational roles. */
var SEED_ROLES = [
  { role_id: 'ROLE_ADMIN', name: 'ADMIN', description: 'Full access' },
  { role_id: 'ROLE_BRANCH_MANAGER', name: 'BRANCH_MANAGER', description: 'Branch management and reports' },
  { role_id: 'ROLE_COLLECTOR', name: 'COLLECTOR', description: 'Collection operations' },
  { role_id: 'ROLE_TREASURY', name: 'TREASURY', description: 'Deposits and transfers' },
  { role_id: 'ROLE_AUDITOR', name: 'AUDITOR', description: 'Read only and audit reports' }
];

/** Sheets that must be locked against manual editing after every bootstrap run. */
var PROTECTED_SHEETS = [
  'tbl_audit_logs', 'idx_tracking', 'idx_id_map', 'tbl_sequences',
  // PHASE 2 — append-only / security-sensitive sheets
  'tbl_security_events', 'tbl_sessions'
];
