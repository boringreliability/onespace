/**
 * The belt as the game sees it, for node tests (v4 sub-plan 2, Task 3).
 *
 * The start system comes from a REAL `Universe.init` (stubbed renderer and
 * scene: init only generates and places, it never draws), so these tests run
 * against the system a new game actually opens in — Fyss — not a copy of the
 * selection rule.
 *
 * `beltRig()` gives a Belt over a plain world stub: the Belt reads only the
 * system, the orbit clock and the ship's world position, so a test can put
 * the ship and the clock wherever it needs them.
 */

import { PerspectiveCamera, Scene, Vector3 } from 'three';

import type { EngineContext } from '@/core/Engine';
import { FloatingOrigin } from '@/core/FloatingOrigin';
import { beltFor, fieldOrbits, fieldSpec, type BeltSpec, type FieldSpec } from '@/gen/belt';
import { orbitalPosition, orbitalVelocity } from '@/gen/orbit';
import type { StarSystemSpec } from '@/gen/types';
import { Belt } from '@/game/Belt';
import { Universe } from '@/game/Universe';
import { WorldState } from '@/game/worldState';

/** A context good enough for `Universe.init` and for modules that only project. */
export function nodeCtx(over: Partial<Record<keyof EngineContext, unknown>> = {}): EngineContext {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.001, 1e9);
  return {
    renderer: { compileAsync: () => Promise.resolve(), getPixelRatio: () => 1 },
    scene: new Scene(),
    camera,
    origin: new FloatingOrigin(),
    input: { pressed: () => false, down: () => false },
    quality: {},
    elapsed: 0,
    frame: 0,
    width: 1600,
    height: 900,
    ...over,
  } as unknown as EngineContext;
}

let started: Universe | null = null;

/** A real Universe after `init` — the new game's opening state. Built once. */
export function startUniverse(): Universe {
  if (!started) {
    started = new Universe();
    started.init(nodeCtx());
  }
  return started;
}

export function startSystem(): StarSystemSpec {
  return startUniverse().system;
}

export interface BeltWorldStub {
  system: StarSystemSpec | null;
  orbitSeconds: number;
  flight: { worldPosition: Vector3 };
}

export function beltRig(system: StarSystemSpec | null = startSystem(), wallMs = 1_700_000_000_000) {
  const world: BeltWorldStub = { system, orbitSeconds: 0, flight: { worldPosition: new Vector3() } };
  const clock = { wall: wallMs };
  const worldState = new WorldState({ orbitSeconds: () => world.orbitSeconds, wallMs: () => clock.wall });
  const belt = new Belt({ universe: world, worldState });
  const ctx = nodeCtx();
  const frame = (): void => belt.update(1 / 60, ctx);
  return { world, clock, worldState, belt, ctx, frame };
}

/** Fyss's belt and field k, built independently of the Belt module. */
export function fyssBelt(): BeltSpec {
  const sys = startSystem();
  const b = beltFor(sys);
  if (!b) throw new Error(`start system ${sys.name} has no belt`);
  return b;
}

export function fyssField(k: number): FieldSpec {
  return fieldSpec(fyssBelt(), startSystem().seed, k);
}

export function fyssOrbits() {
  return fieldOrbits(fyssBelt(), startSystem().seed);
}

export function fieldCentre(f: FieldSpec, t: number): Vector3 {
  const p = orbitalPosition(f.orbit, t);
  return new Vector3(p.x, p.y, p.z);
}

export function fieldVelocity(f: FieldSpec, t: number): Vector3 {
  const v = orbitalVelocity(f.orbit, t, fyssBelt().starMu);
  return new Vector3(v.x, v.y, v.z);
}
