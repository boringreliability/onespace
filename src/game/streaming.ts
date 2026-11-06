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
 */
export function planStreaming(candidates: readonly StreamCandidate[], budget: number): boolean[] {
  const out = new Array<boolean>(candidates.length).fill(false);
  if (budget <= 0) return out;

  const eligible: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const limit = (c.streamed ? STREAM_RELEASE_RADII : STREAM_ACQUIRE_RADII) * c.radiusKm;
    if (c.distanceKm < limit) eligible.push(i);
  }
  eligible.sort((a, b) => candidates[a]!.distanceKm - candidates[b]!.distanceKm);
  for (let k = 0; k < Math.min(budget, eligible.length); k++) out[eligible[k]!] = true;
  return out;
}
