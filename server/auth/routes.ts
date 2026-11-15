import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Sql } from 'postgres';

import type { Config } from '../config';
import { rateLimiter } from '../rateLimit';
import { checkMembership, DISCORD_AUTHORIZE_URL, DISCORD_SCOPE, exchangeCode } from './discord';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  requireUser,
  sessionToken,
  setSessionCookie,
  type AuthVariables,
} from './session';

export const OAUTH_COOKIE = '__Host-onespace_oauth';
const OAUTH_TTL_S = 600;
const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 60_000;

export type AuthDeps = {
  config: Config;
  sql: Sql;
  now: () => number;
  fetch: typeof fetch;
  clientIp?: (c: Context) => string;
};

/** Production sits behind Railway's proxy: first x-forwarded-for hop. Otherwise the socket address. */
export function defaultClientIp(config: Config): (c: Context) => string {
  return (c) => {
    if (config.production) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

const oauthCookieOpts = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

export function authRoutes(deps: AuthDeps): Hono<{ Variables: AuthVariables }> {
  const { config, sql, now } = deps;
  const clientIp = deps.clientIp ?? defaultClientIp(config);
  const redirectUri = `${config.publicOrigin}/api/auth/discord/callback`;
  const app = new Hono<{ Variables: AuthVariables }>();

  // One shared budget per client IP across all three login routes.
  const limit = rateLimiter({ limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS, key: clientIp, now });
  app.use('/auth/discord', limit);
  app.use('/auth/discord/callback', limit);
  app.use('/test/login', limit);

  const upsertUser = async (discordId: string, name: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      insert into users (discord_id, name) values (${discordId}, ${name})
      on conflict (discord_id) do update set name = excluded.name
      returning id`;
    return row!.id;
  };

  app.get('/auth/discord', (c) => {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    setCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, { ...oauthCookieOpts, maxAge: OAUTH_TTL_S });
    const url = new URL(DISCORD_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.discord.clientId,
      redirect_uri: redirectUri,
      scope: DISCORD_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return c.redirect(url.toString(), 302);
  });

  app.get('/auth/discord/callback', async (c) => {
    const raw = getCookie(c, OAUTH_COOKIE);
    // Single-use: cleared on every outcome.
    setCookie(c, OAUTH_COOKIE, '', { ...oauthCookieOpts, maxAge: 0 });
    const fail = () => c.redirect('/?auth=error', 302);

    const parts = raw?.split('.') ?? [];
    const [cookieState, verifier] = parts;
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (parts.length !== 2 || !cookieState || !verifier || !state || !code || c.req.query('error')) return fail();
    const a = Buffer.from(cookieState);
    const b = Buffer.from(state);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return fail();

    let member;
    try {
      const accessToken = await exchangeCode(deps.fetch, {
        clientId: config.discord.clientId,
        clientSecret: config.discord.clientSecret,
        code,
        redirectUri,
        verifier,
      });
      member = await checkMembership(deps.fetch, accessToken, config.discord.guildId, config.discord.roleId);
    } catch {
      return fail();
    }
    if (!member.ok) return c.redirect('/?auth=not-invited', 302);

    try {
      const userId = await upsertUser(member.id, member.name);
      setSessionCookie(c, await createSession(sql, userId, now()));
    } catch (err) {
      console.error('login failed after Discord check:', err instanceof Error ? err.message : err);
      return fail();
    }
    return c.redirect('/?auth=ok', 302);
  });

  app.get('/me', requireUser(sql, now), (c) => c.json(c.var.user));

  app.post('/auth/logout', async (c) => {
    const token = sessionToken(c);
    if (token) await deleteSession(sql, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  if (config.testLogin) {
    app.post('/test/login', async (c) => {
      const body = await c.req.json().catch(() => null);
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== 'string' || name.length < 1 || name.length > 64) return c.json({ error: 'bad_request' }, 400);
      const id = await upsertUser(`test:${name}`, name);
      setSessionCookie(c, await createSession(sql, id, now()));
      return c.json({ id, name });
    });
  }

  return app;
}
