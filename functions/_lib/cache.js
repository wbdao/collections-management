/** KV read cache with tag-based invalidation. */

export async function cached(env, key, ttlSeconds, loader) {
  // Cache is a pure optimisation: a KV misconfiguration must never turn a
  // healthy API response into a 500. Guard every KV call and fall back to the
  // loader on any error (e.g. an expirationTtl below KV's 60s minimum).
  if (!env.KV) return loader();
  const cacheKey = `cache:${key}`;
  try {
    const hit = await env.KV.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (err) { /* fall through to loader */ }
  const value = await loader();
  try {
    // KV enforces a minimum TTL of 60 seconds.
    await env.KV.put(cacheKey, JSON.stringify(value), {
      expirationTtl: Math.max(60, Number(ttlSeconds) || 60)
    });
  } catch (err) { /* cache write failure must not fail the request */ }
  return value;
}

export async function invalidate(env, tags = []) {
  if (!env.KV || !tags.length) return;
  for (const tag of tags) {
    await env.KV.put(`cachetag:${tag}`, String(Date.now()), { expirationTtl: 86400 });
  }
  // Cache keys are versioned by tag generation at read time; a simpler Phase 1
  // approach is to delete known aggregate keys directly.
  const known = ['dashboard:summary', 'dashboard:custody', 'tracking'];
  for (const key of known) await env.KV.delete(`cache:${key}`);
}
