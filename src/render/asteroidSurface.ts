/**
 * An asteroid's surface from its composition (v4 sub-plan 2; final review I1) — pure.
 *
 * The shader lights a rock as
 *
 *   c = sun · (albedo · (ndl + amb) + specColor · spec · blinn)
 *   specColor = mix(vec3(1), albedo / max(albedo), metalness)
 *
 * so a metal's highlight is tinted by its own albedo (F0 ≈ albedo) and every
 * highlight stays within ~1.5× of the diffuse it sits on. The old metal (albedo
 * 0.15, white spec 0.55 at exponent 24) opened the centre-weighted iris and
 * then clipped through ACES as a soft white disc.
 *
 * Mass fractions mix the three looks; rare ores read as metal; an empty
 * composition reads as silicate.
 */

import type { Resource } from '@/gen/belt';

/** Blinn exponent of the highlight: tight, so the shape stays readable. */
export const ASTEROID_SPEC_EXPONENT = 56;

interface Look {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly spec: number;
}

/** Linear albedo and specular strength per look. */
const ICE: Look = { r: 0.55, g: 0.62, b: 0.7, spec: 0.12 };
const METAL: Look = { r: 0.3, g: 0.29, b: 0.28, spec: 0.15 };
const SILICATE: Look = { r: 0.3, g: 0.26, b: 0.22, spec: 0.04 };

export interface AsteroidSurface {
  /** Linear diffuse albedo. */
  readonly albedo: readonly [number, number, number];
  /** Specular strength (the highlight peak before specColor). */
  readonly spec: number;
  /** 0 dielectric (white highlight) … 1 metal (highlight tinted by the albedo). */
  readonly metalness: number;
  /** mix(1, albedo / max(albedo), metalness). */
  readonly specColor: readonly [number, number, number];
}

export function asteroidSurface(c: Readonly<Record<Resource, number>>): AsteroidSurface {
  const ice = Math.max(0, c.ice) || 0;
  const metal = (Math.max(0, c.metal) || 0) + (Math.max(0, c.rare) || 0);
  const sil = Math.max(0, c.silicate) || 0;
  const sum = ice + metal + sil;
  const fi = sum > 0 ? ice / sum : 0;
  const fm = sum > 0 ? metal / sum : 0;
  const fs = sum > 0 ? sil / sum : 1;
  const r = fi * ICE.r + fm * METAL.r + fs * SILICATE.r;
  const g = fi * ICE.g + fm * METAL.g + fs * SILICATE.g;
  const b = fi * ICE.b + fm * METAL.b + fs * SILICATE.b;
  const spec = fi * ICE.spec + fm * METAL.spec + fs * SILICATE.spec;
  const max = Math.max(r, g, b);
  const tint = (x: number): number => 1 - fm + fm * (x / max);
  return { albedo: [r, g, b], spec, metalness: fm, specColor: [tint(r), tint(g), tint(b)] };
}
