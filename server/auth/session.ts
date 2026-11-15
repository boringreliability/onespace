import { createHash, randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Sql } from 'postgres';

export const SESSION_COOKIE = '__Host-onespace_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = { id: string; name: string };
export type AuthVariables = { user: SessionUser };

const hash = (token: string) => createHash('sha256').update(token).digest();

/** Creates a session and returns the raw token; only its sha256 is stored. */
export async function createSession(sql: Sql, userId: string, now: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hash(token)}, ${userId}, ${new Date(now + SESSION_TTL_MS)})`;
  return token;
}

export async function sessionUser(sql: Sql, token: string, now: number): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await sql<SessionUser[]>`
    select u.id, u.name from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${hash(token)} and s.expires_at > ${new Date(now)}`;
  return rows[0] ?? null;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`delete from sessions where token_hash = ${hash(token)}`;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 0 });
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function requireUser(sql: Sql, now: () => number = Date.now): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = sessionToken(c);
    const user = token ? await sessionUser(sql, token, now()) : null;
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    c.set('user', user);
    await next();
  };
}
