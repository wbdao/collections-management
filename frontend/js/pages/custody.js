/** Custody workspace: balances, immutable ledger, and reconciliation exceptions. */
import { api } from '../api/client.js';
import { card, tabs, table, statusBadge, loading, errorBox } from '../components/ui.js';
import { money, num, datetime } from '../utils/format.js';
import { on } from '../utils/dom.js';

let activeTab = 'balances';

const TAB_ITEMS = [
  { key: 'balances', label: 'Balances' },
  { key: 'ledger', label: 'Ledger' },
  { key: 'exceptions', label: 'Exceptions' }
];

async function panel(which) {
  try {
    if (which === 'balances') {
      const rows = await api.get('/custody/balances');
      return card({
        title: 'Custody balances',
        subtitle: 'Auto-calculated from the append-only custody ledger',
        body: table({
          columns: [
            { key: 'holder_id', label: 'Holder' },
            { key: 'document_type', label: 'Document', render: (r) => statusBadge(r.document_type) },
            { key: 'document_count', label: 'Count', align: 'num', render: (r) => num(r.document_count) },
            { key: 'total_amount_minor', label: 'Amount', align: 'num', render: (r) => money(r.total_amount_minor) },
            { key: 'balance_status', label: 'Status', render: (r) => statusBadge(r.balance_status) },
            { key: 'calculated_at', label: 'Calculated', render: (r) => datetime(r.calculated_at) }
          ],
          rows: Array.isArray(rows) ? rows : (rows.items || []),
          emptyMessage: 'No custody balances yet.'
        })
      });
    }

    if (which === 'ledger') {
      const rows = await api.get('/custody/ledger');
      return card({
        title: 'Custody ledger',
        subtitle: 'Every custody action produces an immutable entry',
        body: table({
          columns: [
            { key: 'occurred_at', label: 'When', render: (r) => datetime(r.occurred_at) },
            { key: 'holder_id', label: 'Holder' },
            { key: 'document_type', label: 'Document', render: (r) => statusBadge(r.document_type) },
            { key: 'event_type', label: 'Event' },
            { key: 'direction', label: 'Dir', render: (r) => statusBadge(r.direction) },
            { key: 'count_delta', label: 'Δ Count', align: 'num' },
            { key: 'amount_minor_delta', label: 'Δ Amount', align: 'num', render: (r) => money(r.amount_minor_delta) },
            { key: 'balance_amount_after', label: 'Balance', align: 'num', render: (r) => money(r.balance_amount_after) }
          ],
          rows: Array.isArray(rows) ? rows : (rows.items || []),
          emptyMessage: 'No ledger entries yet.'
        })
      });
    }

    const rows = await api.get('/custody/exceptions');
    return card({
      title: 'Reconciliation exceptions',
      subtitle: 'Generated automatically whenever a variance is detected',
      body: table({
        columns: [
          { key: 'detected_at', label: 'Detected', render: (r) => datetime(r.detected_at) },
          { key: 'holder_id', label: 'Holder' },
          { key: 'document_type', label: 'Document', render: (r) => statusBadge(r.document_type) },
          { key: 'expected_count', label: 'Expected', align: 'num' },
          { key: 'actual_count', label: 'Actual', align: 'num' },
          { key: 'expected_amount_minor', label: 'Exp. amount', align: 'num', render: (r) => money(r.expected_amount_minor) },
          { key: 'actual_amount_minor', label: 'Act. amount', align: 'num', render: (r) => money(r.actual_amount_minor) },
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }
        ],
        rows: Array.isArray(rows) ? rows : (rows.items || []),
        emptyMessage: 'No reconciliation exceptions. All balances match.'
      })
    });
  } catch (err) {
    return errorBox(`Unable to load custody data: ${err.message}`);
  }
}

export default {
  title: 'Custody',
  subtitle: 'Collector balances, ledger and reconciliation',
  permission: 'custody.read',
  async render() {
    return `<div class="stack">
      ${tabs(TAB_ITEMS, activeTab)}
      <div id="custody-panel">${loading()}</div>
    </div>`;
  },
  async mounted(root) {
    const panelRoot = root.querySelector('#custody-panel');
    if (panelRoot) panelRoot.innerHTML = await panel(activeTab);

    on(root, 'click', '[data-tab]', async (event, target) => {
      activeTab = target.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((node) => {
        const isActive = node.dataset.tab === activeTab;
        node.classList.toggle('active', isActive);
        node.setAttribute('aria-selected', String(isActive));
      });
      panelRoot.innerHTML = loading();
      panelRoot.innerHTML = await panel(activeTab);
    });
  }
};
