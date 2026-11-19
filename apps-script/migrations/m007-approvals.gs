/** PHASE 2 / M007 — approval workflow table. */
var M007Approvals = (function () {
  function up() {
    return { sheet: TABLES.approvals.sheet, created: true };
  }
  function verify() {
    return MigrationRunner.ok('approvals');
  }
  return { up: up, verify: verify };
})();
