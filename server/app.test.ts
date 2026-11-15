/**
 * The HTTP app (v4 sub-plan 4, Task 1): health, static serving, and the
 * guards every /api request passes through before routing — origin check,
 * body limit, security headers.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const config: Config = {
  databaseUrl: 'postgres://unused',
  publicOrigin: ORIGIN,
  discord: { clientId: 'fake-client', clientSecret: 'fake-secret', guildId: 'fake-guild', roleId: 'fake-role' },
  port: 8787,
  production: false,
  testLogin: false,
};

let t: TestSchema;
let staticRoot: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await withTestSchema();
  staticRoot = mkdtempSync(join(tmpdir(), 'onespace-static-'));
  writeFileSync(join(staticRoot, 'index.html'), INDEX_HTML);
  app = createApp({ config, sql: t.sql, staticRoot });
});
afterAll(async () => {
  await t.drop();
  rmSync(staticRoot, { recursive: true, force: true });
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
