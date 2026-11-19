/**
 * v4 sub-plan 3 (local save), Task 4 — `newestOf`.
 *
 * On boot there can be two candidates: the IndexedDB current and the WAL
 * snapshot (written synchronously on pagehide). `newestOf` picks one:
 * the higher `revision` wins; on equal revisions the later `savedAt.wallMs`
 * wins; on a full tie the FIRST argument wins (deterministic, no flip-flop).
 * It never mutates and returns one of its arguments (not a copy).
 */

import { describe, expect, it } from 'vitest';

import golden from './fixtures/v1-golden.json';
import type { SaveV1 } from './schema';
import { newestOf } from './store';

function saveAt(revision: number, wallMs: number): SaveV1 {
  const s = structuredClone(golden) as unknown as SaveV1;
  s.revision = revision;
  s.savedAt = { wallMs, orbitSeconds: s.savedAt.orbitSeconds };
  return s;
}

describe('newestOf', () => {
  it('Given two nulls, Then it is null', () => {
    expect(newestOf(null, null)).toBeNull();
  });

  it('Given one save and a null (either side), Then it is the save', () => {
    const a = saveAt(3, 1000);
    expect(newestOf(a, null)).toBe(a);
    expect(newestOf(null, a)).toBe(a);
  });

  it('Given a higher revision with an OLDER wall time, Then the higher revision still wins', () => {
    const high = saveAt(9, 1000);
    const low = saveAt(8, 9_999_999);
    expect(newestOf(high, low)).toBe(high);
    expect(newestOf(low, high)).toBe(high);
  });

  it('Given equal revisions, Then the later savedAt.wallMs wins, whichever side it is on', () => {
    const older = saveAt(8, 1000);
    const newer = saveAt(8, 2000);
    expect(newestOf(older, newer)).toBe(newer);
    expect(newestOf(newer, older)).toBe(newer);
  });

  it('Given equal revision and equal wallMs, Then the first argument wins', () => {
    const a = saveAt(8, 1000);
    const b = saveAt(8, 1000);
    expect(newestOf(a, b)).toBe(a);
    expect(newestOf(b, a)).toBe(b);
  });

  it('Given two saves, Then neither is mutated', () => {
    const a = saveAt(8, 1000);
    const b = saveAt(9, 500);
    const before = structuredClone([a, b]);
    newestOf(a, b);
    expect([a, b]).toEqual(before);
  });
});
