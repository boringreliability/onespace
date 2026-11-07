/**
 * Flight-instrument maths — pure, so the numbers the pilot lands by are tested.
 *
 * Covers GAMEPLAY F1 (prograde/retrograde), F2 (VSI, time-to-impact, ALT over
 * terrain), F9 (title names the wrong body) and F11 (ALT names its body).
 */

import type { Camera, Vector3 } from 'three';

/** Sink slower than this is "level" — no impact countdown; 0.1 m/s. */
export const LEVEL_VS_KMS = 1e-4;
/**
 * Below this the velocity direction is noise: parked on a pad the vector
 * wanders with every substep of ground contact. 0.5 m/s.
 */
export const MARKER_MIN_SPEED_KMS = 5e-4;
/** The altimeter's reach, in the body's own radii — same as Universe's. */
export const ALT_RANGE_RADII = 40;

export interface VerticalReadout {
  /** km/s along the local vertical; positive is climbing. */
  vsiKmS: number;
  /** Seconds to ground at the current sink rate, or null. */
  ttiS: number | null;
}

/**
 * VSI and time-to-impact at a constant sink rate. No gravity term on purpose:
 * in orbit the gravity-only estimate predicts an impact that the orbit never
 * delivers, and near the ground — where the number matters — the constant-rate
 * figure is within a second of the truth.
 */
export function verticalReadout(
  vsKmS: number,
  altKm: number | null,
  grounded: boolean,
  out: VerticalReadout = { vsiKmS: 0, ttiS: null },
): VerticalReadout {
  if (grounded) {
    out.vsiKmS = 0;
    out.ttiS = null;
    return out;
  }
  out.vsiKmS = vsKmS;
  out.ttiS = altKm !== null && vsKmS < -LEVEL_VS_KMS ? Math.max(0, altKm) / -vsKmS : null;
  return out;
}

export interface AltitudeInput {
  /** The body whose frame the ship flies in, or null for the star. */
  readonly parentName: string | null;
  /** `flight.altitude` — terrain when a sampler is installed, else the sphere. */
  readonly parentAltKm: number;
  readonly parentRadiusKm: number;
  readonly nearestName: string | null;
  /** `universe.nearestAltitudeKm` — sphere, already null beyond range. */
  readonly nearestAltKm: number | null;
}

export interface AltitudeReadout {
  altitudeKm: number;
  bodyName: string;
}

/**
 * Prefer the parent: VEL is measured against it, so ALT measured against it
 * too means the two numbers are about the same world, and it is the only body
 * with a terrain sampler. Fall back to the nearest body otherwise.
 */
export function pickAltitude(i: AltitudeInput): AltitudeReadout | null {
  if (
    i.parentName !== null &&
    Number.isFinite(i.parentAltKm) &&
    i.parentAltKm < i.parentRadiusKm * ALT_RANGE_RADII
  ) {
    return { altitudeKm: i.parentAltKm, bodyName: i.parentName };
  }
  if (i.nearestName !== null && i.nearestAltKm !== null) {
    return { altitudeKm: i.nearestAltKm, bodyName: i.nearestName };
  }
  return null;
}

export interface AltitudeContext {
  /** What ALT shows — `pickAltitude`'s choice, unchanged from v2 (F11). */
  alt: AltitudeReadout | null;
  /** VEL's frame, named only when it is not the body ALT names. */
  velFrame: string | null;
  /** A different body whose surface is nearer than the ALT body's. */
  proximity: AltitudeReadout | null;
  /** V/S and impact run along the parent's vertical: meaningful only when ALT is the parent. */
  verticalApplies: boolean;
}

/**
 * Make ALT and VEL say what they measure (v3 F). `frameName` is what VEL is
 * relative to: the parent, or the system's star in the star frame.
 */
export function altitudeContext(i: AltitudeInput, frameName: string): AltitudeContext {
  const alt = pickAltitude(i);
  const velFrame = alt !== null && alt.bodyName === frameName ? null : frameName;
  let proximity: AltitudeReadout | null = null;
  if (
    alt !== null &&
    i.nearestName !== null &&
    i.nearestAltKm !== null &&
    i.nearestName !== alt.bodyName &&
    i.nearestAltKm < alt.altitudeKm
  ) {
    proximity = { altitudeKm: i.nearestAltKm, bodyName: i.nearestName };
  }
  const verticalApplies = alt !== null && i.parentName !== null && alt.bodyName === i.parentName;
  return { alt, velFrame, proximity, verticalApplies };
}

/**
 * V/S and time-to-impact are shown only with a parent to measure against and
 * while the cruise drive is idle (review-v3b): under cruise "vertical" speed
 * is the drive's 10^3-10^5 km/s along whatever the nose points at, and the
 * impact countdown runs towards a world the drive drops out in front of.
 */
export function verticalShown(hasParent: boolean, cruisePhase: 'idle' | 'spooling' | 'cruise' | 'dropping'): boolean {
  return hasParent && cruisePhase === 'idle';
}

/**
 * The title names where the ship IS — its parent — not whichever renderer was
 * streamed in last (that was the moon, every time the moon was acquired after
 * the planet).
 */
export function locationLabel(systemName: string, parentName: string | null): string {
  return parentName ?? systemName;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** In front of the camera's near side or not; behind = mirrored projection. */
  behind: boolean;
}

/**
 * Project a render-space point (w = 1) or a direction (w = 0) to CSS pixels,
 * top-left origin. A direction ignores the camera's translation, which is what
 * a velocity marker is: a point at infinity. Behind the camera the result is
 * the mirrored projection, flagged, which is what the HUD's edge clamp expects.
 * Allocation-free.
 */
export function projectToScreen(
  x: number,
  y: number,
  z: number,
  w: number,
  camera: Camera,
  width: number,
  height: number,
  out: ScreenPoint,
): ScreenPoint {
  const v = camera.matrixWorldInverse.elements;
  // View space (column-major).
  const vx = v[0]! * x + v[4]! * y + v[8]! * z + v[12]! * w;
  const vy = v[1]! * x + v[5]! * y + v[9]! * z + v[13]! * w;
  const vz = v[2]! * x + v[6]! * y + v[10]! * z + v[14]! * w;
  const vw = v[3]! * x + v[7]! * y + v[11]! * z + v[15]! * w;
  const p = camera.projectionMatrix.elements;
  const cx = p[0]! * vx + p[4]! * vy + p[8]! * vz + p[12]! * vw;
  const cy = p[1]! * vx + p[5]! * vy + p[9]! * vz + p[13]! * vw;
  const cw = p[3]! * vx + p[7]! * vy + p[11]! * vz + p[15]! * vw;
  // For a direction cw is -vz (perspective), which is the right divisor; keep
  // it away from zero so a point exactly abeam does not become Infinity.
  const iw = 1 / (Math.abs(cw) < 1e-12 ? 1e-12 : Math.abs(cw));
  out.behind = cw <= 0;
  out.x = (cx * iw * 0.5 + 0.5) * width;
  out.y = (0.5 - cy * iw * 0.5) * height;
  return out;
}

/**
 * Unit prograde and retrograde from a parent-relative velocity. False (and the
 * outputs untouched) when the ship is too slow for a direction to mean anything.
 */
export function velocityMarkers(velocity: Vector3, prograde: Vector3, retrograde: Vector3): boolean {
  const s = velocity.length();
  if (s < MARKER_MIN_SPEED_KMS) return false;
  prograde.copy(velocity).divideScalar(s);
  retrograde.copy(prograde).negate();
  return true;
}
