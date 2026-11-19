/** PHASE 2 / Step 2 — edge JWT issuance/verification with real WebCrypto. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  TOKEN_TTL, issueAccessToken, verifyAccessToken, issueMfaChallengeToken,
  actorFromClaims, b64url, unb64url
} from '../functions/_lib/auth.js';

function toPem(buffer, label) {
  const base64 = Buffer.from(buffer).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function envWithKeys() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
  return {
    JWT_PRIVATE_KEY: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'),
    JWT_PUBLIC_KEY: toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
    JWT_ISSUER: 'cms-api',
    JWT_AUDIENCE: 'cms-web'
  };
}

const IDENTITY = {
  userId: 'USR1', username: 'admin', fullName: 'Admin', role: 'ADMIN',
  scopes: [{ type: 'WAREHOUSE', id: 'W1' }]
};

test('base64url helpers round-trip UTF-8 (Arabic)', () => {
  assert.equal(unb64url(b64url('مستودع')), 'مستودع');
});

test('issued access tokens live 15 minutes and carry session/MFA claims', async () => {
  const env = await envWithKeys();
  const issued = await issueAccessToken(env, IDENTITY, ['audit.read'], {
    sid: 'SES_1', amr: ['pwd', 'totp'], mfa: true
  });
  assert.equal(issued.expiresIn, TOKEN_TTL.access);

  const claims = await verifyAccessToken(env, issued.token);
  assert.equal(claims.sub, 'USR1');
  assert.equal(claims.role, 'ADMIN');
  assert.equal(claims.exp - claims.iat, 900);
  assert.equal(claims.sid, 'SES_1');
  assert.deepEqual(claims.amr, ['pwd', 'totp']);
  assert.equal(claims.mfa, true);
  assert.deepEqual(claims.scopes, IDENTITY.scopes);
  assert.deepEqual(actorFromClaims(claims).permissions, ['audit.read']);
});

test('access tokens reject tampering, wrong audience and wrong issuer', async () => {
  const env = await envWithKeys();
  const { token } = await issueAccessToken(env, IDENTITY, []);
  const parts = token.split('.');

  await assert.rejects(() => verifyAccessToken(env, `${parts[0]}.${parts[1]}.AAAA`), /Invalid signature/);
  await assert.rejects(() => verifyAccessToken(env, token, { audience: 'cms-other' }), /Invalid audience/);
  await assert.rejects(
    () => verifyAccessToken({ ...env, JWT_ISSUER: 'other' }, token),
    /Invalid issuer/
  );
});

test('MFA challenge tokens use the dedicated audience and skip revocation', async () => {
  const env = await envWithKeys();
  const challenge = await issueMfaChallengeToken(env, IDENTITY, ['TOTP', 'EMAIL_OTP']);
  const claims = await verifyAccessToken(env, challenge.token, { audience: 'cms-mfa' });
  assert.equal(claims.aud, 'cms-mfa');
  assert.equal(claims.mfa, false);
  assert.deepEqual(claims.amr, ['pwd']);
  await assert.rejects(() => verifyAccessToken(env, challenge.token), /Invalid audience/);
});

test('expired tokens are rejected with TOKEN_EXPIRED', async () => {
  const env = await envWithKeys();
  const { token } = await issueAccessToken(env, IDENTITY, []);
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(unb64url(payload));
  claims.exp = Math.floor(Date.now() / 1000) - 10;
  const tamperedPayload = b64url(JSON.stringify(claims));
  // Re-sign with the matching private key so expiry is the only failure.
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(env.JWT_PRIVATE_KEY.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${tamperedPayload}`)
  );
  let binary = '';
  new Uint8Array(sig).forEach((b) => { binary += String.fromCharCode(b); });
  const tampered = `${header}.${tamperedPayload}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  assert.notEqual(tampered, token);
  assert.equal(signature.length > 0, true);
  await assert.rejects(() => verifyAccessToken(env, tampered), (err) => err.code === 'TOKEN_EXPIRED');
});
