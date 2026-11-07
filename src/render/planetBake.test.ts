/**
 * PlanetRenderer's baked state against the things that can take it away
 * (review-p3). The GPU half of the bake is verified on a real GPU by the
 * review scripts; what is pinned here is the CPU bookkeeping around it, with a
 * renderer stub that only records what would have been drawn.
 *
 *   1. The flight model must land on the surface that is DRAWN. On an ocean
 *      world that is the sea, not the sea floor: the surface pass holds the
 *      ground at sea level wherever it lies below it.
 *   2. A lost WebGL context takes every baked tile and clipmap level with it.
 *      After the restore, nothing may still claim to be baked.
 */

import { describe, expect, it } from 'vitest';
import { Color, PerspectiveCamera, Vector3, type WebGLRenderer } from 'three';

import type { EngineContext } from '@/core/Engine';
import { config } from '@/core/Config';
import { generateGalaxy, sampleSystemsNear } from '@/gen/galaxy';
import { generateSystem } from '@/gen/system';
import type { PlanetSpec } from '@/gen/types';
import { PlanetRenderer } from './Planet';
import { MutableViewState } from './ViewState';

const GALAXY = generateGalaxy(0x51a1);
const STUBS = sampleSystemsNear(GALAXY, [GALAXY.radiusLy * 0.3, 0, 0], 300, 60);
const WORLDS: PlanetSpec[] = STUBS.slice(0, 25)
  .map((s) => generateSystem(GALAXY, s))
  .flatMap((s) => s.planets)
  .flatMap((p) => [p, ...p.moons]);

function oceanWorld(): PlanetSpec {
  const w = WORLDS.find((p) => p.ocean && !p.bands);
  if (!w) throw new Error('fixture: no ocean world in the sample');
  return w;
}

function dryWorld(): PlanetSpec {
  const w = WORLDS.find((p) => !p.ocean && !p.bands);
  if (!w) throw new Error('fixture: no dry world in the sample');
  return w;
}

/** Directions on a Fibonacci sphere: deterministic and evenly spread. */
function directions(n: number): Vector3[] {
  const out: Vector3[] = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push(new Vector3(Math.cos(g * i) * r, y, Math.sin(g * i) * r));
  }
  return out;
}

/** Records bakes instead of drawing them. */
function stubRenderer(): { renderer: WebGLRenderer; renders: () => number } {
  let target: unknown = null;
  let renders = 0;
  const r = {
    autoClear: true,
    extensions: { has: () => true },
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => {
      target = t;
    },
    render: () => {
      renders++;
    },
  };
  return { renderer: r as unknown as WebGLRenderer, renders: () => renders };
}

function frame(planet: PlanetRenderer, renderer: WebGLRenderer, altitudeKm: number): void {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.01, 1e9);
  const R = planet.spec.radius;
  const camLocal = new Vector3(0, R + altitudeKm, 0);
  camera.position.copy(camLocal);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const view = new MutableViewState();
  view.set(camLocal, new Vector3(1, 0, 0), new Color(1, 1, 1), 0, Math.PI / 3, 900);
  const ctx = { renderer, camera } as unknown as EngineContext;
  planet.update(1 / 60, ctx, view);
}

/** Read-only view of the private bake state this suite asserts on. */
interface BakeInternals {
  nodePool: Array<{ inUse: boolean; built: boolean; slot: number }>;
  slots: { free: number; size: number };
  uniforms: { uClipH: { value: number[] } };
  clipCentre: Array<unknown>;
}
const internals = (p: PlanetRenderer): BakeInternals => p as unknown as BakeInternals;

describe('surfaceRadius — the ship lands on the drawn surface (review-p3 #1)', () => {
  it('Given an ocean world, When sampled anywhere, Then the surface is never below sea level', () => {
    const planet = new PlanetRenderer(oceanWorld(), config.quality);
    let below = 0;
    for (const d of directions(400)) {
      const h = planet.sampleHeight(d);
      const s = planet.surfaceRadius(d);
      if (h < 0) below++;
      // Drawn: radius + max(h, 0) — exactly the vertex shader's hs.
      expect(s).toBeCloseTo(planet.spec.radius + Math.max(h, 0), 9);
    }
    // The fixture must actually exercise the sea.
    expect(below).toBeGreaterThan(0);
    planet.dispose();
  });

  it('Given a world without an ocean, When sampled, Then the surface follows the ground into its basins', () => {
    const planet = new PlanetRenderer(dryWorld(), config.quality);
    for (const d of directions(100)) {
      expect(planet.surfaceRadius(d)).toBeCloseTo(planet.spec.radius + planet.sampleHeight(d), 9);
    }
    planet.dispose();
  });
});

describe('contextRestored — a lost context takes the bakes with it (review-p3 #2)', () => {
  it('Given a planet with baked patches and shadow levels, When the context is restored, Then nothing claims to be baked and every tile is free', () => {
    const planet = new PlanetRenderer(dryWorld(), config.quality);
    const { renderer } = stubRenderer();
    for (let i = 0; i < 8; i++) frame(planet, renderer, 2);
    const s = internals(planet);
    expect(s.nodePool.some((p) => p.inUse && p.built)).toBe(true);
    expect(s.uniforms.uClipH.value.some((h) => h > 0)).toBe(true);

    planet.contextRestored();

    expect(s.nodePool.some((p) => p.built)).toBe(false);
    expect(s.slots.free).toBe(s.slots.size);
    expect(s.uniforms.uClipH.value.every((h) => h === 0)).toBe(true);
    expect(s.clipCentre.every((c) => c === null)).toBe(true);
    planet.dispose();
  });

  it('Given a restored context, When the next frame runs, Then the six roots are re-baked before anything is drawn', () => {
    const planet = new PlanetRenderer(dryWorld(), config.quality);
    const stub = stubRenderer();
    for (let i = 0; i < 4; i++) frame(planet, stub.renderer, 20000);
    planet.contextRestored();
    const before = stub.renders();
    frame(planet, stub.renderer, 20000);
    expect(stub.renders() - before).toBeGreaterThanOrEqual(6);
    const s = internals(planet);
    expect(s.nodePool.filter((p) => p.inUse && p.built).length).toBeGreaterThanOrEqual(6);
    planet.dispose();
  });
});

describe('shadow clipmap budget (review-p3 #3)', () => {
  it('Given a camera at the surface, When one frame runs, Then at most one clipmap level is baked', () => {
    const planet = new PlanetRenderer(dryWorld(), config.quality);
    const { renderer } = stubRenderer();
    frame(planet, renderer, 2);
    const baked = internals(planet).uniforms.uClipH.value.filter((h) => h > 0).length;
    expect(baked).toBe(1);
    planet.dispose();
  });

  it('Given a camera that stays put, When four frames run, Then every level is baked', () => {
    const planet = new PlanetRenderer(dryWorld(), config.quality);
    const { renderer } = stubRenderer();
    for (let i = 0; i < 4; i++) frame(planet, renderer, 2);
    expect(internals(planet).uniforms.uClipH.value.every((h) => h > 0)).toBe(true);
    planet.dispose();
  });
});
