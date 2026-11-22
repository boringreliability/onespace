/**
 * v4 sub-plan 6 — open choice 1 (phase A, for the owner's approval):
 * the emergency choice menu (H on an empty tank) and the resources screen (I).
 *
 * Task 4 review M-3 (.superpowers/sdd/plan-6-resources/task-4-review.md): with
 * the menu up, I opened the sheet, and one O there could throw out the hold
 * the menu's cheapest way out (`3 · CANNIBALIZE CARGO`, from 1 000 kg) needs —
 * without a word. Proposed here: while the menu is up, I is refused like
 * cruise, a jump and the beacon recovery are refused — the screen does not
 * open, nothing is thrown out, and exactly one warn line says why.
 *
 * The text, `IN EMERGENCY`, is OCCUPIED_TEXT's style (`IN CRUISE` / `IN JUMP` /
 * `IN RECOVERY`) and the word the game already shows in this state (the NAV
 * ADVISORY prompt `EMERGENCY · H`). `IN RECOVERY` does not say it truthfully:
 * the recovery is the beacon's cut, which starts only after 2 is picked.
 *
 * Assumed seam: ResourcesOptions gains an OPTIONAL `emergency: { readonly
 * open: boolean }` (the real Emergency satisfies it; registry passes it).
 * Optional, because the approved harness in Resources.test.ts builds the
 * screen without one. OCCUPIED_TEXT gains `emergency: 'IN EMERGENCY'`.
 *
 * Real Emergency, real Resources, real modes and gating; the registry's order
 * (Emergency ahead of Resources). A key reaches the flight's Input only if the
 * screen's capture listener did not stop it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { EMERGENCY_KEYS, RESOURCES_KEY, actionForKey, type ActionName } from '@/core/Input';
import { modes, type BaseMode, type Mode } from '@/core/Modes';
import { tickModules } from '@/core/tick';
import type { Resource } from '@/gen/belt';
import { Emergency } from '@/game/Emergency';
import type { ActionState } from '@/game/Mining';
import { applyGating } from '@/game/gating';
import { OCCUPIED_TEXT } from '@/game/miningRules';
import { CARGO_CAPACITY_KG, CANNIBALIZE_CARGO_MIN_KG, Cargo } from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { Resources } from './Resources';

/** The proposed refusal (open choice 1). */
const IN_EMERGENCY = 'IN EMERGENCY';

const RESOURCES_MODE = 'resources' as string as BaseMode;
const H = 1 / 60;
// Built, not typed: no binding is spelled out here.
const JETTISON = `Key${'O'}`;
const label = (code: string): string => code.replace(/^Key/, '').replace(/^Digit/, '');

function toMode(m: BaseMode): void {
  if (modes.overlay) modes.pop();
  if (modes.base === m) return;
  if (!modes.can(m)) modes.go('flight');
  modes.go(m);
}

const offs: Array<() => void> = [];
beforeEach(() => toMode('flight'));
afterEach(() => {
  for (const off of offs.splice(0)) off();
  toMode('flight');
});

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

interface Key extends Event {
  readonly code: string;
  readonly stopped: boolean;
}

function keydown(code: string, o: { shift?: boolean } = {}): Key {
  const e = new Event('keydown', { cancelable: true, bubbles: true });
  let stopped = false;
  const stop = e.stopPropagation.bind(e);
  Object.defineProperties(e, {
    code: { value: code },
    shiftKey: { value: o.shift === true },
    ctrlKey: { value: false },
    metaKey: { value: false },
    altKey: { value: false },
    repeat: { value: false },
    stopPropagation: {
      value: () => {
        stopped = true;
        stop();
      },
    },
    stopped: { get: () => stopped },
  });
  return e as Key;
}

const IDLE = { progress: 0, shownKg: 0, leftS: 0, resource: null } as const;
const NOTHING: ActionState = { ...IDLE, kind: 'blocked', reason: 'nothing-to-repair' };

function game(o: { fill?: number; hold?: Partial<Record<Resource, number>> } = {}) {
  const tank = new Propellant(PROBE_TANK_CAPACITY_KG, o.fill ?? 0);
  const cargo = new Cargo(CARGO_CAPACITY_KG);
  cargo.restore(o.hold ?? { ice: 1_200 });
  const world = {
    paused: false as boolean,
    frozen: false as boolean,
    cargo,
    flight: { propellant: tank as Propellant | null },
    recoverToOrbit: () => undefined,
  };
  const cruise = { busy: false };
  const warp = { phase: 'idle' };
  const recovery = { active: false };
  const mining = {
    beamResource: 'ice' as Resource,
    setBeamResource(r: Resource) {
      this.beamResource = r;
    },
    status: (): ActionState => NOTHING,
  };
  const emergency = new Emergency({ universe: world, recovery, warp });
  // Not a fresh literal: the extra `emergency` is today's unknown option.
  const opts = { universe: world, mining, cruise, warp, recovery, emergency };
  const screen = new Resources(opts);

  // The registry's order: Emergency ahead of Resources.
  const mods: GameModule[] = [emergency, screen];
  applyGating(mods);
  const input = new StubInput();
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  emergency.init();
  offs.push(modes.onChange((from: Mode, to: Mode) => {
    for (const m of mods) m.onModeChange?.(from, to, ctx);
  }));

  const logs: string[] = [];
  const tones: Array<string | undefined> = [];
  const actions: unknown[] = [];
  offs.push(bus.on('log', ({ text, tone }) => {
    logs.push(text);
    tones.push(tone);
  }));
  offs.push(bus.on('cargo:action', (e) => actions.push(e)));

  const frame = (): void => {
    tickModules(mods, { base: modes.base, overlay: modes.overlay }, H, ctx);
    input.endFrame();
  };
  const key = (code: string, k: { shift?: boolean } = {}): Key => {
    const e = keydown(code, k);
    screen.onKeyDown(e as unknown as KeyboardEvent);
    if (!e.stopped) input.pressKey(code);
    frame();
    return e;
  };
  return { tank, cargo, world, emergency, screen, logs, tones, actions, frame, key };
}

describe('open choice 1 — I does not open the resources screen while the emergency menu is up', () => {
  it('Given an empty tank and 1 200 kg aboard, When H, Then the menu is up and offers 3 · CANNIBALIZE CARGO first (precondition)', () => {
    const g = game();
    expect(g.tank.empty).toBe(true);
    expect(g.cargo.totalKg).toBeGreaterThanOrEqual(CANNIBALIZE_CARGO_MIN_KG);
    g.key(EMERGENCY_KEYS.open);
    expect(g.emergency.open).toBe(true);
    expect(g.emergency.line ?? '').toMatch(new RegExp(`^${label(EMERGENCY_KEYS.cannibalizeCargo)} · CANNIBALIZE CARGO`));
  });

  it('Given the menu up, When I, Then the screen does not open and exactly one warn line says IN EMERGENCY', () => {
    const g = game();
    g.key(EMERGENCY_KEYS.open);
    g.logs.length = 0;
    g.tones.length = 0;
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe('flight');
    expect(g.logs).toEqual([IN_EMERGENCY]);
    expect(g.tones).toEqual(['warn']);
  });

  it('Given the proposed text, Then it is OCCUPIED_TEXT.emergency (one source, the style of IN CRUISE / IN JUMP / IN RECOVERY) and not IN RECOVERY', () => {
    expect((OCCUPIED_TEXT as Readonly<Record<string, string>>)['emergency']).toBe(IN_EMERGENCY);
    expect(OCCUPIED_TEXT.recovery).not.toBe(IN_EMERGENCY);
  });

  it('Given the menu up, When I and then O and Shift+O, Then nothing is thrown out: no cargo:action, the hold still 1 200 kg, and the menu still offers CANNIBALIZE CARGO', () => {
    const g = game();
    g.key(EMERGENCY_KEYS.open);
    g.key(RESOURCES_KEY);
    g.key(JETTISON);
    g.key(JETTISON, { shift: true });
    expect(g.actions).toEqual([]);
    expect(g.cargo.kg('ice')).toBe(1_200);
    expect(g.emergency.open).toBe(true);
    expect(g.emergency.line ?? '').toContain('CANNIBALIZE CARGO');
  });

  it('Given the menu up, When I is pressed twice, Then each press is refused with its own single line (two presses, two lines, both IN EMERGENCY)', () => {
    const g = game();
    g.key(EMERGENCY_KEYS.open);
    g.logs.length = 0;
    g.key(RESOURCES_KEY);
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe('flight');
    expect(g.logs).toEqual([IN_EMERGENCY, IN_EMERGENCY]);
  });

  it('Guard: Given the menu closed again with H (only the EMERGENCY · H prompt left), When I, Then the screen opens as usual and nothing is logged', () => {
    const g = game();
    g.key(EMERGENCY_KEYS.open);
    g.key(EMERGENCY_KEYS.open);
    expect(g.emergency.open).toBe(false);
    expect(g.emergency.prompt).not.toBeNull(); // precondition: still stranded
    g.logs.length = 0;
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe(RESOURCES_MODE);
    expect(g.logs).toEqual([]);
  });

  it('Guard: Given an empty tank and the menu never opened, When I, Then the screen opens as usual', () => {
    const g = game();
    expect(g.emergency.prompt).not.toBeNull();
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe(RESOURCES_MODE);
    expect(g.logs).toEqual([]);
  });

  it('Given a refused I under the menu, When the menu is then closed with H and I pressed, Then the screen opens (the refusal lasts only as long as the menu)', () => {
    const g = game();
    g.key(EMERGENCY_KEYS.open);
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe('flight');
    g.key(EMERGENCY_KEYS.open);
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Guard: Given a tank with propellant (no emergency at all), When I, Then the screen opens', () => {
    const g = game({ fill: 0.5 });
    expect(g.emergency.prompt).toBeNull();
    g.key(EMERGENCY_KEYS.open); // H does nothing with fuel aboard
    expect(g.emergency.open).toBe(false);
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given registry.ts, Then Emergency is built ahead of Resources and handed to it as `emergency`', () => {
    const src = readFileSync(fileURLToPath(new URL('../game/registry.ts', import.meta.url)), 'utf8');
    const em = src.indexOf('new Emergency(');
    const screen = src.indexOf('new Resources(');
    expect(em).toBeGreaterThanOrEqual(0);
    expect(screen).toBeGreaterThan(em);
    expect(src.slice(screen, src.indexOf('engine.add', screen))).toMatch(/\bemergency\b/);
  });
});
