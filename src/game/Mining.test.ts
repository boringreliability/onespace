/**
 * v4 sub-plan 2, Task 5 — mine (B), refine (U), repair (N). The success
 * criterion's "mine an asteroid and refuel".
 *
 * Contract with the pilot:
 * - B on a targeted asteroid within 0.5 km of its SURFACE, matched to within
 *   0.005 km/s, starts a 4 s (SIM time) mine. It completes through
 *   `applyCargoAction` (one `cargo:action` mine) and `worldState.recordMined`
 *   (once per completed mine — never per tick), and logs "MINED · 2 000 KG ICE".
 * - U refines all the ice the tank can take (0.8 kg fuel per kg ice) in 8 s;
 *   N repairs 0.04 of tank capacity loss for 600 kg metal + 400 kg silicate
 *   in 10 s. Both complete through `applyCargoAction`.
 * - A refusal logs its reason (`REFUSAL_LOG`) and starts nothing.
 * - A mine is aborted cleanly — no yield, no action, "MINING ABORTED" — by
 *   drifting out of range, pause, freeze, cruise, a warp or the beacon.
 *   The gate (`mayMine`) is asked every frame and again at completion (R16).
 * - Time is SIM time (`universe.simulatedSeconds`), so 10× finishes in 0.4 s
 *   wall. Completion lands on the frame the duration is reached (a 1e-6 s
 *   float tolerance: 240 × 1/60 sums to 3.99999999999999).
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
import type { AsteroidSpec } from '@/gen/belt';
import { CARGO_CAPACITY_KG, Cargo, type CargoAction, type CargoResult } from '@/ship/cargo';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
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

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

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
  it('Given a targeted asteroid in range and matched, When B, Then after 4 s sim the hold has +2 000 kg ice, cargo:action mine emitted once, worldState updated, log MINED', () => {
    const r = rig();
    const iceBefore = r.belt.remainingKg(r.ast.id, 'ice');
    r.press(MINING_KEYS.mine);
    // The clock starts on the press frame: 4 s of sim time from the NEXT frame on.
    expect(r.mining.busy).toEqual({ kind: 'mine', leftS: 4 });
    r.tick(239); // 3.983 s
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0); // never per tick
    r.tick(1); // 240 frames: 4 s
    expect(r.mining.busy).toBeNull();
    expect(r.cargo.kg('ice')).toBe(2_000);
    expect(r.cargo.totalKg).toBe(2_000);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.action).toEqual({ kind: 'mine', asteroidId: r.ast.id, resource: 'ice', kg: 2_000 });
    expect(r.actions[0]!.result.ok).toBe(true);
    expect(r.worldState.entries()).toHaveLength(1);
    expect(r.worldState.entries()[0]).toMatchObject({ id: r.ast.id, resource: 'ice', kg: 2_000, by: 'local' });
    expect(r.belt.remainingKg(r.ast.id, 'ice')).toBe(iceBefore - 2_000);
    expect(r.logs).toEqual(['MINED · 2 000 KG ICE']);
    // Nothing more happens on its own.
    r.tick(600);
    expect(r.actions).toHaveLength(1);
    expect(r.worldState.entries()).toHaveLength(1);
  });

  it('Given only 500 kg of ice left in the rock, When B, Then the hold gets the remainder (500 kg) and the log says so', () => {
    const r = rig();
    r.worldState.recordMined(r.ast.id, 'ice', r.ast.composition.ice - 500, 'local');
    r.press(MINING_KEYS.mine);
    r.tick(240);
    expect(r.cargo.kg('ice')).toBe(500);
    expect(r.belt.remainingKg(r.ast.id, 'ice')).toBe(0);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.action).toMatchObject({ kind: 'mine', resource: 'ice', kg: 500 });
    expect(r.worldState.entries()).toHaveLength(2); // the setup's, and exactly one from the mine
    expect(r.logs).toEqual(['MINED · 500 KG ICE']);
  });

  it('Given no ice left but metal, When B, Then the mine takes the next resource in order (no NaN)', () => {
    const r = rig();
    r.worldState.recordMined(r.ast.id, 'ice', r.ast.composition.ice, 'local');
    r.worldState.recordMined(r.ast.id, 'rare', r.ast.composition.rare, 'local');
    r.press(MINING_KEYS.mine);
    r.tick(240);
    const want = Math.min(2_000, r.ast.composition.metal);
    expect(r.cargo.kg('metal')).toBe(want);
    expect(Number.isFinite(r.cargo.totalKg)).toBe(true);
    expect(r.actions[0]!.action).toMatchObject({ kind: 'mine', resource: 'metal' });
  });

  it('Given a hold with only 500 kg free, When B completes, Then only the free space is taken and the log says MINED then HOLD FULL', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 500 });
    r.press(MINING_KEYS.mine);
    r.tick(240);
    expect(r.cargo.kg('ice')).toBe(500);
    expect(r.cargo.totalKg).toBe(CARGO_CAPACITY_KG);
    expect(r.cargo.freeKg).toBe(0);
    // The rock gives up only what the hold took.
    expect(r.worldState.entries()).toHaveLength(1);
    expect(r.worldState.entries()[0]!.kg).toBe(500);
    expect(r.logs).toEqual(['MINED · 500 KG ICE', 'HOLD FULL']);
  });

  it('Given the ship matched through its parent frame (velocity relative to shipParent), Then the relative speed is taken in the world frame', () => {
    const r = rig();
    const parentVel = new Vector3(3, -7, 11);
    r.world.shipParent = { worldVelocity: parentVel };
    r.world.flight.velocity.copy(r.astVel).sub(parentVel);
    r.press(MINING_KEYS.mine);
    expect(r.mining.busy?.kind).toBe('mine');
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

  it('Given a depleted rock, When B, Then "DEPLETED", nothing is mined and nothing is NaN', () => {
    const r = rig();
    for (const res of ['ice', 'metal', 'silicate', 'rare'] as const) {
      r.worldState.recordMined(r.ast.id, res, r.ast.composition[res], 'local');
    }
    const before = r.worldState.entries().length;
    r.press(MINING_KEYS.mine);
    r.tick(300);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['DEPLETED']);
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

  it('Given a mine underway, When B, U or N is pressed, Then "BUSY" and the mine carries on to completion', () => {
    const r = rig();
    r.cargo.restore({ ice: 1_000 });
    r.press(MINING_KEYS.mine);
    r.press(MINING_KEYS.mine);
    r.press(MINING_KEYS.refine);
    r.press(MINING_KEYS.repair);
    expect(r.logs).toEqual(['BUSY', 'BUSY', 'BUSY']);
    expect(r.mining.busy?.kind).toBe('mine');
    r.tick(237); // 3 presses + 237 = 240 frames since B
    expect(r.mining.busy).toBeNull();
    expect(r.cargo.kg('ice')).toBe(3_000);
    expect(r.actions).toHaveLength(1);
  });
});

describe('a mine aborts cleanly — no yield, no action, "MINING ABORTED"', () => {
  const blockers: Array<[string, (r: ReturnType<typeof rig>) => void, (r: ReturnType<typeof rig>) => void]> = [
    ['the ship drifts out of range', (r) => r.placeAt(MINE_RANGE_KM + 0.1), (r) => r.placeAt(0.2)],
    ['pause', (r) => (r.world.paused = true), (r) => (r.world.paused = false)],
    ['freeze (recovery cut, overlay)', (r) => (r.world.frozen = true), (r) => (r.world.frozen = false)],
    ['cruise', (r) => (r.cruise.busy = true), (r) => (r.cruise.busy = false)],
    ['warp', (r) => (r.warp.phase = 'charging'), (r) => (r.warp.phase = 'idle')],
    ['the emergency beacon', () => bus.emit('ship:recovered', { cause: 'beacon' }), () => undefined],
  ];

  for (const [why, block, clear] of blockers) {
    it(`Given a mine 2 s in, When ${why}, Then it aborts: no yield, no cargo:action, no worldState entry, log MINING ABORTED`, () => {
      const r = rig();
      r.press(MINING_KEYS.mine);
      r.tick(119);
      expect(r.mining.busy?.kind).toBe('mine');
      block(r);
      r.tick();
      expect(r.mining.busy).toBeNull();
      expect(r.logs).toEqual(['MINING ABORTED']);
      // And it stays aborted: clearing the blocker does not resume it.
      clear(r);
      r.tick(600);
      expect(r.mining.busy).toBeNull();
      expect(r.cargo.totalKg).toBe(0);
      expect(r.actions).toEqual([]);
      expect(r.worldState.entries()).toHaveLength(0);
      expect(r.logs).toEqual(['MINING ABORTED']);
    });
  }

  it('Given the gate fails on the very frame the 4 s would complete, Then it aborts instead (re-checked at completion, R16)', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(239);
    r.placeAt(MINE_RANGE_KM + 0.1);
    r.tick(1);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
    expect(r.logs).toEqual(['MINING ABORTED']);
  });
});

describe('sim time', () => {
  it('Given 10× time compression, Then the action completes after 4 s sim (0.4 s wall, 24 frames)', () => {
    const r = rig();
    r.setRate(10);
    r.press(MINING_KEYS.mine);
    r.tick(23); // 3.83 s sim
    expect(r.cargo.totalKg).toBe(0);
    expect(r.mining.busy?.kind).toBe('mine');
    r.tick(1); // 24 frames: 4 s sim, 0.4 s wall
    expect(r.mining.busy).toBeNull();
    expect(r.cargo.kg('ice')).toBe(2_000);
    expect(r.actions).toHaveLength(1);
    expect(r.worldState.entries()).toHaveLength(1);
  });

  it('Given frames that advanced no sim time, Then the action does not progress', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    const left = r.mining.busy!.leftS;
    r.setRate(0);
    r.tick(600);
    expect(r.mining.busy).toEqual({ kind: 'mine', leftS: left });
    expect(r.cargo.totalKg).toBe(0);
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

  it('Given a rock with 0.3 kg left of everything, Then B is refused DEPLETED (never "MINED · 0 KG")', () => {
    const r = rig();
    for (const res of ['ice', 'metal', 'silicate', 'rare'] as const) {
      r.worldState.recordMined(r.ast.id, res, r.ast.composition[res] - 0.3, 'local');
    }
    const before = r.worldState.entries().length;
    r.press(MINING_KEYS.mine);
    r.tick(300);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['DEPLETED']);
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

  it('Given a mine that leaves 0.3 kg free, When it completes, Then the log says MINED then HOLD FULL', () => {
    const r = rig();
    r.cargo.restore({ silicate: CARGO_CAPACITY_KG - 2_000.3 });
    r.press(MINING_KEYS.mine);
    r.tick(240);
    expect(r.cargo.freeKg).toBeCloseTo(0.3, 6);
    expect(r.logs).toEqual(['MINED · 2 000 KG ICE', 'HOLD FULL']);
  });

  it('Given Mining.ts, Then it has no FULL_EPS_KG of its own (one threshold, from miningRules)', () => {
    const src = readFileSync(fileURLToPath(new URL('./Mining.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('FULL_EPS_KG');
  });
});

describe('more clean aborts (R18)', () => {
  it('Given a mine 2 s in, When the game leaves flight (onModeChange), Then it aborts with one MINING ABORTED and nothing applied', () => {
    const r = rig();
    r.press(MINING_KEYS.mine);
    r.tick(119);
    r.mining.onModeChange?.('flight', 'map');
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['MINING ABORTED']);
    // Back in flight: it does not resume, and nothing is logged twice.
    r.mining.onModeChange?.('map', 'flight');
    r.tick(600);
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['MINING ABORTED']);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
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

  it('Given a mine 2 s in, When the target switches to another asteroid that is itself in range and matched, Then the mine aborts (it belongs to the rock it started on)', () => {
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
    expect(r.mining.busy).toBeNull();
    expect(r.logs).toEqual(['MINING ABORTED']);
    r.tick(600);
    expect(r.cargo.totalKg).toBe(0);
    expect(r.actions).toEqual([]);
    expect(r.worldState.entries()).toHaveLength(0);
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
