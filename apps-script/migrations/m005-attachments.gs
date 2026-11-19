/**
 * PHASE 2 / M005 — attachment metadata table.
 * The schema lives in tables.gs (which Bootstrap creates); this migration
 * backfills the appended Phase 6 columns on any pre-existing rows so the
 * soft-delete flags and audit metadata always have deterministic defaults.
 */
var M005Attachments = (function () {

  function up() {
    var updated = 0;
    SheetsAdapter.readRows('attachments', { includeDeleted: true }).forEach(function (row) {
      var patch = {};
      if (row.content_type === undefined || row.content_type === '') patch.content_type = 'application/octet-stream';
      if (row.size_bytes === undefined || row.size_bytes === '') patch.size_bytes = 0;
      if (row.checksum === undefined || row.checksum === '') patch.checksum = '';
      if (row.is_deleted === undefined || row.is_deleted === '') patch.is_deleted = false;
      if (row.deleted_at === undefined || row.deleted_at === '') patch.deleted_at = '';
      if (row.deleted_by === undefined || row.deleted_by === '') patch.deleted_by = '';
      if (!Object.keys(patch).length) return;
      var next = Helpers.clone(row);
      delete next._row;
      Object.keys(patch).forEach(function (key) { next[key] = patch[key]; });
      SheetsAdapter.writeRowByNumber('attachments', row._row, next);
      updated++;
    });
    return { sheet: TABLES.attachments.sheet, created: true, rowsBackfilled: updated };
  }

  function verify() {
    return MigrationRunner.ok('attachments');
  }

  return { up: up, verify: verify };
})();
