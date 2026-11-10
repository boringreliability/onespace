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
 */

import { describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';

import { ASTEROID_SPEC_EXPONENT, asteroidSurface } from './asteroidSurface';

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
