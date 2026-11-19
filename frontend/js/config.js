/** Frontend configuration and approval-catalog display values (mirrors shared enums). */

export const API_BASE = '/api/v1';

export const STORAGE_KEYS = Object.freeze({
  TOKEN: 'cms.accessToken',
  // PHASE 2 / Step 2 — 15-minute access tokens + 7-day rotating refresh tokens.
  REFRESH_TOKEN: 'cms.refreshToken',
  SESSION: 'cms.sessionId',
  USER: 'cms.user',
  PERMISSIONS: 'cms.permissions'
});

export const ROLES = Object.freeze([
  'ADMIN', 'BRANCH_MANAGER', 'COLLECTOR', 'TREASURY', 'AUDITOR'
]);

export const STATUS_TONES = Object.freeze({
  AVAILABLE: 'success', ACTIVE: 'success', CLEARED: 'success',
  RECONCILED: 'success', CONFIRMED: 'success', ACKNOWLEDGED: 'success', BALANCED: 'success',
  ASSIGNED: 'primary', COLLECTED: 'primary', AT_BANK: 'primary', CLEARING: 'info',
  SENT_TO_HQ: 'info', DEPOSITED_BRANCH: 'info', IN_TRANSIT: 'info',
  DEPOSITED_HQ: 'success', COMPLETED: 'success', RECEIVED: 'info', INSPECTED: 'info',
  EXPECTED: 'info', QUARANTINED: 'warning', DUE_30: 'warning', DUE_15: 'warning',
  DUE_7: 'danger', EXPIRED: 'danger', SHORT: 'danger', OVER: 'warning',
  CANCELLED: 'danger', LOST: 'danger', RETURNED: 'danger', REJECTED: 'danger',
  VARIANCE: 'danger', PARTIAL: 'warning', DRAFT: 'info', SUBMITTED: 'info',
  AT_BRANCH: 'info', AT_HQ: 'primary', LEGAL_DEPARTMENT: 'primary',
  RELEASED: 'success', CLOSED: 'info', RETURNED_TO_SUPPLIER: 'danger', OPEN: 'warning'
});

export const BOOK_STATUSES = ['AVAILABLE', 'ASSIGNED', 'COMPLETED', 'CANCELLED', 'LOST'];
export const RECEIPT_STATUSES = ['UNUSED', 'COLLECTED', 'DEPOSITED_BRANCH', 'DEPOSITED_HQ', 'CANCELLED', 'LOST'];
export const BATCH_STATUSES = ['EXPECTED', 'RECEIVED', 'INSPECTED', 'ACTIVE', 'QUARANTINED', 'RETURNED_TO_SUPPLIER', 'CLOSED'];
export const CHEQUE_STATUSES = ['AT_BRANCH', 'SENT_TO_HQ', 'AT_BANK', 'CLEARING', 'CLEARED', 'RETURNED'];
export const GUARANTEE_STATUSES = ['AT_BRANCH', 'AT_HQ', 'LEGAL_DEPARTMENT', 'RELEASED', 'CLOSED'];
export const DOCUMENT_TYPES = ['BOOK', 'RECEIPT', 'CHEQUE', 'GUARANTEE'];
export const ALERT_TYPES = ['GUARANTEE_EXPIRY', 'CHEQUE_OVERDUE', 'CUSTODY_VARIANCE'];
export const ALERT_BUCKETS = ['DUE_30', 'DUE_15', 'DUE_7', 'EXPIRED'];
