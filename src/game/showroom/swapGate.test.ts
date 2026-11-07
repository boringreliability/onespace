/**
 * When the Yard may cut to the next hull, and which hulls it warms up after.
 *
 * The cut used to happen as soon as the veil was black, with generation done
 * right there on the main thread. Generation now runs in a worker during the
 * fade, so the cut waits for BOTH the veil and the blueprint — but never
 * forever: a worker that is slow or gone must not leave the player staring at
 * black, so past a ceiling the cut goes ahead and the hull is built in place.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SELECTION, stepSeed, toShipParams } from './catalog';
import { SWAP_MAX_WAIT_MS, mayCut, seedNeighbours } from './swapGate';

describe('mayCut', () => {
  const FADE = 160;

  it('Given the veil is still fading up, When the blueprint is already ready, Then the cut waits for black', () => {
    expect(mayCut(FADE - 1, FADE, true)).toBe(false);
  });

  it('Given the veil is black and the blueprint is ready, Then the cut goes ahead', () => {
    expect(mayCut(FADE, FADE, true)).toBe(true);
  });

  it('Given the veil is black but the blueprint is not ready, Then the cut holds on black', () => {
    expect(mayCut(FADE + 50, FADE, false)).toBe(false);
  });

  it('Given the blueprint never arrives, When the ceiling has passed, Then the cut goes ahead anyway (built in place)', () => {
    expect(mayCut(FADE + SWAP_MAX_WAIT_MS, FADE, false)).toBe(true);
  });

  it('Given the player keeps asking for new hulls on black, When the fade began long ago, Then the ceiling runs from the last ask', () => {
    expect(mayCut(FADE + SWAP_MAX_WAIT_MS * 3, FADE, false, 100)).toBe(false);
    expect(mayCut(FADE + SWAP_MAX_WAIT_MS * 3, FADE, false, SWAP_MAX_WAIT_MS)).toBe(true);
  });

  it('Given the ceiling, Then it is long enough for a slow hull and short enough not to read as a hang', () => {
    expect(SWAP_MAX_WAIT_MS).toBeGreaterThanOrEqual(400);
    expect(SWAP_MAX_WAIT_MS).toBeLessThanOrEqual(2000);
  });
});

describe('seedNeighbours', () => {
  it('Given a selection, Then the neighbours are the next and previous hull numbers, next first', () => {
    const n = seedNeighbours(DEFAULT_SELECTION);
    expect(n).toEqual([toShipParams(stepSeed(DEFAULT_SELECTION, 1)), toShipParams(stepSeed(DEFAULT_SELECTION, -1))]);
  });

  it('Given a selection, Then the neighbours keep its faction, role and size', () => {
    for (const p of seedNeighbours(DEFAULT_SELECTION)) {
      expect(p.factionId).toBe(DEFAULT_SELECTION.factionId);
      expect(p.role).toBe(DEFAULT_SELECTION.role);
      expect(p.sizeClass).toBe(DEFAULT_SELECTION.sizeClass);
      expect(p.seed).not.toBe(DEFAULT_SELECTION.seed);
    }
  });
});

describe('mayCut — the ceiling counts from black (review-worker)', () => {
  const FADE = 160;

  it('Given the blueprint is not ready, When black has lasted just under the ceiling, Then the cut still holds', () => {
    // The fade itself is not waiting time: the ceiling starts once the veil is black.
    expect(mayCut(FADE + SWAP_MAX_WAIT_MS - 1, FADE, false)).toBe(false);
  });
});
