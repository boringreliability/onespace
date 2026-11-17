/**
 * The HTTP app (v4 sub-plan 4, Task 1): health, static serving, and the
 * guards every /api request passes through before routing — origin check,
 * body limit, security headers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, MAX_BODY_BYTES } from './app';
import type { Config } from './config';
import { withTestSchema, type TestSchema } from './test/db';

const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const ORIGIN = 'https://onespace.example';
const INDEX_HTML = '<!doctype html><title>oneSpace</title><div id="app"></div>';

const SECRET = 'TOP-SECRET-OUTSIDE-STATIC-ROOT';

// What the game ships today is html/js/map (dist/); the rest covers assets it may add.
const MIME_CASES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

const config: Config = {
  databaseUrl: 'postgres://unused',
  publicOrigin: ORIGIN,
  discord: { clientId: 'fake-client', clientSecret: 'fake-secret', guildId: 'fake-guild', roleId: 'fake-role' },
  port: 8787,
  production: false,
  testLogin: false,
};

let t: TestSchema;
let base: string;
let staticRoot: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await withTestSchema();
  base = mkdtempSync(join(tmpdir(), 'onespace-static-'));
  staticRoot = join(base, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), INDEX_HTML);
  writeFileSync(join(staticRoot, 'assets', 'a.js'), 'export const a = 1;');
  for (const ext of Object.keys(MIME_CASES)) writeFileSync(join(staticRoot, 'assets', `f${ext}`), 'x');
  // Lives next to, not inside, the static root: must never be served.
  writeFileSync(join(base, 'secret.txt'), SECRET);
  app = createApp({ config, sql: t.sql, staticRoot });
});
afterAll(async () => {
  await t.drop();
  rmSync(base, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  describe('given a live database', () => {
    it('when requested, then it answers 200 { ok: true }', async () => {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('given a closed sql client', () => {
    it('when requested, then it answers 503', async () => {
      const closed = await withTestSchema();
      await closed.sql.end({ timeout: 1 });
      try {
        const res = await createApp({ config, sql: closed.sql, staticRoot }).request('/api/health');
        expect(res.status).toBe(503);
      } finally {
        await closed.drop();
      }
    });
  });
});

describe('static serving', () => {
  describe('given a staticRoot with an index.html', () => {
    it('when GET /, then it serves index.html', async () => {
      const res = await app.request('/');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    });

    it('when GET an unknown non-api path, then it falls back to index.html', async () => {
      const res = await app.request('/some/client/route');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    });

    it('when GET an unknown /api path, then it is a 404 JSON, not index.html', async () => {
      const res = await app.request('/api/nope');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).not.toContain('<!doctype');
    });
  });
});

describe('guards on /api', () => {
  describe('given a write from a foreign origin', () => {
    it('when POST with Origin https://evil.example, then it is 403', async () => {
      const res = await app.request('/api/anything', { method: 'POST', headers: { Origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
    });
  });

  describe('given a write from our own origin', () => {
    it('when POST with Origin = PUBLIC_ORIGIN, then it passes the origin check (no route: 404, not 403)', async () => {
      const res = await app.request('/api/anything', { method: 'POST', headers: { Origin: ORIGIN }, body: '{}' });
      expect(res.status).toBe(404);
    });
  });

  describe('given an oversized body', () => {
    it('when POST a body over MAX_BODY_BYTES, then it is 413', async () => {
      const res = await app.request('/api/anything', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      });
      expect(res.status).toBe(413);
    });
  });
});

describe('security headers', () => {
  const paths: [string, RequestInit?][] = [
    ['/api/health'],
    ['/'],
    ['/api/nope'],
    ['/api/anything', { method: 'POST', headers: { Origin: 'https://evil.example' } }],
  ];

  for (const [path, init] of paths) {
    describe(`given ${init?.method ?? 'GET'} ${path}`, () => {
      it('when answered, then nosniff, same-origin referrer, the exact CSP, and no CORS header are present', async () => {
        const res = await app.request(path, init);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
        expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      });
    });
  }
});

describe('guards on /api: more cases', () => {
  describe('given an oversized declared Content-Length', () => {
    it('when POST declares Content-Length over MAX_BODY_BYTES, then it is 413', async () => {
      const res = await app.request('/api/anything', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': String(MAX_BODY_BYTES + 1) },
        body: '{}',
      });
      expect(res.status).toBe(413);
    });
  });

  describe('given other write methods or a missing/opaque origin', () => {
    it.each(['PUT', 'DELETE', 'PATCH'])('when %s with Origin https://evil.example, then it is 403', async (method) => {
      const res = await app.request('/api/anything', { method, headers: { Origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
    });

    it('when POST has no Origin header, then it is 403', async () => {
      const res = await app.request('/api/anything', { method: 'POST', body: '{}' });
      expect(res.status).toBe(403);
    });

    it('when POST has Origin: null, then it is 403', async () => {
      const res = await app.request('/api/anything', { method: 'POST', headers: { Origin: 'null' }, body: '{}' });
      expect(res.status).toBe(403);
    });
  });
});

describe('static serving: path traversal', () => {
  describe('given a secret file just outside staticRoot', () => {
    it.each(['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/%00', '/assets/..%2f..%2fsecret.txt'])(
      'when GET %s, then nothing from outside staticRoot is served',
      async (path) => {
        const res = await app.request(path);
        const text = await res.text();
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('"scripts"');
      },
    );
  });
});

describe('static serving: assets and MIME', () => {
  it('when GET /assets/a.js, then it is 200 with the file and a JavaScript type', async () => {
    const res = await app.request('/assets/a.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('export const a = 1;');
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it.each(Object.entries(MIME_CASES))('when GET a %s file, then Content-Type starts with %s', async (ext, mime) => {
    const res = await app.request(`/assets/f${ext}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(new RegExp(`^${mime.replace('+', '\\+')}`));
  });
});

describe('security headers on non-trivial responses', () => {
  const expectHeaders = (res: Response) => {
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  };

  it('when the body limit answers 413, then the headers are present', async () => {
    const res = await app.request('/api/anything', {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expectHeaders(res);
  });

  it('when health answers 503, then the headers are present', async () => {
    const closed = await withTestSchema();
    await closed.sql.end({ timeout: 1 });
    try {
      const res = await createApp({ config, sql: closed.sql, staticRoot }).request('/api/health');
      expect(res.status).toBe(503);
      expectHeaders(res);
    } finally {
      await closed.drop();
    }
  });

  it('when a static asset answers 200, then the headers are present', async () => {
    const res = await app.request('/assets/a.js');
    expect(res.status).toBe(200);
    expectHeaders(res);
  });
});

// Final fix round — Ruling R72: HSTS in production only (local development runs on http).
describe('Strict-Transport-Security (R72)', () => {
  const HSTS = 'max-age=31536000; includeSubDomains';
  const prodApp = () => createApp({ config: { ...config, production: true }, sql: t.sql, staticRoot });

  describe('given production', () => {
    const cases: [string, RequestInit?][] = [
      ['/api/health'],
      ['/'],
      ['/assets/a.js'],
      ['/api/nope'],
      ['/api/anything', { method: 'POST', headers: { Origin: 'https://evil.example' } }],
    ];
    it.each(cases)('when %s is answered, then Strict-Transport-Security is exactly "max-age=31536000; includeSubDomains"', async (path, init) => {
      const res = await prodApp().request(path, init);
      expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
    });
  });

  describe('given production is false', () => {
    it.each(['/api/health', '/'])('when %s is answered, then there is no Strict-Transport-Security header', async (path) => {
      const res = await app.request(path);
      expect(res.headers.get('Strict-Transport-Security')).toBeNull();
    });
  });
});
