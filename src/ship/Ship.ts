/**
 * The ship you fly — hull, greebles, engines, thrusters, re-entry.
 *
 * Design language: a working vessel, not a fighter. Everything here exists to
 * sell one idea — this thing has a maintenance history. It is asymmetric
 * because a bolt-on was welded to one side and never to the other; it is dirty
 * because nobody washes a hull; its panels do not match because half of them
 * were replaced by three different yards.
 *
 * The hull is a swept superellipse (a lathe that can change its cross-section),
 * bolt-ons are boxes and cylinders merged into the same buffer, and every panel
 * line, rivet, streak and chip lives in the fragment shader. No CSG, no UV
 * unwrap: all surface detail is triplanar, driven by object-space position.
 *
 * DRAW CALLS: 10 — hull, four greeble families, emissive lights, nozzles,
 * plume, RCS puffs, re-entry wake. The last two switch themselves off when
 * idle, so a coasting ship costs 8.
 *
 * UNITS: kilometres. The ship is 0.03 km (30 m) long, nose at z = -0.015,
 * tail at z = +0.015. Forward is -Z, up is +Y, starboard is +X.
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
  Mesh,
  Object3D,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import { Rng, hashSeed } from '@/math/rng';
import { registerShaderChunks } from '@/shaders/chunks';
import { registerShot } from '@/game/Shots';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface ShipState {
  /** Main engine demand, 0..1. */
  readonly throttle: number;
  /** Overdrive on top of throttle, 0..1. Shifts the plume white-hot. */
  readonly boost: number;
  /** Re-entry heating, 0..1. Drives leading-edge glow and the plasma wake. */
  readonly heating: number;
  /**
   * Commanded translation in SHIP-LOCAL space, roughly -1..1 per axis.
   * The thruster whose exhaust opposes this vector is the one that fires.
   */
  readonly rcs: Vector3;
}

/** Ship length in km. The whole model is authored against this. */
export const SHIP_LENGTH_KM = 0.03;

const HALF = SHIP_LENGTH_KM * 0.5;
/** Maximum hull half-width in km — an 8.4 m beam on a 30 m boat. */
const MAX_R = 0.0042;

const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * Re-frames a bolt-on so it mounts on a cylinder wall rather than on the hull:
 * its mounting face (+Y) turns to face the frame's +X, and its long axis (+Z)
 * lies along the frame's +Y. Used for the hardware bolted to the nacelles.
 */
const RADIAL_MOUNT = new Matrix4().makeBasis(
  new Vector3(0, 0, 1),
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
);

// ---------------------------------------------------------------------------
// Small maths helpers (module scope — never called from update())
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. `rate` is roughly "how many
 * e-foldings per second"; nothing in this file ever assigns a target directly.
 */
function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// ---------------------------------------------------------------------------
// Geometry builder — accumulates one merged, indexed buffer
// ---------------------------------------------------------------------------

interface Occluder {
  x: number;
  y: number;
  z: number;
  r: number;
}

/**
 * A sphere that interrupts the key light. Deliberately a different list from
 * `Occluder`: contact AO wants one fat blob per bolt-on centred where it meets
 * the plating, a cast shadow wants a chain of tight spheres following the part
 * out into the light. `part` is the part id of the caster, so a fin never
 * shadows itself.
 */
interface Shadower {
  x: number;
  y: number;
  z: number;
  r: number;
  part: number;
}

/**
 * Uniform array sizes, hard-coded into the shader as defines. 28 sphere tests
 * and 6 point lights per fragment on a 30 m object is a rounding error next to
 * the four fbm calls the same shader already runs.
 */
const OCC_MAX = 28;
const LAMP_MAX = 6;

/**
 * Positions, indices and three shading channels. Normals are accumulated from
 * face normals at the end, which gives smooth shading exactly where vertices
 * are shared and flat shading exactly where they are not — so a box built with
 * four vertices per face comes out faceted for free.
 */
class HullBuilder {
  readonly pos: number[] = [];
  readonly wear: number[] = [];
  readonly part: number[] = [];
  readonly ao: number[] = [];
  readonly idx: number[] = [];

  vertex(x: number, y: number, z: number, wear: number, part: number, ao: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.wear.push(wear);
    this.part.push(part);
    this.ao.push(ao);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Accumulate area-weighted face normals; unshared vertices stay faceted. */
  private computeNormals(): Float32Array {
    const n = new Float32Array(this.pos.length);
    const p = this.pos;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3;
      const b = this.idx[i + 1] * 3;
      const c = this.idx[i + 2] * 3;
      const ax = p[b] - p[a];
      const ay = p[b + 1] - p[a + 1];
      const az = p[b + 2] - p[a + 2];
      const bx = p[c] - p[a];
      const by = p[c + 1] - p[a + 1];
      const bz = p[c + 2] - p[a + 2];
      // Un-normalised cross product weights each face by twice its area.
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      n[a] += nx;
      n[a + 1] += ny;
      n[a + 2] += nz;
      n[b] += nx;
      n[b + 1] += ny;
      n[b + 2] += nz;
      n[c] += nx;
      n[c + 1] += ny;
      n[c + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
    return n;
  }

  /**
   * @param perVertexWear false for instanced base geometry, where wear and
   *        part id arrive as per-instance attributes instead.
   */
  toGeometry(perVertexWear: boolean): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(this.computeNormals(), 3));
    g.setAttribute('aAO', new BufferAttribute(new Float32Array(this.ao), 1));
    if (perVertexWear) {
      g.setAttribute('aWear', new BufferAttribute(new Float32Array(this.wear), 1));
      g.setAttribute('aPart', new BufferAttribute(new Float32Array(this.part), 1));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const _v = new Vector3();
const _v2 = new Vector3();
const _bx = new Vector3();
const _by = new Vector3();
const _bz = new Vector3();

/** Transform a local point by `m` and push it. Construction-time only. */
function pushLocal(
  b: HullBuilder,
  m: Matrix4,
  x: number,
  y: number,
  z: number,
  wear: number,
  part: number,
  ao: number,
): number {
  _v.set(x, y, z).applyMatrix4(m);
  return b.vertex(_v.x, _v.y, _v.z, wear, part, ao);
}

/** Ambient occlusion for a bolt-on: dark where it meets the hull (y = 0). */
function mountAO(y: number, h: number): number {
  return 0.3 + 0.7 * Math.pow(clamp01(y / (h || 1)), 0.7);
}

/**
 * A box spanning x/z about the origin and y from 0 (the mounting face) up.
 * Four vertices per face, so it shades hard-edged.
 */
function addBox(
  b: HullBuilder,
  m: Matrix4,
  sx: number,
  sy: number,
  sz: number,
  wear: number,
  part: number,
): void {
  const hx = sx * 0.5;
  const hz = sz * 0.5;
  const a0 = mountAO(0, sy);
  const a1 = mountAO(sy, sy);
  // +Y (top)
  let i = pushLocal(b, m, -hx, sy, -hz, wear, part, a1);
  b.quad(
    i,
    pushLocal(b, m, hx, sy, -hz, wear, part, a1),
    pushLocal(b, m, hx, sy, hz, wear, part, a1),
    pushLocal(b, m, -hx, sy, hz, wear, part, a1),
  );
  // -Y (bottom / mounting face)
  i = pushLocal(b, m, -hx, 0, hz, wear, part, a0);
  b.quad(
    i,
    pushLocal(b, m, hx, 0, hz, wear, part, a0),
    pushLocal(b, m, hx, 0, -hz, wear, part, a0),
    pushLocal(b, m, -hx, 0, -hz, wear, part, a0),
  );
  // +Z
  i = pushLocal(b, m, -hx, 0, hz, wear, part, a0);
  b.quad(
    i,
    pushLocal(b, m, -hx, sy, hz, wear, part, a1),
    pushLocal(b, m, hx, sy, hz, wear, part, a1),
    pushLocal(b, m, hx, 0, hz, wear, part, a0),
  );
  // -Z
  i = pushLocal(b, m, hx, 0, -hz, wear, part, a0);
  b.quad(
    i,
    pushLocal(b, m, hx, sy, -hz, wear, part, a1),
    pushLocal(b, m, -hx, sy, -hz, wear, part, a1),
    pushLocal(b, m, -hx, 0, -hz, wear, part, a0),
  );
  // +X
  i = pushLocal(b, m, hx, 0, hz, wear, part, a0);
  b.quad(
    i,
    pushLocal(b, m, hx, sy, hz, wear, part, a1),
    pushLocal(b, m, hx, sy, -hz, wear, part, a1),
    pushLocal(b, m, hx, 0, -hz, wear, part, a0),
  );
  // -X
  i = pushLocal(b, m, -hx, 0, -hz, wear, part, a0);
  b.quad(
    i,
    pushLocal(b, m, -hx, sy, -hz, wear, part, a1),
    pushLocal(b, m, -hx, sy, hz, wear, part, a1),
    pushLocal(b, m, -hx, 0, hz, wear, part, a0),
  );
}

/** A capped cone/cylinder standing on y = 0, radius r0 at the base, r1 on top. */
function addCylinder(
  b: HullBuilder,
  m: Matrix4,
  r0: number,
  r1: number,
  h: number,
  seg: number,
  wear: number,
  part: number,
): void {
  const base: number[] = [];
  const top: number[] = [];
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const c = Math.cos(a);
    const si = Math.sin(a);
    base.push(pushLocal(b, m, c * r0, 0, si * r0, wear, part, mountAO(0, h)));
    top.push(pushLocal(b, m, c * r1, h, si * r1, wear, part, mountAO(h, h)));
  }
  for (let s = 0; s < seg; s++) {
    const n = (s + 1) % seg;
    b.quad(base[s], base[n], top[n], top[s]);
  }
  // Flat cap: its own vertex ring so the rim stays a hard edge.
  if (r1 > 1e-7) {
    const centre = pushLocal(b, m, 0, h, 0, wear, part, mountAO(h, h));
    const cap: number[] = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      cap.push(pushLocal(b, m, Math.cos(a) * r1, h, Math.sin(a) * r1, wear, part, mountAO(h, h)));
    }
    for (let s = 0; s < seg; s++) b.tri(centre, cap[s], cap[(s + 1) % seg]);
  }
}

// ---------------------------------------------------------------------------
// Greeble families
//
// Each is authored in a unit footprint — x and z in [-0.5, 0.5], y from 0 (the
// mounting face) up to about 1 — so one per-instance scale drives all of them.
// They are assemblies, not primitives: a bare box and a bare cylinder gave the
// whole hull exactly two silhouettes.
// ---------------------------------------------------------------------------

type GreebleKind = 'hatch' | 'bracket' | 'ribbed' | 'stack' | 'pipe';

const _gm = new Matrix4();

/** Access panel: a shallow plate with a raised lip and a latch block. */
function greebleHatch(): BufferGeometry {
  const b = new HullBuilder();
  addBox(b, _gm.identity(), 1, 0.42, 1, 0, 0);
  addBox(b, _gm.makeTranslation(0, 0.42, 0), 0.78, 0.2, 0.78, 0, 0);
  addBox(b, _gm.makeTranslation(0.3, 0.42, -0.22), 0.18, 0.34, 0.3, 0, 0);
  return b.toGeometry(false);
}

/** L-bracket: an upright web with a foot, the commonest bolt-on in the world. */
function greebleBracket(): BufferGeometry {
  const b = new HullBuilder();
  addBox(b, _gm.makeTranslation(0, 0, 0.16), 0.9, 0.22, 0.66, 0, 0);
  addBox(b, _gm.makeTranslation(0, 0, -0.32), 0.9, 1.0, 0.22, 0, 0);
  addBox(b, _gm.makeTranslation(-0.28, 0.22, -0.1), 0.16, 0.5, 0.2, 0, 0);
  return b.toGeometry(false);
}

/** Ribbed strip: a cable run or a heat-sink, three fins on a base rail. */
function greebleRibbed(): BufferGeometry {
  const b = new HullBuilder();
  addBox(b, _gm.identity(), 1, 0.18, 0.9, 0, 0);
  for (let i = 0; i < 3; i++) {
    addBox(b, _gm.makeTranslation((i - 1) * 0.33, 0.18, 0), 0.14, 0.66, 0.94, 0, 0);
  }
  return b.toGeometry(false);
}

/** Stacked boxes: two crates strapped down, deliberately off-square. */
function greebleStack(): BufferGeometry {
  const b = new HullBuilder();
  addBox(b, _gm.identity(), 1, 0.5, 0.8, 0, 0);
  addBox(b, _gm.makeTranslation(-0.12, 0.5, 0.08), 0.62, 0.55, 0.56, 0, 0);
  addBox(b, _gm.makeTranslation(0.36, 0.16, -0.2), 0.24, 0.24, 0.3, 0, 0);
  return b.toGeometry(false);
}

/** Short capped pipe with a flange at its root. */
function greeblePipe(): BufferGeometry {
  const b = new HullBuilder();
  addCylinder(b, _gm.identity(), 0.5, 0.44, 0.14, 12, 0, 0);
  addCylinder(b, _gm.makeTranslation(0, 0.14, 0), 0.3, 0.27, 0.86, 10, 0, 0);
  addCylinder(b, _gm.makeTranslation(0, 0.74, 0), 0.4, 0.36, 0.12, 10, 0, 0);
  return b.toGeometry(false);
}

// ---------------------------------------------------------------------------
// The hull surface: a swept superellipse
// ---------------------------------------------------------------------------

interface HullRing {
  z: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Superellipse exponent. 2 = ellipse, 6 = almost a box. */
  n: number;
}

/**
 * The fuselage is a lofted cross-section rather than a lathe: the section can
 * go from a rounded nose to a boxy freight tail and drift off the centreline
 * on the way, which is what stops it reading as a missile.
 */
class HullShape {
  readonly rings: HullRing[] = [];
  /** Constant-along-length radial modulation: this is what makes the chines. */
  private readonly modAmp: number[] = [];
  private readonly modFreq: number[] = [];
  private readonly modPhase: number[] = [];

  constructor(rng: Rng, ringCount: number) {
    const bulges = [
      { t: rng.range(0.3, 0.55), a: rng.range(0.06, 0.2), w: rng.range(0.08, 0.16) },
      { t: rng.range(0.55, 0.85), a: rng.range(-0.12, 0.1), w: rng.range(0.06, 0.14) },
      { t: rng.range(0.15, 0.35), a: rng.range(-0.08, 0.08), w: rng.range(0.05, 0.1) },
    ];
    const xBend = rng.range(-0.16, 0.16);
    const hLow = rng.range(0.56, 0.66);
    const hHigh = rng.range(0.78, 0.94);

    for (let i = 0; i < ringCount; i++) {
      const t = i / (ringCount - 1);
      const nose = smoothstep(0, 0.26, t);
      const tail = 1 - 0.2 * smoothstep(0.72, 1, t);
      let env = (0.3 + 0.7 * Math.pow(nose, 0.65)) * tail;
      for (const bl of bulges) {
        const d = (t - bl.t) / bl.w;
        env *= 1 + bl.a * Math.exp(-0.5 * d * d);
      }
      const hRatio = hLow + (hHigh - hLow) * smoothstep(0.15, 0.85, t);
      this.rings.push({
        z: -HALF + t * SHIP_LENGTH_KM,
        cx: MAX_R * xBend * Math.sin(t * Math.PI * 0.9),
        // Rides nose-down: the belly stays flat, the spine climbs aft.
        cy: MAX_R * (0.12 * smoothstep(0.25, 1, t) - 0.07 * (1 - env)),
        rx: MAX_R * env,
        ry: MAX_R * env * hRatio,
        n: 2.5 + 2.3 * smoothstep(0.1, 0.9, t),
      });
    }

    const chines = rng.int(2, 3);
    for (let k = 0; k < chines; k++) {
      this.modAmp.push(rng.range(0.03, 0.085));
      this.modFreq.push(rng.int(3, 7));
      this.modPhase.push(rng.range(0, Math.PI * 2));
    }
  }

  private modulation(theta: number): number {
    let m = 1;
    for (let k = 0; k < this.modAmp.length; k++) {
      m += this.modAmp[k] * Math.cos(this.modFreq[k] * theta + this.modPhase[k]);
    }
    return m;
  }

  /** `t` runs 0 (nose) to 1 (tail); `theta` 0 = starboard, PI/2 = up. */
  sample(t: number, theta: number, out: Vector3): Vector3 {
    const f = clamp01(t) * (this.rings.length - 1);
    const i0 = Math.min(this.rings.length - 2, Math.floor(f));
    const k = f - i0;
    const a = this.rings[i0];
    const b = this.rings[i0 + 1];
    const z = a.z + (b.z - a.z) * k;
    const cx = a.cx + (b.cx - a.cx) * k;
    const cy = a.cy + (b.cy - a.cy) * k;
    const rx = a.rx + (b.rx - a.rx) * k;
    const ry = a.ry + (b.ry - a.ry) * k;
    const n = a.n + (b.n - a.n) * k;

    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const e = 2 / n;
    let sx = Math.sign(c) * Math.pow(Math.abs(c), e);
    let sy = Math.sign(s) * Math.pow(Math.abs(s), e);
    // Flat-bottomed: freighters land on their bellies.
    if (sy < 0) sy *= 0.82;
    const m = this.modulation(theta);
    sx *= m;
    sy *= m;
    return out.set(cx + rx * sx, cy + ry * sy, z);
  }

  /** Numeric surface normal. Construction-time only — it allocates nothing. */
  normal(t: number, theta: number, out: Vector3): Vector3 {
    const dt = 0.004;
    const da = 0.01;
    this.sample(Math.min(1, t + dt), theta, _bx);
    this.sample(Math.max(0, t - dt), theta, _by);
    _bx.sub(_by); // d/dt
    this.sample(t, theta + da, _bz);
    this.sample(t, theta - da, _v2);
    _bz.sub(_v2); // d/dtheta
    return out.crossVectors(_bz, _bx).normalize();
  }
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/**
 * Panel plating on an arbitrary 2D projection of object space.
 *
 * A jittered two-level grid beats worley cells here: real hull plating is
 * rectangular and irregular *in size*, not in shape. Returns
 * (distance to nearest seam, panel id hash, coordinate along that seam).
 */
const PANEL_GLSL = /* glsl */ `
float shipHash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 shipPanels(vec2 q) {
  vec2 g0 = floor(q);
  vec2 f0 = q - g0;
  float r = shipHash21(g0 + 11.3);
  vec2 sub = r < 0.36 ? vec2(2.0, 1.0) : (r < 0.68 ? vec2(1.0, 2.0) : vec2(2.0, 2.0));
  vec2 q1 = f0 * sub;
  vec2 g1 = floor(q1);
  vec2 f1 = q1 - g1;
  vec2 d = min(f1, 1.0 - f1) / sub;
  float line = min(d.x, d.y);
  float id = shipHash21(g0 * 3.71 + g1 * 1.13 + 5.0);
  float along = d.x < d.y ? q.y : q.x;
  return vec3(line, id, along);
}

float shipSeam(float d, float w) {
  float e = fwidth(d) * 1.4 + 1e-7;
  return 1.0 - smoothstep(w - e, w + e, d);
}
`;

const HULL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

// Per-vertex on the hull, per-instance on the greebles — same declaration
// either way, three binds whichever the geometry supplies.
attribute float aAO;
attribute float aWear;
attribute float aPart;

varying vec3 vPos;
varying vec3 vNrm;
varying float vWear;
varying float vPart;
varying float vAO;

void main() {
  vec3 p = position;
  vec3 n = normal;

  #ifdef USE_INSTANCING
    mat3 im = mat3(instanceMatrix);
    // Correct normal transform for a rotation*scale matrix without inverting.
    vec3 sc = vec3(length(im[0]), length(im[1]), length(im[2]));
    p = (instanceMatrix * vec4(p, 1.0)).xyz;
    n = im * (n / max(sc * sc, vec3(1e-9)));
  #endif

  vPos = p;
  vNrm = normalize(n);
  vWear = aWear;
  vPart = aPart;
  vAO = aAO;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const HULL_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>
${PANEL_GLSL}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCameraLocal;
uniform vec3 uFill;
uniform vec3 uPaint;
uniform vec3 uPaintAlt;
uniform vec3 uMetal;
uniform vec3 uAmber;
uniform vec3 uPlumeColor;
uniform vec3 uEngineA;
uniform vec3 uEngineB;
uniform vec3 uFlowDir;
uniform float uTime;
uniform float uThrottle;
uniform float uHeat;
uniform float uPanelScale;
uniform float uCurvScale;
uniform float uGrime;
uniform float uBump;
// xyz = centre in object space, w = radius. Unused slots carry w = 0.
uniform vec4 uOcc[SHIP_OCC_MAX];
// Part id of the caster in the matching uOcc slot, so nothing shadows itself.
uniform float uOccPart[SHIP_OCC_MAX];
// xyz = window position in object space, w = strength.
uniform vec4 uLamp[SHIP_LAMP_MAX];

varying vec3 vPos;
varying vec3 vNrm;
varying float vWear;
varying float vPart;
varying float vAO;

void main() {
  #include <logdepthbuf_fragment>

  vec3 N = normalize(vNrm);
  vec3 P = vPos;
  vec3 V = normalize(uCameraLocal - P);

  vec3 dPx = dFdx(P);
  vec3 dPy = dFdy(P);
  vec3 dNx = dFdx(N);
  vec3 dNy = dFdy(N);
  // |dN/dP| is a view-independent curvature estimate: it spikes on every
  // geometric edge, which is exactly where paint wears through.
  float curv = (length(dNx) + length(dNy)) / max(length(dPx) + length(dPy), 1e-12);
  float edge = clamp(curv * uCurvScale, 0.0, 1.0);

  // --- plating -------------------------------------------------------------
  vec3 an = abs(N);
  an = an * an * an;
  an *= an;
  an /= max(an.x + an.y + an.z, 1e-5);

  // Plate size is a per-part decision. Running one panel scale across the
  // fuselage, the fin, the pods and the pannier is what makes the plating read
  // as one projected texture instead of as sheet metal cut by four yards.
  // Held at exactly uPanelScale on the fuselage (part 0) so the ship still has
  // one reference plate size; the bolt-ons swing +/- 45% around it.
  float ps = uPanelScale
           * (1.0 + 0.9 * step(0.5, vPart) * (shipHash21(vec2(vPart * 7.31, 1.9)) - 0.5));
  vec2 poff = vec2(shipHash21(vec2(vPart * 3.17, 8.4)),
                   shipHash21(vec2(vPart * 5.09, 2.2))) * 23.0;

  vec3 pa = shipPanels(P.zy * ps + poff);
  vec3 pb = shipPanels(P.xz * ps + poff);
  vec3 pc = shipPanels(P.xy * ps + poff);

  float seam = shipSeam(pa.x, 0.008) * an.x
             + shipSeam(pb.x, 0.008) * an.y
             + shipSeam(pc.x, 0.008) * an.z;

  // Panel identity comes from the dominant plane only — blending ids is mush.
  // The hand-over between planes is warped, though: a clean switch draws a
  // lat/long lattice radiating off the nose, where the dominant plane flips
  // fastest. Warping it turns that boundary into a ragged butt joint.
  vec3 anj = an + os_fbm(P * 210.0, 2, 2.2, 0.5) * vec3(0.11, -0.07, 0.09);
  vec3 dom = anj.x > anj.y ? (anj.x > anj.z ? pa : pc) : (anj.y > anj.z ? pb : pc);
  float pid = dom.y;

  float rivet = 0.0;
  #ifdef SHIP_RIVETS
    float rf = 5.0;
    float ra = fract(dom.z * rf) - 0.5;
    float rd = length(vec2((dom.x - 0.02) * rf, ra));
    rivet = 1.0 - smoothstep(0.10, 0.20, rd);
    // Only some seams are riveted; the rest are welded.
    rivet *= step(0.42, shipHash21(vec2(pid * 31.0, 2.7)));
    rivet *= 1.0 - smoothstep(0.06, 0.11, dom.x);
  #endif

  // --- paint ---------------------------------------------------------------
  float ph = shipHash21(vec2(vPart * 13.7, 3.1));
  vec3 albedo = uPaint * (0.84 + 0.32 * ph);
  // Bolt-ons and replacement plates came from another yard.
  albedo = mix(albedo, uPaintAlt, step(0.72, ph) * 0.7);
  albedo *= 1.0 + (pid * 2.0 - 1.0) * 0.13;
  albedo = mix(albedo, uPaintAlt, step(0.87, pid) * 0.8);
  // Large-scale variation so no two square metres match.
  float macro = os_fbm(P * 90.0, 3, 2.1, 0.55) * 0.5 + 0.5;
  albedo *= 0.86 + 0.28 * macro;

  // --- grime, streaked along the airflow ----------------------------------
  vec3 sp = vec3(P.x * 2400.0, P.y * 2400.0, P.z * 210.0);
  float streak = os_fbm(sp, SHIP_GRIME_OCTAVES, 2.3, 0.5) * 0.5 + 0.5;
  // Contrasted hard into ribbons: soft noise reads as a dirty lens, not soot.
  streak = smoothstep(0.32, 0.82, streak);
  // A second, finer pass so the ribbons have fibres inside them.
  streak *= 0.55 + 0.45 * smoothstep(0.3, 0.9,
              os_fbm(sp * vec3(3.1, 3.1, 1.7), 3, 2.4, 0.5) * 0.5 + 0.5);
  // It runs aft and it pools on downward faces and in the gaps.
  float dirt = streak * (0.45 + 0.55 * clamp(-N.y * 0.6 + 0.55, 0.0, 1.0));
  dirt = mix(dirt, 1.0, 0.5 * seam);
  dirt = clamp(dirt * uGrime * 1.5, 0.0, 1.0);

  // --- edge wear -----------------------------------------------------------
  // Gated hard by noise: a curvature estimate this cheap saturates on anything
  // small in screen space, and ungated it turns every greeble into bare steel.
  float wearNoise = os_fbm(P * 1400.0, 3, 2.2, 0.55) * 0.5 + 0.5;
  float wear = smoothstep(0.55, 0.95, edge * (0.25 + 1.05 * wearNoise) * (0.4 + 0.8 * vWear));
  float chip = smoothstep(0.72, 0.80, os_fbm(P * 820.0, 3, 2.4, 0.5) * 0.5 + 0.5)
             * smoothstep(0.06, 0.5, edge);
  float bare = clamp(wear + chip * 0.7, 0.0, 1.0);

  // Not quite 1.0: a fully metallic fragment has no diffuse at all, and with
  // no environment to reflect that is how every worn edge and every greeble
  // ended up as a flat black fleck. Oxidised steel is not a perfect conductor.
  float metalness = mix(0.16, 0.88, bare);
  // Undirtied paint has to stay tight enough for the raking key to leave one
  // readable streak down the spine; above ~0.6 the lobe is too wide to lift
  // anything off the silhouette.
  float rough = mix(mix(0.46, 0.30, bare), 0.86, dirt);
  albedo = mix(albedo, uMetal, bare);
  // Soot is warm, and it eats the paint's chroma as well as its value.
  albedo = mix(albedo, vec3(dot(albedo, vec3(0.30, 0.59, 0.11))) * vec3(0.42, 0.36, 0.30), dirt);

  // Cavity: the seam is a hole, so it is darker and rougher than the plate.
  albedo *= 1.0 - 0.55 * seam;
  rough = mix(rough, 0.92, seam * 0.5);
  albedo = mix(albedo, uMetal * 0.9, rivet * 0.3);
  rough = mix(rough, 0.35, rivet * 0.4);

  float ao = clamp(vAO, 0.0, 1.0) * (1.0 - 0.55 * seam) * (1.0 - 0.22 * dirt);

  // --- bump ----------------------------------------------------------------
  #ifdef SHIP_BUMP
  {
    // Height in kilometres so the surface gradient stays dimensionless.
    //
    // 8 mm was too shallow to survive at hero distance: the gap produced no
    // lit/shadowed edge pair, so every seam read as a painted line. 2.5 cm of
    // gap, plus a lip standing proud on one side of it, gives each seam a
    // bright edge on the key side and a black one opposite — which is the
    // whole difference between a joint and a decal.
    float lip = shipSeam(abs(dom.x - 0.017), 0.006)
              * (step(0.5, shipHash21(vec2(pid * 19.0, 4.4))) * 2.0 - 1.0);
    float h = (-seam * 0.9 + lip * 0.5 + rivet * 0.5) * 2.5e-5;
    float dhx = dFdx(h);
    float dhy = dFdy(h);
    vec3 r1 = cross(dPy, N);
    vec3 r2 = cross(N, dPx);
    float det = dot(dPx, r1);
    if (abs(det) > 1e-20) {
      vec3 grad = (dhx * r1 + dhy * r2) / det;
      // Close up a pixel spans less hull than the relief is deep, and an
      // unclamped gradient tips the normal past the tangent plane.
      float gmag = length(grad);
      grad *= min(1.0, 1.8 / max(gmag, 1e-9));
      N = normalize(N - uBump * grad);
    }
  }
  #endif

  // --- cast shadow ---------------------------------------------------------
  // Analytic sphere shadows off the bolt-ons. Without them nothing on the
  // model interrupts the key, which is the exact tell that separates a lit
  // model from a shape with a lamp pointed at it — and it is why the fins,
  // mast, pylons and patch plates read as decals rather than as hardware.
  // The caster list is built alongside the one the contact-AO bake already
  // needs; there is no shadow map, no extra pass and no shader permutation.
  float sunVis = 1.0;
  for (int i = 0; i < SHIP_OCC_MAX; i++) {
    vec4 o = uOcc[i];
    vec3 od = o.xyz - P;
    float ot = dot(od, uSunDir);
    float perp = sqrt(max(dot(od, od) - ot * ot, 0.0));
    // The penumbra opens up with the throw: a star is a disc, not a point.
    float soft = o.w * (0.20 + 0.85 * clamp(ot / max(o.w * 7.0, 1e-9), 0.0, 1.0));
    float s = smoothstep(-soft, soft, perp - o.w);
    // Empty slot, caster behind the fragment, or the caster is this very part.
    s = mix(1.0, s, step(1e-7, o.w) * step(1e-7, ot)
                    * step(0.5, abs(vPart - uOccPart[i])));
    // Nearest caster wins rather than accumulating — overlapping spheres
    // multiplied together punch black craters into the plating.
    sunVis = min(sunVis, s);
  }

  // --- direct lighting: one key, no ambient -------------------------------
  float NoL = max(dot(N, uSunDir), 0.0) * sunVis;
  float NoV = max(dot(N, V), 1e-4);
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);

  float a = max(rough * rough, 0.0025);
  float a2 = a * a;
  float dd = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = a * 0.5;
  float G = (NoV / (NoV * (1.0 - k) + k)) * (NoL / (NoL * (1.0 - k) + k));
  vec3 F0 = mix(vec3(0.04), albedo, metalness);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);

  vec3 spec = (D * G / max(4.0 * NoV * NoL, 1e-4)) * F * NoL;
  // No 1/PI: uSunColor is authored as irradiance already folded by PI, which
  // keeps the star intensity numbers the rest of the game passes around sane.
  vec3 diff = albedo * (1.0 - metalness) * NoL;
  vec3 col = (diff + spec * PI) * uSunColor * ao;

  // --- environment ---------------------------------------------------------
  // There was no environment term at all here, which is not a "too dark"
  // problem, it is a missing integral: a metallic fragment reflects only what
  // is around it, and with nothing around it every worn edge, greeble and
  // anti-sun face rendered pure black. The surround is a planetshine
  // hemisphere plus the broad glare halo around the star.
  vec3 Rv = reflect(-V, N);
  vec3 envCol = uFill * (0.30 + 1.05 * clamp(-Rv.y * 0.5 + 0.5, 0.0, 1.0))
              + uSunColor * 0.010 * pow(max(dot(Rv, uSunDir), 0.0), 5.0) * sunVis;
  // Split-sum-ish: the horizon of the specular lobe never falls below F0.
  vec3 Fenv = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - NoV, 5.0);
  col += envCol * Fenv * ao;

  // Planetshine, not ambient: it arrives from the world *below*, so it fills
  // the belly and leaves the shadowed upper flank properly black.
  col += albedo * (1.0 - metalness) * uFill * ao * (0.25 + 0.75 * (-N.y * 0.5 + 0.5));

  // Grazing sheen. Fresnel guarantees a reflectance spike at the silhouette,
  // so an edge seen edge-on against black cannot fade to nothing — this is the
  // silver lining, and it is the cheapest thing that stops a hull reading as
  // unfired clay. Rationed by dirt: soot has no lining.
  float graze = pow(1.0 - NoV, 4.0);
  float sheen = smoothstep(-0.30, 0.30, dot(N, uSunDir)) * sunVis;
  col += uSunColor * graze * sheen * (0.018 + 0.050 * (1.0 - rough))
       * (1.0 - 0.65 * dirt) * ao;

  // --- self illumination ---------------------------------------------------
  // Amber leaking from a badly seated panel. Rationed hard: a handful of
  // seams, broken along their length, or the hull reads as a neon sign.
  float leak = seam * step(0.955, shipHash21(vec2(pid * 57.0, 7.3)));
  leak *= smoothstep(0.5, 0.8, shipHash21(vec2(floor(dom.z * 5.0), pid * 13.0)));
  col += uAmber * leak * (0.55 + 0.45 * sin(uTime * 2.1 + pid * 40.0)) * 0.5;

  // Each lit window pools warm light on the plating around it. An emitter that
  // lights nothing is a sticker; these pools are also what rake across the
  // seams and greebles beside them and give that plating a second direction.
  for (int i = 0; i < SHIP_LAMP_MAX; i++) {
    vec4 lp = uLamp[i];
    vec3 ld = lp.xyz - P;
    float ldist = max(length(ld), 1e-6);
    float fall = lp.w * exp(-ldist * 760.0) * max(dot(N, ld / ldist), 0.0);
    col += uAmber * albedo * fall * ao;
  }

  // The plume lights the hull. A real light would cost a shadow pass and a
  // shader permutation, so it is a distance-and-facing gradient instead.
  // The facing term was inverted (P minus uEngineA points away from the
  // source), so the blue was landing on everything that faced *forward*, which
  // is the one set of surfaces a plume can never reach.
  vec3 ea = uEngineA - P;
  vec3 eb = uEngineB - P;
  float da = max(length(ea), 1e-6);
  float db = max(length(eb), 1e-6);
  float ga = exp(-da * 260.0) * max(dot(N, ea / da), 0.0);
  float gb = exp(-db * 260.0) * max(dot(N, eb / db), 0.0);
  col += uPlumeColor * (ga + gb) * uThrottle * 2.6;

  // --- re-entry ------------------------------------------------------------
  if (uHeat > 0.002) {
    float face = max(dot(N, uFlowDir), 0.0);
    // Leading *edges* first: sharp geometry heats before flat plate does.
    float lead = pow(face, 3.0) * (0.25 + 0.75 * edge);
    float flick = 0.75 + 0.25 * os_snoise(P * 600.0 + vec3(0.0, 0.0, -uTime * 5.0));
    // Tops out around 4200 K: a hull that reaches white heat has already
    // failed, and a white silhouette destroys every other read on the ship.
    vec3 hot = os_blackbody(mix(1400.0, 4200.0, uHeat));
    col += hot * lead * uHeat * uHeat * 5.5 * flick;
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

const LIGHTS_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aColor;
attribute float aPhase;
attribute float aKind;

varying vec2 vUv;
varying vec3 vCol;
varying float vPhase;
varying float vKind;
varying float vFacing;

void main() {
  vUv = uv;
  vCol = aColor;
  vPhase = aPhase;
  vKind = aKind;
  vec3 wn = normalize(mat3(modelMatrix) * normal);
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vFacing = max(dot(wn, normalize(cameraPosition - wp)), 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const LIGHTS_FRAG = /* glsl */ `
#include <common>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>

uniform float uTime;
uniform float uIntensity;

varying vec2 vUv;
varying vec3 vCol;
varying float vPhase;
varying float vKind;
varying float vFacing;

void main() {
  #include <logdepthbuf_fragment>
  vec2 d = vUv - 0.5;
  float a;
  if (vKind < 0.5) {
    // Running light: a soft round emitter with a hot core.
    float r = length(d) * 2.0;
    a = pow(clamp(1.0 - r, 0.0, 1.0), 2.0) + pow(clamp(1.0 - r * 2.2, 0.0, 1.0), 6.0) * 1.6;
    // Beacons strobe; they never snap on, they ramp. The floor is high enough
    // that a still frame still finds them lit — at 0.25 they spent nine tenths
    // of the cycle invisible, so the flank read as one uniform row of windows.
    float s = sin(uTime * 1.9 + vPhase * 6.2831);
    a *= mix(0.42, 1.0, smoothstep(0.55, 0.95, s));
  } else {
    // Lit window: a soft rectangle with a mullion across it.
    vec2 q = abs(d) * 2.0;
    a = (1.0 - smoothstep(0.72, 1.0, q.x)) * (1.0 - smoothstep(0.6, 1.0, q.y));
    a *= 1.0 - 0.55 * (1.0 - smoothstep(0.0, 0.06, abs(vUv.x - 0.5)));
    a *= 0.8 + 0.2 * sin(uTime * 0.7 + vPhase * 9.0);
  }
  a *= pow(vFacing, 0.7);
  gl_FragColor = vec4(vCol * a * uIntensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const NOZZLE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aT;

varying vec3 vPos;
varying vec3 vNrm;
varying float vT;

void main() {
  vPos = position;
  vNrm = normal;
  vT = aT;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const NOZZLE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCameraLocal;
uniform vec3 uPlumeColor;
uniform vec3 uFill;
uniform float uThrottle;
uniform float uGlowDepth;
uniform float uTime;

varying vec3 vPos;
varying vec3 vNrm;
varying float vT;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uCameraLocal - vPos);

  if (gl_FrontFacing) {
    // Outside of the bell: scorched, sooted metal.
    //
    // A pure sine gave every corrugation the same depth and the same pitch.
    // Phase-modulating it with noise varies the pitch, and a per-rib hash
    // varies the depth, so some rings are crisp and some are half beaten flat.
    float wob = os_fbm(vPos * 2400.0, 2, 2.2, 0.5);
    float ribPhase = vT * 46.0 + 2.1 * wob;
    float ribId = floor(ribPhase / 6.2831853);
    float ribJ = fract(sin(ribId * 91.7 + 3.1) * 43758.5453);
    float rib = (0.5 + 0.5 * sin(ribPhase)) * mix(0.25, 1.0, ribJ);

    float NoL = max(dot(N, uSunDir), 0.0);
    float NoV = max(dot(N, V), 1e-4);
    // Soot, thickest towards the lip where the flow recirculates.
    float soot = smoothstep(0.20, 0.92, os_fbm(vPos * 1600.0, 3, 2.3, 0.55) * 0.5 + 0.5);

    // Authored *below* the hull's value on purpose. A scorched bell is the
    // dirtiest object on the ship; when it is the brightest and most saturated
    // mass in frame it steals the job the amber is supposed to be doing.
    vec3 base = mix(vec3(0.019, 0.018, 0.017), vec3(0.033, 0.029, 0.025), rib);
    // Heat staining creeps back from the lip — bronze, not salmon.
    base = mix(base, vec3(0.030, 0.022, 0.015), smoothstep(0.40, 1.0, vT));
    base *= 1.0 - 0.55 * soot * smoothstep(0.15, 1.0, vT);

    // The groove between two corrugations sees less of the sky than the crest.
    float ao = 0.5 + 0.5 * rib;
    vec3 c = base * (uSunColor * NoL + uFill * 1.3) * ao;
    // Same grazing Fresnel as the hull, so the lip keeps a lining.
    c += uSunColor * pow(1.0 - NoV, 4.0)
       * smoothstep(-0.3, 0.3, dot(N, uSunDir)) * 0.018 * (1.0 - 0.7 * soot);
    c += uPlumeColor * uThrottle * 0.45 * smoothstep(0.5, 1.0, vT);
    gl_FragColor = vec4(c, 1.0);
  } else {
    // Inside: the glow climbs deeper into the throat as throttle comes up.
    float depth = smoothstep(1.0 - uGlowDepth, 1.0, vT);
    float turb = 0.75 + 0.25 * os_snoise(vPos * 900.0 + vec3(0.0, 0.0, -uTime * 7.0));
    vec3 c = uPlumeColor * depth * (0.25 + 1.9 * uThrottle) * turb;
    c += vec3(1.0, 0.93, 0.86) * depth * uThrottle * uThrottle * uThrottle * 0.55;
    gl_FragColor = vec4(c, 1.0);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const PLUME_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aT;
attribute float aLayer;
attribute vec3 aDir;

uniform float uLen;
uniform float uWidth;
uniform float uTime;
uniform float uThrottle;

varying float vT;
varying float vLayer;
varying vec3 vNrm;
varying vec3 vWorld;

void main() {
  float len = uLen * mix(1.0, 0.62, aLayer);
  float wid = uWidth * mix(1.0, 0.42, aLayer);
  // Flares out of the bell, then tapers to nothing.
  float prof = aT < 0.10
    ? mix(0.45, 1.0, aT / 0.10)
    : pow(max(1.0 - (aT - 0.10) / 0.90, 0.0), 1.35);
  // The column is never perfectly steady.
  float wob = 1.0 + 0.07 * aT * sin(aT * 26.0 + uTime * 11.0) * (0.4 + uThrottle);

  vec3 p = position + aDir * (aT * len) + normal * (prof * wid * wob);

  vT = aT;
  vLayer = aLayer;
  // World space: the fragment prefix has cameraPosition but not modelMatrix.
  vNrm = mat3(modelMatrix) * normal;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const PLUME_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uCold;
uniform vec3 uHot;
uniform float uHeatMix;
uniform float uIntensity;
uniform float uDiamonds;
uniform float uTime;

varying float vT;
varying float vLayer;
varying vec3 vNrm;
varying vec3 vWorld;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNrm);
  vec3 V = normalize(cameraPosition - vWorld);
  // Inverse fresnel: an open shell fades at its silhouette, which is what
  // makes two triangles' worth of cone read as a volume of gas.
  float shell = pow(abs(dot(N, V)), 1.6);
  // Tightens as it gets hotter: an over-driven nozzle collimates.
  float axial = pow(max(1.0 - vT, 0.0), 2.2 + 1.4 * uHeatMix);

  vec3 c = mix(uCold, uHot, uHeatMix);
  vec3 col = c * shell * axial * uIntensity;

  // Shock diamonds: only once the flow is over-expanded.
  float sd = pow(max(sin(vT * 34.0 - uTime * 2.0) * 0.5 + 0.5, 0.0), 10.0);
  sd *= exp(-vT * 3.2) * uDiamonds;
  col += mix(uHot, vec3(1.0), 0.5) * sd * (0.3 + vLayer) * uIntensity * 1.4;

  // White-hot core, right at the throat.
  col += vec3(1.0, 0.96, 0.9) * vLayer * pow(max(1.0 - vT, 0.0), 4.5) * shell * uIntensity * 0.5;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WAKE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aT;
attribute float aAngle;

uniform float uLen;
uniform float uWidth;
uniform float uTime;

varying float vT;
varying float vAngle;
varying vec3 vNrm;
varying vec3 vWorld;

void main() {
  float prof = pow(aT, 0.45);
  // Ragged, drifting silhouette: a perfect cone of revolution reads as a
  // traffic cone, not as ionised gas being torn off a hull.
  float rag = 1.0 + 0.3 * sin(aAngle * 3.0 + aT * 7.0 + uTime * 0.7)
                        * sin(aAngle * 5.0 - aT * 4.0 - uTime * 1.1);
  vec3 p = position + vec3(0.0, 0.0, aT * uLen) + normal * (prof * uWidth * rag);
  vT = aT;
  vAngle = aAngle;
  vNrm = mat3(modelMatrix) * normal;
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const WAKE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>
#include <logdepthbuf_pars_fragment>

uniform float uHeat;
uniform float uTime;
uniform float uIntensity;

varying float vT;
varying float vAngle;
varying vec3 vNrm;
varying vec3 vWorld;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNrm);
  vec3 V = normalize(cameraPosition - vWorld);
  float shell = pow(abs(dot(N, V)), 1.1);

  // Turbulent filaments shearing downstream.
  float n = os_fbm(vec3(vAngle * 2.4, vT * 5.0 - uTime * 2.2, uTime * 0.35), 4, 2.3, 0.55);
  float fil = 0.12 + 0.88 * smoothstep(0.25, 0.85, n * 0.5 + 0.5);

  float fade = pow(max(1.0 - vT, 0.0), 2.6) * smoothstep(0.0, 0.1, vT);
  vec3 hot = os_blackbody(mix(1800.0, 4600.0, uHeat * (1.0 - vT * 0.6)));
  // The far tail cools into ionised violet rather than fading to grey.
  hot = mix(hot, vec3(0.45, 0.24, 0.8), smoothstep(0.35, 1.0, vT) * 0.8);

  vec3 col = hot * shell * fade * fil * uHeat * uHeat * uIntensity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RCS_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aDir;
attribute float aLevel;

uniform float uSize;

varying vec2 vUv;
varying float vLevel;

void main() {
  vec3 c = instanceMatrix[3].xyz;
  float len = uSize * (0.5 + 2.2 * aLevel);
  float wid = uSize * (0.20 + 0.30 * aLevel);

  // The axis is a real 3D segment from nozzle to plume tip, transformed and
  // then projected — billboarding purely in screen space made a thruster
  // firing towards the camera collapse to nothing instead of to a disc.
  vec4 mvBase = modelViewMatrix * vec4(c + aDir * (len * 0.08), 1.0);
  vec4 mvTip = modelViewMatrix * vec4(c + aDir * len, 1.0);
  vec4 mv = mix(mvBase, mvTip, position.y);

  vec2 axis = mvTip.xy - mvBase.xy;
  float al = length(axis);
  axis = al > 1e-7 ? axis / al : vec2(1.0, 0.0);
  vec2 perp = vec2(-axis.y, axis.x);
  // A cold-gas jet leaves the throat narrow and spreads as it expands.
  float halfW = wid * (0.4 + 1.5 * position.y);
  mv.xy += perp * (position.x * 2.0 * halfW);

  vUv = uv;
  vLevel = aLevel;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const RCS_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;
uniform float uIntensity;

varying vec2 vUv;
varying float vLevel;

void main() {
  #include <logdepthbuf_fragment>
  float t = vUv.y;
  float r = abs(vUv.x - 0.5) * 2.0;
  // Soft-edged core that thins out along the jet.
  float a = 1.0 - smoothstep(0.15, 1.0, r);
  a *= pow(max(1.0 - t, 0.0), 2.2);
  a *= vLevel;
  vec3 c = mix(uColor, vec3(1.0), pow(max(1.0 - t, 0.0), 2.5));
  gl_FragColor = vec4(c * a * uIntensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

/** Module scope so the per-frame plume tint lerp allocates nothing. */
const PLUME_HOT = new Color(1.0, 0.88, 0.75);

interface Thruster {
  pos: Vector3;
  /** Outward exhaust direction; thrust on the hull is the negative of this. */
  dir: Vector3;
}

export class Ship {
  readonly object3d: Object3D = new Group();

  /**
   * Unit vector towards the dominant star, expressed in SHIP-LOCAL space.
   * Copy into it each frame; the ship never reads global state to find it.
   */
  readonly sunDirection = new Vector3(0.42, 0.55, -0.72).normalize();
  /** Linear RGB of the key light, pre-multiplied by intensity. */
  readonly sunColor = new Color(1.0, 0.94, 0.86);
  /** Bounce/planetshine. Near black on purpose — space has no fill light. */
  readonly fillColor = new Color(0.010, 0.014, 0.022);
  /** Where a chase camera should sit its target, in local km. */
  readonly cameraAnchorLocal = new Vector3(0, 0.0016, 0.002);
  readonly lengthKm = SHIP_LENGTH_KM;

  private readonly group = this.object3d as Group;

  private hullGeo: BufferGeometry;
  private greebleGeos: BufferGeometry[] = [];
  private lightGeo: BufferGeometry;
  private nozzleGeo: BufferGeometry;
  private plumeGeo: BufferGeometry;
  private wakeGeo: BufferGeometry;
  private rcsGeo: BufferGeometry;

  private hullMat: ShaderMaterial;
  private greebleMat: ShaderMaterial;
  private lightMat: ShaderMaterial;
  private nozzleMat: ShaderMaterial;
  private plumeMat: ShaderMaterial;
  private wakeMat: ShaderMaterial;
  private rcsMat: ShaderMaterial;

  private greebleMeshes: InstancedMesh[] = [];
  private rcsMesh: InstancedMesh;
  private plumeMesh: Mesh;
  private wakeMesh: Mesh;

  private readonly thrusters: Thruster[] = [];
  private readonly rcsLevel: Float32Array;
  private readonly rcsPhase: Float32Array;
  private rcsAttr: InstancedBufferAttribute;

  private readonly enginePos: Vector3[] = [];
  private readonly engineDir: Vector3[] = [];

  /** Damped, visible-value mirrors of the commanded state. Nothing snaps. */
  private time = 0;
  private vThrottle = 0;
  private vBoost = 0;
  private vHeat = 0;

  // Preallocated scratch — update() must never allocate.
  private readonly _inv = new Matrix4();
  private readonly _camLocal = new Vector3();
  private readonly _rcsDir = new Vector3();

  constructor(seed: number, quality: QualitySettings) {
    registerShaderChunks();

    const tier = quality.tier;
    const ringCount = tier === 'low' ? 16 : tier === 'medium' ? 18 : tier === 'high' ? 22 : 24;
    const radial = tier === 'low' ? 20 : tier === 'medium' ? 24 : tier === 'high' ? 28 : 32;
    const greebleBudget =
      tier === 'low' ? 80 : tier === 'medium' ? 150 : tier === 'high' ? 240 : 340;

    const rng = new Rng(hashSeed(seed, 'ship'));
    const shape = new HullShape(rng.fork('hull'), ringCount);
    const occluders: Occluder[] = [];
    const shadowers: Shadower[] = [];

    // ---- hull + bolt-ons, one buffer -------------------------------------
    const hb = new HullBuilder();
    const hullVerts = this.buildFuselage(hb, shape, ringCount, radial);
    this.buildParts(hb, shape, rng.fork('parts'), occluders, shadowers);
    this.applyContactAO(hb, hullVerts, occluders);
    this.hullGeo = hb.toGeometry(true);

    // ---- palette ----------------------------------------------------------
    const pRng = rng.fork('paint');
    // Rationed colour: everything is a desaturated steel/olive/ochre.
    // Lightness is deliberately low: these are linear-space values, and a
    // noir hull has to sit in the bottom third of the range so the key light
    // and the emissives are the only bright things on screen.
    const hue = pRng.pick([0.58, 0.55, 0.11, 0.09, 0.33]);
    // Saturation has to run higher than it looks: at this lightness in linear
    // space, HSL saturation below ~0.2 comes out indistinguishable from grey.
    const paint = new Color().setHSL(hue, pRng.range(0.22, 0.45), pRng.range(0.05, 0.095));
    const paintAlt = new Color().setHSL(
      hue + pRng.range(-0.12, 0.12),
      pRng.range(0.1, 0.4),
      pRng.range(0.035, 0.13),
    );

    // ---- shared hull uniforms --------------------------------------------
    const hullUniforms = {
      uSunDir: { value: this.sunDirection },
      uSunColor: { value: new Color().copy(this.sunColor) },
      uCameraLocal: { value: this._camLocal },
      uFill: { value: new Color().copy(this.fillColor) },
      uPaint: { value: paint },
      uPaintAlt: { value: paintAlt },
      // Bare steel under the paint: dull and oxidised, not chrome. It must sit
      // close to the paint's value or every worn edge reads as a highlight.
      uMetal: { value: new Color(0.20, 0.21, 0.235) },
      uAmber: { value: new Color(1.0, 0.52, 0.13) },
      uPlumeColor: { value: new Color(0.22, 0.44, 1.0) },
      uEngineA: { value: new Vector3() },
      uEngineB: { value: new Vector3() },
      uFlowDir: { value: new Vector3(0, 0, -1) },
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uHeat: { value: 0 },
      // Cells of ~3.8 m, subdivided into halves and quarters: plating on a
      // 30 m boat runs 2–4 m, and smaller than that reads as fish scales.
      uPanelScale: { value: 265 },
      // 1/curvature at which paint is fully worn: only genuinely sharp,
      // hull-scale edges qualify.
      uCurvScale: { value: 1 / 2600 },
      uGrime: { value: pRng.range(0.55, 0.95) },
      uBump: { value: 0.45 },
      // Cast-shadow spheres and window lamps. Flat arrays rather than
      // Vector4[]: three flattens them either way and this allocates once.
      uOcc: { value: new Float32Array(OCC_MAX * 4) },
      uOccPart: { value: new Float32Array(OCC_MAX) },
      uLamp: { value: new Float32Array(LAMP_MAX * 4) },
    };

    // Casters, nearest first — the list is capped, so the biggest masses have
    // to be at the front or a whip antenna could evict the cargo pannier.
    shadowers.sort((a, b) => b.r - a.r);
    const occArr = hullUniforms.uOcc.value;
    const occPart = hullUniforms.uOccPart.value;
    for (let i = 0; i < Math.min(shadowers.length, OCC_MAX); i++) {
      const s = shadowers[i];
      occArr[i * 4] = s.x;
      occArr[i * 4 + 1] = s.y;
      occArr[i * 4 + 2] = s.z;
      occArr[i * 4 + 3] = s.r;
      occPart[i] = s.part;
    }
    // Unused slots keep radius 0; the shader multiplies them out.

    const hullDefines: Record<string, string> = {
      SHIP_GRIME_OCTAVES: tier === 'low' ? '2' : '4',
      SHIP_OCC_MAX: String(OCC_MAX),
      SHIP_LAMP_MAX: String(LAMP_MAX),
    };
    if (tier !== 'low') {
      hullDefines.SHIP_RIVETS = '1';
      hullDefines.SHIP_BUMP = '1';
    }

    this.hullMat = new ShaderMaterial({
      uniforms: hullUniforms,
      defines: { ...hullDefines },
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
    });
    // A second material rather than sharing one: three would otherwise swap
    // programs between the instanced and non-instanced draws every frame.
    this.greebleMat = new ShaderMaterial({
      uniforms: hullUniforms,
      defines: { ...hullDefines },
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
    });

    const hullMesh = new Mesh(this.hullGeo, this.hullMat);
    hullMesh.frustumCulled = false;
    this.group.add(hullMesh);

    // ---- greebles ---------------------------------------------------------
    // Two primitives over 200+ instances is why the same crescent silhouette
    // kept appearing across the hull — the greeble equivalent of visible
    // tiling. Five families, each a small assembly rather than a bare
    // primitive, and each with its own aspect-ratio envelope. Cost is three
    // extra draw calls against a 400-call budget.
    const families: Array<{ geo: BufferGeometry; share: number; kind: GreebleKind }> = [
      { geo: greebleHatch(), share: 0.26, kind: 'hatch' },
      { geo: greebleBracket(), share: 0.2, kind: 'bracket' },
      { geo: greebleRibbed(), share: 0.2, kind: 'ribbed' },
      { geo: greebleStack(), share: 0.16, kind: 'stack' },
      { geo: greeblePipe(), share: 0.18, kind: 'pipe' },
    ];
    let placed = 0;
    const seats: Array<{ p: Vector3; r: number }> = [];
    for (let f = 0; f < families.length; f++) {
      const fam = families[f];
      const n =
        f === families.length - 1
          ? greebleBudget - placed
          : Math.round(greebleBudget * fam.share);
      placed += n;
      this.greebleGeos.push(fam.geo);
      const mesh = this.scatterGreebles(
        fam.geo,
        shape,
        rng.fork(`greeble-${fam.kind}`),
        n,
        occluders,
        fam.kind,
        seats,
      );
      this.greebleMeshes.push(mesh);
      this.group.add(mesh);
    }

    // ---- emissive lights --------------------------------------------------
    this.lightGeo = this.buildLights(shape, rng.fork('lights'), hullUniforms.uLamp.value);
    this.lightMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 5.0 } },
      vertexShader: LIGHTS_VERT,
      fragmentShader: LIGHTS_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const lightMesh = new Mesh(this.lightGeo, this.lightMat);
    lightMesh.frustumCulled = false;
    lightMesh.renderOrder = 2;
    this.group.add(lightMesh);

    // ---- engines ----------------------------------------------------------
    this.nozzleGeo = this.buildNozzles();
    this.nozzleMat = new ShaderMaterial({
      uniforms: {
        uSunDir: hullUniforms.uSunDir,
        uSunColor: hullUniforms.uSunColor,
        uCameraLocal: hullUniforms.uCameraLocal,
        uPlumeColor: hullUniforms.uPlumeColor,
        uFill: hullUniforms.uFill,
        uThrottle: { value: 0 },
        uGlowDepth: { value: 0.2 },
        uTime: hullUniforms.uTime,
      },
      vertexShader: NOZZLE_VERT,
      fragmentShader: NOZZLE_FRAG,
      side: DoubleSide,
    });
    const nozzleMesh = new Mesh(this.nozzleGeo, this.nozzleMat);
    nozzleMesh.frustumCulled = false;
    this.group.add(nozzleMesh);

    this.plumeGeo = this.buildPlume();
    this.plumeMat = new ShaderMaterial({
      uniforms: {
        uCold: { value: new Color(0.10, 0.28, 1.0) },
        uHot: { value: new Color(1.0, 0.92, 0.84) },
        uHeatMix: { value: 0 },
        uIntensity: { value: 0 },
        uDiamonds: { value: 0 },
        uLen: { value: 0.002 },
        uWidth: { value: 0.0012 },
        uThrottle: { value: 0 },
        uTime: hullUniforms.uTime,
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.plumeMesh = new Mesh(this.plumeGeo, this.plumeMat);
    this.plumeMesh.frustumCulled = false;
    this.plumeMesh.renderOrder = 3;
    this.group.add(this.plumeMesh);

    // ---- RCS --------------------------------------------------------------
    this.buildThrusters(shape);
    const n = this.thrusters.length;
    this.rcsLevel = new Float32Array(n);
    this.rcsPhase = new Float32Array(n);
    const phRng = rng.fork('rcs');
    for (let i = 0; i < n; i++) this.rcsPhase[i] = phRng.next();

    this.rcsGeo = new BufferGeometry();
    this.rcsGeo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3),
    );
    this.rcsGeo.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
    );
    this.rcsGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const dirArr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      dirArr[i * 3] = this.thrusters[i].dir.x;
      dirArr[i * 3 + 1] = this.thrusters[i].dir.y;
      dirArr[i * 3 + 2] = this.thrusters[i].dir.z;
    }
    this.rcsGeo.setAttribute('aDir', new InstancedBufferAttribute(dirArr, 3));
    this.rcsAttr = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.rcsAttr.setUsage(DynamicDrawUsage);
    this.rcsGeo.setAttribute('aLevel', this.rcsAttr);

    this.rcsMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color(0.52, 0.70, 1.0) },
        uIntensity: { value: 5.5 },
        uSize: { value: 0.0013 },
      },
      vertexShader: RCS_VERT,
      fragmentShader: RCS_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      // The vertex shader reorients the quad in view space, so its winding
      // flips depending on which way the nozzle points. Culling eats it.
      side: DoubleSide,
    });
    this.rcsMesh = new InstancedMesh(this.rcsGeo, this.rcsMat, n);
    this.rcsMesh.frustumCulled = false;
    this.rcsMesh.renderOrder = 3;
    const m = new Matrix4();
    for (let i = 0; i < n; i++) {
      m.identity().setPosition(this.thrusters[i].pos);
      this.rcsMesh.setMatrixAt(i, m);
    }
    this.rcsMesh.instanceMatrix.needsUpdate = true;
    this.rcsMesh.visible = false;
    this.group.add(this.rcsMesh);

    // ---- re-entry wake ----------------------------------------------------
    this.wakeGeo = this.buildWake();
    this.wakeMat = new ShaderMaterial({
      uniforms: {
        uHeat: { value: 0 },
        uTime: hullUniforms.uTime,
        uIntensity: { value: 0.6 },
        uLen: { value: 0.11 },
        uWidth: { value: 0.016 },
      },
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.wakeMesh = new Mesh(this.wakeGeo, this.wakeMat);
    this.wakeMesh.frustumCulled = false;
    this.wakeMesh.renderOrder = 4;
    this.wakeMesh.visible = false;
    this.group.add(this.wakeMesh);

    // Engine anchors feed the hull's fake plume lighting.
    hullUniforms.uEngineA.value.copy(this.enginePos[0]);
    hullUniforms.uEngineB.value.copy(this.enginePos[1] ?? this.enginePos[0]);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildFuselage(
    b: HullBuilder,
    shape: HullShape,
    rings: number,
    radial: number,
  ): number {
    const p = new Vector3();
    const grid: number[][] = [];
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const row: number[] = [];
      // Nose and tail plating is newer than the flanks nobody can reach.
      const wear = 0.35 + 0.65 * Math.max(smoothstep(0.25, 0, t), smoothstep(0.7, 1, t));
      for (let s = 0; s <= radial; s++) {
        const theta = ((s % radial) / radial) * Math.PI * 2;
        shape.sample(t, theta, p);
        row.push(b.vertex(p.x, p.y, p.z, wear, 0, 1));
      }
      grid.push(row);
    }
    for (let i = 0; i < rings - 1; i++) {
      for (let s = 0; s < radial; s++) {
        b.quad(grid[i][s], grid[i][s + 1], grid[i + 1][s + 1], grid[i + 1][s]);
      }
    }
    // Blunt nose: a flat plate, deliberately off-centre and slightly low.
    // Part id 0, same as the fuselage: the cap fan shares its rim vertices with
    // the hull, so a different id would interpolate across every cap triangle
    // and smear the paint batch and the plate scale into the nose.
    const noseC = b.vertex(
      shape.rings[0].cx * 0.5 - MAX_R * 0.08,
      shape.rings[0].cy - MAX_R * 0.06,
      -HALF - MAX_R * 0.12,
      1,
      0,
      1,
    );
    for (let s = 0; s < radial; s++) b.tri(noseC, grid[0][s + 1], grid[0][s]);
    const last = shape.rings[rings - 1];
    const tailC = b.vertex(last.cx, last.cy, last.z + MAX_R * 0.05, 0.8, 0, 0.75);
    for (let s = 0; s < radial; s++) b.tri(tailC, grid[rings - 1][s], grid[rings - 1][s + 1]);
    return b.vertexCount;
  }

  /**
   * Build a mounting frame on the hull: +Y is the surface normal, +Z runs aft
   * along the airflow, so every bolt-on is naturally aligned to the hull.
   */
  private place(
    shape: HullShape,
    t: number,
    theta: number,
    sink: number,
    yaw: number,
    out: Matrix4,
  ): Matrix4 {
    const p = new Vector3();
    const n = new Vector3();
    shape.sample(t, theta, p);
    shape.normal(t, theta, n);
    p.addScaledVector(n, -sink);

    const up = n.clone();
    const fwd = AXIS_Z.clone().addScaledVector(up, -AXIS_Z.dot(up));
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 1, 0).addScaledVector(up, -up.y);
    fwd.normalize();
    const right = new Vector3().crossVectors(up, fwd);
    out.makeBasis(right, up, fwd).setPosition(p);
    if (yaw !== 0) out.multiply(new Matrix4().makeRotationY(yaw));
    return out;
  }

  private mark(occ: Occluder[], m: Matrix4, r: number): void {
    const p = new Vector3().setFromMatrixPosition(m);
    occ.push({ x: p.x, y: p.y, z: p.z, r });
  }

  /**
   * Lay a chain of shadow spheres along a bolt-on's own +Z, lifted `up` off its
   * mounting face. A slab needs several: one fat sphere at the root casts a
   * blob, and a fin's shadow is a stripe.
   */
  private cast(
    sh: Shadower[],
    m: Matrix4,
    up: number,
    span: number,
    r: number,
    part: number,
    n: number,
  ): void {
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : (i / (n - 1) - 0.5) * span;
      const p = new Vector3(0, up, f).applyMatrix4(m);
      sh.push({ x: p.x, y: p.y, z: p.z, r, part });
    }
  }

  /** Bolt-ons. Deliberately hand-composed, seed-jittered: a silhouette is not a random walk. */
  private buildParts(
    b: HullBuilder,
    shape: HullShape,
    rng: Rng,
    occ: Occluder[],
    sh: Shadower[],
  ): void {
    const m = new Matrix4();
    const TOP = Math.PI * 0.5;
    const BOT = -Math.PI * 0.5;
    // The pannier picks a side once; that single coin flip is most of the
    // ship's asymmetry.
    const side = rng.chance(0.5) ? 0 : Math.PI;

    // Dorsal spine + its cable runs.
    this.place(shape, 0.58, TOP, MAX_R * 0.25, 0, m);
    addBox(b, m, MAX_R * 0.5, MAX_R * 0.34, SHIP_LENGTH_KM * 0.42, 0.55, 2);
    this.mark(occ, m, MAX_R * 0.6);
    this.cast(sh, m, MAX_R * 0.17, SHIP_LENGTH_KM * 0.34, MAX_R * 0.3, 2, 3);
    for (let i = 0; i < 3; i++) {
      const t = 0.42 + i * 0.14;
      this.place(shape, t, TOP + (i % 2 === 0 ? 0.26 : -0.26), MAX_R * 0.1, 0, m);
      addBox(b, m, MAX_R * 0.14, MAX_R * 0.1, SHIP_LENGTH_KM * 0.1, 0.9, 3);
    }

    // Radiator fins, one pair, unequal because one was replaced.
    for (let s = -1; s <= 1; s += 2) {
      this.place(shape, 0.66, TOP + s * 0.55, MAX_R * 0.1, s * 0.18, m);
      addBox(
        b,
        m,
        MAX_R * 0.08,
        MAX_R * (s > 0 ? 0.8 : 0.62),
        SHIP_LENGTH_KM * (s > 0 ? 0.15 : 0.12),
        0.75,
        4,
      );
      this.mark(occ, m, MAX_R * 0.35);
      // A slab standing in the key is the single most valuable caster on the
      // ship: it lays a hard stripe across the plating downlight of it.
      this.cast(
        sh,
        m,
        MAX_R * (s > 0 ? 0.42 : 0.33),
        SHIP_LENGTH_KM * (s > 0 ? 0.12 : 0.1),
        MAX_R * (s > 0 ? 0.3 : 0.25),
        4,
        3,
      );
    }

    // Cargo pannier: the big one-sided mass.
    this.place(shape, 0.52, side, MAX_R * 0.35, 0, m);
    addBox(b, m, MAX_R * 0.75, MAX_R * 0.95, SHIP_LENGTH_KM * 0.34, 0.5, 5);
    this.mark(occ, m, MAX_R * 1.1);
    this.cast(sh, m, MAX_R * 0.48, SHIP_LENGTH_KM * 0.26, MAX_R * 0.5, 5, 3);
    this.place(shape, 0.42, side + 0.24, MAX_R * 0.3, 0.1, m);
    addBox(b, m, MAX_R * 0.5, MAX_R * 0.55, SHIP_LENGTH_KM * 0.16, 0.85, 6);
    for (let i = 0; i < 3; i++) {
      this.place(shape, 0.42 + i * 0.09, side, MAX_R * 0.28, 0, m);
      addBox(b, m, MAX_R * 0.95, MAX_R * 0.12, SHIP_LENGTH_KM * 0.02, 0.95, 7);
    }

    // Cockpit blister, offset to the far side from the pannier.
    const cockpitTheta = TOP + (side === 0 ? 0.55 : -0.55);
    this.place(shape, 0.19, cockpitTheta, MAX_R * 0.2, 0, m);
    addCylinder(b, m, MAX_R * 0.46, MAX_R * 0.3, MAX_R * 0.34, 14, 0.35, 8);
    this.mark(occ, m, MAX_R * 0.55);
    this.cast(sh, m, MAX_R * 0.17, 0, MAX_R * 0.38, 8, 1);

    // Engine pylons and nacelles. One runs long — nobody matched them.
    for (let s = -1; s <= 1; s += 2) {
      const theta = s > 0 ? 0.16 : Math.PI - 0.16;
      const long = s > 0 ? 1.0 : rng.range(1.1, 1.22);
      this.place(shape, 0.84, theta, MAX_R * 0.3, 0, m);
      addBox(b, m, MAX_R * 0.42, MAX_R * 0.55, SHIP_LENGTH_KM * 0.16 * long, 0.6, 9);
      this.mark(occ, m, MAX_R * 0.7);
      this.cast(sh, m, MAX_R * 0.28, SHIP_LENGTH_KM * 0.1, MAX_R * 0.34, 9, 2);

      const nac = new Vector3();
      const nacN = new Vector3();
      shape.sample(0.84, theta, nac);
      shape.normal(0.84, theta, nacN);
      nac.addScaledVector(nacN, MAX_R * 0.55);
      nac.z += SHIP_LENGTH_KM * 0.1;

      const dir = new Vector3(s * 0.11, -0.03, 1).normalize();
      const up = new Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
      const right = new Vector3().crossVectors(up, dir);
      // Nacelle body: built along its own +Y then laid onto the thrust axis.
      const bm = new Matrix4().makeBasis(right, dir, new Vector3().copy(up).negate());
      bm.setPosition(nac.x, nac.y, nac.z);
      // 20 segments, not 8: at hero distance the octagon's facets were
      // countable along the silhouette.
      const nacLen = SHIP_LENGTH_KM * 0.16 * long;
      addCylinder(b, bm, MAX_R * 0.42, MAX_R * 0.36, nacLen, 20, 0.7, 10);
      this.mark(occ, bm, MAX_R * 0.6);
      this.cast(sh, bm, nacLen * 0.5, 0, MAX_R * 0.44, 10, 1);

      // Hardware on the nacelle. The scatter can never reach it — it rejects
      // anything inside an occluder sphere and the nacelle is one big sphere —
      // so it was the only surface on the ship with no detail at all. Hand
      // placement beats a second scatter pass here: these are real parts.
      const ringPart = 33 + (s > 0 ? 0 : 1);
      for (let i = 0; i < 3; i++) {
        const at = nacLen * (0.18 + i * 0.28);
        const rm = new Matrix4().copy(bm).multiply(new Matrix4().makeTranslation(0, at, 0));
        // Girth band, slightly proud of the skin.
        addCylinder(b, rm, MAX_R * 0.44, MAX_R * 0.44, nacLen * 0.035, 20, 0.85, ringPart);
        // A junction box hung off the band's outboard face.
        const jm = new Matrix4()
          .copy(rm)
          .multiply(new Matrix4().makeRotationY(0.9 + i * 2.1))
          .multiply(new Matrix4().makeTranslation(MAX_R * 0.4, nacLen * 0.02, 0))
          .multiply(RADIAL_MOUNT);
        addBox(b, jm, MAX_R * 0.16, MAX_R * 0.09, nacLen * (0.1 + 0.05 * i), 0.95, ringPart);
      }
      // A conduit running the length of the can, top outboard.
      const cm = new Matrix4()
        .copy(bm)
        .multiply(new Matrix4().makeRotationY(2.2))
        .multiply(new Matrix4().makeTranslation(MAX_R * 0.38, nacLen * 0.5, 0))
        .multiply(RADIAL_MOUNT);
      addBox(b, cm, MAX_R * 0.1, MAX_R * 0.07, nacLen * 0.72, 0.9, ringPart);

      const mouth = new Vector3().copy(nac).addScaledVector(dir, nacLen);
      this.enginePos.push(mouth);
      this.engineDir.push(dir);
    }

    // Landing gear pods on the belly.
    for (let s = -1; s <= 1; s += 2) {
      this.place(shape, 0.72, BOT + s * 0.34, MAX_R * 0.15, 0, m);
      addBox(b, m, MAX_R * 0.34, MAX_R * 0.3, SHIP_LENGTH_KM * 0.09, 0.8, 11);
      this.mark(occ, m, MAX_R * 0.4);
      this.cast(sh, m, MAX_R * 0.15, SHIP_LENGTH_KM * 0.06, MAX_R * 0.28, 11, 1);
    }
    this.place(shape, 0.26, BOT, MAX_R * 0.15, 0, m);
    addBox(b, m, MAX_R * 0.45, MAX_R * 0.26, SHIP_LENGTH_KM * 0.08, 0.85, 11);
    this.mark(occ, m, MAX_R * 0.4);
    this.cast(sh, m, MAX_R * 0.13, SHIP_LENGTH_KM * 0.05, MAX_R * 0.3, 11, 1);

    // Ventral intake scoop under the nose — also the re-entry leading edge.
    this.place(shape, 0.13, BOT + 0.15, MAX_R * 0.1, 0, m);
    addBox(b, m, MAX_R * 0.55, MAX_R * 0.2, SHIP_LENGTH_KM * 0.07, 1.0, 12);

    // Sensor mast and dish, one side only.
    const mastTheta = TOP + (side === 0 ? -0.95 : 0.95);
    this.place(shape, 0.3, mastTheta, 0, 0, m);
    addCylinder(b, m, MAX_R * 0.06, MAX_R * 0.05, MAX_R * 0.85, 6, 0.9, 13);
    // The dish is a shallow cone sitting on the mast head, tipped off-axis.
    const dish = new Matrix4()
      .copy(m)
      .multiply(new Matrix4().makeTranslation(0, MAX_R * 0.85, 0))
      .multiply(new Matrix4().makeRotationX(0.35));
    addCylinder(b, dish, MAX_R * 0.34, MAX_R * 0.06, MAX_R * 0.16, 14, 0.95, 13);
    this.mark(occ, m, MAX_R * 0.25);
    // Mast and dish: a thin pole throws a thin shadow, the dish a round one.
    this.cast(sh, m, MAX_R * 0.45, 0, MAX_R * 0.08, 13, 1);
    this.cast(sh, m, MAX_R * 0.9, 0, MAX_R * 0.2, 13, 1);

    // Whip antennae.
    for (let i = 0; i < 2; i++) {
      this.place(shape, 0.36 + i * 0.3, TOP + (i === 0 ? 0.9 : -1.1), 0, 0, m);
      addCylinder(b, m, MAX_R * 0.03, MAX_R * 0.012, MAX_R * (1.1 + i * 0.4), 5, 1.0, 14);
    }

    // Tail stabiliser.
    this.place(shape, 0.93, TOP, MAX_R * 0.15, 0, m);
    addBox(b, m, MAX_R * 0.1, MAX_R * 0.85, SHIP_LENGTH_KM * 0.09, 0.7, 15);
    this.mark(occ, m, MAX_R * 0.4);
    this.cast(sh, m, MAX_R * 0.45, SHIP_LENGTH_KM * 0.07, MAX_R * 0.26, 15, 3);

    // Patch plates: welded on later, over damage nobody logged.
    const patches = rng.int(4, 6);
    for (let i = 0; i < patches; i++) {
      const t = rng.range(0.2, 0.9);
      // Kept off the belly: a patch hanging under the keel reads as damage.
      const th = rng.range(-0.6, Math.PI + 0.6);
      this.place(shape, t, th, MAX_R * 0.02, rng.range(-0.4, 0.4), m);
      addBox(
        b,
        m,
        MAX_R * rng.range(0.4, 0.8),
        MAX_R * 0.028,
        SHIP_LENGTH_KM * rng.range(0.03, 0.07),
        1.0,
        16 + i,
      );
    }
  }

  /**
   * Darken hull vertices that sit inside the shadow of a bolt-on. A real AO
   * bake is overkill for 4000 vertices you can hold in one hand.
   */
  private applyContactAO(b: HullBuilder, hullVerts: number, occ: Occluder[]): void {
    for (let i = 0; i < hullVerts; i++) {
      const x = b.pos[i * 3];
      const y = b.pos[i * 3 + 1];
      const z = b.pos[i * 3 + 2];
      // Nearest occluder wins rather than accumulating: multiplying overlapping
      // spheres punches black craters into the plating.
      let ao = 1;
      for (const o of occ) {
        const d = Math.hypot(x - o.x, y - o.y, z - o.z);
        if (d > o.r * 2.2) continue;
        const k = 0.55 + 0.45 * clamp01((d - o.r * 0.55) / (o.r * 1.65));
        if (k < ao) ao = k;
      }
      b.ao[i] = ao;
    }
  }

  /**
   * Poisson-ish scatter over the hull surface. Rejection against a minimum
   * spacing is what stops greebles clumping into visual noise.
   */
  private scatterGreebles(
    geo: BufferGeometry,
    shape: HullShape,
    rng: Rng,
    count: number,
    occ: Occluder[],
    kind: GreebleKind,
    seats: Array<{ p: Vector3; r: number }>,
  ): InstancedMesh {
    // Per-family footprint envelope. A pipe is square in plan and stands up; a
    // ribbed strip is long and low. Widening these ranges is half of what
    // stops the scatter reading as one repeated silhouette.
    const env =
      kind === 'pipe'
        ? { w: 0.085, lo: 1.0, hi: 1.0, h: 0.16, hlo: 0.5, hhi: 1.6 }
        : kind === 'ribbed'
          ? { w: 0.13, lo: 0.5, hi: 3.4, h: 0.06, hlo: 0.5, hhi: 1.4 }
          : kind === 'bracket'
            ? { w: 0.12, lo: 0.6, hi: 2.2, h: 0.1, hlo: 0.6, hhi: 1.8 }
            : kind === 'stack'
              ? { w: 0.14, lo: 0.6, hi: 1.7, h: 0.09, hlo: 0.7, hhi: 1.7 }
              : { w: 0.17, lo: 0.55, hi: 2.6, h: 0.05, hlo: 0.5, hhi: 1.5 };
    const mats: Matrix4[] = [];
    const wear: number[] = [];
    const part: number[] = [];
    const p = new Vector3();
    const m = new Matrix4();
    const scaleM = new Matrix4();

    let attempts = 0;
    let taken = 0;
    while (taken < count && attempts < count * 40) {
      attempts++;
      const t = rng.range(0.08, 0.97);
      // Biased away from straight down: nobody bolts equipment where the
      // landing gear puts it in the dirt, and a greebled belly reads as noise.
      const theta = rng.chance(0.78)
        ? rng.range(-0.75, Math.PI + 0.75)
        : rng.range(Math.PI + 0.75, Math.PI * 2 - 0.75);
      shape.sample(t, theta, p);

      // Size is drawn before the rejection test, because spacing has to know
      // how big the thing is. A fixed 1.1 m minimum let a 1.8 m wide part sit
      // on top of its neighbour, which is why greebles were intersecting.
      const s = rng.power(0.3, 1.0, -1.6);
      // Greebles hug the hull: tall boxes read as debris, not as hardware.
      const ratio = rng.range(env.lo, env.hi);
      const sx = MAX_R * env.w * s * (kind === 'ribbed' ? 1 : ratio);
      const sz = MAX_R * env.w * s * (kind === 'ribbed' ? ratio : rng.range(0.7, 1.6));
      const sy = MAX_R * env.h * s * rng.range(env.hlo, env.hhi);
      const yaw = rng.range(0, Math.PI * 2);
      const rad = Math.max(sx, kind === 'pipe' ? sx : sz) * 0.5;

      let ok = true;
      // `seats` is shared across every greeble family: rejecting only against
      // your own family lets five scatters land on top of each other.
      for (const a of seats) {
        // Size-aware, but with a fixed floor: hardware that touches its
        // neighbour reads as a pile, not as a fitted-out hull.
        const gap = (rad + a.r) * 0.95 + 0.0005;
        if (a.p.distanceToSquared(p) < gap * gap) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // Do not bury greebles inside the bolt-ons.
      for (const o of occ) {
        const d = Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z);
        if (d < o.r * 0.95) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      seats.push({ p: p.clone(), r: rad });
      taken++;
      // Seat them *into* the shell rather than floating them above it. The
      // mounting face is flat and the hull is not, so a part that only kisses
      // the plating shows daylight under its corners; sinking a fifth of its
      // own height buries that gap and gives the base a contact line.
      this.place(shape, t, theta, sy * 0.22, yaw, m);
      scaleM.makeScale(sx, sy, kind === 'pipe' ? sx : sz);
      mats.push(new Matrix4().multiplyMatrices(m, scaleM));
      wear.push(rng.range(0.4, 1.0));
      // 40+: patch plates run to 21 and the nacelle hardware to 34, and part id
      // now picks the plate scale as well as the paint batch, so they must not
      // collide.
      part.push(40 + rng.int(0, 11));
    }

    const n = mats.length;
    const mat = this.greebleMat;
    const mesh = new InstancedMesh(geo, mat, Math.max(n, 1));
    mesh.frustumCulled = false;
    const wearArr = new Float32Array(Math.max(n, 1));
    const partArr = new Float32Array(Math.max(n, 1));
    for (let i = 0; i < n; i++) {
      mesh.setMatrixAt(i, mats[i]);
      wearArr[i] = wear[i];
      partArr[i] = part[i];
    }
    // A starved family must draw nothing: the instance buffer is allocated with
    // at least one slot and an unwritten slot is the identity matrix, which
    // would put a one-kilometre greeble through the middle of the ship.
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    geo.setAttribute('aWear', new InstancedBufferAttribute(wearArr, 1));
    geo.setAttribute('aPart', new InstancedBufferAttribute(partArr, 1));
    return mesh;
  }

  /**
   * @param lamps Filled with (x, y, z, strength) for the strongest emitters, in
   *        object space, so the hull shader can pool their light on the plating
   *        around them. An emitter that lights nothing reads as a sticker.
   */
  private buildLights(shape: HullShape, rng: Rng, lamps: Float32Array): BufferGeometry {
    let lampCount = 0;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const phase: number[] = [];
    const kind: number[] = [];
    const idx: number[] = [];

    const p = new Vector3();
    const n = new Vector3();
    const right = new Vector3();
    const up = new Vector3();

    const quad = (
      t: number,
      theta: number,
      w: number,
      h: number,
      r: number,
      g: number,
      bl: number,
      k: number,
      lamp = 0,
    ): void => {
      shape.sample(t, theta, p);
      shape.normal(t, theta, n);
      p.addScaledVector(n, 0.00018);
      if (lamp > 0 && lampCount < LAMP_MAX) {
        // Sits 40 cm proud of the plating so the pool has a real solid angle:
        // a source flush with the surface only ever grazes it.
        lamps[lampCount * 4] = p.x + n.x * 0.0004;
        lamps[lampCount * 4 + 1] = p.y + n.y * 0.0004;
        lamps[lampCount * 4 + 2] = p.z + n.z * 0.0004;
        lamps[lampCount * 4 + 3] = lamp;
        lampCount++;
      }
      // Long axis of a window runs along the hull, like every porthole ever.
      right.copy(AXIS_Z).addScaledVector(n, -AXIS_Z.dot(n));
      if (right.lengthSq() < 1e-8) right.set(0, 1, 0).addScaledVector(n, -n.y);
      right.normalize();
      up.crossVectors(n, right);
      const base = pos.length / 3;
      const ph = rng.next();
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -0.5 : 0.5;
        const sy = i < 2 ? -0.5 : 0.5;
        pos.push(
          p.x + right.x * w * sx + up.x * h * sy,
          p.y + right.y * w * sx + up.y * h * sy,
          p.z + right.z * w * sx + up.z * h * sy,
        );
        nrm.push(n.x, n.y, n.z);
        uv.push(sx + 0.5, sy + 0.5);
        col.push(r, g, bl);
        phase.push(ph);
        kind.push(k);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    const TOP = Math.PI * 0.5;
    // Cockpit glass: the one warm rectangle you can read the ship's scale by.
    quad(0.17, TOP + 0.55, 0.0018, 0.0009, 1.0, 0.58, 0.2, 1, 5.0);
    quad(0.2, TOP + 0.9, 0.0011, 0.0007, 1.0, 0.55, 0.18, 1);
    // Crew windows along the starboard flank. Evenly spaced, identically sized
    // windows read as a bus: the spacing is grouped into a two-and-three with a
    // gap where the frame bulkhead is, the sizes step, and one port in the run
    // is a small round scuttle rather than a window.
    const starboard: Array<[number, number, number, number]> = [
      [0.39, 0.0011, 0.0007, 1],
      [0.435, 0.0008, 0.0006, 1],
      [0.53, 0.0009, 0.0006, 1],
      [0.565, 0.00055, 0.00055, 0],
      [0.6, 0.0012, 0.00065, 1],
    ];
    for (let i = 0; i < starboard.length; i++) {
      const [t, w, h, k] = starboard[i];
      quad(
        t,
        0.35 + (i % 2 === 0 ? 0.0 : 0.12),
        w,
        h,
        1.0,
        0.6,
        0.24,
        k,
        i === 0 ? 3.2 : i === 2 ? 3.6 : i === 4 ? 3.4 : 0,
      );
    }
    // Port flank: fewer, and staggered off the starboard run so a three-quarter
    // view never sees two matching rows.
    quad(0.44, Math.PI - 0.42, 0.001, 0.00065, 1.0, 0.6, 0.24, 1, 3.2);
    quad(0.485, Math.PI - 0.3, 0.0006, 0.0006, 1.0, 0.6, 0.24, 0);
    quad(0.58, Math.PI - 0.45, 0.0013, 0.0006, 1.0, 0.6, 0.24, 1);
    // Running lights and beacons — one cold accent, the rest amber.
    quad(0.86, 0.16, 0.0007, 0.0007, 1.0, 0.35, 0.1, 0);
    quad(0.86, Math.PI - 0.16, 0.0007, 0.0007, 0.3, 0.75, 1.0, 0);
    quad(0.06, TOP, 0.0005, 0.0005, 1.0, 0.45, 0.12, 0);
    quad(0.95, TOP, 0.0006, 0.0006, 1.0, 0.4, 0.12, 0);
    quad(0.55, -TOP, 0.0006, 0.0006, 1.0, 0.3, 0.08, 0);
    // Floodlight over the cargo pannier's hatch: the only cold light on the
    // hull, and the reason the pannier is not just a black slab at night. Not
    // registered as a lamp: the hull's pooling term is authored in uAmber, and
    // one cold pool among five warm ones would need a second colour uniform for
    // a light that covers two square metres.
    quad(0.52, TOP - 1.15, 0.0008, 0.0005, 0.6, 0.78, 1.0, 0);

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(col), 3));
    g.setAttribute('aPhase', new BufferAttribute(new Float32Array(phase), 1));
    g.setAttribute('aKind', new BufferAttribute(new Float32Array(kind), 1));
    g.setIndex(idx);
    return g;
  }

  private buildNozzles(): BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const ts: number[] = [];
    const idx: number[] = [];
    const seg = 16;
    const rings = [
      { t: 0, r: MAX_R * 0.2, o: 0 },
      { t: 0.45, r: MAX_R * 0.26, o: MAX_R * 0.3 },
      { t: 1, r: MAX_R * 0.44, o: MAX_R * 0.62 },
    ];

    for (let e = 0; e < this.enginePos.length; e++) {
      const c = this.enginePos[e];
      const d = this.engineDir[e];
      const up = new Vector3(0, 1, 0).addScaledVector(d, -d.y).normalize();
      const rt = new Vector3().crossVectors(up, d);
      const base = pos.length / 3;
      for (let r = 0; r < rings.length; r++) {
        const ring = rings[r];
        for (let s = 0; s < seg; s++) {
          const a = (s / seg) * Math.PI * 2;
          const cx = Math.cos(a);
          const sy = Math.sin(a);
          pos.push(
            c.x + d.x * ring.o + (rt.x * cx + up.x * sy) * ring.r,
            c.y + d.y * ring.o + (rt.y * cx + up.y * sy) * ring.r,
            c.z + d.z * ring.o + (rt.z * cx + up.z * sy) * ring.r,
          );
          nrm.push(rt.x * cx + up.x * sy, rt.y * cx + up.y * sy, rt.z * cx + up.z * sy);
          ts.push(ring.t);
        }
      }
      for (let r = 0; r < rings.length - 1; r++) {
        for (let s = 0; s < seg; s++) {
          const a = base + r * seg + s;
          const b = base + r * seg + ((s + 1) % seg);
          const cc = base + (r + 1) * seg + ((s + 1) % seg);
          const dd = base + (r + 1) * seg + s;
          idx.push(a, b, cc, a, cc, dd);
        }
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('aT', new BufferAttribute(new Float32Array(ts), 1));
    g.setIndex(idx);
    return g;
  }

  /**
   * Two nested cone shells per engine. `position` carries the nozzle mouth,
   * `normal` the radial direction and `aT` the axial parameter, so the vertex
   * shader can stretch the whole column from three uniforms.
   */
  private buildPlume(): BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const ts: number[] = [];
    const layer: number[] = [];
    const dirs: number[] = [];
    const idx: number[] = [];
    const seg = 16;
    const steps = 12;

    for (let e = 0; e < this.enginePos.length; e++) {
      const c = this.enginePos[e];
      const d = this.engineDir[e];
      const up = new Vector3(0, 1, 0).addScaledVector(d, -d.y).normalize();
      const rt = new Vector3().crossVectors(up, d);
      for (let l = 0; l < 2; l++) {
        const base = pos.length / 3;
        for (let r = 0; r <= steps; r++) {
          const t = r / steps;
          for (let s = 0; s < seg; s++) {
            const a = (s / seg) * Math.PI * 2;
            const cx = Math.cos(a);
            const sy = Math.sin(a);
            pos.push(c.x, c.y, c.z);
            nrm.push(rt.x * cx + up.x * sy, rt.y * cx + up.y * sy, rt.z * cx + up.z * sy);
            ts.push(t);
            layer.push(l);
            dirs.push(d.x, d.y, d.z);
          }
        }
        for (let r = 0; r < steps; r++) {
          for (let s = 0; s < seg; s++) {
            const a = base + r * seg + s;
            const b = base + r * seg + ((s + 1) % seg);
            const cc = base + (r + 1) * seg + ((s + 1) % seg);
            const dd = base + (r + 1) * seg + s;
            idx.push(a, b, cc, a, cc, dd);
          }
        }
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('aT', new BufferAttribute(new Float32Array(ts), 1));
    g.setAttribute('aLayer', new BufferAttribute(new Float32Array(layer), 1));
    g.setAttribute('aDir', new BufferAttribute(new Float32Array(dirs), 3));
    g.setIndex(idx);
    return g;
  }

  private buildWake(): BufferGeometry {
    const pos: number[] = [];
    const nrm: number[] = [];
    const ts: number[] = [];
    const ang: number[] = [];
    const idx: number[] = [];
    const seg = 24;
    const steps = 14;
    const z0 = HALF * 0.95;

    for (let r = 0; r <= steps; r++) {
      const t = r / steps;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        pos.push(0, 0, z0);
        nrm.push(Math.cos(a), Math.sin(a) * 0.8, 0);
        ts.push(t);
        ang.push(a);
      }
    }
    for (let r = 0; r < steps; r++) {
      for (let s = 0; s < seg; s++) {
        const a = r * seg + s;
        const b = r * seg + ((s + 1) % seg);
        const c = (r + 1) * seg + ((s + 1) % seg);
        const d = (r + 1) * seg + s;
        idx.push(a, b, c, a, c, d);
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('aT', new BufferAttribute(new Float32Array(ts), 1));
    g.setAttribute('aAngle', new BufferAttribute(new Float32Array(ang), 1));
    g.setIndex(idx);
    return g;
  }

  private buildThrusters(shape: HullShape): void {
    const spots: Array<[number, number]> = [
      // Bow quad — these do the work in a docking approach.
      [0.14, 0],
      [0.14, Math.PI],
      [0.14, Math.PI * 0.5],
      [0.14, -Math.PI * 0.5],
      // Stern quad.
      [0.8, 0.2],
      [0.8, Math.PI - 0.2],
      [0.8, Math.PI * 0.5],
      [0.8, -Math.PI * 0.5],
      // Mid-body pair for pure translation.
      [0.48, Math.PI * 0.5],
      [0.48, -Math.PI * 0.5],
    ];
    for (const [t, theta] of spots) {
      const p = new Vector3();
      const n = new Vector3();
      shape.sample(t, theta, p);
      shape.normal(t, theta, n);
      // 40 cm proud of the plating: the puff must clear the hull's depth or
      // it gets z-tested away against the panel it is bolted to.
      p.addScaledVector(n, 0.0004);
      this.thrusters.push({ pos: p, dir: n });
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, state: ShipState): void {
    this.time += dt;

    // Every visible value chases its command. The engine spools, it does not
    // switch; heat builds and bleeds off. Nothing is ever assigned directly.
    this.vThrottle = damp(this.vThrottle, clamp01(state.throttle), 3.0, dt);
    this.vBoost = damp(this.vBoost, clamp01(state.boost), 2.2, dt);
    this.vHeat = damp(this.vHeat, clamp01(state.heating), 1.5, dt);

    const th = this.vThrottle;
    const boost = this.vBoost;

    // Camera in local space: the hull shader needs it for specular and wear.
    ctx.camera.updateWorldMatrix(true, false);
    this.object3d.updateWorldMatrix(true, false);
    this._inv.copy(this.object3d.matrixWorld).invert();
    this._camLocal.setFromMatrixPosition(ctx.camera.matrixWorld).applyMatrix4(this._inv);

    const hu = this.hullMat.uniforms;
    hu.uTime.value = this.time;
    hu.uThrottle.value = th + boost * 0.5;
    hu.uHeat.value = this.vHeat;
    (hu.uSunColor.value as Color).copy(this.sunColor);
    (hu.uFill.value as Color).copy(this.fillColor);
    // uSunDir and uCameraLocal alias live Vector3s — no copy needed.

    this.lightMat.uniforms.uTime.value = this.time;

    // Engines ---------------------------------------------------------------
    const drive = clamp01(th + boost * 0.35);
    this.nozzleMat.uniforms.uThrottle.value = drive;
    this.nozzleMat.uniforms.uGlowDepth.value = 0.12 + drive * 0.75;

    const pu = this.plumeMat.uniforms;
    pu.uLen.value = SHIP_LENGTH_KM * (0.08 + th * 0.62 + boost * 0.7);
    pu.uWidth.value = MAX_R * (0.2 + th * 0.24 + boost * 0.14);
    // Stays deep blue at cruise; only boost drives it white-hot.
    pu.uHeatMix.value = clamp01(th * 0.3 + boost * 0.85);
    pu.uIntensity.value = 1.15 * smoothstep(0.0, 0.15, th) * (0.45 + th * 0.8 + boost * 0.35);
    pu.uDiamonds.value = smoothstep(0.5, 0.92, th) * (0.5 + 0.5 * boost);
    pu.uThrottle.value = th;
    this.plumeMesh.visible = th > 0.01 || boost > 0.01;
    // The hull's fake plume light must track the plume's colour. Weighted the
    // same way the plume itself is: throttle alone must not wash the blue out,
    // or the one cold accent on the ship goes white at cruise.
    (hu.uPlumeColor.value as Color)
      .setRGB(0.16, 0.36, 1.0)
      .lerp(PLUME_HOT, clamp01(th * 0.28 + boost * 0.85));

    // RCS -------------------------------------------------------------------
    const cmd = state.rcs;
    const mag = Math.min(1, cmd.length());
    if (mag > 1e-4) this._rcsDir.copy(cmd).multiplyScalar(1 / cmd.length());
    let anyFiring = 0;
    const levels = this.rcsAttr.array as Float32Array;
    for (let i = 0; i < this.thrusters.length; i++) {
      let target = 0;
      if (mag > 1e-4) {
        // Thrust is opposite the exhaust, so the firing nozzle is the one
        // pointing away from where the pilot asked to go.
        const align = -this._rcsDir.dot(this.thrusters[i].dir);
        if (align > 0.3) target = Math.min(1, (align - 0.3) / 0.5) * mag;
      }
      // Cold-gas thrusters are bang-bang valves; they stutter, they never hold.
      if (target > 0) {
        const duty = Math.sin(this.time * 17 + this.rcsPhase[i] * 6.2831);
        target *= duty > -0.15 ? 1 : 0.1;
      }
      // Fast attack, slow decay: that asymmetry is the whole "puff" read.
      const rate = target > this.rcsLevel[i] ? 38 : 7.5;
      this.rcsLevel[i] = damp(this.rcsLevel[i], target, rate, dt);
      levels[i] = this.rcsLevel[i];
      if (this.rcsLevel[i] > anyFiring) anyFiring = this.rcsLevel[i];
    }
    this.rcsAttr.needsUpdate = true;
    this.rcsMesh.visible = anyFiring > 0.004;

    // Re-entry --------------------------------------------------------------
    this.wakeMat.uniforms.uHeat.value = this.vHeat;
    this.wakeMat.uniforms.uLen.value = SHIP_LENGTH_KM * (1.2 + this.vHeat * 2.6);
    this.wakeMat.uniforms.uWidth.value = MAX_R * (0.9 + this.vHeat * 1.5);
    this.wakeMesh.visible = this.vHeat > 0.01;
  }

  dispose(): void {
    this.hullGeo.dispose();
    for (const g of this.greebleGeos) g.dispose();
    this.lightGeo.dispose();
    this.nozzleGeo.dispose();
    this.plumeGeo.dispose();
    this.wakeGeo.dispose();
    this.rcsGeo.dispose();

    this.hullMat.dispose();
    this.greebleMat.dispose();
    this.lightMat.dispose();
    this.nozzleMat.dispose();
    this.plumeMat.dispose();
    this.wakeMat.dispose();
    this.rcsMat.dispose();

    for (const m of this.greebleMeshes) m.dispose();
    this.rcsMesh.dispose();

    // The integrator added object3d to the scene; removing it is their call.
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Review shot
// ---------------------------------------------------------------------------

const HERO_STATE: ShipState = {
  throttle: 0.68,
  // Light on the boost: it is what shifts the plume white, and the plume is the
  // only cold accent on the ship.
  boost: 0.12,
  heating: 0,
  // Mostly a down-translation, so the dorsal nozzles fire broadside to the
  // hero camera. A thruster firing straight at the lens is not a detail.
  rcs: new Vector3(-0.24, -0.7, 0),
};

/** Camera direction in SHIP-LOCAL space, and how far back it sits, in km. */
const HERO_CAM_DIR = new Vector3(0.714, 0.333, 0.616).normalize();
const HERO_CAM_DIST = 0.078;
/**
 * Roll applied to the ship about the view axis. The axis runs through the ship
 * and the camera, so this rotates the composition on screen without moving the
 * camera relative to the hull: it buys the diagonal for free.
 */
const HERO_ROLL = 0.34;
/** Where the ship's centre lands, in NDC. Dead centre is a turntable render. */
const HERO_OFFSET_X = 0.16;
const HERO_OFFSET_Y = 0.12;

/**
 * Register the ship's hero frame.
 *
 * Pass the live ship if one exists; otherwise the shot builds its own so the
 * module can be reviewed before the integrator has wired anything up.
 */
export function registerShipShots(existing?: Ship): void {
  let owned: Ship | null = null;
  let resolved: Ship | null = null;

  const camPos = new Vector3();
  const target = new Vector3();
  const axisX = new Vector3();
  const axisY = new Vector3();
  const axisZ = new Vector3();
  const worldUp = new Vector3(0, 1, 0);

  registerShot({
    name: 'ship-hero',
    description:
      'Rear three-quarter of the ship under a raking key, engines lit at cruise with both ' +
      'bell throats and the plume in frame, RCS puffing, plating and edge wear reading ' +
      'across the flank. Composed on the diagonal with the plume exiting frame.',
    apply(ctx) {
      let ship = existing;
      if (!ship) {
        owned = owned ?? new Ship(0x5eed1701, ctx.quality);
        ship = owned;
        if (!ship.object3d.parent) ctx.scene.add(ship.object3d);
      }
      resolved = ship;

      ship.object3d.position.set(0, 0, 0);
      ship.object3d.rotation.set(0.10, 0.34, -0.13);
      ship.object3d.updateMatrixWorld(true);

      // The camera is placed in SHIP-LOCAL space and then rotated into the
      // world, because what matters is the angle onto the hull, not a world
      // coordinate. Previously it sat forward of both bell mouths, so even with
      // the drive lit you could only ever see the outside of the nozzles.
      // 52 degrees off the thrust axis puts both throats and the plume in
      // frame while the starboard flank is still nearly side-on.
      camPos.copy(HERO_CAM_DIR).multiplyScalar(HERO_CAM_DIST);
      camPos.applyQuaternion(ship.object3d.quaternion);

      // Roll the hull about the view axis: pure screen-space rotation, so the
      // lighting on the hull is untouched and the ship runs on a 35 degree
      // diagonal instead of lying flat across the middle of the frame.
      ship.object3d.rotateOnWorldAxis(_v.copy(camPos).normalize(), HERO_ROLL);
      ship.object3d.updateMatrixWorld(true);

      // Key roughly 80 degrees off the camera and high: the top plating reads
      // fully lit, the near flank is grazed, and a hard terminator runs down
      // the hull where the fins and pylons now cast across the plating.
      ship.sunDirection.set(0.40, 0.74, -0.54).normalize();
      ship.sunColor.setRGB(1.0, 0.93, 0.82).multiplyScalar(3.0);
      // Cold planetshine off a world just out of frame — the only thing
      // separating the shadow side from the background, and now also the
      // environment the hull's metals reflect.
      ship.fillColor.setRGB(0.11, 0.14, 0.22);

      // 0.05 km near plane: the camera cannot come closer than 50 m, so the
      // hero framing is a telephoto rather than a wide.
      ctx.camera.fov = 22;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.position.copy(camPos);

      // Push the subject off centre by aiming past it. Half-extents of the
      // frame at the subject's distance, so the offsets read directly in NDC.
      axisZ.copy(camPos).normalize();
      axisX.crossVectors(worldUp, axisZ).normalize();
      axisY.crossVectors(axisZ, axisX);
      const hy = HERO_CAM_DIST * Math.tan((ctx.camera.fov * Math.PI) / 360);
      const hx = hy * Math.max(ctx.camera.aspect, 1e-3);
      target
        .set(0, 0, 0)
        .addScaledVector(axisX, -HERO_OFFSET_X * hx)
        .addScaledVector(axisY, -HERO_OFFSET_Y * hy);
      ctx.camera.lookAt(target);
      ctx.camera.updateMatrixWorld(true);

      // On the in-frame light source that section 6 asks for: the key itself
      // cannot be in shot. A star inside a 38 degree frame sits within 20
      // degrees of the view axis, which is a silhouette, not a raking key —
      // and this shot exists to show plating. The emitter carrying that job is
      // the drive: with the engines actually lit, both bell throats and the
      // plume core sit well above PostFX's bright-pass threshold, in the lower
      // left third, and the plume runs out of frame. A separate key-star
      // sprite would have to live in the shared scene, and `Shot` has no
      // teardown hook to take it down again for the next shot.

      // Spool the drive before the first frame is captured. Every visible value
      // on this ship is critically damped towards its command, so a shot that
      // starts from rest photographs a powered-down hull no matter what state
      // it asked for — which is exactly what the last review caught.
      for (let i = 0; i < 12; i++) ship.update(0.25, ctx, HERO_STATE);
    },
    update(dt, ctx) {
      // Drive whichever ship the shot resolved. When the integrator supplies
      // one, Pilot has already stood down for the duration of the shot, so
      // this is the only update the hull gets — without it the throttle,
      // plume, nozzle glow and RCS all stay at their constructor zero.
      if (resolved) resolved.update(dt, ctx, HERO_STATE);
    },
  });
}
