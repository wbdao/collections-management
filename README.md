# Collections Management System — Phase 1

Production implementation of the approved Phase 1 architecture.

```text
Frontend → Cloudflare Functions → Repository Interface → Apps Script Adapter → Google Sheets
```

Business services never access `SpreadsheetApp`. Only `apps-script/repository/sheets-adapter.gs` holds Google Sheets access code.

## Layout

| Path | Responsibility |
|---|---|
| `frontend/` | Vanilla HTML/CSS/JS SPA served by Cloudflare Pages |
| `functions/` | Cloudflare Pages Functions: middleware, JWT, RBAC, routing, modules |
| `functions/_lib/` | Shared edge libraries + business service modules |
| `shared/` | Constants, enums, repository contract, validation schemas |
| `apps-script/` | Google Apps Script backend (adapter, data definitions, services) |
| `apps-script/repository/` | **Only** file permitted to use `SpreadsheetApp` |
| `apps-script/services/` | Domain services (state machines, custody, deposits, alerts, audit) |
| `migrations/d1/` | Future Cloudflare D1 schema (not active in Phase 1) |

## Phase 1 scope

- JWT-only authentication (8 h, RS256), RBAC, warehouse/branch scope enforcement
- Customer master read from a separate, daily-updated spreadsheet (system of record)
  - Lookup/autocomplete by Account, Name and الاسم الموحد; 5-minute `customer:{Account}` cache
  - Warehouse Group / Customer group inherited by value onto documents; no local master tables
- Book batches (printing house) with variance + quarantine
- Books with auto-generated receipts
- Receipts validate Account and inherit customer name, warehouse and department
- Collector custody ledger, balances, reconciliation exceptions
- Collections, branch/HQ deposits with atomic confirmation
- Cheques (incl. `CLEARING`), guarantees
- Alerts (guarantee 30/15/7/expired, cheque overdue, custody variance) with daily scan
- Movements for BOOK/RECEIPT/CHEQUE/GUARANTEE, universal tracking
- Append-only audit (no hash chain in Phase 1)
- Single operational spreadsheet (existing workbook), `sheet_registry` stored in `tbl_settings`
- Warehouse reports group by Warehouse Group; department reports group by Customer group

## Setup

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the complete deployment and production
test checklist (Apps Script Web App, Script Properties, Cloudflare secrets/KV,
bootstrap, customer-master validation, and security validation).

Quick start:

1. Copy `.dev.vars.example` → `.dev.vars` and fill secrets.
2. Generate an RSA key pair for JWT (see `.dev.vars.example`).
3. Deploy `apps-script/` as a Web App ("Execute as: Me", access: Anyone —
   requests are HMAC-signed).
4. Set Apps Script Script Properties (at minimum `GAS_SHARED_SECRET` and
   `CUSTOMER_MASTER_SPREADSHEET_ID`).
5. Set Cloudflare Pages secrets and KV namespace IDs in `wrangler.toml`.
6. Call `POST /api/v1/admin/bootstrap` with `X-Bootstrap-Token`.
7. Deploy: `npm run deploy`.

Customer master columns are resolved by header text at read time: `Account`, `Name`,
`Warehouse Group`, `Customer group`, `Eligible credit limit`, `Credit limit`, `Balance`,
`Payment schedule`, `Worker`, `Worker Name`, `Company chain`, `Segment`, `ID number`,
`Telephone`, `Account status`, `الاسم الموحد`.

## Tests

`npm test` — repository contract, schema, constants and scope checks in `tests/`.
