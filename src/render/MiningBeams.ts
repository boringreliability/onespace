/**
 * The mining beam (v4 sub-plan 5, Task 6): mining you can see.
 *
 * For each operation in `Mining.operations` (DESIGN-5 §7.8: the list, not the
 * player's ship, so a drone's operation would be drawn the same way) a thin,
 * steady beam runs from its `source` (the nose) to its `impact` (the rock's
 * surface nearest the ship), a glow sits where it hits, and every
 * `'mining:bite'` throws a small puff of pebbles off the surface. Three
 * InstancedMeshes, three draw calls at most, however many beams; nothing is
 * drawn (count 0, hidden) when nothing is mined.
 *
 * READING THE OPERATIONS. Mining hands out one of two arrays and reuses its
 * one operation object, mutated in place. So `operations` is read every
 * update and its numbers are COPIED into this module's own slots; nothing is
 * kept by reference. A beam follows an operation by its rock (`asteroidId`):
 * when the same object comes back for another rock, the old beam fades out
 * where it was and a new one fades in.
 *
 * A bite is resolved against the operations at the moment it is emitted (the
 * last bite of a rock is emitted just before Mining ends the extraction in
 * the same update, and must still throw pebbles). Mining emits a bite BEFORE
 * it places the operation for the frame, so on a rock this module already
 * draws, the operation still holds the endpoints of the last update: the
 * puff is carried on by the rock's velocity times the orbit time since then,
 * to be born where the impact is now.
 *
 * CLOCK: `universe.orbitSeconds`, as the break-up in Asteroids. The fade and
 * the pebbles advance only by orbit time, so a frozen clock (pause, chart)
 * freezes them where they stand; a clock that runs backwards (a restore)
 * advances nothing and ends every pebble.
 *
 * RIDING THE FIELD. A fading beam keeps its last endpoints, and a pebble
 * flies from where it was thrown; in a belt the rock (and the ship beside it)
 * orbit at ~18 km/s, so both are carried on with the rock's velocity when a
 * Belt is given (`belt.asteroidVelocity`). It is read for every live beam on
 * every update and cached in the beam's slot (as Asteroids caches it per
 * slot): the Belt forgets an emptied rock before its last bite is emitted,
 * and the last puff and the fading beam still ride with the velocity the
 * rock had while alive. A beam fades from the frame its operation is gone,
 * already carried on to that frame. A live beam is never moved: it sits on
 * the operation's endpoints. Without a Belt, or a velocity it ever knew
 * (tests), they stay put in the world.
 *
 * CAMERA-RELATIVE (ruling R15, as Asteroids): every instance translation is
 * `world − cameraWorld` in float64 on the CPU, the root a pure translation at
 * the camera's render position, the shader `modelViewMatrix * instanceMatrix`.
 *
 * Scene contract (as Dust and Asteroids): linear HDR, toneMapped false, no
 * colorspace or dither chunk, all four logdepthbuf chunks. Warm white-amber,
 * never the nav target's cyan; the core sits above PostFX's bloom threshold
 * (1.0) and below its streak threshold (2.5): it glows, it does not flare.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import type { Mode } from '@/core/Modes';
import type { MiningOperation } from '@/game/Mining';
import { AU, type StarSystemSpec } from '@/gen/types';
import type { Resource } from '@/gen/belt';
import { registerShot } from '@/game/Shots';
import type { ShipState } from '@/ship/Ship';
import type { AsteroidReviewRock } from './Asteroids';
import { keyLightAt } from './keyLight';

/** Beams (and glows) drawn at once; a further operation is ignored. */
export const MAX_BEAMS = 8;
/** Fade in and out, seconds of orbit time. */
export const BEAM_FADE_S = 0.25;
/** Live pebbles at most; a new puff past the cap replaces the oldest. */
export const MAX_PEBBLES = 96;

/** Pebbles per bite. */
const PUFF = 7;
/** Beam half-width, km (35 cm), and its floor in pixels so it never aliases away. */
const BEAM_HALF_KM = 0.00035;
const BEAM_MIN_PX = 0.9;
/** Glow radius, km, and its floor in pixels. */
const GLOW_KM = 0.007;
const GLOW_MIN_PX = 13;
/** Warm white-amber, linear; the beam's core is whiter, the glow hotter. */
const BEAM_COLOR: readonly [number, number, number] = [1.0, 0.72, 0.4];
const BEAM_INTENSITY = 1.9;
const GLOW_INTENSITY = 1.6;
/** A bite brightens the glow a little for a moment. */
const PULSE = 0.35;
const PULSE_DECAY_S = 0.18;

/** Pebble life (s of orbit time), size (km), speed off the surface (km/s), cooling (s). */
const PEBBLE_LIFE_MIN_S = 1.4;
const PEBBLE_LIFE_SPAN_S = 1.2;
const PEBBLE_SIZE_MIN_KM = 0.0005;
const PEBBLE_SIZE_SPAN_KM = 0.0012;
const PEBBLE_SPEED_MIN = 0.005;
const PEBBLE_SPEED_SPAN = 0.013;
const PEBBLE_COOL_S = 0.8;
/** A live pebble is drawn at least this many pixels across. */
const PEBBLE_MIN_PX = 2.2;
/** Widest angle off the surface normal a pebble is thrown at (radians). */
const PEBBLE_CONE = 1.2;
/** Pebble record: pos xyz, vel xyz, axis xyz, spin, phase, size, life, birth. */
const PS = 14;

const SUN_BASE: readonly [number, number, number] = [1, 0.96, 0.9];

/** What it reads of Mining. `Mining` satisfies it. */
export interface MiningBeamsSource {
  readonly operations: readonly MiningOperation[];
}

/** What it reads of the universe. `Universe` satisfies it. */
export interface MiningBeamsWorld {
  readonly system: StarSystemSpec | null | undefined;
  readonly orbitSeconds: number;
}

export interface MiningBeamsOptions {
  readonly mining: MiningBeamsSource;
  readonly universe: MiningBeamsWorld;
  /** The rock's velocity, so a fading beam and the pebbles ride with the field. `Belt` satisfies it. */
  readonly belt?: { asteroidVelocity(id: string, out: { x: number; y: number; z: number }): boolean };
}

const BEAM_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aFade;
uniform float uHalfWidth;  // km
uniform float uMinPx;      // half-width floor, px
uniform float uPixel;      // km per px at 1 km: 2 tan(fov/2) / height
varying float vX;
varying float vZ;
varying float vLen;
varying float vFade;
varying float vGain;

void main() {
  // Local z runs 0..1 from the nose to the impact; local x is the side, in
  // half-widths, turned in view space to face the camera about the axis.
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, position.z, 1.0);
  vec3 axis = mat3(modelViewMatrix) * (mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
  vec3 side = cross(axis, mv.xyz);
  float sl = length(side);
  side = sl > 1e-12 ? side / sl : vec3(1.0, 0.0, 0.0);
  float w = max(uHalfWidth, uMinPx * uPixel * max(-mv.z, 0.0));
  mv.xyz += side * position.x * w;
  vX = position.x;
  vZ = position.z;
  vLen = length(axis);
  vFade = aFade;
  // Widened to the pixel floor, the same light is spread thinner.
  vGain = clamp(uHalfWidth / w, 0.35, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const BEAM_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;       // linear, warm white-amber
uniform float uIntensity;
uniform float uTime;       // orbit seconds, wrapped
varying float vX;
varying float vZ;
varying float vLen;
varying float vFade;
varying float vGain;

void main() {
  #include <logdepthbuf_fragment>
  float x2 = vX * vX;
  float core = exp(-x2 * 14.0);
  float halo = exp(-x2 * 3.0) * 0.3 * (1.0 - x2);
  float f = vFade * vFade * (3.0 - 2.0 * vFade);
  // Soft out of the nose; a faint, slow ripple running towards the rock.
  float ends = smoothstep(0.0, 0.006, vZ * vLen);
  float ripple = 0.95 + 0.05 * sin(vZ * vLen * 380.0 - uTime * 9.0);
  vec3 hot = mix(uColor, vec3(1.0, 0.94, 0.84), 0.55);
  vec3 c = (uColor * halo + hot * core) * uIntensity * f * ends * ripple * vGain;
  gl_FragColor = vec4(c, 1.0);
}
`;

const GLOW_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aFade;
uniform float uSize;       // km
uniform float uMinPx;
uniform float uPixel;
varying vec2 vUv;
varying float vFade;

void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = max(uSize, uMinPx * uPixel * max(-mv.z, 0.0));
  // Lifted towards the camera, out of the rock it sits on; then a billboard.
  vec3 toCam = normalize(-mv.xyz);
  mv.xyz += toCam * s;
  mv.xy += position.xy * s;
  vUv = position.xy;
  vFade = aFade;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const GLOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying float vFade;

void main() {
  #include <logdepthbuf_fragment>
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  float wide = (exp(-r2 * 10.0) - exp(-10.0)) * 0.5 + (1.0 - r2) * (1.0 - r2) * 0.04;
  float core = exp(-r2 * 90.0) * 1.1;
  float f = clamp(vFade, 0.0, 2.0);
  vec3 hot = mix(uColor, vec3(1.0, 0.95, 0.86), 0.5);
  gl_FragColor = vec4((uColor * wide + hot * core) * uIntensity * f, 1.0);
}
`;

const PEBBLE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aHeat;     // 1 thrown hot … 0 cooled
uniform float uMinPx;      // a live pebble is never smaller than this, px across
uniform float uPixel;
varying vec3 vNormal;
varying float vHeat;

void main() {
  vNormal = normalize(mat3(instanceMatrix) * normal);
  vHeat = aHeat;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float size = length(instanceMatrix[0].xyz);
  // Far off, a metre-sized chip is under a pixel: hold it at a speck, not nothing.
  float floorKm = uMinPx * 0.5 * uPixel * max(-centre.z, 0.0);
  if (size > 0.0 && size < floorKm) mv.xyz = centre.xyz + (mv.xyz - centre.xyz) * (floorKm / size);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const PEBBLE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHot;
varying vec3 vNormal;
varying float vHeat;

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, uSunDir), 0.0);
  // Grey-brown grit in the starlight, with the beam's heat dying out of it.
  vec3 rock = vec3(0.16, 0.14, 0.12) * uSunColor * (ndl + 0.06);
  vec3 c = rock + uHot * (vHeat * sqrt(vHeat));
  gl_FragColor = vec4(c, 1.0);
}
`;

/** One beam slot. */
const FREE = 0;
const LIVE = 1;
const FADING = 2;

export class MiningBeams implements GameModule {
  readonly name = 'mining-beams';
  /** A pure translation to the camera's render position. */
  readonly root = new Group();
  readonly beams: InstancedMesh;
  readonly glows: InstancedMesh;
  readonly pebbles: InstancedMesh;

  private readonly mining: MiningBeamsSource;
  private readonly universe: MiningBeamsWorld;
  private readonly belt: MiningBeamsOptions['belt'];
  private readonly beamMaterial: ShaderMaterial;
  private readonly glowMaterial: ShaderMaterial;
  private readonly pebbleMaterial: ShaderMaterial;
  private readonly beamFade: InstancedBufferAttribute;
  private readonly glowFade: InstancedBufferAttribute;
  private readonly pebbleHeat: InstancedBufferAttribute;
  private readonly offBite: () => void;
  private disposed = false;
  private warmed = false;

  // Beam slots, all preallocated: state, rock, fade, endpoints (world km), drift, last bite.
  private readonly state = new Uint8Array(MAX_BEAMS);
  private readonly rock: Array<string | null> = new Array<string | null>(MAX_BEAMS).fill(null);
  private readonly seen = new Uint8Array(MAX_BEAMS);
  private readonly fade = new Float64Array(MAX_BEAMS);
  // One row more than the slots: the row a bite's own endpoints are copied into.
  private readonly ends = new Float64Array((MAX_BEAMS + 1) * 6);
  private readonly drift = new Float64Array((MAX_BEAMS + 1) * 3);
  // The rock's velocity last known while the beam was live (zero if never known).
  private readonly vel = new Float64Array(MAX_BEAMS * 3);
  private readonly pulseT = new Float64Array(MAX_BEAMS).fill(Number.NEGATIVE_INFINITY);

  // Pebbles: a ring of records; `alive` marks the used ones.
  private readonly pebbleData = new Float64Array(MAX_PEBBLES * PS);
  private readonly alive = new Uint8Array(MAX_PEBBLES);
  private nextPebble = 0;
  private puffs = 0;

  /** Orbit time of the last update; NaN before the first. */
  private lastT = Number.NaN;
  /** The system the last update saw; a change drops everything. */
  private system: StarSystemSpec | null | undefined = undefined;

  private readonly v = { x: 0, y: 0, z: 0 };
  private readonly cam = new Vector3();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly q = new Quaternion();
  private readonly axis = new Vector3();
  private readonly m = new Matrix4();
  private readonly beamRange = { start: 0, count: 0 };
  private readonly beamRange16 = { start: 0, count: 0 };
  private readonly pebbleRange = { start: 0, count: 0 };
  private readonly pebbleRange16 = { start: 0, count: 0 };

  constructor(opts: MiningBeamsOptions) {
    this.mining = opts.mining;
    this.universe = opts.universe;
    this.belt = opts.belt;

    // The beam: a ribbon, x the side in half-widths, z 0..1 along the beam.
    const bg = new BufferGeometry();
    bg.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 0, 1, 1, 0, 1]), 3));
    bg.setIndex([0, 1, 2, 2, 1, 3]);
    this.beamFade = dynamicAttr(bg, 'aFade', MAX_BEAMS);
    this.beamMaterial = new ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: {
        uColor: { value: new Vector3(BEAM_COLOR[0], BEAM_COLOR[1], BEAM_COLOR[2]) },
        uIntensity: { value: BEAM_INTENSITY },
        uHalfWidth: { value: BEAM_HALF_KM },
        uMinPx: { value: BEAM_MIN_PX },
        uPixel: { value: 1e-3 },
        uTime: { value: 0 },
      },
      // The ribbon turns to face the camera; its winding then depends on the view.
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.beams = instanced(bg, this.beamMaterial, MAX_BEAMS, 'mining-beams-beam');

    // The glow: one billboard quad at each impact.
    const gg = new BufferGeometry();
    gg.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    gg.setIndex([0, 1, 2, 2, 1, 3]);
    this.glowFade = dynamicAttr(gg, 'aFade', MAX_BEAMS);
    this.glowMaterial = new ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: {
        uColor: { value: new Vector3(BEAM_COLOR[0], BEAM_COLOR[1] * 0.92, BEAM_COLOR[2] * 0.8) },
        uIntensity: { value: GLOW_INTENSITY },
        uSize: { value: GLOW_KM },
        uMinPx: { value: GLOW_MIN_PX },
        uPixel: { value: 1e-3 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.glows = instanced(gg, this.glowMaterial, MAX_BEAMS, 'mining-beams-glow');

    // The pebbles: a faceted chip, lit by the star and hot from the beam.
    const pg = new OctahedronGeometry(1, 0);
    this.pebbleHeat = dynamicAttr(pg, 'aHeat', MAX_PEBBLES);
    this.pebbleMaterial = new ShaderMaterial({
      vertexShader: PEBBLE_VERT,
      fragmentShader: PEBBLE_FRAG,
      uniforms: {
        uSunDir: { value: new Vector3(0, 0, 1) },
        uSunColor: { value: new Vector3(1, 1, 1) },
        uHot: { value: new Vector3(BEAM_COLOR[0] * 1.6, BEAM_COLOR[1] * 1.1, BEAM_COLOR[2] * 0.6) },
        uMinPx: { value: PEBBLE_MIN_PX },
        uPixel: { value: 1e-3 },
      },
      toneMapped: false,
    });
    this.pebbles = instanced(pg, this.pebbleMaterial, MAX_PEBBLES, 'mining-beams-pebbles');

    this.root.name = 'mining-beams';
    this.root.add(this.beams, this.glows, this.pebbles);
    this.root.visible = false;
    this.offBite = bus.on('mining:bite', this.onBite);
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);
  }

  /** Leaving flight drops everything at once: a hidden beam would come back frozen. */
  onModeChange(_from: Mode, to: Mode): void {
    if (to !== 'flight') this.dropAll();
  }

  update(_dt: number, ctx: EngineContext): void {
    if (this.disposed) return;
    if (!this.warmed) this.warm(ctx);
    const sys = this.universe.system;
    if (sys !== this.system) {
      this.system = sys;
      this.dropAll();
    }
    const t = this.orbitNow();
    const last = this.lastT;
    this.lastT = t;
    // Orbit time since the last update; none for a frozen or backward clock.
    const step = t > last ? t - last : 0;
    const back = t < last;

    // Live beams last frame are unseen until an operation claims them.
    this.seen.fill(0);
    const ops = this.mining.operations;
    const n = Math.min(ops.length, MAX_BEAMS);
    for (let i = 0; i < n; i++) {
      const op = ops[i]!;
      let k = -1;
      for (let b = 0; b < MAX_BEAMS; b++) {
        if (this.state[b] === LIVE && this.seen[b] === 0 && this.rock[b] === op.asteroidId) {
          k = b;
          break;
        }
      }
      if (k >= 0) {
        this.fade[k] = Math.min(1, this.fade[k]! + step / BEAM_FADE_S);
      } else {
        k = this.claimSlot();
        if (k < 0) continue;
        this.state[k] = LIVE;
        this.rock[k] = op.asteroidId;
        this.fade[k] = 0;
        this.pulseT[k] = Number.NEGATIVE_INFINITY;
        this.vel[k * 3] = 0;
        this.vel[k * 3 + 1] = 0;
        this.vel[k * 3 + 2] = 0;
      }
      this.seen[k] = 1;
      this.copyEnds(k, op);
      this.cacheVelocity(k);
    }

    for (let b = 0; b < MAX_BEAMS; b++) {
      const st = this.state[b]!;
      if (st === LIVE && this.seen[b] === 0) {
        // The operation is gone: fade out from where it was, riding with its
        // rock at the velocity cached while live, carried on to this frame.
        this.state[b] = FADING;
        const d = b * 3;
        this.drift[d] = this.vel[d]!;
        this.drift[d + 1] = this.vel[d + 1]!;
        this.drift[d + 2] = this.vel[d + 2]!;
        this.carry(b, step);
      } else if (st === FADING) {
        if (back) {
          this.free(b);
          continue;
        }
        this.fade[b] = this.fade[b]! - step / BEAM_FADE_S;
        if (this.fade[b]! <= 0) {
          this.free(b);
          continue;
        }
        this.carry(b, step);
      }
    }

    // Pebbles end on the orbit clock; a clock that ran backwards ends them all.
    let pebbles = 0;
    for (let i = 0; i < MAX_PEBBLES; i++) {
      if (this.alive[i] === 0) continue;
      const age = t - this.pebbleData[i * PS + 13]!;
      if (age < 0 || age >= this.pebbleData[i * PS + 12]!) this.alive[i] = 0;
      else pebbles++;
    }
    let beams = 0;
    for (let b = 0; b < MAX_BEAMS; b++) if (this.state[b] !== FREE) beams++;
    this.beams.count = beams;
    this.glows.count = beams;
    this.pebbles.count = pebbles;
    this.beams.visible = beams > 0;
    this.glows.visible = beams > 0;
    this.pebbles.visible = pebbles > 0;
    this.root.visible = beams > 0 || pebbles > 0;
  }

  /** After every camera writer: instances relative to the camera, root at the camera. */
  lateUpdate(_dt: number, ctx: EngineContext): void {
    if (this.disposed || !this.root.visible) return;
    ctx.camera.getWorldPosition(this.cam);
    this.root.position.copy(this.cam);
    const off = ctx.origin.offset;
    this.write(this.orbitNow(), off.x + this.cam.x, off.y + this.cam.y, off.z + this.cam.z, ctx);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offBite();
    this.dropAll();
    this.root.removeFromParent();
    for (const mesh of [this.beams, this.glows, this.pebbles]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.beamMaterial.dispose();
    this.glowMaterial.dispose();
    this.pebbleMaterial.dispose();
  }

  /**
   * REVIEW ONLY (`registerMiningBeamShots`): one beam from `source` to
   * `impact` (camera-relative km, world axes), full on, with puffs thrown
   * `ages` seconds ago, through the same slots and writers the game uses. The
   * module sleeps in review mode, so nothing else writes these meshes while a
   * shot holds them. `null` clears the stage.
   */
  stageForReview(
    beam: {
      readonly source: { readonly x: number; readonly y: number; readonly z: number };
      readonly impact: { readonly x: number; readonly y: number; readonly z: number };
      readonly ages: readonly number[];
      readonly sun: { readonly x: number; readonly y: number; readonly z: number };
      readonly light: number;
    } | null,
    ctx: EngineContext,
  ): void {
    this.dropAll();
    if (!beam) return;
    this.drift.fill(0);
    ctx.camera.getWorldPosition(this.cam);
    this.root.position.copy(this.cam);
    const off = ctx.origin.offset;
    const cx = off.x + this.cam.x;
    const cy = off.y + this.cam.y;
    const cz = off.z + this.cam.z;
    const t = 1_000;
    this.state[0] = LIVE;
    this.rock[0] = 'review';
    this.fade[0] = 1;
    const e = this.ends;
    e[0] = cx + beam.source.x;
    e[1] = cy + beam.source.y;
    e[2] = cz + beam.source.z;
    e[3] = cx + beam.impact.x;
    e[4] = cy + beam.impact.y;
    e[5] = cz + beam.impact.z;
    for (const age of beam.ages) this.puff(0, t - age);
    let pebbles = 0;
    for (let i = 0; i < MAX_PEBBLES; i++) pebbles += this.alive[i]!;
    this.beams.count = 1;
    this.glows.count = 1;
    this.pebbles.count = pebbles;
    this.beams.visible = true;
    this.glows.visible = true;
    this.pebbles.visible = pebbles > 0;
    this.root.visible = true;
    this.write(t, cx, cy, cz, ctx);
    const u = this.pebbleMaterial.uniforms;
    u.uSunDir!.value.set(beam.sun.x, beam.sun.y, beam.sun.z).normalize();
    u.uSunColor!.value.set(SUN_BASE[0] * beam.light, SUN_BASE[1] * beam.light, SUN_BASE[2] * beam.light);
  }

  // -------------------------------------------------------------------------

  /** A bite: puff pebbles off the impact of the operation on that rock, as it is now. */
  private readonly onBite = (e: { asteroidId: string }): void => {
    if (this.disposed) return;
    const ops = this.mining.operations;
    const n = Math.min(ops.length, MAX_BEAMS);
    let op: MiningOperation | null = null;
    for (let i = 0; i < n; i++) {
      if (ops[i]!.asteroidId === e.asteroidId) {
        op = ops[i]!;
        break;
      }
    }
    if (!op) return;
    // The beam on that rock (if it has one yet) takes the bite's endpoints and a pulse.
    let k = -1;
    for (let b = 0; b < MAX_BEAMS; b++) {
      if (this.state[b] === LIVE && this.rock[b] === e.asteroidId) {
        k = b;
        break;
      }
    }
    const t = this.orbitNow();
    const at = MAX_BEAMS; // a scratch row past the slots: the bite's own endpoints
    this.copyEnds(at, op);
    if (!this.readDrift(e.asteroidId, at) && k >= 0) {
      // The Belt has forgotten the rock (its last bite): the velocity it had while alive.
      const d = at * 3;
      const c = k * 3;
      this.drift[d] = this.vel[c]!;
      this.drift[d + 1] = this.vel[c + 1]!;
      this.drift[d + 2] = this.vel[c + 2]!;
    }
    if (k >= 0) {
      // The beam's rock was placed at the last update and the bite comes before
      // this frame's placement: carry the endpoints on to where they are now.
      this.pulseT[k] = t;
      const last = this.lastT;
      this.carry(at, t > last ? t - last : 0);
    }
    this.puff(at, t);
    const pebbles = this.countPebbles();
    this.pebbles.count = pebbles;
    this.pebbles.visible = pebbles > 0;
    if (pebbles > 0) this.root.visible = true;
  };

  /** Throw PUFF pebbles from row `row` of `ends`/`drift`, born at orbit time `t0`. */
  private puff(row: number, t0: number): void {
    const e = this.ends;
    const sx = e[row * 6]!;
    const sy = e[row * 6 + 1]!;
    const sz = e[row * 6 + 2]!;
    const ix = e[row * 6 + 3]!;
    const iy = e[row * 6 + 4]!;
    const iz = e[row * 6 + 5]!;
    // The surface normal at the nearest point is the way back to the ship.
    let nx = sx - ix;
    let ny = sy - iy;
    let nz = sz - iz;
    let d = Math.hypot(nx, ny, nz);
    if (!(d > 1e-12)) {
      nx = 0;
      ny = 1;
      nz = 0;
      d = 1;
    }
    nx /= d;
    ny /= d;
    nz /= d;
    // A tangent basis: t1 = n × up, t2 = n × t1.
    const ux = Math.abs(ny) < 0.9 ? 0 : 1;
    const uy = Math.abs(ny) < 0.9 ? 1 : 0;
    let ax = ny * 0 - nz * uy;
    let ay = nz * ux - nx * 0;
    let az = nx * uy - ny * ux;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const bx = ny * az - nz * ay;
    const by = nz * ax - nx * az;
    const bz = nx * ay - ny * ax;
    const dr = row * 3;
    const seed = (0x6d1b0000 + this.puffs++) >>> 0;
    const pd = this.pebbleData;
    for (let j = 0; j < PUFF; j++) {
      const i = this.nextPebble;
      this.nextPebble = (i + 1) % MAX_PEBBLES;
      this.alive[i] = 1;
      const o = i * PS;
      const th = PEBBLE_CONE * Math.sqrt(hash01(seed, j, 0));
      const ph = hash01(seed, j, 1) * Math.PI * 2;
      const st = Math.sin(th);
      const ct = Math.cos(th);
      const cp = Math.cos(ph);
      const sp = Math.sin(ph);
      const dx = nx * ct + (ax * cp + bx * sp) * st;
      const dy = ny * ct + (ay * cp + by * sp) * st;
      const dz = nz * ct + (az * cp + bz * sp) * st;
      const speed = PEBBLE_SPEED_MIN + PEBBLE_SPEED_SPAN * hash01(seed, j, 2);
      // Born a metre off the surface, inside the glow.
      pd[o] = ix + dx * 0.001;
      pd[o + 1] = iy + dy * 0.001;
      pd[o + 2] = iz + dz * 0.001;
      pd[o + 3] = dx * speed + this.drift[dr]!;
      pd[o + 4] = dy * speed + this.drift[dr + 1]!;
      pd[o + 5] = dz * speed + this.drift[dr + 2]!;
      const z = hash01(seed, j, 3) * 2 - 1;
      const aph = hash01(seed, j, 4) * Math.PI * 2;
      const rr = Math.sqrt(1 - z * z);
      pd[o + 6] = rr * Math.cos(aph);
      pd[o + 7] = rr * Math.sin(aph);
      pd[o + 8] = z;
      pd[o + 9] = (1.5 + 5 * hash01(seed, j, 5)) * (hash01(seed, j, 6) < 0.5 ? -1 : 1);
      pd[o + 10] = hash01(seed, j, 7) * Math.PI * 2;
      pd[o + 11] = PEBBLE_SIZE_MIN_KM + PEBBLE_SIZE_SPAN_KM * hash01(seed, j, 8) ** 2;
      pd[o + 12] = PEBBLE_LIFE_MIN_S + PEBBLE_LIFE_SPAN_S * hash01(seed, j, 9);
      pd[o + 13] = t0;
    }
  }

  /** Every beam, glow and pebble, packed from instance 0, camera-relative. */
  private write(t: number, cx: number, cy: number, cz: number, ctx: EngineContext): void {
    const pixel = (2 * Math.tan((ctx.camera.fov * Math.PI) / 360)) / Math.max(1, ctx.height || 1);
    this.beamMaterial.uniforms.uPixel!.value = pixel;
    this.beamMaterial.uniforms.uTime!.value = t % 1000;
    this.glowMaterial.uniforms.uPixel!.value = pixel;
    this.pebbleMaterial.uniforms.uPixel!.value = pixel;

    const bf = this.beamFade.array as Float32Array;
    const gf = this.glowFade.array as Float32Array;
    const e = this.ends;
    let n = 0;
    let sunX = 0;
    let sunY = 0;
    let sunZ = 0;
    for (let b = 0; b < MAX_BEAMS; b++) {
      if (this.state[b] === FREE) continue;
      const o = b * 6;
      const sx = e[o]! - cx;
      const sy = e[o + 1]! - cy;
      const sz = e[o + 2]! - cz;
      const ix = e[o + 3]! - cx;
      const iy = e[o + 4]! - cy;
      const iz = e[o + 5]! - cz;
      // Columns: x and y any perpendicular unit pair (the shader turns the
      // ribbon itself), z the beam, translation the nose.
      let zx = ix - sx;
      let zy = iy - sy;
      let zz = iz - sz;
      const len = Math.hypot(zx, zy, zz);
      const ux = len > 1e-12 ? zx / len : 0;
      const uy = len > 1e-12 ? zy / len : 0;
      const uz = len > 1e-12 ? zz / len : 1;
      if (!(len > 1e-12)) {
        zx = 0;
        zy = 0;
        zz = 1e-9;
      }
      // x = normalize(u × up), y = u × x.
      const upY = Math.abs(uy) < 0.9 ? 1 : 0;
      const upX = 1 - upY;
      let xx = uy * 0 - uz * upY;
      let xy = uz * upX - ux * 0;
      let xz = ux * upY - uy * upX;
      const xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl;
      xy /= xl;
      xz /= xl;
      const yx = uy * xz - uz * xy;
      const yy = uz * xx - ux * xz;
      const yz = ux * xy - uy * xx;
      this.m.set(xx, yx, zx, sx, xy, yy, zy, sy, xz, yz, zz, sz, 0, 0, 0, 1);
      this.beams.setMatrixAt(n, this.m);
      // The glow sits a metre off the surface, towards the nose.
      const lift = len > 0.001 ? 0.001 : 0;
      this.m.makeTranslation(ix - ux * lift, iy - uy * lift, iz - uz * lift);
      this.glows.setMatrixAt(n, this.m);
      const f = Math.max(0, Math.min(1, this.fade[b]!));
      bf[n] = f;
      const since = t - this.pulseT[b]!;
      gf[n] = f * (1 + (since >= 0 ? PULSE * Math.exp(-since / PULSE_DECAY_S) : 0));
      if (n === 0) {
        sunX = -e[o + 3]!;
        sunY = -e[o + 4]!;
        sunZ = -e[o + 5]!;
      }
      n++;
    }
    this.beams.count = n;
    this.glows.count = n;
    if (n > 0) {
      this.beamRange.count = n;
      this.beamRange16.count = n * 16;
      upload(this.beams.instanceMatrix, this.beamRange16);
      upload(this.glows.instanceMatrix, this.beamRange16);
      upload(this.beamFade, this.beamRange);
      upload(this.glowFade, this.beamRange);
    }

    const pd = this.pebbleData;
    const heat = this.pebbleHeat.array as Float32Array;
    let k = 0;
    for (let i = 0; i < MAX_PEBBLES; i++) {
      if (this.alive[i] === 0) continue;
      const o = i * PS;
      const age = Math.max(0, t - pd[o + 13]!);
      const u = Math.min(1, age / pd[o + 12]!);
      this.p.set(pd[o]! + pd[o + 3]! * age - cx, pd[o + 1]! + pd[o + 4]! * age - cy, pd[o + 2]! + pd[o + 5]! * age - cz);
      this.axis.set(pd[o + 6]!, pd[o + 7]!, pd[o + 8]!);
      this.q.setFromAxisAngle(this.axis, pd[o + 10]! + pd[o + 9]! * age);
      this.s.setScalar(pd[o + 11]! * (1 - smoothstep(0.7, 1, u)));
      this.m.compose(this.p, this.q, this.s);
      this.pebbles.setMatrixAt(k, this.m);
      heat[k] = Math.exp(-age / PEBBLE_COOL_S);
      if (n === 0 && k === 0) {
        sunX = -pd[o]!;
        sunY = -pd[o + 1]!;
        sunZ = -pd[o + 2]!;
      }
      k++;
    }
    this.pebbles.count = k;
    if (k > 0) {
      this.pebbleRange.count = k;
      this.pebbleRange16.count = k * 16;
      upload(this.pebbles.instanceMatrix, this.pebbleRange16);
      upload(this.pebbleHeat, this.pebbleRange);
      // The star is at the world origin: the key light at the work.
      const d = Math.hypot(sunX, sunY, sunZ);
      if (d > 0) {
        const u = this.pebbleMaterial.uniforms;
        u.uSunDir!.value.set(sunX / d, sunY / d, sunZ / d);
        const level = keyLightAt(this.universe.system?.stars[0]?.luminosity ?? 1, d);
        u.uSunColor!.value.set(SUN_BASE[0] * level, SUN_BASE[1] * level, SUN_BASE[2] * level);
      }
    }
  }

  /** Copy an operation's endpoints into row `row` of `ends` (never keep the object). */
  private copyEnds(row: number, op: MiningOperation): void {
    const e = this.ends;
    const o = row * 6;
    e[o] = op.source.x;
    e[o + 1] = op.source.y;
    e[o + 2] = op.source.z;
    e[o + 3] = op.impact.x;
    e[o + 4] = op.impact.y;
    e[o + 5] = op.impact.z;
  }

  /** Move both endpoints of row `row` of `ends` by its `drift` times `dt` seconds. */
  private carry(row: number, dt: number): void {
    if (!(dt > 0)) return;
    const e = row * 6;
    const d = row * 3;
    for (let j = 0; j < 3; j++) {
      this.ends[e + j] = this.ends[e + j]! + this.drift[d + j]! * dt;
      this.ends[e + 3 + j] = this.ends[e + 3 + j]! + this.drift[d + j]! * dt;
    }
  }

  /** A live beam's rock velocity, cached in its slot; an unknown rock keeps the last known one. */
  private cacheVelocity(b: number): void {
    if (!this.belt || !this.rock[b]) return;
    const ok = this.belt.asteroidVelocity(this.rock[b]!, this.v) === true;
    if (!ok || !Number.isFinite(this.v.x) || !Number.isFinite(this.v.y) || !Number.isFinite(this.v.z)) return;
    const c = b * 3;
    this.vel[c] = this.v.x;
    this.vel[c + 1] = this.v.y;
    this.vel[c + 2] = this.v.z;
  }

  /** The rock's velocity into row `row` of `drift`; zero without a Belt or a known rock. */
  private readDrift(id: string, row: number): boolean {
    const d = row * 3;
    const ok = this.belt?.asteroidVelocity(id, this.v) === true;
    const fine = ok && Number.isFinite(this.v.x) && Number.isFinite(this.v.y) && Number.isFinite(this.v.z);
    this.drift[d] = fine ? this.v.x : 0;
    this.drift[d + 1] = fine ? this.v.y : 0;
    this.drift[d + 2] = fine ? this.v.z : 0;
    return fine;
  }

  /** A free slot, or else the faintest fading one; -1 when all are live. */
  private claimSlot(): number {
    let faint = -1;
    for (let b = 0; b < MAX_BEAMS; b++) {
      if (this.state[b] === FREE) return b;
      if (this.state[b] === FADING && (faint < 0 || this.fade[b]! < this.fade[faint]!)) faint = b;
    }
    return faint;
  }

  private free(b: number): void {
    this.state[b] = FREE;
    this.rock[b] = null;
    this.fade[b] = 0;
  }

  private countPebbles(): number {
    let n = 0;
    for (let i = 0; i < MAX_PEBBLES; i++) n += this.alive[i]!;
    return n;
  }

  /** Nothing drawn, nothing remembered: another system, another mode, disposal. */
  private dropAll(): void {
    for (let b = 0; b < MAX_BEAMS; b++) this.free(b);
    this.alive.fill(0);
    this.beams.count = 0;
    this.glows.count = 0;
    this.pebbles.count = 0;
    this.beams.visible = false;
    this.glows.visible = false;
    this.pebbles.visible = false;
    this.root.visible = false;
  }

  /**
   * The three programs, compiled once before the first beam (all three are
   * hidden until then, so the engine's prewarm never sees them): `compile`
   * walks hidden descendants too. A missing renderer (tests) is tolerated; a
   * failure only means the first beam compiles lazily.
   */
  private warm(ctx: EngineContext): void {
    this.warmed = true;
    const r = ctx.renderer as Partial<Pick<EngineContext['renderer'], 'compile' | 'compileAsync'>> | undefined;
    try {
      if (typeof r?.compileAsync === 'function') {
        r.compileAsync(this.root, ctx.camera, ctx.scene).catch(() => {});
      } else if (typeof r?.compile === 'function') {
        r.compile(this.root, ctx.camera, ctx.scene);
      }
    } catch {
      /* compiles lazily at the first beam */
    }
  }

  private orbitNow(): number {
    const t = this.universe.orbitSeconds;
    return Number.isFinite(t) ? t : 0;
  }
}

// ---------------------------------------------------------------------------
// Review shot (plan 5, Task 6): the ship mining a rock worn to 40 %. Every
// module involved sleeps in review mode, so the shot stages the rock through
// `Asteroids.stageForReview`, the beam through `MiningBeams.stageForReview`,
// and places the hull itself; nothing else writes them meanwhile.
// ---------------------------------------------------------------------------

/** What the shot needs of the hull. `Ship` satisfies it. */
export interface MiningBeamReviewShip {
  readonly object3d: { position: Vector3; quaternion: Quaternion; updateMatrixWorld(force?: boolean): void };
  readonly sunDirection: Vector3;
  readonly sunColor: { setRGB(r: number, g: number, b: number): unknown };
  readonly fillColor: { setRGB(r: number, g: number, b: number): unknown };
  update(dt: number, ctx: EngineContext, state: ShipState): void;
}

let shotsRegistered = false;

/** Camera render position: away from every other shot's fixture. */
const SHOT_CAM = new Vector3(-4_000, 0, 0);
/** Camera-relative, km, world axes; the camera looks down −z. */
const SHOT_SHIP = new Vector3(0.016, -0.013, -0.075);
const SHOT_ROCK = new Vector3(-0.2, 0.07, -1.05);
const SHOT_ROCK_RADIUS_KM = 0.3;
const SHOT_SUN = new Vector3(-0.72, 0.42, 0.55).normalize();
const SHOT_COMPOSITION: Readonly<Record<Resource, number>> = { ice: 1.2e7, metal: 4e6, silicate: 4.4e7, rare: 0 };
/** Three puffs in the air: just thrown, mid-flight, nearly gone. */
const SHOT_PUFFS: readonly number[] = [0.12, 0.85, 1.6];

export function registerMiningBeamShots(
  beams: MiningBeams,
  rocks: { stageForReview(rock: AsteroidReviewRock | null, ctx: EngineContext): void },
  ship: MiningBeamReviewShip | null,
): void {
  if (shotsRegistered) return;
  shotsRegistered = true;
  const light = keyLightAt(1, 2.6 * AU);
  const coast: ShipState = { throttle: 0, boost: 0, heating: 0, rcs: new Vector3() };
  const toRock = new Vector3();
  const impact = new Vector3();
  const source = new Vector3();
  const forward = new Vector3(0, 0, -1);

  registerShot({
    name: 'mining-beam',
    description:
      'The ship mining a rock worn to 40 %: a thin, steady warm white-amber beam from the nose to the surface, ' +
      'a soft glow where it lands, and three puffs of pebbles (just thrown, mid-flight, nearly cooled). ' +
      'Sober, not a laser show; never cyan.',
    apply(ctx) {
      ctx.camera.fov = 40;
      ctx.camera.updateProjectionMatrix();
      ctx.camera.position.copy(SHOT_CAM);
      ctx.camera.quaternion.identity();
      ctx.camera.updateMatrixWorld(true);
      // The point on the rock nearest the ship, and the nose towards it.
      toRock.copy(SHOT_SHIP).sub(SHOT_ROCK).normalize();
      impact.copy(SHOT_ROCK).addScaledVector(toRock, SHOT_ROCK_RADIUS_KM);
      const dir = toRock.clone().negate();
      source.copy(SHOT_SHIP).addScaledVector(dir, 0.005);
      rocks.stageForReview(
        {
          seed: 0x51d3a,
          radiusKm: SHOT_ROCK_RADIUS_KM,
          composition: SHOT_COMPOSITION,
          wear: 0.4,
          at: SHOT_ROCK,
          t: 1_000,
          breakupAge: null,
          sun: SHOT_SUN,
          light,
        },
        ctx,
      );
      beams.stageForReview({ source, impact, ages: SHOT_PUFFS, sun: SHOT_SUN, light }, ctx);
      if (ship) {
        ship.object3d.position.copy(SHOT_CAM).add(SHOT_SHIP);
        ship.object3d.quaternion.setFromUnitVectors(forward, dir);
        ship.object3d.updateMatrixWorld(true);
        ship.sunDirection.copy(SHOT_SUN);
        ship.sunColor.setRGB(1.0 * 2.2, 0.94 * 2.2, 0.86 * 2.2);
        ship.fillColor.setRGB(0.012, 0.015, 0.024);
        for (let i = 0; i < 12; i++) ship.update(0.25, ctx, coast);
      }
    },
    update(dt, ctx) {
      ship?.update(dt, ctx, coast);
    },
    teardown(ctx) {
      rocks.stageForReview(null, ctx);
      beams.stageForReview(null, ctx);
    },
  });
}

function instanced(g: BufferGeometry, mat: ShaderMaterial, count: number, name: string): InstancedMesh {
  const mesh = new InstancedMesh(g, mat, count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.name = name;
  // Instances move every frame; a bounding sphere would always be stale.
  mesh.frustumCulled = false;
  // After the rocks and the hull: additive light over what it lands on.
  mesh.renderOrder = 6;
  return mesh;
}

/** A per-instance float attribute of `count` items, dynamic, added to `g`. */
function dynamicAttr(g: BufferGeometry, name: string, count: number): InstancedBufferAttribute {
  const a = new InstancedBufferAttribute(new Float32Array(count), 1);
  a.setUsage(DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

/** Flag `attr` for upload of exactly `range`. */
function upload(attr: { updateRanges: Array<{ start: number; count: number }>; needsUpdate: boolean }, range: { start: number; count: number }): void {
  attr.updateRanges.length = 0;
  attr.updateRanges.push(range);
  attr.needsUpdate = true;
}

/** 32-bit integer hash → [0, 1). */
function hash01(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(b + 0x2545f491, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}
