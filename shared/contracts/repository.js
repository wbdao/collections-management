/**
 * Canonical Repository contract for CMS Phase 1.
 * Both the Cloudflare implementation and the future D1 implementation must
 * satisfy this contract. Business modules only import this interface.
 */

export const REPOSITORY_METHODS = Object.freeze([
  'list',
  'get',
  'insert',
  'update',
  'transition',
  'aggregate',
  'appendLedger',
  'withTransaction'
]);

/**
 * @typedef {Object} RepositoryContext
 * @property {string} requestId
 * @property {string} [idempotencyKey]
 * @property {{userId:string, username:string, role:string, scopes:Array}} [actor]
 *
 * @typedef {Object} RepositoryResult
 * @property {boolean} ok
 * @property {*} data
 * @property {{version?:number, warnings?:Array, rowsAffected?:number}} meta
 */

/**
 * Interface (documented; JavaScript has no native interfaces):
 *
 * list(entity, query?, options?)            -> RepositoryResult<Array>
 * get(entity, id)                           -> RepositoryResult<Object>
 * insert(entity, data)                      -> RepositoryResult<Object>
 * update(entity, id, patch, expectedVersion?)-> RepositoryResult<Object>
 * transition(entity, id, toStatus, payload) -> RepositoryResult<Object>
 * aggregate(name, params)                   -> RepositoryResult<Object>
 * appendLedger(entry)                       -> RepositoryResult<Object>
 * withTransaction()                         -> Transaction (insert/update/transition/
 *                                              appendLedger/call + commit)
 */

export function assertRepository(api) {
  const missing = REPOSITORY_METHODS.filter((m) => typeof api[m] !== 'function');
  if (missing.length) throw new Error(`Repository is missing methods: ${missing.join(', ')}`);
  return api;
}

/**
 * Only operational entities are listed here. Customer master data, warehouses
 * and departments are external to the spreadsheet and are read through the
 * customer master service; they deliberately have no entity entries.
 */
export const ENTITY = Object.freeze({
  USERS: 'users',
  ROLES: 'roles',
  PERMISSIONS: 'permissions',
  ROLE_PERMISSIONS: 'role_permissions',
  USER_SCOPES: 'user_scopes',
  BATCHES: 'book_batches',
  BOOKS: 'books',
  RECEIPTS: 'receipts',
  ASSIGNMENTS: 'book_assignments',
  CUSTODY_LEDGER: 'custody_ledger',
  CUSTODY_BALANCES: 'custody_balances',
  RECONCILIATION: 'reconciliation_exceptions',
  COLLECTIONS: 'collections',
  DEPOSITS_BRANCH: 'deposits_branch',
  DEPOSITS_HQ: 'deposits_hq',
  DEPOSIT_LINES: 'deposit_lines',
  CHEQUES: 'cheques',
  GUARANTEES: 'guarantees',
  MOVEMENTS: 'movements',
  ALERTS: 'alerts',
  AUDIT_LOGS: 'audit_logs',
  // PHASE 2 — additive entity keys only. The 8-method contract above is
  // deliberately unchanged; no new repository method is introduced.
  SESSIONS: 'sessions',
  TREASURIES: 'treasuries',
  ATTACHMENTS: 'attachments',
  NOTIFICATIONS: 'notifications',
  APPROVALS: 'approvals',
  SECURITY_EVENTS: 'security_events',
  BACKUPS: 'backups'
});
