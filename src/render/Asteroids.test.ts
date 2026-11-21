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
 *
 * Plan 5, Task 5 (visible wear and break-up) — see the blocks at the end:
 *   per-instance 'aWear' = wearVisual(belt.wear(id)) on each variant geometry
 *   .breakup: InstancedMesh — the one extra drawable; BREAKUP_S, MAX_BREAKUPS
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Matrix4,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';

import type { AsteroidSpec, Resource } from '@/gen/belt';
import { AU } from '@/gen/types';
import { beltRig, fieldCentre, fyssField, nodeCtx, startSystem } from '@/game/testing/beltFixture';

import {
  ASTEROID_DRAW_KM,
  ASTEROID_VARIANTS,
  Asteroids,
  BREAKUP_S,
  MAX_ASTEROID_INSTANCES,
  MAX_BREAKUPS,
} from './Asteroids';
import { asteroidSurface, wearVisual } from './asteroidSurface';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const COMPOSITION: Record<Resource, number> = { ice: 1e6, metal: 1e5, silicate: 5e6, rare: 10 };

/**
 * A Belt look-alike: a fixed list of asteroids at fixed world positions.
 * Plan 5, Task 5: also `wear`, `asteroidSpecRaw`, `isDestroyed` and
 * `asteroidVelocity` with the Belt's semantics — a destroyed rock is absent
 * from asteroidsNear / asteroidWorld / asteroidSpec / asteroidVelocity, but
 * `asteroidSpecRaw` still has it, and its wear is just under 1 (dust left).
 */
class StubBelt {
  readonly specs = new Map<string, AsteroidSpec>();
  readonly world = new Map<string, Vector3>();
  /** Mined mass / original mass per id; absent = 0. */
  readonly wearOf = new Map<string, number>();
  readonly destroyed = new Set<string>();
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
      if (this.destroyed.has(id)) continue;
      const w = this.world.get(id)!;
      if (Math.hypot(w.x - at.x, w.y - at.y, w.z - at.z) <= maxKm) out.push(id);
    }
    return out.length;
  }

  asteroidWorld(id: string, out: Vec3Like): boolean {
    if (this.destroyed.has(id)) return false;
    const w = this.world.get(id);
    if (!w) return false;
    out.x = w.x;
    out.y = w.y;
    out.z = w.z;
    return true;
  }

  asteroidSpec(id: string): AsteroidSpec | null {
    if (this.destroyed.has(id)) return null;
    return this.specs.get(id) ?? null;
  }

  asteroidVelocity(id: string, out: Vec3Like): boolean {
    if (this.destroyed.has(id) || !this.specs.has(id)) return false;
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return true;
  }

  asteroidSpecRaw(id: string): AsteroidSpec | null {
    return this.specs.get(id) ?? null;
  }

  wear(id: string): number {
    return this.specs.has(id) ? (this.wearOf.get(id) ?? 0) : 0;
  }

  isDestroyed(id: string): boolean {
    return this.destroyed.has(id);
  }

  /** Mined empty: every lookup but asteroidSpecRaw forgets it; dust left, so wear < 1. */
  destroy(id: string): void {
    this.destroyed.add(id);
    this.wearOf.set(id, 0.9999);
  }
}

/** Every Asteroids a test builds is disposed after it: no bus listener outlives its test. */
const live: Asteroids[] = [];
afterEach(() => {
  for (const a of live.splice(0)) a.dispose();
  vi.restoreAllMocks();
});

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
  live.push(asteroids);
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
  it('Given 30 asteroids within 1 500 km, Then exactly 30 instances are active, spread over ≤ 8 meshes, and each instance\'s matrix places it at origin.toRender(asteroidWorld)', () => {
    const { belt, ctx, asteroids, frame } = rig();
    expect(ASTEROID_DRAW_KM).toBe(1_500);
    expect(ASTEROID_VARIANTS).toBe(8);
    for (let i = 0; i < 30; i++) {
      const at = SHIP.clone().add(dir(i, 30).multiplyScalar(5 + i * 50)); // 5 … 1 455 km
      belt.add(`ast:test:0:${i}`, at, 0.4 + 0.12 * i, 1000 + i * 7);
    }
    // Beyond the draw distance: never drawn.
    for (let i = 0; i < 5; i++) {
      belt.add(`ast:test:1:${i}`, SHIP.clone().add(dir(i, 5).multiplyScalar(1_520 + i * 50)), 2, 77 + i);
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

// ---------------------------------------------------------------------------
// Final whole-branch review, minor (a): the surface update range was reset in
// lateUpdate — before the renderer ever read it — so a changed tint never
// reached the GPU. At render time (after update AND lateUpdate) the range must
// cover exactly the slots whose occupant changed this frame.
// ---------------------------------------------------------------------------

/** The element span [start, end) the ranges with count > 0 cover, or null. */
function surfaceSpan(attr: InstancedBufferAttribute): { start: number; end: number; total: number } | null {
  let start = Infinity;
  let end = -Infinity;
  let total = 0;
  for (const r of attr.updateRanges) {
    if (r.count <= 0) continue;
    start = Math.min(start, r.start);
    end = Math.max(end, r.start + r.count);
    total += r.count;
  }
  return total > 0 ? { start, end, total } : null;
}

describe('Asteroids — the surface update range survives to render time (final review, minor a)', () => {
  const surface = (a: Asteroids, v: number): InstancedBufferAttribute =>
    a.meshes[v]!.geometry.getAttribute('aSurface') as InstancedBufferAttribute;

  it("Given the first frame, When update and lateUpdate have both run, Then each drawn variant's surface range covers exactly its occupied slots", () => {
    const { asteroids, frame } = farRig();
    frame();
    let drawnVariants = 0;
    for (let v = 0; v < asteroids.meshes.length; v++) {
      const count = asteroids.meshes[v]!.count;
      if (count === 0) continue;
      drawnVariants++;
      const span = surfaceSpan(surface(asteroids, v));
      expect(span, `variant ${v}: range emptied before render`).not.toBeNull();
      expect(span!.start, `variant ${v}`).toBe(0);
      expect(span!.end, `variant ${v}`).toBe(count * 4);
    }
    expect(drawnVariants).toBeGreaterThan(0);
  });

  it("Given a settled field, When one new rock takes a slot, Then at render time its variant's surface range is exactly that slot (4 floats) and is flagged for upload", () => {
    const { belt, asteroids, frame } = farRig();
    frame();
    frame();
    const seed = 4242;
    const v = seed % ASTEROID_VARIANTS;
    // The stub reports new rocks last (and < 256 are never sorted), so it takes the next slot.
    const slot = asteroids.meshes[v]!.count;
    const before = surface(asteroids, v).version;
    belt.add('ast:test:9:0', SHIP.clone().add(new Vector3(1, 0, 0)), 0.3, seed);
    frame();
    expect(asteroids.meshes[v]!.count).toBe(slot + 1);
    const attr = surface(asteroids, v);
    expect(attr.version).toBeGreaterThan(before);
    const span = surfaceSpan(attr);
    expect(span, 'range emptied before render').not.toBeNull();
    expect(span).toEqual({ start: slot * 4, end: slot * 4 + 4, total: 4 });
  });

  it('Given a frame that changes nothing after one that changed a slot, Then nothing is re-uploaded (version unchanged)', () => {
    const { belt, asteroids, frame } = farRig();
    frame();
    belt.add('ast:test:9:0', SHIP.clone().add(new Vector3(1, 0, 0)), 0.3, 4242);
    frame();
    const versions = asteroids.meshes.map((_, v) => surface(asteroids, v).version);
    frame();
    expect(asteroids.meshes.map((_, v) => surface(asteroids, v).version)).toEqual(versions);
  });
});

// ---------------------------------------------------------------------------
// Final whole-branch review, I1 — the renderer takes its surface from the pure
// helper (render/asteroidSurface), and the shader tints and tightens the
// highlight as ruled. Imported dynamically so a missing helper fails only here.
// ---------------------------------------------------------------------------

describe('Asteroids — surface from asteroidSurface (final review I1)', () => {
  it("Given a metal-only rock, Then its aSurface slot holds the helper's albedo (rgb) and specular strength (a)", async () => {
    const { asteroidSurface } = await import('./asteroidSurface');
    const { belt, asteroids, frame } = rig();
    const seed = 3001;
    const metal: Record<Resource, number> = { ice: 0, metal: 4e6, silicate: 0, rare: 0 };
    belt.add('ast:test:m:0', SHIP.clone().add(new Vector3(2, 0, 0)), 0.2, seed);
    belt.specs.set('ast:test:m:0', { ...belt.specs.get('ast:test:m:0')!, composition: metal });
    frame();
    const v = seed % ASTEROID_VARIANTS;
    const arr = (asteroids.meshes[v]!.geometry.getAttribute('aSurface') as InstancedBufferAttribute).array;
    const s = asteroidSurface(metal);
    expect(arr[0]).toBeCloseTo(s.albedo[0], 6);
    expect(arr[1]).toBeCloseTo(s.albedo[1], 6);
    expect(arr[2]).toBeCloseTo(s.albedo[2], 6);
    expect(arr[3]).toBeCloseTo(s.spec, 6);
  });

  it('Given the fragment shader, Then the highlight uses ASTEROID_SPEC_EXPONENT (not 24) and a specColor mixed from white towards the albedo by metalness', async () => {
    const { ASTEROID_SPEC_EXPONENT } = await import('./asteroidSurface');
    const { asteroids } = rig();
    const fs = (asteroids.meshes[0]!.material as ShaderMaterial).fragmentShader;
    expect(fs).not.toMatch(/pow\([^;]*,\s*24\.0\)/);
    expect(fs).toContain(ASTEROID_SPEC_EXPONENT.toFixed(1));
    expect(fs).toMatch(/mix\(\s*vec3\(\s*1(\.0)?\s*\)/);
  });
});

// ===========================================================================
// v4 sub-plan 5, Task 5 — visible wear and break-up of a mined-out rock.
//
// The owner: "the wear on the rock should be visible … and shouldn't we more
// or less destroy the asteroid when mining?" Mining is continuous; the rock
// shows it. Contract asserted below:
//
//   'aWear' — one float per instance on each of the eight variant geometries,
//     holding wearVisual(belt.wear(id)) (the LOOK, as aSurface/aMetal hold
//     the helper's final values, not the composition). Re-uploaded only when a
//     slot's wear or occupant changed, as aSurface is.
//   .breakup: InstancedMesh — the ONE extra drawable. Idle: hidden or count 0.
//     On 'asteroid:destroyed' (global bus) a rock the renderer drew breaks up
//     at its last position, with its radius and surface ('aSurface' on the
//     break-up geometry), pieces drifting apart, laid out from the rock's seed.
//     Driven by universe.orbitSeconds (the clock the spin already reads): a
//     frozen clock freezes it. After BREAKUP_S = 2.5 s it is gone.
//     At most MAX_BREAKUPS = 4 at once; more are ignored.
//   Break-up and "not drawn" key on absence from the Belt (destroyed), never
//   on wear === 1. A rock destroyed before it was ever drawn gives no break-up.
// ===========================================================================

type Ctx = ReturnType<typeof nodeCtx>;
type Drawable = Object3D & {
  geometry: BufferGeometry;
  material: Material | Material[];
  count?: number;
  isMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
  isInstancedMesh?: boolean;
};

const wearAttr = (a: Asteroids, v: number): InstancedBufferAttribute =>
  a.meshes[v]!.geometry.getAttribute('aWear') as InstancedBufferAttribute;
const surfaceAttr = (a: Asteroids, v: number): InstancedBufferAttribute =>
  a.meshes[v]!.geometry.getAttribute('aSurface') as InstancedBufferAttribute;

/** True when the object and every ancestor are visible. */
function shown(o: Object3D): boolean {
  for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function inScene(o: Object3D, scene: Object3D): boolean {
  for (let x: Object3D | null = o; x; x = x.parent) if (x === scene) return true;
  return false;
}

/** Everything under `root` the renderer would issue a draw call for, visible or not. */
function drawables(root: Object3D): Drawable[] {
  const out: Drawable[] = [];
  root.traverse((o) => {
    const d = o as Drawable;
    if (d.isMesh || d.isPoints || d.isLine || d.isSprite) out.push(d);
  });
  return out;
}

/** Draw calls this frame: shown drawables, an InstancedMesh only with count > 0. */
function drawCalls(scene: Object3D): number {
  let n = 0;
  for (const d of drawables(scene)) {
    if (!shown(d)) continue;
    if (d.isInstancedMesh && (d.count ?? 0) === 0) continue;
    n++;
  }
  return n;
}

/** Drawables in the scene that are not one of the eight variant meshes. */
function extras(a: Asteroids, scene: Object3D): Drawable[] {
  const eight = new Set<Object3D>(a.meshes);
  return drawables(scene).filter((d) => !eight.has(d));
}

/** No break-up is being drawn. */
function idle(a: Asteroids): boolean {
  return !shown(a.breakup) || a.breakup.count === 0;
}

interface Piece {
  /** World position (float64, star frame), km. */
  world: Vector3;
  /** Instance scale × the break-up geometry's bounding radius, km. */
  extent: number;
}

/** The break-up's pieces as drawn: none unless it is in the scene, shown and has instances. */
function pieces(a: Asteroids, ctx: Ctx): Piece[] {
  const b = a.breakup;
  if (!inScene(b, ctx.scene) || !shown(b) || b.count === 0) return [];
  b.updateWorldMatrix(true, false);
  b.geometry.computeBoundingSphere();
  const gr = b.geometry.boundingSphere!.radius;
  const out: Piece[] = [];
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  for (let i = 0; i < b.count; i++) {
    b.getMatrixAt(i, m);
    m.premultiply(b.matrixWorld);
    m.decompose(p, q, s);
    out.push({ world: p.clone().add(ctx.origin.offset), extent: Math.max(s.x, s.y, s.z) * gr });
  }
  return out;
}

function near(ps: readonly Piece[], c: Vector3, km: number): Piece[] {
  return ps.filter((p) => p.world.distanceTo(c) <= km);
}

function centroid(ps: readonly Piece[]): Vector3 {
  const c = new Vector3();
  for (const p of ps) c.add(p.world);
  return c.multiplyScalar(1 / ps.length);
}

function meanDistance(ps: readonly Piece[], c: Vector3): number {
  let sum = 0;
  for (const p of ps) sum += p.world.distanceTo(c);
  return sum / ps.length;
}

/** id → variant and slot of every drawn rock, found by its render position. */
function slotsOf(a: Asteroids, which: (render: Vector3) => string | null): Map<string, { v: number; slot: number }> {
  const out = new Map<string, { v: number; slot: number }>();
  if (!shown(a.root)) return out;
  a.root.updateMatrixWorld(true);
  const m = new Matrix4();
  const p = new Vector3();
  a.meshes.forEach((mesh, v) => {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.premultiply(mesh.matrixWorld);
      p.setFromMatrixPosition(m);
      const id = which(p);
      if (id) out.set(id, { v, slot: i });
    }
  });
  return out;
}

/** The stub's rocks by render position (destroyed ones included, so a wrongly drawn one is caught). */
const stubWhich = (belt: StubBelt, ctx: Ctx) => (p: Vector3) => idAt(belt, ctx, p);

/** Mine a stub rock empty and announce it, as Mining does. */
function destroyAndAnnounce(belt: StubBelt, id: string): void {
  belt.destroy(id);
  bus.emit('asteroid:destroyed', { asteroidId: id });
}

/** console.error, silenced and watched: the bus reports a throwing handler there instead of throwing. */
function watchErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** The break-up's own per-instance data, in a comparable form. */
function breakupData(a: Asteroids): number[][] {
  const b = a.breakup;
  const out: number[][] = [Array.from(b.instanceMatrix.array.slice(0, b.count * 16))];
  for (const name of Object.keys(b.geometry.attributes).sort()) {
    const attr = b.geometry.getAttribute(name);
    if (!(attr instanceof InstancedBufferAttribute)) continue;
    out.push(Array.from((attr.array as Float32Array).slice(0, b.count * attr.itemSize)));
  }
  return out;
}

const ROCK = 'ast:test:5:0';
const ROCK_AT = SHIP.clone().add(new Vector3(3, 0.5, -1));
const ROCK_R = 0.3;
const ROCK_SEED = 4243;
/** A second rock that stays, far enough that no piece of ROCK comes near it. */
const OTHER = 'ast:test:5:1';
const OTHER_AT = SHIP.clone().add(new Vector3(-60, 10, 25));

/** rig() with ROCK and OTHER in view, one frame run. */
function rockRig(opts: { withOther?: boolean; radius?: number; seed?: number } = {}) {
  const r = rig();
  r.belt.add(ROCK, ROCK_AT, opts.radius ?? ROCK_R, opts.seed ?? ROCK_SEED);
  if (opts.withOther ?? true) r.belt.add(OTHER, OTHER_AT, 0.5, 4250);
  r.frame();
  return r;
}

// ---------------------------------------------------------------------------
// aWear
// ---------------------------------------------------------------------------

describe('Asteroids — aWear: the wear each rock shows (plan 5 task 5)', () => {
  it('Given the eight variant geometries, Then each carries an instanced float attribute aWear with room for every instance', () => {
    const { asteroids } = rig();
    expect(asteroids.meshes.length).toBe(ASTEROID_VARIANTS);
    for (let v = 0; v < ASTEROID_VARIANTS; v++) {
      const attr = wearAttr(asteroids, v);
      expect(attr, `variant ${v}`).toBeInstanceOf(InstancedBufferAttribute);
      expect(attr.itemSize, `variant ${v}`).toBe(1);
      expect(attr.count, `variant ${v}`).toBeGreaterThanOrEqual(MAX_ASTEROID_INSTANCES);
    }
  });

  it('Given 30 rocks with different wear, When drawn, Then each rock\'s aWear slot holds wearVisual(belt.wear(id))', () => {
    const { belt, ctx, asteroids, frame } = rig();
    for (let i = 0; i < 30; i++) {
      const id = `ast:test:6:${i}`;
      belt.add(id, SHIP.clone().add(dir(i, 30).multiplyScalar(4 + i * 9)), 0.1 + 0.01 * i, 2000 + i * 13);
      belt.wearOf.set(id, i === 0 ? 0 : i / 31);
    }
    frame();
    const slots = slotsOf(asteroids, stubWhich(belt, ctx));
    expect(slots.size).toBe(30);
    for (const [id, { v, slot }] of slots) {
      expect(wearAttr(asteroids, v).getX(slot), id).toBeCloseTo(wearVisual(belt.wear(id)), 6);
    }
  });

  it('Given a drawn rock, When its wear changes between frames, Then the next frame its aWear slot holds the new look, flagged for upload with a range covering that slot, and aSurface is not re-uploaded', () => {
    const { belt, ctx, asteroids, frame } = rockRig();
    frame();
    const at = slotsOf(asteroids, stubWhich(belt, ctx)).get(ROCK)!;
    expect(at).toBeDefined();
    expect(wearAttr(asteroids, at.v).getX(at.slot)).toBeCloseTo(wearVisual(0), 6);
    const wearVersion = wearAttr(asteroids, at.v).version;
    const surfaceVersion = surfaceAttr(asteroids, at.v).version;

    belt.wearOf.set(ROCK, 2_000 / 65_000); // a few bites
    frame();

    const attr = wearAttr(asteroids, at.v);
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).get(ROCK)).toEqual(at);
    expect(attr.getX(at.slot)).toBeCloseTo(wearVisual(2_000 / 65_000), 6);
    expect(attr.getX(at.slot)).toBeGreaterThanOrEqual(0.15);
    expect(attr.version).toBeGreaterThan(wearVersion);
    const covered = attr.updateRanges.some((r) => r.count > 0 && r.start <= at.slot && r.start + r.count >= at.slot + 1);
    expect(covered, `ranges ${JSON.stringify(attr.updateRanges)}`).toBe(true);
    expect(surfaceAttr(asteroids, at.v).version).toBe(surfaceVersion);

    // And again: more wear, a newer look.
    belt.wearOf.set(ROCK, 0.4);
    frame();
    expect(wearAttr(asteroids, at.v).getX(at.slot)).toBeCloseTo(wearVisual(0.4), 6);
  });

  it('Given a settled field whose wear does not change, Then aWear is not re-uploaded (version unchanged)', () => {
    const { belt, asteroids, frame } = farRig();
    belt.wearOf.set('ast:test:0:3', 0.2);
    frame();
    frame();
    const before = asteroids.meshes.map((_, v) => wearAttr(asteroids, v).version);
    frame();
    frame();
    expect(asteroids.meshes.map((_, v) => wearAttr(asteroids, v).version)).toEqual(before);
  });

  it('Given a rock worn to 0.99991 but NOT destroyed (resources left), Then it is still drawn with that look and no break-up starts (wear is not the destroy test)', () => {
    const { belt, ctx, asteroids, frame } = rockRig();
    belt.wearOf.set(ROCK, 0.99991);
    frame();
    const at = slotsOf(asteroids, stubWhich(belt, ctx)).get(ROCK);
    expect(at, 'a nearly-empty rock is still a rock').toBeDefined();
    expect(wearAttr(asteroids, at!.v).getX(at!.slot)).toBeCloseTo(wearVisual(0.99991), 6);
    expect(idle(asteroids)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Draw calls
// ---------------------------------------------------------------------------

describe('Asteroids — the break-up costs at most one draw call (plan 5 task 5)', () => {
  it('Given a field and no break-up, Then there are still exactly eight InstancedMeshes, at most one other drawable (the break-up), and it is hidden or empty', () => {
    const { asteroids, ctx } = farRig();
    asteroids.update(1 / 60, ctx);
    asteroids.lateUpdate(1 / 60, ctx);
    expect(asteroids.meshes.length).toBe(8);
    for (const m of asteroids.meshes) expect(m).toBeInstanceOf(InstancedMesh);
    expect(asteroids.breakup).toBeInstanceOf(InstancedMesh);
    const other = extras(asteroids, ctx.scene);
    expect(other.length).toBeLessThanOrEqual(1);
    for (const d of other) expect(d).toBe(asteroids.breakup);
    expect(idle(asteroids)).toBe(true);
    const nonEmpty = asteroids.meshes.filter((m) => m.count > 0).length;
    expect(drawCalls(ctx.scene)).toBe(nonEmpty);
  });

  it('Given a break-up running in a field, Then the eight stay eight and the draw calls are the non-empty variants plus exactly one', () => {
    const { belt, universe, ctx, asteroids, frame } = rockRig();
    destroyAndAnnounce(belt, ROCK);
    frame();
    universe.orbitSeconds += BREAKUP_S * 0.4;
    frame();
    expect(asteroids.meshes.length).toBe(8);
    expect(idle(asteroids)).toBe(false);
    const other = extras(asteroids, ctx.scene);
    expect(other).toEqual([asteroids.breakup]);
    const nonEmpty = asteroids.meshes.filter((m) => m.count > 0 && shown(m)).length;
    expect(drawCalls(ctx.scene)).toBe(nonEmpty + 1);
  });
});

// ---------------------------------------------------------------------------
// The break-up itself
// ---------------------------------------------------------------------------

describe('Asteroids — a rock mined empty breaks up and is gone (plan 5 task 5)', () => {
  it('Given BREAKUP_S and MAX_BREAKUPS, Then they are 2.5 s and 4', () => {
    expect(BREAKUP_S).toBe(2.5);
    expect(MAX_BREAKUPS).toBe(4);
  });

  it("Given a drawn rock, When 'asteroid:destroyed' arrives for it, Then it is no longer drawn among the eight and several pieces appear at its last position, each smaller than the rock, all within 1.5 radii", () => {
    const { belt, ctx, asteroids, frame } = rockRig();
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(ROCK)).toBe(true);
    expect(idle(asteroids)).toBe(true);

    destroyAndAnnounce(belt, ROCK);
    frame(); // same orbit time: age 0

    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(ROCK), 'the destroyed rock is still drawn whole').toBe(false);
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(OTHER)).toBe(true);
    const ps = pieces(asteroids, ctx);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    for (const p of ps) {
      expect(p.world.distanceTo(ROCK_AT)).toBeLessThanOrEqual(1.5 * ROCK_R);
      expect(p.extent).toBeGreaterThan(0);
      expect(p.extent).toBeLessThanOrEqual(ROCK_R * (1 + 1e-6));
    }
    expect(centroid(ps).distanceTo(ROCK_AT)).toBeLessThanOrEqual(ROCK_R);
  });

  it('Given the last rock in view breaks up, Then the pieces are still drawn (the break-up does not vanish with the eight meshes) and they are the only draw call', () => {
    const { belt, ctx, asteroids, frame } = rockRig({ withOther: false });
    destroyAndAnnounce(belt, ROCK);
    frame();
    expect(asteroids.meshes.every((m) => m.count === 0 || !shown(m))).toBe(true);
    const ps = pieces(asteroids, ctx);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(centroid(ps).distanceTo(ROCK_AT)).toBeLessThanOrEqual(ROCK_R);
    expect(drawCalls(ctx.scene)).toBe(1);
  });

  it('Given the real frame order (Mining emits between update and lateUpdate), Then the break-up starts at the rock and the rock is gone from the eight by the next frame', () => {
    const { belt, ctx, asteroids, frame } = rockRig();
    asteroids.update(1 / 60, ctx);
    destroyAndAnnounce(belt, ROCK);
    asteroids.lateUpdate(1 / 60, ctx);
    frame();
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(ROCK)).toBe(false);
    const ps = pieces(asteroids, ctx);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(centroid(ps).distanceTo(ROCK_AT)).toBeLessThanOrEqual(ROCK_R);
  });

  it('Given a break-up running, When orbit time passes, Then the pieces drift apart (mean distance from the rock grows) and are still drawn at 0.9 × BREAKUP_S', () => {
    const { belt, universe, ctx, asteroids, frame } = rockRig();
    const t0 = universe.orbitSeconds;
    destroyAndAnnounce(belt, ROCK);
    frame();
    const spread: number[] = [];
    for (const f of [0.1, 0.4, 0.9]) {
      universe.orbitSeconds = t0 + f * BREAKUP_S;
      frame();
      const ps = pieces(asteroids, ctx);
      expect(ps.length, `at ${f} × BREAKUP_S`).toBeGreaterThanOrEqual(3);
      spread.push(meanDistance(ps, ROCK_AT));
    }
    expect(spread[1]!).toBeGreaterThan(spread[0]!);
    expect(spread[2]!).toBeGreaterThan(spread[1]!);
  });

  it('Given a break-up, When BREAKUP_S of orbit time has passed, Then it is gone: no pieces, instance count back to 0, and the draw calls are the eight\'s alone', () => {
    const { belt, universe, ctx, asteroids, frame } = rockRig();
    const t0 = universe.orbitSeconds;
    destroyAndAnnounce(belt, ROCK);
    frame();
    universe.orbitSeconds = t0 + BREAKUP_S * 0.5;
    frame();
    expect(pieces(asteroids, ctx).length).toBeGreaterThan(0);

    universe.orbitSeconds = t0 + BREAKUP_S + 0.01;
    frame();
    expect(pieces(asteroids, ctx)).toEqual([]);
    expect(asteroids.breakup.count).toBe(0);
    expect(idle(asteroids)).toBe(true);
    const nonEmpty = asteroids.meshes.filter((m) => m.count > 0 && shown(m)).length;
    expect(drawCalls(ctx.scene)).toBe(nonEmpty);

    // And it stays gone.
    universe.orbitSeconds += 5;
    frame();
    expect(asteroids.breakup.count).toBe(0);
  });

  it('Given a break-up and a frozen orbit clock (pause), When 300 frames pass, Then it neither advances nor ends: the pieces are exactly where they were', () => {
    const { belt, universe, ctx, asteroids, frame } = rockRig();
    destroyAndAnnounce(belt, ROCK);
    frame();
    universe.orbitSeconds += BREAKUP_S * 0.3;
    frame();
    const before = breakupData(asteroids);
    expect(before[0]!.length).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) frame(); // 5 s of dt, but no orbit time
    expect(idle(asteroids)).toBe(false);
    expect(breakupData(asteroids)).toEqual(before);
  });

  it('Given a metal rock breaks up, Then the pieces carry its surface: the break-up geometry\'s aSurface holds asteroidSurface(composition of asteroidSpecRaw) for every piece', () => {
    const r = rig();
    const metal: Record<Resource, number> = { ice: 0, metal: 4e6, silicate: 0, rare: 0 };
    r.belt.add(ROCK, ROCK_AT, ROCK_R, ROCK_SEED);
    r.belt.specs.set(ROCK, { ...r.belt.specs.get(ROCK)!, composition: metal });
    r.belt.add(OTHER, OTHER_AT, 0.5, 4250);
    r.frame();
    destroyAndAnnounce(r.belt, ROCK);
    r.frame();
    const b = r.asteroids.breakup;
    expect(b.count).toBeGreaterThanOrEqual(3);
    const attr = b.geometry.getAttribute('aSurface') as InstancedBufferAttribute;
    expect(attr).toBeInstanceOf(InstancedBufferAttribute);
    expect(attr.itemSize).toBe(4);
    const s = asteroidSurface(metal);
    for (let i = 0; i < b.count; i++) {
      expect(attr.getX(i), `piece ${i}`).toBeCloseTo(s.albedo[0], 6);
      expect(attr.getY(i), `piece ${i}`).toBeCloseTo(s.albedo[1], 6);
      expect(attr.getZ(i), `piece ${i}`).toBeCloseTo(s.albedo[2], 6);
      expect(attr.getW(i), `piece ${i}`).toBeCloseTo(s.spec, 6);
    }
  });

  it('Given two rocks of radius 0.1 and 0.5 km (same seed), Then the break-up of the larger is about five times as large', () => {
    const envelope = (radius: number): number => {
      const { belt, ctx, asteroids, frame } = rockRig({ radius });
      destroyAndAnnounce(belt, ROCK);
      frame();
      const ps = pieces(asteroids, ctx);
      expect(ps.length).toBeGreaterThanOrEqual(3);
      return Math.max(...ps.map((p) => p.world.distanceTo(ROCK_AT) + p.extent));
    };
    const ratio = envelope(0.5) / envelope(0.1);
    expect(ratio).toBeGreaterThanOrEqual(3.5);
    expect(ratio).toBeLessThanOrEqual(6.5);
  });
});

// ---------------------------------------------------------------------------
// Rocks that are already gone, and events that point nowhere
// ---------------------------------------------------------------------------

describe('Asteroids — no break-up without a rock that was seen (plan 5 task 5)', () => {
  it('Given a rock already destroyed when the renderer first looks (loaded that way), Then it is never drawn and no break-up appears', () => {
    const { belt, universe, ctx, asteroids, frame } = rig();
    belt.add(ROCK, ROCK_AT, ROCK_R, ROCK_SEED);
    belt.add(OTHER, OTHER_AT, 0.5, 4250);
    belt.destroy(ROCK); // no event: nothing was mined this session
    for (let i = 0; i < 3; i++) {
      frame();
      universe.orbitSeconds += 0.5;
    }
    const slots = slotsOf(asteroids, stubWhich(belt, ctx));
    expect(slots.has(ROCK)).toBe(false);
    expect(slots.has(OTHER)).toBe(true);
    expect(idle(asteroids)).toBe(true);
    expect(pieces(asteroids, ctx)).toEqual([]);
  });

  it('Given a drawn rock, When the world is restored with it emptied (no event), Then it disappears the next frame and no break-up appears', () => {
    const { belt, ctx, asteroids, frame } = rockRig();
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(ROCK)).toBe(true);
    belt.destroy(ROCK);
    frame();
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(ROCK)).toBe(false);
    expect(idle(asteroids)).toBe(true);
  });

  it("Given 'asteroid:destroyed' for an unknown id, Then nothing throws (no handler error) and no break-up appears", () => {
    const errors = watchErrors();
    const { asteroids, frame } = rockRig();
    expect(() => bus.emit('asteroid:destroyed', { asteroidId: 'ast:nowhere:9:9' })).not.toThrow();
    frame();
    expect(errors).not.toHaveBeenCalled();
    expect(idle(asteroids)).toBe(true);
  });

  it("Given 'asteroid:destroyed' for a rock beyond the draw distance (never drawn), Then nothing throws and no break-up appears", () => {
    const errors = watchErrors();
    const { belt, ctx, asteroids, frame } = rockRig();
    const FAR = 'ast:test:5:9';
    belt.add(FAR, SHIP.clone().add(new Vector3(ASTEROID_DRAW_KM + 300, 0, 0)), 0.4, 4261);
    frame();
    destroyAndAnnounce(belt, FAR);
    frame();
    expect(errors).not.toHaveBeenCalled();
    expect(idle(asteroids)).toBe(true);
    expect(pieces(asteroids, ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Several at once
// ---------------------------------------------------------------------------

describe('Asteroids — several break-ups share the one draw call (plan 5 task 5)', () => {
  /** Rocks 40 km apart, all in view. */
  const many = (n: number) => {
    const r = rig();
    const ids: string[] = [];
    const at: Vector3[] = [];
    for (let k = 0; k < n; k++) {
      ids.push(`ast:test:7:${k}`);
      at.push(SHIP.clone().add(new Vector3(20 + k * 40, 5, -10)));
      r.belt.add(ids[k]!, at[k]!, 0.3, 5000 + k * 17);
    }
    r.belt.add(OTHER, OTHER_AT, 0.5, 4250);
    r.frame();
    return { ...r, ids, at };
  };

  it('Given two rocks destroyed one second apart, Then while both run both break-ups are drawn in the single extra draw call, and each ends on its own clock', () => {
    const { belt, universe, ctx, asteroids, frame, ids, at } = many(2);
    const t0 = universe.orbitSeconds;
    destroyAndAnnounce(belt, ids[0]!);
    frame();
    universe.orbitSeconds = t0 + 1;
    frame();
    destroyAndAnnounce(belt, ids[1]!);
    frame();
    universe.orbitSeconds = t0 + 1.5;
    frame();
    let ps = pieces(asteroids, ctx);
    expect(near(ps, at[0]!, 5).length, 'first break-up').toBeGreaterThanOrEqual(3);
    expect(near(ps, at[1]!, 5).length, 'second break-up').toBeGreaterThanOrEqual(3);
    expect(extras(asteroids, ctx.scene)).toEqual([asteroids.breakup]);
    const nonEmpty = asteroids.meshes.filter((m) => m.count > 0 && shown(m)).length;
    expect(drawCalls(ctx.scene)).toBe(nonEmpty + 1);

    universe.orbitSeconds = t0 + BREAKUP_S + 0.1; // first over, second at 1.6 s
    frame();
    ps = pieces(asteroids, ctx);
    expect(near(ps, at[0]!, 5)).toEqual([]);
    expect(near(ps, at[1]!, 5).length).toBeGreaterThanOrEqual(3);

    universe.orbitSeconds = t0 + 1 + BREAKUP_S + 0.1;
    frame();
    expect(idle(asteroids)).toBe(true);
  });

  it('Given MAX_BREAKUPS + 1 rocks destroyed in one frame, Then the first MAX_BREAKUPS break up, the extra one is ignored without error, and a slot freed later takes a new one', () => {
    const errors = watchErrors();
    const n = MAX_BREAKUPS + 2;
    const { belt, universe, ctx, asteroids, frame, ids, at } = many(n);
    const t0 = universe.orbitSeconds;
    for (let k = 0; k <= MAX_BREAKUPS; k++) destroyAndAnnounce(belt, ids[k]!);
    frame();
    universe.orbitSeconds = t0 + 0.5;
    frame();
    const ps = pieces(asteroids, ctx);
    for (let k = 0; k < MAX_BREAKUPS; k++) expect(near(ps, at[k]!, 5).length, `rock ${k}`).toBeGreaterThanOrEqual(3);
    expect(near(ps, at[MAX_BREAKUPS]!, 5), 'beyond the cap').toEqual([]);
    expect(slotsOf(asteroids, stubWhich(belt, ctx)).has(ids[MAX_BREAKUPS]!), 'an ignored rock is still destroyed').toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(extras(asteroids, ctx.scene)).toEqual([asteroids.breakup]);

    // All over; the last rock breaks up in a freed slot.
    universe.orbitSeconds = t0 + BREAKUP_S + 0.1;
    frame();
    expect(idle(asteroids)).toBe(true);
    destroyAndAnnounce(belt, ids[n - 1]!);
    frame();
    expect(near(pieces(asteroids, ctx), at[n - 1]!, 5).length).toBeGreaterThanOrEqual(3);
    expect(errors).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Determinism, no Math.random, no allocation
// ---------------------------------------------------------------------------

describe('Asteroids — a break-up is the same on every machine (plan 5 task 5)', () => {
  const runTo = (seed: number, age: number): { data: number[][]; offsets: number[] } => {
    const { belt, universe, ctx, asteroids, frame } = rockRig({ seed });
    const t0 = universe.orbitSeconds;
    destroyAndAnnounce(belt, ROCK);
    frame();
    universe.orbitSeconds = t0 + age;
    frame();
    const offsets = pieces(asteroids, ctx).flatMap((p) => p.world.clone().sub(ROCK_AT).toArray());
    return { data: breakupData(asteroids), offsets };
  };

  it('Given two renderers and the same destroyed rock at the same orbit time, Then their break-up instance data are identical', () => {
    const a = runTo(ROCK_SEED, 1.1);
    const b = runTo(ROCK_SEED, 1.1);
    expect(a.data[0]!.length).toBeGreaterThan(0);
    expect(b.data).toEqual(a.data);
  });

  it('Given two rocks alike but for their seed, Then their pieces lie differently (the layout comes from the seed)', () => {
    const a = runTo(ROCK_SEED, 1.1);
    const b = runTo(ROCK_SEED + 8, 1.1); // same variant, other seed
    expect(a.offsets.length).toBeGreaterThan(0);
    const differ =
      a.offsets.length !== b.offsets.length || a.offsets.some((x, i) => Math.abs(x - b.offsets[i]!) > 1e-6);
    expect(differ).toBe(true);
  });

  it('Given a break-up from event to end, Then Math.random is never called', () => {
    const { belt, universe, asteroids, frame } = rockRig();
    const random = vi.spyOn(Math, 'random');
    const t0 = universe.orbitSeconds;
    destroyAndAnnounce(belt, ROCK);
    for (let i = 0; i <= 30; i++) {
      universe.orbitSeconds = t0 + (i / 30) * (BREAKUP_S + 0.2);
      frame();
    }
    expect(asteroids.breakup.count).toBe(0);
    expect(random).not.toHaveBeenCalled();
  });

  it('Given frames before, during and after two break-ups, Then the break-up mesh, its geometry, its arrays and every aWear array are the same objects throughout (nothing is rebuilt per frame)', () => {
    const { belt, universe, asteroids, frame } = rockRig();
    const b = asteroids.breakup;
    const geometry = b.geometry;
    const matrixArray = b.instanceMatrix.array;
    const attrArrays = new Map(Object.entries(geometry.attributes).map(([k, a]) => [k, a.array]));
    const wearArrays = asteroids.meshes.map((_, v) => wearAttr(asteroids, v).array);
    const check = (): void => {
      expect(asteroids.breakup).toBe(b);
      expect(b.geometry).toBe(geometry);
      expect(b.instanceMatrix.array).toBe(matrixArray);
      expect(new Set(Object.keys(b.geometry.attributes))).toEqual(new Set(attrArrays.keys()));
      for (const [k, arr] of attrArrays) expect(b.geometry.getAttribute(k).array, k).toBe(arr);
      asteroids.meshes.forEach((_, v) => expect(wearAttr(asteroids, v).array).toBe(wearArrays[v]));
    };
    const t0 = universe.orbitSeconds;
    destroyAndAnnounce(belt, ROCK);
    for (let i = 0; i < 40; i++) {
      universe.orbitSeconds = t0 + (i / 40) * (BREAKUP_S + 0.5);
      belt.wearOf.set(OTHER, i / 80);
      frame();
      check();
    }
    destroyAndAnnounce(belt, OTHER);
    frame();
    check();
    expect(idle(asteroids)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('Asteroids — a break-up never outlives its world or its renderer (plan 5 task 5)', () => {
  it('Given a break-up running, When the system changes (or goes), Then it is dropped without error and does not come back', () => {
    const errors = watchErrors();
    const { belt, universe, asteroids, frame } = rockRig();
    destroyAndAnnounce(belt, ROCK);
    frame();
    universe.orbitSeconds += 0.5;
    frame();
    expect(idle(asteroids)).toBe(false);

    const sys = universe.system;
    (universe as { system: unknown }).system = { ...sys }; // another system: another belt
    expect(() => frame()).not.toThrow();
    expect(idle(asteroids)).toBe(true);

    (universe as { system: unknown }).system = sys;
    universe.orbitSeconds += 0.1;
    frame();
    expect(idle(asteroids)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given a break-up running, When the system is left for none (null), Then it is dropped without error', () => {
    const errors = watchErrors();
    const { belt, universe, asteroids, frame } = rockRig();
    destroyAndAnnounce(belt, ROCK);
    frame();
    (universe as { system: unknown }).system = null;
    expect(() => frame()).not.toThrow();
    expect(idle(asteroids)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it("Given a break-up running, When the renderer is disposed, Then its 'asteroid:destroyed' listener is removed and an event after dispose does nothing", () => {
    const errors = watchErrors();
    const subs: Array<{ event: string; off: boolean }> = [];
    const on = bus.on.bind(bus);
    vi.spyOn(bus, 'on').mockImplementation(((event: Parameters<typeof bus.on>[0], fn: Parameters<typeof bus.on>[1]) => {
      const off = on(event, fn);
      const rec = { event: String(event), off: false };
      subs.push(rec);
      return () => {
        rec.off = true;
        off();
      };
    }) as typeof bus.on);

    const { belt, asteroids, frame } = rockRig();
    expect(subs.filter((s) => s.event === 'asteroid:destroyed').length).toBeGreaterThanOrEqual(1);
    destroyAndAnnounce(belt, ROCK);
    frame();
    expect(idle(asteroids)).toBe(false);

    asteroids.dispose();
    for (const s of subs.filter((x) => x.event === 'asteroid:destroyed')) expect(s.off).toBe(true);
    const asked = vi.spyOn(belt, 'asteroidSpecRaw');
    destroyAndAnnounce(belt, OTHER);
    expect(asked).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given a break-up running, When the renderer is disposed, Then every geometry and material it draws with — the break-up\'s included — is disposed', () => {
    const { belt, asteroids, frame } = rockRig();
    destroyAndAnnounce(belt, ROCK);
    frame();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const d of drawables(asteroids.root)) {
      geometries.add(d.geometry);
      for (const m of Array.isArray(d.material) ? d.material : [d.material]) materials.add(m);
    }
    geometries.add(asteroids.breakup.geometry);
    const bm = asteroids.breakup.material;
    for (const m of Array.isArray(bm) ? bm : [bm]) materials.add(m);
    const disposed = new Set<object>();
    for (const g of geometries) g.addEventListener('dispose', () => disposed.add(g));
    for (const m of materials) m.addEventListener('dispose', () => disposed.add(m));

    asteroids.dispose();
    for (const g of geometries) expect(disposed.has(g), `geometry ${g.uuid}`).toBe(true);
    for (const m of materials) expect(disposed.has(m), `material ${m.uuid}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// With the real Belt and WorldState: wear is derived from what was mined, a
// rock loaded empty is not drawn, and a break-up moves with its field.
// ---------------------------------------------------------------------------

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

function realRig(k = 7) {
  const r = beltRig();
  const field = fyssField(k);
  const ship = fieldCentre(field, 0);
  r.world.flight.worldPosition.copy(ship);
  const ctx = nodeCtx();
  ctx.origin.setTo(ship.clone().add(new Vector3(11, -4, 2)));
  ctx.origin.toRender(ship, ctx.camera.position).add(CAM_FROM_SHIP);
  // No cast: the real Belt must satisfy what the renderer reads.
  const asteroids = new Asteroids({ belt: r.belt, universe: r.world });
  live.push(asteroids);
  asteroids.init(ctx);
  /** The Belt alone (its memo, so isDestroyed/wear answer), the renderer not yet. */
  const beltTick = (): void => r.belt.update(1 / 60, r.ctx);
  const frame = (): void => {
    beltTick();
    asteroids.update(1 / 60, ctx);
    asteroids.lateUpdate(1 / 60, ctx);
  };
  /** World position of a rock of this field now, destroyed or not. */
  const rockWorld = (id: string): Vector3 => {
    const a = field.asteroids.find((x) => x.id === id)!;
    return fieldCentre(field, r.world.orbitSeconds).add(new Vector3(...a.offsetKm));
  };
  const which = (p: Vector3): string | null => {
    const rp = new Vector3();
    for (const a of field.asteroids) {
      ctx.origin.toRender(rockWorld(a.id), rp);
      if (rp.distanceTo(p) <= 5e-3) return a.id;
    }
    return null;
  };
  const empty = (id: string, leaveKg = 0): void => {
    const a = field.asteroids.find((x) => x.id === id)!;
    for (const res of RESOURCES) {
      const kg = a.composition[res] - leaveKg;
      if (kg > 0) r.worldState.recordMined(id, res, kg, 'local');
    }
  };
  return { ...r, field, ctx, asteroids, beltTick, frame, rockWorld, which, empty };
}

describe('Asteroids — with the real Belt and WorldState (plan 5 task 5)', () => {
  it('Given a rock in view, When 2 000 kg are mined from it (WorldState.recordMined), Then the next frame its aWear is wearVisual(belt.wear(id)) — up from 0', () => {
    const { belt, worldState, field, asteroids, frame, which } = realRig();
    frame();
    const rock = field.asteroids[0]!;
    const at = slotsOf(asteroids, which).get(rock.id)!;
    expect(at, 'rock drawn').toBeDefined();
    expect(wearAttr(asteroids, at.v).getX(at.slot)).toBeCloseTo(0, 6);

    const res = RESOURCES.reduce((best, x) => (rock.composition[x] > rock.composition[best] ? x : best), 'ice' as Resource);
    worldState.recordMined(rock.id, res, Math.min(2_000, rock.composition[res] / 2), 'local');
    frame();
    expect(belt.wear(rock.id)).toBeGreaterThan(0);
    const now = slotsOf(asteroids, which).get(rock.id)!;
    expect(wearAttr(asteroids, now.v).getX(now.slot)).toBeCloseTo(wearVisual(belt.wear(rock.id)), 6);
    expect(wearAttr(asteroids, now.v).getX(now.slot)).toBeGreaterThan(0);
  });

  it('Given rocks emptied in WorldState before the renderer first looks — one fully, one with dust left (wear < 1) — Then neither is drawn and no break-up appears', () => {
    const { belt, field, asteroids, beltTick, frame, which, empty, ctx } = realRig();
    const [a, b] = [field.asteroids[0]!, field.asteroids[1]!];
    beltTick();
    empty(a.id);
    empty(b.id, 0.3);
    expect(belt.isDestroyed(b.id)).toBe(true);
    expect(belt.wear(b.id)).toBeLessThan(1);
    frame();
    frame();
    const slots = slotsOf(asteroids, which);
    expect(slots.has(a.id)).toBe(false);
    expect(slots.has(b.id)).toBe(false);
    expect(slots.size).toBe(field.asteroids.length - 2);
    expect(idle(asteroids)).toBe(true);
    expect(pieces(asteroids, ctx)).toEqual([]);
  });

  it('Given a rock in view, When the world is restored with it emptied (WorldState.restore, no event), Then it disappears and no break-up appears', () => {
    const { worldState, field, asteroids, frame, which } = realRig();
    frame();
    const rock = field.asteroids[2]!;
    expect(slotsOf(asteroids, which).has(rock.id)).toBe(true);
    worldState.restore(
      RESOURCES.filter((res) => rock.composition[res] > 0).map((res) => ({
        id: rock.id,
        by: 'local' as const,
        resource: res,
        kg: rock.composition[res],
        orbitSeconds: 0,
        wallMs: 0,
      })),
    );
    frame();
    expect(slotsOf(asteroids, which).has(rock.id)).toBe(false);
    expect(idle(asteroids)).toBe(true);
  });

  it('Given a rock mined empty and announced, When a second of orbit time passes, Then the pieces have moved with the rock\'s field (they do not stay at a fixed world point while the field flies on)', () => {
    const { world, field, asteroids, frame, empty, rockWorld, ctx } = realRig();
    frame();
    const rock = [...field.asteroids].sort((x, y) => x.radiusKm - y.radiusKm)[0]!;
    const before = rockWorld(rock.id);
    empty(rock.id);
    bus.emit('asteroid:destroyed', { asteroidId: rock.id });
    frame();
    world.orbitSeconds += 1;
    frame();
    const now = rockWorld(rock.id);
    const tol = 2 * rock.radiusKm + 0.5;
    expect(now.distanceTo(before), 'the field must move far more than the tolerance for this test to mean anything').toBeGreaterThan(3 * tol);
    const ps = pieces(asteroids, ctx);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(centroid(ps).distanceTo(now)).toBeLessThanOrEqual(tol);
  });
});
