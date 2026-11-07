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

/** Why the drive let go: an obstacle, the pilot, or having arrived. */
export type CruiseDropReason = CruiseBlock | 'released' | 'arrival';

export interface CruiseConfig {
  /** Ceiling per kilometre of clearance, per second. */
  readonly rate: number;
  /** Hard ceiling, km/s. Roughly 500c — beyond this the number stops meaning anything. */
  readonly maxCapKmS: number;
  /**
   * Absolute floor on the clearance needed to start, km. The real threshold is
   * `max(this, engageRadii × R)` of the body the clearance is measured to.
   */
  readonly engageClearanceKm: number;
  /**
   * Absolute floor on the clearance below which it lets go, km. Lower than
   * engage, deliberately; the real threshold is `max(this, holdRadii × R)`.
   */
  readonly dropClearanceKm: number;
  /** Clearance needed to start, in radii of the nearest body. */
  readonly engageRadii: number;
  /** Clearance below which the drive lets go, in radii of the nearest body. */
  readonly holdRadii: number;
  /** Clearance at which the drive drops on purpose when closing on a body, in radii. */
  readonly arrivalRadii: number;
  /** Arrival is pulled inside this fraction of the body's SOI, so the drop happens in its frame. */
  readonly arrivalSoiFraction: number;
  /** Seconds of charge before the drive takes hold. */
  readonly spoolTime: number;
  /** Seconds to bleed the ceiling back to sublight. */
  readonly dropTime: number;
  /** The ceiling handed back to the flight model on exit, km/s. */
  readonly exitSpeedKmS: number;
  /** Floor on the bleed's target speed, km/s, so the geometric bleed never divides by zero. */
  readonly minExitSpeedKmS: number;
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
  // v2: the envelope is measured in radii of the body in question, because a
  // gravity well scales with its body. The opening orbit sits 4 474 km above
  // Remit 31 (R 7 240 km) = 0.62 R, so engage at 0.5 R starts there with ~24 %
  // margin; hold at 0.3 R keeps a 1.67× hysteresis band. The floors exist for
  // small bodies: 700 km of clearance still gives a 245 km/s ceiling, above
  // boosted sublight (180), so holding at the floor is never a downgrade.
  engageClearanceKm: 1_200,
  dropClearanceKm: 700,
  engageRadii: 0.5,
  holdRadii: 0.3,
  // r = 3 R: far enough that a circular orbit there is well clear of any
  // atmosphere and of the hold threshold, close enough to fill the screen.
  arrivalRadii: 2,
  // SOI entry happens at 0.98 r_soi and one frame moves ≤ 0.6 % of the gap,
  // so by 0.9 r_soi the rebase has always happened.
  arrivalSoiFraction: 0.9,
  spoolTime: 2.0,
  dropTime: 0.9,
  // Used only without a gravity source (no parent). With one, the caller hands
  // in the circular speed and the bleed ends in orbit — see `cruiseOrbit.ts`.
  exitSpeedKmS: 60,
  minExitSpeedKmS: 0.01,
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

/** Clearance needed to engage near a body of radius `radiusKm`. */
export function engageClearanceKm(radiusKm: number, c: CruiseConfig = CRUISE_DEFAULTS): number {
  return Math.max(c.engageClearanceKm, c.engageRadii * Math.max(0, radiusKm || 0));
}

/** Clearance below which the drive lets go near a body of radius `radiusKm`. */
export function holdClearanceKm(radiusKm: number, c: CruiseConfig = CRUISE_DEFAULTS): number {
  return Math.max(c.dropClearanceKm, c.holdRadii * Math.max(0, radiusKm || 0));
}

/**
 * Clearance at which a ship closing on a body drops for arrival: `arrivalRadii`
 * R, pulled inside `arrivalSoiFraction` of its SOI so the drop happens in the
 * body's own frame, and never below the hold threshold (below that the hold
 * drop gets there first anyway).
 */
export function arrivalClearanceKm(
  radiusKm: number,
  soiRadiusKm = Number.POSITIVE_INFINITY,
  c: CruiseConfig = CRUISE_DEFAULTS,
): number {
  const r = Math.max(0, radiusKm || 0);
  const inSoi = c.arrivalSoiFraction * soiRadiusKm - r;
  return Math.max(holdClearanceKm(r, c), Math.min(c.arrivalRadii * r, inSoi));
}

/**
 * The chart's crossing time to a body: centre distance in, seconds to the
 * drive's arrival threshold out. The same thresholds the drive flies by.
 */
export function cruiseEtaSeconds(
  distanceKm: number,
  radiusKm: number,
  soiRadiusKm = Number.POSITIVE_INFINITY,
  c: CruiseConfig = CRUISE_DEFAULTS,
): number {
  return cruiseTravelSeconds(
    Math.max(distanceKm - radiusKm, 1),
    arrivalClearanceKm(radiusKm, soiRadiusKm, c),
    c,
  );
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
  /** Radius of the body `clearanceKm` is measured to, km. Omitted = floors only. */
  readonly nearestRadiusKm?: number;
  /** The body being approached (the locked target, else the nearest), if any. */
  readonly arrival?: CruiseArrival | null;
  /**
   * Speed the drop bleeds down to, km/s: the circular speed about the ship's
   * parent where it is. Omitted = `config.exitSpeedKmS`.
   */
  readonly exitSpeedKmS?: number;
  /**
   * v3: the nose (and so the carried velocity) is on the insertion tangent,
   * to within the handover's tolerance. While false the drop does not let go
   * at the end of its bleed — it holds at the exit speed and waits, at most
   * MAX_ALIGN_HOLD_S. Omitted = aligned (the v2 behaviour).
   */
  readonly aligned?: boolean;
}

/**
 * Longest a drop waits past its bleed for the nose to reach the tangent, s.
 * A 90° turn at the slew's 90°/s needs ~1 s; this is the bound for a pilot
 * or a world that keeps moving the target.
 */
export const MAX_ALIGN_HOLD_S = 2.5;

export interface CruiseArrival {
  /** Clearance to this body's surface, km. */
  readonly clearanceKm: number;
  readonly radiusKm: number;
  readonly soiRadiusKm: number;
  /** The ship is moving towards it. Only a closing ship arrives. */
  readonly closing: boolean;
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
  /** Why the last drop started, or null before the first. */
  dropReason: CruiseDropReason | null = null;

  /** Latched so the camera shake and the audio cue fire exactly once. */
  private dropped = false;
  /** Ceiling at the moment the drop started, so the bleed has somewhere to start. */
  private dropFrom = 0;
  /** Seconds the current drop has waited past its bleed for alignment. */
  private alignHeld = 0;

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
    const r = i.nearestRadiusKm ?? 0;
    const need = keeping ? holdClearanceKm(r, this.config) : engageClearanceKm(r, this.config);
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
          // B1 (v3): the engage frame already flies under the law. A 0 here
          // reached FlightModel's hard clamp and took the ship 5 → 0 km/s for
          // one frame before the drive picked it back up.
          this.capKmS = cruiseCapKmS(i.clearanceKm, c);
        }
        break;
      }

      case 'cruise': {
        this.blocked = this.obstacle(i, true);
        const a = i.arrival;
        const arrived =
          !!a && a.closing && a.clearanceKm < arrivalClearanceKm(a.radiusKm, a.soiRadiusKm, c);
        if (!i.requested || this.blocked !== null || arrived) {
          this.dropReason = this.blocked ?? (i.requested ? 'arrival' : 'released');
          this.dropFrom = Math.max(this.capKmS, this.exitSpeed(i));
          this.phase = 'dropping';
          this.progress = 1;
          this.alignHeld = 0;
          this.dropped = true;
          // Fall through to the drop's first step so the ceiling starts moving
          // this frame rather than holding for one more.
          this.stepDrop(dt, i);
          break;
        }
        this.capKmS = cruiseCapKmS(i.clearanceKm, c);
        break;
      }

      case 'dropping':
        this.stepDrop(dt, i);
        break;
    }
  }

  private exitSpeed(i: CruiseInputs): number {
    const v = i.exitSpeedKmS ?? this.config.exitSpeedKmS;
    return Math.max(Number.isFinite(v) ? v : this.config.exitSpeedKmS, this.config.minExitSpeedKmS);
  }

  private stepDrop(dt: number, i: CruiseInputs): void {
    const c = this.config;
    this.progress = Math.max(0, this.progress - dt / Math.max(c.dropTime, 1e-6));
    if (this.progress <= 0 && i.aligned === false && this.alignHeld < MAX_ALIGN_HOLD_S) {
      // v3: the bleed is done but the nose is not on the tangent yet. Hold at
      // the exit speed (k = 0 below) rather than hand over a snapped velocity.
      this.alignHeld += dt;
      this.progress = 0;
      this.capKmS = Math.min(this.exitSpeed(i), cruiseCapKmS(i.clearanceKm, c));
      return;
    }
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
    const exit = this.exitSpeed(i);
    const from = Math.max(this.dropFrom, exit);
    const bleed = exit * Math.pow(from / exit, k);
    // The bleed is still under the law: the gap can keep closing while it
    // runs, and the ceiling must keep falling with it.
    this.capKmS = Math.min(bleed, cruiseCapKmS(i.clearanceKm, c));
  }

  /** Back to a cold drive. Used when the world is replaced under the ship. */
  reset(): void {
    this.phase = 'idle';
    this.progress = 0;
    this.capKmS = 0;
    this.blocked = null;
    this.dropReason = null;
    this.dropped = false;
  }
}
