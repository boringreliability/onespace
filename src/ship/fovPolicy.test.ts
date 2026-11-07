/**
 * [v3-T1] FOV policy (D0, docs/v3/PLAN.md phase C).
 *
 * v2 breathed the FOV with absolute speed, so in orbit it sat at its ceiling:
 * 77.7° vertical, 110-124° horizontal on wide screens, an egg-shaped planet.
 */

import { describe, expect, it } from 'vitest';
import {
  BASE_HFOV_DEG,
  COCKPIT_MAX_HFOV_DEG,
  CRUISE_BREATH_DEG,
  HOR_PLUS_MAX_HFOV_DEG,
  THRUST_BREATH_DEG,
  fovPolicy,
  hfovFromVfov,
  vfovFromHfov,
} from './fovPolicy';

const at = (aspect: number, thrustFrac = 0, cruiseSpool = 0, mode: 'chase' | 'cockpit' = 'chase') =>
  fovPolicy({ aspect, thrustFrac, cruiseSpool, mode });
const h = (aspect: number, ...rest: [number?, number?, ('chase' | 'cockpit')?]) =>
  hfovFromVfov(at(aspect, ...rest), aspect);

describe('fovPolicy', () => {
  it('Given 16:9 at rest, Then the horizontal fov is 88° (≈ 57.0° vertical)', () => {
    expect(h(16 / 9)).toBeCloseTo(88, 6);
    expect(at(16 / 9)).toBeCloseTo(57.0, 1);
  });

  it('Given 2.1:1, Then it is Hor+: the same vertical as 16:9 and a wider horizontal under 100°', () => {
    expect(at(2.1)).toBeCloseTo(at(16 / 9), 6);
    expect(h(2.1)).toBeGreaterThan(88);
    expect(h(2.1)).toBeLessThan(HOR_PLUS_MAX_HFOV_DEG);
  });

  it('Given 21:9, Then the horizontal stops at 100° and the vertical narrows (Vert-)', () => {
    expect(h(21 / 9)).toBeCloseTo(HOR_PLUS_MAX_HFOV_DEG, 6);
    expect(at(21 / 9)).toBeLessThan(at(16 / 9));
  });

  it('Given 32:9, Then the horizontal is still 100° at rest', () => {
    expect(h(32 / 9)).toBeCloseTo(HOR_PLUS_MAX_HFOV_DEG, 6);
  });

  it('Given 4:3, Then it keeps the 16:9 vertical (Hor+ narrows the horizontal)', () => {
    expect(at(4 / 3)).toBeCloseTo(at(16 / 9), 6);
    expect(h(4 / 3)).toBeLessThan(88);
  });

  it('Given full thrust at 16:9, Then it breathes out by 4° horizontal; Given full cruise spool, by 10°', () => {
    expect(h(16 / 9, 1, 0)).toBeCloseTo(BASE_HFOV_DEG + THRUST_BREATH_DEG, 6);
    expect(h(16 / 9, 0, 1)).toBeCloseTo(BASE_HFOV_DEG + CRUISE_BREATH_DEG, 6);
    expect(h(16 / 9, 1, 1)).toBeCloseTo(BASE_HFOV_DEG + THRUST_BREATH_DEG + CRUISE_BREATH_DEG, 6);
  });

  it('Given half thrust, Then half the breath; Given out-of-range inputs, Then they are clamped to 0..1', () => {
    expect(h(16 / 9, 0.5, 0)).toBeCloseTo(BASE_HFOV_DEG + THRUST_BREATH_DEG / 2, 6);
    expect(at(16 / 9, 7, 0)).toBeCloseTo(at(16 / 9, 1, 0), 9);
    expect(at(16 / 9, -1, -3)).toBeCloseTo(at(16 / 9, 0, 0), 9);
    expect(Number.isFinite(at(16 / 9, Number.NaN, Number.NaN))).toBe(true);
    expect(at(16 / 9, Number.NaN, Number.NaN)).toBeCloseTo(at(16 / 9), 9);
  });

  it('Given breathing on an ultra-wide screen in chase, Then it still breathes (on top of the 100° base)', () => {
    expect(h(21 / 9, 0, 1)).toBeGreaterThan(h(21 / 9) + 5);
  });

  it('Given the cockpit, Then it is never wider than 100° horizontal at any aspect or breath', () => {
    for (const aspect of [4 / 3, 16 / 9, 2.1, 21 / 9, 32 / 9]) {
      for (const [t, s] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        expect(h(aspect, t, s, 'cockpit')).toBeLessThanOrEqual(COCKPIT_MAX_HFOV_DEG + 1e-9);
      }
    }
  });

  it('Given the cockpit at 16:9 at rest, Then it matches the chase base (88°)', () => {
    expect(h(16 / 9, 0, 0, 'cockpit')).toBeCloseTo(88, 6);
  });

  it('Given more thrust or more spool, Then the fov never narrows (monotonic)', () => {
    let prev = 0;
    for (let i = 0; i <= 20; i++) {
      const v = at(16 / 9, i / 20, i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('Given the helpers, Then hfov and vfov are inverses', () => {
    for (const a of [1, 16 / 9, 2.4]) expect(vfovFromHfov(hfovFromVfov(57, a), a)).toBeCloseTo(57, 9);
  });
});

// [review-v3a] Adversarial review: narrow screens, pinned numbers, bad aspects.
describe('fovPolicy — narrow screens and pinned numbers (review-v3a)', () => {
  it('Given a phone in portrait (9:16), When the cruise drive spools and thrust is full, Then the vertical breathes exactly as at 16:9 (not 66 % harder)', () => {
    for (const aspect of [9 / 16, 0.2, 1, 4 / 3]) {
      for (const [t, s] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.3]] as const) {
        expect(at(aspect, t, s)).toBeCloseTo(at(16 / 9, t, s), 9);
        expect(at(aspect, t, s, 'cockpit')).toBeCloseTo(at(16 / 9, t, s, 'cockpit'), 9);
      }
    }
    // Measured before the fix: 57.0° → 76.7° vertical at 9:16, 57.0° → 69.6° at 16:9.
    expect(at(9 / 16, 1, 1)).toBeLessThan(70);
  });

  it('Given the D0 numbers, Then they are pinned as literals (88° base, +4° thrust, +10° spool, 100° Hor+ and cockpit caps)', () => {
    expect(h(16 / 9)).toBeCloseTo(88, 6);
    expect(h(16 / 9, 1, 0)).toBeCloseTo(92, 6);
    expect(h(16 / 9, 0, 1)).toBeCloseTo(98, 6);
    expect(h(32 / 9)).toBeCloseTo(100, 6);
    expect(h(32 / 9, 1, 1, 'cockpit')).toBeCloseTo(100, 6);
    expect(h(16 / 9, 1, 1, 'cockpit')).toBeCloseTo(100, 6);
  });

  it('Given an infinite, NaN, zero or negative aspect, Then it falls back to the 16:9 answer instead of a NaN', () => {
    for (const aspect of [Infinity, Number.NaN, 0, -2]) {
      const v = fovPolicy({ aspect, thrustFrac: 0.5, cruiseSpool: 0.5, mode: 'chase' });
      expect(v).toBeCloseTo(at(16 / 9, 0.5, 0.5), 9);
    }
  });
});
