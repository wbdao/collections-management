/** Frontend bootstrap: route table, session guards and shell rendering. */
import { api } from './api/client.js';
import { isAuthenticated, can, endSession, setPermissions, updateUser } from './store.js';
import { defineRoutes, setNotFound, navigate, start } from './router.js';
import { renderShell, bindShell } from './components/shell.js';
import { card, loading } from './components/ui.js';
import login from './pages/login.js';
import dashboard from './pages/dashboard.js';
import custody from './pages/custody.js';
import tracking from './pages/tracking.js';
import customers from './pages/customers.js';
import approvals from './pages/approvals.js';
import reports from './pages/reports.js';
import { notFoundPage, forbiddenPage } from './pages/notfound.js';

const app = document.getElementById('app');

/** Placeholder workspaces for modules whose full UI is outside the initial structure. */
function stubPage(title, subtitle, permission) {
  return {
    title,
    subtitle,
    permission,
    async render() {
      return card({
        title,
        subtitle,
        body: `<p style="color:var(--color-ink-soft)">This workspace is part of the Phase 1 API and is available through the endpoint layer. The interactive screen is not part of the initial frontend structure.</p>
               <p style="margin-top:8px"><a href="#/dashboard">Return to dashboard</a></p>`
      });
    }
  };
}

defineRoutes([
  { path: '/login', page: login, public: true },
  { path: '/dashboard', page: dashboard },
  { path: '/custody', page: custody },
  { path: '/tracking', page: tracking },
  { path: '/customers', page: customers },
  { path: '/approvals', page: approvals },
  { path: '/batches', page: stubPage('Book Batches', 'Printing house batch lifecycle', 'batches.read') },
  { path: '/books', page: stubPage('Books', 'Serial ranges and receipt generation', 'books.read') },
  { path: '/receipts', page: stubPage('Receipts', 'Collection receipt lifecycle', 'receipts.read') },
  { path: '/collections', page: stubPage('Collections', 'Collector collections', 'collections.read') },
  { path: '/deposits/branch', page: stubPage('Branch Deposits', 'Collected → deposited at branch', 'deposits.branch.read') },
  { path: '/deposits/hq', page: stubPage('HQ Deposits', 'Branch → deposited at HQ', 'deposits.hq.read') },
  { path: '/cheques', page: stubPage('Cheques', 'Cheque lifecycle and clearing', 'cheques.read') },
  { path: '/guarantees', page: stubPage('Guarantees', 'Guarantee lifecycle and expiry', 'guarantees.read') },
  { path: '/alerts', page: stubPage('Alerts', 'Daily idempotent alert scan', 'alerts.read') },
  { path: '/reports', page: reports },
  { path: '/reports/advanced', page: reports },
  { path: '/reports/outstanding', page: stubPage('Outstanding Report', 'Collector balances and aging', 'reports.read') },
  { path: '/audit', page: stubPage('Audit Log', 'Append-only audit trail', 'audit.read') }
]);

function paint(page, path, content) {
  app.innerHTML = renderShell({
    title: page.title,
    subtitle: page.subtitle,
    content,
    activePath: path
  });
  bindShell(app);
}

async function renderRoute(route, params, path) {
  const page = route.page;

  if (route.public) {
    if (isAuthenticated()) { navigate('/dashboard', { replace: true }); return; }
    app.innerHTML = await page.render();
    if (page.mounted) await page.mounted(app, { params, path });
    return;
  }

  if (!isAuthenticated()) { navigate('/login', { replace: true }); return; }

  if (page.permission && !can(page.permission)) {
    const denied = forbiddenPage();
    paint(denied, path, denied.content);
    return;
  }

  paint(page, path, loading());
  const content = await page.render({ params, path });
  const main = app.querySelector('#main-content');
  if (main) main.innerHTML = content;
  if (page.mounted) await page.mounted(app, { params, path });
}

setNotFound(async (path) => {
  if (!isAuthenticated()) { navigate('/login', { replace: true }); return; }
  const page = notFoundPage(path);
  paint(page, path, page.content);
});

window.addEventListener('cms:unauthorized', () => {
  endSession();
  navigate('/login', { replace: true });
});

async function bootstrap() {
  if (!location.hash) {
    location.replace(isAuthenticated() ? '#/dashboard' : '#/login');
  }

  if (isAuthenticated()) {
    try {
      const me = await api.get('/auth/me');
      if (me.user) updateUser(me.user);
      setPermissions(me.permissions || []);
    } catch (err) {
      if (err.status === 401) endSession();
    }
  }

  await start(renderRoute);
}

bootstrap();
