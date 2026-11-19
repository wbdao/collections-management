/** PHASE 2 / Step 11 — layered rate limits, non-recursive event logging,
 *  security endpoints and deterministic account lockout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceRateLimit, enforcePerIpLimit, enforceAuthUserLimit, enforceMfaLimit,
  enforceBootstrapLimit, recordRateLimitEvent
} from '../functions/_lib/ratelimit.js';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import * as security from '../functions/_lib/modules/security.js';
import * as admin from '../functions/_lib/modules/admin.js';
import { loadGs } from './helpers/gas-harness.js';

/* -------------------------------------------------------------------------- */
/* KV helpers                                                                   */
/* -------------------------------------------------------------------------- */

function kvEnv(mutate) {
  const data = new Map();
  const kv = {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value, options) { data.set(key, value); kv.lastOptions = options; },
    async delete(key) { data.delete(key); }
  };
  const env = { KV: kv, GAS_URL: 'https://example.com/exec', GAS_SHARED_SECRET: 'secret' };
  if (mutate) mutate(env, kv, data);
  return { env, kv, data };
}

/* -------------------------------------------------------------------------- */
/* Layered limits                                                               */
/* -------------------------------------------------------------------------- */

test('layered limit helpers use distinct keys and enforce their configured caps', async () => {
  const { env, data } = kvEnv();
  const ctx = { actor: { userId: 'USR1' }, ip: '203.0.113.7' };
  await enforcePerIpLimit(env, ctx);
  await enforceAuthUserLimit(env, ctx, 'USR1');
  await enforceMfaLimit(env, ctx);
  await enforceBootstrapLimit(env, ctx);
  const keys = [...data.keys()];
  assert.equal(keys.length, 4);
  assert.ok(keys.some((k) => k.startsWith('rl:ip:203.0.113.7:')));
  assert.ok(keys.some((k) => k.startsWith('rl:auth_user:USR1:')));
  assert.ok(keys.some((k) => k.startsWith('rl:mfa:USR1:')));
  assert.ok(keys.some((k) => k.startsWith('rl:bootstrap:203.0.113.7:')));
});

test('exceeding a layered limit throws RATE_LIMITED with the bucket name', async () => {
  const { env } = kvEnv((_e, kv) => {
    const originalGet = kv.get;
    kv.get = async (key) => (key.startsWith('rl:mfa:') ? '99' : originalGet(key));
  });
  await assert.rejects(() => enforceMfaLimit(env, { actor: { userId: 'USR1' } }), (err) => {
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.status, 429);
    assert.equal(err.bucket, 'mfa');
    assert.equal(err.details[0].retryAfter, 300);
    return true;
  });
});

test('all layered helpers degrade open when KV is unavailable', async () => {
  const env = {};
  const ctx = { actor: { userId: 'USR1' }, ip: '1.1.1.1' };
  await enforcePerIpLimit(env, ctx);
  await enforceAuthUserLimit(env, ctx);
  await enforceMfaLimit(env, ctx);
  await enforceBootstrapLimit(env, ctx);
});

/* -------------------------------------------------------------------------- */
/* Non-recursive RATE_LIMITED event                                              */
/* -------------------------------------------------------------------------- */

test('recordRateLimitEvent writes a RATE_LIMITED event directly via GAS', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: {}, meta: {} }),
      { status: 200 });
  };
  try {
    const { env } = kvEnv();
    const ctx = { requestId: 'REQ-1', ip: '198.51.100.9', actor: { userId: 'USR1' } };
    assert.equal(await recordRateLimitEvent(env, ctx, 'ip'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'security.event');
    assert.equal(calls[0].entity, 'security_events');
    assert.equal(calls[0].payload.eventType, 'RATE_LIMITED');
    assert.equal(calls[0].payload.severity, 'WARNING');
    assert.equal(calls[0].payload.details.bucket, 'ip');
    assert.equal(calls[0].payload.userId, 'USR1');
    assert.equal(calls[0].payload.ip, '198.51.100.9');
    // The signed envelope carries the IP so the GAS audit path stays intact.
    assert.equal(calls[0].actor.ip, '198.51.100.9');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recordRateLimitEvent dedupes per identity per minute (no event flood)', async () => {
  let writes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    writes += 1;
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: {}, meta: {} }),
      { status: 200 });
  };
  try {
    const { env } = kvEnv();
    const ctx = { requestId: 'REQ-2', ip: '198.51.100.10', actor: { userId: 'USR2' } };
    assert.equal(await recordRateLimitEvent(env, ctx, 'api'), true);
    assert.equal(await recordRateLimitEvent(env, ctx, 'api'), false);
    assert.equal(await recordRateLimitEvent(env, ctx, 'mfa'), false); // same minute bucket
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recordRateLimitEvent degrades silently when GAS/KV is unavailable', async () => {
  const noKv = await recordRateLimitEvent({}, { ip: '1.2.3.4' }, 'ip');
  assert.equal(noKv, false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const { env } = kvEnv();
    assert.equal(await recordRateLimitEvent(env, { ip: '5.6.7.8' }, 'login'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('middleware offloads RATE_LIMITED event writing and still returns 429', async () => {
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    writes.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: {}, meta: {} }),
      { status: 200 });
  };
  try {
    const { env } = kvEnv((_e, kv) => {
      const originalGet = kv.get;
      kv.get = async (key) => (key.startsWith('rl:ip:') ? '999' : originalGet(key));
    });
    const pending = [];
    const request = new Request('https://example.com/api/v1/customers/search', {
      headers: { 'CF-Connecting-IP': '203.0.113.99' }
    });
    const response = await middleware({
      request, env,
      waitUntil: (p) => pending.push(p),
      next: () => { throw new Error('next should not run when rate limited'); }
    });
    assert.equal(response.status, 429);
    assert.equal(await response.json().then((b) => b.error.code), 'RATE_LIMITED');
    await Promise.all(pending);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].payload.eventType, 'RATE_LIMITED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* -------------------------------------------------------------------------- */
/* Edge security endpoints                                                      */
/* -------------------------------------------------------------------------- */

const CTX = { requestId: 'REQ', ip: '1.2.3.4', actor: { userId: 'admin', role: 'ADMIN', permissions: ['*'], scopes: [] } };
const AUDITOR = { requestId: 'REQ', ip: '1.2.3.4', actor: { userId: 'aud', role: 'AUDITOR', permissions: ['security.read'], scopes: [] } };
const COLLECTOR = { requestId: 'REQ', ip: '1.2.3.4', actor: { userId: 'col', role: 'COLLECTOR', permissions: ['security.read'], scopes: [] } };
const ENV = { GAS_URL: 'https://example.com/exec', GAS_SHARED_SECRET: 'secret' };

test('edge security.events requires security.read and explicit scope', async () => {
  await assert.rejects(() => security.events(ENV, { actor: { role: 'COLLECTOR', permissions: [] } }),
    (err) => err.code === 'FORBIDDEN');
  await assert.rejects(() => security.events(ENV, COLLECTOR),
    (err) => err.code === 'FORBIDDEN'); // no warehouse/branch scopes
});

test('edge security.events forwards filters for ADMIN/AUDITOR', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      protocol: 'cms-repo/v1', ok: true,
      data: { items: [{ event_type: 'ACCOUNT_LOCKED' }] }, meta: {}
    }), { status: 200 });
  };
  try {
    const items = await security.events(ENV, AUDITOR, { eventType: 'ACCOUNT_LOCKED', limit: 5 });
    assert.equal(items.length, 1);
    assert.equal(calls[0].action, 'security.events');
    assert.equal(calls[0].payload.eventType, 'ACCOUNT_LOCKED');
    assert.equal(calls[0].payload.limit, 5);
    await security.me(ENV, CTX);
    assert.equal(calls[1].action, 'security.me');
    assert.equal(calls[1].payload.userId, 'admin'); // self-service uses the token subject
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('edge admin.unlockUser requires users.manage and a userId', async () => {
  await assert.rejects(() => admin.unlockUser(ENV, AUDITOR, 'USR1'),
    (err) => err.code === 'FORBIDDEN');
  await assert.rejects(() => admin.unlockUser(ENV, CTX, ''),
    (err) => err.code === 'VALIDATION_ERROR');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ protocol: 'cms-repo/v1', ok: true, data: { unlocked: true }, meta: {} }),
      { status: 200 });
  };
  try {
    const result = await admin.unlockUser(ENV, CTX, 'USR1');
    assert.equal(result.unlocked, true);
    assert.equal(calls[0].action, 'security.unlock');
    assert.equal(calls[0].payload.userId, 'USR1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* -------------------------------------------------------------------------- */
/* GAS account lockout                                                          */
/* -------------------------------------------------------------------------- */

function authHarness() {
  const h = loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/auth-service.gs'
  ], {
    AuditService: { write() { return {}; } },
    ROLE_PERMISSION_MAP: { ADMIN: ['audit.read'] }
  });
  const passwordHash = h.sandbox.AuthService.hashPassword('Test@12345', 'salt', 2);
  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'USR1', username: 'admin', full_name: 'Admin', email: 'admin@example.com',
    role_id: 'ROLE_ADMIN', status: 'ACTIVE', password_hash: passwordHash,
    failed_attempts: 0, locked_until: '', version: 1, mfa_enabled: false, mfa_secret: ''
  });
  return h;
}

test('five failed passwords lock the account and write one ACCOUNT_LOCKED event', () => {
  const h = authHarness();
  const AuthService = h.sandbox.AuthService;
  for (let i = 0; i < 4; i++) {
    assert.throws(() => AuthService.login('admin', 'wrong', '1.2.3.4'),
      (err) => err.code === 'INVALID_CREDENTIALS');
  }
  assert.equal(h.securityEvents.length, 0);
  assert.throws(() => AuthService.login('admin', 'wrong', '1.2.3.4'),
    (err) => err.code === 'ACCOUNT_LOCKED');
  assert.equal(h.securityEvents.length, 1);
  assert.equal(h.securityEvents[0].eventType, 'ACCOUNT_LOCKED');

  const row = h.store.rows.users[0];
  assert.equal(Number(row.failed_attempts), 5);
  assert.ok(Date.parse(row.locked_until) > Date.now());

  // While locked, even the correct password is rejected and re-logs the event.
  assert.throws(() => AuthService.login('admin', 'Test@12345', '1.2.3.4'),
    (err) => err.code === 'ACCOUNT_LOCKED');
  assert.equal(h.securityEvents.length, 2);
});

test('a correct password resets failed attempts and never emits a lock event', () => {
  const h = authHarness();
  const AuthService = h.sandbox.AuthService;
  assert.throws(() => AuthService.login('admin', 'wrong', '1.2.3.4'),
    (err) => err.code === 'INVALID_CREDENTIALS');
  assert.equal(Number(h.store.rows.users[0].failed_attempts), 1);
  const result = AuthService.login('admin', 'Test@12345', '1.2.3.4');
  assert.equal(result.user.userId, 'USR1');
  assert.equal(Number(h.store.rows.users[0].failed_attempts), 0);
  assert.equal(h.securityEvents.length, 0);
});

test('an expired lock auto-unlocks on the next successful login (single version bump)', () => {
  const h = authHarness();
  const row = h.store.rows.users[0];
  row.failed_attempts = 5;
  row.locked_until = new Date(Date.now() - 60 * 1000).toISOString();
  row.version = 7;

  const AuthService = h.sandbox.AuthService;
  assert.equal(AuthService.lockStatus(row).expired, true);
  const result = AuthService.login('admin', 'Test@12345', '1.2.3.4');
  assert.equal(result.user.userId, 'USR1');
  assert.equal(Number(h.store.rows.users[0].failed_attempts), 0);
  assert.equal(h.store.rows.users[0].locked_until, '');
  assert.equal(Number(h.store.rows.users[0].version), 8); // exactly one update
  assert.equal(h.securityEvents.length, 0);
});

test('ADMIN unlock clears the lock, writes ADMIN_UNLOCK and audits the change', () => {
  const h = authHarness();
  const row = h.store.rows.users[0];
  row.failed_attempts = 5;
  row.locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const ctx = { requestId: 'REQ-U', ip: '9.8.7.6', actor: { role: 'ADMIN', userId: 'root' } };
  const result = h.sandbox.AuthService.unlockUser('USR1', ctx);
  assert.equal(result.unlocked, true);
  assert.equal(Number(h.store.rows.users[0].failed_attempts), 0);
  assert.equal(h.store.rows.users[0].locked_until, '');
  assert.equal(h.securityEvents.length, 1);
  assert.equal(h.securityEvents[0].eventType, 'ADMIN_UNLOCK');
  assert.equal(h.securityEvents[0].details.unlockedBy, 'root');
  assert.equal(Number(h.store.rows.users[0].version), 2);

  // After unlock the user can log in again.
  assert.equal(h.sandbox.AuthService.login('admin', 'Test@12345', '1.2.3.4').user.userId, 'USR1');
});

test('router enforces ADMIN for security.unlock and exposes security.me', () => {
  const h = loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/auth-service.gs',
    'apps-script/router.gs'
  ], {
    AuditService: { write() { return {}; } },
    ROLE_PERMISSION_MAP: { ADMIN: ['audit.read'] },
    SessionService: { list: () => [{ session_id: 'SES1' }] }
  });
  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'USR1', username: 'admin', role_id: 'ROLE_ADMIN', status: 'ACTIVE',
    password_hash: 'x', failed_attempts: 0, locked_until: '', version: 1,
    mfa_enabled: false, mfa_secret: ''
  });

  const router = h.sandbox.Router;
  assert.throws(() => router.handle({
    action: 'security.unlock', payload: { userId: 'USR1' },
    actor: { role: 'TREASURY', userId: 't' }
  }), (err) => err.code === 'FORBIDDEN');

  const me = router.handle({ action: 'security.me', payload: { userId: 'USR1' },
    actor: { role: 'ADMIN', userId: 'admin' } }).data;
  assert.equal(me.userId, 'USR1');
  assert.equal(me.lock.locked, false);
  assert.equal(me.sessions.length, 1);
  assert.ok(Array.isArray(me.recentEvents));

  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'USR2', username: 'u2', role_id: 'ROLE_ADMIN', status: 'ACTIVE',
    password_hash: 'x', failed_attempts: 5,
    locked_until: new Date(Date.now() + 600000).toISOString(), version: 1
  });
  const unlocked = router.handle({ action: 'security.unlock', payload: { userId: 'USR2' },
    actor: { role: 'ADMIN', userId: 'root' } }).data;
  assert.equal(unlocked.unlocked, true);
  assert.equal(Number(h.store.rows.users[1].failed_attempts), 0);
});
