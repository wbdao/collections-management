/** KV-backed fixed-window rate limiting. Degrades open if KV is unavailable. */

export async function enforceRateLimit(env, ctx, bucket, limit, windowSeconds = 60, identity) {
  if (!env.KV) return;
  const actor = identity || ctx.actor?.userId || ctx.ip || 'anonymous';
  const key = `rl:${bucket}:${actor}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const current = Number((await env.KV.get(key)) || 0) + 1;
  if (current > limit) {
    throw Object.assign(new Error('Too many requests'), {
      code: 'RATE_LIMITED', status: 429, details: [{ retryAfter: windowSeconds }]
    });
  }
  await env.KV.put(key, String(current), { expirationTtl: windowSeconds + 5 });
}

export async function enforceLoginLimit(env, ctx) {
  // Public login runs with actor.userId === 'anonymous'. Key on the source IP
  // so one attacker cannot exhaust a single global login bucket for everyone.
  await enforceRateLimit(env, ctx, 'login', 10, 60, ctx.ip || 'unknown');
}
