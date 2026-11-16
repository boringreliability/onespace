import { Hono, type Context } from 'hono';
import type { Sql } from 'postgres';
import * as z from 'zod';

import { migrate } from '../../src/save/migrate';
import type { SaveV1 } from '../../src/save/schema';
import { clearSessionCookie, requireUser, type AuthVariables } from '../auth/session';
import { rateLimiter } from '../rateLimit';
import { deleteAccount, getHead, putSave, resolveSave, RevisionOverflowError, UserGoneError } from './repo';

export const WRITE_LIMIT = 30;
export const WRITE_WINDOW_MS = 60_000;
const INT4_MAX = 2_147_483_647;

const Base = z.object({ saveId: z.uuid(), revision: z.number().int().min(0).max(INT4_MAX) }).nullable();
const PutBody = z
  .object({ deviceId: z.uuid(), base: Base, save: z.unknown() })
  .refine((b) => b.save !== undefined);
const ResolveBody = z
  .object({ deviceId: z.uuid(), keep: z.enum(['device', 'cloud']), device: z.unknown(), base: Base, cloud: Base })
  .refine((b) => b.device !== undefined);

/** A string Postgres jsonb cannot store: U+0000, or a lone surrogate (not well-formed UTF-16). */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Walks every string value and object key. */
function hasUnstorable(v: unknown): boolean {
  if (typeof v === 'string') return UNSTORABLE.test(v);
  if (Array.isArray(v)) return v.some(hasUnstorable);
  if (v && typeof v === 'object') {
    return Object.entries(v).some(([k, x]) => UNSTORABLE.test(k) || hasUnstorable(x));
  }
  return false;
}

/** `migrate`, then the range checks the Postgres int columns need (R25). */
function validateSave(raw: unknown): SaveV1 | null {
  const r = migrate(raw);
  if (!r.ok) return null;
  const s = r.save;
  if (s.revision > INT4_MAX || hasUnstorable(s)) return null;
  for (const a of s.actions) if (!Number.isInteger(a.seq) || a.seq < 0 || a.seq > INT4_MAX) return null;
  return s;
}

type Env = { Variables: AuthVariables };

export function saveRoutes(deps: { sql: Sql; now: () => number }): Hono<Env> {
  const { sql, now } = deps;
  const app = new Hono<Env>();
  const auth = requireUser(sql, now);
  // One shared per-account budget for PUT, resolve and DELETE (after requireUser).
  const writes = rateLimiter({
    limit: WRITE_LIMIT,
    windowMs: WRITE_WINDOW_MS,
    key: (c) => `save-write:${c.get('user').id}`,
    now,
  });

  const guard = async (c: Context<Env>, run: () => Promise<Response>): Promise<Response> => {
    try {
      return await run();
    } catch (err) {
      // resolveSameGame parses its output with Zod: bad input is a client error, not a 500.
      if (err instanceof z.ZodError || err instanceof RevisionOverflowError) return c.json({ error: 'invalid-save' }, 400);
      // The account was deleted while this write waited for its lock.
      if (err instanceof UserGoneError) return c.json({ error: 'unauthenticated' }, 401);
      console.error('save route failed:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'internal' }, 500);
    }
  };

  const readJson = (c: Context<Env>): Promise<unknown> => c.req.json().catch(() => undefined);

  app.get('/save', auth, (c) =>
    guard(c, async () => {
      const head = await getHead(sql, c.get('user').id);
      if (!head) return c.json({ error: 'no-save' }, 404);
      return c.json({ revision: head.revision, save: head.save });
    }),
  );

  app.put('/save', auth, writes, (c) =>
    guard(c, async () => {
      const body = PutBody.safeParse(await readJson(c));
      if (!body.success) return c.json({ error: 'invalid-body' }, 400);
      const save = validateSave(body.data.save);
      if (!save) return c.json({ error: 'invalid-save' }, 400);
      const r = await putSave(sql, c.get('user').id, { deviceId: body.data.deviceId, base: body.data.base, save });
      if (r.kind === 'conflict') return c.json({ cloud: r.cloud }, 409);
      return c.json({ revision: r.revision });
    }),
  );

  app.post('/save/resolve', auth, writes, (c) =>
    guard(c, async () => {
      const body = ResolveBody.safeParse(await readJson(c));
      if (!body.success) return c.json({ error: 'invalid-body' }, 400);
      const device = validateSave(body.data.device);
      if (!device) return c.json({ error: 'invalid-save' }, 400);
      const { deviceId, keep, base, cloud } = body.data;
      const r = await resolveSave(sql, c.get('user').id, { deviceId, keep, device, base, cloud });
      if (r.kind === 'conflict') return c.json({ cloud: r.cloud }, 409);
      return c.json({ revision: r.revision, save: r.save });
    }),
  );

  app.delete('/account', auth, writes, (c) =>
    guard(c, async () => {
      await deleteAccount(sql, c.get('user').id);
      clearSessionCookie(c);
      return c.body(null, 204);
    }),
  );

  return app;
}
