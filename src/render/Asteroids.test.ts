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
 * R15 (fix round 1): the instances are CAMERA-RELATIVE. Each instance
 * translation is asteroidWorld − cameraWorld, taken in float64 on the CPU
 * (|t| ≤ ASTEROID_DRAW_KM), and `root.position` is the camera's render
 * position, so the GPU never composes a ~10 000 km translation in float32.
 * Where an instance is DRAWN in render space is therefore root · instance —
 * the same world point as origin.toRender(asteroidWorld), which the older
 * tests below still assert through `drawn()`.
 *
 * Contract asserted here:
 *   new Asteroids({ belt, universe }) — universe: { system, flight.worldPosition }
 *   .meshes: readonly InstancedMesh[] (one per variant; .count = active instances)
 *   .root: the Group holding the meshes (pure translation = camera render position)
 *   init(ctx), update(dt, ctx), optional lateUpdate(dt, ctx) (a frame runs both)
 *   per-instance surface attribute 'aSurface' on each variant geometry
 */

import { describe, expect, it } from 'vitest';
import { InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';

import type { GameModule } from '@/core/Engine';

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

/** Camera offset from the ship, km (a chase camera ~40 m behind and above). */
const CAM_FROM_SHIP = new Vector3(0.02, 0.012, -0.035);

function rig() {
  const belt = new StubBelt();
  const universe = { system: startSystem(), orbitSeconds: 0, flight: { worldPosition: SHIP.clone() } };
  const ctx = nodeCtx();
  ctx.origin.setTo(SHIP.clone().add(new Vector3(37, -12, 5)));
  // The camera sits just off the ship, as the chase rig puts it.
  ctx.origin.toRender(SHIP, ctx.camera.position).add(CAM_FROM_SHIP);
  const asteroids = new Asteroids({ belt, universe } as unknown as ConstructorParameters<typeof Asteroids>[0]);
  asteroids.init(ctx);
  const frame = (): void => {
    asteroids.update(1 / 60, ctx);
    (asteroids as GameModule).lateUpdate?.(1 / 60, ctx);
  };
  return { belt, universe, ctx, asteroids, frame };
}

interface Drawn {
  variant: number;
  position: Vector3;
  scale: number;
}

/**
 * Every active instance across every variant mesh, at the RENDER position it
 * is drawn at: the mesh's world matrix (root, R15) times the instance matrix.
 */
function drawn(asteroids: Asteroids): Drawn[] {
  const out: Drawn[] = [];
  asteroids.root.updateMatrixWorld(true);
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  const meshes = asteroids.meshes as readonly InstancedMesh[];
  for (let v = 0; v < meshes.length; v++) {
    const mesh = meshes[v]!;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.premultiply(mesh.matrixWorld);
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

// ---------------------------------------------------------------------------
// R15 — camera-relative instances (fix round 1)
// ---------------------------------------------------------------------------

/** Ship 9 000 km from render zero: just under the 10 000 km rebase threshold. */
function farRig() {
  const r = rig();
  r.ctx.origin.setTo(SHIP.clone().sub(new Vector3(9_000, -2_000, 500)));
  r.ctx.origin.toRender(SHIP, r.ctx.camera.position).add(CAM_FROM_SHIP);
  for (let i = 0; i < 30; i++) {
    r.belt.add(`ast:test:0:${i}`, SHIP.clone().add(dir(i, 30).multiplyScalar(5 + i * 13)), 0.05 + 0.018 * i, 1000 + i * 7);
  }
  return r;
}

/** Half a float32 step at |x| (the instance matrix is a Float32Array), plus the ruling's 1e-6 km. */
function f32Tol(x: number): number {
  return 1e-6 + Math.abs(x) * 2 ** -24;
}

describe('Asteroids — camera-relative instances (R15)', () => {
  it('Given the camera 9 000 km from render zero, Then every instance translation is the asteroid\'s world position minus the camera\'s world position (to 1e-6 km) and |translation| ≤ ASTEROID_DRAW_KM', () => {
    const { belt, ctx, asteroids, frame } = farRig();
    expect(ctx.camera.position.length()).toBeGreaterThan(9_000);
    frame();

    const camWorld = ctx.origin.offset.clone().add(ctx.camera.position); // float64
    expect(drawn(asteroids).length).toBe(30);

    const m = new Matrix4();
    const t = new Vector3();
    let checked = 0;
    for (const mesh of asteroids.meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        t.setFromMatrixPosition(m);
        expect(t.length(), `${mesh.name}[${i}]`).toBeLessThanOrEqual(ASTEROID_DRAW_KM);
        // Which rock is it? The one drawn at root + t in render space.
        const at = t.clone().add(asteroids.root.position);
        const id = idAt(belt, ctx, at);
        expect(id, `${mesh.name}[${i}] at ${at.toArray()}`).not.toBeNull();
        const w = belt.world.get(id!)!;
        const ex = w.x - camWorld.x;
        const ey = w.y - camWorld.y;
        const ez = w.z - camWorld.z;
        expect(Math.abs(t.x - ex), id!).toBeLessThanOrEqual(f32Tol(ex));
        expect(Math.abs(t.y - ey), id!).toBeLessThanOrEqual(f32Tol(ey));
        expect(Math.abs(t.z - ez), id!).toBeLessThanOrEqual(f32Tol(ez));
        checked++;
      }
    }
    expect(checked).toBe(30);
  });

  it('Given the root, Then its position is the camera\'s render position', () => {
    const { ctx, asteroids, frame } = farRig();
    frame();
    const cam = ctx.camera.getWorldPosition(new Vector3());
    expect(asteroids.root.position.distanceTo(cam)).toBeLessThanOrEqual(1e-9);
    // A pure translation: no rotation or scale for the normals to undo.
    expect(asteroids.root.quaternion.angleTo(new Quaternion())).toBeLessThanOrEqual(1e-12);
    expect(asteroids.root.scale.equals(new Vector3(1, 1, 1))).toBe(true);

    // It follows the camera the next frame.
    ctx.camera.position.add(new Vector3(1.5, -0.25, 3));
    frame();
    expect(asteroids.root.position.distanceTo(ctx.camera.getWorldPosition(new Vector3()))).toBeLessThanOrEqual(1e-9);
  });

  it('Given the vertex shader, Then it uses modelViewMatrix with instanceMatrix and not viewMatrix * modelMatrix', () => {
    const { asteroids } = rig();
    for (const mesh of asteroids.meshes) {
      const vs = (mesh.material as ShaderMaterial).vertexShader;
      expect(vs).toMatch(/modelViewMatrix\s*\*\s*instanceMatrix/);
      expect(vs).not.toMatch(/viewMatrix\s*\*\s*modelMatrix/);
      // Nor a world position built from modelMatrix and then multiplied by viewMatrix.
      expect(vs).not.toMatch(/projectionMatrix\s*\*\s*viewMatrix/);
      expect(vs).toContain('#include <logdepthbuf_vertex>');
    }
  });

  it('Given 30 instances, Then the matrix update range covers 30 instances only', () => {
    const { asteroids, frame } = farRig();
    // Two frames: the ranges must be reset, not accumulated (in node nothing uploads them).
    frame();
    frame();
    let covered = 0;
    for (const mesh of asteroids.meshes) {
      let sum = 0;
      for (const r of mesh.instanceMatrix.updateRanges) {
        expect(r.start).toBeGreaterThanOrEqual(0);
        expect(r.start + r.count, mesh.name).toBeLessThanOrEqual(mesh.count * 16);
        sum += r.count;
      }
      expect(sum, mesh.name).toBe(mesh.count * 16);
      covered += sum;
    }
    expect(covered).toBe(30 * 16);
  });

  it('Given an unchanged slot assignment across two frames, Then the surface attribute is not re-uploaded (version unchanged)', () => {
    const { belt, asteroids, frame } = farRig();
    const surface = (v: number): InstancedBufferAttribute =>
      asteroids.meshes[v]!.geometry.getAttribute('aSurface') as InstancedBufferAttribute;

    frame();
    const before = asteroids.meshes.map((_, v) => surface(v).version);
    frame();
    const after = asteroids.meshes.map((_, v) => surface(v).version);
    expect(after).toEqual(before);

    // Control: a new rock, nearer than all the others, changes its variant's slots.
    const seed = 4242;
    belt.add('ast:test:9:0', SHIP.clone().add(new Vector3(1, 0, 0)), 0.3, seed);
    frame();
    const v = seed % ASTEROID_VARIANTS;
    expect(surface(v).version).toBeGreaterThan(after[v]!);
  });
});
