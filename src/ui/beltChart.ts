/**
 * The belt on the local chart (v4 sub-plan 2, Task 7) — the pure half.
 *
 * SystemMap draws SVG and does not run in node; the numbers it draws with
 * live here so they can be tested: the chart's log radial scale (moved out of
 * SystemMap so the ring and the orbits share it), the chart's outer radius
 * (which now includes the belt — a belt system with no planets still needs a
 * scale, R21), the annulus radii, and what selecting the BELT node targets.
 */

import { beltFor, fieldOrbits, nearestFieldIndex, type BeltSpec, type Vec3Like } from '@/gen/belt';
import { AU, type StarSystemSpec } from '@/gen/types';
import { beltFieldName } from '@/game/Belt';

/** Chart radius in viewBox units. The viewBox is square and centred on 0,0. */
export const CHART_R = 500;

/** Inner end of the log scale, km. Comfortably inside any star. */
const R_FLOOR_KM = 1e5;

/** Margin past the outermost thing drawn. */
const SCALE_MARGIN = 1.12;

/** log-scaled radius: km from the star to viewBox units. */
export function radial(km: number, maxKm: number): number {
  const r = Math.max(km, R_FLOOR_KM);
  const span = Math.log(Math.max(maxKm, R_FLOOR_KM * 10) / R_FLOOR_KM);
  return CHART_R * Math.min(1, Math.log(r / R_FLOOR_KM) / span);
}

/**
 * The chart's outer radius, km: the furthest planet apoapsis (at least 1 AU),
 * or the belt's outer edge if that is further, plus the margin.
 */
export function chartMaxKm(sys: StarSystemSpec): number {
  const planets =
    sys.planets.reduce((m, p) => Math.max(m, p.orbit.semiMajorAxis * (1 + p.orbit.eccentricity)), AU) * SCALE_MARGIN;
  const belt = beltFor(sys);
  return belt ? Math.max(planets, belt.outerAU * AU * SCALE_MARGIN) : planets;
}

/** The belt's annulus on the chart: inner and outer radius in viewBox units. */
export function beltRing(belt: BeltSpec, maxKm: number): { inner: number; outer: number } {
  return { inner: radial(belt.innerAU * AU, maxKm), outer: radial(belt.outerAU * AU, maxKm) };
}

export { beltFieldName };

/**
 * What selecting the BELT node emits on `target:changed`: the field nearest
 * the ship at `orbitSeconds`. Null for a system without a belt.
 */
export function beltNodeTarget(
  sys: StarSystemSpec,
  shipWorld: Vec3Like,
  orbitSeconds: number,
): { id: string; name: string } | null {
  const belt = beltFor(sys);
  if (!belt) return null;
  const k = nearestFieldIndex(fieldOrbits(belt, sys.seed), shipWorld, orbitSeconds);
  return { id: `field:${belt.systemId}:${k}`, name: beltFieldName(sys.name, k) };
}
