/**
 * Cloudflare Pages API middleware:
 * CORS/preflight, request id, JWT validation, RBAC-ready context, scope context,
 * rate limiting, and API error handling. Static frontend assets are unaffected.
 */
import { verifyAccessToken, actorFromClaims } from '../_lib/auth.js';
import { optionsResponse, failure } from '../_lib/respond.js';
import { normalizeError } from '../_lib/errors.js';
import { resolveIdempotencyKey } from '../_lib/idempotency.js';
import { enforceRateLimit, enforceLoginLimit } from '../_lib/ratelimit.js';

const PUBLIC_PATHS = new Set(['/api/v1/auth/login', '/api/health', '/api/v1/health']);
const BOOTSTRAP_PATH = '/api/v1/admin/bootstrap';

export async function onRequest(context) {
  const { request, env, next } = context;

  if (request.method === 'OPTIONS') return optionsResponse();

  const requestId = request.headers.get('X-Request-Id') || crypto.randomUUID();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  const ctx = {
    requestId,
    ip,
    idempotencyKey: resolveIdempotencyKey(request)
  };

  try {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (PUBLIC_PATHS.has(path)) {
      ctx.actor = { userId: 'anonymous', username: 'anonymous', role: 'PUBLIC', scopes: [], permissions: [] };
      await enforceLoginLimit(env, ctx);
      context.data.cms = ctx;
      return next();
    }

    if (path === BOOTSTRAP_PATH) {
      const provided = request.headers.get('X-Bootstrap-Token') || '';
      if (!env.BOOTSTRAP_TOKEN || provided !== env.BOOTSTRAP_TOKEN) {
        return failure(401, 'UNAUTHORIZED', 'Invalid bootstrap token', [], requestId);
      }
      ctx.actor = { userId: 'system', username: 'system', role: 'ADMIN', scopes: [], permissions: ['*'] };
      context.data.cms = ctx;
      return next();
    }

    const header = request.headers.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) {
      return failure(401, 'UNAUTHORIZED', 'Bearer token required', [], requestId);
    }
    const claims = await verifyAccessToken(env, header.slice(7).trim());
    ctx.actor = actorFromClaims(claims);
    ctx.claims = claims;

    // CSRF defence-in-depth: reject cross-site state changes.
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (request.method !== 'GET' && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return failure(403, 'CSRF_REJECTED', 'Cross-site mutation rejected', [], requestId);
    }

    await enforceRateLimit(env, ctx, 'api', 120, 60);
    context.data.cms = ctx;
    return next();
  } catch (error) {
    const normalized = normalizeError(error);
    return failure(normalized.status, normalized.code, normalized.message, normalized.details, requestId);
  }
}
