/**
 * Shutdown drain (v4 sub-plan 4, final fix round — Ruling R72).
 *
 * A deploy sends SIGTERM. Exiting at once drops the answer to a PUT the
 * server has already committed (final review I1). The drain: stop accepting,
 * wait for in-flight requests, a hard timer of 10 s, then close the pool and
 * exit.
 *
 * Assumed surface (server/shutdown.ts — phase B creates it):
 *
 *   SHUTDOWN_GRACE_MS === 10_000
 *   shutdown(d: {
 *     server: { close(cb?: (err?: Error) => void): unknown; closeAllConnections?(): void };
 *     sql: { end(opts?: { timeout?: number }): Promise<unknown> };
 *     exit: (code: number) => void;
 *     graceMs?: number;                 // default SHUTDOWN_GRACE_MS
 *   }): Promise<void>
 *     // server.close() at once (no new connections); when every in-flight
 *     // request has answered: sql.end(), then exit(0). If that has not
 *     // happened after graceMs: give up waiting — sql.end(), then exit.
 *     // exit is called exactly once.
 *
 *   server/index.ts calls shutdown(…) from its SIGTERM/SIGINT handler.
 */

import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHUTDOWN_GRACE_MS, shutdown } from './shutdown';

afterEach(() => {
  vi.useRealTimers();
});

/** A GET without keep-alive (agent: false): the connection closes with the response. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const fakeSql = () => ({ end: vi.fn(async (_o?: { timeout?: number }) => undefined) });

describe('shutdown — the constant', () => {
  it('Ruling R72: Given the module, Then the hard timer is 10 s', () => {
    expect(SHUTDOWN_GRACE_MS).toBe(10_000);
  });
});

describe('shutdown — waits for an in-flight request (a real HTTP server)', () => {
  it('Ruling R72: Given a request in flight when shutdown starts, Then new connections are refused, the pool is not closed and the process does not exit until that request has answered; then sql.end() and exit(0), in that order', async () => {
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = new Hono();
    app.get('/slow', async (c) => {
      entered();
      await gate;
      return c.text('committed');
    });
    app.get('/fast', (c) => c.text('fast'));

    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s as Server));
    });
    const port = (server.address() as AddressInfo).port;
    const sql = fakeSql();
    const exit = vi.fn((_code: number) => undefined);

    try {
      const slow = get(port, '/slow');
      await inside;
      const done = shutdown({ server, sql, exit });

      await expect(get(port, '/fast')).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 200));
      expect(sql.end).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      release();
      expect(await slow).toEqual({ status: 200, body: 'committed' });
      await done;
      expect(sql.end).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(sql.end.mock.invocationCallOrder[0]!).toBeLessThan(exit.mock.invocationCallOrder[0]!);
    } finally {
      release();
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('shutdown — gives up at the timer', () => {
  it('Ruling R72: Given a request that never finishes (close never completes), Then nothing is closed before 10 s; at 10 000 ms the pool is closed and then the process exits — once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const server = { close: vi.fn((_cb?: (err?: Error) => void) => undefined), closeAllConnections: vi.fn() };
    const sql = fakeSql();
    const exit = vi.fn((_code: number) => undefined);

    void shutdown({ server, sql, exit });
    expect(server.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sql.end).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sql.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(sql.end.mock.invocationCallOrder[0]!).toBeLessThan(exit.mock.invocationCallOrder[0]!);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('Ruling R72: Given every request drains at once, Then sql.end() and exit(0) follow without waiting for the timer, and the timer firing later does not exit a second time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const server = { close: vi.fn((cb?: (err?: Error) => void) => cb?.()) };
    const sql = fakeSql();
    const exit = vi.fn((_code: number) => undefined);

    await shutdown({ server, sql, exit });
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(sql.end).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS + 1_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(sql.end).toHaveBeenCalledTimes(1);
  });
});

describe('server/index.ts wires the drain', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  it("Ruling R72: Given index.ts, Then it imports shutdown from './shutdown' and calls it on SIGTERM and SIGINT", () => {
    expect(src).toMatch(/from '\.\/shutdown'/);
    expect(src).toMatch(/shutdown\(/);
    expect(src).toMatch(/SIGTERM/);
    expect(src).toMatch(/SIGINT/);
  });
});
