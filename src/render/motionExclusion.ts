/**
 * Render-space spheres the ground-referenced motion blur leaves sharp
 * (v3 T4, PLAN E3). Pure packing; PostFX owns the shader side in a marked block.
 */

import type { Vector3 } from 'three';

export const MAX_MOTION_EXCLUSIONS = 4;
/** Radius padding: bounding radii are not exact and plumes extend aft. */
export const MOTION_EXCLUSION_PAD = 1.35;

export interface MotionExclusionSphere {
  readonly center: Vector3;
  readonly radiusKm: number;
}

/**
 * The live exclusion uniform PostFX reads (xyz centre, w radius, render space).
 * Written once per frame by Traffic, as `motionReference` is by its owner.
 */
export const motionExclusionBuffer = new Float32Array(MAX_MOTION_EXCLUSIONS * 4);

const order: number[] = [];
const dist: number[] = [];

/**
 * Write up to MAX_MOTION_EXCLUSIONS spheres (nearest to `cam` first) as
 * xyz = centre, w = padded radius into `out`; unused slots get w = 0.
 * Returns the count written. Allocation-free after warm-up.
 */
export function packMotionExclusions(
  spheres: ReadonlyArray<MotionExclusionSphere>,
  cam: Vector3,
  out: Float32Array,
): number {
  order.length = 0;
  dist.length = 0;
  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i]!;
    const c = s.center;
    if (!(s.radiusKm > 0) || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) continue;
    order.push(i);
    dist[i] = c.distanceToSquared(cam);
  }
  order.sort((a, b) => dist[a]! - dist[b]!);
  const n = Math.min(order.length, MAX_MOTION_EXCLUSIONS, Math.floor(out.length / 4));
  for (let k = 0; k < MAX_MOTION_EXCLUSIONS && k * 4 + 3 < out.length; k++) {
    if (k < n) {
      const s = spheres[order[k]!]!;
      out[k * 4] = s.center.x;
      out[k * 4 + 1] = s.center.y;
      out[k * 4 + 2] = s.center.z;
      out[k * 4 + 3] = s.radiusKm * MOTION_EXCLUSION_PAD;
    } else {
      out[k * 4 + 3] = 0;
    }
  }
  return n;
}
