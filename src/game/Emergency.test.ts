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

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import { EMERGENCY_KEYS, actionForKey, type ActionName } from '@/core/Input';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { emergencyMayAct } from '@/ship/emergency';
import { advisoryText, type HintState } from '@/ui/hintRules';
import { CARGO_CAPACITY_KG, Cargo, type Resource } from '@/ship/cargo';
import { ShipLog } from './Log';
import { EMERGENCY_PROMPT, Emergency, type EmergencyWorld } from './Emergency';

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
  /** R16: the states the exit must stand down in. Mutable mid-test. */
  world: { -readonly [K in keyof EmergencyWorld]: EmergencyWorld[K] };
  recovery: { active: boolean };
  warp: { phase: string };
  input: StubInput;
  recoveries: number;
  logs: string[];
  used: Array<'cannibalize' | 'cannibalize-cargo' | 'beacon'>;
  recovered: number;
  tick(n?: number): void;
  press(code: string): void;
}

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function harness(opts: { fill?: number; lossFrac?: number; noTank?: boolean } = {}): Harness {
  const tank = new Propellant(BASE, opts.fill ?? 0);
  tank.capacityLossFrac = opts.lossFrac ?? 0;
  const input = new StubInput();
  const h = {
    tank,
    input,
    recoveries: 0,
    logs: [] as string[],
    used: [] as Array<'cannibalize' | 'cannibalize-cargo' | 'beacon'>,
    recovered: 0,
  } as Harness;
  const world: Harness['world'] = {
    flight: { propellant: opts.noTank ? null : tank },
    paused: false,
    frozen: false,
    recoverToOrbit: () => {
      h.recoveries++;
    },
  };
  const recovery = { active: false };
  const warp = { phase: 'idle' };
  h.world = world;
  h.recovery = recovery;
  h.warp = warp;
  h.em = new Emergency({ universe: world, recovery, warp });
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

  it('are four different keys (Task 6: 3 burns the cargo)', () => {
    const codes = new Set(Object.values(EMERGENCY_KEYS));
    expect(codes.size).toBe(4);
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

// ---------------------------------------------------------------------------
// Fix round 1 (R16): the exit only acts when its prompt is shown — one shared
// predicate, `emergencyMayAct`, gates the keys AND the NAV ADVISORY line.
// ---------------------------------------------------------------------------

/** What `emergencyMayAct` is asked, read off the harness (the module reads the same). */
function gateOf(h: Harness) {
  return {
    paused: h.world.paused,
    frozen: h.world.frozen,
    recoveryActive: h.recovery.active,
    warpPhase: h.warp.phase,
    tank: h.world.flight.propellant,
  };
}

/** A flight state in which a lesson could show (pointer captured, nothing open). */
const FLYING: HintState = {
  inFlight: true,
  pointerLocked: true,
  overlayOpen: false,
  paused: false,
  busy: false,
  hasTarget: false,
  cruising: false,
};

function expectNothingHappened(h: Harness): void {
  expect(h.tank.massKg).toBe(0);
  expect(h.tank.capacityLossFrac).toBe(0);
  expect(h.recoveries).toBe(0);
  expect(h.recovered).toBe(0);
  expect(h.used).toEqual([]);
  expect(h.logs).not.toContain('RECOVERED · BEACON');
  expect(h.em.timesUsed).toBe(0);
}

describe('the exit only acts when its prompt is shown (R16)', () => {
  it('Given a recovery fade in progress (frozen), When H then 2 is pressed, Then nothing happens and no ship:recovered is emitted', () => {
    const h = harness({ fill: 0 });
    h.world.frozen = true;
    h.recovery.active = true;
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.em.open).toBe(false);
    expectNothingHappened(h);
  });

  it('Given only universe.frozen (no recovery flag), When H then 2 is pressed, Then nothing happens', () => {
    const h = harness({ fill: 0 });
    h.world.frozen = true;
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    expectNothingHappened(h);
  });

  it('Given only a recovery active (not frozen), When H then 1 is pressed, Then nothing happens', () => {
    const h = harness({ fill: 0 });
    h.recovery.active = true;
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expectNothingHappened(h);
  });

  it('Given a warp in progress with an empty tank, When H then 2 is pressed, Then nothing happens', () => {
    const h = harness({ fill: 0 });
    h.warp.phase = 'tunnel';
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    h.press(EMERGENCY_KEYS.cannibalize);
    expectNothingHappened(h);
  });

  it('Given the choice was opened and THEN a warp/fade starts, When 2 is pressed, Then nothing happens', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    h.warp.phase = 'charging';
    h.press(EMERGENCY_KEYS.beacon);
    expectNothingHappened(h);
    h.warp.phase = 'idle';
    h.world.frozen = true;
    h.press(EMERGENCY_KEYS.beacon);
    expectNothingHappened(h);
  });

  it('Given the game paused, Then H/1/2 do nothing', () => {
    const h = harness({ fill: 0 });
    h.world.paused = true;
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.em.open).toBe(false);
    expectNothingHappened(h);
  });

  it('Given a hull without a tank, Then H/1/2 do nothing', () => {
    const h = harness({ noTank: true });
    h.tick(10);
    expect(h.em.prompt).toBeNull();
    expect(h.em.line).toBeNull();
    expect(h.em.offers).toEqual([]);
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.em.open).toBe(false);
    expect(h.recoveries).toBe(0);
    expect(h.recovered).toBe(0);
    expect(h.used).toEqual([]);
  });

  it('Given the predicate false, Then the hint line is not shown; given true, Then it is (same predicate)', () => {
    const h = harness({ fill: 0 });
    const blockers: Array<[string, () => void, () => void]> = [
      ['paused', () => (h.world.paused = true), () => (h.world.paused = false)],
      ['frozen', () => (h.world.frozen = true), () => (h.world.frozen = false)],
      ['recovery', () => (h.recovery.active = true), () => (h.recovery.active = false)],
      ['warp', () => (h.warp.phase = 'tunnel'), () => (h.warp.phase = 'idle')],
    ];
    // True: the prompt is the line, and NAV ADVISORY shows it.
    expect(emergencyMayAct(gateOf(h))).toBe(true);
    expect(h.em.prompt).toBe(EMERGENCY_PROMPT);
    expect(h.em.line).toBe(EMERGENCY_PROMPT);
    expect(advisoryText(FLYING, {}, h.em.line)).toBe(EMERGENCY_PROMPT);
    for (const [why, set, clear] of blockers) {
      set();
      expect(emergencyMayAct(gateOf(h)), why).toBe(false);
      expect(h.em.prompt, why).toBeNull();
      expect(h.em.line, why).toBeNull();
      expect(advisoryText(FLYING, {}, h.em.line), why).not.toBe(EMERGENCY_PROMPT);
      clear();
    }
    // A full tank: predicate false, no line.
    h.tank.add(1);
    expect(emergencyMayAct(gateOf(h))).toBe(false);
    expect(h.em.line).toBeNull();
    expect(advisoryText(FLYING, {}, h.em.line)).not.toBe(EMERGENCY_PROMPT);
  });

  it('Given the emergency line, Then it outranks every lesson on NAV ADVISORY, but an open chart or codex still hides the line', () => {
    // Outranks lessons (fresh counts: the "fly" lesson would otherwise show).
    expect(advisoryText(FLYING, {}, EMERGENCY_PROMPT)).toBe(EMERGENCY_PROMPT);
    // An open chart or codex hides the whole line.
    expect(advisoryText({ ...FLYING, overlayOpen: true }, {}, EMERGENCY_PROMPT)).toBeNull();
    // Out of flight, nothing.
    expect(advisoryText({ ...FLYING, inFlight: false }, {}, EMERGENCY_PROMPT)).toBeNull();
    // No emergency line: the ordinary lesson text.
    expect(advisoryText(FLYING, {}, null)).toBe('W/S — THROTTLE · MOUSE — STEER');
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I4 — the picks are named actions (P3).
// Cannibalize and beacon change the tank only through applyAction, which
// announces each with `propellant:action`; emergency:used carries the count.
// ---------------------------------------------------------------------------

describe('final review I4 — Emergency picks go through applyAction', () => {
  type Seen = { action: { kind: string; part?: string; timesUsed?: number }; ok: boolean; kg: number };

  function listen(): Seen[] {
    const seen: Seen[] = [];
    offs.push(bus.on('propellant:action', (e: Seen) => seen.push(e)));
    return seen;
  }

  it('Given Emergency picks cannibalize, Then it goes through applyAction: one propellant:action { cannibalize, part tank, timesUsed 0 }, ok', () => {
    const h = harness({ fill: 0 });
    const seen = listen();
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toMatchObject({ kind: 'cannibalize', part: 'tank', timesUsed: 0 });
    expect(seen[0]!.ok).toBe(true);
  });

  it('Given a restored count of 2, When cannibalize is picked, Then the action is priced by it (timesUsed 2)', () => {
    const h = harness({ fill: 0 });
    h.em.timesUsed = 2;
    const seen = listen();
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(seen[0]!.action).toMatchObject({ kind: 'cannibalize', timesUsed: 2 });
  });

  it('Given Emergency picks the beacon, Then it goes through applyAction: one propellant:action { beacon }', () => {
    const h = harness({ fill: 0 });
    const seen = listen();
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    expect(seen.map((e) => e.action.kind)).toEqual(['beacon']);
  });

  it('Given a cannibalization, Then emergency:used carries timesUsed — the count after this use (1, then 2)', () => {
    const h = harness({ fill: 0 });
    const events: Array<{ kind: string; timesUsed?: number }> = [];
    offs.push(bus.on('emergency:used', (e) => events.push(e)));
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    h.tank.consume(h.tank.massKg);
    h.tick();
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.cannibalize);
    expect(events).toEqual([
      { kind: 'cannibalize', timesUsed: 1 },
      { kind: 'cannibalize', timesUsed: 2 },
    ]);
  });

  it('Given the game code, Then no module outside ship/ calls the emergency rules directly (applyCannibalize / applyBeacon)', () => {
    const offenders: string[] = [];
    for (const dir of ['../game', '../ui']) {
      const abs = fileURLToPath(new URL(`${dir}/`, import.meta.url));
      for (const f of readdirSync(abs)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        const src = readFileSync(join(abs, f), 'utf8');
        if (/\bapply(Cannibalize|Beacon)\s*\(/.test(src)) offenders.push(`${dir}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 2 (mining), Task 6 — the emergency exit knows the cargo.
//
// - Key 3 (`EMERGENCY_KEYS.cannibalizeCargo`, Digit3) burns the whole hold for
//   3 % of BASE tank capacity — no capacity loss — via the cargo action
//   `cannibalize-cargo`. Offered FIRST (3, 1, 2) when the hold holds ≥ 1 000 kg.
// - The beacon (key 2) pays through `payBeacon(tank, cargo, log)`: the hold is
//   jettisoned (`jettison-all`, one `cargo:action`) and the ship's log gets a
//   'BEACON RECOVERY' note under its own key `beacon:<n>`.
// ---------------------------------------------------------------------------

describe('Task 6 — key 3 is its own key', () => {
  it('Given EMERGENCY_KEYS, Then cannibalizeCargo is Digit3 and maps to emergencyCannibalizeCargo', () => {
    const keys = EMERGENCY_KEYS as Record<string, string>;
    expect(keys.cannibalizeCargo).toBe('Digit3');
    expect(actionForKey('Digit3')).toBe('emergencyCannibalizeCargo');
  });

  it('Given every bound key, Then only Digit3 reaches emergencyCannibalizeCargo, and Digit3 means nothing else', () => {
    const all = ['ShiftLeft', 'ShiftRight', 'Space', 'Tab', 'Escape', 'F2', 'Comma', 'Period']
      .concat(Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`))
      .concat(Array.from({ length: 10 }, (_, i) => `Digit${i}`));
    const reaching = all.filter((c) => actionForKey(c) === 'emergencyCannibalizeCargo');
    expect(reaching).toEqual(['Digit3']);
  });

  it('Given every raw key handler in src, Then none reads Digit3 (it was free)', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, f.name);
        if (f.isDirectory()) walk(abs);
        else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) {
          if (abs === join(root, 'core', 'Input.ts')) continue; // the binding table itself
          if (/['"`]Digit3['"`]/.test(readFileSync(abs, 'utf8'))) offenders.push(abs.slice(root.length));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

interface CargoHarness {
  em: Emergency;
  tank: Propellant;
  cargo: Cargo;
  log: ShipLog;
  recoveries: number;
  used: Array<{ kind: string; timesUsed?: number }>;
  cargoActions: Array<{ kind: string; ok: boolean; kgOut: number }>;
  /** Hold total at the moment ship:recovered was announced. */
  holdAtRecovered: number[];
  press(code: string): void;
  tick(n?: number): void;
}

function cargoHarness(
  opts: { fill?: number; lossFrac?: number; hold?: Partial<Record<Resource, number>> } = {},
): CargoHarness {
  const tank = new Propellant(BASE, opts.fill ?? 0);
  tank.capacityLossFrac = opts.lossFrac ?? 0;
  const cargo = new Cargo(CARGO_CAPACITY_KG);
  cargo.restore(opts.hold ?? {});
  // Node has no localStorage: the log keeps its entries in memory.
  const log = new ShipLog();
  const input = new StubInput();
  const h = {
    tank,
    cargo,
    log,
    recoveries: 0,
    used: [],
    cargoActions: [],
    holdAtRecovered: [],
  } as unknown as CargoHarness;
  const world = {
    flight: { propellant: tank },
    cargo,
    paused: false,
    frozen: false,
    recoverToOrbit: () => {
      h.recoveries++;
    },
  };
  h.em = new Emergency({
    universe: world,
    recovery: { active: false },
    warp: { phase: 'idle' },
    log,
  } as ConstructorParameters<typeof Emergency>[0]);
  offs.push(bus.on('emergency:used', (e) => h.used.push({ ...e })));
  offs.push(
    bus.on('cargo:action', ({ action, result }) =>
      h.cargoActions.push({ kind: action.kind, ok: result.ok, kgOut: result.kgOut }),
    ),
  );
  offs.push(bus.on('ship:recovered', () => h.holdAtRecovered.push(cargo.totalKg)));
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

/** Key 3; falls back to the literal so the RED run fails on behaviour, not on a lookup. */
const KEY3 = (EMERGENCY_KEYS as Record<string, string>).cannibalizeCargo ?? 'Digit3';

function beaconNotes(log: ShipLog) {
  return log.all().filter((e) => e.title === 'BEACON RECOVERY');
}

describe('Task 6 — cannibalize cargo (key 3)', () => {
  it("Given cargo 3 t and an empty tank, Then the menu offers 3 (cargo), 1 (tank), 2 (beacon); When 3, Then the hold empties, the tank gains 3 % of base, capacity is untouched, emergency:used {kind:'cannibalize-cargo'}", () => {
    const h = cargoHarness({ hold: { metal: 2_000, silicate: 1_000 } });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.open).toBe(true);
    expect(h.em.offers).toEqual(['cannibalize-cargo', 'cannibalize', 'beacon']);
    h.press(KEY3);
    expect(h.cargo.totalKg).toBe(0);
    expect(h.tank.massKg).toBeCloseTo(0.03 * BASE, 9);
    expect(h.tank.capacityLossFrac).toBe(0);
    expect(h.used).toEqual([{ kind: 'cannibalize-cargo' }]);
    // A cargo burn is not a tank cannibalization: the tank's price does not rise.
    expect(h.em.timesUsed).toBe(0);
    expect(h.recoveries).toBe(0);
    expect(h.em.open).toBe(false);
    expect(h.em.prompt).toBeNull();
  });

  it('Given cargo 3 t and the choice open, Then the NAV ADVISORY line lists 3 (CARGO), 1, 2 in that order', () => {
    const h = cargoHarness({ hold: { ice: 3_000 } });
    h.press(EMERGENCY_KEYS.open);
    const line = h.em.line ?? '';
    const i3 = line.indexOf(`${label(KEY3)} · CANNIBALIZE CARGO`);
    const i1 = line.indexOf(`${label(EMERGENCY_KEYS.cannibalize)} · CANNIBALIZE TANK`);
    const i2 = line.indexOf(`${label(EMERGENCY_KEYS.beacon)} · BEACON`);
    expect(i3, line).toBeGreaterThanOrEqual(0);
    expect(i3, line).toBeLessThan(i1);
    expect(i1, line).toBeLessThan(i2);
  });

  it('Given cargo 500 kg, Then 3 is not offered, and pressing 3 does nothing', () => {
    const h = cargoHarness({ hold: { metal: 500 } });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.offers).toEqual(['cannibalize', 'beacon']);
    expect(h.em.line ?? '').not.toContain('CARGO');
    h.press(KEY3);
    expect(h.cargo.totalKg).toBe(500);
    expect(h.tank.massKg).toBe(0);
    expect(h.used).toEqual([]);
    expect(h.cargoActions).toEqual([]);
    expect(h.em.open).toBe(true);
  });

  it('Given exactly 1 000 kg, Then 3 is offered first (the threshold is inclusive)', () => {
    const h = cargoHarness({ hold: { silicate: 1_000 } });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.offers[0]).toBe('cannibalize-cargo');
  });

  it('Given cargo 3 t and a tank that is NOT empty, Then cargo cannibalization is not offered and 3 does nothing', () => {
    const h = cargoHarness({ fill: 0.001, hold: { metal: 3_000 } });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.offers).toEqual([]);
    h.press(KEY3);
    expect(h.cargo.totalKg).toBe(3_000);
    expect(h.tank.massKg).toBeCloseTo(0.001 * BASE, 9);
    expect(h.used).toEqual([]);
    expect(h.cargoActions).toEqual([]);
  });

  it('Given cargo 3 t, When 3 without opening the choice first, Then nothing happens', () => {
    const h = cargoHarness({ hold: { metal: 3_000 } });
    h.press(KEY3);
    expect(h.cargo.totalKg).toBe(3_000);
    expect(h.used).toEqual([]);
    expect(h.cargoActions).toEqual([]);
  });

  it('Given cargo 3 t, When 3, Then it goes through the cargo action only: one cargo:action cannibalize-cargo, no propellant:action', () => {
    const h = cargoHarness({ hold: { metal: 3_000 } });
    const tankActions: string[] = [];
    offs.push(bus.on('propellant:action', (e) => tankActions.push(e.action.kind)));
    h.press(EMERGENCY_KEYS.open);
    h.press(KEY3);
    expect(h.cargoActions).toEqual([{ kind: 'cannibalize-cargo', ok: true, kgOut: 3_000 }]);
    expect(tankActions).toEqual([]);
  });

  it('Given a damaged tank (20 % lost) and cargo 3 t, When 3, Then it still gains 3 % of BASE and the loss is unchanged', () => {
    const h = cargoHarness({ lossFrac: 0.2, hold: { metal: 3_000 } });
    h.press(EMERGENCY_KEYS.open);
    h.press(KEY3);
    expect(h.tank.massKg).toBeCloseTo(0.03 * BASE, 9);
    expect(h.tank.capacityLossFrac).toBeCloseTo(0.2, 12);
  });
});

describe('Task 6 — the beacon (key 2) jettisons the hold and logs it', () => {
  it('Given cargo and a beacon (key 2), Then the hold is emptied via jettison-all and a BEACON RECOVERY logbook note exists', () => {
    const h = cargoHarness({ hold: { metal: 2_000, ice: 1_000 } });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    expect(h.recoveries).toBe(1);
    expect(h.cargo.totalKg).toBe(0);
    expect(h.cargoActions).toEqual([{ kind: 'jettison-all', ok: true, kgOut: 3_000 }]);
    const notes = beaconNotes(h.log);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe('note');
    expect(notes[0]!.key).toBe('beacon:1');
    // The beacon's tank price is unchanged.
    expect(h.tank.massKg).toBeCloseTo(0.05 * h.tank.capacityKg, 9);
    expect(h.used).toEqual([{ kind: 'beacon' }]);
  });

  it('Given the beacon, Then jettison emits exactly one cargo:action, and the hold is already empty when ship:recovered is announced', () => {
    const h = cargoHarness({ hold: { metal: 3_000 } });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    h.tick(60);
    expect(h.cargoActions).toEqual([{ kind: 'jettison-all', ok: true, kgOut: 3_000 }]);
    // Mining aborts on ship:recovered: by then the hold is settled.
    expect(h.holdAtRecovered).toEqual([0]);
  });

  it('Given an EMPTY hold, When the beacon fires, Then it still writes the BEACON RECOVERY note and nothing throws', () => {
    const h = cargoHarness({});
    h.press(EMERGENCY_KEYS.open);
    expect(() => h.press(EMERGENCY_KEYS.beacon)).not.toThrow();
    expect(h.recoveries).toBe(1);
    expect(h.cargo.totalKg).toBe(0);
    expect(beaconNotes(h.log)).toHaveLength(1);
    // One jettison asked, refused as 'empty' — still exactly one cargo:action.
    expect(h.cargoActions).toEqual([{ kind: 'jettison-all', ok: false, kgOut: 0 }]);
    expect(h.used).toEqual([{ kind: 'beacon' }]);
  });

  it('Given two beacons, Then each is its own note (beacon:1, beacon:2) — not one note visited twice', () => {
    const h = cargoHarness({ hold: { metal: 3_000 } });
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    h.tank.consume(h.tank.massKg);
    h.tick();
    h.press(EMERGENCY_KEYS.open);
    h.press(EMERGENCY_KEYS.beacon);
    const notes = beaconNotes(h.log);
    expect(notes.map((e) => e.key).sort()).toEqual(['beacon:1', 'beacon:2']);
    expect(notes.every((e) => e.visits === 1)).toBe(true);
  });
});

describe('Task 6 — one shared payBeacon', () => {
  it('Given the game code, Then Emergency and RecoveryCut both pay the beacon through payBeacon, and neither jettisons or applies the beacon action itself', () => {
    for (const f of ['./Emergency.ts', './RecoveryCut.ts']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
      expect(src, f).toMatch(/\bpayBeacon\s*\(/);
      expect(src, f).not.toMatch(/applyAction\([^)]*kind:\s*'beacon'/);
      expect(src, f).not.toContain('jettison-all');
    }
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I2 — an honest beacon (DESIGN §5.4 "tydelig
// prompt"). The beacon jettisons the whole hold; with cargo aboard the menu
// says so, with the mass (formatKg). An empty hold: the text is unchanged.
// ---------------------------------------------------------------------------

describe('final review I2 — the beacon says it loses the cargo', () => {
  it('Given 6 099 kg in the hold and the choice open, Then the beacon reads "2 · BEACON · LOSE 6 099 KG CARGO"', () => {
    const h = cargoHarness({ hold: { metal: 4_000, ice: 2_099 } });
    h.press(EMERGENCY_KEYS.open);
    const line = h.em.line ?? '';
    expect(line, line).toContain(`${label(EMERGENCY_KEYS.beacon)} · BEACON · LOSE 6 099 KG CARGO`);
  });

  it('Given a fractional hold (6 098.6 kg), Then the mass is rounded as formatKg rounds it: "LOSE 6 099 KG CARGO"', () => {
    const h = cargoHarness({ hold: { silicate: 6_098.6 } });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.line ?? '').toContain(`${label(EMERGENCY_KEYS.beacon)} · BEACON · LOSE 6 099 KG CARGO`);
  });

  it('Given an empty hold, Then the beacon reads "2 · BEACON" exactly as before (no LOSE)', () => {
    const h = cargoHarness({});
    h.press(EMERGENCY_KEYS.open);
    const line = h.em.line ?? '';
    expect(line.endsWith(`${label(EMERGENCY_KEYS.beacon)} · BEACON`), line).toBe(true);
    expect(line).not.toContain('LOSE');
  });

  it('Given a hull with no hold at all (v4-fuel world), Then the beacon reads "2 · BEACON" (no LOSE)', () => {
    const h = harness({ fill: 0 });
    h.press(EMERGENCY_KEYS.open);
    const line = h.em.line ?? '';
    expect(line.endsWith(`${label(EMERGENCY_KEYS.beacon)} · BEACON`), line).toBe(true);
    expect(line).not.toContain('LOSE');
  });

  it('Given cargo, When the hold empties (the line is asked again), Then the warning goes with it', () => {
    const h = cargoHarness({ hold: { metal: 500 } });
    h.press(EMERGENCY_KEYS.open);
    expect(h.em.line ?? '').toContain('LOSE 500 KG CARGO');
    h.cargo.restore({});
    expect(h.em.line ?? '').not.toContain('LOSE');
  });
});
