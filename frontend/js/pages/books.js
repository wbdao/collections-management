/**
 * Books workspace: cut a serial range from an ACTIVE batch (generating one
 * receipt per serial in Apps Script), inspect those receipts, then assign the
 * book to a collector or return it to the warehouse.
 */
import { api } from '../api/client.js';
import { can } from '../store.js';
import { card, table, statusBadge, kv, empty, errorBox, loading } from '../components/ui.js';
import { escapeHtml, on, valueOf, qs } from '../utils/dom.js';
import { date, num } from '../utils/format.js';
import { BOOK_STATUSES, BOOK_TRANSITIONS } from '../config.js';

let filterBatch = '';
let filterStatus = '';
let selectedId = '';
let batchesCache = [];
let collectorsCache = [];

const asItems = (result) => (Array.isArray(result) ? result : (result?.items || []));
const batchLabel = (id) => batchesCache.find((b) => b.batch_id === id)?.batch_number || id || '—';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** The router matches only the path, so the ?batch= hint is read from the hash. */
function batchFromHash() {
  const raw = (location.hash || '').split('?')[1] || '';
  return new URLSearchParams(raw).get('batch') || '';
}

function statusOptions(selected) {
  return ['', ...BOOK_STATUSES].map((value) => `
    <option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>
      ${value ? escapeHtml(value.replace(/_/g, ' ')) : 'All statuses'}
    </option>`).join('');
}

function batchOptions(selected, activeOnly) {
  const items = activeOnly ? batchesCache.filter((b) => b.status === 'ACTIVE') : batchesCache;
  return `<option value="">${activeOnly ? 'Select an ACTIVE batch' : 'All batches'}</option>` +
    items.map((b) => `
      <option value="${escapeHtml(b.batch_id)}" ${selected === b.batch_id ? 'selected' : ''}>
        ${escapeHtml(b.batch_number)} · ${escapeHtml(String(b.serial_from ?? '—'))}–${escapeHtml(String(b.serial_to ?? '—'))}
      </option>`).join('');
}

function rowsHtml(result) {
  const items = asItems(result);
  if (!items.length) return empty('No books in this view. Cut a book from an ACTIVE batch to generate receipts.');
  return table({
    columns: [
      { key: 'book_number', label: 'Book', render: (r) => `<a href="#/books" data-book-id="${escapeHtml(r.book_id)}">${escapeHtml(r.book_number)}</a>` },
      { key: 'batch_id', label: 'Batch', render: (r) => escapeHtml(batchLabel(r.batch_id)) },
      { key: 'serial_range', label: 'Serials', render: (r) => `${escapeHtml(String(r.serial_from ?? '—'))} – ${escapeHtml(String(r.serial_to ?? '—'))}` },
      { key: 'total_receipts', label: 'Receipts', align: 'num', render: (r) => num(r.total_receipts) },
      { key: 'issue_date', label: 'Issued', render: (r) => escapeHtml(date(r.issue_date)) },
      { key: 'current_holder_id', label: 'Holder', render: (r) => escapeHtml(r.current_holder_id || 'Warehouse') },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }
    ],
    rows: items,
    emptyMessage: 'No books in this view.'
  });
}

function receiptCounts(items) {
  const counts = {};
  items.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  return Object.entries(counts).map(([status, count]) =>
    `${escapeHtml(status.replace(/_/g, ' '))}: <strong>${num(count)}</strong>`).join(' · ');
}

function receiptsHtml(result) {
  const items = asItems(result);
  if (!items.length) return empty('No receipts generated for this book.');
  const shown = items.slice(0, 50);
  const more = items.length > shown.length
    ? `<p class="field-hint">Showing ${shown.length} of ${num(items.length)} receipts.</p>` : '';
  return `
    <p style="font-size:12px;color:var(--color-ink-soft);margin-bottom:10px">${receiptCounts(items)}</p>
    ${table({
      columns: [
        { key: 'receipt_number', label: 'Receipt' },
        { key: 'sequence_in_book', label: '#', align: 'num', render: (r) => num(r.sequence_in_book) },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
        { key: 'customer_code', label: 'Account' },
        { key: 'collection_date', label: 'Collected', render: (r) => escapeHtml(date(r.collection_date)) },
        { key: 'amount_minor', label: 'Amount', align: 'num', render: (r) => num(r.amount_minor) }
      ],
      rows: shown,
      emptyMessage: 'No receipts generated for this book.'
    })}
    ${more}`;
}

function actionHtml(book) {
  const parts = [];
  if (book.status === 'AVAILABLE' && can('books.assign')) {
    parts.push(`
      <div class="row" style="margin-top:12px">
        <button class="btn btn-sm btn-primary" type="button" data-toggle-assign>Assign to collector</button>
      </div>
      <form id="book-assign-form" class="form-stack" hidden style="margin-top:10px">
        <div class="row">
          <div class="field" style="min-width:220px;flex:1">
            <label for="book-assign-to">Collector user ID *</label>
            <input id="book-assign-to" name="assigned_to" list="collector-options" autocomplete="off" required>
            <datalist id="collector-options">
              ${collectorsCache.map((c) => `<option value="${escapeHtml(c.user_id)}">${escapeHtml(c.full_name || c.username || '')}</option>`).join('')}
            </datalist>
          </div>
          <div class="field" style="min-width:170px">
            <label for="book-assign-due">Due return at</label>
            <input id="book-assign-due" name="due_return_at" type="date">
          </div>
          <div class="field" style="min-width:180px;flex:1">
            <label for="book-assign-notes">Notes</label>
            <input id="book-assign-notes" name="notes" type="text">
          </div>
        </div>
        <div class="row"><button class="btn btn-sm btn-primary" type="submit">Assign book</button></div>
      </form>`);
  }
  if (book.status === 'ASSIGNED' && can('books.return')) {
    parts.push(`<div class="row" style="margin-top:12px">
      <button class="btn btn-sm" type="button" data-book-return data-book-id="${escapeHtml(book.book_id)}">Return to warehouse</button>
    </div>`);
  }
  const next = (BOOK_TRANSITIONS[book.status] || []).filter((s) =>
    s !== 'ASSIGNED' && s !== 'AVAILABLE');
  if (can('books.transition') && next.length) {
    parts.push(`
      <div class="row" style="margin-top:12px">
        <span class="field-hint">Move to:</span>
        ${next.map((status) => `
          <button class="btn btn-sm ${status === 'LOST' || status === 'CANCELLED' ? 'btn-danger' : 'btn-primary'}"
            type="button" data-book-transition="${escapeHtml(status)}" data-book-id="${escapeHtml(book.book_id)}">
            ${escapeHtml(status.replace(/_/g, ' '))}
          </button>`).join('')}
      </div>`);
  }
  return parts.join('');
}

function detailHtml(book, receiptResult) {
  if (!book) return empty('Select a book to see its receipts.');
  return `
    <div class="stack">
      ${kv([
        ['Book number', book.book_number],
        ['Batch', batchLabel(book.batch_id)],
        ['Serial range', `${book.serial_from ?? '—'} – ${book.serial_to ?? '—'}`],
        ['Total receipts', num(book.total_receipts)],
        ['Issue date', date(book.issue_date)],
        ['Status', book.status],
        ['Current holder', book.current_holder_id || 'Warehouse'],
        ['Current location', book.current_location],
        ['Notes', book.notes]
      ])}
      ${actionHtml(book)}
      <div id="book-action-msg"></div>
      <h3 style="margin-top:8px">Generated receipts</h3>
      ${receiptsHtml(receiptResult)}
    </div>`;
}

function createForm() {
  if (!can('books.create')) return '';
  return card({
    title: 'Create a book',
    subtitle: 'Cut an inclusive serial range from an ACTIVE batch; one UNUSED receipt is generated per serial.',
    body: `
      <form id="book-create-form" class="form-stack">
        <div class="row">
          <div class="field" style="min-width:240px;flex:1">
            <label for="book-batch">Batch *</label>
            <select id="book-batch" name="batch_id" required>${batchOptions('', true)}</select>
          </div>
          <div class="field" style="min-width:140px">
            <label for="book-from">Serial from *</label>
            <input id="book-from" name="serial_from" type="number" min="0" step="1" required>
          </div>
          <div class="field" style="min-width:140px">
            <label for="book-to">Serial to *</label>
            <input id="book-to" name="serial_to" type="number" min="0" step="1" required>
          </div>
          <div class="field" style="min-width:150px">
            <label for="book-issue">Issue date</label>
            <input id="book-issue" name="issue_date" type="date" value="${todayIso()}">
          </div>
          <div class="field" style="min-width:180px;flex:1">
            <label for="book-notes">Notes</label>
            <input id="book-notes" name="notes" type="text">
          </div>
        </div>
        <div class="row"><button class="btn btn-primary" type="submit">Create book &amp; receipts</button></div>
        <div id="book-create-msg"></div>
      </form>`
  });
}

export default {
  title: 'Books',
  subtitle: 'Serial ranges, generated receipts and collector assignment',
  permission: 'books.read',
  async render() {
    const hashBatch = batchFromHash();
    if (hashBatch) filterBatch = hashBatch;
    return `
      <div class="stack">
        ${createForm()}
        ${card({
          title: 'Books',
          subtitle: 'Click a book number to inspect its generated receipts',
          body: `
            <div class="row" style="margin-bottom:12px">
              <div class="field" style="min-width:240px">
                <label for="book-batch-filter">Batch</label>
                <select id="book-batch-filter">${batchOptions(filterBatch, false)}</select>
              </div>
              <div class="field" style="min-width:180px">
                <label for="book-status-filter">Status</label>
                <select id="book-status-filter">${statusOptions(filterStatus)}</select>
              </div>
              <button class="btn" id="book-refresh" type="button">Refresh</button>
            </div>
            <div id="book-list">${loading()}</div>`
        })}
        ${card({ title: 'Book detail', body: `<div id="book-detail">${empty('Select a book to see its receipts.')}</div>` })}
      </div>`;
  },
  async mounted(root) {
    const listRoot = qs('#book-list', root);
    const detailRoot = qs('#book-detail', root);
    const createMsg = qs('#book-create-msg', root);

    async function loadBatches() {
      try {
        const result = await api.get('/batches');
        batchesCache = asItems(result);
        const createSelect = qs('#book-batch', root);
        if (createSelect) createSelect.innerHTML = batchOptions('', true);
        const filterSelect = qs('#book-batch-filter', root);
        if (filterSelect) filterSelect.innerHTML = batchOptions(filterBatch, false);
      } catch (err) {
        if (createMsg) createMsg.innerHTML = `<p class="form-error">Unable to load batches: ${escapeHtml(err.message)}</p>`;
      }
    }

    async function loadCollectors() {
      if (!can('users.manage')) return;
      try {
        const result = await api.get('/admin/users', { role_id: 'ROLE_COLLECTOR' });
        collectorsCache = asItems(result).filter((u) => u.role_id === 'ROLE_COLLECTOR');
      } catch (err) {
        collectorsCache = [];
      }
    }

    async function loadList() {
      try {
        const query = {};
        if (filterBatch) query.batchId = filterBatch;
        if (filterStatus) query.status = filterStatus;
        const result = await api.get('/books', Object.keys(query).length ? query : undefined);
        listRoot.innerHTML = rowsHtml(result);
        const items = asItems(result);
        if (selectedId && items.some((b) => b.book_id === selectedId)) await loadDetail(selectedId);
      } catch (err) {
        listRoot.innerHTML = errorBox(`Unable to load books: ${err.message}`);
      }
    }

    async function loadDetail(id) {
      selectedId = id;
      detailRoot.innerHTML = loading();
      try {
        const [book, receipts] = await Promise.all([
          api.get(`/books/${encodeURIComponent(id)}`),
          api.get(`/books/${encodeURIComponent(id)}/receipts`)
        ]);
        detailRoot.innerHTML = detailHtml(book, receipts);
        bindDetailActions(book);
      } catch (err) {
        detailRoot.innerHTML = errorBox(`Unable to load book detail: ${err.message}`);
      }
    }

    function bindDetailActions(book) {
      const msg = qs('#book-action-msg', detailRoot);
      const report = (text, ok) => {
        if (msg) msg.innerHTML = `<p class="form-error" style="color:${ok ? 'var(--color-success)' : 'var(--color-danger)'}">${escapeHtml(text)}</p>`;
      };

      const toggle = qs('[data-toggle-assign]', detailRoot);
      if (toggle) toggle.addEventListener('click', () => {
        const form = qs('#book-assign-form', detailRoot);
        if (form) form.hidden = !form.hidden;
      });

      const assignForm = qs('#book-assign-form', detailRoot);
      if (assignForm) {
        assignForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          const body = { assigned_to: valueOf('#book-assign-to', detailRoot) };
          const due = valueOf('#book-assign-due', detailRoot);
          if (due) body.due_return_at = due;
          const notes = valueOf('#book-assign-notes', detailRoot);
          if (notes) body.notes = notes;
          try {
            await api.post(`/books/${encodeURIComponent(book.book_id)}/assign`, body);
            await Promise.all([loadList(), loadDetail(book.book_id)]);
          } catch (err) {
            report(err.message, false);
          }
        });
      }

    }

    // Registered once on the persistent detail container: detailHtml is re-rendered
    // on every load, so delegated handlers here must not be re-added each time.
    function reportAction(text, ok) {
      const msg = qs('#book-action-msg', detailRoot);
      if (msg) msg.innerHTML = `<p class="form-error" style="color:${ok ? 'var(--color-success)' : 'var(--color-danger)'}">${escapeHtml(text)}</p>`;
    }
    on(detailRoot, 'click', '[data-book-return]', async (event, node) => {
      node.disabled = true;
      try {
        await api.post(`/books/${encodeURIComponent(node.dataset.bookId)}/return`, {});
        await Promise.all([loadList(), loadDetail(node.dataset.bookId)]);
      } catch (err) {
        reportAction(err.message, false);
        node.disabled = false;
      }
    });
    on(detailRoot, 'click', '[data-book-transition]', async (event, node) => {
      node.disabled = true;
      try {
        await api.post(`/books/${encodeURIComponent(node.dataset.bookId)}/transition`,
          { toStatus: node.dataset.bookTransition });
        await Promise.all([loadList(), loadDetail(node.dataset.bookId)]);
      } catch (err) {
        reportAction(err.message, false);
        node.disabled = false;
      }
    });

    const refreshBtn = qs('#book-refresh', root);
    if (refreshBtn) refreshBtn.addEventListener('click', loadList);
    const batchFilter = qs('#book-batch-filter', root);
    if (batchFilter) batchFilter.addEventListener('change', () => { filterBatch = valueOf('#book-batch-filter', root); loadList(); });
    const statusFilter = qs('#book-status-filter', root);
    if (statusFilter) statusFilter.addEventListener('change', () => { filterStatus = valueOf('#book-status-filter', root); loadList(); });

    on(root, 'click', '[data-book-id]', (event, node) => {
      if (node.hasAttribute('data-book-return') || node.hasAttribute('data-book-transition')) return;
      event.preventDefault();
      loadDetail(node.dataset.bookId);
    });

    const form = qs('#book-create-form', root);
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        createMsg.innerHTML = '';
        const body = {
          batch_id: valueOf('#book-batch', root),
          serial_from: Number(valueOf('#book-from', root)),
          serial_to: Number(valueOf('#book-to', root)),
          issue_date: valueOf('#book-issue', root),
          notes: valueOf('#book-notes', root)
        };
        try {
          const created = await api.post('/books', body);
          form.reset();
          qs('#book-issue', root).value = todayIso();
          createMsg.innerHTML = `<p class="form-error" style="color:var(--color-success);background:var(--color-success-soft);border-color:#bbf7d0">Created ${escapeHtml(created?.book_number || created?.book_id || 'book')} with ${num(created?.receiptsCreated)} receipts.</p>`;
          await loadBatches();
          filterBatch = created?.batch_id || filterBatch;
          const filterSelect = qs('#book-batch-filter', root);
          if (filterSelect) filterSelect.value = filterBatch;
          await loadList();
          if (created?.book_id) await loadDetail(created.book_id);
        } catch (err) {
          createMsg.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        }
      });
    }

    await Promise.all([loadBatches(), loadCollectors()]);
    await loadList();
  }
};
