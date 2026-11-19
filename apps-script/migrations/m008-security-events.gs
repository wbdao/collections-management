/** PHASE 2 / M008 — append-only security event log. */
var M008SecurityEvents = (function () {
  function up() {
    return { sheet: TABLES.security_events.sheet, created: true };
  }
  function verify() {
    return MigrationRunner.ok('security_events');
  }
  return { up: up, verify: verify };
})();
