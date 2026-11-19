/**
 * ============================================================================
 * SHEETS ADAPTER — THE ONLY FILE IN THE SYSTEM THAT MAY USE SpreadsheetApp.
 * ============================================================================
 * All other Apps Script services call this adapter. Business modules in
 * Cloudflare Functions call the Repository Interface, never this adapter.
 */
var SheetsAdapter = (function () {
  var SETTINGS_SHEET = 'tbl_settings'; // internal adapter constant, allowed here only
  var registryCacheKey = 'cms_sheet_registry_v1';
  var WORKBOOK_REGISTRY_KEY = 'workbook_registry';
  var SPLIT_FLAG_KEY = 'registry.splitEnabled';
  var workbookCache = {};
  // Internal control tables always live in CORE. Forcing them here prevents a
  // misconfigured registry from moving the very settings sheet that stores the
  // registry (and also breaks the read cycle explained in getSettingDirect()).
  var CORE_ONLY = {
    settings: true, idx_id_map: true, sequences: true, processed_requests: true
  };

  function getSpreadsheet() {
    return SpreadsheetApp.openById(CONFIG.spreadsheetId);
  }

  /** PHASE 2 (M010): open a workbook by id, with a per-script-run cache. */
  function getWorkbook(id) {
    var workbookId = String(id || CONFIG.coreSpreadsheetId);
    if (!workbookCache[workbookId]) {
      workbookCache[workbookId] = SpreadsheetApp.openById(workbookId);
    }
    return workbookCache[workbookId];
  }

  /**
   * Reads a tbl_settings value straight from the CORE sheet, bypassing
   * getSetting()/getSheet(). getSetting() calls findRow('settings') →
   * readRows('settings') → getSheet('settings') → workbookIdFor(), so calling
   * it from workbookIdFor() would recurse forever. Settings are CORE-only, so
   * this direct read is both correct and cycle-free.
   */
  function getSettingDirect(key) {
    var sheet = getWorkbook(CONFIG.coreSpreadsheetId).getSheetByName(SETTINGS_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return null;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === key) return Helpers.fromJson(values[i][1]);
    }
    return null;
  }

  function getWorkbookRegistry() {
    return getSettingDirect(WORKBOOK_REGISTRY_KEY) || null;
  }

  /**
   * Entities stay in CORE until BOTH the registry `enabled` flag and the
   * `registry.splitEnabled` policy flag are true. Requiring both is fail-closed:
   * flipping either flag alone never activates a split. CORE-only control
   * tables are pinned to CORE regardless of the registry.
   */
  function workbookIdFor(entity) {
    if (CORE_ONLY[entity]) return CONFIG.coreSpreadsheetId;
    var registry = getWorkbookRegistry();
    if (!registry || !registry.enabled) return CONFIG.coreSpreadsheetId;
    if (getSettingDirect(SPLIT_FLAG_KEY) !== true) return CONFIG.coreSpreadsheetId;
    var name = (registry.entities && registry.entities[entity]) || 'CORE';
    return registry[name] || CONFIG.coreSpreadsheetId;
  }

  function getCache() {
    return CacheService.getScriptCache();
  }

  /* ------------------------------------------------------------------------
   * EXTERNAL CUSTOMER MASTER — READ ONLY
   * ------------------------------------------------------------------------
   * The customer spreadsheet is a separate, daily-updated workbook owned by
   * the business. It is read here (in the data-access layer) so that business
   * services never touch SpreadsheetApp. Columns are resolved by HEADER TEXT
   * at read time — no fixed column indexes are used anywhere.
   */
  function readCustomerMaster() {
    var spreadsheetId = CONFIG.customerMasterSpreadsheetId;
    if (!spreadsheetId) {
      Errors.fail('CUSTOMER_MASTER_NOT_CONFIGURED',
        'Set Script Property CUSTOMER_MASTER_SPREADSHEET_ID to the customer master spreadsheet ID');
    }

    var sheetName = CONFIG.customerMasterSheetName;
    var ss;
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } catch (e) {
      Errors.fail('CUSTOMER_MASTER_UNAVAILABLE',
        'Cannot open customer master spreadsheet: ' + (e && e.message ? e.message : String(e)));
    }

    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Errors.fail('CUSTOMER_MASTER_SHEET_NOT_FOUND', 'Customer master sheet not found: ' + sheetName);
    }
    if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) {
      return { headers: [], rows: [] };
    }

    var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    var headers = values[0].map(function (h) {
      return String(h === undefined || h === null ? '' : h).trim();
    });

    // Key each data row by its trimmed header text. Column order may change
    // daily without breaking any consumer.
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var record = {};
      var hasData = false;
      for (var j = 0; j < headers.length; j++) {
        if (!headers[j]) continue;
        var value = values[i][j];
        record[headers[j]] = value;
        if (value !== '' && value !== null && value !== undefined) hasData = true;
      }
      if (hasData) rows.push(record);
    }
    return { headers: headers, rows: rows };
  }

  /** sheet_registry lives inside tbl_settings. All entities point to one workbook in Phase 1. */
  function getRegistry() {
    var cached = getCache().get(registryCacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* fall through */ }
    }
    var sheet = getSpreadsheet().getSheetByName(SETTINGS_SHEET);
    var registry = {};
    if (sheet && sheet.getLastRow() > 1) {
      var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
      for (var i = 0; i < values.length; i++) {
        if (values[i][0] === 'sheet_registry') {
          registry = Helpers.fromJson(values[i][1]) || {};
          break;
        }
      }
    }
    var workbookRegistry = getWorkbookRegistry();
    Object.keys(TABLES).forEach(function (entity) {
      if (!registry[entity]) registry[entity] = { sheet: TABLES[entity].sheet, workbookId: CONFIG.spreadsheetId };
      if (workbookRegistry) {
        var name = (workbookRegistry.entities && workbookRegistry.entities[entity]) || 'CORE';
        registry[entity].workbook = name;
        registry[entity].workbookId = workbookIdFor(entity);
      }
    });
    getCache().put(registryCacheKey, JSON.stringify(registry), CONFIG.cacheTtlSeconds);
    return registry;
  }

  function clearRegistryCache() {
    getCache().remove(registryCacheKey);
    workbookCache = {};
  }

  function sheetName(entity) {
    if (!TABLES[entity]) Errors.fail('UNKNOWN_ENTITY', 'Unknown entity: ' + entity);
    var reg = getRegistry();
    return (reg[entity] && reg[entity].sheet) || TABLES[entity].sheet;
  }

  function getSheet(entity) {
    return getWorkbook(workbookIdFor(entity)).getSheetByName(sheetName(entity));
  }

  function tableName(entity) { return TABLES[entity]; }

  function columnIndex(entity, field) {
    return TABLES[entity].columns.indexOf(field);
  }

  var VALIDATION_ROWS = 5000; // data rows covered by dropdown rules (header excluded)

  /**
   * Creates one sheet from its catalog definition and applies the full required
   * structure: exact headers, bold header row, frozen header, auto-sized columns,
   * dropdown validations for status/categorical fields, and sheet protection
   * where required. Safe to re-run — existing sheets are updated in place.
   */
  function createSheet(entity) {
    var ss = getWorkbook(workbookIdFor(entity));
    var name = sheetName(entity);
    var existing = ss.getSheetByName(name);
    var sheet = existing || ss.insertSheet(name);
    var columns = TABLES[entity].columns;

    // 1. Exact headers (replace only when they actually differ).
    var headerRange = sheet.getRange(1, 1, 1, columns.length);
    var header = headerRange.getValues()[0];
    var same = header.length === columns.length && columns.every(function (c, i) { return header[i] === c; });
    if (!same) headerRange.setValues([columns]);

    // Existing, correctly-structured sheets need no further writes. Re-applying
    // 5000-row validation ranges and auto-resize on every bootstrap run is what
    // makes a 27-sheet bootstrap hang for minutes in Apps Script.
    if (existing && same && sheet.getFrozenRows() === 1) return sheet;

    // 2. Bold header row.
    headerRange.setFontWeight('bold');

    // 3. Freeze the header row.
    sheet.setFrozenRows(1);

    // 4. Auto-resize all columns to fit their content.
    sheet.autoResizeColumns(1, columns.length);

    // 5. Dropdown validation on status / categorical columns.
    applyValidations(sheet, entity, columns);

    // 6. Protect append-only / index sheets against manual edits.
    if (PROTECTED_SHEETS.indexOf(name) >= 0) protectSheet(sheet);

    return sheet;
  }

  /** Applies require-value-in-list dropdowns from COLUMN_VALIDATIONS. */
  function applyValidations(sheet, entity, columns) {
    var defs = (typeof COLUMN_VALIDATIONS !== 'undefined') ? COLUMN_VALIDATIONS[entity] : null;
    if (!defs) return;
    Object.keys(defs).forEach(function (field) {
      var col = columns.indexOf(field);
      if (col < 0) return;
      var values = defs[field] || [];
      if (!values.length) return;
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(values, true)
        .setAllowInvalid(false)
        .setHelpText('Select a valid ' + field)
        .build();
      sheet.getRange(2, col + 1, VALIDATION_ROWS, 1).setDataValidation(rule);
    });
  }

  /** Locks a whole sheet; idempotent so repeated bootstrap runs do not stack protections. */
  function protectSheet(sheet) {
    try {
      var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      if (existing && existing.length) return existing[0];
    } catch (e) { /* enum unavailable in this context — fall through to protect() */ }
    var protection = sheet.protect();
    protection.setWarningOnly(false);
    return protection;
  }

  function ensureAllSheets() {
    Object.keys(TABLES).forEach(function (entity) { createSheet(entity); });
    clearRegistryCache();
  }

  function rowToObject(entity, values, rowNumber) {
    var obj = {};
    TABLES[entity].columns.forEach(function (col, i) { obj[col] = values[i]; });
    obj._row = rowNumber;
    return obj;
  }

  function objectToRow(entity, obj) {
    return TABLES[entity].columns.map(function (col) {
      var v = obj[col];
      return v === undefined || v === null ? '' : v;
    });
  }

  function readRows(entity, options) {
    var opts = options || {};
    var sheet = getSheet(entity);
    if (!sheet || sheet.getLastRow() < 2) return [];
    var width = TABLES[entity].columns.length;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
    var rows = [];
    for (var i = 0; i < values.length; i++) {
      var obj = rowToObject(entity, values[i], i + 2);
      var deleted = obj.is_deleted === true || obj.is_deleted === 'TRUE';
      if (deleted && !opts.includeDeleted) continue;
      if (opts.where && !opts.where(obj)) continue;
      rows.push(obj);
    }
    if (opts.orderBy) {
      var dir = opts.descending === false ? 1 : -1;
      rows.sort(function (a, b) {
        var av = a[opts.orderBy], bv = b[opts.orderBy];
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });
    }
    if (opts.offset) rows = rows.slice(opts.offset);
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  }

  function readRowByNumber(entity, rowNumber) {
    var sheet = getSheet(entity);
    if (!sheet) return null;
    var values = sheet.getRange(rowNumber, 1, 1, TABLES[entity].columns.length).getValues()[0];
    return rowToObject(entity, values, rowNumber);
  }

  function writeRowByNumber(entity, rowNumber, obj) {
    var sheet = getSheet(entity);
    sheet.getRange(rowNumber, 1, 1, TABLES[entity].columns.length).setValues([objectToRow(entity, obj)]);
    return rowToObject(entity, TABLES[entity].columns.map(function (c) { return obj[c]; }), rowNumber);
  }

  function findRow(entity, field, value, options) {
    var opts = options || {};
    var rows = readRows(entity, { includeDeleted: !!opts.includeDeleted });
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][field]) === String(value)) return rows[i];
    }
    return null;
  }

  function assertUnique(entity, data, excludeId) {
    var def = TABLES[entity];
    def.unique.forEach(function (field) {
      if (Helpers.isEmpty(data[field])) return;
      var rows = readRows(entity, { includeDeleted: true });
      for (var i = 0; i < rows.length; i++) {
        if (excludeId && String(rows[i][def.id]) === String(excludeId)) continue;
        if (String(rows[i][field]) === String(data[field])) {
          Errors.fail('DUPLICATE_KEY', field + ' already exists: ' + data[field]);
        }
      }
    });
  }

  function insertRow(entity, data) {
    var def = TABLES[entity];
    assertUnique(entity, data, null);
    var row = Helpers.clone(data || {});
    var ts = Helpers.nowIso();
    if (!row[def.id]) row[def.id] = Helpers.id(entity.slice(0, 3).toUpperCase());
    if (def.versioned && Helpers.isEmpty(row.version)) row.version = 1;
    if (def.columns.indexOf('created_at') >= 0 && Helpers.isEmpty(row.created_at)) row.created_at = ts;
    if (def.columns.indexOf('updated_at') >= 0 && Helpers.isEmpty(row.updated_at)) row.updated_at = ts;
    if (def.softDelete) {
      if (Helpers.isEmpty(row.is_deleted)) row.is_deleted = false;
      if (Helpers.isEmpty(row.deleted_at)) row.deleted_at = '';
      if (Helpers.isEmpty(row.deleted_by)) row.deleted_by = '';
    }
    def.columns.forEach(function (c) {
      if (Helpers.isEmpty(row[c])) row[c] = '';
    });
    var sheet = getSheet(entity);
    sheet.appendRow(objectToRow(entity, row));
    var newRowNumber = sheet.getLastRow();
    updateIdMap(String(row[def.id]), sheetName(entity), newRowNumber);
    return rowToObject(entity, TABLES[entity].columns.map(function (c) { return row[c]; }), newRowNumber);
  }

  /** Bulk append used for auto-generated receipt ranges. Applies defaults per row. */
  function insertRows(entity, rows) {
    if (!rows || !rows.length) return [];
    var def = TABLES[entity];
    var ts = Helpers.nowIso();
    var prepared = rows.map(function (input) {
      var row = Helpers.clone(input || {});
      if (!row[def.id]) row[def.id] = Helpers.id(entity.slice(0, 3).toUpperCase());
      if (def.versioned && Helpers.isEmpty(row.version)) row.version = 1;
      if (def.columns.indexOf('created_at') >= 0 && Helpers.isEmpty(row.created_at)) row.created_at = ts;
      if (def.columns.indexOf('updated_at') >= 0 && Helpers.isEmpty(row.updated_at)) row.updated_at = ts;
      if (def.softDelete) {
        if (Helpers.isEmpty(row.is_deleted)) row.is_deleted = false;
        if (Helpers.isEmpty(row.deleted_at)) row.deleted_at = '';
        if (Helpers.isEmpty(row.deleted_by)) row.deleted_by = '';
      }
      return def.columns.map(function (c) { return Helpers.isEmpty(row[c]) ? '' : row[c]; });
    });
    var sheet = getSheet(entity);
    var start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, prepared.length, def.columns.length).setValues(prepared);
    return prepared.map(function (values, i) { return rowToObject(entity, values, start + i); });
  }

  function updateRow(entity, id, patch, expectedVersion) {
    var def = TABLES[entity];
    if (def.appendOnly) Errors.fail('APPEND_ONLY', entity + ' is append-only');
    var row = findRow(entity, def.id, id);
    if (!row) Errors.notFound(entity, id);
    if (def.versioned && expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '') {
      if (Number(row.version) !== Number(expectedVersion)) Errors.version();
    }
    var next = Helpers.clone(row);
    delete next._row;
    Object.keys(patch || {}).forEach(function (k) {
      if (def.columns.indexOf(k) >= 0) next[k] = patch[k];
    });
    if (def.versioned) next.version = Number(row.version || 1) + 1;
    if (def.columns.indexOf('updated_at') >= 0) next.updated_at = Helpers.nowIso();
    assertUnique(entity, next, id);
    return writeRowByNumber(entity, row._row, next);
  }

  function softDeleteRow(entity, id, deletedBy) {
    return updateRow(entity, id, {
      is_deleted: true,
      deleted_at: Helpers.nowIso(),
      deleted_by: deletedBy || ''
    });
  }

  /** Upsert for small config/index tables keyed by a non-generated field. */
  function upsert(entity, keyField, keyValue, data) {
    var row = findRow(entity, keyField, keyValue);
    if (!row) return insertRow(entity, Object.assign({}, data, { [keyField]: keyValue }));
    var patch = Helpers.clone(data);
    delete patch[keyField];
    return updateRow(entity, row[TABLES[entity].id], patch);
  }

  function updateIdMap(publicId, sheet, rowNumber) {
    var sheetObj = getSheet('idx_id_map');
    if (!sheetObj) return;
    var existing = findRow('idx_id_map', 'public_id', publicId);
    if (existing) {
      sheetObj.getRange(existing._row, 3, 1, 2).setValues([[rowNumber, Helpers.nowIso()]]);
    } else {
      sheetObj.appendRow([publicId, sheet, rowNumber, Helpers.nowIso()]);
    }
  }

  function nextSequence(name) {
    var row = findRow('sequences', 'name', name);
    var next = row ? Number(row.next_value || 1) : 1;
    var value = next;
    if (row) {
      getSheet('sequences').getRange(row._row, 2, 1, 2).setValues([[next + 1, Helpers.nowIso()]]);
    } else {
      insertRow('sequences', { name: name, next_value: next + 1, updated_at: Helpers.nowIso() });
    }
    return value;
  }

  function getSetting(key) {
    var row = findRow('settings', 'key', key);
    return row ? Helpers.fromJson(row.value_json) : null;
  }

  function setSetting(key, value, description, updatedBy) {
    return upsert('settings', 'key', key, {
      value_json: Helpers.toJson(value),
      description: description || '',
      updated_by: updatedBy || 'system',
      updated_at: Helpers.nowIso()
    });
  }

  /** Executes fn inside one Apps Script LockService transaction. */
  function withTransaction(fn) {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(CONFIG.lockWaitMs);
      return fn();
    } catch (err) {
      throw err;
    } finally {
      try { lock.releaseLock(); } catch (e) { /* ignore */ }
    }
  }

  return {
    getSpreadsheet: getSpreadsheet,
    getWorkbook: getWorkbook,
    getWorkbookRegistry: getWorkbookRegistry,
    workbookIdFor: workbookIdFor,
    readCustomerMaster: readCustomerMaster,
    getRegistry: getRegistry,
    clearRegistryCache: clearRegistryCache,
    sheetName: sheetName,
    getSheet: getSheet,
    tableName: tableName,
    columnIndex: columnIndex,
    createSheet: createSheet,
    ensureAllSheets: ensureAllSheets,
    readRows: readRows,
    readRowByNumber: readRowByNumber,
    writeRowByNumber: writeRowByNumber,
    findRow: findRow,
    insertRow: insertRow,
    insertRows: insertRows,
    updateRow: updateRow,
    softDeleteRow: softDeleteRow,
    upsert: upsert,
    updateIdMap: updateIdMap,
    nextSequence: nextSequence,
    getSetting: getSetting,
    getSettingDirect: getSettingDirect,
    setSetting: setSetting,
    withTransaction: withTransaction
  };
})();
