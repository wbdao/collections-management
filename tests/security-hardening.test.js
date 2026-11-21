/** PHASE 2 — regression tests for the Phase 1 security gap fixes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { hasPermission } from '../functions/_lib/rbac.js';
import { assertExplicitScope, assertScope } from '../functions/_lib/scope.js';
import { mapCode } from '../functions/_lib/gas-client.js';
import { enforceRateLimit } from '../functions/_lib/ratelimit.js';
import { publicUser } from '../functions/_lib/modules/admin.js';
import {
  TOKEN_TTL, issueAccessToken, issueMfaChallengeToken, verifyAccessToken, unb64url
} from '../functions/_lib/auth.js';

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

/* ---- Regressions for the post-staging security review --------------------- */

test('admin user projection strips password hashes and MFA secrets', () => {
  const safe = publicUser({
    user_id: 'USR1', username: 'admin', full_name: 'Admin', email: 'a@b.c',
    role_id: 'ROLE_ADMIN', status: 'ACTIVE', scopes: [],
    password_hash: 'HASH', mfa_secret: 'SECRET', recovery_hashes: ['X']
  });
  assert.equal(safe.user_id, 'USR1');
  assert.equal(safe.username, 'admin');
  assert.equal(safe.password_hash, undefined);
  assert.equal(safe.mfa_secret, undefined);
  assert.equal(safe.recovery_hashes, undefined);
});

test('collector scope denies rows without any holder identity', () => {
  const ctx = { actor: { userId: 'USR1', role: 'COLLECTOR', scopes: [] } };
  assert.throws(() => assertScope(ctx, { book_id: 'B1', warehouse: 'W1' }),
    (error) => error.code === 'FORBIDDEN');
  assert.equal(assertScope(ctx, { collector_id: 'USR1', book_id: 'B1' }), true);
  assert.throws(() => assertScope(ctx, { collector_id: 'USR2', book_id: 'B2' }),
    (error) => error.code === 'FORBIDDEN');
});

function toPem(buffer, label) {
  const base64 = Buffer.from(buffer).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keyEnv(kv) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  return {
    JWT_PRIVATE_KEY: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'),
    JWT_PUBLIC_KEY: toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
    JWT_ISSUER: 'cms-api', JWT_AUDIENCE: 'cms-web', KV: kv
  };
}

test('same-second subject revocation invalidates the token', async () => {
  const data = new Map();
  const env = await keyEnv({
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value) { data.set(key, value); }
  });
  const identity = { userId: 'USR1', username: 'u', role: 'ADMIN', scopes: [] };
  const { token } = await issueAccessToken(env, identity, []);
  const claims = JSON.parse(unb64url(token.split('.')[1]));
  // Simulate logout in the very same second the token was issued.
  data.set('revoke:sub:USR1', String(claims.iat));
  await assert.rejects(() => verifyAccessToken(env, token), /Session revoked/);
});

test('MFA challenges have a distinct 5-minute TTL', async () => {
  const env = await keyEnv({ async get() { return null; }, async put() {} });
  assert.equal(TOKEN_TTL.mfa, 300);
  const challenge = await issueMfaChallengeToken(env, {
    userId: 'USR1', username: 'u', role: 'ADMIN', scopes: []
  }, ['TOTP']);
  assert.equal(challenge.expiresIn, 300);
  const claims = await verifyAccessToken(env, challenge.token, { audience: 'cms-mfa' });
  assert.equal(claims.exp - claims.iat, 300);
});

test('no known default admin password remains in the Apps Script config', () => {
  const source = fs.readFileSync(new URL('../apps-script/config.gs', import.meta.url), 'utf8');
  assert.equal(source.includes('Admin@12345'), false);
  assert.match(source, /require\('BOOTSTRAP_ADMIN_PASSWORD'\)/);
});

test('MFA verification sends the challenge token as Bearer', () => {
  const source = fs.readFileSync(new URL('../frontend/js/pages/login.js', import.meta.url), 'utf8');
  assert.match(source, /api\.post\('\/auth\/mfa\/verify'[\s\S]*?authToken: challenge\.mfaToken/);
});

test('scope-sensitive modules guard detail reads and every mutation', () => {
  const expected = {
    collections: { getInScope: 1, guardScope: 2, scopeForCreate: 1 },
    books:       { getInScope: 1, guardScope: 5, scopeForCreate: 1 },
    receipts:    { getInScope: 0, guardScope: 5, scopeForCreate: 1 },
    batches:     { getInScope: 1, guardScope: 3, scopeForCreate: 1 },
    deposits:    { getInScope: 1, guardScope: 1, scopeForCreate: 1 }
  };
  for (const [name, counts] of Object.entries(expected)) {
    const source = fs.readFileSync(
      new URL(`../functions/_lib/modules/${name}.js`, import.meta.url), 'utf8'
    );
    for (const [helper, expectedCount] of Object.entries(counts)) {
      const actual = (source.match(new RegExp(`${helper}\\(`, 'g')) || []).length;
      assert.equal(actual, expectedCount, `${name}.js ${helper} call count`);
    }
  }
});
