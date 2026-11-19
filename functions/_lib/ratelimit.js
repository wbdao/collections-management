/** KV-backed fixed-window rate limiting. Degrades open if KV is unavailable. */

import { callGas } from './gas-client.js';

export async function enforceRateLimit(env, ctx, bucket, limit, windowSeconds = 60, identity) {
  if (!env.KV) return;
  const actor = identity || ctx.actor?.userId || ctx.ip || 'anonymous';
  const key = `rl:${bucket}:${actor}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const current = Number((await env.KV.get(key)) || 0) + 1;
  if (current > limit) {
    throw Object.assign(new Error('Too many requests'), {
      code: 'RATE_LIMITED', status: 429,
      bucket, // consumed by recordRateLimitEvent() for the security event details
      details: [{ retryAfter: windowSeconds }]
    });
  }
  // KV expirationTtl floor is 60 seconds; never use a shorter TTL.
  await env.KV.put(key, String(current), { expirationTtl: Math.max(60, windowSeconds + 5) });
}

/**
 * PHASE 2 / Step 11 — record a RATE_LIMITED security event WITHOUT recursion.
 *
 * This writes straight to Apps Script via callGas() and therefore never
 * re-enters the Pages middleware or the rate limiter that just rejected the
 * request. It is strictly best-effort: KV/GAS/network failures are swallowed
 * so a logging problem can never turn a 429 into a 500 or lock out users.
 *
 * A KV dedupe key suppresses duplicate events from the same identity for the
 * same minute, so a flood of rejected requests cannot spam tbl_security_events.
 */
export async function recordRateLimitEvent(env, ctx, bucket = 'unknown') {
  // If KV is unavailable the limiter degraded open, so there is nothing to log.
  if (!env.KV) return false;
  const identity = ctx.actor?.userId && ctx.actor.userId !== 'anonymous'
    ? `u:${ctx.actor.userId}` : `ip:${ctx.ip || 'unknown'}`;
  const dedupeKey = `sec:rate:${identity}:${Math.floor(Date.now() / 1000 / 60)}`;
  try {
    if (await env.KV.get(dedupeKey)) return false;
    await env.KV.put(dedupeKey, '1', { expirationTtl: 60 });
  } catch (err) {
    // KV failure must not block or break the response — degrade open.
  }
  try {
    await callGas(env, ctx, 'security.event', 'security_events', {
      eventType: 'RATE_LIMITED',
      userId: ctx.actor?.userId || 'anonymous',
      ip: ctx.ip || '',
      requestId: ctx.requestId || '',
      severity: 'WARNING',
      details: { bucket }
    });
    return true;
  } catch (err) {
    // Security logging must never break an authentication/rate-limit response.
    return false;
  }
}

export async function enforceLoginLimit(env, ctx) {
  // Public login runs with actor.userId === 'anonymous'. Key on the source IP
  // so one attacker cannot exhaust a single global login bucket for everyone.
  await enforceRateLimit(env, ctx, 'login', 10, 60, ctx.ip || 'unknown');
}

/* ---- PHASE 2 / Step 11 — layered limits ---------------------------------- */

/** Per-IP layer applied to every non-OPTIONS request, including public paths. */
export async function enforcePerIpLimit(env, ctx) {
  const limit = Number(env.SECURITY_PER_IP_LIMIT) || 300;
  await enforceRateLimit(env, ctx, 'ip', limit, 60, ctx.ip || 'unknown');
}

/** Per-user layer for authentication endpoints (login/refresh/MFA). */
export async function enforceAuthUserLimit(env, ctx, identity) {
  const limit = Number(env.SECURITY_AUTH_USER_LIMIT) || 20;
  await enforceRateLimit(env, ctx, 'auth_user', limit, 60,
    identity || ctx.actor?.userId || ctx.ip || 'unknown');
}

/** Tighter bucket for OTP verification (5 attempts / 5 minutes). */
export async function enforceMfaLimit(env, ctx) {
  await enforceRateLimit(env, ctx, 'mfa', 5, 300,
    ctx.actor?.userId || ctx.ip || 'unknown');
}

/** Bootstrap is a static shared secret; cap attempts per source IP. */
export async function enforceBootstrapLimit(env, ctx) {
  await enforceRateLimit(env, ctx, 'bootstrap', 10, 60, ctx.ip || 'unknown');
}
