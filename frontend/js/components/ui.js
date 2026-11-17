/** Presentational helpers. Every dynamic value is escaped by the caller or here. */
import { STATUS_TONES } from '../config.js';
import { escapeHtml } from '../utils/dom.js';
import { num } from '../utils/format.js';

export function badge(text, tone = '') {
  return `<span class="badge ${tone ? `tone-${escapeHtml(tone)}` : ''}">${escapeHtml(text)}</span>`;
}

export function statusBadge(value) {
  return badge(String(value || '—').replace(/_/g, ' '), STATUS_TONES[value] || '');
}

export function statCard({ label, value, sub = '', tone = '' }) {
  return `
    <div class="card stat-card ${tone ? `tone-${escapeHtml(tone)}` : ''}">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;
}

export function card({ title = '', subtitle = '', body = '', foot = '', action = '' } = {}) {
  return `
    <section class="card">
      ${title ? `
        <div class="card-head">
          <div>
            <h2>${escapeHtml(title)}</h2>
            ${subtitle ? `<p style="font-size:12px;color:var(--color-ink-faint);margin-top:2px">${escapeHtml(subtitle)}</p>` : ''}
          </div>
          ${action}
        </div>` : ''}
      <div class="card-body">${body}</div>
      ${foot ? `<div class="card-foot">${foot}</div>` : ''}
    </section>`;
}

/**
 * columns: [{ key, label, align: 'num', render: (row) => html }]
 * Every label and default cell value is escaped; custom renderers must escape.
 */
export function table({ columns = [], rows = [], emptyMessage = 'No records found.' } = {}) {
  if (!rows.length) return empty(emptyMessage);
  const head = columns.map((c) => `<th${c.align ? ` class="${escapeHtml(c.align)}"` : ''}>${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map((row) => `
    <tr>${columns.map((c) => `
      <td${c.align ? ` class="${escapeHtml(c.align)}"` : ''}>${c.render ? c.render(row) : escapeHtml(row[c.key] ?? '—')}</td>
    `).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function tabs(items, active) {
  return `<div class="tabs" role="tablist">${items.map((item) => `
    <button class="tab ${item.key === active ? 'active' : ''}" role="tab" data-tab="${escapeHtml(item.key)}"
      aria-selected="${item.key === active}">${escapeHtml(item.label)}</button>
  `).join('')}</div>`;
}

export function empty(message = 'Nothing to display.') {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

export function errorBox(message) {
  return `<div class="error-box">${escapeHtml(message)}</div>`;
}

export function loading(label = 'Loading…') {
  return `<div class="loading"><span class="spinner-sm" aria-hidden="true"></span> ${escapeHtml(label)}</div>`;
}

export function kv(pairs = []) {
  return `<dl class="kv">${pairs.map(([key, value]) => `
    <dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? '—')}</dd>
  `).join('')}</dl>`;
}

export function count(value) {
  return num(value);
}
