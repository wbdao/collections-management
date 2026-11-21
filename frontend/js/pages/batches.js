/**
 * Book batch workspace: printing-house delivery, inspection and lifecycle.
 * A batch defines an inclusive serial range; books are cut from that range on
 * the Books screen. Variance (registered - expected) is always shown and must
 * be zero before a batch can be CLOSED (enforced server-side).
 */
import { api } from '../api/client.js';
import { can } from '../store.js';
import { navigate } from '../router.js';
import { card, table, statusBadge, kv, empty, errorBox, loading } from '../components/ui.js';
import { escapeHtml, on, valueOf, qs } from '../utils/dom.js';
import { date, num } from '../utils/format.js';
import { BATCH_STATUSES, BATCH_TRANSITIONS } from '../config.js';

let filterStatus = '';
let selectedId = '';

const asItems = (result) => (Array.isArray(result) ? result : (result?.items || []));

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function statusOptions(selected) {
  return ['', ...BATCH_STATUSES].map((value) => `
    <option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>
      ${value ? escapeHtml(value.replace(/_/g, ' ')) : 'All statuses'}
    </option>`).join('');
}

function varianceBadge(value) {
  const n = Number(value || 0);
  return `<span class="badge tone-${n === 0 ? 'success' : 'warning'}">${n > 0 ? '+' : ''}${num(n)}</span>`;
}

function rowsHtml(result) {
  const items = asItems(result);
  if (!items.length) return empty('No batches in this view. Create one to receive a printing delivery.');
  return table({
    columns: [
      { key: 'batch_number', label: 'Batch', render: (r) => `<a href="#/batches" data-batch-id="${escapeHtml(r.batch_id)}">${escapeHtml(r.batch_number)}</a>` },
      { key: 'supplier', label: 'Supplier' },
      { key: 'delivery_date', label: 'Delivered', render: (r) => escapeHtml(date(r.delivery_date)) },
      { key: 'serial_range', label: 'Serial range', render: (r) => `${escapeHtml(String(r.serial_from ?? '—'))} – ${escapeHtml(String(r.serial_to ?? '—'))}` },
      { key: 'expected_quantity', label: 'Expected', align: 'num', render: (r) => num(r.expected_quantity) },
      { key: 'registered_quantity', label: 'Registered', align: 'num', render: (r) => num(r.registered_quantity) },
      { key: 'variance', label: 'Variance', align: 'num', render: (r) => varianceBadge(r.variance) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }
    ],
    rows: items,
    emptyMessage: 'No batches in this view.'
  });
}

function booksHtml(result) {
  const items = asItems(result);
  if (!items.length) return empty('No books cut from this batch yet. Use the Books screen.');
  return table({
    columns: [
      { key: 'book_number', label: 'Book' },
      { key: 'serial_range', label: 'Serials', render: (r) => `${escapeHtml(String(r.serial_from ?? '—'))} – ${escapeHtml(String(r.serial_to ?? '—'))}` },
      { key: 'total_receipts', label: 'Receipts', align: 'num', render: (r) => num(r.total_receipts) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }
    ],
    rows: items,
    emptyMessage: 'No books cut from this batch yet.'
  });
}

function transitionButtons(batch) {
  if (!can('batches.manage')) return '';
  const next = BATCH_TRANSITIONS[batch.status] || [];
  if (!next.length) return '';
  return `
    <div class="row" style="margin-top:12px">
      <span class="field-hint">Move to:</span>
      ${next.map((status) => `
        <button class="btn btn-sm ${status === 'QUARANTINED' || status === 'RETURNED_TO_SUPPLIER' ? 'btn-danger' : 'btn-primary'}"
          type="button" data-batch-transition="${escapeHtml(status)}" data-batch-id="${escapeHtml(batch.batch_id)}">
          ${escapeHtml(status.replace(/_/g, ' '))}
        </button>`).join('')}
    </div>`;
}

function detailHtml(batch, bookResult) {
  if (!batch) return empty('Select a batch to see details.');
  return `
    <div class="stack">
      ${kv([
        ['Batch number', batch.batch_number],
        ['Supplier', batch.supplier],
        ['Delivery date', date(batch.delivery_date)],
        ['Invoice reference', batch.invoice_reference],
        ['Serial range', `${batch.serial_from ?? '—'} – ${batch.serial_to ?? '—'}`],
        ['Expected quantity', num(batch.expected_quantity)],
        ['Registered quantity', num(batch.registered_quantity)],
        ['Received by', batch.received_by],
        ['Inspected by', batch.inspected_by],
        ['Notes', batch.notes]
      ])}
      <div class="row"><span class="field-hint">Variance</span>${varianceBadge(batch.variance)}</div>
      ${transitionButtons(batch)}
      <div class="row" style="margin-top:12px">
        <button class="btn btn-sm" type="button" data-open-books data-batch-id="${escapeHtml(batch.batch_id)}">Open in Books →</button>
      </div>
      <h3 style="margin-top:8px">Books in this batch</h3>
      ${booksHtml(bookResult)}
    </div>`;
}

function createForm() {
  if (!can('batches.create')) return '';
  return card({
    title: 'Receive a printing batch',
    subtitle: 'Register the delivered serial range. expected_quantity defaults to the range size.',
    body: `
      <form id="batch-create-form" class="form-stack">
        <div class="row">
          <div class="field" style="min-width:180px;flex:1">
            <label for="batch-number">Batch number *</label>
            <input id="batch-number" name="batch_number" type="text" placeholder="BAT-2026-001" pattern="BAT-[A-Za-z0-9-]+" required>
          </div>
          <div class="field" style="min-width:180px;flex:1">
            <label for="batch-supplier">Supplier *</label>
            <input id="batch-supplier" name="supplier" type="text" required>
          </div>
          <div class="field" style="min-width:150px">
            <label for="batch-date">Delivery date *</label>
            <input id="batch-date" name="delivery_date" type="date" value="${todayIso()}" required>
          </div>
        </div>
        <div class="row">
          <div class="field" style="min-width:140px">
            <label for="batch-from">Serial from *</label>
            <input id="batch-from" name="serial_from" type="number" min="0" step="1" required>
          </div>
          <div class="field" style="min-width:140px">
            <label for="batch-to">Serial to *</label>
            <input id="batch-to" name="serial_to" type="number" min="0" step="1" required>
          </div>
          <div class="field" style="min-width:160px">
            <label for="batch-expected">Expected quantity</label>
            <input id="batch-expected" name="expected_quantity" type="number" min="0" step="1" placeholder="auto from range">
          </div>
          <div class="field" style="min-width:180px;flex:1">
            <label for="batch-notes">Notes</label>
            <input id="batch-notes" name="notes" type="text">
          </div>
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Create batch</button></div>
        <div id="batch-create-msg"></div>
      </form>`
  });
}

export default {
  title: 'Book Batches',
  subtitle: 'Printing-house delivery, inspection and batch lifecycle',
  permission: 'batches.read',
  async render() {
    return `
      <div class="stack">
        ${createForm()}
        ${card({
          title: 'Batches',
          subtitle: 'Click a batch number to inspect its books and lifecycle',
          body: `
            <div class="row" style="margin-bottom:12px">
              <div class="field" style="min-width:200px">
                <label for="batch-status-filter">Status</label>
                <select id="batch-status-filter">${statusOptions(filterStatus)}</select>
              </div>
              <button class="btn" id="batch-refresh" type="button">Refresh</button>
            </div>
            <div id="batch-list">${loading()}</div>`
        })}
        ${card({ title: 'Batch detail', body: `<div id="batch-detail">${empty('Select a batch to see details.')}</div>` })}
      </div>`;
  },
  async mounted(root) {
    const listRoot = qs('#batch-list', root);
    const detailRoot = qs('#batch-detail', root);
    const msgRoot = qs('#batch-create-msg', root);

    async function loadList() {
      try {
        const result = await api.get('/batches', filterStatus ? { status: filterStatus } : undefined);
        listRoot.innerHTML = rowsHtml(result);
        const items = asItems(result);
        if (selectedId && items.some((b) => b.batch_id === selectedId)) {
          await loadDetail(selectedId);
        }
      } catch (err) {
        listRoot.innerHTML = errorBox(`Unable to load batches: ${err.message}`);
      }
    }

    async function loadDetail(id) {
      selectedId = id;
      detailRoot.innerHTML = loading();
      try {
        const [batch, books] = await Promise.all([
          api.get(`/batches/${encodeURIComponent(id)}`),
          api.get(`/batches/${encodeURIComponent(id)}/books`)
        ]);
        detailRoot.innerHTML = detailHtml(batch, books);
      } catch (err) {
        detailRoot.innerHTML = errorBox(`Unable to load batch detail: ${err.message}`);
      }
    }

    const refreshBtn = qs('#batch-refresh', root);
    if (refreshBtn) refreshBtn.addEventListener('click', loadList);
    const filter = qs('#batch-status-filter', root);
    if (filter) filter.addEventListener('change', () => { filterStatus = valueOf('#batch-status-filter', root); loadList(); });

    on(root, 'click', '[data-batch-id]', (event, node) => {
      if (node.hasAttribute('data-batch-transition') || node.hasAttribute('data-open-books')) return;
      event.preventDefault();
      loadDetail(node.dataset.batchId);
    });

    on(root, 'click', '[data-batch-transition]', async (event, node) => {
      const id = node.dataset.batchId;
      const status = node.dataset.batchTransition;
      node.disabled = true;
      try {
        await api.post(`/batches/${encodeURIComponent(id)}/transition`, { toStatus: status });
        await Promise.all([loadList(), loadDetail(id)]);
      } catch (err) {
        detailRoot.insertAdjacentHTML('afterbegin', `<p class="form-error">${escapeHtml(err.message)}</p>`);
        node.disabled = false;
      }
    });

    on(root, 'click', '[data-open-books]', (event, node) => {
      navigate(`/books?batch=${encodeURIComponent(node.dataset.batchId)}`);
    });

    const form = qs('#batch-create-form', root);
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        msgRoot.innerHTML = '';
        const body = {
          batch_number: valueOf('#batch-number', root),
          supplier: valueOf('#batch-supplier', root),
          delivery_date: valueOf('#batch-date', root),
          serial_from: Number(valueOf('#batch-from', root)),
          serial_to: Number(valueOf('#batch-to', root)),
          notes: valueOf('#batch-notes', root)
        };
        const expected = valueOf('#batch-expected', root);
        if (expected !== '') body.expected_quantity = Number(expected);
        try {
          const created = await api.post('/batches', body);
          form.reset();
          qs('#batch-date', root).value = todayIso();
          msgRoot.innerHTML = `<p class="form-error" style="color:var(--color-success);background:var(--color-success-soft);border-color:#bbf7d0">Created ${escapeHtml(created?.batch_number || created?.batch_id || 'batch')}.</p>`;
          await loadList();
          if (created?.batch_id) await loadDetail(created.batch_id);
        } catch (err) {
          msgRoot.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        }
      });
    }

    await loadList();
  }
};
