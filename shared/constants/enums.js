/** Approved Phase 1 constants. Mirror: apps-script/constants.gs */

export const ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  COLLECTOR: 'COLLECTOR',
  TREASURY: 'TREASURY',
  AUDITOR: 'AUDITOR'
});

export const BOOK_STATUSES = Object.freeze(['AVAILABLE', 'ASSIGNED', 'COMPLETED', 'CANCELLED', 'LOST']);
export const RECEIPT_STATUSES = Object.freeze([
  'UNUSED', 'COLLECTED', 'DEPOSITED_BRANCH', 'DEPOSITED_HQ', 'CANCELLED', 'LOST'
]);
export const BATCH_STATUSES = Object.freeze([
  'EXPECTED', 'RECEIVED', 'INSPECTED', 'ACTIVE', 'QUARANTINED', 'RETURNED_TO_SUPPLIER', 'CLOSED'
]);
export const CHEQUE_STATUSES = Object.freeze([
  'AT_BRANCH', 'SENT_TO_HQ', 'AT_BANK', 'CLEARING', 'CLEARED', 'RETURNED'
]);
export const GUARANTEE_STATUSES = Object.freeze([
  'AT_BRANCH', 'AT_HQ', 'LEGAL_DEPARTMENT', 'RELEASED', 'CLOSED'
]);
export const DOCUMENT_TYPES = Object.freeze(['BOOK', 'RECEIPT', 'CHEQUE', 'GUARANTEE']);
export const ALERT_TYPES = Object.freeze(['GUARANTEE_EXPIRY', 'CHEQUE_OVERDUE', 'CUSTODY_VARIANCE']);
export const ALERT_BUCKETS = Object.freeze(['DUE_30', 'DUE_15', 'DUE_7', 'EXPIRED', 'NA']);
export const CUSTODY_HOLDER_TYPES = Object.freeze([
  'COLLECTOR', 'BRANCH_TREASURY', 'HQ_TREASURY', 'WAREHOUSE', 'BANK', 'LEGAL'
]);
export const PAYMENT_METHODS = Object.freeze(['CASH', 'CHEQUE', 'OTHER']);

export const PERMISSIONS = Object.freeze([
  'dashboard.read', 'batches.read', 'batches.create', 'batches.manage',
  'books.read', 'books.create', 'books.assign', 'books.return', 'books.transition',
  'receipts.read', 'receipts.collect', 'receipts.cancel', 'receipts.mark_lost',
  'collections.read', 'collections.create', 'collections.reconcile',
  'deposits.branch.read', 'deposits.branch.create', 'deposits.branch.confirm',
  'deposits.hq.read', 'deposits.hq.create', 'deposits.hq.confirm',
  'cheques.read', 'cheques.create', 'cheques.update', 'cheques.transition',
  'guarantees.read', 'guarantees.create', 'guarantees.update', 'guarantees.transition',
  'movements.read', 'movements.create', 'custody.read', 'custody.reconcile',
  'tracking.read', 'reports.read', 'audit.read', 'users.manage', 'settings.manage',
  // Customer master is external and read-only; only lookup/autocomplete exist.
  'customers.read',
  'alerts.read', 'alerts.acknowledge', 'alerts.scan'
]);

/** Mirrors ROLE_PERMISSION_MAP in apps-script/constants.gs */
export const ROLE_PERMISSIONS = Object.freeze({
  ADMIN: PERMISSIONS.slice(),
  BRANCH_MANAGER: [
    'dashboard.read', 'batches.read', 'batches.manage', 'books.read', 'books.create', 'books.assign',
    'books.return', 'receipts.read', 'receipts.collect', 'collections.read', 'collections.create',
    'collections.reconcile', 'deposits.branch.read', 'deposits.branch.create', 'deposits.branch.confirm',
    'cheques.read', 'guarantees.read', 'movements.read', 'movements.create', 'custody.read',
    'tracking.read', 'reports.read', 'customers.read',
    'alerts.read', 'alerts.acknowledge'
  ],
  COLLECTOR: [
    'dashboard.read', 'books.read', 'receipts.read', 'receipts.collect', 'collections.read',
    'collections.create', 'custody.read', 'tracking.read'
  ],
  TREASURY: [
    'dashboard.read', 'books.read', 'books.return', 'receipts.read', 'collections.read',
    'deposits.branch.read', 'deposits.branch.create', 'deposits.branch.confirm',
    'deposits.hq.read', 'deposits.hq.create', 'deposits.hq.confirm',
    'cheques.read', 'cheques.create', 'cheques.update', 'cheques.transition',
    'guarantees.read', 'guarantees.create', 'guarantees.update', 'guarantees.transition',
    'movements.read', 'movements.create', 'custody.read', 'tracking.read', 'reports.read',
    'alerts.read', 'alerts.acknowledge'
  ],
  AUDITOR: PERMISSIONS.filter((p) => p.endsWith('.read'))
});

export const STATE_MACHINES = Object.freeze({
  book_batches: {
    EXPECTED: ['RECEIVED', 'QUARANTINED'],
    RECEIVED: ['INSPECTED', 'QUARANTINED'],
    INSPECTED: ['ACTIVE', 'QUARANTINED'],
    QUARANTINED: ['ACTIVE', 'RETURNED_TO_SUPPLIER'],
    ACTIVE: ['CLOSED'],
    CLOSED: [],
    RETURNED_TO_SUPPLIER: []
  },
  books: {
    AVAILABLE: ['ASSIGNED', 'CANCELLED', 'LOST'],
    ASSIGNED: ['AVAILABLE', 'COMPLETED', 'CANCELLED', 'LOST'],
    COMPLETED: [], CANCELLED: [], LOST: []
  },
  receipts: {
    UNUSED: ['COLLECTED', 'CANCELLED', 'LOST'],
    COLLECTED: ['DEPOSITED_BRANCH', 'CANCELLED'],
    DEPOSITED_BRANCH: ['DEPOSITED_HQ'],
    DEPOSITED_HQ: [], CANCELLED: [], LOST: []
  },
  cheques: {
    AT_BRANCH: ['SENT_TO_HQ'],
    SENT_TO_HQ: ['AT_BANK'],
    AT_BANK: ['CLEARING'],
    CLEARING: ['CLEARED', 'RETURNED'],
    CLEARED: [], RETURNED: []
  },
  guarantees: {
    AT_BRANCH: ['AT_HQ'],
    AT_HQ: ['LEGAL_DEPARTMENT'],
    LEGAL_DEPARTMENT: ['RELEASED', 'CLOSED'],
    RELEASED: [], CLOSED: []
  }
});

export const ENTITY_LABEL = Object.freeze({
  book_batches: 'BATCH', books: 'BOOK', receipts: 'RECEIPT', cheques: 'CHEQUE', guarantees: 'GUARANTEE'
});

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
