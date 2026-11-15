/**
 * Purity guard (v4 sub-plan 4, Task 1).
 *
 * The save core (schema, migrate, replay, later conflict) is shared by the
 * browser and the node server, which bundles it with esbuild. So these files
 * and everything they import must stay free of `three` and of DOM/storage
 * globals at module level.
 *
 * Two independent checks per entry file:
 *   1. static: bundle with esbuild (metafile) and assert no input comes from
 *      node_modules/three;
 *   2. dynamic: bundle to ESM, then import the bundle in node, where `window`,
 *      `document`, `indexedDB` and `localStorage` do not exist. Booby-trapped
 *      getters on globalThis record any touch, so a guarded `typeof` check
 *      is fine but a bare read at module level is caught (and a ReferenceError
 *      thrown by evaluating the module fails the test too).
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ENTRIES = ['save/schema.ts', 'save/migrate.ts', 'save/replay.ts']; // Task 3 appends 'save/conflict.ts'
const FORBIDDEN_GLOBALS = ['window', 'document', 'indexedDB', 'localStorage'] as const;

async function bundle(entry: string) {
  return build({
    entryPoints: [SRC + entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    alias: { '@': SRC.replace(/\/$/, '') },
  });
}

describe.each(ENTRIES)('save core purity: src/%s', (entry) => {
  describe('given the module and its transitive imports', () => {
    it('when bundled, then no input comes from three', async () => {
      const result = await bundle(entry);
      const inputs = Object.keys(result.metafile.inputs);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.filter((p) => /node_modules\/three(\/|$)/.test(p))).toEqual([]);
    });

    it('when its top level runs in node, then it touches none of window/document/indexedDB/localStorage', async () => {
      const result = await bundle(entry);
      const code = result.outputFiles[0].text;
      const touched: string[] = [];
      const g = globalThis as Record<string, unknown>;
      for (const name of FORBIDDEN_GLOBALS) {
        Object.defineProperty(g, name, {
          configurable: true,
          get() {
            touched.push(name);
            return undefined;
          },
        });
      }
      try {
        await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
      } finally {
        for (const name of FORBIDDEN_GLOBALS) delete g[name];
      }
      expect(touched).toEqual([]);
    });
  });
});
