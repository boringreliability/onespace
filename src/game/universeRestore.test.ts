/**
 * v4 sub-plan 3 (local save), Task 2 — the game can be put back.
 *
 * A save is applied to a REAL Universe (init → generate, place, emit; its
 * renderer-bound steps stubbed as in rocksClock.test.ts — the slice loop,
 * orbits, parenting and the flight model run for real).
 *
 * Four promises:
 *  - in orbit: the ship comes back exactly where it was, on the same clock,
 *    around the same body — and a CONTINUE boots straight into the saved
 *    system, so the start system never flashes past (no system:entered for it);
 *  - landed: the ship comes back ON the ground, silently — no touchdown, no
 *    landing, no new landing visit in the log — and stays on the same patch
 *    of surface while the world turns under it;
 *  - another system: a neighbour of Fyss is re-found from its position;
 *  - not found: an unknown system id changes nothing and says so.
 *
 * "Same surface point" is measured in the body's own rotating frame: the
 * parent-relative position turned by the inverse of the body's spin. That
 * coordinate is fixed to the ground, so it is the same before the save and
 * 30 s after the restore exactly when the ship has not slid.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { StarSystemStub } from '@/gen/galaxy';
import { ShipLog } from './Log';
import { Universe, type UniverseRestore } from './Universe';
import { nodeCtx } from './testing/beltFixture';

/** Universe steps that need a GPU; everything else in update() runs for real. */
const RENDER_STEPS = ['streamRenderers', 'updateBodies', 'updateStar', 'publishMotionReference', 'refreshAtmosphere'];

const START = 'Fyss';
/** Fyss's arrival world (spec.name; the HUD calls it "Remit 31"). */
const LANDING_WORLD = 'Remit 31 / Fyss';

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
});
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.unstubAllGlobals();
});

function stubRender(u: Universe): void {
  const raw = u as unknown as Record<string, unknown>;
  for (const k of RENDER_STEPS) raw[k] = () => undefined;
}

/** A real Universe after init; `restore` boots it straight into a save. */
function boot(restore?: UniverseRestore): { u: Universe; ctx: EngineContext } {
  const ctx = nodeCtx();
  const u = new Universe(restore ? { restore } : {});
  u.init(ctx);
  stubRender(u);
  return { u, ctx };
}

function frames(u: Universe, ctx: EngineContext, seconds: number): void {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) u.update(1 / 60, ctx);
}

/** Everything a save holds about the player, read off a live Universe. */
function capture(u: Universe): UniverseRestore {
  const s = u.system;
  const fm = u.flight;
  return {
    system: { id: s.id, seed: s.seed, name: s.name, positionLy: [s.position[0], s.position[1], s.position[2]] },
    orbitSeconds: u.orbitSeconds,
    parentId: u.shipParent ? u.shipParent.spec.id : null,
    flight: {
      position: [fm.position.x, fm.position.y, fm.position.z],
      velocity: [fm.velocity.x, fm.velocity.y, fm.velocity.z],
      orientation: [fm.orientation.x, fm.orientation.y, fm.orientation.z, fm.orientation.w],
      grounded: fm.grounded,
    },
    flightAssist: fm.flightAssist,
  };
}

function systemsEntered(): string[] {
  const ids: string[] = [];
  offs.push(bus.on('system:entered', ({ system }) => ids.push(system.id)));
  return ids;
}

function expectSameState(u: Universe, r: UniverseRestore): void {
  const fm = u.flight;
  const [px, py, pz] = r.flight.position;
  const [vx, vy, vz] = r.flight.velocity;
  const [qx, qy, qz, qw] = r.flight.orientation;
  expect(u.system.id).toBe(r.system.id);
  expect(Math.abs(u.orbitSeconds - r.orbitSeconds)).toBeLessThan(1e-9);
  expect(u.shipParent ? u.shipParent.spec.id : null).toBe(r.parentId);
  expect(fm.position.distanceTo(new Vector3(px, py, pz))).toBeLessThan(1e-9);
  expect(fm.velocity.distanceTo(new Vector3(vx, vy, vz))).toBeLessThan(1e-9);
  expect(fm.orientation.angleTo(new Quaternion(qx, qy, qz, qw))).toBeLessThan(1e-9);
  expect(fm.angularVelocity.length()).toBe(0);
  expect(fm.grounded).toBe(r.flight.grounded);
  expect(fm.flightAssist).toBe(r.flightAssist);
}

/** A save in Fyss, in orbit about its arrival world, a little way into the game. */
function fyssOrbitSave(): { save: UniverseRestore; bodyWorld: Vector3 } {
  const { u, ctx } = boot();
  expect(u.system.name).toBe(START);
  expect(u.shipParent).not.toBeNull();
  frames(u, ctx, 5);
  u.flight.flightAssist = !u.flight.flightAssist;
  const save = capture(u);
  expect(save.orbitSeconds).toBeGreaterThan(0);
  return { save, bodyWorld: u.shipParent!.world.clone() };
}

/** A neighbour of Fyss, as the jump map sees it. */
function neighbourOfFyss(): StarSystemStub {
  const { u } = boot();
  const n = u.neighbours(60, 16).find((s) => s.id !== u.system.id);
  expect(n).toBeDefined();
  return n!;
}

// ---------------------------------------------------------------------------

describe('Universe restore — in orbit', () => {
  it('Given a save in Fyss at a planet, When restored, Then position/velocity/orientation, orbitSeconds and parent match to 1e-9 and no system:entered for the start system was emitted first', () => {
    const { save, bodyWorld } = fyssOrbitSave();
    const entered = systemsEntered();

    const { u } = boot(save);

    expect(entered).toEqual([save.system.id]);
    expectSameState(u, save);
    // The bodies are where the clock says: updateOrbits ran at the restored time.
    expect(u.shipParent!.world.distanceTo(bodyWorld)).toBeLessThan(1e-9);
  });

  it('Given a running Universe, When restoreState(save) is called, Then it returns true and the state matches to 1e-9', () => {
    const { save, bodyWorld } = fyssOrbitSave();
    const { u, ctx } = boot();
    frames(u, ctx, 2);

    expect(u.restoreState(save)).toBe(true);

    expectSameState(u, save);
    expect(u.shipParent!.world.distanceTo(bodyWorld)).toBeLessThan(1e-9);
  });

  it('Given setOrbitSeconds(t), Then the clock reads t and every body is placed for t (as a Universe that ran to t)', () => {
    const { save, bodyWorld } = fyssOrbitSave();
    const { u } = boot();
    u.setOrbitSeconds(save.orbitSeconds);
    expect(u.orbitSeconds).toBe(save.orbitSeconds);
    expect(u.bodyById(save.parentId!)!.world.distanceTo(bodyWorld)).toBeLessThan(1e-9);
  });

  it('Given restoreParent(id), Then the ship is parented to that body (its frame, by reference), and restoreParent(null) to the star', () => {
    const { u } = boot();
    const other = u.allBodies().find((b) => b !== u.shipParent)!;
    u.restoreParent(other.spec.id);
    expect(u.shipParent).toBe(other);
    expect(u.flight.worldPosition.distanceTo(u.flight.position.clone().add(other.world))).toBeLessThan(1e-9);
    u.restoreParent(null);
    expect(u.shipParent).toBeNull();
  });
});

describe('Universe restore — landed', () => {
  /** A surface the node rig can stand on: the renderer the sampler reads, as a sphere. */
  function sphereGround(u: Universe, id: string): void {
    const body = u.bodyById(id)!;
    (body as unknown as { planet: unknown }).planet = { surfaceRadius: () => body.spec.radius };
  }

  /** The ship's position in the body's own rotating (ground-fixed) frame. */
  function surfacePoint(u: Universe): Vector3 {
    const body = u.shipParent!;
    return u.flight.position.clone().applyQuaternion(body.spin.clone().invert());
  }

  it(`Given a ship landed on Remit 31, When restored and stepped 30 s, Then it is still grounded at the same surface point (± 1 m), no planet:landed/ship:touchdown fired, and the log has no new landing visit`, () => {
    const log = new ShipLog();
    log.init();
    offs.push(() => log.dispose());

    // --- land for real in a first Universe ---------------------------------
    const a = boot();
    const remit = a.u.allBodies().find((b) => b.spec.name === LANDING_WORLD)!;
    expect(remit).toBeDefined();
    // Setup only, through today's private route (as rocksClock.test.ts does).
    (a.u as unknown as { setShipParent(b: unknown): void }).setShipParent(remit);
    sphereGround(a.u, remit.spec.id);
    const up = new Vector3(0.3, 0.8, 0.5).normalize();
    a.u.flight.teleport(up.clone().multiplyScalar(remit.spec.radius + 0.002), new Vector3(), new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up));
    for (let i = 0; i < 1200 && !a.u.flight.grounded; i++) a.u.update(1 / 60, a.ctx);
    expect(a.u.flight.grounded).toBe(true);
    frames(a.u, a.ctx, 3);
    expect(a.u.flight.grounded).toBe(true);
    const landKey = `land:${remit.spec.id}`;
    const visits = (): number => log.all().find((e) => e.key === landKey)?.visits ?? 0;
    expect(visits()).toBe(1);

    const save = capture(a.u);
    expect(save.flight.grounded).toBe(true);
    const pointBefore = surfacePoint(a.u);

    // --- restore into a fresh Universe, the way CONTINUE does ---------------
    const fired: string[] = [];
    offs.push(bus.on('ship:touchdown', () => fired.push('ship:touchdown')));
    offs.push(bus.on('planet:landed', () => fired.push('planet:landed')));

    const b = boot(save);
    expect(b.u.flight.grounded).toBe(true);
    expect(b.u.shipParent!.spec.id).toBe(remit.spec.id);
    // The terrain streams in after the restore (in the game, streamRenderers).
    sphereGround(b.u, remit.spec.id);
    frames(b.u, b.ctx, 30);

    expect(fired).toEqual([]);
    expect(b.u.flight.grounded).toBe(true);
    expect(surfacePoint(b.u).distanceTo(pointBefore)).toBeLessThan(1e-3); // km: 1 m
    expect(visits()).toBe(1);
    expect(log.byKind('landing')).toHaveLength(1);
  });

  it('Given a restored landed ship and NO terrain for the first 2 s (renderer not streamed in yet), Then every frame it stays grounded on the same surface point (± 1 m) without falling, and when the terrain arrives no touchdown/landing fires', () => {
    // --- land for real in a first Universe (as above) -----------------------
    const a = boot();
    const remit = a.u.allBodies().find((b) => b.spec.name === LANDING_WORLD)!;
    expect(remit).toBeDefined();
    (a.u as unknown as { setShipParent(b: unknown): void }).setShipParent(remit);
    sphereGround(a.u, remit.spec.id);
    const up = new Vector3(-0.6, 0.2, 0.7).normalize();
    a.u.flight.teleport(up.clone().multiplyScalar(remit.spec.radius + 0.002), new Vector3(), new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up));
    for (let i = 0; i < 1200 && !a.u.flight.grounded; i++) a.u.update(1 / 60, a.ctx);
    frames(a.u, a.ctx, 3);
    expect(a.u.flight.grounded).toBe(true);
    const save = capture(a.u);
    const pointBefore = surfacePoint(a.u);

    const fired: string[] = [];
    offs.push(bus.on('ship:touchdown', () => fired.push('ship:touchdown')));
    offs.push(bus.on('planet:landed', () => fired.push('planet:landed')));

    // --- restore with no terrain: the sampler has nothing to read -----------
    const b = boot(save);
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      b.u.update(1 / 60, b.ctx);
      expect(b.u.flight.grounded).toBe(true);
      worst = Math.max(worst, surfacePoint(b.u).distanceTo(pointBefore));
    }
    expect(worst).toBeLessThan(1e-3); // km: 1 m — no fall, no drift
    expect(b.u.flight.position.length()).toBeGreaterThan(remit.spec.radius - 1e-3);

    // --- the terrain streams in ---------------------------------------------
    sphereGround(b.u, remit.spec.id);
    frames(b.u, b.ctx, 5);
    expect(fired).toEqual([]);
    expect(b.u.flight.grounded).toBe(true);
    expect(surfacePoint(b.u).distanceTo(pointBefore)).toBeLessThan(1e-3);
  });
});

describe('Universe restore — saved system missing at boot', () => {
  it('Given the restore option names a system that can\'t be found, When init runs, Then it falls back to the normal start system (Fyss), emits system:entered for it, and exposes a restore failure flag (universe.restoreFailed === true) for boot to report', () => {
    const { save } = fyssOrbitSave();
    const fyssId = save.system.id;
    const missing: UniverseRestore = { ...save, system: { ...save.system, id: 'sys-does-not-exist' } };
    const entered = systemsEntered();

    const { u } = boot(missing);

    expect(u.restoreFailed).toBe(true);
    expect(u.system.id).toBe(fyssId);
    expect(u.system.name).toBe(START);
    expect(entered).toEqual([fyssId]);
    // A new start: the opening clock, not the save's.
    expect(u.orbitSeconds).toBe(0);
  });

  it('Given the restore option names a system that IS found, Then restoreFailed is false; and a plain new game is false too', () => {
    const { save } = fyssOrbitSave();
    expect(boot(save).u.restoreFailed).toBe(false);
    expect(boot().u.restoreFailed).toBe(false);
  });
});

describe('Universe restore — another system', () => {
  it('Given a save in another system (a neighbour of Fyss), Then restore enters that system (not Fyss)', () => {
    const n = neighbourOfFyss();
    const save: UniverseRestore = {
      system: { id: n.id, seed: n.seed, name: n.name, positionLy: [n.position[0], n.position[1], n.position[2]] },
      orbitSeconds: 1234,
      parentId: null,
      flight: { position: [0, 0, 9e8], velocity: [1, 2, 3], orientation: [0, 0, 0, 1], grounded: false },
      flightAssist: true,
    };
    const entered = systemsEntered();

    const { u } = boot(save);

    expect(entered).toEqual([n.id]);
    expect(u.system.id).toBe(n.id);
    expect(u.system.name).not.toBe(START);
    expectSameState(u, save);
  });

  it('Given a running Universe in Fyss, When restoreState(neighbour save) is called, Then it leaves Fyss and enters the neighbour', () => {
    const n = neighbourOfFyss();
    const { u } = boot();
    const entered = systemsEntered();
    const ok = u.restoreState({
      system: { id: n.id, seed: n.seed, name: n.name, positionLy: [n.position[0], n.position[1], n.position[2]] },
      orbitSeconds: 50,
      parentId: null,
      flight: { position: [0, 0, 9e8], velocity: [0, 0, 0], orientation: [0, 0, 0, 1], grounded: false },
      flightAssist: false,
    });
    expect(ok).toBe(true);
    expect(entered).toEqual([n.id]);
    expect(u.system.id).toBe(n.id);
  });
});

describe('Universe restore — system not found', () => {
  function unknownSave(): UniverseRestore {
    const { save } = fyssOrbitSave();
    return { ...save, system: { ...save.system, id: 'sys-does-not-exist' } };
  }

  it('Given an unknown system id, Then restore returns false and nothing changes', () => {
    const save = unknownSave();
    const { u, ctx } = boot();
    frames(u, ctx, 1);
    const before = capture(u);
    const system = u.system;
    const parent = u.shipParent;
    const fired: string[] = [];
    offs.push(bus.on('system:entered', () => fired.push('system:entered')));

    expect(u.restoreState(save)).toBe(false);

    expect(fired).toEqual([]);
    expect(u.system).toBe(system);
    expect(u.shipParent).toBe(parent);
    expect(capture(u)).toEqual(before);
  });

  it('Given an unknown parent id in a known system, Then restore returns false and nothing changes', () => {
    const { save } = fyssOrbitSave();
    const { u } = boot();
    const before = capture(u);
    expect(u.restoreState({ ...save, parentId: 'body-does-not-exist' })).toBe(false);
    expect(capture(u)).toEqual(before);
  });
});
