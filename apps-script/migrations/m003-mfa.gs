/** PHASE 2 / M003 — MFA columns on tbl_users (appended at end). */
var M003Mfa = (function () {

  function up() {
    var updated = 0;
    SheetsAdapter.readRows('users', { includeDeleted: true }).forEach(function (row) {
      var patch = {};
      if (row.mfa_enabled === undefined || row.mfa_enabled === '') patch.mfa_enabled = false;
      if (row.mfa_secret === undefined || row.mfa_secret === '') patch.mfa_secret = '';
      if (row.locked_until === undefined || row.locked_until === '') patch.locked_until = '';
      if (!Object.keys(patch).length) return;
      var next = Helpers.clone(row);
      delete next._row;
      Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
      SheetsAdapter.writeRowByNumber('users', row._row, next);
      updated++;
    });
    return { usersBackfilled: updated };
  }

  function verify() {
    var columns = MigrationRunner.columnsMatch('users');
    var rows = SheetsAdapter.readRows('users', { includeDeleted: true });
    var blank = rows.filter(function (row) { return row.mfa_enabled === undefined || row.mfa_enabled === ''; });
    return { ok: columns && blank.length === 0, columns: columns, users: rows.length, blankMfaFlags: blank.length };
  }

  return { up: up, verify: verify };
})();
