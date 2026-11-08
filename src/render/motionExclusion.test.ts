/**
 * v3 T4 / PLAN E3 — traffic is excluded from the ground-referenced blur.
 *
 * PostFX's motion blur reprojects every pixel as if it were the ground below
 * (render/motionReference.ts). A co-orbiting hull moves with the player, not
 * with the ground, so it was smeared as if it flew 5 km/s (audit V2). Without
 * a velocity buffer, the cheapest honest fix is a handful of render-space
 * spheres the blur skips: a reconstructed pixel inside one is left sharp.
 * This packs them into the uniform.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { MAX_MOTION_EXCLUSIONS, MOTION_EXCLUSION_PAD, packMotionExclusions } from './motionExclusion';

const s = (x: number, y: number, z: number, radiusKm: number) => ({ center: new Vector3(x, y, z), radiusKm });

describe('packMotionExclusions', () => {
  it('Given no spheres, Then the count is 0 and every slot is disabled (w = 0)', () => {
    const out = new Float32Array(MAX_MOTION_EXCLUSIONS * 4).fill(9);
    expect(packMotionExclusions([], new Vector3(), out)).toBe(0);
    for (let i = 0; i < MAX_MOTION_EXCLUSIONS; i++) expect(out[i * 4 + 3]).toBe(0);
  });

  it('Given one hull, Then its centre is packed and the radius is padded (the plume and the bounds are not exact)', () => {
    const out = new Float32Array(MAX_MOTION_EXCLUSIONS * 4);
    expect(packMotionExclusions([s(1, 2, 3, 0.4)], new Vector3(), out)).toBe(1);
    expect([out[0], out[1], out[2]]).toEqual([1, 2, 3]);
    expect(out[3]).toBeCloseTo(0.4 * MOTION_EXCLUSION_PAD, 6);
    expect(MOTION_EXCLUSION_PAD).toBeGreaterThan(1);
  });

  it('Given more hulls than slots, Then the nearest to the camera win', () => {
    const out = new Float32Array(MAX_MOTION_EXCLUSIONS * 4);
    const many = [s(900, 0, 0, 0.3), s(5, 0, 0, 0.3), s(400, 0, 0, 0.3), s(2, 0, 0, 0.3), s(50, 0, 0, 0.3), s(10, 0, 0, 0.3)];
    expect(packMotionExclusions(many, new Vector3(), out)).toBe(MAX_MOTION_EXCLUSIONS);
    const xs = [];
    for (let i = 0; i < MAX_MOTION_EXCLUSIONS; i++) xs.push(out[i * 4]);
    expect(xs).not.toContain(900);
    expect(xs).toContain(2);
    expect(xs).toContain(5);
  });

  it('Given a sphere with no radius or a non-finite centre, Then it is skipped', () => {
    const out = new Float32Array(MAX_MOTION_EXCLUSIONS * 4);
    expect(packMotionExclusions([s(1, 1, 1, 0), s(Number.NaN, 0, 0, 1)], new Vector3(), out)).toBe(0);
  });

  it('Given the slot count, Then it is small (a uniform array, a few ALU per pixel)', () => {
    expect(MAX_MOTION_EXCLUSIONS).toBeGreaterThanOrEqual(2);
    expect(MAX_MOTION_EXCLUSIONS).toBeLessThanOrEqual(8);
  });
});
