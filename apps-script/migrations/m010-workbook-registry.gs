/**
 * PHASE 2 / M010 — workbook registry migration support.
 *
 * The registry is stored in tbl_settings under `workbook_registry`. All
 * entities default to CORE and `enabled` stays false until an explicit,
 * separately approved cutover. This makes the migration a no-op for live
 * Phase 1 behaviour while providing the mapping SheetsAdapter needs.
 */
var M010WorkbookRegistry = (function () {

  var KEY = 'workbook_registry';

  var PLACEMENT = {
    audit_logs: 'AUDIT', security_events: 'AUDIT', backups: 'AUDIT',
    cheques: 'DOCS', guarantees: 'DOCS', deposits_branch: 'DOCS',
    deposits_hq: 'DOCS', deposit_lines: 'DOCS', movements: 'DOCS', attachments: 'DOCS'
  };

  function up() {
    var existing = SheetsAdapter.getSetting(KEY);
    if (existing && existing.CORE) return { created: false, registry: existing };
    var core = CONFIG.coreSpreadsheetId;
    var registry = {
      CORE: core,
      DOCS: CONFIG.docsSpreadsheetId || core,
      AUDIT: CONFIG.auditSpreadsheetId || core,
      enabled: false,
      entities: {}
    };
    Object.keys(TABLES).forEach(function (entity) {
      registry.entities[entity] = PLACEMENT[entity] || 'CORE';
    });
    SheetsAdapter.setSetting(KEY, registry, 'Entity to workbook placement', 'migration-M010');
    return { created: true, registry: registry };
  }

  function verify() {
    var registry = SheetsAdapter.getSetting(KEY);
    var missing = Object.keys(TABLES).filter(function (entity) { return !registry || !registry.entities[entity]; });
    return {
      ok: !!registry && !!registry.CORE && missing.length === 0,
      missing: missing,
      enabled: registry ? !!registry.enabled : false
    };
  }

  return { up: up, verify: verify, KEY: KEY, PLACEMENT: PLACEMENT };
})();
