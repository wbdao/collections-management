/** PHASE 2 / M009 — backup ledger table. */
var M009Backups = (function () {
  function up() {
    return { sheet: TABLES.backups.sheet, created: true };
  }
  function verify() {
    return MigrationRunner.ok('backups');
  }
  return { up: up, verify: verify };
})();
