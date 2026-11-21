/**
 * v4 sub-plan 5, Task 6 — the mining beam: mining you can see.
 *
 * A beam from the ship's nose to the point on the rock's surface nearest the
 * ship, a glow where it hits, and loose pebbles puffed off at each bite. Drawn
 * from `Mining.operations` (DESIGN-5 §7.8: the list, not the player's ship),
 * so a drone's operation would be drawn the same way.
 *
 * Contract asserted here (the API these tests assume):
 *
 *   new MiningBeams({ mining, universe })
 *     mining:   { readonly operations: readonly MiningOperation[] } — `Mining` satisfies it.
 *               Read every frame; the array and its one operation object are
 *               reused and mutated in place, so nothing may be kept by reference.
 *     universe: { system, orbitSeconds } — `Universe` satisfies it.
 *   .name === 'mining-beams' (gated exactly as 'mining', game/gating.ts)
 *   .root:    Group, a pure translation to the camera's render position (R15,
 *             as Asteroids): every instance translation is world − cameraWorld,
 *             taken in float64 on the CPU.
 *   .beams:   InstancedMesh, one instance per beam. The beam geometry runs along
 *             local +z from 0 to 1: instance i maps local (0,0,0) to the
 *             operation's `source` and local (0,0,1) to its `impact`. Width and
 *             the rest of the look are free.
 *             Per-instance float attribute 'aFade' (0..1) on its geometry.
 *   .glows:   InstancedMesh, the impact glow; the instance translation is the impact.
 *   .pebbles: InstancedMesh, every live pebble; the instance translation is the pebble.
 *   Those three are everything it draws: at most three draw calls in total.
 *   MAX_BEAMS = 8, BEAM_FADE_S = 0.25, MAX_PEBBLES (a positive integer cap).
 *   Materials: ShaderMaterial, the scene contract (toneMapped false, linear —
 *   no colorspace or dither chunk — and all four logdepthbuf chunks); beam
 *   and glow colour in a `uColor` uniform (Color or Vector3), warm white-amber.
 *
 * Clock: the fade and the pebbles run on `universe.orbitSeconds`, like the
 * break-up in Asteroids, so a frozen orbit clock (pause, chart) freezes them.
 * Every frame below passes dt = 1/60 whether or not orbit time moves, so a
 * module that ran on dt would fail the pause tests.
 *
 * Not tested (judged on screenshots): the beam's width and profile, the glow's
 * size, the pebbles' size, number per puff, motion and lifetime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { Resource } from '@/gen/belt';
import { AU } from '@/gen/types';
import type { Mining, MiningOperation } from '@/game/Mining';
import type { Universe } from '@/game/Universe';
import { MODULE_MODES, applyGating } from '@/game/gating';
import { nodeCtx, startSystem } from '@/game/testing/beltFixture';

import { BEAM_FADE_S, MAX_BEAMS, MAX_PEBBLES, MiningBeams } from './MiningBeams';

type Ctx = ReturnType<typeof nodeCtx>;

interface MutVec3 {
  x: number;
  y: number;
  z: number;
}

/** An operation as Mining holds it: one object whose source and impact are mutated in place. */
interface MutOperation {
  asteroidId: string;
  resource: Resource;
  source: MutVec3;
  impact: MutVec3;
}

/**
 * A Mining look-alike. Like Mining it hands out a list it owns, and the
 * tests mutate the operation objects in place between frames. `reads`
 * counts how often `operations` was read.
 */
class FakeMining {
  reads = 0;
  private list: readonly MiningOperation[] = Object.freeze([]);

  get operations(): readonly MiningOperation[] {
    this.reads++;
    return this.list;
  }

  set(ops: readonly MutOperation[]): void {
    this.list = ops;
  }

  clear(): void {
    this.list = Object.freeze([]);
  }
}

// Compile-time only: the real Mining and Universe must satisfy the options (the registry passes them).
function realOptionsCompile(mining: Mining, universe: Universe): ConstructorParameters<typeof MiningBeams>[0] {
  return { mining, universe };
}

/** Every MiningBeams a test builds is disposed after it: no bus listener outlives its test. */
const live: MiningBeams[] = [];
afterEach(() => {
  for (const b of live.splice(0)) b.dispose();
  vi.restoreAllMocks();
});

/** The ship somewhere in a belt, far from the star: float64 matters here. */
const SHIP = new Vector3(2.6 * AU, 0.013 * AU, -0.4 * AU);
/** Camera offset from the ship, km (a chase camera ~40 m behind and above). */
const CAM_FROM_SHIP = new Vector3(0.02, 0.012, -0.035);

/** A direction from a counter, spread over the sphere (golden spiral). */
function dir(i: number, n: number): Vector3 {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return new Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
}

const v3 = (v: Vector3): MutVec3 => ({ x: v.x, y: v.y, z: v.z });
const vec = (p: { x: number; y: number; z: number }): Vector3 => new Vector3(p.x, p.y, p.z);

/**
 * An operation on a rock in direction `d` from the ship: the rock's centre
 * 0.5 km out, radius 0.3, so the impact is 0.2 km out; the nose 5 m out.
 */
function opToward(id: string, d: Vector3, resource: Resource = 'ice'): MutOperation {
  const u = d.clone().normalize();
  return {
    asteroidId: id,
    resource,
    source: v3(SHIP.clone().addScaledVector(u, 0.005)),
    impact: v3(SHIP.clone().addScaledVector(u, 0.2)),
  };
}

const ROCK_A = 'ast:test:6:0';
const ROCK_B = 'ast:test:6:1';

function rig(opts: { far?: boolean } = {}) {
  const mining = new FakeMining();
  const universe = { system: startSystem() as unknown, orbitSeconds: 1_000 };
  const ctx = nodeCtx();
  if (opts.far) ctx.origin.setTo(SHIP.clone().sub(new Vector3(9_000, -2_000, 500)));
  else ctx.origin.setTo(SHIP.clone().add(new Vector3(37, -12, 5)));
  ctx.origin.toRender(SHIP, ctx.camera.position).add(CAM_FROM_SHIP);
  const beams = new MiningBeams({ mining, universe } as unknown as ConstructorParameters<typeof MiningBeams>[0]);
  live.push(beams);
  beams.init(ctx);
  /** One frame: orbit time moves by `orbitDt` (0 = a frozen clock), dt is always 1/60. */
  const frame = (orbitDt = 1 / 60): void => {
    universe.orbitSeconds += orbitDt;
    beams.update(1 / 60, ctx);
    (beams as GameModule).lateUpdate?.(1 / 60, ctx);
  };
  return { mining, universe, ctx, beams, frame };
}

// ---------------------------------------------------------------------------
// Reading what is drawn
// ---------------------------------------------------------------------------

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

/** The mesh's drawn instances: none unless it is in the scene, shown and has instances. */
function drawnCount(mesh: InstancedMesh, ctx: Ctx): number {
  if (!inScene(mesh, ctx.scene) || !shown(mesh)) return 0;
  return mesh.count;
}

/** World position (float64, star frame) of local point `local` of instance i. */
function instanceWorld(mesh: InstancedMesh, i: number, local: Vector3, ctx: Ctx): Vector3 {
  mesh.updateWorldMatrix(true, false);
  const m = new Matrix4();
  mesh.getMatrixAt(i, m);
  m.premultiply(mesh.matrixWorld);
  return local.clone().applyMatrix4(m).add(ctx.origin.offset);
}

interface Beam {
  from: Vector3;
  to: Vector3;
  fade: number;
}

const fadeAttr = (b: MiningBeams): InstancedBufferAttribute =>
  b.beams.geometry.getAttribute('aFade') as InstancedBufferAttribute;

/** Every beam drawn, in world coordinates, with its fade. */
function beamsDrawn(b: MiningBeams, ctx: Ctx): Beam[] {
  const n = drawnCount(b.beams, ctx);
  const out: Beam[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      from: instanceWorld(b.beams, i, new Vector3(0, 0, 0), ctx),
      to: instanceWorld(b.beams, i, new Vector3(0, 0, 1), ctx),
      fade: fadeAttr(b).getX(i),
    });
  }
  return out;
}

/** The drawn beam from `source` to `impact` (to 1 m), or undefined. */
function beamFor(b: MiningBeams, ctx: Ctx, op: { source: MutVec3; impact: MutVec3 }, tolKm = 1e-3): Beam | undefined {
  return beamsDrawn(b, ctx).find((x) => x.from.distanceTo(vec(op.source)) <= tolKm && x.to.distanceTo(vec(op.impact)) <= tolKm);
}

function positionsOf(mesh: InstancedMesh, ctx: Ctx): Vector3[] {
  const n = drawnCount(mesh, ctx);
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) out.push(instanceWorld(mesh, i, new Vector3(0, 0, 0), ctx));
  return out;
}

const glowsAt = (b: MiningBeams, ctx: Ctx): Vector3[] => positionsOf(b.glows, ctx);
const pebblesAt = (b: MiningBeams, ctx: Ctx): Vector3[] => positionsOf(b.pebbles, ctx);

/** Nothing of the beam is drawn. */
function noBeams(b: MiningBeams, ctx: Ctx): boolean {
  return drawnCount(b.beams, ctx) === 0;
}

/** A mesh's per-instance data, in a comparable form. */
function instanceData(mesh: InstancedMesh): number[][] {
  const out: number[][] = [Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16))];
  for (const name of Object.keys(mesh.geometry.attributes).sort()) {
    const attr = mesh.geometry.getAttribute(name);
    if (!(attr instanceof InstancedBufferAttribute)) continue;
    out.push(Array.from((attr.array as Float32Array).slice(0, mesh.count * attr.itemSize)));
  }
  return out;
}

const threeMeshes = (b: MiningBeams): InstancedMesh[] => [b.beams, b.glows, b.pebbles];

function bite(id: string, kg = 250, resource: Resource = 'ice'): void {
  bus.emit('mining:bite', { asteroidId: id, resource, kg });
}

/** console.error, silenced and watched: the bus reports a throwing handler there instead of throwing. */
function watchErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** Half a float32 step at |x| (the instance matrix is a Float32Array), plus 1e-6 km. */
function f32Tol(x: number): number {
  return 1e-6 + Math.abs(x) * 2 ** -24;
}

/** A colour uniform as rgb, whether a Color or a Vector3. */
function colourOf(mat: ShaderMaterial): { r: number; g: number; b: number } {
  const u = mat.uniforms.uColor;
  expect(u, 'uColor uniform').toBeDefined();
  const v = u!.value as { r?: number; g?: number; b?: number; x?: number; y?: number; z?: number };
  return { r: (v.r ?? v.x)!, g: (v.g ?? v.y)!, b: (v.b ?? v.z)! };
}

// ===========================================================================
// The constants and the contract's shape
// ===========================================================================

describe('MiningBeams — constants and shape (plan 5 task 6)', () => {
  it('Given the module, Then MAX_BEAMS is 8, BEAM_FADE_S is 0.25 and MAX_PEBBLES is a positive integer', () => {
    expect(MAX_BEAMS).toBe(8);
    expect(BEAM_FADE_S).toBe(0.25);
    expect(Number.isInteger(MAX_PEBBLES)).toBe(true);
    expect(MAX_PEBBLES).toBeGreaterThan(0);
  });

  it('Given the real Mining and Universe, Then they satisfy the options (checked by the type checker)', () => {
    expect(typeof realOptionsCompile).toBe('function');
  });

  it("Given a new MiningBeams, Then its name is 'mining-beams', it draws with three InstancedMeshes under its root, room for MAX_BEAMS beams and glows and MAX_PEBBLES pebbles, and the beam geometry has a per-instance float 'aFade'", () => {
    const { beams, ctx } = rig();
    expect(beams.name).toBe('mining-beams');
    for (const m of threeMeshes(beams)) {
      expect(m).toBeInstanceOf(InstancedMesh);
      expect(inScene(m, beams.root), m.name).toBe(true);
    }
    expect(inScene(beams.root, ctx.scene)).toBe(true);
    expect(beams.beams.instanceMatrix.count).toBeGreaterThanOrEqual(MAX_BEAMS);
    expect(beams.glows.instanceMatrix.count).toBeGreaterThanOrEqual(MAX_BEAMS);
    expect(beams.pebbles.instanceMatrix.count).toBeGreaterThanOrEqual(MAX_PEBBLES);
    const fade = fadeAttr(beams);
    expect(fade).toBeInstanceOf(InstancedBufferAttribute);
    expect(fade.itemSize).toBe(1);
    expect(fade.count).toBeGreaterThanOrEqual(MAX_BEAMS);
    // The three are all it draws.
    const all = drawables(beams.root);
    expect(all.length).toBeLessThanOrEqual(3);
    for (const d of all) expect(threeMeshes(beams)).toContain(d);
  });
});

// ===========================================================================
// Nothing, then one beam from source to impact
// ===========================================================================

describe('MiningBeams — one beam per operation, from source to impact (plan 5 task 6)', () => {
  it('Given no operations, When frames run, Then nothing is drawn: no beam, glow or pebble instance and zero draw calls', () => {
    const { beams, ctx, frame } = rig();
    for (let i = 0; i < 5; i++) frame();
    expect(drawnCount(beams.beams, ctx)).toBe(0);
    expect(drawnCount(beams.glows, ctx)).toBe(0);
    expect(drawnCount(beams.pebbles, ctx)).toBe(0);
    expect(drawCalls(ctx.scene)).toBe(0);
  });

  it('Given one operation, When a frame runs, Then exactly one beam is drawn, from its source (the nose) to its impact (to 1 m), and one glow sits at the impact (to 5 m)', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0.2, -0.3));
    mining.set([op]);
    frame();
    const drawn = beamsDrawn(beams, ctx);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.from.distanceTo(vec(op.source))).toBeLessThanOrEqual(1e-3);
    expect(drawn[0]!.to.distanceTo(vec(op.impact))).toBeLessThanOrEqual(1e-3);
    const glows = glowsAt(beams, ctx);
    expect(glows).toHaveLength(1);
    expect(glows[0]!.distanceTo(vec(op.impact))).toBeLessThanOrEqual(5e-3);
  });

  it('Given one operation object mutated in place between frames (as Mining does), Then the beam follows its new source and impact the next frame', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    const list = [op];
    mining.set(list);
    frame();
    expect(beamFor(beams, ctx, op)).toBeDefined();
    for (let i = 1; i <= 10; i++) {
      // The ship drifts; Mining rewrites the same objects.
      op.source.x += 0.004;
      op.source.y -= 0.002;
      op.impact.x += 0.003;
      op.impact.z += 0.001;
      frame();
      expect(beamFor(beams, ctx, op), `frame ${i}`).toBeDefined();
      expect(beamsDrawn(beams, ctx)).toHaveLength(1);
    }
  });

  it('Given the operation list replaced by an empty one (the extraction ended), Then the beam does not keep the old array: it starts to fade out the next frame', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(0, 1, 0));
    mining.set([op]);
    frame(0);
    frame(BEAM_FADE_S + 0.05); // fully in
    frame();
    const full = beamFor(beams, ctx, op)!.fade;
    mining.clear();
    frame(0); // the frame the operation is gone
    frame(BEAM_FADE_S * 0.5);
    const b = beamFor(beams, ctx, op);
    expect(b, 'still drawn while fading out').toBeDefined();
    expect(b!.fade).toBeLessThan(full);
  });

  it('Given operations read through the getter, Then MiningBeams reads mining.operations every frame', () => {
    const { mining, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    const before = mining.reads;
    for (let i = 0; i < 5; i++) frame();
    expect(mining.reads - before).toBeGreaterThanOrEqual(5);
  });
});

// ===========================================================================
// Camera-relative (R15, as Asteroids)
// ===========================================================================

describe('MiningBeams — camera-relative instances (R15)', () => {
  it("Given the camera 9 000 km from render zero, Then the beam's instance translation is source − cameraWorld (float64, to a float32 step), its local (0,0,1) lands on impact − cameraWorld, and the glow's translation is impact − cameraWorld (to 5 m)", () => {
    const { mining, beams, ctx, frame } = rig({ far: true });
    expect(ctx.camera.position.length()).toBeGreaterThan(9_000);
    const op = opToward(ROCK_A, new Vector3(0.3, -0.8, 0.5));
    mining.set([op]);
    frame();
    const cam = ctx.origin.offset.clone().add(ctx.camera.getWorldPosition(new Vector3())); // float64

    expect(drawnCount(beams.beams, ctx)).toBe(1);
    const m = new Matrix4();
    beams.beams.getMatrixAt(0, m);
    const t = new Vector3().setFromMatrixPosition(m);
    const ex = op.source.x - cam.x;
    const ey = op.source.y - cam.y;
    const ez = op.source.z - cam.z;
    expect(Math.abs(t.x - ex)).toBeLessThanOrEqual(f32Tol(ex));
    expect(Math.abs(t.y - ey)).toBeLessThanOrEqual(f32Tol(ey));
    expect(Math.abs(t.z - ez)).toBeLessThanOrEqual(f32Tol(ez));
    expect(t.length()).toBeLessThan(1); // a beam next to the camera, not a 9 000 km translation

    const end = new Vector3(0, 0, 1).applyMatrix4(m);
    const im = vec(op.impact).sub(cam);
    expect(end.distanceTo(im)).toBeLessThanOrEqual(1e-5);

    expect(drawnCount(beams.glows, ctx)).toBe(1);
    beams.glows.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixPosition(m).distanceTo(im)).toBeLessThanOrEqual(5e-3);
  });

  it("Given the root, Then it is a pure translation at the camera's render position, and it follows the camera the next frame", () => {
    const { mining, beams, ctx, frame } = rig({ far: true });
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    expect(beams.root.position.distanceTo(ctx.camera.getWorldPosition(new Vector3()))).toBeLessThanOrEqual(1e-9);
    expect(beams.root.quaternion.angleTo(new Quaternion())).toBeLessThanOrEqual(1e-12);
    expect(beams.root.scale.equals(new Vector3(1, 1, 1))).toBe(true);
    ctx.camera.position.add(new Vector3(1.5, -0.25, 3));
    frame();
    expect(beams.root.position.distanceTo(ctx.camera.getWorldPosition(new Vector3()))).toBeLessThanOrEqual(1e-9);
  });

  it('Given a beam and a camera that moves, Then the beam stays on the same world endpoints', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(-0.4, 0.1, 1));
    mining.set([op]);
    frame();
    expect(beamFor(beams, ctx, op)).toBeDefined();
    ctx.camera.position.add(new Vector3(0.03, -0.01, 0.02));
    frame();
    expect(beamFor(beams, ctx, op)).toBeDefined();
  });

  it('Given the vertex shaders, Then each uses modelViewMatrix with instanceMatrix and never viewMatrix * modelMatrix', () => {
    const { beams } = rig();
    for (const mesh of threeMeshes(beams)) {
      const vs = (mesh.material as ShaderMaterial).vertexShader;
      expect(vs, mesh.name).toMatch(/modelViewMatrix\s*\*\s*instanceMatrix/);
      expect(vs, mesh.name).not.toMatch(/viewMatrix\s*\*\s*modelMatrix/);
      expect(vs, mesh.name).not.toMatch(/projectionMatrix\s*\*\s*viewMatrix/);
    }
  });
});

// ===========================================================================
// The fade, in and out, on the orbit clock
// ===========================================================================

describe('MiningBeams — the beam fades in and out over BEAM_FADE_S of orbit time (plan 5 task 6)', () => {
  it('Given an operation that appears, Then its fade starts low, rises without ever falling, is part-way at BEAM_FADE_S / 2 and full (≥ 0.999) from BEAM_FADE_S on', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    mining.set([op]);
    frame(0);
    const fades = [beamFor(beams, ctx, op)!.fade];
    expect(fades[0]!).toBeLessThan(0.5);
    for (let i = 1; i <= 10; i++) {
      frame(BEAM_FADE_S / 10);
      const b = beamFor(beams, ctx, op);
      expect(b, `step ${i}`).toBeDefined();
      fades.push(b!.fade);
      if (i === 5) {
        expect(b!.fade).toBeGreaterThan(0.2);
        expect(b!.fade).toBeLessThan(0.8);
      }
    }
    for (let i = 1; i < fades.length; i++) expect(fades[i]!, `step ${i}`).toBeGreaterThanOrEqual(fades[i - 1]! - 1e-6);
    expect(fades[10]!).toBeGreaterThanOrEqual(0.999);
    frame(1);
    expect(beamFor(beams, ctx, op)!.fade).toBeGreaterThanOrEqual(0.999);
    for (const f of fades) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('Given a full beam whose operation disappears, Then it keeps its last endpoints, fades without ever rising, is part-way at BEAM_FADE_S / 2, and is gone after BEAM_FADE_S', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(0.2, 1, 0));
    const last = { source: { ...op.source }, impact: { ...op.impact } };
    mining.set([op]);
    frame(0);
    frame(BEAM_FADE_S + 0.1);
    frame();
    mining.clear();
    frame(0); // the frame the operation is gone
    let prev = beamFor(beams, ctx, last)!.fade;
    expect(prev).toBeGreaterThan(0.8);
    for (let i = 1; i <= 9; i++) {
      frame(BEAM_FADE_S / 10);
      const b = beamFor(beams, ctx, last);
      expect(b, `step ${i}: the fading beam left its last endpoints`).toBeDefined();
      expect(b!.fade, `step ${i}`).toBeLessThanOrEqual(prev + 1e-6);
      if (i === 5) {
        expect(b!.fade).toBeGreaterThan(0.2);
        expect(b!.fade).toBeLessThan(0.8);
      }
      prev = b!.fade;
    }
    frame(BEAM_FADE_S / 10 + 0.01);
    expect(noBeams(beams, ctx)).toBe(true);
    frame(1);
    expect(noBeams(beams, ctx)).toBe(true);
  });

  it('Given a fading-out beam, When Mining reuses the same operation object for a new extraction on another rock, Then the old beam fades out where it was and a new beam fades in from low toward the new rock', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    const lastA = { source: { ...op.source }, impact: { ...op.impact } };
    const list = [op];
    mining.set(list);
    frame(0);
    frame(BEAM_FADE_S + 0.1);
    mining.clear(); // B again: the extraction stops
    frame();
    // The next extraction, a frame later, on the same object.
    const b = opToward(ROCK_B, new Vector3(0, 0, 1), 'metal');
    op.asteroidId = b.asteroidId;
    op.resource = b.resource;
    Object.assign(op.source, b.source);
    Object.assign(op.impact, b.impact);
    mining.set(list);
    frame();
    const old = beamFor(beams, ctx, lastA);
    const fresh = beamFor(beams, ctx, op);
    expect(old, 'the old beam vanished or jumped').toBeDefined();
    expect(fresh, 'no beam toward the new rock').toBeDefined();
    expect(old!.fade).toBeLessThan(1);
    expect(fresh!.fade).toBeLessThan(0.5);
    expect(beamsDrawn(beams, ctx)).toHaveLength(2);
  });

  it('Given a fading-out beam, When the reused operation object is changed afterwards, Then the beam stays at the endpoints it last saw (no reference kept)', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    const last = { source: { ...op.source }, impact: { ...op.impact } };
    mining.set([op]);
    frame(0);
    frame(BEAM_FADE_S + 0.1);
    mining.clear();
    frame();
    op.source.x += 5;
    op.impact.y -= 5;
    frame(BEAM_FADE_S * 0.3);
    expect(beamFor(beams, ctx, last)).toBeDefined();
    expect(beamsDrawn(beams, ctx)).toHaveLength(1);
  });

  it('Given an operation that ends while still fading in, Then the fade never rises above where it was and the beam is gone BEAM_FADE_S later', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 1, 0));
    const last = { source: { ...op.source }, impact: { ...op.impact } };
    mining.set([op]);
    frame(0);
    frame(BEAM_FADE_S * 0.4);
    const at = beamFor(beams, ctx, op)!.fade;
    expect(at).toBeLessThan(0.999);
    mining.clear();
    frame(0); // the frame the operation is gone
    for (let i = 0; i < 5; i++) {
      frame(BEAM_FADE_S / 5 - 0.001);
      const b = beamFor(beams, ctx, last);
      if (b) expect(b.fade, `step ${i}`).toBeLessThanOrEqual(at + 1e-6);
    }
    frame(0.02);
    expect(noBeams(beams, ctx)).toBe(true);
  });

  it('Given a beam half faded in and a frozen orbit clock (pause), When 300 frames pass, Then its fade does not move; when the clock runs again it does', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    mining.set([op]);
    frame(0);
    frame(BEAM_FADE_S * 0.5);
    const f = beamFor(beams, ctx, op)!.fade;
    for (let i = 0; i < 300; i++) frame(0);
    expect(beamFor(beams, ctx, op)!.fade).toBe(f);
    frame(BEAM_FADE_S * 0.25);
    expect(beamFor(beams, ctx, op)!.fade).toBeGreaterThan(f);
  });

  it('Given a beam fading out and a frozen orbit clock, When 300 frames pass, Then it neither fades further nor disappears', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(0, 1, 0));
    const last = { source: { ...op.source }, impact: { ...op.impact } };
    mining.set([op]);
    frame(0);
    frame(BEAM_FADE_S + 0.1);
    mining.clear();
    frame(0);
    frame(BEAM_FADE_S * 0.4);
    const f = beamFor(beams, ctx, last)!.fade;
    for (let i = 0; i < 300; i++) frame(0);
    const b = beamFor(beams, ctx, last);
    expect(b).toBeDefined();
    expect(b!.fade).toBe(f);
  });

  it('Given a beam fading out, When the orbit clock jumps backwards (a restore), Then nothing throws and the beam is gone no later than BEAM_FADE_S of orbit time after the jump', () => {
    const errors = watchErrors();
    const { mining, universe, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame(BEAM_FADE_S + 0.1);
    mining.clear();
    frame(BEAM_FADE_S * 0.3);
    universe.orbitSeconds -= 500;
    expect(() => frame(0)).not.toThrow();
    frame(BEAM_FADE_S + 0.01);
    expect(noBeams(beams, ctx)).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Eight beams, a ninth ignored, three draw calls whatever the count
// ===========================================================================

describe('MiningBeams — at most three draw calls, whatever the number of beams (plan 5 task 6)', () => {
  const ops = (n: number): MutOperation[] => {
    const out: MutOperation[] = [];
    for (let i = 0; i < n; i++) out.push(opToward(`ast:test:8:${i}`, dir(i, n)));
    return out;
  };

  it('Given one operation with a bite, Then the draw calls are at least one and at most three', () => {
    const { mining, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame(BEAM_FADE_S);
    bite(ROCK_A);
    frame();
    expect(drawnCount(beams.beams, ctx)).toBe(1);
    expect(drawCalls(ctx.scene)).toBeGreaterThanOrEqual(1);
    expect(drawCalls(ctx.scene)).toBeLessThanOrEqual(3);
  });

  it('Given eight operations, each with a bite, Then eight beams (each from its source to its impact), eight glows, pebbles, and still at most three draw calls from at most three drawables', () => {
    const { mining, beams, ctx, frame } = rig();
    const list = ops(MAX_BEAMS);
    mining.set(list);
    frame(BEAM_FADE_S);
    for (const op of list) bite(op.asteroidId);
    frame();
    expect(beamsDrawn(beams, ctx)).toHaveLength(MAX_BEAMS);
    for (const op of list) expect(beamFor(beams, ctx, op), op.asteroidId).toBeDefined();
    const glows = glowsAt(beams, ctx);
    expect(glows).toHaveLength(MAX_BEAMS);
    for (const op of list) expect(glows.some((g) => g.distanceTo(vec(op.impact)) <= 5e-3), op.asteroidId).toBe(true);
    expect(drawnCount(beams.pebbles, ctx)).toBeGreaterThan(0);
    expect(drawCalls(ctx.scene)).toBeLessThanOrEqual(3);
    expect(drawables(ctx.scene).length).toBeLessThanOrEqual(3);
  });

  it('Given nine operations, Then the first eight are drawn, the ninth is ignored without error, and the draw calls stay at most three', () => {
    const errors = watchErrors();
    const { mining, beams, ctx, frame } = rig();
    const list = ops(MAX_BEAMS + 1);
    mining.set(list);
    expect(() => frame(BEAM_FADE_S)).not.toThrow();
    for (const op of list) bite(op.asteroidId);
    expect(() => frame()).not.toThrow();
    expect(beamsDrawn(beams, ctx)).toHaveLength(MAX_BEAMS);
    for (let i = 0; i < MAX_BEAMS; i++) expect(beamFor(beams, ctx, list[i]!), `operation ${i}`).toBeDefined();
    expect(beamFor(beams, ctx, list[MAX_BEAMS]!), 'the ninth').toBeUndefined();
    expect(drawnCount(beams.glows, ctx)).toBeLessThanOrEqual(MAX_BEAMS);
    expect(drawCalls(ctx.scene)).toBeLessThanOrEqual(3);
    expect(drawables(ctx.scene).length).toBeLessThanOrEqual(3);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given eight beams that all end, Then once they have faded and the pebbles are gone there are zero draw calls again', () => {
    const { mining, beams, ctx, frame } = rig();
    const list = ops(MAX_BEAMS);
    mining.set(list);
    frame(BEAM_FADE_S);
    for (const op of list) bite(op.asteroidId);
    frame();
    mining.clear();
    frame(0); // the frame the operations are gone
    frame(BEAM_FADE_S + 0.01);
    expect(noBeams(beams, ctx)).toBe(true);
    frame(60); // far past any pebble's life
    frame();
    expect(drawnCount(beams.pebbles, ctx)).toBe(0);
    expect(drawnCount(beams.glows, ctx)).toBe(0);
    expect(drawCalls(ctx.scene)).toBe(0);
  });
});

// ===========================================================================
// Pebbles: a puff at each bite, a fixed cap
// ===========================================================================

describe("MiningBeams — each 'mining:bite' puffs pebbles off the impact (plan 5 task 6)", () => {
  it('Given an operation and no bite yet, Then no pebble is drawn', () => {
    const { mining, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    for (let i = 0; i < 10; i++) frame();
    expect(drawnCount(beams.pebbles, ctx)).toBe(0);
  });

  it("Given an operation, When a bite on its rock arrives, Then pebbles appear the same frame, every one within 50 m of that operation's impact", () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(0.3, 0.6, -0.7));
    mining.set([op]);
    frame();
    bite(ROCK_A);
    frame(0);
    const ps = pebblesAt(beams, ctx);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(p.distanceTo(vec(op.impact))).toBeLessThanOrEqual(0.05);
  });

  it("Given two operations on two rocks, When a bite on rock A arrives, Then the pebbles are at A's impact and none at B's", () => {
    const { mining, beams, ctx, frame } = rig();
    const a = opToward(ROCK_A, new Vector3(1, 0, 0));
    const b = opToward(ROCK_B, new Vector3(-1, 0, 0));
    mining.set([a, b]);
    frame();
    bite(ROCK_A);
    frame(0);
    const ps = pebblesAt(beams, ctx);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.distanceTo(vec(a.impact))).toBeLessThanOrEqual(0.05);
      expect(p.distanceTo(vec(b.impact))).toBeGreaterThan(0.1);
    }
  });

  it('Given the operation mutated in place to a new impact, When a bite arrives, Then the pebbles are at the new impact, not the old', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    mining.set([op]);
    frame();
    const old = vec(op.impact);
    op.impact.y += 0.15;
    op.impact.z -= 0.1;
    bite(ROCK_A);
    frame(0);
    const ps = pebblesAt(beams, ctx);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p.distanceTo(vec(op.impact))).toBeLessThanOrEqual(0.05);
      expect(p.distanceTo(old)).toBeGreaterThan(0.1);
    }
  });

  it('Given the last bite of a rock (Mining emits the bite, then ends the extraction in the same update), Then that bite still puffs pebbles at the impact', () => {
    const { mining, beams, ctx, frame } = rig();
    const op = opToward(ROCK_A, new Vector3(0, 0, 1));
    const impact = vec(op.impact);
    mining.set([op]);
    frame();
    bite(ROCK_A);
    mining.clear();
    frame(0);
    const ps = pebblesAt(beams, ctx);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(p.distanceTo(impact)).toBeLessThanOrEqual(0.05);
  });

  it('Given a bite for a rock with no current operation (or no operations at all), Then nothing throws, no handler error is reported, and no pebble appears', () => {
    const errors = watchErrors();
    const { mining, beams, ctx, frame } = rig();
    frame();
    expect(() => bite(ROCK_A)).not.toThrow();
    frame(0);
    expect(drawnCount(beams.pebbles, ctx)).toBe(0);
    mining.set([opToward(ROCK_B, new Vector3(1, 0, 0))]);
    frame();
    expect(() => bite(ROCK_A)).not.toThrow();
    frame(0);
    expect(drawnCount(beams.pebbles, ctx)).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given time compression (forty bites a frame for fifty frames), Then the live pebbles never exceed MAX_PEBBLES, there are some, and nothing throws', () => {
    const errors = watchErrors();
    const { mining, universe, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    let most = 0;
    for (let f = 0; f < 50; f++) {
      universe.orbitSeconds += 100 / 60; // Universe first, then Mining's bites, then the beams
      for (let k = 0; k < 40; k++) bite(ROCK_A, 1.7);
      frame(0);
      const n = drawnCount(beams.pebbles, ctx);
      expect(n, `frame ${f}`).toBeLessThanOrEqual(MAX_PEBBLES);
      expect(beams.pebbles.count, `frame ${f}`).toBeLessThanOrEqual(MAX_PEBBLES);
      most = Math.max(most, n);
    }
    expect(most).toBeGreaterThan(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given MAX_PEBBLES × 4 bites in one frame, Then the live pebbles are at most MAX_PEBBLES', () => {
    const { mining, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    for (let k = 0; k < MAX_PEBBLES * 4; k++) bite(ROCK_A);
    frame(0);
    expect(drawnCount(beams.pebbles, ctx)).toBeGreaterThan(0);
    expect(beams.pebbles.count).toBeLessThanOrEqual(MAX_PEBBLES);
  });

  it('Given pebbles in flight and a frozen orbit clock (pause), When 300 frames pass, Then they are exactly where they were; when the clock runs again they change', () => {
    const { mining, beams, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    bite(ROCK_A);
    frame(0.05);
    const before = instanceData(beams.pebbles);
    expect(before[0]!.length).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) frame(0);
    expect(instanceData(beams.pebbles)).toEqual(before);
    frame(0.2);
    expect(instanceData(beams.pebbles)).not.toEqual(before);
  });

  it('Given pebbles and no more bites, When a minute of orbit time passes, Then none are left', () => {
    const { mining, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    bite(ROCK_A);
    frame(0);
    expect(drawnCount(beams.pebbles, ctx)).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) frame(1);
    expect(drawnCount(beams.pebbles, ctx)).toBe(0);
  });
});

// ===========================================================================
// The scene's contract and the colour
// ===========================================================================

describe('MiningBeams — materials follow the HDR scene and the beam is warm white-amber (plan 5 task 6)', () => {
  it('Given the three materials, Then each is a ShaderMaterial, toneMapped false, linear (no colorspace or dither chunk) and with all four logdepthbuf chunks', () => {
    const { beams } = rig();
    for (const mesh of threeMeshes(beams)) {
      const mat = mesh.material as ShaderMaterial;
      expect(mat, mesh.name).toBeInstanceOf(ShaderMaterial);
      expect(mat.toneMapped, mesh.name).toBe(false);
      expect(mat.vertexShader).toContain('#include <logdepthbuf_pars_vertex>');
      expect(mat.vertexShader).toContain('#include <logdepthbuf_vertex>');
      expect(mat.fragmentShader).toContain('#include <logdepthbuf_pars_fragment>');
      expect(mat.fragmentShader).toContain('#include <logdepthbuf_fragment>');
      expect(mat.fragmentShader).not.toContain('colorspace_fragment');
      expect(mat.fragmentShader).not.toContain('dithering_fragment');
    }
  });

  it("Given the beam's and the glow's uColor, Then each is warm white-amber: r ≥ g > b ≥ 0, g at least 0.4 r (amber, not red), and never cyan (b < r)", () => {
    const { beams } = rig();
    for (const mesh of [beams.beams, beams.glows]) {
      const { r, g, b } = colourOf(mesh.material as ShaderMaterial);
      expect(r, mesh.name).toBeGreaterThan(0);
      expect(r, mesh.name).toBeGreaterThanOrEqual(g);
      expect(g, mesh.name).toBeGreaterThan(b);
      expect(b, mesh.name).toBeGreaterThanOrEqual(0);
      expect(g, mesh.name).toBeGreaterThanOrEqual(0.4 * r);
      expect(b, mesh.name).toBeLessThan(r);
    }
  });
});

// ===========================================================================
// The same everywhere, and nothing rebuilt per frame
// ===========================================================================

describe('MiningBeams — deterministic, nothing rebuilt per frame (plan 5 task 6)', () => {
  const script = (r: ReturnType<typeof rig>): void => {
    const a = opToward(ROCK_A, new Vector3(1, 0.1, 0));
    const b = opToward(ROCK_B, new Vector3(-0.2, 1, 0.3));
    r.mining.set([a, b]);
    r.frame(0);
    for (let i = 0; i < 20; i++) {
      a.impact.x += 0.001;
      if (i % 3 === 0) bite(ROCK_A);
      if (i % 4 === 1) bite(ROCK_B);
      if (i === 12) r.mining.set([b]);
      r.frame(1 / 60);
    }
  };

  it('Given two renderers fed the same operations, bites and orbit times, Then their beam, glow and pebble instance data are identical', () => {
    const one = rig();
    script(one);
    const a = threeMeshes(one.beams).map(instanceData);
    const two = rig();
    script(two);
    const b = threeMeshes(two.beams).map(instanceData);
    expect(a[2]![0]!.length, 'pebbles were drawn').toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('Given beams appearing, fading, nine operations and many bites, Then Math.random is never called', () => {
    const r = rig();
    const random = vi.spyOn(Math, 'random');
    script(r);
    const nine: MutOperation[] = [];
    for (let i = 0; i < 9; i++) nine.push(opToward(`ast:test:8:${i}`, dir(i, 9)));
    r.mining.set(nine);
    for (let i = 0; i < 30; i++) {
      for (const op of nine) bite(op.asteroidId);
      r.frame(1 / 60);
    }
    r.mining.clear();
    for (let i = 0; i < 30; i++) r.frame(0.1);
    expect(random).not.toHaveBeenCalled();
  });

  it('Given frames with no operations, one, nine, bites and fade-outs, Then the three meshes, their geometries, materials, instance matrix arrays and every attribute array are the same objects throughout', () => {
    const r = rig();
    const { beams } = r;
    const meshes = threeMeshes(beams);
    const geometries = meshes.map((m) => m.geometry);
    const materials = meshes.map((m) => m.material);
    const matrices = meshes.map((m) => m.instanceMatrix.array);
    const attrs = meshes.map((m) => new Map(Object.entries(m.geometry.attributes).map(([k, a]) => [k, a.array])));
    const check = (when: string): void => {
      const now = threeMeshes(beams);
      now.forEach((m, i) => {
        expect(m, when).toBe(meshes[i]);
        expect(m.geometry, when).toBe(geometries[i]);
        expect(m.material, when).toBe(materials[i]);
        expect(m.instanceMatrix.array, when).toBe(matrices[i]);
        expect(new Set(Object.keys(m.geometry.attributes)), when).toEqual(new Set(attrs[i]!.keys()));
        for (const [k, arr] of attrs[i]!) expect(m.geometry.getAttribute(k).array, `${when} ${k}`).toBe(arr);
      });
      expect(drawables(beams.root).length, when).toBeLessThanOrEqual(3);
    };
    r.frame();
    check('empty');
    const op = opToward(ROCK_A, new Vector3(1, 0, 0));
    r.mining.set([op]);
    for (let i = 0; i < 20; i++) {
      op.source.y += 0.001;
      bite(ROCK_A);
      r.frame();
      check(`one, frame ${i}`);
    }
    const nine: MutOperation[] = [];
    for (let i = 0; i < 9; i++) nine.push(opToward(`ast:test:8:${i}`, dir(i, 9)));
    r.mining.set(nine);
    for (let i = 0; i < 10; i++) {
      for (const o of nine) bite(o.asteroidId);
      r.frame();
      check(`nine, frame ${i}`);
    }
    r.mining.clear();
    for (let i = 0; i < 20; i++) {
      r.frame(0.05);
      check(`fading, frame ${i}`);
    }
  });
});

// ===========================================================================
// Lifecycle: dispose, another system, leaving flight
// ===========================================================================

describe('MiningBeams — nothing outlives its world, its mode or its module (plan 5 task 6)', () => {
  it("Given a beam with pebbles, When it is disposed, Then its 'mining:bite' listener is removed and a bite afterwards does nothing (no read of operations, no error)", () => {
    const errors = watchErrors();
    startSystem(); // the shared Universe exists before the spy: every subscription below is the module's
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

    const { mining, beams, frame } = rig();
    expect(subs.filter((s) => s.event === 'mining:bite').length).toBeGreaterThanOrEqual(1);
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    bite(ROCK_A);
    frame();

    beams.dispose();
    for (const s of subs) expect(s.off, s.event).toBe(true);
    const reads = mining.reads;
    bite(ROCK_A);
    expect(mining.reads).toBe(reads);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given a beam with pebbles, When it is disposed, Then every geometry and material it draws with is disposed and its root has left the scene', () => {
    const { mining, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame();
    bite(ROCK_A);
    frame();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const d of [...drawables(beams.root), ...threeMeshes(beams)]) {
      geometries.add(d.geometry);
      for (const m of Array.isArray(d.material) ? d.material : [d.material]) materials.add(m);
    }
    const disposed = new Set<object>();
    for (const g of geometries) g.addEventListener('dispose', () => disposed.add(g));
    for (const m of materials) m.addEventListener('dispose', () => disposed.add(m));

    beams.dispose();
    for (const g of geometries) expect(disposed.has(g), `geometry ${g.uuid}`).toBe(true);
    for (const m of materials) expect(disposed.has(m), `material ${m.uuid}`).toBe(true);
    expect(inScene(beams.root, ctx.scene)).toBe(false);
  });

  it('Given a beam and pebbles, When the system changes (a jump) and the operation is gone, Then everything is dropped at once — no fade-out, no pebbles — without error, and nothing comes back', () => {
    const errors = watchErrors();
    const { mining, universe, beams, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame(BEAM_FADE_S + 0.1);
    bite(ROCK_A);
    frame();
    expect(drawCalls(ctx.scene)).toBeGreaterThan(0);

    const sys = universe.system as object;
    universe.system = { ...sys };
    mining.clear();
    expect(() => frame()).not.toThrow();
    expect(drawCalls(ctx.scene)).toBe(0);
    frame();
    expect(drawCalls(ctx.scene)).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given a beam and pebbles, When the system is left for none (null), Then everything is dropped without error', () => {
    const errors = watchErrors();
    const { mining, universe, ctx, frame } = rig();
    mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
    frame(BEAM_FADE_S + 0.1);
    bite(ROCK_A);
    frame();
    universe.system = null;
    mining.clear();
    expect(() => frame()).not.toThrow();
    expect(drawCalls(ctx.scene)).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given a beam and pebbles, When the mode leaves flight (map, Yard or title), Then nothing is drawn at once, and back in flight with no operation nothing returns even on a frozen clock', () => {
    for (const to of ['map', 'yard', 'title'] as const) {
      const { mining, beams, ctx, frame } = rig();
      mining.set([opToward(ROCK_A, new Vector3(1, 0, 0))]);
      frame(BEAM_FADE_S + 0.1);
      bite(ROCK_A);
      frame();
      expect(drawCalls(ctx.scene), to).toBeGreaterThan(0);
      mining.clear(); // Mining ends the extraction when flight is left
      (beams as GameModule).onModeChange?.('flight', to, ctx);
      expect(drawCalls(ctx.scene), to).toBe(0);
      (beams as GameModule).onModeChange?.(to, 'flight', ctx);
      frame(0);
      expect(drawCalls(ctx.scene), `${to} → flight`).toBe(0);
    }
  });
});

// ===========================================================================
// Gating and registration
// ===========================================================================

describe('MiningBeams — sleeps whenever Mining sleeps, and is registered (plan 5 task 6)', () => {
  it("Given the gating table, Then 'mining-beams' is listed and ticks in exactly the modes 'mining' ticks in", () => {
    expect(MODULE_MODES['mining-beams']).toBeDefined();
    expect(MODULE_MODES['mining-beams']).toEqual(MODULE_MODES['mining']);
  });

  it('Given a MiningBeams, When the table is applied to it, Then its activeIn is that of Mining (its name matches the table)', () => {
    const { beams } = rig();
    applyGating([beams]);
    expect((beams as GameModule).activeIn).toEqual(MODULE_MODES['mining']);
  });

  it('Given registry.ts, Then it imports MiningBeams from render/MiningBeams and builds one after Mining, from that Mining', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../game/registry.ts'), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\bMiningBeams\b[^}]*\}\s*from\s*'@\/render\/MiningBeams'/);
    const mining = src.indexOf('new Mining(');
    const beams = src.indexOf('new MiningBeams(');
    expect(mining).toBeGreaterThanOrEqual(0);
    expect(beams).toBeGreaterThan(mining);
    expect(src.slice(beams, src.indexOf(')', beams))).toMatch(/\bmining\b/);
  });
});
