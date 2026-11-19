/** PHASE 2 / Step 2 — session store, rotation, reuse detection and token TTL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGs } from './helpers/gas-harness.js';
import { TOKEN_TTL, issueRefreshToken, hashToken } from '../functions/_lib/auth.js';

function harness() {
  return loadGs([
    'apps-script/utils/errors.gs',
    'apps-script/utils/helpers.gs',
    'apps-script/services/session-service.gs'
  ]);
}

test('access token TTL is 15 minutes and refresh TTL is 7 days', () => {
  assert.equal(TOKEN_TTL.access, 900);
  assert.equal(TOKEN_TTL.refresh, 604800);
});

test('refresh tokens are 256-bit opaque values hashed with SHA-256', async () => {
  const a = issueRefreshToken();
  const b = issueRefreshToken();
  assert.notEqual(a, b);
  const hash = await hashToken(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashToken(a));
  assert.notEqual(hash, await hashToken(b));
  assert.ok(!hash.includes(a));
});

test('session creation stores only the refresh hash and defaults', () => {
  const h = harness();
  const row = h.sandbox.SessionService.create({}, {
    sessionId: 'SES_1', userId: 'USR1', refreshTokenHash: 'hash1',
    deviceInfo: 'browser', ip: '1.2.3.4'
  });
  assert.equal(row.session_id, 'SES_1');
  assert.equal(row.refresh_token_hash, 'hash1');
  assert.equal(row.revoked_at, '');
  assert.ok(row.expires_at > row.created_at);
  assert.equal(h.store.rows.sessions.length, 1);
});

test('rotation creates a successor, revokes the predecessor and returns identity', () => {
  const h = harness();
  const SessionService = h.sandbox.SessionService;
  SessionService.create({}, {
    sessionId: 'SES_1', userId: 'USR1', refreshTokenHash: 'old-hash', ip: '1.2.3.4'
  });

  const result = SessionService.rotate({}, {
    refreshTokenHash: 'old-hash', userId: 'USR1',
    newSessionId: 'SES_2', newRefreshTokenHash: 'new-hash', ip: '1.2.3.4'
  });

  assert.equal(result.error, undefined);
  assert.equal(result.previousSessionId, 'SES_1');
  assert.equal(result.session.session_id, 'SES_2');
  assert.ok(SessionService.findById('SES_1').revoked_at);
  assert.equal(SessionService.findById('SES_2').revoked_at, '');
  assert.equal(h.securityEvents.filter((e) => e.eventType === 'SESSION_REVOKED').length, 1);
});

test('replaying a rotated refresh token revokes every session for the user', () => {
  const h = harness();
  const SessionService = h.sandbox.SessionService;
  SessionService.create({}, { sessionId: 'SES_1', userId: 'USR1', refreshTokenHash: 'old-hash' });
  SessionService.rotate({}, {
    refreshTokenHash: 'old-hash', userId: 'USR1',
    newSessionId: 'SES_2', newRefreshTokenHash: 'new-hash'
  });

  const replay = SessionService.rotate({}, {
    refreshTokenHash: 'old-hash', userId: 'USR1',
    newSessionId: 'SES_3', newRefreshTokenHash: 'third-hash'
  });

  assert.equal(replay.error, 'REFRESH_REUSE');
  assert.ok(SessionService.findById('SES_2').revoked_at, 'successor must also be revoked');
  assert.equal(h.securityEvents.some((e) => e.eventType === 'TOKEN_REUSE_DETECTED'), true);
});

test('lookup rejects unknown and expired refresh tokens', () => {
  const h = harness();
  const SessionService = h.sandbox.SessionService;
  assert.throws(() => SessionService.lookup('missing'), (e) => e.code === 'REFRESH_INVALID');

  SessionService.create({}, {
    sessionId: 'SES_1', userId: 'USR1', refreshTokenHash: 'hash1',
    expiresAt: '2000-01-01T00:00:00.000Z'
  });
  assert.throws(() => SessionService.lookup('hash1'), (e) => e.code === 'REFRESH_INVALID');
});

test('revokeAll and list expose the correct session view', () => {
  const h = harness();
  const SessionService = h.sandbox.SessionService;
  SessionService.create({}, { sessionId: 'SES_1', userId: 'USR1', refreshTokenHash: 'h1' });
  SessionService.create({}, { sessionId: 'SES_2', userId: 'USR1', refreshTokenHash: 'h2' });
  SessionService.create({}, { sessionId: 'SES_3', userId: 'USR2', refreshTokenHash: 'h3' });

  const result = SessionService.revokeAll('USR1', 'LOGOUT_ALL');
  assert.equal(result.revoked, 2);
  const list = SessionService.list('USR1');
  assert.equal(list.length, 2);
  assert.ok(list.every((item) => item.revokedAt));
  assert.equal(SessionService.list('USR2')[0].revokedAt, '');
});
