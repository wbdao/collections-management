/**
 * PHASE 2 / Step 10 — D1RepositoryAdapter (INACTIVE reference implementation).
 *
 * Implements the exact same 8-method Repository contract as the Phase 1
 * Apps Script adapter, but against a Cloudflare D1 binding (env.DB) using
 * migrations/d1/0001_init.sql as the schema reference.
 *
 * IMPORTANT:
 *  - No D1 binding is added in Phase 2 and this adapter is never selected in
 *    production. Google Sheets remains the single source of truth.
 *  - It is selected ONLY when env.REPOSITORY_ADAPTER === 'd1'.
 *  - Service actions (auth.*, audit.verify, backup.*, ...) that have not been
 *    ported to SQL are forwarded to Apps Script via the unchanged `call()`
 *    escape hatch, exactly as the design specifies.
 */

import { callGas } from './gas-client.js';
import { assertRepository } from '../../shared/contracts/repository.js';
import { STATE_MACHINES } from '../../shared/constants/enums.js';

/* -------------------------------------------------------------------------- */
/* Table metadata — derived 1:1 from migrations/d1/0001_init.sql               */
/* -------------------------------------------------------------------------- */

function cols(list) { return list.trim().split(/\s+/); }

const T = {
  users: {
    pk: 'user_id', versioned: true, softDelete: true, search: 'username full_name',
    columns: cols(`user_id username password_hash full_name email role_id status failed_attempts
      last_login_at created_at updated_at version is_deleted deleted_at deleted_by mfa_enabled
      mfa_secret locked_until`)
  },
  roles: { pk: 'role_id', columns: cols('role_id name description') },
  permissions: { pk: 'permission_id', columns: cols('permission_id code module action') },
  role_permissions: {
    pk: 'role_id', columns: cols('role_id permission_id')
  },
  user_scopes: {
    pk: 'scope_id', columns: cols('scope_id user_id scope_type scope_id_value created_at')
  },
  sessions: {
    pk: 'session_id',
    columns: cols('session_id user_id refresh_token_hash device_info ip_address created_at expires_at revoked_at')
  },
  treasuries: {
    pk: 'treasury_id', columns: cols('treasury_id treasury_name treasury_type warehouse status')
  },
  book_batches: {
    pk: 'batch_id', versioned: true, softDelete: true,
    columns: cols(`batch_id batch_number supplier delivery_date invoice_reference serial_from serial_to
      expected_quantity registered_quantity variance received_by inspected_by status notes version
      created_at updated_at is_deleted deleted_at deleted_by`)
  },
  books: {
    pk: 'book_id', versioned: true, softDelete: true, search: 'book_number',
    columns: cols(`book_id book_number batch_id serial_from serial_to total_receipts issue_date status
      current_holder_id current_holder_type current_location last_movement_id notes version created_at
      updated_at is_deleted deleted_at deleted_by`)
  },
  receipts: {
    pk: 'receipt_id', versioned: true, softDelete: true,
    search: 'receipt_number customer_name customer_code',
    columns: cols(`receipt_id receipt_number book_id sequence_in_book collector_id customer_code
      customer_name warehouse department collection_date amount_minor payment_method status collection_id
      branch_deposit_id hq_deposit_id last_receipt_movement_id cancelled_reason version created_at
      updated_at is_deleted deleted_at deleted_by`)
  },
  book_assignments: {
    pk: 'assignment_id', versioned: true, softDelete: true,
    columns: cols(`assignment_id book_id assigned_to assigned_by assigned_at due_return_at returned_at
      received_by condition_notes status version created_at updated_at is_deleted deleted_at deleted_by`)
  },
  collections: {
    pk: 'collection_id', versioned: true, softDelete: true,
    columns: cols(`collection_id collector_id book_id collection_date receipt_count total_minor status
      notes version created_at updated_at is_deleted deleted_at deleted_by`)
  },
  deposits_branch: {
    pk: 'deposit_id', versioned: true, softDelete: true, search: 'deposit_number',
    columns: cols(`deposit_id deposit_number deposit_date prepared_by approved_by receipt_count
      total_minor status notes version created_at updated_at is_deleted deleted_at deleted_by treasury_id`)
  },
  deposits_hq: {
    pk: 'deposit_id', versioned: true, softDelete: true, search: 'deposit_number hq_reference',
    columns: cols(`deposit_id deposit_number hq_reference deposit_date prepared_by received_by
      receipt_count total_minor status notes version created_at updated_at is_deleted deleted_at
      deleted_by treasury_id`)
  },
  deposit_lines: {
    pk: 'line_id', versioned: true, softDelete: true,
    columns: cols(`line_id deposit_id deposit_level receipt_id amount_minor line_status rejection_reason
      version created_at updated_at is_deleted deleted_at deleted_by`)
  },
  cheques: {
    pk: 'cheque_id', versioned: true, softDelete: true,
    search: 'cheque_number customer_name customer_code',
    columns: cols(`cheque_id cheque_number customer_code customer_name warehouse department cheque_date
      due_date amount_minor bank status clearing_started_at expected_clear_date bank_reference cleared_at
      return_reason current_holder current_location last_movement_id version created_at updated_at
      is_deleted deleted_at deleted_by treasury_id`)
  },
  guarantees: {
    pk: 'guarantee_id', versioned: true, softDelete: true,
    search: 'guarantee_number customer_name customer_code',
    columns: cols(`guarantee_id guarantee_number customer_code customer_name warehouse department
      contract_number amount_minor issue_date expiry_date status current_holder current_location
      last_movement_id version created_at updated_at is_deleted deleted_at deleted_by treasury_id`)
  },
  movements: {
    pk: 'movement_id', versioned: true, softDelete: true, search: 'document_number',
    columns: cols(`movement_id document_type document_id document_number from_location to_location
      from_holder_id to_holder_id movement_date performed_by authorized_by reason notes related_deposit_id
      request_id version created_at updated_at is_deleted deleted_at deleted_by treasury_id`)
  },
  custody_ledger: {
    pk: 'ledger_id', appendOnly: true,
    columns: cols(`ledger_id holder_id holder_type document_type document_id document_number event_type
      direction count_delta amount_minor_delta balance_count_after balance_amount_after occurred_at
      recorded_by request_id created_at`)
  },
  custody_balances: {
    pk: 'balance_id', versioned: true,
    columns: cols(`balance_id holder_id holder_type document_type document_count total_amount_minor
      last_event_at calculated_at balance_status version updated_at`)
  },
  reconciliation_exceptions: {
    pk: 'exception_id',
    columns: cols(`exception_id holder_id document_type expected_count actual_count
      expected_amount_minor actual_amount_minor detected_at resolved_at resolution_notes status`)
  },
  alerts: {
    pk: 'alert_id',
    columns: cols('alert_id alert_type entity_type entity_id bucket due_date status created_at acknowledged_by acknowledged_at')
  },
  audit_logs: {
    pk: 'audit_id', appendOnly: true,
    columns: cols(`audit_id request_id user_id operation entity_type entity_id old_value new_value
      changed_fields timestamp ip_address result audit_hash previous_hash`)
  },
  attachments: {
    pk: 'attachment_id',
    columns: cols('attachment_id entity_type entity_id file_name r2_key uploaded_by uploaded_at')
  },
  notifications: {
    pk: 'notification_id',
    columns: cols(`notification_id user_id notification_type entity_type entity_id title body channel
      status created_at read_at delivery_status`)
  },
  approvals: {
    pk: 'approval_id',
    columns: cols(`approval_id entity_type entity_id action requested_by requested_at status approver_id
      decided_at decision_notes expires_at`)
  },
  security_events: {
    pk: 'event_id', appendOnly: true,
    columns: cols('event_id event_type user_id ip_address request_id details_json severity created_at')
  },
  backups: {
    pk: 'backup_id',
    columns: cols(`backup_id scope workbook_ids r2_key size_bytes checksum status started_at
      completed_at retention_until`)
  },
  processed_requests: {
    pk: 'idempotency_key',
    columns: cols('idempotency_key request_id action entity result_json created_at expires_at')
  },
  integration_errors: {
    pk: 'error_id',
    columns: cols(`error_id request_id action envelope_json error_code message retry_count created_at
      resolved_at`)
  },
  idx_tracking: {
    pk: 'track_key',
    columns: cols(`track_key entity_type entity_id current_status current_holder current_location
      last_movement_at updated_at`)
  },
  idx_id_map: {
    pk: 'public_id',
    columns: cols('public_id sheet_name row_number updated_at')
  },
  sequences: {
    pk: 'name',
    columns: cols('name next_value updated_at')
  },
  settings: {
    pk: 'key',
    columns: cols('key value_json description updated_by updated_at')
  }
};

// Attach the entity name so statement builders can qualify INSERT/UPDATE.
Object.keys(T).forEach((entity) => { T[entity].__entity = entity; });

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const IDENT = /^[a-z_][a-z0-9_]*$/;

function fail(code, message, status) {
  throw Object.assign(new Error(message), { code, status });
}

function quote(identifier) {
  if (!IDENT.test(identifier)) fail('VALIDATION_ERROR', `Unsafe SQL identifier: ${identifier}`, 400);
  return `"${identifier}"`;
}

function metaFor(entity) {
  const meta = T[entity];
  if (!meta) fail('UNKNOWN_ENTITY', `Unknown entity: ${entity}`, 400);
  return meta;
}

function isColumn(meta, name) { return meta.columns.indexOf(name) >= 0; }

function idFor(entity) {
  const prefix = String(entity).slice(0, 3).toUpperCase();
  const uuid = (globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '');
  return `${prefix}_${uuid.slice(0, 20).toUpperCase()}`;
}

function nowIso() { return new Date().toISOString(); }

const FIELD_MAP = {
  id: null, // resolved to the table primary key at query time
  bookId: 'book_id', batchId: 'batch_id', receiptId: 'receipt_id', depositId: 'deposit_id',
  collectorId: 'collector_id', holderId: 'holder_id', customerId: 'customer_code',
  account: 'customer_code', warehouseId: 'warehouse', warehouse: 'warehouse',
  departmentId: 'department', department: 'department', branchId: 'branch_id',
  documentType: 'document_type', documentId: 'document_id', documentNumber: 'document_number',
  status: 'status', alertType: 'alert_type', bucket: 'bucket', entityType: 'entity_type',
  entityId: 'entity_id', number: 'receipt_number', lineId: 'line_id', assignmentId: 'assignment_id',
  userId: 'user_id', treasuryId: 'treasury_id', notificationType: 'notification_type',
  eventType: 'event_type', attachmentId: 'attachment_id', approvalId: 'approval_id'
};

const QUERY_CONTROL_KEYS = new Set([
  'limit', 'offset', 'orderBy', 'descending', 'includeDeleted', 'filters',
  'warehouseIds', 'branchIds', 'search', 'q'
]);

function columnFor(meta, key) {
  const mapped = Object.prototype.hasOwnProperty.call(FIELD_MAP, key) ? FIELD_MAP[key] : key;
  const column = mapped === null ? meta.pk : mapped;
  return isColumn(meta, column) ? column : null;
}

/** Builds the WHERE clause + bindings for a list() query. Never interpolates values. */
function buildWhere(meta, query) {
  const clauses = [];
  const binds = [];

  function eq(column, value) {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      const values = value.map(String);
      if (!values.length) return;
      clauses.push(`${quote(column)} IN (${values.map(() => '?').join(', ')})`);
      binds.push(...values);
    } else {
      clauses.push(`${quote(column)} = ?`);
      binds.push(value);
    }
  }

  if (meta.softDelete && query.includeDeleted !== true) {
    clauses.push('COALESCE("is_deleted", 0) = 0');
  }

  Object.keys(query).forEach((key) => {
    if (QUERY_CONTROL_KEYS.has(key)) return;
    const column = columnFor(meta, key);
    if (column) eq(column, query[key]);
  });

  if (query.filters && typeof query.filters === 'object') {
    Object.keys(query.filters).forEach((key) => {
      const column = columnFor(meta, key);
      if (column) eq(column, query.filters[key]);
    });
  }
  if (Array.isArray(query.warehouseIds) && query.warehouseIds.length && isColumn(meta, 'warehouse')) {
    eq('warehouse', query.warehouseIds);
  }
  if (Array.isArray(query.branchIds) && query.branchIds.length && isColumn(meta, 'branch_id')) {
    eq('branch_id', query.branchIds);
  }

  const term = query.search || query.q;
  if (term && meta.search) {
    const like = `%${String(term)}%`;
    const parts = meta.search.split(' ').filter((c) => isColumn(meta, c))
      .map((c) => `${quote(c)} LIKE ?`);
    if (parts.length) {
      clauses.push(`(${parts.join(' OR ')})`);
      for (let i = 0; i < parts.length; i++) binds.push(like);
    }
  }

  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', binds };
}

/* -------------------------------------------------------------------------- */
/* Statement builders — shared by direct methods and the transaction wrapper   */
/* -------------------------------------------------------------------------- */

function buildInsertStatement(db, meta, input) {
  const row = { ...input };
  if (!row[meta.pk]) row[meta.pk] = idFor(meta.pk === 'key' ? 'setting' : meta.pk);
  if (meta.versioned && row.version === undefined) row.version = 1;
  if (isColumn(meta, 'created_at') && !row.created_at) row.created_at = nowIso();
  if (isColumn(meta, 'updated_at') && !row.updated_at) row.updated_at = nowIso();
  if (meta.softDelete) {
    if (row.is_deleted === undefined) row.is_deleted = 0;
    if (isColumn(meta, 'deleted_at') && row.deleted_at === undefined) row.deleted_at = '';
    if (isColumn(meta, 'deleted_by') && row.deleted_by === undefined) row.deleted_by = '';
  }

  const entries = Object.keys(row).filter((k) => isColumn(meta, k));
  if (!entries.length) fail('VALIDATION_ERROR', 'No valid columns to insert', 400);
  const sql = `INSERT INTO ${quote(meta.__entity)} (${entries.map(quote).join(', ')}) `
    + `VALUES (${entries.map(() => '?').join(', ')})`;
  return { statement: db.prepare(sql).bind(...entries.map((k) => row[k])), row };
}

function buildUpdateStatement(db, meta, id, patch, expectedVersion) {
  if (meta.appendOnly) fail('APPEND_ONLY', `${meta.__entity} is append-only`, 409);
  const updates = {};
  Object.keys(patch || {}).forEach((k) => {
    if (k !== meta.pk && isColumn(meta, k)) updates[k] = patch[k];
  });
  if (meta.versioned) {
    updates.version = Number(patch?.version || expectedVersion || 1) + 1;
    if (isColumn(meta, 'updated_at')) updates.updated_at = nowIso();
  }
  const keys = Object.keys(updates);
  if (!keys.length) fail('VALIDATION_ERROR', 'No valid columns to update', 400);

  let sql = `UPDATE ${quote(meta.__entity)} SET ${keys.map((k) => `${quote(k)} = ?`).join(', ')} `
    + `WHERE ${quote(meta.pk)} = ?`;
  const binds = keys.map((k) => updates[k]);
  binds.push(id);
  if (meta.versioned && expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
    sql += ` AND "version" = ?`;
    binds.push(Number(expectedVersion));
  }
  return { statement: db.prepare(sql).bind(...binds), updates };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class D1RepositoryAdapter {
  constructor(db, ctx = {}) {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('D1RepositoryAdapter requires a D1 binding (env.DB)');
    }
    this.db = db;
    this.ctx = ctx;
    this.env = ctx.env || {};
  }

  /** Service actions not ported to SQL keep using the GAS escape hatch. */
  call(action, entity, payload = {}) {
    if (!this.env.GAS_URL || !this.env.GAS_SHARED_SECRET) {
      fail('D1_CALL_UNAVAILABLE',
        `D1 adapter cannot service action "${action}" without GAS configuration`, 500);
    }
    return callGas(this.env, this.ctx, action, entity, payload);
  }

  async list(entity, query = {}, options = {}) {
    const meta = metaFor(entity);
    const { sql, binds } = buildWhere(meta, query || {});
    let statement = `SELECT * FROM ${quote(entity)}${sql}`;
    const orderBy = options.orderBy || query.orderBy;
    if (orderBy && isColumn(meta, orderBy)) {
      const descending = options.descending !== undefined ? options.descending : query.descending;
      statement += ` ORDER BY ${quote(orderBy)} ${descending === false ? 'ASC' : 'DESC'}`;
    }
    const limit = Number(options.limit || query.limit || 0);
    const offset = Number(options.offset || query.offset || 0);
    const finalBinds = binds.slice();
    if (limit) { statement += ' LIMIT ?'; finalBinds.push(limit); }
    if (offset) { statement += ' OFFSET ?'; finalBinds.push(offset); }

    const result = await this.db.prepare(statement).bind(...finalBinds).all();
    return { ok: true, data: result.results || [], meta: {} };
  }

  async get(entity, id) {
    const meta = metaFor(entity);
    const result = await this.db.prepare(
      `SELECT * FROM ${quote(entity)} WHERE ${quote(meta.pk)} = ? LIMIT 1`
    ).bind(id).first();
    if (!result) fail('NOT_FOUND', `${entity} not found: ${id}`, 404);
    return { ok: true, data: result, meta: { version: result.version } };
  }

  async insert(entity, data = {}) {
    const meta = metaFor(entity);
    const { statement, row } = buildInsertStatement(this.db, meta, data);
    await statement.run();
    return { ok: true, data: row, meta: {} };
  }

  async update(entity, id, patch = {}, expectedVersion) {
    const meta = metaFor(entity);
    const { statement, updates } = buildUpdateStatement(this.db, meta, id, patch, expectedVersion);
    const result = await statement.run();
    const changes = Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0);
    if (changes === 0) {
      // Distinguish a genuine version conflict from a missing row.
      const existing = await this.db.prepare(
        `SELECT ${quote(meta.pk)} FROM ${quote(entity)} WHERE ${quote(meta.pk)} = ? LIMIT 1`
      ).bind(id).first();
      if (!existing) fail('NOT_FOUND', `${entity} not found: ${id}`, 404);
      if (meta.versioned && expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
        fail('CONFLICT_VERSION', 'Record was modified by another request', 409);
      }
    }
    const next = await this.get(entity, id);
    return { ok: true, data: next.data, meta: { version: updates.version ?? next.meta.version } };
  }

  async transition(entity, id, toStatus, payload = {}) {
    const meta = metaFor(entity);
    const current = await this.get(entity, id);
    const machine = STATE_MACHINES[entity];
    if (machine && machine[current.data.status] && machine[current.data.status].indexOf(toStatus) < 0) {
      fail('VALIDATION_ERROR', `Invalid transition ${current.data.status} -> ${toStatus}`, 400);
    }
    const patch = { status: toStatus };
    if (payload.notes !== undefined && isColumn(meta, 'notes')) patch.notes = payload.notes;
    const updated = await this.update(entity, id, patch, current.meta.version);
    // An explicitly supplied ledger entry is appended in the same logical step.
    if (payload.entry) {
      await this.appendLedger(payload.entry);
    }
    return updated;
  }

  async aggregate(name, params = {}) {
    // A small set of D1-native aggregates; the rest use the GAS escape hatch
    // until they are ported. This adapter is inactive in Phase 2.
    if (name === 'alertSummary') {
      const result = await this.db.prepare(
        'SELECT status, COUNT(*) AS count FROM alerts GROUP BY status'
      ).all();
      const byStatus = {};
      (result.results || []).forEach((row) => { byStatus[row.status] = Number(row.count); });
      return { ok: true, data: { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) }, meta: {} };
    }
    if (name === 'receiptsInTransit') {
      const result = await this.db.prepare(
        `SELECT * FROM receipts WHERE status IN ('COLLECTED','DEPOSITED_BRANCH') ORDER BY collection_date DESC`
      ).all();
      return { ok: true, data: { items: result.results || [] }, meta: {} };
    }
    return this.call('aggregate', name, { params });
  }

  async appendLedger(entry = {}) {
    const meta = metaFor('custody_ledger');
    const { statement, row } = buildInsertStatement(this.db, meta, entry);
    await statement.run();
    return { ok: true, data: row, meta: {} };
  }

  withTransaction() {
    return new D1Transaction(this);
  }
}

/* -------------------------------------------------------------------------- */
/* Transaction — fluent API matching the Phase 1 Transaction class             */
/* -------------------------------------------------------------------------- */

export class D1Transaction {
  constructor(repository) {
    this.repository = repository;
    this.operations = [];
    this.committed = false;
  }

  insert(entity, data) {
    this.operations.push({ method: 'insert', args: [entity, data] });
    return this;
  }

  update(entity, id, patch, expectedVersion) {
    this.operations.push({ method: 'update', args: [entity, id, patch, expectedVersion] });
    return this;
  }

  transition(entity, id, toStatus, payload = {}) {
    this.operations.push({ method: 'transition', args: [entity, id, toStatus, payload] });
    return this;
  }

  appendLedger(entry) {
    this.operations.push({ method: 'appendLedger', args: [entry] });
    return this;
  }

  call(action, entity, payload = {}) {
    this.operations.push({ method: 'call', args: [action, entity, payload] });
    return this;
  }

  async commit() {
    if (this.committed) throw new Error('Transaction already committed');
    this.committed = true;
    if (!this.operations.length) return { ok: true, data: {}, meta: { rowsAffected: 0 } };

    // Operations run through the adapter so version checks and result shapes
    // are identical to direct calls. Enabling D1 in production should replace
    // this with a db.batch() plus pre-validated versions for full atomicity.
    const results = [];
    for (const op of this.operations) {
      results.push(await this.repository[op.method](...op.args));
    }
    return {
      ok: true,
      data: { results, rowsAffected: results.length },
      meta: { rowsAffected: results.length }
    };
  }
}

assertRepository(D1RepositoryAdapter.prototype);

export default D1RepositoryAdapter;
