/** JWT (RS256) issue/verify and credential calls. Phase 1: access token only, 8 h TTL. */

import { callGas } from './gas-client.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACCESS_TTL_SECONDS = 8 * 60 * 60;

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

export async function issueAccessToken(env, identity, permissions) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: identity.userId,
    username: identity.username,
    role: identity.role,
    scopes: identity.scopes || [],
    permissions: permissions || [],
    iss: env.JWT_ISSUER || 'cms-api',
    aud: env.JWT_AUDIENCE || 'cms-web',
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
    jti: crypto.randomUUID()
  };
  const header = b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(env.JWT_PRIVATE_KEY);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return { token: `${unsigned}.${b64urlEncode(signature)}`, expiresIn: ACCESS_TTL_SECONDS };
}

export async function verifyAccessToken(env, token) {
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
  if (claims.exp <= now) throw unauthorized('Token expired');
  if (claims.iat > now + 60) throw unauthorized('Token issued in the future');
  if (claims.iss !== (env.JWT_ISSUER || 'cms-api')) throw unauthorized('Invalid issuer');
  if (claims.aud !== (env.JWT_AUDIENCE || 'cms-web')) throw unauthorized('Invalid audience');
  return claims;
}

function unauthorized(message) {
  return Object.assign(new Error(message), { code: 'UNAUTHORIZED', status: 401 });
}

export function actorFromClaims(claims) {
  return {
    userId: claims.sub,
    username: claims.username,
    role: claims.role,
    scopes: claims.scopes || [],
    permissions: claims.permissions || []
  };
}

export async function login(env, ctx, username, password) {
  const result = await callGas(env, ctx, 'auth.login', 'users', { username, password, ip: ctx.ip });
  const identity = result.data;
  const issued = await issueAccessToken(env, identity.user, identity.permissions);
  return { accessToken: issued.token, tokenType: 'Bearer', expiresIn: issued.expiresIn, user: identity.user };
}

export async function me(env, ctx) {
  const result = await callGas(env, ctx, 'auth.me', 'users', { userId: ctx.actor.userId, ip: ctx.ip });
  return result.data;
}

export async function logout(env, ctx) {
  const result = await callGas(env, ctx, 'auth.logout', 'users', {
    userId: ctx.actor.userId, username: ctx.actor.username, ip: ctx.ip
  });
  return result.data;
}
