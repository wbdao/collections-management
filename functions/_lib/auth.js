/**
 * JWT (RS256) issue/verify, sessions and credential calls.
 * PHASE 2 / Step 2: 15-minute access tokens + 7-day rotating refresh tokens.
 * Phase 1 signatures are preserved (new parameters are optional/additive).
 */

import { callGas } from './gas-client.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToDer(pem, label) {
  const normalized = String(pem || '').replace(/\\n/g, '\n');
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const match = normalized.match(pattern);
  if (!match) throw Object.assign(new Error(`Invalid ${label} PEM`), { code: 'CONFIG_ERROR', status: 500 });
  const clean = match[1].replace(/\s/g, '');
  const binary = atob(clean);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

async function importPrivateKey(pem) {
  return crypto.subtle.importKey(
    'pkcs8', pemToDer(pem, 'PRIVATE KEY'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
}

async function importPublicKey(pem) {
  return crypto.subtle.importKey(
    'spki', pemToDer(pem, 'PUBLIC KEY'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
}

/** extras is additive: { sid, amr, mfa, audience }. */
export async function issueAccessToken(env, identity, permissions, extras = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: identity.userId,
    username: identity.username,
    role: identity.role,
    scopes: identity.scopes || [],
    permissions: permissions || [],
    iss: env.JWT_ISSUER || 'cms-api',
    aud: extras.audience || env.JWT_AUDIENCE || 'cms-web',
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
    jti: crypto.randomUUID()
  };
  if (extras.sid) claims.sid = extras.sid;
  if (extras.amr) claims.amr = extras.amr;
  if (extras.mfa !== undefined) claims.mfa = Boolean(extras.mfa);
  const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(env.JWT_PRIVATE_KEY);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return { token: `${unsigned}.${b64urlEncode(signature)}`, expiresIn: ACCESS_TTL_SECONDS };
}

/* ---- KV revocation (best-effort, degrades open) -------------------------- */

async function kvGet(env, key) {
  try { return await env.KV?.get(key) ?? null; } catch (_) { return null; }
}

async function kvPut(env, key, value, ttl) {
  try {
    await env.KV?.put(key, String(value), { expirationTtl: Math.max(60, ttl) });
  } catch (_) { /* KV is an optimisation; never fail auth because of it. */ }
}

async function revokeJti(env, claims) {
  if (!claims?.jti || !claims?.exp) return;
  const remaining = Math.max(60, claims.exp - Math.floor(Date.now() / 1000));
  await kvPut(env, `revoke:jti:${claims.jti}`, '1', remaining);
}

async function revokeSubject(env, userId) {
  if (!userId) return;
  await kvPut(env, `revoke:sub:${userId}`, Math.floor(Date.now() / 1000), REFRESH_TTL_SECONDS);
}

async function isRevoked(env, claims) {
  const jtiFlag = await kvGet(env, `revoke:jti:${claims.jti || ''}`);
  if (jtiFlag) return true;
  const revokedAfter = Number(await kvGet(env, `revoke:sub:${claims.sub || ''}`) || 0);
  return revokedAfter > 0 && Number(claims.iat || 0) < revokedAfter;
}

/** Token helpers exported for unit tests and the MFA challenge (Step 3). */
export async function issueMfaChallengeToken(env, user, methods) {
  return issueAccessToken(env, { ...user, userId: user.userId }, [], {
    audience: 'cms-mfa', amr: ['pwd'], mfa: false
  });
}

export function b64url(input) { return b64urlEncode(input); }
export function unb64url(text) { return decoder.decode(b64urlDecode(text)); }

export async function verifyAccessToken(env, token, options = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');
  const header = JSON.parse(decoder.decode(b64urlDecode(parts[0])));
  if (header.alg !== 'RS256') throw unauthorized('Unsupported algorithm');
  const key = await importPublicKey(env.JWT_PUBLIC_KEY);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw unauthorized('Invalid signature');
  const claims = JSON.parse(decoder.decode(b64urlDecode(parts[1])));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw unauthorized('Token expired', 'TOKEN_EXPIRED');
  if (claims.iat > now + 60) throw unauthorized('Token issued in the future');
  const expectedAudience = options.audience || env.JWT_AUDIENCE || 'cms-web';
  if (claims.iss !== (env.JWT_ISSUER || 'cms-api')) throw unauthorized('Invalid issuer');
  if (claims.aud !== expectedAudience) throw unauthorized('Invalid audience');
  // Revocation is checked only for normal access tokens; the MFA challenge
  // token is short-lived and must remain usable while the user is logging in.
  if (!options.skipRevocation && claims.aud === expectedAudience && await isRevoked(env, claims)) {
    throw unauthorized('Session revoked');
  }
  return claims;
}

function unauthorized(message, code = 'UNAUTHORIZED') {
  return Object.assign(new Error(message), { code, status: 401 });
}

export function actorFromClaims(claims) {
  return {
    userId: claims.sub,
    username: claims.username,
    role: claims.role,
    scopes: claims.scopes || [],
    permissions: claims.permissions || [],
    sessionId: claims.sid || ''
  };
}

/* ---- Refresh tokens ------------------------------------------------------ */

export function issueRefreshToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64urlEncode(bytes);
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(token)));
  return [...new Uint8Array(digest)].map((b) => ('0' + b.toString(16)).slice(-2)).join('');
}

function refreshExpiry() {
  return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
}

/** Create a session after credential or MFA success. */
export async function createSessionPair(env, ctx, identity, permissions, methods = ['pwd']) {
  const sessionId = crypto.randomUUID();
  const refreshToken = issueRefreshToken();
  const refreshHash = await hashToken(refreshToken);
  await callGas(env, ctx, 'session.create', 'sessions', {
    sessionId,
    userId: identity.userId,
    refreshTokenHash: refreshHash,
    deviceInfo: ctx.userAgent || '',
    ip: ctx.ip || '',
    expiresAt: refreshExpiry()
  });
  const issued = await issueAccessToken(env, identity, permissions, {
    sid: sessionId, amr: methods, mfa: methods.some((m) => m !== 'pwd')
  });
  return {
    accessToken: issued.token,
    tokenType: 'Bearer',
    expiresIn: issued.expiresIn,
    refreshToken,
    refreshExpiresIn: REFRESH_TTL_SECONDS,
    sessionId,
    user: identity
  };
}

export async function refresh(env, ctx, refreshToken) {
  const hash = await hashToken(refreshToken);
  const lookup = await callGas(env, ctx, 'session.lookup', 'sessions', { refreshTokenHash: hash });
  const { userId } = lookup.data;
  const newSessionId = crypto.randomUUID();
  const newRefreshToken = issueRefreshToken();
  const newHash = await hashToken(newRefreshToken);
  const rotated = await callGas(env, ctx, 'session.refresh', 'sessions', {
    userId,
    refreshTokenHash: hash,
    newSessionId,
    newRefreshTokenHash: newHash,
    deviceInfo: ctx.userAgent || '',
    ip: ctx.ip || '',
    expiresAt: refreshExpiry()
  });
  const data = rotated.data;
  const methods = [...new Set([...(ctx.claims?.amr || ['pwd']), 'refresh'])];
  const issued = await issueAccessToken(env, data.user, data.permissions, {
    sid: newSessionId, amr: methods, mfa: Boolean(ctx.claims?.mfa)
  });
  return {
    accessToken: issued.token,
    tokenType: 'Bearer',
    expiresIn: issued.expiresIn,
    refreshToken: newRefreshToken,
    refreshExpiresIn: REFRESH_TTL_SECONDS,
    sessionId: newSessionId,
    user: data.user
  };
}

/* ---- Phase 1 credential calls (extended) -------------------------------- */

export async function login(env, ctx, username, password, deviceInfo = '') {
  const result = await callGas(env, ctx, 'auth.login', 'users', { username, password, ip: ctx.ip });
  const identity = result.data;

  // MFA plumbing (Step 3 activates the GAS-side mfaRequired flag).
  if (identity.mfaRequired) {
    const challenge = await issueMfaChallengeToken(env, identity.user, identity.mfaMethods || ['TOTP', 'EMAIL_OTP']);
    return {
      mfaRequired: true,
      mfaToken: challenge.token,
      mfaExpiresIn: challenge.expiresIn,
      methods: identity.mfaMethods || ['TOTP', 'EMAIL_OTP'],
      user: identity.user
    };
  }

  if (deviceInfo) ctx.userAgent = deviceInfo;
  return createSessionPair(env, ctx, identity.user, identity.permissions, ['pwd']);
}

export async function me(env, ctx) {
  const result = await callGas(env, ctx, 'auth.me', 'users', { userId: ctx.actor.userId, ip: ctx.ip });
  return {
    ...result.data,
    sessionId: ctx.claims?.sid || '',
    mfaEnabled: Boolean(result.data.user?.mfaEnabled),
    mfaMethods: result.data.user?.mfaMethods || []
  };
}

export async function logout(env, ctx, all = false) {
  const claims = ctx.claims || {};
  if (all) {
    await callGas(env, ctx, 'session.revokeAll', 'sessions', {
      userId: ctx.actor.userId, reason: 'LOGOUT_ALL'
    });
    await revokeSubject(env, ctx.actor.userId);
  } else if (claims.sid) {
    await callGas(env, ctx, 'session.revoke', 'sessions', {
      sessionId: claims.sid, reason: 'LOGOUT'
    });
  }
  await revokeJti(env, claims);
  // Preserve the Phase 1 LOGOUT audit row.
  const result = await callGas(env, ctx, 'auth.logout', 'users', {
    userId: ctx.actor.userId, username: ctx.actor.username, ip: ctx.ip
  });
  return { ...result.data, loggedOut: true, all };
}

export async function sessions(env, ctx) {
  const result = await callGas(env, ctx, 'session.list', 'sessions', {});
  return {
    items: result.data.items.map((item) => ({
      ...item, current: item.sessionId === ctx.claims?.sid
    }))
  };
}

export const TOKEN_TTL = Object.freeze({
  access: ACCESS_TTL_SECONDS,
  refresh: REFRESH_TTL_SECONDS
});
