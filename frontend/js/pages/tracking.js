/** Universal tracking: search by number, return status/holder/location/full history. */
import { api } from '../api/client.js';
import { card, statusBadge, kv, empty, errorBox, loading } from '../components/ui.js';
import { escapeHtml, valueOf, qs } from '../utils/dom.js';
import { datetime } from '../utils/format.js';
import { DOCUMENT_TYPES } from '../config.js';

export default {
  title: 'Tracking',
  subtitle: 'Universal search across books, receipts, cheques and guarantees',
  permission: 'tracking.read',
  async render() {
    return `
      <div class="stack">
        ${card({
          title: 'Find a document',
          subtitle: 'Search by document number (BOOK, RECEIPT, CHEQUE or GUARANTEE)',
          body: `
            <form id="track-form" class="row" style="align-items:flex-end">
              <div class="field" style="min-width:220px;flex:1">
                <label for="track-type">Document type (optional)</label>
                <select id="track-type">
                  <option value="">Any type</option>
                  ${DOCUMENT_TYPES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
                </select>
              </div>
              <div class="field" style="min-width:240px;flex:2">
                <label for="track-number">Number</label>
                <input id="track-number" type="text" placeholder="e.g. 10045 or CHQ-2026-001" required>
              </div>
              <button class="btn btn-primary" type="submit">Search</button>
            </form>`
        })}
        <div id="track-result">${empty('Enter a document number to see its current status and full history.')}</div>
      </div>`;
  },
  async mounted(root) {
    const form = root.querySelector('#track-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const number = valueOf('#track-number', root);
      const type = valueOf('#track-type', root);
      const resultRoot = qs('#track-result', root);
      if (!number) return;
      resultRoot.innerHTML = loading('Searching…');
      try {
        const path = type ? `/track/${encodeURIComponent(type)}/${encodeURIComponent(number)}`
          : `/track/${encodeURIComponent(number)}`;
        const result = await api.get(path);
        resultRoot.innerHTML = renderResult(result);
      } catch (err) {
        resultRoot.innerHTML = errorBox(err.message || 'No matching document found.');
      }
    });
  }
};

function renderResult(result) {
  if (!result || !result.match) return empty('No matching document found.');
  const match = result.match;
  const timeline = (result.timeline || result.movements || []).map((m) => ({
    at: m.at || m.movement_date,
    event: m.event || m.reason || 'MOVEMENT',
    actor: m.actor || m.performed_by,
    from: m.from || m.from_location,
    to: m.to || m.to_location,
    notes: m.notes || ''
  }));

  const identity = card({
    title: 'Current status',
    body: kv([
      ['Type', match.type],
      ['Number', match.number],
      ['Entity ID', match.entityId],
      ['Status', match.status],
      ['Current holder', match.currentHolder],
      ['Current location', match.currentLocation],
      ['Last movement', datetime(match.lastMovementAt)]
    ])
  });

  // Customer master fields are resolved by Account at tracking time so that
  // Account status is always current even for older documents.
  const customer = result.customer || {};
  const customerCard = card({
    title: 'Customer',
    subtitle: 'From the external customer master (by Account)',
    body: kv([
      ['Account', customer.account],
      ['Name', customer.name],
      ['Warehouse Group', customer.warehouseGroup],
      ['Customer group', customer.customerGroup],
      ['Account status', customer.account_status || customer.accountStatus || '']
    ])
  });

  const statusLine = `<div class="row" style="margin-bottom:12px">${statusBadge(match.status)}${statusBadge(match.currentLocation || 'UNKNOWN')}</div>`;

  const history = card({
    title: 'Full history',
    subtitle: `${timeline.length} recorded movement${timeline.length === 1 ? '' : 's'}`,
    body: timeline.length ? `
      ${statusLine}
      <ol class="timeline">
        ${timeline.map((m) => `
          <li>
            <div class="timeline-time">${escapeHtml(datetime(m.at))}</div>
            <div class="timeline-event">${escapeHtml(m.event)}</div>
            <div class="timeline-meta">
              ${escapeHtml(m.from || '—')} → ${escapeHtml(m.to || '—')}
              ${m.actor ? ` · by ${escapeHtml(m.actor)}` : ''}
            </div>
            ${m.notes ? `<div class="timeline-meta">${escapeHtml(m.notes)}</div>` : ''}
          </li>`).join('')}
      </ol>`
      : empty('No movements recorded for this document yet.')
  });

  const related = result.related && Object.keys(result.related).length
    ? card({ title: 'Related records', body: kv(Object.entries(result.related)) })
    : '';

  return `<div class="grid grid-2">
    <div class="stack">${identity}${customerCard}</div>
    <div class="stack">${statusLine}${history}${related}</div>
  </div>`;
}
