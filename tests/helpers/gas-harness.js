/**
 * Test harness for Apps Script .gs files.
 *
 * Apps Script services cannot be imported by Node (they rely on SpreadsheetApp,
 * Utilities, CacheService, ...). This harness loads the REAL production source
 * into a VM context with deterministic mocks so tests exercise shipped code,
 * not a hand-written copy that could drift out of sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

export function loadGs(relativePaths, extraGlobals = {}) {
  let uuidCounter = 0;
  const store = { settings: {}, rows: {} };
  const securityEvents = [];

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256', SHA_512: 'SHA_512' },
    getUuid() {
      uuidCounter += 1;
      const hex = uuidCounter.toString(16).padStart(32, '0');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    computeDigest(_algorithm, value) {
      // Unsigned bytes 0..255; audit-service.bytesToHex also handles signed bytes.
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest());
    },
    computeHmacSha256Signature(value, key) {
      return Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
    },
    base64EncodeWebSafe(bytes) {
      return Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64url');
    }
  };

  const SheetsAdapter = {
    getSetting(key) {
      return Object.prototype.hasOwnProperty.call(store.settings, key) ? store.settings[key] : null;
    },
    setSetting(key, value) { store.settings[key] = value; },
    readRows(entity, options = {}) {
      let rows = (store.rows[entity] || []).map((row) => ({ ...row }));
      const deleted = (row) => row.is_deleted === true || row.is_deleted === 'TRUE';
      if (!options.includeDeleted) rows = rows.filter((row) => !deleted(row));
      if (options.where) rows = rows.filter(options.where);
      if (options.orderBy) {
        const dir = options.descending === false ? 1 : -1;
        rows.sort((a, b) => {
          const av = a[options.orderBy], bv = b[options.orderBy];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * dir;
        });
      }
      if (options.offset) rows = rows.slice(options.offset);
      if (options.limit) rows = rows.slice(0, options.limit);
      return rows;
    },
    insertRow(entity, row) {
      if (!store.rows[entity]) store.rows[entity] = [];
      const stored = { ...row, _row: store.rows[entity].length + 2 };
      store.rows[entity].push(stored);
      return { ...stored };
    },
    writeRowByNumber(entity, rowNumber, row) {
      const index = rowNumber - 2;
      store.rows[entity][index] = { ...row, _row: rowNumber };
      return { ...store.rows[entity][index] };
    },
    updateRow(entity, id, patch, expectedVersion) {
      const def = sandbox.TABLES ? sandbox.TABLES[entity] : null;
      const idField = def ? def.id : entity.replace(/s$/, '') + '_id';
      const row = (store.rows[entity] || []).find((r) => String(r[idField]) === String(id));
      if (!row) throw new Error(`${entity} not found: ${id}`);
      if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== '' &&
          Number(row.version) !== Number(expectedVersion)) {
        throw new Error('Version conflict');
      }
      const next = { ...row };
      Object.keys(patch || {}).forEach((k) => { next[k] = patch[k]; });
      next.version = Number(row.version || 1) + 1;
      next.updated_at = new Date().toISOString();
      return SheetsAdapter.writeRowByNumber(entity, row._row, next);
    },
    findRow(entity, key, value) {
      return (store.rows[entity] || []).find((row) => String(row[key]) === String(value)) || null;
    },
    softDeleteRow(entity, id, deletedBy) {
      const idField = (sandbox.SOFT_DELETE_ID_FIELDS || {})[entity] ||
        entity.replace(/s$/, '') + '_id';
      const row = (store.rows[entity] || []).find((r) => String(r[idField]) === String(id));
      if (!row) return null;
      return SheetsAdapter.writeRowByNumber(entity, row._row, {
        ...row, is_deleted: true, deleted_at: '2026-01-01T00:00:00.000Z', deleted_by: deletedBy || ''
      });
    },
    nextSequence() { return 1; },
    clearRegistryCache() {},
    withTransaction(fn) { return fn(); }
  };

  const SecurityEventService = {
    write(input) { securityEvents.push(input); return input; },
    list() { return securityEvents.slice(); }
  };

  const sandbox = {
    console, JSON, Date, Math, Object, Array, String, Number, Boolean,
    Utilities, SheetsAdapter, SecurityEventService,
    ...extraGlobals
  };
  vm.createContext(sandbox);

  for (const relativePath of relativePaths) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    vm.runInContext(source, sandbox, { filename: relativePath });
  }

  return {
    sandbox,
    store,
    securityEvents,
    get AuditService() { return sandbox.AuditService; },
    get Errors() { return sandbox.Errors; },
    get Helpers() { return sandbox.Helpers; },
    get MigrationRunner() { return sandbox.MigrationRunner; }
  };
}
