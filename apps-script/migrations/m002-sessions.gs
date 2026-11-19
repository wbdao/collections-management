/** PHASE 2 / M002 — session store table. */
var M002Sessions = (function () {
  function up() {
    return { sheet: TABLES.sessions.sheet, created: true };
  }
  function verify() {
    return MigrationRunner.ok('sessions');
  }
  return { up: up, verify: verify };
})();
