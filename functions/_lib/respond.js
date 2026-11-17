/** Consistent API envelopes and CORS headers. */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, If-Match, X-Request-Id, X-Bootstrap-Token',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin'
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      ...extraHeaders
    }
  });
}

export function success(data, meta = {}, status = 200, requestId) {
  return json({
    ok: true,
    data,
    meta: { requestId, ...meta }
  }, status);
}

export function failure(status, code, message, details = [], requestId) {
  return json({
    ok: false,
    error: { code, message, details, requestId }
  }, status);
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: CORS });
}
