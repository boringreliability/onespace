/**
 * v4 sub-plan 1 (propellant), Task 6 — the emergency exit, wired.
 *
 * Contract with the pilot:
 * - Only an EMPTY tank (propellant 0) offers "EMERGENCY · [key]".
 * - Nothing happens on its own: the key opens the choice, and only the
 *   player's pick (cannibalize or beacon) changes anything.
 * - Cannibalize: +3 % of base capacity, a permanent 8 · 1.5^n % loss, emits
 *   `emergency:used` { kind: 'cannibalize' }. Refused → only the beacon is offered.
 * - Beacon: `recoverToOrbit()`, tank set to 5 % of current capacity, the log says
 *   "RECOVERED · BEACON", `ship:recovered` lets go of anything flying the ship,
 *   and `emergency:used` { kind: 'beacon' } is emitted.
 *
 * The keys come from one exported constant (`EMERGENCY_KEYS`) and reach the
 * module the same way the real Input delivers them: code → action.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import { EMERGENCY_KEYS, actionForKey, type ActionName } from '@/core/Input';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { Emergency, type EmergencyWorld } from './Emergency';

const BASE = PROBE_TANK_CAPACITY_KG;
/** 'KeyH' → 'H', 'Digit1' → '1': what the HUD prints for a key code. */
const label = (code: string): string => code.replace(/^Key/, '').replace(/^Digit/, '');

class StubInput {
  private presses = new Set<ActionName>();
  pressKey(code: string): void {
    const a = actionForKey(code);
    if (a) this.presses.add(a);
  }
  pressed(a: ActionName): boolean {
    return this.presses.has(a);
  }
  held(): boolean {
    return false;
  }
  isDown(): boolean {
    return false;
  }
  setThrottle(): void {}
  endFrame(): void {
    this.presses.clear();
  }
}

interface Harness {
  em: Emergency;
  tank: Propellant;
  input: StubInput;
  recoveries: number;
  logs: string[];
  used: Array<'cannibalize' | 'beacon'>;
  recovered: number;
  tick(n?: number): void;
  press(code: string): void;
}

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function harness(opts: { fill?: number; lossFrac?: number } = {}): Harness {
  const tank = new Propellant(BASE, opts.fill ?? 0);
  tank.capacityLossFrac = opts.lossFrac ?? 0;
  const input = new StubInput();
  const h = {
    tank,
    input,
    recoveries: 0,
    logs: [] as string[],
    used: [] as Array<'cannibalize' | 'beacon'>,
    recovered: 0,
  } as Harness;
  const world: EmergencyWorld = {
    flight: { propellant: tank },
    paused: false,
    recoverToOrbit: () => {
      h.recoveries++;
    },
  };
  h.em = new Emergency({ universe: world });
  offs.push(bus.on('log', ({ text }) => h.logs.push(text)));
  offs.push(bus.on('emergency:used', ({ kind }) => h.used.push(kind)));
  offs.push(bus.on('ship:recovered', () => h.recovered++));
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  h.em.init?.();
  h.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      h.em.update(1 / 60, ctx);
      input.endFrame();
    }
  };
  h.press = (code: string) => {
    input.pressKey(code);
    h.tick();
  };
  return h;
}

describe('the keys', () => {
  it('are bound in Input: open, cannibalize and beacon each map to their own action', () => {
    expect(actionForKey(EMERGENCY_KEYS.open)).toBe('emergency');
    expect(actionForKey(EMERGENCY_KEYS.cannibalize)).toBe('emergencyCannibalize');
    expect(actionForKey(EMERGENCY_KEYS.beacon)).toBe('emergencyBeacon');
  });

  it('are three different keys', () => {
    const codes = new Set(Object.values(EMERGENCY_KEYS));
    expect(codes.size).toBe(3);
  });
});

describe('the prompt', () => {
  it(`Given an empty tank, Then the HUD offers "EMERGENCY · [key]" and nothing happens without the player's choice`, () => {
    const h = harness({ fill: 0 });
    h.tick(600);
    expect(h.em.prompt).toBe(`EMERGENCY · ${label(EMERGENCY_KEYS.open)}`);
    expect(h.tank.massKg).toBe(0);
    expect(h.tank.capacityLossFrac).toBe(0);
    expect(h.recoveries).toBe(0);
    expect(h.used).toEqual([]);
    expect(h.em.timesUsed).toBe(0);
  });

  it('Given an empty tank, When the key is pressed, Then the choice opens but still nothing is applied', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.open).toBe(true);
    expect(h.em.offers).toEqual(['cannibalize', 'beacon']);
    h.tick(600);
    expect(h.tank.massKg).toBe(0);
    expect(h.tank.capacityLossFrac).toBe(0);
    expect(h.recoveries).toBe(0);
    expect(h.used).toEqual([]);
  });

  it('Given an empty tank, When a choice key is pressed WITHOUT opening the choice first, Then nothing happens', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.cannibalize);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.tank.massKg).toBe(0);
    expect(h.tank.capacityLossFrac).toBe(0);
    expect(h.recoveries).toBe(0);
    expect(h.used).toEqual([]);
  });

  it('Given the choice is open, When the key is pressed again, Then it closes with nothing applied', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.open).toBe(false);
    expect(h.used).toEqual([]);
  });

  it('Given propellant above 0, Then the emergency prompt is not offered', () => {
    const h = harness({ fill: 0.001 });
    h.tick(60);
    expect(h.em.prompt).toBeNull();
    expect(h.em.offers).toEqual([]);
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.open).toBe(false);
    h.press(EMERGENCY_KEYS.cannibalize);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.tank.capacityLossFrac).toBe(0);
    expect(h.recoveries).toBe(0);
    expect(h.used).toEqual([]);
  });
});

describe('cannibalize', () => {
  it('Given an empty tank, When cannibalize is chosen, Then propellant rises by 3 % of base capacity and capacityLossFrac rises by 8 %', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(h.tank.massKg).toBeCloseTo(0.03 * BASE, 9);
    expect(h.tank.capacityLossFrac).toBeCloseTo(0.08, 12);
    expect(h.used).toEqual(['cannibalize']);
    expect(h.em.timesUsed).toBe(1);
    expect(h.recoveries).toBe(0);
    // The tank is no longer empty: the prompt and the choice are gone.
    expect(h.em.open).toBe(false);
    expect(h.em.prompt).toBeNull();
  });

  it('When used a second time, Then the loss is 12 %', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    h.tank.consume(h.tank.massKg);
    h.tick();
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(h.tank.capacityLossFrac).toBeCloseTo(0.08 + 0.12, 12);
    expect(h.tank.massKg).toBeCloseTo(0.03 * BASE, 9);
    expect(h.used).toEqual(['cannibalize', 'cannibalize']);
    expect(h.em.timesUsed).toBe(2);
  });

  it('Given a restored use count (a save), Then the next loss follows it: timesUsed 2 → 18 %', () => {
    const h = harness({ fill: 0 });
    h.em.timesUsed = 2;
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(h.tank.capacityLossFrac).toBeCloseTo(0.18, 12);
    expect(h.em.timesUsed).toBe(3);
  });

  it('Given capacity too low to pay the loss, Then cannibalize is refused and only the beacon is offered', () => {
    const h = harness({ fill: 0, lossFrac: 0.95 });
    h.tick();
    expect(h.em.prompt).toBe(`EMERGENCY · ${label(EMERGENCY_KEYS.open)}`);
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.offers).toEqual(['beacon']);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(h.tank.massKg).toBe(0);
    expect(h.tank.capacityLossFrac).toBeCloseTo(0.95, 12);
    expect(h.used).toEqual([]);
    expect(h.em.timesUsed).toBe(0);
    // The beacon still answers.
    expect(h.em.open).toBe(true);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.recoveries).toBe(1);
    expect(h.used).toEqual(['beacon']);
  });
});

describe('beacon', () => {
  it('When beacon is chosen, Then recoverToOrbit runs, the tank is set to 5 % of current capacity, and the log says "RECOVERED · BEACON"', () => {
    const h = harness({ fill: 0, lossFrac: 0.2 });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.recoveries).toBe(1);
    expect(h.tank.massKg).toBeCloseTo(0.05 * h.tank.capacityKg, 9);
    expect(h.tank.massKg).toBeCloseTo(0.05 * 0.8 * BASE, 9);
    expect(h.tank.capacityLossFrac).toBeCloseTo(0.2, 12);
    expect(h.logs).toContain('RECOVERED · BEACON');
    expect(h.used).toEqual(['beacon']);
    // Cargo loss is added in sub-plan 2; the beacon does not count as a cannibalization.
    expect(h.em.timesUsed).toBe(0);
    expect(h.em.open).toBe(false);
    expect(h.em.prompt).toBeNull();
  });

  it('When beacon is chosen, Then ship:recovered is emitted so the cruise drive and autopilot let go', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.recovered).toBe(1);
  });

  it('Each choice is applied once per press: holding the frame loop runs nothing twice', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    h.tick(120);
    expect(h.recoveries).toBe(1);
    expect(h.used).toEqual(['beacon']);
  });
});
