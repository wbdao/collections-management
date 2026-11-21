# Phase 2 Architecture Review

**Status:** Steps 1-12 (except skipped R2 Steps 6/12) are **live in production** — Phase 2 shipped 2026-11-19, security hardening 2026-11-21 (`f08b537`). Migrations M001-M011 applied and verified; smoke 11/11 + 11/11.
**Rollout update:** R2 is skipped. Google Sheets is the only storage backend; Steps 6 and 12 are dormant reference code and their R2 instructions below are not part of the active rollout.
**Scope:** Upgrade the live Phase 1 system at `https://collections-management.pages.dev/` into a production-grade financial control platform **on top of** the existing implementation, with zero redesign and zero rebuilding of Phase 1.

---

## 1. Phase 1 architecture as it exists today

```
Browser (frontend/)
  └─ fetch /api/v1/*  (Bearer JWT in localStorage)
       └─ Cloudflare Pages Function: functions/api/_middleware.js
            ├─ CORS / requestId / IP / idempotency key
            ├─ JWT verify (RS256, 8h) or login/bootstrap exemption
            ├─ CSRF defence-in-depth + KV rate limit (120/min per user)
            └─ functions/api/[[path]].js  (REST router, ~70 routes)
                 └─ functions/_lib/modules/*.js  (business logic)
                      └─ functions/_lib/repository.js  (8-method Repository Interface)
                           └─ functions/_lib/gas-client.js  (HMAC-SHA256 over ?signature=)
                                └─ Apps Script Web App (deployment @17)
                                     └─ apps-script/Code.gs → Router.handle()
                                          └─ apps-script/services/*.gs
                                               └─ apps-script/repository/sheets-adapter.gs
                                                    └─ Google Sheets (single workbook, 27 sheets)
```

**Data stores today**

| Store | Role | Notes |
|---|---|---|
| Operational Google Sheet `12GyV…unLI` | Primary source of truth, 27 sheets | Only `SheetsAdapter` may call `SpreadsheetApp` |
| Customer master Sheet `1U5mx…BH4E` | External, read-only, daily-updated | 5,914 rows, header-text-keyed |
| Cloudflare KV (`KV`) | Cache (TTL ≥ 60s), fixed-window rate limits, unused idempotency helpers | Failure must never break an API response |
| Apps Script `CacheService` | 60s registry cache, 300s customer cache | — |
| Apps Script `LockService` | One global script lock per mutation | **No rollback** on error |

**Current security:** RBAC via JWT claims + `requirePermission`; 43 permissions, 5 roles; 5-attempt account lockout; static bootstrap token; HMAC signed edge↔GAS transport. **No** sessions, refresh tokens, revocation, MFA, hash chain, approvals, notifications, attachments, R2, or D1 activation.

---

## 2. Non-negotiable preservation rules

1. **The call chain above stays intact.** New code is additive inside existing layers; no new top-level architecture.
2. **`shared/contracts/repository.js` stays byte-for-byte unchanged**: the same 8 methods, same signatures, same `{ok, data, meta}` result contract. No business module's call shape changes.
3. **Google Sheets remains the primary source.** D1 is an adapter layer only — not migrated to, not activated.
4. **No destructive schema change.** New fields are **appended at the end** of a table's `columns` array; existing row data keeps its physical column index. New tables are added to `TABLES` additively.
5. **Bootstrap stays re-runnable** and never overwrites existing rows or credentials.
6. **KV stays an optimisation.** Any KV failure must degrade open, never fail a request (KV `expirationTtl` floor is 60s).
7. **Migration-first.** Every storage change ships with a migration script and a verification step before dependent code is enabled.
8. **Feature flags** in `tbl_settings` gate new behaviour so a step can be rolled back to Phase 1 behaviour without redeploying data.

---

## 3. Feature-to-component mapping

| # | Phase 2 feature | Lives in (new) | Seam into Phase 1 (existing) | Phase 1 impact |
|---|---|---|---|---|
| 1 | Audit hash chain + `verifyAuditChain()` | `apps-script/services/audit-service.gs` (hash write + verify), new `migrations/apps-script/M001…`, new API routes | `AuditService.write()` is already the single audit append point (Router, all services) | Additive: 2 columns appended to `tbl_audit_logs`; all existing audit writes gain hashes automatically |
| 2 | Refresh tokens + sessions | `functions/_lib/auth.js`, `_middleware.js`, new `tbl_sessions`, new routes | `auth.login/logout`, JWT claims, `repo.call()` to GAS | 8h→15m access token is required behaviour change; legacy tokens expire naturally |
| 3 | MFA (email OTP + TOTP) | Edge challenge/verify in `functions/_lib/auth.js`; `tbl_users` gains 2 fields | `AuthService.login()` returns an `mfaRequired` state; Router service actions | Additive; MFA enforced by policy flag for ADMIN/TREASURY |
| 4 | Workbook split (CORE/DOCS/AUDIT) | `apps-script/repository/sheets-adapter.gs` (`getSheet()` resolves registry `workbookId`), `bootstrap.gs`, `config.gs` | Registry already stores `workbookId` but **`getSheet()` ignores it** — that is the exact seam | Business services untouched; all entities remain in CORE until a manual cutover |
| 5 | D1 adapter | `functions/_lib/d1-repository-adapter.js`, `migrations/d1/0001_init.sql` | `functions/_lib/repository.js` factory selects adapter via env flag | Inactive by default; `assertRepository()` proves contract compliance |
| 6 | Treasury entities | New `tbl_treasuries`, `apps-script/services/treasury-service.gs`; FK fields appended to documents | Deposit/cheque/guarantee/movement services currently write **text** `BRANCH_TREASURY`/`HQ_TREASURY` | Dual-write text + `treasury_id` during transition; text columns retained |
| 7 | R2 attachments | R2 bucket, edge upload/download routes, new `tbl_attachments` | `repo.insert('attachments', …)` metadata; entity id from existing docs | No change to document services |
| 8 | Notifications | New `tbl_notifications`, `apps-script/services/notification-service.gs`, edge routes | `AlertService.raise()` already fires for the 3 of 4 required types; add FAILED_RECONCILIATION | Alerts stay; notifications are a parallel in-app channel |
| 9 | Approval workflow | New `tbl_approvals`, `apps-script/services/approval-service.gs`, edge routes | HQ deposit confirm, cheque status change, guarantee release call sites get an approval gate | Gate is **policy-disabled by default**, preserving Phase 1 flows |
| 10 | Advanced reporting | New aggregates in `Router.aggregate()`, new report module, new routes | `ReportService` already has aging buckets + collector outstanding; `DashboardService` has KPI inputs | Existing report endpoints unchanged; new ones added |
| 11 | Security hardening | `_middleware.js`, `ratelimit.js`, new `tbl_security_events`, KV revocation | Existing JWT verify, KV limiter, lockout | Adds per-user + per-IP limits, denylist, event log; fixes 4 Phase 1 gaps |
| 12 | R2 backups | R2 bucket, edge backup endpoint, Apps Script daily trigger, new `tbl_backups` | Mirrors existing `installDailyScanTrigger()` pattern | Additive; 90-day R2 lifecycle retention |

---

## 4. Cross-cutting design decisions

- **Additive schema, never in-place replacement.** Appending columns is safe; inserting/reordering is not (header rewrite does not move existing row values).
- **Dual-write / read-prefer-new** for treasury references: write both legacy text and new `treasury_id`; readers use `treasury_id` when present and fall back to text.
- **Policy flags** in `tbl_settings` (`auth.mfa.required`, `approvals.enabled`, `treasury.enforce`, etc.) let each step be activated independently after its migration verifies.
- **One audit writer.** All new features call `AuditService.write()` so they automatically inherit the hash chain — no second audit path.
- **One repository contract.** New entities/tables are reached through the same 8 methods or through the existing `repo.call(action, entity, payload)` escape hatch already used by Phase 1 service actions.
- **Secrets never in sheets.** JWT keys, GAS secret, R2 credentials stay in Cloudflare Secrets / Apps Script Properties.
- **Security events are separate from audit logs.** Verification events go to a new append-only `tbl_security_events` so `verifyAuditChain()` does not mutate the chain it verifies.
- **Checkpoint the audit tip** (`tbl_settings.audit_chain_tip` + periodic R2 anchor) so deletion of the *last* audit record is detectable — an internal chain alone cannot detect tail truncation.

---

## 5. Change-surface inventory (files expected to change)

| Layer | Files | Nature |
|---|---|---|
| Shared contracts | `shared/constants/enums.js`, `shared/schemas/index.js` | Additive enums/permissions/schemas only; **`shared/contracts/repository.js` untouched** |
| Edge middleware/lib | `functions/api/_middleware.js`, `functions/_lib/auth.js`, `ratelimit.js`, `repository.js`, `respond.js`, `errors.js`, `gas-client.js` | Extend existing; add new lib modules for sessions/MFA/security/attachments/backups |
| Edge router | `functions/api/[[path]].js` | Append new routes only |
| Edge modules | `functions/_lib/modules/*` | New report/notification/approval/attachment modules |
| Apps Script | `router.gs`, `config.gs`, `bootstrap.gs`, `data/tables.gs`, `repository/sheets-adapter.gs`, `services/audit-service.gs`, `services/auth-service.gs`, `services/alert-service.gs` | Additive; new service files |
| Migrations | `migrations/apps-script/M###…`, `migrations/d1/0001_init.sql` | New |
| Infra | `wrangler.toml`, `.github/workflows/deploy.yml`, `.dev.vars.example` | Add R2/KV bindings + secrets injection |
| Frontend | `frontend/js/api/client.js`, `store.js`, `config.js`, new pages/components | Refresh flow, MFA challenge, notifications, approvals, attachments, reports |
| Docs | `README.md`, `DEPLOYMENT.md`, `CLOUDFLARE_SETUP.md`, this `docs/phase2/` set | Update API spec, ERD, operations |

---

## 6. Risks and mitigations

| Risk | Evidence | Mitigation |
|---|---|---|
| Header append vs. data alignment | `sheets-adapter.gs:133-142` rewrites headers only; data stays in old columns | **Always append new columns at the end**; migration verifies column count and row alignment |
| No transaction rollback | `sheets-adapter.gs:394-405` | Migrations are idempotent and re-runnable; each mutation writes an audit/security event; compensating actions where needed |
| Registry `workbookId` unused | `sheets-adapter.gs:108-110` | Workbook split is isolated in `getSheet()`/bootstrap; CORE default preserves today's behaviour until cutover |
| Idempotency write outside lock | `router.gs:267-271` | Keep as-is for Phase 1; new mutating endpoints use unique keys and audit rows |
| Audit IP lost in transit | `gas-client.js:60` omits `actor.ip`; `router.gs:33` reads it | Propagate IP in the envelope; fix is backward compatible |
| Login failures map to HTTP 500 | `gas-client.js:135-154` default branch | Add explicit 401 mapping for `INVALID_CREDENTIALS`, `ACCOUNT_DISABLED`, `ACCOUNT_LOCKED`, `MFA_*` |
| `'*'` not honoured server-side | `rbac.js:11-12` | Treat `'*'` as wildcard in `hasPermission` (no behaviour loss for existing roles) |
| Empty scopes bypass restrictions | `scope.js:66-70` | Require explicit scope or ADMIN/AUDITOR for new sensitive endpoints |
| TOTP HMAC-SHA1 unavailable in GAS | Apps Script exposes SHA256/SHA512 HMAC only | Generate/verify TOTP at the **Edge** with WebCrypto HMAC-SHA256 (RFC 6238 allows SHA256) |
| Pages has no native cron triggers | `wrangler.toml` Pages project | Daily backup uses an Apps Script time trigger, mirroring `installDailyScanTrigger()` |
| KV TTL floor 60s | Phase 1 incident (30s broke API) | All new KV writes use TTL ≥ 60; cache failures are swallowed |

---

## 7. Rollout and verification strategy

Each implementation step ships with: (1) migration + verification, (2) feature flag defaulting to **off** where behaviour changes, (3) new tests, (4) a smoke script against the production-like URL, and (5) a one-line rollback (flip flag / disable route). Full regression = the Phase 1 smoke set (`health`, `auth/me`, dashboard, customer autocomplete/search, `customers/CUST020208`, tracking) must stay green after every step.

---

## 8. Explicitly out of scope for this design

- No new architecture, no replacement of Sheets as system of record, no D1 cutover.
- No deletion or rewriting of Phase 1 data, credentials, or deployments.
- Email/SMS delivery adapters are designed as interfaces; only in-app delivery is implemented now.
- No changes to the public Apps Script deployment access setting beyond what is already documented (`أي شخص` / anyone).
