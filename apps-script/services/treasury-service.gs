/**
 * PHASE 2 / Step 4 — structured treasury master.
 * Denormalised warehouse/department/holder text remains untouched; treasury_id
 * is an additional structured reference resolved from those values.
 */
var TreasuryService = (function () {

  function list(query) {
    query = query || {};
    return SheetsAdapter.readRows('treasuries', {
      where: function (row) {
        if (query.type && row.treasury_type !== query.type) return false;
        if (query.status && row.status !== query.status) return false;
        if (query.warehouse && row.warehouse !== query.warehouse) return false;
        return true;
      },
      orderBy: 'treasury_id',
      descending: false
    });
  }

  function get(id) {
    var row = SheetsAdapter.findRow('treasuries', 'treasury_id', id);
    if (!row) Errors.notFound('treasuries', id);
    return row;
  }

  function create(ctx, data) {
    var id = String(data.treasury_id || '').trim().toUpperCase();
    Errors.assert(/^[A-Z0-9_-]{2,40}$/.test(id), 'VALIDATION_ERROR', 'Invalid treasury_id');
    Errors.assert(!Helpers.isEmpty(data.treasury_name), 'VALIDATION_ERROR', 'treasury_name is required');
    Errors.assert(TREASURY_TYPES.indexOf(data.treasury_type) >= 0,
      'VALIDATION_ERROR', 'Invalid treasury_type');
    if (SheetsAdapter.findRow('treasuries', 'treasury_id', id)) {
      Errors.conflict('Treasury already exists: ' + id);
    }
    var row = SheetsAdapter.insertRow('treasuries', {
      treasury_id: id,
      treasury_name: String(data.treasury_name),
      treasury_type: data.treasury_type,
      warehouse: data.treasury_type === 'BRANCH' ? (data.warehouse || '') : '',
      status: data.status || 'ACTIVE'
    });
    AuditService.write(ctx, {
      operation: 'CREATE', entityType: 'treasuries', entityId: id,
      oldValue: null, newValue: row, result: 'SUCCESS'
    });
    return row;
  }

  function update(ctx, id, patch) {
    var current = get(id);
    Errors.assert(patch.treasury_id === undefined || patch.treasury_id === id,
      'VALIDATION_ERROR', 'treasury_id is immutable');
    var next = Helpers.clone(current);
    delete next._row;
    if (patch.treasury_name !== undefined) next.treasury_name = String(patch.treasury_name);
    if (patch.warehouse !== undefined) next.warehouse = String(patch.warehouse);
    if (patch.status !== undefined) {
      Errors.assert(TREASURY_STATUSES.indexOf(patch.status) >= 0, 'VALIDATION_ERROR', 'Invalid status');
      next.status = patch.status;
    }
    var updated = SheetsAdapter.writeRowByNumber('treasuries', current._row, next);
    AuditService.write(ctx, {
      operation: 'UPDATE', entityType: 'treasuries', entityId: id,
      oldValue: current, newValue: patch, result: 'SUCCESS'
    });
    return updated;
  }

  /** Map legacy CUSTODY_HOLDER_TYPES values to a treasury_id (may be blank). */
  function resolveForLegacy(holder, warehouse) {
    var value = String(holder || '');
    if (value === 'HQ_TREASURY') return 'TR_HQ';
    if (value === 'BRANCH_TREASURY') {
      return typeof M004Treasuries !== 'undefined'
        ? M004Treasuries.branchIdFor(warehouse)
        : 'TR_BRANCH';
    }
    return '';
  }

  function resolveOrDefault(holder, warehouse) {
    return resolveForLegacy(holder, warehouse) || 'TR_BRANCH';
  }

  return {
    list: list, get: get, create: create, update: update,
    resolveForLegacy: resolveForLegacy, resolveOrDefault: resolveOrDefault
  };
})();
