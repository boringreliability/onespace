/**
 * Warp — the FTL transition between star systems.
 *
 * This is the game's punctuation mark. It happens hundreds of times, so it has
 * to be short (5.9 s of sequence, ~1.5 s of exposure tail) and it has to be
 * beautiful every single time. Four beats:
 *
 *   CHARGE   2.0 s  frame darkens, a distortion ring forms ahead, sub-bass
 *                   builds, the camera pulls back. Abortable.
 *   FLASH    0.4 s  a hard, short white spike with a violent chromatic split
 *                   that resolves inside 200 ms.
 *   TUNNEL   2.5 s  a dark corridor of filamentary energy — *not* a blue
 *                   star-streak tube — lit from far ahead by the destination.
 *   ARRIVE   1.0 s  deceleration, the corridor collapses forward into the
 *                   destination star, then a 1.5 s iris as exposure recovers.
 *
 * DETERMINISM
 * Every visible value is a pure function of one scalar: `t`, seconds since
 * `engage()`. Nothing is integrated frame to frame. That is what lets the
 * screenshot harness call `setPhaseTime('tunnel', 0.5)` and get a byte-identical
 * frame on any machine, at any framerate, with any settle window. It is also
 * why the motion never snaps: the curves themselves are smooth, so no damping
 * filter (and no hidden state) is needed to make it feel heavy.
 *
 * Warp deliberately does not touch the camera or the flight model — those are
 * owned by CameraRig and FlightModel. It publishes what it wants from them on
 * `outputs` and lets them apply it with their own damping.
 */

import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { registerShaderChunks } from '@/shaders/chunks';
import { registerShot } from '@/game/Shots';
import type { Vec3 } from '@/gen/types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type WarpPhase = 'idle' | 'charging' | 'tunnel' | 'arriving';

export interface WarpTarget {
  readonly name: string;
  /** Galaxy-local position of the destination, light years. */
  readonly positionLy: Vec3;
}

/**
 * PostFX is optional at construction — Warp is reviewable and playable without
 * it, it just loses the exposure punch. Every member is optional so the
 * integrator can hand over a partially-built pipeline.
 */
export interface WarpHooks {
  /** Blow the exposure out for `duration` seconds. `intensity` is in stops. */
  flash?(intensity: number, duration: number): void;
  /** Persistent exposure offset in stops, pushed every frame. */
  setExposureBias?(stops: number): void;
  /** Optional: 0..1 override of the grade's chromatic aberration. */
  setChromaticAberration?(amount: number): void;
}

/**
 * What Warp wants from the rest of the ship this frame. Read it, damp it with
 * your own filter, apply it. The object is reused every frame — copy the
 * numbers, never retain the reference.
 */
export interface WarpOutputs {
  /** Extra chase-camera distance in km. Negative = thrown forward (arrival). */
  readonly pullbackKm: number;
  /** 0..1 camera shake amplitude. Peaks on the flash and on arrival. */
  readonly shake: number;
  /** 1 while the pilot has authority, 0 while the drive owns the ship. */
  readonly control: number;
  /** Exposure bias in stops, mirrored to `hooks.setExposureBias`. */
  readonly exposureBias: number;
}

/** Thrown from the promise returned by `engage()` when the pilot aborts. */
export class WarpAbortedError extends Error {
  constructor() {
    super('warp aborted');
    this.name = 'WarpAbortedError';
  }
}

// ---------------------------------------------------------------------------
// Timeline. One scalar drives everything; these are its landmarks.
// ---------------------------------------------------------------------------

const T_CHARGE = 2.0;
const T_FLASH = 0.4;
const T_TUNNEL = 2.5;
const T_ARRIVE = 1.0;
/** Exposure iris. Runs past the end of the sequence; phase is 'idle' by then. */
const T_TAIL = 1.5;
/** How long the charge visuals take to unwind when the pilot aborts. */
const T_ABORT = 0.7;

const T0_TUNNEL = T_CHARGE; // 2.0 — the flash fires here
const T0_TUNNEL_BODY = T_CHARGE + T_FLASH; // 2.4
const T0_ARRIVE = T0_TUNNEL_BODY + T_TUNNEL; // 4.9 — world swap happens here
const T_END = T0_ARRIVE + T_ARRIVE; // 5.9
const T_DONE = T_END + T_TAIL; // 7.4

/** Corridor extent ahead of the camera, km. Also the shader's depth basis. */
const TUNNEL_LENGTH = 60;
/** Where the destination point-light billboard sits inside the corridor. */
const DEST_Z = -55;
/** How far ahead of the camera the charge ring forms, km. */
const RING_Z = -0.18;
const RING_SPAN = 0.2;

// ---------------------------------------------------------------------------
// Curve helpers — pure, allocation-free
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Hermite ease, the same shape as GLSL smoothstep(0,1,x). */
function ease(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function span(x: number, a: number, b: number): number {
  return ease((x - a) / (b - a));
}

function mix(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * Distance travelled along the corridor, in noise units. Closed form rather
 * than integrated so a scrubbed timeline is identical to a played one.
 */
function flowAt(t: number): number {
  if (t <= T0_TUNNEL) {
    // The drive spools: a slow creep before anything has really moved.
    const u = clamp01(t / T_CHARGE);
    return 0.4 * u * u;
  }
  if (t <= T0_ARRIVE) {
    const u = clamp01((t - T0_TUNNEL) / (T_FLASH + T_TUNNEL));
    // Exponent < 2 keeps the acceleration reading as "already enormous" rather
    // than as a car pulling away from lights.
    return 0.4 + 46 * Math.pow(u, 1.55);
  }
  const v = clamp01((t - T0_ARRIVE) / T_ARRIVE);
  // Cubic ease-out: the drive letting go, not a brake being stamped on.
  return 46.4 + 7 * (1 - Math.pow(1 - v, 3));
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const TUNNEL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <onespace_noise>

uniform float uFlow;
uniform float uLength;
uniform float uWarpAmp;

varying vec3 vLocal;

void main() {
  // The noise parameterisation uses the *undisplaced* shell so the pattern
  // stays glued to the wall while the wall itself breathes.
  vLocal = position;

  vec3 p = position;
  float ahead = -p.z;
  float d01 = clamp(ahead / uLength, 0.0, 1.0);

  vec2 radial = p.xy + vec2(1e-4);
  float rlen = length(radial);
  vec2 dir = radial / rlen;

  // Real geometric warp, so the corridor has a warped silhouette at the
  // vanishing point instead of a suspiciously perfect cone edge.
  float n = os_fbm(vec3(dir * 2.0, ahead * 0.22 - uFlow), 3, 2.1, 0.5);
  p.xy += dir * n * uWarpAmp * rlen * smoothstep(0.03, 0.35, d01);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  #include <logdepthbuf_vertex>
}
`;

const TUNNEL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uFlow;
uniform float uTime;
uniform float uLength;
uniform float uAlpha;
uniform float uEnergy;
uniform float uStreak;
uniform vec3  uAccent;

varying vec3 vLocal;

void main() {
  #include <logdepthbuf_fragment>

  float ahead = -vLocal.z;
  float d01 = clamp(ahead / uLength, 0.0, 1.0);
  float ang = atan(vLocal.y, vLocal.x);

  // Drive the noise with a point on a circle, never with the angle itself —
  // atan wraps at ±pi and a seam down the corridor would be unmissable.
  // Compressing the z term is what turns blobs into filaments.
  vec3 p = vec3(cos(ang) * 2.3, sin(ang) * 2.3, ahead * 0.30 - uFlow);
  p = os_warp(p * 0.55, 0.45) * 1.8;

  // Poor-man's motion blur: average a few taps smeared along the travel axis.
  // Cheaper and better behaved than a velocity buffer for a 2.5 s effect.
  float fil = 0.0;
  for (int i = 0; i < WARP_TAPS; i++) {
    vec3 q = p;
    q.z -= float(i) * uStreak * 0.55;
    fil += os_ridged(q, WARP_OCTAVES, 2.15, 0.55) * 0.5 + 0.5;
  }
  fil /= float(WARP_TAPS);
  fil = smoothstep(0.42, 0.94, fil);

  // A second, finer, harder-streaked layer stops the walls reading as one
  // uniform material.
  vec3 p2 = vec3(cos(ang) * 6.1, sin(ang) * 6.1, ahead * 0.11 - uFlow * 1.35);
  float fine = os_ridged(p2, 3, 2.4, 0.5) * 0.5 + 0.5;
  fine = smoothstep(0.55, 1.0, fine);

  float e = fil * (0.45 + 0.75 * fine) * uEnergy;

  // Lit from ahead: the destination is the only light source in here, so the
  // near walls are essentially black and the far end carries all the value.
  float lit = pow(d01, 2.2);

  vec3 steel = vec3(0.30, 0.37, 0.46);
  vec3 c = steel * e * 0.85;
  c += uAccent * pow(e, 2.6) * 2.2;          // cyan only in the hot cores
  c *= mix(0.04, 1.0, lit);
  c += uAccent * 0.10 * pow(d01, 7.0) * uEnergy;  // glow bleeding back at us

  // The mouth of the corridor, where the destination light spills onto the walls.
  float endGlow = smoothstep(0.72, 1.0, d01);
  c += uAccent * endGlow * endGlow * 1.9 * uEnergy;

  // Opaque throughout: the corridor is what hides the system we are leaving.
  // Coverage comes from alpha, darkness comes from the colour.
  gl_FragColor = vec4(os_dither(c, gl_FragCoord.xy), uAlpha);
}
`;

const BILLBOARD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DEST_FRAG = /* glsl */ `
#include <common>
#include <onespace_color>

uniform float uIntensity;
uniform float uTime;
uniform float uSpikes;
uniform vec3  uAccent;

varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);

  float core = exp(-r * 22.0);
  float halo = 1.0 / (1.0 + r * r * 38.0);
  // Anamorphic bar plus a vertical spike — a real lens, not a round dot.
  float bar   = exp(-abs(p.y) * 70.0) * exp(-abs(p.x) * 2.4);
  float spike = exp(-abs(p.x) * 110.0) * exp(-abs(p.y) * 3.2);

  // Deterministic scintillation; uTime is sequence time, never wall clock.
  float flick = 0.92 + 0.08 * sin(uTime * 23.0) * sin(uTime * 7.3);

  float i = (core * 2.6 + halo * 0.85 + (bar * 0.55 + spike * 0.3) * uSpikes) * flick;
  vec3 c = mix(uAccent, vec3(1.0), clamp(core * 2.2, 0.0, 1.0));

  gl_FragColor = vec4(os_dither(c * i * uIntensity, gl_FragCoord.xy), 1.0);
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uAmount;
uniform float uRadius;
uniform float uWidth;
uniform vec3  uAccent;

varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float ang = atan(p.y, p.x);

  // Wobbling the radius is what sells "space is bending" instead of "decal".
  float wob = os_fbm(vec3(cos(ang) * 1.6, sin(ang) * 1.6, uTime * 0.55), 3, 2.0, 0.5);
  float rr = r + wob * 0.09 * uAmount;

  float band = exp(-pow(abs(rr - uRadius) / uWidth, 1.7));
  float spokes = 0.62 + 0.38 * sin(ang * 11.0 - uTime * 2.6);
  float fill = smoothstep(uRadius, uRadius - 0.45, rr) * 0.05;

  vec3 c = uAccent * band * spokes;
  c += vec3(0.82, 0.95, 1.0) * pow(band, 5.0) * 0.9;   // white-hot filament
  c += uAccent * fill;

  gl_FragColor = vec4(os_dither(c * uAmount * 1.5, gl_FragCoord.xy), 1.0);
}
`;

const OVERLAY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Clip space directly: this quad is a grade, not an object in the world.
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

const OVERLAY_FRAG = /* glsl */ `
#include <common>
#include <onespace_color>

uniform float uVignette;
uniform float uFlash;
uniform float uSplit;
uniform float uAspect;
uniform vec3  uAccent;

varying vec2 vUv;

float burst(float r) { return exp(-r * r * 2.1); }

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
  float r = length(p);

  // Beat 1: the frame closes in. Works with or without PostFX.
  float va = uVignette * (0.12 + 0.88 * smoothstep(0.15, 1.4, r));

  // Beat 2: per-channel radial scaling gives a real chromatic split, and it
  // resolves as uSplit decays — no separate pass needed.
  float fr = burst(r * (1.0 - uSplit));
  float fg = burst(r);
  float fb = burst(r * (1.0 + uSplit));
  float peak = max(max(fr, fg), fb);
  vec3  fc = vec3(fr, fg, fb) / max(peak, 1e-4);
  float fa = clamp(uFlash * peak, 0.0, 1.0);

  // Black-over then white-over, folded into one normal-blended draw.
  float a = clamp(va + fa, 0.0, 1.0);
  vec3 c = mix(uAccent * 0.35, fc, clamp(uSplit * 0.6 + 0.55, 0.0, 1.0)) * (fa / max(a, 1e-4));

  a += (os_igNoise(gl_FragCoord.xy) - 0.5) / 255.0;  // the vignette bands otherwise
  gl_FragColor = vec4(os_dither(c, gl_FragCoord.xy), a);
}
`;

// ---------------------------------------------------------------------------

type Mode = 'idle' | 'running' | 'aborting';

export class Warp implements GameModule {
  readonly name = 'warp';

  private group = new Group();
  private tunnel!: Mesh<BufferGeometry, ShaderMaterial>;
  private dest!: Mesh<BufferGeometry, ShaderMaterial>;
  private ring!: Mesh<BufferGeometry, ShaderMaterial>;
  private overlay!: Mesh<BufferGeometry, ShaderMaterial>;
  private scene: EngineContext['scene'] | null = null;

  private mode: Mode = 'idle';
  /** Seconds since engage() (running) or since abort() (aborting). */
  private t = 0;
  /** Set by setPhaseTime: hold this frame forever so a screenshot is stable. */
  private frozen = false;

  private target: WarpTarget | null = null;
  private resolveJump: (() => void) | null = null;
  private rejectJump: ((e: unknown) => void) | null = null;

  private firedEngaged = false;
  private firedArrived = false;

  /** Captured at abort so the charge visuals unwind from wherever they were. */
  private abortVignette = 0;
  private abortRing = 0;
  private abortBias = 0;
  private abortPull = 0;

  // Preallocated: update() must not allocate.
  private readonly out = { pullbackKm: 0, shake: 0, control: 1, exposureBias: 0 };
  private readonly chargePayload = { progress: 0 };
  private readonly namePayload = { targetName: '' };
  private readonly logPayload: { text: string; tone?: 'normal' | 'warn' | 'good' } = {
    text: '',
    tone: 'normal',
  };
  private readonly camPos = new Vector3();
  private readonly camQuat = new Quaternion();

  constructor(private hooks: WarpHooks = {}) {}

  // -- lifecycle ------------------------------------------------------------

  init(ctx: EngineContext): void {
    registerShaderChunks();
    const q = ctx.quality;

    const radial = q.tier === 'low' ? 48 : q.tier === 'medium' ? 64 : 96;
    const rings = q.tier === 'low' ? 14 : q.tier === 'medium' ? 24 : 40;
    const octaves = q.tier === 'low' ? 3 : q.tier === 'medium' ? 4 : 5;
    const taps = q.tier === 'low' ? 1 : q.tier === 'medium' ? 2 : 3;

    // A cone narrowing away from the camera. The camera sits on its axis, so
    // every forward ray hits a wall or the far cap — coverage is guaranteed at
    // any aspect ratio without a full-screen blackout quad.
    const height = TUNNEL_LENGTH + 0.4;
    const tunnelGeo = new CylinderGeometry(0.06, 1.8, height, radial, rings, false);
    tunnelGeo.rotateX(-Math.PI / 2); // +Y (the narrow end) becomes -Z, i.e. ahead
    tunnelGeo.translate(0, 0, -(TUNNEL_LENGTH - 0.4) / 2);

    const tunnelMat = new ShaderMaterial({
      vertexShader: TUNNEL_VERT,
      fragmentShader: TUNNEL_FRAG,
      defines: { WARP_OCTAVES: octaves, WARP_TAPS: taps },
      uniforms: {
        uFlow: { value: 0 },
        uTime: { value: 0 },
        uLength: { value: TUNNEL_LENGTH },
        uAlpha: { value: 0 },
        uEnergy: { value: 0 },
        uStreak: { value: 0 },
        uWarpAmp: { value: 0.22 },
        uAccent: { value: new Vector3(0.16, 0.86, 1.0) },
      },
      transparent: true,
      // Depth-tested on purpose: the ship stays visible *inside* the corridor,
      // which is the only thing giving the tunnel a sense of scale.
      depthTest: true,
      depthWrite: false,
      side: BackSide, // we are inside the shell, looking at its far wall
    });
    this.tunnel = new Mesh(tunnelGeo, tunnelMat);
    this.tunnel.frustumCulled = false;
    this.tunnel.renderOrder = 2000;
    this.tunnel.visible = false;

    const destMat = new ShaderMaterial({
      vertexShader: BILLBOARD_VERT,
      fragmentShader: DEST_FRAG,
      uniforms: {
        uIntensity: { value: 0 },
        uTime: { value: 0 },
        uSpikes: { value: 1 },
        uAccent: { value: new Vector3(0.34, 0.88, 1.0) },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.dest = new Mesh(new PlaneGeometry(1, 1), destMat);
    this.dest.position.set(0, 0, DEST_Z);
    this.dest.frustumCulled = false;
    this.dest.renderOrder = 2100;
    this.dest.visible = false;

    const ringMat = new ShaderMaterial({
      vertexShader: BILLBOARD_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uRadius: { value: 0.86 },
        uWidth: { value: 0.11 },
        uAccent: { value: new Vector3(0.20, 0.78, 1.0) },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.ring = new Mesh(new PlaneGeometry(1, 1), ringMat);
    this.ring.position.set(0, 0, RING_Z);
    this.ring.scale.set(RING_SPAN, RING_SPAN, 1);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 2200;
    this.ring.visible = false;

    const overlayMat = new ShaderMaterial({
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      uniforms: {
        uVignette: { value: 0 },
        uFlash: { value: 0 },
        uSplit: { value: 0 },
        uAspect: { value: ctx.width / Math.max(1, ctx.height) },
        uAccent: { value: new Vector3(0.55, 0.86, 1.0) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.overlay = new Mesh(new PlaneGeometry(1, 1), overlayMat);
    this.overlay.frustumCulled = false;
    this.overlay.renderOrder = 2300;
    this.overlay.visible = false;

    this.group.add(this.tunnel, this.dest, this.ring, this.overlay);
    this.group.visible = false;
    this.group.matrixAutoUpdate = true;
    ctx.scene.add(this.group);
    this.scene = ctx.scene;
  }

  resize(width: number, height: number): void {
    this.overlay.material.uniforms.uAspect!.value = width / Math.max(1, height);
  }

  dispose(): void {
    // A jump in flight when the world goes away is an abort, not a hang.
    this.rejectJump?.(new WarpAbortedError());
    this.resolveJump = null;
    this.rejectJump = null;

    this.scene?.remove(this.group);
    this.scene = null;
    for (const m of [this.tunnel, this.dest, this.ring, this.overlay]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.group.clear();
  }

  // -- public API -----------------------------------------------------------

  get phase(): WarpPhase {
    if (this.mode !== 'running') return 'idle';
    if (this.t < T0_TUNNEL) return 'charging';
    if (this.t < T0_ARRIVE) return 'tunnel';
    if (this.t < T_END) return 'arriving';
    return 'idle';
  }

  /** 0..1 across the whole sequence (the exposure tail reads as 1). */
  get progress(): number {
    return this.mode === 'running' ? clamp01(this.t / T_END) : 0;
  }

  /** 0..1 within the current phase — what the HUD's charge bar wants. */
  get phaseProgress(): number {
    switch (this.phase) {
      case 'charging':
        return clamp01(this.t / T_CHARGE);
      case 'tunnel':
        return clamp01((this.t - T0_TUNNEL) / (T_FLASH + T_TUNNEL));
      case 'arriving':
        return clamp01((this.t - T0_ARRIVE) / T_ARRIVE);
      default:
        return 0;
    }
  }

  /** The destination of the jump in flight, or the last one completed. */
  get destination(): WarpTarget | null {
    return this.target;
  }

  /** Read once per frame, damp it yourself, apply it. Reused object. */
  get outputs(): WarpOutputs {
    return this.out;
  }

  /**
   * Start a jump. Resolves at the moment of arrival — which is the *start* of
   * the arrival beat, while the screen is still blown out, so the caller should
   * swap the universe immediately and let the deceleration reveal it.
   * Rejects with `WarpAbortedError` if the pilot aborts during the charge.
   */
  engage(target: WarpTarget): Promise<void> {
    if (this.mode === 'running') {
      const busy = Promise.reject(new WarpAbortedError());
      busy.catch(() => undefined);
      return busy;
    }

    this.target = target;
    this.mode = 'running';
    this.t = 0;
    this.frozen = false;
    this.firedEngaged = false;
    this.firedArrived = false;
    this.group.visible = true;
    this.apply();

    this.log(`JUMP DRIVE SPOOLING — ${target.name.toUpperCase()}`, 'warn');

    const p = new Promise<void>((resolve, reject) => {
      this.resolveJump = resolve;
      this.rejectJump = reject;
    });
    // Callers are allowed to fire and forget; abort is broadcast on the bus
    // too. Marking the promise handled here keeps an ignored abort from
    // surfacing as an unhandled rejection.
    p.catch(() => undefined);
    return p;
  }

  /** Cancel a charging jump. A no-op once the drive has fired. */
  abort(): void {
    if (this.mode !== 'running' || this.t >= T0_TUNNEL) {
      if (this.mode === 'running') this.log('JUMP COMMITTED — ABORT REFUSED', 'warn');
      return;
    }

    // Freeze the current look and unwind from there, so aborting at 90% charge
    // fades a bright ring out rather than cutting a bright ring off.
    this.abortVignette = this.overlay.material.uniforms.uVignette!.value as number;
    this.abortRing = this.ring.material.uniforms.uAmount!.value as number;
    this.abortBias = this.out.exposureBias;
    this.abortPull = this.out.pullbackKm;

    this.mode = 'aborting';
    this.t = 0;
    this.frozen = false;
    this.tunnel.visible = false;
    this.dest.visible = false;

    bus.emit('warp:aborted');
    this.log('JUMP ABORTED', 'warn');

    this.rejectJump?.(new WarpAbortedError());
    this.resolveJump = null;
    this.rejectJump = null;
  }

  /**
   * Screenshot harness hook: jump to `t01` (0..1) through `phase` and hold
   * there. Fires no events and calls no hooks — a review shot must not have
   * side effects on audio, the HUD or the universe state machine. Cleared by
   * the next `engage()`.
   */
  setPhaseTime(phase: WarpPhase, t01: number): void {
    const u = clamp01(t01);
    switch (phase) {
      case 'charging':
        this.t = u * T_CHARGE;
        break;
      case 'tunnel':
        this.t = T0_TUNNEL + u * (T_FLASH + T_TUNNEL);
        break;
      case 'arriving':
        this.t = T0_ARRIVE + u * T_ARRIVE;
        break;
      default:
        this.t = T_DONE;
        break;
    }
    this.mode = 'running';
    this.frozen = true;
    this.firedEngaged = true;
    this.firedArrived = true;
    if (!this.target) this.target = { name: 'REVIEW', positionLy: [0, 0, 0] };
    this.group.visible = true;
    this.apply();
  }

  // -- frame ----------------------------------------------------------------

  update(dt: number, _ctx: EngineContext): void {
    if (this.mode === 'idle') return;

    if (!this.frozen) {
      this.t += dt;
      if (this.mode === 'running') this.advanceBeats();
      else if (this.t >= T_ABORT) {
        this.mode = 'idle';
        this.group.visible = false;
        this.setVisible(false);
        this.resetOutputs();
        return;
      }
      if (this.mode === 'running' && this.t >= T_DONE) {
        this.mode = 'idle';
        this.group.visible = false;
        this.setVisible(false);
        this.resetOutputs();
        return;
      }
    }

    this.apply();
  }

  lateUpdate(_dt: number, ctx: EngineContext): void {
    if (this.mode === 'idle') return;
    // Glue the corridor to the camera *after* CameraRig has had its say, so the
    // walls never lag behind a shaking camera by a frame.
    ctx.camera.getWorldPosition(this.camPos);
    ctx.camera.getWorldQuaternion(this.camQuat);
    this.group.position.copy(this.camPos);
    this.group.quaternion.copy(this.camQuat);
  }

  // -- internals ------------------------------------------------------------

  private setVisible(v: boolean): void {
    this.tunnel.visible = v;
    this.dest.visible = v;
    this.ring.visible = v;
    this.overlay.visible = v;
  }

  private resetOutputs(): void {
    this.out.pullbackKm = 0;
    this.out.shake = 0;
    this.out.control = 1;
    this.out.exposureBias = 0;
    this.hooks.setExposureBias?.(0);
    this.hooks.setChromaticAberration?.(0);
  }

  /** One-shot beats. Flags rather than edge detection: `t` only ever grows. */
  private advanceBeats(): void {
    const t = this.t;

    if (!this.firedEngaged && t >= T0_TUNNEL) {
      this.firedEngaged = true;
      this.namePayload.targetName = this.target?.name ?? '';
      bus.emit('warp:engaged', this.namePayload);
      // Short and violent. PostFX owns the actual exposure curve; we only say
      // how hard and for how long.
      this.hooks.flash?.(2.8, 0.32);
      this.log('WARP', 'good');
    }

    if (!this.firedArrived && t >= T0_ARRIVE) {
      this.firedArrived = true;
      this.namePayload.targetName = this.target?.name ?? '';
      // Fired while the corridor is still opaque: the integrator swaps the
      // universe here and the collapse reveals it.
      bus.emit('warp:arrived', this.namePayload);
      this.hooks.flash?.(3.4, 0.5);
      this.log(`ARRIVED — ${(this.target?.name ?? '').toUpperCase()}`, 'good');
      this.resolveJump?.();
      this.resolveJump = null;
      this.rejectJump = null;
    }

    if (t < T0_TUNNEL) {
      this.chargePayload.progress = clamp01(t / T_CHARGE);
      bus.emit('warp:charging', this.chargePayload);
    }
  }

  /**
   * The whole look, as a pure function of `t`. Every uniform is written every
   * frame — there is no incremental state to get out of sync with a scrub.
   */
  private apply(): void {
    const t = this.t;

    let vignette: number;
    let flash: number;
    let split: number;
    let bias: number;
    let pull: number;
    let shake: number;
    let control: number;

    let tunnelAlpha = 0;
    let tunnelEnergy = 0;
    let streak = 0;
    let collapse = 0;
    let ringAmount = 0;
    let ringRadius = 0.86;
    let ringWidth = 0.11;
    let destIntensity = 0;
    let destSize = 0.6;
    let destSpikes = 0;

    if (this.mode === 'aborting') {
      // Everything unwinds together from wherever the abort caught it.
      const k = 1 - ease(t / T_ABORT);
      vignette = this.abortVignette * k;
      ringAmount = this.abortRing * k;
      ringRadius = 0.86;
      bias = this.abortBias * k;
      pull = this.abortPull * k;
      flash = 0;
      split = 0;
      shake = 0.25 * k * k;
      control = 1 - 0.4 * k;
    } else if (t < T0_TUNNEL) {
      // ---- Beat 1: CHARGE -------------------------------------------------
      const u = clamp01(t / T_CHARGE);
      // ^1.9 keeps the first second almost calm; the dread arrives late.
      const build = Math.pow(u, 1.9);
      vignette = 0.88 * build;
      flash = 0;
      split = 0.06 * build;
      bias = -1.0 * build;
      pull = 0.06 * ease(u * 1.15);
      shake = 0.10 * build;
      control = 1 - 0.85 * ease(span(u, 0.6, 1.0));

      ringAmount = ease(span(u, 0.26, 0.98));
      ringRadius = mix(0.9, 0.44, ease(span(u, 0.3, 1.0)));
      ringWidth = mix(0.16, 0.045, build);
    } else if (t < T0_ARRIVE) {
      // ---- Beat 2 & 3: FLASH, then TUNNEL ---------------------------------
      const x = t - T0_TUNNEL;
      const body = clamp01((t - T0_TUNNEL_BODY) / T_TUNNEL);

      // 40 ms up, ~250 ms down. Anything longer reads as a fade, not a strike.
      flash = ease(x / 0.04) * Math.exp(-Math.max(0, x - 0.04) * 9.5);
      // e^-15x is ~5% at 200 ms: the split resolves inside the brief's budget.
      split = 0.62 * Math.exp(-x * 15) + 0.05;
      vignette = mix(0.88, 0.34, ease(x / 0.35));

      bias = mix(2.4, -0.4, ease(x / 0.3));
      pull = mix(0.06, 0.02, ease(x / 0.6));
      shake = 0.95 * Math.exp(-x * 4.2) + 0.13;
      control = 0;

      tunnelAlpha = ease(x / 0.11);
      tunnelEnergy = mix(0.45, 1.15, ease(body * 1.4));
      streak = mix(0.25, 1.0, ease(body * 1.2));

      destSize = mix(0.55, 4.2, Math.pow(body, 2.3));
      destIntensity = mix(0.5, 2.6, ease(body));
      destSpikes = ease(body * 1.5);
    } else if (t < T_DONE) {
      // ---- Beat 4: ARRIVAL and the iris -----------------------------------
      const v = clamp01((t - T0_ARRIVE) / T_ARRIVE);
      const tail = clamp01((t - T_END) / T_TAIL);

      collapse = ease(span(v, 0.12, 0.96));
      tunnelAlpha = 1 - ease(span(v, 0.42, 0.95));
      tunnelEnergy = mix(1.15, 2.2, ease(v * 1.6)) * (1 - ease(span(v, 0.5, 1.0)));
      streak = 1 - ease(v); // deceleration: the smear shortens

      destSize = mix(4.2, 150, Math.pow(v, 2.6));
      destIntensity = mix(2.6, 9.0, ease(v * 1.3)) * (1 - ease(span(tail, 0.0, 0.45)));
      destSpikes = 1;

      // The blowout, then the iris closing over 1.5 s.
      const white = ease(span(v, 0.3, 0.8)) * 0.95;
      flash = t < T_END ? white : 0.95 * Math.pow(1 - tail, 1.7);
      split = 0.28 * ease(span(v, 0.45, 0.9)) * (1 - ease(tail));
      vignette = 0.34 * (1 - ease(v));

      const blown = t < T_END ? mix(-0.4, 2.8, ease(span(v, 0.25, 0.85))) : 2.8;
      bias = t < T_END ? blown : 2.8 * Math.pow(1 - tail, 1.6);

      // Weight: a damped oscillation, not a step. The ship is thrown forward as
      // the drive lets go and settles back over about a second.
      const x = t - T0_ARRIVE;
      pull = -0.05 * Math.exp(-x * 2.9) * Math.cos(x * 8.6) + 0.02 * Math.exp(-x * 2.0);
      shake = 0.75 * Math.exp(-Math.max(0, x - 0.1) * 3.4) * ease(v * 6);
      control = ease(span(tail, 0.1, 0.7));
    } else {
      vignette = 0;
      flash = 0;
      split = 0;
      bias = 0;
      pull = 0;
      shake = 0;
      control = 1;
    }

    const flow = this.mode === 'aborting' ? 0 : flowAt(t);

    // The corridor shader is the expensive one and it covers the whole frame.
    // Skipping the draw entirely during the two-second charge is free frames.
    this.tunnel.visible = tunnelAlpha > 0.002;
    this.dest.visible = destIntensity > 0.002;
    this.ring.visible = ringAmount > 0.002;
    this.overlay.visible = vignette > 0.002 || flash > 0.002;

    const tu = this.tunnel.material.uniforms;
    tu.uFlow!.value = flow;
    tu.uTime!.value = t;
    tu.uAlpha!.value = tunnelAlpha;
    tu.uEnergy!.value = tunnelEnergy;
    tu.uStreak!.value = streak;
    // The corridor breathes harder the faster we go, and stiffens as we slow.
    tu.uWarpAmp!.value = 0.12 + 0.22 * streak;

    const s = 1 - 0.94 * collapse;
    this.tunnel.scale.set(s, s, 1 - 0.68 * collapse);
    // A slow roll inside the corridor — the only cue that the ship is a body
    // moving through a place rather than a camera watching a screensaver.
    this.tunnel.rotation.z = 0.22 * Math.sin(t * 0.73) + t * 0.11;

    const du = this.dest.material.uniforms;
    du.uIntensity!.value = destIntensity;
    du.uTime!.value = t;
    du.uSpikes!.value = destSpikes;
    this.dest.scale.set(destSize, destSize, 1);

    const ru = this.ring.material.uniforms;
    ru.uTime!.value = t;
    ru.uAmount!.value = ringAmount;
    ru.uRadius!.value = ringRadius;
    ru.uWidth!.value = ringWidth;
    this.ring.rotation.z = t * 0.35;

    const ou = this.overlay.material.uniforms;
    ou.uVignette!.value = vignette;
    ou.uFlash!.value = flash;
    ou.uSplit!.value = split;

    this.out.pullbackKm = pull;
    this.out.shake = shake;
    this.out.control = control;
    this.out.exposureBias = bias;

    if (!this.frozen) {
      this.hooks.setExposureBias?.(bias);
      this.hooks.setChromaticAberration?.(split);
    }
  }

  private log(text: string, tone: 'normal' | 'warn' | 'good'): void {
    this.logPayload.text = text;
    this.logPayload.tone = tone;
    bus.emit('log', this.logPayload);
  }
}

// ---------------------------------------------------------------------------
// Review shots
// ---------------------------------------------------------------------------

/**
 * Three fixed points in the sequence. Each freezes the timeline, so the settle
 * window produces identical frames however many of them it renders.
 */
export function registerWarpShots(warp: Warp): void {
  const frame = (ctx: EngineContext): void => {
    ctx.camera.position.set(0, 0, 0);
    ctx.camera.rotation.set(0, 0, 0);
    ctx.camera.quaternion.identity();
  };

  registerShot({
    name: 'warp-charge',
    description:
      'Jump drive at 80% charge: frame darkened to the edges, cyan distortion ring warping ahead of the ship, exposure pulled down.',
    apply(ctx) {
      frame(ctx);
      warp.setPhaseTime('charging', 0.8);
    },
  });

  registerShot({
    name: 'warp-tunnel',
    description:
      'Mid-tunnel: a dark corridor of filamentary energy streaked along the travel axis, near-monochrome with one cyan accent, destination burning at the vanishing point.',
    apply(ctx) {
      frame(ctx);
      warp.setPhaseTime('tunnel', 0.5);
    },
  });

  registerShot({
    name: 'warp-arrival',
    description:
      'Arrival: the corridor collapsing forward into the destination star, exposure blown out just before the iris closes.',
    apply(ctx) {
      frame(ctx);
      warp.setPhaseTime('arriving', 0.45);
    },
  });
}
