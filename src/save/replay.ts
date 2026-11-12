/**
 * Recompute the ship from its action log (v4 sub-plan 3, ruling R8).
 *
 * Pure: `replay(initial, actions)` returns a new state and never touches its
 * inputs. It is the oracle for the log — the tank (mass and capacity loss),
 * the hold, the depletion per asteroid and the emergency counts the live game
 * reached must all come back out of it — and the reason a checkpoint carries
 * NET effects: replaying [checkpoint, …rest] equals replaying the full log.
 *
 * Rules, per entry:
 *  - propellant: the tank moves by `tankDeltaKg` (refused entries too — a leg
 *    that ran dry took what it took); an ok tank cannibalization adds
 *    `cannibalizeLossFrac(timesUsed)` to the capacity loss;
 *  - thrust: the tank falls by its kg;
 *  - cargo: a mine adds `kgIn`; a refine takes `kgOut` ice and adds `fuelKg` to
 *    the tank; a repair takes 600 kg metal + 400 kg silicate and lowers the
 *    loss by `restoredFrac`; a jettison empties the hold; a cargo
 *    cannibalization empties it and adds `fuelKg` to the tank;
 *  - mined: the asteroid's depletion grows;
 *  - emergency: counted by kind;
 *  - checkpoint: its net effects are added.
 *
 * Nothing is clamped: the deltas were measured on the real tank and hold.
 */

import type { Resource } from '@/gen/belt';
import { REPAIR_METAL_KG, REPAIR_SILICATE_KG } from '@/ship/cargo';
import { cannibalizeLossFrac } from '@/ship/emergency';
import type { ActionEntry } from './schema';

export interface ReplayState {
  tank: { massKg: number; capacityLossFrac: number };
  cargo: Record<Resource, number>;
  /** kg taken per asteroid id, per resource. */
  depletion: Record<string, Record<Resource, number>>;
  emergency: { cannibalize: number; cannibalizeCargo: number; beacon: number };
}

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

function perResource(): Record<Resource, number> {
  return { ice: 0, metal: 0, silicate: 0, rare: 0 };
}

/** Nothing at all: the start a checkpoint's net effects are measured from. */
export function zeroState(): ReplayState {
  return {
    tank: { massKg: 0, capacityLossFrac: 0 },
    cargo: perResource(),
    depletion: {},
    emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
  };
}

function copyState(s: ReplayState): ReplayState {
  const depletion: ReplayState['depletion'] = {};
  for (const [id, d] of Object.entries(s.depletion)) depletion[id] = { ...d };
  return {
    tank: { ...s.tank },
    cargo: { ...s.cargo },
    depletion,
    emergency: { ...s.emergency },
  };
}

function emptyHold(s: ReplayState): void {
  for (const r of RESOURCES) s.cargo[r] = 0;
}

function deplete(s: ReplayState, id: string): Record<Resource, number> {
  let d = s.depletion[id];
  if (!d) {
    d = perResource();
    s.depletion[id] = d;
  }
  return d;
}

/** Apply one entry to `s`, in place. */
export function applyEntry(s: ReplayState, e: ActionEntry): void {
  switch (e.source) {
    case 'propellant': {
      s.tank.massKg += e.payload.tankDeltaKg;
      const a = e.payload.action;
      if (a.kind === 'cannibalize' && e.payload.ok) s.tank.capacityLossFrac += cannibalizeLossFrac(a.timesUsed ?? 0);
      break;
    }
    case 'thrust':
      s.tank.massKg -= e.payload.kg;
      break;
    case 'cargo': {
      const { action: a, result: r } = e.payload;
      if (!r.ok) break;
      switch (a.kind) {
        case 'mine':
          s.cargo[a.resource] += r.kgIn;
          break;
        case 'refine':
          s.cargo.ice -= r.kgOut;
          s.tank.massKg += r.fuelKg;
          break;
        case 'repair':
          s.cargo.metal -= REPAIR_METAL_KG;
          s.cargo.silicate -= REPAIR_SILICATE_KG;
          s.tank.capacityLossFrac -= r.restoredFrac;
          break;
        case 'jettison-all':
          emptyHold(s);
          break;
        case 'cannibalize-cargo':
          emptyHold(s);
          s.tank.massKg += r.fuelKg;
          break;
      }
      break;
    }
    case 'mined':
      deplete(s, e.payload.id)[e.payload.resource] += e.payload.kg;
      break;
    case 'emergency':
      if (e.payload.kind === 'cannibalize') s.emergency.cannibalize++;
      else if (e.payload.kind === 'cannibalize-cargo') s.emergency.cannibalizeCargo++;
      else s.emergency.beacon++;
      break;
    case 'checkpoint': {
      const p = e.payload;
      s.tank.massKg += p.tankNetKg;
      s.tank.capacityLossFrac += p.capacityLossNetFrac;
      for (const r of RESOURCES) s.cargo[r] += p.cargoNetKg[r];
      for (const [id, kg] of Object.entries(p.minedByAsteroid)) {
        const d = deplete(s, id);
        for (const r of RESOURCES) d[r] += kg[r];
      }
      s.emergency.cannibalize += p.emergency.cannibalize;
      s.emergency.cannibalizeCargo += p.emergency.cannibalizeCargo;
      s.emergency.beacon += p.emergency.beacon;
      break;
    }
  }
}

export function replay(initial: ReplayState, actions: readonly ActionEntry[]): ReplayState {
  const s = copyState(initial);
  for (const e of actions) applyEntry(s, e);
  return s;
}
