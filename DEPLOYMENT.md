# Deployment & Production Test Guide — Collections Management System Phase 1

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

### Cloudflare bindings / vars

| Name | Purpose | Status |
|---|---|---|
| `KV` | Cache, rate limit, idempotency | Binding exists; **IDs are placeholders** |
| `ENVIRONMENT`, `API_BASE` | Non-sensitive vars | Present in `wrangler.toml` |

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
| Token revocation | No refresh/revoke by design | 8h lifetime; rotate keys to revoke globally |

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

### Open items

- **Daily alert-scan trigger is not installed.** The Apps Script Triggers page
  shows `0` triggers. Install once from the editor:
  `installDailyScanTrigger()` (daily 01:00 UTC `dailyScanTrigger`). There is
  intentionally **no** customer-master scan trigger — the master is read live
  with a 5-minute CacheService TTL (`customer:{Account}`).
- Mutation flows (create/transition/audit-log insertion) have not been run
  against production to avoid writing test records into the live workbook.
  Run them in a sandbox copy or with explicit approval, then inspect
  `tbl_audit_logs` / `tbl_integration_errors`.
- Temporary Apps Script deployments `@9`–`@15` can be archived/removed;
  keep `@17` as the single public Web App deployment.
