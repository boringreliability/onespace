/**
 * Quality tiers — guard rails measured in the v2 performance audit.
 *
 * DPR 2 on a retina laptop is 5.8-7.7 Mpx through a raymarched, log-depth
 * stack; dropping it to 1 saved 40 % of the frame. Terrain vertices are
 * evaluated five times per frame each, so patch resolution is the other
 * lever. These tests stop either creeping back.
 */

import { describe, expect, it } from 'vitest';
import { Config } from './Config';

const tier = (t: 'low' | 'medium' | 'high' | 'ultra') => new Config().setTier(t);

describe('quality tiers', () => {
  it('Given high, Then the pixel ratio is capped at 1.25', () => {
    expect(tier('high').maxPixelRatio).toBeLessThanOrEqual(1.25);
  });

  it('Given ultra, Then the pixel ratio is capped at 1.5', () => {
    expect(tier('ultra').maxPixelRatio).toBeLessThanOrEqual(1.5);
  });

  it('Given high, Then terrain patches are 33 vertices per side, not 65', () => {
    expect(tier('high').patchResolution).toBe(33);
  });

  it('Given any tier, Then patch resolution is 2^n + 1 (the quadtree stitching needs it)', () => {
    for (const t of Config.tiers()) {
      const n = tier(t).patchResolution - 1;
      expect(n > 0 && (n & (n - 1)) === 0).toBe(true);
    }
  });

  it('Given the tiers in order, Then pixel ratio never decreases going up', () => {
    const r = Config.tiers().map((t) => tier(t).maxPixelRatio);
    for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!);
  });
});
