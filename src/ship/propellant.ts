/**
 * v4 sub-plan 1 (propellant) — the probe's tank and its consumption formulas.
 *
 * Pure: no three.js, no FlightModel import. Later tasks wire it into the
 * flight model.
 */

/** Tank capacity of the probe, kg. */
export const PROBE_TANK_CAPACITY_KG = 20_000;
/** Dry mass of the probe, kg. Equals DEFAULT_SHIP_CONFIG.mass (pinned by test). */
export const PROBE_DRY_MASS_KG = 2.0e5;
/** Effective exhaust velocity, km/s. Tuned in D1/D2: auto-land from the opening orbit ~7 % of a full tank. */
export const EXHAUST_VELOCITY_KMS = 11_500;
/** Fraction of the tank filled at the start. */
export const START_FILL = 0.6;

/** Finite and positive, else 0. NaN, negatives and ±Infinity all collapse to 0. */
function clean(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

export interface PropellantSnapshot {
  readonly massKg: number;
  readonly capacityLossFrac: number;
}

export class Propellant {
  readonly baseCapacityKg: number;
  massKg: number;
  private lossFrac = 0;

  constructor(capacityKg: number, fill: number) {
    this.baseCapacityKg = clean(capacityKg);
    const f = Number.isFinite(fill) ? Math.min(1, Math.max(0, fill)) : 0;
    this.massKg = this.baseCapacityKg * f;
  }

  get capacityLossFrac(): number {
    return this.lossFrac;
  }

  /** Clamped to [0,1]; a tank fuller than the new capacity is clamped down at once. */
  set capacityLossFrac(v: number) {
    this.lossFrac = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    this.massKg = Math.min(this.massKg, this.capacityKg);
  }

  /** [v4-save] What a save keeps of the tank. A plain copy. */
  snapshot(): PropellantSnapshot {
    return { massKg: this.massKg, capacityLossFrac: this.lossFrac };
  }

  /**
   * [v4-save] Put a saved tank back. Loss FIRST, then mass: the mass is
   * clamped to the restored capacity, never to whatever this tank had before.
   * Sanitised by today's rules (non-finite / negative → 0, loss to [0,1]).
   */
  restore(s: PropellantSnapshot): void {
    this.capacityLossFrac = s.capacityLossFrac;
    this.massKg = Math.min(clean(s.massKg), this.capacityKg);
  }

  get capacityKg(): number {
    return this.baseCapacityKg * (1 - this.lossFrac);
  }

  get fraction(): number {
    const cap = this.capacityKg;
    return cap > 0 ? Math.min(1, this.massKg / cap) : 0;
  }

  get empty(): boolean {
    return this.massKg <= 0;
  }

  /** Takes up to `kg`; returns what was actually taken. NaN/negative takes nothing. */
  consume(kg: number): number {
    if (Number.isNaN(kg) || kg <= 0) return 0;
    const taken = Math.min(kg, this.massKg);
    this.massKg = taken >= this.massKg ? 0 : this.massKg - taken;
    return taken;
  }

  /** Adds up to `kg`; returns what fit. NaN/negative adds nothing. */
  add(kg: number): number {
    if (Number.isNaN(kg) || kg <= 0) return 0;
    const free = Math.max(0, this.capacityKg - this.massKg);
    const added = Math.min(kg, free);
    this.massKg = added >= free ? this.capacityKg : this.massKg + added;
    return added;
  }
}

/** kg burned to give `accelKmS2` to `massKg` for `dtS` at exhaust speed `exhaustKmS`: a·m·dt/ve. */
export function propellantForImpulse(
  accelKmS2: number,
  massKg: number,
  dtS: number,
  exhaustKmS: number,
): number {
  const ve = clean(exhaustKmS);
  if (ve === 0) return 0;
  return (clean(accelKmS2) * clean(massKg) * clean(dtS)) / ve;
}

/** Tsiolkovsky dv left, km/s: ve·ln(m0/m1). */
export function deltaVRemaining(
  dryKg: number,
  propKg: number,
  extraKg: number,
  exhaustKmS: number,
): number {
  const m1 = clean(dryKg) + clean(extraKg);
  if (m1 <= 0) return 0;
  const m0 = m1 + clean(propKg);
  return clean(exhaustKmS) * Math.log(m0 / m1);
}

/** Response scale from tank mass: dry/(dry+prop+extra). */
export function massScale(dryKg: number, propKg: number, extraKg: number): number {
  const dry = clean(dryKg);
  const total = dry + clean(propKg) + clean(extraKg);
  return total > 0 ? dry / total : 0;
}
