/**
 * What the scanner locks onto — pure.
 *
 * The target if there is one; else the world under (or near) the reticle;
 * else the world you are orbiting. A vessel is scanned only as a target: the
 * old "any hull within 400 km wins" rule made the spawn world unscannable
 * whenever traffic was co-orbiting (GAMEPLAY F3).
 */

/** Slack around a body's disc for "under the reticle": a dot needs a margin. */
export const RETICLE_MARGIN_RAD = (3 * Math.PI) / 180;

export interface ScanBody {
  readonly id: string;
  /** Angle between the nose and the body's centre. */
  readonly angleRad: number;
  /** Half the angle the disc subtends. */
  readonly angularRadiusRad: number;
  readonly distanceKm: number;
  /** Within the array's reach. */
  readonly inRange: boolean;
}

export interface ScanChoiceInput {
  readonly target: { readonly id: string; readonly inRange: boolean } | null;
  readonly bodies: readonly ScanBody[];
  /** The ship's parent body id, or null in the star's frame. */
  readonly parentId: string | null;
}

export type ScanChoice =
  | { readonly kind: 'scan'; readonly id: string }
  | { readonly kind: 'out-of-range'; readonly id: string }
  | { readonly kind: 'none' };

export function chooseScanTarget(input: ScanChoiceInput): ScanChoice {
  const t = input.target;
  // An explicit target is never second-guessed: falling back to something else
  // would scan a thing the pilot did not ask for and not say why.
  if (t) return t.inRange ? { kind: 'scan', id: t.id } : { kind: 'out-of-range', id: t.id };

  // Under the reticle: the nearest one, because it occludes the rest.
  let best: ScanBody | null = null;
  for (const b of input.bodies) {
    if (!b.inRange) continue;
    if (b.angleRad > b.angularRadiusRad + RETICLE_MARGIN_RAD) continue;
    if (!best || b.distanceKm < best.distanceKm) best = b;
  }
  if (best) return { kind: 'scan', id: best.id };

  if (input.parentId !== null) {
    for (const b of input.bodies) {
      if (b.id === input.parentId && b.inRange) return { kind: 'scan', id: b.id };
    }
  }
  return { kind: 'none' };
}
