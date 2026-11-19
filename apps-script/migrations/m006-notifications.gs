/** PHASE 2 / M006 — in-app notification table. */
var M006Notifications = (function () {
  function up() {
    return { sheet: TABLES.notifications.sheet, created: true };
  }
  function verify() {
    return MigrationRunner.ok('notifications');
  }
  return { up: up, verify: verify };
})();
