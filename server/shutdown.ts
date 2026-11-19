/**
 * Shutdown drain (Ruling R72). A deploy sends SIGTERM; exiting at once would drop the
 * answer to a request the server has already committed (final review I1). So: stop
 * accepting, wait for in-flight requests, give up after a hard timer, then close the
 * pool and exit — exactly once.
 */

export const SHUTDOWN_GRACE_MS = 10_000;

export type ShutdownDeps = {
  server: { close(cb?: (err?: Error) => void): unknown; closeAllConnections?(): void };
  sql: { end(opts?: { timeout?: number }): Promise<unknown> };
  exit: (code: number) => void;
  graceMs?: number;
};

export async function shutdown({ server, sql, exit, graceMs = SHUTDOWN_GRACE_MS }: ShutdownDeps): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      console.error(`shutdown: requests still in flight after ${graceMs} ms, closing anyway`);
      server.closeAllConnections?.();
      resolve(1);
    }, graceMs);
  });
  const drained = new Promise<number>((resolve) => {
    // close() stops accepting at once; its callback runs when every connection has ended.
    server.close((err) => {
      if (err) console.error('shutdown: server.close failed:', err);
      resolve(0);
    });
  });

  const code = await Promise.race([drained, timedOut]);
  clearTimeout(timer);
  try {
    await sql.end({ timeout: 5 });
  } catch (err) {
    console.error('shutdown: closing the database pool failed:', err);
  }
  exit(code);
}
