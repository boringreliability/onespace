import { serve } from '@hono/node-server';

import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createDb } from './db';
import { migrate } from './migrate';

async function main() {
  const config = loadConfig(process.env);
  const sql = createDb(config.databaseUrl);
  const applied = await migrate(sql);
  if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);
  const app = createApp({ config, sql });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`oneSpace server listening on :${info.port}`);
  });
  const stop = () => {
    server.close();
    void sql.end({ timeout: 5 }).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `Config error: ${err.message}` : err);
  process.exit(1);
});
