import type { Context, MiddlewareHandler } from 'hono';

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  key: (c: Context) => string;
  /** Hard cap on live keys (default 10_000). A NEW key at the cap is rejected (fail closed). */
  maxKeys?: number;
  now?: () => number;
};

/** Fixed-window limiter, in memory. Expired keys are swept at most once per window. */
export function rateLimiter(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, key } = opts;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return async (c, next) => {
    const t = now();
    const sweep = () => {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      lastSweep = t;
    };
    if (t - lastSweep >= windowMs) sweep();
    const k = key(c);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= t) {
      if (!entry && hits.size >= maxKeys) sweep();
      if (!entry && hits.size >= maxKeys) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
        return c.json({ error: 'rate_limited' }, 429);
      }
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(k, entry);
    }
    if (entry.count >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      return c.json({ error: 'rate_limited' }, 429);
    }
    entry.count += 1;
    await next();
  };
}
