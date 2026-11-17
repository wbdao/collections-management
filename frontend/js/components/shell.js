/** Authenticated application shell with permission-aware navigation. */
import { can, getState, endSession } from '../store.js';
import { navigate, href, currentPath } from '../router.js';
import { api } from '../api/client.js';
import { escapeHtml } from '../utils/dom.js';
import { on } from '../utils/dom.js';

const NAV = [
  { group: 'Overview', items: [
    { path: '/dashboard', label: 'Dashboard', icon: '▦', permission: 'dashboard.read' },
    { path: '/custody', label: 'Custody', icon: '▣', permission: 'custody.read' },
    { path: '/tracking', label: 'Tracking', icon: '◎', permission: 'tracking.read' },
    { path: '/customers', label: 'Customers', icon: '◉', permission: 'customers.read' }
  ] },
  { group: 'Operations', items: [
    { path: '/batches', label: 'Book Batches', icon: '▤', permission: 'batches.read' },
    { path: '/books', label: 'Books', icon: '▥', permission: 'books.read' },
    { path: '/receipts', label: 'Receipts', icon: '▧', permission: 'receipts.read' },
    { path: '/collections', label: 'Collections', icon: '◈', permission: 'collections.read' },
    { path: '/deposits/branch', label: 'Branch Deposits', icon: '⇥', permission: 'deposits.branch.read' },
    { path: '/deposits/hq', label: 'HQ Deposits', icon: '⇤', permission: 'deposits.hq.read' },
    { path: '/cheques', label: 'Cheques', icon: '▭', permission: 'cheques.read' },
    { path: '/guarantees', label: 'Guarantees', icon: '❖', permission: 'guarantees.read' }
  ] },
  { group: 'Insights', items: [
    { path: '/alerts', label: 'Alerts', icon: '⚑', permission: 'alerts.read' },
    { path: '/reports/outstanding', label: 'Outstanding Report', icon: '▤', permission: 'reports.read' },
    { path: '/audit', label: 'Audit Log', icon: '≡', permission: 'audit.read' }
  ] }
];

function initials(fullName) {
  return String(fullName || '?').split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
}

function renderNav(activePath) {
  return NAV.map((group) => {
    const items = group.items.filter((item) => can(item.permission));
    if (!items.length) return '';
    return `
      <nav class="nav-group" aria-label="${escapeHtml(group.group)}">
        <div class="nav-label">${escapeHtml(group.group)}</div>
        ${items.map((item) => `
          <a class="nav-link ${activePath === item.path ? 'active' : ''}" href="${href(item.path)}">
            <span class="nav-icon" aria-hidden="true">${item.icon}</span>
            <span>${escapeHtml(item.label)}</span>
          </a>`).join('')}
      </nav>`;
  }).join('');
}

export function renderShell({ title, subtitle = '', content = '', activePath = '' }) {
  const { user } = getState();
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">CM</div>
          <div class="brand-text"><strong>Collections</strong><span>Management System</span></div>
        </div>
        ${renderNav(activePath)}
        <div class="sidebar-footer">Phase 1 · Secure session<br>8-hour token</div>
      </aside>
      <header class="topbar">
        <div class="topbar-title">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(subtitle || 'Collections Management System')}</p>
        </div>
        <div class="topbar-actions">
          <div class="user-chip">
            <span class="avatar">${escapeHtml(initials(user?.fullName))}</span>
            <span>${escapeHtml(user?.username || 'user')} · ${escapeHtml(user?.role || '')}</span>
          </div>
          <button class="btn btn-sm btn-ghost" id="logout-btn" type="button">Sign out</button>
        </div>
      </header>
      <main class="content" id="main-content">${content}</main>
    </div>`;
}

export function bindShell(root) {
  on(root, 'click', '#logout-btn', async () => {
    try { await api.post('/auth/logout', {}); } catch (e) { /* local logout still applies */ }
    endSession();
    navigate('/login', { replace: true });
  });
}

export function contentHead(title, subtitle = '', actions = '') {
  return `
    <div class="content-head">
      <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>
      <div class="row">${actions}</div>
    </div>`;
}

export { currentPath };
