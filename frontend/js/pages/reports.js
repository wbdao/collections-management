/** PHASE 2 / Step 8 — advanced reporting workspace (5 endpoints). */
import { api } from '../api/client.js';
import { can } from '../store.js';
import { card, statCard, table, statusBadge, empty, errorBox, loading } from '../components/ui.js';
import { escapeHtml, on } from '../utils/dom.js';
import { money, num, date, datetime } from '../utils/format.js';

const TABS = [
  { key: 'kpis', label: 'KPIs', endpoint: '/reports/kpis', permission: 'reports.read' },
  { key: 'aging', label: 'Receivables Aging', endpoint: '/reports/aging', permission: 'reports.advanced.read' },
  { key: 'collectors', label: 'Collector Performance', endpoint: '/reports/collector-performance', permission: 'reports.advanced.read' },
  { key: 'treasuries', label: 'Treasury Reconciliation', endpoint: '/reports/treasury-reconciliation', permission: 'reports.advanced.read' },
  { key: 'audit', label: 'Audit Exceptions', endpoint: '/reports/audit-exceptions', permission: 'audit.verify' }
];

const CACHE = {};
let active = 'kpis';

function availableTabs() {
  return TABS.filter((tab) => can(tab.permission));
}

function renderKpis(data) {
  const cards = [
    statCard({
      label: 'Collection efficiency',
      value: `${Math.round(Number(data.collectionEfficiency.value || 0) * 100)}%`,
      sub: `${money(data.collectionEfficiency.collectedMinor)} of ${money(data.collectionEfficiency.issuedMinor)} issued`
    }),
    statCard({
      label: 'Deposits pending',
      value: num(data.depositsPending.value),
      sub: `${num(data.depositsPending.receiptCount)} receipts + ${num(data.depositsPending.depositCount)} deposits`,
      tone: data.depositsPending.value ? 'warn' : ''
    }),
    statCard({
      label: 'Collector outstanding',
      value: money(data.collectorOutstandingBalances.value),
      sub: `${num(data.collectorOutstandingBalances.highRiskCollectors)} high-risk collectors`,
      tone: data.collectorOutstandingBalances.highRiskCollectors ? 'danger' : ''
    }),
    statCard({
      label: 'Cheque clearance',
      value: `${Math.round(Number(data.chequeClearancePerformance.value || 0) * 100)}%`,
      sub: `${num(data.chequeClearancePerformance.overdueCount)} overdue · avg ${data.chequeClearancePerformance.averageClearanceDays ?? '—'} days`
    }),
    statCard({
      label: 'Guarantee risk exposure',
      value: money(data.guaranteeRiskExposure.value),
      sub: `${num(data.guaranteeRiskExposure.expiredCount)} expired · ${num(data.guaranteeRiskExposure.expiringSoonCount)} expiring soon`,
      tone: data.guaranteeRiskExposure.expiredCount ? 'danger' : ''
    })
  ].join('');

  const byCollector = table({
    columns: [
      { key: 'collectorId', label: 'Collector' },
      { key: 'outstandingMinor', label: 'Outstanding', align: 'num', render: (r) => money(r.outstandingMinor) },
      { key: 'riskFlag', label: 'Risk', render: (r) => statusBadge(r.riskFlag) }
    ],
    rows: data.collectorOutstandingBalances.byCollector || [],
    emptyMessage: 'No outstanding collector balances.'
  });

  return `${cards}
    ${card({ title: 'Outstanding by collector', body: byCollector })}
    <p style="font-size:12px;color:var(--color-ink-faint)">As of ${datetime(data.asOf)}</p>`;
}

function renderAging(data) {
  const buckets = data.buckets || {};
  const bucketCards = ['d0_7', 'd8_30', 'd31_60', 'd60plus'].map((key) =>
    statCard({
      label: key === 'd60plus' ? 'Over 60 days' : key.replace('d', '').replace('_', '–') + ' days',
      value: money(buckets[key]),
      tone: key === 'd60plus' ? 'danger' : (key === 'd31_60' ? 'warn' : '')
    })).join('');

  const byType = table({
    columns: [
      { key: 'type', label: 'Receivable' },
      { key: 'count', label: 'Documents', align: 'num' },
      { key: 'totalMinor', label: 'Total', align: 'num', render: (r) => money(r.totalMinor) },
      { key: 'overdue', label: 'Over 30 days', align: 'num', render: (r) => money(Number(r.d31_60 || 0) + Number(r.d60plus || 0)) }
    ],
    rows: Object.keys(data.byType || {}).map((type) => ({ type, ...data.byType[type] })),
    emptyMessage: 'No outstanding receivables.'
  });

  return `${bucketCards}
    ${card({
      title: 'Aging breakdown',
      subtitle: `${num(data.totals.documents)} documents · ${money(data.totals.overdueMinor)} overdue`,
      body: byType
    })}`;
}

function renderCollectors(data) {
  const body = table({
    columns: [
      { key: 'collectorId', label: 'Collector' },
      { key: 'collected', label: 'Collected', align: 'num', render: (r) => num(r.receipts.collected) },
      { key: 'outstanding', label: 'Outstanding', align: 'num', render: (r) => money(r.cashOutstandingMinor) },
      { key: 'booksOutstanding', label: 'Books out', align: 'num' },
      { key: 'depositRate', label: 'Deposit rate', align: 'num', render: (r) => `${Math.round(Number(r.depositRate) * 100)}%` },
      { key: 'riskFlag', label: 'Risk', render: (r) => statusBadge(r.riskFlag) }
    ],
    rows: data.items || [],
    emptyMessage: 'No collector performance data.'
  });
  return card({
    title: 'Collector performance',
    subtitle: `${num(data.totals.collectors)} collectors · ${num(data.totals.highRiskCollectors)} high risk`,
    body
  });
}

function renderTreasuries(data) {
  const body = table({
    columns: [
      { key: 'treasuryId', label: 'Treasury' },
      { key: 'treasuryName', label: 'Name' },
      { key: 'expectedMinor', label: 'Expected', align: 'num', render: (r) => money(r.expectedMinor) },
      { key: 'actualMinor', label: 'Actual', align: 'num', render: (r) => money(r.actualMinor) },
      { key: 'varianceMinor', label: 'Variance', align: 'num', render: (r) => money(r.varianceMinor) },
      { key: 'openExceptions', label: 'Open', align: 'num' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }
    ],
    rows: data.items || [],
    emptyMessage: 'No treasuries configured.'
  });
  return card({
    title: 'Treasury reconciliation',
    subtitle: `${num(data.totals.exceptionTreasuries)} of ${num(data.totals.treasuries)} treasuries with exceptions`,
    body
  });
}

function renderAudit(data) {
  const tone = data.valid ? 'ok' : 'danger';
  const summary = card({
    title: 'Audit chain integrity',
    subtitle: data.neverVerified ? 'No verification has run yet' : `Last checked ${datetime(data.checkedAt)}`,
    body: `
      <div class="row">
        ${statCard({ label: 'Chain valid', value: data.valid ? 'YES' : 'NO', tone })}
        ${statCard({ label: 'Records checked', value: num(data.recordsChecked) })}
        ${statCard({ label: 'Issues', value: num(data.issues.length), tone: data.issues.length ? 'danger' : '' })}
      </div>
      <p style="font-size:12px;color:var(--color-ink-faint)">Tip: ${escapeHtml(data.tip || '—')}</p>`
  });
  const issues = table({
    columns: [
      { key: 'type', label: 'Issue', render: (r) => statusBadge(r.type) },
      { key: 'auditId', label: 'Audit ID' },
      { key: 'at', label: 'Detected at', render: (r) => datetime(r.at) },
      { key: 'detail', label: 'Detail' }
    ],
    rows: data.issues || [],
    emptyMessage: 'No audit chain exceptions detected.'
  });
  return `${summary}${card({ title: 'Detected issues', body: issues })}`;
}

const RENDERERS = {
  kpis: renderKpis,
  aging: renderAging,
  collectors: renderCollectors,
  treasuries: renderTreasuries,
  audit: renderAudit
};

export default {
  title: 'Advanced Reports',
  subtitle: 'Aging, productivity, treasury, audit integrity and headline KPIs',
  permission: 'reports.read',
  async render() {
    const tabs = availableTabs();
    if (!tabs.some((t) => t.key === active)) active = tabs[0]?.key || 'kpis';
    return `
      <div class="stack">
        <div class="tabs" role="tablist">
          ${tabs.map((tab) => `
            <button class="tab ${tab.key === active ? 'active' : ''}" role="tab" data-tab="${tab.key}"
              aria-selected="${tab.key === active}">${escapeHtml(tab.label)}</button>`).join('')}
        </div>
        <div id="report-body">${loading()}</div>
      </div>`;
  },
  async mounted(root) {
    const body = root.querySelector('#report-body');

    async function load() {
      const tab = availableTabs().find((t) => t.key === active);
      if (!tab) { body.innerHTML = empty('No report available for your role.'); return; }
      body.innerHTML = loading(`Loading ${tab.label}…`);
      try {
        if (!CACHE[tab.key]) CACHE[tab.key] = await api.get(tab.endpoint);
        body.innerHTML = RENDERERS[tab.key](CACHE[tab.key]);
      } catch (err) {
        body.innerHTML = errorBox(err.message);
      }
    }

    on(root, 'click', '.tab', (event, button) => {
      active = button.dataset.tab;
      root.querySelectorAll('.tab').forEach((el) => {
        const on = el.dataset.tab === active;
        el.classList.toggle('active', on);
        el.setAttribute('aria-selected', String(on));
      });
      load();
    });

    await load();
  }
};
