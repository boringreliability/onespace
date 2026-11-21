/**
 * A SaveStore in memory (tests, and a fallback where IndexedDB is missing).
 * Same promises as `idbStore`: copies in, copies out.
 */

import type { Save } from './schema';
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
    async save(s: Save) {
      const copy = structuredClone(s);
      if (current !== null) previous = current;
      current = copy;
    },
    async replaceAll(s: Save | null) {
      current = s === null ? null : structuredClone(s);
      previous = null;
    },
    async keepCorrupt(raw: unknown, wallMs: number) {
      const key = rawKey(raw);
      if (key !== null && corrupt.some((c) => rawKey(c.raw) === key)) return;
      corrupt.push({ wallMs, raw: structuredClone(raw) });
    },
  };
}
