# CLASP Deployment Guide — Apps Script Backend

**Scope:** upload all Apps Script files in one `clasp push`, with no manual file
creation in the Apps Script editor. No business logic is changed by this setup.

Run every command from the **repository root** (`D:\Collecting`). An equivalent
`.clasp.json` is also provided inside `apps-script/` if you prefer to `cd`
there; both target the same script and produce the same upload.

---

## A. Complete folder structure required for CLASP

```
D:\Collecting                       <- run clasp here
├── .clasp.json                     <- CLASP project config (scriptId + rootDir)
├── .claspignore                    <- allowlist: manifest + all **/*.gs only
├── .gitignore                      <- .clasprc.json ignored (OAuth credentials)
├── .clasprc.json                   <- created by `clasp login` (local, never commit)
├── appsscript.json                 <- LEGACY/unused; NOT uploaded (see note below)
├── CLASP_DEPLOYMENT.md             <- this guide
├── scripts/
│   └── verify-clasp.ps1            <- repeatable pre-flight validation
└── apps-script/                    <- rootDir: CLASP uploads from here
    ├── .clasp.json                 <- equivalent config for `cd apps-script`
    ├── .claspignore                <- same allowlist, relative to "."
    ├── appsscript.json             <- AUTHORITATIVE manifest that gets pushed
    ├── Code.gs                     <- doGet/doPost entry points
    ├── bootstrap.gs
    ├── config.gs
    ├── constants.gs
    ├── router.gs
    ├── triggers.gs
    ├── data/
    │   └── tables.gs
    ├── repository/
    │   └── sheets-adapter.gs       <- only file that uses SpreadsheetApp
    ├── services/
    │   ├── alert-service.gs
    │   ├── audit-service.gs
    │   ├── auth-service.gs
    │   ├── batch-service.gs
    │   ├── book-service.gs
    │   ├── cheque-service.gs
    │   ├── collection-service.gs
    │   ├── custody-service.gs
    │   ├── customer-master-service.gs
    │   ├── dashboard-service.gs
    │   ├── deposit-service.gs
    │   ├── guarantee-service.gs
    │   ├── movement-service.gs
    │   ├── receipt-service.gs
    │   ├── report-service.gs
    │   ├── state-machine.gs
    │   └── tracking-service.gs
    └── utils/
        ├── errors.gs
        ├── helpers.gs
        └── response.gs
```

**Total: 28 `.gs` files + 1 manifest = 29 files uploaded.** Subfolders are
preserved by CLASP, so Apps Script shows `services/...`, `repository/...`, etc.

> **Note on the root `appsscript.json`:** a second, older manifest exists at the
> repository root (`ANYONE_ANONYMOUS`, `Africa/Cairo`, no `oauthScopes`). It is
> **not used**: `rootDir` is `apps-script`, and `.claspignore` only admits the
> manifest inside `rootDir`. The authoritative manifest is
> `apps-script/appsscript.json`. Delete or align the root copy if you want to
> remove the ambiguity; do not push from a directory that contains it.

---

## B. appsscript.json

Authoritative file: `apps-script/appsscript.json`

```json
{
  "timeZone": "Etc/GMT",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

Why these settings:

| Setting | Reason |
|---|---|
| `runtimeVersion: V8` | Code uses modern JS (`const`, arrow functions, `Object.freeze`) |
| `executeAs: USER_DEPLOYING` | Script runs as you, so it can reach both spreadsheets |
| `access: ANYONE` | Cloudflare Functions must be able to call the Web App; every request is HMAC-signed |
| `spreadsheets` | `SpreadsheetApp.openById()` for the operational + customer master workbooks |
| `script.external_request` | `UrlFetchApp`, used by `Code.gs`/auth helpers |
| `script.scriptapp` | `installDailyScanTrigger()` / `ScriptApp` |

If the spreadsheets live in a Shared Drive, add
`https://www.googleapis.com/auth/drive` to `oauthScopes` and re-push with
`clasp push --force`.

---

## C. .clasp.json template

Repository root — `.clasp.json` (already generated with your existing script ID):

```json
{
  "scriptId": "1eAit884xBXPD0nF5MB8lMlC_JQ-xuaZS3Dzwm1XYRjNKRtGIhKRXUoJr",
  "rootDir": "apps-script",
  "scriptExtensions": [".gs", ".js"],
  "htmlExtensions": [".html"],
  "filePushOrder": [
    "apps-script/constants.gs",
    "apps-script/config.gs",
    "apps-script/data/tables.gs",
    "apps-script/utils/errors.gs",
    "apps-script/utils/helpers.gs",
    "apps-script/utils/response.gs",
    "apps-script/repository/sheets-adapter.gs"
  ],
  "skipSubdirectories": false
}
```

Equivalent `apps-script/.clasp.json` uses `"rootDir": "."` and the same
`filePushOrder` entries **without** the `apps-script/` prefix.

| Field | Meaning |
|---|---|
| `scriptId` | Target Apps Script project. Preserved from the pre-existing config. Replace with your own ID if pointing at a different project. |
| `rootDir` | Only files under this directory are uploaded. This is what prevents `frontend/`, `functions/`, `shared/`, `tests/`, `wrangler.toml`, etc. from being pushed. |
| `scriptExtensions` | `.gs` first so pulls write `.gs` files. |
| `filePushOrder` | Foundational globals (constants, config, tables, utils, adapter) are pushed first; everything else follows alphabetically. |
| `skipSubdirectories: false` | Required so `services/`, `repository/`, `data/`, `utils/` are included. |

Companion `.claspignore` (both locations):

```
**/**
!appsscript.json
!**/*.gs
.git/**
node_modules/**
```

---

## D. Required npm packages

| Requirement | Version / note |
|---|---|
| Node.js | **>= 22** (required by clasp 3.x) |
| npm | Ships with Node 22 |
| `@google/clasp` | `3.4.1` or newer |
| Google Apps Script API | Must be enabled at <https://script.google.com/home/usersettings> |

Install options:

```powershell
# As requested: global install
npm install -g @google/clasp
clasp --version

# Alternative (no global install; pin version locally)
npm install --save-dev @google/clasp@^3.4.1
npx clasp --version
```

No other npm packages are needed for pushing Apps Script. (The root
`package.json` `wrangler` dependency is for the Cloudflare side only.)

---

## E. Required CLASP commands (exact)

### 1. Install CLASP

```powershell
npm install -g @google/clasp
clasp --version
```

### 2. Login

```powershell
clasp login
```

Use a Google account that can edit the Apps Script project and has access to
both spreadsheets. For headless/limited environments:

```powershell
clasp login --no-localhost
clasp show-authorized-user
```

### 3. Create or link the Apps Script project

```powershell
# Already linked: both .clasp.json files contain the scriptId. Nothing to do.

# OPTIONAL - verify the target project is reachable:
clasp list-scripts

# OPTIONAL - link a DIFFERENT existing project (writes a new .clasp.json):
clasp clone-script "<SCRIPT_ID>" --rootDir "apps-script"

# OPTIONAL - create a NEW standalone project (writes a new .clasp.json):
clasp create-script --title "collections-management-phase1" --rootDir "apps-script"
```

> Do **not** run `create-script`/`clone-script` if you want to keep the existing
> script ID — both overwrite `.clasp.json`.

### 4. Set Script ID

The script ID is already set in both `.clasp.json` files. To verify or change:

```powershell
# Verify
Get-Content .clasp.json
Get-Content apps-script\.clasp.json

# Change: edit the "scriptId" value in BOTH files so they stay identical.
# clasp 3.x removed `clasp settings`; on clasp 2.x this alias still works:
#   clasp setting scriptId "<SCRIPT_ID>"
```

Keep the two `scriptId` values identical — `scripts\verify-clasp.ps1` checks this.

### 5. Push all .gs files

```powershell
# Pre-flight: shows exactly the 29 files that will be written to Google
clasp show-file-status

# Upload everything in one operation (force accepts the manifest scope changes)
clasp push --force
```

`clasp push` replaces the remote project contents wholesale. It does **not**
create files one by one; all 28 `.gs` files plus the manifest arrive at once.

### 6. Open the project

```powershell
clasp open-script
```

Older clasp versions: `clasp open`.

### 7. Create a deployment

```powershell
clasp create-deployment --description "Phase 1 initial release"
clasp list-deployments
```

Older clasp versions: `clasp deploy --description "Phase 1 initial release"`.

Copy the resulting `/exec` URL into the Cloudflare Pages secret `GAS_URL`.
Every code change afterwards needs:

```powershell
clasp push --force
clasp create-deployment --description "Phase 1 update"
```

(The `/exec` URL stays the same for subsequent versions.)

### 2.x -> 3.x command mapping

| Your command | clasp 3.x command |
|---|---|
| `clasp create` | `clasp create-script` |
| `clasp clone` | `clasp clone-script` |
| `clasp open` | `clasp open-script` |
| `clasp deploy` | `clasp create-deployment` |
| `clasp settings` | removed (edit `.clasp.json`) |
| `clasp login`, `clasp push` | unchanged |

---

## Validation results (run in this repository)

```
Checked 28 .gs files and 53 global declarations
OK: clasp push will upload exactly the manifest and all .gs files; no duplicate globals
```

Additional checks performed:

- **All `.gs` files uploaded automatically** — `.claspignore` allows `!**/*.gs`
  from `rootDir`, covering every subfolder. `skipSubdirectories: false`.
- **No manual file creation** — nothing needs to be pasted into the editor;
  `clasp push` creates all files and folders in the Apps Script project.
- **`bootstrap.gs` included** — yes.
- **Repository adapter included** — `repository/sheets-adapter.gs`.
- **Services included** — all 17 files in `services/`, including
  `customer-master-service.gs`, `receipt-service.gs`, `collection-service.gs`,
  `cheque-service.gs`, `guarantee-service.gs`, `tracking-service.gs`.
- **Data layer included** — `data/tables.gs` (27 sheet definitions).
- **Entry points present** — `doGet` and `doPost` in `Code.gs`; trigger handlers
  `installDailyScanTrigger` and `dailyScanTrigger` in `triggers.gs`.
- **Duplicate global names** — none (53 unique globals across 28 files).
- **Cross-file globals** — all resolve; the only unmatched uppercase tokens are
  IIFE-local (`HEADER`, `REQUIRED_HEADERS`, `READ_ACTIONS`, `SEARCH_FIELDS`),
  built-ins (`JSON`), or comment text (`SHA256`).

Repeat any time with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-clasp.ps1
```

---

## Deployment checklist

- [ ] Node.js >= 22 and `@google/clasp` installed (`clasp --version`)
- [ ] Apps Script API enabled at <https://script.google.com/home/usersettings>
- [ ] `clasp login` completed with an account able to edit the script + both spreadsheets
- [ ] `scripts\verify-clasp.ps1` passes
- [ ] `clasp show-file-status` lists **exactly 29 files** (28 `.gs` + `appsscript.json`)
- [ ] No `frontend/`, `functions/`, `shared/`, `tests/`, `wrangler.toml` or `package.json` in that list
- [ ] `clasp push --force` succeeds
- [ ] `clasp open-script` shows `services/`, `repository/`, `data/`, `utils/` folders
- [ ] `clasp create-deployment` completed; `/exec` URL saved as CF secret `GAS_URL`
- [ ] Script Properties set (`GAS_SHARED_SECRET`, `CUSTOMER_MASTER_SPREADSHEET_ID`,
      strong `BOOTSTRAP_ADMIN_PASSWORD`) — see `DEPLOYMENT.md`
- [ ] `installDailyScanTrigger()` run once from the editor
- [ ] Root `appsscript.json` left unused or removed (do not push it)

---

## Blockers preventing `clasp push`

| Blocker | Status |
|---|---|
| Root `.clasp.json` had `rootDir: ""` and no ignore file → would have uploaded the entire repository (frontend/functions/shared/tests JS + wrong root manifest) | **FIXED** — `rootDir: "apps-script"` + `.claspignore` |
| Two conflicting `appsscript.json` files | **RESOLVED** — `rootDir` selects `apps-script/appsscript.json`; root copy is unused (cleanup recommended) |
| Undocumented `jsonExtensions: [".json"]` in old config could upload `package.json` | **FIXED** — removed |
| Node/npm/git unavailable in this audit environment | **ENVIRONMENTAL** — could not execute `clasp` here; run on a machine with Node >= 22 |
| Google Apps Script API enabled? | **EXTERNAL** — enable at the usersettings link above |
| Script ID `1eAit…RtGIhKRXUoJr` valid and accessible to the logged-in account? | **EXTERNAL** — verify with `clasp list-scripts` / `clasp open-script` |
| Script Properties / Web App deployment / daily trigger | **POST-PUSH** — required for runtime, not for `clasp push` |
