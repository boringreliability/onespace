/**
 * Planet — cube-sphere quadtree LOD, terrain material, ocean shell and gas
 * giant band flow.
 *
 * The whole body is one `Group` in planet-local kilometres. The integrator
 * places it (floating origin) and hands it a `ViewState` each frame; this file
 * never touches the scene, the camera transform or any global state beyond the
 * `EngineContext` it is given.
 *
 * ---------------------------------------------------------------------------
 * WHY A CUBE-SPHERE QUADTREE
 *
 * A UV sphere concentrates vertices at the poles and cannot be subdivided
 * locally. Six quadtrees over the faces of a cube can: every patch is a regular
 * grid, patches subdivide independently, and the *spherified cube* mapping
 * (Cousins' formula, below) spreads the vertices far more evenly than plain
 * normalisation — the corner-to-centre area ratio drops from ~1.9 to ~1.2.
 *
 * WHY SKIRTS AND NOT STITCHED INDEX BUFFERS
 *
 * Neighbouring patches at different depths leave a hairline crack where the
 * coarse edge chords under-shoot the fine edge. The two standard fixes:
 *
 *   1. Stitched index buffers — pick one of 16 pre-baked edge-degeneracy index
 *      sets per patch depending on which of its four neighbours are coarser.
 *      Zero overdraw and watertight, but it needs a neighbour lookup across
 *      face boundaries (where the quadtree's u/v axes rotate), it re-indexes
 *      whenever a *neighbour* splits, and it can only handle a one-level
 *      difference, so the tree needs an extra "balanced 2:1" invariant.
 *   2. Skirts — every patch carries a one-quad rim extruded inwards along the
 *      radius. The rim is invisible from outside (it is behind the surface) and
 *      it plugs any crack up to its own depth, regardless of the neighbour's
 *      level or which face it belongs to.
 *
 * This module uses skirts. The cost is one extra ring of vertices
 * ((n+2)^2 vs n^2, ~6% at n=65) and a little overdraw at grazing angles; the
 * gain is that split and merge are purely local operations — no neighbour
 * graph, no 2:1 balancing, no cross-face axis-rotation table. For a renderer
 * that must stream patches under a per-frame budget, "no neighbour ever
 * invalidates my index buffer" is worth far more than the 6%.
 *
 * ---------------------------------------------------------------------------
 * WHY SCREEN-SPACE ERROR AND NOT DISTANCE
 *
 * Distance-based LOD ("split when closer than k * patchSize") ignores the field
 * of view and the framebuffer resolution, so the same world looks different at
 * every aspect and every zoom, and patches pop in visibly on a big screen. Here
 * each patch carries a *geometric error* in kilometres — the size of the
 * feature its grid cannot represent — and it is projected to pixels:
 *
 *     pixels = error / distance * (viewportHeight / (2 tan(fovY/2)))
 *
 * A patch splits when that exceeds `splitThresholdPx`, which is derived from
 * the patch resolution so that a screen-filling planet costs roughly the same
 * number of draw calls at every quality tier.
 */

import {
  BufferGeometry,
  type Camera,
  Color,
  Float32BufferAttribute,
  FloatType,
  HalfFloatType,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
  type WebGLRenderer,
  FrontSide,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import type { PlanetSpec, RGB, Vec3 } from '@/gen/types';
import { hashSeed, Rng } from '@/math/rng';
import { registerShot } from '@/game/Shots';
import { registerShaderChunks } from '@/shaders/chunks';
import {
  sampleTerrain,
  terrainGlsl,
  terrainUniformValues,
  TERRAIN_UNIFORM_NAMES,
} from '@/gen/terrain';
import type { ViewState } from './ViewState';
import { MutableViewState } from './ViewState';
import {
  atlasLayout,
  bakeNormalEps,
  clipNeedsRecentre,
  gridTexel,
  selectBuilds,
  shadowClipExtents,
  SlotPool,
  tileOrigin,
  type AtlasLayout,
} from './terrainBake';

// ---------------------------------------------------------------------------
// Cube-sphere geometry
// ---------------------------------------------------------------------------

/**
 * The six cube faces. `r` and `u` are the in-face axes; the triple (r, u, n) is
 * right-handed on every face, which is what makes one shared index buffer wind
 * counter-clockwise when seen from outside on all six.
 */
const FACES: ReadonlyArray<{ n: Vec3; r: Vec3; u: Vec3 }> = [
  { n: [1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  { n: [-1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
];

/**
 * Spherified cube (Cousins). Maps the cube surface to the sphere while keeping
 * the vertex spacing near-uniform, unlike `normalize()` which bunches nearly a
 * factor of two of extra vertices into the face corners.
 */
function spherify(x: number, y: number, z: number, out: Vector3): Vector3 {
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  out.set(
    x * Math.sqrt(Math.max(0, 1 - y2 * 0.5 - z2 * 0.5 + (y2 * z2) / 3)),
    y * Math.sqrt(Math.max(0, 1 - z2 * 0.5 - x2 * 0.5 + (z2 * x2) / 3)),
    z * Math.sqrt(Math.max(0, 1 - x2 * 0.5 - y2 * 0.5 + (x2 * y2) / 3)),
  );
  return out;
}

/** Unit direction for face-parametric coordinates a, b in [0,1]. */
function faceDir(face: number, a: number, b: number, out: Vector3): Vector3 {
  const f = FACES[face]!;
  const s = a * 2 - 1;
  const t = b * 2 - 1;
  return spherify(
    f.n[0] + f.r[0] * s + f.u[0] * t,
    f.n[1] + f.r[1] * s + f.u[1] * t,
    f.n[2] + f.r[2] * s + f.u[2] * t,
    out,
  ).normalize();
}

// ---------------------------------------------------------------------------
// Quadtree node
// ---------------------------------------------------------------------------

/**
 * One quadtree node. Nodes come from a preallocated pool and are recycled on
 * merge, so a fully built tree performs no allocation in `update()`.
 */
class Patch {
  face = 0;
  level = 0;
  /** Face-parametric origin and extent, both in [0,1]. */
  a0 = 0;
  b0 = 0;
  size = 1;

  /** Unit direction through the patch centre. */
  readonly dir = new Vector3();
  /** Bounding-sphere centre, planet-local km. */
  readonly centre = new Vector3();
  boundRadius = 0;
  /** Length of one side of the patch measured on the sphere, km. */
  arcSide = 0;
  /** Size of the terrain feature this patch's grid cannot represent, km. */
  geoError = 0;
  /** Extremes of the displaced surface over the patch, km from planet centre. */
  minRadius = 0;
  maxRadius = 0;

  /** Index into the geometry pool, or -1 when this node owns no mesh. */
  slot = -1;
  built = false;
  /** Own index in the node pool — recycling must not need a linear search. */
  poolIndex = 0;

  parent: Patch | null = null;
  readonly children: Array<Patch | null> = [null, null, null, null];
  hasChildren = false;
  inUse = false;

  reset(): void {
    this.parent = null;
    this.children[0] = null;
    this.children[1] = null;
    this.children[2] = null;
    this.children[3] = null;
    this.hasChildren = false;
    this.slot = -1;
    this.built = false;
  }
}

// ---------------------------------------------------------------------------
// Surface shader
// ---------------------------------------------------------------------------

/**
 * Detail wavelengths in kilometres. These are absolute, not relative to the
 * planet radius, so a 2,000 km moon and a 12,000 km world have the same
 * physical grain — which is what makes the scale read correctly on approach.
 * Each is faded out once its wavelength approaches the size of a pixel, which
 * is both an anti-aliasing measure and the thing that keeps the shader cheap
 * when the planet is a disc in the distance.
 */
const DETAIL_GLSL = /* glsl */ `
#define OS_W0 420.0
#define OS_W1 46.0
#define OS_W2 5.5
#define OS_W3 0.62
#define OS_W4 0.075

float os_detailFade(float wavelength, float pixelKm) {
  return smoothstep(1.5, 5.0, wavelength / max(pixelKm, 1e-8));
}
`;

/**
 * The camera-centred shadow height map (see terrainBake.shadowClipExtents for
 * why a clipmap and not the patch tiles). OS_CLIP_LEVELS square levels sit
 * side by side in one float texture; level l is a gnomonic projection onto the
 * plane tangent at uClipC[l], which — unlike the spherified cube — inverts in
 * two dot products. Bilinear by hand with texelFetch: a float32 texture is not
 * filterable without OES_texture_float_linear.
 */
const CLIP_GLSL = /* glsl */ `
uniform highp sampler2D uShadowMap;
uniform vec3  uClipC[OS_CLIP_LEVELS];
uniform vec3  uClipT1[OS_CLIP_LEVELS];
uniform vec3  uClipT2[OS_CLIP_LEVELS];
uniform float uClipH[OS_CLIP_LEVELS];   // half extent km; 0 until baked
uniform float uClipN;                   // texels per level side

/** Plane coordinates in km of a unit direction, in level l. */
vec2 os_clipCoord(int l, vec3 dir) {
  vec3 c = uClipC[l];
  vec3 q = dir / max(dot(dir, c), 1e-6) - c;
  return vec2(dot(q, uClipT1[l]), dot(q, uClipT2[l])) * uRadius;
}

float os_clipHeight(int l, vec2 xy) {
  float n  = uClipN;
  vec2  x  = clamp((xy / uClipH[l] * 0.5 + 0.5) * n - 0.5, vec2(0.0), vec2(n - 1.001));
  vec2  x0 = floor(x);
  vec2  f  = x - x0;
  ivec2 i0 = ivec2(x0) + ivec2(l * int(n), 0);
  float h00 = texelFetch(uShadowMap, i0, 0).x;
  float h10 = texelFetch(uShadowMap, i0 + ivec2(1, 0), 0).x;
  float h01 = texelFetch(uShadowMap, i0 + ivec2(0, 1), 0).x;
  float h11 = texelFetch(uShadowMap, i0 + ivec2(1, 1), 0).x;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
`;

const BAKE_VERT = /* glsl */ `
void main() {
  // A 2x2 plane in clip space: one fullscreen triangle pair. The viewport and
  // scissor restrict it to the one tile being baked.
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * The bake: one fragment per grid vertex, running exactly the height and
 * normal the vertex shader used to run per frame. Every quantity on the way
 * to the direction is dyadic — a0, b0, size are k/2^level, the grid step is
 * 1/(res-1) = 1/2^m — so the face parameters are exact in float32 and a vertex
 * shared by two patches (same level or not) bakes the bit-identical direction
 * and therefore the bit-identical height. That is what keeps the seams
 * watertight without relying on the skirts.
 */
function bakeFragmentShader(terrain: string): string {
  return /* glsl */ `
precision highp float;
#include <onespace_noise>
${terrain}

uniform float uRadius;
uniform vec3  uFaceN;
uniform vec3  uFaceR;
uniform vec3  uFaceU;
uniform vec3  uBakeRect;    // a0, b0, size in face parameters
uniform vec2  uBakeOrigin;  // tile's lower-left texel in the atlas
uniform float uBakeInvN;    // 1 / (res - 1)
uniform float uBakeEps;     // normal step, km along the surface

// Cousins' spherified cube — identical to spherify() in Planet.ts.
vec3 os_spherify(vec3 p) {
  vec3 q = p * p;
  return p * sqrt(max(vec3(0.0), vec3(
    1.0 - q.y * 0.5 - q.z * 0.5 + q.y * q.z / 3.0,
    1.0 - q.z * 0.5 - q.x * 0.5 + q.z * q.x / 3.0,
    1.0 - q.x * 0.5 - q.y * 0.5 + q.x * q.y / 3.0)));
}

void main() {
  vec2 ij = floor(gl_FragCoord.xy - uBakeOrigin);
  vec2 ab = uBakeRect.xy + uBakeRect.z * (ij * uBakeInvN);
  vec2 st = ab * 2.0 - 1.0;
  vec3 d  = normalize(os_spherify(uFaceN + uFaceR * st.x + uFaceU * st.y));
  float h = os_terrainHeight(d, uTerrainSeedOffset);
  vec3  n = os_terrainNormal(d, uTerrainSeedOffset, uRadius, uBakeEps);
  gl_FragColor = vec4(h, n);
}
`;
}

/** One level of the shadow clipmap: heights on a gnomonic grid. */
function clipBakeFragmentShader(terrain: string): string {
  return /* glsl */ `
precision highp float;
#include <onespace_noise>
${terrain}

uniform float uRadius;
uniform vec3  uClipBakeC;
uniform vec3  uClipBakeT1;
uniform vec3  uClipBakeT2;
uniform float uClipBakeH;     // half extent km
uniform float uClipBakeX;     // level's first texel column
uniform float uClipN;

void main() {
  vec2 ij = floor(gl_FragCoord.xy) - vec2(uClipBakeX, 0.0);
  vec2 xy = ((ij + 0.5) / uClipN * 2.0 - 1.0) * uClipBakeH;
  vec3 d  = normalize(uClipBakeC + (uClipBakeT1 * xy.x + uClipBakeT2 * xy.y) / uRadius);
  gl_FragColor = vec4(os_terrainHeight(d, uTerrainSeedOffset), 0.0, 0.0, 1.0);
}
`;
}

// The engine runs with logarithmicDepthBuffer, which is not free: every
// ShaderMaterial has to opt in via three's logdepthbuf chunks or it writes
// LINEAR depth while the rest of the scene writes logarithmic depth, and the
// comparison between them is meaningless. The planet is the game's principal
// occluder, so getting this wrong meant rings, clouds and hulls were never
// hidden behind it — reported as "the far half of the ring does not go behind
// the planet".
function surfaceVertexShader(terrain: string): string {
  return /* glsl */ `
precision highp float;
// three's logdepthbuf_vertex chunk calls isPerspectiveMatrix(), which lives in
// its <common> chunk. Pulling all of <common> in would collide with names this
// file already defines, so declare just the one function it needs.
bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
#include <logdepthbuf_pars_vertex>

#include <onespace_noise>
${terrain}

attribute vec3 aDir;
// Integer texel of this vertex in the height atlas (skirt vertices share their
// edge neighbour's texel; see terrainBake.gridTexel).
attribute vec2 aTexel;

uniform float uRadius;
uniform vec3  uCamLocal;
// RGBA = height km, outward normal. Baked once per patch from the very same
// os_terrainHeight / os_terrainNormal this shader used to run five times per
// vertex per frame (docs/v2/PERFORMANCE.md, root cause #1).
uniform highp sampler2D uHeightAtlas;

varying vec3  vDir;
varying vec3  vNrm;
varying float vH;
varying float vDist;
varying vec3  vLocal;
varying vec3  vView;
#if OS_OCEAN == 1
varying float vDepth;
#endif

void main() {
  vec3 d = normalize(aDir);
  vec4 baked = texelFetch(uHeightAtlas, ivec2(aTexel), 0);
  float h = baked.x;

#if OS_OCEAN == 1
  // The sea is drawn in this same pass: the surface is held at sea level
  // wherever the ground is below it, and the fragment shader paints water
  // there, mixing the floor in through the shallows. The old separate shell
  // evaluated the full terrain per PIXEL for its depth and cost a second,
  // blended draw; here the depth is the baked height, interpolated across the
  // very triangle the coastline is cut from.
  vDepth = -h;
  float hs = max(h, 0.0);
#else
  float hs = h;
#endif

  // 'position' is the undisplaced sphere point relative to the patch centre;
  // skirt vertices already carry their inward offset, so one add serves both.
  vec3 p = position + d * hs;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>

  vec3 local = d * (uRadius + hs);
  vec3 toCam = uCamLocal - local;
  float dist = length(toCam);

  vDir   = d;
  vH     = h;
  vLocal = local;
  vDist  = dist;
  vView  = toCam / max(dist, 1e-6);
  vNrm   = baked.yzw;
}
`;
}

function surfaceFragmentShader(terrain: string): string {
  return /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>

#include <onespace_noise>
#include <onespace_color>
${terrain}
${DETAIL_GLSL}

uniform float uRadius;
uniform float uPixelAngle;
uniform float uTime;
uniform vec3  uCamLocal;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uAtmosTint;
// Two air strengths, because two different renderers own two different halves
// of "atmosphere" and only one of them can be present.
//
//   uAtmos      — air the SURFACE owns and nothing else can supply. The sun's
//                 reddening along the star->ground slant path, the softened
//                 terminator, the blue skylight that keeps a cast shadow from
//                 being a hole. All three are *illumination of the ground*;
//                 Atmosphere.ts integrates camera->scene radiance and never
//                 lights anything, so these have no double anywhere.
//   uAtmosOuter — air seen AT or THROUGH, from outside the ground: the limb
//                 ring, the Mie forward crescent, the sunset band, aerial
//                 perspective. Every one of these is exactly what the
//                 scattering shell marches and composites, so when a shell is
//                 attached this is set to zero by setAtmosphereShell() and the
//                 shell is the only thing drawing them. Left equal to uAtmos on
//                 a planet with no shell — a low tier that skips the shell, or
//                 the review fixtures — where the cheap path is all there is.
//
// Rendering both at once is what blew the day side of review/final/
// planet-orbit.png out to flat white: the limb ring and the haze were being
// integrated twice over the same column of air.
uniform float uAtmos;
uniform float uAtmosOuter;
uniform float uNightLights;
uniform float uRoughness;
uniform float uPolarLat;
uniform float uSnowLine;
uniform float uDetailStrength;

uniform vec3 uLow;
uniform vec3 uMid;
uniform vec3 uHigh;
uniform vec3 uPeak;
uniform vec3 uCliff;
uniform vec3 uPolar;
uniform vec3 uAccent;

varying vec3  vDir;
varying vec3  vNrm;
varying float vH;
varying float vDist;
varying vec3  vLocal;
varying vec3  vView;

#if OS_SHADOW_STEPS > 0
${CLIP_GLSL}
#endif
#if OS_OCEAN == 1
${OCEAN_GLSL}
#endif

/**
 * The fine displacement the mesh does not carry, in kilometres. Only the
 * scales that survive the pixel-footprint fade are evaluated, so this costs
 * nothing when the planet is far away.
 */
float os_microHeight(vec3 p, vec3 k) {
  // Roughness as a fraction of wavelength; 2*pi*a/W is the facet slope, so
  // these give about 7, 9 and 12 degrees. That is honest rock — scree, strata,
  // frost-shattered blockfield — and it is the only thing standing between a
  // close pass and an airbrushed dune. The previous values (0.010/0.013/0.016)
  // came out at 3.6 degrees, which is invisible under any sun angle.
  //
  // The ceiling is real though: past ~15 degrees a shading-only bump that the
  // silhouette does not back up starts reading as dirt on the lens, and under a
  // low sun it self-shadows into salt and pepper. Do not raise these further
  // without adding real displacement to match.
  // The finest scale stays low on purpose. At 75 m it is only a few pixels
  // across on a close pass, so a slope that flips N.L past the sun's elevation
  // does not read as relief — it reads as pepper, and it aliases as the camera
  // moves. The two coarse scales carry the rock; this one only breaks the edge.
  return k.x * os_snoise(p * (1.0 / OS_W2)) * (OS_W2 * 0.020)
       + k.y * os_snoise(p * (1.0 / OS_W3)) * (OS_W3 * 0.026)
       + k.z * os_snoise(p * (1.0 / OS_W4)) * (OS_W4 * 0.021);
}

/** The ground: rock, ice, sand, lights. Also the sea floor under shallows. */
vec3 os_landColor() {
  vec3  up   = normalize(vDir);
  vec3  N    = normalize(vNrm);
  vec3  V    = normalize(vView);
  vec3  P    = vLocal;
  float pxKm = vDist * uPixelAngle;

  // --- multi-scale breakup ------------------------------------------------
  float k0 = os_detailFade(OS_W0, pxKm);
  float k1 = os_detailFade(OS_W1, pxKm);
  float k2 = os_detailFade(OS_W2, pxKm);
  float k3 = os_detailFade(OS_W3, pxKm);
  float k4 = os_detailFade(OS_W4, pxKm);

  vec3 so = uTerrainSeedOffset;
  float det = k0 * os_snoise(P * (1.0 / OS_W0) + so)         * 0.55
            + k1 * os_snoise(P * (1.0 / OS_W1) + so.yzx)     * 0.34
            + k2 * os_snoise(P * (1.0 / OS_W2) + so.zxy)     * 0.22
            + k3 * os_snoise(P * (1.0 / OS_W3) + so.zyx)     * 0.14
            + k4 * os_snoise(P * (1.0 / OS_W4) + so.xzy)     * 0.09;

  // --- normal detail finer than the mesh ----------------------------------
  // Material is chosen by the *terrain's* slope, not by pebble-scale bumps:
  // blending in a dark cliff colour wherever a micro-normal tips over turns a
  // snowfield into pepper. The detail normal is for light only.
  float steep  = 1.0 - clamp(dot(N, up), 0.0, 1.0);
  // The *terrain* normal, kept before the micro-relief below tilts it. Anything
  // that picks a material or a climate has to read this one: a mask driven by
  // pebble-scale bumps is pepper, not geography.
  vec3  Ng     = N;
  float ndlGeo = dot(up, uSunDir);
  // Camera altitude decides which of the two atmosphere models below applies.
  // Outside the shell the air is a limb ring you look *at*; inside it is haze
  // you look *through*. Running both at once double-counts the same photons
  // and blows the horizon out.
  float above  = smoothstep(uRadius * 0.02, uRadius * 0.10, length(uCamLocal) - uRadius);
  // Ease the detail off only as the sun actually reaches the horizon. The old
  // floor of 0.30 threw away two thirds of the micro-relief under a nine-degree
  // sun — i.e. in precisely the raking light that exists to reveal it.
  float dstr = uDetailStrength * clamp(0.55 + ndlGeo * 2.6, 0.55, 1.0);

  vec3 kk = vec3(k2, k3, k4);
  if (kk.x + kk.y + kk.z > 0.002) {
    // Never step finer than about three quarters of the shortest wavelength in
    // os_microHeight: a central difference taken well inside its own feature
    // returns gradient noise, and that noise is what stipples a slope.
    float s = max(pxKm * 0.9, OS_W4 * 0.75);
    vec2 e = vec2(1.0, -1.0);
    vec3 g = e.xyy * os_microHeight(P + e.xyy * s, kk)
           + e.yyx * os_microHeight(P + e.yyx * s, kk)
           + e.yxy * os_microHeight(P + e.yxy * s, kk)
           + e.xxx * os_microHeight(P + e.xxx * s, kk);
    g /= (4.0 * s);
    vec3 gT = g - N * dot(g, N);
    N = normalize(N - gT * dstr);
  }

  // --- palette ------------------------------------------------------------
  float e   = clamp(vH / max(uTerrainAmplitude, 1e-4) + uTerrainSeaLevel, 0.0, 1.0);
  // A big elevation jitter is what stops the palette bands reading as contour
  // lines drawn round every basin.
  float eN  = clamp(e + det * 0.035, 0.0, 1.0);
  float lat = abs(up.y);
  float sea = uTerrainSeaLevel;

  // Close-range material breakup at 2.3 km and 340 m. Hoisted above the palette
  // because the masks below need it: every band is chosen by elevation, slope or
  // latitude, and all three are effectively constant across a low-altitude
  // frame, so a mask edge with no breakup in this band comes out as a drawn
  // contour line.
  float grit = k2 * os_snoise(P * (1.0 / (OS_W2 * 0.42)) + so.yxz) * 0.62
             + k3 * os_snoise(P * (1.0 / (OS_W3 * 0.55)) + so.xzy) * 0.38;

  vec3 alb = uLow;
  alb = mix(alb, uMid,  smoothstep(sea - 0.03, sea + 0.16, eN));
  alb = mix(alb, uHigh, smoothstep(sea + 0.12, sea + 0.38, eN));

  // Continent-scale arid regions: the one place the saturated accent is spent,
  // and ARCHITECTURE §6 rations colour hard — "never more than two saturated
  // hues on screen at once", against a desaturated steel-blue and near-black
  // base. Three gates keep this to roughly a tenth of the surface:
  //
  //   1. A narrow band of the mask field. The old window (0.42..0.78 on a
  //      zero-mean field) was open over about a third of the sphere, and since
  //      the accent is three to four times brighter than the base palette it
  //      did not read as an accent at all — it repainted the planet.
  //   2. Latitude. Arid belts are subtropical; deserts at the pole are just a
  //      brown planet with a hat on.
  //   3. Elevation, and this is the one that decides whether a *ground* shot
  //      works. Sand collects in basins and on plains; it does not climb ridge
  //      lines. Cutting it off just above the plains means a low pass over
  //      mountains gets ochre in the valley floors and bare rock on everything
  //      that catches the light — colour separation inside a single frame,
  //      instead of one wash over all of it.
  //
  // The mask itself had two faults that together are the "noise on a sphere"
  // tell. It was ONE octave of snoise, so its boundary had exactly one
  // wavelength and no structure at 200 or 40 km; and it was statistically
  // independent of the terrain beneath it, so the wash ignored every feature it
  // lay over. Climate is not independent of relief — arid ground is where the
  // moisture already fell out. So:
  //
  //   * domain-warp the field and run it fractal, and fold in det (which
  //     already carries 420 km down to 75 m) so the coast of the desert is
  //     ragged at every scale instead of being a smooth blob outline;
  //   * bias it by the rain shadow. Ng - up*dot(Ng,up) is the downhill
  //     direction of the terrain; where that turns away from the prevailing
  //     zonal wind the ground is leeward of a ridge and it is dry. That is one
  //     dot product, and it is the coupling whose absence made the two layers
  //     read as unrelated.
  //
  // The three gates are evaluated FIRST and the field is skipped when they
  // close. They are pure arithmetic on values already in hand, whereas the
  // field is a domain warp plus four octaves — seven simplex evaluations, a
  // third again on top of everything else this shader does. By its own design
  // the accent reaches about a tenth of the surface, so branching here makes
  // the new mask cheaper over most of the frame than the single-octave one it
  // replaces, and the gates vary on continental scales so the branch is
  // coherent across a warp.
  float aridGate = (1.0 - smoothstep(0.30, 0.74, lat))
                 * (1.0 - smoothstep(0.04, 0.20, steep))
                 * (1.0 - smoothstep(sea + 0.08, sea + 0.30, eN));
  if (aridGate > 0.002) {
    vec3  wp   = os_warp(P * (1.0 / 1100.0) + so.zxy, 0.6);
    float arid = os_fbm(wp, 4, 2.35, 0.55) * 0.5 + 0.5 + det * 0.10;
    // Prevailing wind is zonal (trade winds run along latitude circles), tilted
    // a little so it is not degenerate at the poles.
    vec3  windDir = normalize(cross(up, vec3(0.0, 1.0, 0.0)) + up * 0.15 + vec3(1e-5));
    vec3  slope   = Ng - up * dot(Ng, up);
    float lee     = clamp(dot(slope, windDir) * 6.0, -1.0, 1.0);
    float desert  = smoothstep(0.48, 0.82, arid + lee * 0.14);
    alb = mix(alb, uAccent, 0.58 * desert * aridGate);
  }

  // Snow / ash caps, pushed down towards the poles.
  float snowLine = mix(uSnowLine, uSnowLine - 0.18, smoothstep(0.40, 0.98, lat));
  alb = mix(alb, uPeak, smoothstep(snowLine, snowLine + 0.20, eN) * (1.0 - smoothstep(0.16, 0.42, steep)));

  // Slope is what makes cliffs read as a different material — but only if the
  // boundary is fractal. det*0.025 against a 0.23-wide window is a 10%
  // perturbation, which is a smooth contour line with a wobble on it, and from
  // orbit it reads as a hard near-binary blotch mask. The jitter has to be
  // comparable to the window, and it needs a second term an order of magnitude
  // finer (grit is 2.3 km and 340 m) or the edge is only broken at one scale.
  alb = mix(alb, uCliff, smoothstep(0.05, 0.28, steep + det * 0.12 + grit * 0.06));

  float ice = smoothstep(uPolarLat, uPolarLat + 0.15, lat + det * 0.045)
            * (1.0 - smoothstep(0.12, 0.36, steep));
  alb = mix(alb, uPolar, ice);

  // Nothing is ever a flat gradient.
  alb *= 0.80 + 0.42 * (det * 0.5 + 0.5);

  // Pushing towards the *cliff* colour rather than up and down in brightness is
  // what makes the breakup read as exposed rock and scree instead of a dirty
  // lens. Held off the ice, which pepper ruins.
  alb = mix(alb, uCliff, clamp(grit, 0.0, 1.0) * 0.30 * (1.0 - ice));
  alb *= 1.0 + grit * 0.22 * (1.0 - ice);

  // --- light --------------------------------------------------------------
  float ndl = dot(N, uSunDir);

  // Terminator: hard on an airless body, ~2 degrees of softening with an
  // atmosphere. Nothing else lifts it.
  //
  // The extra term is anti-aliasing, not art: ndl uses the full-resolution
  // terrain normal, so from orbit — where one pixel spans ten kilometres of
  // relief — a knife-edge terminator turns twenty kilometres of mountain into
  // ragged black pepper along the day/night line. Widening it by the pixel
  // footprint keeps the line hard on approach (where the term is ~1e-4) and
  // resolves it honestly from orbit.
  //
  // Its old ceiling of 0.025 was three times what anti-aliasing needs. Added to
  // the 0.038 atmospheric term it gave +/-0.063 in ndl — 3.6 degrees, a quarter
  // of the visible disc turning into a grey dithered dissolve. A dissolve is
  // not a terminator: §6 wants the shadow edge hard. The width belongs in the
  // *scattering* band below, where it is a colour rather than an absence, so
  // the geometric term is capped at +/-0.008 (half a pixel of relief) and the
  // atmospheric one trimmed to the ~1.7 degrees a real slant path buys.
  float soft  = mix(0.006, 0.030, uAtmos) + clamp(pxKm / max(uRadius, 1.0) * 25.0, 0.0, 0.008);
  float shade = smoothstep(-soft, soft, ndl) * smoothstep(-0.05, 0.02, ndlGeo);

  float shadow = 1.0;
#if OS_SHADOW_STEPS > 0
  // Short march along the sun ray. Only worth it low over the terrain with the
  // sun near the horizon — which is exactly when long shadows sell the relief.
  if (ndlGeo > 0.0 && ndlGeo < 0.72 && vDist < uRadius * 0.06) {
    // Reach far enough to catch the ridge next door, but no further: with a
    // handful of steps a long ray lands on unrelated mountains and the result
    // is pepper, not shadow. Samples are packed quadratically towards the
    // shading point, where the occluders that matter actually are.
    float travel = min(uTerrainAmplitude * 2.5 / max(ndlGeo, 0.12), uTerrainAmplitude * 3.0);
    // The heights come from the camera-centred shadow clipmap, not a fresh
    // terrain evaluation per step (PERFORMANCE.md: those were four full
    // evaluations per pixel). The whole ray reads ONE level, the finest that
    // holds both ends, and every comparison is RELATIVE to the shading point's
    // height read from that same level: a coarse level smooths valleys
    // upwards, and an absolute test would put every valley floor in its own
    // shadow. When P is exact this is the old test, (rq - rP) - (hq - hP).
    vec3  pEnd = normalize(P + uSunDir * travel);
    vec2  xyP  = vec2(0.0);
    int   lvl  = -1;
    for (int l = 0; l < OS_CLIP_LEVELS; l++) {
      if (uClipH[l] <= 0.0) continue;
      vec2 a = os_clipCoord(l, up);
      vec2 b = os_clipCoord(l, pEnd);
      vec2 m = max(abs(a), abs(b));
      if (max(m.x, m.y) < uClipH[l] * 0.9) { lvl = l; xyP = a; break; }
    }
    if (lvl >= 0) {
      float rP = length(P);
      float hP = os_clipHeight(lvl, xyP);
      for (int i = 1; i <= OS_SHADOW_STEPS; i++) {
        float f  = float(i) / float(OS_SHADOW_STEPS);
        float t  = travel * f * f;
        vec3  q  = P + uSunDir * t;
        float rq = length(q);
        float rise = os_clipHeight(lvl, os_clipCoord(lvl, q / rq)) - hP;
        shadow = min(shadow, smoothstep(0.0, uTerrainAmplitude * 0.16, (rq - rP) - rise));
      }
    }
    shadow = mix(1.0, shadow, smoothstep(uRadius * 0.06, uRadius * 0.02, vDist));
  }
#endif

  // Sunlight reddens as it grazes: the atmosphere is a long filter at the
  // terminator. This is what stops the day side looking like a flat map.
  vec3 sun = uSunColor * mix(vec3(1.0), uAtmosTint, uAtmos * (1.0 - smoothstep(0.0, 0.30, ndlGeo)));

  vec3 col = alb * sun * shade * shadow;

  // Skylight. A shadow under an atmosphere is blue, not black — without this
  // the cast shadows read as holes cut in the planet.
  col += alb * uSunColor * mix(vec3(1.0), uAtmosTint.bgr, 0.55) * 0.028 * uAtmos * shade * (1.0 - shadow);

  // Specular: wide and weak on rock, tight on ice and wet ground.
  float rough = clamp(uRoughness - ice * 0.35, 0.06, 1.0);
  vec3  H     = normalize(uSunDir + V);
  float a     = rough * rough;
  float d     = dot(N, H);
  float dd    = d * d * (a * a - 1.0) + 1.0;
  float spec  = (a * a) / (3.14159265 * dd * dd + 1e-6);
  float fres  = 0.04 + 0.96 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  // Kill the highlight as the sun sinks: a specular lobe riding on shading-only
  // micro-normals turns the terminator into tinsel.
  col += sun * shade * shadow * spec * fres * 0.35 * (1.0 - ice * 0.2)
       * smoothstep(0.0, 0.28, ndlGeo);

  // --- night side ---------------------------------------------------------
  float night = 1.0 - shade;

  // Starlight only. There is no ambient fill in space.
  col += alb * uSunColor * 0.005 * night;

  if (uNightLights > 0.0 && night > 0.02) {
    // Settlements are rare, but "rare" was being multiplied out to "never":
    // five independent masks in series, one of them squared, left the product
    // effectively zero everywhere and the night side came back dead black on a
    // world flagged as inhabited. The clustering is what sells a civilisation,
    // not the scarcity — so keep the Worley cores tight and the province mask
    // narrow, but open each gate far enough that a few provinces actually light.
    vec2  w       = os_worley(P * (1.0 / 44.0) + so);
    // Widened from 0.42..0.68. That window opened on one province of the whole
    // sphere, so a civilisation showed up as a single isolated confetti clump
    // on an otherwise dead hemisphere — which reads as stuck pixels, not as a
    // settled world. Lower and wider puts light on several coastlines.
    float region  = smoothstep(0.30, 0.62, os_snoise(P * (1.0 / 2200.0) + so.yxz) * 0.5 + 0.5);
    float coast   = 1.0 - smoothstep(0.0, 0.085, abs(e - sea - 0.03));
    float flat_   = 1.0 - smoothstep(0.03, 0.14, steep);
    // Cores plus sprawl. The squared point term alone is a single-pixel dot on
    // absolute black: nothing for the bloom pass to find (bloom needs area, not
    // amplitude) and no geography. The second, much wider and much dimmer term
    // on the same Worley cell is the suburban skirt around each core, and it is
    // what makes the cluster read as lit ground seen from orbit.
    float pts     = smoothstep(0.24, 0.02, w.x);
    float halo    = smoothstep(0.62, 0.10, w.x) * 0.22;
    float lights  = (pts * pts + halo) * region * flat_ * mix(0.16, 1.0, coast) * step(sea, e);
    // Well above 1.0 on purpose: this is the one emitter on the night side and
    // it is what the bloom pass is for. Amber, per the §6 palette.
    col += vec3(1.0, 0.55, 0.18) * lights * uNightLights * night * 6.0;
  }

  // --- the air, seen from outside ------------------------------------------
  // THIS BLOCK AND THE AERIAL PERSPECTIVE BELOW ARE THE CHEAP STAND-IN FOR
  // Atmosphere.ts, AND THEY RUN ONLY WHEN NO SHELL IS ATTACHED. See uAtmosOuter
  // at the top of this shader. The branch is coherent across the whole draw —
  // uAtmosOuter is a per-planet constant — so on a world that does carry a
  // scattering shell this is not merely neutralised arithmetic, it is skipped.
  if (uAtmosOuter > 0.002) {
    // The limb ring: the silver lining that tells the frame where the star is.
    //
    // This existed before at exponent 3.5 and strength 0.11, which is why the
    // last review found "a razor-hard 1px edge against black with zero
    // atmosphere glow" on every limb in the set. Both numbers were wrong for a
    // physical reason. A shell one seven-hundredth of the planet's radius deep
    // presents a slant path ~sqrt(2R/H) ~ 40x its own depth at grazing
    // incidence, so it is a *ring* tens of pixels wide, not a line; pow(.,2.0)
    // puts half the term inside the outer 10% of the disc radius, which is
    // where that path actually is. And a ring that scatters a tenth of the key
    // light is invisible next to ground lit by all of it — 0.5 puts the sunward
    // edge just over 1.0, i.e. in the bloom, which is what "light has presence"
    // means in §6.
    float grz  = 1.0 - clamp(dot(up, V), 0.0, 1.0);
    float limb = grz * grz;
    // Blue looking down through it, sodium-orange along the terminator: the
    // same slant-path filter as sun, seen edge-on.
    vec3  air  = mix(uAtmosTint.bgr, uAtmosTint, smoothstep(0.35, -0.05, ndlGeo));
    col += air * uSunColor * limb * uAtmosOuter * 0.50 * above * smoothstep(-0.30, 0.45, ndlGeo);

    // Mie forward lobe. When the star is behind the body from the camera's
    // point of view the whole sunward limb lights up in a hard, bright crescent
    // — the one lens-flare-grade highlight this module can honestly produce.
    // Separate from the ring above because it is a *phase function*, not a path
    // length.
    float fwd = max(dot(-V, uSunDir), 0.0);
    fwd = fwd * fwd; fwd = fwd * fwd; fwd = fwd * fwd;   // ^8, no pow() call
    col += uSunColor * uAtmosTint * limb * uAtmosOuter * fwd * above * 1.60;

    // Sunset band. This is where the terminator width went. A planet with
    // enough air to soften the shadow edge has, by exactly the same optical
    // depth, a band of reddened forward scattering a few degrees wide along
    // that edge — so the softness reads as a sodium-orange ring (one of §6's
    // two rationed hues) instead of grey mush. Driven by the geometric ndl so
    // surface relief cannot stipple it.
    //
    // The terminator SOFTENING itself stays outside this branch (see 'soft'):
    // that is the ground's own shading, which the shell never touches. Only the
    // glow that stands in front of it is the shell's to draw.
    col += uAtmosTint * uSunColor * uAtmosOuter * 0.55 * mix(0.25, 1.0, above)
         * exp(-(ndlGeo / 0.055) * (ndlGeo / 0.055))
         * (0.35 + 0.65 * limb);
  }

  // --- aerial perspective -------------------------------------------------
  // The cheap stand-in for the shell's extinction + inscatter composite, and it
  // is gated the same way. Without a shell there is no other depth cue at all:
  // a low pass renders a ridge 300 km away at exactly the contrast of one 3 km
  // away, and the frame reads as a flat matte painting. With one, this is the
  // same photons a second time — the shell clips every view ray to the analytic
  // planet sphere whether or not it has been handed a depth texture, so it
  // already carries the horizon-distance gradient this term exists to fake.
  //
  // Scale: Rayleigh at ~0.013/km times the ~6% relative density found 24 km up
  // is about 8e-4 per km. The coefficient here lands near 1.2e-3 — deliberately
  // above that, because a line of sight to the horizon does not stay at the
  // camera's altitude, it dives through steadily denser air the whole way.
  // Tying the rate to 1/uRadius instead of a constant holds the same *visual*
  // depth on a 2000 km moon and a 12000 km world, whose horizons sit at very
  // different ranges. It also buys the frame its second hue: cool haze in front
  // of warm rock is exactly the two-colour contrast §6 asks for.
  //
  // It is also fenced against the LIMB terms above by 'above', which this file
  // computes for that purpose and — until now — never spent. The note beside it
  // says it plainly: outside the shell the air is a ring you look *at*, inside
  // it is haze you look *through*, and running both at once double-counts the
  // same photons. The ring was gated and the haze was not, so from orbit vDist
  // is several planet radii of pure vacuum, the exponential saturates at 1.0,
  // and mix(col, ins, 0.80) repaints four fifths of the lit disc in flat
  // inscatter colour. That is the blown-out white day side in
  // review/final/planet-orbit.png, and it is present with or without a shell —
  // a separate fault from the double-count, in the same three lines.
  float inAir = 1.0 - above;
  if (uAtmosOuter > 0.01 && inAir > 0.002) {
    float haze  = (1.0 - exp(-vDist * uAtmosOuter * 14.0 / max(uRadius, 1.0))) * inAir;
    // Warm looking into the star, cold looking away: the same slant-path
    // filter that reddens the terminator, seen end-on.
    float toSun = clamp(dot(-V, uSunDir), 0.0, 1.0);
    vec3  hz    = mix(uAtmosTint.bgr, uAtmosTint, pow(toSun, 2.5));

    // The inscatter *level* is the whole point and it was an order of magnitude
    // too low. Haze is a mix towards this colour, so if the colour is darker
    // than the terrain then "more air in the way" means "darker", which is the
    // opposite of aerial perspective — distance was crushing contrast downwards
    // instead of lifting the blacks, and the far ridges came out at the same
    // black point as the near ones.
    //
    // The right scale is set by the ground it has to compete with: this rock is
    // albedo 0.05–0.15, so a lit surface leaves ~0.2–0.35 of the key. Inscatter
    // slightly above that (0.16 * key) makes distance lift and desaturate,
    // which is what a horizon does. Mie forward scattering then triples it
    // towards the star — that is where a washed-out sunward horizon and the
    // light shafts §6 asks for come from — and it is the *only* free parameter
    // here that is not derived from the surface albedo.
    vec3 ins = hz * uSunColor * 0.16 * mix(1.0, 3.0, toSun * toSun * toSun * toSun * toSun * toSun)
             * smoothstep(-0.12, 0.30, ndlGeo);
    col = mix(col, ins, haze * 0.80);
  }

  return col;
}

void main() {
  #include <logdepthbuf_fragment>
#if OS_OCEAN == 1
  vec3 col;
  if (vDepth > 0.0) {
    vec4 sea = os_seaColor(vDepth);
    // Deep water is opaque, so the ground under it is never shaded at all.
    col = sea.a > 0.999 ? sea.rgb : mix(os_landColor(), sea.rgb, sea.a);
  } else {
    col = os_landColor();
  }
#else
  vec3 col = os_landColor();
#endif

  // Linear HDR out. PostFX owns the tone map and the noir grade (see
  // ARCHITECTURE §6 "Grade"), so this material is toneMapped:false and must
  // NOT include <tonemapping_fragment> — ACES here would clamp to 1.0, and the
  // three things in this shader that are supposed to bloom (the sun glint, the
  // settlement lights, the lit limb) are all above 1.0 by design.
  gl_FragColor = vec4(col, 1.0);

  #include <colorspace_fragment>

  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;
}

// ---------------------------------------------------------------------------
// Ocean shader
// ---------------------------------------------------------------------------

/**
 * The sea, as a function the surface shader calls where the ground is below
 * sea level (see the vertex shader). It shares the surface's uniforms; see
 * the uAtmos/uAtmosOuter note there — uAtmos lights the water (sun reddening,
 * terminator width, the sky it mirrors), uAtmosOuter draws the air in front
 * of it and is zeroed when Atmosphere.ts is drawing that air instead.
 */
const OCEAN_GLSL = /* glsl */ `
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uEmissive;
uniform float uSpecular;
uniform float uWave;
varying float vDepth;

/** Two drifting swell trains plus chop. Returns a height in kilometres. */
float os_waveHeight(vec3 p, float t, vec2 k) {
  float a = os_snoise(p * (1.0 / 0.9) + vec3(t * 0.020, 0.0, t * 0.013));
  float b = os_snoise(p * (1.0 / 0.22) + vec3(-t * 0.045, t * 0.031, 0.0));
  return (a * 0.9 * k.x + b * 0.35 * k.y) * uWave;
}

/**
 * Water colour and coverage at this fragment. 'depth' is how far the ground
 * sits below sea level, km — sea level is exactly the mean radius (see
 * gen/terrain.ts) — baked and interpolated across the triangle the coastline
 * is cut from. Alpha is coverage: below 1 only in the shallows, where the
 * caller mixes the sea floor in.
 */
vec4 os_seaColor(float depth) {
  vec3  d     = normalize(vDir);
  vec3  V     = normalize(vView);
  float pxKm  = vDist * uPixelAngle;

  vec3 N = d;

  // Wave normal, faded out once the swell is smaller than a pixel.
  vec2 k = vec2(smoothstep(1.5, 5.0, 0.9 / max(pxKm, 1e-8)),
                smoothstep(1.5, 5.0, 0.22 / max(pxKm, 1e-8)));
  if (k.x + k.y > 0.002) {
    float s = max(pxKm * 0.9, 0.02);
    vec2  e = vec2(1.0, -1.0);
    vec3  g = e.xyy * os_waveHeight(vLocal + e.xyy * s, uTime, k)
            + e.yyx * os_waveHeight(vLocal + e.yyx * s, uTime, k)
            + e.yxy * os_waveHeight(vLocal + e.yxy * s, uTime, k)
            + e.xxx * os_waveHeight(vLocal + e.xxx * s, uTime, k);
    g /= (4.0 * s);
    N = normalize(N - (g - d * dot(g, d)));
  }

  float ndlGeo = dot(d, uSunDir);
  // Must match surfaceFragmentShader exactly, or the sea's terminator stays a
  // grey dissolve while the land's tightens and the two disagree along every
  // coastline. See the long note there for why the geometric cap is 0.008.
  float soft   = mix(0.006, 0.030, uAtmos) + clamp(pxKm / max(uRadius, 1.0) * 25.0, 0.0, 0.008);
  float shade  = smoothstep(-soft, soft, dot(N, uSunDir)) * smoothstep(-0.05, 0.02, ndlGeo);
  float above  = smoothstep(uRadius * 0.02, uRadius * 0.10, length(uCamLocal) - uRadius);

  vec3 sun = uSunColor * mix(vec3(1.0), uAtmosTint, uAtmos * (1.0 - smoothstep(0.0, 0.30, ndlGeo)));

  // Shallows read lighter and greener; the abyss goes almost black.
  float dm   = 1.0 - exp(-depth * 0.55);
  vec3  body = mix(uShallow, uDeep, dm);

  vec3 col = body * sun * shade * 0.95;

  // Fresnel: a water surface is a mirror at grazing angles and glass head on.
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

  // What it mirrors is the sky, and the sky is not one grey. Cold overhead,
  // warm towards the star — without this the sea reads as sheet metal.
  vec3  refl = reflect(-V, N);
  float rs   = clamp(dot(refl, uSunDir), 0.0, 1.0);
  vec3  sky  = mix(vec3(0.045, 0.085, 0.185), uAtmosTint * 1.15, pow(rs, 3.0));
  sky = mix(sky * 0.35, sky, uAtmos);
  col += sky * fres * uSpecular * shade * 1.15;

  // Volume scattering. Water is not a black mirror: most of what an ocean
  // sends back to orbit is light that went in, bounced around and came out
  // again. It is a *body* colour, so it hides behind the reflection at
  // grazing angles instead of adding to it — otherwise the sea goes milky
  // the moment the camera drops to sea level.
  col += uShallow * sun * shade * 0.55 * (1.0 - dm * 0.55) * (1.0 - fres);

  // Sun glint — a GGX lobe roughened by the swell.
  //
  // The wave normals above fade out once the swell drops below a pixel, and a
  // naive glint then rides on a mirror-smooth sphere: at 0.05 roughness the
  // lobe is 0.2 degrees wide, which from orbit is a highlight two pixels
  // across, i.e. no highlight at all. Real sun glitter is broad *because* of
  // the sub-pixel slope distribution, so the roughness has to absorb exactly
  // the slope variance the fade just discarded (the LEAN/Toksvig argument).
  // This is what puts a readable, bloom-worthy glare path on the sea from
  // orbit — the one specular event in the whole frame.
  float lost  = 1.0 - clamp(max(k.x, k.y), 0.0, 1.0);
  vec3  H     = normalize(uSunDir + V);
  float rough = clamp(0.045 + uWave * 6.0 + lost * 0.17, 0.03, 0.45);
  float a     = rough * rough;
  float dh    = dot(N, H);
  float dd    = dh * dh * (a * a - 1.0) + 1.0;
  float ggx   = (a * a) / (3.14159265 * dd * dd + 1e-6);
  col += sun * ggx * fres * uSpecular * 1.6 * shade;

#if OS_EMISSIVE == 1
  // Lava and liquid methane emit; the emission is stronger where it is deep.
  vec3 lava = uEmissive * (0.35 + 0.65 * (os_fbm(vLocal * 0.12 + uTime * 0.01, 4, 2.1, 0.55) * 0.5 + 0.5));
  col += lava * mix(0.35, 1.0, dm);
#endif

  float night = 1.0 - shade;
  col += body * uSunColor * 0.004 * night;

  // The same limb ring and sunset band the land carries, and it has to switch
  // off on exactly the same condition — the shell covers the whole disc, so a
  // sea that kept its cheap ring while the land dropped its own would put a
  // brighter rim over every ocean and a dotted limb round the coastlines.
  // See surfaceFragmentShader for the derivation of the exponents and levels.
  if (uAtmosOuter > 0.002) {
    float grz  = 1.0 - clamp(dot(d, V), 0.0, 1.0);
    float limb = grz * grz;
    vec3  air  = mix(uAtmosTint.bgr, uAtmosTint, smoothstep(0.35, -0.05, ndlGeo));
    col += air * uSunColor * limb * uAtmosOuter * 0.50 * above * smoothstep(-0.30, 0.45, ndlGeo);
    float fwd = max(dot(-V, uSunDir), 0.0);
    fwd = fwd * fwd; fwd = fwd * fwd; fwd = fwd * fwd;
    col += uSunColor * uAtmosTint * limb * uAtmosOuter * fwd * above * 1.60;
    col += uAtmosTint * uSunColor * uAtmosOuter * 0.55 * mix(0.25, 1.0, above)
         * exp(-(ndlGeo / 0.055) * (ndlGeo / 0.055))
         * (0.35 + 0.65 * limb);
  }

  // Feather the shoreline so the sphere never shows a hard analytic edge.
  //
  // The old width was pxKm * 2.0 — a *horizontal* length in kilometres used
  // as a threshold on depth, which is a *vertical* one. From orbit pxKm is
  // ~15 km, so the ramp ran over 30 km of depth on a body whose deepest water
  // is 10: the entire ocean went translucent and the dark sea floor showed
  // through it in a fractal, near-binary mottle. That mottle is what the last
  // review read as "a hard-edged, near-binary cyan blotch mask ... one blotch
  // size, no intermediate tones".
  //
  // A pixel of horizontal footprint converts to a depth interval through the
  // sea-bed slope. 0.04 is the continental slope (2.3 degrees), which is the
  // gradient that actually governs where a coastline lands within a pixel; the
  // floor keeps a close pass from aliasing the shoreline to a single texel.
  float alpha = smoothstep(0.0, max(uTerrainAmplitude * 3.0e-3, pxKm * 0.04), depth);

  return vec4(col, alpha);
}
`;

// ---------------------------------------------------------------------------
// Gas giant shader
// ---------------------------------------------------------------------------

const GAS_VERT = /* glsl */ `
precision highp float;
// three's logdepthbuf_vertex chunk calls isPerspectiveMatrix(), which lives in
// its <common> chunk. Pulling all of <common> in would collide with names this
// file already defines, so declare just the one function it needs.
bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
#include <logdepthbuf_pars_vertex>

uniform vec3 uCamLocal;

varying vec3  vDir;
varying vec3  vView;
varying float vDist;

void main() {
  vDir = normalize(position);
  vec3 toCam = uCamLocal - position;
  vDist = length(toCam);
  vView = toCam / max(vDist, 1e-6);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const MAX_BAND_COLORS = 8;
const MAX_STORMS = 6;

/**
 * A gas giant is not stripes. It is a differentially rotating fluid: alternating
 * zonal jets, turbulence sheared out along the flow into filaments, and long
 * lived vortices parked inside a jet. This shader builds it in that order —
 * advect first, then band, then storm — which is why the band edges come out
 * ragged and braided instead of ruled.
 */
const GAS_FRAG = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>

#include <onespace_noise>
#include <onespace_color>

uniform float uRadius;
uniform float uTime;
uniform float uPixelAngle;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSeed;

uniform float uBandCount;
uniform float uTurb;
uniform float uShear;
uniform int   uPalCount;
uniform vec3  uPal[${MAX_BAND_COLORS}];
uniform vec3  uStormColor;
uniform vec3  uPolarColor;
uniform int   uStormCount;
uniform vec4  uStormA[${MAX_STORMS}];
uniform vec4  uStormB[${MAX_STORMS}];

varying vec3  vDir;
varying vec3  vView;
varying float vDist;

// Octaves scale with the quality tier (OS_GAS_OCT is -2..+1); the floor keeps
// the cheapest tier from dropping a field to zero octaves. Written as a
// ternary rather than max() on purpose: three.js emits GLSL ES 1.00, which has
// no integer overload of min/max — that arrived in ES 3.00. Both operands are
// compile-time constants, so this folds away.
#define OS_GO(n) ((((n) + (OS_GAS_OCT)) < 2) ? 2 : ((n) + (OS_GAS_OCT)))

vec3 os_rotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

/** Zonal wind speed at sine-latitude sy. Alternating jets, fast at the equator. */
float os_wind(float sy) {
  return uShear * (sin(sy * 3.14159265 * uBandCount * 0.5) * (1.0 - 0.42 * sy * sy)
                 + 0.55 * exp(-sy * sy * 16.0));
}

/**
 * d(os_wind)/d(sy) — the meridional shear of the zonal flow. Turbulence does
 * not live uniformly over a giant; it lives where two jets rub past each other,
 * which is exactly where this is large. Written analytically because a finite
 * difference here would cost two more transcendentals for no accuracy.
 */
float os_windShear(float sy) {
  float k = 3.14159265 * uBandCount * 0.5;
  return uShear * (cos(sy * k) * k * (1.0 - 0.42 * sy * sy)
                 - sin(sy * k) * 0.84 * sy
                 - 0.55 * 32.0 * sy * exp(-sy * sy * 16.0));
}

/**
 * Detail fade for the flow field, gated on the HIGHEST spatial frequency a
 * given sampling scale produces — not its nominal one.
 *
 * This distinction is the whole of finding 7 in the last review. The band field
 * is sampled in a zonally squashed frame (0.22 across, 3.1 along the meridian),
 * so a nominal scale s is really 0.22s in longitude and 3.1s in latitude: a
 * 14:1 anisotropy. Gating on s let the latitude direction run fourteen times
 * finer than the gate believed — sub-pixel, i.e. aliasing, which is what the
 * review correctly called "dither grain" — while the longitude direction, the
 * one the eye reads band structure in, bottomed out at 30 pixels. Passing the
 * effective frequency in fixes both ends.
 */
float os_gasFade(float freq, float pixAng) {
  return smoothstep(1.5, 5.0, 1.0 / max(freq * pixAng, 1e-9));
}

float os_bandHash(float i) {
  return fract(sin(i * 91.7 + 13.1) * 43758.5453);
}

vec3 os_palette(float t) {
  float f = clamp(t, 0.0, 1.0) * float(uPalCount - 1);
  vec3 c = vec3(0.0);
  for (int i = 0; i < ${MAX_BAND_COLORS}; i++) {
    if (i >= uPalCount) break;
    c += uPal[i] * max(0.0, 1.0 - abs(f - float(i)));
  }
  return c;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3  d      = normalize(vDir);
  vec3  V      = normalize(vView);
  // Angular size of a pixel on the surface, in radians — the LOD metric for
  // everything below.
  float pixAng = max(vDist * uPixelAngle / uRadius, 1e-7);

  // --- advection ----------------------------------------------------------
  float sy = clamp(d.y, -1.0, 1.0);
  vec3  rp = os_rotY(d, os_wind(sy) * uTime);

  // Sampling in a zonally stretched frame is what turns blobs into filaments.
  vec3 sp = vec3(rp.x * 0.22, rp.y * 3.1, rp.z * 0.22);

  float turb  = os_fbm(sp * 3.0 + uSeed, OS_GO(5), 2.15, 0.55);
  float turb2 = os_fbm(sp * 11.0 + uSeed.zxy, OS_GO(4), 2.30, 0.52);

  float latW = sy + (turb * 0.055 + turb2 * 0.022) * uTurb * (1.0 - 0.35 * abs(sy));

  // --- bands --------------------------------------------------------------
  float bc = latW * uBandCount;
  float bi = floor(bc);
  float bf = fract(bc) + turb2 * 0.07;

  float tPrev = os_bandHash(bi - 1.0);
  float tCur  = os_bandHash(bi);
  float tNext = os_bandHash(bi + 1.0);
  float lo = smoothstep(0.0, 0.20, bf);
  float hi = smoothstep(0.80, 1.0, bf);
  float t = mix(mix(tPrev, tCur, lo), tNext, hi);

  // Belts are dark, zones are bright, and the difference is most of what makes
  // a gas giant read as a gas giant. Blended on the same edges as the hue so
  // the two never disagree about where a band ends.
  float gPrev = os_bandHash(bi + 36.0);
  float gCur  = os_bandHash(bi + 37.0);
  float gNext = os_bandHash(bi + 38.0);
  float gain = mix(mix(gPrev, gCur, lo), gNext, hi);

  // Belt/zone brightness ratio. Jupiter's belts are ~35% darker than its
  // zones in the visible; a narrower range than this reads as one beige ball
  // once the grade's shoulder has had its way with the highlights.
  vec3 col = os_palette(t) * mix(0.32, 1.50, gain);

  // Filaments and curdling, with two extra scales that only switch on when the
  // camera is close enough for them to be larger than a pixel.
  float fil = os_fbm(sp * 9.0 + uSeed.yzx, OS_GO(5), 2.2, 0.55);
  col *= 0.66 + 0.66 * (fil * 0.5 + 0.5);

  // 3.1 is sp's meridional multiplier: see os_gasFade.
  float kf1 = os_gasFade(34.0 * 3.1, pixAng);
  if (kf1 > 0.002) col *= 1.0 + kf1 * os_fbm(sp * 34.0 + uSeed, OS_GO(3), 2.2, 0.5) * 0.22;

  // --- shear filaments -----------------------------------------------------
  // The scale that used to sit here (sp * 130) was 35 pixels wide in longitude
  // and a third of a pixel in latitude, so it contributed a horizontal smear
  // and a field of aliasing, which is why the close shot had nothing between a
  // silky airbrushed ribbon and grain. It is replaced rather than added to.
  //
  // Two changes make it read as fluid. First its own frame: shear stretches
  // large eddies, but a small one is torn apart long before it can be drawn out
  // 14:1, so the fine scales are close to isotropic and get a 1.8:1 frame of
  // their own — which is what lets them be a few pixels across in *both*
  // directions instead of sub-pixel in one and invisible in the other. Second,
  // ridged noise fed through a domain warp: a rolled-up shear layer is thin
  // bright filaments with dark lanes between them, and plain fbm can only
  // curdle. Amplitude follows the meridional wind shear, so the detail piles up
  // on the belt/zone boundaries where the turbulence actually is and the zone
  // interiors stay smooth — which is also the read Jupiter gives.
  vec3  fp  = vec3(rp.x * 0.85, rp.y * 1.5, rp.z * 0.85);
  float kf2 = os_gasFade(230.0 * 1.5, pixAng);
  float kf3 = os_gasFade(760.0 * 1.5, pixAng);
  if (kf2 + kf3 > 0.002) {
    float shr = clamp(abs(os_windShear(sy)) / (uShear * uBandCount * 2.0 + 1e-6), 0.0, 1.0);
    float amp = mix(0.06, 0.24, shr) * uTurb;
    float f2  = os_ridged(os_warp(fp * 230.0 + uSeed.zxy, 0.75), OS_GO(3), 2.25, 0.5);
    float f3  = kf3 > 0.002 ? os_ridged(fp * 760.0 + uSeed.yzx, OS_GO(2), 2.30, 0.5) : 0.0;
    col *= 1.0 + amp * (kf2 * f2 + kf3 * f3 * 0.55);
  }

  // --- storms -------------------------------------------------------------
  for (int i = 0; i < ${MAX_STORMS}; i++) {
    if (i >= uStormCount) break;
    vec4 A = uStormA[i];
    vec4 B = uStormB[i];

    // The vortex is carried by the jet it sits in.
    vec3 c = os_rotY(A.xyz, os_wind(A.y) * uTime);
    float cosd = dot(d, c);
    if (cosd < 0.0) continue;

    vec3 tangent = d - c * cosd;
    vec3 east    = normalize(cross(vec3(0.0, 1.0, 0.0), c) + vec3(1e-6));
    vec3 north   = cross(c, east);
    float ex = dot(tangent, east) / max(B.y, 0.2);
    float ny = dot(tangent, north);
    float r  = sqrt(ex * ex + ny * ny) / max(A.w, 1e-4);
    if (r > 1.25) continue;

    // Differential rotation. The vortex turns faster at its centre than at its
    // rim, so the material in it is wound up — but it is the *material* that
    // winds, not the noise's argument.
    //
    // What was here sampled os_fbm(vec3(cos(th), sin(th), r*1.7) * s), a field
    // parameterised by angle and radius alone. Such a field is constant along
    // every spiral it defines, so it can produce exactly one thing: evenly
    // spaced concentric log-spiral streaks with one frequency and no structure
    // at any other. That is a twirl filter. It also contradicted this shader's
    // own claim to advect first and apply the storm afterwards, because nothing
    // of the surrounding band ever entered it.
    //
    // Rotating the local coordinates and rebuilding a genuine point on the
    // sphere keeps the noise a 3D field: it is turbulent at every radius, it
    // draws in the band material the vortex is parked in, and the ridged term
    // gives the filaments that a smooth fbm has no way to make.
    float a  = B.x * (1.35 - r) * 2.6 + uTime * B.x * 0.05;
    float ca = cos(a);
    float sa = sin(a);
    vec2  wv = vec2(ca * ex - sa * ny, sa * ex + ca * ny);
    vec3  q  = c * cosd + east * wv.x * B.y + north * wv.y;

    // Two bands, deliberately far apart. The fbm carries the vortex's own
    // shape at a quarter of its radius; the ridged term at five times the
    // frequency is the filament structure, and it lands at roughly eight
    // pixels across at the framing this shot uses — which is the scale the
    // review found completely missing.
    float S  = 2.6 + B.w;
    float sw = 0.66 * os_fbm(q * S + uSeed.yxz, OS_GO(4), 2.2, 0.55)
             + 0.44 * os_ridged(q * S * 5.0 + uSeed.zxy, OS_GO(3), 2.2, 0.5);

    // Broken by the same field that fills it, so the vortex ends in entrained
    // filaments instead of the hard ellipse the review found.
    float core = smoothstep(1.05, 0.35, r + 0.20 * sw);
    // An eye. The centre of a cyclone is a clear, darker well — it is not the
    // brightest point of the spiral, and having no eye at all was half of why
    // this read as a filter effect rather than as weather.
    vec3  sc   = uStormColor * (0.62 + 0.55 * (sw * 0.5 + 0.5))
               * mix(0.45, 1.0, smoothstep(0.10, 0.26, r));
    col = mix(col, sc, core * 0.92);
    // Bright sheared collar where the vortex drags the surrounding band.
    col += uStormColor * 0.22 * smoothstep(0.75, 1.02, r) * smoothstep(1.28, 1.0, r) * (0.5 + 0.5 * sw);
  }

  // Polar hoods: colder, hazier, less banded.
  float pole = smoothstep(0.78, 1.02, abs(sy));
  col = mix(col, uPolarColor * (0.85 + 0.3 * turb), pole * 0.55);

  // --- light --------------------------------------------------------------
  float ndl = dot(d, uSunDir);
  float mu  = clamp(dot(d, V), 0.0, 1.0);

  // A deep atmosphere has no hard surface, so the terminator is soft — but
  // only about six degrees of it. Wider than this and the unlit third of the
  // disc becomes a smooth grey ramp, which is the "uniform field" failure in
  // ARCHITECTURE §6: the flow field stops reading long before the light does.
  float shade = smoothstep(-0.045, 0.075, ndl);

  // Minnaert limb darkening. mu^0.7 is close to Jupiter in the visible; the
  // shallower exponent this used to carry (0.42) left the disc almost evenly
  // bright to the edge, which is what makes a gas giant read as a flat circle
  // rather than a sphere.
  float limb = pow(mu, 0.70);

  vec3 lit = col * uSunColor * shade * limb;

  // Forward-scattered rim. This has to be a *rim* — a bright edge on the
  // sunward limb — not a broad wash, or it simply re-lights the limb darkening
  // it is meant to contrast against. But 4.5 was too tight to survive: it put
  // the whole term inside the outermost 1% of the disc radius, i.e. two or
  // three pixels, which is a hairline nobody sees and the review recorded as
  // "not one flare, glare or silver lining anywhere". 2.8 keeps it a rim (half
  // of it still inside the outer 6% of the radius) while giving it enough area
  // for the bloom pass to have something to work with.
  float rim = pow(1.0 - mu, 2.8);
  lit += uSunColor * rim * 0.55 * smoothstep(-0.05, 0.35, ndl);

  // Night side. No ambient fill (§6), but a giant does glow from its own
  // internal heat. Modulating it by col rather than adding a flat value is
  // the whole point: a constant term paints the unlit third of the disc a
  // uniform brown and erases the flow field, whereas this carries the belts and
  // filaments through the terminator so the dark limb stays a structured
  // silhouette instead of a hole cut in the starfield.
  lit += col * uSunColor * 0.006 * (1.0 - shade);
  lit += col * vec3(0.90, 0.34, 0.20) * 0.030 * (1.0 - shade) * mix(0.30, 1.0, limb);

  gl_FragColor = vec4(lit, 1.0);

  #include <colorspace_fragment>

  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function toColor(c: RGB): Color {
  return new Color(c[0], c[1], c[2]);
}

/**
 * Shadow clipmap shape. Four levels, each 4x the last, put the outermost at
 * 0.07 R + 3 x amplitude (everything a shadow ray can touch) while the finest
 * is 1/64 of that: ~60 m texels under the camera on an Earth-sized world,
 * finer than the first march step, so the near shadows lose nothing.
 */
const CLIP_LEVELS = 4;
const CLIP_TEXELS = 256;

/** Shadow-march steps per tier. Zero on `low`, where the cost is not affordable. */
function shadowSteps(q: QualitySettings): number {
  switch (q.tier) {
    case 'low':
      return 0;
    case 'medium':
      return 2;
    case 'high':
      return 4;
    default:
      return 6;
  }
}

/**
 * Octaves added to (or taken off) every fBm in the gas giant flow field.
 * A banded giant is a full-screen fragment shader with six fBm calls in it —
 * roughly 24 octaves of 3D simplex per pixel at `high` — so this is the one
 * number that decides whether `low` can draw one at all.
 */
function gasOctaveBias(q: QualitySettings): number {
  switch (q.tier) {
    case 'low':
      return -2;
    case 'medium':
      return -1;
    case 'ultra':
      return 1;
    default:
      return 0;
  }
}

/**
 * How many pixels a whole patch should span before it splits. Dividing by the
 * patch resolution turns this into the per-cell screen-space error, so the
 * *number of patches on screen* — and therefore the draw call count — stays
 * roughly constant across tiers even though the vertex density does not.
 * At `high` (65 vertices) this works out at the ~2 px the brief asks for.
 */
function targetPatchPixels(q: QualitySettings): number {
  switch (q.tier) {
    case 'low':
      return 208;
    case 'medium':
      return 160;
    default:
      return 128;
  }
}

// ---------------------------------------------------------------------------
// PlanetRenderer
// ---------------------------------------------------------------------------

export class PlanetRenderer {
  /** Planet-local space, kilometres. The integrator positions this. */
  readonly object3d: Object3D;

  private readonly root = new Group();
  private readonly patchRoot = new Group();

  private readonly radius: number;
  private readonly amplitude: number;
  private readonly seaLevel: number;
  private readonly isGasGiant: boolean;
  /** uAtmos as derived from the spec — the value uAtmosOuter returns to. */
  private atmosStrength = 0;

  // --- LOD configuration ---------------------------------------------------
  private readonly res: number;
  private readonly gridN: number;
  private readonly vertCount: number;
  private readonly maxDepth: number;
  private readonly buildBudget: number;
  private readonly splitPx: number;
  private readonly mergePx: number;
  private readonly poolSize: number;
  private readonly occluderRadius: number;

  // --- GPU resources -------------------------------------------------------
  private readonly uniforms: Record<string, IUniform> = {};
  private surfaceMat: ShaderMaterial | null = null;
  private gasMat: ShaderMaterial | null = null;
  private gasMesh: Mesh | null = null;
  private indexAttr: Uint16BufferAttribute | null = null;
  private readonly geometries: BufferGeometry[] = [];
  private readonly meshes: Mesh[] = [];
  private slots: SlotPool = new SlotPool(0);

  // --- baked terrain (see terrainBake.ts) -----------------------------------
  private layout: AtlasLayout = atlasLayout(1, 2);
  private atlas: WebGLRenderTarget | null = null;
  private bakeMat: ShaderMaterial | null = null;
  private bakeGeo: PlaneGeometry | null = null;
  private readonly bakeScene = new Scene();
  private readonly bakeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bakeU: Record<string, IUniform> = {};
  private bakePrevTarget: WebGLRenderTarget | null = null;
  private bakePrevAutoClear = true;
  private bakeOpen = false;
  private bakesThisFrame = 0;
  private bakeSel = new Int32Array(0);

  // --- shadow clipmap (see terrainBake.shadowClipExtents) -------------------
  private readonly clipLevels: number;
  private readonly clipExtents: number[];
  private shadowMap: WebGLRenderTarget | null = null;
  private clipMat: ShaderMaterial | null = null;
  private readonly clipScene = new Scene();
  private readonly clipU: Record<string, IUniform> = {};
  /** Ground direction each level was last baked around; null = never. */
  private readonly clipCentre: Array<[number, number, number] | null> = [];
  private readonly camDir: [number, number, number] = [0, 0, 0];

  // --- quadtree ------------------------------------------------------------
  private readonly nodePool: Patch[] = [];
  private readonly freeNodes: number[] = [];
  private readonly roots: Patch[] = [];

  // --- per-frame scratch (preallocated: update() must not allocate) --------
  private readonly reqNodes: Array<Patch | null> = [];
  private readonly reqErr: Float64Array;
  private reqCount = 0;
  private readonly frustum = new Frustum();
  private readonly m4 = new Matrix4();
  private readonly tmpSphere = new Sphere();
  private readonly v3a = new Vector3();
  private readonly v3b = new Vector3();
  private readonly v3c = new Vector3();
  private readonly dirScratch: [number, number, number] = [0, 0, 0];
  private pixelScale = 900;
  private frameId = 0;
  private disposed = false;

  constructor(
    readonly spec: PlanetSpec,
    private readonly quality: QualitySettings,
  ) {
    registerShaderChunks();

    this.object3d = this.root;
    this.root.name = `planet:${spec.id}`;

    this.radius = spec.radius;
    this.amplitude = spec.terrain.amplitude;
    this.seaLevel = spec.terrain.seaLevel;
    this.isGasGiant = spec.bands !== null;

    this.res = Math.max(5, quality.patchResolution);
    this.gridN = this.res + 2; // one skirt ring on every side
    this.vertCount = this.gridN * this.gridN;
    this.maxDepth = quality.planetMaxDepth;
    this.buildBudget = Math.max(1, quality.patchBuildBudget);

    const target = targetPatchPixels(quality);
    this.splitPx = target / (this.res - 1);
    // Hysteresis. Splitting and merging on the same threshold makes a patch
    // flicker for as long as the camera hovers on the boundary.
    this.mergePx = this.splitPx * 0.62;

    // A screen-filling planet needs ~(1920*1080)/target^2 leaves; the rest is
    // headroom for the parents that stay resident while children stream in.
    const screenLeaves = Math.ceil((1920 * 1080) / (target * target));
    this.poolSize = this.isGasGiant ? 0 : Math.min(288, Math.ceil(screenLeaves * 1.8) + 24);
    this.reqErr = new Float64Array(Math.max(1, this.poolSize));

    // The horizon occluder must be the *smallest* radius the terrain can reach,
    // or the test would cull patches that are actually peeking over the edge.
    this.occluderRadius = this.radius - this.amplitude * this.seaLevel;

    this.clipLevels = this.isGasGiant || shadowSteps(quality) === 0 ? 0 : CLIP_LEVELS;
    this.clipExtents = shadowClipExtents(this.radius, this.amplitude, this.clipLevels);
    for (let i = 0; i < this.clipLevels; i++) this.clipCentre.push(null);

    this.buildUniforms();

    if (this.isGasGiant) this.buildGasGiant();
    else this.buildSurface();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildUniforms(): void {
    const s = this.spec;
    const u = this.uniforms;

    // Terrain: gen/terrain.ts owns these names and declares them in its own
    // GLSL, so they are copied verbatim and never redeclared here.
    const tv = terrainUniformValues(s.terrain, s.seed);
    for (const name of TERRAIN_UNIFORM_NAMES) {
      const v = tv[name];
      if (v === undefined) continue;
      u[name] = { value: typeof v === 'number' ? v : new Vector3(v[0], v[1], v[2]) };
    }

    const atm = s.atmosphere;
    // The tint of light that survives a long slant path: whatever Rayleigh
    // scattering has *not* taken out. This is what reddens the terminator.
    let tint = new Color(1, 0.44, 0.16);
    let atmos = 0;
    if (atm) {
      const k = Math.max(8, atm.scaleHeight * 7);
      const r = Math.exp(-atm.rayleigh[0] * k);
      const g = Math.exp(-atm.rayleigh[1] * k);
      const b = Math.exp(-atm.rayleigh[2] * k);
      const m = Math.max(r, g, b, 1e-4);
      tint = new Color(r / m, g / m, b / m);
      atmos = clamp01(Math.min(1, 0.3 + Math.log10(1 + atm.pressure) * 0.8) * clamp01(atm.intensity * 0.9 + 0.1));
    }

    // Cold worlds carry ice further from the poles and snow further down.
    const t = s.temperature;
    const polarLat = clamp01((t - 205) / 130) * 0.30 + 0.68;
    const snowLine = clamp01((t - 210) / 150) * 0.32 + 0.60;

    const rough =
      s.type === 'ice' ? 0.45 : s.type === 'ocean' || s.type === 'terran' ? 0.72 : 0.92;

    u.uRadius = { value: this.radius };
    u.uHeightAtlas = { value: null };
    u.uShadowMap = { value: null };
    u.uClipN = { value: CLIP_TEXELS };
    u.uClipC = { value: Array.from({ length: Math.max(1, this.clipLevels) }, () => new Vector3(0, 1, 0)) };
    u.uClipT1 = { value: Array.from({ length: Math.max(1, this.clipLevels) }, () => new Vector3(1, 0, 0)) };
    u.uClipT2 = { value: Array.from({ length: Math.max(1, this.clipLevels) }, () => new Vector3(0, 0, 1)) };
    // Zero marks a level as not yet baked; the shader skips it.
    u.uClipH = { value: new Array<number>(Math.max(1, this.clipLevels)).fill(0) };
    u.uCamLocal = { value: new Vector3(0, 0, this.radius * 3) };
    u.uPixelAngle = { value: 1 / 900 };
    u.uTime = { value: 0 };
    u.uSunDir = { value: new Vector3(1, 0, 0) };
    u.uSunColor = { value: new Color(1, 0.97, 0.92) };
    u.uAtmosTint = { value: tint };
    u.uAtmos = { value: atmos };
    this.atmosStrength = atmos;
    // Starts equal to uAtmos: a planet is responsible for its own air until
    // something tells it otherwise. setAtmosphereShell(true) is what tells it.
    // Defaulting the other way would strip the limb off every world the
    // integrator forgot to wire, which is a silent, invisible failure; this way
    // the worst case is the double-count we already have.
    u.uAtmosOuter = { value: atmos };
    u.uNightLights = { value: clamp01((s.interest - 0.5) / 0.5) };
    u.uRoughness = { value: rough };
    u.uPolarLat = { value: polarLat };
    u.uSnowLine = { value: snowLine };
    u.uDetailStrength = { value: s.type === 'ice' ? 0.6 : 1.0 };

    u.uLow = { value: toColor(s.palette.low) };
    u.uMid = { value: toColor(s.palette.mid) };
    u.uHigh = { value: toColor(s.palette.high) };
    u.uPeak = { value: toColor(s.palette.peak) };
    u.uCliff = { value: toColor(s.palette.cliff) };
    u.uPolar = { value: toColor(s.palette.polar) };
    u.uAccent = { value: toColor(s.palette.accent) };
  }

  private buildSurface(): void {
    const terrain = terrainGlsl();
    const ocean = this.spec.ocean;
    if (ocean) this.buildOceanUniforms();

    this.surfaceMat = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: surfaceVertexShader(terrain),
      fragmentShader: surfaceFragmentShader(terrain),
      defines: {
        OS_SHADOW_STEPS: shadowSteps(this.quality),
        OS_CLIP_LEVELS: Math.max(1, this.clipLevels),
        OS_OCEAN: ocean ? 1 : 0,
        // A four-octave fBm for the lava glow is pure waste on the ~90% of
        // oceans that are water, and it runs on every shaded water pixel.
        OS_EMISSIVE: ocean?.emissive ? 1 : 0,
      },
      side: FrontSide,
      transparent: false,
      depthWrite: true,
      // PostFX is the only tone map in this project. Every other renderer
      // (Sky, Nebula, Rings, Clouds) opts out the same way; a material that
      // tone-maps itself clamps to 1.0 and its highlights never reach bloom.
      toneMapped: false,
    });

    // One index buffer for every patch: the grid topology is identical, only
    // the vertex positions differ. Saves ~50 kB of upload per patch.
    const g = this.gridN;
    const quads = (g - 1) * (g - 1);
    const idx = new Uint16Array(quads * 6);
    let o = 0;
    for (let j = 0; j < g - 1; j++) {
      for (let i = 0; i < g - 1; i++) {
        const a = j * g + i;
        const b = a + 1;
        const c = a + g;
        const d = c + 1;
        idx[o++] = a;
        idx[o++] = b;
        idx[o++] = d;
        idx[o++] = a;
        idx[o++] = d;
        idx[o++] = c;
      }
    }
    this.indexAttr = new Uint16BufferAttribute(idx, 1);

    // One atlas tile per geometry slot, so a tile lives exactly as long as the
    // patch holding the slot. Each vertex's texel depends only on the slot and
    // its grid index, so aTexel is written here once and never again.
    this.layout = atlasLayout(this.poolSize, this.res);
    this.slots = new SlotPool(this.poolSize);
    this.bakeSel = new Int32Array(Math.max(1, this.poolSize));
    for (let i = 0; i < this.poolSize; i++) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(this.vertCount * 3), 3));
      geo.setAttribute('aDir', new Float32BufferAttribute(new Float32Array(this.vertCount * 3), 3));
      const texel = new Float32Array(this.vertCount * 2);
      const [tx, ty] = tileOrigin(this.layout, i);
      let t = 0;
      for (let j = 0; j < g; j++) {
        for (let k = 0; k < g; k++) {
          texel[t++] = tx + gridTexel(k, g);
          texel[t++] = ty + gridTexel(j, g);
        }
      }
      geo.setAttribute('aTexel', new Float32BufferAttribute(texel, 2));
      geo.setIndex(this.indexAttr);
      geo.boundingSphere = new Sphere(new Vector3(), this.radius);
      const mesh = new Mesh(geo, this.surfaceMat);
      mesh.frustumCulled = false; // culled by the quadtree, in planet-local space
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      this.geometries.push(geo);
      this.meshes.push(mesh);
      this.patchRoot.add(mesh);
      this.reqNodes.push(null);
    }
    this.root.add(this.patchRoot);

    this.buildBakeResources(terrain);

    // Node pool: every resident patch plus the internal nodes above it.
    const nodeCount = this.poolSize * 2 + 16;
    for (let i = 0; i < nodeCount; i++) {
      const p = new Patch();
      p.poolIndex = i;
      this.nodePool.push(p);
      this.freeNodes.push(i);
    }

    for (let f = 0; f < 6; f++) {
      const p = this.allocNode();
      if (!p) break;
      this.initNode(p, f, 0, 0, 0, 1);
      // The roots are baked on the first update() regardless of budget: they
      // are the fallback that guarantees the planet is never a hole while
      // deeper patches stream in. (Baking needs the renderer, which a
      // constructor does not have.)
      this.roots.push(p);
    }

  }

  /** The sea's uniforms; it is drawn by the surface material (OCEAN_GLSL). */
  private buildOceanUniforms(): void {
    const ocean = this.spec.ocean;
    if (!ocean) return;
    const u = this.uniforms;
    u.uShallow = { value: toColor(ocean.color) };
    u.uDeep = { value: toColor(ocean.deepColor) };
    u.uEmissive = { value: ocean.emissive ? toColor(ocean.emissive) : new Color(0, 0, 0) };
    u.uSpecular = { value: ocean.specular };
    u.uWave = { value: Math.max(1e-5, ocean.waveHeight) };
  }

  /**
   * The bake passes: fullscreen quads whose materials run the terrain GLSL per
   * texel, in private scenes. compileAsync(object3d) never sees those, so
   * PlanetRenderer.compileAsync() links them against their real targets.
   */
  private buildBakeResources(terrain: string): void {
    const b = this.bakeU;
    for (const name of TERRAIN_UNIFORM_NAMES) {
      const v = this.uniforms[name];
      if (v) b[name] = v;
    }
    b.uRadius = this.uniforms.uRadius!;
    b.uFaceN = { value: new Vector3() };
    b.uFaceR = { value: new Vector3() };
    b.uFaceU = { value: new Vector3() };
    b.uBakeRect = { value: new Vector3() };
    b.uBakeOrigin = { value: new Vector2() };
    b.uBakeInvN = { value: 1 / (this.res - 1) };
    b.uBakeEps = { value: 1 };
    this.bakeMat = new ShaderMaterial({
      name: 'os-terrain-bake',
      uniforms: b,
      vertexShader: BAKE_VERT,
      fragmentShader: bakeFragmentShader(terrain),
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.bakeGeo = new PlaneGeometry(2, 2);
    const quad = new Mesh(this.bakeGeo, this.bakeMat);
    quad.frustumCulled = false;
    this.bakeScene.add(quad);
    if (this.clipLevels > 0) {
      const c = this.clipU;
      for (const name of TERRAIN_UNIFORM_NAMES) {
        const v = this.uniforms[name];
        if (v) c[name] = v;
      }
      c.uRadius = this.uniforms.uRadius!;
      c.uClipN = this.uniforms.uClipN!;
      c.uClipBakeC = { value: new Vector3() };
      c.uClipBakeT1 = { value: new Vector3() };
      c.uClipBakeT2 = { value: new Vector3() };
      c.uClipBakeH = { value: 1 };
      c.uClipBakeX = { value: 0 };
      this.clipMat = new ShaderMaterial({
        name: 'os-terrain-clip-bake',
        uniforms: c,
        vertexShader: BAKE_VERT,
        fragmentShader: clipBakeFragmentShader(terrain),
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const cq = new Mesh(this.bakeGeo, this.clipMat);
      cq.frustumCulled = false;
      this.clipScene.add(cq);
    }
  }

  /** The atlas needs the renderer (for its float support), so it is lazy. */
  private ensureAtlas(renderer: WebGLRenderer): WebGLRenderTarget {
    if (this.atlas) return this.atlas;
    // float32: a half float quantises a 10 km height to ~8 m, which steps the
    // silhouette on a low pass. Half is the fallback where float32 colour
    // buffers are not renderable.
    const float = renderer.extensions.has('EXT_color_buffer_float');
    const rt = new WebGLRenderTarget(this.layout.width, this.layout.height, {
      type: float ? FloatType : HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.name = 'os-terrain-atlas';
    rt.scissorTest = true;
    this.atlas = rt;
    this.uniforms.uHeightAtlas!.value = rt.texture;
    return rt;
  }

  private ensureShadowMap(renderer: WebGLRenderer): WebGLRenderTarget {
    if (this.shadowMap) return this.shadowMap;
    const n = CLIP_TEXELS;
    const rt = new WebGLRenderTarget(n * Math.max(1, this.clipLevels), n, {
      type: renderer.extensions.has('EXT_color_buffer_float') ? FloatType : HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.name = 'os-terrain-shadow-clip';
    rt.scissorTest = true;
    this.shadowMap = rt;
    this.uniforms.uShadowMap!.value = rt.texture;
    return rt;
  }

  /**
   * Link the bake programs ahead of the first bake, without blocking where the
   * driver supports KHR_parallel_shader_compile. Call alongside
   * renderer.compileAsync(object3d): the bake scenes are private, so that call
   * never reaches them. Each is compiled with its own render target bound,
   * because the program key includes the output colour space of the target.
   */
  async compileAsync(renderer: WebGLRenderer, _camera?: Camera): Promise<void> {
    if (this.disposed || this.isGasGiant || !this.bakeMat) return;
    const prev = renderer.getRenderTarget();
    const jobs: Array<Promise<unknown>> = [];
    renderer.setRenderTarget(this.ensureAtlas(renderer));
    jobs.push(renderer.compileAsync(this.bakeScene, this.bakeCam));
    if (this.clipMat) {
      renderer.setRenderTarget(this.ensureShadowMap(renderer));
      jobs.push(renderer.compileAsync(this.clipScene, this.bakeCam));
    }
    renderer.setRenderTarget(prev);
    await Promise.all(jobs);
  }

  private bakeBegin(renderer: WebGLRenderer): void {
    if (this.bakeOpen) return;
    this.ensureAtlas(renderer);
    this.bakePrevTarget = renderer.getRenderTarget();
    this.bakePrevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.bakeOpen = true;
  }

  private bakeEnd(renderer: WebGLRenderer): void {
    if (!this.bakeOpen) return;
    renderer.setRenderTarget(this.bakePrevTarget);
    renderer.autoClear = this.bakePrevAutoClear;
    this.bakePrevTarget = null;
    this.bakeOpen = false;
  }

  private buildGasGiant(): void {
    const bands = this.spec.bands;
    if (!bands) return;
    const u = this.uniforms;
    const rng = new Rng(hashSeed(this.spec.seed, 'gas-bands'));

    const pal: Color[] = [];
    for (let i = 0; i < MAX_BAND_COLORS; i++) {
      const c = bands.palette[Math.min(i, bands.palette.length - 1)];
      pal.push(c ? toColor(c) : new Color(0.5, 0.45, 0.4));
    }
    const palCount = Math.max(2, Math.min(MAX_BAND_COLORS, bands.palette.length));

    // The storm is the one saturated accent on the whole body: push the most
    // colourful band entry further rather than inventing a new hue.
    let best = pal[0]!;
    let bestSat = -1;
    for (let i = 0; i < palCount; i++) {
      const c = pal[i]!;
      const mx = Math.max(c.r, c.g, c.b);
      const mn = Math.min(c.r, c.g, c.b);
      const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
      if (sat > bestSat) {
        bestSat = sat;
        best = c;
      }
    }
    const stormColor = best.clone().multiplyScalar(1.25).lerp(new Color(0.55, 0.16, 0.09), 0.35);

    const stormCount = Math.max(0, Math.min(MAX_STORMS, Math.round(bands.stormCount)));
    const A: Vector4[] = [];
    const B: Vector4[] = [];
    for (let i = 0; i < MAX_STORMS; i++) {
      // Storms live in the jets, not on the equator and not at the poles.
      const sy = rng.range(0.18, 0.62) * (rng.chance(0.5) ? 1 : -1);
      const lon = rng.range(0, Math.PI * 2);
      const cy = Math.sqrt(Math.max(0, 1 - sy * sy));
      // The first vortex is the body's landmark and is always the big one.
      const ang = i === 0 ? rng.range(0.20, 0.30) : rng.range(0.05, 0.13);
      A.push(new Vector4(cy * Math.cos(lon), sy, cy * Math.sin(lon), ang));
      B.push(new Vector4(rng.range(0.5, 1.6) * (sy > 0 ? 1 : -1), rng.range(1.5, 2.9), 0, rng.range(0, 3)));
    }

    u.uSeed = { value: new Vector3(rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40)) };
    u.uBandCount = { value: Math.max(2, bands.count) };
    u.uTurb = { value: bands.turbulence };
    u.uShear = { value: bands.shearSpeed };
    u.uPal = { value: pal };
    u.uPalCount = { value: palCount };
    u.uStormColor = { value: stormColor };
    u.uPolarColor = { value: pal[palCount - 1]!.clone().lerp(new Color(0.10, 0.12, 0.16), 0.6) };
    u.uStormCount = { value: stormCount };
    u.uStormA = { value: A };
    u.uStormB = { value: B };

    this.gasMat = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: GAS_VERT,
      fragmentShader: GAS_FRAG,
      // The flow field is six fBm calls deep and a gas giant fills the frame,
      // so its octave count is the module's single largest fragment cost. It
      // must scale with the tier like every other budget in ARCHITECTURE §5.
      defines: { OS_GAS_OCT: gasOctaveBias(this.quality) },
      side: FrontSide,
      toneMapped: false,
    });

    const seg = this.quality.tier === 'low' ? 128 : this.quality.tier === 'medium' ? 256 : 384;
    const geo = new SphereGeometry(this.radius, seg, seg / 2);
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    this.gasMesh = new Mesh(geo, this.gasMat);
    this.root.add(this.gasMesh);
  }

  // -------------------------------------------------------------------------
  // Node lifecycle
  // -------------------------------------------------------------------------

  private allocNode(): Patch | null {
    const i = this.freeNodes.pop();
    if (i === undefined) return null;
    const p = this.nodePool[i]!;
    p.reset();
    p.inUse = true;
    return p;
  }

  private freeNode(p: Patch): void {
    for (let i = 0; i < 4; i++) {
      const c = p.children[i];
      if (c) this.freeNode(c);
    }
    this.releaseSlot(p);
    p.reset();
    p.inUse = false;
    this.freeNodes.push(p.poolIndex);
  }

  private collapse(p: Patch): void {
    if (!p.hasChildren) return;
    for (let i = 0; i < 4; i++) {
      const c = p.children[i];
      if (c) this.freeNode(c);
      p.children[i] = null;
    }
    p.hasChildren = false;
  }

  private releaseSlot(p: Patch): void {
    if (p.slot < 0) return;
    this.meshes[p.slot]!.visible = false;
    this.slots.release(p.slot);
    p.slot = -1;
    p.built = false;
  }

  /**
   * Fill in a node's geometry-independent data: centre direction, bounding
   * sphere, geometric error. The bounds come from a 3x3 CPU terrain probe —
   * cheap, and it is the same function the flight model lands against, so the
   * culling can never disagree with what is drawn.
   */
  private initNode(p: Patch, face: number, level: number, a0: number, b0: number, size: number): void {
    p.face = face;
    p.level = level;
    p.a0 = a0;
    p.b0 = b0;
    p.size = size;

    faceDir(face, a0 + size * 0.5, b0 + size * 0.5, p.dir);

    let minH = Infinity;
    let maxH = -Infinity;
    for (let j = 0; j <= 2; j++) {
      for (let i = 0; i <= 2; i++) {
        faceDir(face, a0 + size * (i * 0.5), b0 + size * (j * 0.5), this.v3a);
        this.dirScratch[0] = this.v3a.x;
        this.dirScratch[1] = this.v3a.y;
        this.dirScratch[2] = this.v3a.z;
        const h = sampleTerrain(this.spec.terrain, this.spec.seed, this.dirScratch);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    // A 3x3 probe under-samples, so widen the envelope before it is used to
    // cull. Being generous here costs a few extra draws; being tight loses
    // mountain tops on the limb.
    const pad = this.amplitude * 0.18 + (maxH - minH) * 0.5;
    p.minRadius = this.radius + minH - pad;
    p.maxRadius = this.radius + maxH + pad;

    p.centre.copy(p.dir).multiplyScalar(this.radius + (minH + maxH) * 0.5);

    // Side length and corner spread, measured on the sphere.
    faceDir(face, a0, b0, this.v3a);
    faceDir(face, a0 + size, b0, this.v3b);
    const side = Math.acos(Math.min(1, Math.max(-1, this.v3a.dot(this.v3b)))) * this.radius;
    const corner = Math.acos(Math.min(1, Math.max(-1, this.v3a.dot(p.dir)))) * this.radius;

    p.arcSide = side;
    p.boundRadius = corner * 1.06 + (p.maxRadius - p.minRadius) * 0.5;
    // The feature a grid cell cannot resolve is about one cell across.
    p.geoError = Math.max(side / (this.res - 1), 1e-6);
  }

  private buildPatch(p: Patch, renderer: WebGLRenderer): boolean {
    if (p.built) return true;
    const slot = this.slots.alloc();
    if (slot < 0) return false;

    const geo = this.geometries[slot]!;
    const pos = (geo.getAttribute('position') as Float32BufferAttribute).array as Float32Array;
    const dirs = (geo.getAttribute('aDir') as Float32BufferAttribute).array as Float32Array;

    const g = this.gridN;
    const n = this.res;
    const inv = 1 / (n - 1);
    const R = this.radius;

    // Skirt depth must exceed the height mismatch a coarser neighbour can show,
    // which scales with that neighbour's cell size, plus a slice of the terrain
    // amplitude for the worst case at low depths.
    const skirt = p.arcSide * 0.07 + this.amplitude * 0.05;

    const ox = p.dir.x * R;
    const oy = p.dir.y * R;
    const oz = p.dir.z * R;

    let o = 0;
    for (let j = 0; j < g; j++) {
      const bj = Math.min(n - 1, Math.max(0, j - 1)) * inv;
      const b = p.b0 + p.size * bj;
      for (let i = 0; i < g; i++) {
        const ai = Math.min(n - 1, Math.max(0, i - 1)) * inv;
        const a = p.a0 + p.size * ai;
        faceDir(p.face, a, b, this.v3a);
        const rim = i === 0 || j === 0 || i === g - 1 || j === g - 1;
        const r = rim ? R - skirt : R;
        pos[o] = this.v3a.x * r - ox;
        pos[o + 1] = this.v3a.y * r - oy;
        pos[o + 2] = this.v3a.z * r - oz;
        dirs[o] = this.v3a.x;
        dirs[o + 1] = this.v3a.y;
        dirs[o + 2] = this.v3a.z;
        o += 3;
      }
    }

    geo.getAttribute('position').needsUpdate = true;
    geo.getAttribute('aDir').needsUpdate = true;
    geo.boundingSphere!.center.set(0, 0, 0);
    geo.boundingSphere!.radius = p.boundRadius + this.amplitude;

    const mesh = this.meshes[slot]!;
    mesh.position.set(ox, oy, oz);
    mesh.visible = false;

    p.slot = slot;
    this.bakeTile(p, renderer);
    p.built = true;
    return true;
  }

  /** Render this patch's heights and normals into its atlas tile. */
  private bakeTile(p: Patch, renderer: WebGLRenderer): void {
    this.bakeBegin(renderer);
    const rt = this.atlas!;
    const [x, y] = tileOrigin(this.layout, p.slot);
    const n = this.layout.tile;
    const f = FACES[p.face]!;
    const b = this.bakeU;
    (b.uFaceN!.value as Vector3).set(f.n[0], f.n[1], f.n[2]);
    (b.uFaceR!.value as Vector3).set(f.r[0], f.r[1], f.r[2]);
    (b.uFaceU!.value as Vector3).set(f.u[0], f.u[1], f.u[2]);
    (b.uBakeRect!.value as Vector3).set(p.a0, p.b0, p.size);
    (b.uBakeOrigin!.value as Vector2).set(x, y);
    b.uBakeEps!.value = bakeNormalEps(p.arcSide / (this.res - 1), this.radius);
    rt.viewport.set(x, y, n, n);
    rt.scissor.set(x, y, n, n);
    renderer.setRenderTarget(rt);
    renderer.render(this.bakeScene, this.bakeCam);
    this.bakesThisFrame++;
  }

  /**
   * Re-centre any shadow clipmap level the camera has drifted out of. Only
   * near the ground, where the surface shader actually marches shadows.
   */
  private updateShadowClip(renderer: WebGLRenderer, view: ViewState): void {
    if (this.clipLevels === 0 || !this.clipMat) return;
    const cam = view.cameraLocal;
    const len = cam.length();
    // The march runs for fragments within 0.06 R of the camera, so nothing
    // above that (plus the tallest peak) can need it.
    if (len - this.radius > this.radius * 0.06 + this.amplitude) return;
    this.camDir[0] = cam.x / len;
    this.camDir[1] = cam.y / len;
    this.camDir[2] = cam.z / len;

    const n = CLIP_TEXELS;
    const u = this.uniforms;
    const C = u.uClipC!.value as Vector3[];
    const T1 = u.uClipT1!.value as Vector3[];
    const T2 = u.uClipT2!.value as Vector3[];
    const H = u.uClipH!.value as number[];
    const b = this.clipU;
    for (let l = 0; l < this.clipLevels; l++) {
      const prev = this.clipCentre[l] ?? null;
      if (!clipNeedsRecentre(prev, this.camDir, this.clipExtents[l]!, this.radius)) continue;

      // Tangent basis at the new centre, built off whichever axis is least
      // parallel to it so it never degenerates.
      const c = C[l]!.set(this.camDir[0], this.camDir[1], this.camDir[2]);
      const ax = Math.abs(c.x) < 0.6 ? this.v3a.set(1, 0, 0) : this.v3a.set(0, 1, 0);
      T1[l]!.crossVectors(c, ax).normalize();
      T2[l]!.crossVectors(c, T1[l]!).normalize();

      this.bakeBegin(renderer);
      (b.uClipBakeC!.value as Vector3).copy(c);
      (b.uClipBakeT1!.value as Vector3).copy(T1[l]!);
      (b.uClipBakeT2!.value as Vector3).copy(T2[l]!);
      b.uClipBakeH!.value = this.clipExtents[l]!;
      b.uClipBakeX!.value = l * n;
      const rt = this.ensureShadowMap(renderer);
      rt.viewport.set(l * n, 0, n, n);
      rt.scissor.set(l * n, 0, n, n);
      renderer.setRenderTarget(rt);
      renderer.render(this.clipScene, this.bakeCam);
      H[l] = this.clipExtents[l]!;

      const keep = this.clipCentre[l] ?? [0, 0, 0];
      keep[0] = this.camDir[0];
      keep[1] = this.camDir[1];
      keep[2] = this.camDir[2];
      this.clipCentre[l] = keep;
    }
  }

  // -------------------------------------------------------------------------
  // LOD selection
  // -------------------------------------------------------------------------

  private screenError(p: Patch, view: ViewState): number {
    const dx = view.cameraLocal.x - p.centre.x;
    const dy = view.cameraLocal.y - p.centre.y;
    const dz = view.cameraLocal.z - p.centre.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.boundRadius;
    return (p.geoError / Math.max(d, 0.02)) * this.pixelScale;
  }

  private isVisible(p: Patch, view: ViewState): boolean {
    const V = view.cameraLocal;
    const camLen2 = V.lengthSq();
    const occ = this.occluderRadius;

    // Horizon: a point at radius r is behind the limb of a sphere of radius occ
    // when dot(P, V) < occ^2. The bounding radius makes it conservative.
    if (camLen2 > occ * occ) {
      const dot = p.centre.x * V.x + p.centre.y * V.y + p.centre.z * V.z;
      if (dot < occ * occ - p.boundRadius * Math.sqrt(camLen2)) return false;
    }

    this.tmpSphere.center.copy(p.centre);
    this.tmpSphere.radius = p.boundRadius;
    return this.frustum.intersectsSphere(this.tmpSphere);
  }

  private request(p: Patch, err: number): void {
    if (this.reqCount >= this.reqNodes.length) return;
    this.reqNodes[this.reqCount] = p;
    this.reqErr[this.reqCount] = err;
    this.reqCount++;
  }

  private select(p: Patch, view: ViewState): void {
    if (!this.isVisible(p, view)) {
      // Reclaim off-screen subtrees only when the pool is getting tight, so a
      // camera sweep does not thrash the build queue.
      if (p.hasChildren && this.slots.free < this.poolSize * 0.25) this.collapse(p);
      return;
    }

    const err = this.screenError(p, view);

    if (err > this.splitPx && p.level < this.maxDepth) {
      if (p.hasChildren) {
        let ready = true;
        for (let i = 0; i < 4; i++) {
          const c = p.children[i]!;
          if (!c.built) {
            ready = false;
            this.request(c, err);
          }
        }
        if (ready) {
          for (let i = 0; i < 4; i++) this.select(p.children[i]!, view);
          return;
        }
      } else if (this.freeNodes.length >= 4 && this.slots.free > 4) {
        const h = p.size * 0.5;
        for (let i = 0; i < 4; i++) {
          const c = this.allocNode();
          if (!c) break;
          c.parent = p;
          this.initNode(c, p.face, p.level + 1, p.a0 + (i & 1) * h, p.b0 + (i >> 1) * h, h);
          p.children[i] = c;
          this.request(c, err);
        }
        // A partial split is not a split: all four children or none, or the
        // skirt cannot cover the seam. Recycle by hand rather than through
        // collapse(), which no-ops while hasChildren is still false and would
        // strand the nodes we did allocate until the parent itself is freed.
        if (p.children[3] === null) {
          for (let i = 0; i < 4; i++) {
            const c = p.children[i];
            if (c) this.freeNode(c);
            p.children[i] = null;
          }
        } else {
          p.hasChildren = true;
        }
      }
    } else if (p.hasChildren && err < this.mergePx) {
      this.collapse(p);
    }

    // Draw this node: either it is the chosen LOD, or it is the deepest level
    // that is ready and stands in until its children arrive.
    if (p.built) {
      this.meshes[p.slot]!.visible = true;
    } else this.request(p, err * 1e3); // a hole is worse than any refinement
  }

  private processBuilds(renderer: WebGLRenderer): void {
    // Highest screen error first: the patch the player is staring at wins.
    // A few spare picks cover duplicate or already-built requests without
    // spending the budget on them.
    const picks = selectBuilds(this.reqErr, this.reqCount, this.buildBudget + 4, this.bakeSel);
    let budget = this.buildBudget;
    for (let i = 0; i < picks && budget > 0; i++) {
      const node = this.reqNodes[this.bakeSel[i]!];
      if (!node || !node.inUse || node.built) continue;
      if (!this.buildPatch(node, renderer)) break; // pool exhausted; try again next frame
      budget--;
    }
    for (let i = 0; i < this.reqCount; i++) this.reqNodes[i] = null;
    this.reqCount = 0;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    if (this.disposed) return;
    this.frameId++;

    const u = this.uniforms;
    u.uTime!.value = view.time;
    (u.uCamLocal!.value as Vector3).copy(view.cameraLocal);
    (u.uSunDir!.value as Vector3).copy(view.sunDirection);
    (u.uSunColor!.value as Color).copy(view.sunColor);

    // Radians per pixel: the whole screen-space error metric in one number.
    const pixelAngle = (2 * Math.tan(view.fovY * 0.5)) / Math.max(1, view.viewportHeight);
    u.uPixelAngle!.value = pixelAngle;
    this.pixelScale = 1 / pixelAngle;

    if (this.isGasGiant) return;

    // Frustum in planet-local space, so the quadtree never leaves its own
    // coordinate system.
    this.root.updateWorldMatrix(true, false);
    this.m4.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    this.m4.multiply(this.root.matrixWorld);
    this.frustum.setFromProjectionMatrix(this.m4);

    const renderer = ctx.renderer;
    this.bakesThisFrame = 0;
    for (let i = 0; i < this.roots.length; i++) {
      const r = this.roots[i]!;
      if (!r.built) this.buildPatch(r, renderer);
    }

    for (let i = 0; i < this.meshes.length; i++) this.meshes[i]!.visible = false;
    for (let i = 0; i < this.roots.length; i++) this.select(this.roots[i]!, view);
    this.processBuilds(renderer);
    this.updateShadowClip(renderer, view);
    this.bakeEnd(renderer);
  }

  // -------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------

  /**
   * Tell the surface whether an `AtmosphereRenderer` is drawing this planet's
   * air. Call it once, right after attaching (or detaching) the shell.
   *
   * The surface shader carries a cheap analytic atmosphere: a limb ring, a Mie
   * forward crescent, a sunset band and a distance haze. Those are the same
   * four things the scattering shell marches and composites, so with both
   * present every one of them is integrated twice over the same column of air —
   * which is why the day side of `review/final/planet-orbit.png` reads as
   * blown-out flat white and the limb as a wide milky band rather than a rim.
   *
   * This is a switch and not a deletion because the cheap path is still the
   * only path in three cases: a planet whose renderer is built without a shell
   * (the review fixtures in this file, `game/registry.ts`'s gallery), a quality
   * tier that decides a scattering march is not affordable, and any future
   * distance LOD that drops the shell before it drops the planet. In all three
   * the terms are the difference between air and a hard-edged ball.
   *
   * What it does NOT switch off, because the shell cannot supply it: everything
   * that *lights the ground*. `AtmosphereRenderer` integrates radiance along
   * the camera ray and composites it over the frame; it never contributes to
   * the surface's own shading. So the reddening of the key light along the
   * star-to-ground slant path, the atmospheric widening of the terminator, the
   * blue skylight that keeps a cast shadow from being a hole, and the sky
   * colour the ocean mirrors all stay on and stay driven by `uAtmos`.
   */
  setAtmosphereShell(present: boolean): void {
    const u = this.uniforms.uAtmosOuter;
    if (!u) return;
    u.value = present ? 0 : this.atmosStrength;
  }

  /**
   * Elevation in kilometres, signed about sea level, at a unit direction in
   * planet-local space. Delegates to the same sampler the vertex shader
   * mirrors, so the flight model lands on exactly what is drawn.
   */
  sampleHeight(dir: Vector3): number {
    if (this.isGasGiant) return 0;
    const len = dir.length() || 1;
    this.dirScratch[0] = dir.x / len;
    this.dirScratch[1] = dir.y / len;
    this.dirScratch[2] = dir.z / len;
    return sampleTerrain(this.spec.terrain, this.spec.seed, this.dirScratch);
  }

  /**
   * Unit axes of this gas giant's vortices at t = 0, planet-local. Empty for
   * anything that is not a gas giant. The storms drift east with their jet, so
   * this is where to *point*, not where they will be an hour later.
   */
  stormAxes(): Vector3[] {
    const u = this.uniforms.uStormA;
    const count = this.uniforms.uStormCount;
    if (!u || !count) return [];
    const arr = u.value as Vector4[];
    const n = count.value as number;
    const out: Vector3[] = [];
    for (let i = 0; i < Math.min(n, arr.length); i++) {
      const v = arr[i]!;
      out.push(new Vector3(v.x, v.y, v.z));
    }
    return out;
  }

  /** Distance from the planet centre to the surface along `dir`, kilometres. */
  surfaceRadius(dir: Vector3): number {
    return this.radius + this.sampleHeight(dir);
  }

  /** Diagnostics for the debug overlay. */
  stats(): { resident: number; drawn: number; depth: number } {
    // The ocean and gas shells are not in the patch pool but they are still
    // draw calls, and this number is what the §5 budget is checked against.
    let drawn = this.gasMesh ? 1 : 0;
    let depth = 0;
    for (let i = 0; i < this.meshes.length; i++) if (this.meshes[i]!.visible) drawn++;
    for (let i = 0; i < this.nodePool.length; i++) {
      const p = this.nodePool[i]!;
      if (p.inUse && p.built && p.level > depth) depth = p.level;
    }
    return { resident: this.poolSize - this.slots.free, drawn, depth };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.meshes.length = 0;
    // The shared index attribute is released with the geometries above; drop
    // the reference so nothing can resurrect it.
    this.indexAttr = null;

    this.surfaceMat?.dispose();
    this.surfaceMat = null;

    this.atlas?.dispose();
    this.atlas = null;
    this.shadowMap?.dispose();
    this.shadowMap = null;
    this.clipMat?.dispose();
    this.clipMat = null;
    this.clipScene.clear();
    this.bakeMat?.dispose();
    this.bakeMat = null;
    this.bakeGeo?.dispose();
    this.bakeGeo = null;
    this.bakeScene.clear();

    if (this.gasMesh) {
      this.gasMesh.geometry.dispose();
      this.root.remove(this.gasMesh);
      this.gasMesh = null;
    }
    this.gasMat?.dispose();
    this.gasMat = null;

    this.patchRoot.clear();
    this.root.clear();
    this.roots.length = 0;
    this.nodePool.length = 0;
    this.freeNodes.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Review shots
// ---------------------------------------------------------------------------

/**
 * Lets the integrator hand the shots a real, already-wired planet. When a hook
 * is absent (or returns null) the shot stands up its own fixture so the module
 * can be reviewed before `game/Universe.ts` exists — the fixture specs below
 * are camera test charts, not generated worlds, and nothing else consumes them.
 */
export interface PlanetShotSource {
  rocky?(ctx: EngineContext): PlanetRenderer | null;
  gasGiant?(ctx: EngineContext): PlanetRenderer | null;
}

interface Fixture {
  planet: PlanetRenderer;
  owned: boolean;
  view: MutableViewState;
  sunDir: Vector3;
  sunColor: Color;
  camPos: Vector3;
  camQuat: Quaternion;
  planetPos: Vector3;
}

let fixture: Fixture | null = null;
const shotScratch = new Vector3();

function clearFixture(ctx: EngineContext): void {
  if (!fixture) return;
  if (fixture.owned) {
    ctx.scene.remove(fixture.planet.object3d);
    fixture.planet.dispose();
  }
  fixture = null;
}

/**
 * Tear down whatever fixture the planet shots left in the scene.
 *
 * `scripts/shoot.mjs` drives every shot in one page load, and `Shot` has no
 * teardown hook — so a fixture built by `planet-orbit` is still sitting at the
 * world origin when `sky-*` or `star-*` runs next, and the planet shots sort
 * first. Each `apply()` below clears its predecessor, which covers planet ->
 * planet; this export is the one line the integrator needs so that planet ->
 * anything else is covered too. See the report: the real fix is a
 * `teardown?(ctx)` member on `Shot`, which is not this module's file.
 */
export function clearPlanetShotFixture(ctx: EngineContext): void {
  clearFixture(ctx);
}

/** Point the camera and freeze the pose so no other module can drift it. */
function pose(ctx: EngineContext, from: Vector3, at: Vector3, up: Vector3): { p: Vector3; q: Quaternion } {
  ctx.camera.up.copy(up);
  ctx.camera.position.copy(from);
  ctx.camera.lookAt(at);
  ctx.camera.updateMatrixWorld();
  return { p: from.clone(), q: ctx.camera.quaternion.clone() };
}

function driveFixture(dt: number, ctx: EngineContext): void {
  const f = fixture;
  if (!f) return;
  ctx.camera.position.copy(f.camPos);
  ctx.camera.quaternion.copy(f.camQuat);
  ctx.camera.updateMatrixWorld();

  shotScratch.copy(f.camPos).sub(f.planetPos);
  f.view.set(
    shotScratch,
    f.sunDir,
    f.sunColor,
    ctx.elapsed,
    (ctx.camera.fov * Math.PI) / 180,
    Math.max(1, ctx.height * ctx.renderer.getPixelRatio()),
  );
  if (f.owned) f.planet.update(dt, ctx, f.view);
}

// --- fixture specs ---------------------------------------------------------

const DEMO_ORBIT = {
  semiMajorAxis: 1.496e8,
  eccentricity: 0.017,
  inclination: 0,
  longitudeOfAscendingNode: 0,
  argumentOfPeriapsis: 0,
  meanAnomalyAtEpoch: 0,
  period: 3.156e7,
} as const;

/**
 * A weathered temperate world. Steel-blue and near-black base, one ochre
 * accent, snow only where it has earned it.
 */
function demoTerran(): PlanetSpec {
  return {
    id: 'shot-terran',
    seed: hashSeed(0x5eed1a55, 'shot-terran'),
    name: 'HERON IV',
    type: 'terran',
    radius: 6120,
    mass: 0.94,
    gravity: 9.4,
    orbit: DEMO_ORBIT,
    rotationPeriod: 86400,
    axialTilt: 0.41,
    temperature: 268,
    terrain: {
      // Deliberately mountainous: a high gain keeps energy in the 10–100 km
      // octaves, which is the band the camera sees on a low pass. Realistic
      // fBm (gain ~0.5) puts nearly all the relief at continental scale and
      // looks like a billiard ball from 30 km up.
      frequency: 9,
      octaves: 13,
      lacunarity: 2.06,
      gain: 0.63,
      amplitude: 20,
      ridged: 0.82,
      warp: 0.60,
      craters: 0.03,
      sharpness: 1.10,
      seaLevel: 0.50,
    },
    // Steel-blue and near-black, per §6, with one ochre accent. The hue split
    // between the cool rock (low/mid/cliff) and the warm exposed strata (high)
    // is what stops the land reading as a single grey once the accent has been
    // rationed back to the basins it belongs in.
    palette: {
      low: [0.034, 0.042, 0.050],
      mid: [0.050, 0.060, 0.070],
      high: [0.092, 0.083, 0.068],
      peak: [0.52, 0.55, 0.60],
      cliff: [0.036, 0.040, 0.047],
      polar: [0.70, 0.76, 0.84],
      accent: [0.235, 0.130, 0.048],
    },
    atmosphere: {
      scaleHeight: 8.4,
      thickness: 110,
      rayleigh: [0.0058, 0.0135, 0.0331],
      mie: 0.0021,
      mieAnisotropy: 0.76,
      intensity: 1,
      pressure: 0.92,
    },
    clouds: null,
    ocean: {
      color: [0.042, 0.086, 0.132],
      deepColor: [0.011, 0.030, 0.058],
      specular: 0.85,
      waveHeight: 0.0016,
      emissive: null,
    },
    rings: null,
    moons: [],
    bands: null,
    interest: 0.82,
    blurb: 'Shot fixture.',
    isMoon: false,
  };
}

/**
 * A dry, mountainous world for the low pass. Deliberately a *different* fixture
 * from the orbit planet: a disc read from three radii out wants continent-scale
 * features, and a camera 24 km up wants ten times the energy at ten times the
 * frequency. One spectrum cannot be best at both, and a shot is a camera test
 * chart, not a world.
 */
function demoHighlands(): PlanetSpec {
  const t = demoTerran();
  return {
    ...t,
    id: 'shot-highlands',
    seed: hashSeed(0x5eed1a55, 'shot-highlands'),
    name: 'HERON IV — SIRACH RANGE',
    type: 'rocky',
    temperature: 244,
    // Note which band is which: on this spec the terrain sits high above its
    // datum, so `high` is the band that fills the frame and it is therefore the
    // one that has to carry §6's cold steel base — grey exposed bedrock on the
    // massif. The warm oxidised tone goes on `mid`, the lowland shoulders,
    // where it is a minority of the frame. That is the same read the Andes give
    // from the air, and it costs nothing; raising seaLevel to move the bands
    // instead would have planed the mountains flat.
    palette: {
      low: [0.028, 0.035, 0.044],
      mid: [0.088, 0.078, 0.062],
      high: [0.050, 0.058, 0.068],
      peak: [0.46, 0.49, 0.55],
      cliff: [0.026, 0.029, 0.035],
      polar: [0.66, 0.72, 0.80],
      accent: [0.215, 0.122, 0.046],
    },
    terrain: {
      ...t.terrain,
      frequency: 21,
      octaves: 13,
      gain: 0.62,
      amplitude: 22,
      ridged: 0.86,
      warp: 0.72,
      // Left at 0.30 deliberately. seaLevel is not just a palette datum here —
      // os_tSeaFloor flattens everything beneath it into a continental-slope
      // profile, so raising it to put the elevation bands in frame also planes
      // the mountains this shot exists to show. The bands are placed by the
      // palette below instead, which costs nothing.
      seaLevel: 0.30,
    },
    // No sea: a mirror-flat plate of water eats half the frame and carries
    // none of the LOD detail this shot exists to show.
    ocean: null,
    interest: 0.35,
  };
}

/** A Jupiter-class banded giant with a long-lived vortex. */
function demoGasGiant(): PlanetSpec {
  return {
    id: 'shot-giant',
    seed: hashSeed(0x5eed1a55, 'shot-giant'),
    name: 'CORVID',
    type: 'gas-giant',
    radius: 58200,
    mass: 244,
    gravity: 23.1,
    orbit: DEMO_ORBIT,
    rotationPeriod: 35400,
    axialTilt: 0.05,
    temperature: 128,
    terrain: {
      frequency: 1,
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
      amplitude: 0,
      ridged: 0,
      warp: 0,
      craters: 0,
      sharpness: 1,
      seaLevel: 0.5,
    },
    palette: {
      low: [0.05, 0.05, 0.06],
      mid: [0.10, 0.09, 0.09],
      high: [0.16, 0.14, 0.13],
      peak: [0.30, 0.28, 0.26],
      cliff: [0.08, 0.07, 0.07],
      polar: [0.12, 0.14, 0.18],
      accent: [0.34, 0.14, 0.07],
    },
    atmosphere: null,
    clouds: null,
    ocean: null,
    rings: null,
    moons: [],
    bands: {
      count: 11,
      turbulence: 1.15,
      shearSpeed: 0.0075,
      stormCount: 3,
      // Near-neutral on purpose. A Jupiter-brown body plus a red storm is two
      // warm hues and no accent: §6 wants the saturated element to be alone in
      // the frame. Desaturating the belts to steel leaves the vortex as the
      // only colour on the disc, which is also what makes it read as a feature
      // rather than as a slightly different stripe.
      palette: [
        [0.052, 0.056, 0.066],
        [0.140, 0.142, 0.145],
        [0.082, 0.086, 0.094],
        [0.215, 0.216, 0.218],
        [0.112, 0.104, 0.098],
        [0.262, 0.258, 0.250],
      ],
    },
    interest: 0.4,
    blurb: 'Shot fixture.',
    isMoon: false,
  };
}

function makeFixture(ctx: EngineContext, spec: PlanetSpec, provided: PlanetRenderer | null): Fixture {
  const planet = provided ?? new PlanetRenderer(spec, ctx.quality);
  const owned = provided === null;
  if (owned) ctx.scene.add(planet.object3d);
  return {
    planet,
    owned,
    view: new MutableViewState(),
    sunDir: new Vector3(1, 0, 0),
    // Irradiance, not a colour: rock albedo is ~0.1, so the lit side needs a
    // few units of light before the tone map has anything to work with.
    sunColor: new Color(1.0, 0.955, 0.90).multiplyScalar(2.3),
    camPos: new Vector3(),
    camQuat: new Quaternion(),
    planetPos: planet.object3d.position.clone(),
  };
}

/**
 * Search the sphere for the most photogenic ground: high, above water, steep,
 * and away from the ice. Deterministic — same seed, same landing site, so the
 * approach shot is reproducible frame for frame.
 */
function findRelief(planet: PlanetRenderer, seed: number): { dir: Vector3; height: number } {
  const rng = new Rng(hashSeed(seed, 'hero-site'));
  const d = new Vector3();
  const t1 = new Vector3();
  const t2 = new Vector3();
  const probe = new Vector3();
  const best = new Vector3(0, 0, 1);
  let bestScore = -Infinity;
  let bestH = 0;

  for (let i = 0; i < 700; i++) {
    const s = rng.onSphere();
    d.set(s[0], s[1], s[2]);
    const h = planet.sampleHeight(d);
    if (h <= 1.0) continue; // dry land, well clear of the shoreline

    // Tangent basis for a ~24 km probe ring.
    t1.set(0, 1, 0).cross(d);
    if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
    t1.normalize();
    t2.copy(d).cross(t1);
    const step = 24 / planet.spec.radius;

    // Probe two rings: 8 km catches ridge lines, 30 km catches whole ranges.
    let lo = Infinity;
    let hi = -Infinity;
    for (let ring = 0; ring < 2; ring++) {
      const rad = ring === 0 ? step * (8 / 24) : step * (30 / 24);
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3 + ring * 0.5;
        probe
          .copy(d)
          .addScaledVector(t1, Math.cos(a) * rad)
          .addScaledVector(t2, Math.sin(a) * rad)
          .normalize();
        const hp = planet.sampleHeight(probe);
        if (hp < lo) lo = hp;
        if (hp > hi) hi = hp;
      }
    }

    if (lo <= 0.15) continue; // no coast in the near field: water flattens the shot
    const relief = hi - lo;
    const polar = Math.abs(d.y);
    // Aim for mid-altitude mountains: the snow line blows out to white and
    // the plains have nothing to cast a shadow.
    const score = relief * 7.0 - Math.abs(h - 2.6) * 0.55 - Math.max(0, polar - 0.55) * 22;
    if (score > bestScore) {
      bestScore = score;
      bestH = h;
      best.copy(d);
    }
  }
  return { dir: best, height: bestH };
}

export function registerPlanetShots(source: PlanetShotSource = {}): void {
  registerShot({
    name: 'planet-orbit',
    description:
      'Whole disc from three radii out, terminator cutting across frame. Tests contrast, ' +
      'the palette, the hard day/night line, sun-reddened grazing light and the night-side ' +
      'settlement lights.',
    apply(ctx) {
      clearFixture(ctx);
      const f = makeFixture(ctx, demoTerran(), source.rocky?.(ctx) ?? null);
      fixture = f;

      const R = f.planet.spec.radius;
      // 2.70 radii. A previous pass pulled in to 1.50 to close an 858-pixel
      // column of empty sky, but that trades one §6 failure for a worse one:
      // at 1.50 radii the disc subtends 83.6 degrees against a 62 degree
      // vertical field, so the planet cannot be whole in frame at all and the
      // shot stops being the whole-disc test its own description promises —
      // the curvature survives only in one corner, which reads as a flat wall,
      // not a world. At 2.70 the disc subtends 43.4 degrees and fills about
      // 70% of frame height: entire, unmistakably spherical, with room for the
      // terminator to run.
      //
      // The empty gutter is a COMPOSITION problem and is solved by composing:
      // the disc sits low-left, the terminator runs corner to corner, and the
      // remaining sky carries the galactic band and the night-side lights
      // rather than being flat void.
      const from = shotScratch.set(0.28, 0.30, 1).normalize().multiplyScalar(R * 2.7).clone();
      from.add(f.planetPos);
      // Aim off-centre so the disc sits low-left and the terminator runs
      // corner to corner instead of splitting the frame in half. The offset is
      // an angle, not a length, so it scales with the range.
      const at = f.planetPos.clone().addScaledVector(new Vector3(0.30, 0.22, 0).normalize(), R * 0.62);
      const p = pose(ctx, from, at, new Vector3(0, 1, 0));
      f.camPos.copy(p.p);
      f.camQuat.copy(p.q);

      // Star nearly side-on and slightly behind — a 96 degree phase angle, so
      // a little under half the visible disc is lit. Pushed back from the old
      // 74 degrees on purpose: the sunward limb now runs almost exactly along
      // the edge of the disc, which is the geometry that makes the atmosphere
      // ring read as a silver lining rather than as a slightly brighter edge,
      // and it hands the night side enough of the frame for the settlement
      // lights to be a second, cooler light source instead of a curiosity.
      f.sunDir.set(-0.86, 0.30, 0.05).normalize();
      driveFixture(0, ctx);
    },
    update: driveFixture,
  });

  registerShot({
    name: 'planet-approach',
    description:
      'Twenty-four kilometres over the highest relief on the planet with the star nine degrees ' +
      'above the horizon. Tests deep LOD, terrain shadows, micro-detail normals and the ' +
      'curvature of the horizon.',
    apply(ctx) {
      clearFixture(ctx);
      const f = makeFixture(ctx, demoHighlands(), source.rocky?.(ctx) ?? null);
      fixture = f;

      const R = f.planet.spec.radius;
      const site = findRelief(f.planet, f.planet.spec.seed);
      const up = site.dir.clone();

      // Local frame: forward is the direction we fly, east is to the right.
      const east = new Vector3(0, 1, 0).cross(up);
      if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
      east.normalize();
      const forward = new Vector3().crossVectors(up, east).normalize();

      // 34 km rather than 24: the horizon dip grows from 5.1 to 6.0 degrees, so
      // the skyline droops ~34 px across the frame instead of ~28 and reads as
      // the edge of a sphere rather than the edge of a heightmap.
      const from = up.clone().multiplyScalar(R + site.height + 34).add(f.planetPos);
      // 23 degrees of down-pitch, not 10. At 10 the horizon sat at y=430 and
      // gave 37% of the frame to empty black sky with nothing in it — §6 again.
      // At 23 it sits near y=270, the near ground closes to ~25 km and fills
      // the bottom of the frame, and the shot gets the foreground occluder it
      // never had. This module cannot draw a hull strut or a ring plane; it can
      // at least put its own terrain in the way.
      const pitch = 0.40;
      const look = forward.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(up, -Math.sin(pitch));
      const at = from.clone().addScaledVector(look, 400);
      // A few degrees of bank. A horizon exactly parallel to the frame edge for
      // 1920 px is the single strongest "this is a tech demo turntable" cue in
      // the set, and a ship in atmosphere is never wings-level for free.
      const upRolled = up.clone().applyAxisAngle(look, 0.075);
      const p = pose(ctx, from, at, upRolled);
      f.camPos.copy(p.p);
      f.camQuat.copy(p.q);

      // Sun 9 degrees up, raking across from the left and slightly ahead: the
      // shadows run towards camera-right and every ridge gets a bright edge.
      f.sunDir
        .copy(east)
        .multiplyScalar(-0.80)
        .addScaledVector(forward, 0.60)
        .normalize()
        .multiplyScalar(Math.cos(0.157))
        .addScaledVector(up, Math.sin(0.157))
        .normalize();
      driveFixture(0, ctx);
    },
    update: driveFixture,
  });

  registerShot({
    name: 'gas-giant',
    description:
      'Banded giant with a cyclonic storm left of centre and the terminator entering from ' +
      'the right. Tests the zonal flow field, the shear between jets, the vortex and limb ' +
      'darkening.',
    apply(ctx) {
      clearFixture(ctx);
      const f = makeFixture(ctx, demoGasGiant(), source.gasGiant?.(ctx) ?? null);
      fixture = f;

      const R = f.planet.spec.radius;
      const axes = f.planet.stormAxes();
      const storm = (axes[0] ?? new Vector3(0.45, 0.35, 0.82)).clone().normalize();

      const pole = new Vector3(0, 1, 0);
      const east = new Vector3().crossVectors(pole, storm).normalize();

      const camDir = storm.clone().addScaledVector(east, 0.46).addScaledVector(pole, 0.12).normalize();
      // 1.35 radii, not 1.80. At 1.80 the disc subtended 33.7 degrees and its
      // right limb landed at x~1450, dumping a ~470 px black column down the
      // side of the frame. At 1.35 it subtends 47.8 degrees, bleeds off three
      // edges, and the gutter the terminator enters through comes down to
      // ~230 px — a margin, not a void.
      const from = camDir.clone().multiplyScalar(R * 1.35).add(f.planetPos);
      // Same reasoning as planet-orbit: the aim offset is an angle, so it has
      // to grow with the closer range to hold the disc's right limb in frame.
      const at = f.planetPos.clone().addScaledVector(east, R * 0.227);
      const p = pose(ctx, from, at, pole);
      f.camPos.copy(p.p);
      f.camQuat.copy(p.q);

      // Sub-solar point well to the west: the storm stays lit, the terminator
      // sweeps in from the right-hand limb.
      f.sunDir.copy(camDir).addScaledVector(east, -1.55).addScaledVector(pole, 0.22).normalize();
      driveFixture(0, ctx);
    },
    update: driveFixture,
  });
}
