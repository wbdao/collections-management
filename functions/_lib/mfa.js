/**
 * PHASE 2 / Step 3 — multi-factor authentication at the edge.
 *
 * TOTP uses HMAC-SHA256 with a 30-second period and 6 digits, matching the
 * provisioning URI. Verification stays here because GAS cannot expose the
 * same WebCrypto primitives and because the secret should not travel back to
 * the edge from Sheets on every request. Email OTPs are delivered through a
 * pluggable NotificationSender and stored only as salted hashes in KV.
 */
import { callGas } from './gas-client.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const OTP_TTL = 300; // seconds; > 60 so the KV floor never truncates it
const MAX_ATTEMPTS = 5;
const encoder = new TextEncoder();

/* ---- base32 -------------------------------------------------------------- */

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of String(text || '').toUpperCase().replace(/=+$/, '')) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

/* ---- crypto helpers ------------------------------------------------------ */

export function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => ('0' + b.toString(16)).slice(-2)).join('');
}

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
}

function u64(counter) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, BigInt(counter), false);
  return new Uint8Array(buffer);
}

/** RFC 6238 TOTP with SHA-256, 6 digits, 30-second step. */
export async function totp(secretBase32, counter) {
  const digest = await hmacSha256(base32Decode(secretBase32), u64(counter));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]
  ) >>> 0;
  return String(binary % 1000000).padStart(6, '0');
}

/** Accepts ±1 clock step (90 seconds total). */
export async function verifyTotp(secretBase32, code, now = Date.now(), window = 1) {
  if (!secretBase32 || !/^\d{6}$/.test(String(code))) return false;
  const step = Math.floor(now / 30000);
  for (let delta = -window; delta <= window; delta++) {
    if (constantTimeEqual(await totp(secretBase32, step + delta), code)) return true;
  }
  return false;
}

/* ---- enrolment ----------------------------------------------------------- */

export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function provisioningUri(username, secret) {
  return 'otpauth://totp/CMS:' + encodeURIComponent(String(username)) +
    '?secret=' + encodeURIComponent(secret) +
    '&issuer=CMS&algorithm=SHA256&digits=6&period=30';
}

function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => ('0' + b.toString(16)).slice(-2)).join('').toUpperCase();
}

export async function generateRecoveryCodes(count = 8) {
  const codes = Array.from({ length: count }, () => generateRecoveryCode());
  return {
    codes,
    hashes: await Promise.all(codes.map((code) => sha256Hex(code)))
  };
}

/* ---- email OTP challenges ------------------------------------------------ */

function otpKey(userId) { return `otp:${userId}`; }

function numericCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const value = new DataView(bytes.buffer).getUint32(0, false);
  return String(value % 1000000).padStart(6, '0');
}

/**
 * NotificationSender interface. The default adapter delivers through Apps
 * Script (MailApp when configured, in-app security event otherwise). A custom
 * sender with the same send(input) signature can be supplied by a host.
 */
export const NotificationSender = Object.freeze({
  async send(env, ctx, input) {
    const result = await callGas(env, ctx, 'mfa.deliverOtp', 'users', input);
    return result.data || {};
  }
});

export async function issueEmailOtp(env, ctx, userId, email, sender = NotificationSender) {
  const code = numericCode();
  const salt = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => ('0' + b.toString(16)).slice(-2)).join('');
  const challenge = {
    hash: await sha256Hex(salt + ':' + code),
    salt,
    attempts: 0,
    type: 'EMAIL_OTP',
    expiresAt: Date.now() + OTP_TTL * 1000
  };
  try {
    await env.KV?.put(otpKey(userId), JSON.stringify(challenge), { expirationTtl: OTP_TTL });
  } catch (err) {
    throw Object.assign(new Error('OTP storage unavailable'), {
      code: 'OTP_UNAVAILABLE', status: 503
    });
  }
  let delivery = { delivered: false, channel: 'INAPP' };
  try {
    delivery = await sender.send(env, ctx, { userId, email, code, ip: ctx.ip || '' });
  } catch (err) {
    await securityEvent(env, ctx, userId, 'MFA_OTP_DELIVERY_FAILED', 'WARNING');
  }
  return { challengeId: userId, delivered: delivery.delivered, channel: delivery.channel };
}

async function readChallenge(env, userId) {
  try {
    const raw = await env.KV?.get(otpKey(userId));
    if (!raw) return null;
    const challenge = JSON.parse(raw);
    if (challenge.expiresAt && challenge.expiresAt < Date.now()) {
      await env.KV?.delete(otpKey(userId));
      return null;
    }
    return challenge;
  } catch (err) {
    return null;
  }
}

async function clearChallenge(env, userId) {
  try { await env.KV?.delete(otpKey(userId)); } catch (err) { /* best effort */ }
}

export async function securityEvent(env, ctx, userId, eventType, severity = 'WARNING', details = {}) {
  try {
    await callGas(env, ctx, 'security.event', 'security_events', {
      eventType, userId: userId || 'anonymous', ip: ctx.ip || '',
      requestId: ctx.requestId || '', severity, details
    });
  } catch (err) {
    // Security logging must never break an authentication response.
  }
}

export async function verifyEmailOtp(env, ctx, userId, code) {
  const challenge = await readChallenge(env, userId);
  if (!challenge) throw mfaError('MFA_INVALID', 'Verification code expired or was not issued.');

  if (challenge.attempts >= MAX_ATTEMPTS) {
    await clearChallenge(env, userId);
    await securityEvent(env, ctx, userId, 'MFA_CHALLENGE_FAILED', 'CRITICAL');
    throw mfaError('MFA_CHALLENGE_FAILED', 'Too many verification attempts.');
  }

  if (constantTimeEqual(challenge.hash, await sha256Hex(challenge.salt + ':' + code))) {
    await clearChallenge(env, userId);
    return true;
  }

  challenge.attempts += 1;
  try {
    await env.KV?.put(otpKey(userId), JSON.stringify(challenge), { expirationTtl: OTP_TTL });
  } catch (err) { /* best effort */ }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    await clearChallenge(env, userId);
    await securityEvent(env, ctx, userId, 'MFA_CHALLENGE_FAILED', 'CRITICAL');
    throw mfaError('MFA_CHALLENGE_FAILED', 'Too many verification attempts.');
  }
  throw mfaError('MFA_INVALID', 'Incorrect verification code.');
}

export function mfaError(code, message) {
  return Object.assign(new Error(message), { code, status: 401 });
}
