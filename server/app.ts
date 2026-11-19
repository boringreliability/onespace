import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Sql } from 'postgres';

import { authRoutes } from './auth/routes';
import type { Config } from './config';
import { saveRoutes } from './save/routes';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const HSTS = 'max-age=31536000; includeSubDomains';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

// Anchored to this module, not cwd: dist-server/index.mjs -> ../dist (and server/app.ts -> ../dist).
const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('../dist', import.meta.url));

export type AppDeps = {
  config: Config;
  sql: Sql;
  now?: () => number;
  fetch?: typeof fetch;
  staticRoot?: string;
  /** Client IP for rate limiting. Default: the right-most x-forwarded-for hop in production, else the socket address. */
  clientIp?: (c: Context) => string;
};

export function createApp(deps: AppDeps): Hono {
  const { config, sql } = deps;
  const root = resolve(deps.staticRoot ?? DEFAULT_STATIC_ROOT);
  const app = new Hono();

  // Security headers on every response, including errors and early rejections.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'same-origin');
    c.res.headers.set('Content-Security-Policy', CSP);
    // Production only: local development runs on plain http.
    if (config.production) c.res.headers.set('Strict-Transport-Security', HSTS);
  });

  // CSRF: every non-safe method must come from our own origin.
  app.use('/api/*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && c.req.header('Origin') !== config.publicOrigin) {
      return c.json({ error: 'forbidden_origin' }, 403);
    }
    await next();
  });

  app.use(
    '/api/*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
  );

  app.get('/api/health', async (c) => {
    try {
      await sql`select 1`;
      return c.json({ ok: true });
    } catch (err) {
      console.error('health check failed:', err);
      return c.json({ ok: false }, 503);
    }
  });

  app.route(
    '/api',
    authRoutes({ config, sql, now: deps.now ?? Date.now, fetch: deps.fetch ?? fetch, clientIp: deps.clientIp }),
  );

  app.route('/api', saveRoutes({ sql, now: deps.now ?? Date.now }));

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  app.get('*', async (c) => {
    let rel = '/';
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      /* malformed escape: serve index.html */
    }
    const file = resolve(join(root, rel));
    if (file.startsWith(root + sep)) {
      try {
        const body = await readFile(file);
        return c.body(body, 200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      } catch {
        /* fall through to index.html */
      }
    }
    try {
      return c.html((await readFile(join(root, 'index.html'))).toString('utf8'));
    } catch {
      return c.text('Not found', 404);
    }
  });

  return app;
}
