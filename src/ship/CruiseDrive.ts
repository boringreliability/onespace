/**
 * The cruise drive — travel inside a system.
 *
 * The problem it solves is arithmetic. Sublight top speed is 60 km/s, boosted
 * 180. One astronomical unit is 149.6 million km. Crossing it under thrust
 * takes **nine and a half days**, so before this file the inner system was a
 * place you could look at and never visit.
 *
 * The model is Elite's, and the reason to prefer it here is not nostalgia:
 *
 *     v_max = clearance × rate
 *
 * The speed ceiling is proportional to how far the nearest surface is. That
 * single choice buys three things at once.
 *
 * 1. **It cannot tunnel.** In one step the drive covers `rate × h` of its own
 *    clearance — 0.58% at 60 Hz. A fixed-step integrator can therefore be
 *    handed a 500c ceiling without ever skipping a planet or stepping across a
 *    sphere-of-influence boundary. See `cruise.test.ts`, which asserts this for
 *    clearances spanning nine orders of magnitude.
 * 2. **It brakes itself.** Closing on a body, the ceiling falls with the gap,
 *    so arrival is asymptotic. You do not aim; you point and are slowed.
 * 3. **It makes travel logarithmic.** Time to cross from r0 to r1 is
 *    `ln(r1/r0) / rate`, which is about half a minute from low orbit to 1 AU
 *    and only five seconds more to reach five. Big systems stop being big in
 *    the boring way while staying big to look at.
 *
 * What it costs: the ceiling is not a physical speed. At 1 AU of clearance it
 * is roughly 170 times light. This file does not pretend otherwise — it is a
 * drive, not a velocity, and `FlightModel` suspends gravity while it runs
 * because a ship under cruise is not on a trajectory.
 *
 * This module is pure. No three.js, no vectors, no clock — clearance and a
 * timestep in, a ceiling and a phase out. That is what lets the invariant
 * above be tested rather than hoped for.
 */

export type CruisePhase = 'idle' | 'spooling' | 'cruise' | 'dropping';

/** Why the drive will not engage, in the order the pilot should be told. */
export type CruiseBlock = 'landed' | 'atmosphere' | 'mass';

export interface CruiseConfig {
  /** Ceiling per kilometre of clearance, per second. */
  readonly rate: number;
  /** Hard ceiling, km/s. Roughly 500c — beyond this the number stops meaning anything. */
  readonly maxCapKmS: number;
  /** Clearance needed to start, km. */
  readonly engageClearanceKm: number;
  /** Clearance below which it lets go, km. Lower than engage, deliberately. */
  readonly dropClearanceKm: number;
  /** Seconds of charge before the drive takes hold. */
  readonly spoolTime: number;
  /** Seconds to bleed the ceiling back to sublight. */
  readonly dropTime: number;
  /** The ceiling handed back to the flight model on exit, km/s. */
  readonly exitSpeedKmS: number;
  /**
   * Relative air density above which the drive refuses. An exponential
   * atmosphere never reaches zero — float64 only underflows at ~745 scale
   * heights — so a `> 0` test locked the drive out thousands of kilometres
   * above a world whose air is a couple of hundred thick. 1e-6 is ~14 scale
   * heights: the top of any atmosphere a player would call one.
   */
  readonly atmosphereCutoff: number;
}

export const CRUISE_DEFAULTS: CruiseConfig = {
  // 0.35 puts low orbit to 1 AU at ln(30000)/0.35 ≈ 29 s, which play-tests as
  // long enough to feel like a crossing and short enough to do twice.
  rate: 0.35,
  // ~500c. Elite's is 2001c; this game's systems are smaller and its tone is
  // quieter, and a number this large is already past the point of meaning.
  maxCapKmS: 1.5e8,
  engageClearanceKm: 5_000,
  dropClearanceKm: 3_000,
  spoolTime: 2.0,
  dropTime: 0.9,
  // The sublight ceiling. Dropping at 1 050 km/s would fling the ship past
  // whatever it came to see; this is the one deliberate cheat in the model.
  exitSpeedKmS: 60,
  atmosphereCutoff: 1e-6,
};

/**
 * The speed ceiling for a given clearance, km/s.
 *
 * Exported on its own because the HUD and the system map both want to quote a
 * travel time without instantiating a drive.
 */
export function cruiseCapKmS(
  clearanceKm: number,
  c: CruiseConfig = CRUISE_DEFAULTS,
): number {
  if (!Number.isFinite(clearanceKm) || clearanceKm <= 0) return 0;
  return Math.min(clearanceKm * c.rate, c.maxCapKmS);
}

/**
 * Seconds to cross from one clearance to another under the law.
 *
 * Closed form: the ceiling is proportional to the gap, so the gap decays
 * exponentially and the time is a logarithm. Used for the map's ETA readout,
 * where integrating a loop per body per frame would be absurd.
 */
export function cruiseTravelSeconds(
  fromKm: number,
  toKm: number,
  c: CruiseConfig = CRUISE_DEFAULTS,
): number {
  const a = Math.max(fromKm, 1);
  const b = Math.max(toKm, 1);
  if (b >= a) return 0;
  const clampAt = c.maxCapKmS / c.rate;
  // Above the clamp the ceiling is constant, so that stretch is linear time
  // and only the part below the clamp is logarithmic. Ignoring the split
  // under-reports a crossing of the outer system by minutes.
  let seconds = 0;
  let hi = a;
  if (hi > clampAt) {
    const lo = Math.max(b, clampAt);
    seconds += (hi - lo) / c.maxCapKmS;
    hi = lo;
  }
  if (hi > b) seconds += Math.log(hi / b) / c.rate;
  return seconds;
}

export interface CruiseInputs {
  /** The pilot wants the drive running. */
  readonly requested: boolean;
  /** Distance to the nearest surface — any body, or the star. Kilometres. */
  readonly clearanceKm: number;
  readonly grounded: boolean;
  /** Relative air density; above `atmosphereCutoff` the ship is in air. */
  readonly atmosphericDensity: number;
}

export class CruiseDrive {
  readonly config: CruiseConfig;

  phase: CruisePhase = 'idle';
  /** 0..1 through the current spool or drop. */
  progress = 0;
  /** Current speed ceiling, km/s. Zero unless the drive is doing something. */
  capKmS = 0;
  /** Why it will not engage, or null. Only meaningful while idle or dropping. */
  blocked: CruiseBlock | null = null;

  /** Latched so the camera shake and the audio cue fire exactly once. */
  private dropped = false;
  /** Ceiling at the moment the drop started, so the bleed has somewhere to start. */
  private dropFrom = 0;

  constructor(config: CruiseConfig = CRUISE_DEFAULTS) {
    this.config = config;
  }

  /** True once per drop. Reading it clears it. */
  takeDropEvent(): boolean {
    const v = this.dropped;
    this.dropped = false;
    return v;
  }

  get engaged(): boolean {
    return this.phase === 'cruise' || this.phase === 'dropping';
  }

  /**
   * Why the drive cannot hold, given the world.
   *
   * `keeping` selects the lower clearance threshold: it takes more room to
   * start than to continue, so a ship sitting between the two neither engages
   * nor drops. Equal thresholds would flip it on alternate frames forever.
   */
  private obstacle(i: CruiseInputs, keeping: boolean): CruiseBlock | null {
    if (i.grounded) return 'landed';
    if (i.atmosphericDensity > this.config.atmosphereCutoff) return 'atmosphere';
    const need = keeping ? this.config.dropClearanceKm : this.config.engageClearanceKm;
    if (!(i.clearanceKm >= need)) return 'mass';
    return null;
  }

  update(dt: number, i: CruiseInputs): void {
    const c = this.config;

    switch (this.phase) {
      case 'idle': {
        this.capKmS = 0;
        this.progress = 0;
        this.blocked = this.obstacle(i, false);
        if (i.requested && this.blocked === null) {
          this.phase = 'spooling';
          this.progress = 0;
        }
        break;
      }

      case 'spooling': {
        this.blocked = this.obstacle(i, false);
        // A charge is not a commitment. Releasing the key or straying into
        // something's gravity well aborts it outright rather than queueing.
        if (!i.requested || this.blocked !== null) {
          this.phase = 'idle';
          this.progress = 0;
          break;
        }
        this.progress = Math.min(1, this.progress + dt / Math.max(c.spoolTime, 1e-6));
        this.capKmS = 0;
        if (this.progress >= 1) {
          this.phase = 'cruise';
          this.progress = 1;
        }
        break;
      }

      case 'cruise': {
        this.blocked = this.obstacle(i, true);
        if (!i.requested || this.blocked !== null) {
          this.dropFrom = Math.max(this.capKmS, c.exitSpeedKmS);
          this.phase = 'dropping';
          this.progress = 1;
          this.dropped = true;
          // Fall through to the drop's first step so the ceiling starts moving
          // this frame rather than holding for one more.
          this.stepDrop(dt);
          break;
        }
        this.capKmS = cruiseCapKmS(i.clearanceKm, c);
        break;
      }

      case 'dropping':
        this.stepDrop(dt);
        break;
    }
  }

  private stepDrop(dt: number): void {
    const c = this.config;
    this.progress = Math.max(0, this.progress - dt / Math.max(c.dropTime, 1e-6));
    if (this.progress <= 0) {
      this.phase = 'idle';
      this.capKmS = 0;
      this.progress = 0;
      return;
    }
    // Geometric rather than linear: falling from 10^6 to 60 km/s linearly
    // spends almost the whole bleed above 10^5, so nothing appears to happen
    // until the very end.
    const k = this.progress * this.progress;
    this.capKmS = c.exitSpeedKmS * Math.pow(this.dropFrom / c.exitSpeedKmS, k);
  }

  /** Back to a cold drive. Used when the world is replaced under the ship. */
  reset(): void {
    this.phase = 'idle';
    this.progress = 0;
    this.capKmS = 0;
    this.blocked = null;
    this.dropped = false;
  }
}
