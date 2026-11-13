/**
 * A SaveStore in memory (tests, and a fallback where IndexedDB is missing).
 * Same promises as `idbStore`: copies in, copies out.
 */

import type { SaveV1 } from './schema';
import { rawKey, type SaveStore } from './store';

export function memoryStore(): SaveStore & { readonly corrupt: ReadonlyArray<{ wallMs: number; raw: unknown }> } {
  let current: unknown | null = null;
  let previous: unknown | null = null;
  const corrupt: Array<{ wallMs: number; raw: unknown }> = [];

  return {
    corrupt,
    async load() {
      return { current: structuredClone(current), previous: structuredClone(previous) };
    },
    async save(s: SaveV1) {
      const copy = structuredClone(s);
      if (current !== null) previous = current;
      current = copy;
    },
    async keepCorrupt(raw: unknown, wallMs: number) {
      const key = rawKey(raw);
      if (key !== null && corrupt.some((c) => rawKey(c.raw) === key)) return;
      corrupt.push({ wallMs, raw: structuredClone(raw) });
    },
  };
}
