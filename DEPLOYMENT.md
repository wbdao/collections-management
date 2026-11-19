# Deployment & Production Test Guide — Collections Management System (Phase 1 + Phase 2)

> **Status:** Phase 1 is live and verified (§13). Phase 2 Steps 1–12 are
> implemented and validated locally but **not deployed** — see §14 for the
> Phase 2 configuration, migration, operations and explicit approval gate.

> Audit baseline: local checkout at `D:\Collecting`, corresponding to
> `https://github.com/wbdao/collections-management.git`.
> Git/network access was unavailable in the audit environment, so the clone
> could not be re-fetched; the audit was performed against the identical local
> working tree. All changes described as "fixed" are already applied there.

---

## 1. Repository Structure Report

```
D:\Collecting
├── .dev.vars.example              # CF local secret template (edge secrets only)
├── .gitignore                     # node_modules, .dev.vars, dist, logs
├── .github/workflows/deploy.yml   # CI test + Cloudflare Pages deploy (ADDED)
├── package.json                   # dev/deploy/test scripts, wrangler ^3.60
├── wrangler.toml                  # Pages project, KV bindings (IDs are placeholders)
├── README.md                      # Architecture + quick start
├── DEPLOYMENT.md                  # This document (ADDED)
├── apps-script/                   # Google Apps Script backend
│   ├── appsscript.json            # V8 runtime, Web App, OAuth scopes
│   ├── Code.gs                    # doGet/doPost, HMAC verification
│   ├── config.gs                  # Script Properties + defaults
│   ├── constants.gs               # enums, permissions, state machines (mirror)
│   ├── router.gs                  # action dispatch + LockService transaction
│   ├── bootstrap.gs               # creates 27 sheets, seeds roles/permissions/admin
│   ├── triggers.gs                # daily 01:00 UTC alert scan
│   ├── data/tables.gs             # 27 sheet definitions + validation catalog
│   ├── repository/sheets-adapter.gs  # ONLY file allowed to use SpreadsheetApp
│   ├── services/                  # 15 domain services (business logic)
│   └── utils/                     # errors, helpers, response
├── functions/                     # Cloudflare Pages Functions (edge)
│   ├── api/_middleware.js         # auth, CSRF, rate limit, request context
│   ├── api/[[path]].js            # REST router (v1 prefix normalized)
│   └── _lib/                      # auth(JWT), rbac, scope, cache, idempotency,
│                                  # gas-client(HMAC), repository, 17 modules
├── frontend/                      # Static SPA (served as Pages output)
│   ├── index.html
│   ├── css/                       # base, layout, components
│   └── js/                        # app, router, store, api client, components, pages
├── shared/                        # Cross-runtime contracts
│   ├── contracts/repository.js    # 8-method repository interface
│   ├── constants/enums.js         # approved enums/permissions/state machines
│   └── schemas/index.js           # request validation rules
├── tests/                         # node:test suites (ADDED — was empty)
│   ├── repository.contract.test.js
│   ├── schemas.test.js
│   ├── constants.test.js
│   └── scope.test.js
└── migrations/d1/                 # Future D1 schema (inactive)
```

**Layer rule:** `frontend → functions → repository → Apps Script adapter → Sheets`.
Business services never call `SpreadsheetApp`; verified only
`apps-script/repository/sheets-adapter.gs` does.

---

## 2. Deployment Readiness Report

| Area | Status | Notes |
|---|---|---|
| Repository pattern | READY | 8 methods, `assertRepository` enforced |
| Sheets adapter / bootstrap | READY | 27 sheets verified, re-runnable, protected sheets |
| Auth (RS256 JWT, 8h) | READY | Key pair must be generated and stored as secrets |
| RBAC / scope | READY (fixed) | Scope row-shape bug fixed; assign scope rows after bootstrap |
| Customer master | READY | Dynamic header mapping, 5-min cache, `CUSTOMER_NOT_FOUND` |
| Document services | READY | Receipt/collection/cheque/guarantee validate `Account` |
| Tracking / reports | READY | Customer block + Warehouse Group/Customer group reports |
| Frontend SPA | READY | Pages/static; no build step required |
| Static verification | PASS | 27/27 headers, 123 imports, 159 exports, bootstrap structure |
| Automated tests | READY (added) | `npm test` now has 4 suites |
| CI/CD workflow | READY (added) | `.github/workflows/deploy.yml` |
| Cloudflare config | **BLOCKED** | KV IDs are placeholders; secrets must be set |
| Apps Script config | **BLOCKED** | Script Properties not set; Web App not deployed |
| Customer master ID | **BLOCKED** | Not provided to the project |
| Bootstrap execution | **PENDING** | Must run once after deployment |
| Live HMAC round-trip | **PENDING** | Verify edge↔GAS signature compatibility |
| `package-lock.json` | MISSING | Created by `npm install` (not present in checkout) |

**Overall: not yet deployable.** All code-level blockers were fixed during the
audit; remaining blockers are configuration/deployment credentials.

### Fixes applied during this audit

| # | Issue | File | Fix |
|---|---|---|---|
| 1 | `batch` schema required removed `warehouse_id` → all batch creation would 400 | `shared/schemas/index.js` | Removed field |
| 2 | `collect` schema required legacy `customer_id`; service expects `account` | `shared/schemas/index.js` | Changed to `account` (required) |
| 3 | `cheque`/`guarantee` schemas had stale `customer_id` | `shared/schemas/index.js` | Changed to required `account` |
| 4 | `book`/`customer` schemas stale | `shared/schemas/index.js` | Cleaned to master-based shape |
| 5 | `assertScope()` checked camelCase keys against snake_case rows → single-record scope checks were a no-op | `functions/_lib/scope.js` | Accept `warehouse`, `warehouse_id`, `collector_id`, `current_holder_id` |
| 6 | Login rate limit keyed on shared `anonymous` actor → global 10-attempt bucket (login DoS) | `functions/_lib/ratelimit.js` | Key login limit on source IP |
| 7 | `tests/` empty while `npm test` referenced it | `package.json`, `tests/` | Added 4 suites, simplified script |
| 8 | No CI/CD workflow | `.github/workflows/deploy.yml` | Added |
| 9 | `.dev.vars.example` listed unused `SPREADSHEET_ID` | `.dev.vars.example` | Replaced with Apps Script property guidance |

---

## 3. Missing Environment Variables

### Cloudflare Pages (secrets — set via `wrangler pages secret put` or dashboard)

| Name | Purpose | Status |
|---|---|---|
| `GAS_URL` | Apps Script Web App `/exec` URL | **MISSING** |
| `GAS_SHARED_SECRET` | HMAC secret for edge→GAS requests | **MISSING** |
| `JWT_PRIVATE_KEY` | RS256 signing key (PKCS#8 PEM, literal `\n`) | **MISSING** |
| `JWT_PUBLIC_KEY` | RS256 verification key (SPKI PEM, literal `\n`) | **MISSING** |
| `JWT_ISSUER` | Expected `iss` claim (default `cms-api`) | Optional (default works) |
| `JWT_AUDIENCE` | Expected `aud` claim (default `cms-web`) | Optional (default works) |
| `BOOTSTRAP_TOKEN` | One-time bootstrap header token | **MISSING** |

`BACKUP_SERVICE_TOKEN` and `BACKUP_SIGNING_KEY` are **not used** — R2 is skipped. They may already exist in Cloudflare but are ignored by this rollout.

### Cloudflare bindings / vars

| Name | Purpose | Status |
|---|---|---|
| `KV` | Cache, rate limit, idempotency | Binding exists; production IDs configured in `wrangler.toml` |
| `ENVIRONMENT`, `API_BASE`, `REPOSITORY_ADAPTER`, `CACHE_TTL_SECONDS` | Non-sensitive vars | Present in `wrangler.toml` (`REPOSITORY_ADAPTER = sheets`) |
| ~~`ATTACHMENTS_BUCKET`, `BACKUPS_BUCKET`~~ | ~~Phase 2: private R2 bindings~~ | **Removed** — R2 skipped; Google Sheets is the only store |

> Note: `SPREADSHEET_ID` is **not** a Cloudflare variable. It is an Apps Script
> Script Property (see §4).

---

## 4. Required Apps Script Properties

Set under **Project Settings → Script Properties**:

| Property | Required | Value / default |
|---|---|---|
| `GAS_SHARED_SECRET` | **YES** | Must byte-match Cloudflare `GAS_SHARED_SECRET` |
| `CUSTOMER_MASTER_SPREADSHEET_ID` | **YES** (customer features) | ID of the daily-updated customer workbook — **not yet provided** |
| `CUSTOMER_MASTER_SHEET_NAME` | No | `قاعده عملاء الشركه` (default) |
| `SPREADSHEET_ID` | No | Defaults to `12GyVXdmKlIZUy6evNhQK2IKJjZ8olWtEn6WxuPSunLI` |
| `BOOTSTRAP_ADMIN_PASSWORD` | **YES in production** | Default `Admin@12345` — **must be changed** |

OAuth scopes in `appsscript.json`: spreadsheets, external_request, script.scriptapp.
If the workbooks live in a Shared Drive, add
`https://www.googleapis.com/auth/drive`.

---

## 5. Required Cloudflare Secrets

Generate values:

```powershell
# random 48-byte secrets (PowerShell)
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }) -as [byte[]])

# RSA key pair (OpenSSL)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_private.pem
openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem
```

Set them:

```powershell
wrangler pages secret put GAS_URL
wrangler pages secret put GAS_SHARED_SECRET
wrangler pages secret put JWT_PRIVATE_KEY   # paste PEM with literal \n
wrangler pages secret put JWT_PUBLIC_KEY
wrangler pages secret put JWT_ISSUER
wrangler pages secret put JWT_AUDIENCE
wrangler pages secret put BOOTSTRAP_TOKEN
```

The same `GAS_SHARED_SECRET` value must be stored as an Apps Script Script
Property. Keep JWT issuer/audience consistent between token issue and verify
(defaults are fine if you do not set them).

---

## 6. Google Sheets Initialization Checklist

Operational workbook (existing, do **not** create/rename):
`12GyVXdmKlIZUy6evNhQK2IKJjZ8olWtEn6WxuPSunLI`

- [ ] Service account / deploying user has **edit** access to the operational workbook.
- [ ] Deploying user has at least **view** access to the customer master workbook.
- [ ] `SPREADSHEET_ID` Script Property set (or default confirmed).
- [ ] `CUSTOMER_MASTER_SPREADSHEET_ID` Script Property set.
- [ ] `CUSTOMER_MASTER_SHEET_NAME` confirmed: `قاعده عملاء الشركه`.
- [ ] Customer master header row contains exactly these texts (order may vary, resolution is by header text):
      `Account`, `Name`, `Warehouse Group`, `Customer group`, `Eligible credit limit`,
      `Credit limit`, `Balance`, `Payment schedule`, `Worker`, `Worker Name`,
      `Company chain`, `Segment`, `ID number`, `Telephone`, `Account status`, `الاسم الموحد`.
- [ ] `Account` values are unique and non-blank.
- [ ] Bootstrap executed (§10); response reports 27 sheets.
- [ ] Verify exactly 27 sheets/headers; no `tbl_customers`, `tbl_warehouses`,
      `tbl_departments`, `tbl_branches`, `tbl_locations`, or customer history sheets.
- [ ] Protected sheets: `tbl_audit_logs`, `idx_tracking`, `idx_id_map`, `tbl_sequences`.
- [ ] Default roles/permissions seeded; `admin` user present.
- [ ] Change the default admin password in `tbl_users` (or set
      `BOOTSTRAP_ADMIN_PASSWORD` **before** first bootstrap, then remove it).
- [ ] Populate `tbl_user_scopes` for BRANCH_MANAGER/TREASURY/COLLECTOR users —
      no scopes are seeded, so unscoped users currently see all records.
- [ ] Install the daily alert-scan trigger (§7).

---

## 7. Apps Script Deployment Instructions

1. Open the Apps Script project linked to the operational workbook (or create a
   standalone project and paste all files from `apps-script/`).
2. Replace `appsscript.json` with the repository version. Runtime: V8.
3. Set Script Properties per §4. **Use a strong `BOOTSTRAP_ADMIN_PASSWORD`.**
4. Save all files. Run `installDailyScanTrigger()` once from the editor
   (authorizes the `script.scriptapp` scope) — confirm "installed: true".
5. Optional smoke test from the editor:
   `Logger.log(JSON.stringify(CustomerMasterService.searchCustomers({ query: 'a', limit: 5 })));`
   Expected: an `items` array, or `CUSTOMER_MASTER_*` error if misconfigured.
6. Deploy → **New deployment** → Web app:
   - Execute as: **Me**
   - Who has access: **Anyone**
     (required so Cloudflare can call it; every request is HMAC-signed and
     rejected if the signature does not match).
7. Copy the `/exec` URL into Cloudflare secret `GAS_URL`.
8. Verify public health: `GET <GAS_URL>` returns JSON with
   `protocol: "cms-repo/v1", ok: true`.
9. Redeploy (`Manage deployments → Edit → New version`) after **every** Apps
   Script code change; the `/exec` URL stays the same for subsequent versions.

---

## 8. Cloudflare Pages Deployment Instructions

### Option A — local

```powershell
npm install
# create KV namespaces and paste IDs into wrangler.toml
wrangler kv namespace create CMS_KV
wrangler kv namespace create CMS_KV --preview
# set secrets per §5
npm test
npm run deploy
```

### Option B — GitHub Actions (recommended)

The workflow `.github/workflows/deploy.yml` runs `npm test` on PRs and pushes,
then deploys on push to `main`. Configure repository Variables and Secrets (§9).

### Verify after deploy

```powershell
curl https://<project>.pages.dev/api/health
curl https://<project>.pages.dev/api/v1/ping
```

Both should return `ok: true` (ping requires a valid JWT unless the middleware
is adjusted — use a logged-in session for `ping`).

---

## 9. GitHub Integration Instructions

1. Push the working tree to `main` on `wbdao/collections-management`.
   (`git` was unavailable in the audit environment; perform this from a machine
   with Git installed.)
2. Repository **Variables** (Settings → Variables and secrets → Variables):
   - `KV_NAMESPACE_ID` — production KV namespace ID
   - `PREVIEW_KV_NAMESPACE_ID` — preview KV namespace ID
3. Repository **Secrets**:
   - `CLOUDFLARE_API_TOKEN` (Pages:Edit + Account:Read)
   - `CLOUDFLARE_ACCOUNT_ID`
   - `GAS_URL`, `GAS_SHARED_SECRET`
   - `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`
   - `BOOTSTRAP_TOKEN`
4. The workflow substitutes KV IDs into `wrangler.toml` and fails fast if
   placeholders or required secrets are missing.
5. PRs run tests only; merges to `main` run tests then deploy.

---

## 10. Bootstrap Execution Instructions

Bootstrap is idempotent: it creates missing sheets/headers, seeds missing roles,
permissions and the admin user, and writes `sheet_registry` to `tbl_settings`.

```powershell
curl -X POST "https://<project>.pages.dev/api/v1/admin/bootstrap" `
  -H "X-Bootstrap-Token: <BOOTSTRAP_TOKEN>" `
  -H "Content-Type: application/json" -d "{}"
```

Expected (counts vary on re-run):

```json
{
  "ok": true,
  "data": { "sheets": 27, "protectedSheets": 4, "roles": 5,
            "permissionsAndGrants": 120, "admin": 1 },
  "meta": { "requestId": "..." }
}
```

- Wrong/missing token → `401 UNAUTHORIZED`.
- Re-running is safe; `admin` and `roles` counts drop to 0 on subsequent runs.
- Bootstrap must run **after** the Web App is deployed and secrets are set.

---

## 11. Customer Master Connectivity Validation

1. Confirm Script Properties `CUSTOMER_MASTER_SPREADSHEET_ID` and (optionally)
   `CUSTOMER_MASTER_SHEET_NAME` are set.
2. From a logged-in session:
   ```powershell
   curl "https://<project>.pages.dev/api/v1/customers/autocomplete?q=123&limit=5" `
     -H "Authorization: Bearer <JWT>"
   ```
   Expected: `{ "ok": true, "data": { "items": [ ... ] } }` with each item
   containing `account`, `customer_name`, `warehouse`, `department`,
   `account_status`, `unifiedName`, `phone`, `national_id`
   (`customer_status`/`accountStatus` are kept as backward-compatible aliases).
3. Lookup: `GET /api/v1/customers/12345` → full normalized customer.
   Unknown account → `404 CUSTOMER_NOT_FOUND`.
4. Warehouse/department helpers:
   `GET /api/v1/customers/12345/warehouse`, `.../department`.
5. Verify the 5-minute cache: key `customer:{Account}` in Apps Script CacheService.
6. Verify autocomplete matches `Account`, `Name`, and `الاسم الموحد`.
7. Create a receipt/cheque/guarantee with a valid `account`: fields are populated.
   Repeat with an unknown account → `CUSTOMER_NOT_FOUND`.
8. Tracking search for that document shows Account, Name, Warehouse Group,
   Customer group, and Account status.
9. `GET /api/v1/reports/by-warehouse` and `/by-department` group by the
   denormalized `warehouse` / `department` values.

---

## 12. Security Validation

| Check | How | Expected |
|---|---|---|
| HMAC edge↔GAS | Send a request with a tampered `X-Signature` directly to GAS | `401 UNAUTHORIZED` |
| Web App exposure | `GET <GAS_URL>/exec` without signature | Health JSON only; no data |
| JWT algorithm | Signed token with `alg: none`/HS256 | `401` (RS256 enforced) |
| JWT expiry/issuer/audience | Expired or wrong claims | `401` |
| Login brute force | >10 logins/minute from one IP | `429 RATE_LIMITED` per IP (fixed) |
| CSRF | Cross-site POST with `Sec-Fetch-Site: cross-site` | `403 CSRF_REJECTED` |
| RBAC | Collector calls `/admin/users` | `403 FORBIDDEN` |
| Scope on get | Scoped manager fetches a document in another Warehouse Group | `403 FORBIDDEN` (fixed) |
| Scope on list | Scoped manager lists documents → only own Warehouse Group | Filtered by `warehouse` |
| Scope assignment | Users with no `tbl_user_scopes` rows | See all data — **populate scopes** |
| Customer master read-only | POST/PUT `/customers` | `404` (routes removed) |
| Bootstrap protection | POST bootstrap without token | `401 UNAUTHORIZED` |
| Audit log | Any mutation | Row appended to `tbl_audit_logs` |
| Default admin password | Try `Admin@12345` | **Must fail** — change before prod |
| CORS | Wildcard `Access-Control-Allow-Origin` | Acceptable: auth header required; frontend uses `same-origin` |
| Password KDF | Custom PBKDF2-HMAC-SHA256, 2000 iterations | Works, but below modern guidance — plan upgrade |
| Token revocation | Phase 1: 8h lifetime, rotate keys to revoke globally. Phase 2 (pending deploy): 15m access token + refresh/session revocation | Verify `TOKEN_REVOKED`, `REFRESH_INVALID`, `REFRESH_REUSE` after Phase 2 deploy |

### Residual risks / follow-ups (not Phase 1 blockers)

- Consider raising PBKDF2 iterations and migrating to a standard library KDF.
- Consider restricting CORS `Allow-Origin` to the Pages domain.
- Consider adding scope checks to mutation service actions (currently enforced
  mainly on list/get paths).
- Generate `package-lock.json` via `npm install` and commit it for reproducible CI.

---

## 13. Production deployment & verification log (2026-11-18)

### Live deployment

| Item | Value |
|---|---|
| Cloudflare Pages project | `collections-management` |
| API base | `https://collections-management.pages.dev/api/v1` |
| Health | `https://collections-management.pages.dev/api/health` → 200 |
| Apps Script Web App (production) | deployment `@17`, `AKfycbxythKpR19EZt2deIdK4r6aahN__hRy19-CezsY5ukmcmr1gRWe8cQne2jee3LDExc` |
| Web App access | **Anyone** (`أي شخص`), execute as Me — set from the Apps Script UI |
| Operational workbook | `12GyVXdmKlIZUy6evNhQK2IKJjZ8olWtEn6WxuPSunLI` |
| Customer master workbook | `1U5mxsJIKZ_eVMlEgSZQBuBNJUEH7zX4Z`, sheet `قاعده عملاء الشركه` (5,914 rows, read live) |
| Production KV | `fb65d7933b724884a1740133c824b026` |
| CI | GitHub Actions auto-deploy on push to `main` (workflow `deploy.yml`) |

> Do **not** run `clasp deploy` against `@17`: it can reset Web App access to
> login-only. Create a new deployment from the Apps Script UI with access
> `أي شخص` if a new Apps Script version must go live, then update the
> `GAS_URL` GitHub Secret and rerun the deploy workflow.

### Bootstrap / auth

- Bootstrap on production succeeded:
  `{"sheets":27,"protectedSheets":4,"roles":0,"permissionsAndGrants":0,"admin":0}`
  (counts are 0 on re-run because the sheets/seeds already exist).
- Login with `admin` succeeded; RS256 8h token verified on `GET /auth/me`.
- `npm test`: **13 pass, 0 fail** (4 original suites + `gas-client.test.js`).

### Production fixes applied after the first deployment

| Commit | Issue | Fix |
|---|---|---|
| `4fbef14` | Dashboard returned 500. `cached()` wrote KV with `expirationTtl: 30`; Cloudflare requires ≥ 60s. | TTL raised to 60; all KV reads/writes wrapped so cache failures can never break a healthy response. |
| `182cb7c` | `customers/autocomplete` and `/search` always returned empty: edge expected a bare array but Apps Script returns `{ items: [...] }`. | Accept both response shapes. |
| `64e0132` | Arabic/Unicode search failed with `UNAUTHORIZED Invalid request signature`: Apps Script HMAC does not byte-match Workers' UTF-8 encoder for non-ASCII payloads. | Escape non-ASCII code units as `\uXXXX` before signing; `JSON.parse` restores original text. Regression test added. |
| `633d169` | `limit` was dropped by the Apps Script router, so autocomplete ignored it. | Enforce the requested limit at the edge (capped at 100). |

### Verified production results

- `GET /dashboard/summary`, `/dashboard/custody`, `/dashboard/structure` → 200;
  cache keys `cache:dashboard:summary` and `cache:dashboard:custody` are written.
- Full GET smoke sweep across all modules passed (transient `HTTP=000` results
  during rapid bursts succeeded on retry). `GET /admin/permissions` is 404 by
  design — that route does not exist.
- Customer master: `GET /customers/CUST020208` returns the mapped record
  (`warehouse: "56"`, `department: "Wsagent-E"`, Arabic name/phone/national id);
  `/warehouse` and `/department` return 200 with the same values.
- Autocomplete/search:
  - `?q=CUST0202&limit=3` → 3 items
  - `?q=CUST020208&limit=3` → 1 exact item
  - `?q=احمد&limit=3` and `?q=روان&limit=3` → 3 items each (Unicode fix)
  - unknown account → `404 CUSTOMER_NOT_FOUND`
- HMAC negative test directly against the production `/exec` endpoint:
  missing, empty and wrong `?signature=` values all return
  `UNAUTHORIZED Invalid request signature`; no data is disclosed.
- Apps Script HEAD was restored to clean repository code with `clasp push
  --force` after temporary diagnostics; production `@17` was never changed.

### Final operational state

- **Daily alert-scan trigger installed and verified.** The Triggers page shows
  exactly one trigger: `dailyScanTrigger`, time-based, daily at 01:00 UTC, on
  the main deployment. There is intentionally **no** customer-master scan
  trigger — the master is read live with a 5-minute CacheService TTL
  (`customer:{Account}`).
- **Temporary Apps Script deployments archived.** All temporary active
  deployments (`@9`, `@10`, `@12`, `@13`, `@15`, plus related untitled ones)
  were archived. Only deployment `@17` remains active, with public access
  `أي شخص`; its ID and URL are unchanged. No new `clasp deploy` was run.
- Mutation flows (create/transition/audit-log insertion) were intentionally
  **not** run against production, to avoid writing test records into the live
  business workbook. If required later, run them in a sandbox copy or with
  explicit approval, then inspect `tbl_audit_logs` /
  `tbl_integration_errors`.
- Final production recheck after the trigger/deployment cleanup: `health`,
  `auth/me`, `dashboard/summary`, `dashboard/custody`, both customer
  autocomplete variants and `customers/CUST020208` all returned 200;
  `track/BOOK/NO-SUCH` returned the expected 404.

---

## 14. Phase 2 — configuration, migration & operations (pending approval)

Nothing in this section is live. Phase 2 code is committed to the local working
tree only. **Do not** run `clasp push --force`, `clasp deploy`, or a Pages
production deploy until the user explicitly approves it.

When the Apps Script push is approved, run `clasp` **from `apps-script/`** so the
complete `apps-script/.clasp.json` push order is used (it includes
`services/backup-service.gs` and all Phase 2 services/migrations). The older
root `.clasp.json` has only the Phase 1 push order.

### 14.1 Additional configuration — Google Sheets only

**R2 is skipped.** Step 6 (attachments) and Step 12 (backups) are implemented
locally as dormant reference code, but:

- no `ATTACHMENTS_BUCKET` / `BACKUPS_BUCKET` bindings exist in `wrangler.toml`;
- no R2 buckets, versioning or lifecycle rules are created;
- `POST/GET /api/v1/attachments` and `POST/GET /api/v1/admin/backups` are **not
  mounted** and return `404 NOT_FOUND`;
- `BACKUP_SERVICE_TOKEN`, `BACKUP_SIGNING_KEY` and `BACKUP_EDGE_URL` are
  **not required** (including as Apps Script Script Properties);
- `installDailyBackupTrigger()` is inert and `dailyBackupTrigger()` is a no-op.

Install only `dailyScanTrigger` (01:00 UTC, already live in Phase 1). Do **not**
install `dailyBackupTrigger`.

No additional Cloudflare secrets or Apps Script properties are needed beyond
the Phase 1 set in §3 and §4.

### 14.2 Migration runbook (M001–M011)

Migrations are additive: new sheets plus columns **appended at the end** of
existing tables. There are no destructive column moves or deletes.

1. Take a one-off export/copy of the production workbook before M001.
2. Apply in this order: **M011** (flags/permissions) → **M008** (security events)
   + **M001** (audit chain) → **M002, M003, M004, M005, M006, M007, M009, M010**.
3. After each, call `migration.verify` and confirm `{ ok: true }`. Check
   `migration.status` for the full manifest. These are signed Apps Script
   router actions — there is no public REST route for them.
4. Backfill verification: audit hashes (`M001`), treasury FKs (`M004`) and
   registry placement (`M010`) must report zero unresolved rows before flags
   are enabled.

Default flag state after migration: `auth.refreshEnabled = true`;
`audit.chainEnabled = true`; `auth.mfa.enforce`, `approvals.enabled`,
`registry.splitEnabled` and `treasury.enforce` remain **false** until
explicitly enabled. Workbook split activates only when both
`workbook_registry.enabled` and `registry.splitEnabled` are true.

### 14.3 Feature behaviour to validate after deploy

| Area | Endpoint / action | Expected |
|---|---|---|
| Refresh rotation | `POST /auth/refresh` | New access JWT (15 min) + new refresh token; predecessor session `revoked_at` set |
| Reuse detection | Replay an old refresh token | `401 REFRESH_REUSE`; **all** sessions for that user revoked |
| Logout | `POST /auth/logout`, `logout {all:true}` | Current session / all user sessions revoked |
| MFA enrol | `POST /auth/mfa/enroll`, `verify` | TOTP (SHA256) or Email OTP accepted; `cms-mfa` challenge token only works on `/auth/mfa/*` |
| Audit integrity | `GET /audit/verify`, `/audit/chain/status` | `{valid:true}`; tampering writes `AUDIT_VERIFY_FAILED` + `tbl_security_events` and an appended `FAILURE` audit row |
| Lockout | 5 bad passwords | `ACCOUNT_LOCKED` event, 30-minute `users.locked_until`; ADMIN `POST /admin/security/unlock` clears it |
| Rate limits | Flood an IP / user / MFA | `429 RATE_LIMITED` + one deduped `RATE_LIMITED` security event per minute; logging never recurses into the limiter |
| Security views | `GET /security/events`, `/security/me` | ADMIN/AUDITOR see the log (scoped roles need explicit scopes); any user sees their own posture |
| R2 routes | `GET /attachments`, `GET/POST /admin/backups` | `404 NOT_FOUND` — intentionally unmounted; no bucket or trigger is used |
| Approvals | gated mutations (while flag off) | No behaviour change; with flag on, one open request per entity/action, 24 h expiry, no self-approval |
| Reports | `GET /reports/aging`, `/collector-performance`, `/treasury-reconciliation`, `/audit-exceptions`, `/kpis` | Permission-gated as documented in `docs/phase2/04-api-changes.md` |

### 14.4 Backup verification & restore — not applicable

R2 backup/restore is **out of scope**. The R2-backed backup endpoint and daily
trigger are disabled; no R2 object or audit-tip checkpoint is produced.

Use the normal Google Workspace version history / protected-range controls for
the operational spreadsheet, plus the audit hash chain in `tbl_audit_logs` and
`tbl_settings.audit_chain_tip` for integrity verification. The dormant GAS
backup service and its unit tests are reference code only and must not be used
as the production backup procedure.

### 14.5 Incident response

| Signal | Action |
|---|---|
| `HASH_CHAIN_INVALID` / `audit.verify` fails | Do **not** edit `tbl_audit_logs`. Snapshot the chain, read `tbl_security_events`, compare with `tbl_settings.audit_chain_tip`, and escalate. |
| `REFRESH_REUSE` | Treat as token theft: the user family is already revoked; force password reset and review `tbl_sessions` + security events. |
| `ACCOUNT_LOCKED` storms | Check whether the source is a single IP (rate limiter) or distributed; do not bulk-unlock without investigating. |
| `BACKUP_FAILED` (legacy only) | No active backup job exists in this rollout. Treat any such event as reference/test data; verify Google Workspace version history and the audit chain instead. |

### 14.6 Local validation evidence before approval

- `npm test`: **19 files / 137 tests, 0 failures**.
- Syntax checks: clean for all changed `.js`/`.gs` files.
- Phase 1 production smoke set: **11/11** checks green (regression baseline).
- No `clasp push --force`, `clasp deploy` or Pages production deploy has been
  performed for Phase 2.
