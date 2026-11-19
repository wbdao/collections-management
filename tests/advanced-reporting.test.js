/** PHASE 2 / Step 8 — advanced reporting: GAS computations + edge permissions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';
import * as edgeReports from '../functions/_lib/modules/reports.js';

/* -------------------------------------------------------------------------- */
/* GAS ReportService (real production source in a VM harness)                  */
/* -------------------------------------------------------------------------- */

function daysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const daysAgo = (n) => daysFromNow(-n);

function harness() {
  const h = loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/audit-service.gs',
    'apps-script/services/report-service.gs'
  ]);
  const s = h.store;

  // Receipts: 4 outstanding (COLLECTED) across two aging buckets and two
  // warehouses, one deposited, one cancelled and one unused.
  s.rows.receipts = [
    { receipt_id: 'R1', collector_id: 'C1', warehouse: 'W1', status: 'COLLECTED',      amount_minor: 1000, collection_date: daysAgo(3) },
    { receipt_id: 'R2', collector_id: 'C1', warehouse: 'W1', status: 'COLLECTED',      amount_minor: 2000, collection_date: daysAgo(20) },
    { receipt_id: 'R3', collector_id: 'C2', warehouse: 'W2', status: 'COLLECTED',      amount_minor: 3000, collection_date: daysAgo(45) },
    { receipt_id: 'R4', collector_id: 'C2', warehouse: 'W2', status: 'COLLECTED',      amount_minor: 4000, collection_date: daysAgo(80) },
    { receipt_id: 'R5', collector_id: 'C1', warehouse: 'W1', status: 'DEPOSITED_HQ',   amount_minor: 5000, collection_date: daysAgo(2) },
    { receipt_id: 'R6', collector_id: 'C1', warehouse: 'W1', status: 'CANCELLED',      amount_minor: 600,  collection_date: daysAgo(1) },
    { receipt_id: 'R7', collector_id: 'C1', warehouse: 'W1', status: 'UNUSED',         amount_minor: 700,  collection_date: '' }
  ];

  s.rows.cheques = [
    { cheque_id: 'CH1', warehouse: 'W1', status: 'PENDING', amount_minor: 1500, due_date: daysAgo(10), cheque_date: daysAgo(40) },
    { cheque_id: 'CH2', warehouse: 'W1', status: 'CLEARED', amount_minor: 2500, due_date: daysAgo(5), cheque_date: daysAgo(30),
      clearing_started_at: `${daysAgo(4)}T00:00:00.000Z`, cleared_at: `${daysAgo(2)}T00:00:00.000Z` }
  ];

  s.rows.guarantees = [
    { guarantee_id: 'G1', warehouse: 'W2', status: 'ACTIVE',   amount_minor: 3500, expiry_date: daysFromNow(10) },
    { guarantee_id: 'G2', warehouse: 'W2', status: 'RELEASED', amount_minor: 4500, expiry_date: daysFromNow(20) }
  ];

  s.rows.custody_balances = [
    { balance_id: 'B1', document_type: 'RECEIPT', holder_id: 'C1', document_count: 2, total_amount_minor: 3000 },
    { balance_id: 'B2', document_type: 'CHEQUE',  holder_id: 'BRANCH_TREASURY', warehouse: 'W1', document_count: 8, total_amount_minor: 8000 }
  ];

  s.rows.book_assignments = [
    { assignment_id: 'A1', assigned_to: 'C1', status: 'ACTIVE' }
  ];

  s.rows.treasuries = [
    { treasury_id: 'TR_HQ', treasury_name: 'HQ Treasury', treasury_type: 'HQ', warehouse: '', status: 'ACTIVE' },
    { treasury_id: 'TR_W1', treasury_name: 'W1 Treasury', treasury_type: 'BRANCH', warehouse: 'W1', status: 'ACTIVE' },
    { treasury_id: 'TR_W2', treasury_name: 'W2 Treasury', treasury_type: 'BRANCH', warehouse: 'W2', status: 'ACTIVE' }
  ];

  s.rows.deposits_branch = [
    { deposit_id: 'D1', warehouse: 'W1', status: 'DRAFT', total_minor: 6000 }
  ];
  s.rows.deposits_hq = [
    { deposit_id: 'D2', status: 'CONFIRMED', total_minor: 5000 }
  ];

  s.rows.reconciliation_exceptions = [
    { exception_id: 'E1', holder_id: 'TR_W1', expected_count: 10, actual_count: 8,
      expected_amount_minor: 10000, actual_amount_minor: 8000, status: 'OPEN' },
    { exception_id: 'E2', holder_id: 'HQ_TREASURY', expected_count: 5, actual_count: 5,
      expected_amount_minor: 5000, actual_amount_minor: 5000, status: 'RESOLVED' }
  ];

  s.settings.audit_chain_last_verified = {
    valid: false, recordsChecked: 10,
    issues: [{ auditId: 'AUD9', type: 'HASH_MISMATCH', detail: 'modified' }],
    firstFailure: { auditId: 'AUD9', type: 'HASH_MISMATCH' },
    checkedAt: '2026-01-01T00:00:00.000Z'
  };
  s.settings.audit_chain_tip = 'abcdtip';
  s.settings.audit_chain_genesis = '0000genesis';

  return h;
}

test('aging() buckets all outstanding receivables by age', () => {
  const report = harness().sandbox.ReportService.aging({});
  assert.deepEqual({ ...report.buckets }, { d0_7: 4500, d8_30: 3500, d31_60: 3000, d60plus: 4000 });
  assert.equal(report.totals.documents, 6);
  assert.equal(report.totals.totalMinor, 15000);
  assert.equal(report.totals.overdueMinor, 7000);
  assert.equal(report.byType.receipts.count, 4);
  assert.equal(report.byType.cheques.count, 1);   // CLEARED excluded
  assert.equal(report.byType.guarantees.count, 1); // RELEASED excluded
  assert.equal(report.byType.guarantees.d0_7, 3500);
});

test('aging() honours warehouse scope and never leaks other units', () => {
  const report = harness().sandbox.ReportService.aging({ warehouseIds: ['W2'] });
  assert.deepEqual({ ...report.buckets }, { d0_7: 3500, d8_30: 0, d31_60: 3000, d60plus: 4000 });
  assert.equal(report.totals.documents, 3); // R3, R4, G1
  assert.equal(report.totals.totalMinor, 10500);
});

test('collectorPerformance() ranks by outstanding cash and flags risk', () => {
  const report = harness().sandbox.ReportService.collectorPerformance({});
  assert.equal(report.totals.collectors, 2);
  assert.equal(report.totals.highRiskCollectors, 1);
  assert.equal(report.totals.cashOutstandingMinor, 10000);
  assert.equal(report.items[0].collectorId, 'C2'); // 7000 outstanding, HIGH risk
  assert.equal(report.items[0].riskFlag, 'HIGH');
  assert.equal(report.items[1].collectorId, 'C1');
  assert.equal(report.items[1].booksOutstanding, 1);
  // cashCollectedMinor is all of C1's receipts (incl. CANCELLED/UNUSED) = 9300.
  assert.equal(report.items[1].depositRate, 5000 / 9300);
});

test('collectorPerformance() restricts a collector to their own receipts', () => {
  const report = harness().sandbox.ReportService.collectorPerformance({ collectorId: 'C1' });
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].collectorId, 'C1');
  assert.equal(report.totals.cashOutstandingMinor, 3000);
});

test('treasuryReconciliation() computes expected vs actual and open exceptions', () => {
  const report = harness().sandbox.ReportService.treasuryReconciliation({});
  const byId = Object.fromEntries(report.items.map((i) => [i.treasuryId, i]));

  assert.equal(byId.TR_W1.status, 'EXCEPTION');
  assert.equal(byId.TR_W1.varianceCount, -2);
  assert.equal(byId.TR_W1.varianceMinor, -2000);
  assert.equal(byId.TR_W1.openExceptions, 1);
  assert.equal(byId.TR_W1.custodyCount, 8);
  assert.equal(byId.TR_W1.custodyMinor, 8000);

  assert.equal(byId.TR_HQ.status, 'OK'); // RESOLVED exception, zero variance
  assert.equal(byId.TR_HQ.openExceptions, 0);
  assert.equal(byId.TR_W2.status, 'OK');

  assert.equal(report.totals.treasuries, 3);
  assert.equal(report.totals.exceptionTreasuries, 1);
  assert.equal(report.totals.varianceMinor, -2000);
  assert.equal(report.openExceptions.length, 1);
  assert.equal(report.openExceptions[0].exception_id, 'E1');
});

test('auditExceptions() reports the stored verify result plus chain status', () => {
  const report = harness().sandbox.ReportService.auditExceptions({});
  assert.equal(report.neverVerified, false);
  assert.equal(report.valid, false);
  assert.equal(report.recordsChecked, 10);
  assert.equal(report.issues[0].type, 'HASH_MISMATCH');
  assert.equal(report.firstFailure.auditId, 'AUD9');
  assert.equal(report.tip, 'abcdtip');
  assert.equal(report.genesis, '0000genesis');
  assert.equal(report.records, 0); // no audit_logs rows seeded
});

test('auditExceptions() degrades safely when verification never ran', () => {
  const h = harness();
  delete h.store.settings.audit_chain_last_verified;
  const report = h.sandbox.ReportService.auditExceptions({});
  assert.equal(report.neverVerified, true);
  assert.equal(report.valid, true);
  assert.equal(report.issues.length, 0);
});

test('kpis() exposes exactly the five documented keys with computed values', () => {
  const report = harness().sandbox.ReportService.kpis({});
  assert.deepEqual(Object.keys(report).filter((k) => k !== 'asOf').sort(), [
    'chequeClearancePerformance', 'collectionEfficiency', 'collectorOutstandingBalances',
    'depositsPending', 'guaranteeRiskExposure'
  ]);

  assert.equal(report.collectionEfficiency.value, Number((15000 / 15700).toFixed(4)));
  assert.equal(report.collectionEfficiency.unit, 'ratio');
  assert.equal(report.collectionEfficiency.issuedMinor, 15700);

  assert.equal(report.depositsPending.value, 5); // 4 collected receipts + 1 draft deposit
  assert.equal(report.depositsPending.totalMinor, 16000);

  assert.equal(report.collectorOutstandingBalances.value, 10000);
  assert.equal(report.collectorOutstandingBalances.collectors, 2);
  assert.equal(report.collectorOutstandingBalances.highRiskCollectors, 1);

  assert.equal(report.chequeClearancePerformance.issued, 2);
  assert.equal(report.chequeClearancePerformance.cleared, 1);
  assert.equal(report.chequeClearancePerformance.overdueCount, 1);
  assert.equal(report.chequeClearancePerformance.averageClearanceDays, 2);

  assert.equal(report.guaranteeRiskExposure.value, 3500);
  assert.equal(report.guaranteeRiskExposure.expiringSoonCount, 1);
  assert.equal(report.guaranteeRiskExposure.expiredCount, 0);
});

/* -------------------------------------------------------------------------- */
/* Edge module — permission enforcement (no fetch needed: guard runs first)    */
/* -------------------------------------------------------------------------- */

const ENV = { GAS_URL: 'https://example.com/exec', GAS_SHARED_SECRET: 'secret' };
const ADMIN = { actor: { userId: 'admin', role: 'ADMIN', permissions: ['*'] } };
const LIMITED = { actor: { userId: 'u1', role: 'COLLECTOR', permissions: ['reports.read'] } };

test('advanced report endpoints require reports.advanced.read', async () => {
  for (const fn of [edgeReports.aging, edgeReports.collectorPerformance,
    edgeReports.treasuryReconciliation]) {
    await assert.rejects(() => fn(ENV, LIMITED, {}), (err) => err.code === 'FORBIDDEN');
  }
});

test('audit-exceptions requires audit.verify (reports.read is not enough)', async () => {
  await assert.rejects(() => edgeReports.auditExceptions(ENV, LIMITED, {}),
    (err) => err.code === 'FORBIDDEN');
  const auditor = { actor: { userId: 'a', role: 'AUDITOR', permissions: ['audit.verify'] } };
  // Guard passes; the call then needs transport, so stub fetch to observe the action.
  const originalFetch = globalThis.fetch;
  let action;
  globalThis.fetch = async (_url, options) => {
    action = JSON.parse(options.body).action;
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: {}, meta: {} }),
      { status: 200 });
  };
  try {
    await edgeReports.auditExceptions(ENV, auditor, {});
    assert.equal(action, 'report.auditExceptions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('kpis requires only reports.read and calls report.kpis', async () => {
  const originalFetch = globalThis.fetch;
  let action;
  globalThis.fetch = async (_url, options) => {
    action = JSON.parse(options.body).action;
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: {}, meta: {} }),
      { status: 200 });
  };
  try {
    await edgeReports.kpis(ENV, LIMITED, {});
    assert.equal(action, 'report.kpis');
    await edgeReports.aging(ENV, ADMIN, {});
    assert.equal(action, 'report.aging');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
