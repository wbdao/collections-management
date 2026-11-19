-- PHASE 2 / M012 — D1 schema (INACTIVE).
-- Reference schema for D1RepositoryAdapter only. Not applied; no D1 binding
-- is added in Phase 2. Google Sheets remains the primary source of truth.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  full_name TEXT, email TEXT UNIQUE, role_id TEXT, status TEXT, failed_attempts INTEGER DEFAULT 0,
  last_login_at TEXT, created_at TEXT, updated_at TEXT, version INTEGER DEFAULT 1,
  is_deleted INTEGER DEFAULT 0, deleted_at TEXT, deleted_by TEXT,
  mfa_enabled INTEGER DEFAULT 0, mfa_secret TEXT, locked_until TEXT
);
CREATE TABLE IF NOT EXISTS roles (role_id TEXT PRIMARY KEY, name TEXT UNIQUE, description TEXT);
CREATE TABLE IF NOT EXISTS permissions (permission_id TEXT PRIMARY KEY, code TEXT UNIQUE, module TEXT, action TEXT);
CREATE TABLE IF NOT EXISTS role_permissions (role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY (role_id, permission_id));
CREATE TABLE IF NOT EXISTS user_scopes (scope_id TEXT PRIMARY KEY, user_id TEXT, scope_type TEXT, scope_id_value TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, refresh_token_hash TEXT NOT NULL UNIQUE,
  device_info TEXT, ip_address TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS treasuries (
  treasury_id TEXT PRIMARY KEY, treasury_name TEXT, treasury_type TEXT, warehouse TEXT, status TEXT
);

CREATE TABLE IF NOT EXISTS book_batches (
  batch_id TEXT PRIMARY KEY, batch_number TEXT UNIQUE, supplier TEXT, delivery_date TEXT,
  invoice_reference TEXT, serial_from TEXT, serial_to TEXT, expected_quantity INTEGER,
  registered_quantity INTEGER, variance INTEGER, received_by TEXT, inspected_by TEXT,
  status TEXT, notes TEXT, version INTEGER, created_at TEXT, updated_at TEXT,
  is_deleted INTEGER, deleted_at TEXT, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS books (
  book_id TEXT PRIMARY KEY, book_number TEXT UNIQUE, batch_id TEXT, serial_from TEXT, serial_to TEXT,
  total_receipts INTEGER, issue_date TEXT, status TEXT, current_holder_id TEXT, current_holder_type TEXT,
  current_location TEXT, last_movement_id TEXT, notes TEXT, version INTEGER, created_at TEXT,
  updated_at TEXT, is_deleted INTEGER, deleted_at TEXT, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY, receipt_number TEXT UNIQUE, book_id TEXT, sequence_in_book INTEGER,
  collector_id TEXT, customer_code TEXT, customer_name TEXT, warehouse TEXT, department TEXT,
  collection_date TEXT, amount_minor INTEGER, payment_method TEXT, status TEXT, collection_id TEXT,
  branch_deposit_id TEXT, hq_deposit_id TEXT, last_receipt_movement_id TEXT, cancelled_reason TEXT,
  version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER, deleted_at TEXT, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS book_assignments (
  assignment_id TEXT PRIMARY KEY, book_id TEXT, assigned_to TEXT, assigned_by TEXT, assigned_at TEXT,
  due_return_at TEXT, returned_at TEXT, received_by TEXT, condition_notes TEXT, status TEXT,
  version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER, deleted_at TEXT, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS collections (
  collection_id TEXT PRIMARY KEY, collector_id TEXT, book_id TEXT, collection_date TEXT,
  receipt_count INTEGER, total_minor INTEGER, status TEXT, notes TEXT, version INTEGER,
  created_at TEXT, updated_at TEXT, is_deleted INTEGER, deleted_at TEXT, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS deposits_branch (
  deposit_id TEXT PRIMARY KEY, deposit_number TEXT UNIQUE, deposit_date TEXT, prepared_by TEXT,
  approved_by TEXT, receipt_count INTEGER, total_minor INTEGER, status TEXT, notes TEXT,
  version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER, deleted_at TEXT,
  deleted_by TEXT, treasury_id TEXT
);
CREATE TABLE IF NOT EXISTS deposits_hq (
  deposit_id TEXT PRIMARY KEY, deposit_number TEXT UNIQUE, hq_reference TEXT, deposit_date TEXT,
  prepared_by TEXT, received_by TEXT, receipt_count INTEGER, total_minor INTEGER, status TEXT,
  notes TEXT, version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER,
  deleted_at TEXT, deleted_by TEXT, treasury_id TEXT
);
CREATE TABLE IF NOT EXISTS deposit_lines (
  line_id TEXT PRIMARY KEY, deposit_id TEXT, deposit_level TEXT, receipt_id TEXT, amount_minor INTEGER,
  line_status TEXT, rejection_reason TEXT, version INTEGER, created_at TEXT, updated_at TEXT,
  is_deleted INTEGER, deleted_at TEXT, deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS cheques (
  cheque_id TEXT PRIMARY KEY, cheque_number TEXT UNIQUE, customer_code TEXT, customer_name TEXT,
  warehouse TEXT, department TEXT, cheque_date TEXT, due_date TEXT, amount_minor INTEGER, bank TEXT,
  status TEXT, clearing_started_at TEXT, expected_clear_date TEXT, bank_reference TEXT, cleared_at TEXT,
  return_reason TEXT, current_holder TEXT, current_location TEXT, last_movement_id TEXT,
  version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER, deleted_at TEXT,
  deleted_by TEXT, treasury_id TEXT
);
CREATE TABLE IF NOT EXISTS guarantees (
  guarantee_id TEXT PRIMARY KEY, guarantee_number TEXT UNIQUE, customer_code TEXT, customer_name TEXT,
  warehouse TEXT, department TEXT, contract_number TEXT, amount_minor INTEGER, issue_date TEXT,
  expiry_date TEXT, status TEXT, current_holder TEXT, current_location TEXT, last_movement_id TEXT,
  version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER, deleted_at TEXT,
  deleted_by TEXT, treasury_id TEXT
);
CREATE TABLE IF NOT EXISTS movements (
  movement_id TEXT PRIMARY KEY, document_type TEXT, document_id TEXT, document_number TEXT,
  from_location TEXT, to_location TEXT, from_holder_id TEXT, to_holder_id TEXT, movement_date TEXT,
  performed_by TEXT, authorized_by TEXT, reason TEXT, notes TEXT, related_deposit_id TEXT,
  request_id TEXT, version INTEGER, created_at TEXT, updated_at TEXT, is_deleted INTEGER,
  deleted_at TEXT, deleted_by TEXT, treasury_id TEXT
);
CREATE TABLE IF NOT EXISTS custody_ledger (
  ledger_id TEXT PRIMARY KEY, holder_id TEXT, holder_type TEXT, document_type TEXT, document_id TEXT,
  document_number TEXT, event_type TEXT, direction TEXT, count_delta INTEGER, amount_minor_delta INTEGER,
  balance_count_after INTEGER, balance_amount_after INTEGER, occurred_at TEXT, recorded_by TEXT,
  request_id TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS custody_balances (
  balance_id TEXT PRIMARY KEY, holder_id TEXT, holder_type TEXT, document_type TEXT,
  document_count INTEGER, total_amount_minor INTEGER, last_event_at TEXT, calculated_at TEXT,
  balance_status TEXT, version INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  exception_id TEXT PRIMARY KEY, holder_id TEXT, document_type TEXT, expected_count INTEGER,
  actual_count INTEGER, expected_amount_minor INTEGER, actual_amount_minor INTEGER, detected_at TEXT,
  resolved_at TEXT, resolution_notes TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY, alert_type TEXT, entity_type TEXT, entity_id TEXT, bucket TEXT,
  due_date TEXT, status TEXT, created_at TEXT, acknowledged_by TEXT, acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id TEXT PRIMARY KEY, request_id TEXT, user_id TEXT, operation TEXT, entity_type TEXT,
  entity_id TEXT, old_value TEXT, new_value TEXT, changed_fields TEXT, timestamp TEXT,
  ip_address TEXT, result TEXT, audit_hash TEXT, previous_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_hash ON audit_logs(audit_hash);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, file_name TEXT, r2_key TEXT,
  uploaded_by TEXT, uploaded_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY, user_id TEXT, notification_type TEXT, entity_type TEXT,
  entity_id TEXT, title TEXT, body TEXT, channel TEXT, status TEXT, created_at TEXT,
  read_at TEXT, delivery_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, status);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, action TEXT, requested_by TEXT,
  requested_at TEXT, status TEXT, approver_id TEXT, decided_at TEXT, decision_notes TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE TABLE IF NOT EXISTS security_events (
  event_id TEXT PRIMARY KEY, event_type TEXT, user_id TEXT, ip_address TEXT, request_id TEXT,
  details_json TEXT, severity TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS backups (
  backup_id TEXT PRIMARY KEY, scope TEXT, workbook_ids TEXT, r2_key TEXT, size_bytes INTEGER,
  checksum TEXT, status TEXT, started_at TEXT, completed_at TEXT, retention_until TEXT
);
CREATE TABLE IF NOT EXISTS processed_requests (
  idempotency_key TEXT PRIMARY KEY, request_id TEXT, action TEXT, entity TEXT, result_json TEXT,
  created_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS integration_errors (
  error_id TEXT PRIMARY KEY, request_id TEXT, action TEXT, envelope_json TEXT, error_code TEXT,
  message TEXT, retry_count INTEGER, created_at TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS idx_tracking (
  track_key TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, current_status TEXT,
  current_holder TEXT, current_location TEXT, last_movement_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS idx_id_map (
  public_id TEXT PRIMARY KEY, sheet_name TEXT, row_number INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, next_value INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT, description TEXT, updated_by TEXT, updated_at TEXT);
