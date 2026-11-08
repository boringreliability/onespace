/**
 * [v3-T1] Field of view policy (docs/v3/DECISIONS.md D0).
 *
 * - 88° horizontal at 16:9. Wider screens get more horizontal view at the
 *   same vertical (Hor+) until 100° horizontal, then the vertical narrows
 *   (Vert-). Narrower screens keep the 16:9 vertical.
 * - Breathing only from thrust (+4°) and cruise spool (+10°), horizontal
 *   degrees on top of the base. NEVER from orbital speed: there is no speed
 *   input here on purpose.
 * - Cockpit: never wider than 100° horizontal.
 */

export type FovMode = 'chase' | 'cockpit';

export interface FovInput {
  /** Viewport width / height. */
  readonly aspect: number;
  /** 0..1 engine output. */
  readonly thrustFrac: number;
  /** 0..1 cruise drive spool. */
  readonly cruiseSpool: number;
  readonly mode: FovMode;
}

export const REFERENCE_ASPECT = 16 / 9;
export const BASE_HFOV_DEG = 88;
export const HOR_PLUS_MAX_HFOV_DEG = 100;
export const COCKPIT_MAX_HFOV_DEG = 100;
export const THRUST_BREATH_DEG = 4;
export const CRUISE_BREATH_DEG = 10;

/** Horizontal fov (deg) of a vertical fov (deg) at an aspect. */
export function hfovFromVfov(vfovDeg: number, aspect: number): number {
  const t = Math.tan((vfovDeg * Math.PI) / 360) * aspect;
  return (Math.atan(t) * 360) / Math.PI;
}

/** Vertical fov (deg) of a horizontal fov (deg) at an aspect. */
export function vfovFromHfov(hfovDeg: number, aspect: number): number {
  const t = Math.tan((hfovDeg * Math.PI) / 360) / aspect;
  return (Math.atan(t) * 360) / Math.PI;
}

/** Vertical fov in degrees, what `PerspectiveCamera.fov` wants. */
export function fovPolicy(input: FovInput): number {
  const raw = input.aspect > 0 && Number.isFinite(input.aspect) ? input.aspect : REFERENCE_ASPECT;
  // [review-v3a] A screen narrower than 16:9 keeps the 16:9 vertical — at
  // rest AND breathing — so it is solved as 16:9. Breathing in horizontal
  // degrees at the real aspect zoomed a phone in portrait 66 % harder than
  // 16:9 (57 → 77° vertical on a cruise spool; 57 → 99° at 1:5).
  const aspect = raw < REFERENCE_ASPECT ? REFERENCE_ASPECT : raw;
  // The 16:9 vertical; Hor+ keeps it, until the horizontal reaches the cap.
  const vRef = vfovFromHfov(BASE_HFOV_DEG, REFERENCE_ASPECT);
  const hBase = Math.min(HOR_PLUS_MAX_HFOV_DEG, hfovFromVfov(vRef, aspect));
  const breath = THRUST_BREATH_DEG * unit(input.thrustFrac) + CRUISE_BREATH_DEG * unit(input.cruiseSpool);
  let h = hBase + breath;
  if (input.mode === 'cockpit') h = Math.min(COCKPIT_MAX_HFOV_DEG, h);
  return vfovFromHfov(h, aspect);
}

function unit(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0; // NaN → 0
}
