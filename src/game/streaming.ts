/**
 * Which bodies get full renderers — pure, so the hysteresis can be tested.
 *
 * Two thresholds, in each body's own radii. A body is acquired inside
 * `STREAM_ACQUIRE_RADII` and kept until it is beyond `STREAM_RELEASE_RADII`.
 * With one threshold a ship loitering on the boundary rebuilt a planet — its
 * quadtree, its shaders, its cloud shell — on every crossing, and each rebuild
 * is a compile hitch of hundreds of milliseconds.
 *
 * Beyond the acquire distance a world is a few pixels across; a full quadtree
 * for a dot is waste.
 */

export const STREAM_ACQUIRE_RADII = 60;
export const STREAM_RELEASE_RADII = 75;

export interface StreamCandidate {
  readonly distanceKm: number;
  readonly radiusKm: number;
  /** Whether it currently has renderers. */
  readonly streamed: boolean;
}

/**
 * Returns, per candidate in input order, whether it should have renderers.
 * Only the `budget` closest eligible candidates are wanted.
 *
 * Runs every frame, so it allocates nothing when handed `out` (ARCHITECTURE
 * §5): the result is written into it, resized to fit. Selection is a repeated
 * nearest-scan, O(budget × n) — both are single digits to a few dozen. Ties
 * go to the earlier candidate, so equal distances never flicker.
 */
export function planStreaming(
  candidates: readonly StreamCandidate[],
  budget: number,
  out: boolean[] = [],
): boolean[] {
  const n = candidates.length;
  out.length = n;
  out.fill(false);

  for (let k = 0; k < budget; k++) {
    let best = -1;
    let bestKm = Infinity;
    for (let i = 0; i < n; i++) {
      if (out[i]) continue;
      const c = candidates[i]!;
      const limit = (c.streamed ? STREAM_RELEASE_RADII : STREAM_ACQUIRE_RADII) * c.radiusKm;
      if (c.distanceKm < limit && c.distanceKm < bestKm) {
        best = i;
        bestKm = c.distanceKm;
      }
    }
    if (best < 0) break;
    out[best] = true;
  }
  return out;
}
