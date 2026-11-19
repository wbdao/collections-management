/** PHASE 2 / Step 9 — workbook split: service, router, real adapter, edge guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadGs, ROOT } from './helpers/gas-harness.js';
import * as admin from '../functions/_lib/modules/admin.js';

const TABLES = {
  books: { sheet: 'tbl_books' },
  receipts: { sheet: 'tbl_receipts' },
  cheques: { sheet: 'tbl_cheques' },
  audit_logs: { sheet: 'tbl_audit_logs' },
  treasuries: { sheet: 'tbl_treasuries' },
  settings: { sheet: 'tbl_settings' },
  idx_id_map: { sheet: 'tbl_idx_id_map' },
  sequences: { sheet: 'tbl_sequences' },
  processed_requests: { sheet: 'tbl_processed_requests' }
};
const CONFIG = {
  coreSpreadsheetId: 'CORE_ID',
  docsSpreadsheetId: 'DOCS_ID',
  auditSpreadsheetId: 'AUDIT_ID'
};

function serviceHarness() {
  const h = loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/audit-service.gs',
    'apps-script/services/workbook-registry-service.gs',
    'apps-script/router.gs'
  ], { CONFIG, TABLES });

  h.store.settings.workbook_registry = {
    CORE: 'CORE_ID', DOCS: 'DOCS_ID', AUDIT: 'AUDIT_ID',
    enabled: false,
    entities: {
      books: 'CORE', receipts: 'CORE', cheques: 'DOCS', audit_logs: 'AUDIT',
      treasuries: 'CORE', settings: 'CORE'
    }
  };
  h.store.settings['registry.splitEnabled'] = false;
  return h;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                      */
/* -------------------------------------------------------------------------- */

test('status() reports split OFF with all entities resolving to CORE', () => {
  const service = serviceHarness().sandbox.WorkbookRegistryService;
  const status = service.status();
  assert.equal(status.splitEnabled, false);
  assert.equal(status.registryEnabled, false);
  assert.equal(status.policyFlag, false);
  assert.equal(status.consistent, true);
  assert.deepEqual({ ...status.workbooks }, { CORE: 'CORE_ID', DOCS: 'DOCS_ID', AUDIT: 'AUDIT_ID' });
  assert.equal(status.placement.books.workbookId, 'CORE_ID');
  assert.equal(status.placement.cheques.workbookId, 'CORE_ID');   // split off → CORE
  assert.equal(status.placement.audit_logs.workbookId, 'CORE_ID');
  assert.equal(status.placement.settings.workbook, 'CORE');        // pinned
  assert.ok(status.entitiesByWorkbook.DOCS.includes('cheques'));
  assert.ok(status.entitiesByWorkbook.AUDIT.includes('audit_logs'));
});

test('setSplit(true) flips both flags, clears caches, audits, resolves DOCS/AUDIT', () => {
  const h = serviceHarness();
  const ctx = { requestId: 'REQ1', actor: { userId: 'admin', role: 'ADMIN', ip: '1.2.3.4' } };
  const status = h.sandbox.WorkbookRegistryService.setSplit(ctx, true);

  assert.equal(status.splitEnabled, true);
  assert.equal(status.registryEnabled, true);
  assert.equal(status.policyFlag, true);
  assert.equal(status.previousSplitEnabled, false);
  assert.equal(h.store.settings.workbook_registry.enabled, true);
  assert.equal(h.store.settings['registry.splitEnabled'], true);
  assert.equal(status.placement.books.workbookId, 'CORE_ID');
  assert.equal(status.placement.cheques.workbookId, 'DOCS_ID');
  assert.equal(status.placement.audit_logs.workbookId, 'AUDIT_ID');
  assert.equal(status.placement.settings.workbookId, 'CORE_ID'); // pinned even when split on

  const audit = h.store.rows.audit_logs || [];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].operation, 'WORKBOOK_SPLIT_ENABLE');
  assert.equal(audit[0].entity_type, 'settings');
  assert.ok(audit[0].audit_hash); // chained
});

test('setSplit(false) reverts to CORE and audits WORKBOOK_SPLIT_DISABLE', () => {
  const h = serviceHarness();
  const ctx = { requestId: 'REQ2', actor: { userId: 'admin', role: 'ADMIN', ip: '' } };
  h.sandbox.WorkbookRegistryService.setSplit(ctx, true);
  const status = h.sandbox.WorkbookRegistryService.setSplit(ctx, false);

  assert.equal(status.splitEnabled, false);
  assert.equal(status.registryEnabled, false);
  assert.equal(status.policyFlag, false);
  assert.equal(status.placement.cheques.workbookId, 'CORE_ID');
  assert.equal((h.store.rows.audit_logs || []).length, 2);
  assert.equal(h.store.rows.audit_logs[1].operation, 'WORKBOOK_SPLIT_DISABLE');
});

test('status() fails closed when only one flag is on', () => {
  const h = serviceHarness();
  h.store.settings.workbook_registry.enabled = true; // policy flag stays false
  const status = h.sandbox.WorkbookRegistryService.status();
  assert.equal(status.splitEnabled, false);
  assert.equal(status.consistent, false);
  assert.equal(status.placement.cheques.workbookId, 'CORE_ID');
});

test('status() derives defaults when no registry exists yet', () => {
  const h = serviceHarness();
  delete h.store.settings.workbook_registry;
  delete h.store.settings['registry.splitEnabled'];
  const status = h.sandbox.WorkbookRegistryService.status();
  assert.equal(status.splitEnabled, false);
  assert.deepEqual({ ...status.workbooks }, { CORE: 'CORE_ID', DOCS: 'DOCS_ID', AUDIT: 'AUDIT_ID' });
  assert.equal(status.placement.books.workbookId, 'CORE_ID');
});

/* -------------------------------------------------------------------------- */
/* Router ADMIN enforcement                                                      */
/* -------------------------------------------------------------------------- */

test('router: registry.status and registry.setSplit require ADMIN', () => {
  const h = serviceHarness();
  const router = h.sandbox.Router;
  const nonAdmin = { action: 'registry.status', actor: { role: 'COLLECTOR', userId: 'u' } };
  assert.throws(() => router.handle(nonAdmin), (err) => err.code === 'FORBIDDEN');
  const nonAdminWrite = { action: 'registry.setSplit', payload: { enabled: true },
    actor: { role: 'TREASURY', userId: 't' } };
  assert.throws(() => router.handle(nonAdminWrite), (err) => err.code === 'FORBIDDEN');

  const adminStatus = router.handle({ action: 'registry.status', actor: { role: 'ADMIN', userId: 'a' } });
  assert.equal(adminStatus.data.splitEnabled, false);
  const adminWrite = router.handle({ action: 'registry.setSplit', payload: { enabled: true },
    actor: { role: 'ADMIN', userId: 'a' } });
  assert.equal(adminWrite.data.splitEnabled, true);
});

/* -------------------------------------------------------------------------- */
/* Real sheets-adapter.gs — recursion fix + effective workbook resolution       */
/* -------------------------------------------------------------------------- */

function loadRealAdapter(settings) {
  const workbooks = {};
  function makeWorkbook(id) {
    return {
      __id: id,
      getSheetByName(name) {
        if (name === 'tbl_settings') {
          const rows = Object.keys(settings).map((k) => [k, JSON.stringify(settings[k])]);
          return {
            __id: id,
            getLastRow: () => rows.length + 1,
            getRange: () => ({ getValues: () => rows })
          };
        }
        return {
          __id: id,
          getLastRow: () => 1,
          getRange: () => ({ getValues: () => [] }),
          appendRow() {},
          get Protections() { return []; }
        };
      }
    };
  }
  const SpreadsheetApp = {
    ProtectionType: { SHEET: 'SHEET' },
    openById(id) {
      if (!workbooks[id]) workbooks[id] = makeWorkbook(id);
      return workbooks[id];
    }
  };
  const CacheService = { getScriptCache: () => ({
    get: () => null, put() {}, remove() {}
  }) };
  const props = {
    CORE_SPREADSHEET_ID: 'CORE_ID',
    DOCS_SPREADSHEET_ID: 'DOCS_ID',
    AUDIT_SPREADSHEET_ID: 'AUDIT_ID'
  };
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: (key) => (Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null)
  }) };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const Utilities = {
    getUuid: () => 'uuid',
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: () => [],
    base64EncodeWebSafe: () => ''
  };
  const sandbox = {
    console, JSON, Date, Math, Object, Array, String, Number, Boolean,
    SpreadsheetApp, CacheService, PropertiesService, LockService, Utilities
  };
  vm.createContext(sandbox);
  for (const file of [
    'apps-script/constants.gs',
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/config.gs',
    'apps-script/data/tables.gs',
    'apps-script/repository/sheets-adapter.gs'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  return { sandbox, workbooks };
}

const FULL_REGISTRY = {
  CORE: 'CORE_ID', DOCS: 'DOCS_ID', AUDIT: 'AUDIT_ID', enabled: true,
  entities: {
    books: 'CORE', receipts: 'CORE', cheques: 'DOCS', guarantees: 'DOCS',
    audit_logs: 'AUDIT', security_events: 'AUDIT', settings: 'CORE'
  }
};

test('real adapter: workbookIdFor() does not recurse and honours both flags', () => {
  const off = loadRealAdapter({
    workbook_registry: { ...FULL_REGISTRY, enabled: false },
    'registry.splitEnabled': false
  });
  assert.equal(off.sandbox.SheetsAdapter.workbookIdFor('books'), 'CORE_ID');
  assert.equal(off.sandbox.SheetsAdapter.workbookIdFor('cheques'), 'CORE_ID');
  assert.equal(off.sandbox.SheetsAdapter.workbookIdFor('settings'), 'CORE_ID');

  const bothOn = loadRealAdapter({
    workbook_registry: FULL_REGISTRY,
    'registry.splitEnabled': true
  });
  assert.equal(bothOn.sandbox.SheetsAdapter.workbookIdFor('books'), 'CORE_ID');
  assert.equal(bothOn.sandbox.SheetsAdapter.workbookIdFor('cheques'), 'DOCS_ID');
  assert.equal(bothOn.sandbox.SheetsAdapter.workbookIdFor('audit_logs'), 'AUDIT_ID');
  assert.equal(bothOn.sandbox.SheetsAdapter.workbookIdFor('settings'), 'CORE_ID'); // pinned

  const oneFlag = loadRealAdapter({
    workbook_registry: FULL_REGISTRY,
    'registry.splitEnabled': false
  });
  assert.equal(oneFlag.sandbox.SheetsAdapter.workbookIdFor('cheques'), 'CORE_ID'); // fail-closed
});

test('real adapter: getSheet() opens the workbook resolved by the registry', () => {
  const { sandbox, workbooks } = loadRealAdapter({
    workbook_registry: FULL_REGISTRY,
    'registry.splitEnabled': true
  });
  const booksSheet = sandbox.SheetsAdapter.getSheet('books');
  const chequesSheet = sandbox.SheetsAdapter.getSheet('cheques');
  const auditSheet = sandbox.SheetsAdapter.getSheet('audit_logs');
  assert.equal(booksSheet.__id, 'CORE_ID');
  assert.equal(chequesSheet.__id, 'DOCS_ID');
  assert.equal(auditSheet.__id, 'AUDIT_ID');
  assert.ok(workbooks.CORE_ID && workbooks.DOCS_ID && workbooks.AUDIT_ID);
});

/* -------------------------------------------------------------------------- */
/* Edge module guards                                                            */
/* -------------------------------------------------------------------------- */

const ENV = { GAS_URL: 'https://example.com/exec', GAS_SHARED_SECRET: 'secret' };
const ADMIN = { actor: { userId: 'admin', role: 'ADMIN', permissions: ['settings.manage'] } };
const AUDITOR = { actor: { userId: 'a', role: 'AUDITOR', permissions: ['audit.verify'] } };

test('edge: registry endpoints require settings.manage (ADMIN)', async () => {
  await assert.rejects(() => admin.registryStatus(ENV, AUDITOR, {}),
    (err) => err.code === 'FORBIDDEN');
  await assert.rejects(() => admin.registrySetSplit(ENV, AUDITOR, true),
    (err) => err.code === 'FORBIDDEN');
});

test('edge: registryStatus / registrySetSplit forward the right actions', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.action);
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: { splitEnabled: true }, meta: {} }),
      { status: 200 });
  };
  try {
    const result = await admin.registryStatus(ENV, ADMIN);
    assert.equal(result.splitEnabled, true);
    await admin.registrySetSplit(ENV, ADMIN, true);
    assert.deepEqual(calls, ['registry.status', 'registry.setSplit']);
    await assert.rejects(() => admin.registrySetSplit(ENV, ADMIN, 'yes'),
      (err) => err.code === 'VALIDATION_ERROR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
