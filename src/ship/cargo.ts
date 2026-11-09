/**
 * v4 sub-plan 2, Task 2 — the hold and its named resource actions.
 *
 * Pure: no three.js. The hold changes only through `applyCargoAction`, which
 * announces `cargo:action` exactly once per call, refusals included. The tank
 * is touched only through Propellant.consume/add/capacityLossFrac.
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

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

export class Cargo {
  readonly capacityKg: number;
  private readonly held: Record<Resource, number> = { ice: 0, metal: 0, silicate: 0, rare: 0 };

  constructor(capacityKg: number) {
    this.capacityKg = Number.isFinite(capacityKg) && capacityKg > 0 ? capacityKg : 0;
  }

  kg(r: Resource): number {
    return this.held[r];
  }

  get totalKg(): number {
    return RESOURCES.reduce((s, r) => s + this.held[r], 0);
  }

  get freeKg(): number {
    return Math.max(0, this.capacityKg - this.totalKg);
  }

  /** @internal Only applyCargoAction calls this. */
  _add(r: Resource, kg: number): void {
    this.held[r] += kg;
  }

  /** @internal Only applyCargoAction calls this. */
  _take(r: Resource, kg: number): void {
    this.held[r] = kg >= this.held[r] ? 0 : this.held[r] - kg;
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
    | 'not-empty';
}

function result(ok: boolean, p: Partial<CargoResult> = {}): CargoResult {
  return { ok, kgIn: 0, kgOut: 0, fuelKg: 0, restoredFrac: 0, ...p };
}
const refuse = (reason: NonNullable<CargoResult['reason']>): CargoResult => result(false, { reason });

function run(cargo: Cargo, tank: Propellant | null, a: CargoAction): CargoResult {
  switch (a.kind) {
    case 'mine': {
      if (!Number.isFinite(a.kg) || a.kg <= 0) return refuse('insufficient');
      if (cargo.freeKg <= 0) return refuse('hold-full');
      const kg = Math.min(a.kg, cargo.freeKg);
      cargo._add(a.resource, kg);
      return result(true, { kgIn: kg });
    }
    case 'refine': {
      const ice = cargo.kg('ice');
      if (!tank) return refuse('tank-full');
      if (ice <= 0) return refuse('nothing-to-refine');
      if (tank.capacityKg - tank.massKg <= 0) return refuse('tank-full');
      const fuel = tank.add(ice * REFINE_ICE_TO_FUEL);
      const used = Math.min(ice, fuel / REFINE_ICE_TO_FUEL);
      cargo._take('ice', used);
      return result(true, { kgOut: used, fuelKg: fuel });
    }
    case 'repair': {
      if (!tank || tank.capacityLossFrac <= 0) return refuse('nothing-to-repair');
      if (cargo.kg('metal') < REPAIR_METAL_KG || cargo.kg('silicate') < REPAIR_SILICATE_KG) {
        return refuse('insufficient');
      }
      const before = tank.capacityLossFrac;
      const after = Math.max(0, before - REPAIR_RESTORE_FRAC);
      tank.capacityLossFrac = after;
      cargo._take('metal', REPAIR_METAL_KG);
      cargo._take('silicate', REPAIR_SILICATE_KG);
      return result(true, {
        kgOut: REPAIR_METAL_KG + REPAIR_SILICATE_KG,
        restoredFrac: before - after,
      });
    }
    case 'jettison-all': {
      const total = cargo.totalKg;
      if (total <= 0) return refuse('empty');
      for (const r of RESOURCES) cargo._take(r, cargo.kg(r));
      return result(true, { kgOut: total });
    }
    case 'cannibalize-cargo': {
      const total = cargo.totalKg;
      if (!tank || total < CANNIBALIZE_CARGO_MIN_KG) return refuse('insufficient');
      if (!tank.empty) return refuse('not-empty');
      // Emergency: the whole hold burns even if the (damaged) tank takes less.
      const fuel = tank.add(CANNIBALIZE_CARGO_FRAC * tank.baseCapacityKg);
      for (const r of RESOURCES) cargo._take(r, cargo.kg(r));
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
