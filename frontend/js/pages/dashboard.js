/** Dashboard: operational summary + live custody snapshot. */
import { api } from '../api/client.js';
import { card, statCard, table, badge, errorBox } from '../components/ui.js';
import { money, num, datetime } from '../utils/format.js';
import { escapeHtml } from '../utils/dom.js';

export default {
  title: 'Dashboard',
  subtitle: 'Operational overview',
  permission: 'dashboard.read',
  async render() {
    try {
      const [summary, custody] = await Promise.all([
        api.get('/dashboard/summary'),
        api.get('/dashboard/custody')
      ]);

      const books = summary.books || {};
      const collections = summary.collections || {};
      const cheques = summary.cheques || {};
      const guarantees = summary.guarantees || {};

      const stats = `
        <div class="grid grid-4">
          ${statCard({ label: 'Books available', value: num(books.available), sub: `${num(books.total)} total`, tone: 'primary' })}
          ${statCard({ label: 'Books with collectors', value: num(books.assigned), sub: `${num(books.completed)} completed`, tone: 'info' })}
          ${statCard({ label: 'Collected today', value: money(collections.todayMinor), sub: `${money(collections.monthMinor)} this month`, tone: 'success' })}
          ${statCard({ label: 'Pending deposit', value: money(collections.pendingMinor), sub: `${money(collections.depositedMinor)} deposited`, tone: 'warning' })}
        </div>`;

      const stageRows = Object.entries(custody.cashInCustody?.byStage || {}).map(([stage, value]) => ({
        stage: stage.replace(/_/g, ' '), value: money(value)
      }));

      const custodyCards = `
        <div class="grid grid-3">
          ${card({
            title: 'Cash in custody',
            subtitle: `As of ${datetime(custody.asOf)}`,
            body: `
              <div class="stat-value" style="font-size:22px">${money(custody.cashInCustody?.totalMinor)}</div>
              <div style="margin-top:12px">${table({
                columns: [
                  { key: 'stage', label: 'Stage' },
                  { key: 'value', label: 'Amount', align: 'num', render: (r) => escapeHtml(r.value) }
                ],
                rows: stageRows,
                emptyMessage: 'No cash stages recorded.'
              })}</div>`
          })}
          ${card({
            title: 'Documents in custody',
            body: `
              <dl class="kv">
                <dt>Books</dt><dd>${num(custody.booksInCustody?.total)}</dd>
                <dt>Cheques</dt><dd>${num(custody.chequesInCustody?.count)} (${money(custody.chequesInCustody?.totalMinor)})</dd>
                <dt>Guarantees</dt><dd>${num(custody.guaranteesInCustody?.count)} (${money(custody.guaranteesInCustody?.totalMinor)})</dd>
                <dt>Open exceptions</dt><dd>${num(custody.balanceExceptions)}</dd>
              </dl>`
          })}
          ${card({
            title: 'Alert watch',
            body: `
              <dl class="kv">
                <dt>Overdue cheques</dt><dd>${num(cheques.overdueCount)}</dd>
                <dt>Expiring guarantees</dt><dd>${num(guarantees.expiringCount)}</dd>
                <dt>Books lost</dt><dd>${num(books.lost)}</dd>
                <dt>Custody exceptions</dt><dd>${num(custody.balanceExceptions)}</dd>
              </dl>`
          })}
        </div>`;

      const movementRows = (summary.recentMovements || []).map((m) => ({
        when: datetime(m.movement_date),
        type: m.document_type,
        number: m.document_number || m.document_id,
        from: m.from_location || '—',
        to: m.to_location || '—',
        reason: m.reason || '—'
      }));

      const recentCard = card({
        title: 'Recent movements',
        subtitle: 'Latest 10 status transfers across all document types',
        body: table({
          columns: [
            { key: 'when', label: 'When', render: (r) => escapeHtml(r.when) },
            { key: 'type', label: 'Type', render: (r) => badge(r.type, 'primary') },
            { key: 'number', label: 'Number' },
            { key: 'from', label: 'From', render: (r) => escapeHtml(r.from) },
            { key: 'to', label: 'To', render: (r) => escapeHtml(r.to) },
            { key: 'reason', label: 'Reason' }
          ],
          rows: movementRows,
          emptyMessage: 'No movements recorded yet.'
        })
      });

      return `<div class="stack">${stats}${custodyCards}${recentCard}</div>`;
    } catch (err) {
      return errorBox(`Unable to load dashboard data: ${err.message}`);
    }
  }
};
