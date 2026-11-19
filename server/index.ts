import { serve } from '@hono/node-server';

import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrate';
import { shutdown } from './shutdown';

async function main() {
  const config = loadConfig(process.env);
  const sql = createDb(config.databaseUrl);
  const applied = await migrate(sql);
  if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
  const app = createApp({ config, sql });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`oneSpace server listening on :${info.port}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdown({ server, sql, exit: (code) => process.exit(code) });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `Config error: ${err.message}` : err);
  process.exit(1);
});
