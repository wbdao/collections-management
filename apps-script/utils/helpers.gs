/** Common helpers shared by Apps Script services. No SpreadsheetApp access here. */

var Helpers = (function () {
  function nowIso() {
    return new Date().toISOString();
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function id(prefix) {
    var uuid = Utilities.getUuid().replace(/-/g, '');
    return prefix + '_' + uuid.slice(0, 20).toUpperCase();
  }

  function sequence(prefix) {
    return SheetsAdapter.nextSequence(prefix);
  }

  function clone(value) {
    return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
  }

  function isEmpty(value) {
    return value === undefined || value === null || value === '';
  }

  function toJson(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  function fromJson(value) {
    if (isEmpty(value)) return null;
    try { return JSON.parse(value); } catch (e) { return value; }
  }

  function changedFields(oldRow, newRow) {
    var changed = [];
    var keys = {};
    Object.keys(oldRow || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(newRow || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      var a = oldRow ? oldRow[k] : undefined;
      var b = newRow ? newRow[k] : undefined;
      if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
    });
    return changed;
  }

  function daysUntil(dateIso) {
    if (isEmpty(dateIso)) return null;
    var target = new Date(String(dateIso).slice(0, 10) + 'T00:00:00Z').getTime();
    var today = new Date(todayIso() + 'T00:00:00Z').getTime();
    return Math.round((target - today) / 86400000);
  }

  function normalizeWhitespace(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function assert(condition, code, message) {
    if (!condition) {
      var err = new Error(message || code);
      err.code = code;
      throw err;
    }
  }

  return {
    nowIso: nowIso,
    todayIso: todayIso,
    id: id,
    sequence: sequence,
    clone: clone,
    isEmpty: isEmpty,
    toJson: toJson,
    fromJson: fromJson,
    changedFields: changedFields,
    daysUntil: daysUntil,
    normalizeWhitespace: normalizeWhitespace,
    assert: assert
  };
})();
