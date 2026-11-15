import type { Context, MiddlewareHandler } from 'hono';

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  key: (c: Context) => string;
  now?: () => number;
};

/** Fixed-window limiter, in memory. Expired keys are swept at most once per window. */
export function rateLimiter(opts: RateLimitOptions): MiddlewareHandler {
  const { limit, windowMs, key } = opts;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return async (c, next) => {
    const t = now();
    if (t - lastSweep >= windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      lastSweep = t;
    }
    const k = key(c);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= t) {
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
