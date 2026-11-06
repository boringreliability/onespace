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
  NormalBlending,
  Object3D,
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
import { WARP_TIMELINE } from '@/ship/warpTimeline';

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

// The numbers live in warpTimeline.ts so the galaxy chart's JUMP EST reads the
// same ones (GAMEPLAY F5). Aliased here to keep the sequence code readable.
const T_CHARGE = WARP_TIMELINE.charge;
const T_FLASH = WARP_TIMELINE.flash;
const T_TUNNEL = WARP_TIMELINE.tunnel;
const T_ARRIVE = WARP_TIMELINE.arrive;
/** Exposure iris. Runs past the end of the sequence; phase is 'idle' by then. */
const T_TAIL = WARP_TIMELINE.tail;
/** How long the charge visuals take to unwind when the pilot aborts. */
const T_ABORT = WARP_TIMELINE.abort;

const T0_TUNNEL = WARP_TIMELINE.tunnelAt; // 2.0 — the flash fires here
const T0_TUNNEL_BODY = WARP_TIMELINE.tunnelBodyAt; // 2.4
const T0_ARRIVE = WARP_TIMELINE.arriveAt; // 4.9 — world swap happens here
const T_END = WARP_TIMELINE.endAt; // 5.9
const T_DONE = WARP_TIMELINE.doneAt; // 7.4

/** Corridor extent ahead of the camera, km. Also the shader's depth basis. */
const TUNNEL_LENGTH = 60;
/** Where the destination point-light billboard sits inside the corridor. */
const DEST_Z = -55;
/** How far ahead of the camera the charge ring forms, km. */
const RING_Z = -0.18;
const RING_SPAN = 0.2;

/**
 * The corridor is aligned with the *ship's heading*, not with the camera's look
 * axis. A chase camera sits above and outboard of the hull and pitches down onto
 * it, so the vanishing point belongs above and to one side of frame centre —
 * never on the exact pixel the frame is symmetric about. Radians.
 */
const CORRIDOR_PITCH = 0.075;
const CORRIDOR_YAW = 0.048;

/**
 * How far off the corridor's axis the ship flies, km, against a shell radius of
 * ~1.79 km at the camera plane. Rotating the corridor alone moves the vanishing
 * point but leaves the walls perfectly symmetric *about* it; this makes one
 * flank genuinely nearer than the other. The far end shifts by 0.3 km over
 * 60 km — a third of a degree — so the vanishing point does not move with it.
 */
const CORRIDOR_OFF_X = 0.30;
const CORRIDOR_OFF_Y = -0.22;

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
uniform float uSplit;
uniform vec3  uAccent;

varying vec3 vLocal;

void main() {
  #include <logdepthbuf_fragment>

  float ahead = -vLocal.z;
  float d01 = clamp(ahead / uLength, 0.0, 1.0);
  float ang = atan(vLocal.y, vLocal.x);

  // Speed does not chop the pattern into copies, it *stretches* it. Compressing
  // the travel axis of the noise domain is what turns blobs into filaments, so
  // driving that compression with speed is the elongation itself: continuous,
  // free, and with none of the ghosting a handful of discrete taps produces.
  // Both terms are divided, so features still stream past at the travel rate —
  // they are simply longer.
  float stretch = 1.0 + uStreak * 5.0;

  // Drive the noise with a point on a circle, never with the angle itself —
  // atan wraps at ±pi and a seam down the corridor would be unmissable.
  vec3 p = vec3(cos(ang) * 2.3, sin(ang) * 2.3, (ahead * 0.30 - uFlow) / stretch);
  p = os_warp(p * 0.55, 0.45) * 1.8;

  // Poor-man's motion blur on top of the stretch, softening the leading edge.
  // A smear is the *union* of where the filament has been, never its average:
  // averaging pulls every fragment towards the noise mean and the threshold
  // below then eats the entire wall.
  float fil = 0.0;
  for (int i = 0; i < WARP_TAPS; i++) {
    vec3 q = p;
    q.z -= float(i) * uStreak * 0.28;
    float tap = os_ridged(q, WARP_OCTAVES, 2.15, 0.55) * 0.5 + 0.5;
    fil = max(fil, tap * (1.0 - 0.14 * float(i)));   // the tail fades
  }
  // Ridged noise sits around 0.31 once mapped to 0..1; a threshold starting at
  // 0.42 was above almost the whole distribution.
  fil = smoothstep(0.26, 0.72, fil);

  // A second, finer, harder-streaked layer stops the walls reading as one
  // uniform material.
  vec3 p2 = vec3(cos(ang) * 6.1, sin(ang) * 6.1,
                 (ahead * 0.11 - uFlow * 1.35) / (1.0 + uStreak * 8.0));
  float fine = os_ridged(p2, 3, 2.4, 0.5) * 0.5 + 0.5;
  fine = smoothstep(0.34, 0.86, fine);

  float e = fil * (0.45 + 0.75 * fine) * uEnergy;

  // How much of the sight line runs *through* the emissive skin. The near wall
  // is seen almost edge-on, which is a long path; staring down the corridor is
  // a short one. This is the silver lining, and it is what keeps the 96% of the
  // frame that is near wall from being black.
  float graze = pow(1.0 - d01, 1.6);
  // How much the destination — the only actual lamp in here — reaches a wall.
  float lit = pow(d01, 1.5);

  // Lateral chromatic aberration, frame edges only (§6). First order: shift the
  // filament field along the screen radius by a fraction of a pixel per channel.
  // d01 falls off outward from the vanishing point, so its screen gradient *is*
  // the radial direction — no resolution uniform and no extra noise taps.
  vec2 gd = vec2(dFdx(d01), dFdy(d01));
  vec2 sdir = -gd * inversesqrt(max(dot(gd, gd), 1e-12));
  float shift = (1.2 + 18.0 * uSplit) * graze * uStreak;
  float dl = clamp(dot(vec2(dFdx(e), dFdy(e)), sdir) * shift, -0.3, 0.3);
  vec3 ec = max(vec3(e + dl, e, e - dl), 0.0);

  vec3 steel = vec3(0.30, 0.37, 0.46);
  // The filaments are the drive's own energy: emissive, not a surface being lit.
  // Multiplying them by distance-from-the-lamp (the old mix(0.04, 1.0, lit)) was
  // the wrong model and it deleted the corridor.
  vec3 c = steel * ec * (0.30 + 0.70 * graze);
  c += steel * ec * 1.15 * lit;                            // key light from ahead
  c += uAccent * pow(ec, vec3(2.6)) * (0.55 + 1.5 * lit);  // accent in hot cores

  // Rim on the flank of every filament, so the walls have edges instead of
  // reading as flat emissive noise.
  float rim = smoothstep(0.04, 0.50, fil) * (1.0 - fil);
  c += uAccent * rim * (0.22 + 0.85 * lit) * uEnergy * 0.55;

  // Forward-scattered haze in the volume itself: filaments near the far end
  // glow through the ones in front of them and the empty corridor is not empty,
  // which is the only way a one-ended light source reads as directional.
  c += uAccent * (0.09 + 0.45 * fil) * pow(d01, 1.6) * 0.55 * uEnergy;

  // The mouth of the corridor, where the destination light spills onto the walls.
  float endGlow = smoothstep(0.58, 1.0, d01);
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
#include <onespace_noise>
#include <onespace_color>

uniform float uIntensity;
uniform float uTime;
uniform float uSpikes;
uniform vec3  uAccent;

varying vec2 vUv;

/**
 * One flare filament: thin across, long along, and aimed at an arbitrary angle.
 * Six of these at unrelated angles and widths read as a lens; two at 0 and 90
 * degrees read as a Photoshop brush.
 */
float destFlare(vec2 p, float a, float thin, float fall) {
  vec2 d = vec2(cos(a), sin(a));
  float across = abs(p.x * -d.y + p.y * d.x);
  float along  = abs(dot(p, d));
  return exp(-across * thin) * exp(-along * fall);
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);

  // Nothing may survive to the quad boundary. A light source with an edge you
  // can measure with a ruler is a decal, not light — so the whole field is
  // windowed to exactly zero inside the billboard, and every term below is
  // sized to be negligible long before the window starts to bite.
  float win = 1.0 - smoothstep(0.52, 0.98, r);
  win *= win;

  // Zero-based: the halo is exactly 0 at r = 1 instead of 1/39 of its peak,
  // which at arrival intensity was half a stop of visible teal on all four
  // straight edges of the polygon.
  float core = exp(-r * 26.0);
  float h    = 1.0 / (1.0 + r * r * 60.0);
  float halo = max(0.0, h - 1.0 / 61.0) * (61.0 / 60.0);

  // Granulation at two scales. A star blown through a real lens is not a
  // mathematical ramp, and dither cannot substitute for structure.
  float gran = 0.72 + 0.52 * os_fbm(vec3(p * 7.0, uTime * 0.30), 3, 2.2, 0.55);
  float grit = 0.85 + 0.30 * os_fbm(vec3(p * 23.0, uTime * 0.90), 2, 2.4, 0.50);

  // Deterministic scintillation; uTime is sequence time, never wall clock.
  float flick = 0.92 + 0.08 * sin(uTime * 23.0) * sin(uTime * 7.3);

  float fl = destFlare(p,  0.021, 130.0, 2.4) * 0.62   // the dominant anamorphic
           + destFlare(p,  1.634, 165.0, 3.3) * 0.31
           + destFlare(p,  0.713, 270.0, 5.1) * 0.17
           + destFlare(p,  2.242, 330.0, 6.4) * 0.12
           + destFlare(p, -0.938, 215.0, 4.3) * 0.15
           + destFlare(p, -2.507, 390.0, 7.2) * 0.09;
  fl *= uSpikes * (0.86 + 0.14 * sin(uTime * 11.0 + p.x * 3.0));

  float i = (core * 3.2 + halo * 1.05 * gran * grit + fl * 0.9) * flick * win;
  float lin = i * uIntensity;

  // White is what a filmic curve does to a blown value, not a colour to author.
  // Gating on the linear value rather than on the normalised shape keeps cyan as
  // the single accent and stops cream owning large low-intensity regions.
  vec3 c = mix(uAccent, vec3(1.0), smoothstep(2.2, 8.0, lin));

  gl_FragColor = vec4(os_dither(c * lin, gl_FragCoord.xy), 1.0);
}
`;

const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec2 vUv;

void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uAmount;
uniform float uRadius;
uniform float uWidth;
uniform vec3  uAccent;

varying vec2 vUv;

void main() {
  #include <logdepthbuf_fragment>

  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  vec2 dir = p / max(r, 1e-4);

  // The ring is not a circle. Its radius is a low-frequency function of angle,
  // so no two sides of it match and it can never read as a stamped ellipse.
  // Sampling a *circle* in the noise domain, not the angle, keeps it seamless.
  float lobe = os_fbm(vec3(dir * 1.2, uTime * 0.21), RING_OCT, 2.0, 0.55);
  float wob  = os_fbm(vec3(dir * 3.6, uTime * 0.55), RING_OCT, 2.0, 0.50);
  float rad  = uRadius * (1.0 + 0.17 * lobe * uAmount) + wob * 0.06 * uAmount;

  float band = exp(-pow(abs(r - rad) / uWidth, 1.7));

  // Azimuthal structure from noise at two frequencies. A raw sin(ang * 11) is a
  // periodic sawtooth rosette — the single loudest procedural tell there is —
  // and it is exactly what a lens-flare brush looks like.
  float e = 0.0;
  if (band > 0.0025) {
    float s1 = os_fbm(vec3(dir * 4.0, uTime * 0.40), RING_OCT, 2.1, 0.55) * 0.5 + 0.5;
    float s2 = os_ridged(vec3(dir * 17.0, uTime * 0.90), 2, 2.3, 0.50) * 0.5 + 0.5;
    e = band * clamp(0.22 + 1.15 * s1 + 0.55 * s2 * s2, 0.0, 2.4);
  }

  float lin = e * uAmount * 2.3;
  // Cyan is the accent; white is what the tone mapper does to a blown value.
  vec3 c = mix(uAccent, vec3(1.0), smoothstep(3.2, 9.0, lin)) * lin;

  // The ring bends light *away* from us. Premultiplied output: alpha subtracts
  // the background while the colour adds the ring's own emission, so the
  // starfield inside the ring is dimmed and displaced rather than shining
  // through an additive sticker completely undisturbed.
  float lens = 1.0 - smoothstep(rad - 0.55, rad, r);
  float occl = clamp((lens * 0.62 + band * 0.30) * uAmount, 0.0, 1.0);

  gl_FragColor = vec4(os_dither(c, gl_FragCoord.xy), occl);
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

float burst(float r) { return exp(-r * r * 1.15); }

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
  // A lens flooded by a point source does not go black at the edges: the
  // whiteout is a wash with a hot centre, not a blob. This is the term that
  // owns the arrival blowout, so the destination billboard does not have to
  // grow to 150 km of world-space quad to do a screen-space job.
  float fa = clamp(uFlash * (0.34 + 0.66 * peak), 0.0, 1.0);

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
  /** Corridor heading relative to the camera's look axis. Built once. */
  private readonly heading = new Quaternion()
    .setFromAxisAngle(new Vector3(1, 0, 0), CORRIDOR_PITCH)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), CORRIDOR_YAW));

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
        uSplit: { value: 0 },
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
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      defines: { RING_OCT: q.tier === 'low' ? 2 : 3 },
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uRadius: { value: 0.86 },
        uWidth: { value: 0.11 },
        uAccent: { value: new Vector3(0.20, 0.78, 1.0) },
      },
      transparent: true,
      // Premultiplied normal blending, not additive: the ring has to be able to
      // take light away as well as add it, or it can only ever be a decal over
      // an undisturbed background.
      blending: NormalBlending,
      premultipliedAlpha: true,
      // Depth-tested: the ring forms 180 m ahead of the ship, so the hull is in
      // front of it and must occlude it.
      depthTest: true,
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
    // Aligned with the ship's heading, which a chase camera looks *down at* —
    // so the vanishing point sits off the exact pixel centre of the frame and
    // the camera is off the corridor's axis, giving the walls an asymmetric
    // silhouette instead of a perfect radial gradient.
    this.group.quaternion.copy(this.camQuat).multiply(this.heading);
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

      destSize = mix(0.9, 7.0, Math.pow(body, 2.3));
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

      // Capped. Past about 30 km the billboard is a world-space quad doing a
      // screen-space job, and its boundary becomes the whiteout's silhouette.
      // `flash` in OVERLAY_FRAG is full-screen and resolution-independent and
      // owns the rest of the blowout.
      destSize = mix(7.0, 30, Math.pow(v, 2.2));
      // Raised to hold the same total flux now the quad is a fifth of the area:
      // the core has to reach a genuinely blown linear value for the tone mapper
      // to produce the white, because the white is no longer authored.
      destIntensity = mix(2.6, 14.0, ease(v * 1.3)) * (1 - ease(span(tail, 0.0, 0.45)));
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
    tu.uSplit!.value = split;
    // The corridor breathes harder the faster we go, and stiffens as we slow.
    tu.uWarpAmp!.value = 0.12 + 0.22 * streak;

    const s = 1 - 0.94 * collapse;
    this.tunnel.scale.set(s, s, 1 - 0.68 * collapse);
    // Offset shrinks with the shell so the camera keeps the same proportional
    // place inside it and never ends up outside the corridor as it collapses.
    this.tunnel.position.set(CORRIDOR_OFF_X * s, CORRIDOR_OFF_Y * s, 0);
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
    // Slow: the ring's own noise animates now, so spinning it as fast as the old
    // sawtooth needed would read as a wheel.
    this.ring.rotation.z = t * 0.13;

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
export function registerWarpShots(warp: Warp, hull?: Object3D): void {
  const frame = (ctx: EngineContext): void => {
    // The old pose parked the camera at the origin with identity rotation, which
    // is *inside* the ship: the hull never appeared, nothing occluded, and a
    // corridor with no ship in it has no size reference at all. This is the
    // chase pose — 48 m astern, 4.5 m up, 10 m to starboard, aimed above the
    // hull so the dorsal spine and one nacelle cut into the lower third.
    if (hull) {
      hull.position.set(0, 0, 0);
      hull.rotation.set(0.012, 0.05, -0.03);
      hull.visible = true;
    }
    // Set explicitly: shots run in one page load and `ship-hero` leaves the
    // camera on a 26-degree telephoto, which would reframe all three of these.
    // 62 is the game's own field of view — a warp shot has to be what the pilot
    // actually sees.
    ctx.camera.fov = 62;
    ctx.camera.updateProjectionMatrix();
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.position.set(0.0100, 0.0045, 0.0480);
    ctx.camera.lookAt(0.0005, 0.0180, -1.0);
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
