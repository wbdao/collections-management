/** PHASE 2 / Step 7 — approval queue. */
import { api } from '../api/client.js';
import { can } from '../store.js';
import { card, empty, statusBadge } from '../components/ui.js';
import { escapeHtml, on, valueOf } from '../utils/dom.js';

let status = 'PENDING_APPROVAL';

function statusOptions(selected) {
  return ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].map((value) =>
    `<option value="${value}" ${selected === value ? 'selected' : ''}>${value}</option>`).join('');
}

function rowsHtml(items) {
  if (!items || !items.length) return empty('No approval requests in this view.');
  return `
    <table class="table">
      <thead><tr><th>Request</th><th>Document</th><th>Action</th><th>Requested by</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${items.map((item) => `
          <tr>
            <td>${escapeHtml(item.approval_id)}</td>
            <td>${escapeHtml(item.entity_type)} / ${escapeHtml(item.entity_id)}</td>
            <td>${escapeHtml(item.action)}</td>
            <td>${escapeHtml(item.requested_by)}</td>
            <td>${statusBadge(item.status)}</td>
            <td class="row">
              ${item.status === 'PENDING_APPROVAL' && can('approvals.decide') ? `
                <button class="btn btn-sm btn-primary js-approve" data-id="${escapeHtml(item.approval_id)}">Approve</button>
                <button class="btn btn-sm btn-ghost js-reject" data-id="${escapeHtml(item.approval_id)}">Reject</button>` : ''}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

export default {
  title: 'Approvals',
  subtitle: 'Sensitive transition approval queue',
  permission: 'approvals.read',
  async render() {
    return `
      <div class="stack">
        ${card({
          title: 'Filter',
          subtitle: 'Requests are scoped to your assigned documents',
          body: `
            <div class="row">
              <div class="field"><label for="approval-status">Status</label>
                <select id="approval-status">${statusOptions(status)}</select></div>
              <button class="btn" id="approval-refresh" type="button">Refresh</button>
            </div>`
        })}
        <div id="approval-results">${rowsHtml([])}</div>
      </div>`;
  },
  async mounted(root) {
    const results = root.querySelector('#approval-results');

    async function refresh() {
      try {
        results.innerHTML = rowsHtml(await api.get('/approvals', { status }));
      } catch (err) {
        results.innerHTML = statusBadge('ERROR') + `<p>${escapeHtml(err.message)}</p>`;
      }
    }

    root.querySelector('#approval-refresh').addEventListener('click', async () => {
      status = valueOf('#approval-status', root) || 'PENDING_APPROVAL';
      await refresh();
    });

    async function decide(id, decision) {
      const label = decision === 'approve' ? 'approve' : 'reject';
      const notes = window.prompt(`${label[0].toUpperCase() + label.slice(1)} request ${id} — notes${decision === 'reject' ? ' (required)' : ''}:`);
      if (notes === null || (decision === 'reject' && !notes.trim())) return;
      try {
        await api.post(`/approvals/${encodeURIComponent(id)}/${decision}`,
          decision === 'reject' ? { reason: notes } : { notes });
        await refresh();
      } catch (err) {
        results.insertAdjacentHTML('afterbegin', `<p class="form-error">${escapeHtml(err.message)}</p>`);
      }
    }

    on(root, 'click', '.js-approve', (event, button) => decide(button.dataset.id, 'approve'));
    on(root, 'click', '.js-reject', (event, button) => decide(button.dataset.id, 'reject'));

    await refresh();
  }
};
