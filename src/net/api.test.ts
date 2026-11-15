/**
 * v4 sub-plan 4, Task 5 (phase A) — the client's API layer (R26).
 *
 * Pinned surface (src/net/api.ts):
 *
 *   SYNC_TIMEOUT_MS === 3_000
 *   type ApiResult<T = unknown> =
 *     | { ok: true; status: number; body: T }
 *     | { ok: false; status: number | 'offline' | 'timeout';
 *         body?: unknown;            // the parsed JSON of a non-2xx reply (null if none)
 *         retryAfterS?: number | null }  // a 429's Retry-After, in seconds
 *   interface PutBody     { deviceId: string; base: CloudHead | null; save: SaveV1 }
 *   interface ResolveBody { deviceId: string; keep: 'device' | 'cloud'; device: SaveV1;
 *                           base: CloudHead | null; cloud: CloudHead | null }
 *   interface Api { me(); getSave(); putSave(b: PutBody); resolve(b: ResolveBody);
 *                   logout(); deleteAccount(); }      // each → Promise<ApiResult>
 *   createApi(deps: { fetch: typeof fetch; timeoutMs?: number }): Api   // timeoutMs default SYNC_TIMEOUT_MS
 *
 * The server contract (server/save/routes.ts, server/auth/routes.ts):
 *   GET  /api/me              200 {id, name} | 401 {error:'unauthenticated'}
 *   GET  /api/save            200 {revision, save} | 404 {error:'no-save'}
 *   PUT  /api/save            200 {revision} | 409 {cloud:{revision, save}} | 400 | 429 (Retry-After)
 *   POST /api/save/resolve    200 {revision, save} | 409 {cloud:{revision, save}}
 *   POST /api/auth/logout     204
 *   DELETE /api/account       204
 * ok = a 2xx status. The api is thin: it does not interpret 404/409 — the
 * caller does (getSave 404 {error:'no-save'} = an empty cloud).
 * Every call: credentials 'same-origin'; every non-GET: Content-Type
 * application/json. A per-call timeout aborts the request (AbortController)
 * and gives 'timeout'; a rejected fetch gives 'offline'. Never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_ID, GAME_X, save } from './__fixtures__/sync';
import { SYNC_TIMEOUT_MS, createApi } from './api';

interface Call {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A fetch that records calls and answers with `reply`. */
function fakeFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return reply(url, init ?? {});
  }) as typeof fetch;
  return { fetch: f, calls };
}

const header = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('api — constants', () => {
  it('Given the module, Then SYNC_TIMEOUT_MS is 3 000', () => {
    expect(SYNC_TIMEOUT_MS).toBe(3_000);
  });
});

describe('api — me()', () => {
  it("Given a signed-in session, When me(), Then GET /api/me with credentials 'same-origin' and {ok: true, status: 200, body: {id, name}}", async () => {
    const f = fakeFetch(() => json(200, { id: 'u1', name: 'Ava' }));
    const r = await createApi({ fetch: f.fetch }).me();
    expect(r).toEqual({ ok: true, status: 200, body: { id: 'u1', name: 'Ava' } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('/api/me');
    expect(f.calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(f.calls[0]!.init.credentials).toBe('same-origin');
  });

  it('Given no session, When me(), Then {ok: false, status: 401}', async () => {
    const f = fakeFetch(() => json(401, { error: 'unauthenticated' }));
    const r = await createApi({ fetch: f.fetch }).me();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});

describe('api — getSave()', () => {
  it('Given a cloud save, When getSave(), Then GET /api/save and the body {revision, save}', async () => {
    const s = save({ revision: 9 });
    const f = fakeFetch(() => json(200, { revision: 9, save: s }));
    const r = await createApi({ fetch: f.fetch }).getSave();
    expect(f.calls[0]!.url).toBe('/api/save');
    expect(f.calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(f.calls[0]!.init.credentials).toBe('same-origin');
    expect(r).toEqual({ ok: true, status: 200, body: { revision: 9, save: s } });
  });

  it("Given an empty cloud, When getSave(), Then {ok: false, status: 404} with the body {error: 'no-save'} for the caller to read", async () => {
    const f = fakeFetch(() => json(404, { error: 'no-save' }));
    const r = await createApi({ fetch: f.fetch }).getSave();
    expect(r).toMatchObject({ ok: false, status: 404, body: { error: 'no-save' } });
  });

  it('Given a server error, When getSave(), Then {ok: false, status: 503}', async () => {
    const f = fakeFetch(() => json(503, { error: 'internal' }));
    expect(await createApi({ fetch: f.fetch }).getSave()).toMatchObject({ ok: false, status: 503 });
  });
});

describe('api — putSave() and resolve()', () => {
  it('Given a save, When putSave({deviceId, base, save}), Then PUT /api/save with a JSON body of exactly those fields, Content-Type application/json, same-origin', async () => {
    const s = save({ revision: 8 });
    const f = fakeFetch(() => json(200, { revision: 8 }));
    const r = await createApi({ fetch: f.fetch }).putSave({ deviceId: DEVICE_ID, base: { saveId: GAME_X, revision: 7 }, save: s });
    const c = f.calls[0]!;
    expect(c.url).toBe('/api/save');
    expect(c.init.method).toBe('PUT');
    expect(c.init.credentials).toBe('same-origin');
    expect(header(c.init, 'Content-Type')).toMatch(/^application\/json/);
    expect(JSON.parse(c.init.body as string)).toEqual({ deviceId: DEVICE_ID, base: { saveId: GAME_X, revision: 7 }, save: s });
    expect(r).toEqual({ ok: true, status: 200, body: { revision: 8 } });
  });

  it('Given base null (a first push), When putSave, Then the body carries base: null (not omitted)', async () => {
    const f = fakeFetch(() => json(200, { revision: 7 }));
    await createApi({ fetch: f.fetch }).putSave({ deviceId: DEVICE_ID, base: null, save: save() });
    expect(JSON.parse(f.calls[0]!.init.body as string)).toHaveProperty('base', null);
  });

  it('Given the cloud moved, When putSave, Then {ok: false, status: 409} with the body {cloud: {revision, save}}', async () => {
    const cloud = save({ revision: 9 });
    const f = fakeFetch(() => json(409, { cloud: { revision: 9, save: cloud } }));
    const r = await createApi({ fetch: f.fetch }).putSave({ deviceId: DEVICE_ID, base: null, save: save() });
    expect(r).toMatchObject({ ok: false, status: 409, body: { cloud: { revision: 9, save: cloud } } });
  });

  it('Given the rate limit, When putSave gets 429 with Retry-After: 42, Then {ok: false, status: 429, retryAfterS: 42}', async () => {
    const f = fakeFetch(() => json(429, { error: 'rate_limited' }, { 'Retry-After': '42' }));
    const r = await createApi({ fetch: f.fetch }).putSave({ deviceId: DEVICE_ID, base: null, save: save() });
    expect(r).toMatchObject({ ok: false, status: 429, retryAfterS: 42 });
  });

  it('Given a resolve, When resolve({deviceId, keep, device, base, cloud}), Then POST /api/save/resolve with exactly those fields as JSON', async () => {
    const device = save({ revision: 9 });
    const result = save({ revision: 10 });
    const f = fakeFetch(() => json(200, { revision: 10, save: result }));
    const body = {
      deviceId: DEVICE_ID,
      keep: 'device' as const,
      device,
      base: { saveId: GAME_X, revision: 7 },
      cloud: { saveId: GAME_X, revision: 8 },
    };
    const r = await createApi({ fetch: f.fetch }).resolve(body);
    const c = f.calls[0]!;
    expect(c.url).toBe('/api/save/resolve');
    expect(c.init.method).toBe('POST');
    expect(c.init.credentials).toBe('same-origin');
    expect(header(c.init, 'Content-Type')).toMatch(/^application\/json/);
    expect(JSON.parse(c.init.body as string)).toEqual(body);
    expect(r).toEqual({ ok: true, status: 200, body: { revision: 10, save: result } });
  });

  it('Given a resolve with cloud: null (the client saw an empty cloud), Then the body carries cloud: null', async () => {
    const f = fakeFetch(() => json(200, { revision: 7, save: save() }));
    await createApi({ fetch: f.fetch }).resolve({ deviceId: DEVICE_ID, keep: 'device', device: save(), base: null, cloud: null });
    expect(JSON.parse(f.calls[0]!.init.body as string)).toHaveProperty('cloud', null);
  });
});

describe('api — logout() and deleteAccount()', () => {
  it('Given a session, When logout(), Then POST /api/auth/logout, Content-Type application/json, same-origin, and 204 is ok with body null', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const r = await createApi({ fetch: f.fetch }).logout();
    const c = f.calls[0]!;
    expect(c.url).toBe('/api/auth/logout');
    expect(c.init.method).toBe('POST');
    expect(c.init.credentials).toBe('same-origin');
    expect(header(c.init, 'Content-Type')).toMatch(/^application\/json/);
    expect(r).toEqual({ ok: true, status: 204, body: null });
  });

  it('Given a session, When deleteAccount(), Then DELETE /api/account, Content-Type application/json, same-origin, and 204 is ok', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    const r = await createApi({ fetch: f.fetch }).deleteAccount();
    const c = f.calls[0]!;
    expect(c.url).toBe('/api/account');
    expect(c.init.method).toBe('DELETE');
    expect(c.init.credentials).toBe('same-origin');
    expect(header(c.init, 'Content-Type')).toMatch(/^application\/json/);
    expect(r).toEqual({ ok: true, status: 204, body: null });
  });
});

describe('api — offline, timeout and odd replies (never throws)', () => {
  it("Given fetch rejects (no network), When any call, Then {ok: false, status: 'offline'}", async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const api = createApi({ fetch: f.fetch });
    for (const r of [await api.me(), await api.getSave(), await api.putSave({ deviceId: DEVICE_ID, base: null, save: save() }), await api.logout()]) {
      expect(r).toEqual({ ok: false, status: 'offline' });
    }
  });

  it("Given fetch never answers, When getSave(), Then {ok: false, status: 'timeout'} at SYNC_TIMEOUT_MS — not before — and the request's signal is aborted", async () => {
    let signal: AbortSignal | undefined;
    const f = fakeFetch((_u, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
    });
    let r: unknown = null;
    void createApi({ fetch: f.fetch })
      .getSave()
      .then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(r).toBeNull();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r).toEqual({ ok: false, status: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it("Given an injected timeoutMs of 500 and a fetch that ignores the abort, When me(), Then 'timeout' at 500 ms", async () => {
    const f = fakeFetch(() => new Promise<Response>(() => undefined));
    let r: unknown = null;
    void createApi({ fetch: f.fetch, timeoutMs: 500 })
      .me()
      .then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(499);
    expect(r).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(r).toEqual({ ok: false, status: 'timeout' });
  });

  it("Given headers arrive but the body never finishes, When getSave(), Then 'timeout' at SYNC_TIMEOUT_MS (the budget covers the body)", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"revision":9,'));
      },
    });
    const f = fakeFetch(() => new Response(stalled, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    let r: unknown = null;
    void createApi({ fetch: f.fetch })
      .getSave()
      .then((x) => (r = x));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(r).toEqual({ ok: false, status: 'timeout' });
  });

  it('Given an answer in time, When the call returns, Then no timer is left pending', async () => {
    const f = fakeFetch(() => json(200, { id: 'u1', name: 'Ava' }));
    await createApi({ fetch: f.fetch }).me();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given a 200 whose body is not JSON, When getSave(), Then it does not throw: ok with body null', async () => {
    const f = fakeFetch(() => new Response('<html>proxy</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(await createApi({ fetch: f.fetch }).getSave()).toEqual({ ok: true, status: 200, body: null });
  });

  it('Given a 502 whose body is not JSON, When putSave, Then {ok: false, status: 502}', async () => {
    const f = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    expect(await createApi({ fetch: f.fetch }).putSave({ deviceId: DEVICE_ID, base: null, save: save() })).toMatchObject({
      ok: false,
      status: 502,
    });
  });
});
