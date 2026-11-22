/**
 * v4 sub-plan 6, Task 4 (phase A) — the resources screen in the game
 * (DESIGN-6 §7.1, §7.3; plan 6 Task 4, Review Focus 3 and 5).
 *
 * The screen's rules are Task 3's (resourcesState.ts, tested there). This file
 * pins what Task 4 adds around them: the module that opens the screen from
 * flight, refuses it elsewhere, reads the screen's keys raw while it is open,
 * and carries out what `resourcesKey` decides — jettison through
 * `applyCargoAction`, the beam's choice through `mining.setBeamResource`,
 * closing through `modes.go('flight')`.
 *
 * Assumed surface (src/ui/Resources.ts), for the owner's approval:
 *
 *   export const RESOURCES_TITLE = 'RESOURCES';
 *   export const RESOURCES_COLUMNS = ['HOLD', 'BEAM', 'USES'];
 *   export class Resources implements GameModule {
 *     readonly name = 'resources';
 *     constructor(opts: {
 *       universe: { paused; frozen; cargo: Cargo | null; flight: { propellant: Propellant | null } };
 *       mining: { beamResource; setBeamResource(r); status(kind) };   // the real Mining
 *       cruise: { busy };  warp: { phase };  recovery: { active };
 *     });
 *     update(dt, ctx);                  // flight: the 'resources' action (I) opens, or the refusal is logged
 *     onKeyDown(e: KeyboardEvent);      // THE window keydown listener (capture phase); acts only in mode 'resources'
 *   }
 * The constructor, update() and onKeyDown() touch no DOM (as Pause: the DOM is
 * built in init(), which these tests never call). There is no jsdom: a key is a
 * real `Event` carrying the DOM's own field names (code, shiftKey, ctrlKey,
 * metaKey, altKey, repeat), handed to `onKeyDown` exactly as the window would.
 *
 * The harness ticks the modules through the engine's own gating
 * (`applyGating` + `tickModules`) and forwards mode changes as the Engine does,
 * so a module that sleeps in a mode really sleeps here. A key reaches the
 * flight's Input only if `onKeyDown` did not stop it (the capture listener runs
 * first, as Pause's and ConflictOverlay's do).
 *
 * Choices pinned here that the spec/brief do not decide (see the phase A report):
 *  - the seam names `onKeyDown`, `RESOURCES_TITLE`, `RESOURCES_COLUMNS`;
 *  - a refused I under the beacon recovery logs one warn line (text left open);
 *    in pause the screen does not open (whether it logs is left open: in the
 *    game Pause's capture listener swallows every key while the sheet is up);
 *    over the open chart (`universe.paused`) and in photo nothing at all;
 *  - after construction the selection starts on ice.
 *
 * The module does not exist yet: it is loaded by a path the type checker does
 * not follow, and every test first asserts the export it needs, so a failure
 * says what is missing and `npm run typecheck` stays clean.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext, GameModule } from '@/core/Engine';
import { EMERGENCY_KEYS, Input, MINING_KEYS, RESOURCES_KEY, actionForKey, type ActionName } from '@/core/Input';
import { modes, type BaseMode, type Mode } from '@/core/Modes';
import { tickModules } from '@/core/tick';
import type { AsteroidSpec, Resource } from '@/gen/belt';
import { ActionFeed, type ActionFeedOptions } from '@/game/ActionFeed';
import { clearShot, setShot } from '@/game/Shots';
import { MODULE_MODES, applyGating } from '@/game/gating';
import { Mining, type ActionState, type MiningWorld } from '@/game/Mining';
import { OCCUPIED_TEXT, formatKg, notHereText } from '@/game/miningRules';
import { beltRig, fyssField } from '@/game/testing/beltFixture';
import {
  CARGO_CAPACITY_KG,
  Cargo,
  JETTISON_STEP_KG,
  refineRefusal,
  repairRefusal,
  type CargoAction,
  type CargoResult,
} from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { READY_TEXT, type ActionRow } from './actionRows';
import { createCargoReadout, readCargo } from './cargoReadout';
import { resourcesView, type ResourcesViewInput } from './resourcesState';

// -----------------------------------------------------------------------------
// The module under test, loaded without the type checker following the path.

interface ResourcesModule extends GameModule {
  onKeyDown(e: KeyboardEvent): void;
}
interface ResourcesOptions {
  universe: MiningWorld;
  mining: Mining;
  cruise: { busy: boolean };
  warp: { phase: string };
  recovery: { active: boolean };
}
interface Mod {
  Resources?: new (o: ResourcesOptions) => ResourcesModule;
  RESOURCES_TITLE?: string;
  RESOURCES_COLUMNS?: readonly string[];
  registerResourcesShots?: (screen: { showShot(i: ResourcesViewInput): void; hideShot(): void }) => void;
}

const MODULE = './Resources';
let mod: Mod = {};
let loadError: unknown = null;

beforeAll(async () => {
  try {
    mod = (await import(/* @vite-ignore */ MODULE)) as Mod;
  } catch (e) {
    loadError = e;
  }
});

function need<K extends keyof Mod>(name: K): NonNullable<Mod[K]> {
  expect(loadError, 'src/ui/Resources.ts must exist').toBeNull();
  expect(mod[name], `Resources.ts must export ${name}`).toBeDefined();
  return mod[name] as NonNullable<Mod[K]>;
}

// -----------------------------------------------------------------------------
// Names not in the types yet (phase A): the mode and the action.

const RESOURCES_MODE = 'resources' as string as BaseMode;
const RESOURCES_ACTION = 'resources' as string as ActionName;

// Key codes built, not typed, so no binding is spelled out here.
const letter = (c: string): string => `Key${c}`;
const JETTISON = letter('O');

const H = 1 / 60;
const NAME: Readonly<Record<Resource, string>> = { ice: 'ICE', rare: 'RARE', metal: 'METAL', silicate: 'SILICATE' };

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

// -----------------------------------------------------------------------------
// A keydown as the window hands it over: a real Event with the DOM's field names.

interface Key extends Event {
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  /** stopPropagation or stopImmediatePropagation was called: flight's Input never sees it. */
  readonly stopped: boolean;
}

function keydown(code: string, o: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean; repeat?: boolean } = {}): Key {
  const e = new Event('keydown', { cancelable: true, bubbles: true });
  let stopped = false;
  const stop = e.stopPropagation.bind(e);
  const stopNow = e.stopImmediatePropagation.bind(e);
  Object.defineProperties(e, {
    code: { value: code },
    key: { value: code.startsWith('Key') ? code.slice(3).toLowerCase() : code },
    shiftKey: { value: o.shift === true },
    ctrlKey: { value: o.ctrl === true },
    metaKey: { value: o.meta === true },
    altKey: { value: o.alt === true },
    repeat: { value: o.repeat === true },
    stopPropagation: {
      value: () => {
        stopped = true;
        stop();
      },
    },
    stopImmediatePropagation: {
      value: () => {
        stopped = true;
        stopNow();
      },
    },
    stopped: { get: () => stopped },
  });
  return e as Key;
}

// -----------------------------------------------------------------------------
// The game around the screen: a real Belt, a real Mining, the action feed.

class StubInput {
  private presses = new Set<ActionName>();
  /** What Input does on a keydown that reached it: the bound action is pressed this frame. */
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

function richAsteroid(): AsteroidSpec {
  const a = fyssField(0).asteroids.find(
    (x) => x.composition.ice >= 6_000 && x.composition.metal >= 1_000 && x.composition.silicate >= 1_000,
  );
  if (!a) throw new Error('fixture: no asteroid in Fyss field 0 with ≥ 6 t ice, ≥ 1 t metal and silicate');
  return a;
}

type Seen = { action: CargoAction; result: CargoResult };
type Ended = { asteroidId: string; resource: Resource; minedKg: number; end: string };

interface GameOpts {
  hold?: Partial<Record<Resource, number>>;
  fill?: number;
  /**
   * Task 4 review fix (M-5): the real Input (on a fake DOM) in the frame, as
   * the Engine runs it — `input.update(dt)` before the modules, `endFrame()`
   * after. Absent: the stub, as before.
   */
  realInput?: Input;
}

function game(o: GameOpts = {}) {
  const b = beltRig();
  b.frame();
  const ast = richAsteroid();
  const astWorld = new Vector3();
  const astVel = new Vector3();
  if (!b.belt.asteroidWorld(ast.id, astWorld) || !b.belt.asteroidVelocity(ast.id, astVel)) {
    throw new Error('fixture: the belt does not know the asteroid');
  }
  b.world.flight.worldPosition.copy(astWorld).add(new Vector3(ast.radiusKm + 0.2, 0, 0));
  b.frame();
  const tank = new Propellant(PROBE_TANK_CAPACITY_KG, o.fill ?? 0.5);
  const cargo = new Cargo(CARGO_CAPACITY_KG);
  cargo.restore(o.hold ?? {});
  const world = {
    paused: false as boolean,
    frozen: false as boolean,
    simulatedSeconds: 0,
    cargo,
    flight: { propellant: tank, worldPosition: b.world.flight.worldPosition, velocity: astVel.clone() },
    shipParent: null as { worldVelocity: Vector3 } | null,
  } satisfies MiningWorld;
  const targeting = { targetId: ast.id as string | null };
  const cruise = { busy: false };
  const warp = { phase: 'idle' };
  const recovery = { active: false };
  const mining = new Mining({ universe: world, belt: b.belt, worldState: b.worldState, targeting, cruise, warp });

  const rows: string[][] = [];
  const hud = {
    setActions: (r: readonly [ActionRow, ActionRow, ActionRow]) => rows.push(r.map((x) => x.text)),
    setSpeedOk: () => undefined,
  };
  const feed = new ActionFeed({ hud, mining, targeting } as unknown as ActionFeedOptions);

  const Ctor = mod.Resources;
  const screen = Ctor ? new Ctor({ universe: world, mining, cruise, warp, recovery }) : null;

  // Registry order: Mining, the screen after it, the feed.
  const mods: GameModule[] = [mining, ...(screen ? [screen] : []), feed];
  applyGating(mods);

  const input = new StubInput();
  const ctx = { input: o.realInput ?? input, elapsed: 0 } as unknown as EngineContext;
  mining.init?.(ctx);
  offs.push(() => mining.dispose?.());
  offs.push(modes.onChange((from: Mode, to: Mode) => {
    for (const m of mods) m.onModeChange?.(from, to, ctx);
  }));

  const logs: string[] = [];
  const actions: Seen[] = [];
  const ended: Ended[] = [];
  const started: unknown[] = [];
  const actionEnded: Array<{ kind: string; ok: boolean }> = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));
  offs.push(bus.on('cargo:action', (e: Seen) => actions.push(e)));
  offs.push(bus.on('mining:ended', (e) => ended.push(e)));
  offs.push(bus.on('mining:started', (e) => started.push(e)));
  offs.push(bus.on('action:ended', (e) => actionEnded.push(e)));

  /** One engine frame through the gating table, as tick.ts runs it. */
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      world.simulatedSeconds = world.paused || world.frozen || modes.overlay ? 0 : H;
      b.frame();
      o.realInput?.update(H);
      tickModules(mods, { base: modes.base, overlay: modes.overlay }, H, ctx);
      input.endFrame();
      o.realInput?.endFrame();
    }
  };

  /**
   * A key pressed: the screen's capture listener first; the flight's Input gets
   * it only if the listener did not stop it; then one frame.
   */
  const key = (code: string, o: Parameters<typeof keydown>[1] = {}): Key => {
    const e = keydown(code, o);
    if (screen) screen.onKeyDown(e as unknown as KeyboardEvent);
    if (!e.stopped) input.pressKey(code);
    frame();
    return e;
  };

  /** Open the screen from flight with I (the bound action). */
  const open = (): void => {
    key(RESOURCES_KEY);
  };

  return { ...b, ast, tank, cargo, world, targeting, cruise, warp, recovery, mining, screen, rows, logs, actions, ended, started, actionEnded, frame, key, open, input };
}

/** A game whose screen exists (asserts the module first). */
function screenGame(o: GameOpts = {}) {
  need('Resources');
  const g = game(o);
  expect(g.screen).not.toBeNull();
  return g;
}

// =============================================================================

describe('the screen\'s fixed texts (plan Global Constraints: title and columns verbatim)', () => {
  it('Given Resources.ts, Then the title is RESOURCES and the columns are HOLD, BEAM, USES in that order', () => {
    expect(need('RESOURCES_TITLE')).toBe('RESOURCES');
    expect([...need('RESOURCES_COLUMNS')]).toEqual(['HOLD', 'BEAM', 'USES']);
  });

  it('Given Resources.ts, Then the DOM draws from the title and column constants and from resourcesView / resourcesKey (one source for every text)', () => {
    const src = readFileSync(fileURLToPath(new URL('./Resources.ts', import.meta.url)), 'utf8');
    expect(src.match(/\bRESOURCES_TITLE\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src.match(/\bRESOURCES_COLUMNS\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/import\s*\{[^}]*\bresourcesView\b[^}]*\}\s*from\s*'\.\/resourcesState'/);
    expect(src).toMatch(/import\s*\{[^}]*\bresourcesKey\b[^}]*\}\s*from\s*'\.\/resourcesState'/);
  });

  it("Given a Resources, Then its name is 'resources' (the gating table's key)", () => {
    const g = screenGame();
    expect(g.screen!.name).toBe('resources');
  });
});

describe('opening and closing (DESIGN-6 §7.1)', () => {
  it('Given flight, When I is pressed, Then the mode is resources', () => {
    const g = screenGame();
    g.open();
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given flight, When I opens the screen, Then that keydown was not stopped: it reached the flight\'s Input (the screen reads raw keys only while open)', () => {
    const g = screenGame();
    const e = g.key(RESOURCES_KEY);
    expect(e.stopped).toBe(false);
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given the screen open, When I is pressed again, Then it closes (flight), and the press is kept from the flight so it does not reopen it', () => {
    const g = screenGame();
    g.open();
    const e = g.key(RESOURCES_KEY);
    expect(e.stopped).toBe(true);
    expect(modes.base).toBe('flight');
    g.frame(3);
    expect(modes.base).toBe('flight');
  });

  it('Given the screen open, When Esc is pressed, Then it closes, and Esc is kept from the flight (it does not reach pause)', () => {
    const g = screenGame();
    g.open();
    const e = g.key('Escape');
    expect(e.stopped).toBe(true);
    expect(modes.base).toBe('flight');
  });

  it('Given the screen open, When I is held (repeat), Then it stays open', () => {
    const g = screenGame();
    g.open();
    g.key(RESOURCES_KEY, { repeat: true });
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given flight, When open → close → open, Then each I toggles once', () => {
    const g = screenGame();
    g.open();
    g.key(RESOURCES_KEY);
    g.open();
    expect(modes.base).toBe(RESOURCES_MODE);
  });
});

describe('opening is refused outside free flight (Review Focus 5; DESIGN-6 §7.1)', () => {
  it('Given cruise, When I is pressed, Then the screen does not open and the log says IN CRUISE (OCCUPIED_TEXT)', () => {
    const g = screenGame();
    g.cruise.busy = true;
    g.open();
    expect(modes.base).toBe('flight');
    expect(g.logs).toEqual([OCCUPIED_TEXT.cruise]);
    expect(OCCUPIED_TEXT.cruise).toBe('IN CRUISE');
  });

  it('Given a jump, When I is pressed, Then the screen does not open and the log says IN JUMP (OCCUPIED_TEXT)', () => {
    const g = screenGame();
    g.warp.phase = 'charging';
    g.open();
    expect(modes.base).toBe('flight');
    expect(g.logs).toEqual([OCCUPIED_TEXT.jump]);
    expect(OCCUPIED_TEXT.jump).toBe('IN JUMP');
  });

  it('Given the beacon recovery underway, When I is pressed, Then the screen does not open and exactly one warn line says why', () => {
    const g = screenGame();
    const tones: Array<string | undefined> = [];
    offs.push(bus.on('log', ({ tone }) => tones.push(tone)));
    g.recovery.active = true;
    g.open();
    expect(modes.base).toBe('flight');
    expect(g.logs).toHaveLength(1);
    expect(g.logs[0]!.length).toBeGreaterThan(0);
    expect(tones).toEqual(['warn']);
  });

  it('Given the pause sheet (the world frozen), When the I action arrives, Then the screen does not open', () => {
    const g = screenGame();
    g.world.frozen = true;
    g.open();
    expect(modes.base).toBe('flight');
  });

  it('Given the chart open over flight (universe.paused), When I is pressed, Then nothing happens: no screen, no log', () => {
    const g = screenGame();
    g.world.paused = true;
    g.open();
    expect(modes.base).toBe('flight');
    expect(g.logs).toEqual([]);
  });

  it('Given the photo overlay over flight, When I is pressed, Then nothing happens: still photo, nothing thrown, no log', () => {
    const g = screenGame();
    modes.push('photo');
    expect(() => g.open()).not.toThrow();
    expect(modes.current).toBe('photo');
    expect(modes.base).toBe('flight');
    expect(g.logs).toEqual([]);
  });

  for (const base of ['yard', 'title', 'map'] as const) {
    it(`Given the ${base}, When I is pressed, Then nothing happens: still ${base}, no log`, () => {
      const g = screenGame();
      toMode(base);
      g.logs.length = 0;
      expect(() => g.open()).not.toThrow();
      expect(modes.base).toBe(base);
      expect(g.logs).toEqual([]);
    });
  }
});

describe('opening ends what runs, and the world stands still (D53; DESIGN-6 §7.1)', () => {
  it('Given an extraction underway, When the screen opens, Then it ends interrupted (one mining:ended), and nothing more is mined while open', () => {
    const g = screenGame();
    g.key(MINING_KEYS.mine);
    g.frame(120); // one bite of 250 kg
    expect(g.mining.status('mine').kind).toBe('running');
    g.open();
    expect(g.ended).toHaveLength(1);
    expect(g.ended[0]!.end).toBe('interrupted');
    const held = g.cargo.kg('ice');
    g.frame(600);
    expect(g.cargo.kg('ice')).toBe(held);
    expect(g.mining.operations).toHaveLength(0);
  });

  it('Given a refine underway, When the screen opens, Then it is aborted: one action:ended with ok false', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.key(MINING_KEYS.refine);
    expect(g.mining.busy?.kind).toBe('refine');
    g.open();
    expect(g.actionEnded).toEqual([{ kind: 'refine', ok: false }]);
    expect(g.mining.busy).toBeNull();
  });

  it('Given the gating table, When the mode is resources, Then every module that moves the world or flies the ship stands still (dt ≤ 0)', () => {
    const still = [
      'universe', 'pilot', 'traffic', 'cruise', 'warp', 'belt', 'scanner', 'targeting', 'autopilot',
      'time-compression', 'emergency', 'recovery', 'pause', 'mining', 'mining-beams', 'action-feed',
    ];
    for (const name of still) {
      expect(MODULE_MODES[name], name).toBeDefined();
      const on = MODULE_MODES[name]!;
      // tick.ts: listed → dt, else -1 (no overlay here).
      expect(on.includes(RESOURCES_MODE), `${name} must not tick in resources`).toBe(false);
    }
  });

  it("Given the gating table, Then 'resources' is listed, and it sleeps in the map, the Yard, the title, boot and a review shot (I does nothing there)", () => {
    const on = MODULE_MODES['resources'];
    expect(on).toBeDefined();
    for (const b of ['map', 'yard', 'title', 'boot', 'review'] as const) expect(on!.includes(b), b).toBe(false);
  });

  it('Given the gating table, Then mining, action-feed and mining-beams stay flight-only (guard)', () => {
    expect(MODULE_MODES['mining']).toEqual(['flight']);
    expect(MODULE_MODES['action-feed']).toEqual(['flight']);
    expect(MODULE_MODES['mining-beams']).toEqual(['flight']);
  });
});

describe('jettison on the screen (DESIGN-6 §7.3; R9: the log reports kgOut)', () => {
  it('Given 1 000 kg ice and the screen open, When O, Then one cargo:action { jettison, ice, 250 }, the hold has 750 kg, and the log says JETTISONED · 250 KG ICE', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.open();
    g.logs.length = 0;
    g.key(JETTISON);
    expect(g.actions).toHaveLength(1);
    expect(g.actions[0]!.action).toEqual({ kind: 'jettison', resource: 'ice', kg: JETTISON_STEP_KG });
    expect(g.actions[0]!.result.ok).toBe(true);
    expect(g.actions[0]!.result.kgOut).toBe(250);
    expect(g.cargo.kg('ice')).toBe(750);
    expect(g.logs).toEqual(['JETTISONED · 250 KG ICE']);
  });

  it('R9: Given 100 kg ice, When O, Then the action asks 250 but the log says what left: JETTISONED · 100 KG ICE', () => {
    const g = screenGame({ hold: { ice: 100 } });
    g.open();
    g.logs.length = 0;
    g.key(JETTISON);
    expect(g.actions).toHaveLength(1);
    expect(g.actions[0]!.action).toEqual({ kind: 'jettison', resource: 'ice', kg: JETTISON_STEP_KG });
    expect(g.actions[0]!.result.kgOut).toBe(100);
    expect(g.cargo.kg('ice')).toBe(0);
    expect(g.logs).toEqual(['JETTISONED · 100 KG ICE']);
  });

  it('Given 1 234.4 kg metal selected, When Shift+O, Then all of it leaves and the log says JETTISONED · 1 234 KG METAL (formatKg, the resource in capitals)', () => {
    const g = screenGame({ hold: { ice: 500, metal: 1_234.4 } });
    g.open();
    g.key('ArrowDown');
    g.key('ArrowDown'); // ice → rare → metal
    g.logs.length = 0;
    g.key(JETTISON, { shift: true });
    expect(g.actions).toHaveLength(1);
    expect(g.actions[0]!.action).toMatchObject({ kind: 'jettison', resource: 'metal' });
    expect(g.cargo.kg('metal')).toBe(0);
    expect(g.cargo.kg('ice')).toBe(500);
    expect(g.logs).toEqual([`JETTISONED · ${formatKg(1_234.4)} KG ${NAME.metal}`]);
    expect(formatKg(1_234.4)).toBe('1 234');
  });

  it('Given no rare aboard and rare selected, When O, Then nothing: no cargo:action and no JETTISONED line', () => {
    const g = screenGame({ hold: { ice: 500 } });
    g.open();
    g.key('ArrowDown'); // rare
    g.logs.length = 0;
    g.key(JETTISON);
    expect(g.actions).toEqual([]);
    expect(g.logs.filter((t) => t.startsWith('JETTISONED'))).toEqual([]);
  });

  it('Given flight with the screen closed, When O (and Shift+O), Then nothing is thrown out and the key is not taken from the flight', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    const a = g.key(JETTISON);
    const b = g.key(JETTISON, { shift: true });
    expect(g.actions).toEqual([]);
    expect(g.cargo.kg('ice')).toBe(1_000);
    expect(a.stopped).toBe(false);
    expect(a.defaultPrevented).toBe(false);
    expect(b.stopped).toBe(false);
  });

  it('Given the screen open, When O is held (repeat), Then only the first press throws out', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.open();
    g.key(JETTISON);
    g.key(JETTISON, { repeat: true });
    g.key(JETTISON, { repeat: true });
    expect(g.actions).toHaveLength(1);
    expect(g.cargo.kg('ice')).toBe(750);
  });
});

describe('the beam\'s choice on the screen (DESIGN-6 §7.2)', () => {
  it('Given the screen open on ice, When ↓ ↓ and Enter, Then mining.beamResource is metal', () => {
    const g = screenGame();
    expect(g.mining.beamResource).toBe('ice');
    g.open();
    g.key('ArrowDown');
    g.key('ArrowDown');
    g.key('Enter');
    expect(g.mining.beamResource).toBe('metal');
  });

  it('Given the screen open, When Enter on ice, Then the beam is ice and the screen stays open', () => {
    const g = screenGame();
    g.mining.setBeamResource('rare');
    g.open();
    g.key('Enter');
    expect(g.mining.beamResource).toBe('ice');
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given flight with the screen closed, When ↓ and Enter, Then the beam is unchanged (the screen\'s keys are read only while it is open)', () => {
    const g = screenGame();
    g.key('ArrowDown');
    g.key('Enter');
    expect(g.mining.beamResource).toBe('ice');
  });

  it('M-3: Given the beam set to metal on the screen and a rock without metal, When the screen closes and the HUD updates, Then the MINE row says NO METAL HERE — never NO ICE HERE', () => {
    const g = screenGame();
    g.worldState.recordMined(g.ast.id, 'metal', g.ast.composition.metal, 'local');
    g.open();
    g.key('ArrowDown');
    g.key('ArrowDown');
    g.key('Enter');
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe('flight');
    g.rows.length = 0;
    g.frame();
    expect(g.rows.at(-1)![0]).toBe(notHereText('metal'));
    expect(g.rows.at(-1)![0]).toBe('NO METAL HERE');
    // And B says the same, and starts nothing.
    g.logs.length = 0;
    g.key(MINING_KEYS.mine);
    expect(g.started).toEqual([]);
    expect(g.logs).toEqual(['NO METAL HERE']);
  });
});

describe('no key pressed on the screen reaches the flight (Review Focus 5; Task 3 review m-3)', () => {
  it('Given the screen open, When J, B, W, Space, an arrow or Tab is pressed, Then each is stopped before the flight\'s Input', () => {
    const g = screenGame();
    g.open();
    for (const code of [letter('J'), MINING_KEYS.mine, letter('W'), 'Space', 'ArrowUp', 'Tab', letter('G'), letter('M')]) {
      expect(g.key(code).stopped, code).toBe(true);
    }
  });

  it('Given the screen open on a minable rock, When B is pressed, and then the screen is closed, Then no extraction was started', () => {
    const g = screenGame();
    g.open();
    g.key(MINING_KEYS.mine);
    g.key(RESOURCES_KEY);
    g.frame(10);
    expect(g.started).toEqual([]);
    expect(g.mining.status('mine').kind).not.toBe('running');
  });

  it('m-3: Given the screen open, When Ctrl+B / Cmd+B / Alt+B, Then the key is stopped from the flight but the browser default is left alone, and no extraction starts', () => {
    const g = screenGame();
    g.open();
    for (const mods of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      const e = g.key(MINING_KEYS.mine, mods);
      expect(e.stopped, JSON.stringify(mods)).toBe(true);
      expect(e.defaultPrevented, JSON.stringify(mods)).toBe(false);
    }
    g.key(RESOURCES_KEY);
    g.frame(10);
    expect(g.started).toEqual([]);
  });

  it('m-3: Given the screen open, When an unbound function key (F1, F5, F12) is pressed, Then it is stopped from the flight, the browser keeps its default', () => {
    const g = screenGame();
    g.open();
    for (const code of ['F1', 'F5', 'F12']) {
      const e = g.key(code);
      expect(e.stopped, code).toBe(true);
      expect(e.defaultPrevented, code).toBe(false);
    }
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given the screen open, When a screen key (arrow, Enter, O) is pressed, Then its default is prevented too', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.open();
    for (const [code, o] of [['ArrowDown', {}], ['ArrowUp', {}], ['Enter', {}], [JETTISON, {}]] as const) {
      expect(g.key(code, o).defaultPrevented, code).toBe(true);
    }
  });

  it('Given Resources.ts, Then its keydown listener is registered in the capture phase on window (ahead of Input), and removed again', () => {
    const src = readFileSync(fileURLToPath(new URL('./Resources.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/window\.addEventListener\(\s*'keydown',\s*this\.onKeyDown,\s*true\s*\)/);
    expect(src).toMatch(/window\.removeEventListener\(\s*'keydown',\s*this\.onKeyDown,\s*true\s*\)/);
  });
});

describe('the DOM key path passes the modifiers on (Task 3 review m-2: ctrlKey/metaKey/altKey → ctrl/meta/alt)', () => {
  it('Given 1 000 kg ice and the screen open, When Cmd+O or Ctrl+O, Then nothing is thrown out', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.open();
    g.key(JETTISON, { meta: true });
    g.key(JETTISON, { ctrl: true });
    g.key(JETTISON, { alt: true });
    expect(g.actions).toEqual([]);
    expect(g.cargo.kg('ice')).toBe(1_000);
  });

  it('Given 1 000 kg ice and the screen open, When Cmd+Shift+O or Ctrl+Shift+O, Then nothing is thrown out (not "all")', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.open();
    g.key(JETTISON, { meta: true, shift: true });
    g.key(JETTISON, { ctrl: true, shift: true });
    expect(g.actions).toEqual([]);
    expect(g.cargo.kg('ice')).toBe(1_000);
  });

  it('Given the screen open with rare selected, When Ctrl+Enter or Cmd+Enter, Then the beam is not set', () => {
    const g = screenGame();
    g.open();
    g.key('ArrowDown'); // rare
    g.key('Enter', { ctrl: true });
    g.key('Enter', { meta: true });
    expect(g.mining.beamResource).toBe('ice');
  });

  it('Given the screen open, When Cmd+I or Ctrl+Esc, Then it does not close', () => {
    const g = screenGame();
    g.open();
    g.key(RESOURCES_KEY, { meta: true });
    g.key('Escape', { ctrl: true });
    expect(modes.base).toBe(RESOURCES_MODE);
  });

  it('Given the screen open, When Shift+O with 1 000 kg ice (no chord), Then all of it leaves (the shift really is passed on)', () => {
    const g = screenGame({ hold: { ice: 1_000 } });
    g.open();
    g.key(JETTISON, { shift: true });
    expect(g.cargo.kg('ice')).toBe(0);
    expect(g.logs.at(-1)).toBe('JETTISONED · 1 000 KG ICE');
  });
});

// =============================================================================
// D14 — one key, one meaning.

const ALL_CODES = ['ShiftLeft', 'ShiftRight', 'Space', 'Tab', 'Escape', 'Enter', 'F2', 'Comma', 'Period']
  .concat(Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`))
  .concat(Array.from({ length: 10 }, (_, i) => `Digit${i}`));

function srcFiles(): { root: string; files: string[] } {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs);
      else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) files.push(abs);
    }
  };
  walk(root);
  return { root, files };
}

describe('D14: I and O mean one thing each', () => {
  it("Given Input, Then RESOURCES_KEY (I) is bound to 'resources'", () => {
    expect(RESOURCES_KEY).toBe(letter('I'));
    expect(actionForKey(RESOURCES_KEY)).toBe(RESOURCES_ACTION);
  });

  it("Given every key, Then only I reaches 'resources'", () => {
    expect(ALL_CODES.filter((c) => actionForKey(c) === RESOURCES_ACTION)).toEqual([RESOURCES_KEY]);
  });

  it('Given every key, Then O is bound to nothing in flight (it acts only on the screen) — guard', () => {
    expect(actionForKey(JETTISON)).toBeUndefined();
  });

  it('Given the emergency, mining and flight-axis keys, Then I and O are none of them — guard', () => {
    const axisKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    for (const c of [RESOURCES_KEY, JETTISON]) {
      expect(Object.values(EMERGENCY_KEYS), c).not.toContain(c);
      expect(Object.values(MINING_KEYS), c).not.toContain(c);
      expect(axisKeys, c).not.toContain(c);
    }
  });

  it('Given every source file, Then I is spelled raw only in core/Input.ts (the binding table) — guard', () => {
    const { root, files } = srcFiles();
    const re = new RegExp(`['"\`]${RESOURCES_KEY}['"\`]`);
    const offenders = files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length));
    expect(offenders).toEqual([join('core', 'Input.ts')]);
  });

  it('Given every source file, Then O is spelled raw only in ui/resourcesState.ts — guard', () => {
    const { root, files } = srcFiles();
    const re = new RegExp(`['"\`]${JETTISON}['"\`]`);
    const offenders = files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length));
    expect(offenders).toEqual([join('ui', 'resourcesState.ts')]);
  });
});

// =============================================================================
// Registration and review shots.

describe('registry.ts and the review shots', () => {
  const registry = (): string => readFileSync(fileURLToPath(new URL('../game/registry.ts', import.meta.url)), 'utf8');

  it('Given registry.ts, Then it imports Resources from ui/Resources and builds one after Mining, handed that Mining', () => {
    const src = registry();
    expect(src).toMatch(/import\s*\{[^}]*\bResources\b[^}]*\}\s*from\s*'@\/ui\/Resources'/);
    const mining = src.indexOf('new Mining(');
    const screen = src.indexOf('new Resources(');
    expect(mining).toBeGreaterThanOrEqual(0);
    expect(screen).toBeGreaterThan(mining);
    expect(src.slice(screen, src.indexOf('engine.add', screen))).toMatch(/\bmining\b/);
  });

  it('Given registry.ts, Then the review guard counts hud-beam-choice as a HUD shot (else the HUD is hidden in it)', () => {
    const line = registry().split('\n').find((l) => /const hudShot\b/.test(l)) ?? '';
    expect(line).not.toBe('');
    expect(/hud-beam-choice|startsWith\('hud-'\)/.test(line), line).toBe(true);
  });

  it('Given every registerShot in src, Then resources-empty, resources-full and hud-beam-choice are registered (the existing hud-actions-mining proves the scan)', () => {
    const { files } = srcFiles();
    const names = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/registerShot\(\{\s*name:\s*'([^']+)'/g)) names.add(m[1]!);
    }
    expect(names.has('hud-actions-mining')).toBe(true);
    for (const n of ['resources-empty', 'resources-full', 'hud-beam-choice']) expect(names.has(n), n).toBe(true);
  });
});

// =============================================================================
// Task 4 review fix (phase A) — .superpowers/sdd/plan-6-resources/task-4-review.md.
// The approved tests above are untouched; these pin the fixed behaviour.

/** The HUD blocks rule (I-1, R11), loaded without the type checker following the path. */
interface HudBlocks {
  readonly cargo: boolean;
  readonly actions: boolean;
  readonly log: boolean;
}
const HUD_BLOCKS = './hudBlocks';
let hudBlocksMod: { hudBlocks?: (base: BaseMode) => HudBlocks } = {};
let hudBlocksError: unknown = null;
beforeAll(async () => {
  try {
    hudBlocksMod = (await import(/* @vite-ignore */ HUD_BLOCKS)) as typeof hudBlocksMod;
  } catch (e) {
    hudBlocksError = e;
  }
});
function hudBlocks(base: BaseMode): HudBlocks {
  expect(hudBlocksError, 'src/ui/hudBlocks.ts must exist').toBeNull();
  expect(hudBlocksMod.hudBlocks, 'hudBlocks.ts must export hudBlocks').toBeDefined();
  return hudBlocksMod.hudBlocks!(base);
}

/** What the open sheet shows, from the same live sources Resources.liveView reads. */
function sheetNow(g: ReturnType<typeof game>, selected: Resource = 'ice') {
  return resourcesView({
    cargo: g.cargo.snapshot(),
    capacityKg: g.cargo.capacityKg,
    selected,
    beam: g.mining.beamResource,
    refine: g.mining.status('refine'),
    repair: g.mining.status('repair'),
  });
}

describe('I-1 (R11): the HUD never contradicts the open sheet (DESIGN-6 §7.1: USES and the HUD rows never say different things)', () => {
  it('Given 1 000 kg ice and a half tank, When I and then Shift+O on ICE, Then while the sheet says HOLD 0 the HUD shows no CARGO block and no action rows — only the log, which says JETTISONED', () => {
    const g = screenGame({ hold: { ice: 1_000 }, fill: 0.5 });
    g.frame();
    // Before: the HUD's REFINE row is READY, as the sheet will be.
    expect(g.rows.at(-1)![1]).toBe(READY_TEXT);
    g.open();
    expect(sheetNow(g).uses[0]!.status).toBe(READY_TEXT);
    g.key(JETTISON, { shift: true });
    expect(modes.base).toBe(RESOURCES_MODE);
    expect(g.cargo.totalKg).toBe(0);
    expect(sheetNow(g).header).toBe('HOLD 0 / 8 000 KG');
    expect(sheetNow(g).uses[0]!.status).not.toBe(READY_TEXT);
    // The HUD behind the sheet: its frozen CARGO 1 000 and REFINE ▸ READY are not shown …
    const open = hudBlocks(modes.base);
    expect(open.cargo).toBe(false);
    expect(open.actions).toBe(false);
    // … but the log is, so the jettison can be read.
    expect(open.log).toBe(true);
    expect(g.logs.at(-1)).toBe('JETTISONED · 1 000 KG ICE');
  });

  it('Given the same jettison, When I closes the sheet and one flight frame runs, Then the HUD shows its blocks again and they agree with the hold: no CARGO, REFINE says what the sheet said (not READY)', () => {
    const g = screenGame({ hold: { ice: 1_000 }, fill: 0.5 });
    g.open();
    g.key(JETTISON, { shift: true });
    const sheetSaid = sheetNow(g).uses[0]!.status;
    g.key(RESOURCES_KEY);
    expect(modes.base).toBe('flight');
    g.rows.length = 0;
    g.frame();
    // The rows and the CARGO block are fed live again (ActionFeed, Instruments → readCargo).
    expect(g.rows.at(-1)![1]).toBe(sheetSaid);
    expect(g.rows.at(-1)![1]).not.toBe(READY_TEXT);
    expect(readCargo(g.cargo, createCargoReadout()).visible).toBe(false);
    // … and shown again.
    const shown = hudBlocks(modes.base);
    expect(shown.cargo).toBe(true);
    expect(shown.actions).toBe(true);
    expect(shown.log).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// M-2: the review shot must show what a player can really see.

describe('M-2: the resources shots show statuses a player can really see with that hold', () => {
  /** The view each resources-* shot hands the screen, captured through a stand-in screen. */
  let captured: Map<string, ResourcesViewInput> | null = null;
  async function shotInputs(): Promise<Map<string, ResourcesViewInput>> {
    if (captured) return captured;
    const register = need('registerResourcesShots');
    const seen = new Map<string, ResourcesViewInput>();
    let current = '';
    register({ showShot: (i) => void seen.set(current, i), hideShot: () => undefined });
    const ctx = {} as EngineContext;
    for (const name of ['resources-empty', 'resources-full']) {
      current = name;
      await setShot(name, ctx);
      clearShot(ctx);
    }
    captured = seen;
    return seen;
  }

  /** null = ready; else the blocked reason. */
  const reasonOf = (s: ActionState): string | null => (s.kind === 'ready' ? null : s.kind === 'blocked' ? s.reason : `running:${s.kind}`);

  /** The tanks a ship with this hold can have: none, or half / full, whole / damaged. */
  function tanks(): Array<Propellant | null> {
    const out: Array<Propellant | null> = [null];
    for (const fill of [0.5, 1]) {
      for (const loss of [0, 0.3]) {
        const t = new Propellant(PROBE_TANK_CAPACITY_KG, 1);
        t.restore({ massKg: fill * PROBE_TANK_CAPACITY_KG * (1 - loss), capacityLossFrac: loss });
        out.push(t);
      }
    }
    return out;
  }

  for (const name of ['resources-empty', 'resources-full']) {
    it(`Given the ${name} shot, Then its REFINE and REPAIR statuses are never IN CRUISE / IN JUMP / BUSY (the screen cannot open there; opening ends a running action)`, async () => {
      const input = (await shotInputs()).get(name);
      expect(input, `${name} must hand the screen a view`).toBeDefined();
      for (const s of [input!.refine, input!.repair]) {
        expect(s.kind).not.toBe('running');
        if (s.kind === 'blocked') expect(['cruise', 'jump', 'busy']).not.toContain(s.reason);
      }
    });

    it(`Given the ${name} shot, Then its REFINE and REPAIR statuses are what the rules say for that very hold and one real tank (no NEED METAL · SILICATE beside a hold that has them)`, async () => {
      const input = (await shotInputs()).get(name)!;
      expect(input).toBeDefined();
      const cargo = new Cargo(CARGO_CAPACITY_KG);
      cargo.restore(input.cargo);
      const want = { refine: reasonOf(input.refine), repair: reasonOf(input.repair) };
      const possible = tanks().map((t) => ({ refine: refineRefusal(cargo, t), repair: repairRefusal(cargo, t) }));
      expect(possible, `${name}: ${JSON.stringify(want)} for hold ${JSON.stringify(input.cargo)}`).toContainEqual(want);
    });
  }
});

// -----------------------------------------------------------------------------
// M-4 and M-5 need the DOM Resources.init builds and the window Input binds to.
// There is no jsdom: a fake with just the surface those two touch, and a window
// that runs capture listeners first (Resources) and the others (Input) only if
// no capture listener stopped the key — as the browser does on window.

type Listener = (e: unknown) => void;

class FakeTarget {
  readonly listeners: Array<{ type: string; fn: Listener; capture: boolean }> = [];
  addEventListener(type: string, fn: Listener, opt?: boolean | { capture?: boolean }): void {
    const capture = opt === true || (typeof opt === 'object' && opt?.capture === true);
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: Listener, opt?: boolean | { capture?: boolean }): void {
    const capture = opt === true || (typeof opt === 'object' && opt?.capture === true);
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  /** A key at the window: capture listeners, then the rest unless it was stopped. */
  key(e: Key): void {
    for (const l of this.listeners.filter((x) => x.type === 'keydown' && x.capture)) l.fn(e);
    if (e.stopped) return;
    for (const l of this.listeners.filter((x) => x.type === 'keydown' && !x.capture)) l.fn(e);
  }
  keyup(code: string): void {
    for (const l of this.listeners.filter((x) => x.type === 'keyup')) l.fn({ code });
  }
}

class FakeEl extends FakeTarget {
  className = '';
  id = '';
  textContent: string | null = '';
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void } = {
    setProperty(k: string, v: string): void {
      (this as Record<string, unknown>)[k] = v;
    },
  };
  private readonly added = new Set<string>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c) || this.added.has(c),
    add: (c: string): void => void this.added.add(c),
    remove: (c: string): void => {
      this.added.delete(c);
      this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' ');
    },
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this.classList.contains(c);
      if (on) this.classList.add(c);
      else this.classList.remove(c);
      return on;
    },
  };
  constructor(readonly tagName: string) {
    super();
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  setAttribute(): void {}
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  requestPointerLock(): void {}
}

class FakeDocument extends FakeTarget {
  readonly body = new FakeEl('body');
  readonly head = new FakeEl('head');
  pointerLockElement: unknown = null;
  createElement(tag: string): FakeEl {
    return new FakeEl(tag.toUpperCase());
  }
  getElementById(): null {
    return null;
  }
  exitPointerLock(): void {
    this.pointerLockElement = null;
  }
}

const DOM_GLOBALS = ['window', 'document', 'localStorage'] as const;

/**
 * Install the fake window / document / storage. `restore` must run after every
 * dispose that still touches them: push it to `offs` last.
 */
function fakeDom() {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = DOM_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const win = new FakeTarget();
  const doc = new FakeDocument();
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  for (const [k, v] of [['window', win], ['document', doc], ['localStorage', storage]] as const) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  const restore = (): void => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
    }
  };
  const canvas = new FakeEl('CANVAS');
  /** The screen's root (class os-res) under the body. */
  const sheet = (): FakeEl => {
    const r = doc.body.children.find((c) => c.classList.contains('os-res'));
    if (!r) throw new Error('Resources.init built no .os-res under the body');
    return r;
  };
  return { win, doc, canvas, sheet, restore };
}

/** The sheet catches clicks: pointer-events auto, by its live class or inline. */
function catchesClicks(root: FakeEl): boolean {
  return root.classList.contains('is-live') || root.style.pointerEvents === 'auto';
}

describe('M-4: from the moment the screen is open the sheet catches clicks (a click in the fade-in cannot lock the pointer)', () => {
  function domGame() {
    const dom = fakeDom();
    const g = screenGame();
    g.screen!.init?.({} as EngineContext);
    offs.push(() => g.screen!.dispose?.(), dom.restore);
    return { dom, g };
  }

  it('Given flight, When I opens the screen, Then on that very frame — the fade-in barely begun — the sheet already catches clicks', () => {
    const { dom, g } = domGame();
    g.open();
    expect(modes.base).toBe(RESOURCES_MODE);
    const root = dom.sheet();
    // The fade-in is under way, far from done (FADE 0.18 s; one 60 Hz frame).
    expect(Number(root.style['--os-res-t'])).toBeLessThan(0.5);
    expect(catchesClicks(root)).toBe(true);
  });

  it('Given flight before I, Then the sheet does not catch clicks (the canvas takes them) — guard', () => {
    const { dom, g } = domGame();
    g.frame(3);
    expect(catchesClicks(dom.sheet())).toBe(false);
  });

  it('Given the screen open and then closed, When the fade-out is over, Then the sheet no longer catches clicks (one click on the canvas takes the controls again) — guard', () => {
    const { dom, g } = domGame();
    g.open();
    g.frame(30);
    g.key(RESOURCES_KEY);
    g.frame(60);
    expect(modes.base).toBe('flight');
    expect(catchesClicks(dom.sheet())).toBe(false);
  });
});

describe('M-5: keys held when the screen opens do not keep acting', () => {
  it('Given W held in flight, When I opens the screen and W stays down for 2 s, Then the throttle does not climb while the screen is open', () => {
    const dom = fakeDom();
    const real = new Input(dom.canvas as unknown as HTMLElement);
    const g = screenGame({ realInput: real });
    g.screen!.init?.({} as EngineContext);
    offs.push(() => g.screen!.dispose?.(), () => real.dispose(), dom.restore);
    const press = (code: string): void => {
      dom.win.key(keydown(code));
      g.frame();
    };

    dom.win.key(keydown(letter('W')));
    g.frame(12); // the lever's target ≈ 0.18
    press(RESOURCES_KEY);
    expect(modes.base).toBe(RESOURCES_MODE);
    let most = real.axes.throttle;
    for (let i = 0; i < 120; i++) {
      g.frame();
      most = Math.max(most, real.axes.throttle);
    }
    // Held for 2 s it would reach full lever; time stands still on the screen.
    expect(most).toBeLessThan(0.25);
  });

  it('Given W held across the opening and let go while the screen is open, When I closes it, Then the lever is not stuck climbing: 2 s of flight later it is where it was', () => {
    const dom = fakeDom();
    const real = new Input(dom.canvas as unknown as HTMLElement);
    const g = screenGame({ realInput: real });
    g.screen!.init?.({} as EngineContext);
    offs.push(() => g.screen!.dispose?.(), () => real.dispose(), dom.restore);

    dom.win.key(keydown(letter('W')));
    g.frame(12);
    dom.win.key(keydown(RESOURCES_KEY));
    g.frame();
    expect(modes.base).toBe(RESOURCES_MODE);
    g.frame(120);
    dom.win.keyup(letter('W'));
    const e = keydown(RESOURCES_KEY);
    dom.win.key(e);
    expect(e.stopped).toBe(true);
    g.frame();
    expect(modes.base).toBe('flight');
    let most = real.axes.throttle;
    for (let i = 0; i < 120; i++) {
      g.frame();
      most = Math.max(most, real.axes.throttle);
    }
    expect(most).toBeLessThan(0.25);
  });

  it('Given ↓ held in flight (pitch) when I opens the screen, When its auto-repeat reaches the sheet, Then the selection does not move: Enter still sets ICE', () => {
    const g = screenGame();
    g.mining.setBeamResource('rare');
    g.key('ArrowDown'); // pressed in flight: the flight's key
    g.open();
    for (let i = 0; i < 3; i++) g.key('ArrowDown', { repeat: true });
    g.key('Enter');
    expect(g.mining.beamResource).toBe('ice');
  });

  it('Given the screen open, When ↓ is pressed on it and held (repeat), Then the selection still runs (Task 3: a held arrow repeats) — guard', () => {
    const g = screenGame();
    g.open();
    g.key('ArrowDown'); // rare
    g.key('ArrowDown', { repeat: true }); // metal
    g.key('ArrowDown', { repeat: true }); // silicate
    g.key('Enter');
    expect(g.mining.beamResource).toBe('silicate');
  });
});
