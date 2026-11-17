/** KV read cache with tag-based invalidation. */

export async function cached(env, key, ttlSeconds, loader) {
  if (!env.KV) return loader();
  const cacheKey = `cache:${key}`;
  const hit = await env.KV.get(cacheKey);
  if (hit) return JSON.parse(hit);
  const value = await loader();
  await env.KV.put(cacheKey, JSON.stringify(value), { expirationTtl: ttlSeconds });
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
