/** PHASE 2 — regression tests for the Phase 1 security gap fixes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPermission } from '../functions/_lib/rbac.js';
import { assertExplicitScope } from '../functions/_lib/scope.js';
import { mapCode } from '../functions/_lib/gas-client.js';
import { enforceRateLimit } from '../functions/_lib/ratelimit.js';

test('rbac honours the wildcard permission', () => {
  const ctx = { actor: { role: 'ADMIN', permissions: ['*'] } };
  assert.equal(hasPermission(ctx, 'audit.verify'), true);
  assert.equal(hasPermission(ctx, 'anything.at.all'), true);
});

test('rbac preserves role fallback when permissions are absent', () => {
  const ctx = { actor: { role: 'AUDITOR' } };
  assert.equal(hasPermission(ctx, 'audit.read'), true);
  assert.equal(hasPermission(ctx, 'books.create'), false);
});

test('rbac does not broaden an explicitly empty permission list', () => {
  const ctx = { actor: { role: 'COLLECTOR', permissions: [] } };
  assert.equal(hasPermission(ctx, 'books.create'), false);
});

test('assertExplicitScope rejects scoped roles with no scopes but allows admins', () => {
  assert.equal(assertExplicitScope({ actor: { role: 'ADMIN', scopes: [] } }), true);
  assert.equal(assertExplicitScope({ actor: { role: 'AUDITOR', scopes: [] } }), true);
  assert.throws(
    () => assertExplicitScope({ actor: { role: 'TREASURY', scopes: [] } }),
    (error) => error.code === 'FORBIDDEN'
  );
  assert.equal(assertExplicitScope({
    actor: { role: 'TREASURY', scopes: [{ type: 'WAREHOUSE', id: 'W1' }] }
  }), true);
});

test('upstream auth error codes map to HTTP 401 (previously 500)', () => {
  for (const code of ['INVALID_CREDENTIALS', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED',
    'MFA_REQUIRED', 'MFA_INVALID', 'REFRESH_REUSE', 'TOKEN_EXPIRED']) {
    assert.equal(mapCode(code), 401, code);
  }
});

test('rate limit keys separate buckets, identities and fixed windows', async () => {
  const data = new Map();
  const kv = {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value, options) { data.set(key, value); kv.lastOptions = options; }
  };
  const env = { KV: kv };
  const ctx = { actor: { userId: 'USR1' }, ip: '1.2.3.4' };
  await enforceRateLimit(env, ctx, 'api', 120, 60);
  await enforceRateLimit(env, ctx, 'ip', 300, 60, '1.2.3.4');
  const keys = [...data.keys()];
  assert.equal(keys.length, 2);
  assert.ok(keys.some((k) => k.startsWith('rl:api:USR1:')));
  assert.ok(keys.some((k) => k.startsWith('rl:ip:1.2.3.4:')));
  assert.ok(kv.lastOptions.expirationTtl >= 60);
});

test('rate limiting degrades open when KV is unavailable', async () => {
  await enforceRateLimit({}, { actor: { userId: 'USR1' } }, 'api', 0, 60);
});
