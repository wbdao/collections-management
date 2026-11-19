/**
 * Configuration for the Apps Script backend.
 *
 * The Phase 1 database is the EXISTING spreadsheet created by the business:
 *   https://docs.google.com/spreadsheets/d/12GyVXdmKlIZUy6evNhQK2IKJjZ8olWtEn6WxuPSunLI/edit
 *
 * That ID is the default so the bootstrap works immediately. Setting the
 * SPREADSHEET_ID Script Property still overrides it (useful for a sandbox copy).
 * The bootstrap never creates a new spreadsheet — it only adds sheets to this one.
 */
var DEFAULT_SPREADSHEET_ID = '12GyVXdmKlIZUy6evNhQK2IKJjZ8olWtEn6WxuPSunLI';

var CONFIG = (function () {
  var props = PropertiesService.getScriptProperties();

  function get(key, fallback) {
    var value = props.getProperty(key);
    return value === null || value === '' ? fallback : value;
  }

  function require(key) {
    var value = props.getProperty(key);
    if (!value) throw new Error('Missing Script Property: ' + key);
    return value;
  }

  return {
    /* ---- Operational database (this app owns it) ------------------------ */
    get spreadsheetId() { return get('SPREADSHEET_ID', DEFAULT_SPREADSHEET_ID); },
    // PHASE 2 (M010): workbook split. Missing DOCS/AUDIT properties fall back
    // to CORE, so a fresh deployment behaves exactly like Phase 1.
    get coreSpreadsheetId() { return get('CORE_SPREADSHEET_ID', get('SPREADSHEET_ID', DEFAULT_SPREADSHEET_ID)); },
    get docsSpreadsheetId() { return get('DOCS_SPREADSHEET_ID', ''); },
    get auditSpreadsheetId() { return get('AUDIT_SPREADSHEET_ID', ''); },
    get sharedSecret() { return require('GAS_SHARED_SECRET'); },
    get adminPassword() { return get('BOOTSTRAP_ADMIN_PASSWORD', 'Admin@12345'); },
    cacheTtlSeconds: 60,
    lockWaitMs: 10000,
    maxRowsPerRead: 20000,
    protocol: 'cms-repo/v1',

    /* ---- Customer master (external, daily-updated, read-only) ---------- */
    // The customer spreadsheet is the system of record. Its ID must be set as
    // a Script Property; the sheet name defaults to the approved Arabic name.
    get customerMasterSpreadsheetId() { return get('CUSTOMER_MASTER_SPREADSHEET_ID', ''); },
    get customerMasterSheetName() { return get('CUSTOMER_MASTER_SHEET_NAME', 'قاعده عملاء الشركه'); },
    customerMasterCacheTtlSeconds: 300,
    customerMasterDefaultSearchLimit: 20,
    customerMasterMaxSearchLimit: 100
  };
})();
