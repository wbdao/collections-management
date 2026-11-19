/**
 * PHASE 2 / M001 — backfill audit_hash / previous_hash for all existing
 * audit records, then anchor the chain tip in tbl_settings.
 */
var M001AuditChain = (function () {

  function up() {
    var genesis = AuditService.genesis();
    SheetsAdapter.setSetting(AuditService.SETTING_GENESIS, genesis,
      'SHA-256 audit chain genesis', 'migration-M001');

    var rows = SheetsAdapter.readRows('audit_logs', { includeDeleted: true });

    // Google Sheets coerces an all-zero hash string to numeric 0. Force plain
    // text on both hash columns before backfilling so the genesis link survives.
    var sheet = SheetsAdapter.getSheet('audit_logs');
    if (sheet && sheet.getLastRow() > 1) {
      ['audit_hash', 'previous_hash'].forEach(function (field) {
        var col = TABLES.audit_logs.columns.indexOf(field) + 1;
        if (col > 0) sheet.getRange(2, col, sheet.getLastRow() - 1, 1).setNumberFormat('@');
      });
    }

    var previous = genesis;
    var updated = 0;
    rows.forEach(function (row) {
      var next = Helpers.clone(row);
      delete next._row;
      next.previous_hash = previous;
      next.audit_hash = AuditService.computeHash(next);
      SheetsAdapter.writeRowByNumber('audit_logs', row._row, next);
      previous = next.audit_hash;
      updated++;
    });
    AuditService.setTip(previous);
    return { backfilled: updated, tip: previous };
  }

  function verify() {
    var result = AuditService.verifyChain();
    return {
      ok: result.valid,
      valid: result.valid,
      recordsChecked: result.recordsChecked,
      issues: result.issues.slice(0, 10)
    };
  }

  return { up: up, verify: verify };
})();
