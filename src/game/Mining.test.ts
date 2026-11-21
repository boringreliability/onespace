/**
 * v4 sub-plan 2, Task 5 — mine (B), refine (U), repair (N). The success
 * criterion's "mine an asteroid and refuel".
 * v4 sub-plan 5, Task 3 — mining is a continuous EXTRACTION.
 *
 * Contract with the pilot:
 * - B on a targeted asteroid within 0.5 km of its SURFACE, matched to within
 *   0.005 km/s, with room in the hold, starts an extraction of ONE resource
 *   (the first of ice, rare, metal, silicate with ≥ 0.5 kg left). From the
 *   next frame on it accrues 150 kg per SIM second and lands in the hold in
 *   bites of 250 kg (the last may be smaller). Each bite is one ordinary
 *   `cargo:action` mine plus one `worldState.recordMined`, and a
 *   `mining:bite` on the bus.
 * - It ends — keeping every finished bite, never the unfinished part — on B
 *   again (`stopped`), a full hold (`hold-full`), the resource running out
 *   (`resource-depleted`), the rock running out (`rock-depleted`, and
 *   `asteroid:destroyed`), out of range (`range`), too fast (`speed`), the
 *   target dropped or not a rock (`no-target`), or another rock, cruise, a
 *   jump, pause, freeze, the beacon or leaving flight (`interrupted`). One log
 *   line at the end: `extractionLog(end, minedKg, resource)`. A refusal at
 *   the press logs its reason (`REFUSAL_LOG`) and starts nothing.
 * - The gate (`mayMine`) is asked once per frame, before that frame's bites;
 *   a long frame pays every bite its time covers.
 * - U refines all the ice the tank can take (0.8 kg fuel per kg ice) in 8 s;
 *   N repairs 0.04 of tank capacity loss for 600 kg metal + 400 kg silicate
 *   in 10 s. Both all-or-nothing, as in sub-plan 2.
 * - No tank or no hold: B/U/N do nothing at all.
 *
 * Fixture: a REAL Belt over Fyss (beltRig), its WorldState, and the ship
 * placed beside a real asteroid. The orbit clock stands still, so the rock
 * stays put; the ship's velocity is set equal to the rock's ("matched").
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import { EMERGENCY_KEYS, MINING_KEYS, actionForKey, type ActionName } from '@/core/Input';
import type { AsteroidSpec, Resource } from '@/gen/belt';
import { ActionJournal } from '@/save/actionJournal';
import { replay, zeroState } from '@/save/replay';
import { CARGO_CAPACITY_KG, Cargo, type CargoAction, type CargoResult } from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { extractionLog, type ExtractionEnd } from './extraction';
import { Mining, type MiningWorld } from './Mining';
import { MINE_RANGE_KM } from './miningRules';
import { beltRig, fyssField } from './testing/beltFixture';

const CAP = PROBE_TANK_CAPACITY_KG;
/** One wall frame, s. */
const H = 1 / 60;

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

type Seen = { action: CargoAction; result: CargoResult };

// Plan 5, Task 3: the extraction's events on the bus.
type Started = { asteroidId: string; resource: Resource };
type Bite = { asteroidId: string; resource: Resource; kg: number };
type Ended = { asteroidId: string; resource: Resource; minedKg: number; end: ExtractionEnd };
type Destroyed = { asteroidId: string };

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/**
 * Plan 5, Task 3 (phase A): 'mining:started' / 'mining:bite' / 'mining:ended' /
 * 'asteroid:destroyed' are not in `GameEvents` yet. This one cast keeps that
 * out of the type check; the implementer declares the events in EventBus.ts
 * and replaces the cast with `bus.on`.
 */
function listen<T>(event: string, fn: (e: T) => void): void {
  offs.push((bus as unknown as { on(e: string, f: (p: T) => void): () => void }).on(event, fn));
}

/** A rock in field 0 with plenty of every resource, so each test can drain what it needs. */
function richAsteroid(): AsteroidSpec {
  const a = fyssField(0).asteroids.find(
    (x) => x.composition.ice >= 6_000 && x.composition.metal >= 1_000 && x.composition.silicate >= 1_000,
  );
  if (!a) throw new Error('fixture: no asteroid in Fyss field 0 with ≥ 6 t ice, ≥ 1 t metal and silicate');
  return a;
}

interface RigOpts {
  /** Surface range to start at, km. */
  rangeKm?: number;
  /** Speed relative to the rock, km/s, along +y. */
  relKmS?: number;
  fill?: number;
  lossFrac?: number;
  noTank?: boolean;
  noCargo?: boolean;
  /** Target id; default the rich asteroid. */
  target?: string | null;
}

function rig(o: RigOpts = {}) {
  const b = beltRig();
  b.frame(); // the Belt enters the system on its first update
  const ast = richAsteroid();
  const astWorld = new Vector3();
  const astVel = new Vector3();
  if (!b.belt.asteroidWorld(ast.id, astWorld) || !b.belt.asteroidVelocity(ast.id, astVel)) {
    throw new Error('fixture: the belt does not know the asteroid');
  }
  const tank = new Propellant(CAP, o.fill ?? 0.5);
  tank.capacityLossFrac = o.lossFrac ?? 0;
  const cargo = new Cargo(CARGO_CAPACITY_KG);

  /** Put the ship `km` from the rock's SURFACE, along +x. */
  const placeAt = (km: number): void => {
    b.world.flight.worldPosition.copy(astWorld).add(new Vector3(ast.radiusKm + km, 0, 0));
  };
  placeAt(o.rangeKm ?? 0.2);
  b.frame();

  const velocity = astVel.clone().add(new Vector3(0, o.relKmS ?? 0, 0));
  const world = {
    paused: false as boolean,
    frozen: false as boolean,
    simulatedSeconds: 0,
    cargo: o.noCargo ? null : cargo,
    flight: { propellant: o.noTank ? null : tank, worldPosition: b.world.flight.worldPosition, velocity },
    shipParent: null as { worldVelocity: Vector3 } | null,
  } satisfies MiningWorld;
  const targeting = { targetId: o.target === undefined ? ast.id : o.target };
  const cruise = { busy: false };
  const warp = { phase: 'idle' };
  const mining = new Mining({ universe: world, belt: b.belt, worldState: b.worldState, targeting, cruise, warp });

  const logs: string[] = [];
  const actions: Seen[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));
  offs.push(bus.on('cargo:action', (e: Seen) => actions.push(e)));
  // Plan 5, Task 3: the extraction's events, in the order they arrive.
  const started: Started[] = [];
  const bites: Bite[] = [];
  const ended: Ended[] = [];
  const destroyed: Destroyed[] = [];
  listen<Started>('mining:started', (e) => started.push(e));
  listen<Bite>('mining:bite', (e) => bites.push(e));
  listen<Ended>('mining:ended', (e) => ended.push(e));
  listen<Destroyed>('asteroid:destroyed', (e) => destroyed.push(e));

  const input = new StubInput();
  const ctx = { input, elapsed: 0 } as unknown as EngineContext;
  mining.init?.(ctx);
  // R18 (6): the module is torn down with the rig — no bus listener outlives its test.
  offs.push(() => mining.dispose?.());
  /** One wall frame of 1/60 s that advanced `rate` × as much sim time (0 while paused/frozen). */
  let rate = 1;
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      world.simulatedSeconds = world.paused || world.frozen ? 0 : H * rate;
      b.frame();
      mining.update(H, ctx);
      input.endFrame();
    }
  };
  const press = (code: string): void => {
    input.pressKey(code);
    tick();
  };
  return {
    ...b,
    ast,
    astWorld,
    astVel,
    tank,
    cargo,
    world,
    targeting,
    cruise,
    warp,
    mining,
    logs,
    actions,
    started,
    bites,
    ended,
    destroyed,
    placeAt,
    tick,
    press,
    setRate: (r: number) => {
      rate = r;
    },
  };
}

// ---------------------------------------------------------------------------

describe('the keys', () => {
  it('Given MINING_KEYS, Then B, U and N are bound in Input to mine, refine and repair (R17: Y is the Yard)', () => {
    expect(MINING_KEYS).toEqual({ mine: 'KeyB', refine: 'KeyU', repair: 'KeyN' });
    expect(actionForKey(MINING_KEYS.mine)).toBe('mine');
    expect(actionForKey(MINING_KEYS.refine)).toBe('refine');
    expect(actionForKey(MINING_KEYS.repair)).toBe('repair');
  });

  it('Given every bound key, Then the mining keys are three different keys that mean nothing else', () => {
    const codes = Object.values(MINING_KEYS);
    expect(new Set(codes).size).toBe(3);
    // Not the emergency keys, and not a flight-axis key Input reads directly.
    const axisKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    for (const c of codes) {
      expect(Object.values(EMERGENCY_KEYS), c).not.toContain(c);
      expect(axisKeys, c).not.toContain(c);
    }
    // No other key reaches mine / refine / repair.
    const all = ['ShiftLeft', 'ShiftRight', 'Space', 'Tab', 'Escape', 'F2', 'Comma', 'Period']
      .concat(Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`))
      .concat(Array.from({ length: 10 }, (_, i) => `Digit${i}`));
    for (const code of all) {
      const a = actionForKey(code);
      if (a === 'mine' || a === 'refine' || a === 'repair') expect(codes, code).toContain(code);
    }
  });

  it('Given every raw key handler in src (e.code === \'KeyY\' and the like), Then none reads a mining key (R17)', () => {
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
    const inputTs = join(root, 'core', 'Input.ts');
    const raw = new Map<string, string[]>();
    for (const file of files) {
      if (file === inputTs) continue; // the binding table itself
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/['"`]((?:Key[A-Z])|(?:Digit[0-9]))['"`]/g)) {
        const list = raw.get(m[1]!) ?? [];
        list.push(file.slice(root.length));
        raw.set(m[1]!, list);
      }
    }
    // The scan sees the Yard's raw Y (the reason repair left Y).
    expect(raw.get('KeyY') ?? []).toContain('game/Yard.ts');
    for (const c of Object.values(MINING_KEYS)) {
      expect(raw.get(c) ?? [], `${c} is read raw elsewhere`).toEqual([]);
    }
  });
});

describe('mine (B)', () => {
  // Plan 5, Task 3: replaces "after 4 s sim the hold has +2 000 kg ice … log MINED".
  it('Given a targeted asteroid in range and matched, When B, Then it starts, and after 10/6 s sim the hold has 250 kg ice: one cargo:action mine, one recordMined of 250, one mining:bite, no log line yet', () => {
    const r = rig();
    const iceBefore = r.belt.remainingKg(r.ast.id, 'ice');
    r.press(MINING_KEYS.mine);
    expect(r.started).toEqual([{ asteroidId: r.ast.id, resource: 'ice' }]);
    expect(r.mining.status('mine').kind).toBe('running');
    expect(r.logs).toEqual([]);
    // The clock starts on the press frame: sim time counts from the NEXT frame on.
    r.tick(99); // 1.65 s: 247.5 kg accrued, no bite yet
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.bites).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
    r.tick(1); // 100 frames: 10/6 s, 250 kg
    expect(r.cargo.kg('ice')).toBe(250);
    expect(r.cargo.totalKg).toBe(250);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.action).toEqual({ kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 });
    expect(r.actions[0]!.result.ok).toBe(true);
    expect(r.worldState.entries()).toHaveLength(1);
    expect(r.worldState.entries()[0]).toMatchObject({ id: r.ast.id, resource: 'ice', kg: 250, by: 'local' });
    expect(r.bites).toEqual([{ asteroidId: r.ast.id, resource: 'ice', kg: 250 }]);
    expect(r.belt.remainingKg(r.ast.id, 'ice')).toBe(iceBefore - 250);
    // Still running: one log line comes only when it ends.
    expect(r.mining.status('mine').kind).toBe('running');
    expect(r.logs).toEqual([]);
    expect(r.ended).toEqual([]);
  });

  it('Given an extraction left alone, Then it keeps going: 800 frames (13.33 s) give 8 bites of 250 kg, each its own cargo:action and recordMined', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(800);
    expect(r.cargo.kg('ice')).toBe(2_000);
    expect(r.bites.map((b) => b.kg)).toEqual([250, 250, 250, 250, 250, 250, 250, 250]);
    expect(r.actions.map((a) => a.action)).toEqual(
      Array.from({ length: 8 }, () => ({ kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 })),
    );
    expect(r.worldState.entries().map((e) => e.kg)).toEqual([250, 250, 250, 250, 250, 250, 250, 250]);
    expect(r.started).toHaveLength(1);
    expect(r.mining.status('mine').kind).toBe('running');
    expect(r.logs).toEqual([]);
  });

  // Plan 5, Task 3: replaces "the hold gets the remainder (500 kg)" — the
  // remainder now comes as two bites, and the extraction ends ICE DEPLETED.
  it('Given only 500 kg of ice left in the rock (and other resources), When B, Then two bites of 250 kg, and it ends "MINED · 500 KG ICE — ICE DEPLETED"', () => {
    const r = rig();
    r.worldState.recordMined(r.ast.id, 'ice', r.ast.composition.ice - 500, 'local');
    r.press(MINING_KEYS.mine);
    r.tick(240);
    expect(r.cargo.kg('ice')).toBe(500);
    expect(r.belt.remainingKg(r.ast.id, 'ice')).toBe(0);
    expect(r.actions.map((a) => a.action)).toEqual([
      { kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 },
      { kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 },
    ]);
    expect(r.worldState.entries()).toHaveLength(3); // the setup's, and one per bite
    expect(r.logs).toEqual(['MINED · 500 KG ICE — ICE DEPLETED']);
    expect(r.logs).toEqual([extractionLog('resource-depleted', 500, 'ice')]);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 500, end: 'resource-depleted' }]);
  });

  // Plan 5, Task 3: replaces "takes the next resource … min(2 000, metal)".
  it('Given no ice or rare left but metal, When B, Then the extraction takes metal (no NaN)', () => {
    const r = rig();
    r.worldState.recordMined(r.ast.id, 'ice', r.ast.composition.ice, 'local');
    r.worldState.recordMined(r.ast.id, 'rare', r.ast.composition.rare, 'local');
    r.press(MINING_KEYS.mine);
    r.tick(240); // 600 kg accrued: two bites
    expect(r.started).toEqual([{ asteroidId: r.ast.id, resource: 'metal' }]);
    expect(r.cargo.kg('metal')).toBe(500);
    expect(Number.isFinite(r.cargo.totalKg)).toBe(true);
    expect(r.actions.map((a) => a.action)).toEqual([
      { kind: 'mine', asteroidId: r.ast.id, resource: 'metal', kg: 250 },
      { kind: 'mine', asteroidId: r.ast.id, resource: 'metal', kg: 250 },
    ]);
  });

  // Plan 5, Task 3: replaces "only the free space is taken … MINED then HOLD FULL".
  it('Given a hold with only 500 kg free, When B, Then two bites fill it, and it ends in one line "MINED · 500 KG ICE — HOLD FULL"', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 500 });
    r.press(MINING_KEYS.mine);
    r.tick(240);
    expect(r.cargo.kg('ice')).toBe(500);
    expect(r.cargo.totalKg).toBe(CARGO_CAPACITY_KG);
    expect(r.cargo.freeKg).toBe(0);
    // The rock gives up only what the hold took.
    expect(r.worldState.entries().map((e) => e.kg)).toEqual([250, 250]);
    expect(r.logs).toEqual(['MINED · 500 KG ICE — HOLD FULL']);
    expect(r.logs).toEqual([extractionLog('hold-full', 500, 'ice')]);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 500, end: 'hold-full' }]);
  });

  it('Given the ship matched through its parent frame (velocity relative to shipParent), Then the relative speed is taken in the world frame', () => {
    const r = rig();
    const parentVel = new Vector3(3, -7, 11);
    r.world.shipParent = { worldVelocity: parentVel };
    r.world.flight.velocity.copy(r.astVel).sub(parentVel);
    r.press(MINING_KEYS.mine);
    // Plan 5, Task 3: was `busy?.kind === 'mine'`; an extraction is reported by status().
    expect(r.mining.status('mine').kind).toBe('running');
    expect(r.logs).toEqual([]);
  });

  it('Given an asteroid targeted, Then asteroidInRange says whether the ship is within 0.5 km of its surface', () => {
    const r = rig({ rangeKm: 0.4 });
    r.tick();
    expect(r.mining.asteroidInRange).toBe(true);
    r.placeAt(MINE_RANGE_KM + 0.01);
    r.tick();
    expect(r.mining.asteroidInRange).toBe(false);
    r.placeAt(0.1);
    r.targeting.targetId = null;
    r.tick();
    expect(r.mining.asteroidInRange).toBe(false);
  });
});

describe('mine refusals — logged, nothing started', () => {
  function refused(r: ReturnType<typeof rig>, log: string): void {
    r.press(MINING_KEYS.mine);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual([log]);
    r.tick(300);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions.filter((a) => a.result.ok)).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
  }

  it('Given no target, When B, Then "NO ASTEROID TARGETED"', () => {
    refused(rig({ target: null }), 'NO ASTEROID TARGETED');
  });

  it('Given a field (not an asteroid) targeted, When B, Then "NO ASTEROID TARGETED"', () => {
    refused(rig({ target: fyssField(0).id }), 'NO ASTEROID TARGETED');
  });

  it('Given the rock 0.6 km from the surface, When B, Then "OUT OF RANGE"', () => {
    refused(rig({ rangeKm: 0.6 }), 'OUT OF RANGE');
  });

  it('Given 0.006 km/s relative to the rock, When B, Then "MATCH SPEED"', () => {
    refused(rig({ relKmS: 0.006 }), 'MATCH SPEED');
  });

  it('Given a full hold, When B, Then "HOLD FULL"', () => {
    const r = rig();
    r.cargo.restore({ metal: CARGO_CAPACITY_KG });
    r.press(MINING_KEYS.mine);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['HOLD FULL']);
    expect(r.cargo.totalKg).toBe(CARGO_CAPACITY_KG);
  });

  // Plan 5 (owner, 2026-11-20): a mined-out rock no longer exists, so it is not a target.
  it('Given a depleted rock, When B, Then "NO ASTEROID TARGETED" (the rock is gone), nothing is mined and nothing is NaN', () => {
    const r = rig();
    for (const res of ['ice', 'metal', 'silicate', 'rare'] as const) {
      r.worldState.recordMined(r.ast.id, res, r.ast.composition[res], 'local');
    }
    const before = r.worldState.entries().length;
    r.press(MINING_KEYS.mine);
    r.tick(300);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['NO ASTEROID TARGETED']);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.worldState.entries()).toHaveLength(before);
    for (const res of ['ice', 'metal', 'silicate', 'rare'] as const) {
      expect(r.belt.remainingKg(r.ast.id, res)).toBe(0);
      expect(Number.isNaN(r.cargo.kg(res))).toBe(false);
    }
  });

  it('Given cruise or a warp, When B, Then "BUSY"', () => {
    const r = rig();
    r.cruise.busy = true;
    r.press(MINING_KEYS.mine);
    r.cruise.busy = false;
    r.warp.phase = 'charging';
    r.press(MINING_KEYS.mine);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['BUSY', 'BUSY']);
  });

  it('Given paused or frozen, When B/U/N, Then the keys do nothing — not even a log', () => {
    const r = rig();
    r.cargo.restore({ ice: 5_000, metal: 1_000, silicate: 1_000 });
    r.tank.capacityLossFrac = 0.1;
    for (const k of ['paused', 'frozen'] as const) {
      r.world[k] = true;
      r.press(MINING_KEYS.mine);
      r.press(MINING_KEYS.refine);
      r.press(MINING_KEYS.repair);
      r.world[k] = false;
    }
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual([]);
    expect(r.actions).toEqual([]);
  });

  // Plan 5, Task 3: replaces "When B, U or N … BUSY and the mine carries on" —
  // B now stops an extraction (see 'an extraction stops'); U and N stay BUSY.
  it('Given an extraction underway, When U or N is pressed, Then "BUSY" and the extraction carries on', () => {
    const r = rig({ lossFrac: 0.1 });
    r.cargo.restore({ ice: 1_000, metal: 600, silicate: 400 });
    r.press(MINING_KEYS.mine);
    r.press(MINING_KEYS.refine);
    r.press(MINING_KEYS.repair);
    expect(r.logs).toEqual(['BUSY', 'BUSY']);
    expect(r.mining.status('mine').kind).toBe('running');
    expect(r.mining.busy).toBeNull(); // no refine or repair started
    r.tick(98); // 2 presses + 98 = 100 frames since B: one bite
    expect(r.cargo.kg('ice')).toBe(1_250);
    expect(r.actions.map((a) => a.action.kind)).toEqual(['mine']);
    expect(r.mining.status('mine').kind).toBe('running');
  });

  it('Given a refine underway, When B is pressed, Then "BUSY", nothing is extracted, and the refine completes', () => {
    const r = rig({ fill: 0.5 });
    r.cargo.restore({ ice: 1_000 });
    r.press(MINING_KEYS.refine);
    r.press(MINING_KEYS.mine);
    expect(r.logs).toEqual(['BUSY']);
    expect(r.started).toEqual([]);
    expect(r.mining.busy?.kind).toBe('refine');
    r.tick(479); // 480 frames since U
    expect(r.mining.busy).toBeNull();
    expect(r.actions.map((a) => a.action.kind)).toEqual(['refine']);
    expect(r.logs).toEqual(['BUSY', 'REFINED · 800 KG PROPELLANT']);
  });
});

// Plan 5, Task 3: replaces 'a mine aborts cleanly — no yield, no action,
// "MINING ABORTED"'. A broken requirement ENDS the extraction with its reason;
// every finished bite is kept, the unfinished part is not paid.
describe('an extraction ends when a requirement breaks — the finished bites are kept', () => {
  type R = ReturnType<typeof rig>;
  const enders: Array<[string, ExtractionEnd, string, (r: R) => void, (r: R) => void]> = [
    ['the ship drifts out of range', 'range', 'MINING STOPPED — OUT OF RANGE · 250 KG ICE', (r) => r.placeAt(MINE_RANGE_KM + 0.1), (r) => r.placeAt(0.2)],
    [
      'the ship moves 0.006 km/s relative to the rock',
      'speed',
      'MINING STOPPED — MATCH SPEED · 250 KG ICE',
      (r) => r.world.flight.velocity.add(new Vector3(0, 0.006, 0)),
      (r) => r.world.flight.velocity.copy(r.astVel),
    ],
    ['the target is dropped', 'no-target', 'MINING STOPPED — NO ASTEROID TARGETED · 250 KG ICE', (r) => (r.targeting.targetId = null), (r) => (r.targeting.targetId = r.ast.id)],
    [
      'the target becomes a field (not an asteroid)',
      'no-target',
      'MINING STOPPED — NO ASTEROID TARGETED · 250 KG ICE',
      (r) => (r.targeting.targetId = fyssField(0).id),
      (r) => (r.targeting.targetId = r.ast.id),
    ],
    ['pause', 'interrupted', 'MINING STOPPED · 250 KG ICE', (r) => (r.world.paused = true), (r) => (r.world.paused = false)],
    ['freeze (recovery cut, overlay)', 'interrupted', 'MINING STOPPED · 250 KG ICE', (r) => (r.world.frozen = true), (r) => (r.world.frozen = false)],
    ['cruise', 'interrupted', 'MINING STOPPED · 250 KG ICE', (r) => (r.cruise.busy = true), (r) => (r.cruise.busy = false)],
    ['a jump (warp charging)', 'interrupted', 'MINING STOPPED · 250 KG ICE', (r) => (r.warp.phase = 'charging'), (r) => (r.warp.phase = 'idle')],
    ['the emergency beacon (ship:recovered)', 'interrupted', 'MINING STOPPED · 250 KG ICE', () => bus.emit('ship:recovered', { cause: 'beacon' }), () => undefined],
  ];

  for (const [why, end, text, block, clear] of enders) {
    it(`Given an extraction 2 s in (one bite), When ${why}, Then it ends '${end}': the 250 kg stay in the hold, log "${text}"`, () => {
      const r = rig();
      r.press(MINING_KEYS.mine);
      r.tick(119); // 297.5 kg accrued: one bite of 250
      expect(r.mining.status('mine').kind).toBe('running');
      expect(r.cargo.kg('ice')).toBe(250);
      block(r);
      r.tick();
      expect(r.mining.status('mine').kind).not.toBe('running');
      expect(r.logs).toEqual([text]);
      expect(r.logs).toEqual([extractionLog(end, 250, 'ice')]);
      expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 250, end }]);
      // The bite is kept, recorded once; the 47.5 kg begun on the next is not paid.
      expect(r.cargo.kg('ice')).toBe(250);
      expect(r.actions.map((a) => a.action)).toEqual([{ kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 }]);
      expect(r.worldState.entries()).toHaveLength(1);
      // And it stays ended: clearing the blocker does not resume it.
      clear(r);
      r.tick(600);
      expect(r.mining.status('mine').kind).not.toBe('running');
      expect(r.cargo.totalKg).toBe(250);
      expect(r.actions).toHaveLength(1);
      expect(r.worldState.entries()).toHaveLength(1);
      expect(r.ended).toHaveLength(1);
      expect(r.logs).toEqual([text]);
    });
  }

  it('Given an extraction ended by a broken requirement before its first bite, Then "MINING STOPPED — OUT OF RANGE", nothing in the hold, mining:ended with 0 kg', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(50);
    r.placeAt(MINE_RANGE_KM + 0.1);
    r.tick();
    expect(r.logs).toEqual(['MINING STOPPED — OUT OF RANGE']);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 0, end: 'range' }]);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
  });

  // Plan 5, Task 3: replaces "the gate fails on the very frame the 4 s would complete".
  it('Given the gate fails on the very frame a bite would fall due, Then that bite is not paid (the gate is asked before the bites, R16)', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(99); // 247.5 kg: the bite falls due on the next frame
    r.placeAt(MINE_RANGE_KM + 0.1);
    r.tick(1);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.bites).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
    expect(r.logs).toEqual(['MINING STOPPED — OUT OF RANGE']);
  });
});

// Plan 5, Task 3: replaces 'sim time' (the 10× compression test). Time
// compression cannot be engaged at a rock (owner, 2026-11-20), but a long
// frame — a stalling tab — covers several bites, faked here as one frame that
// advanced several seconds of sim time.
describe('sim time — several bites in one frame (review focus 1)', () => {
  it('Given one frame of 3.4 s sim, Then two bites of 250 kg land in that frame, and 10 kg carry on toward the next', () => {
    const r = rig();
    r.setRate(204); // 204 × 1/60 s = 3.4 s per frame: 510 kg
    r.press(MINING_KEYS.mine);
    expect(r.cargo.totalKg).toBe(0); // the press frame only starts it
    r.tick(1);
    expect(r.bites.map((b) => b.kg)).toEqual([250, 250]);
    expect(r.cargo.kg('ice')).toBe(500);
    expect(r.actions).toHaveLength(2);
    expect(r.worldState.entries()).toHaveLength(2);
    const s = r.mining.status('mine');
    expect(s.kind).toBe('running');
    expect(s.kind === 'running' ? s.shownKg : NaN).toBeCloseTo(510, 6);
  });

  it('Given 300 kg of room and one frame of 4 s sim, Then 250 + 50 kg land in that frame and it ends HOLD FULL in that same frame', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 300 });
    r.setRate(240); // 4 s per frame: 600 kg
    r.press(MINING_KEYS.mine);
    r.tick(1);
    expect(r.bites.map((b) => b.kg)).toEqual([250, 50]);
    expect(r.cargo.kg('ice')).toBe(300);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 300, end: 'hold-full' }]);
    expect(r.logs).toEqual(['MINED · 300 KG ICE — HOLD FULL']);
    expect(r.logs).toEqual([extractionLog('hold-full', 300, 'ice')]);
  });

  it('Given a long frame in which the ship is out of range, Then none of its bites are paid (the gate decides the frame, once)', () => {
    const r = rig();
    r.setRate(204);
    r.press(MINING_KEYS.mine);
    r.placeAt(MINE_RANGE_KM + 0.1);
    r.tick(1);
    expect(r.bites).toEqual([]);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.logs).toEqual(['MINING STOPPED — OUT OF RANGE']);
  });

  // Plan 5, Task 3: replaces "frames that advanced no sim time → the action does not progress" (was `busy.leftS`).
  it('Given frames that advanced no sim time, Then the extraction does not progress', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(50);
    const s0 = r.mining.status('mine');
    expect(s0.kind).toBe('running');
    const shown = s0.kind === 'running' ? s0.shownKg : NaN;
    r.setRate(0);
    r.tick(600);
    const s1 = r.mining.status('mine');
    expect(s1.kind).toBe('running');
    expect(s1.kind === 'running' ? s1.shownKg : NaN).toBe(shown);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.bites).toEqual([]);
  });
});

describe('refine (U) — the tank op', () => {
  it('Given ice in the hold and room in the tank, When U, Then after 8 s the tank rises by 0.8 × the ice used and the log says REFINED', () => {
    const r = rig({ fill: 0.5 });
    r.cargo.restore({ ice: 5_000 });
    const before = r.tank.massKg;
    r.press(MINING_KEYS.refine);
    expect(r.mining.busy).toEqual({ kind: 'refine', leftS: 8 });
    r.tick(479);
    expect(r.tank.massKg).toBe(before);
    expect(r.cargo.kg('ice')).toBe(5_000);
    r.tick(1); // 480 frames: 8 s
    expect(r.mining.busy).toBeNull();
    expect(r.tank.massKg).toBeCloseTo(before + 0.8 * 5_000, 6);
    expect(r.cargo.kg('ice')).toBe(0);
    expect(r.actions.map((a) => a.action.kind)).toEqual(['refine']);
    expect(r.actions[0]!.result.ok).toBe(true);
    expect(r.logs).toEqual(['REFINED · 4 000 KG PROPELLANT']);
  });

  it('Given only 1 000 kg of room in the tank, When U, Then 1 250 kg ice is used and the rest stays in the hold', () => {
    const r = rig({ fill: (CAP - 1_000) / CAP });
    r.cargo.restore({ ice: 5_000 });
    r.press(MINING_KEYS.refine);
    r.tick(480);
    expect(r.tank.massKg).toBeCloseTo(CAP, 6);
    expect(r.cargo.kg('ice')).toBeCloseTo(3_750, 6);
    expect(r.logs).toEqual(['REFINED · 1 000 KG PROPELLANT']);
  });

  it('Given no ice, When U, Then "NO ICE" and nothing starts', () => {
    const r = rig();
    r.press(MINING_KEYS.refine);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['NO ICE']);
  });

  it('Given a full tank, When U, Then "TANK FULL" and nothing starts', () => {
    const r = rig({ fill: 1 });
    r.cargo.restore({ ice: 5_000 });
    r.press(MINING_KEYS.refine);
    r.tick(600);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['TANK FULL']);
    expect(r.cargo.kg('ice')).toBe(5_000);
  });

  it('Given refining needs no rock, Then U works with no target and out of range', () => {
    const r = rig({ target: null, rangeKm: 50 });
    r.cargo.restore({ ice: 1_000 });
    r.press(MINING_KEYS.refine);
    r.tick(480);
    expect(r.cargo.kg('ice')).toBe(0);
    expect(r.logs).toEqual(['REFINED · 800 KG PROPELLANT']);
  });
});

describe('repair (N)', () => {
  it('Given materials and loss, When N, Then after 10 s the loss falls by 0.04 and the log says REPAIRED · TANK +4 %', () => {
    const r = rig({ lossFrac: 0.1 });
    r.cargo.restore({ metal: 600, silicate: 400 });
    r.press(MINING_KEYS.repair);
    expect(r.mining.busy).toEqual({ kind: 'repair', leftS: 10 });
    r.tick(599);
    expect(r.tank.capacityLossFrac).toBeCloseTo(0.1, 12);
    r.tick(1); // 600 frames: 10 s
    expect(r.mining.busy).toBeNull();
    expect(r.tank.capacityLossFrac).toBeCloseTo(0.06, 12);
    expect(r.cargo.kg('metal')).toBe(0);
    expect(r.cargo.kg('silicate')).toBe(0);
    expect(r.actions.map((a) => a.action.kind)).toEqual(['repair']);
    expect(r.logs).toEqual(['REPAIRED · TANK +4 %']);
  });

  it('Given no loss, When N, Then "TANK UNDAMAGED" and nothing starts', () => {
    const r = rig({ lossFrac: 0 });
    r.cargo.restore({ metal: 600, silicate: 400 });
    r.press(MINING_KEYS.repair);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['TANK UNDAMAGED']);
  });

  it('Given too little metal or silicate, When N, Then "NEED 600 KG METAL · 400 KG SILICATE" and nothing starts', () => {
    const r = rig({ lossFrac: 0.1 });
    r.cargo.restore({ metal: 599, silicate: 400 });
    r.press(MINING_KEYS.repair);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['NEED 600 KG METAL · 400 KG SILICATE']);
    r.tick(700);
    expect(r.tank.capacityLossFrac).toBeCloseTo(0.1, 12);
  });
});

describe('a hull without a tank or a hold — inert', () => {
  for (const [why, o] of [
    ['no tank', { noTank: true }],
    ['no hold', { noCargo: true }],
  ] as const) {
    it(`Given ${why}, Then B/U/N do nothing: no action, no log, no worldState entry`, () => {
      const r = rig({ ...o, lossFrac: 0.1 });
      r.cargo.restore({ ice: 5_000, metal: 1_000, silicate: 1_000 });
      r.press(MINING_KEYS.mine);
      r.press(MINING_KEYS.refine);
      r.press(MINING_KEYS.repair);
      r.tick(700);
      expect(r.mining.busy).toBeNull();
      expect(r.mining.asteroidInRange).toBe(false);
      expect(r.logs).toEqual([]);
      expect(r.actions).toEqual([]);
      expect(r.worldState.entries()).toHaveLength(0);
      expect(r.cargo.snapshot()).toEqual({ ice: 5_000, metal: 1_000, silicate: 1_000, rare: 0 });
    });
  }
});

// ---------------------------------------------------------------------------
// Ruling R16 — refine and repair abort on the same conditions as a mine
// (pause, frozen, cruise, warp, the beacon / ship:recovered), with nothing
// applied, and log REFINING ABORTED / REPAIR ABORTED. Unlike a mine they do
// not depend on the target, the range or the relative speed.
// ---------------------------------------------------------------------------

describe('refine and repair abort cleanly (R16)', () => {
  type R = ReturnType<typeof rig>;
  const blockers: Array<[string, (r: R) => void, (r: R) => void]> = [
    ['pause', (r) => (r.world.paused = true), (r) => (r.world.paused = false)],
    ['freeze', (r) => (r.world.frozen = true), (r) => (r.world.frozen = false)],
    ['cruise', (r) => (r.cruise.busy = true), (r) => (r.cruise.busy = false)],
    ['warp', (r) => (r.warp.phase = 'charging'), (r) => (r.warp.phase = 'idle')],
    ['the emergency beacon (ship:recovered)', () => bus.emit('ship:recovered', { cause: 'beacon' }), () => undefined],
  ];
  const kinds = [
    { kind: 'refine', key: MINING_KEYS.refine, frames: 480, log: 'REFINING ABORTED' },
    { kind: 'repair', key: MINING_KEYS.repair, frames: 600, log: 'REPAIR ABORTED' },
  ] as const;

  /** Ice to refine, materials to repair with, room in the tank and loss to repair. */
  function stocked(): R {
    const r = rig({ fill: 0.5, lossFrac: 0.1 });
    r.cargo.restore({ ice: 5_000, metal: 600, silicate: 400 });
    return r;
  }

  function expectUntouched(r: R, mass: number): void {
    expect(r.mining.busy).toBeNull();
    expect(r.actions).toEqual([]);
    expect(r.cargo.snapshot()).toEqual({ ice: 5_000, metal: 600, silicate: 400, rare: 0 });
    expect(r.tank.massKg).toBe(mass);
    expect(r.tank.capacityLossFrac).toBeCloseTo(0.1, 12);
  }

  for (const k of kinds) {
    for (const [why, block, clear] of blockers) {
      it(`Given a ${k.kind} half done, When ${why}, Then it aborts: nothing applied, no cargo:action, log ${k.log}`, () => {
        const r = stocked();
        const mass = r.tank.massKg;
        r.press(k.key);
        r.tick(k.frames / 2);
        expect(r.mining.busy?.kind).toBe(k.kind);
        block(r);
        r.tick();
        expect(r.logs).toEqual([k.log]);
        // And it stays aborted: clearing the blocker does not resume it.
        clear(r);
        r.tick(k.frames + 60);
        expectUntouched(r, mass);
        expect(r.logs).toEqual([k.log]);
      });
    }

    it(`Given the gate fails on the very frame the ${k.kind} would complete, Then it aborts instead (re-checked at completion)`, () => {
      const r = stocked();
      const mass = r.tank.massKg;
      r.press(k.key);
      r.tick(k.frames - 1);
      expect(r.mining.busy?.kind).toBe(k.kind);
      r.warp.phase = 'charging';
      r.tick(1);
      expectUntouched(r, mass);
      expect(r.logs).toEqual([k.log]);
    });

    it(`Given a ${k.kind} underway, When the target is dropped and the ship drifts off at speed, Then it still completes (no target, range or speed gate)`, () => {
      const r = stocked();
      r.press(k.key);
      r.tick(10);
      r.targeting.targetId = null;
      r.placeAt(500);
      r.world.flight.velocity.add(new Vector3(1, 0, 0));
      r.tick(k.frames - 10);
      expect(r.mining.busy).toBeNull();
      expect(r.actions.map((a) => a.action.kind)).toEqual([k.kind]);
      expect(r.actions[0]!.result.ok).toBe(true);
      expect(r.logs.some((l) => l.endsWith('ABORTED'))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Task 5 fix round 1 (R18): one hold-full rule, dust is depleted, and the
// aborts the review found untested — leaving flight, and a new target.
// ---------------------------------------------------------------------------

/** Listeners on the shared bus for one event (the bus keeps them private). */
function listeners(event: string): number {
  return (bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers.get(event)?.size ?? 0;
}

describe('one hold-full rule; dust is depleted (R18)', () => {
  it('Given 5e-7 kg free, Then B is refused HOLD FULL at the press', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 5e-7 });
    expect(r.cargo.freeKg).toBeGreaterThan(0);
    r.press(MINING_KEYS.mine);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['HOLD FULL']);
    r.tick(300);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
  });

  // Plan 5 (owner, 2026-11-20): dust under 0.5 kg of everything is a destroyed rock.
  it('Given a rock with 0.3 kg left of everything, Then B is refused NO ASTEROID TARGETED (the rock is gone; never "MINED · 0 KG")', () => {
    const r = rig();
    for (const res of ['ice', 'metal', 'silicate', 'rare'] as const) {
      r.worldState.recordMined(r.ast.id, res, r.ast.composition[res] - 0.3, 'local');
    }
    const before = r.worldState.entries().length;
    r.press(MINING_KEYS.mine);
    r.tick(300);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['NO ASTEROID TARGETED']);
    expect(r.actions).toEqual([]);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.worldState.entries()).toHaveLength(before);
  });
});

// Final whole-branch review, minor (c): one threshold — MINE_MIN_KG (0.5 kg) —
// for "the hold is full", at the press and after a mine; FULL_EPS_KG is gone.
describe('hold-full at MINE_MIN_KG (final review, minor c)', () => {
  it('Given 0.3 kg free, When B, Then it is refused HOLD FULL at the press (never "MINED · 0 KG", no dust record)', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 0.3 });
    r.press(MINING_KEYS.mine);
    expect(r.mining.busy).toBeNull();
    r.tick(300);
    expect(r.logs).toEqual(['HOLD FULL']);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
  });

  // Plan 5, Task 3: was one 2 000 kg mine (240 frames) logging 'MINED · 2 000 KG ICE', 'HOLD FULL'.
  it('Given an extraction that leaves 0.3 kg free, When its last bite lands, Then it ends at once in one line "MINED · 2 000 KG ICE — HOLD FULL"', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 2_000.3 });
    r.press(MINING_KEYS.mine);
    r.tick(800); // 8 bites of 250
    expect(r.cargo.freeKg).toBeCloseTo(0.3, 6);
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.logs).toEqual(['MINED · 2 000 KG ICE — HOLD FULL']);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 2_000, end: 'hold-full' }]);
  });

  it('Given Mining.ts, Then it has no FULL_EPS_KG of its own (one threshold, from miningRules)', () => {
    const src = readFileSync(fileURLToPath(new URL('./Mining.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('FULL_EPS_KG');
  });
});

describe('more clean aborts (R18)', () => {
  // Plan 5, Task 3: was "aborts with one MINING ABORTED and nothing applied".
  it('Given an extraction 2 s in (one bite), When the game leaves flight (onModeChange), Then it ends interrupted at once with "MINING STOPPED · 250 KG ICE" and the bite is kept', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(119);
    r.mining.onModeChange?.('flight', 'map');
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.logs).toEqual(['MINING STOPPED · 250 KG ICE']);
    expect(r.logs).toEqual([extractionLog('interrupted', 250, 'ice')]);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 250, end: 'interrupted' }]);
    // Back in flight: it does not resume, and nothing is logged twice.
    r.mining.onModeChange?.('map', 'flight');
    r.tick(600);
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.logs).toEqual(['MINING STOPPED · 250 KG ICE']);
    expect(r.cargo.totalKg).toBe(250);
    expect(r.actions).toHaveLength(1);
    expect(r.worldState.entries()).toHaveLength(1);
    expect(r.ended).toHaveLength(1);
  });

  it('Given a refine underway, When the game leaves flight, Then REFINING ABORTED and the tank is untouched', () => {
    const r = rig({ fill: 0.5 });
    r.cargo.restore({ ice: 1_000 });
    const mass = r.tank.massKg;
    r.press(MINING_KEYS.refine);
    r.tick(60);
    r.mining.onModeChange?.('flight', 'yard');
    r.tick(600);
    expect(r.logs).toEqual(['REFINING ABORTED']);
    expect(r.tank.massKg).toBe(mass);
    expect(r.cargo.kg('ice')).toBe(1_000);
    expect(r.actions).toEqual([]);
  });

  it('Given nothing underway, When the game leaves flight, Then nothing is logged', () => {
    const r = rig();
    r.mining.onModeChange?.('flight', 'map');
    expect(r.logs).toEqual([]);
  });

  // Plan 5, Task 3: was "Then the mine aborts" with nothing applied.
  it('Given an extraction 2 s in (one bite), When the target switches to another asteroid that is itself in range and matched, Then it ends interrupted (it belongs to the rock it started on) and the bite is kept', () => {
    const r = rig();
    const other = fyssField(0).asteroids.find((a) => a.id !== r.ast.id)!;
    const w = new Vector3();
    expect(r.belt.asteroidWorld(other.id, w)).toBe(true);
    r.press(MINING_KEYS.mine);
    r.tick(119);
    // Same field, same velocity: beside the other rock the ship is matched.
    r.targeting.targetId = other.id;
    r.world.flight.worldPosition.copy(w).add(new Vector3(other.radiusKm + 0.2, 0, 0));
    r.tick();
    expect(r.mining.asteroidInRange).toBe(true); // the new target passes the gate on its own
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.logs).toEqual(['MINING STOPPED · 250 KG ICE']);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 250, end: 'interrupted' }]);
    r.tick(600);
    expect(r.cargo.totalKg).toBe(250);
    expect(r.actions.map((a) => a.action)).toEqual([{ kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 }]);
    expect(r.worldState.entries()).toHaveLength(1);
    expect(r.started).toHaveLength(1); // nothing starts on the other rock by itself
  });
});

describe('the rig cleans up after itself (R18)', () => {
  it('Given the rigs of every earlier test, Then no Mining listener is left on the bus; and a disposed Mining releases its own', () => {
    expect(listeners('ship:recovered')).toBe(0);
    const r = rig();
    expect(listeners('ship:recovered')).toBe(1);
    r.mining.dispose?.();
    expect(listeners('ship:recovered')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v4 sub-plan 5, Task 3 (phase A) — Mining runs the extraction.
// ---------------------------------------------------------------------------

const ALL: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

/** Leave `leftKg` of `res` in the rig's rock (the rest of it recorded as mined). */
function leave(r: ReturnType<typeof rig>, res: Resource, leftKg: number): void {
  r.worldState.recordMined(r.ast.id, res, r.ast.composition[res] - leftKg, 'local');
}

describe('an extraction stops (B again)', () => {
  it('Given an extraction with one bite and 122.5 kg begun on the next, When B again, Then it ends stopped: "MINED · 250 KG ICE", 250 kg kept, the begun part not paid', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(149);
    expect(r.cargo.kg('ice')).toBe(250);
    r.press(MINING_KEYS.mine);
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.logs).toEqual(['MINED · 250 KG ICE']);
    expect(r.logs).toEqual([extractionLog('stopped', 250, 'ice')]);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 250, end: 'stopped' }]);
    r.tick(600);
    expect(r.cargo.kg('ice')).toBe(250);
    expect(r.actions).toHaveLength(1);
    expect(r.worldState.entries()).toHaveLength(1);
    expect(r.ended).toHaveLength(1);
  });

  it('Given an extraction stopped before its first bite, Then "MINING STOPPED" and mining:ended with 0 kg', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(30);
    r.press(MINING_KEYS.mine);
    expect(r.logs).toEqual(['MINING STOPPED']);
    expect(r.logs).toEqual([extractionLog('stopped', 0, 'ice')]);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 0, end: 'stopped' }]);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
  });

  it('Given a stopped extraction, When B a third time, Then a new one starts from nothing (its first bite 100 frames later)', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(149);
    r.press(MINING_KEYS.mine); // stop
    r.press(MINING_KEYS.mine); // start again
    expect(r.started).toHaveLength(2);
    expect(r.mining.status('mine').kind).toBe('running');
    r.tick(99);
    expect(r.cargo.kg('ice')).toBe(250);
    r.tick(1);
    expect(r.cargo.kg('ice')).toBe(500);
  });
});

describe('which resource an extraction takes — one, and it does not switch', () => {
  const cases: Array<[readonly Resource[], Resource]> = [
    [[], 'ice'],
    [['ice'], 'rare'],
    [['ice', 'rare'], 'metal'],
    [['ice', 'rare', 'metal'], 'silicate'],
  ];
  for (const [gone, want] of cases) {
    it(`Given ${gone.length ? gone.join(', ') + ' mined out' : 'every resource'}, When B, Then the extraction takes ${want} (order: ice, rare, metal, silicate)`, () => {
      const r = rig();
      for (const res of gone) leave(r, res, 0);
      r.press(MINING_KEYS.mine);
      expect(r.started).toEqual([{ asteroidId: r.ast.id, resource: want }]);
      r.tick(100);
      expect(r.bites).toEqual([{ asteroidId: r.ast.id, resource: want, kg: 250 }]);
      expect(r.cargo.kg(want)).toBe(250);
    });
  }

  it('Given 300 kg of ice left and plenty of everything else, When B and time passes, Then 250 + 50 kg ice, it ends "MINED · 300 KG ICE — ICE DEPLETED" and takes nothing else', () => {
    const r = rig();
    leave(r, 'ice', 300);
    r.press(MINING_KEYS.mine);
    r.tick(119);
    expect(r.mining.status('mine').kind).toBe('running');
    r.tick(1); // frame 120: the 50 kg bite — and the end, in the same frame
    expect(r.bites.map((b) => b.kg)).toEqual([250, 50]);
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 300, end: 'resource-depleted' }]);
    expect(r.logs).toEqual(['MINED · 300 KG ICE — ICE DEPLETED']);
    expect(r.logs).toEqual([extractionLog('resource-depleted', 300, 'ice')]);
    r.tick(600);
    expect(r.cargo.snapshot()).toEqual({ ice: 300, metal: 0, silicate: 0, rare: 0 });
    // The rock still has rare, metal and silicate: it is not destroyed.
    expect(r.destroyed).toEqual([]);
    expect(r.belt.isDestroyed(r.ast.id)).toBe(false);
  });

  it('Given the ice ran out, When B again, Then a new extraction starts on the next resource (rare)', () => {
    const r = rig();
    leave(r, 'ice', 300);
    r.press(MINING_KEYS.mine);
    r.tick(120);
    r.press(MINING_KEYS.mine);
    expect(r.started.map((s) => s.resource)).toEqual(['ice', 'rare']);
    r.tick(100);
    expect(r.cargo.kg('rare')).toBe(250);
  });
});

describe('no carried-over burst — an extraction ends in the frame its bite size becomes 0', () => {
  it('Given the hold fills on a bite, Then the extraction has ended in that same frame (status not running, one mining:ended)', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 300 });
    r.press(MINING_KEYS.mine);
    r.tick(119);
    expect(r.ended).toEqual([]);
    r.tick(1); // frame 120: 50 kg, hold full
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 300, end: 'hold-full' }]);
    expect(r.mining.status('mine')).toEqual({ kind: 'blocked', reason: 'hold-full' });
  });

  it('Given a full hold that sat for 10 s, When space is freed and B pressed, Then the new extraction starts from 0 carry: no bite at once, the first after 100 frames', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 300 });
    r.press(MINING_KEYS.mine);
    r.tick(120);
    r.tick(600); // nothing may pile up while the hold is full
    expect(r.bites).toHaveLength(2);
    r.cargo.restore({ ice: 300 }); // the silicate is gone: 7 700 kg free
    r.press(MINING_KEYS.mine);
    expect(r.started).toHaveLength(2);
    r.tick(1);
    expect(r.cargo.kg('ice')).toBe(300);
    expect(r.bites).toHaveLength(2);
    r.tick(98); // 99 frames since the press
    expect(r.cargo.kg('ice')).toBe(300);
    r.tick(1); // 100 frames: the first bite
    expect(r.cargo.kg('ice')).toBe(550);
    expect(r.bites).toHaveLength(3);
  });
});

describe('the last bite empties the rock (review focus 3)', () => {
  /** A rock with only `iceKg` of ice left and `dustKg` of everything else. */
  function nearlyEmpty(iceKg: number, dustKg: number): ReturnType<typeof rig> {
    const r = rig();
    for (const res of ALL) leave(r, res, res === 'ice' ? iceKg : dustKg);
    return r;
  }

  for (const dust of [0, 0.3]) {
    it(`Given ${dust} kg of everything but ice and 300 kg ice, When the last bite lands, Then asteroid:destroyed once in that frame, mining:ended 'rock-depleted', "MINED · 300 KG ICE — DEPLETED"`, () => {
      const r = nearlyEmpty(300, dust);
      r.press(MINING_KEYS.mine);
      r.tick(119);
      expect(r.destroyed).toEqual([]);
      r.tick(1); // frame 120: the 50 kg bite empties the rock
      expect(r.bites.map((b) => b.kg)).toEqual([250, 50]);
      expect(r.destroyed).toEqual([{ asteroidId: r.ast.id }]);
      expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: 300, end: 'rock-depleted' }]);
      expect(r.logs).toEqual(['MINED · 300 KG ICE — DEPLETED']);
      expect(r.logs).toEqual([extractionLog('rock-depleted', 300, 'ice')]);
      expect(r.belt.isDestroyed(r.ast.id)).toBe(true);
      // Not "the target changed": the rock is gone, and the line says so.
      expect(r.logs.some((l) => l.startsWith('MINING STOPPED'))).toBe(false);
    });
  }

  it('Given the rock destroyed with the target still on its id, Then later frames do not throw, nothing more is emitted, and mine is blocked NO ASTEROID TARGETED', () => {
    const r = nearlyEmpty(300, 0);
    r.press(MINING_KEYS.mine);
    r.tick(120);
    expect(r.belt.asteroidSpec(r.ast.id)).toBeNull(); // what Targeting reads to drop it (Targeting.test.ts)
    expect(r.targeting.targetId).toBe(r.ast.id);
    expect(() => r.tick(60)).not.toThrow();
    expect(r.destroyed).toHaveLength(1);
    expect(r.ended).toHaveLength(1);
    expect(r.bites).toHaveLength(2);
    expect(r.mining.status('mine')).toEqual({ kind: 'blocked', reason: 'no-target' });
    expect(r.mining.operations).toEqual([]);
    expect(r.mining.asteroidInRange).toBe(false);
    // B on the gone rock is refused like any non-target.
    r.press(MINING_KEYS.mine);
    expect(r.logs.at(-1)).toBe('NO ASTEROID TARGETED');
    // And once Targeting has dropped it (the next frame in the game), still nothing throws.
    r.targeting.targetId = null;
    expect(() => r.tick(10)).not.toThrow();
    expect(r.destroyed).toHaveLength(1);
  });
});

describe('what is saved (review focus 2)', () => {
  it('Given 3 bites and a 4th begun, When the extraction ends out of range, Then 750 kg in the hold, the rock 750 kg lighter, 3 mine entries in the journal, and replaying it gives the same hold', () => {
    const r = rig();
    const journal = new ActionJournal({ wallMs: () => 0, orbitSeconds: () => 0 });
    offs.push(() => journal.dispose());
    const iceBefore = r.belt.remainingKg(r.ast.id, 'ice');
    r.press(MINING_KEYS.mine);
    r.tick(350); // 875 kg accrued: 3 bites, 125 kg begun on the 4th
    r.placeAt(MINE_RANGE_KM + 0.1);
    r.tick();
    expect(r.logs).toEqual(['MINING STOPPED — OUT OF RANGE · 750 KG ICE']);
    expect(r.cargo.kg('ice')).toBe(750);
    expect(r.belt.remainingKg(r.ast.id, 'ice')).toBe(iceBefore - 750);
    expect(r.worldState.entries().map((e) => e.kg)).toEqual([250, 250, 250]);
    const mines = journal.peek().filter((e) => e.source === 'cargo');
    expect(mines).toHaveLength(3);
    for (const e of mines) {
      expect(e.payload).toMatchObject({ action: { kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 250 }, result: { ok: true, kgIn: 250 } });
    }
    expect(replay(zeroState(), journal.peek()).cargo).toEqual(r.cargo.snapshot());
  });
});

describe('status(kind) — what the HUD reads', () => {
  it('Given a targeted rock in range, matched, with room, Then status(mine) is ready', () => {
    const r = rig();
    r.tick();
    expect(r.mining.status('mine')).toEqual({ kind: 'ready' });
  });

  const blocked: Array<[string, RigOpts, (r: ReturnType<typeof rig>) => void, string]> = [
    ['no target', { target: null }, () => undefined, 'no-target'],
    ['a field targeted', { target: fyssField(0).id }, () => undefined, 'no-target'],
    ['0.6 km from the surface', { rangeKm: 0.6 }, () => undefined, 'range'],
    ['0.006 km/s relative', { relKmS: 0.006 }, () => undefined, 'speed'],
    ['a full hold', {}, (r) => r.cargo.restore({ metal: CARGO_CAPACITY_KG }), 'hold-full'],
    ['cruise engaged', {}, (r) => (r.cruise.busy = true), 'cruise'],
    ['a jump charging', {}, (r) => (r.warp.phase = 'charging'), 'jump'],
    ['a jump in the tunnel', {}, (r) => (r.warp.phase = 'tunnel'), 'jump'],
    ['paused', {}, (r) => (r.world.paused = true), 'busy'],
    ['frozen', {}, (r) => (r.world.frozen = true), 'busy'],
  ];
  for (const [why, o, set, reason] of blocked) {
    it(`Given ${why}, Then status(mine) is blocked '${reason}'`, () => {
      const r = rig(o);
      set(r);
      r.tick();
      expect(r.mining.status('mine')).toEqual({ kind: 'blocked', reason });
    });
  }

  it('Given cruise or a jump, When B, Then the log still says "BUSY" (unchanged) while status says cruise / jump', () => {
    const r = rig();
    r.cruise.busy = true;
    r.press(MINING_KEYS.mine);
    expect(r.mining.status('mine')).toEqual({ kind: 'blocked', reason: 'cruise' });
    r.cruise.busy = false;
    r.warp.phase = 'charging';
    r.press(MINING_KEYS.mine);
    expect(r.mining.status('mine')).toEqual({ kind: 'blocked', reason: 'jump' });
    expect(r.logs).toEqual(['BUSY', 'BUSY']);
  });

  it('Given a refine running, Then status(mine) is blocked busy (another action is running)', () => {
    const r = rig({ fill: 0.5 });
    r.cargo.restore({ ice: 1_000 });
    r.press(MINING_KEYS.refine);
    r.tick();
    expect(r.mining.status('mine')).toEqual({ kind: 'blocked', reason: 'busy' });
  });

  it('Given an extraction running, Then status(mine) is running on ice with shownKg rising every frame, and progress the hold\'s fill', () => {
    const r = rig();
    r.cargo.restore({ silicate: 4_000 });
    r.press(MINING_KEYS.mine);
    let prev = -1;
    for (let i = 0; i < 150; i++) {
      r.tick();
      const s = r.mining.status('mine');
      expect(s.kind).toBe('running');
      expect(s.resource).toBe('ice');
      expect(s.shownKg).toBeGreaterThan(prev);
      prev = s.shownKg;
      if (i === 99) {
        // Frame 100: the first bite has just landed and nothing is begun on the next.
        expect(s.shownKg).toBeCloseTo(250, 9);
        expect(s.progress).toBeCloseTo(4_250 / CARGO_CAPACITY_KG, 9);
      }
    }
    expect(prev).toBeCloseTo(375, 9); // 150 frames × 2.5 kg
    const s = r.mining.status('mine');
    expect(s.progress).toBeGreaterThanOrEqual(0);
    expect(s.progress).toBeLessThanOrEqual(1);
  });

  it('Given a refine 4 s into its 8 s, Then status(refine) is running with progress 0.5 and 4 s left', () => {
    const r = rig({ fill: 0.5 });
    r.cargo.restore({ ice: 5_000 });
    r.press(MINING_KEYS.refine);
    r.tick(240);
    const s = r.mining.status('refine');
    expect(s.kind).toBe('running');
    expect(s.progress).toBeCloseTo(0.5, 9);
    expect(s.leftS).toBeCloseTo(4, 9);
  });

  it('Given a repair 5 s into its 10 s, Then status(repair) is running with progress 0.5 and 5 s left', () => {
    const r = rig({ lossFrac: 0.1 });
    r.cargo.restore({ metal: 600, silicate: 400 });
    r.press(MINING_KEYS.repair);
    r.tick(300);
    const s = r.mining.status('repair');
    expect(s.kind).toBe('running');
    expect(s.progress).toBeCloseTo(0.5, 9);
    expect(s.leftS).toBeCloseTo(5, 9);
  });

  it('Given refine and repair, Then status is ready when they could start and blocked with the refusal they would log otherwise', () => {
    const r = rig({ fill: 0.5, lossFrac: 0.1 });
    r.tick();
    expect(r.mining.status('refine')).toEqual({ kind: 'blocked', reason: 'nothing-to-refine' });
    expect(r.mining.status('repair')).toEqual({ kind: 'blocked', reason: 'insufficient' });
    r.cargo.restore({ ice: 1_000, metal: 600, silicate: 400 });
    r.tick();
    expect(r.mining.status('refine')).toEqual({ kind: 'ready' });
    expect(r.mining.status('repair')).toEqual({ kind: 'ready' });
    r.tank.capacityLossFrac = 0;
    r.tick();
    expect(r.mining.status('repair')).toEqual({ kind: 'blocked', reason: 'nothing-to-repair' });
    r.cruise.busy = true;
    r.tick();
    expect(r.mining.status('refine')).toEqual({ kind: 'blocked', reason: 'cruise' });
    r.cruise.busy = false;
    r.warp.phase = 'arriving';
    r.tick();
    expect(r.mining.status('refine')).toEqual({ kind: 'blocked', reason: 'jump' });
  });

  it('Given an extraction running, Then status(refine) and status(repair) are blocked busy', () => {
    const r = rig({ lossFrac: 0.1 });
    r.cargo.restore({ ice: 1_000, metal: 600, silicate: 400 });
    r.press(MINING_KEYS.mine);
    r.tick();
    expect(r.mining.status('refine')).toEqual({ kind: 'blocked', reason: 'busy' });
    expect(r.mining.status('repair')).toEqual({ kind: 'blocked', reason: 'busy' });
  });
});

describe('relSpeedKmS and speedOk', () => {
  it('Given the ship matched to the rock, Then relSpeedKmS ≈ 0 and speedOk', () => {
    const r = rig();
    r.tick();
    expect(r.mining.relSpeedKmS).toBeLessThan(1e-9);
    expect(r.mining.speedOk).toBe(true);
  });

  it('Given 0.004 km/s relative, Then speedOk; 0.006 km/s, Then not, and relSpeedKmS says 0.006', () => {
    const ok = rig({ relKmS: 0.004 });
    ok.tick();
    expect(ok.mining.relSpeedKmS).toBeCloseTo(0.004, 9);
    expect(ok.mining.speedOk).toBe(true);
    const fast = rig({ relKmS: 0.006 });
    fast.tick();
    expect(fast.mining.relSpeedKmS).toBeCloseTo(0.006, 9);
    expect(fast.mining.speedOk).toBe(false);
  });
});

describe('operations — what the beam and the wear are drawn from', () => {
  it('Given nothing running (or a refine), Then operations is empty', () => {
    const r = rig({ fill: 0.5 });
    r.tick();
    expect(r.mining.operations).toEqual([]);
    r.cargo.restore({ ice: 1_000 });
    r.press(MINING_KEYS.refine);
    r.tick();
    expect(r.mining.operations).toEqual([]);
  });

  it('Given an extraction running, Then one operation on the rock and resource, with its impact on the rock\'s surface (± 1 mm) on the ship\'s side, and its source at the ship', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick();
    expect(r.mining.operations).toHaveLength(1);
    const op = r.mining.operations[0]!;
    expect(op).toMatchObject({ asteroidId: r.ast.id, resource: 'ice' });
    const impact = new Vector3(op.impact.x, op.impact.y, op.impact.z);
    const source = new Vector3(op.source.x, op.source.y, op.source.z);
    const ship = r.world.flight.worldPosition;
    expect(Math.abs(impact.distanceTo(r.astWorld) - r.ast.radiusKm)).toBeLessThanOrEqual(1e-6);
    // The ship is 0.2 km from the surface; the nearest surface point is about that far.
    expect(impact.distanceTo(ship)).toBeLessThan(0.2 + 0.1);
    // The nose: at the ship, give or take its length.
    expect(source.distanceTo(ship)).toBeLessThan(0.1);
  });

  it('Given an extraction running for many frames, Then the operation and its source and impact are the same objects, updated in place', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick();
    const op = r.mining.operations[0]!;
    const { source, impact } = op;
    r.placeAt(0.4);
    for (let i = 0; i < 30; i++) {
      r.tick();
      expect(r.mining.operations[0]).toBe(op);
      expect(r.mining.operations[0]!.source).toBe(source);
      expect(r.mining.operations[0]!.impact).toBe(impact);
    }
    // …and they follow the ship: the impact is still on the surface, now ~0.4 km away.
    const p = new Vector3(impact.x, impact.y, impact.z);
    expect(Math.abs(p.distanceTo(r.astWorld) - r.ast.radiusKm)).toBeLessThanOrEqual(1e-6);
    expect(p.distanceTo(r.world.flight.worldPosition)).toBeGreaterThan(0.3);
    expect(p.distanceTo(r.world.flight.worldPosition)).toBeLessThan(0.5);
  });

  it('Given the extraction ends, Then operations is empty again', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(10);
    expect(r.mining.operations).toHaveLength(1);
    r.press(MINING_KEYS.mine);
    expect(r.mining.operations).toEqual([]);
  });
});

describe('the bus — one started and one ended per extraction', () => {
  it('Given two extractions, Then mining:started and mining:ended come once each per extraction, in order, with the bites between', () => {
    const r = rig();
    const seen: string[] = [];
    listen<Started>('mining:started', () => seen.push('started'));
    listen<Bite>('mining:bite', () => seen.push('bite'));
    listen<Ended>('mining:ended', () => seen.push('ended'));
    r.press(MINING_KEYS.mine);
    r.tick(250); // two bites
    r.press(MINING_KEYS.mine);
    r.press(MINING_KEYS.mine);
    r.tick(100);
    r.press(MINING_KEYS.mine);
    expect(seen).toEqual(['started', 'bite', 'bite', 'ended', 'started', 'bite', 'ended']);
    expect(r.ended.map((e) => e.minedKg)).toEqual([500, 250]);
  });
});

// ---------------------------------------------------------------------------
// Review fix (plan 5, task 3) — B in the frame an extraction ends by itself.
// The extraction step runs before the key handling, so that B was read as
// "start": a second mining:started, or a second (refusal) log line. Ruling: a B
// press in the frame an extraction ended — for any reason — does nothing. A B
// press in the NEXT frame behaves normally.
// ---------------------------------------------------------------------------

describe('B in the frame an extraction ends by itself', () => {
  type R = ReturnType<typeof rig>;

  /** Press B in this frame: the one frame, with `before` applied first. */
  function pressInThisFrame(r: R, before: (r: R) => void = () => undefined): void {
    before(r);
    r.press(MINING_KEYS.mine);
  }

  function expectNothingMore(r: R, text: string, end: ExtractionEnd, kg: number): void {
    expect(r.logs).toEqual([text]);
    expect(r.started).toHaveLength(1);
    expect(r.ended).toEqual([{ asteroidId: r.ast.id, resource: 'ice', minedKg: kg, end }]);
    expect(r.mining.status('mine').kind).not.toBe('running');
    expect(r.cargo.kg('ice')).toBe(kg);
    expect(r.cargo.totalKg).toBeGreaterThanOrEqual(kg);
  }

  it('Given the last 250 kg of ice (other material left), When B is pressed in frame 100, the frame of the last bite, Then it ends "MINED · 250 KG ICE — ICE DEPLETED", and B starts nothing: one started, no new extraction', () => {
    const r = rig();
    leave(r, 'ice', 250);
    r.press(MINING_KEYS.mine);
    r.tick(99);
    pressInThisFrame(r);
    expectNothingMore(r, 'MINED · 250 KG ICE — ICE DEPLETED', 'resource-depleted', 250);
    expect(r.cargo.snapshot()).toEqual({ ice: 250, metal: 0, silicate: 0, rare: 0 });
    r.tick(600); // and nothing mines on by itself
    expect(r.started).toHaveLength(1);
    expect(r.cargo.totalKg).toBe(250);
    expect(r.logs).toEqual(['MINED · 250 KG ICE — ICE DEPLETED']);
  });

  it('Given 250 kg of room in the hold, When B is pressed in frame 100, the frame the hold fills, Then it ends "MINED · 250 KG ICE — HOLD FULL" and no second "HOLD FULL" line follows', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 250 });
    r.press(MINING_KEYS.mine);
    r.tick(99);
    pressInThisFrame(r);
    expectNothingMore(r, 'MINED · 250 KG ICE — HOLD FULL', 'hold-full', 250);
    expect(r.cargo.freeKg).toBe(0);
  });

  it('Given only 250 kg of ice and nothing else left in the rock, When B is pressed in frame 100, the frame its last bite destroys the rock, Then it ends "MINED · 250 KG ICE — DEPLETED" and no "NO ASTEROID TARGETED" follows', () => {
    const r = rig();
    for (const res of ALL) leave(r, res, res === 'ice' ? 250 : 0);
    r.press(MINING_KEYS.mine);
    r.tick(99);
    pressInThisFrame(r);
    expectNothingMore(r, 'MINED · 250 KG ICE — DEPLETED', 'rock-depleted', 250);
    expect(r.destroyed).toEqual([{ asteroidId: r.ast.id }]);
  });

  it('Given an extraction with one bite, When the ship drifts out of range and B is pressed in that same frame, Then it ends "MINING STOPPED — OUT OF RANGE · 250 KG ICE" and no "OUT OF RANGE" refusal follows', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(119);
    expect(r.cargo.kg('ice')).toBe(250);
    pressInThisFrame(r, (x) => x.placeAt(MINE_RANGE_KM + 0.1));
    expectNothingMore(r, 'MINING STOPPED — OUT OF RANGE · 250 KG ICE', 'range', 250);
  });

  it('Given an extraction with one bite, When the ship goes 0.006 km/s relative to the rock and B is pressed in that same frame, Then it ends "MINING STOPPED — MATCH SPEED · 250 KG ICE" and no "MATCH SPEED" refusal follows', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(119);
    expect(r.cargo.kg('ice')).toBe(250);
    pressInThisFrame(r, (x) => x.world.flight.velocity.add(new Vector3(0, 0.006, 0)));
    expectNothingMore(r, 'MINING STOPPED — MATCH SPEED · 250 KG ICE', 'speed', 250);
  });

  it('Given the ice ran out in frame 100 and B was swallowed, When B is pressed in the next frame, Then it behaves as a normal press: a new extraction starts on the next resource (rare)', () => {
    const r = rig();
    leave(r, 'ice', 250);
    r.press(MINING_KEYS.mine);
    r.tick(99);
    pressInThisFrame(r);
    expect(r.started).toHaveLength(1);
    r.press(MINING_KEYS.mine);
    expect(r.started.map((s) => s.resource)).toEqual(['ice', 'rare']);
    expect(r.mining.status('mine').kind).toBe('running');
    expect(r.logs).toEqual(['MINED · 250 KG ICE — ICE DEPLETED']);
    r.tick(100);
    expect(r.cargo.kg('rare')).toBe(250);
  });

  it('Given the hold filled in frame 100 and B was swallowed, When B is pressed in the next frame, Then it behaves as a normal press: the refusal "HOLD FULL" is logged once, nothing starts', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 250 });
    r.press(MINING_KEYS.mine);
    r.tick(99);
    pressInThisFrame(r);
    expect(r.logs).toEqual(['MINED · 250 KG ICE — HOLD FULL']);
    r.press(MINING_KEYS.mine);
    expect(r.logs).toEqual(['MINED · 250 KG ICE — HOLD FULL', 'HOLD FULL']);
    expect(r.started).toHaveLength(1);
    expect(r.mining.status('mine').kind).not.toBe('running');
  });
});
