/**
 * Ruling R63 — Zod must not probe eval in the client (phase A, tests only).
 *
 * The e2e found a CSP violation on every boot. Zod 4 builds a fast parser
 * for each `z.object(...)` with `new Function(...)`, and checks first whether
 * that is allowed (`util.allowsEval` runs `new Function("")`). Under
 * `script-src 'self'` the probe is reported as a `securitypolicyviolation`
 * even though Zod catches the throw.
 *
 * The client sets `z.config({ jitless: true })` before any schema exists.
 * In zod 4.6.7 the check runs when a schema is BUILT, not when it is parsed:
 * $ZodObject's init computes `fastEnabled = !globalConfig.jitless &&
 * allowsEval.value`. So the setting must be in place before any module that
 * declares a schema is evaluated.
 *
 * Assumed surface: src/core/zodConfig.ts, a side-effect module that calls
 * `z.config({ jitless: true })`. It is the FIRST import of src/main.ts, the
 * client entry. It lives in src/core (entry side), not src/save: the save
 * module must stay pure and must not decide a page-wide setting. The server
 * has no CSP and is out of scope.
 *
 * Every module here is imported dynamically. Vitest isolates each test file,
 * so zod and the save schema are evaluated fresh, in the order this file
 * chooses.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import golden from '@/save/fixtures/v1-golden.json';

const RealFunction = globalThis.Function;

/** Count every use of the Function constructor (`new Function(...)` and `Function(...)`). */
function countFunctionCalls(): { calls: () => number; restore: () => void } {
  let n = 0;
  const counting = new Proxy(RealFunction, {
    construct(target, args, newTarget) {
      n++;
      return Reflect.construct(target, args, newTarget === counting ? target : newTarget);
    },
    apply(target, self, args) {
      n++;
      return Reflect.apply(target, self, args);
    },
  });
  globalThis.Function = counting as FunctionConstructor;
  return {
    calls: () => n,
    restore: () => {
      globalThis.Function = RealFunction;
    },
  };
}

afterEach(() => {
  globalThis.Function = RealFunction;
});

describe('Ruling R63 — the client sets Zod jitless before any schema exists', () => {
  it('Ruling R63: Given the client config module, When it is imported, Then z.config().jitless is true', async () => {
    const { z } = await import('zod');
    expect(z.config().jitless).not.toBe(true); // Zod's default: JIT on
    await import('@/core/zodConfig');
    expect(z.config().jitless).toBe(true);
  });

  it('Ruling R63: Given the config imported first, When the save schema is built and the golden save is parsed and migrated, Then the Function constructor is never called (no eval probe, no compiled fast path)', async () => {
    const spy = countFunctionCalls();
    try {
      await import('@/core/zodConfig');
      const { SaveV1Schema } = await import('@/save/schema');
      const { migrate } = await import('@/save/migrate');
      expect(SaveV1Schema.safeParse(golden).success).toBe(true);
      expect(migrate(structuredClone(golden)).ok).toBe(true);
      expect(spy.calls()).toBe(0);
    } finally {
      spy.restore();
    }
  });
});

describe('Ruling R63 — the client entry imports the config first', () => {
  it('Ruling R63: Given src/main.ts, Then its first import is the Zod config (it must run before any module that declares a schema)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../main.ts'), 'utf8');
    const first = /^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/m.exec(src);
    expect(first, 'main.ts has an import').not.toBeNull();
    expect(first![1]).toMatch(/^(@\/core|\.\/core)\/zodConfig$/);
  });
});
