# Phase 2 — R2 Configuration (Design)

> **Rollout update — Google Sheets only:** R2 is skipped. No buckets, bindings,
> versioning, lifecycle rules, backup secrets or daily backup trigger are used.
> Edge attachment and backup flows exist only as dormant reference code; their
> API routes are not mounted. This document is retained for design history and
> is superseded by `DEPLOYMENT.md` §14 for the active rollout.

**Original status:** Approved design; locally implemented but not deployed.

---

## 1. Buckets

| Bucket | Binding | Purpose | Public access |
|---|---|---|---|
| `cms-attachments` | `ATTACHMENTS_BUCKET` | Cheque / guarantee / deposit files | **Private** — all reads through authorised edge proxy |
| `cms-backups` | `BACKUPS_BUCKET` | Daily spreadsheet backups | **Private** — retrieval via authenticated admin endpoint + signed URL |

Create once (out of band):
```
wrangler r2 bucket create cms-attachments
wrangler r2 bucket create cms-backups
wrangler r2 bucket create cms-attachments-preview
wrangler r2 bucket create cms-backups-preview
```
Bindings are declared in `wrangler.toml` (deliverable 7). No static R2 keys — the Workers binding supplies credentials.

---

## 2. Object key layout

```
attachments/<ENTITY_TYPE>/<ENTITY_ID>/<uuid>-<sanitized-file-name>
backups/<yyyy>/<mm>/<dd>/<backup-id>.json          (or .csv bundle)
backups/checkpoints/audit-tip-<yyyy-mm-dd>.txt      (audit chain anchor)
```

- `ENTITY_TYPE` ∈ `CHEQUE | GUARANTEE | DEPOSIT`; `ENTITY_ID` is the document id.
- File name is sanitised (strip path separators and control characters); UUID prefix prevents collisions.
- Metadata is stored in `tbl_attachments` / `tbl_backups`; R2 objects carry custom metadata `entity-type`, `entity-id`, `uploaded-by`, `checksum`.

---

## 3. Attachments flow

**Upload** (`POST /api/v1/attachments`, multipart, authenticated):
1. Edge validates permission `attachments.create`, entity type allow-list, content type, and size ≤ 10 MB (streamed, no full buffering where possible).
2. Edge writes the object to `ATTACHMENTS_BUCKET.put(key, stream, {customMetadata})`.
3. Only on success, `repo.insert('attachments', {attachment_id, entity_type, entity_id, file_name, r2_key, uploaded_by, uploaded_at})` — metadata is the source of truth; orphan objects are swept by a lifecycle rule.
4. Return `{attachment}`; write an audit row automatically through `AuditService.write()` (and therefore the hash chain).

**Download** (`GET /api/v1/attachments/:id/download`):
1. Look up metadata, check `attachments.read` plus scope (`assertScope`) on the parent document.
2. `ATTACHMENTS_BUCKET.get(r2_key)` → stream body with `Content-Type`, `Content-Disposition: attachment; filename="…"`, `Cache-Control: private, no-store`.
3. Never expose a public R2 URL; all access is authorised.

**Delete**: revoke metadata (soft delete) then `ATTACHMENTS_BUCKET.delete(r2_key)`; audit both steps.

---

## 4. Backup flow

**Daily schedule:** Apps Script time-driven trigger `dailyBackupTrigger` (mirrors the existing `dailyScanTrigger`, 01:00 UTC → backup at a later hour, e.g. 02:00 UTC). No Cloudflare cron trigger is available for Pages Functions.

1. Trigger POSTs `{ source: 'daily-trigger' }` to the edge `POST /api/v1/admin/backups` with header `X-Backup-Token: $BACKUP_SERVICE_TOKEN` (a time trigger cannot present a Bearer JWT). A normal ADMIN Bearer token also works for a manual trigger.
2. The edge calls the signed GAS action `backup.start`, which serialises each configured workbook's sheets (headers + rows), the `tbl_settings` policy flags and the audit-chain tip to ASCII-escaped JSON, computes a SHA-256 checksum, and opens a `RUNNING` `tbl_backups` row. (A caller may instead supply a pre-collected `backupId`/`payload`/`checksum`; the edge then skips `backup.start`.)
3. The edge recomputes the checksum; on match it writes `backups/<yyyy>/<mm>/<dd>/<backup-id>.json` to `BACKUPS_BUCKET` with `checksum`, `backup-id`, `retention-days` and an HMAC `backup-signature` in object metadata. GAS owns the ledger; the edge is the only R2 writer.
4. The edge writes `backups/checkpoints/audit-tip-<date>.txt` containing the current `audit_chain_tip` — this external anchor is what makes deletion of the last audit record detectable.
5. The edge calls `backup.complete` to set `r2_key`, `size_bytes`, `checksum`, `status='COMPLETED'`, `retention_until = started_at + 90 days` in `tbl_backups`.
6. On checksum mismatch, R2 failure or dispatch failure: the partial object is deleted, `status='FAILED'` and a `BACKUP_FAILED` security event are recorded; retry next day.

**Restore:** documented procedure (not automated in Phase 2) — locate backup by `backup_id`, verify checksum, import sheets into a **sandbox copy** workbook, run `migration.verify`, compare row counts, then cut over via `sheet_registry` (never overwrite live data in place).

---

## 5. Retention and lifecycle

- R2 lifecycle rule on `cms-backups`: **expire objects 90 days after creation** (matching `retention_until`); keep `checkpoints/` objects for 180 days for audit-anchor continuity.
- `cms-attachments`: no automatic expiry (business records); a lifecycle transition to a colder storage class after 365 days is optional future work.
- Bucket versioning: enabled on `cms-backups` for accidental-delete recovery; disabled on `cms-attachments` (metadata-led deletes are intentional).

---

## 6. Security

- Buckets are private; no public r2.dev URLs, no custom domains.
- All object access is mediated by the edge with existing RBAC, scope checks, and audit logging.
- CORS: not required (browser uploads go to the same-origin edge endpoint, not directly to R2). If direct-to-R2 presigned uploads are added later, configure restrictive CORS allowing only the production origin.
- Uploads are scanned for disallowed content types; malware scanning is future-ready.
- `BACKUP_SIGNING_KEY` HMAC checksum proves a backup was produced by the platform and not altered in storage.
