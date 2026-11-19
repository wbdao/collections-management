/** Apps Script copy of the approved enum/permission catalog. Mirrors shared/constants/enums.js. */

var ROLES = {
  ADMIN: 'ADMIN',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  COLLECTOR: 'COLLECTOR',
  TREASURY: 'TREASURY',
  AUDITOR: 'AUDITOR'
};

var BOOK_STATUSES = ['AVAILABLE', 'ASSIGNED', 'COMPLETED', 'CANCELLED', 'LOST'];
var RECEIPT_STATUSES = ['UNUSED', 'COLLECTED', 'DEPOSITED_BRANCH', 'DEPOSITED_HQ', 'CANCELLED', 'LOST'];
var BATCH_STATUSES = ['EXPECTED', 'RECEIVED', 'INSPECTED', 'ACTIVE', 'QUARANTINED', 'RETURNED_TO_SUPPLIER', 'CLOSED'];
var CHEQUE_STATUSES = ['AT_BRANCH', 'SENT_TO_HQ', 'AT_BANK', 'CLEARING', 'CLEARED', 'RETURNED'];
var GUARANTEE_STATUSES = ['AT_BRANCH', 'AT_HQ', 'LEGAL_DEPARTMENT', 'RELEASED', 'CLOSED'];
var DOCUMENT_TYPES = ['BOOK', 'RECEIPT', 'CHEQUE', 'GUARANTEE'];
var ALERT_TYPES = ['GUARANTEE_EXPIRY', 'CHEQUE_OVERDUE', 'CUSTODY_VARIANCE', 'FAILED_RECONCILIATION'];
var ALERT_BUCKETS = ['DUE_30', 'DUE_15', 'DUE_7', 'EXPIRED', 'NA'];
var CUSTODY_HOLDER_TYPES = ['COLLECTOR', 'BRANCH_TREASURY', 'HQ_TREASURY', 'WAREHOUSE', 'BANK', 'LEGAL'];
var PAYMENT_METHODS = ['CASH', 'CHEQUE', 'OTHER'];

/** Approved transition graph. Mirrors STATE_MACHINES in shared/constants/enums.js. */
var STATE_MACHINES = {
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
};

var ENTITY_LABEL = {
  book_batches: 'BATCH', books: 'BOOK', receipts: 'RECEIPT',
  cheques: 'CHEQUE', guarantees: 'GUARANTEE'
};

var PERMISSION_CATALOG = [
  ['dashboard.read', 'dashboard', 'read'],
  ['batches.read', 'batches', 'read'], ['batches.create', 'batches', 'create'], ['batches.manage', 'batches', 'manage'],
  ['books.read', 'books', 'read'], ['books.create', 'books', 'create'], ['books.assign', 'books', 'assign'],
  ['books.return', 'books', 'return'], ['books.transition', 'books', 'transition'],
  ['receipts.read', 'receipts', 'read'], ['receipts.collect', 'receipts', 'collect'],
  ['receipts.cancel', 'receipts', 'cancel'], ['receipts.mark_lost', 'receipts', 'mark_lost'],
  ['collections.read', 'collections', 'read'], ['collections.create', 'collections', 'create'],
  ['collections.reconcile', 'collections', 'reconcile'],
  ['deposits.branch.read', 'deposits', 'branch.read'], ['deposits.branch.create', 'deposits', 'branch.create'],
  ['deposits.branch.confirm', 'deposits', 'branch.confirm'],
  ['deposits.hq.read', 'deposits', 'hq.read'], ['deposits.hq.create', 'deposits', 'hq.create'],
  ['deposits.hq.confirm', 'deposits', 'hq.confirm'],
  ['cheques.read', 'cheques', 'read'], ['cheques.create', 'cheques', 'create'], ['cheques.update', 'cheques', 'update'],
  ['cheques.transition', 'cheques', 'transition'],
  ['guarantees.read', 'guarantees', 'read'], ['guarantees.create', 'guarantees', 'create'],
  ['guarantees.update', 'guarantees', 'update'], ['guarantees.transition', 'guarantees', 'transition'],
  ['movements.read', 'movements', 'read'], ['movements.create', 'movements', 'create'],
  ['custody.read', 'custody', 'read'], ['custody.reconcile', 'custody', 'reconcile'],
  ['tracking.read', 'tracking', 'read'], ['reports.read', 'reports', 'read'], ['audit.read', 'audit', 'read'],
  ['users.manage', 'users', 'manage'], ['settings.manage', 'settings', 'manage'],
  // Customer master is external and read-only; only lookup/autocomplete exist.
  ['customers.read', 'customers', 'read'],
  ['alerts.read', 'alerts', 'read'], ['alerts.acknowledge', 'alerts', 'acknowledge'], ['alerts.scan', 'alerts', 'scan'],
  // PHASE 2 / M011 — additive permissions.
  ['audit.verify', 'audit', 'verify'], ['sessions.read', 'sessions', 'read'],
  ['sessions.revoke', 'sessions', 'revoke'], ['mfa.manage', 'mfa', 'manage'],
  ['treasuries.read', 'treasuries', 'read'], ['treasuries.manage', 'treasuries', 'manage'],
  ['attachments.read', 'attachments', 'read'], ['attachments.create', 'attachments', 'create'],
  ['attachments.delete', 'attachments', 'delete'],
  ['notifications.read', 'notifications', 'read'], ['notifications.manage', 'notifications', 'manage'],
  ['approvals.read', 'approvals', 'read'], ['approvals.decide', 'approvals', 'decide'],
  ['reports.advanced.read', 'reports', 'advanced.read'],
  ['backups.read', 'backups', 'read'], ['backups.create', 'backups', 'create'],
  ['security.read', 'security', 'read'], ['migration.run', 'migration', 'run']
];

// PHASE 2 additive enum mirrors.
var TREASURY_TYPES = ['BRANCH', 'HQ'];
var TREASURY_STATUSES = ['ACTIVE', 'INACTIVE'];
var NOTIFICATION_TYPES = ['GUARANTEE_EXPIRY', 'CHEQUE_OVERDUE', 'CUSTODY_VARIANCE', 'FAILED_RECONCILIATION'];
var NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS'];
var APPROVAL_ENTITIES = ['HQ_DEPOSIT', 'CHEQUE_STATUS_CHANGE', 'GUARANTEE_RELEASE'];
var APPROVAL_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'];

var READ_PERMISSIONS = PERMISSION_CATALOG.filter(function (p) { return p[2] === 'read' || p[1] === 'audit'; }).map(function (p) { return p[0]; });

var ROLE_PERMISSION_MAP = {};
ROLE_PERMISSION_MAP[ROLES.ADMIN] = PERMISSION_CATALOG.map(function (p) { return p[0]; });
ROLE_PERMISSION_MAP[ROLES.BRANCH_MANAGER] = [
  'dashboard.read', 'batches.read', 'batches.manage', 'books.read', 'books.create', 'books.assign', 'books.return',
  'receipts.read', 'receipts.collect', 'collections.read', 'collections.create', 'collections.reconcile',
  'deposits.branch.read', 'deposits.branch.create', 'deposits.branch.confirm',
  'cheques.read', 'guarantees.read', 'movements.read', 'movements.create', 'custody.read',
  'tracking.read', 'reports.read', 'customers.read',
  'alerts.read', 'alerts.acknowledge',
  'treasuries.read', 'notifications.read', 'approvals.read', 'reports.advanced.read'
];
ROLE_PERMISSION_MAP[ROLES.COLLECTOR] = [
  'dashboard.read', 'books.read', 'receipts.read', 'receipts.collect', 'collections.read', 'collections.create',
  'custody.read', 'tracking.read', 'notifications.read'
];
ROLE_PERMISSION_MAP[ROLES.TREASURY] = [
  'dashboard.read', 'books.read', 'books.return', 'receipts.read', 'collections.read',
  'deposits.branch.read', 'deposits.branch.create', 'deposits.branch.confirm',
  'deposits.hq.read', 'deposits.hq.create', 'deposits.hq.confirm',
  'cheques.read', 'cheques.create', 'cheques.update', 'cheques.transition',
  'guarantees.read', 'guarantees.create', 'guarantees.update', 'guarantees.transition',
  'movements.read', 'movements.create', 'custody.read', 'tracking.read', 'reports.read',
  'alerts.read', 'alerts.acknowledge',
  'treasuries.read', 'treasuries.manage', 'attachments.read', 'attachments.create',
  'notifications.read', 'approvals.read', 'approvals.decide', 'reports.advanced.read'
];
ROLE_PERMISSION_MAP[ROLES.AUDITOR] = READ_PERMISSIONS.concat([
  'audit.read', 'audit.verify', 'reports.read', 'reports.advanced.read', 'custody.read'
]);
