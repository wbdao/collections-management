/** PHASE 2 / M011 — additive permissions, role grants and policy flags. */
var M011PermissionsSettings = (function () {

  var DEFAULTS = {
    'audit.chainEnabled': true,
    // Refresh must ship ON: 15-minute access tokens are unusable without it.
    // The other behaviour-changing flags (MFA, approvals, split) stay off.
    'auth.refreshEnabled': true,
    'auth.mfa.enforce': false,
    'auth.mfa.requiredRoles': ['ADMIN', 'TREASURY'],
    'treasury.enforce': false,
    'notifications.enabled': true,
    'approvals.enabled': false,
    'registry.splitEnabled': false,
    'security.perIpLimit': 300,
    'security.perUserLimit': 120,
    'report.kpisEnabled': true
  };

  function up() {
    var permissionsCreated = Bootstrap.seedPermissions();
    var settingsCreated = 0;
    Object.keys(DEFAULTS).forEach(function (key) {
      if (SheetsAdapter.getSetting(key) === null) {
        SheetsAdapter.setSetting(key, DEFAULTS[key], 'Phase 2 policy flag', 'migration-M011');
        settingsCreated++;
      }
    });
    return { permissionsCreated: permissionsCreated, settingsCreated: settingsCreated };
  }

  function verify() {
    var missing = Object.keys(DEFAULTS).filter(function (key) {
      return SheetsAdapter.getSetting(key) === null;
    });
    return {
      ok: missing.length === 0,
      missing: missing,
      flags: Object.keys(DEFAULTS).length
    };
  }

  return { up: up, verify: verify, DEFAULTS: DEFAULTS };
})();
