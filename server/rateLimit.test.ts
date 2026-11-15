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

  describe('given maxKeys of 3 (R16: fail closed)', () => {
    const capped = (clock: { t: number }) => {
      const app = new Hono();
      app.use(
        '*',
        rateLimiter({ limit: 2, windowMs: 1000, maxKeys: 3, key: (c) => c.req.header('x-key') ?? 'anonymous', now: () => clock.t }),
      );
      app.get('/', (c) => c.text('ok'));
      return app;
    };

    it('when a fourth distinct key arrives, then it is 429 while the three live keys keep working', async () => {
      const app = capped({ t: 0 });
      for (const k of ['a', 'b', 'c']) expect((await hit(app, k)).status).toBe(200);
      expect((await hit(app, 'd')).status).toBe(429);
      expect((await hit(app, 'a')).status).toBe(200);
      expect((await hit(app, 'a')).status).toBe(429);
    });

    it('when the window has expired, then the new key is admitted', async () => {
      const clock = { t: 0 };
      const app = capped(clock);
      for (const k of ['a', 'b', 'c']) await hit(app, k);
      expect((await hit(app, 'd')).status).toBe(429);
      clock.t = 1001;
      expect((await hit(app, 'd')).status).toBe(200);
    });

    it('when no maxKeys is given, then 10_000 distinct keys are admitted and the 10_001st is 429', async () => {
      const app = new Hono();
      app.use('*', rateLimiter({ limit: 1, windowMs: 60_000, key: (c) => c.req.header('x-key')!, now: () => 0 }));
      app.get('/', (c) => c.text('ok'));
      for (let i = 0; i < 10_000; i++) expect((await hit(app, `k${i}`)).status).toBe(200);
      expect((await hit(app, 'one-too-many')).status).toBe(429);
    });
  });

  describe('given a rejected request (Retry-After)', () => {
    it('when 400 ms of a 1000 ms window have passed, then Retry-After is 1 (ceil of 0.6 s)', async () => {
      const clock = { t: 0 };
      const app = appWith({ limit: 1, windowMs: 1000 }, clock);
      await hit(app, 'a');
      clock.t = 400;
      expect((await hit(app, 'a')).headers.get('retry-after')).toBe('1');
    });

    it('when 10.5 s of a 60 s window have passed, then Retry-After is 50 (ceil of 49.5)', async () => {
      const clock = { t: 5_000 };
      const app = appWith({ limit: 1, windowMs: 60_000 }, clock);
      await hit(app, 'a');
      clock.t = 15_500;
      expect((await hit(app, 'a')).headers.get('retry-after')).toBe('50');
    });

    it('when 1 ms of the window is left, then Retry-After is never below 1', async () => {
      const clock = { t: 0 };
      const app = appWith({ limit: 1, windowMs: 1000 }, clock);
      await hit(app, 'a');
      clock.t = 999;
      expect((await hit(app, 'a')).headers.get('retry-after')).toBe('1');
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
