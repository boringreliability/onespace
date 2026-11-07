/**
 * v3 T3, phase D — the time rate while the autopilot flies (D0 point 3):
 * auto-10× while the computer flies hands-off above 20 km AGL and outside
 * thick air, 1× below; any pilot input drops it to 1×.
 *
 * `autopilotTimeRate` is pure; `TimeControl` applies it (tested further down
 * with stubs for Universe, the input and the autopilot).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { ActionName, InputAxes } from '@/core/Input';
import type { Universe } from '@/game/Universe';
import type { Hud } from '@/ui/Hud';
import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import { AUTOPILOT_FAST_ALT_KM, THICK_AIR_RHO, autopilotTimeRate } from './timeCompression';
import { TimeControl } from './TimeControl';

const hand = { altKm: 100, rho: 0, phase: 'descent' as const, hands: false };

describe('autopilotTimeRate (pure)', () => {
  it('Given the computer flying hands-off at 100 km in vacuum, Then the rate is 10×', () => {
    expect(autopilotTimeRate(hand)).toBe(10);
  });

  it(`Given the floor, Then it is ${20} km of terrain altitude`, () => {
    expect(AUTOPILOT_FAST_ALT_KM).toBe(20);
  });

  it('Given an altitude at or below 20 km, Then 1× — the end of the landing is watched in real time', () => {
    expect(autopilotTimeRate({ ...hand, altKm: 20 })).toBe(1);
    expect(autopilotTimeRate({ ...hand, altKm: 5 })).toBe(1);
    expect(autopilotTimeRate({ ...hand, altKm: 20.01 })).toBe(10);
  });

  it('Given thick air (density at or above THICK_AIR_RHO), Then 1×, at any altitude', () => {
    expect(autopilotTimeRate({ ...hand, altKm: 300, rho: THICK_AIR_RHO })).toBe(1);
    expect(autopilotTimeRate({ ...hand, altKm: 300, rho: THICK_AIR_RHO * 0.99 })).toBe(10);
  });

  it('Given hands on the controls, Then 1×', () => {
    expect(autopilotTimeRate({ ...hand, hands: true })).toBe(1);
  });

  it("Given phase 'idle' (nothing flying) or 'final', Then 1×", () => {
    expect(autopilotTimeRate({ ...hand, phase: 'idle' })).toBe(1);
    expect(autopilotTimeRate({ ...hand, phase: 'final' })).toBe(1);
  });

  it('Given the orbit leg climbing above 20 km in vacuum, Then 10× too (ascent / circularise)', () => {
    expect(autopilotTimeRate({ ...hand, phase: 'ascent' })).toBe(10);
    expect(autopilotTimeRate({ ...hand, phase: 'circularise' })).toBe(10);
  });

  it('Given NaN altitude or density, Then 1× — never fast on a degenerate readout', () => {
    expect(autopilotTimeRate({ ...hand, altKm: Number.NaN })).toBe(1);
    expect(autopilotTimeRate({ ...hand, rho: Number.NaN })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TimeControl, wired
// ---------------------------------------------------------------------------

class StubInput {
  readonly axes: InputAxes = { pitch: 0, yaw: 0, roll: 0, throttle: 0, strafeX: 0, strafeY: 0, strafeZ: 0 };
  readonly heldActions = new Set<ActionName>();
  private presses = new Set<ActionName>();
  press(a: ActionName): void {
    this.presses.add(a);
  }
  pressed(a: ActionName): boolean {
    return this.presses.has(a);
  }
  held(a: ActionName): boolean {
    return this.heldActions.has(a);
  }
  endFrame(): void {
    this.presses.clear();
  }
}

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function rig() {
  const R = 1_000;
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  const frame = { position: new Vector3(), velocity: new Vector3(), mu: 1_500, radius: R };
  fm.setParent(frame);
  let ground = 100; // km of terrain altitude, set by the test
  fm.setGroundSampler(() => ground);
  const p = new Vector3(R + 100, 0, 0);
  fm.teleport(p, fm.orbitalVelocityAt(p));
  fm.update(1 / 60);

  const universe = {
    flight: fm,
    paused: false,
    frozen: false,
    simRate: 1,
    shipParent: { spec: { radius: R, atmosphere: null }, frame, soiRadius: 1e6 },
  } as unknown as Universe;
  const rates: number[] = [];
  const hud = { setTimeRate: (r: number) => rates.push(r) } as unknown as Hud;
  const autopilot = { active: true, phase: 'descent' as string };
  const input = new StubInput();
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  const tc = new TimeControl({ universe, warp: { phase: 'idle' }, autopilot, hud });
  tc.init();
  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)), () => tc.dispose());
  return {
    fm,
    universe,
    autopilot,
    input,
    rates,
    logs,
    setAlt(km: number) {
      ground = km;
      fm.update(1 / 60); // altitude is the sampler's, refreshed by an update
    },
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        tc.update(1 / 60, ctx);
        input.endFrame();
      }
    },
  };
}

describe('TimeControl applies the autopilot rate', () => {
  it('Given the autopilot flying hands-off at 100 km in vacuum, When a frame runs, Then Universe.simRate is 10 and the HUD shows ×10', () => {
    const r = rig();
    r.setAlt(100);
    r.tick();
    expect(r.universe.simRate).toBe(10);
    expect(r.rates).toContain(10);
  });

  it('Given auto-10×, When the ship descends through 20 km, Then it drops to 1× on that frame', () => {
    const r = rig();
    r.setAlt(100);
    r.tick();
    expect(r.universe.simRate).toBe(10);
    r.setAlt(19);
    r.tick();
    expect(r.universe.simRate).toBe(1);
    expect(r.rates[r.rates.length - 1]).toBe(1);
  });

  it('Given auto-10×, When the pilot touches the stick, Then 1× that same frame (the autopilot disengages separately)', () => {
    const r = rig();
    r.setAlt(100);
    r.tick();
    r.input.axes.pitch = 0.5;
    r.tick();
    expect(r.universe.simRate).toBe(1);
  });

  it('Given auto-10×, When the autopilot completes or is disengaged, Then the rate it chose is not left behind: 1×', () => {
    const r = rig();
    r.setAlt(100);
    r.tick();
    r.autopilot.active = false;
    r.autopilot.phase = 'idle';
    r.tick();
    expect(r.universe.simRate).toBe(1);
  });

  it('Given the autopilot flying, When "." is pressed, Then it is refused and the autopilot keeps choosing the rate', () => {
    const r = rig();
    r.setAlt(100);
    r.tick();
    r.input.press('timeFaster');
    r.tick();
    expect(r.universe.simRate).toBe(10);
    expect(r.logs.some((t) => t.includes('DENIED') && t.includes('AUTOPILOT'))).toBe(true);
  });

  it('Given the autopilot flying low (1×), Then "." is refused too — the D0 rule, not the pilot, picks 10×', () => {
    const r = rig();
    r.setAlt(5);
    r.tick();
    r.input.press('timeFaster');
    r.tick();
    expect(r.universe.simRate).toBe(1);
  });
});
