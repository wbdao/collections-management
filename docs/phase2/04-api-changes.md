# Phase 2 — API Changes (Design)

**Status:** All Phase 2 endpoints (except skipped R2 attachment/backup routes) are **live in production**. See `docs/api/openapi.yaml` for the active route reference.

> **Rollout update:** R2 is skipped. The attachment and backup endpoint tables
> below are design history only; those routes are **not mounted** and are absent
> from `docs/api/openapi.yaml`. Calls return `404 NOT_FOUND`.

**Preservation rule:** Every Phase 1 route in `functions/api/[[path]].js:79-265` keeps its method, path, permission, request shape, and `{ok, data, meta}` / `{ok:false, error}` envelope. All Phase 2 routes are **appended**. No existing response field is removed; new fields are additive.

> The repo has no formal API specification today — the effective spec is the router plus `shared/schemas/index.js`. Deliverable 10 will add `docs/api/openapi.yaml` (OpenAPI 3.0) covering both Phase 1 and Phase 2 routes.

---

## 1. Changes to existing auth routes

| Route | Change | Compatibility |
|---|---|---|
| `POST /api/v1/auth/login` | Response gains `expiresIn: 900`, `sid`, `mfaRequired`, `mfaChallengeToken?`. When MFA is required, returns `{ mfaRequired:true, mfaToken, methods:['TOTP','EMAIL_OTP'] }` and **no access token** until verified. | Legacy clients ignore new fields; when `mfa.enforce=false`, behaviour is identical plus shorter TTL. |
| `POST /api/v1/auth/logout` | Now revokes the current session (`sid`) and any refresh token presented. Gains optional body `{all: true}` → revoke all sessions for the user. Old no-body call still works (current session only). | Backward compatible. |
| `GET /api/v1/auth/me` | Response gains `mfaEnabled`, `mfaMethods`, `sessionId`. | Additive. |
| New `POST /api/v1/auth/refresh` | Body `{refreshToken}` → `{accessToken, refreshToken, expiresIn:900, sessionId}`. Rotates the refresh token; reuse revokes the session family. | — |
| New `POST /api/v1/auth/mfa/enroll` | `{type:'TOTP'}` → `{secret, provisioningUri, recoveryCodes}`; `{type:'EMAIL_OTP'}` → `{challengeId}` then verify. Requires authenticated session. | — |
| New `POST /api/v1/auth/mfa/verify` | `{mfaToken, code, type}` → full token pair + user. Used both for enrolment confirmation and login challenge. | — |
| New `POST /api/v1/auth/mfa/disable` | `{code}` → `{disabled:true}`; blocked when role policy requires MFA. | — |
| New `GET /api/v1/auth/sessions` | Lists the caller's sessions (`session_id`, `device_info`, `ip_address`, `created_at`, `expires_at`, `revoked_at`, `current`). | — |

---

## 2. New routes by feature

### Audit integrity (Step 1)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/audit/verify` | `audit.verify` | Run `verifyAuditChain()` → `{valid, recordsChecked, firstFailure, issues:[{auditId,type,detail}], checkedAt}` |
| GET | `/api/v1/audit/chain/status` | `audit.read` | Cached tip/genesis/last-verified result from `tbl_settings` |

### Treasury management (Step 4)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/treasuries` | `treasuries.read` | List `{items}`; filter `?type=BRANCH\|HQ&status=` |
| POST | `/api/v1/treasuries` | `treasuries.manage` | Create treasury |
| GET | `/api/v1/treasuries/:id` | `treasuries.read` | Get treasury |
| PATCH | `/api/v1/treasuries/:id` | `treasuries.manage` | Rename/deactivate; immutable `treasury_id` |

### Notifications (Step 5)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/notifications` | `notifications.read` | In-app list; `?status=UNREAD&limit=` |
| GET | `/api/v1/notifications/summary` | `notifications.read` | Unread counts by type |
| PATCH | `/api/v1/notifications/:id/read` | `notifications.read` | Mark read |
| POST | `/api/v1/notifications/read-all` | `notifications.read` | Bulk mark read |

### Attachments (Step 6)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/api/v1/attachments` | `attachments.create` | `multipart/form-data`: `entityType`, `entityId`, `file`. Writes R2 then metadata; returns `{attachment}` |
| GET | `/api/v1/attachments` | `attachments.read` | `?entityType=&entityId=` list |
| GET | `/api/v1/attachments/:id` | `attachments.read` | Metadata |
| GET | `/api/v1/attachments/:id/download` | `attachments.read` | Streamed, authorised proxy from R2 (no public bucket URL) |
| DELETE | `/api/v1/attachments/:id` | `attachments.delete` | R2 delete + metadata soft delete |

Constraints: max 10 MB/file, allow-list `image/jpeg`, `image/png`, `application/pdf`, R2 key `attachments/<ENTITY>/<entityId>/<uuid>-<safeName>`.

### Approvals (Step 7)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/approvals` | `approvals.read` | `?status=PENDING_APPROVAL&entityType=` |
| GET | `/api/v1/approvals/:id` | `approvals.read` | Detail |
| POST | `/api/v1/approvals/:id/approve` | `approvals.decide` | `{notes}` → `APPROVED`, releases the gated transition |
| POST | `/api/v1/approvals/:id/reject` | `approvals.decide` | `{reason}` → `REJECTED` |

Gate points (active only when `approvals.enabled`): `deposits.hq.confirm` (HQ_DEPOSIT), cheque status change to `CLEARING`/`CLEARED` (CHEQUE_STATUS_CHANGE), guarantee transition to `RELEASED` (GUARANTEE_RELEASE).

### Advanced reporting (Step 8)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/reports/aging` | `reports.advanced.read` | Receivables aging buckets `d0_7/d8_30/d31_60/d60plus` |
| GET | `/api/v1/reports/collector-performance` | `reports.advanced.read` | Per-collector counts, cash, books outstanding, risk flag |
| GET | `/api/v1/reports/treasury-reconciliation` | `reports.advanced.read` | Per-treasury expected vs actual, exceptions |
| GET | `/api/v1/reports/audit-exceptions` | `audit.verify` | Results of the latest `verifyAuditChain()` |
| GET | `/api/v1/reports/kpis` | `reports.read` | The five KPIs below |

KPI response keys: `collectionEfficiency`, `depositsPending`, `collectorOutstandingBalances`, `chequeClearancePerformance`, `guaranteeRiskExposure` — all computed from existing `ReportService`/`DashboardService` inputs; no new source table.

### Security (Step 11)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/v1/security/events` | `security.read` | Filterable security event log |
| GET | `/api/v1/security/me` | authenticated | Current rate-limit/session summary |

### Backup (Step 12)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/api/v1/admin/backups` | `backups.create` (ADMIN) | Trigger a backup; Apps Script collects data, edge writes R2, metadata row inserted |
| GET | `/api/v1/admin/backups` | `backups.read` | Backup ledger; retention status |

---

## 3. Error codes added

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Existing; now also expired/revoked token |
| `TOKEN_EXPIRED` | 401 | Access token expired (frontend refreshes) |
| `REFRESH_INVALID` | 401 | Unknown/expired/hashed refresh token |
| `REFRESH_REUSE` | 401 | Reuse detected → all sessions for user revoked |
| `MFA_REQUIRED` | 401 | Login needs MFA verification |
| `MFA_INVALID` | 401 | Wrong OTP/TOTP |
| `ACCOUNT_LOCKED` | 401 | Existing GAS code, now correctly mapped (was 500) |
| `ACCOUNT_DISABLED` | 401 | Existing GAS code, now correctly mapped (was 500) |
| `INVALID_CREDENTIALS` | 401 | Existing GAS code, now correctly mapped (was 500) |
| `SESSION_NOT_FOUND` | 404 | Session id unknown/revoked |
| `RATE_LIMITED` | 429 | Existing; now also per-IP layer |
| `APPROVAL_REQUIRED` | 409 | Transition blocked pending approval |
| `APPROVAL_DECIDED` | 409 | Approval already resolved |
| `HASH_CHAIN_INVALID` | 409 | Verification found tampering |
| `FILE_TOO_LARGE` / `FILE_TYPE_REJECTED` | 422 | Attachment validation |
| `R2_UNAVAILABLE` | 503 | R2 write/read failure |

`functions/_lib/gas-client.js:135-154` `mapCode()` is extended so the three auth codes and `MFA_*` map to 401 instead of the current 500 default.

---

## 4. Frontend changes (API consumption only)

- `frontend/js/api/client.js`: add a single-flight refresh interceptor — on 401 `TOKEN_EXPIRED`/`UNAUTHORIZED`, call `POST /auth/refresh`, update the stored token, replay the request once; on `REFRESH_REUSE`/`MFA_REQUIRED` clear session and emit `cms:unauthorized`.
- `frontend/js/config.js`: add `cms.refreshToken`, `cms.sessionId` storage keys.
- `frontend/js/store.js`: `startSession()` stores refresh token + expiry; `endSession(all?)` calls logout.
- `frontend/js/pages/login.js`: handle `mfaRequired` state with a code-entry step and method selector.
- New pages: `notifications.js`, `approvals.js`, `attachments` component, `reports.js`, `audit.js`, `treasuries.js`; nav entries in `components/shell.js` guarded by the new permissions.
- Real report UI replaces the stub at `frontend/js/app.js:48`.
