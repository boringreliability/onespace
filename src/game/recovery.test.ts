/**
 * The safety net: where the ship is put back after it has hit something, and
 * which way it faces when it gets there.
 *
 * Three properties carry the whole feature, and all three fail silently:
 *   - the respawn orbit is CIRCULAR (speed √(μ/r), velocity ⟂ radius) — a few
 *     percent off and the player is "recovered" into a slow decay back into
 *     the ground they just hit;
 *   - the nose is PROGRADE — the old spawn pointed it at the planet's centre,
 *     so the first press of W was a dive;
 *   - the star is solid — before this you could fly through the photosphere.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import {
  RESPAWN_ALTITUDE_RADII,
  circularOrbitState,
  insideStar,
  progradeAttitude,
} from './recovery';
import { SOLAR_RADIUS } from '@/gen/types';

/** Earth-ish: radius 6371 km, μ 398600 km³/s². */
const R = 6371;
const MU = 398600.4418;

const nose = (q: Quaternion): Vector3 => new Vector3(0, 0, -1).applyQuaternion(q);
const upOf = (q: Quaternion): Vector3 => new Vector3(0, 1, 0).applyQuaternion(q);

describe('circularOrbitState — the respawn state vector', () => {
  it('Given a crash site, When recovering, Then the ship is placed 0.6 R above the surface', () => {
    const s = circularOrbitState(new Vector3(1, 0.2, -0.4), R, MU);
    expect(RESPAWN_ALTITUDE_RADII).toBeCloseTo(0.6, 9);
    expect(s.position.length()).toBeCloseTo(R * (1 + RESPAWN_ALTITUDE_RADII), 6);
  });

  it('Given a crash site, When recovering, Then the ship is placed directly above it', () => {
    const site = new Vector3(3, -2, 5);
    const s = circularOrbitState(site, R, MU);
    expect(s.position.clone().normalize().dot(site.clone().normalize())).toBeCloseTo(1, 9);
  });

  it('Given any radial, When recovering, Then the speed is exactly circular, √(μ/r)', () => {
    for (const dir of [
      new Vector3(1, 0, 0),
      new Vector3(0, 0, -1),
      new Vector3(0.3, 0.9, 0.1),
      new Vector3(-2, -1, 4),
    ]) {
      const s = circularOrbitState(dir, R, MU);
      const r = s.position.length();
      expect(s.velocity.length()).toBeCloseTo(Math.sqrt(MU / r), 9);
    }
  });

  it('Given any radial, When recovering, Then the velocity is perpendicular to the radius', () => {
    for (const dir of [new Vector3(1, 0, 0), new Vector3(0.3, 0.9, 0.1), new Vector3(-2, -1, 4)]) {
      const s = circularOrbitState(dir, R, MU);
      expect(s.velocity.clone().normalize().dot(s.position.clone().normalize())).toBeCloseTo(0, 9);
    }
  });

  it('Given a crash at the pole (radial along world up), When recovering, Then the orbit is still well formed', () => {
    const s = circularOrbitState(new Vector3(0, 1, 0), R, MU);
    expect(Number.isFinite(s.velocity.x + s.velocity.y + s.velocity.z)).toBe(true);
    expect(s.velocity.length()).toBeCloseTo(Math.sqrt(MU / s.position.length()), 9);
    expect(s.velocity.dot(s.position)).toBeCloseTo(0, 6);
  });

  it('Given a degenerate radial (the zero vector), When recovering, Then a fallback direction is used, not NaN', () => {
    const s = circularOrbitState(new Vector3(0, 0, 0), R, MU);
    expect(s.position.length()).toBeCloseTo(R * 1.6, 6);
    expect(Number.isNaN(s.velocity.length())).toBe(false);
    expect(s.velocity.length()).toBeGreaterThan(0);
  });

  it('Given a radial in the ecliptic, When recovering, Then the orbit stays in the ecliptic (as spawning does)', () => {
    const s = circularOrbitState(new Vector3(1, 0, 0), R, MU);
    expect(s.velocity.y).toBeCloseTo(0, 9);
  });

  it('Given a recovery, When it is placed, Then the nose points prograde and the roof points away from the world', () => {
    const s = circularOrbitState(new Vector3(0.4, 0.3, -1), R, MU);
    expect(nose(s.orientation).dot(s.velocity.clone().normalize())).toBeCloseTo(1, 6);
    expect(upOf(s.orientation).dot(s.position.clone().normalize())).toBeCloseTo(1, 6);
  });

  it('Given the caller passes its own radial vector, When recovering, Then that vector is not mutated', () => {
    const site = new Vector3(3, 4, 0);
    circularOrbitState(site, R, MU);
    expect(site.toArray()).toEqual([3, 4, 0]);
  });
});

describe('progradeAttitude — the spawn orientation', () => {
  /** The arrival geometry Universe uses: 1.6 R, offset towards the star, lifted. */
  const pos = new Vector3(-1, 0.35, -0.2).normalize().multiplyScalar(R * 1.6);
  const vel = new Vector3(0, 1, 0).cross(pos).normalize().multiplyScalar(Math.sqrt(MU / pos.length()));

  it('Given the arrival state vector, When the attitude is built, Then the nose is along the velocity', () => {
    const q = progradeAttitude(vel, pos);
    expect(nose(q).dot(vel.clone().normalize())).toBeCloseTo(1, 6);
  });

  it('Given the arrival state vector, When the attitude is built, Then the nose does NOT point at the planet centre', () => {
    const q = progradeAttitude(vel, pos);
    const towardCentre = pos.clone().normalize().negate();
    // The old spawn had this at exactly 1. Prograde in a circular orbit is 0.
    expect(nose(q).dot(towardCentre)).toBeCloseTo(0, 6);
  });

  it('Given the arrival state vector, When the attitude is built, Then the roof points radially out (horizon level)', () => {
    const q = progradeAttitude(vel, pos);
    expect(upOf(q).dot(pos.clone().normalize())).toBeCloseTo(1, 6);
  });

  it('Given an up hint that is parallel to the velocity, When the attitude is built, Then it is still a unit quaternion with the nose prograde', () => {
    const v = new Vector3(0, 0, -5);
    const q = progradeAttitude(v, new Vector3(0, 0, 1));
    expect(q.length()).toBeCloseTo(1, 9);
    expect(nose(q).dot(new Vector3(0, 0, -1))).toBeCloseTo(1, 6);
  });

  it('Given a zero velocity, When the attitude is built, Then it is finite (identity-like), not NaN', () => {
    const q = progradeAttitude(new Vector3(), new Vector3(0, 1, 0));
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
    expect(q.length()).toBeCloseTo(1, 9);
  });
});

describe('insideStar — the photosphere is solid', () => {
  const sunRadiusKm = 1 * SOLAR_RADIUS;

  it('Given the ship well outside the star, Then there is no contact', () => {
    expect(insideStar(sunRadiusKm * 3, sunRadiusKm)).toBe(false);
  });

  it('Given the ship just above the photosphere, Then there is no contact', () => {
    expect(insideStar(sunRadiusKm * 1.0001, sunRadiusKm)).toBe(false);
  });

  it('Given the ship at or below the photosphere, Then it is in contact', () => {
    expect(insideStar(sunRadiusKm, sunRadiusKm)).toBe(true);
    expect(insideStar(sunRadiusKm * 0.5, sunRadiusKm)).toBe(true);
    expect(insideStar(0, sunRadiusKm)).toBe(true);
  });

  it('Given a star with no radius (headless / unknown), Then nothing is ever inside it', () => {
    expect(insideStar(0, 0)).toBe(false);
    expect(insideStar(10, Number.NaN)).toBe(false);
  });
});
