# Phase 2 — Cloudflare Configuration Changes (Design)

> **Rollout update — Google Sheets only:** R2 is skipped. Step 6 (attachments)
> and Step 12 (backups) are dormant reference code; their routes, bindings,
> secrets and daily trigger are not deployed. This document remains the original
> approved design and is superseded by `DEPLOYMENT.md` §14 for this rollout.

**Original status:** Approved design; the R2-specific instructions below are **not** part of the active deployment checklist.

**Preservation rule:** The existing Pages project `collections-management`, production KV namespace IDs, Pages secrets, and GitHub Variables stay as-is. New bindings/vars are added, not substituted.

---

## 1. `wrangler.toml` additions

```toml
[vars]
ENVIRONMENT = "production"
API_BASE = "/api/v1"
REPOSITORY_ADAPTER = "sheets"      # never set to "d1" in Phase 2
CACHE_TTL_SECONDS = "60"           # KV floor 60s

# Existing binding unchanged:
[[kv_namespaces]]
binding = "KV"
id = "fb65d7933b724884a1740133c824b026"           # injected by CI in practice
preview_id = "50ad43c2c8a740a0a2429cdd66b93dd6"

# NEW — object storage
[[r2_buckets]]
binding = "ATTACHMENTS_BUCKET"
bucket_name = "cms-attachments"
preview_bucket_name = "cms-attachments-preview"

[[r2_buckets]]
binding = "BACKUPS_BUCKET"
bucket_name = "cms-backups"
preview_bucket_name = "cms-backups-preview"

# NEW — D1 binding is NOT added in Phase 2 (adapter layer only).
# The D1 adapter is unit-tested with a local D1 database in CI.
```

KV namespace strategy: **reuse the existing `KV` binding** with namespaced key prefixes (`rl:*`, `cache:*`, `revoke:*`, `otp:*`, `mfa:replay:*`, `idem:*`) rather than creating new namespaces — simpler and preserves the current deployment. If scale requires it later, a second `[[kv_namespaces]]` binding can be added without code changes to callers.

---

## 2. Secrets (Cloudflare Pages Secrets / GitHub Secrets)

| Secret | Status | Purpose |
|---|---|---|
| `GAS_URL`, `GAS_SHARED_SECRET` | existing | signed edge↔GAS transport |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE` | existing | RS256 access tokens (audience stays `cms-web`; MFA challenge uses a dedicated short-lived token signed with the same key but `aud='cms-mfa'`) |
| `BOOTSTRAP_TOKEN` | existing | admin bootstrap (rotate + per-IP limit) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | existing (CI only) | deploy |
| `MFA_EMAIL_FROM` | new, optional | sender identity for future email OTP |
| `BACKUP_SIGNING_KEY` | new | HMAC checksum for backup objects |

R2 access uses the binding (Workers runtime credentials), **no static access keys**.

---

## 3. GitHub Variables

| Variable | Status |
|---|---|
| `KV_NAMESPACE_ID`, `PREVIEW_KV_NAMESPACE_ID` | existing, unchanged |
| `R2_ATTACHMENTS_BUCKET`, `R2_BACKUPS_BUCKET` (optional) | new — if bucket names differ per environment, add `sed` injection alongside the existing KV injection step in `deploy.yml:36-45` |

---

## 4. CI/CD workflow changes (`.github/workflows/deploy.yml`)

1. **Tests job** stays Node 20 + `npm test`; new contract tests (both adapters), migration tests, JWT/session/MFA tests are picked up automatically.
2. **KV injection** step unchanged.
3. **R2 buckets** are created out-of-band (one-off `wrangler r2 bucket create`) and bound in `wrangler.toml`; no per-deploy creation.
4. **Secrets bulk** step: extend the `keys` array at `deploy.yml:65` with `MFA_EMAIL_FROM`, `BACKUP_SIGNING_KEY` (empty values are acceptable for optional ones).
5. **Migrations are NOT run by CI** — they are run explicitly via the authenticated `migration.run` service action by an administrator, in the documented order, with `migration.verify` after each. This avoids schema changes on every push.
6. Deploy command unchanged: `npx wrangler pages deploy frontend --project-name=collections-management --branch=main`.

---

## 5. New environment files

- `.dev.vars.example`: add placeholders for `REPOSITORY_ADAPTER=sheets`, `MFA_EMAIL_FROM`, `BACKUP_SIGNING_KEY`, and local R2 preview notes. Existing JWT/GAS examples unchanged.
- `package.json`: keep `test: node --test`; add optional `test:d1` (local D1 conformance) and `migrate:verify` helper scripts only if needed.

---

## 6. Local development

- `npm run dev` stays `wrangler pages dev frontend --kv KV`; add `--r2 ATTACHMENTS_BUCKET --r2 BACKUPS_BUCKET` for Phase 2 endpoints.
- Apps Script development remains via `clasp`; new `.gs` files must be added to `apps-script/.clasp.json` `filePushOrder` **after** constants/config/tables/utils/adapter and before services/router (preserving the current ordering so globals resolve).
- `clasp push` warnings from the Phase 1 deployment still apply: do not run `clasp deploy` casually (it can reset public access); production remains `@17` with access `أي شخص`.

---

## 7. Health and observability

- `/api/health` remains public and unchanged; add a `features` block reporting flag states (`refresh`, `mfa`, `approvals`, `split`, `chain`) for operational verification.
- No new Cloudflare Analytics Engine / Logpush configuration in this phase; security events are stored in `tbl_security_events`.
