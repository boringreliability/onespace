/**
 * One blueprint object is now shared by everything that reads it.
 *
 * Before the worker pool, the Stage generated a fresh blueprint per quality
 * tier and Traffic one per vessel, so a renderer that wrote into its input
 * only spoiled its own copy. `shipGen` hands out the SAME object from its LRU
 * to every tier, the Yard, the review harness and Traffic. A write into it
 * would leak from one consumer into the next — silently, and differently
 * depending on which one happened to build first. This pins "readers only":
 * the blueprint is deep-frozen (writes throw in module code), then pushed
 * through every consumer at every tier and LOD.
 */

import { describe, it } from 'vitest';

import { Config } from '@/core/Config';
import { generateShip } from '@/gen/ships/blueprint';
import { PINNED } from '@/gen/ships/goldenParams';
import { shipScan } from '@/gen/ships/physics';
import { shipSpecs } from '@/game/showroom/specs';
import { createShipVisual } from './ShipMesh';

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze((o as Record<string, unknown>)[k]);
  }
  return o;
}

describe('a blueprint shared across consumers', () => {
  it('Given a deep-frozen blueprint, When every quality tier builds and re-LODs a visual from it and the scan and specs read it, Then nothing writes into it', () => {
    const cfg = new Config();
    for (const p of PINNED) {
      const bp = deepFreeze(generateShip(p));
      for (const tier of Config.tiers()) {
        const v = createShipVisual(bp, cfg.setTier(tier));
        for (const l of [0, 1, 2, 3] as const) v.setLod(l);
        v.dispose();
      }
      shipScan(bp);
      shipSpecs(bp);
    }
  }, 120_000);
});
