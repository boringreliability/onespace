// Bundles server/index.ts into dist-server/index.mjs. `@` -> src so the server
// can share the pure save core with the client. Dependencies stay external.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(root + 'dist-server', { recursive: true, force: true });
await build({
  entryPoints: [root + 'server/index.ts'],
  outfile: root + 'dist-server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  alias: { '@': root + 'src' },
});
cpSync(root + 'server/migrations', root + 'dist-server/migrations', { recursive: true });
