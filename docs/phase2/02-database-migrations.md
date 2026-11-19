# Phase 2 — Database Migrations (Design)

**Status:** Approved. Executable, idempotent M001-M011 scripts are in `apps-script/migrations/`; production application pending approval.

> **Rollout update:** R2 is skipped. M005 and M009 still create additive sheet
> schemas for reference, but no R2 object is written and no backup lifecycle is
> active. Take the pre-migration workbook copy via Google Workspace version
> history / manual export, not R2.

---

## 1. Migration rules (non-negotiable)

1. **Additive only.** Never reorder, rename, or remove an existing column. New columns are **appended to the end** of a table's `columns` array because `sheets-adapter.gs:133-142` only rewrites headers — inserting a column in the middle would misalign all existing row data.
2. **Idempotent + re-runnable.** Every migration checks its own ledger entry in `tbl_settings` (`migration_ledger`) and skips completed work; partial runs resume safely.
3. **No destructive rollback.** Rollback = flip a feature flag in `tbl_settings`; data is never deleted to "undo" a migration.
4. **Migration before code.** A migration and its `verify()` must pass before the code that depends on it is enabled.
5. **Backup before migration.** M001 is preceded by a one-off manual export of the production workbook to R2 (the R2 backup service from Step 12 is used if available, otherwise a manual copy).
6. **Single writer.** All migrations run through the Apps Script Router with an ADMIN/system actor inside the existing `LockService` transaction (same pattern as `Bootstrap.run()`).
7. **No change to `shared/contracts/repository.js` method contract** (see deliverable 6).

**Migration runner:** new `migrations/apps-script/migration-runner.gs` exposing `run(ctx, {only})` and `verify(ctx, {only})`; invoked via new service actions `migration.run` / `migration.verify` (ADMIN only). Ledger row: `migration_ledger` → `{applied: [{id, at, checksum}], failed: [...]}`.

---

## 2. Migration manifest

| ID | Step | Target | Change | Flag gating dependant code |
|---|---|---|---|---|
| M001 | 1 | `tbl_audit_logs` | Append `audit_hash`, `previous_hash`; backfill chain; seed tip | `audit.chainEnabled` |
| M002 | 2 | new `tbl_sessions` | Create session store | `auth.refreshEnabled` |
| M003 | 3 | `tbl_users` | Append `mfa_enabled`, `mfa_secret` | `auth.mfa.enforce` |
| M004 | 4 | new `tbl_treasuries` + 5 doc tables | Create treasury master; append `treasury_id`; backfill from text | `treasury.enforce` |
| M005 | 6 | new `tbl_attachments` | Create attachment metadata table | — |
| M006 | 5 | new `tbl_notifications` | Create in-app notification table | `notifications.enabled` |
| M007 | 7 | new `tbl_approvals` | Create approval table | `approvals.enabled` |
| M008 | 11 | new `tbl_security_events` | Create append-only security event log; protect sheet | — |
| M009 | 12 | new `tbl_backups` | Create backup ledger | — |
| M010 | 9 | `tbl_settings.sheet_registry` | Extend registry with `workbooks` map + per-entity workbook | `registry.splitEnabled` |
| M011 | all | `tbl_settings`, `tbl_permissions`, `tbl_role_permissions` | Seed policy flags + new permissions/grants | individual flags |
| M012 | 10 | `migrations/d1/0001_init.sql` | D1 schema file only — **not executed, no binding** | `repository.adapter=sheets` (unchanged) |

Execution order at deployment: M011 (flags/permissions) → M001 → M002 → M003 → M004 → M006 → M005 → M007 → M008 → M009 → M010. M010 is last so all new tables exist in CORE before any cutover.

---

## 3. Detailed migration specifications

### M001 — Audit hash chain

**Schema append** to `TABLES.audit_logs.columns` (end of array, after `result`):

```
..., 'result', 'audit_hash', 'previous_hash'
```

**Backfill algorithm** (runs once, inside the Router lock):
1. Read all audit rows in physical row order (`readRows('audit_logs')` preserves sheet order).
2. `prev = SETTINGS.audit_chain_genesis` (64-char constant, e.g. `'0'.repeat(64)`), stored in `tbl_settings`.
3. For each row: `audit_hash = SHA256(asciiJson(canonical(row without audit_hash) + previous_hash: prev))`; set `previous_hash = prev`; write the row back by `_row` via `writeRowByNumber` (allowed for a migration even though the table is appendOnly at the service layer); `prev = audit_hash`.
4. Store `audit_chain_tip = prev` in `tbl_settings`.
5. Append a `MIGRATION` audit row — which itself gets a hash — so the chain continues seamlessly.

**Canonical payload** (fixed key order, ASCII-escaped JSON — same convention as HMAC `asciiJson`):
```
v|audit_id|request_id|user_id|operation|entity_type|entity_id|old_value|new_value|changed_fields|timestamp|ip_address|result|previous_hash
```
Hash = `Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)` → lowercase hex.

**verify():** recompute every hash; assert `row[i].previous_hash === (i===0 ? genesis : row[i-1].audit_hash)`; assert final hash equals stored `audit_chain_tip`. Report `HASH_MISMATCH`, `CHAIN_BROKEN`, `DELETED_ENTRIES_SUSPECTED`, `TIP_MISMATCH` with the offending `audit_id`.

### M002 — `tbl_sessions`

```
session_id, user_id, refresh_token_hash, device_info, ip_address,
created_at, expires_at, revoked_at
```
Options: `{ id: 'session_id', unique: ['session_id'] }`. Add to `PROTECTED_SHEETS`? No — sessions are written by the service; protect against manual edit only (add to protection list without preventing script writes — `protect()` blocks manual edits only). Session rows are compact and indexed by `session_id`. Verify: sheet exists with exact headers.

### M003 — MFA columns

Append to `TABLES.users.columns` **after** `STANDARD_SOFT`:
```
..., 'deleted_by', 'mfa_enabled', 'mfa_secret'
```
Backfill: set `mfa_enabled = false` and `mfa_secret = ''` for rows where blank. Existing password hashes and credentials are never touched. Verify: existing users' `user_id`, `username`, `password_hash`, `role_id` unchanged (snapshot before/after).

### M004 — Treasury management

**New master** `tbl_treasuries`:
```
treasury_id, treasury_name, treasury_type, warehouse, status
```
Options `{ unique: ['treasury_id'] }`, validation `treasury_type: ['BRANCH','HQ']`, `status: ['ACTIVE','INACTIVE']`.

**Append `treasury_id` (one column, at end)** to: `deposits_branch`, `deposits_hq`, `cheques`, `guarantees`, `movements`.

**Seed from existing text values** (no data loss):
- `HQ_TREASURY` → `TR_HQ`, name "HQ Treasury", type `HQ`, warehouse `''`.
- `BRANCH_TREASURY` → `TR_BRANCH`, type `BRANCH`.
- Each distinct non-blank `warehouse` value on cheques/guarantees/receipts → `TR_BR_<slug>`, type `BRANCH`, warehouse = that value.
- `BANK`, `LEGAL`, `WAREHOUSE`, `COLLECTOR` remain as **custody holder types** (not treasuries) and keep their text columns.

**Backfill:** map each document's legacy text holder/location to the seeded `treasury_id`; where ambiguous, leave `treasury_id` blank and let readers fall back to text. Dual-write begins after migration.

### M005 — `tbl_attachments`

```
attachment_id, entity_type, entity_id, file_name, r2_key,
uploaded_by, uploaded_at
```
Options `{ id: 'attachment_id', unique: ['attachment_id'] }`. Validation `entity_type: ['CHEQUE','GUARANTEE','DEPOSIT']`. The R2 object is written first; metadata insert happens only after a successful R2 put (orphan objects are cleaned by a lifecycle rule).

### M006 — `tbl_notifications`

```
notification_id, user_id, notification_type, entity_type, entity_id,
title, body, channel, status, created_at, read_at, delivery_status
```
Validations: `notification_type: ['GUARANTEE_EXPIRY','CHEQUE_OVERDUE','CUSTODY_VARIANCE','FAILED_RECONCILIATION']`; `channel: ['IN_APP','EMAIL','SMS']`; `status: ['UNREAD','READ','ARCHIVED']`; `delivery_status: ['N/A','PENDING','SENT','FAILED']`. Only `IN_APP` is delivered now; EMAIL/SMS rows are future-ready.

### M007 — `tbl_approvals`

```
approval_id, entity_type, entity_id, action, requested_by, requested_at,
status, approver_id, decided_at, decision_notes, expires_at
```
Validations: `entity_type: ['HQ_DEPOSIT','CHEQUE_STATUS_CHANGE','GUARANTEE_RELEASE']`; `status: ['PENDING_APPROVAL','APPROVED','REJECTED']`. One open approval per `(entity_type, entity_id, action)` enforced in the service (not a sheet constraint).

### M008 — `tbl_security_events`

```
event_id, event_type, user_id, ip_address, request_id,
details_json, severity, created_at
```
Options `{ appendOnly: true }`; add `tbl_security_events` to `PROTECTED_SHEETS`. Event types: `AUDIT_VERIFY_FAILED`, `TOKEN_REUSE_DETECTED`, `SESSION_REVOKED`, `MFA_CHALLENGE_FAILED`, `ACCOUNT_LOCKED`, `RATE_LIMITED`, `JWT_REVOKED`, `BACKUP_FAILED`. Kept separate from `tbl_audit_logs` so verification does not extend the audited chain.

### M009 — `tbl_backups`

```
backup_id, scope, workbook_ids, r2_key, size_bytes, checksum,
status, started_at, completed_at, retention_until
```
Validation `status: ['RUNNING','COMPLETED','FAILED']`. `retention_until = started_at + 90 days`; R2 lifecycle enforces physical deletion.

### M010 — Workbook registry migration

1. Extend the `sheet_registry` setting value:
```
{
  workbooks: {
    CORE: <CONFIG.spreadsheetId>,
    DOCS: <DOCS_SPREADSHEET_ID>,
    AUDIT: <AUDIT_SPREADSHEET_ID>
  },
  entities: { <entity>: { sheet: <name>, workbookId: <id>, workbook: 'CORE'|'DOCS'|'AUDIT' } }
}
```
2. New Script Properties: `CORE_SPREADSHEET_ID` (falls back to `SPREADSHEET_ID`), `DOCS_SPREADSHEET_ID`, `AUDIT_SPREADSHEET_ID`. If DOCS/AUDIT are unset, they fall back to CORE → **Phase 1 behaviour unchanged**.
3. Grouping: **AUDIT** = `audit_logs`, `security_events`, `backups`; **DOCS** = `cheques`, `guarantees`, `deposits_branch`, `deposits_hq`, `deposit_lines`, `attachments`, `movements`; **CORE** = everything else (identity, books/receipts/collections, custody, alerts, indexes, settings, sessions, treasuries, notifications, approvals).
4. `getSheet(entity)` must open `workbooks[entry.workbook]` (with a workbook-object cache) — **business services are untouched**.
5. Cutover is a separate manual run: copy each target sheet (values + headers) to the new workbook, compare row counts and checksums, then flip `registry.splitEnabled = true`. Until then every entity still points at CORE.

### M011 — Permissions, roles and policy settings

Additive permissions (mirrored in `shared/constants/enums.js` and `apps-script/constants.gs`, seeded into `tbl_permissions`/`tbl_role_permissions` by re-running bootstrap):
```
audit.verify, sessions.read, sessions.revoke, mfa.manage,
treasuries.read, treasuries.manage,
attachments.read, attachments.create, attachments.delete,
notifications.read, notifications.manage,
approvals.read, approvals.decide,
reports.advanced.read, backups.read, backups.create, security.read, migration.run
```

Policy rows in `tbl_settings`:
| Key | Default | Purpose |
|---|---|---|
| `audit.chainEnabled` | `true` after M001 | hash writing/verification on |
| `auth.refreshEnabled` | `false` | enable refresh/session endpoints |
| `auth.mfa.enforce` | `false` | require MFA for configured roles |
| `auth.mfa.requiredRoles` | `["ADMIN","TREASURY"]` | roles subject to enforcement |
| `treasury.enforce` | `false` | require `treasury_id` on new docs |
| `notifications.enabled` | `true` | create in-app notifications from alerts |
| `approvals.enabled` | `false` | approval gates block transitions |
| `registry.splitEnabled` | `false` | multi-workbook resolution active |
| `security.perIpLimit` / `security.perUserLimit` | `120`/`300` per minute | layered rate limits |

### M012 — D1 schema (file only, inactive)

`migrations/d1/0001_init.sql` will contain DDL for all 21 operational entities plus the 8 new tables, with `PRIMARY KEY`, `UNIQUE`, and index statements mirroring `TABLES` metadata. It is **not applied**; no `[[d1_databases]]` binding is added to `wrangler.toml` in this step. The D1 adapter (Step 10) is verified against this schema using a local D1 database only.

---

## 4. Verification gate (must pass before dependent code)

1. `migration.verify(ctx, {only: <id>})` returns `{ok:true}` for every applied migration.
2. `npm test` remains 13/13 green, plus new migration contract tests.
3. Phase 1 smoke set remains green after each migration (health, auth/me, dashboard, customer autocomplete/search, `customers/CUST020208`, tracking).
4. Row counts of all 27 Phase 1 sheets are unchanged after M001–M004 (only appended columns/backfills).
5. After M010, every entity resolves to the CORE workbook until an explicit cutover.
