/**
 * rateLimiter (v4 sub-plan 4, Task 2): fixed window per key, in memory.
 * `now` is injected so windows can be crossed without sleeping.
 *
 * Signature pinned here: rateLimiter({ limit, windowMs, key, now? }): MiddlewareHandler
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { rateLimiter } from './rateLimit';

function appWith(opts: { limit: number; windowMs: number }, clock: { t: number }) {
  const app = new Hono();
  app.use(
    '*',
    rateLimiter({
      ...opts,
      key: (c) => c.req.header('x-key') ?? 'anonymous',
      now: () => clock.t,
    }),
  );
  app.get('/', (c) => c.text('ok'));
  return app;
}

const hit = (app: Hono, key?: string) => app.request('/', { headers: key ? { 'x-key': key } : {} });

describe('rateLimiter', () => {
  describe('given a limit of 3 per 1000 ms', () => {
    it('when a key makes 3 requests, then all pass', async () => {
      const app = appWith({ limit: 3, windowMs: 1000 }, { t: 0 });
      for (let i = 0; i < 3; i++) expect((await hit(app, 'a')).status).toBe(200);
    });

    it('when a key makes a 4th request inside the window, then it gets 429', async () => {
      const app = appWith({ limit: 3, windowMs: 1000 }, { t: 0 });
      for (let i = 0; i < 3; i++) await hit(app, 'a');
      const res = await hit(app, 'a');
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
    });

    it('when the window has passed, then the key may make requests again', async () => {
      const clock = { t: 0 };
      const app = appWith({ limit: 3, windowMs: 1000 }, clock);
      for (let i = 0; i < 4; i++) await hit(app, 'a');
      clock.t = 1001;
      expect((await hit(app, 'a')).status).toBe(200);
    });

    it('when rejected requests keep coming, then they do not extend the window past its original end', async () => {
      const clock = { t: 0 };
      const app = appWith({ limit: 3, windowMs: 1000 }, clock);
      for (let i = 0; i < 3; i++) await hit(app, 'a');
      clock.t = 900;
      expect((await hit(app, 'a')).status).toBe(429);
      clock.t = 1001;
      expect((await hit(app, 'a')).status).toBe(200);
    });

    it('when two different keys are used, then each has its own budget', async () => {
      const app = appWith({ limit: 3, windowMs: 1000 }, { t: 0 });
      for (let i = 0; i < 4; i++) await hit(app, 'a');
      expect((await hit(app, 'a')).status).toBe(429);
      expect((await hit(app, 'b')).status).toBe(200);
    });

    it('when the key function returns the same key for everyone, then they share one budget', async () => {
      const app = new Hono();
      app.use('*', rateLimiter({ limit: 1, windowMs: 1000, key: () => 'everyone', now: () => 0 }));
      app.get('/', (c) => c.text('ok'));
      expect((await hit(app, 'a')).status).toBe(200);
      expect((await hit(app, 'b')).status).toBe(429);
    });
  });

  describe('given two limiter instances', () => {
    it('when one is exhausted, then the other is unaffected', async () => {
      const one = appWith({ limit: 1, windowMs: 1000 }, { t: 0 });
      const two = appWith({ limit: 1, windowMs: 1000 }, { t: 0 });
      await hit(one, 'a');
      expect((await hit(one, 'a')).status).toBe(429);
      expect((await hit(two, 'a')).status).toBe(200);
    });
  });
});
