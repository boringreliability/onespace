/**
 * oneSpace — ship propulsion and VFX.
 *
 * Everything that burns, puffs or blinks: main-drive nozzles, exhaust plumes,
 * RCS jets, navigation/beacon/docking lights and the re-entry wake. It reads a
 * `ShipBlueprint` and nothing else, and it visualises what the blueprint says
 * rather than inventing hardware.
 *
 * THE FIVE DECISIONS THIS FILE IS BUILT ON
 *
 * 1. **The plume is extruded in the vertex shader.** Every plume vertex is
 *    authored at the nozzle mouth and pushed out along the exhaust axis by
 *    per-instance attributes. Length, width, taper, wobble and shock spacing
 *    are therefore free to animate: no geometry is ever rebuilt, and a 5 km
 *    torch and a 0.4 m attitude jet share one buffer.
 *
 * 2. **Drive technology is a SHAPE, not a tint.** A fusion torch is a long
 *    collimated column off a deep bell; an ion drive is a flat perforated grid
 *    with a wide, faint, diverging fan and no shock structure at all; a
 *    reaction plate is a disc with no nozzle that flashes in discrete
 *    detonations. If the only difference between two drives were their colour
 *    this file would have failed its brief.
 *
 * 3. **Two materials, four draw calls.** BRIEF §6 allows three materials per
 *    ship and `ShipMaterial.ts` owns one of them, so propulsion owns exactly
 *    two: an opaque nozzle material (the only thing here that needs
 *    `DoubleSide` + `gl_FrontFacing`) and ONE additive material shared by
 *    plumes, jets, lights and the wake, branching on a per-instance `iKind`.
 *    Everything is instanced; a ten-engine capital costs the same number of
 *    draw calls as a single-engine courier.
 *
 * 4. **Nothing is authored in metres.** Nozzle geometry is built in a unit
 *    envelope (exit radius 1, length 1) and scaled per instance, and every
 *    noise frequency in the nozzle shader is evaluated in that unit space. A
 *    4 km capital's bell therefore gets the same corrugation pitch *relative
 *    to itself* as a courier's, instead of the 133×-too-fine grain that
 *    kilometre-space constants would give it.
 *
 * 5. **Emitters carry a screen-space floor.** A navigation light on a 4 km
 *    hull is a sub-pixel object at any range you would actually look at the
 *    ship from. Each emitter quad is expanded in the vertex shader so it never
 *    falls below a few pixels, which is what makes a capital read as inhabited
 *    instead of as an unlit slab.
 *
 * SCENE CONTRACT. The scene is linear HDR and `PostFX` owns the tone map:
 * every material here is `toneMapped: false` with no `<tonemapping_fragment>`,
 * no `<colorspace_fragment>` and no `os_dither`. All four `logdepthbuf` chunks
 * are present in every program — the engine runs a logarithmic depth buffer and
 * a material that omits them sorts wrongly against every planet in the game.
 *
 * UNITS: kilometres, seconds, linear RGB. Ship-local frame is -Z forward,
 * +Y up, +X starboard; an engine's `frame.forward` is the EXHAUST direction.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings, QualityTier } from '@/core/Config';
import type { ViewState } from '@/render/ViewState';
import { registerShaderChunks } from '@/shaders/chunks';
import type {
  EnginePod,
  Frame,
  NozzleStyle,
  RcsGroup,
  ShipBlueprint,
  TechnologyProfile,
} from '@/gen/ships/types';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * What the pilot is asking the drive to do, this frame.
 *
 * Deliberately separate from `ViewState`: `ViewState` says where the camera and
 * the star are, this says what the ship is doing. `Ship.ts`'s `ShipState` is
 * the ancestor of this type and is a genuinely good little contract; this adds
 * the two things a *generated* ship needs that the hero ship did not — an
 * angular command (so the blueprint's `RcsGroup` couples can be honoured rather
 * than guessed from geometry) and a power flag (so lights come up with the bus
 * rather than being permanently on).
 *
 * NOTE FOR THE INTEGRATOR: this type is declared here because nothing in
 * `gen/ships/types.ts` declares it and that layer is published/append-only. If
 * it belongs upstream, move it there and re-export from here.
 */
export interface ShipDriveState {
  /** Main engine demand, 0..1. */
  readonly throttle: number;
  /** Overdrive on top of throttle, 0..1. Shifts the plume white-hot. */
  readonly boost: number;
  /** Re-entry heating, 0..1. Drives the plasma wake. */
  readonly heating: number;
  /**
   * Commanded TRANSLATION in ship-local space, roughly -1..1 per axis.
   * A thruster fires when it belongs to a group this vector demands.
   */
  readonly translation: Vector3;
  /**
   * Commanded ROTATION, roughly -1..1 per axis: x = pitch, y = yaw, z = roll.
   * Gimballed main nozzles track pitch and yaw from this too.
   */
  readonly angular: Vector3;
  /** Main bus live. Navigation lights, beacons and throat glow fade with it. */
  readonly powered: boolean;
}

/** A reusable, mutable `ShipDriveState` so the caller's frame loop allocates nothing. */
export class MutableShipDriveState implements ShipDriveState {
  throttle = 0;
  boost = 0;
  heating = 0;
  readonly translation = new Vector3();
  readonly angular = new Vector3();
  powered = true;
}

/**
 * Slots in the fake plume-lighting uniform block.
 *
 * One slot per engine POD, not per nozzle: a cluster of four bells is one light
 * source at any distance you can see the hull glow from, and the eight largest
 * pods are the only ones whose wash is legible anyway. `Ship.ts` had exactly
 * two (`uEngineA`/`uEngineB`) and broke on any ship that was not a twin.
 */
export const ENGINE_GLOW_MAX = 8;

/**
 * GLSL for the hull material to include.
 *
 * "Plumes must light the hull around them" — but a real light per engine is a
 * shadow-mapped, per-fragment cost for something the eye reads as a gradient.
 * This is the gradient: an analytic wash from up to eight column sources,
 * ~10 ALU each, with the falloff length supplied as a uniform so it tracks the
 * plume's own length instead of being a hard-coded metre count (the mistake
 * `Ship.ts` made with `exp(-d * 260.0)`, an e-folding of 3.85 m baked against a
 * 30 m hull).
 *
 * `chunks.ts` is integrator-owned so this cannot be registered as a real
 * `#include` chunk. Concatenate it into the hull fragment shader and alias
 * `ShipPropulsion.engineGlowUniforms` into the hull material's uniform object
 * BY REFERENCE — the values are refreshed in place every frame and must never
 * be copied.
 */
export const ENGINE_GLOW_GLSL = /* glsl */ `
#ifndef SHIP_ENGINE_GLOW_MAX
#define SHIP_ENGINE_GLOW_MAX ${ENGINE_GLOW_MAX}
#endif
uniform vec4  uEngineGlow[SHIP_ENGINE_GLOW_MAX];      // xyz = mouth, w = strength
uniform vec3  uEngineGlowDir[SHIP_ENGINE_GLOW_MAX];   // unit exhaust axis
uniform vec3  uEngineGlowColor;
uniform float uEngineGlowRange;                       // e-folding length, km

/** Radiance added to a hull fragment by the drive plumes. P and N are ship-local. */
vec3 shipEngineGlow(vec3 P, vec3 N) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < SHIP_ENGINE_GLOW_MAX; i++) {
    vec4 g = uEngineGlow[i];
    if (g.w <= 1e-5) continue;
    vec3 d = g.xyz - P;
    float dist = max(length(d), 1e-7);
    vec3 L = d / dist;
    // A plume is a column lying aft of the mouth, so plating that faces INTO
    // the column is washed and plating on the far side of the ship is not.
    // Without this term the whole hull lifts uniformly and reads as ambient.
    float side = clamp(dot(-L, uEngineGlowDir[i]) * 0.5 + 0.5, 0.0, 1.0);
    sum += uEngineGlowColor * g.w
         * exp(-dist / max(uEngineGlowRange, 1e-7))
         * max(dot(N, L), 0.0)
         * mix(0.30, 1.0, side);
  }
  return sum;
}
`;

/** The uniform object `ENGINE_GLOW_GLSL` expects. Alias it; never copy it. */
export interface EngineGlowUniforms {
  readonly uEngineGlow: { value: Float32Array };
  readonly uEngineGlowDir: { value: Float32Array };
  readonly uEngineGlowColor: { value: Color };
  readonly uEngineGlowRange: { value: number };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

interface Budget {
  /** Radial segments round a nozzle. Screen-space property: does NOT grow with the hull. */
  readonly nozzleSeg: number;
  /** Radial segments round a plume shell. */
  readonly plumeSeg: number;
  /** Axial steps along a plume shell. */
  readonly plumeSteps: number;
  /** Nested shells. Two is the minimum that reads as a core inside a envelope. */
  readonly plumeLayers: number;
  readonly wakeSeg: number;
  readonly wakeSteps: number;
  /** Emissive quads never fall below this on screen. */
  readonly minLightPixels: number;
}

const BUDGETS: Record<QualityTier, Budget> = {
  low: { nozzleSeg: 10, plumeSeg: 8, plumeSteps: 6, plumeLayers: 1, wakeSeg: 12, wakeSteps: 8, minLightPixels: 2.0 },
  medium: { nozzleSeg: 14, plumeSeg: 10, plumeSteps: 8, plumeLayers: 2, wakeSeg: 16, wakeSteps: 10, minLightPixels: 2.2 },
  high: { nozzleSeg: 18, plumeSeg: 14, plumeSteps: 9, plumeLayers: 2, wakeSeg: 24, wakeSteps: 13, minLightPixels: 2.5 },
  ultra: { nozzleSeg: 24, plumeSeg: 16, plumeSteps: 11, plumeLayers: 2, wakeSeg: 28, wakeSteps: 15, minLightPixels: 2.5 },
};

/**
 * Above this many nozzles the plume tessellation is halved.
 *
 * A ten-pod capital with four bells each is 40 plume instances of pure additive
 * overdraw. The silhouette of one plume in a rank of forty is not what anyone
 * is looking at; the rank as a whole is.
 */
const PLUME_CROWD_THRESHOLD = 10;

/** Hard cap on emissive fixtures. A super-capital's navlight list can be long. */
const MAX_LIGHTS = 320;

/** Hard cap on drawn RCS nozzles. */
const MAX_JETS = 128;

/** Reference hull length the temporal constants were authored against, km. */
const REFERENCE_LENGTH_KM = 0.03;

/** Additive kinds, matched by the shared shader's `iKind` branch. */
const KIND_PLUME = 0;
const KIND_JET = 1;
const KIND_LIGHT = 2;
const KIND_WAKE = 3;

/** Emissive blink patterns, matched by the shared fragment shader. */
const PATTERN_STEADY = 0;
const PATTERN_STROBE = 1;
const PATTERN_BEACON = 2;
const PATTERN_GUIDE = 3;

/** Drive technology, as a float the shader can branch on. */
const DRIVE_TECH: Record<TechnologyProfile['drive'], number> = {
  chemical: 0,
  ion: 1,
  'fusion-torch': 2,
  plasma: 3,
  'reaction-plate': 4,
};

/**
 * Plume proportion per drive technology, on top of the blueprint's own ratios.
 *
 * The blueprint gives `lengthRatio` per pod, which varies the drive within a
 * culture. These multipliers are what keep the five technologies apart when two
 * factions happen to land on similar ratios — an ion drive must never be able
 * to look like a short fat chemical plume, whatever the seed says.
 */
const PLUME_SHAPE: Record<TechnologyProfile['drive'], readonly [number, number]> = {
  chemical: [1.0, 1.0],
  ion: [1.35, 0.42],
  'fusion-torch': [1.6, 0.6],
  plasma: [1.0, 1.15],
  'reaction-plate': [0.22, 2.2],
};

/** Every RCS group, in the order the per-frame demand array uses. */
const RCS_GROUP_ORDER: readonly RcsGroup[] = [
  'pitch+', 'pitch-', 'yaw+', 'yaw-', 'roll+', 'roll-',
  'x+', 'x-', 'y+', 'y-', 'z+', 'z-',
];

// ---------------------------------------------------------------------------
// Small maths (module scope — never called from update())
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach; `rate` is e-foldings per second. */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// ---------------------------------------------------------------------------
// Geometry accumulator
// ---------------------------------------------------------------------------

/**
 * One merged indexed buffer.
 *
 * Normals are authored per vertex rather than accumulated from faces: every
 * surface here is a surface of revolution whose exact normal is known
 * analytically, and a face-averaged normal on a nozzle lip rounds off the one
 * hard edge that tells you the bell is made of sheet.
 */
class Buf {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly at: number[] = [];
  readonly part: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, t: number, part: number): number {
    const i = this.count;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.at.push(t);
    this.part.push(part);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aT', new BufferAttribute(new Float32Array(this.at), 1));
    g.setAttribute('aPart', new BufferAttribute(new Float32Array(this.part), 1));
    g.setIndex(this.idx);
    return g;
  }
}

/**
 * A ring of `seg` vertices at axial `z`, radius `r`.
 *
 * `slope` is dr/dz of the surface passing through the ring, so the outward
 * normal in the (radial, axial) plane is (1, -slope) normalised. Passing it in
 * rather than differencing adjacent rings is what keeps a hard lip hard.
 */
function ring(b: Buf, seg: number, z: number, r: number, slope: number, t: number, part: number): number {
  const base = b.count;
  const inv = 1 / Math.hypot(1, slope);
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    b.v(cx * r, sy * r, z, cx * inv, sy * inv, -slope * inv, t, part);
  }
  return base;
}

/** Bridge two rings of equal segment count into a quad band, outward-facing. */
function band(b: Buf, lo: number, hi: number, seg: number): void {
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    b.quad(lo + s, lo + s1, hi + s1, hi + s);
  }
}

/** Flat disc at `z`, radius `r`, facing `sign` along Z. Grid faces, plate faces, caps. */
function disc(b: Buf, seg: number, z: number, r: number, t: number, part: number, sign = 1): void {
  const c = b.v(0, 0, z, 0, 0, sign, t, part);
  const base = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    b.v(Math.cos(a) * r, Math.sin(a) * r, z, 0, 0, sign, t, part);
  }
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    if (sign > 0) b.tri(c, base + s, base + s1);
    else b.tri(c, base + s1, base + s);
  }
}

/** A capped tube between two points. Turbopumps, feed pipes, stiffener ribs. */
function tube(
  b: Buf,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number, seg: number, part: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-9;
  const fx = dx / len;
  const fy = dy / len;
  const fz = dz / len;
  // Any perpendicular will do; pick the one furthest from the axis so the
  // cross product never degenerates on an axis-aligned tube.
  let ux = 0;
  let uy = 0;
  let uz = 1;
  if (Math.abs(fz) > 0.9) {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const rx = uy * fz - uz * fy;
  const ry = uz * fx - ux * fz;
  const rz = ux * fy - uy * fx;
  const rl = Math.hypot(rx, ry, rz) || 1e-9;
  const r0x = rx / rl;
  const r0y = ry / rl;
  const r0z = rz / rl;
  const u0x = fy * r0z - fz * r0y;
  const u0y = fz * r0x - fx * r0z;
  const u0z = fx * r0y - fy * r0x;

  const lo = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    const nx = r0x * cx + u0x * sy;
    const ny = r0y * cx + u0y * sy;
    const nz = r0z * cx + u0z * sy;
    b.v(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, 0, part);
  }
  const hi = b.count;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    const nx = r0x * cx + u0x * sy;
    const ny = r0y * cx + u0y * sy;
    const nz = r0z * cx + u0z * sy;
    b.v(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, 1, part);
  }
  band(b, lo, hi, seg);
  // Caps. Flat and hard: a capped tube with smoothed ends reads as a sausage.
  const ca = b.v(ax, ay, az, -fx, -fy, -fz, 0, part);
  const cb = b.v(bx, by, bz, fx, fy, fz, 1, part);
  for (let s = 0; s < seg; s++) {
    const s1 = (s + 1) % seg;
    b.tri(ca, lo + s1, lo + s);
    b.tri(cb, hi + s, hi + s1);
  }
}

// ---------------------------------------------------------------------------
// Nozzle geometry — one unit envelope per style
// ---------------------------------------------------------------------------
//
// Authoring space: axis +Z, throat at z = 0, exit plane at z = 1, exit radius 1.
// The instance carries `iSize = (exitRadius, exitRadius, bellLength)` so the
// vertex shader scales it; `instanceMatrix` stays a RIGID transform so normals
// survive `mat3(instanceMatrix)` without an inverse-transpose.
//
// `aPart`:  0 = wall (front face = outside, back face = throat interior)
//           1 = surface the exhaust washes over (spike, plug) — glows
//           2 = hardware (rims, pumps, pipes, ribs) — never glows
//           3 = emissive face (ion grid, reaction plate)

const PART_WALL = 0;
const PART_WASHED = 1;
const PART_HARDWARE = 2;
const PART_FACE = 3;

/** Classic expansion bell. Chemical, fusion, plasma. */
function buildBell(seg: number, throat: number): Buf {
  const b = new Buf();
  const rings = 6;
  let prevIdx = -1;
  let prevR = 0;
  let prevZ = 0;
  for (let i = 0; i < rings; i++) {
    const s = i / (rings - 1);
    const z = s;
    // A real bell expands fast off the throat then straightens: the exponent
    // below 1 is what gives the profile its shoulder. A straight cone reads as
    // a party hat.
    const r = throat + (1 - throat) * Math.pow(s, 0.55);
    const slope = i === 0 ? (1 - throat) * 4 : (r - prevR) / Math.max(z - prevZ, 1e-6);
    const idx = ring(b, seg, z, r, slope, s, PART_WALL);
    if (prevIdx >= 0) band(b, prevIdx, idx, seg);
    prevIdx = idx;
    prevR = r;
    prevZ = z;
  }
  // A rolled lip. It costs one band and it is the difference between sheet
  // metal and a rendering of a cone.
  const lip = ring(b, seg, 1.035, 1.055, -0.9, 1, PART_WALL);
  band(b, prevIdx, lip, seg);
  return b;
}

/** Ion grid: flat, perforated, glowing, recessed in a shallow can. No bell. */
function buildGrid(seg: number, throat: number): Buf {
  const b = new Buf();
  const r0 = ring(b, seg, 0.0, Math.max(throat, 0.86), 0.4, 0, PART_WALL);
  const r1 = ring(b, seg, 0.62, 0.97, 0.2, 0.6, PART_WALL);
  const r2 = ring(b, seg, 1.0, 1.0, 0.0, 1, PART_WALL);
  band(b, r0, r1, seg);
  band(b, r1, r2, seg);
  // Mounting flange: the ring of bolted structure that says this is hardware
  // and not a light fitting.
  const f0 = ring(b, seg, 1.0, 1.0, 0, 1, PART_HARDWARE);
  const f1 = ring(b, seg, 0.94, 1.14, 0, 1, PART_HARDWARE);
  band(b, f0, f1, seg);
  // The accelerator grid, set back inside the can so it self-shadows.
  disc(b, seg, 0.34, 0.9, 0, PART_FACE);
  return b;
}

/** Aerospike: annular throat round a truncated central spike. */
function buildAerospike(seg: number, throat: number): Buf {
  const b = new Buf();
  const s0 = ring(b, seg, 0.0, 1.0, -0.1, 0, PART_WALL);
  const s1 = ring(b, seg, 0.22, 0.97, -0.1, 0.2, PART_WALL);
  band(b, s0, s1, seg);
  // The spike. The exhaust clings to it, so it is `PART_WASHED` and glows from
  // the root outward — that gradient is the whole read of an aerospike.
  const spikeRings = 5;
  let prev = -1;
  for (let i = 0; i < spikeRings; i++) {
    const s = i / (spikeRings - 1);
    const z = 0.1 + s * 0.85;
    const r = Math.max(throat, 0.8) * (1 - s) + 0.09 * s;
    const idx = ring(b, seg, z, r, -0.85, s, PART_WASHED);
    if (prev >= 0) band(b, prev, idx, seg);
    prev = idx;
  }
  disc(b, seg, 0.95, 0.09, 1, PART_WASHED);
  // Injector blocks round the throat. Small, but they break the ring's
  // silhouette so it is not a bare washer.
  const blocks = Math.min(8, Math.max(4, seg >> 1));
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    tube(b, cx * 0.92, sy * 0.92, 0.02, cx * 1.04, sy * 1.04, 0.16, 0.07, 5, PART_HARDWARE);
  }
  return b;
}

/** Annular: exhaust in the gap between an outer wall and a central plug. */
function buildAnnular(seg: number, throat: number): Buf {
  const b = new Buf();
  const rings = 4;
  let prev = -1;
  for (let i = 0; i < rings; i++) {
    const s = i / (rings - 1);
    const r = Math.max(throat, 0.62) + (1 - Math.max(throat, 0.62)) * Math.pow(s, 0.7);
    const idx = ring(b, seg, s, r, 0.45, s, PART_WALL);
    if (prev >= 0) band(b, prev, idx, seg);
    prev = idx;
  }
  // The plug. Blunt, domed, and washed by the annular flow.
  const p0 = ring(b, seg, 0.02, 0.42, 0, 0, PART_WASHED);
  const p1 = ring(b, seg, 0.62, 0.40, 0, 0.6, PART_WASHED);
  const p2 = ring(b, seg, 0.80, 0.28, -0.7, 0.85, PART_WASHED);
  band(b, p0, p1, seg);
  band(b, p1, p2, seg);
  disc(b, seg, 0.8, 0.28, 1, PART_WASHED);
  return b;
}

/** Open cycle: a short bell wearing its turbomachinery on the outside. */
function buildOpenCycle(seg: number, throat: number): Buf {
  const b = buildBell(seg, throat);
  const pumps = 4;
  for (let i = 0; i < pumps; i++) {
    const a = (i / pumps) * Math.PI * 2 + 0.4;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    const pr = Math.max(throat, 0.4) + 0.2;
    // Turbopump body, then the feed line curving back into the bell wall. Two
    // primitives that say "this drive was designed to be opened".
    tube(b, cx * pr, sy * pr, 0.02, cx * pr, sy * pr, 0.42, 0.17, 6, PART_HARDWARE);
    tube(b, cx * pr, sy * pr, 0.40, cx * (pr + 0.34), sy * (pr + 0.34), 0.82, 0.055, 5, PART_HARDWARE);
  }
  return b;
}

/** Reaction plate: a disc that is struck, not a nozzle that flows. */
function buildPlate(seg: number, _throat: number): Buf {
  const b = new Buf();
  const r0 = ring(b, seg, 0.0, 1.0, 0, 0, PART_HARDWARE);
  const r1 = ring(b, seg, 1.0, 1.0, 0, 1, PART_HARDWARE);
  band(b, r0, r1, seg);
  // Forward face is structure; aft face is the working surface and flashes.
  disc(b, seg, 1.0, 1.0, 1, PART_FACE);
  disc(b, seg, 0.0, 1.0, 0, PART_HARDWARE, -1);
  // Radial stiffeners on the forward face. A flat disc with nothing on it
  // reads as a decal; the ribs are what make it a structural member.
  const ribs = 6;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    const cx = Math.cos(a);
    const sy = Math.sin(a);
    tube(b, cx * 0.16, sy * 0.16, -0.02, cx * 0.94, sy * 0.94, -0.02, 0.075, 4, PART_HARDWARE);
  }
  return b;
}

function buildNozzle(style: NozzleStyle, seg: number, throat: number): Buf {
  switch (style) {
    case 'bell':
      return buildBell(seg, throat);
    case 'aerospike':
      return buildAerospike(seg, throat);
    case 'annular':
      return buildAnnular(seg, throat);
    case 'grid':
      return buildGrid(seg, throat);
    case 'open-cycle':
      return buildOpenCycle(seg, throat);
    case 'plate':
      return buildPlate(seg, throat);
  }
}

// ---------------------------------------------------------------------------
// Additive geometry — one attribute layout for every emissive family
// ---------------------------------------------------------------------------
//
// position / normal / uv / aT / aLayer, always all five, so all four meshes can
// share one program with no attribute-presence permutation.

function additiveGeometry(pos: Float32Array, nrm: Float32Array, uv: Float32Array, t: Float32Array, layer: Float32Array, idx: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('aT', new BufferAttribute(t, 1));
  g.setAttribute('aLayer', new BufferAttribute(layer, 1));
  g.setIndex(idx);
  return g;
}

/** Unit quad in the XY plane, -0.5..0.5, uv 0..1. Lights and RCS jets. */
function buildQuadGeometry(): BufferGeometry {
  return additiveGeometry(
    new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    new Float32Array(4),
    new Float32Array(4),
    [0, 1, 2, 0, 2, 3],
  );
}

/**
 * Nested cone shells with every vertex at the origin.
 *
 * `normal` carries the radial direction and `aT` the axial parameter; the
 * vertex shader does the extruding. This is the technique worth copying
 * wholesale from `Ship.ts`: it makes length, width, taper and wobble free to
 * animate, and it is why a plume never needs a geometry rebuild.
 */
function buildShellGeometry(seg: number, steps: number, layers: number, ySquash: number): BufferGeometry {
  const verts = layers * (steps + 1) * seg;
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const t = new Float32Array(verts);
  const layer = new Float32Array(verts);
  const idx: number[] = [];

  let v = 0;
  for (let l = 0; l < layers; l++) {
    const base = v;
    for (let r = 0; r <= steps; r++) {
      const tt = r / steps;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        nrm[v * 3] = Math.cos(a);
        nrm[v * 3 + 1] = Math.sin(a) * ySquash;
        nrm[v * 3 + 2] = 0;
        uv[v * 2] = s / seg;
        uv[v * 2 + 1] = tt;
        t[v] = tt;
        layer[v] = layers > 1 ? l : 1;
        v++;
      }
    }
    for (let r = 0; r < steps; r++) {
      for (let s = 0; s < seg; s++) {
        const s1 = (s + 1) % seg;
        const a = base + r * seg + s;
        const bb = base + r * seg + s1;
        const c = base + (r + 1) * seg + s1;
        const d = base + (r + 1) * seg + s;
        idx.push(a, bb, c, a, c, d);
      }
    }
  }
  return additiveGeometry(pos, nrm, uv, t, layer, idx);
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const NOZZLE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aT;
attribute float aPart;

attribute vec3  iSize;    // (exitRadius, exitRadius, bellLength) km
attribute vec3  iCore;    // plume core colour, for the throat glow
attribute float iTech;
attribute float iSeed;

varying vec3  vLocal;     // UNIT-nozzle space — every noise frequency lives here
varying vec3  vPos;       // ship-local km, for the view vector
varying vec3  vNrm;
varying float vT;
varying float vPart;
varying vec3  vCore;
varying float vTech;
varying float vSeed;

void main() {
  vec3 lp = position * iSize;
  // Inverse-transpose of a diagonal scale is the reciprocal scale. This is the
  // whole reason instanceMatrix is kept rigid and the size rides an attribute:
  // a non-uniform scale inside instanceMatrix would silently skew every normal.
  vec3 ln = normalize(normal / iSize);

  vec4 local = instanceMatrix * vec4(lp, 1.0);
  vLocal = position;
  vPos = local.xyz;
  vNrm = mat3(instanceMatrix) * ln;
  vT = aT;
  vPart = aPart;
  vCore = iCore;
  vTech = iTech;
  vSeed = iSeed;

  gl_Position = projectionMatrix * modelViewMatrix * local;
  #include <logdepthbuf_vertex>
}
`;

const NOZZLE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <logdepthbuf_pars_fragment>

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uFill;
uniform vec3  uCameraLocal;
uniform float uThrottle;
uniform float uGlowDepth;
uniform float uTime;
uniform float uTimeScale;
uniform float uPower;

varying vec3  vLocal;
varying vec3  vPos;
varying vec3  vNrm;
varying float vT;
varying float vPart;
varying vec3  vCore;
varying float vTech;
varying float vSeed;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uCameraLocal - vPos);
  float NoL = max(dot(N, uSunDir), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float t = uTime * uTimeScale;

  // Every frequency below is in CYCLES PER NOZZLE, evaluated in unit space, so
  // a 4 m bell and a 400 m bell get the same corrugation count rather than the
  // same corrugation pitch. This is the fix for the nine kilometre-space noise
  // constants the reference ship bakes against a 30 m hull.
  vec3 q = vLocal + vSeed;
  float soot = smoothstep(0.20, 0.92, os_fbm(q * 5.5, 3, 2.3, 0.55) * 0.5 + 0.5);

  vec3 col;

  if (vPart < 0.5) {
    if (gl_FrontFacing) {
      // Outside of the bell. Phase-modulating the corrugation varies its pitch
      // and a per-rib hash varies its depth, so some rings are crisp and some
      // are half beaten flat — a pure sine gives every ring the same everything.
      float wob = os_fbm(q * 9.0, 2, 2.2, 0.5);
      float ribPhase = vT * 46.0 + 2.1 * wob;
      float ribId = floor(ribPhase / 6.2831853);
      float ribJ = fract(sin(ribId * 91.7 + 3.1 + vSeed) * 43758.5453);
      float rib = (0.5 + 0.5 * sin(ribPhase)) * mix(0.25, 1.0, ribJ);

      // Authored BELOW the hull's value on purpose: a scorched bell is the
      // dirtiest object on the ship, and when it is the brightest mass in frame
      // it steals the job the amber accents are doing.
      vec3 base = mix(vec3(0.014, 0.0135, 0.013), vec3(0.038, 0.033, 0.028), rib);
      base = mix(base, vec3(0.030, 0.022, 0.015), smoothstep(0.40, 1.0, vT));
      base *= 1.0 - 0.55 * soot * smoothstep(0.15, 1.0, vT);

      float ao = 0.5 + 0.5 * rib;
      col = base * (uSunColor * NoL + uFill * 1.3) * ao;
      // Grazing sheen. The cheapest thing that stops metal reading as clay, and
      // soot has no lining — hence the dirt rationing.
      col += uSunColor * pow(1.0 - NoV, 4.0)
           * smoothstep(-0.3, 0.3, dot(N, uSunDir)) * 0.018 * (1.0 - 0.7 * soot);
      // Rationed hard, and pushed right up to the lip. At the reference ship's
      // 0.45 over the aft half, a firing bell's own plume light drowns the
      // corrugations and the metal reads as blue plastic — the wash has to lose
      // to the geometry, not the other way round.
      col += vCore * uThrottle * 0.26 * smoothstep(0.72, 1.0, vT);
    } else {
      // Throat interior. The glow climbs deeper as throttle comes up, which is
      // the only cue that a drive is spooling before the plume appears.
      float depth = smoothstep(1.0 - uGlowDepth, 1.0, vT);
      float turb = 0.75 + 0.25 * os_snoise(q * 4.0 + vec3(0.0, 0.0, -t * 7.0));
      col = vCore * depth * (0.25 + 1.9 * uThrottle) * turb * uPower;
      col += vec3(1.0, 0.93, 0.86) * depth * pow(uThrottle, 3.0) * 0.55;
    }
  } else if (vPart < 1.5) {
    // Spike or plug: metal the exhaust washes over. It is hot at the root and
    // cools along its length, and that gradient is the read on the whole style.
    float wash = pow(clamp(vT, 0.0, 1.0), 0.7);
    vec3 base = mix(vec3(0.030, 0.026, 0.022), vec3(0.016, 0.014, 0.013), soot);
    col = base * (uSunColor * NoL + uFill * 1.3);
    col += uSunColor * pow(1.0 - NoV, 4.0) * smoothstep(-0.3, 0.3, dot(N, uSunDir)) * 0.02;
    col += vCore * uThrottle * (0.15 + 1.4 * wash) * uPower;
  } else if (vPart < 2.5) {
    // Hardware: pumps, flanges, ribs. Never glows — if the plumbing lit up as
    // brightly as the throat the eye would lose the throat.
    vec3 base = mix(vec3(0.024, 0.023, 0.022), vec3(0.014, 0.013, 0.012), soot * 0.7);
    col = base * (uSunColor * NoL + uFill * 1.25);
    col += uSunColor * pow(1.0 - NoV, 4.0) * smoothstep(-0.3, 0.3, dot(N, uSunDir)) * 0.014;
  } else {
    // The emissive working face. Two completely different objects share this
    // branch because both are flat and neither is a bell.
    float rad = length(vLocal.xy);
    vec3 base = vec3(0.020, 0.019, 0.018) * (uSunColor * NoL + uFill * 1.2);
    if (vTech > 3.5) {
      // Reaction plate: discrete detonations, not a flow. The pulse is what
      // stops it reading as a lamp.
      float rings = 0.5 + 0.5 * sin(rad * 46.0);
      float pulse = pow(0.5 + 0.5 * sin(t * 7.0 + vSeed * 6.2831), 8.0);
      col = base + vCore * uPower * (0.04 + uThrottle * (0.4 + 2.6 * pulse)) * mix(0.55, 1.0, rings);
    } else {
      // Ion accelerator grid: a perforated plate whose holes are the emitter.
      vec2 cell = fract(vLocal.xy * 11.0) - 0.5;
      float hole = 1.0 - smoothstep(0.17, 0.33, length(cell));
      float edge = 1.0 - smoothstep(0.80, 0.95, rad);
      float shimmer = 0.85 + 0.15 * os_snoise(vec3(vLocal.xy * 6.0, t * 0.9));
      col = base + vCore * hole * edge * shimmer * uPower * (0.10 + 2.6 * uThrottle);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * One additive program for plumes, RCS jets, emissive fixtures and the wake.
 *
 * They share an attribute layout and branch on `iKind`. Every instance in a
 * given mesh has the same kind, so the branch is fully coherent per draw and
 * costs nothing; what it buys is the material budget (BRIEF §6 allows three per
 * ship and the hull needs one).
 */
const ADDITIVE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aT;
attribute float aLayer;

attribute float iKind;
attribute vec3  iColor;   // core / fixture colour
attribute vec3  iEdge;    // envelope colour
attribute vec4  iSizeA;   // (length|halfWidth, width|halfHeight, intensity, phase)
attribute vec4  iSizeB;   // (diamonds|pattern, flicker|chaseIndex, tech, spare)
attribute float iDrive;   // dynamic: throttle | jet level | bus power

uniform float uTime;
uniform float uTimeScale;
uniform float uThrottle;
uniform float uBoost;
uniform float uHeat;
uniform float uPixelAngle;    // radians per pixel: km/px = viewDepth * this
uniform float uMinPixels;

varying vec3  vCol;
varying vec3  vEdge;
varying vec2  vUv;
varying float vT;
varying float vKind;
varying float vDrive;
varying vec4  vA;
varying vec4  vB;
varying vec3  vNrm;
varying vec3  vPos;

void main() {
  vCol = iColor;
  vEdge = iEdge;
  vUv = uv;
  vT = aT;
  vKind = iKind;
  vDrive = iDrive;
  vA = iSizeA;
  vB = iSizeB;
  vNrm = vec3(0.0, 0.0, 1.0);
  vPos = instanceMatrix[3].xyz;

  float t = uTime * uTimeScale;

  if (iKind < 0.5) {
    // ------------------------------------------------------------------ plume
    float tech = iSizeB.z;
    // iSizeA holds the FULL-THROTTLE column. A drive at idle is a short, thin
    // stub of flame, not a full plume that merely dims — an unlit plume of full
    // length is the classic tell that the effect is a texture.
    float grow = 0.13 + 0.87 * uThrottle + 0.50 * uBoost;
    float fat = 0.55 + 0.45 * uThrottle + 0.20 * uBoost;
    float len = iSizeA.x * grow * mix(1.0, 0.60, aLayer);
    float wid = iSizeA.y * fat * mix(1.0, 0.44, aLayer);

    // The radial profile IS the technology. Five genuinely different columns,
    // not one column in five colours.
    float prof;
    if (tech < 0.5) {
      // chemical — flares out of the bell, then tapers
      prof = aT < 0.10 ? mix(0.50, 1.0, aT / 0.10)
                       : pow(max(1.0 - (aT - 0.10) / 0.90, 0.0), 1.35);
    } else if (tech < 1.5) {
      // ion — no bell flare at all: a thin, slowly diverging fan
      prof = (0.30 + 0.95 * aT) * pow(max(1.0 - aT, 0.0), 0.35);
    } else if (tech < 2.5) {
      // fusion torch — pinched hard at the throat, then collimated
      prof = mix(0.22, 1.0, smoothstep(0.0, 0.07, aT)) * pow(max(1.0 - aT, 0.0), 0.45);
    } else if (tech < 3.5) {
      // plasma — a magnetic nozzle beads the column into visible pinches
      prof = pow(max(1.0 - aT, 0.0), 0.95) * (1.0 + 0.34 * sin(aT * 9.0 + iSizeA.w * 6.2831));
    } else {
      // reaction plate — a pancake hugging the plate, not a column
      prof = pow(max(1.0 - aT, 0.0), 0.30) * 1.55;
    }

    // A drive is never perfectly steady, and a rank of six that wobbles in
    // lockstep reads as one animated object rather than six machines.
    float wob = 1.0 + iSizeB.y * aT * sin(aT * 26.0 + t * 11.0 + iSizeA.w * 6.2831)
                    * (0.4 + uThrottle + uBoost);

    vec3 lp = vec3(normal.xy * (prof * wid * wob), aT * len);
    vec4 local = instanceMatrix * vec4(lp, 1.0);
    vNrm = mat3(instanceMatrix) * vec3(normal.xy, 0.0);
    // SHIP-LOCAL, to match uCameraLocal. This object carries no transform of
    // its own relative to the hull, so no modelMatrix is needed anywhere here —
    // which also keeps the effect independent of where the floating origin has
    // put the ship this frame.
    vPos = local.xyz;
    vB.w = aLayer;
    gl_Position = projectionMatrix * modelViewMatrix * local;

  } else if (iKind < 1.5) {
    // -------------------------------------------------------------- RCS jet
    // The axis is a REAL 3D segment transformed into view space and only then
    // projected. Billboarding purely in screen space makes a thruster firing
    // at the camera collapse to nothing instead of to a disc.
    vec3 c = instanceMatrix[3].xyz;
    vec3 dir = normalize(instanceMatrix[2].xyz);
    float lvl = iDrive;
    float len = iSizeA.x * (0.5 + 2.2 * lvl);
    float wid = iSizeA.y * (0.20 + 0.30 * lvl);

    vec4 mvBase = modelViewMatrix * vec4(c + dir * (len * 0.08), 1.0);
    vec4 mvTip = modelViewMatrix * vec4(c + dir * len, 1.0);
    vec4 mv = mix(mvBase, mvTip, uv.y);

    vec2 axis = mvTip.xy - mvBase.xy;
    float al = length(axis);
    axis = al > 1e-7 ? axis / al : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);

    // A cold-gas jet leaves the throat narrow and spreads as it expands, and it
    // never falls below a couple of pixels or a capital's RCS is invisible.
    float pixKm = max(-mv.z, 0.0) * uPixelAngle;
    float halfW = max(wid * (0.4 + 1.5 * uv.y), uMinPixels * pixKm * 0.5);
    mv.xy += perp * ((uv.x - 0.5) * 2.0 * halfW);

    gl_Position = projectionMatrix * mv;

  } else if (iKind < 2.5) {
    // --------------------------------------------------------- light fixture
    vec3 c = instanceMatrix[3].xyz;
    vec4 mv = modelViewMatrix * vec4(c, 1.0);
    float pixKm = max(-mv.z, 0.0) * uPixelAngle;
    float floorKm = uMinPixels * pixKm * 0.5;
    float hw = max(iSizeA.x, floorKm);
    float hh = max(iSizeA.y, floorKm);

    // Camera-facing: a fixture seen at a glancing angle must DIM (which the
    // fragment does from the fitting's own normal) rather than shear into a
    // line, which is what a hull-plane quad does.
    mv.xy += vec2(position.x * 2.0 * hw, position.y * 2.0 * hh);
    // Pulled towards the camera by its own half-size, so an expanded sprite
    // does not bury itself in the plating it is bolted to.
    mv.z += max(hw, hh);

    vNrm = mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0);
    vPos = instanceMatrix[3].xyz;
    gl_Position = projectionMatrix * mv;

  } else {
    // ------------------------------------------------------------ plasma wake
    float prof = pow(aT, 0.45);
    // A perfect cone of revolution reads as a traffic cone, not as ionised gas
    // being torn off a hull.
    float rag = 1.0 + 0.30 * sin(normal.x * 3.0 + aT * 7.0 + t * 0.7)
                          * sin(normal.y * 5.0 - aT * 4.0 - t * 1.1);
    vec3 lp = vec3(normal.xy * (prof * iSizeA.y * uHeat * rag), aT * iSizeA.x * uHeat);
    vec4 local = instanceMatrix * vec4(lp, 1.0);
    vNrm = mat3(instanceMatrix) * vec3(normal.xy, 0.0);
    vPos = local.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * local;
  }

  #include <logdepthbuf_vertex>
}
`;

const ADDITIVE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>

uniform vec3  uCameraLocal;
uniform float uTime;
uniform float uTimeScale;
uniform float uThrottle;
uniform float uBoost;
uniform float uHeat;

varying vec3  vCol;
varying vec3  vEdge;
varying vec2  vUv;
varying float vT;
varying float vKind;
varying float vDrive;
varying vec4  vA;
varying vec4  vB;
varying vec3  vNrm;
varying vec3  vPos;

void main() {
  #include <logdepthbuf_fragment>
  float t = uTime * uTimeScale;
  vec3 col;

  if (vKind < 0.5) {
    // ------------------------------------------------------------------ plume
    vec3 N = normalize(vNrm);
    vec3 V = normalize(uCameraLocal - vPos);
    // Inverse Fresnel: an open shell fades at its own silhouette, which is what
    // makes two triangles' worth of cone read as a volume of gas.
    float shell = pow(abs(dot(N, V)), 1.6);
    float tech = vB.z;
    float layer = vB.w;
    float heat = clamp(uThrottle * 0.30 + uBoost * 0.85, 0.0, 1.0);

    float axial;
    if (tech > 0.5 && tech < 1.5) {
      // An ion beam has no hot root: it brightens away from the grid and then
      // thins out over a very long distance.
      axial = pow(max(1.0 - vT, 0.0), 1.05) * smoothstep(0.0, 0.22, vT);
    } else {
      axial = pow(max(1.0 - vT, 0.0), 2.2 + 1.4 * heat);
    }

    // Radiance, not opacity: this lands well above the 1.0 bloom threshold at
    // high throttle, which is the only way an emitter is allowed to bloom.
    float I = vA.z * vDrive
            * smoothstep(0.0, 0.15, uThrottle + uBoost)
            * (0.45 + uThrottle * 0.8 + uBoost * 0.35);

    vec3 base = mix(vEdge, vCol, layer);
    base = mix(base, vec3(1.0, 0.96, 0.92), heat * 0.55);
    col = base * shell * axial * I;

    // Shock diamonds. vB.x is the blueprint's diamond COUNT, so the sine runs
    // exactly that many periods over the column however long it is — and they
    // only exist once the flow is over-expanded, which is why they arrive at
    // high throttle and are absent from ion and plate drives entirely.
    if (vB.x > 0.5) {
      float sd = pow(max(sin(vT * 6.2831853 * vB.x - t * 2.0) * 0.5 + 0.5, 0.0), 10.0);
      sd *= exp(-vT * 3.2) * smoothstep(0.42, 0.90, uThrottle + uBoost * 0.5);
      col += mix(base, vec3(1.0), 0.5) * sd * (0.3 + layer) * I * 1.4;
    }

    if (tech > 3.5) {
      // The plate's wash is pulsed to match the face flashing behind it.
      col *= 0.35 + 1.9 * pow(0.5 + 0.5 * sin(t * 7.0 + vA.w * 6.2831), 8.0);
    } else if (tech < 1.5 && tech > 0.5) {
      // No white core on an ion drive: there is nothing burning.
    } else {
      col += vec3(1.0, 0.96, 0.90) * layer * pow(max(1.0 - vT, 0.0), 4.5)
           * shell * I * 0.5;
    }

  } else if (vKind < 1.5) {
    // -------------------------------------------------------------- RCS jet
    float r = abs(vUv.x - 0.5) * 2.0;
    float a = 1.0 - smoothstep(0.15, 1.0, r);
    a *= pow(max(1.0 - vUv.y, 0.0), 2.2) * vDrive;
    col = mix(vCol, vec3(1.0), pow(max(1.0 - vUv.y, 0.0), 2.5)) * a * vA.z;

  } else if (vKind < 2.5) {
    // --------------------------------------------------------- light fixture
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.0)
            + pow(clamp(1.0 - r * 2.4, 0.0, 1.0), 6.0) * 1.8;

    float ph = vA.w;
    float k;
    if (vB.x < 0.5) {
      // Steady position light. It breathes very slightly; a mathematically
      // constant emitter is the one thing on a hull that never looks real.
      k = 0.92 + 0.08 * sin(t * 1.3 + ph * 6.2831);
    } else if (vB.x < 1.5) {
      // Anti-collision strobe: a hard double flash. The floor is deliberately
      // not zero — at zero, most still frames of a ship have no lights at all.
      float c = fract(t * 0.62 + ph);
      k = 0.13 + 2.6 * max(exp(-pow((c - 0.02) / 0.022, 2.0)),
                           exp(-pow((c - 0.11) / 0.022, 2.0)));
    } else if (vB.x < 2.5) {
      // Rotating beacon: it ramps through, it never snaps.
      k = mix(0.18, 1.0, pow(clamp(sin(t * 1.15 + ph * 6.2831), 0.0, 1.0), 3.0));
    } else {
      // Docking guide: a chase running round the collar towards the port.
      float c = fract(t * 0.9 - vB.y * 0.11);
      k = 0.18 + 1.7 * exp(-pow(c / 0.075, 2.0));
    }

    // The fitting has a housing: a lamp on the far side of the hull must not
    // shine through it. vNrm is the fixture's own outward normal.
    float facing = max(dot(normalize(vNrm), normalize(uCameraLocal - vPos)), 0.0);
    col = vCol * a * k * vA.z * vDrive * pow(facing, 0.7);

  } else {
    // ------------------------------------------------------------ plasma wake
    vec3 N = normalize(vNrm);
    vec3 V = normalize(uCameraLocal - vPos);
    float shell = pow(abs(dot(N, V)), 1.1);
    // Driven by the ring direction rather than by uv.x: uv wraps at the seam
    // and leaves a stationary bright stripe down one side of the cone.
    vec2 ringDir = normalize(vNrm.xy + 1e-6);
    float n = os_fbm(vec3(ringDir * 6.0, vT * 5.0 - t * 2.2) + vec3(0.0, 0.0, t * 0.35), 4, 2.3, 0.55);
    float fil = 0.12 + 0.88 * smoothstep(0.25, 0.85, n * 0.5 + 0.5);
    float fade = pow(max(1.0 - vT, 0.0), 2.6) * smoothstep(0.0, 0.1, vT);
    vec3 hot = os_blackbody(mix(1800.0, 4600.0, uHeat * (1.0 - vT * 0.6)));
    // The far tail cools into ionised violet rather than fading to grey.
    hot = mix(hot, vec3(0.45, 0.24, 0.8), smoothstep(0.35, 1.0, vT) * 0.8);
    col = hot * shell * fade * fil * uHeat * uHeat * vA.z;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();

/**
 * Rigid basis from a blueprint `Frame`: local +Z = `forward`, +Y = `up`.
 *
 * Re-orthogonalised on the way in. A blueprint frame is supposed to be
 * orthonormal, but one degenerate frame in a generated fleet would otherwise
 * produce a NaN matrix and take the whole instanced mesh with it.
 */
function frameMatrix(f: Frame, out: Matrix4): Matrix4 {
  _fwd.set(f.forward[0], f.forward[1], f.forward[2]);
  if (_fwd.lengthSq() < 1e-18) _fwd.set(0, 0, 1);
  _fwd.normalize();
  _up.set(f.up[0], f.up[1], f.up[2]);
  _up.addScaledVector(_fwd, -_up.dot(_fwd));
  if (_up.lengthSq() < 1e-14) {
    _up.set(0, 1, 0).addScaledVector(_fwd, -_fwd.y);
    if (_up.lengthSq() < 1e-14) _up.set(1, 0, 0).addScaledVector(_fwd, -_fwd.x);
  }
  _up.normalize();
  // right = up × forward, matching `frameRight()` in the blueprint contract.
  _right.crossVectors(_up, _fwd);
  return out.makeBasis(_right, _up, _fwd);
}

// ---------------------------------------------------------------------------
// Per-instance staging
// ---------------------------------------------------------------------------

/** Everything the additive material needs per instance, before upload. */
class AdditiveBatch {
  readonly matrix: Float32Array;
  readonly kind: Float32Array;
  readonly color: Float32Array;
  readonly edge: Float32Array;
  readonly sizeA: Float32Array;
  readonly sizeB: Float32Array;
  readonly drive: Float32Array;
  count = 0;

  constructor(readonly capacity: number) {
    this.matrix = new Float32Array(capacity * 16);
    this.kind = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 3);
    this.edge = new Float32Array(capacity * 3);
    this.sizeA = new Float32Array(capacity * 4);
    this.sizeB = new Float32Array(capacity * 4);
    this.drive = new Float32Array(capacity);
  }

  push(m: Matrix4, kind: number, col: Color, edge: Color, a: readonly number[], b: readonly number[], drive: number): number {
    const i = this.count;
    if (i >= this.capacity) return -1;
    m.toArray(this.matrix, i * 16);
    this.kind[i] = kind;
    this.color[i * 3] = col.r;
    this.color[i * 3 + 1] = col.g;
    this.color[i * 3 + 2] = col.b;
    this.edge[i * 3] = edge.r;
    this.edge[i * 3 + 1] = edge.g;
    this.edge[i * 3 + 2] = edge.b;
    for (let k = 0; k < 4; k++) {
      this.sizeA[i * 4 + k] = a[k];
      this.sizeB[i * 4 + k] = b[k];
    }
    this.drive[i] = drive;
    this.count = i + 1;
    return i;
  }

  /** Attach every instanced attribute to a geometry and return the drive attribute. */
  attach(g: BufferGeometry, dynamicDrive: boolean): InstancedBufferAttribute {
    g.setAttribute('iKind', new InstancedBufferAttribute(this.kind.subarray(0, this.count), 1));
    g.setAttribute('iColor', new InstancedBufferAttribute(this.color.subarray(0, this.count * 3), 3));
    g.setAttribute('iEdge', new InstancedBufferAttribute(this.edge.subarray(0, this.count * 3), 3));
    g.setAttribute('iSizeA', new InstancedBufferAttribute(this.sizeA.subarray(0, this.count * 4), 4));
    g.setAttribute('iSizeB', new InstancedBufferAttribute(this.sizeB.subarray(0, this.count * 4), 4));
    const drv = new InstancedBufferAttribute(this.drive.subarray(0, this.count), 1);
    if (dynamicDrive) drv.setUsage(DynamicDrawUsage);
    g.setAttribute('iDrive', drv);
    return drv;
  }
}

/** One drawn nozzle. Kept flat so the gimbal loop touches no objects. */
interface NozzleSlot {
  readonly mesh: number;
  readonly slot: number;
  readonly plumeSlot: number;
  readonly gimbal: number;
}

// ---------------------------------------------------------------------------
// ShipPropulsion
// ---------------------------------------------------------------------------

export class ShipPropulsion {
  readonly object3d: Object3D;

  /**
   * Alias these into the hull material's uniform object BY REFERENCE and pair
   * them with `ENGINE_GLOW_GLSL`. They are refreshed in place every frame.
   */
  readonly engineGlowUniforms: EngineGlowUniforms;

  /**
   * Planetshine, linear RGB, ship-local. `ViewState` carries the key light but
   * has no fill term, and a nozzle lit by the key alone is pure black on its
   * shadow side. Defaults to the project's authored value; the integrator may
   * overwrite it per frame. Flagged in the report as a `ViewState` gap.
   */
  readonly fillColor = new Color(0.010, 0.014, 0.022);

  private readonly group = new Group();

  // --- GPU resources, every one of which dispose() frees ---------------------
  private readonly nozzleGeos: BufferGeometry[] = [];
  private readonly nozzleMeshes: InstancedMesh[] = [];
  private readonly nozzleMat: ShaderMaterial;
  private readonly additiveMat: ShaderMaterial;
  private plumeGeo: BufferGeometry | null = null;
  private plumeMesh: InstancedMesh | null = null;
  private quadGeo: BufferGeometry | null = null;
  private quadMesh: InstancedMesh | null = null;
  private wakeGeo: BufferGeometry | null = null;
  private wakeMesh: InstancedMesh | null = null;

  // --- per-frame state, all preallocated ------------------------------------
  private time = 0;
  private vThrottle = 0;
  private vBoost = 0;
  private vHeat = 0;
  private vPower = 0;
  private vGimbalPitch = 0;
  private vGimbalYaw = 0;

  private readonly nozzles: NozzleSlot[] = [];
  private readonly nozzleQuat: Quaternion[] = [];
  private readonly nozzlePos: Vector3[] = [];
  /** Bell length per nozzle, km. The plume anchors this far aft of the throat. */
  private readonly nozzleBell: number[] = [];
  private readonly hasGimbal: boolean;

  private readonly jetCount: number;
  private readonly jetBase: number;
  private readonly jetDir: Float32Array;
  private readonly jetLevel: Float32Array;
  private readonly jetPhase: Float32Array;
  private readonly jetGroupStart: Uint32Array;
  private readonly jetGroupIndex: Uint8Array;
  private readonly groupDemand = new Float32Array(RCS_GROUP_ORDER.length);
  private quadDriveAttr: InstancedBufferAttribute | null = null;
  private plumeDriveAttr: InstancedBufferAttribute | null = null;
  /**
   * Per-nozzle lever arms (x, y) normalised by the hull's half-beam.
   *
   * A multi-engine ship does not only gimbal to turn — it throttles its engines
   * differentially, and a rank of bells where the outboard one visibly comes up
   * under a yaw input is the read that says the drive is being flown.
   */
  private readonly nozzleLever: Float32Array;
  private readonly differentialGain: number;

  /** Engine-glow staging: pod mouth, exhaust axis, base strength. */
  private readonly glowCount: number;
  private readonly glowStrength: Float32Array;
  private readonly glowRangeBase: number;

  private readonly timeScale: number;
  private readonly minLightPixels: number;

  // scratch — never allocated in update()
  private readonly _m4 = new Matrix4();
  private readonly _m4b = new Matrix4();
  private readonly _q = new Quaternion();
  private readonly _qg = new Quaternion();
  private readonly _v = new Vector3();
  private readonly _scale = new Vector3(1, 1, 1);
  private readonly _axisX = new Vector3(1, 0, 0);
  private readonly _axisY = new Vector3(0, 1, 0);

  constructor(bp: ShipBlueprint, quality: QualitySettings) {
    registerShaderChunks();

    const budget = BUDGETS[quality.tier];
    this.minLightPixels = budget.minLightPixels;
    this.object3d = this.group;
    this.group.name = `propulsion:${bp.id}`;

    const L = Math.max(bp.dimensions.lengthKm, 1e-5);
    // Big machines move slowly. Every temporal constant in this file was
    // authored against a 30 m hull; scaling them by the ship's own size is what
    // stops a 4 km capital's valves chattering like a courier's.
    this.timeScale = clamp(Math.pow(REFERENCE_LENGTH_KM / L, 0.35), 0.22, 1.7);

    const tech = DRIVE_TECH[bp.technologyProfile.drive];
    const shape = PLUME_SHAPE[bp.technologyProfile.drive];

    // ---- materials --------------------------------------------------------
    const glow: EngineGlowUniforms = {
      uEngineGlow: { value: new Float32Array(ENGINE_GLOW_MAX * 4) },
      uEngineGlowDir: { value: new Float32Array(ENGINE_GLOW_MAX * 3) },
      uEngineGlowColor: { value: new Color(bp.palette.engineGlow[0], bp.palette.engineGlow[1], bp.palette.engineGlow[2]) },
      uEngineGlowRange: { value: L * 0.15 },
    };
    this.engineGlowUniforms = glow;

    const coreColor = new Color(bp.palette.engineCore[0], bp.palette.engineCore[1], bp.palette.engineCore[2]);

    this.nozzleMat = new ShaderMaterial({
      uniforms: {
        uSunDir: { value: new Vector3(0, 0, 1) },
        uSunColor: { value: new Color(1, 1, 1) },
        uFill: { value: this.fillColor },
        uCameraLocal: { value: new Vector3() },
        uThrottle: { value: 0 },
        uGlowDepth: { value: 0.2 },
        uTime: { value: 0 },
        uTimeScale: { value: this.timeScale },
        uPower: { value: 0 },
      },
      vertexShader: NOZZLE_VERT,
      fragmentShader: NOZZLE_FRAG,
      // One shell serves as both the outside of the bell and its throat; the
      // fragment branches on gl_FrontFacing. Half the triangles of two shells.
      side: DoubleSide,
      // PostFX owns the tone map. The scene target is linear HDR.
      toneMapped: false,
    });

    this.additiveMat = new ShaderMaterial({
      uniforms: {
        uCameraLocal: { value: new Vector3() },
        uTime: { value: 0 },
        uTimeScale: { value: this.timeScale },
        uThrottle: { value: 0 },
        uBoost: { value: 0 },
        uHeat: { value: 0 },
        uPixelAngle: { value: 0.001 },
        uMinPixels: { value: this.minLightPixels },
      },
      vertexShader: ADDITIVE_VERT,
      fragmentShader: ADDITIVE_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      // The vertex shader reorients these quads and shells in view space, so
      // their winding flips with orientation. Culling eats them.
      side: DoubleSide,
      toneMapped: false,
    });

    // ---- engines ----------------------------------------------------------
    const pods = bp.engines;
    let nozzleTotal = 0;
    for (const p of pods) nozzleTotal += Math.max(1, Math.round(p.nozzle.count));

    // Mean throat ratio. Baked into the geometry rather than carried per
    // instance: the deviation between pods of one ship is a few percent of a
    // radius, and a per-instance profile costs a vertex-shader reconstruction
    // of every normal to buy something nobody can see.
    let throatSum = 0;
    for (const p of pods) throatSum += clamp(p.nozzle.throatRadius / Math.max(p.nozzle.exitRadius, 1e-9), 0.18, 0.82);
    const throat = pods.length > 0 ? throatSum / pods.length : 0.42;

    const crowded = nozzleTotal > PLUME_CROWD_THRESHOLD;
    const plumeSeg = crowded ? Math.max(6, budget.plumeSeg >> 1) : budget.plumeSeg;
    const plumeSteps = crowded ? Math.max(5, (budget.plumeSteps * 2) / 3 | 0) : budget.plumeSteps;
    const plumeLayers = crowded ? 1 : budget.plumeLayers;

    // Group nozzles by style: one InstancedMesh per style present, which is
    // one draw call for almost every ship (a faction has one nozzle doctrine)
    // and never one per engine.
    const byStyle = new Map<NozzleStyle, { size: number[]; matrix: number[]; seed: number[] }>();
    const plumeBatch = new AdditiveBatch(nozzleTotal);

    const glowPos: number[] = [];
    const glowDir: number[] = [];
    const glowW: number[] = [];

    const m = new Matrix4();
    const local = new Matrix4();
    const world = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const edgeColor = new Color();
    const podCore = new Color();

    for (let pi = 0; pi < pods.length; pi++) {
      const pod = pods[pi];
      frameMatrix(pod.frame, m);
      m.setPosition(pod.frame.origin[0], pod.frame.origin[1], pod.frame.origin[2]);

      const count = Math.max(1, Math.round(pod.nozzle.count));
      const exit = Math.max(pod.nozzle.exitRadius, 1e-6);
      let bellLen = Math.max(pod.nozzle.length, exit * 0.12);
      // A grid or a plate has no bell to be long. If the family's bell aspect
      // says otherwise the family is describing a drive it does not have.
      if (pod.nozzle.style === 'grid') bellLen = Math.min(bellLen, exit * 0.5);
      if (pod.nozzle.style === 'plate') bellLen = Math.min(bellLen, exit * 0.24);

      // Bells in a cluster that overlap is a visible bug, not a style. The
      // blueprint's clusterRadius is trusted unless it cannot possibly work.
      const clusterR = count > 1 ? Math.max(pod.nozzle.clusterRadius, exit * 1.15) : 0;

      podCore.setRGB(pod.plume.coreColor[0], pod.plume.coreColor[1], pod.plume.coreColor[2]);
      edgeColor.setRGB(pod.plume.edgeColor[0], pod.plume.edgeColor[1], pod.plume.edgeColor[2]);

      let entry = byStyle.get(pod.nozzle.style);
      if (!entry) {
        entry = { size: [], matrix: [], seed: [] };
        byStyle.set(pod.nozzle.style, entry);
      }
      const meshIndex = [...byStyle.keys()].indexOf(pod.nozzle.style);

      const plumeLen = exit * Math.max(pod.plume.lengthRatio, 0.5) * shape[0];
      const plumeWid = exit * shape[1];

      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2;
        local.identity().setPosition(Math.cos(a) * clusterR, Math.sin(a) * clusterR, 0);
        world.multiplyMatrices(m, local);

        const slot = entry.size.length / 3;
        entry.size.push(exit, exit, bellLen);
        for (let k = 0; k < 16; k++) entry.matrix.push(world.elements[k]);
        entry.seed.push(((pod.seed >>> 0) % 1024) * 0.031 + n * 0.37);

        // The plume starts at the EXIT plane, not at the throat the frame is
        // anchored to — otherwise it is drawn inside its own bell.
        local.identity().setPosition(Math.cos(a) * clusterR, Math.sin(a) * clusterR, bellLen);
        this._m4.multiplyMatrices(m, local);
        const plumeSlot = plumeBatch.push(
          this._m4,
          KIND_PLUME,
          podCore,
          edgeColor,
          [plumeLen, plumeWid, 1.15, ((pod.seed >>> 0) % 997) / 997],
          [Math.max(0, Math.round(pod.plume.diamonds)), clamp01(pod.plume.flicker), tech, 0],
          1,
        );

        this.nozzles.push({ mesh: meshIndex, slot, plumeSlot, gimbal: Math.max(0, pod.nozzle.gimbalLimit) });
        this.nozzleBell.push(bellLen);
        world.decompose(pos, q, this._v);
        this.nozzlePos.push(pos.clone());
        this.nozzleQuat.push(q.clone());
      }

      // One glow slot per pod: a cluster of four bells is one light source at
      // any range the hull wash is legible from.
      pos.set(pod.frame.origin[0], pod.frame.origin[1], pod.frame.origin[2]);
      this._v.set(pod.frame.forward[0], pod.frame.forward[1], pod.frame.forward[2]).normalize();
      pos.addScaledVector(this._v, bellLen + plumeLen * 0.35);
      glowPos.push(pos.x, pos.y, pos.z);
      glowDir.push(this._v.x, this._v.y, this._v.z);
      glowW.push(exit);
    }

    this.hasGimbal = this.nozzles.some((n) => n.gimbal > 1e-4);
    // A gimballed drive does most of the vectoring with the bell, so its
    // differential trim is subtle; a fixed drive has nothing else to turn with.
    this.differentialGain = this.hasGimbal ? 0.22 : 0.75;

    const halfBeam = Math.max(bp.dimensions.beamKm * 0.5, 1e-6);
    this.nozzleLever = new Float32Array(this.nozzles.length * 2);
    for (let i = 0; i < this.nozzles.length; i++) {
      this.nozzleLever[i * 2] = clamp(this.nozzlePos[i].x / halfBeam, -1, 1);
      this.nozzleLever[i * 2 + 1] = clamp(this.nozzlePos[i].y / halfBeam, -1, 1);
    }

    // Sort glow slots by exit radius so a manoeuvring thruster pod never evicts
    // a main drive from the eight available slots.
    const glowOrder = glowW.map((w, i) => i).sort((a, b) => glowW[b] - glowW[a]);
    this.glowCount = Math.min(ENGINE_GLOW_MAX, glowOrder.length);
    this.glowStrength = new Float32Array(ENGINE_GLOW_MAX);
    let maxExit = 1e-9;
    for (const w of glowW) maxExit = Math.max(maxExit, w);
    for (let i = 0; i < this.glowCount; i++) {
      const src = glowOrder[i];
      glow.uEngineGlow.value[i * 4] = glowPos[src * 3];
      glow.uEngineGlow.value[i * 4 + 1] = glowPos[src * 3 + 1];
      glow.uEngineGlow.value[i * 4 + 2] = glowPos[src * 3 + 2];
      glow.uEngineGlowDir.value[i * 3] = glowDir[src * 3];
      glow.uEngineGlowDir.value[i * 3 + 1] = glowDir[src * 3 + 1];
      glow.uEngineGlowDir.value[i * 3 + 2] = glowDir[src * 3 + 2];
      // Normalised against the largest bell so the wash reads the same on a
      // courier and a capital; absolute radiance is the throttle's job.
      this.glowStrength[i] = glowW[src] / maxExit;
    }
    this.glowRangeBase = pods.length > 0 ? this.meanPlumeLength(pods, shape[0]) : L * 0.1;

    // ---- nozzle meshes ----------------------------------------------------
    for (const [style, entry] of byStyle) {
      const geo = buildNozzle(style, budget.nozzleSeg, throat).geometry();
      const n = entry.size.length / 3;
      geo.setAttribute('iSize', new InstancedBufferAttribute(new Float32Array(entry.size), 3));
      geo.setAttribute('iCore', new InstancedBufferAttribute(this.repeatColor(coreColor, n), 3));
      geo.setAttribute('iTech', new InstancedBufferAttribute(new Float32Array(n).fill(tech), 1));
      geo.setAttribute('iSeed', new InstancedBufferAttribute(new Float32Array(entry.seed), 1));
      const mesh = new InstancedMesh(geo, this.nozzleMat, n);
      mesh.instanceMatrix.array.set(entry.matrix);
      mesh.instanceMatrix.needsUpdate = true;
      if (this.hasGimbal) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // The ship is the near subject and the integrator culls it as a whole;
      // per-mesh culling here would only fight the vertex-shader extrusion.
      mesh.frustumCulled = false;
      mesh.renderOrder = 0;
      this.nozzleGeos.push(geo);
      this.nozzleMeshes.push(mesh);
      this.group.add(mesh);
    }

    // ---- plumes -----------------------------------------------------------
    if (plumeBatch.count > 0) {
      this.plumeGeo = buildShellGeometry(plumeSeg, plumeSteps, plumeLayers, 1);
      this.plumeDriveAttr = plumeBatch.attach(this.plumeGeo, true);
      this.plumeMesh = new InstancedMesh(this.plumeGeo, this.additiveMat, plumeBatch.count);
      this.plumeMesh.instanceMatrix.array.set(plumeBatch.matrix.subarray(0, plumeBatch.count * 16));
      this.plumeMesh.instanceMatrix.needsUpdate = true;
      if (this.hasGimbal) this.plumeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      this.plumeMesh.frustumCulled = false;
      // After the opaque nozzle so the column's root sits inside a bell that
      // has already written depth.
      this.plumeMesh.renderOrder = 3;
      this.plumeMesh.visible = false;
      this.group.add(this.plumeMesh);
    }

    // ---- lights and RCS jets, one merged instanced quad --------------------
    const lights = this.collectLights(bp);
    const thrusters = bp.thrusters.slice(0, MAX_JETS);
    this.jetCount = thrusters.length;
    this.jetBase = lights.count;

    const quadBatch = new AdditiveBatch(lights.count + this.jetCount);
    // Copy the staged lights across first so the jets occupy a contiguous tail
    // and the per-frame level write is one linear run.
    quadBatch.matrix.set(lights.matrix.subarray(0, lights.count * 16));
    quadBatch.kind.set(lights.kind.subarray(0, lights.count));
    quadBatch.color.set(lights.color.subarray(0, lights.count * 3));
    quadBatch.edge.set(lights.edge.subarray(0, lights.count * 3));
    quadBatch.sizeA.set(lights.sizeA.subarray(0, lights.count * 4));
    quadBatch.sizeB.set(lights.sizeB.subarray(0, lights.count * 4));
    quadBatch.drive.set(lights.drive.subarray(0, lights.count));
    quadBatch.count = lights.count;

    this.jetDir = new Float32Array(this.jetCount * 3);
    this.jetLevel = new Float32Array(this.jetCount);
    this.jetPhase = new Float32Array(this.jetCount);
    this.jetGroupStart = new Uint32Array(this.jetCount + 1);
    const groupFlat: number[] = [];
    const jetColor = new Color(bp.palette.navStrobe[0], bp.palette.navStrobe[1], bp.palette.navStrobe[2]);
    // A cold-gas jet is not a running light: bias it towards the drive's cold
    // accent so it belongs to the propulsion story, not the signalling one.
    jetColor.lerp(new Color(0.52, 0.70, 1.0), 0.65);

    for (let i = 0; i < this.jetCount; i++) {
      const th = thrusters[i];
      frameMatrix(th.frame, m);
      this._v.set(th.frame.forward[0], th.frame.forward[1], th.frame.forward[2]).normalize();
      // Stood off the plating so the puff clears the panel it is bolted to and
      // does not get z-tested away against it.
      const standoff = Math.max(th.radius * 0.6, L * 2e-4);
      m.setPosition(
        th.frame.origin[0] + this._v.x * standoff,
        th.frame.origin[1] + this._v.y * standoff,
        th.frame.origin[2] + this._v.z * standoff,
      );
      this.jetDir[i * 3] = this._v.x;
      this.jetDir[i * 3 + 1] = this._v.y;
      this.jetDir[i * 3 + 2] = this._v.z;
      // Deterministic, from the thruster's own identity: two ships of one seed
      // must stutter identically.
      this.jetPhase[i] = ((this.hashString(th.id) >>> 0) % 4096) / 4096;

      const r = Math.max(th.radius, L * 1e-4);
      quadBatch.push(m, KIND_JET, jetColor, jetColor, [r * 26, r * 3.2, 5.5, this.jetPhase[i]], [0, 0, 0, 0], 0);

      this.jetGroupStart[i] = groupFlat.length;
      for (const g of th.groups) {
        const gi = RCS_GROUP_ORDER.indexOf(g);
        if (gi >= 0) groupFlat.push(gi);
      }
    }
    this.jetGroupStart[this.jetCount] = groupFlat.length;
    this.jetGroupIndex = new Uint8Array(groupFlat);

    if (quadBatch.count > 0) {
      this.quadGeo = buildQuadGeometry();
      this.quadDriveAttr = quadBatch.attach(this.quadGeo, true);
      this.quadMesh = new InstancedMesh(this.quadGeo, this.additiveMat, quadBatch.count);
      this.quadMesh.instanceMatrix.array.set(quadBatch.matrix.subarray(0, quadBatch.count * 16));
      this.quadMesh.instanceMatrix.needsUpdate = true;
      this.quadMesh.frustumCulled = false;
      this.quadMesh.renderOrder = 4;
      this.group.add(this.quadMesh);
    }

    // ---- re-entry wake ----------------------------------------------------
    if (bp.technologyProfile.atmosphereCapable) {
      const wakeBatch = new AdditiveBatch(1);
      const aft = bp.dimensions.bounds.max[2];
      m.identity().setPosition(0, 0, aft * 0.95);
      wakeBatch.push(m, KIND_WAKE, coreColor, coreColor, [L * 3.8, bp.dimensions.beamKm * 0.75, 0.6, 0], [0, 0, 0, 0], 1);
      this.wakeGeo = buildShellGeometry(budget.wakeSeg, budget.wakeSteps, 1, 0.8);
      wakeBatch.attach(this.wakeGeo, false);
      this.wakeMesh = new InstancedMesh(this.wakeGeo, this.additiveMat, 1);
      this.wakeMesh.instanceMatrix.array.set(wakeBatch.matrix.subarray(0, 16));
      this.wakeMesh.instanceMatrix.needsUpdate = true;
      this.wakeMesh.frustumCulled = false;
      this.wakeMesh.renderOrder = 5;
      this.wakeMesh.visible = false;
      this.group.add(this.wakeMesh);
    }
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private meanPlumeLength(pods: readonly EnginePod[], lenMul: number): number {
    let sum = 0;
    for (const p of pods) sum += p.nozzle.exitRadius * Math.max(p.plume.lengthRatio, 0.5) * lenMul;
    return sum / Math.max(pods.length, 1);
  }

  private repeatColor(c: Color, n: number): Float32Array {
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
    }
    return a;
  }

  /** FNV-1a. Deterministic phases from ids, so no `Math.random()` ever appears. */
  private hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Navigation lights, beacons and docking guides, per the faction's palette.
   *
   * Side convention is read from the fixture's own position, because that is
   * the one navigation-light rule every culture in the game shares: port is one
   * colour, starboard is the other, and the strobes are neither. Everything
   * else — which hue, how bright — comes from `bp.palette`.
   */
  private collectLights(bp: ShipBlueprint): AdditiveBatch {
    const port = new Color(bp.palette.navPort[0], bp.palette.navPort[1], bp.palette.navPort[2]);
    const stbd = new Color(bp.palette.navStarboard[0], bp.palette.navStarboard[1], bp.palette.navStarboard[2]);
    const strobe = new Color(bp.palette.navStrobe[0], bp.palette.navStrobe[1], bp.palette.navStrobe[2]);
    const beacon = new Color(bp.palette.beacon[0], bp.palette.beacon[1], bp.palette.beacon[2]);

    const fixtures = bp.modules.filter((mod) => mod.present && (mod.kind === 'navlight' || mod.kind === 'beacon'));
    let guides = 0;
    for (const d of bp.dockingPoints) guides += Math.max(0, Math.round(d.guideLightCount));

    const batch = new AdditiveBatch(Math.min(MAX_LIGHTS, fixtures.length + guides));
    const m = new Matrix4();
    const local = new Matrix4();
    const world = new Matrix4();

    // A fixture is a piece of hardware a person installs, so its physical size
    // comes from a human dimension band — never from the ship's length. The
    // shader's pixel floor is what keeps it visible on a capital.
    const lo = 0.00022;
    const hi = 0.0014;

    for (const mod of fixtures) {
      frameMatrix(mod.frame, m);
      this._v.set(mod.frame.forward[0], mod.frame.forward[1], mod.frame.forward[2]).normalize();
      const size = clamp(Math.max(mod.halfExtents[0], mod.halfExtents[1]) || lo, lo, hi);
      m.setPosition(
        mod.frame.origin[0] + this._v.x * size,
        mod.frame.origin[1] + this._v.y * size,
        mod.frame.origin[2] + this._v.z * size,
      );

      const x = mod.frame.origin[0];
      const lateral = Math.abs(x) > bp.dimensions.beamKm * 0.06;
      let col = strobe;
      let pattern = PATTERN_STROBE;
      let intensity = 4.6;
      if (mod.kind === 'beacon') {
        col = beacon;
        pattern = PATTERN_BEACON;
        intensity = 5.4;
      } else if (lateral) {
        col = x < 0 ? port : stbd;
        pattern = PATTERN_STEADY;
        intensity = 4.0;
      }
      const phase = ((this.hashString(mod.id) >>> 0) % 4096) / 4096;
      batch.push(m, KIND_LIGHT, col, col, [size, size, intensity, phase], [pattern, 0, 0, 0], 1);
    }

    // Docking guides: a ring round the collar, phase-sequenced into a chase
    // running towards the port. The HUD homes on these, so they are the one
    // light group that must read as a group and not as scattered dots.
    for (const d of bp.dockingPoints) {
      const n = Math.max(0, Math.round(d.guideLightCount));
      if (n === 0) continue;
      frameMatrix(d.frame, m);
      m.setPosition(d.frame.origin[0], d.frame.origin[1], d.frame.origin[2]);
      const ring = d.diameter * 0.5;
      const size = clamp(d.diameter * 0.045, lo, hi);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        local.identity().setPosition(Math.cos(a) * ring, Math.sin(a) * ring, size);
        world.multiplyMatrices(m, local);
        batch.push(world, KIND_LIGHT, strobe, strobe, [size, size, 3.4, i / n], [PATTERN_GUIDE, i, 0, 0], 1);
      }
    }
    return batch;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState, state: ShipDriveState): void {
    this.time += dt;

    // Nothing snaps. A drive spools, heat builds and bleeds, the bus comes up.
    // The spool rate is scaled with the hull so a capital takes visibly longer
    // to answer the throttle than a courier does.
    const spool = 3.0 * this.timeScale;
    this.vThrottle = damp(this.vThrottle, clamp01(state.throttle), spool, dt);
    this.vBoost = damp(this.vBoost, clamp01(state.boost), 2.2 * this.timeScale, dt);
    this.vHeat = damp(this.vHeat, clamp01(state.heating), 1.5, dt);
    this.vPower = damp(this.vPower, state.powered ? 1 : 0, 1.8, dt);

    const th = this.vThrottle;
    const boost = this.vBoost;
    const drive = clamp01(th + boost * 0.35);

    // ---- shared uniforms --------------------------------------------------
    const nu = this.nozzleMat.uniforms;
    nu.uTime.value = this.time;
    nu.uThrottle.value = drive;
    nu.uGlowDepth.value = 0.12 + drive * 0.75;
    nu.uPower.value = this.vPower;
    // Aliased by reference: ViewState's vectors are refilled in place by the
    // integrator every frame, so copying them would be pure waste.
    nu.uSunDir.value = view.sunDirection;
    nu.uSunColor.value = view.sunColor;
    nu.uCameraLocal.value = view.cameraLocal;
    nu.uFill.value = this.fillColor;

    const au = this.additiveMat.uniforms;
    au.uTime.value = this.time;
    au.uThrottle.value = th;
    au.uBoost.value = boost;
    au.uHeat.value = this.vHeat;
    au.uCameraLocal.value = view.cameraLocal;
    // One number carries every screen-space decision in this file, exactly as
    // Planet.ts does: km per pixel at distance d is d * uPixelAngle.
    au.uPixelAngle.value = (2 * Math.tan(view.fovY * 0.5)) / Math.max(view.viewportHeight, 1);

    // ---- engine glow ------------------------------------------------------
    const glowArr = this.engineGlowUniforms.uEngineGlow.value;
    for (let i = 0; i < this.glowCount; i++) {
      glowArr[i * 4 + 3] = this.glowStrength[i] * drive * this.vPower * 2.2;
    }
    // The wash reaches as far as the column that makes it.
    this.engineGlowUniforms.uEngineGlowRange.value = this.glowRangeBase * (0.35 + drive * 0.9);

    if (this.plumeMesh) this.plumeMesh.visible = drive > 0.008 && this.vPower > 0.02;

    // ---- gimbal -----------------------------------------------------------
    if (this.hasGimbal) {
      this.vGimbalPitch = damp(this.vGimbalPitch, clamp(state.angular.x, -1, 1), 6 * this.timeScale, dt);
      this.vGimbalYaw = damp(this.vGimbalYaw, clamp(state.angular.y, -1, 1), 6 * this.timeScale, dt);
      this.applyGimbal();
    }

    this.updateDifferentialThrust(state);

    // ---- RCS --------------------------------------------------------------
    this.updateJets(dt, state);

    // ---- re-entry ---------------------------------------------------------
    if (this.wakeMesh) this.wakeMesh.visible = this.vHeat > 0.01;
  }

  /**
   * Deflect the main nozzles.
   *
   * Two or three degrees of visible gimbal under a hard pitch input is one of
   * the cheapest reads there is on a ship being *flown* rather than animated,
   * and the plume has to follow the bell or the illusion inverts immediately.
   */
  private applyGimbal(): void {
    const meshes = this.nozzleMeshes;
    for (let i = 0; i < this.nozzles.length; i++) {
      const n = this.nozzles[i];
      if (n.gimbal <= 1e-4) continue;
      const mesh = meshes[n.mesh];
      // Thrust opposes exhaust, so a nose-up command swings the bells the other
      // way. The sign is the whole point of doing this at all.
      this._qg.setFromAxisAngle(this._axisX, -this.vGimbalPitch * n.gimbal);
      this._q.copy(this.nozzleQuat[i]).multiply(this._qg);
      this._qg.setFromAxisAngle(this._axisY, -this.vGimbalYaw * n.gimbal);
      this._q.multiply(this._qg);
      this._m4.compose(this.nozzlePos[i], this._q, this._scale);
      this._m4.toArray(mesh.instanceMatrix.array as Float32Array, n.slot * 16);
      if (this.plumeMesh && n.plumeSlot >= 0) {
        // The plume anchors at the exit plane, which moves when the bell swings.
        this._m4b.identity().setPosition(0, 0, this.nozzleBell[i]);
        this._m4b.premultiply(this._m4);
        this._m4b.toArray(this.plumeMesh.instanceMatrix.array as Float32Array, n.plumeSlot * 16);
      }
    }
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
    if (this.plumeMesh) this.plumeMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Differential thrust across the engine rank.
   *
   * Thrust is -Z at each nozzle's own station, so the torque a nozzle makes
   * about +X goes as -y and about +Y as +x. Trimming each plume by that lever
   * arm means a pitch-up command visibly favours the LOWER bells — physically
   * right, and free, because the plume already carries a per-instance drive.
   */
  private updateDifferentialThrust(state: ShipDriveState): void {
    const attr = this.plumeDriveAttr;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    const p = clamp(state.angular.x, -1, 1);
    const w = clamp(state.angular.y, -1, 1);
    const g = this.differentialGain;
    for (let i = 0; i < this.nozzles.length; i++) {
      const slot = this.nozzles[i].plumeSlot;
      if (slot < 0) continue;
      const trim = -this.nozzleLever[i * 2 + 1] * p + this.nozzleLever[i * 2] * w;
      arr[slot] = clamp(1 + g * trim, 0.12, 1.7);
    }
    attr.needsUpdate = true;
  }

  /**
   * RCS: which nozzle fires, and how.
   *
   * Demand comes from the blueprint's own `RcsGroup` membership rather than
   * from a dot product against the commanded vector, which means a nozzle that
   * the generator placed to produce a COUPLE fires on a rotation command even
   * though its exhaust does not oppose any translation. That is most of the
   * difference between a ship that manoeuvres and a ship that slides.
   */
  private updateJets(dt: number, state: ShipDriveState): void {
    if (!this.quadMesh || !this.quadDriveAttr) return;
    const levels = this.quadDriveAttr.array as Float32Array;

    // Lights occupy the head of the buffer and follow the bus. Written before
    // the early-out: a ship with no RCS still has navigation lights.
    for (let i = 0; i < this.jetBase; i++) levels[i] = this.vPower;
    if (this.jetCount === 0) {
      this.quadDriveAttr.needsUpdate = true;
      return;
    }

    const d = this.groupDemand;
    const t = state.translation;
    const a = state.angular;
    d[0] = Math.max(0, a.x);
    d[1] = Math.max(0, -a.x);
    d[2] = Math.max(0, a.y);
    d[3] = Math.max(0, -a.y);
    d[4] = Math.max(0, a.z);
    d[5] = Math.max(0, -a.z);
    d[6] = Math.max(0, t.x);
    d[7] = Math.max(0, -t.x);
    d[8] = Math.max(0, t.y);
    d[9] = Math.max(0, -t.y);
    d[10] = Math.max(0, t.z);
    d[11] = Math.max(0, -t.z);

    const tmag = Math.min(1, Math.hypot(t.x, t.y, t.z));
    // Valves on a big ship are big valves: the chatter slows with the hull.
    const dutyFreq = 17 * this.timeScale;
    const attack = 38 * this.timeScale;
    const decay = 7.5 * this.timeScale;

    for (let i = 0; i < this.jetCount; i++) {
      let target = 0;
      const g0 = this.jetGroupStart[i];
      const g1 = this.jetGroupStart[i + 1];
      if (g1 > g0) {
        for (let g = g0; g < g1; g++) {
          const v = d[this.jetGroupIndex[g]];
          if (v > target) target = v;
        }
      } else if (tmag > 1e-4) {
        // Fallback for a blueprint that left `groups` empty: thrust is opposite
        // the exhaust, so the firing nozzle is the one pointing away from where
        // the pilot asked to go.
        const align = -(this.jetDir[i * 3] * t.x + this.jetDir[i * 3 + 1] * t.y + this.jetDir[i * 3 + 2] * t.z) / tmag;
        if (align > 0.3) target = Math.min(1, (align - 0.3) / 0.5) * tmag;
      }

      if (target > 0) {
        // Cold-gas thrusters are bang-bang valves. They stutter; they never
        // hold. Replacing this with a smooth ramp is the single change that
        // makes a ship stop looking flown.
        const duty = Math.sin(this.time * dutyFreq + this.jetPhase[i] * 6.2831853);
        target *= duty > -0.15 ? 1 : 0.1;
      }
      // Fast attack, slow decay: that asymmetry IS the puff.
      const rate = target > this.jetLevel[i] ? attack : decay;
      this.jetLevel[i] = damp(this.jetLevel[i], target, rate, dt);
      levels[this.jetBase + i] = this.jetLevel[i];
    }
    this.quadDriveAttr.needsUpdate = true;
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    for (const g of this.nozzleGeos) g.dispose();
    for (const mesh of this.nozzleMeshes) mesh.dispose();
    this.nozzleGeos.length = 0;
    this.nozzleMeshes.length = 0;

    this.plumeGeo?.dispose();
    this.plumeMesh?.dispose();
    this.quadGeo?.dispose();
    this.quadMesh?.dispose();
    this.wakeGeo?.dispose();
    this.wakeMesh?.dispose();
    this.plumeGeo = null;
    this.plumeMesh = null;
    this.quadGeo = null;
    this.quadMesh = null;
    this.wakeGeo = null;
    this.wakeMesh = null;

    this.nozzleMat.dispose();
    this.additiveMat.dispose();

    this.group.clear();
  }
}
