# Phase 2 — Security Changes (Design)

**Status:** **Live in production** (15m tokens, rotation/reuse detection, MFA, lockout, layered limits, security events). A follow-up hardening pass shipped 2026-11-21 (`f08b537`): public-field projection on `/admin/users`, 5-min MFA challenge TTL with `Bearer` transport, same-second revocation, no default admin password, and scope guards on detail reads/subresources/mutations.

> **Rollout update:** R2 is skipped. No `R2_*` binding or backup secrets are
> required; KV is used only for cache, revocation, OTP, idempotency and rate
> limits. Google Sheets remains the only production data store.

---

## 1. Token model

| Property | Phase 1 | Phase 2 |
|---|---|---|
| Access token | RS256 JWT, 8 h | RS256 JWT, **15 min** (`ACCESS_TTL_SECONDS = 900`) |
| Refresh token | none | Opaque 256-bit random, **7 days**, SHA-256 hash stored in `tbl_sessions.refresh_token_hash` |
| Access claims | `sub, username, role, scopes, permissions, iss, aud, iat, exp, jti` | same **plus** `sid` (session id), `amr` (auth methods, e.g. `["pwd","totp"]`), `mfa` (bool) |
| Verification | signature, exp, iat, iss, aud | same **plus** revocation check (`jti` denylist + `sub` revoke-after timestamp in KV) |
| `jti` | minted, unused | now persisted in short-lived KV denylist on logout/revocation |

Legacy 8 h tokens already issued remain valid until their natural `exp`; no forced invalidation at rollout.

---

## 2. Session lifecycle

1. **Login** (`POST /auth/login`): credentials verified in GAS (`AuthService.login`). On success, edge creates `tbl_sessions` row (`session_id` UUID, hash of refresh token, `device_info` UA, `ip_address` from `CF-Connecting-IP`, `created_at`, `expires_at = +7d`, `revoked_at=''`), issues access + refresh pair.
2. **Refresh** (`POST /auth/refresh`): hash incoming token → `findRow('sessions','refresh_token_hash', hash)`; reject if missing/expired/revoked. **Rotation**: write new hash into the same session (or create successor + revoke predecessor — design chooses in-session rotation with a `rotated_at` audit event), return a new pair.
3. **Reuse detection**: if a token's hash matches a **revoked** session row → revoke **all** sessions for that `user_id`, write `TOKEN_REUSE_DETECTED` to `tbl_security_events`, and return `REFRESH_REUSE` (401). This contains theft of a rotated token.
4. **Logout current**: revoke the `sid` from the access token (`revoked_at = now`), add `jti` to the KV denylist until `exp`, delete the refresh token client-side.
5. **Logout all**: revoke every non-revoked session for the user, set `KV revoke:sub:<userId> = now` so all outstanding access tokens fail verification.
6. **Session listing/revocation** endpoints let a user see and kill devices.

Session storage is in Sheets (primary source); KV is used only for the short-lived revocation denylist with TTL ≥ 60s and **degrades open** if unavailable (KV failure must not lock out users).

---

## 3. MFA

**Policy:** `auth.mfa.requiredRoles = ["ADMIN","TREASURY"]`. Enrolment is available to all users; enforcement is gated by `auth.mfa.enforce` (default off until rollout).

**TOTP (Authenticator app):**
- Secret generated at the **edge** with `crypto.getRandomValues` (20 bytes → base32), stored base32 in `tbl_users.mfa_secret` through the Repository Interface.
- Verification at the **edge** using WebCrypto `HMAC-SHA-256` (RFC 6238 permits SHA256), 6 digits, 30 s period, ±1 step window, replay cache in KV keyed by `(userId, timeStep)` with 60 s TTL.
- Reason for edge verification: Apps Script exposes HMAC-SHA256/SHA512 but not HMAC-SHA1; keeping TOTP at the edge avoids a crypto mismatch and avoids exposing the secret to GAS.
- Provisioning URI: `otpauth://totp/CMS:<username>?secret=<base32>&issuer=CMS&algorithm=SHA256&digits=6&period=30`.

**Email OTP:**
- 6-digit code generated at the edge, stored **hashed** in KV under `otp:<userId>` with 300 s TTL (floor 60 respected), delivered through a pluggable `NotificationSender` interface. Phase 2 implements the interface with an in-app/`MailApp`-backed adapter; EMAIL/SMS transport providers are future-ready only.
- Verify compares hash with constant-time comparison; max 5 attempts then `MFA_CHALLENGE_FAILED` security event and challenge invalidation.

**Enrolment flow:** authenticated `POST /auth/mfa/enroll {type}` → secret/challenge → `POST /auth/mfa/verify {code}` marks `mfa_enabled=true`, stores recovery codes (hashed) in `tbl_settings`/KV. Login flow: credentials OK → if MFA required → `MFA_REQUIRED` + short-lived `mfaToken` (5 min, single-purpose JWT audience `cms-mfa`) → verify code → full tokens.

---

## 4. Rate limiting (layered, KV)

Extend `functions/_lib/ratelimit.js` while preserving the current `enforceRateLimit(env,ctx,bucket,limit,window,identity)` signature:

| Layer | Key pattern | Default | Applies to |
|---|---|---|---|
| Login (existing) | `rl:login:<ip>:<60s bucket>` | 10/min | public auth |
| API per user (existing) | `rl:api:<userId>:<bucket>` | 120/min | authenticated requests |
| **API per IP (new)** | `rl:ip:<ip>:<bucket>` | 300/min | all non-OPTIONS requests, including public |
| **Auth per user (new)** | `rl:auth_user:<userId>:<bucket>` | 20/min | login/refresh/MFA attempts |
| **MFA challenge (new)** | `rl:mfa:<userId>:<bucket>` | 5/5min | OTP verification |

Both user and IP layers are enforced in `_middleware.js`; exceeding either throws 429 `RATE_LIMITED` and writes a `RATE_LIMITED` security event (rate-limited writes themselves must not recurse into the limiter). KV unavailable → open (Phase 1 behaviour). All TTLs ≥ 60 s.

---

## 5. Account lockout and security event logging

- Phase 1 already locks after 5 failed passwords (`AuthService.login`). Phase 2 adds: lockout timestamp in `tbl_users` (appended field or `tbl_settings` key), automatic unlock after 30 min, `ACCOUNT_LOCKED` security event, and an ADMIN unlock action.
- `tbl_security_events` (append-only, protected) records: `AUDIT_VERIFY_FAILED`, `TOKEN_REUSE_DETECTED`, `SESSION_REVOKED`, `MFA_CHALLENGE_FAILED`, `ACCOUNT_LOCKED`, `RATE_LIMITED`, `JWT_REVOKED`, `BACKUP_FAILED`, `ADMIN_UNLOCK`.
- `verifyAuditChain()` failures always write a security event **and** an audit row with `result:'FAILURE'` (the audit row itself is hashed and chained).

---

## 6. Phase 1 security gaps fixed (non-breaking)

| Gap | Fix |
|---|---|
| `actor.ip` lost between edge and GAS (`gas-client.js:60`, `router.gs:33`) | Include `ip` in the signed envelope actor; audit `ip_address` is then populated |
| Login errors map to HTTP 500 (`gas-client.js:135-154`) | Map `INVALID_CREDENTIALS`, `ACCOUNT_DISABLED`, `ACCOUNT_LOCKED` → 401 |
| `'*'` not honoured server-side (`rbac.js:11-12`) | Treat `'*'` as wildcard in `hasPermission` |
| Empty scopes bypass restrictions (`scope.js:66-70`) | New sensitive endpoints require explicit scope or ADMIN/AUDITOR role |
| Bootstrap token is static, no one-time enforcement | Rotate token via Secret; add `X-Bootstrap-Token` attempt logging + per-IP limit |
| AUDITOR permission mapping differs GAS vs shared | Align `constants.gs` with `shared/constants/enums.js` during M011 |

---

## 7. Transport, secrets and headers

- Edge↔GAS HMAC stays `?signature=` first, `X-Signature` defence-in-depth; payloads remain ASCII-escaped (`asciiJson`) for Unicode parity.
- New secrets (Cloudflare Secrets, not vars): `MFA_EMAIL_FROM` (if email transport enabled), `R2_*` via binding (no static keys), `BACKUP_SIGNING_KEY`. No JWT or GAS secret is moved.
- Add security headers to `respond.js`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and a permissive-then-tightened CSP after frontend audit. CORS stays `*` with the existing allowed-header list (adding `X-Mfa-Token` only if needed).
- JWT signing keys remain 2048-bit RS256 in Secrets; document rotation procedure (issue overlap window, revoke-after timestamp) in `DEPLOYMENT.md`.
