# Phase 2 — Repository Interface Changes (Design)

**Status:** Approved; additive ENTITY keys implemented. `shared/contracts/repository.js` method signatures and result contract are unchanged.

> **Rollout update:** R2 is skipped. Attachment and backup metadata entities
> remain as additive schema/contract entries, but their R2-backed edge flows are
> dormant and unmounted. Google Sheets is the only production store.

---

## 1. What does NOT change (hard constraint)

`shared/contracts/repository.js` remains **byte-for-byte unchanged**:

- `REPOSITORY_METHODS` — the same 8 names: `list, get, insert, update, transition, aggregate, appendLedger, withTransaction`.
- `assertRepository(api)` and all JSDoc signatures.
- Every method signature:
  ```
  list(entity, query?, options?)             -> RepositoryResult<Array>
  get(entity, id)                            -> RepositoryResult<Object>
  insert(entity, data)                       -> RepositoryResult<Object>
  update(entity, id, patch, expectedVersion?) -> RepositoryResult<Object>
  transition(entity, id, toStatus, payload)  -> RepositoryResult<Object>
  aggregate(name, params)                    -> RepositoryResult<Object>
  appendLedger(entry)                        -> RepositoryResult<Object>
  withTransaction()                          -> Transaction (insert/update/transition/appendLedger/call + commit)
  ```
- `RepositoryResult` shape `{ok, data, meta:{version?, warnings?, rowsAffected?}}` and `RepositoryContext` shape.
- No business module in `functions/_lib/modules/*` changes its repository call shape.

`assertRepository()` is run against **both** adapters in tests; a failure blocks the build.

---

## 2. What IS added (additive only)

### 2.1 `ENTITY` constants (same file, additive keys)
Add new entity keys so services can address new tables via the unchanged methods:
```
SESSIONS, TREASURIES, ATTACHMENTS, NOTIFICATIONS,
APPROVALS, SECURITY_EVENTS, BACKUPS, AUDIT_CHAIN (view over audit_logs)
```
No existing key is removed or renamed. Infrastructure-only sheets (`processed_requests`, `settings`, indexes) stay internal as in Phase 1.

### 2.2 New service actions via the existing `repo.call()` escape hatch
Phase 1 already has `Repository.call(action, entity, payload)` (`functions/_lib/repository.js:56-58`) used for `auth.login`, `bootstrap`, `ping`, etc. Phase 2 reuses it — no new interface method:

| Action | Purpose |
|---|---|
| `audit.verify`, `audit.chainStatus` | hash-chain verification |
| `session.create`, `session.rotate`, `session.revoke`, `session.list` | session lifecycle (edge may also write `sessions` directly with `insert/update`) |
| `auth.mfa.enroll`, `auth.mfa.verify`, `auth.mfa.disable` | MFA |
| `treasury.*` | treasury CRUD via `list/get/insert/update` |
| `notification.list`, `notification.read`, `notification.readAll` | in-app notifications |
| `attachment.insert`, `attachment.delete` | metadata after R2 I/O |
| `approval.list`, `approval.decide`, `approval.gate` | approval workflow |
| `report.aging`, `report.collectorPerformance`, `report.treasuryReconciliation`, `report.auditExceptions`, `report.kpis` | aggregates (also expressible via `aggregate(name, params)`) |
| `migration.run`, `migration.verify` | migration runner |
| `backup.start`, `backup.metadata` | backups |

Each is a new `case` in `apps-script/router.gs:167-215` and a new `serviceAction`/aggregate branch — the same extension mechanism Phase 1 uses.

### 2.3 Repository adapter factory (edge)
`functions/_lib/repository.js` gains a selection function:

```js
export function createRepository(env, ctx) {
  // default remains the Phase 1 GAS adapter
  return env.REPOSITORY_ADAPTER === 'd1'
    ? assertRepository(new D1RepositoryAdapter(env.DB, ctx))
    : assertRepository(new Repository(env, ctx)); // unchanged Phase 1 class
}
```
Default `REPOSITORY_ADAPTER = 'sheets'`. No caller changes; all existing modules keep importing the same interface.

---

## 3. D1RepositoryAdapter (Step 10 — adapter layer only)

New file `functions/_lib/d1-repository-adapter.js`. It implements the **same 8 methods** against a D1 binding (`env.DB`) using `migrations/d1/0001_init.sql` as the schema reference. It is **never activated** in this phase.

| Method | D1 implementation sketch |
|---|---|
| `list(entity, query, options)` | Build `SELECT * FROM <table>` from a whitelist derived from `ENTITY`; translate `query` keys to `WHERE` with bound parameters; apply `orderBy`, `limit`, `offset`; return `{ok:true, data:rows, meta:{}}` |
| `get(entity, id)` | `SELECT * FROM <table> WHERE <pk> = ?`, `NOT_FOUND` when empty, `meta.version = row.version` |
| `insert(entity, data)` | Generate id/version/timestamps same as `SheetsAdapter.insertRow`; `INSERT INTO …` bound; return row |
| `update(entity, id, patch, expectedVersion)` | Optimistic lock `WHERE <pk> = ? AND version = ?`; bump version; 0 rows → `CONFLICT_VERSION` |
| `transition(entity, id, toStatus, payload)` | Reuse the shared state-machine table (mirrored constant) inside a D1 batch; write movement/ledger side effects |
| `aggregate(name, params)` | One SQL query per named aggregate (aging, collector performance, etc.), returning the same shapes as `Router.aggregate()` |
| `appendLedger(entry)` | `INSERT INTO custody_ledger …` (append-only) |
| `withTransaction()` | `D1 batch()` wrapper exposing the same fluent `insert/update/transition/appendLedger/call + commit` API; `call` forwards to the GAS adapter for service actions not yet ported |

Contract tests: `tests/repository.contract.test.js` is extended to instantiate both adapters and assert all 8 methods exist and return the canonical result shape (D1 tested against a local/miniflare D1, no remote binding).

---

## 4. `SheetsAdapter` changes that are NOT interface changes

These are internal to the only `SpreadsheetApp` layer:

- `getRegistry()` understands the extended registry shape (`workbooks` + `entities`).
- `getSheet(entity)` resolves `workbookId` from the registry and opens the correct workbook (workbook-object cache added).
- `createSheet(entity)` creates in the resolved workbook; `ensureAllSheets()` iterates new `TABLES` entries.
- All new tables are reached through the existing `readRows/insertRow/updateRow/findRow/…` helpers — no new adapter method signatures.

---

## 5. Verification

- `npm test` includes `assertRepository` checks for both adapters.
- A contract conformance matrix (same inputs → same result shape) is run for a representative entity on both adapters in local tests.
- No production request uses the D1 adapter in Phase 2; `REPOSITORY_ADAPTER` is absent/`sheets` in deployed vars.
