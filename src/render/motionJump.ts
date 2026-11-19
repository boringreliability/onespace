/**
 * [v3-T1] When is a camera move a cut rather than motion?
 *
 * PostFX disabled motion blur when the camera moved more than 25 km in one
 * frame — a distance, so the same flight was "motion" at 30 fps and a "cut" at
 * 144 fps. This is the same threshold expressed as a speed.
 */

/** 25 km per 1/60 s, the v2 threshold at the frame rate it was tuned at. */
export const MOTION_JUMP_SPEED_KMS = 1500;
/** Shortest dt the threshold scales down to, s; a zero-dt frame still has a floor. */
export const MOTION_JUMP_MIN_DT = 1 / 240;

/** True when `displacementKm` over `dt` seconds is a teleport, not motion. */
export function motionJumped(
  displacementKm: number,
  dt: number,
  maxSpeedKmS: number = MOTION_JUMP_SPEED_KMS,
): boolean {
  const t = Number.isFinite(dt) && dt > MOTION_JUMP_MIN_DT ? dt : MOTION_JUMP_MIN_DT;
  return displacementKm > maxSpeedKmS * t;
}
