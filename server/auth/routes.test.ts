/**
 * Auth routes (v4 sub-plan 4, Task 2): Discord OAuth2 + PKCE (hand-rolled, no
 * OAuth library), role gate, sessions, test login, rate limit. Discord is a
 * mocked `fetch`; the clock and the client IP are injected into createApp.
 *
 * Deps added to createApp for this task (phase B implements them):
 *   clientIp?: (c: Context) => string   // prod: getConnInfo, x-forwarded-for right-most entry only when config.production
 *
 * Pinned formats:
 *   oauth cookie  __Host-onespace_oauth   = "<state>.<verifier>"  (HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600)
 *   session cookie __Host-onespace_session = <token>              (HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000)
 */

import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import type { Config } from '../config';
import { migrate } from '../migrate';
import { withTestSchema, type TestSchema } from '../test/db';

const ORIGIN = 'https://onespace.example';
const GUILD = 'guild-1';
const ROLE = 'role-1';
const OAUTH = '__Host-onespace_oauth';
const SESSION = '__Host-onespace_session';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const baseConfig: Config = {
  databaseUrl: 'postgres://unused',
  publicOrigin: ORIGIN,
  discord: { clientId: 'client-1', clientSecret: 'secret-1', guildId: GUILD, roleId: ROLE },
  port: 8787,
  production: false,
  testLogin: false,
};

let t: TestSchema;
let clock: number;

beforeAll(async () => {
  t = await withTestSchema();
  await migrate(t.sql);
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.sql`truncate users cascade`;
  clock = T0;
});

// ---- Discord mock ---------------------------------------------------------

type Call = { url: string; method: string; headers: Headers; body: string };
type Member = { id?: string; username?: string; global_name?: string | null; roles?: string[] };
type DiscordOpts = {
  token?: { status: number; body?: unknown };
  member?: { status: number; body?: unknown } | 'throw';
  tokenThrows?: boolean;
};

const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const MEMBER_URL = `https://discord.com/api/users/@me/guilds/${GUILD}/member`;

function memberOk(m: Member = {}) {
  return {
    status: 200,
    body: {
      user: { id: m.id ?? '1001', username: m.username ?? 'ada_l', global_name: m.global_name === undefined ? 'Ada' : m.global_name },
      roles: m.roles ?? [ROLE],
    },
  };
}

function discord(opts: DiscordOpts = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? '' : String(init.body),
    });
    const reply = (r: { status: number; body?: unknown }) =>
      new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    if (url === TOKEN_URL) {
      if (opts.tokenThrows) throw new TypeError('fetch failed');
      return reply(opts.token ?? { status: 200, body: { access_token: 'access-xyz', token_type: 'Bearer' } });
    }
    if (url === MEMBER_URL) {
      if (opts.member === 'throw') throw new TypeError('fetch failed');
      return reply(opts.member ?? memberOk());
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

// ---- App + request helpers ------------------------------------------------

function makeApp(opts: { config?: Partial<Config>; discord?: DiscordOpts; defaultClientIp?: boolean } = {}) {
  const d = discord(opts.discord);
  const app = createApp({
    config: { ...baseConfig, ...opts.config },
    sql: t.sql,
    now: () => clock,
    fetch: d.fetchFn,
    // defaultClientIp: leave createApp's own client-IP resolution in place.
    ...(opts.defaultClientIp ? {} : { clientIp: (c: Context) => c.req.header('x-test-ip') ?? '10.0.0.1' }),
    staticRoot: '/nonexistent',
  });
  return { app, calls: d.calls };
}

type App = ReturnType<typeof makeApp>['app'];

type Cookie = { name: string; value: string; attrs: string[]; raw: string };
function setCookies(res: Response): Cookie[] {
  return res.headers.getSetCookie().map((raw) => {
    const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
    const eq = pair!.indexOf('=');
    return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attrs, raw };
  });
}
function cookieNamed(res: Response, name: string): Cookie | undefined {
  return setCookies(res).find((c) => c.name === name);
}
function attrsLower(c: Cookie): string[] {
  return c.attrs.map((a) => a.toLowerCase());
}
function expectCleared(c: Cookie | undefined) {
  expect(c, 'cookie should be set to clear it').toBeDefined();
  expect(c!.value).toBe('');
  const a = attrsLower(c!);
  expect(a).toContain('max-age=0');
  expect(a).toContain('path=/');
  expect(a).toContain('secure');
}

const authorize = (app: App, ip?: string) => app.request('/api/auth/discord', { headers: ip ? { 'x-test-ip': ip } : {} });

/** Runs the first leg and returns what a browser would hold: state, verifier and the authorize URL. */
async function startLogin(app: App) {
  const res = await authorize(app);
  const location = new URL(res.headers.get('location')!);
  const cookie = cookieNamed(res, OAUTH)!;
  const [state, verifier] = cookie.value.split('.');
  return { res, location, cookie, state: state!, verifier: verifier! };
}

function callback(app: App, qs: Record<string, string>, cookieValue?: string, ip?: string) {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) headers.cookie = `${OAUTH}=${cookieValue}`;
  if (ip) headers['x-test-ip'] = ip;
  return app.request(`/api/auth/discord/callback?${new URLSearchParams(qs)}`, { headers });
}

/** Full happy-path login; returns the session token. */
async function login(app: App): Promise<string> {
  const { state, verifier } = await startLogin(app);
  const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
  expect(res.headers.get('location')).toBe('/?auth=ok');
  return cookieNamed(res, SESSION)!.value;
}

const counts = async () => {
  const [u] = await t.sql<{ n: number }[]>`select count(*)::int as n from users`;
  const [s] = await t.sql<{ n: number }[]>`select count(*)::int as n from sessions`;
  return { users: u!.n, sessions: s!.n };
};

const b64url = (buf: Buffer) => buf.toString('base64url');

// ---- Tests ----------------------------------------------------------------

describe('GET /api/auth/discord', () => {
  describe('given a visitor starting a login', () => {
    it('when requested, then it redirects 302 to the Discord authorize endpoint', async () => {
      const { app } = makeApp();
      const res = await authorize(app);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location')!);
      expect(`${loc.origin}${loc.pathname}`).toBe('https://discord.com/oauth2/authorize');
    });

    it('when requested, then the query carries code flow, client id, redirect_uri and scopes', async () => {
      const { app } = makeApp();
      const { location } = await startLogin(app);
      const q = location.searchParams;
      expect(q.get('response_type')).toBe('code');
      expect(q.get('client_id')).toBe('client-1');
      expect(q.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`);
      expect(q.get('scope')).toBe('identify guilds.members.read');
    });

    it('when requested, then state is at least 32 chars of base64url and PKCE uses S256', async () => {
      const { app } = makeApp();
      const { location } = await startLogin(app);
      const q = location.searchParams;
      expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(q.get('code_challenge_method')).toBe('S256');
    });

    it('when requested, then it sets the oauth cookie HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600', async () => {
      const { app } = makeApp();
      const { cookie } = await startLogin(app);
      const a = attrsLower(cookie);
      expect(a).toContain('httponly');
      expect(a).toContain('secure');
      expect(a).toContain('samesite=lax');
      expect(a).toContain('path=/');
      expect(a).toContain('max-age=600');
      expect(a.some((x) => x.startsWith('domain='))).toBe(false);
    });

    it('when requested, then the cookie is "<state>.<verifier>" with the same state as the URL', async () => {
      const { app } = makeApp();
      const { cookie, location, state, verifier } = await startLogin(app);
      expect(cookie.value.split('.')).toHaveLength(2);
      expect(state).toBe(location.searchParams.get('state'));
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    });

    it('when requested, then code_challenge equals base64url(sha256(verifier)) from the cookie', async () => {
      const { app } = makeApp();
      const { location, verifier } = await startLogin(app);
      const expected = b64url(createHash('sha256').update(verifier).digest());
      expect(location.searchParams.get('code_challenge')).toBe(expected);
    });

    it('when requested twice, then state and verifier differ between the logins', async () => {
      const { app } = makeApp();
      const a = await startLogin(app);
      const b = await startLogin(app);
      expect(a.state).not.toBe(b.state);
      expect(a.verifier).not.toBe(b.verifier);
    });

    it('when requested, then Discord is not contacted', async () => {
      const { app, calls } = makeApp();
      await authorize(app);
      expect(calls).toHaveLength(0);
    });
  });
});

describe('GET /api/auth/discord/callback', () => {
  describe('given a member with the invite role', () => {
    it('when the callback arrives, then it redirects to /?auth=ok', async () => {
      const { app } = makeApp();
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?auth=ok');
    });

    it('when the callback arrives, then the token request is the exact PKCE authorization_code exchange', async () => {
      const { app, calls } = makeApp();
      const { state, verifier } = await startLogin(app);
      await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      const tokenCalls = calls.filter((c) => c.url === TOKEN_URL);
      expect(tokenCalls).toHaveLength(1);
      const call = tokenCalls[0]!;
      expect(call.method).toBe('POST');
      expect(call.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
      const form = new URLSearchParams(call.body);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('code-1');
      expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`);
      expect(form.get('code_verifier')).toBe(verifier);
      expect(form.get('client_id')).toBe('client-1');
      expect(form.get('client_secret')).toBe('secret-1');
    });

    it('when the callback arrives, then the membership request uses the access token as Bearer', async () => {
      const { app, calls } = makeApp();
      const { state, verifier } = await startLogin(app);
      await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      const memberCalls = calls.filter((c) => c.url === MEMBER_URL);
      expect(memberCalls).toHaveLength(1);
      expect(memberCalls[0]!.method).toBe('GET');
      expect(memberCalls[0]!.headers.get('authorization')).toBe('Bearer access-xyz');
      expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, MEMBER_URL]);
    });

    it('when the callback arrives, then it sets the session cookie HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000', async () => {
      const { app } = makeApp();
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      const c = cookieNamed(res, SESSION)!;
      expect(c).toBeDefined();
      expect(c.value).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      const a = attrsLower(c);
      expect(a).toContain('httponly');
      expect(a).toContain('secure');
      expect(a).toContain('samesite=lax');
      expect(a).toContain('path=/');
      expect(a).toContain('max-age=2592000');
      expect(a.some((x) => x.startsWith('domain='))).toBe(false);
    });

    it('when the callback arrives, then exactly one user and one session exist, keyed by Discord id', async () => {
      const { app } = makeApp();
      await login(app);
      const rows = await t.sql<{ discord_id: string; name: string }[]>`select discord_id, name from users`;
      expect(rows).toEqual([{ discord_id: '1001', name: 'Ada' }]);
      expect((await counts()).sessions).toBe(1);
    });

    it('when the callback arrives, then the session in the database is only a hash of the cookie token', async () => {
      const { app } = makeApp();
      const token = await login(app);
      const [row] = await t.sql<{ token_hash: Buffer }[]>`select token_hash from sessions`;
      expect(Buffer.from(row!.token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
      expect(JSON.stringify(await t.sql`select * from sessions`)).not.toContain(token);
    });

    it('when the callback arrives, then the Discord access token is stored nowhere', async () => {
      const { app } = makeApp();
      await login(app);
      const dump = JSON.stringify([
        await t.sql`select * from users`,
        await t.sql`select * from sessions`,
        await t.sql`select * from saves`,
        await t.sql`select * from actions`,
      ]);
      expect(dump).not.toContain('access-xyz');
    });

    it('when the user has no global_name, then the stored name is the username', async () => {
      const { app } = makeApp({ discord: { member: memberOk({ global_name: null, username: 'ada_l' }) } });
      await login(app);
      const [u] = await t.sql<{ name: string }[]>`select name from users`;
      expect(u!.name).toBe('ada_l');
    });

    it('when the callback arrives, then the oauth cookie is cleared (Max-Age=0)', async () => {
      const { app } = makeApp();
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      expectCleared(cookieNamed(res, OAUTH));
    });

    it('when the same Discord id logs in again with a new name, then it is the same user with the name updated', async () => {
      const first = makeApp({ discord: { member: memberOk({ global_name: 'Old Name' }) } });
      await login(first.app);
      const [before] = await t.sql<{ id: string }[]>`select id from users`;

      const second = makeApp({ discord: { member: memberOk({ global_name: 'New Name' }) } });
      await login(second.app);

      const rows = await t.sql<{ id: string; name: string }[]>`select id, name from users`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(before!.id);
      expect(rows[0]!.name).toBe('New Name');
      expect((await counts()).sessions).toBe(2);
    });

    it('when two different Discord ids log in, then they are two users', async () => {
      await login(makeApp({ discord: { member: memberOk({ id: '1' }) } }).app);
      await login(makeApp({ discord: { member: memberOk({ id: '2' }) } }).app);
      expect((await counts()).users).toBe(2);
    });
  });

  describe('given a member without the invite role', () => {
    it('when the callback arrives, then /?auth=not-invited and no user or session is created', async () => {
      const { app } = makeApp({ discord: { member: memberOk({ roles: ['other'] }) } });
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      expect(res.headers.get('location')).toBe('/?auth=not-invited');
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
      expect(cookieNamed(res, SESSION)).toBeUndefined();
      expectCleared(cookieNamed(res, OAUTH));
    });
  });

  describe('given a Discord user who is not in the guild', () => {
    it('when the member endpoint answers 404, then /?auth=not-invited and nothing is created', async () => {
      const { app } = makeApp({ discord: { member: { status: 404, body: { code: 10007 } } } });
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      expect(res.headers.get('location')).toBe('/?auth=not-invited');
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
      expect(cookieNamed(res, SESSION)).toBeUndefined();
      expectCleared(cookieNamed(res, OAUTH));
    });
  });

  describe('given a callback that cannot be trusted', () => {
    async function expectError(res: Response) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?auth=error');
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
      expect(cookieNamed(res, SESSION)).toBeUndefined();
      expectCleared(cookieNamed(res, OAUTH));
    }

    it('when the state does not match the cookie, then /?auth=error, nothing is created and Discord is not called', async () => {
      const { app, calls } = makeApp();
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state: `${state}x` }, `${state}.${verifier}`);
      await expectError(res);
      expect(calls).toHaveLength(0);
    });

    it('when there is no oauth cookie, then /?auth=error and Discord is not called', async () => {
      const { app, calls } = makeApp();
      const res = await callback(app, { code: 'code-1', state: 'whatever' });
      await expectError(res);
      expect(calls).toHaveLength(0);
    });

    it('when the oauth cookie is malformed, then /?auth=error', async () => {
      const { app, calls } = makeApp();
      const res = await callback(app, { code: 'code-1', state: 'nodot' }, 'nodot');
      await expectError(res);
      expect(calls).toHaveLength(0);
    });

    it('when the code is missing, then /?auth=error and Discord is not called', async () => {
      const { app, calls } = makeApp();
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { state }, `${state}.${verifier}`);
      await expectError(res);
      expect(calls).toHaveLength(0);
    });

    it('when the user cancelled (error=access_denied), then /?auth=error and Discord is not called', async () => {
      const { app, calls } = makeApp();
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { error: 'access_denied', state }, `${state}.${verifier}`);
      await expectError(res);
      expect(calls).toHaveLength(0);
    });

    it('when the token endpoint answers 400, then /?auth=error and the member endpoint is not called', async () => {
      const { app, calls } = makeApp({ discord: { token: { status: 400, body: { error: 'invalid_grant' } } } });
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'bad', state }, `${state}.${verifier}`);
      await expectError(res);
      expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    });

    it('when the token request throws, then /?auth=error', async () => {
      const { app } = makeApp({ discord: { tokenThrows: true } });
      const { state, verifier } = await startLogin(app);
      await expectError(await callback(app, { code: 'code-1', state }, `${state}.${verifier}`));
    });

    it('when the member endpoint answers 500, then /?auth=error (not not-invited)', async () => {
      const { app } = makeApp({ discord: { member: { status: 500, body: {} } } });
      const { state, verifier } = await startLogin(app);
      await expectError(await callback(app, { code: 'code-1', state }, `${state}.${verifier}`));
    });

    it('when the member request throws, then /?auth=error (not not-invited)', async () => {
      const { app } = makeApp({ discord: { member: 'throw' } });
      const { state, verifier } = await startLogin(app);
      await expectError(await callback(app, { code: 'code-1', state }, `${state}.${verifier}`));
    });

    it('when a state was already used, then replaying the callback without the (cleared) cookie is an error', async () => {
      const { app } = makeApp();
      const { state, verifier } = await startLogin(app);
      await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      const replay = await callback(app, { code: 'code-1', state });
      expect(replay.headers.get('location')).toBe('/?auth=error');
      expect((await counts()).sessions).toBe(1);
    });
  });
});

describe('GET /api/me', () => {
  describe('given a logged-in user', () => {
    it('when requested with the session cookie, then it returns { id, name }', async () => {
      const { app } = makeApp();
      const token = await login(app);
      const [u] = await t.sql<{ id: string }[]>`select id from users`;
      const res = await app.request('/api/me', { headers: { cookie: `${SESSION}=${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: u!.id, name: 'Ada' });
    });

    it('when requested, then the response contains no email and no discord id', async () => {
      const { app } = makeApp();
      const token = await login(app);
      const res = await app.request('/api/me', { headers: { cookie: `${SESSION}=${token}` } });
      expect(Object.keys(await res.json()).sort()).toEqual(['id', 'name']);
    });
  });

  describe('given no usable session', () => {
    it('when there is no cookie, then 401 { error: unauthenticated }', async () => {
      const { app } = makeApp();
      const res = await app.request('/api/me');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('when the token is unknown, then 401 { error: unauthenticated }', async () => {
      const { app } = makeApp();
      const res = await app.request('/api/me', { headers: { cookie: `${SESSION}=bogus` } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('when the session is expired (injected now), then 401', async () => {
      const { app } = makeApp();
      const token = await login(app);
      clock = T0 + 30 * DAY + 1000;
      const res = await app.request('/api/me', { headers: { cookie: `${SESSION}=${token}` } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('when the session is one minute from expiry, then it still works', async () => {
      const { app } = makeApp();
      const token = await login(app);
      clock = T0 + 30 * DAY - 60_000;
      const res = await app.request('/api/me', { headers: { cookie: `${SESSION}=${token}` } });
      expect(res.status).toBe(200);
    });
  });
});

describe('POST /api/auth/logout', () => {
  const post = (app: App, cookie?: string, origin: string | null = ORIGIN) =>
    app.request('/api/auth/logout', {
      method: 'POST',
      headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    });

  describe('given a logged-in user', () => {
    it('when logging out, then 204, the session row is deleted and the cookie is cleared', async () => {
      const { app } = makeApp();
      const token = await login(app);
      const res = await post(app, `${SESSION}=${token}`);
      expect(res.status).toBe(204);
      expect((await counts()).sessions).toBe(0);
      expectCleared(cookieNamed(res, SESSION));
    });

    it('when logging out, then the user row and the token stop working', async () => {
      const { app } = makeApp();
      const token = await login(app);
      await post(app, `${SESSION}=${token}`);
      expect((await counts()).users).toBe(1);
      const me = await app.request('/api/me', { headers: { cookie: `${SESSION}=${token}` } });
      expect(me.status).toBe(401);
    });

    it('when logging out, then other sessions of the same user are untouched', async () => {
      const { app } = makeApp();
      const a = await login(app);
      const b = await login(app);
      await post(app, `${SESSION}=${a}`);
      expect((await counts()).sessions).toBe(1);
      const me = await app.request('/api/me', { headers: { cookie: `${SESSION}=${b}` } });
      expect(me.status).toBe(200);
    });
  });

  describe('given no session', () => {
    it('when logging out, then it is still 204 and the cookie is cleared', async () => {
      const { app } = makeApp();
      const res = await post(app);
      expect(res.status).toBe(204);
      expectCleared(cookieNamed(res, SESSION));
    });
  });

  describe('given a request from a foreign origin', () => {
    it('when logging out with the wrong Origin, then 403 and the session survives', async () => {
      const { app } = makeApp();
      const token = await login(app);
      const res = await post(app, `${SESSION}=${token}`, 'https://evil.example');
      expect(res.status).toBe(403);
      expect((await counts()).sessions).toBe(1);
    });

    it('when logging out without an Origin, then 403', async () => {
      const { app } = makeApp();
      const res = await post(app, undefined, null);
      expect(res.status).toBe(403);
    });
  });
});

describe('POST /api/test/login', () => {
  const post = (app: App, body: unknown, origin: string | null = ORIGIN, ip?: string) =>
    app.request('/api/test/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...(ip ? { 'x-test-ip': ip } : {}),
      },
      body: JSON.stringify(body),
    });

  describe('given testLogin is enabled', () => {
    it('when posting a name, then a user with discord_id "test:<name>" and a session are created', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      const res = await post(app, { name: 'tester' });
      expect(res.status).toBe(200);
      const rows = await t.sql<{ discord_id: string; name: string }[]>`select discord_id, name from users`;
      expect(rows).toEqual([{ discord_id: 'test:tester', name: 'tester' }]);
      expect(rows[0]!.discord_id.startsWith('test:')).toBe(true);
      expect((await counts()).sessions).toBe(1);
    });

    it('when posting a name, then the session cookie has the same attributes as a real login and works for /api/me', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      const res = await post(app, { name: 'tester' });
      const c = cookieNamed(res, SESSION)!;
      expect(c).toBeDefined();
      const a = attrsLower(c);
      expect(a).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/', 'max-age=2592000']));
      const me = await app.request('/api/me', { headers: { cookie: `${SESSION}=${c.value}` } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ name: 'tester' });
    });

    it('when the same name logs in twice, then it is one user with two sessions', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      await post(app, { name: 'tester' });
      await post(app, { name: 'tester' });
      expect(await counts()).toEqual({ users: 1, sessions: 2 });
    });

    it('when the name is missing or empty, then 400 and nothing is created', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      expect((await post(app, {})).status).toBe(400);
      expect((await post(app, { name: '' })).status).toBe(400);
      expect((await post(app, { name: 42 })).status).toBe(400);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it('when the Origin is not ours, then 403 (the origin check applies here too)', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      expect((await post(app, { name: 'tester' }, 'https://evil.example')).status).toBe(403);
      expect((await post(app, { name: 'tester' }, null)).status).toBe(403);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });
  });

  describe('given testLogin is disabled', () => {
    it('when posting a name, then 404 and nothing is created', async () => {
      const { app } = makeApp({ config: { testLogin: false } });
      const res = await post(app, { name: 'tester' });
      expect(res.status).toBe(404);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
      expect(cookieNamed(res, SESSION)).toBeUndefined();
    });
  });
});

describe('rate limit on login routes', () => {
  const testLogin = (app: App, ip: string) =>
    app.request('/api/test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-test-ip': ip },
      body: JSON.stringify({ name: 'rl' }),
    });

  describe('given 20 login calls from one IP within 60 s', () => {
    it('when the 21st arrives at /api/auth/discord, then 429', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 20; i++) expect((await authorize(app, '9.9.9.9')).status).toBe(302);
      const res = await authorize(app, '9.9.9.9');
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
    });

    it('when the 21st arrives at /api/auth/discord/callback, then 429', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 20; i++) expect((await callback(app, {}, undefined, '9.9.9.9')).status).toBe(302);
      expect((await callback(app, {}, undefined, '9.9.9.9')).status).toBe(429);
    });

    it('when the 21st arrives at /api/test/login, then 429', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      for (let i = 0; i < 20; i++) expect((await testLogin(app, '9.9.9.9')).status).toBe(200);
      expect((await testLogin(app, '9.9.9.9')).status).toBe(429);
    });

    it('when starts, callbacks and test logins share one IP, then they spend one shared budget of 20', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      for (let i = 0; i < 10; i++) expect((await authorize(app, '9.9.9.9')).status).toBe(302);
      for (let i = 0; i < 10; i++) expect((await callback(app, {}, undefined, '9.9.9.9')).status).toBe(302);
      expect((await authorize(app, '9.9.9.9')).status).toBe(429);
      expect((await callback(app, {}, undefined, '9.9.9.9')).status).toBe(429);
      expect((await testLogin(app, '9.9.9.9')).status).toBe(429);
    });

    it('when a different IP calls, then it is not limited', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 21; i++) await authorize(app, '9.9.9.9');
      expect((await authorize(app, '8.8.8.8')).status).toBe(302);
    });

    it('when more than 60 s have passed, then the IP may log in again', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 21; i++) await authorize(app, '9.9.9.9');
      expect((await authorize(app, '9.9.9.9')).status).toBe(429);
      clock = T0 + 60_001;
      expect((await authorize(app, '9.9.9.9')).status).toBe(302);
    });

    it('when the limit is hit, then non-login routes (health, me) are not limited', async () => {
      const { app } = makeApp();
      for (let i = 0; i < 21; i++) await authorize(app, '9.9.9.9');
      const h = { headers: { 'x-test-ip': '9.9.9.9' } };
      expect((await app.request('/api/health', h)).status).toBe(200);
      expect((await app.request('/api/me', h)).status).toBe(401);
    });
  });
});

// ---- Fix round 1 (R16, R17) -------------------------------------------------

describe('default client IP (no injected clientIp)', () => {
  const xff = (app: App, value: string) => app.request('/api/auth/discord', { headers: { 'x-forwarded-for': value } });

  describe('given production, behind Railway (R16: right-most X-Forwarded-For entry)', () => {
    it('when 21 calls share the right-most entry but vary the left-most, then the 21st is 429', async () => {
      const { app } = makeApp({ config: { production: true }, defaultClientIp: true });
      for (let i = 0; i < 20; i++) expect((await xff(app, `1.1.1.${i}, 9.9.9.9`)).status).toBe(302);
      expect((await xff(app, '1.1.1.99, 9.9.9.9')).status).toBe(429);
    });

    it('when 21 calls share the left-most but vary the right-most, then none is 429', async () => {
      const { app } = makeApp({ config: { production: true }, defaultClientIp: true });
      for (let i = 0; i < 21; i++) expect((await xff(app, `1.1.1.1, 9.9.9.${i}`)).status).toBe(302);
    });

    it('when the right-most entry has surrounding spaces, then it is trimmed to the same key', async () => {
      const { app } = makeApp({ config: { production: true }, defaultClientIp: true });
      for (let i = 0; i < 20; i++) await xff(app, `1.1.1.${i},   9.9.9.9  `);
      expect((await xff(app, '2.2.2.2, 9.9.9.9')).status).toBe(429);
    });
  });

  describe('given production is false', () => {
    it('when the right-most entry varies, then X-Forwarded-For is ignored and all share one key (21st is 429)', async () => {
      const { app } = makeApp({ defaultClientIp: true });
      for (let i = 0; i < 20; i++) expect((await xff(app, `1.1.1.1, 9.9.9.${i}`)).status).toBe(302);
      expect((await xff(app, '1.1.1.1, 9.9.9.250')).status).toBe(429);
    });
  });
});

describe('default client IP: IPv6 /64 keys and fall-through (R19)', () => {
  const xff = (app: App, value?: string) =>
    app.request('/api/auth/discord', { headers: value === undefined ? {} : { 'x-forwarded-for': value } });
  const prod = () => makeApp({ config: { production: true }, defaultClientIp: true }).app;

  describe('given production and IPv6 clients', () => {
    it('when 21 right-most addresses lie inside one /64, then the 21st is 429', async () => {
      const app = prod();
      for (let i = 0; i < 20; i++) expect((await xff(app, `1.1.1.1, 2001:db8:1:2::${(i + 1).toString(16)}`)).status).toBe(302);
      expect((await xff(app, '1.1.1.1, 2001:db8:1:2:ffff::1')).status).toBe(429);
    });

    it('when 21 right-most addresses lie in 21 different /64s, then none is 429', async () => {
      const app = prod();
      for (let i = 0; i < 21; i++) expect((await xff(app, `2001:db8:1:${(i + 1).toString(16)}::1`)).status).toBe(302);
    });

    it('when the same client appears as IPv4 and as ::ffff:IPv4-mapped, then they share one key', async () => {
      const app = prod();
      for (let i = 0; i < 10; i++) await xff(app, '5.6.7.8');
      for (let i = 0; i < 10; i++) await xff(app, '::FFFF:5.6.7.8');
      expect((await xff(app, '5.6.7.8')).status).toBe(429);
    });
  });

  describe('given production and no usable X-Forwarded-For entry', () => {
    it.each([['trailing comma and space', '1.1.1.1, '], ['a lone comma', ','], ['no header at all', undefined]])(
      'when it is %s, then all calls share the fallback key and the 21st is 429',
      async (_label, value) => {
        const app = prod();
        for (let i = 0; i < 20; i++) expect((await xff(app, value)).status).toBe(302);
        expect((await xff(app, value)).status).toBe(429);
      },
    );

    it('when the entry is empty, then it shares one key with a request that has no header', async () => {
      const app = prod();
      for (let i = 0; i < 10; i++) await xff(app, ',');
      for (let i = 0; i < 10; i++) await xff(app);
      expect((await xff(app, '1.1.1.1, ')).status).toBe(429);
    });
  });
});

describe('test login is never available in production (R17)', () => {
  describe('given a Config with production and testLogin both true, passed straight to createApp', () => {
    it('when posting a name, then 404 and nothing is created', async () => {
      const { app } = makeApp({ config: { production: true, testLogin: true } });
      const res = await app.request('/api/test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ name: 'tester' }),
      });
      expect(res.status).toBe(404);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });
  });
});

describe('test login names (R17)', () => {
  const post = (app: App, name: unknown) =>
    app.request('/api/test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ name }),
    });

  describe('given testLogin is enabled', () => {
    it('when the name is only whitespace, then 400 and nothing is created', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      expect((await post(app, '   ')).status).toBe(400);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it('when the name contains a control character, then 400', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      expect((await post(app, 'a\u0007b')).status).toBe(400);
      expect((await post(app, 'line\nbreak')).status).toBe(400);
      expect(await counts()).toEqual({ users: 0, sessions: 0 });
    });

    it('when the name has surrounding spaces, then it is stored trimmed (name and discord_id)', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      const res = await post(app, ' Dennis ');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ name: 'Dennis' });
      const rows = await t.sql<{ discord_id: string; name: string }[]>`select discord_id, name from users`;
      expect(rows).toEqual([{ discord_id: 'test:Dennis', name: 'Dennis' }]);
    });

    it('when the name is 65 chars, then 400; when it is 64 chars, then 200', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      expect((await post(app, 'a'.repeat(65))).status).toBe(400);
      expect((await post(app, 'a'.repeat(64))).status).toBe(200);
    });

    it('when the database fails, then 500 { error: internal } and the message is logged', async () => {
      const { app } = makeApp({ config: { testLogin: true } });
      await t.sql`alter table sessions rename to sessions_gone`;
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await post(app, 'tester');
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'internal' });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        await t.sql`alter table sessions_gone rename to sessions`;
      }
    });
  });
});

describe('no email anywhere', () => {
  describe('given the migrated schema', () => {
    it('when the users table is inspected, then its columns are exactly id, discord_id, name, created_at', async () => {
      const cols = await t.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'users'
        order by ordinal_position`;
      expect(cols.map((c) => c.column_name)).toEqual(['id', 'discord_id', 'name', 'created_at']);
    });
  });
});

// Final fix round — Ruling R72: a login that ends not-invited because the role was taken
// away deletes every session of that Discord user id (a de-invited user keeps no 30-day door).
describe('a de-invited user loses every session (R72)', () => {
  const me = (app: App, token: string) => app.request('/api/me', { headers: { cookie: `${SESSION}=${token}` } });

  describe('given Discord user 1001 holds two sessions and user 2002 one', () => {
    it('when 1001 logs in again WITHOUT the role, then /?auth=not-invited, both of 1001\'s sessions are gone, 2002\'s survives, and no user row is deleted', async () => {
      const ada = makeApp({ discord: { member: memberOk({ id: '1001' }) } }).app;
      const a1 = await login(ada);
      const a2 = await login(ada);
      const bob = makeApp({ discord: { member: memberOk({ id: '2002', global_name: 'Bob' }) } }).app;
      const b1 = await login(bob);
      expect(await counts()).toEqual({ users: 2, sessions: 3 });

      const { app } = makeApp({ discord: { member: memberOk({ id: '1001', roles: ['other'] }) } });
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      expect(res.headers.get('location')).toBe('/?auth=not-invited');
      expect(cookieNamed(res, SESSION)).toBeUndefined();

      expect(await counts()).toEqual({ users: 2, sessions: 1 });
      expect((await me(app, a1)).status).toBe(401);
      expect((await me(app, a2)).status).toBe(401);
      expect((await me(app, b1)).status).toBe(200);
    });

    it('when the not-invited login is a Discord id that never logged in, then nothing changes (no user is created, other sessions survive)', async () => {
      const ada = makeApp({ discord: { member: memberOk({ id: '1001' }) } }).app;
      const a1 = await login(ada);
      const { app } = makeApp({ discord: { member: memberOk({ id: '3003', roles: ['other'] }) } });
      const { state, verifier } = await startLogin(app);
      const res = await callback(app, { code: 'code-1', state }, `${state}.${verifier}`);
      expect(res.headers.get('location')).toBe('/?auth=not-invited');
      expect(await counts()).toEqual({ users: 1, sessions: 1 });
      expect((await me(app, a1)).status).toBe(200);
    });
  });
});
