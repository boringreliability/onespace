/**
 * The client's API layer (v4 sub-plan 4, Task 5; R26). Thin: one call per
 * server route, no interpretation of 404/409 — the caller reads them.
 *
 *   GET  /api/me              200 {id, name} | 401
 *   GET  /api/save            200 {revision, save} | 404 {error:'no-save'}
 *   PUT  /api/save            200 {revision} | 409 {cloud:{revision, save}} | 400 | 413 | 429
 *   POST /api/save/resolve    200 {revision, save} | 409 {cloud:{revision, save}}
 *   POST /api/auth/logout     204
 *   DELETE /api/account       204
 *
 * ok = a 2xx status. A non-2xx result carries the parsed JSON body (or null)
 * and, for a 429, Retry-After in seconds. Every call is same-origin; every
 * non-GET sends Content-Type application/json. A call gets `timeoutMs`
 * (SYNC_TIMEOUT_MS) for the whole exchange — headers AND body — then it is
 * aborted and answers 'timeout'; a fetch that rejects answers 'offline'.
 * Never throws. Bodies are returned as `unknown`: callers validate them.
 */

import type { SaveV1 } from '@/save/schema';

import type { CloudHead } from './syncState';

export const SYNC_TIMEOUT_MS = 3_000;

export type ApiResult<T = unknown> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number | 'offline' | 'timeout'; body?: unknown; retryAfterS?: number | null };

export interface PutBody {
  deviceId: string;
  base: CloudHead | null;
  save: SaveV1;
}

export interface ResolveBody {
  deviceId: string;
  keep: 'device' | 'cloud';
  device: SaveV1;
  base: CloudHead | null;
  cloud: CloudHead | null;
}

export interface Api {
  me(): Promise<ApiResult>;
  getSave(): Promise<ApiResult>;
  putSave(b: PutBody): Promise<ApiResult>;
  resolve(b: ResolveBody): Promise<ApiResult>;
  logout(): Promise<ApiResult>;
  deleteAccount(): Promise<ApiResult>;
}

export interface ApiDeps {
  readonly fetch: typeof fetch;
  /** The budget of one call; default SYNC_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

const BASE = '/api';

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function retryAfter(res: Response): number | null {
  const h = res.headers.get('Retry-After');
  if (h === null) return null;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function createApi(deps: ApiDeps): Api {
  const timeoutMs = deps.timeoutMs ?? SYNC_TIMEOUT_MS;

  async function call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const ctrl = new AbortController();
    const timedOut: ApiResult = { ok: false, status: 'timeout' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ApiResult>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve(timedOut);
      }, timeoutMs);
    });

    const exchange = (async (): Promise<ApiResult> => {
      const init: RequestInit = { method, credentials: 'same-origin', signal: ctrl.signal };
      if (method !== 'GET') {
        init.headers = { 'Content-Type': 'application/json' };
        if (body !== undefined) init.body = JSON.stringify(body);
      }
      let res: Response;
      try {
        res = await deps.fetch(`${BASE}${path}`, init);
      } catch {
        return ctrl.signal.aborted ? timedOut : { ok: false, status: 'offline' };
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        return ctrl.signal.aborted ? timedOut : { ok: false, status: 'offline' };
      }
      const parsed = parseJson(text);
      if (res.ok) return { ok: true, status: res.status, body: parsed };
      return { ok: false, status: res.status, body: parsed, retryAfterS: retryAfter(res) };
    })();

    try {
      return await Promise.race([exchange, deadline]);
    } catch {
      return { ok: false, status: 'offline' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    me: () => call('GET', '/me'),
    getSave: () => call('GET', '/save'),
    putSave: (b) => call('PUT', '/save', { deviceId: b.deviceId, base: b.base, save: b.save }),
    resolve: (b) =>
      call('POST', '/save/resolve', { deviceId: b.deviceId, keep: b.keep, device: b.device, base: b.base, cloud: b.cloud }),
    logout: () => call('POST', '/auth/logout'),
    deleteAccount: () => call('DELETE', '/account'),
  };
}
