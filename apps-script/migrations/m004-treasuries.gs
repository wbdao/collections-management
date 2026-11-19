/**
 * PHASE 2 / M004 — structured treasury master plus additive treasury_id
 * backfill on deposits, cheques, guarantees and movements.
 * Legacy text holder columns are retained; readers fall back to them.
 */
var M004Treasuries = (function () {

  function slug(value) {
    return String(value || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).toUpperCase();
  }

  function branchIdFor(warehouse) {
    return warehouse ? 'TR_BR_' + slug(warehouse) : 'TR_BRANCH';
  }

  function ensureTreasury(id, name, type, warehouse) {
    if (!id) return;
    if (!SheetsAdapter.findRow('treasuries', 'treasury_id', id)) {
      SheetsAdapter.insertRow('treasuries', {
        treasury_id: id,
        treasury_name: name,
        treasury_type: type,
        warehouse: warehouse || '',
        status: 'ACTIVE'
      });
    }
  }

  function collectWarehouses() {
    var found = {};
    ['receipts', 'cheques', 'guarantees'].forEach(function (entity) {
      if (!TABLES[entity]) return;
      SheetsAdapter.readRows(entity).forEach(function (row) {
        if (row.warehouse) found[String(row.warehouse)] = true;
      });
    });
    return Object.keys(found);
  }

  function up() {
    ensureTreasury('TR_HQ', 'HQ Treasury', 'HQ', '');
    ensureTreasury('TR_BRANCH', 'Branch Treasury', 'BRANCH', '');
    var warehouses = collectWarehouses();
    warehouses.forEach(function (warehouse) {
      ensureTreasury(branchIdFor(warehouse), 'Branch Treasury - ' + warehouse, 'BRANCH', warehouse);
    });

    var updated = 0;
    function backfill(entity, resolve) {
      if (!TABLES[entity]) return;
      SheetsAdapter.readRows(entity, { includeDeleted: true }).forEach(function (row) {
        if (row.treasury_id) return;
        var id = resolve(row);
        if (!id) return;
        var next = Helpers.clone(row);
        delete next._row;
        next.treasury_id = id;
        SheetsAdapter.writeRowByNumber(entity, row._row, next);
        updated++;
      });
    }

    function holderToTreasury(holder, warehouse) {
      var value = String(holder || '');
      if (value === 'HQ_TREASURY') return 'TR_HQ';
      if (value === 'BRANCH_TREASURY') return branchIdFor(warehouse);
      return '';
    }

    backfill('cheques', function (row) { return holderToTreasury(row.current_holder, row.warehouse); });
    backfill('guarantees', function (row) { return holderToTreasury(row.current_holder, row.warehouse); });
    backfill('deposits_hq', function () { return 'TR_HQ'; });
    backfill('deposits_branch', function () { return 'TR_BRANCH'; });
    backfill('movements', function (row) { return holderToTreasury(row.to_holder_id, row.warehouse); });

    return {
      treasuriesSeeded: SheetsAdapter.readRows('treasuries').length,
      documentsBackfilled: updated
    };
  }

  function verify() {
    var columns = ['treasuries', 'cheques', 'guarantees', 'deposits_hq', 'deposits_branch', 'movements']
      .every(function (entity) { return MigrationRunner.columnsMatch(entity); });
    return {
      ok: columns,
      columns: columns,
      treasuries: SheetsAdapter.readRows('treasuries').length
    };
  }

  return { up: up, verify: verify, branchIdFor: branchIdFor };
})();
