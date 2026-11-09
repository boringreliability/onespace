/**
 * review-p1 — the recovery cut's hand-off to the rest of the game, in node
 * (no `init()`, so no veil; `update()` needs none of the DOM).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { Universe } from '@/game/Universe';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
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

  function fuelledRig(tank: Propellant | null) {
    const command = { throttle: 0 };
    let recovered = 0;
    const universe = {
      insideStar: false,
      paused: false,
      flight: { command, propellant: tank },
      recoverToOrbit: () => {
        recovered++;
      },
    };
    const ctx = { input: { setThrottle: () => {} } } as unknown as EngineContext;
    const cut = new RecoveryCut(universe as unknown as Universe);
    const used: string[] = [];
    const actions: string[] = [];
    offs.push(bus.on('emergency:used', ({ kind }) => used.push(kind)));
    offs.push(
      bus.on('propellant:action' as never, ((e: { action: { kind: string } }) => actions.push(e.action.kind)) as never),
    );
    const run = (cause: 'requested' | 'crash' | 'star'): void => {
      cut.request(cause);
      for (let i = 0; i < 120; i++) cut.update(1 / 60, ctx);
    };
    return { cut, run, used, actions, recovered: () => recovered };
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
});
