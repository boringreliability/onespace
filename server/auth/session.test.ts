/**
 * Sessions (v4 sub-plan 4, Task 2): random token, only its sha256 in the
 * database, 30-day expiry, and the requireUser middleware.
 *
 * Signatures pinned here (the brief leaves `now` and the middleware inputs open):
 *   createSession(sql, userId, now: number /- epoch ms -/): Promise<string>
 *   sessionUser(sql, token, now: number): Promise<{ id, name } | null>
 *   requireUser(sql, now?: () => number): MiddlewareHandler
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../migrate';
import { withTestSchema, type TestSchema } from '../test/db';
import { createSession, requireUser, sessionUser } from './session';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let t: TestSchema;
let userId: string;

beforeAll(async () => {
  t = await withTestSchema();
  await migrate(t.sql);
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.sql`truncate users cascade`;
  const [u] = await t.sql<{ id: string }[]>`insert into users (discord_id, name) values ('d-1', 'Ada') returning id`;
  userId = u!.id;
});

describe('createSession', () => {
  describe('given an existing user', () => {
    it('when a session is created, then the token is base64url with at least 256 bits', async () => {
      const token = await createSession(t.sql, userId, NOW);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    });

    it('when two sessions are created, then their tokens differ', async () => {
      const a = await createSession(t.sql, userId, NOW);
      const b = await createSession(t.sql, userId, NOW);
      expect(a).not.toBe(b);
    });

    it('when a session is created, then the database holds sha256(token) and never the token', async () => {
      const token = await createSession(t.sql, userId, NOW);
      const rows = await t.sql<{ token_hash: Buffer; hex: string; esc: string; b64: string }[]>`
        select token_hash, encode(token_hash, 'hex') as hex,
               encode(token_hash, 'escape') as esc, encode(token_hash, 'base64') as b64
        from sessions`;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(Buffer.from(row.token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
      for (const text of [row.hex, row.esc, row.b64]) expect(text).not.toContain(token);
      expect(JSON.stringify(await t.sql`select * from sessions`)).not.toContain(token);
    });

    it('when a session is created at NOW, then it expires exactly 30 days later', async () => {
      await createSession(t.sql, userId, NOW);
      const [row] = await t.sql<{ ms: string }[]>`select (extract(epoch from expires_at) * 1000)::text as ms from sessions`;
      expect(Number(row!.ms)).toBe(NOW + 30 * DAY);
    });
  });
});

describe('createSession housekeeping (R17)', () => {
  describe('given two users who both have expired sessions', () => {
    it('when the first user gets a new session, then only their expired rows are deleted', async () => {
      const [other] = await t.sql<{ id: string }[]>`insert into users (discord_id, name) values ('d-2', 'Bo') returning id`;
      const old = await createSession(t.sql, userId, NOW);
      await createSession(t.sql, other!.id, NOW);
      const later = NOW + 31 * DAY;
      const fresh = await createSession(t.sql, userId, later);

      expect(await t.sql`select 1 from sessions where user_id = ${userId}`).toHaveLength(1);
      expect(await t.sql`select 1 from sessions where user_id = ${other!.id}`).toHaveLength(1);
      expect(await sessionUser(t.sql, old, later)).toBeNull();
      expect(await sessionUser(t.sql, fresh, later)).toEqual({ id: userId, name: 'Ada' });
    });

    it('when the first user still has a live session, then it survives the new login', async () => {
      const live = await createSession(t.sql, userId, NOW);
      await createSession(t.sql, userId, NOW + DAY);
      expect(await sessionUser(t.sql, live, NOW + DAY)).toEqual({ id: userId, name: 'Ada' });
      expect(await t.sql`select 1 from sessions where user_id = ${userId}`).toHaveLength(2);
    });
  });
});

describe('sessionUser', () => {
  describe('given a live session', () => {
    it('when looked up with its token, then it returns the user id and name', async () => {
      const token = await createSession(t.sql, userId, NOW);
      expect(await sessionUser(t.sql, token, NOW + DAY)).toEqual({ id: userId, name: 'Ada' });
    });

    it('when looked up one second before expiry, then it still resolves', async () => {
      const token = await createSession(t.sql, userId, NOW);
      expect(await sessionUser(t.sql, token, NOW + 30 * DAY - 1000)).toEqual({ id: userId, name: 'Ada' });
    });
  });

  describe('given an expired session', () => {
    it('when looked up after the 30 days, then it returns null', async () => {
      const token = await createSession(t.sql, userId, NOW);
      expect(await sessionUser(t.sql, token, NOW + 30 * DAY + 1000)).toBeNull();
    });
  });

  describe('given a token that was never issued', () => {
    it('when looked up, then it returns null', async () => {
      await createSession(t.sql, userId, NOW);
      expect(await sessionUser(t.sql, 'not-a-real-token', NOW)).toBeNull();
    });

    it('when the stored hash is presented as if it were the token, then it returns null', async () => {
      const token = await createSession(t.sql, userId, NOW);
      const hex = createHash('sha256').update(token).digest('hex');
      const b64 = createHash('sha256').update(token).digest('base64url');
      expect(await sessionUser(t.sql, hex, NOW)).toBeNull();
      expect(await sessionUser(t.sql, b64, NOW)).toBeNull();
    });

    it('when the token is empty, then it returns null', async () => {
      expect(await sessionUser(t.sql, '', NOW)).toBeNull();
    });
  });

  describe('given the user is deleted', () => {
    it('when the session is looked up, then it returns null (sessions cascade)', async () => {
      const token = await createSession(t.sql, userId, NOW);
      await t.sql`delete from users where id = ${userId}`;
      expect(await sessionUser(t.sql, token, NOW)).toBeNull();
    });
  });
});

describe('requireUser', () => {
  let clock: number;
  function guarded() {
    const app = new Hono<{ Variables: { user: { id: string; name: string } } }>();
    app.use('*', requireUser(t.sql, () => clock));
    app.get('/', (c) => c.json({ user: c.var.user }));
    return app;
  }
  const withCookie = (token: string) => ({ headers: { cookie: `__Host-onespace_session=${token}` } });

  beforeEach(() => {
    clock = NOW;
  });

  describe('given a valid session cookie', () => {
    it('when a request arrives, then the handler sees c.var.user', async () => {
      const token = await createSession(t.sql, userId, NOW);
      const res = await guarded().request('/', withCookie(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: { id: userId, name: 'Ada' } });
    });
  });

  describe('given no usable session', () => {
    it('when there is no cookie, then 401 { error: unauthenticated }', async () => {
      const res = await guarded().request('/');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('when the token is unknown, then 401 { error: unauthenticated }', async () => {
      const res = await guarded().request('/', withCookie('nope'));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('when the session has expired (injected now), then 401 { error: unauthenticated }', async () => {
      const token = await createSession(t.sql, userId, NOW);
      clock = NOW + 30 * DAY + 1000;
      const res = await guarded().request('/', withCookie(token));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('when a differently named cookie carries a valid token, then it is not accepted', async () => {
      const token = await createSession(t.sql, userId, NOW);
      const res = await guarded().request('/', { headers: { cookie: `onespace_session=${token}` } });
      expect(res.status).toBe(401);
    });
  });
});
