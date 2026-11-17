/**
 * ============================================================================
 * CLOUDFLARE PAGES — MAIN API ROUTER (catch-all for /api/*)
 * ============================================================================
 * Every request passes through functions/api/_middleware.js first, which sets
 * context.data.cms = { requestId, ip, idempotencyKey, actor, claims }.
 *
 * This router maps REST paths to the edge business modules. Business modules
 * talk only to the Repository Interface (functions/_lib/repository.js), which
 * talks to Apps Script, which talks to Google Sheets via SheetsAdapter.
 */
import * as auth from '../_lib/auth.js';
import * as batches from '../_lib/modules/batches.js';
import * as books from '../_lib/modules/books.js';
import * as receipts from '../_lib/modules/receipts.js';
import * as customers from '../_lib/modules/customers.js';
import * as custody from '../_lib/modules/custody.js';
import * as collections from '../_lib/modules/collections.js';
import * as deposits from '../_lib/modules/deposits.js';
import * as cheques from '../_lib/modules/cheques.js';
import * as guarantees from '../_lib/modules/guarantees.js';
import * as alerts from '../_lib/modules/alerts.js';
import * as movements from '../_lib/modules/movements.js';
import * as tracking from '../_lib/modules/tracking.js';
import * as audit from '../_lib/modules/audit.js';
import * as dashboard from '../_lib/modules/dashboard.js';
import * as reports from '../_lib/modules/reports.js';
import * as admin from '../_lib/modules/admin.js';

import { success, failure } from '../_lib/respond.js';
import { normalizeError } from '../_lib/errors.js';
import { requireBody, validateBody, queryFromRequest } from '../_lib/validate.js';
import { createRepository } from '../_lib/repository.js';
import { invalidate } from '../_lib/cache.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function readJson(request) {
  if (!request.body) return {};
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return requireBody(parsed);
  } catch (err) {
    if (err?.code === 'VALIDATION_ERROR') throw err;
    throw Object.assign(new Error('Malformed JSON body'), {
      code: 'VALIDATION_ERROR', status: 400
    });
  }
}

function match(method, segments, routes) {
  for (const route of routes) {
    if (route.method !== method || route.pattern.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.pattern.length; i++) {
      const token = route.pattern[i];
      if (token.startsWith(':')) {
        params[token.slice(1)] = decodeURIComponent(segments[i]);
      } else if (token !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Route table — literal paths are declared before dynamic paths.              */
/* Handler signature: (env, ctx, body, query, params, request)                  */
/* -------------------------------------------------------------------------- */

const ROUTES = [
  /* ---- Health / diagnostics --------------------------------------------- */
  { method: 'GET', pattern: ['health'], handler: () => ({
    ok: true, service: 'cms-phase1-api', time: new Date().toISOString()
  }) },
  { method: 'GET', pattern: ['ping'], handler: async (env, ctx) => {
    const repo = createRepository(env, ctx);
    return (await repo.call('ping', null, {})).data;
  } },

  /* ---- Authentication ---------------------------------------------------- */
  { method: 'POST', pattern: ['auth', 'login'], validate: 'login', handler: (env, ctx, body) =>
    auth.login(env, ctx, body.username, body.password) },
  { method: 'POST', pattern: ['auth', 'logout'], handler: (env, ctx) =>
    auth.logout(env, ctx) },
  { method: 'GET', pattern: ['auth', 'me'], handler: (env, ctx) =>
    auth.me(env, ctx) },

  /* ---- Admin / bootstrap ------------------------------------------------- */
  { method: 'POST', pattern: ['admin', 'bootstrap'], mutates: true, handler: async (env, ctx) => {
    const repo = createRepository(env, ctx);
    return (await repo.call('bootstrap', 'settings', {})).data;
  } },
  { method: 'GET', pattern: ['admin', 'users'], handler: (env, ctx, b, q) => admin.users(env, ctx, q) },
  { method: 'GET', pattern: ['admin', 'roles'], handler: (env, ctx) => admin.roles(env, ctx) },
  { method: 'GET', pattern: ['admin', 'role-permissions'], handler: (env, ctx) => admin.rolePermissions(env, ctx) },
  { method: 'GET', pattern: ['admin', 'settings'], handler: (env, ctx) => admin.settings(env, ctx) },

  /* ---- Customer master (external, daily-updated, READ ONLY) -------------- */
  // Literal paths first; `:account` is the unique customer identifier.
  { method: 'GET', pattern: ['customers', 'search'], handler: (env, ctx, b, q) =>
    customers.search(env, ctx, q) },
  { method: 'GET', pattern: ['customers', 'autocomplete'], handler: (env, ctx, b, q) =>
    customers.search(env, ctx, q) },
  { method: 'GET', pattern: ['customers', ':account', 'warehouse'], handler: (env, ctx, b, q, p) =>
    customers.warehouse(env, ctx, p.account) },
  { method: 'GET', pattern: ['customers', ':account', 'department'], handler: (env, ctx, b, q, p) =>
    customers.department(env, ctx, p.account) },
  { method: 'GET', pattern: ['customers', ':account'], handler: (env, ctx, b, q, p) =>
    customers.get(env, ctx, p.account) },

  /* ---- Structure derived from master values on operational documents ----- */
  { method: 'GET', pattern: ['structure'], handler: (env, ctx) => dashboard.structure(env, ctx) },

  /* ---- Book batches ------------------------------------------------------ */
  { method: 'GET', pattern: ['batches'], handler: (env, ctx, b, q) => batches.list(env, ctx, q) },
  { method: 'POST', pattern: ['batches'], validate: 'batch', mutates: true, handler: (env, ctx, body) =>
    batches.create(env, ctx, body) },
  { method: 'GET', pattern: ['batches', 'report'], handler: (env, ctx, b, q) => batches.report(env, ctx, q) },
  { method: 'GET', pattern: ['batches', ':id', 'books'], handler: (env, ctx, b, q, p) => batches.books(env, ctx, p.id) },
  { method: 'POST', pattern: ['batches', ':id', 'transition'], validate: 'transition', mutates: true,
    handler: (env, ctx, body, q, p) => batches.transition(env, ctx, p.id, body.toStatus, body) },
  { method: 'GET', pattern: ['batches', ':id'], handler: (env, ctx, b, q, p) => batches.get(env, ctx, p.id) },
  { method: 'PATCH', pattern: ['batches', ':id'], mutates: true, handler: (env, ctx, body, q, p) =>
    batches.update(env, ctx, p.id, body, body.version) },

  /* ---- Books ------------------------------------------------------------- */
  { method: 'GET', pattern: ['books'], handler: (env, ctx, b, q) => books.list(env, ctx, q) },
  { method: 'POST', pattern: ['books'], validate: 'book', mutates: true, handler: (env, ctx, body) =>
    books.create(env, ctx, body) },
  { method: 'GET', pattern: ['books', ':id', 'receipts'], handler: (env, ctx, b, q, p) =>
    books.receipts(env, ctx, p.id) },
  { method: 'POST', pattern: ['books', ':id', 'assign'], validate: 'assignment', mutates: true,
    handler: (env, ctx, body, q, p) => books.assign(env, ctx, p.id, body) },
  { method: 'POST', pattern: ['books', ':id', 'return'], mutates: true, handler: (env, ctx, body, q, p) =>
    books.returnBook(env, ctx, p.id, body) },
  { method: 'POST', pattern: ['books', ':id', 'transition'], validate: 'transition', mutates: true,
    handler: (env, ctx, body, q, p) => books.transition(env, ctx, p.id, body.toStatus, body) },
  { method: 'GET', pattern: ['books', ':id'], handler: (env, ctx, b, q, p) => books.get(env, ctx, p.id) },
  { method: 'PATCH', pattern: ['books', ':id'], mutates: true, handler: (env, ctx, body, q, p) =>
    books.update(env, ctx, p.id, body, body.version) },

  /* ---- Receipts ---------------------------------------------------------- */
  { method: 'GET', pattern: ['receipts'], handler: (env, ctx, b, q) => receipts.list(env, ctx, q) },
  { method: 'POST', pattern: ['receipts'], mutates: true, handler: (env, ctx, body) =>
    receipts.insert(env, ctx, body) },
  { method: 'GET', pattern: ['receipts', ':id', 'history'], handler: (env, ctx, b, q, p) =>
    receipts.history(env, ctx, p.id) },
  { method: 'POST', pattern: ['receipts', ':id', 'collect'], validate: 'collect', mutates: true,
    handler: (env, ctx, body, q, p) => receipts.collect(env, ctx, p.id, body) },
  { method: 'POST', pattern: ['receipts', ':id', 'cancel'], mutates: true, handler: (env, ctx, body, q, p) =>
    receipts.cancel(env, ctx, p.id, body.reason) },
  { method: 'POST', pattern: ['receipts', ':id', 'lost'], mutates: true, handler: (env, ctx, body, q, p) =>
    receipts.markLost(env, ctx, p.id, body.reason) },
  { method: 'GET', pattern: ['receipts', ':id'], handler: (env, ctx, b, q, p) => receipts.get(env, ctx, p.id) },
  { method: 'PATCH', pattern: ['receipts', ':id'], mutates: true, handler: (env, ctx, body, q, p) =>
    receipts.update(env, ctx, p.id, body, body.version) },

  /* ---- Collections ------------------------------------------------------- */
  { method: 'GET', pattern: ['collections'], handler: (env, ctx, b, q) => collections.list(env, ctx, q) },
  { method: 'POST', pattern: ['collections'], mutates: true, handler: (env, ctx, body) =>
    collections.create(env, ctx, body) },
  { method: 'POST', pattern: ['collections', ':id', 'reconcile'], mutates: true,
    handler: (env, ctx, body, q, p) => collections.reconcile(env, ctx, p.id) },
  { method: 'GET', pattern: ['collections', ':id'], handler: (env, ctx, b, q, p) => collections.get(env, ctx, p.id) },
  { method: 'PATCH', pattern: ['collections', ':id'], mutates: true, handler: (env, ctx, body, q, p) =>
    collections.update(env, ctx, p.id, body, body.version) },

  /* ---- Deposits (branch / hq) ------------------------------------------- */
  { method: 'GET', pattern: ['deposits', 'branch'], handler: (env, ctx, b, q) => deposits.list(env, ctx, 'branch', q) },
  { method: 'POST', pattern: ['deposits', 'branch'], validate: 'deposit', mutates: true,
    handler: (env, ctx, body) => deposits.create(env, ctx, 'branch', body) },
  { method: 'GET', pattern: ['deposits', 'branch', ':id', 'lines'], handler: (env, ctx, b, q, p) =>
    deposits.lines(env, ctx, 'branch', p.id) },
  { method: 'POST', pattern: ['deposits', 'branch', ':id', 'confirm'], mutates: true,
    handler: (env, ctx, body, q, p) => deposits.confirm(env, ctx, 'branch', p.id) },
  { method: 'GET', pattern: ['deposits', 'branch', ':id'], handler: (env, ctx, b, q, p) =>
    deposits.get(env, ctx, 'branch', p.id) },
  { method: 'GET', pattern: ['deposits', 'hq'], handler: (env, ctx, b, q) => deposits.list(env, ctx, 'hq', q) },
  { method: 'POST', pattern: ['deposits', 'hq'], validate: 'deposit', mutates: true,
    handler: (env, ctx, body) => deposits.create(env, ctx, 'hq', body) },
  { method: 'GET', pattern: ['deposits', 'hq', ':id', 'lines'], handler: (env, ctx, b, q, p) =>
    deposits.lines(env, ctx, 'hq', p.id) },
  { method: 'POST', pattern: ['deposits', 'hq', ':id', 'confirm'], mutates: true,
    handler: (env, ctx, body, q, p) => deposits.confirm(env, ctx, 'hq', p.id) },
  { method: 'GET', pattern: ['deposits', 'hq', ':id'], handler: (env, ctx, b, q, p) =>
    deposits.get(env, ctx, 'hq', p.id) },

  /* ---- Cheques ----------------------------------------------------------- */
  { method: 'GET', pattern: ['cheques'], handler: (env, ctx, b, q) => cheques.list(env, ctx, q) },
  { method: 'POST', pattern: ['cheques'], validate: 'cheque', mutates: true, handler: (env, ctx, body) =>
    cheques.create(env, ctx, body) },
  { method: 'GET', pattern: ['cheques', 'overdue'], handler: (env, ctx, b, q) => cheques.overdue(env, ctx, q) },
  { method: 'GET', pattern: ['cheques', 'clearing'], handler: (env, ctx, b, q) => cheques.clearing(env, ctx, q) },
  { method: 'POST', pattern: ['cheques', ':id', 'transition'], validate: 'transition', mutates: true,
    handler: (env, ctx, body, q, p) => cheques.transition(env, ctx, p.id, body.toStatus, body) },
  { method: 'GET', pattern: ['cheques', ':id'], handler: (env, ctx, b, q, p) => cheques.get(env, ctx, p.id) },
  { method: 'PATCH', pattern: ['cheques', ':id'], mutates: true, handler: (env, ctx, body, q, p) =>
    cheques.update(env, ctx, p.id, body, body.version) },

  /* ---- Guarantees -------------------------------------------------------- */
  { method: 'GET', pattern: ['guarantees'], handler: (env, ctx, b, q) => guarantees.list(env, ctx, q) },
  { method: 'POST', pattern: ['guarantees'], validate: 'guarantee', mutates: true, handler: (env, ctx, body) =>
    guarantees.create(env, ctx, body) },
  { method: 'GET', pattern: ['guarantees', 'alerts'], handler: (env, ctx, b, q) => guarantees.alerts(env, ctx, q) },
  { method: 'POST', pattern: ['guarantees', ':id', 'transition'], validate: 'transition', mutates: true,
    handler: (env, ctx, body, q, p) => guarantees.transition(env, ctx, p.id, body.toStatus, body) },
  { method: 'GET', pattern: ['guarantees', ':id'], handler: (env, ctx, b, q, p) => guarantees.get(env, ctx, p.id) },
  { method: 'PATCH', pattern: ['guarantees', ':id'], mutates: true, handler: (env, ctx, body, q, p) =>
    guarantees.update(env, ctx, p.id, body, body.version) },

  /* ---- Custody ----------------------------------------------------------- */
  { method: 'GET', pattern: ['custody', 'balances'], handler: (env, ctx, b, q) => custody.balances(env, ctx, q) },
  { method: 'GET', pattern: ['custody', 'ledger'], handler: (env, ctx, b, q) => custody.ledger(env, ctx, q) },
  { method: 'GET', pattern: ['custody', 'exceptions'], handler: (env, ctx, b, q) => custody.exceptions(env, ctx, q) },
  { method: 'POST', pattern: ['custody', 'reconcile'], mutates: true, handler: (env, ctx) =>
    custody.reconcile(env, ctx) },

  /* ---- Alerts ------------------------------------------------------------ */
  { method: 'GET', pattern: ['alerts'], handler: (env, ctx, b, q) => alerts.list(env, ctx, q) },
  { method: 'GET', pattern: ['alerts', 'summary'], handler: (env, ctx) => alerts.summary(env, ctx) },
  { method: 'POST', pattern: ['alerts', 'scan'], mutates: true, handler: (env, ctx) => alerts.scan(env, ctx) },
  { method: 'POST', pattern: ['alerts', ':id', 'acknowledge'], mutates: true, handler: (env, ctx, body, q, p) =>
    alerts.acknowledge(env, ctx, p.id) },

  /* ---- Movements --------------------------------------------------------- */
  { method: 'GET', pattern: ['movements'], handler: (env, ctx, b, q) => movements.list(env, ctx, q) },
  { method: 'POST', pattern: ['movements'], validate: 'movement', mutates: true, handler: (env, ctx, body) =>
    movements.create(env, ctx, body) },
  { method: 'GET', pattern: ['movements', 'history', ':type', ':number'], handler: (env, ctx, b, q, p) =>
    movements.history(env, ctx, p.type, p.number) },
  { method: 'GET', pattern: ['movements', ':id'], handler: (env, ctx, b, q, p) => movements.get(env, ctx, p.id) },

  /* ---- Tracking (universal search by number) ---------------------------- */
  { method: 'GET', pattern: ['track', ':type', ':number'], handler: (env, ctx, b, q, p) =>
    tracking.trackTyped(env, ctx, p.type, p.number) },
  { method: 'GET', pattern: ['track', ':number'], handler: (env, ctx, b, q, p) =>
    tracking.track(env, ctx, p.number) },

  /* ---- Dashboard --------------------------------------------------------- */
  { method: 'GET', pattern: ['dashboard', 'summary'], handler: (env, ctx, b, q) => dashboard.summary(env, ctx, q) },
  { method: 'GET', pattern: ['dashboard', 'custody'], handler: (env, ctx, b, q) => dashboard.custody(env, ctx, q) },
  { method: 'GET', pattern: ['dashboard', 'structure'], handler: (env, ctx) => dashboard.structure(env, ctx) },

  /* ---- Reports ----------------------------------------------------------- */
  { method: 'GET', pattern: ['reports', 'outstanding-collections'], handler: (env, ctx, b, q) =>
    reports.outstandingCollections(env, ctx, q) },
  { method: 'GET', pattern: ['reports', 'receipts-in-transit'], handler: (env, ctx, b, q) =>
    reports.receiptsInTransit(env, ctx, q) },
  { method: 'GET', pattern: ['reports', 'by-warehouse'], handler: (env, ctx, b, q) =>
    reports.byWarehouse(env, ctx, q) },
  { method: 'GET', pattern: ['reports', 'by-department'], handler: (env, ctx, b, q) =>
    reports.byDepartment(env, ctx, q) },

  /* ---- Audit (append-only, Phase 1) ------------------------------------- */
  { method: 'GET', pattern: ['audit'], handler: (env, ctx, b, q) => audit.list(env, ctx, q) }
];

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                  */
/* -------------------------------------------------------------------------- */

export async function onRequest(context) {
  const { request, env, data } = context;
  const ctx = data?.cms;

  if (!ctx) {
    return failure(500, 'MIDDLEWARE_ERROR', 'API context was not initialized', [], crypto.randomUUID());
  }

  try {
    // Normalize the path: strip /api and the optional /v1 prefix.
    let segments = (context.params?.path || []).slice();
    if (!segments.length) {
      segments = new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
    }
    if (segments[0] === 'v1') segments = segments.slice(1);

    if (!segments.length) {
      return success({ service: 'cms-phase1-api', version: 'v1' }, {}, 200, ctx.requestId);
    }

    const method = request.method.toUpperCase();
    const found = match(method, segments, ROUTES);
    if (!found) {
      return failure(404, 'NOT_FOUND', `No route for ${method} /${segments.join('/')}`, [], ctx.requestId);
    }

    const body = ['GET', 'HEAD'].includes(method) ? {} : await readJson(request);
    if (found.route.validate) validateBody(found.route.validate, body);

    const query = queryFromRequest(request);
    const result = await found.route.handler(env, ctx, body, query, found.params, request);

    if (found.route.mutates) {
      await invalidate(env, ['dashboard:summary', 'dashboard:custody', 'tracking']);
    }

    return success(result, {}, 200, ctx.requestId);
  } catch (error) {
    const normalized = normalizeError(error);
    return failure(normalized.status, normalized.code, normalized.message, normalized.details, ctx.requestId);
  }
}
