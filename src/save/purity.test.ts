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
 *      getters on globalThis record any touch. Any read counts, `typeof window`
 *      included, since the getter is invoked; a module-level access must not
 *      happen at all (a throw while evaluating the module fails the test too).
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ENTRIES = ['save/schema.ts', 'save/migrate.ts', 'save/replay.ts', 'save/conflict.ts'];
const IMPURE_FIXTURE = 'save/__fixtures__/impure.ts'; // negative control: the checker must flag it
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

const cache = new Map<string, ReturnType<typeof runCheck>>();

/** The one checker every entry (and the negative control) goes through; one run per entry. */
function checkPurity(entry: string) {
  let r = cache.get(entry);
  if (!r) cache.set(entry, (r = runCheck(entry)));
  return r;
}

async function runCheck(entry: string) {
  const result = await bundle(entry);
  const inputs = Object.keys(result.metafile.inputs);
  const threeInputs = inputs.filter((p) => /node_modules\/three(\/|$)/.test(p));
  const code = result.outputFiles[0].text;
  const touched: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const original = new Map(FORBIDDEN_GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)]));
  for (const name of FORBIDDEN_GLOBALS) {
    Object.defineProperty(g, name, {
      configurable: true,
      get() {
        touched.push(name);
        return undefined;
      },
    });
  }
  // Node caches data: imports by URL; a per-run suffix forces re-evaluation.
  let threw: unknown = null;
  try {
    await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(`${code}\n// run ${Math.random()}`).toString('base64'));
  } catch (e) {
    threw = e;
  } finally {
    for (const name of FORBIDDEN_GLOBALS) {
      delete g[name];
      const d = original.get(name);
      if (d) Object.defineProperty(g, name, d);
    }
  }
  return { inputCount: inputs.length, threeInputs, touched, threw };
}

describe.each(ENTRIES)('save core purity: src/%s', (entry) => {
  describe('given the module and its transitive imports', () => {
    it('when bundled, then no input comes from three', async () => {
      const r = await checkPurity(entry);
      expect(r.inputCount).toBeGreaterThan(0);
      expect(r.threeInputs).toEqual([]);
    });

    it('when its top level runs in node, then it touches none of window/document/indexedDB/localStorage', async () => {
      const r = await checkPurity(entry);
      expect(r.threw).toBeNull();
      expect(r.touched).toEqual([]);
    });
  });
});

describe('purity checker negative control', () => {
  describe('given a fixture that imports three and reads window at top level', () => {
    it('when checked, then the three-input check flags it', async () => {
      const r = await checkPurity(IMPURE_FIXTURE);
      expect(r.threeInputs.length).toBeGreaterThan(0);
    });

    it('when checked, then the global-trap check flags window', async () => {
      const r = await checkPurity(IMPURE_FIXTURE);
      expect(r.touched).toContain('window');
    });
  });
});
