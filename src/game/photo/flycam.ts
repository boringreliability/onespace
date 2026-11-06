/**
 * Photo mode's free camera — pure state and step, no three.
 *
 * Velocity eases toward the commanded velocity with time constant `tau`
 * (ARCHITECTURE §6: nothing snaps). Position is integrated EXACTLY for that
 * exponential approach rather than with an Euler step:
 *
 *   v(t) = vT + (v0 − vT)·e^(−t/τ)
 *   x(t) = x0 + vT·t + (v0 − vT)·τ·(1 − e^(−t/τ))
 *
 * so the camera ends in the same place at 30 Hz and at 144 Hz. An Euler step
 * would drift by ~dt/τ — several percent at 30 Hz.
 */

export const FLYCAM_DEFAULTS = {
  /** Cruise speed, km/s. 50 m/s frames a 30 m hull comfortably. */
  speedKmS: 0.05,
  /** Multiplier while "fast" is held — enough to frame a planet. */
  fastMultiplier: 40,
  tau: 0.25,
  /** Radians per pixel of look input. */
  lookSensitivity: 0.0025,
  /** Degrees per unit of zoom input. */
  zoomDegPerUnit: 0.02,
  minFov: 10,
  maxFov: 90,
  /** Pitch stops this far short of the pole: no gimbal flip at the zenith. */
  pitchMargin: 0.01,
} as const;

export type Vec3 = [number, number, number];

export interface FlyCamState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  fov: number;
}

export interface FlyCamInput {
  /** Camera-local move intent, each in −1..1: right, up, back (+Z is back). */
  readonly move: readonly [number, number, number];
  readonly lookDx: number;
  readonly lookDy: number;
  readonly zoom: number;
  readonly fast: boolean;
}

export function createFlyCam(position: Vec3, yaw: number, pitch: number, fov: number): FlyCamState {
  return { position: [...position], velocity: [0, 0, 0], yaw, pitch, fov };
}

export function stepFlyCam(c: FlyCamState, input: FlyCamInput, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  const d = FLYCAM_DEFAULTS;

  c.yaw -= input.lookDx * d.lookSensitivity;
  const limit = Math.PI / 2 - d.pitchMargin;
  c.pitch = Math.min(limit, Math.max(-limit, c.pitch - input.lookDy * d.lookSensitivity));
  c.fov = Math.min(d.maxFov, Math.max(d.minFov, c.fov + input.zoom * d.zoomDegPerUnit));

  // Camera basis, yaw about world Y then pitch: forward is −Z at yaw = 0.
  const cy = Math.cos(c.yaw);
  const sy = Math.sin(c.yaw);
  const cp = Math.cos(c.pitch);
  const sp = Math.sin(c.pitch);
  const fwd: Vec3 = [-sy * cp, sp, -cy * cp];
  const right: Vec3 = [cy, 0, -sy];

  const speed = d.speedKmS * (input.fast ? d.fastMultiplier : 1);
  const [mx, my, mz] = input.move;
  // move[2] is +back, so forward contribution is −mz.
  const target: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    target[i] = (right[i]! * mx + (i === 1 ? my : 0) - fwd[i]! * mz) * speed;
  }

  const k = Math.exp(-dt / d.tau);
  for (let i = 0; i < 3; i++) {
    const v0 = c.velocity[i]!;
    const vt = target[i]!;
    c.position[i] = c.position[i]! + vt * dt + (v0 - vt) * d.tau * (1 - k);
    c.velocity[i] = vt + (v0 - vt) * k;
  }
}

export interface Grade {
  readonly exposure?: number;
  readonly grain?: number;
  readonly ca?: number;
  readonly vignette?: number;
}

const GRADE_RANGE: Record<keyof Grade, readonly [number, number]> = {
  exposure: [0.1, 4],
  grain: [0, 0.2],
  ca: [0, 0.02],
  vignette: [0, 1],
};

/** Clamp every field into a safe range; drop non-finite ones entirely. */
export function clampGrade(g: Grade): Grade {
  const out: { -readonly [K in keyof Grade]: number } = {};
  for (const key of Object.keys(GRADE_RANGE) as Array<keyof Grade>) {
    const v = g[key];
    if (v === undefined || !Number.isFinite(v)) continue;
    const [lo, hi] = GRADE_RANGE[key];
    out[key] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}
