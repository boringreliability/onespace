/**
 * v4 sub-plan 2, Task 3 — Targeting learns two more kinds: fields and asteroids.
 *
 * Ids: `field:<systemId>:<k>` and `ast:<systemId>:<k>:<n>` (gen/belt.ts).
 * Targeting resolves them through the Belt module, so range, closing speed,
 * ETA and the HUD bracket work exactly as for bodies and vessels:
 *  - an asteroid's range is to its surface (centre − radius);
 *  - a field's range is to its edge (centre − FIELD_RADIUS_KM), so the cruise
 *    drive drops out ahead of the field rather than inside it.
 *
 * Harness: the real Targeting and Belt modules over a plain universe stub
 * (the module reads `flight`, `shipParent`, `allBodies()`, `paused`) and a HUD
 * stub that records what it is handed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import { FIELD_RADIUS_KM } from '@/gen/belt';
import type { StarSystemSpec } from '@/gen/types';
import { closingSpeed } from '@/game/targets';
import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import type { HudTarget } from '@/ui/Hud';
import { Belt } from './Belt';
import { Targeting, type TargetingOptions } from './Targeting';
import { WorldState } from './worldState';
import { fieldCentre, fieldVelocity, fyssBelt, fyssField, nodeCtx, startSystem } from './testing/beltFixture';

const offs: Array<() => void> = [];
const mods: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  for (const m of mods.splice(0)) m.dispose();
});

const K = 398;

interface FakeBody {
  spec: { id: string; name: string; radius: number; isMoon: boolean; type: string };
  world: Vector3;
  worldVelocity: Vector3;
  planet: null;
}

function rig(opts: { system?: StarSystemSpec | null; ship?: Vector3; shipVel?: Vector3; withBelt?: boolean } = {}) {
  const system = opts.system === undefined ? startSystem() : opts.system;
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  // Star frame: the ship's state vector is its world state.
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: fyssBelt().starMu });
  const ship = opts.ship ?? fieldCentre(fyssField(K), 0);
  fm.teleport(ship, opts.shipVel ?? fieldVelocity(fyssField(K), 0));

  const bodies: FakeBody[] = [
    {
      spec: { id: 'p-dust', name: 'Dust', radius: 2_000, isMoon: false, type: 'rocky' },
      world: ship.clone().add(new Vector3(4e6, 0, 0)),
      worldVelocity: new Vector3(),
      planet: null,
    },
    {
      spec: { id: 'p-ash', name: 'Ash', radius: 3_000, isMoon: false, type: 'rocky' },
      world: ship.clone().add(new Vector3(0, 0, -6e6)),
      worldVelocity: new Vector3(),
      planet: null,
    },
  ];
  const universe = {
    paused: false,
    flight: fm,
    shipParent: null,
    system,
    orbitSeconds: 0,
    allBodies: () => bodies,
  };
  const worldState = new WorldState({ orbitSeconds: () => universe.orbitSeconds, wallMs: () => 0 });
  const belt = new Belt({ universe, worldState });
  const hudLog: Array<HudTarget | null> = [];
  const hud = {
    setTarget: (t: HudTarget | null) => hudLog.push(t ? { ...t } : null),
    setContacts: () => undefined,
  };
  const targeting = new Targeting({
    universe,
    traffic: null,
    hud,
    ...(opts.withBelt === false ? {} : { belt }),
  } as unknown as TargetingOptions);
  mods.push(targeting);

  let tab = false;
  const ctx = nodeCtx({ input: { pressed: (a: string) => a === 'cycleTarget' && tab, down: () => false } });
  targeting.init(ctx);
  const frame = (): void => {
    belt.update(1 / 60, ctx);
    targeting.update(1 / 60, ctx);
  };
  const pressTab = (): string | null => {
    tab = true;
    frame();
    tab = false;
    return targeting.targetId;
  };
  const hudNow = (): HudTarget | null => hudLog[hudLog.length - 1] ?? null;
  return { fm, belt, targeting, frame, pressTab, hudNow, bodies, universe };
}

describe('Targeting — asteroids in the Tab cycle', () => {
  it('Given Tab near a field, Then asteroids are among the cycle candidates (every asteroid of the field is reachable)', () => {
    const r = rig();
    const f = fyssField(K);
    const seen = new Set<string>();
    // Two full cycles of bodies + asteroids (+ the field itself, if offered).
    for (let i = 0; i < 2 * (f.asteroids.length + r.bodies.length + 1); i++) {
      const id = r.pressTab();
      if (id) seen.add(id);
    }
    for (const a of f.asteroids) expect(seen.has(a.id), a.id).toBe(true);
    // The bodies are still there too.
    expect(seen.has('body:Dust')).toBe(true);
    // Nothing from another field.
    for (const id of seen) {
      if (id.startsWith('ast:')) expect(id.startsWith(`ast:${startSystem().id}:${K}:`), id).toBe(true);
    }
  });
});

describe('Targeting — resolving an asteroid target', () => {
  it('Given target ast:…, Then range, closing speed and HUD marker resolve (kind asteroid, range to its surface)', () => {
    const f = fyssField(K);
    const a = f.asteroids[2]!;
    const centre = fieldCentre(f, 0);
    // Park 800 km from the field centre, drifting toward it at 30 m/s relative.
    const ship = centre.clone().add(new Vector3(800, 0, 0));
    const shipVel = fieldVelocity(f, 0).add(new Vector3(-0.03, 0, 0));
    const r = rig({ ship, shipVel });

    bus.emit('target:changed', { id: a.id, name: null });
    r.frame();
    expect(r.targeting.targetId).toBe(a.id);

    const h = r.hudNow();
    expect(h).not.toBeNull();
    expect(h!.id).toBe(a.id);
    expect(h!.kind).toBe('asteroid');
    expect(h!.name.length).toBeGreaterThan(0);

    const astWorld = new Vector3(centre.x + a.offsetKm[0], centre.y + a.offsetKm[1], centre.z + a.offsetKm[2]);
    const rel = astWorld.clone().sub(r.fm.worldPosition);
    expect(h!.distanceKm).toBeCloseTo(rel.length() - a.radiusKm, 6);

    const relVel = fieldVelocity(f, 0).sub(r.fm.velocity);
    expect(h!.closingKmS).toBeCloseTo(closingSpeed(rel, relVel), 9);
    expect(h!.closingKmS).toBeGreaterThan(0.01);
    expect(h!.etaS).not.toBeNull();
    expect(Number.isFinite(h!.x) && Number.isFinite(h!.y)).toBe(true);
  });

  it('Given target field:…, Then the range is to the field edge (centre − FIELD_RADIUS_KM) and kind is field', () => {
    const f = fyssField(K);
    const centre = fieldCentre(f, 0);
    const ship = centre.clone().add(new Vector3(0, 0, 1_000));
    const r = rig({ ship });

    bus.emit('target:changed', { id: f.id, name: null });
    r.frame();
    expect(r.targeting.targetId).toBe(f.id);
    const h = r.hudNow()!;
    expect(h).not.toBeNull();
    expect(h.kind).toBe('field');
    expect(h.distanceKm).toBeCloseTo(1_000 - FIELD_RADIUS_KM, 6);
  });
});

describe('Targeting — unchanged without a belt', () => {
  it('Given a system without a belt, Then Tab cycles bodies only and an ast:… target is dropped', () => {
    const bare = { ...startSystem(), hasAsteroidBelt: false };
    const r = rig({ system: bare });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const id = r.pressTab();
      if (id) seen.add(id);
    }
    expect([...seen].sort()).toEqual(['body:Ash', 'body:Dust']);

    bus.emit('target:changed', { id: fyssField(K).asteroids[0]!.id, name: null });
    r.frame();
    expect(r.targeting.targetId).toBeNull();
    expect(r.hudNow()).toBeNull();
  });

  it('Given no Belt module wired at all, Then Tab cycles bodies only (Targeting as before)', () => {
    const r = rig({ withBelt: false });
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const id = r.pressTab();
      if (id) seen.add(id);
    }
    expect([...seen].sort()).toEqual(['body:Ash', 'body:Dust']);
  });
});
