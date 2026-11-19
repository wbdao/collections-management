# Phase 2 — Development Plan

**Status:** Design approved; **Steps 1–12 implemented and validated locally**. Production migration, `clasp push --force`, Apps Script deployment and Pages deployment are deliberately **pending explicit approval** — nothing from Phase 2 is live yet. Phase 1 production (`@17`, anyone-access) remains unchanged and its smoke set is green.

> **Rollout update — Google Sheets only:** R2 is skipped. Steps 6 and 12 are
> dormant reference code; their routes, bindings, secrets and daily trigger are
> excluded from deployment. Google Sheets is the only production store.

### Implementation status (local)

| Step | Feature | Local validation |
|---|---|---|
| 1 | Audit Hash Chain | `tests/audit-chain.test.js` |
| 2 | Refresh Tokens & Sessions | `tests/session.test.js`, `tests/jwt-tokens.test.js` |
| 3 | MFA | `tests/mfa.test.js` |
| 4 | Treasury Management | `tests/treasury.test.js` |
| 5 | Notifications | `tests/notifications.test.js` |
| 6 | R2 Attachments | `tests/attachments.test.js` |
| 7 | Approval Workflow | `tests/approvals.test.js` |
| 8 | Advanced Reporting | `tests/advanced-reporting.test.js` |
| 9 | Workbook Split Support | `tests/workbook-registry.test.js` (real-adapter VM tests) |
| 10 | D1 Adapter (reference only, unbound) | `tests/d1-adapter.test.js` |
| 11 | Rate Limiting & Lockout | `tests/rate-limit-security.test.js`, `tests/security-hardening.test.js` |
| 12 | Backup & Recovery | `tests/backups.test.js` |

Current baseline: **19 test files / 137 tests, 0 failures** (`npm test`); all syntax checks clean; Phase 1 production smoke set (11 checks) green.

---

## 1. Global entry/exit criteria per step

Every step must satisfy all of the following before the next begins:

- [x] Its migration(s) from deliverable 2 are written and idempotent (`apps-script/migrations/M001`–`M011`); **production `migration.verify()` pending**.
- [x] Feature flag (where defined) exists in `tbl_settings` definitions with the documented default; **production flag rows pending**.
- [x] New tests added; `npm test` green — 19 files / 137 tests, 0 failures (Phase 1 baseline was 5 files / 13 tests).
- [x] Phase 1 smoke set green against production: `health`, `auth/me`, dashboard endpoints, customer autocomplete/search, `customers/CUST020208`, tracking; unknown customer/tracking still 404 (11/11 checks).
- [ ] Apps Script `clasp push --force` clean; no new active deployments; `@17` remains the Web App deployment; public access `أي شخص` — **pending approval**.
- [x] Docs updated: `README.md`, `DEPLOYMENT.md`, `CLOUDFLARE_SETUP.md`, API spec (`docs/api/openapi.yaml`), ERD (`docs/phase2/03-erd-changes.md`), `.dev.vars.example`, `wrangler.toml`.

---

## 2. Ordered implementation steps

| # | Step | Key artifacts | Depends on | Flag |
|---|---|---|---|---|
| 1 | **Audit Hash Chain** | M001; hash write in `AuditService.write()`; `verifyAuditChain()`; `/audit/verify`, `/audit/chain/status` | pre-flight backup | `audit.chainEnabled` |
| 2 | **Refresh Tokens & Sessions** | M002; 15m JWT + `sid`/`jti`/`amr`; `auth.js` refresh/rotate/reuse; `_middleware.js` revocation check; `tbl_sessions`; `/auth/refresh`, `/auth/logout{all}`, `/auth/sessions`; client refresh interceptor | 1 (audit events) | `auth.refreshEnabled` |
| 3 | **MFA** | M003; edge TOTP + email OTP; enroll/verify/disable routes; ADMIN/TREASURY policy; MFA challenge UI | 2 | `auth.mfa.enforce` |
| 4 | **Treasury Management** | M004; `treasury-service.gs`; dual-write FKs in deposit/cheque/guarantee/movement services; `/treasuries` CRUD; backfill verify | 1 | `treasury.enforce` |
| 5 | **Notifications** | M006; `notification-service.gs`; wire `AlertService.raise()` + add FAILED_RECONCILIATION; `/notifications` routes; in-app UI | 4 (treasury context for recipients) | `notifications.enabled` |
| 6 | **Attachments (R2)** | R2 bucket + binding; M005; upload/download/delete routes; attachment component | 7 (config) | — |
| 7 | **Approval Workflow** | M007; `approval-service.gs`; gates on HQ deposit confirm / cheque status change / guarantee release; `/approvals` routes + UI | 4, 5 | `approvals.enabled` |
| 8 | **Advanced Reporting** | New aggregates in `Router.aggregate()`; report module; 5 endpoints incl. KPIs; real report UI | 1, 4 (audit + treasury data) | — |
| 9 | **Workbook Split Support** | M010; registry-aware `getSheet()`/`createSheet()`; Script Properties for DOCS/AUDIT; manual cutover runbook | 1–8 (all sheets exist in CORE) | `registry.splitEnabled` |
| 10 | **D1 Adapter** | M012 SQL (file only); `D1RepositoryAdapter` with 8 methods; contract tests; factory flag | 9 (schema stabilised) | `repository.adapter=sheets` |
| 11 | **Rate Limiting** | Layered per-IP/per-user limits; JWT revocation list; `tbl_security_events` (M008); account lockout hardening; Phase 1 gap fixes | 2, 3 | — |
| 12 | **Backup & Recovery** | R2 backups bucket; M009; `backup.start`; daily Apps Script trigger; 90-day lifecycle; audit-tip checkpoints; restore runbook | 1, 7, 8 | — |

> M008 (`tbl_security_events`) is applied with step 11 but may be applied earlier (after step 1) if audit verification needs a place to log failures immediately — recommended: apply M008 together with M001.

---

## 3. Migration script sequencing (do this first)

Per the user's rule **"Generate migration scripts first"**, the first implementation commit contains only:
1. `migrations/apps-script/migration-runner.gs` with `run/verify`.
2. M001–M012 specifications turned into executable, idempotent scripts (deliverable 2).
3. M011 (flags/permissions) applied first, then M008 + M001 (audit + security log), then the remainder in manifest order.
4. A one-off pre-migration workbook export to R2 (or manual copy) before M001 backfill.

No feature code is enabled until its migration's `verify()` returns `{ok:true}`.

---

## 4. Testing strategy

| Layer | Tests |
|---|---|
| Unit (new) | hash canonicalisation/backfill/verify (tamper, delete, truncate, tip mismatch); JWT 15m + claims; refresh rotation + reuse detection; MFA TOTP vectors + OTP hashing; rate-limit key shapes; D1 adapter 8-method contract; migration idempotency |
| Contract (extended) | `tests/repository.contract.test.js` runs against both Sheets and D1 adapters |
| Existing (preserved) | 13 Phase 1 tests unchanged: constants, gas-client Unicode HMAC, repository contract, schemas, scope |
| Integration/smoke | Per-step smoke script hitting the live URL; full Phase 1 smoke set after every step |
| Security | HMAC negative tests (missing/empty/wrong signature) still reject; login error codes now 401; expired/revoked token rejected; reuse revokes family; MFA wrong code rejected; IP+user limits trip independently |

---

## 5. Deployment sequence

1. Migration commit → admin runs `migration.run`/`verify` in order (behind flags).
2. Per step: implement → test locally (`npm run dev` with R2 bindings) → `clasp push --force` for GAS changes → `git push main` → CI test + Pages deploy → smoke tests → flip flag if green.
3. Workbook cutover (step 9) is a **manual, separately approved** operation: copy sheets, verify checksums, flip `registry.splitEnabled`; rollback = flip back (all entities still resolvable in CORE).
4. No D1 binding, no `REPOSITORY_ADAPTER=d1`, no Apps Script re-deploy beyond `@17` in this phase.

---

## 6. Documentation updates (required by rules 5–9)

| Deliverable | Doc update |
|---|---|
| API spec | New `docs/api/openapi.yaml` covering Phase 1 + Phase 2 routes, envelopes, and error codes |
| ERD | `docs/phase2/03-erd-changes.md` becomes canonical; add Mermaid diagram to `README.md` |
| Repository interfaces | `docs/phase2/06-repository-interface-changes.md`; keep `shared/contracts/repository.js` unchanged |
| Config / R2 | `CLOUDFLARE_SETUP.md`, `DEPLOYMENT.md` binding/secrets checklists |
| Operations | `DEPLOYMENT.md`: refresh/session ops, MFA enrolment, migration runbook, backup/restore, audit verification, incident response for `HASH_CHAIN_INVALID` / `REFRESH_REUSE` |
| Corrections | Test-suite count fixed (now 19 files/137 cases), `package-lock.json` present, `/admin/permissions` → `/admin/role-permissions` route already correct |

---

## 7. Definition of done for Phase 2

- All 12 features implemented in the specified order with flags defaulting safely.
- `npm test` green including new suites; Phase 1 smoke set green on production.
- `verifyAuditChain()` returns `{valid:true}` after a full day of production writes.
- Daily backup verified: object in `cms-backups`, `tbl_backups` row `COMPLETED`, 90-day retention rule present.
- D1 adapter passes contract tests but is not bound or activated.
- Production still uses Google Sheets as the single source of truth; Phase 1 functionality unchanged.
