/** Signed, retrying transport from Cloudflare Functions to the Apps Script Web App. */

const PROTOCOL = 'cms-repo/v1';

const encoder = new TextEncoder();

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64url(signature);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * @param {object} env Cloudflare environment bindings
 * @param {object} ctx request context (requestId, actor, idempotencyKey)
 * @param {string} action repository action or service action
 * @param {string|null} entity entity name
 * @param {object} payload action payload
 */
export async function callGas(env, ctx, action, entity, payload = {}) {
  if (!env.GAS_URL || !env.GAS_SHARED_SECRET) {
    throw Object.assign(new Error('Apps Script is not configured'), { code: 'CONFIG_ERROR', status: 500 });
  }

  const envelope = {
    protocol: PROTOCOL,
    requestId: ctx.requestId,
    timestamp: new Date().toISOString(),
    actor: ctx.actor || null,
    action,
    entity: entity || null,
    payload,
    idempotencyKey: ctx.idempotencyKey || null
  };

  const body = JSON.stringify(envelope);
  const signature = await sign(body, env.GAS_SHARED_SECRET);
  let lastError = null;

  // Apps Script Web Apps do not reliably expose custom request headers to
  // doPost(e) — e.postData.headers is often empty after Google's redirect
  // proxy. Query parameters, however, always arrive via e.parameter. Keep the
  // X-Signature header as defence in depth, but make the query parameter the
  // authoritative channel for the HMAC signature.
  const gasUrl = new URL(env.GAS_URL);
  gasUrl.searchParams.set('signature', signature);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    // Bootstrap seeds all 27 sheets and takes ~13s in Apps Script; the old
    // 10s cap aborted healthy upstream work. 60s leaves generous headroom.
    const timer = setTimeout(() => controller.abort(), Number(env.GAS_TIMEOUT_MS) || 60000);
    try {
      const response = await fetch(gasUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.GAS_SHARED_SECRET}`,
          'X-Signature': signature,
          'X-Request-Id': ctx.requestId
        },
        body,
        signal: controller.signal
      });

      clearTimeout(timer);
      const result = await response.json().catch(() => null);

      if (!result || result.protocol !== PROTOCOL) {
        throw Object.assign(new Error('Invalid Apps Script response'), { code: 'BAD_GATEWAY', status: 502 });
      }
      if (!result.ok) {
        const err = Object.assign(new Error(result.error.message), {
          code: result.error.code,
          status: mapCode(result.error.code),
          details: result.error.details || []
        });
        if (retryable(err.status) && attempt < 3) {
          await sleep(200 * Math.pow(3, attempt - 1) + Math.floor(Math.random() * 120));
          lastError = err;
          continue;
        }
        throw err;
      }
      // Return the full envelope so Repository results match the documented
      // RepositoryResult contract ({ ok, data, meta }) used by every module.
      return { ok: result.ok, data: result.data, meta: result.meta || {} };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') err.code = 'UPSTREAM_TIMEOUT';
      if (err.status && !retryable(err.status)) throw err;
      lastError = err;
      if (attempt < 3) {
        await sleep(200 * Math.pow(3, attempt - 1) + Math.floor(Math.random() * 120));
      }
    }
  }
  throw Object.assign(lastError || new Error('Apps Script unavailable'), {
    code: lastError?.code || 'UPSTREAM_UNAVAILABLE',
    status: 503
  });
}

function mapCode(code) {
  switch (code) {
    case 'NOT_FOUND': return 404;
    case 'CUSTOMER_NOT_FOUND': return 404;
    case 'CUSTOMER_MASTER_NOT_CONFIGURED':
    case 'CUSTOMER_MASTER_UNAVAILABLE':
    case 'CUSTOMER_MASTER_SHEET_NOT_FOUND':
    case 'CUSTOMER_MASTER_SCHEMA': return 422;
    case 'VALIDATION_ERROR':
    case 'UNKNOWN_ENTITY':
    case 'DUPLICATE_KEY': return 400;
    case 'FORBIDDEN': return 403;
    case 'CONFLICT':
    case 'CONFLICT_VERSION':
    case 'APPEND_ONLY': return 409;
    case 'RATE_LIMITED': return 429;
    case 'UPSTREAM_TIMEOUT':
    case 'LOCK_TIMEOUT': return 503;
    default: return 500;
  }
}
