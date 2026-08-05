/**
 * Floating origin.
 *
 * float32 has ~7 significant decimal digits. A vertex 150 million km from the
 * origin therefore snaps to a grid roughly 10 km wide — the ship would visibly
 * vibrate. The fix used by every large-scale space renderer: keep the camera
 * near (0,0,0) in render space and translate the world instead.
 *
 * Positions in `gen/types.ts` are *world* coordinates (float64). Anything
 * uploaded to the GPU must be converted with `toRender()` first.
 */

import { Vector3 } from 'three';

export class FloatingOrigin {
  /** Current world-space offset applied to everything the renderer sees. */
  readonly offset = new Vector3();

  /** Rebase once the camera drifts this far (km) from render-space zero. */
  private readonly threshold: number;

  /** Incremented on every rebase so caches know their transforms went stale. */
  version = 0;

  constructor(threshold = 10_000) {
    this.threshold = threshold;
  }

  /**
   * Move the origin to the camera if it has drifted too far.
   * Returns the delta that must be subtracted from every render-space object,
   * or null when no rebase happened this frame.
   */
  rebaseIfNeeded(cameraRenderPosition: Vector3, out = new Vector3()): Vector3 | null {
    if (cameraRenderPosition.lengthSq() < this.threshold * this.threshold) return null;
    out.copy(cameraRenderPosition);
    this.offset.add(out);
    this.version++;
    return out;
  }

  /** Force the origin to a specific world position (used on warp arrival). */
  setTo(worldPosition: Vector3): void {
    this.offset.copy(worldPosition);
    this.version++;
  }

  /** World (float64, huge) → render (float32-safe, near zero). */
  toRender(world: Vector3, out = new Vector3()): Vector3 {
    return out.copy(world).sub(this.offset);
  }

  /** Render → world. */
  toWorld(render: Vector3, out = new Vector3()): Vector3 {
    return out.copy(render).add(this.offset);
  }

  /** Same as toRender but for a raw triple, avoiding a Vector3 allocation. */
  toRenderXYZ(x: number, y: number, z: number, out = new Vector3()): Vector3 {
    return out.set(x - this.offset.x, y - this.offset.y, z - this.offset.z);
  }
}
