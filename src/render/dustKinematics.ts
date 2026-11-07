/**
 * Orbital dust — the pure kinematics (v3 T4, PLAN E1). See the test for the
 * reasoning; `Dust.ts` is the renderer that consumes this.
 *
 * The dust lives in the LOCAL CIRCULAR-ORBIT frame: a hypothetical particle on
 * a circular orbit through the ship's position, moving the way the ship is
 * moving horizontally. Coasting in orbit the ship and the dust agree and the
 * field is near still; a burn makes it stream in proportion to Δv. Inside an
 * atmosphere the reference is the co-rotating surface (ω × r) instead.
 *
 * Later tuning, noted (v3 T4 stage-1 Q1): a co-moving "free-falling" field —
 * a leaky integral of proper acceleration — would be still in ANY coast, not
 * only near-circular ones. Not done: the plan asks for the circular frame.
 */

import { Vector3 } from 'three';

/** Edge of the wrapping cube of dust around the camera, metres. */
export const DUST_CUBE_M = 400;
/** Instance count. One draw call. */
export const DUST_COUNT = 2400;
/** Exposure time a streak represents, seconds. */
export const DUST_SHUTTER_S = 1 / 30;
/** Longest streak drawn, metres — a cruise exit or a teleport is not a 5 km line. */
export const DUST_MAX_STREAK_M = 60;

const scratchH = new Vector3();

function finite3(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Velocity of the local dust frame, parent-relative km/s.
 *
 * @param r    ship position, parent-relative km
 * @param v    ship velocity, parent-relative km/s
 * @param mu   parent's gravitational parameter, km³/s²; null/0 = no parent
 * @param spin parent's angular velocity (rad/s, world axes) when the ship is
 *             inside its atmosphere; null in vacuum
 */
export function dustReferenceVelocity(
  r: Vector3,
  v: Vector3,
  mu: number | null,
  spin: Vector3 | null,
  out: Vector3,
): Vector3 {
  out.set(0, 0, 0);
  if (!finite3(r) || !finite3(v)) return out;
  if (spin && finite3(spin)) return out.crossVectors(spin, r);
  if (mu === null || !(mu > 0) || !Number.isFinite(mu)) return out;
  const rl = r.length();
  if (!(rl > 1e-9)) return out;
  // Horizontal part of the ship's velocity: the direction the circular orbit runs.
  const h = scratchH.copy(r).multiplyScalar(-v.dot(r) / (rl * rl)).add(v);
  const hs = h.length();
  if (!(hs > 1e-12)) return out;
  const vc = Math.sqrt(mu / rl);
  // Fade the reference out towards a hover, so its direction never flips in a
  // frame as the horizontal speed passes through zero (nothing snaps, §6).
  const w = smoothstep(0, 0.5 * vc, hs);
  return out.copy(h).multiplyScalar((vc * w) / hs);
}

/** Ship velocity relative to the dust frame, km/s. Writes and returns `out`. */
export function dustRelativeVelocity(
  r: Vector3,
  v: Vector3,
  mu: number | null,
  spin: Vector3 | null,
  out: Vector3,
): Vector3 {
  dustReferenceVelocity(r, v, mu, spin, out);
  if (!finite3(v)) return out.set(0, 0, 0);
  // No frame at all (no parent): nothing to stream against.
  if ((mu === null || !(mu > 0)) && !spin) return out.set(0, 0, 0);
  return out.subVectors(v, out);
}

/** Wrap into [-size/2, size/2). */
export function wrapToCube(x: number, size: number): number {
  const h = size / 2;
  let w = (x + h) % size;
  if (w < 0) w += size;
  const res = w - h;
  return res >= h ? -h : res;
}

/** Streak length, metres, for a relative speed in km/s over `shutterS`. */
export function streakLengthM(relSpeedKmS: number, shutterS: number, maxM = DUST_MAX_STREAK_M): number {
  if (!Number.isFinite(relSpeedKmS) || relSpeedKmS <= 0 || !(shutterS > 0)) return 0;
  return Math.min(maxM, relSpeedKmS * 1000 * shutterS);
}

/**
 * Where the dust field sits relative to the camera, metres, kept in [0, size).
 * Integrated from relative velocity only — there is no position input, so a
 * floating-origin rebase cannot reach it.
 */
export class DustDrift {
  readonly offsetM = new Vector3();
  constructor(readonly size = DUST_CUBE_M) {}

  advance(relKmS: Vector3, dt: number): void {
    if (!finite3(relKmS) || !Number.isFinite(dt) || dt <= 0) return;
    const s = this.size;
    const k = -1000 * dt; // the ship moves +v through the dust: the dust moves -v
    const o = this.offsetM;
    o.x = mod(o.x + relKmS.x * k, s);
    o.y = mod(o.y + relKmS.y * k, s);
    o.z = mod(o.z + relKmS.z * k, s);
  }
}

function mod(x: number, s: number): number {
  const m = x % s;
  const r = m < 0 ? m + s : m;
  return r >= s ? 0 : r;
}

export function dustEnabled(s: { readonly cruise: boolean; readonly warp: boolean }): boolean {
  return !s.cruise && !s.warp;
}

/**
 * Brightness of dust seen along a ray whose cosine to the star direction is
 * `cosToStar`. Fine dust scatters forward: bright looking towards the star,
 * all but gone looking away. Henyey-Greenstein, g = 0.7, normalised to 1.
 */
export function dustForwardScatter(cosToStar: number): number {
  const c = Math.min(1, Math.max(-1, Number.isFinite(cosToStar) ? cosToStar : -1));
  const g = 0.7;
  const hg = (x: number): number => (1 - g * g) / Math.pow(1 + g * g - 2 * g * x, 1.5);
  return Math.min(1, Math.max(0, hg(c) / hg(1)));
}

/** Cylindrical shadow of a body of `radiusKm` at the origin, star along `toStar`. */
export function inPlanetShadow(r: Vector3, toStar: Vector3, radiusKm: number): boolean {
  const along = r.dot(toStar) / Math.max(toStar.length(), 1e-12);
  if (along >= 0) return false;
  const perp2 = r.lengthSq() - along * along;
  return perp2 < radiusKm * radiusKm;
}
