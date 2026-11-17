/** Idempotency key handling. Apps Script is the authoritative store (tbl_processed_requests). */

export function resolveIdempotencyKey(request) {
  return request.headers.get('Idempotency-Key') || crypto.randomUUID();
}

export async function rememberResult(env, key, result) {
  if (!env.KV) return;
  await env.KV.put(`idem:${key}`, JSON.stringify(result), { expirationTtl: 86400 });
}

export async function replayResult(env, key) {
  if (!env.KV) return null;
  const raw = await env.KV.get(`idem:${key}`);
  return raw ? JSON.parse(raw) : null;
}
