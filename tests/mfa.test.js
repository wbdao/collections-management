/** PHASE 2 / Step 3 — edge MFA primitives and GAS-side MFA policy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, constantTimeEqual, sha256Hex, totp, verifyTotp,
  generateTotpSecret, provisioningUri, generateRecoveryCodes,
  issueEmailOtp, verifyEmailOtp, mfaError
} from '../functions/_lib/mfa.js';
import { loadGs } from './helpers/gas-harness.js';

const CTX = { requestId: 'req-mfa', ip: '198.51.100.4', actor: { userId: 'USR1' } };

test('base32 round-trips binary data', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  assert.equal(base32Decode(base32Encode(bytes)).join(','), bytes.join(','));
  // RFC 4648-style known vector: "Hello!" + 0xDEADBEEF.
  assert.equal(base32Decode('JBSWY3DPEHPK3PXP').join(','),
    new Uint8Array([72, 101, 108, 108, 111, 33, 222, 173, 190, 239]).join(','));
});

test('TOTP is deterministic, 6 digits and accepts a ±1 step window', async () => {
  const secret = base32Encode(new Uint8Array(20).fill(7));
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30000);
  const code = await totp(secret, step);
  assert.match(code, /^\d{6}$/);
  assert.equal(await totp(secret, step), code);
  assert.equal(await verifyTotp(secret, code, now), true);
  assert.equal(await verifyTotp(secret, code, now + 30000), true);
  assert.equal(await verifyTotp(secret, code, now + 90000), false);
  assert.equal(await verifyTotp(base32Encode(new Uint8Array(20).fill(8)), code, now), false);
});

test('enrolment artefacts use SHA256 TOTP and hashed recovery codes', async () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const uri = provisioningUri('admin', secret);
  assert.match(uri, /algorithm=SHA256/);
  assert.match(uri, /digits=6&period=30/);
  assert.match(uri, /secret=/);

  const recovery = await generateRecoveryCodes();
  assert.equal(recovery.codes.length, 8);
  assert.ok(recovery.codes.every((code) => /^[0-9A-F]{16}$/.test(code)));
  assert.equal(await sha256Hex(recovery.codes[0]), recovery.hashes[0]);
});

test('constant-time comparison and mfaError carry the API contract', async () => {
  assert.equal(constantTimeEqual('123456', '123456'), true);
  assert.equal(constantTimeEqual('123456', '654321'), false);
  assert.equal(constantTimeEqual('1234', '12345'), false);
  const error = mfaError('MFA_INVALID', 'bad code');
  assert.equal(error.code, 'MFA_INVALID');
  assert.equal(error.status, 401);
});

function kvEnv() {
  const data = new Map();
  const kv = {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async put(key, value, options) { data.set(key, value); kv.lastOptions = options; },
    async delete(key) { data.delete(key); }
  };
  return { env: { KV: kv }, data, kv };
}

test('email OTP is delivered, stored hashed, and verified once', async () => {
  const { env, data, kv } = kvEnv();
  let deliveredCode = '';
  const sender = {
    async send(_env, _ctx, input) {
      deliveredCode = input.code;
      assert.equal(input.code.length, 6);
      return { delivered: true, channel: 'EMAIL' };
    }
  };

  const issued = await issueEmailOtp(env, CTX, 'USR1', 'admin@example.com', sender);
  assert.equal(issued.delivered, true);
  assert.equal(issued.channel, 'EMAIL');
  assert.equal(kv.lastOptions.expirationTtl, 300);
  const stored = JSON.parse([...data.values()][0]);
  assert.equal(stored.hash, await sha256Hex(stored.salt + ':' + deliveredCode));
  assert.ok(!JSON.stringify(stored).includes(deliveredCode));

  assert.equal(await verifyEmailOtp(env, CTX, 'USR1', deliveredCode), true);
  assert.equal(data.size, 0, 'challenge must be consumed');
  await assert.rejects(
    () => verifyEmailOtp(env, CTX, 'USR1', deliveredCode),
    (error) => error.code === 'MFA_INVALID'
  );
});

test('five wrong email OTP attempts invalidate the challenge', async () => {
  const { env, data } = kvEnv();
  let real = '';
  const sender = {
    async send(_e, _c, input) { real = input.code; return { delivered: true, channel: 'EMAIL' }; }
  };
  await issueEmailOtp(env, CTX, 'USR1', 'a@b.c', sender);
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => verifyEmailOtp(env, CTX, 'USR1', wrong),
      (error) => error.code === 'MFA_INVALID');
  }
  await assert.rejects(() => verifyEmailOtp(env, CTX, 'USR1', wrong),
    (error) => error.code === 'MFA_CHALLENGE_FAILED');
  assert.equal(data.size, 0);
});

function gasHarness() {
  return loadGs(
    ['apps-script/utils/errors.gs', 'apps-script/utils/helpers.gs', 'apps-script/services/auth-service.gs'],
    {
      AuditService: { write() { return {}; } },
      ROLE_PERMISSION_MAP: { ADMIN: ['audit.read'], TREASURY: ['deposits.hq.read'] },
      SecurityEventService: { write() { return {}; } }
    }
  );
}

function seedUser(h, role = 'ROLE_ADMIN') {
  h.sandbox.SheetsAdapter.insertRow('users', {
    user_id: 'USR1', username: 'admin', full_name: 'Admin', email: 'admin@example.com',
    role_id: role, status: 'ACTIVE', password_hash: 'x', failed_attempts: 0,
    version: 1, mfa_enabled: false, mfa_secret: '', locked_until: ''
  });
}

test('MFA policy is off by default; required roles are ADMIN and TREASURY', () => {
  const h = gasHarness();
  h.sandbox.SheetsAdapter.setSetting('auth.mfa.enforce', false);
  h.sandbox.SheetsAdapter.setSetting('auth.mfa.requiredRoles', ['ADMIN', 'TREASURY']);
  seedUser(h);
  const AuthService = h.sandbox.AuthService;
  assert.equal(AuthService.mfaPolicy().enforce, false);
  assert.equal(AuthService.mfaRequiredFor(h.store.rows.users[0]), false);

  h.sandbox.SheetsAdapter.setSetting('auth.mfa.enforce', true);
  assert.equal(AuthService.mfaRequiredFor(h.store.rows.users[0]), true);
  seedUser(h, 'ROLE_COLLECTOR');
  h.store.rows.users[1].user_id = 'USR2';
  assert.equal(AuthService.mfaRequiredFor(h.store.rows.users[1]), false);
});

test('GAS enrolment persists the secret, enables MFA and burns recovery codes', () => {
  const h = gasHarness();
  seedUser(h);
  const AuthService = h.sandbox.AuthService;
  AuthService.setMfaSecret('USR1', 'JBSWY3DPEHPK3PXP');
  assert.equal(AuthService.getMfaSecret('USR1').secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(AuthService.mfaMethodsFor(h.store.rows.users[0]).join(','), 'TOTP');

  AuthService.setRecoveryCodes('USR1', ['hash1', 'hash2']);
  assert.equal(AuthService.verifyRecoveryCode('USR1', 'hash1').valid, true);
  assert.equal(AuthService.verifyRecoveryCode('USR1', 'hash1').valid, false, 'single use');
  assert.equal(AuthService.verifyRecoveryCode('USR1', 'hash2').valid, true);

  AuthService.setMfaEnabled('USR1', true);
  assert.equal(h.store.rows.users[0].mfa_enabled, true);
  assert.equal(AuthService.mfaRequiredFor(h.store.rows.users[0]), true);
});
