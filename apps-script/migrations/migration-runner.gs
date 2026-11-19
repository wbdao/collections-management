/**
 * PHASE 2 migration runner.
 *
 * Applies additive, idempotent migrations through the existing SheetsAdapter
 * while the Router holds one LockService transaction. Each migration records
 * its own verify() result in tbl_settings (migration_ledger).
 *
 * Usage (ADMIN actor only, via Router service actions):
 *   migration.run    { only?: ['M001', ...] }
 *   migration.verify { only?: ['M001', ...] }
 *   migration.status
 */
var MigrationRunner = (function () {

  var ORDER = [
    { id: 'M011', name: 'Permissions and policy flags', module: 'M011PermissionsSettings' },
    { id: 'M008', name: 'Security event log', module: 'M008SecurityEvents' },
    { id: 'M001', name: 'Audit hash chain', module: 'M001AuditChain' },
    { id: 'M002', name: 'Sessions', module: 'M002Sessions' },
    { id: 'M003', name: 'MFA columns', module: 'M003Mfa' },
    { id: 'M004', name: 'Treasuries', module: 'M004Treasuries' },
    { id: 'M006', name: 'Notifications', module: 'M006Notifications' },
    { id: 'M005', name: 'Attachments metadata', module: 'M005Attachments' },
    { id: 'M007', name: 'Approvals', module: 'M007Approvals' },
    { id: 'M009', name: 'Backups ledger', module: 'M009Backups' },
    { id: 'M010', name: 'Workbook registry migration', module: 'M010WorkbookRegistry' }
  ];

  var LEDGER_KEY = 'migration_ledger';

  function ledger() {
    return SheetsAdapter.getSetting(LEDGER_KEY) || { applied: [], failed: [] };
  }

  function saveLedger(value) {
    SheetsAdapter.setSetting(LEDGER_KEY, value, 'Phase 2 migration ledger', 'migration-runner');
    SheetsAdapter.clearRegistryCache();
  }

  function isApplied(state, id) {
    return state.applied.some(function (entry) { return entry.id === id && (entry.verified || entry.verifiedAt); });
  }

  function selected(only) {
    if (!only || !only.length) return ORDER;
    return ORDER.filter(function (m) { return only.indexOf(m.id) >= 0; });
  }

  function moduleFor(migration) {
    var mod = globalThis[migration.module];
    if (!mod || typeof mod.up !== 'function' || typeof mod.verify !== 'function') {
      Errors.fail('MIGRATION_ERROR', 'Missing migration module: ' + migration.module);
    }
    return mod;
  }

  function run(ctx, options) {
    options = options || {};
    SheetsAdapter.ensureAllSheets();
    var state = ledger();
    var results = [];

    selected(options.only).forEach(function (migration) {
      if (isApplied(state, migration.id)) {
        results.push({ id: migration.id, skipped: true, verified: true });
        return;
      }
      var startedAt = Helpers.nowIso();
      try {
        var mod = moduleFor(migration);
        var up = mod.up(ctx) || {};
        var verification = mod.verify(ctx) || {};
        if (verification.ok === false) {
          Errors.fail('MIGRATION_ERROR', migration.id + ' verify failed: ' +
            (verification.message || JSON.stringify(verification)));
        }
        state.applied = state.applied.filter(function (e) { return e.id !== migration.id; });
        state.applied.push({
          id: migration.id, name: migration.name, at: startedAt,
          verifiedAt: Helpers.nowIso(), result: up, verification: verification
        });
        state.failed = state.failed.filter(function (e) { return e.id !== migration.id; });
        saveLedger(state);
        results.push({ id: migration.id, ok: true, result: up, verification: verification });
      } catch (err) {
        state.failed = state.failed.filter(function (e) { return e.id !== migration.id; });
        state.failed.push({ id: migration.id, at: startedAt, error: Errors.from(err).message });
        saveLedger(state);
        throw err;
      }
    });

    return { results: results, status: status() };
  }

  function verify(ctx, options) {
    options = options || {};
    var results = [];
    selected(options.only).forEach(function (migration) {
      var mod = moduleFor(migration);
      results.push(Object.assign({ id: migration.id }, mod.verify(ctx) || {}));
    });
    return { results: results, allValid: results.every(function (r) { return r.ok !== false; }) };
  }

  function status() {
    var state = ledger();
    return {
      applied: state.applied.map(function (e) { return { id: e.id, at: e.at, verifiedAt: e.verifiedAt }; }),
      failed: state.failed,
      pending: ORDER.filter(function (m) { return !isApplied(state, m.id); }).map(function (m) { return m.id; })
    };
  }

  /** Header check used by migration verify() functions. */
  function columnsMatch(entity) {
    var expected = TABLES[entity].columns;
    var sheet = SheetsAdapter.getSheet(entity);
    if (!sheet) return false;
    var header = sheet.getRange(1, 1, 1, expected.length).getValues()[0];
    return expected.every(function (column, index) { return header[index] === column; });
  }

  function rows(entity) {
    return SheetsAdapter.readRows(entity, { includeDeleted: true }).length;
  }

  function ok(entity) {
    return { ok: columnsMatch(entity), entity: entity, rows: columnsMatch(entity) ? rows(entity) : 0 };
  }

  return {
    run: run, verify: verify, status: status, ledger: ledger, ORDER: ORDER,
    LEDGER_KEY: LEDGER_KEY, columnsMatch: columnsMatch, rows: rows, ok: ok
  };
})();
