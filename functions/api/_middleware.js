/**
 * Cloudflare Pages API middleware:
 * CORS/preflight, request id, JWT validation, RBAC-ready context, scope context,
 * rate limiting, and API error handling. Static frontend assets are unaffected.
 */
import { verifyAccessToken, actorFromClaims } from '../_lib/auth.js';
import { optionsResponse, failure } from '../_lib/respond.js';
import { normalizeError } from '../_lib/errors.js';
import { resolveIdempotencyKey } from '../_lib/idempotency.js';
import {
  enforceLoginLimit, enforceBootstrapLimit, enforceAuthUserLimit,
  enforceMfaLimit, recordRateLimitEvent
} from '../_lib/ratelimit.js';

// PHASE 2 / Step 2: refresh is public (the access token has expired by then)
// and is authenticated solely by the opaque refresh token.
const PUBLIC_PATHS = new Set([
  '/api/v1/auth/login', '/api/v1/auth/refresh', '/api/health', '/api/v1/health'
]);
const BOOTSTRAP_PATH = '/api/v1/admin/bootstrap';

// DORMANT — R2 backup routes are not mounted in the Google-Sheets-only rollout.
// This service-token branch is retained only so the signed service-token
// contract stays testable; /api/v1/admin/backups returns 404 from the router.
const BACKUP_PATH = '/api/v1/admin/backups';

// PHASE 2 / Step 3: these paths also accept the short-lived `cms-mfa`
// challenge token issued by /auth/login when MFA is required.
const MFA_PATHS = new Set([
  '/api/v1/auth/mfa/enroll', '/api/v1/auth/mfa/verify',
  '/api/v1/auth/mfa/disable', '/api/v1/auth/mfa/resend'
]);

async function verifyRequestToken(env, token, path) {
  try {
    return await verifyAccessToken(env, token);
  } catch (error) {
    if (MFA_PATHS.has(path) && error.code === 'UNAUTHORIZED') {
      return verifyAccessToken(env, token, { audience: 'cms-mfa', skipRevocation: true });
    }
    throw error;
  }
}

export async function onRequest(context) {
  const { request, env, next } = context;

  if (request.method === 'OPTIONS') return optionsResponse();

  const requestId = request.headers.get('X-Request-Id') || crypto.randomUUID();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  const ctx = {
    requestId,
    ip,
    userAgent: request.headers.get('User-Agent') || '',
    idempotencyKey: resolveIdempotencyKey(request)
  };

  try {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    // Cloudflare-limit mitigation: there is intentionally NO KV write on every
    // request. KV's free tier allows only 1,000 writes/day, so limits are
    // reserved for the low-volume login/refresh/MFA/bootstrap paths below.
    if (PUBLIC_PATHS.has(path)) {
      ctx.actor = { userId: 'anonymous', username: 'anonymous', role: 'PUBLIC', scopes: [], permissions: [] };
      await enforceLoginLimit(env, ctx);
      // Opaque credentials cannot be attributed to a user yet, so use the IP.
      await enforceAuthUserLimit(env, ctx, ctx.ip || 'unknown');
      context.data.cms = ctx;
      return next();
    }

    if (path === BOOTSTRAP_PATH) {
      await enforceBootstrapLimit(env, ctx);
      const provided = request.headers.get('X-Bootstrap-Token') || '';
      if (!env.BOOTSTRAP_TOKEN || provided !== env.BOOTSTRAP_TOKEN) {
        return failure(401, 'UNAUTHORIZED', 'Invalid bootstrap token', [], requestId);
      }
      ctx.actor = { userId: 'system', username: 'system', role: 'ADMIN', scopes: [], permissions: ['*'] };
      context.data.cms = ctx;
      return next();
    }

    if (path === BACKUP_PATH && request.method === 'POST') {
      const provided = request.headers.get('X-Backup-Token') || '';
      if (env.BACKUP_SERVICE_TOKEN && provided === env.BACKUP_SERVICE_TOKEN) {
        await enforceBootstrapLimit(env, ctx);
        ctx.actor = { userId: 'SYSTEM', username: 'system', role: 'ADMIN', scopes: [], permissions: ['*'] };
        ctx.backupServiceCall = true;
        context.data.cms = ctx;
        return next();
      }
      // No/invalid token: fall through to normal Bearer-token admin auth.
    }

    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) {
      return failure(401, 'UNAUTHORIZED', 'Bearer token required', [], requestId);
    }
    const claims = await verifyRequestToken(env, header.slice(7).trim(), path);
    ctx.actor = actorFromClaims(claims);
    ctx.claims = claims;
    ctx.mfaChallenge = claims.aud === 'cms-mfa';

    if (MFA_PATHS.has(path)) {
      await enforceAuthUserLimit(env, ctx);
      await enforceMfaLimit(env, ctx);
    }

    // CSRF defence-in-depth: reject cross-site state changes.
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (request.method !== 'GET' && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return failure(403, 'CSRF_REJECTED', 'Cross-site mutation rejected', [], requestId);
    }

    // No blanket per-API KV counter here — public API traffic is bounded by
    // Cloudflare's request quota (and custom-domain WAF if enabled), not KV.
    context.data.cms = ctx;
    return next();
  } catch (error) {
    const normalized = normalizeError(error);
    if (error.code === 'RATE_LIMITED') {
      // PHASE 2 / Step 11: append a security event without re-entering the
      // limiter (callGas writes straight to GAS). Offload to waitUntil so a
      // slow/dead upstream never adds latency to the 429 response itself.
      const eventWrite = recordRateLimitEvent(env, ctx, error.bucket || 'unknown');
      if (typeof context.waitUntil === 'function') context.waitUntil(eventWrite);
    }
    return failure(normalized.status, normalized.code, normalized.message, normalized.details, requestId);
  }
}
