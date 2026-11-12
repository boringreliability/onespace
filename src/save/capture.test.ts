/**
 * v4 sub-plan 3 (local save), Task 3 — a save from the running game.
 *
 * `buildSave(w, prev)` reads a live world into a SaveV1; `applySave(w, s)`
 * puts one back. Both run against a REAL Universe (init → generate, place,
 * emit; the GPU-bound steps stubbed as in universeRestore.test.ts), a real
 * ShipLog, WorldState, Emergency and ActionJournal.
 *
 * Promises:
 *  - revision rises by one; the saveId is kept (a first save gets a new UUID);
 *  - player and world are separate (P2); both clocks on everything (P5);
 *  - the log is read with `ShipLog.exportState()` AT SAVE TIME (mission time
 *    is current, not whatever the sink last saw);
 *  - a cruising ship is saved as a circular orbit about the nearest body at
 *    its current radius (§5.2) — and the live ship keeps cruising;
 *  - unannounced thrust is aggregated so the books balance;
 *  - the action log is append-only across saves and capped at MAX_ACTIONS;
 *  - round trip: buildSave → JSON → migrate → applySave into a fresh Universe;
 *  - carried rulings: R6 (log imported AFTER the Universe restore), a null
 *    tank is guarded, `grounded` only with a parent, an unknown system
 *    changes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName } from '@/core/Input';
import { Emergency } from '@/game/Emergency';
import { ShipLog, type LogState } from '@/game/Log';
import { Universe } from '@/game/Universe';
import { fyssField, nodeCtx } from '@/game/testing/beltFixture';
import { WorldState, type MinedEntry } from '@/game/worldState';
import { applyCargoAction } from '@/ship/cargo';
import { EXHAUST_VELOCITY_KMS } from '@/ship/propellant';
import { payBeacon } from '@/ship/emergency';
import { announceAction, applyAction, type ActionResult } from '@/ship/travelCost';
import { Cruise } from '@/game/Cruise';
import { CRUISE_DEFAULTS } from '@/ship/CruiseDrive';
import { ActionJournal, MAX_ACTIONS, compactEntries } from './actionJournal';
import { applySave, buildSave, type SaveWorld } from './capture';
import { migrate } from './migrate';
import { replay, type ReplayState } from './replay';
import { SaveV1Schema, type ActionEntry, type SaveV1 } from './schema';

/** Universe steps that need a GPU; everything else in update() runs for real. */
const RENDER_STEPS = ['streamRenderers', 'updateBodies', 'updateStar', 'publishMotionReference', 'refreshAtmosphere'];

const WALL = 1_800_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A localStorage that behaves like the real one (as in Log.test.ts). */
class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const offs: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WALL);
});
afterEach(() => {
  for (const off of offs.splice(0)) off();
  bus.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubRender(u: Universe): void {
  const raw = u as unknown as Record<string, unknown>;
  for (const k of RENDER_STEPS) raw[k] = () => undefined;
}

interface Live {
  u: Universe;
  ctx: EngineContext;
  w: SaveWorld;
  worldState: WorldState;
  shipLog: ShipLog;
  emergency: Emergency;
  journal: ActionJournal;
  frames(seconds: number): void;
  /** One Emergency frame with `action` pressed. */
  press(action: ActionName): void;
  dispose(): void;
}

/**
 * A live game at a new start in Fyss, wired as the registry will wire it:
 * the log listens before the Universe boots (so it logs the arrival), the
 * WorldState's mines reach the journal through `onMined`.
 */
function live(): Live {
  const ctx = nodeCtx();
  const shipLog = new ShipLog();
  shipLog.init();
  const u = new Universe();
  const journal = new ActionJournal({ wallMs: () => Date.now(), orbitSeconds: () => u.orbitSeconds });
  const worldState = new WorldState({
    orbitSeconds: () => u.orbitSeconds,
    wallMs: () => Date.now(),
    onMined: (e: MinedEntry) => journal.noteMined(e),
  });
  u.init(ctx);
  stubRender(u);
  const emergency = new Emergency({ universe: u, recovery: { active: false }, warp: { phase: 'idle' }, log: shipLog });
  const w: SaveWorld = { universe: u, worldState, shipLog, emergency, journal };
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    shipLog.dispose();
    journal.dispose();
  };
  offs.push(dispose);
  return {
    u,
    ctx,
    w,
    worldState,
    shipLog,
    emergency,
    journal,
    frames: (seconds) => {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) u.update(1 / 60, ctx);
    },
    press: (action) => {
      const input = { pressed: (a: ActionName) => a === action, setThrottle: () => undefined };
      emergency.update(1 / 60, { ...ctx, input } as unknown as EngineContext);
    },
    dispose,
  };
}

/** A save as it comes back from storage: JSON, then migrate. */
function throughStorage(s: SaveV1): SaveV1 {
  const m = migrate(JSON.parse(JSON.stringify(s)));
  if (!m.ok) throw new Error(`migrate refused the save: ${m.reason} ${m.issues.join('; ')}`);
  return m.save;
}

/** Mine `kg` of `resource` the way Mining completes one: the hold first, then the world. */
function mine(g: Live, asteroidId: string, resource: 'ice' | 'metal' | 'silicate' | 'rare', kg: number): void {
  const r = applyCargoAction(g.u.cargo, g.u.flight.propellant, { kind: 'mine', asteroidId, resource, kg });
  expect(r.ok).toBe(true);
  g.worldState.recordMined(asteroidId, resource, r.kgIn, 'local');
}

function expectFlightIs(u: Universe, f: SaveV1['player']['flight']): void {
  const fm = u.flight;
  expect(fm.position.distanceTo(new Vector3(...f.position))).toBeLessThan(1e-9);
  expect(fm.velocity.distanceTo(new Vector3(...f.velocity))).toBeLessThan(1e-9);
  expect(fm.orientation.angleTo(new Quaternion(...f.orientation))).toBeLessThan(1e-9);
  expect(fm.flightAssist).toBe(f.flightAssist);
}

const ASTEROID = (): string => fyssField(0).asteroids[0]!.id;

// ---------------------------------------------------------------------------

describe('buildSave — identity', () => {
  it('Given no previous save, Then revision is 1, saveId is a fresh v4 UUID and the save is a valid SaveV1', () => {
    const g = live();
    const s = buildSave(g.w, null);
    expect(s.format).toBe(1);
    expect(s.revision).toBe(1);
    expect(s.saveId).toMatch(UUID);
    expect(SaveV1Schema.safeParse(s).success).toBe(true);
  });

  it('Given two first saves, Then they get different saveIds', () => {
    const g = live();
    expect(buildSave(g.w, null).saveId).not.toBe(buildSave(g.w, null).saveId);
  });

  it('Given a previous save, Then revision is prev + 1 and the saveId is kept', () => {
    const g = live();
    const s1 = buildSave(g.w, null);
    const s2 = buildSave(g.w, s1);
    const s3 = buildSave(g.w, { ...s2, revision: 41 });
    expect(s2.revision).toBe(2);
    expect(s2.saveId).toBe(s1.saveId);
    expect(s3.revision).toBe(42);
    expect(s3.saveId).toBe(s1.saveId);
  });

  it('Given a running game, Then universeId is `${galaxy.id}:v1`, on the save and on the world', () => {
    const g = live();
    const s = buildSave(g.w, null);
    expect(s.universeId).toBe(`${g.u.galaxy.id}:v1`);
    expect(s.world.universeId).toBe(s.universeId);
  });

  it('Given the clocks, Then savedAt carries both: wall ms now and the orbit clock', () => {
    const g = live();
    g.frames(2);
    vi.setSystemTime(WALL + 12_345);
    const s = buildSave(g.w, null);
    expect(s.savedAt).toEqual({ wallMs: WALL + 12_345, orbitSeconds: g.u.orbitSeconds });
    expect(s.savedAt.orbitSeconds).toBeGreaterThan(0);
  });
});

describe('buildSave — player, ship and world, separately (P2)', () => {
  it('Given a ship in orbit, Then player holds the system, the parent and the parent-relative flight state', () => {
    const g = live();
    g.frames(3);
    g.u.flight.flightAssist = !g.u.flight.flightAssist;
    const s = buildSave(g.w, null);
    const sys = g.u.system;
    expect(s.player.system).toEqual({ id: sys.id, seed: sys.seed, name: sys.name, positionLy: [sys.position[0], sys.position[1], sys.position[2]] });
    expect(s.player.parentId).toBe(g.u.shipParent!.spec.id);
    expect(s.player.flight.grounded).toBe(false);
    expectFlightIs(g.u, s.player.flight);
  });

  it('Given a played tank, hold and emergency, Then ship holds the tank snapshot, the hold and timesUsed', () => {
    const g = live();
    mine(g, ASTEROID(), 'metal', 700);
    g.u.flight.propellant!.capacityLossFrac = 0.2;
    g.u.flight.propellant!.consume(1_234.5);
    g.emergency.timesUsed = 3;
    const s = buildSave(g.w, null);
    expect(s.ship).toEqual({
      propellant: g.u.flight.propellant!.snapshot(),
      cargo: g.u.cargo.snapshot(),
      emergencyTimesUsed: 3,
    });
    expect(s.ship.cargo.metal).toBe(700);
  });

  it('Given mines, Then the world holds them (worldState.entries) and the player holds no trace of them', () => {
    const g = live();
    mine(g, ASTEROID(), 'ice', 2_000);
    mine(g, ASTEROID(), 'metal', 300);
    const s = buildSave(g.w, null);
    expect(Object.keys(s.player).sort()).toEqual(['flight', 'parentId', 'system']);
    expect(Object.keys(s.world).sort()).toEqual(['entries', 'universeId']);
    expect(s.world.entries).toEqual(g.worldState.entries());
    expect(s.world.entries.every((e) => e.by === 'local')).toBe(true);
    expect(JSON.stringify(s.player)).not.toContain(ASTEROID());
  });

  it('Given a save was built, When the game goes on, Then the save does not change (it holds copies)', () => {
    const g = live();
    mine(g, ASTEROID(), 'ice', 500);
    const s = buildSave(g.w, null);
    const frozen = JSON.stringify(s);
    mine(g, ASTEROID(), 'ice', 500);
    g.shipLog.record({ key: 'note:later', kind: 'note', system: 'Fyss', title: 'later', body: ['x'] });
    g.frames(1);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('buildSave — the log comes from exportState at save time', () => {
  it('Given mission time ran on after the last log write, Then save.log is exportState() NOW (current time), not the sink\'s last state', () => {
    const g = live();
    let sunk: LogState | null = null;
    g.shipLog.setSink((st) => {
      sunk = st;
    });
    g.shipLog.record({ key: 'note:one', kind: 'note', system: 'Fyss', title: 'one', body: ['a'] });
    expect(sunk).not.toBeNull();
    g.shipLog.update(500); // mission time moves; nothing is written
    const s = buildSave(g.w, null);
    expect(s.log).toEqual(g.shipLog.exportState());
    expect(s.log.time).toBeGreaterThan(sunk!.time);
    expect(s.log.entries.some((e) => e.key === 'note:one')).toBe(true);
  });
});

describe('buildSave — cruise is saved as a circular orbit about the nearest body (§5.2)', () => {
  function cruising() {
    const g = live();
    g.frames(1); // nearest is found by update
    // Somewhere out from the parent world, moving fast and not in orbit.
    const body = g.u.shipParent!;
    g.u.flight.teleport(new Vector3(body.spec.radius * 3.2, body.spec.radius * 0.7, -body.spec.radius * 1.1), new Vector3(40, -3, 12));
    g.frames(1 / 60);
    g.u.flight.setCruise(2_000);
    expect(g.u.flight.cruising).toBe(true);
    const nearest = g.u.nearest!;
    expect(nearest).not.toBeNull();
    const radius = g.u.flight.worldPosition.distanceTo(nearest.world);
    return { g, nearest, radius };
  }

  it('Given a cruising ship, Then the save parents it to the nearest body at its current radius with |v| = √(µ/r) (1e-6)', () => {
    const { g, nearest, radius } = cruising();
    const s = buildSave(g.w, null);
    const p = new Vector3(...s.player.flight.position);
    const v = new Vector3(...s.player.flight.velocity);
    expect(s.player.parentId).toBe(nearest.spec.id);
    expect(Math.abs(p.length() - radius)).toBeLessThan(1e-6);
    expect(Math.abs(v.length() - Math.sqrt(nearest.frame.mu / p.length()))).toBeLessThan(1e-6);
    // Circular: the velocity is all tangential.
    expect(Math.abs(p.dot(v)) / (p.length() * v.length())).toBeLessThan(1e-9);
    expect(s.player.flight.grounded).toBe(false);
  });

  it('Given a cruising ship, Then the orbit keeps the ship on the same side of the body (the radial direction is kept)', () => {
    const { g, nearest } = cruising();
    const radial = g.u.flight.worldPosition.clone().sub(nearest.world).normalize();
    const s = buildSave(g.w, null);
    const p = new Vector3(...s.player.flight.position).normalize();
    expect(p.angleTo(radial)).toBeLessThan(1e-9);
  });

  it('Given a cruising ship, When saved, Then the live ship is untouched and still cruising (a save reads, it does not drop out)', () => {
    const { g } = cruising();
    const pos = g.u.flight.position.clone();
    const vel = g.u.flight.velocity.clone();
    const parent = g.u.shipParent;
    buildSave(g.w, null);
    expect(g.u.flight.cruising).toBe(true);
    expect(g.u.shipParent).toBe(parent);
    expect(g.u.flight.position.equals(pos)).toBe(true);
    expect(g.u.flight.velocity.equals(vel)).toBe(true);
  });
});

describe('buildSave — the action log', () => {
  function newSince(prev: SaveV1, next: SaveV1): ActionEntry[] {
    return next.actions.slice(prev.actions.length);
  }

  it('Given a jump, a refine and an unannounced burn between two saves, Then Σ named + thrust = the tank\'s drop (1e-9), in at most one thrust entry', () => {
    const g = live();
    mine(g, ASTEROID(), 'ice', 1_000);
    const tank = g.u.flight.propellant!;
    const s1 = buildSave(g.w, null);
    const before = tank.massKg;
    const jump = applyAction(tank, { kind: 'jump', distanceLy: 10 }); // announced
    expect(jump.ok).toBe(true);
    const refine = applyCargoAction(g.u.cargo, tank, { kind: 'refine' }); // announced, puts fuel back
    expect(refine.ok && refine.fuelKg > 0).toBe(true);
    tank.consume(250.5); // thrust: never announced
    const s2 = buildSave(g.w, s1);
    const fresh = newSince(s1, s2);
    const thrust = fresh.filter((e) => e.source === 'thrust');
    expect(thrust.length).toBeLessThanOrEqual(1);
    const thrustKg = thrust.reduce((a, e) => a + (e.payload as { kg: number }).kg, 0);
    const named = jump.kg - refine.fuelKg;
    expect(Math.abs(named + thrustKg - (before - tank.massKg))).toBeLessThan(1e-9);
    expect(Math.abs(thrustKg - 250.5)).toBeLessThan(1e-9);
    expect(s2.ship.propellant.massKg).toBe(tank.massKg);
  });

  it('Given two saves, Then the second save\'s log starts with the first save\'s log, unchanged (append-only), and adds the new entries', () => {
    const g = live();
    mine(g, ASTEROID(), 'ice', 400);
    const s1 = buildSave(g.w, null);
    expect(s1.actions.map((e) => e.source)).toEqual(expect.arrayContaining(['cargo', 'mined']));
    bus.emit('emergency:used', { kind: 'beacon' });
    const s2 = buildSave(g.w, s1);
    expect(s2.actions.slice(0, s1.actions.length)).toEqual(s1.actions);
    expect(newSince(s1, s2).some((e) => e.source === 'emergency')).toBe(true);
    const seqs = s2.actions.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('Given a loaded save with 4 999 actions and 3 new events, When saved, Then at most MAX_ACTIONS remain, starting with a checkpoint, and the save is valid', () => {
    const g = live();
    const base = buildSave(g.w, null);
    const big: SaveV1 = {
      ...base,
      actions: Array.from({ length: 4_999 }, (_, i): ActionEntry => ({
        seq: i + 1,
        source: 'propellant',
        payload: { action: { kind: 'cruise-spool' }, ok: true, kg: 100, tankDeltaKg: -100 },
        wallMs: WALL + i,
        orbitSeconds: i,
      })),
    };
    expect(applySave(g.w, big)).toBe(true);
    bus.emit('emergency:used', { kind: 'beacon' });
    bus.emit('emergency:used', { kind: 'beacon' });
    bus.emit('emergency:used', { kind: 'beacon' });
    const s = buildSave(g.w, big);
    expect(s.actions.length).toBeLessThanOrEqual(MAX_ACTIONS);
    expect(s.actions[0]!.source).toBe('checkpoint');
    expect(s.actions.at(-1)!.seq).toBeGreaterThan(4_999);
    expect(s.actions.filter((e) => e.source === 'emergency')).toHaveLength(3);
    expect(SaveV1Schema.safeParse(s).success).toBe(true);
  });
});

// --- R7: the books balance around emergencies and cruise ---------------------

describe('R7: the books balance around emergencies and cruise', () => {
  /** kg booked as unannounced thrust among `entries`. */
  function thrustKg(entries: readonly ActionEntry[]): number {
    return entries.filter((e) => e.source === 'thrust').reduce((a, e) => a + (e.payload as { kg: number }).kg, 0);
  }
  function since(prev: SaveV1, next: SaveV1): ActionEntry[] {
    return next.actions.slice(prev.actions.length);
  }

  it('Given a world with no tank attached (Yard-like hull), When buildSave, Then it returns a valid save without throwing — a sane empty tank and no thrust entry', () => {
    const g = live();
    g.u.flight.attachPropellant(null, EXHAUST_VELOCITY_KMS);
    let s: SaveV1 | null = null;
    expect(() => {
      s = buildSave(g.w, null);
    }).not.toThrow();
    const save = s as unknown as SaveV1;
    expect(SaveV1Schema.safeParse(save).success).toBe(true);
    const { massKg, capacityLossFrac } = save.ship.propellant;
    expect(Number.isFinite(massKg) && massKg >= 0).toBe(true);
    expect(Number.isFinite(capacityLossFrac) && capacityLossFrac >= 0 && capacityLossFrac <= 1).toBe(true);
    expect(save.actions.some((e) => e.source === 'thrust')).toBe(false);
  });

  it('Given unannounced thrust before the very first save, Then that first save books it (the baseline is the tank when the journal started)', () => {
    const g = live();
    const tank = g.u.flight.propellant!;
    const start = tank.massKg;
    tank.consume(321.25);
    const s = buildSave(g.w, null);
    expect(Math.abs(thrustKg(s.actions) - 321.25)).toBeLessThan(1e-9);
    expect(s.ship.propellant.massKg).toBeCloseTo(start - 321.25, 9);
  });

  it('Given a first save after only named actions (a jump), Then it books no thrust', () => {
    const g = live();
    expect(applyAction(g.u.flight.propellant!, { kind: 'jump', distanceLy: 4 }).ok).toBe(true);
    const s = buildSave(g.w, null);
    expect(thrustKg(s.actions)).toBeLessThan(1e-9);
  });

  it('Given an interval with a cannibalize and a beacon (both announce kg 0 but change the tank), Then that interval books zero thrust', () => {
    const g = live();
    const tank = g.u.flight.propellant!;
    tank.consume(tank.massKg); // dry, unannounced: booked by s1
    const s1 = buildSave(g.w, null);
    g.press('emergency');
    g.press('emergencyCannibalize'); // +3 % of base into a smaller tank
    expect(g.emergency.timesUsed).toBe(1);
    expect(tank.massKg).toBeGreaterThan(0);
    payBeacon(tank, g.u.cargo, g.shipLog, g.u.system.name); // the tank is SET to 5 % of capacity
    const s2 = buildSave(g.w, s1);
    expect(thrustKg(since(s1, s2))).toBeLessThan(1e-9);
    expect(s2.ship.propellant.massKg).toBe(tank.massKg);
  });

  it('Given an interval with a cannibalize-cargo (the gain arrives as cargo fuelKg), Then that interval books zero thrust', () => {
    const g = live();
    const tank = g.u.flight.propellant!;
    mine(g, ASTEROID(), 'metal', 1_500);
    tank.consume(tank.massKg);
    const s1 = buildSave(g.w, null);
    g.press('emergency');
    g.press('emergencyCannibalizeCargo');
    expect(tank.massKg).toBeGreaterThan(0);
    const s2 = buildSave(g.w, s1);
    expect(thrustKg(since(s1, s2))).toBeLessThan(1e-9);
  });

  it('Given an interval where a beacon fired on a 40 % tank (a LOSS, announced kg 0), Then zero thrust is booked — the loss is the beacon\'s', () => {
    const g = live();
    const tank = g.u.flight.propellant!;
    const s1 = buildSave(g.w, null);
    payBeacon(tank, g.u.cargo, g.shipLog, g.u.system.name);
    const s2 = buildSave(g.w, s1);
    expect(thrustKg(since(s1, s2))).toBeLessThan(1e-9);
  });

  /**
   * Cruise's contract (R7 (2)): the tank is billed every frame silently and
   * the leg announced later; `flushLeg()` announces what is pending. This
   * stand-in bills the real tank exactly as Cruise does.
   */
  function cruiseStandIn(g: Live) {
    let pending: { km: number; r: ActionResult } | null = null;
    const bill = (km: number): void => {
      const r = applyAction(g.u.flight.propellant!, { kind: 'cruise-leg', distanceKm: km }, { announce: false });
      pending = pending ? { km: pending.km + km, r: { ok: pending.r.ok && r.ok, kg: pending.r.kg + r.kg } } : { km, r };
    };
    const flushLeg = (): void => {
      if (pending) announceAction({ kind: 'cruise-leg', distanceKm: pending.km }, pending.r);
      pending = null;
    };
    return { bill, flushLeg };
  }

  it('Given an interval of cruise billed but not yet announced, When buildSave (with the cruise in the world), Then the leg is flushed and booked as cruise-leg kg — not thrust', () => {
    const g = live();
    const tank = g.u.flight.propellant!;
    const cruise = cruiseStandIn(g);
    const w: SaveWorld = { ...g.w, cruise };
    const s1 = buildSave(w, null);
    const before = tank.massKg;
    cruise.bill(2.0e7);
    cruise.bill(3.5e7);
    const billed = before - tank.massKg;
    expect(billed).toBeGreaterThan(0);
    const s2 = buildSave(w, s1);
    const fresh = since(s1, s2);
    expect(thrustKg(fresh)).toBeLessThan(1e-9);
    const legs = fresh.filter((e) => e.source === 'propellant' && (e.payload as { action: { kind: string } }).action.kind === 'cruise-leg');
    expect(legs).toHaveLength(1);
    expect(Math.abs((legs[0]!.payload as { kg: number }).kg - billed)).toBeLessThan(1e-9);
  });

  it('Given a leg flushed by a save, When the cruise later flushes again, Then the next save does not count it twice (and still books no thrust)', () => {
    const g = live();
    const tank = g.u.flight.propellant!;
    const cruise = cruiseStandIn(g);
    const w: SaveWorld = { ...g.w, cruise };
    const s1 = buildSave(w, null);
    const before = tank.massKg;
    cruise.bill(2.0e7);
    const s2 = buildSave(w, s1);
    cruise.flushLeg(); // nothing pending: announces nothing
    cruise.bill(1.0e7);
    const s3 = buildSave(w, s2);
    const fresh = since(s1, s3);
    const legKg = fresh
      .filter((e) => e.source === 'propellant')
      .reduce((a, e) => a + (e.payload as { kg: number }).kg, 0);
    expect(Math.abs(legKg - (before - tank.massKg))).toBeLessThan(1e-9);
    expect(thrustKg(fresh)).toBeLessThan(1e-9);
  });
});

// --- round trip ---------------------------------------------------------------

describe('round trip: buildSave → JSON → migrate → applySave into a fresh Universe', () => {
  /** Moved, mined 2 t, refined, cannibalised once — then saved. */
  function played() {
    const a = live();
    const rock = ASTEROID();
    a.frames(2);
    mine(a, rock, 'ice', 2_000);
    mine(a, rock, 'metal', 500);
    const refine = applyCargoAction(a.u.cargo, a.u.flight.propellant, { kind: 'refine' });
    expect(refine.ok).toBe(true);
    // Burn the tank dry without announcing it (thrust), then cannibalise it.
    const tank = a.u.flight.propellant!;
    tank.consume(tank.massKg);
    a.press('emergency');
    a.press('emergencyCannibalize');
    expect(a.emergency.timesUsed).toBe(1);
    expect(tank.capacityLossFrac).toBeGreaterThan(0);
    a.frames(1.5); // moved
    a.shipLog.update(600);
    const s = buildSave(a.w, null);
    const snap = {
      tank: tank.snapshot(),
      cargo: { ...a.u.cargo.snapshot() },
      timesUsed: a.emergency.timesUsed,
      depleted: { ...a.worldState.depleted(rock) },
      world: a.worldState.entries(),
      log: a.shipLog.exportState(),
      systemId: a.u.system.id,
      parentId: a.u.shipParent ? a.u.shipParent.spec.id : null,
      orbitSeconds: a.u.orbitSeconds,
    };
    a.dispose(); // A leaves the bus before B boots
    vi.stubGlobal('localStorage', new MemoryStorage()); // B must not read A's legacy log
    return { s, snap, rock };
  }

  it('Given a played state (moved, mined 2 t, refined, cannibalised once), When buildSave → JSON → migrate → applySave into a fresh Universe, Then tank, capacity loss, cargo, timesUsed, depletion, log and position match', () => {
    const { s, snap, rock } = played();
    const loaded = throughStorage(s);
    const b = live();
    expect(b.u.flight.propellant!.capacityLossFrac).toBe(0); // a new game's tank
    expect(applySave(b.w, loaded)).toBe(true);

    const tank = b.u.flight.propellant!;
    expect(tank.massKg).toBe(snap.tank.massKg);
    expect(tank.capacityLossFrac).toBe(snap.tank.capacityLossFrac);
    expect(b.u.cargo.snapshot()).toEqual(snap.cargo);
    expect(snap.cargo.metal).toBe(500);
    expect(b.emergency.timesUsed).toBe(1);
    expect(b.worldState.depleted(rock)).toEqual(snap.depleted);
    expect(snap.depleted.ice).toBe(2_000);
    expect(b.worldState.entries()).toEqual(snap.world);
    expect(b.shipLog.exportState()).toEqual(snap.log);
    expect(b.u.system.id).toBe(snap.systemId);
    expect(b.u.shipParent ? b.u.shipParent.spec.id : null).toBe(snap.parentId);
    expect(Math.abs(b.u.orbitSeconds - snap.orbitSeconds)).toBeLessThan(1e-9);
    expectFlightIs(b.u, loaded.player.flight);
  });

  it('Given the round-tripped save, Then its action log holds the whole story: mines, mined entries, the refine, the cannibalisation and the thrust', () => {
    const { s } = played();
    const loaded = throughStorage(s);
    const sources = loaded.actions.map((e) => e.source);
    expect(sources.filter((x) => x === 'mined')).toHaveLength(2);
    expect(loaded.actions.filter((e) => e.source === 'cargo').map((e) => (e.payload as { action: { kind: string } }).action.kind)).toEqual(['mine', 'mine', 'refine']);
    expect(sources).toContain('emergency');
    expect(sources).toContain('propellant'); // the cannibalize itself is a propellant:action
  });

  it('Given a loaded save, When the game goes on and saves again, Then the new save continues it: same saveId, revision + 1, the old log as prefix, fresh seqs above it', () => {
    const { s } = played();
    const loaded = throughStorage(s);
    const b = live();
    expect(applySave(b.w, loaded)).toBe(true);
    bus.emit('emergency:used', { kind: 'beacon' });
    const next = buildSave(b.w, loaded);
    expect(next.saveId).toBe(loaded.saveId);
    expect(next.revision).toBe(loaded.revision + 1);
    expect(next.actions.slice(0, loaded.actions.length)).toEqual(loaded.actions);
    const maxOld = Math.max(...loaded.actions.map((e) => e.seq));
    const fresh = next.actions.slice(loaded.actions.length);
    expect(fresh.length).toBeGreaterThan(0);
    for (const e of fresh) expect(e.seq).toBeGreaterThan(maxOld);
  });
});

// --- carried rulings -----------------------------------------------------------

describe('carried rulings', () => {
  it('R6: Given a saved log, When applySave, Then the log is the saved one exactly — the extra ARRIVED visit from the restore\'s system:entered is overwritten (import AFTER the Universe restore)', () => {
    const a = live();
    a.shipLog.record({ key: 'note:r6', kind: 'note', system: 'Fyss', title: 'r6', body: ['kept'] });
    a.shipLog.update(777);
    const s = throughStorage(buildSave(a.w, null));
    const sysKey = `sys:${a.u.system.id}`;
    expect(s.log.entries.find((e) => e.key === sysKey)!.visits).toBe(1);
    a.dispose();
    vi.stubGlobal('localStorage', new MemoryStorage());

    const b = live();
    const entered: string[] = [];
    offs.push(bus.on('system:entered', ({ system }) => entered.push(system.id)));
    expect(applySave(b.w, s)).toBe(true);
    expect(entered).toEqual([s.player.system.id]); // the restore did announce the arrival…
    expect(b.shipLog.exportState()).toEqual(s.log); // …and the saved log won
    expect(b.shipLog.all().find((e) => e.key === sysKey)!.visits).toBe(1);
  });

  it('Given a world whose tank is detached (Yard / showroom hull), When applySave, Then it does not throw and the rest is still put back', () => {
    const a = live();
    mine(a, ASTEROID(), 'metal', 900);
    a.emergency.timesUsed = 2;
    a.frames(1);
    const s = throughStorage(buildSave(a.w, null));
    a.dispose();
    vi.stubGlobal('localStorage', new MemoryStorage());

    const b = live();
    b.u.flight.attachPropellant(null, EXHAUST_VELOCITY_KMS);
    expect(() => applySave(b.w, s)).not.toThrow();
    expect(b.u.flight.propellant).toBeNull();
    expect(b.u.cargo.snapshot()).toEqual(s.ship.cargo);
    expect(b.emergency.timesUsed).toBe(2);
    expect(b.worldState.entries()).toEqual(s.world.entries);
    expectFlightIs(b.u, s.player.flight);
  });

  it('Given a save that says grounded:true with parentId null (corrupt), When applySave, Then the ship is restored AIRBORNE (grounded is honoured only with a parent)', () => {
    const a = live();
    const s = throughStorage(buildSave(a.w, null));
    a.dispose();
    const bad: SaveV1 = {
      ...s,
      player: {
        ...s.player,
        parentId: null,
        flight: { ...s.player.flight, position: [0, 0, 3e8], grounded: true },
      },
    };
    const b = live();
    expect(applySave(b.w, bad)).toBe(true);
    expect(b.u.shipParent).toBeNull();
    expect(b.u.flight.grounded).toBe(false);
  });

  it('Given a save naming a system that cannot be found, When applySave, Then it returns false and changes nothing (tank, hold, world, log, emergency, place)', () => {
    const a = live();
    mine(a, ASTEROID(), 'metal', 900);
    a.emergency.timesUsed = 2;
    a.u.flight.propellant!.capacityLossFrac = 0.3;
    const s = throughStorage(buildSave(a.w, null));
    a.dispose();
    vi.stubGlobal('localStorage', new MemoryStorage());
    const lost: SaveV1 = { ...s, player: { ...s.player, system: { ...s.player.system, id: 'gx-nowhere:s0' } } };

    const b = live();
    const before = {
      tank: b.u.flight.propellant!.snapshot(),
      cargo: { ...b.u.cargo.snapshot() },
      world: b.worldState.entries(),
      log: b.shipLog.exportState(),
      timesUsed: b.emergency.timesUsed,
      systemId: b.u.system.id,
      position: b.u.flight.position.clone(),
    };
    expect(applySave(b.w, lost)).toBe(false);
    expect(b.u.flight.propellant!.snapshot()).toEqual(before.tank);
    expect(b.u.cargo.snapshot()).toEqual(before.cargo);
    expect(b.worldState.entries()).toEqual(before.world);
    expect(b.shipLog.exportState()).toEqual(before.log);
    expect(b.emergency.timesUsed).toBe(before.timesUsed);
    expect(b.u.system.id).toBe(before.systemId);
    expect(b.u.flight.position.equals(before.position)).toBe(true);
  });

  it('Given applySave, Then restoring the world does not feed the journal (the saved mines are already in the saved log)', () => {
    const a = live();
    mine(a, ASTEROID(), 'ice', 1_000);
    const s = throughStorage(buildSave(a.w, null));
    a.dispose();
    vi.stubGlobal('localStorage', new MemoryStorage());
    const b = live();
    b.journal.drain(); // whatever a new start noted
    expect(applySave(b.w, s)).toBe(true);
    const next = buildSave(b.w, s);
    const fresh = next.actions.slice(s.actions.length);
    expect(fresh.filter((e) => e.source === 'mined' || e.source === 'cargo')).toEqual([]);
  });

});

// --- R8: the log can recompute the ship ------------------------------------------

describe('R8: replay(start, log) recomputes the live ship', () => {
  /** Two rocks in Fyss field 0: A with ice and metal, B with silicate. */
  function rocks(): { a: string; b: string } {
    const all = fyssField(0).asteroids;
    const a = all.find((x) => x.composition.ice >= 2_000 && x.composition.metal >= 1_500);
    const b = all.find((x) => x !== a && x.composition.silicate >= 1_200);
    if (!a || !b) throw new Error('fixture: Fyss field 0 lacks the rocks this session needs');
    return { a: a.id, b: b.id };
  }

  /**
   * A played session through the real code paths: moves with thrust, a jump
   * and its refund, a cruise leg and a dry partial leg, three mines across two
   * asteroids, a refine, a tank cannibalization, a repair, a cargo
   * cannibalization and a beacon — saved twice.
   */
  function played() {
    const g = live();
    const tank = g.u.flight.propellant!;
    const startState: ReplayState = {
      tank: { ...tank.snapshot() },
      cargo: { ...g.u.cargo.snapshot() },
      depletion: {},
      emergency: { cannibalize: 0, cannibalizeCargo: 0, beacon: 0 },
    };
    const { a, b } = rocks();

    g.frames(1);
    tank.consume(500); // thrust
    expect(applyAction(tank, { kind: 'jump', distanceLy: 10 }).ok).toBe(true);
    expect(applyAction(tank, { kind: 'jump-refund', kg: 1_600 }).ok).toBe(true);
    mine(g, a, 'ice', 2_000);
    mine(g, a, 'metal', 1_500);
    mine(g, b, 'silicate', 1_200);
    expect(applyCargoAction(g.u.cargo, tank, { kind: 'refine' }).ok).toBe(true);
    expect(applyAction(tank, { kind: 'cruise-leg', distanceKm: 7.5e7 }).ok).toBe(true);
    const s1 = buildSave(g.w, null);

    tank.consume(tank.massKg - 30); // thrust
    const dry = applyAction(tank, { kind: 'cruise-leg', distanceKm: 1.5e8 });
    expect(dry.ok).toBe(false);
    expect(dry.kg).toBeCloseTo(30, 9);
    g.press('emergency');
    g.press('emergencyCannibalize');
    expect(g.emergency.timesUsed).toBe(1);
    expect(applyCargoAction(g.u.cargo, tank, { kind: 'repair' }).ok).toBe(true);
    tank.consume(tank.massKg); // thrust
    g.press('emergency');
    g.press('emergencyCannibalizeCargo');
    expect(g.u.cargo.totalKg).toBe(0);
    tank.consume(tank.massKg); // thrust
    g.press('emergency');
    g.press('emergencyBeacon');
    expect(tank.massKg).toBeGreaterThan(0);
    g.frames(1);
    const s2 = buildSave(g.w, s1);

    const depletion: ReplayState['depletion'] = {};
    for (const e of g.worldState.entries()) depletion[e.id] = { ...g.worldState.depleted(e.id) };
    const now: ReplayState = {
      tank: { ...tank.snapshot() },
      cargo: { ...g.u.cargo.snapshot() },
      depletion,
      emergency: { cannibalize: g.emergency.timesUsed, cannibalizeCargo: 1, beacon: 1 },
    };
    return { g, s2, startState, now };
  }

  function expectState(got: ReplayState, want: ReplayState): void {
    expect(Math.abs(got.tank.massKg - want.tank.massKg)).toBeLessThan(1e-6);
    expect(Math.abs(got.tank.capacityLossFrac - want.tank.capacityLossFrac)).toBeLessThan(1e-9);
    for (const r of ['ice', 'metal', 'silicate', 'rare'] as const) expect(Math.abs(got.cargo[r] - want.cargo[r])).toBeLessThan(1e-6);
    const ids = new Set([...Object.keys(got.depletion), ...Object.keys(want.depletion)]);
    expect(ids.size).toBe(2);
    for (const id of ids) {
      for (const r of ['ice', 'metal', 'silicate', 'rare'] as const) {
        expect(Math.abs((got.depletion[id]?.[r] ?? 0) - (want.depletion[id]?.[r] ?? 0)), `${id} ${r}`).toBeLessThan(1e-6);
      }
    }
    expect(got.emergency).toEqual(want.emergency);
  }

  it('Given a played session, When its whole log is replayed from the start state, Then tank (1e-6 kg), capacity loss (1e-9), hold, depletion (1e-6) and emergency counts equal the live ship', () => {
    const { s2, startState, now } = played();
    expectState(replay(startState, s2.actions), now);
  });

  it('Given the same log compacted to 5 entries, Then replay still equals the live ship, and the save is valid', () => {
    const { s2, startState, now } = played();
    const c = compactEntries(s2.actions, 5);
    expect(c).toHaveLength(5);
    expectState(replay(startState, c), now);
    expect(SaveV1Schema.safeParse({ ...s2, actions: c }).success).toBe(true);
  });

  it('Given the log compacted twice (to 12, then to 5), Then replay still equals the live ship', () => {
    const { s2, startState, now } = played();
    expectState(replay(startState, compactEntries(compactEntries(s2.actions, 12), 5)), now);
  });

  it('Given the compacted save through JSON and migrate, Then replay of the loaded log still equals the live ship', () => {
    const { s2, startState, now } = played();
    const loaded = throughStorage({ ...s2, actions: compactEntries(s2.actions, 5) });
    expectState(replay(startState, loaded.actions), now);
  });
});

// --- M-2: an unexplained gain is counted, not swallowed -----------------------------

describe('M-2: a tank that rose without a named action is counted', () => {
  it('Given the tank gained 250 kg with no announcement, When saved, Then no thrust is booked and the journal counts 250 kg unexplained', () => {
    const g = live();
    const s1 = buildSave(g.w, null);
    g.u.flight.propellant!.add(250);
    const s2 = buildSave(g.w, s1);
    expect(s2.actions.slice(s1.actions.length).some((e) => e.source === 'thrust')).toBe(false);
    expect(g.journal.unexplainedGainKg).toBeCloseTo(250, 9);
  });
});

// --- M-4: cruise outside every SOI goes round the star ---------------------------------

describe('M-4: a cruise save orbits the nearest body only inside its SOI', () => {
  /** The star's µ (private on Universe; read for the check only). */
  const starMu = (u: Universe): number => (u as unknown as { starFrame: { mu: number } }).starFrame.mu;

  /**
   * `nearest` is set by hand: the harness stubs the GPU-bound `updateBodies`,
   * which is what keeps each body's distance (and so `nearest`) current.
   */
  type AnyBody = NonNullable<Universe['nearest']>;
  const setNearest = (u: Universe, b: AnyBody | null): void => {
    (u as unknown as { nearest: AnyBody | null }).nearest = b;
  };

  function farOut() {
    const g = live();
    g.frames(1);
    const home = g.u.shipParent!;
    g.u.restoreParent(null); // star-relative from here
    g.u.flight.teleport(new Vector3(0, 7.5e8, 0), new Vector3(30, 0, 5)); // ~5 AU above the plane
    g.frames(1 / 60);
    g.u.flight.setCruise(2_000);
    expect(g.u.flight.cruising).toBe(true);
    setNearest(g.u, home);
    return { g, home };
  }

  it('Given a cruising ship outside the nearest body\'s SOI, When saved, Then it is parented to the star in a circular orbit: |v| = √(µ★/r) (1e-6), velocity ⊥ radius', () => {
    const { g, home } = farOut();
    expect(g.u.shipParent).toBeNull();
    expect(g.u.flight.worldPosition.distanceTo(home.world)).toBeGreaterThan(home.soiRadius);
    const r = g.u.flight.worldPosition.length();
    const s = buildSave(g.w, null);
    const p = new Vector3(...s.player.flight.position);
    const v = new Vector3(...s.player.flight.velocity);
    expect(s.player.parentId).toBeNull();
    expect(Math.abs(p.length() - r)).toBeLessThan(1e-6);
    expect(Math.abs(v.length() - Math.sqrt(starMu(g.u) / p.length()))).toBeLessThan(1e-6);
    expect(Math.abs(p.dot(v)) / (p.length() * v.length())).toBeLessThan(1e-9);
    expect(s.player.flight.grounded).toBe(false);
  });

  it('Given a cruising ship inside the nearest body\'s SOI, Then it is still saved around that body', () => {
    const g = live();
    g.frames(1);
    const body = g.u.shipParent!;
    g.u.flight.teleport(new Vector3(body.spec.radius * 3.2, 0, 0), new Vector3(0, 0, 9));
    g.frames(1 / 60);
    g.u.flight.setCruise(2_000);
    setNearest(g.u, body);
    expect(g.u.flight.worldPosition.distanceTo(body.world)).toBeLessThan(body.soiRadius);
    const s = buildSave(g.w, null);
    expect(s.player.parentId).toBe(body.spec.id);
    expect(Math.abs(new Vector3(...s.player.flight.position).length() - g.u.flight.worldPosition.distanceTo(body.world))).toBeLessThan(1e-6);
  });

  it('Given a cruising ship with no nearest body and no parent, When saved, Then it is saved in a circular orbit about the star — never with the raw cruise velocity', () => {
    const { g } = farOut();
    setNearest(g.u, null);
    expect(g.u.shipParent).toBeNull();
    const raw = g.u.flight.velocity.clone();
    const s = buildSave(g.w, null);
    const p = new Vector3(...s.player.flight.position);
    const v = new Vector3(...s.player.flight.velocity);
    expect(s.player.parentId).toBeNull();
    expect(Math.abs(v.length() - Math.sqrt(starMu(g.u) / p.length()))).toBeLessThan(1e-6);
    expect(v.distanceTo(raw)).toBeGreaterThan(1e-3);
  });
});

// --- M-5: loading over a live cruise or spool ---------------------------------------------

describe('M-5: applySave while the cruise drive is spooling or cruising', () => {
  function withCruise() {
    const g = live();
    const cruise = new Cruise({ universe: g.u });
    cruise.init();
    offs.push(() => cruise.dispose());
    const axes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
    const pressed = new Set<ActionName>();
    let elapsed = 0;
    const cctx = {
      input: { axes, pressed: (a: ActionName) => pressed.has(a), held: () => false },
      get elapsed() {
        return elapsed;
      },
    } as unknown as EngineContext;
    const step = (seconds: number): void => {
      const n = Math.max(1, Math.round(seconds * 60));
      for (let i = 0; i < n; i++) {
        g.u.update(1 / 60, g.ctx);
        // The harness stubs `updateBodies`, which keeps `nearest` and the
        // clearance current; give Cruise the parent's, as Cruise.test's world stub does.
        const parent = g.u.shipParent;
        if (parent) {
          const raw = g.u as unknown as { nearest: unknown; nearestGapKm: number };
          raw.nearest = parent;
          raw.nearestGapKm = g.u.flight.position.length() - parent.spec.radius;
        }
        cruise.update(1 / 60, cctx);
        pressed.clear();
        elapsed += 1 / 60;
      }
    };
    const w: SaveWorld = { ...g.w, cruise };
    g.u.flight.flightAssist = false; // nothing of its own draws on the tank
    const saved = throughStorage(buildSave(w, null));
    const seen: string[] = [];
    return { g, cruise, w, saved, step, press: (a: ActionName) => pressed.add(a), seen };
  }

  function expectCleanLoad(r: ReturnType<typeof withCruise>): void {
    const tank = r.g.u.flight.propellant!;
    expect(applySave(r.w, r.saved)).toBe(true);
    expect(r.cruise.drive.phase).toBe('idle');
    expect(r.g.u.flight.cruising).toBe(false);
    expect(tank.snapshot()).toEqual(r.saved.ship.propellant);
    offs.push(bus.on('propellant:action', (e) => r.seen.push(e.action.kind)));
    r.step(2);
    // No spool refund and no leg reaches the restored tank or the log.
    expect(r.seen).toEqual([]);
    expect(tank.massKg).toBe(r.saved.ship.propellant.massKg);
    const fresh = buildSave(r.w, r.saved).actions.slice(r.saved.actions.length);
    expect(fresh.filter((e) => e.source === 'propellant' || e.source === 'thrust')).toEqual([]);
  }

  it('Given the drive spooling (its price paid), When a save is loaded, Then Cruise is reset — no spool refund reaches the restored tank, no phantom leg', () => {
    const r = withCruise();
    r.press('cruise');
    r.step(0.5);
    expect(r.cruise.drive.phase).toBe('spooling');
    expect(r.g.u.flight.propellant!.massKg).toBeLessThan(r.saved.ship.propellant.massKg);
    expectCleanLoad(r);
  });

  it('Given the ship cruising with a leg pending, When a save is loaded, Then Cruise is reset — not cruising, no phantom leg, the restored tank untouched', () => {
    const r = withCruise();
    r.press('cruise');
    r.step(CRUISE_DEFAULTS.spoolTime + 0.5);
    expect(r.cruise.drive.phase).toBe('cruise');
    r.step(0.4);
    expectCleanLoad(r);
  });
});
