/**
 * Time compression (v2 phase 4, GAMEPLAY P6) — the pure half: the rate
 * ladder, when it is legal, and how a compressed frame is sliced. The wiring
 * is `game/TimeControl.ts`.
 *
 * LEGAL means nothing can happen that the pilot would need to react to:
 *
 * - on the ground with the engines idle, or
 * - in a STABLE orbit with the engines idle: bound (e < 1), apoapsis inside
 *   the parent's SOI, periapsis above the atmosphere and the terrain margin;
 * - never under cruise, during a jump, or while the autopilot flies (it
 *   burns, and the pilot must be able to take over at 1×).
 *
 * "Engines idle" is the spooled OUTPUT, not the lever: after X the main drive
 * still pushes for ~3 s while it spools down, and compressing that would
 * multiply a burn the pilot thinks is over.
 *
 * SLICING. `FlightModel.update()` discards anything beyond 8 substeps of
 * 1/120 s per call — the guard that stops a stalled frame becoming a burn. So
 * 100× cannot be "pass 100·dt": it would silently become ~4×. Universe
 * instead advances the simulation in slices of at most SIM_SLICE_S, each one
 * an ordinary `update()`; with one substep possibly left in the accumulator a
 * slice still fits under the ceiling, so the trajectory is substep-for-
 * substep the 1× one (tested). MAX_SIM_SECONDS_PER_FRAME is the time budget:
 * at 100× and 30 fps that is 400 substeps a frame, and a slower frame gets
 * less compression rather than a longer frame.
 */

import type { InputAxes } from '@/core/Input';

export const TIME_RATES = [1, 10, 100] as const;
export type TimeRate = (typeof TIME_RATES)[number];

/** One step along the ladder; clamps at both ends. */
export function stepTimeRate(rate: TimeRate, dir: 1 | -1): TimeRate {
  const i = TIME_RATES.indexOf(rate);
  const j = Math.max(0, Math.min(TIME_RATES.length - 1, (i < 0 ? 0 : i) + dir));
  return TIME_RATES[j]!;
}

/**
 * Longest slice handed to `FlightModel.update()`, s. 6 substeps: with up to
 * one substep carried in the accumulator it is 7 < 8, so nothing is clipped.
 */
export const SIM_SLICE_S = 1 / 20;

/** Most simulated time one frame may advance, s (100× at 30 fps). */
export const MAX_SIM_SECONDS_PER_FRAME = 100 / 30;

/**
 * Slice `dt · rate` into `out.count` equal slices of `out.slice` seconds. At
 * 1× with an engine-clamped dt (≤ 1/15 s) this is always one slice of exactly
 * dt, so the uncompressed path is unchanged.
 */
export function simSlices(
  dt: number,
  rate: number,
  out: { count: number; slice: number },
): { count: number; slice: number } {
  const r = rate > 1 ? rate : 1;
  const total = Math.min(Math.max(0, dt) * r, r > 1 ? MAX_SIM_SECONDS_PER_FRAME : Number.POSITIVE_INFINITY);
  if (!(total > 0)) {
    // One empty slice, not none: a dt = 0 frame (photo mode) has always run
    // the update once — orbits, readouts and render extrapolation refresh.
    out.count = 1;
    out.slice = 0;
    return out;
  }
  if (r === 1) {
    // Bit-for-bit the old path: one update of exactly dt.
    out.count = 1;
    out.slice = total;
    return out;
  }
  const n = Math.ceil(total / SIM_SLICE_S);
  out.count = n;
  out.slice = total / n;
  return out;
}

export interface CompressionInputs {
  readonly hasWorld: boolean;
  readonly grounded: boolean;
  readonly cruising: boolean;
  readonly warpIdle: boolean;
  readonly autopilotActive: boolean;
  /** Spooled main-drive output, 0..1. */
  readonly engineOutput: number;
  /** No lever, strafe, brake or boost in the command. */
  readonly commandIdle: boolean;
  /** Distances from the parent's centre, km. */
  readonly periapsisKm: number;
  readonly apoapsisKm: number;
  /** Radius the periapsis must clear: R + max(atmosphere, terrain margin). */
  readonly safeRadiusKm: number;
  readonly soiRadiusKm: number;
}

export type CompressionBlock = 'no-world' | 'cruise' | 'warp' | 'autopilot' | 'thrust' | 'unstable';

/** Spooled output below which the drive counts as idle. */
const ENGINE_IDLE = 0.01;

/** Why compression is not allowed right now, or null when it is. */
export function compressionBlock(s: CompressionInputs): CompressionBlock | null {
  if (!s.hasWorld) return 'no-world';
  if (s.cruising) return 'cruise';
  if (!s.warpIdle) return 'warp';
  if (s.autopilotActive) return 'autopilot';
  if (!s.commandIdle || !(s.engineOutput < ENGINE_IDLE)) return 'thrust';
  if (s.grounded) return null;
  // Written so that NaN anywhere fails towards "unstable".
  const bound = s.apoapsisKm < s.soiRadiusKm;
  const clear = s.periapsisKm > s.safeRadiusKm;
  return bound && clear ? null : 'unstable';
}

/** Stick resting inside this is not a touch (as the autopilot's deadzone). */
const DEADZONE = 0.02;

/** Any hand on the controls — which drops compression straight to 1×. */
export function pilotTouching(axes: InputAxes, brake: boolean, boost: boolean): boolean {
  if (brake || boost) return true;
  if (axes.throttle > 0) return true;
  if (axes.strafeX !== 0 || axes.strafeY !== 0 || axes.strafeZ !== 0) return true;
  return Math.abs(axes.pitch) > DEADZONE || Math.abs(axes.yaw) > DEADZONE || Math.abs(axes.roll) > DEADZONE;
}
