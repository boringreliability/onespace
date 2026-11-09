/**
 * v4 sub-plan 2, Task 4 — the asteroids can be seen: the renderer (CPU part).
 *
 * `Asteroids` asks the Belt for the asteroids within ASTEROID_DRAW_KM of the
 * ship, keeps the MAX_ASTEROID_INSTANCES nearest, and writes one instance
 * matrix each into one of ASTEROID_VARIANTS shared InstancedMeshes (variant =
 * seed % 8, scale = radius, a slow spin from the seed). Positions are uploaded
 * in RENDER space — world (float64, star frame) through the floating origin —
 * so a rebase must move every instance in the same frame.
 *
 * The belt here is a stub with the Belt's own signatures (asteroidsNear,
 * asteroidWorld, asteroidSpec): a real field holds at most 30 asteroids and
 * the memo five fields, so "600 in range" can only be staged. three.js
 * objects (InstancedMesh, matrices, ShaderMaterial) need no WebGL in node.
 *
 * Contract asserted here:
 *   new Asteroids({ belt, universe }) — universe: { system, flight.worldPosition }
 *   .meshes: readonly InstancedMesh[] (one per variant; .count = active instances)
 *   init(ctx), update(dt, ctx)
 */

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';

import type { AsteroidSpec, Resource } from '@/gen/belt';
import { AU } from '@/gen/types';
import { nodeCtx, startSystem } from '@/game/testing/beltFixture';

import { ASTEROID_DRAW_KM, ASTEROID_VARIANTS, Asteroids, MAX_ASTEROID_INSTANCES } from './Asteroids';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const COMPOSITION: Record<Resource, number> = { ice: 1e6, metal: 1e5, silicate: 5e6, rare: 10 };

/** A Belt look-alike: a fixed list of asteroids at fixed world positions. */
class StubBelt {
  readonly specs = new Map<string, AsteroidSpec>();
  readonly world = new Map<string, Vector3>();
  /** Order asteroidsNear reports ids in — deliberately NOT nearest first. */
  private readonly order: string[] = [];

  add(id: string, world: Vector3, radiusKm: number, seed: number): void {
    this.specs.set(id, { id, offsetKm: [0, 0, 0], radiusKm, seed, composition: COMPOSITION });
    this.world.set(id, world.clone());
    this.order.push(id);
  }

  asteroidsNear(at: Vec3Like, maxKm: number, out: string[]): number {
    out.length = 0;
    for (const id of this.order) {
      const w = this.world.get(id)!;
      if (Math.hypot(w.x - at.x, w.y - at.y, w.z - at.z) <= maxKm) out.push(id);
    }
    return out.length;
  }

  asteroidWorld(id: string, out: Vec3Like): boolean {
    const w = this.world.get(id);
    if (!w) return false;
    out.x = w.x;
    out.y = w.y;
    out.z = w.z;
    return true;
  }

  asteroidSpec(id: string): AsteroidSpec | null {
    return this.specs.get(id) ?? null;
  }
}

/** The ship somewhere in a belt, far from the star: float64 matters here. */
const SHIP = new Vector3(2.6 * AU, 0.013 * AU, -0.4 * AU);

/** A direction from a counter, spread over the sphere (golden spiral). */
function dir(i: number, n: number): Vector3 {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return new Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
}

function rig() {
  const belt = new StubBelt();
  const universe = { system: startSystem(), orbitSeconds: 0, flight: { worldPosition: SHIP.clone() } };
  const ctx = nodeCtx();
  ctx.origin.setTo(SHIP.clone().add(new Vector3(37, -12, 5)));
  const asteroids = new Asteroids({ belt, universe } as unknown as ConstructorParameters<typeof Asteroids>[0]);
  asteroids.init(ctx);
  const frame = (): void => asteroids.update(1 / 60, ctx);
  return { belt, universe, ctx, asteroids, frame };
}

interface Drawn {
  variant: number;
  position: Vector3;
  scale: number;
}

/** Every active instance across every variant mesh. */
function drawn(asteroids: Asteroids): Drawn[] {
  const out: Drawn[] = [];
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  const meshes = asteroids.meshes as readonly InstancedMesh[];
  for (let v = 0; v < meshes.length; v++) {
    const mesh = meshes[v]!;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      out.push({ variant: v, position: p.clone(), scale: s.x });
      // Uniform scale: radius, not a squashed blob.
      expect(s.y).toBeCloseTo(s.x, 4);
      expect(s.z).toBeCloseTo(s.x, 4);
    }
  }
  return out;
}

/** The id whose render position (under the current origin) matches `p`, or null. */
function idAt(belt: StubBelt, ctx: ReturnType<typeof nodeCtx>, p: Vector3, tolKm = 5e-3): string | null {
  const r = new Vector3();
  for (const [id, w] of belt.world) {
    ctx.origin.toRender(w, r);
    if (r.distanceTo(p) <= tolKm) return id;
  }
  return null;
}

describe('Asteroids — instanced, in render space', () => {
  it('Given 30 asteroids within 400 km, Then exactly 30 instances are active, spread over ≤ 8 meshes, and each instance\'s matrix places it at origin.toRender(asteroidWorld)', () => {
    const { belt, ctx, asteroids, frame } = rig();
    expect(ASTEROID_DRAW_KM).toBe(400);
    expect(ASTEROID_VARIANTS).toBe(8);
    for (let i = 0; i < 30; i++) {
      const at = SHIP.clone().add(dir(i, 30).multiplyScalar(5 + i * 13)); // 5 … 382 km
      belt.add(`ast:test:0:${i}`, at, 0.05 + 0.018 * i, 1000 + i * 7);
    }
    // Beyond the draw distance: never drawn.
    for (let i = 0; i < 5; i++) {
      belt.add(`ast:test:1:${i}`, SHIP.clone().add(dir(i, 5).multiplyScalar(420 + i * 50)), 0.3, 77 + i);
    }

    frame();

    expect(asteroids.meshes.length).toBeLessThanOrEqual(8);
    const all = drawn(asteroids);
    expect(all.length).toBe(30);

    const seen = new Set<string>();
    for (const d of all) {
      const id = idAt(belt, ctx, d.position);
      expect(id, `instance at ${d.position.toArray()}`).not.toBeNull();
      expect(id!.startsWith('ast:test:0:')).toBe(true);
      expect(seen.has(id!), `${id} drawn twice`).toBe(false);
      seen.add(id!);
      const spec = belt.asteroidSpec(id!)!;
      expect(d.variant, id!).toBe(spec.seed % ASTEROID_VARIANTS);
      expect(d.scale, id!).toBeCloseTo(spec.radiusKm, 4);
    }
    expect(seen.size).toBe(30);
  });

  it('Given a rebase, Then the instance positions follow the new origin the same frame', () => {
    const { belt, ctx, asteroids, frame } = rig();
    for (let i = 0; i < 12; i++) {
      belt.add(`ast:test:0:${i}`, SHIP.clone().add(dir(i, 12).multiplyScalar(20 + i * 25)), 0.2, 500 + i);
    }
    frame();
    expect(drawn(asteroids).length).toBe(12);

    // The camera drifted 9 000 km: the origin jumps. Nothing in the belt moved.
    const v0 = ctx.origin.version;
    ctx.origin.setTo(ctx.origin.offset.clone().add(new Vector3(9_000, -3_000, 1_500)));
    expect(ctx.origin.version).toBe(v0 + 1);
    frame();

    const after = drawn(asteroids);
    expect(after.length).toBe(12);
    const r = new Vector3();
    for (const d of after) {
      const id = idAt(belt, ctx, d.position);
      expect(id, `instance at ${d.position.toArray()} not at its new render position`).not.toBeNull();
      ctx.origin.toRender(belt.world.get(id!)!, r);
      expect(d.position.distanceTo(r)).toBeLessThanOrEqual(5e-3); // float32 at ~9 000 km: ulp ≈ 1 m
    }
  });

  it('Given 600 asteroids in range, Then at most MAX_ASTEROID_INSTANCES, the nearest first', () => {
    const { belt, ctx, asteroids, frame } = rig();
    expect(MAX_ASTEROID_INSTANCES).toBe(256);
    const N = 600;
    // Reported in a scrambled order (stride 7 over 600), so "first 256 reported" ≠ "256 nearest".
    for (let k = 0; k < N; k++) {
      const i = (k * 7) % N;
      const distKm = 10 + (i * 385) / N; // 10 … 395 km, all distinct, all in range
      belt.add(`ast:test:2:${i}`, SHIP.clone().add(dir(i, N).multiplyScalar(distKm)), 0.1, i);
    }
    const nearest = new Set<string>();
    for (let i = 0; i < MAX_ASTEROID_INSTANCES; i++) nearest.add(`ast:test:2:${i}`);

    frame();

    const all = drawn(asteroids);
    expect(all.length).toBe(MAX_ASTEROID_INSTANCES);
    const seen = new Set<string>();
    for (const d of all) {
      const id = idAt(belt, ctx, d.position);
      expect(id).not.toBeNull();
      expect(nearest.has(id!), `${id} drawn but not among the ${MAX_ASTEROID_INSTANCES} nearest`).toBe(true);
      seen.add(id!);
    }
    expect(seen.size).toBe(MAX_ASTEROID_INSTANCES);
  });

  it('Given the material, Then its shaders contain logdepthbuf_pars_vertex/…_fragment (scene contract, as in Dust)', () => {
    const { asteroids } = rig();
    expect(asteroids.meshes.length).toBeGreaterThan(0);
    for (const mesh of asteroids.meshes) {
      expect(mesh).toBeInstanceOf(InstancedMesh);
      const mat = mesh.material as ShaderMaterial;
      expect(mat).toBeInstanceOf(ShaderMaterial);
      expect(mat.vertexShader).toContain('#include <logdepthbuf_pars_vertex>');
      expect(mat.vertexShader).toContain('#include <logdepthbuf_vertex>');
      expect(mat.fragmentShader).toContain('#include <logdepthbuf_pars_fragment>');
      expect(mat.fragmentShader).toContain('#include <logdepthbuf_fragment>');
      expect(mat.toneMapped).toBe(false);
      // Linear HDR: no colorspace or dither chunks.
      expect(mat.fragmentShader).not.toContain('colorspace_fragment');
      expect(mat.fragmentShader).not.toContain('dithering_fragment');
    }
  });
});
