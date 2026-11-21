/**
 * The conflict rule for two diverged saves of the SAME game (v4 sub-plan 4,
 * Task 3; DESIGN-4 §5.3). Pure and shared by client and server: no `three`,
 * no DOM or storage globals.
 *
 * The chosen snapshot is kept (position, log, actions). The unchosen branch's
 * net change is `shipDigest(unchosen) - base` (base = digest of the shared
 * starting point); only its UNFAVOURABLE direction is folded into the chosen:
 * a net fall in tank or any resource is subtracted, a net rise in capacity
 * loss is added, gains are ignored. Emergency counters add, depletion is the
 * union. Tank and hold clamp to >= 0, capacity loss to <= 1. So an emergency
 * or fuel spent on one device cannot be undone by choosing the other.
 *
 * Formats: the rule takes and returns current-format saves (`Save`) and checks
 * its result with `SaveV2Schema`. It never lifts a save — that is `migrate`'s
 * job: SyncClient migrates both sides, and the server lifts a head (or device
 * save) an older build stored as format 1 before it resolves.
 */

import type { Resource } from '@/gen/belt';

import { SaveV2Schema, type Save } from './schema';

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

export interface ShipDigest {
  tankKg: number;
  capacityLossFrac: number;
  cargo: Record<Resource, number>;
  emergencyTimesUsed: number;
}

export function shipDigest(s: Save): ShipDigest {
  const { propellant, cargo, emergencyTimesUsed } = s.ship;
  return {
    tankKg: propellant.massKg,
    capacityLossFrac: propellant.capacityLossFrac,
    cargo: { ice: cargo.ice, metal: cargo.metal, silicate: cargo.silicate, rare: cargo.rare },
    emergencyTimesUsed,
  };
}

export function sameGame(a: Save, b: Save): boolean {
  return a.saveId === b.saveId;
}

type MinedEntry = Save['world']['entries'][number];

/**
 * Depletion union (plan-3 C6): one entry per (id, resource), the larger kg
 * (both branches started from the same base, so summing would double-count),
 * the newest clocks, first-occurrence order (chosen first).
 */
function unionEntries(chosen: readonly MinedEntry[], unchosen: readonly MinedEntry[]): MinedEntry[] {
  const out = new Map<string, MinedEntry>();
  for (const e of [...chosen, ...unchosen]) {
    const key = `${e.id}\u0000${e.resource}`;
    const have = out.get(key);
    if (!have) {
      out.set(key, { ...e });
      continue;
    }
    have.kg = Math.max(have.kg, e.kg);
    if (e.wallMs > have.wallMs) {
      have.wallMs = e.wallMs;
      have.orbitSeconds = e.orbitSeconds;
    }
  }
  return [...out.values()];
}

export function resolveSameGame(chosen: Save, unchosen: Save, base: ShipDigest): Save {
  if (!sameGame(chosen, unchosen)) {
    throw new Error(`resolveSameGame: different games (saveId ${chosen.saveId} vs ${unchosen.saveId})`);
  }
  const out = structuredClone(chosen);
  const u = shipDigest(unchosen);

  out.revision = Math.max(chosen.revision, unchosen.revision) + 1;

  const prop = out.ship.propellant;
  prop.massKg = Math.max(0, prop.massKg - Math.max(0, base.tankKg - u.tankKg));
  prop.capacityLossFrac = Math.min(1, prop.capacityLossFrac + Math.max(0, u.capacityLossFrac - base.capacityLossFrac));

  for (const r of RESOURCES) {
    out.ship.cargo[r] = Math.max(0, out.ship.cargo[r] - Math.max(0, base.cargo[r] - u.cargo[r]));
  }
  out.ship.emergencyTimesUsed += Math.max(0, u.emergencyTimesUsed - base.emergencyTimesUsed);

  out.world.entries = unionEntries(chosen.world.entries, unchosen.world.entries);

  // Zod: a bad result throws a ZodError (the server answers it with 400 invalid-save).
  return SaveV2Schema.parse(out);
}

export interface CardSummary {
  systemName: string;
  place: string;
  tankFrac: number;
  cargoKg: number;
  savedAtWallMs: number;
}

/** R18: `bodyName` is injected by the UI (the galaxy generator), which keeps this module pure. */
export function cardSummary(s: Save, capacityKg: number, bodyName?: (id: string) => string | null): CardSummary {
  const parentId = s.player.parentId;
  let place = 'deep space';
  if (parentId !== null) {
    const name = bodyName?.(parentId) ?? parentId;
    place = `${s.player.flight.grounded ? 'landed' : 'orbit'} ${name}`;
  }
  const { cargo, propellant } = s.ship;
  return {
    systemName: s.player.system.name,
    place,
    tankFrac: capacityKg > 0 ? propellant.massKg / capacityKg : 0,
    cargoKg: RESOURCES.reduce((sum, r) => sum + cargo[r], 0),
    savedAtWallMs: s.savedAt.wallMs,
  };
}
