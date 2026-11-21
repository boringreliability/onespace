/**
 * Final whole-branch review, I1 — metal that reads.
 *
 * Metal-rich rocks rendered as a blown-out soft white disc: a 0.15 albedo
 * opened the centre-weighted iris 1.5–2 stops, and an untinted specular of
 * 0.55 (3.7× the albedo, Blinn exponent 24) then landed 3+ stops over and
 * clipped through ACES. Ruling: the specular is albedo-relative and, for
 * metal, tinted by the albedo (F0 ≈ albedo):
 *
 *   c = sun · (albedo · (ndl + amb) + specColor · spec)
 *   specColor = mix(vec3(1), albedo / max(albedo), metalness)
 *
 * METAL ≈ { 0.30, 0.29, 0.28, spec 0.15 }, exponent 48–64, so the highlight
 * peak stays ≤ ~1.5× the albedo for every composition.
 *
 * Contract asserted here (pure, no WebGL):
 *   asteroidSurface(composition) → { albedo: [r, g, b], spec, metalness, specColor: [r, g, b] }
 *   ASTEROID_SPEC_EXPONENT — the Blinn exponent the shader uses
 *   wearVisual(wear) — plan 5 task 5 (see the block at the end)
 */

import { describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';

import { ASTEROID_SPEC_EXPONENT, asteroidSurface, wearVisual } from './asteroidSurface';

const PURE: Readonly<Record<Resource, Record<Resource, number>>> = {
  ice: { ice: 1e6, metal: 0, silicate: 0, rare: 0 },
  metal: { ice: 0, metal: 1e6, silicate: 0, rare: 0 },
  silicate: { ice: 0, metal: 0, silicate: 1e6, rare: 0 },
  rare: { ice: 0, metal: 0, silicate: 0, rare: 1e6 },
};

/** A sweep of mixes, pure ends included: every fraction in tenths. */
function mixes(): Record<Resource, number>[] {
  const out: Record<Resource, number>[] = [];
  for (let i = 0; i <= 10; i++) {
    for (let m = 0; m <= 10 - i; m++) {
      for (let r = 0; r <= 10 - i - m; r++) {
        out.push({ ice: i * 1e5, metal: m * 1e5, rare: r * 1e5, silicate: (10 - i - m - r) * 1e5 });
      }
    }
  }
  return out;
}

/** The highlight's peak over the diffuse, per channel: specColor·spec / albedo. */
function peakOverAlbedo(s: ReturnType<typeof asteroidSurface>): number {
  let worst = 0;
  for (let c = 0; c < 3; c++) worst = Math.max(worst, (s.specColor[c]! * s.spec) / s.albedo[c]!);
  return worst;
}

describe('asteroidSurface — the highlight never blows out (I1)', () => {
  for (const name of ['ice', 'metal', 'silicate', 'rare'] as const) {
    it(`Given a pure ${name} rock, Then the specular peak is at most 1.5× its albedo in every channel`, () => {
      const s = asteroidSurface(PURE[name]);
      expect(peakOverAlbedo(s), JSON.stringify(s)).toBeLessThanOrEqual(1.5);
    });
  }

  it('Given any mix of ice, metal, silicate and rare (in tenths), Then the specular peak is at most 1.5× the albedo in every channel', () => {
    for (const c of mixes()) {
      const s = asteroidSurface(c);
      expect(peakOverAlbedo(s), JSON.stringify(c)).toBeLessThanOrEqual(1.5);
      for (const a of s.albedo) expect(a, JSON.stringify(c)).toBeGreaterThan(0);
    }
  });

  it('Given the Blinn exponent, Then it is between 48 and 64 (a tighter highlight than the old 24)', () => {
    expect(ASTEROID_SPEC_EXPONENT).toBeGreaterThanOrEqual(48);
    expect(ASTEROID_SPEC_EXPONENT).toBeLessThanOrEqual(64);
  });
});

describe('asteroidSurface — metal is a grey that reads, tinted like a metal (I1)', () => {
  it('Given a pure metal rock, Then its albedo is at least 0.28 in every channel (so the iris does not open on it)', () => {
    const s = asteroidSurface(PURE.metal);
    for (const a of s.albedo) expect(a, JSON.stringify(s.albedo)).toBeGreaterThanOrEqual(0.28);
  });

  it('Given a pure metal rock, Then metalness is 1 and specColor is the albedo over its brightest channel (F0 ≈ albedo), not white', () => {
    const s = asteroidSurface(PURE.metal);
    expect(s.metalness).toBeCloseTo(1, 9);
    const max = Math.max(...s.albedo);
    for (let c = 0; c < 3; c++) expect(s.specColor[c]!, `channel ${c}`).toBeCloseTo(s.albedo[c]! / max, 6);
    // Tinted: the channels differ, so this is not vec3(1).
    expect(Math.min(...s.specColor)).toBeLessThan(1 - 1e-3);
  });

  it('Given a pure ice or silicate rock, Then metalness is 0 and the highlight is white (specColor = 1, 1, 1)', () => {
    for (const name of ['ice', 'silicate'] as const) {
      const s = asteroidSurface(PURE[name]);
      expect(s.metalness, name).toBeCloseTo(0, 9);
      for (const c of s.specColor) expect(c, name).toBeCloseTo(1, 9);
    }
  });

  it('Given a rare-bearing rock, Then it reads as metal: the same surface as pure metal', () => {
    expect(asteroidSurface(PURE.rare)).toEqual(asteroidSurface(PURE.metal));
  });

  it('Given half metal and half ice, Then metalness is 0.5 and specColor = mix(1, albedo / max(albedo), 0.5)', () => {
    const s = asteroidSurface({ ice: 5e5, metal: 5e5, silicate: 0, rare: 0 });
    expect(s.metalness).toBeCloseTo(0.5, 9);
    const max = Math.max(...s.albedo);
    for (let c = 0; c < 3; c++) {
      expect(s.specColor[c]!, `channel ${c}`).toBeCloseTo(0.5 + 0.5 * (s.albedo[c]! / max), 6);
    }
  });

  it('Given an empty composition (all zero), Then it reads as silicate, as before', () => {
    expect(asteroidSurface({ ice: 0, metal: 0, silicate: 0, rare: 0 })).toEqual(asteroidSurface(PURE.silicate));
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 5, Task 5 — visible wear. `wearVisual(wear)` maps the derived
// wear (mined mass / original mass, Belt.wear) to how worn the rock LOOKS,
// 0..1. Not linear: 2 000 kg off a 65 000 kg rock must already show
// ("synligt fra første bid"), so the curve rises fast and flattens (concave).
// The renderer writes it per rock into the `aWear` instance attribute.
//
// Contract asserted here (pure):
//   wearVisual(wear: number): number — 0 → 0, 1 → 1, strictly increasing,
//   concave, wearVisual(2000/65000) ≥ 0.15, clamped (< 0, NaN → 0; > 1 → 1)
// ---------------------------------------------------------------------------

/** Wear values from a first bite to an empty rock. */
const WEAR_TABLE: readonly number[] = [
  0, 0.0005, 0.001, 0.0039, 0.005, 0.01, 2_000 / 65_000, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7,
  0.8, 0.9, 0.95, 0.99, 1,
];

describe('wearVisual — the look of a worn rock (plan 5 task 5)', () => {
  it('Given no wear, Then the look is exactly 0; given a rock mined empty, Then exactly 1', () => {
    expect(wearVisual(0)).toBe(0);
    expect(wearVisual(1)).toBe(1);
  });

  it('Given the table of wear values, Then every look is finite and within 0..1', () => {
    for (const w of WEAR_TABLE) {
      const v = wearVisual(w);
      expect(Number.isFinite(v), `wear ${w}`).toBe(true);
      expect(v, `wear ${w}`).toBeGreaterThanOrEqual(0);
      expect(v, `wear ${w}`).toBeLessThanOrEqual(1);
    }
  });

  it('Given the table of wear values in order, Then the look is strictly increasing', () => {
    for (let i = 1; i < WEAR_TABLE.length; i++) {
      const a = WEAR_TABLE[i - 1]!;
      const b = WEAR_TABLE[i]!;
      expect(wearVisual(b), `wearVisual(${b}) > wearVisual(${a})`).toBeGreaterThan(wearVisual(a));
    }
  });

  it('Given any two wear values a < b from the table, Then the look at their midpoint is at least the mean of their looks (concave)', () => {
    for (let i = 0; i < WEAR_TABLE.length; i++) {
      for (let j = i + 1; j < WEAR_TABLE.length; j++) {
        const a = WEAR_TABLE[i]!;
        const b = WEAR_TABLE[j]!;
        const mid = wearVisual((a + b) / 2);
        const mean = (wearVisual(a) + wearVisual(b)) / 2;
        expect(mid, `a ${a}, b ${b}`).toBeGreaterThanOrEqual(mean - 1e-12);
      }
    }
  });

  it('Given 2 000 kg mined from a 65 000 kg rock, Then the look is at least 0.15 (visible from the first bites)', () => {
    expect(wearVisual(2_000 / 65_000)).toBeGreaterThanOrEqual(0.15);
  });

  it('Given a wear below 0, -Infinity or NaN, Then the look is 0; above 1 or +Infinity, Then 1', () => {
    expect(wearVisual(-0.5)).toBe(0);
    expect(wearVisual(-1e-9)).toBe(0);
    expect(wearVisual(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(wearVisual(Number.NaN)).toBe(0);
    expect(wearVisual(1.5)).toBe(1);
    expect(wearVisual(1 + 1e-9)).toBe(1);
    expect(wearVisual(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
