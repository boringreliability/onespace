/**
 * Ruling R63, the control for zodConfig.test.ts. WITHOUT the client's Zod
 * config, building the save schema and parsing a save DOES call the Function
 * constructor: the eval probe, then the compiled fast path. So the counter is
 * known to see the calls, and zodConfig.test.ts's "0 calls" means something.
 *
 * This is a separate file on purpose: vitest isolates each file, so zod and
 * the schema are evaluated here with Zod's defaults (JIT on).
 */

import { afterEach, describe, expect, it } from 'vitest';

import golden from '@/save/fixtures/v1-golden.json';

const RealFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = RealFunction;
});

describe('Ruling R63 — control: Zod with its defaults probes eval', () => {
  it('Given no jitless config, When the save schema is built and the golden save parsed, Then the Function constructor is called (the probe the CSP reports)', async () => {
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
    try {
      const { z } = await import('zod');
      expect(z.config().jitless).not.toBe(true);
      const { SaveV1Schema } = await import('@/save/schema');
      expect(SaveV1Schema.safeParse(golden).success).toBe(true);
      expect(n).toBeGreaterThan(0);
    } finally {
      globalThis.Function = RealFunction;
    }
  });
});
