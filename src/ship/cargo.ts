/**
 * v4 sub-plan 2, Task 2 — the hold and its named resource actions.
 *
 * Pure: no three.js. The hold changes only through `applyCargoAction` (and the
 * sanitizing `restore`); `applyCargoAction` announces `cargo:action` exactly
 * once per call, refusals included. The tank is touched only through
 * Propellant.consume/add/capacityLossFrac.
 */

import { bus } from '@/core/EventBus';
import type { Resource } from '@/gen/belt';
import type { Propellant } from './propellant';

export type { Resource } from '@/gen/belt';

/** Hold capacity of the probe, kg. */
export const CARGO_CAPACITY_KG = 8_000;
/** Fuel kg per kg of ice refined. */
export const REFINE_ICE_TO_FUEL = 0.8;
/** Materials one repair consumes, kg. */
export const REPAIR_METAL_KG = 600;
export const REPAIR_SILICATE_KG = 400;
/** Tank capacity-loss fraction one repair restores. */
export const REPAIR_RESTORE_FRAC = 0.04;
/** Least cargo worth burning for propellant, kg. */
export const CANNIBALIZE_CARGO_MIN_KG = 1_000;
/** Cargo cannibalization gives this share of the tank's BASE capacity. */
const CANNIBALIZE_CARGO_FRAC = 0.03;

/** Below this many kg a hold counts as full, and a hold of ice as empty. */
export const CARGO_EPS_KG = 1e-6;
const EPS_KG = CARGO_EPS_KG;
/** Below this a capacity-loss fraction counts as zero. */
const EPS_LOSS = 1e-9;

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];
/** Order in which a restored record is clamped to capacity. */
const RESTORE_ORDER: readonly Resource[] = ['ice', 'rare', 'metal', 'silicate'];

/** The hold's contents. Module-private: only the actions and `restore` write. */
const contents = new WeakMap<Cargo, Record<Resource, number>>();

function put(c: Cargo, r: Resource, kg: number): void {
  contents.get(c)![r] += kg;
}
function take(c: Cargo, r: Resource, kg: number): void {
  const h = contents.get(c)!;
  // R18: snap at the source. A remainder below EPS_KG is float dust (e.g.
  // (x·0.8)/0.8 one ulp under x), not cargo: it would show as "ICE 0 KG".
  const left = h[r] - kg;
  h[r] = left < EPS_KG ? 0 : left;
}

export class Cargo {
  readonly capacityKg: number;

  constructor(capacityKg: number) {
    this.capacityKg = Number.isFinite(capacityKg) && capacityKg > 0 ? capacityKg : 0;
    contents.set(this, { ice: 0, metal: 0, silicate: 0, rare: 0 });
  }

  kg(r: Resource): number {
    return contents.get(this)![r];
  }

  get totalKg(): number {
    // A plain loop: Universe reads this every frame for the mass sync, and a
    // reduce would allocate its closure each call.
    const h = contents.get(this)!;
    let s = 0;
    for (let i = 0; i < RESOURCES.length; i++) s += h[RESOURCES[i]!];
    return s;
  }

  get freeKg(): number {
    return Math.max(0, this.capacityKg - this.totalKg);
  }

  /** A copy of the contents; later changes to the hold do not touch it. */
  snapshot(): Readonly<Record<Resource, number>> {
    return { ...contents.get(this)! };
  }

  /**
   * Sets the contents from a saved record. Non-finite or negative amounts
   * become 0, missing resources are 0, and the total is clamped to capacity in
   * the order ice, rare, metal, silicate. Announces nothing.
   */
  restore(record: Partial<Record<Resource, number>>): void {
    const h = contents.get(this)!;
    let room = this.capacityKg;
    for (const r of RESTORE_ORDER) {
      const v = record[r];
      const clean = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
      const kg = Math.min(clean, room);
      h[r] = kg;
      room -= kg;
    }
  }
}

export type CargoAction =
  | { kind: 'mine'; asteroidId: string; resource: Resource; kg: number }
  | { kind: 'refine' }
  | { kind: 'repair' }
  | { kind: 'jettison-all' }
  | { kind: 'cannibalize-cargo' };

export interface CargoResult {
  ok: boolean;
  kgIn: number;
  kgOut: number;
  fuelKg: number;
  restoredFrac: number;
  reason?:
    | 'hold-full'
    | 'nothing-to-refine'
    | 'tank-full'
    | 'insufficient'
    | 'nothing-to-repair'
    | 'empty'
    | 'not-empty'
    | 'no-tank'
    | 'invalid';
}

function result(ok: boolean, p: Partial<CargoResult> = {}): CargoResult {
  return { ok, kgIn: 0, kgOut: 0, fuelKg: 0, restoredFrac: 0, ...p };
}
const refuse = (reason: NonNullable<CargoResult['reason']>): CargoResult => result(false, { reason });

type Reason = NonNullable<CargoResult['reason']>;

/**
 * Why a refine would be refused right now, or null if it would run. The same
 * check `applyCargoAction` makes, so a caller can judge a key press without
 * applying (or announcing) anything.
 */
export function refineRefusal(cargo: Cargo, tank: Propellant | null): Reason | null {
  if (!tank) return 'no-tank';
  if (cargo.kg('ice') < EPS_KG) return 'nothing-to-refine';
  if (tank.capacityKg - tank.massKg <= 0) return 'tank-full';
  return null;
}

/** Why a repair would be refused right now, or null if it would run. */
export function repairRefusal(cargo: Cargo, tank: Propellant | null): Reason | null {
  if (!tank) return 'no-tank';
  if (tank.capacityLossFrac < EPS_LOSS) return 'nothing-to-repair';
  if (cargo.kg('metal') < REPAIR_METAL_KG || cargo.kg('silicate') < REPAIR_SILICATE_KG) return 'insufficient';
  return null;
}

function run(cargo: Cargo, tank: Propellant | null, a: CargoAction): CargoResult {
  switch (a.kind) {
    case 'mine': {
      if (!Number.isFinite(a.kg) || a.kg < 0) return refuse('invalid');
      if (cargo.freeKg < EPS_KG) return refuse('hold-full');
      const kg = Math.min(a.kg, cargo.freeKg);
      put(cargo, a.resource, kg);
      return result(true, { kgIn: kg });
    }
    case 'refine': {
      const no = refineRefusal(cargo, tank);
      if (no || !tank) return refuse(no ?? 'no-tank');
      const ice = cargo.kg('ice');
      const fuel = tank.add(ice * REFINE_ICE_TO_FUEL);
      let used = Math.min(ice, fuel / REFINE_ICE_TO_FUEL);
      // R18: dust left over is part of what was used.
      if (ice - used < EPS_KG) used = ice;
      take(cargo, 'ice', used);
      return result(true, { kgOut: used, fuelKg: fuel });
    }
    case 'repair': {
      const no = repairRefusal(cargo, tank);
      if (no || !tank) return refuse(no ?? 'no-tank');
      const before = tank.capacityLossFrac;
      const after = Math.max(0, before - REPAIR_RESTORE_FRAC);
      tank.capacityLossFrac = after;
      take(cargo, 'metal', REPAIR_METAL_KG);
      take(cargo, 'silicate', REPAIR_SILICATE_KG);
      return result(true, {
        kgOut: REPAIR_METAL_KG + REPAIR_SILICATE_KG,
        restoredFrac: before - after,
      });
    }
    case 'jettison-all': {
      const total = cargo.totalKg;
      if (total <= 0) return refuse('empty');
      for (const r of RESOURCES) take(cargo, r, cargo.kg(r));
      return result(true, { kgOut: total });
    }
    case 'cannibalize-cargo': {
      const total = cargo.totalKg;
      if (!tank) return refuse('no-tank');
      if (total < CANNIBALIZE_CARGO_MIN_KG) return refuse('insufficient');
      if (!tank.empty) return refuse('not-empty');
      if (tank.capacityKg < EPS_KG) return refuse('tank-full');
      // Emergency: the whole hold burns even if the (damaged) tank takes less.
      const fuel = tank.add(CANNIBALIZE_CARGO_FRAC * tank.baseCapacityKg);
      for (const r of RESOURCES) take(cargo, r, cargo.kg(r));
      return result(true, { kgOut: total, fuelKg: fuel });
    }
  }
}

/** Applies one named action to the hold (and tank); announces `cargo:action` once. */
export function applyCargoAction(
  cargo: Cargo,
  tank: Propellant | null,
  a: CargoAction,
): CargoResult {
  const r = run(cargo, tank, a);
  bus.emit('cargo:action', { action: a, result: r });
  return r;
}
