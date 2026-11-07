/**
 * The cruise drive field (v3 T4, PLAN E2): the warp's visual vocabulary at
 * about 5 %. Pure; `Sky.ts` consumes it.
 */

/** Speed of light, km/s. */
export const C_KMS = 299792.458;
/** Below this the drive is sublight (boosted sublight ceiling), km/s. */
const FIELD_FLOOR_KMS = 180;
/** The cruise drive's maximum cap (CruiseDrive maxCapKmS), km/s. */
const FIELD_CEIL_KMS = 1.5e8;
const LO = Math.log10(FIELD_FLOOR_KMS / C_KMS);
const HI = Math.log10(FIELD_CEIL_KMS / C_KMS);

/** β at full field: a star at 90° moves asin(0.3) ≈ 17.5° towards the apex. */
export const DRIVE_ABERRATION_MAX_BETA = 0.3;
/** Edge sheen at full field — "warp at ~5 %". */
export const DRIVE_SHEEN_MAX = 0.05;

/** 0..1, logarithmic in cap / c. */
export function driveFieldAmount(capKmS: number | null): number {
  if (capKmS === null || !Number.isFinite(capKmS) || capKmS <= FIELD_FLOOR_KMS) return 0;
  const t = (Math.log10(capKmS / C_KMS) - LO) / (HI - LO);
  return Math.min(1, Math.max(0, t));
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function driveAberrationBeta(amount: number): number {
  return clamp01(amount) * DRIVE_ABERRATION_MAX_BETA;
}

export function driveSheen(amount: number): number {
  return clamp01(amount) * DRIVE_SHEEN_MAX;
}

/** cosθ′ = (cosθ + β)/(1 + β cosθ). Mirrored in the star vertex shader. */
export function aberrateCos(cosTheta: number, beta: number): number {
  const c = Math.min(1, Math.max(-1, cosTheta));
  const r = (c + beta) / (1 + beta * c);
  return Math.min(1, Math.max(-1, r));
}
