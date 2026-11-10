/**
 * review-p1 — the recovery cut's hand-off to the rest of the game, in node
 * (no `init()`, so no veil; `update()` needs none of the DOM).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { Universe } from '@/game/Universe';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { CARGO_CAPACITY_KG, Cargo, type Resource } from '@/ship/cargo';
import { ShipLog } from './Log';
import { RecoveryCut } from './RecoveryCut';

const offs: Array<() => void> = [];
afterEach(() => {
  for (const o of offs.splice(0)) o();
});

function rig() {
  const command = { throttle: 0.6 };
  let recovered = 0;
  const universe = {
    insideStar: false,
    paused: false,
    flight: { command },
    recoverToOrbit: () => {
      recovered++;
    },
  };
  const lever: number[] = [];
  const ctx = { input: { setThrottle: (v: number) => lever.push(v) } } as unknown as EngineContext;
  const cut = new RecoveryCut(universe as unknown as Universe);
  return { cut, ctx, command, lever, recovered: () => recovered };
}

describe('review-p1: RecoveryCut', () => {
  it('Given RETURN TO ORBIT with the lever at 60 %, When the cut reaches black, Then the ship is moved once, the lever AND the stale command are cut, and ship:recovered is announced once', () => {
    const r = rig();
    const events: string[] = [];
    offs.push(bus.on('ship:recovered', ({ cause }) => events.push(cause)));
    r.cut.request('requested');
    for (let i = 0; i < 120; i++) r.cut.update(1 / 60, r.ctx);
    expect(r.recovered()).toBe(1);
    expect(r.lever).toEqual([0]);
    // Pilot is frozen through the fade; without this the first physics step
    // after it flew the old 60 % as an FA-ON speed hold (e = 0.12).
    expect(r.command.throttle).toBe(0);
    expect(events).toEqual(['requested']);
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I1 — RETURN TO ORBIT is not a free refill.
// Owner ruling: with a tank it stays as a "stuck" rescue but costs exactly what
// the beacon costs: the tank is SET to 5 % of current capacity (the beacon
// rule, as a named action) and emergency:used { kind: 'beacon' } is emitted
// (sub-plan 2 hangs cargo loss on that). No tank: v3, free. A crash or star
// recovery (cause not 'requested') stays free, as in v3.
// ---------------------------------------------------------------------------

describe('final review I1 — RETURN TO ORBIT costs as the beacon', () => {
  const CAP = PROBE_TANK_CAPACITY_KG;

  // [v4-mining] Task 6: the universe carries the hold, and the cut writes the
  // beacon's logbook note — RecoveryCut is built with the ship's log.
  function fuelledRig(tank: Propellant | null, hold: Partial<Record<Resource, number>> = {}) {
    const command = { throttle: 0 };
    let recovered = 0;
    const cargo = new Cargo(CARGO_CAPACITY_KG);
    cargo.restore(hold);
    const log = new ShipLog();
    const universe = {
      insideStar: false,
      paused: false,
      flight: { command, propellant: tank },
      cargo,
      recoverToOrbit: () => {
        recovered++;
      },
    };
    const ctx = { input: { setThrottle: () => {} } } as unknown as EngineContext;
    const cut = new RecoveryCut(universe as unknown as Universe, log);
    const used: string[] = [];
    const actions: string[] = [];
    const cargoActions: Array<{ kind: string; ok: boolean; kgOut: number }> = [];
    offs.push(bus.on('emergency:used', ({ kind }) => used.push(kind)));
    offs.push(
      bus.on('propellant:action', (e) => actions.push(e.action.kind)),
    );
    offs.push(
      bus.on('cargo:action', ({ action, result }) =>
        cargoActions.push({ kind: action.kind, ok: result.ok, kgOut: result.kgOut }),
      ),
    );
    const run = (cause: 'requested' | 'crash' | 'star'): void => {
      cut.request(cause);
      for (let i = 0; i < 120; i++) cut.update(1 / 60, ctx);
    };
    const beaconNotes = () => log.all().filter((e) => e.title === 'BEACON RECOVERY');
    return { cut, run, used, actions, cargo, log, cargoActions, beaconNotes, recovered: () => recovered };
  }

  it("Given a tank, When RETURN TO ORBIT is chosen from pause, Then the ship is recovered and the tank is set to 5 % of current capacity and emergency:used {kind:'beacon'} is emitted", () => {
    const tank = new Propellant(CAP, 0.6);
    tank.capacityLossFrac = 0.2;
    const r = fuelledRig(tank);
    r.run('requested');
    expect(r.recovered()).toBe(1);
    expect(tank.massKg).toBeCloseTo(0.05 * 0.8 * CAP, 6);
    expect(tank.capacityLossFrac).toBeCloseTo(0.2, 12);
    expect(r.used).toEqual(['beacon']);
  });

  it('Given a tank holding less than 5 %, When RETURN TO ORBIT is chosen, Then it is set (not topped past) to exactly 5 % of current capacity, as the beacon does', () => {
    const tank = new Propellant(CAP, 0.01);
    const r = fuelledRig(tank);
    r.run('requested');
    expect(tank.massKg).toBeCloseTo(0.05 * CAP, 6);
  });

  it('Given a tank, When RETURN TO ORBIT is chosen, Then the tank change goes through the beacon action (propellant:action beacon), exactly once', () => {
    const r = fuelledRig(new Propellant(CAP, 0.6));
    r.run('requested');
    expect(r.actions).toEqual(['beacon']);
  });

  it('Given no tank, When RETURN TO ORBIT is chosen, Then v3 behaviour (free): recovered, no emergency:used, no tank action', () => {
    const r = fuelledRig(null);
    r.run('requested');
    expect(r.recovered()).toBe(1);
    expect(r.used).toEqual([]);
    expect(r.actions).toEqual([]);
  });

  it('Given a crash recovery, Then the tank is unchanged and no emergency:used is emitted', () => {
    const tank = new Propellant(CAP, 0.6);
    const r = fuelledRig(tank);
    r.run('crash');
    expect(r.recovered()).toBe(1);
    expect(tank.massKg).toBeCloseTo(0.6 * CAP, 9);
    expect(r.used).toEqual([]);
    expect(r.actions).toEqual([]);
  });

  it('Given a star recovery (photosphere), Then the tank is unchanged', () => {
    const tank = new Propellant(CAP, 0.6);
    const r = fuelledRig(tank);
    r.run('star');
    expect(tank.massKg).toBeCloseTo(0.6 * CAP, 9);
    expect(r.used).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // v4 sub-plan 2 (mining), Task 6 — D11: RETURN TO ORBIT with a tank IS the
  // beacon, cargo included (payBeacon). Crash and star recoveries stay free
  // and keep the hold (v3).
  // -------------------------------------------------------------------------

  it('Given cargo and RETURN TO ORBIT with a tank, Then the same as the beacon: hold emptied via one jettison-all, a BEACON RECOVERY note, tank at 5 %, emergency:used beacon', () => {
    const tank = new Propellant(CAP, 0.6);
    const r = fuelledRig(tank, { metal: 2_000, ice: 1_000 });
    r.run('requested');
    expect(r.recovered()).toBe(1);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.cargoActions).toEqual([{ kind: 'jettison-all', ok: true, kgOut: 3_000 }]);
    const notes = r.beaconNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('note');
    expect(notes[0]!.key).toBe('beacon:1');
    expect(tank.massKg).toBeCloseTo(0.05 * CAP, 6);
    expect(r.actions).toEqual(['beacon']);
    expect(r.used).toEqual(['beacon']);
  });

  it('Given RETURN TO ORBIT with a tank and an EMPTY hold, Then the note is still written and nothing throws', () => {
    const r = fuelledRig(new Propellant(CAP, 0.6));
    expect(() => r.run('requested')).not.toThrow();
    expect(r.beaconNotes()).toHaveLength(1);
    expect(r.cargoActions).toEqual([{ kind: 'jettison-all', ok: false, kgOut: 0 }]);
  });

  it('Given two RETURN TO ORBITs, Then each gets its own note (beacon:1, beacon:2)', () => {
    const r = fuelledRig(new Propellant(CAP, 0.6), { metal: 3_000 });
    r.run('requested');
    r.run('requested');
    expect(r.beaconNotes().map((e) => e.key).sort()).toEqual(['beacon:1', 'beacon:2']);
  });

  it('Given a crash recovery, Then the cargo is untouched (free, v3): no cargo:action, no note', () => {
    const r = fuelledRig(new Propellant(CAP, 0.6), { metal: 2_000, ice: 1_000 });
    r.run('crash');
    expect(r.recovered()).toBe(1);
    expect(r.cargo.totalKg).toBe(3_000);
    expect(r.cargo.kg('metal')).toBe(2_000);
    expect(r.cargoActions).toEqual([]);
    expect(r.beaconNotes()).toEqual([]);
  });

  it('Given a star recovery, Then the cargo is untouched (free, v3)', () => {
    const r = fuelledRig(new Propellant(CAP, 0.6), { metal: 3_000 });
    r.run('star');
    expect(r.cargo.totalKg).toBe(3_000);
    expect(r.cargoActions).toEqual([]);
    expect(r.beaconNotes()).toEqual([]);
  });

  it('Given no tank, When RETURN TO ORBIT, Then free as in v3: the cargo is kept and no note is written', () => {
    const r = fuelledRig(null, { metal: 3_000 });
    r.run('requested');
    expect(r.recovered()).toBe(1);
    expect(r.cargo.totalKg).toBe(3_000);
    expect(r.cargoActions).toEqual([]);
    expect(r.beaconNotes()).toEqual([]);
  });
});
