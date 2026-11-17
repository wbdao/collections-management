/** Small DOM helpers. All dynamic text must pass through escapeHtml before interpolation. */

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Delegated event binding: on(root, 'click', '.js-save', handler) */
export function on(root, eventName, selector, handler) {
  root.addEventListener(eventName, (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}

export function setValue(selector, value, root = document) {
  const node = qs(selector, root);
  if (node) node.value = value === undefined || value === null ? '' : String(value);
}

export function valueOf(selector, root = document) {
  const node = qs(selector, root);
  return node ? node.value.trim() : '';
}
