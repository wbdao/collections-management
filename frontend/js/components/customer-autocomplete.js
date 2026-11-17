/**
 * Customer autocomplete widget.
 *
 * Searches the external customer master by Account number, English Name and
 * الاسم الموحد (Arabic unified name) via GET /customers/autocomplete?q=.
 * Selecting a suggestion returns the full normalized customer record.
 */
import { api } from '../api/client.js';
import { escapeHtml } from '../utils/dom.js';

let sequence = 0;

/** Returns the markup for the input + suggestion list. */
export function customerAutocomplete({
  id,
  label = 'Customer Account',
  placeholder = 'Account number, English name or Arabic name…',
  value = ''
} = {}) {
  const inputId = id || `customer-search-${++sequence}`;
  const listId = `${inputId}-results`;
  return `
    <div class="field autocomplete" data-autocomplete="${escapeHtml(inputId)}">
      <label for="${escapeHtml(inputId)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(inputId)}" type="text" autocomplete="off"
        value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"
        role="combobox" aria-autocomplete="list" aria-expanded="false"
        aria-controls="${escapeHtml(listId)}">
      <div id="${escapeHtml(listId)}" class="autocomplete-list" role="listbox" hidden></div>
    </div>`;
}

/** Wires an autocomplete rendered by customerAutocomplete(). */
export function bindCustomerAutocomplete(root, {
  id,
  onSelect = () => {},
  minLength = 2,
  debounceMs = 200
} = {}) {
  const wrapper = root.querySelector(`[data-autocomplete="${id}"]`);
  const input = wrapper ? wrapper.querySelector('input') : null;
  const list = wrapper ? wrapper.querySelector('.autocomplete-list') : null;
  if (!input || !list) return () => {};

  let timer = null;
  let items = [];
  let active = -1;

  function hide() {
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    active = -1;
    items = [];
  }

  function render() {
    if (!items.length) {
      hide();
      return;
    }
    list.innerHTML = items.map((customer, index) => `
      <button type="button" role="option" aria-selected="${index === active}"
        class="autocomplete-item ${index === active ? 'active' : ''}" data-index="${index}">
        <span class="ac-account">${escapeHtml(customer.account)}</span>
        <span class="ac-name">${escapeHtml(customer.name)}</span>
        <span class="ac-extra">${escapeHtml(customer.unifiedName || '')}</span>
        <span class="ac-meta">${escapeHtml(customer.warehouse || '—')} · ${escapeHtml(customer.department || '—')}</span>
      </button>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function search(term) {
    try {
      const result = await api.get('/customers/autocomplete', { q: term, limit: 20 });
      items = Array.isArray(result?.items) ? result.items : [];
      active = -1;
      render();
    } catch (err) {
      hide();
    }
  }

  function choose(index) {
    const customer = items[index];
    if (!customer) return;
    input.value = customer.account;
    hide();
    onSelect(customer);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < minLength) {
      hide();
      return;
    }
    timer = setTimeout(() => search(term), debounceMs);
  });

  input.addEventListener('keydown', (event) => {
    if (list.hidden || !items.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = (active + 1) % items.length;
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active - 1 + items.length) % items.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active < 0 ? 0 : active);
    } else if (event.key === 'Escape') {
      hide();
    }
  });

  list.addEventListener('mousedown', (event) => {
    const button = event.target.closest('.autocomplete-item');
    if (!button) return;
    event.preventDefault();
    choose(Number(button.dataset.index));
  });

  input.addEventListener('blur', () => setTimeout(hide, 150));

  return () => clearTimeout(timer);
}
