/**
 * Ship generator smoke test.
 *
 * Bundles the pure generation layer with esbuild (no browser, no three.js) and
 * asserts the two things that matter before any geometry exists: the same seed
 * gives the same ship, and different seeds give genuinely different ships.
 */
import { build } from 'esbuild';
import { unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/onespace-ship-smoke.mjs';
await build({
  entryPoints: ['src/gen/ships/entry.smoke.ts'],
  bundle: true, format: 'esm', outfile: OUT, platform: 'node', logLevel: 'warning',
  // esbuild resolves aliases against the CWD, not against this file.
  alias: { '@': resolve(process.cwd(), 'src') },
});
const m = await import(pathToFileURL(OUT).href);
for (const line of m.run()) console.log(line);
unlinkSync(OUT);
