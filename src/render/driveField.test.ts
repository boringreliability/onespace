/**
 * v3 T4 / PLAN E2 — the cruise drive field.
 *
 * The audit: "0.78c looks like a coast". The warp has a full visual
 * vocabulary (streaks, aberration, edge chroma); the cruise drive has none.
 * The fix borrows that vocabulary at about 5 %: the star field bunches towards
 * the direction of travel in proportion to log10(cap / c), with a faint sheen
 * at the frame edges. Logarithmic because the cap spans six decades (180 km/s
 * to 500 c) and a linear map would be all-or-nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  C_KMS,
  DRIVE_ABERRATION_MAX_BETA,
  DRIVE_SHEEN_MAX,
  aberrateCos,
  driveAberrationBeta,
  driveFieldAmount,
  driveSheen,
} from './driveField';

describe('driveFieldAmount: 0..1 from the cruise cap, logarithmic', () => {
  it('Given no cruise (null cap), Then the field is off', () => {
    expect(driveFieldAmount(null)).toBe(0);
  });

  it('Given a cap at or below the sublight ceiling (≤ 180 km/s), Then the field is off', () => {
    expect(driveFieldAmount(0)).toBe(0);
    expect(driveFieldAmount(60)).toBe(0);
    expect(driveFieldAmount(180)).toBe(0);
  });

  it('Given the cap rising through six decades, Then the field rises strictly monotonically', () => {
    let prev = -1;
    for (const cap of [300, 3e3, 3e4, C_KMS, 3e6, 3e7]) {
      const a = driveFieldAmount(cap);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it('Given a cap of c, Then the field is roughly half-on (log scale, not linear)', () => {
    const a = driveFieldAmount(C_KMS);
    expect(a).toBeGreaterThan(0.35);
    expect(a).toBeLessThan(0.75);
  });

  it('Given the drive’s maximum cap (500 c) or more, Then the field saturates at exactly 1', () => {
    expect(driveFieldAmount(1.5e8)).toBeCloseTo(1, 9);
    expect(driveFieldAmount(1e12)).toBe(1);
  });

  it('Given a non-finite cap, Then the field is off rather than NaN', () => {
    expect(driveFieldAmount(Number.NaN)).toBe(0);
    expect(driveFieldAmount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('aberrateCos: relativistic aberration, cosθ′ = (cosθ + β)/(1 + β cosθ)', () => {
  it('Given β = 0, Then every star stays where it is', () => {
    for (const c of [-1, -0.3, 0, 0.6, 1]) expect(aberrateCos(c, 0)).toBeCloseTo(c, 12);
  });

  it('Given the apex and the antapex, Then they are fixed points', () => {
    expect(aberrateCos(1, 0.3)).toBeCloseTo(1, 12);
    expect(aberrateCos(-1, 0.3)).toBeCloseTo(-1, 12);
  });

  it('Given β > 0, Then every other star moves towards the direction of travel (cosθ′ > cosθ)', () => {
    for (const c of [-0.9, -0.5, 0, 0.5, 0.9]) expect(aberrateCos(c, 0.2)).toBeGreaterThan(c);
  });

  it('Given a star at 90°, Then it moves forward by asin(β)', () => {
    const b = 0.2;
    expect(Math.acos(aberrateCos(0, b))).toBeCloseTo(Math.PI / 2 - Math.asin(b), 9);
  });

  it('Given any input, Then the result is a valid cosine in [-1, 1]', () => {
    for (const c of [-1.2, -1, 0, 1, 1.3]) {
      const r = aberrateCos(c, 0.5);
      expect(r).toBeGreaterThanOrEqual(-1);
      expect(r).toBeLessThanOrEqual(1);
    }
  });
});

describe('driveAberrationBeta / driveSheen: the warp vocabulary, quietly', () => {
  it('Given the field off, Then β and sheen are 0', () => {
    expect(driveAberrationBeta(0)).toBe(0);
    expect(driveSheen(0)).toBe(0);
  });

  it('Given the field fully on, Then β is the ceiling and the sheen is ~5 % (never a tunnel)', () => {
    expect(driveAberrationBeta(1)).toBeCloseTo(DRIVE_ABERRATION_MAX_BETA, 12);
    expect(driveSheen(1)).toBeCloseTo(DRIVE_SHEEN_MAX, 12);
    expect(DRIVE_SHEEN_MAX).toBeGreaterThanOrEqual(0.03);
    expect(DRIVE_SHEEN_MAX).toBeLessThanOrEqual(0.08);
  });

  it('Given the β ceiling, Then a 90° star moves visibly (≥ 8°) but the sky does not collapse to a point (≤ 25°)', () => {
    const shiftDeg = (Math.asin(DRIVE_ABERRATION_MAX_BETA) * 180) / Math.PI;
    expect(shiftDeg).toBeGreaterThanOrEqual(8);
    expect(shiftDeg).toBeLessThanOrEqual(25);
  });

  it('Given an amount outside [0, 1], Then it is clamped', () => {
    expect(driveAberrationBeta(-1)).toBe(0);
    expect(driveAberrationBeta(3)).toBeCloseTo(DRIVE_ABERRATION_MAX_BETA, 12);
    expect(driveSheen(Number.NaN)).toBe(0);
  });
});
