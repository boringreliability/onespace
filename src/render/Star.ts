/**
 * The star: photosphere, chromosphere, corona, prominences, glare — and the
 * exotica (white dwarf, neutron star, black hole).
 *
 * DESIGN NOTES
 *
 * *Everything is physically sized.* The photosphere is a real sphere of
 * `spec.radius * SOLAR_RADIUS` kilometres, so its angular size falls off as
 * 1/d exactly like the real thing: at 0.1 AU a G star is a 4°-wide disc with
 * visible granulation, at 40 AU it is a sub-pixel point carried by its glare.
 * Nothing here is a fixed-size billboard except the *screen-space* flare, which
 * is a camera artefact and therefore belongs in screen space.
 *
 * *Brightness comes from temperature, not from a colour picker.* Granules,
 * faculae and sunspots perturb a local temperature scale; colour is
 * `os_blackbody(T)` and radiance is `T^4` (Stefan–Boltzmann). That is why the
 * spots go orange as they darken and the granule interiors go blue-white as
 * they brighten — you cannot get that by lerping two hand-picked colours.
 *
 * *The black hole is the showpiece.* It has no photosphere. Instead it copies
 * whatever has already been drawn into a `FramebufferTexture` and re-samples it
 * along gravitationally deflected rays: weak-field 2Rs/b far out, the strong
 * deflection log-divergence near the photon sphere, a hard shadow inside
 * b = 3√3/2·Rs and a photon ring just outside it. The accretion disc is drawn
 * in two passes — far half before the lens (so it gets bent up and over the
 * hole, the Interstellar arc) and near half after it (so the front rim crosses
 * the shadow).
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Camera,
  Color,
  CylinderGeometry,
  DoubleSide,
  FramebufferTexture,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  RGBAFormat,
  RingGeometry,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
  type IUniform,
  type Scene,
} from 'three';

import type { EngineContext } from '@/core/Engine';
import type { QualitySettings } from '@/core/Config';
import { AU, SOLAR_RADIUS, type StarSpec } from '@/gen/types';
import { Rng } from '@/math/rng';
import { registerShaderChunks } from '@/shaders/chunks';
import { registerShot } from '@/game/Shots';
import { MutableViewState, type ViewState } from './ViewState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schwarzschild radius per solar mass, in kilometres: 2GM☉/c². */
const RS_PER_SOLAR_MASS = 2.953;

/** Impact parameter of the photon sphere, in Schwarzschild radii: 3√3/2. */
const PHOTON_B = 2.598076211;

type StarKind = 'normal' | 'wd' | 'ns' | 'bh';

function tierIndex(q: QualitySettings): number {
  switch (q.tier) {
    case 'low':
      return 0;
    case 'medium':
      return 1;
    case 'high':
      return 2;
    default:
      return 3;
  }
}

function kindOf(spec: StarSpec): StarKind {
  if (spec.spectralClass === 'BH') return 'bh';
  if (spec.spectralClass === 'NS') return 'ns';
  if (spec.spectralClass === 'WD') return 'wd';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Shared GLSL fragments
// ---------------------------------------------------------------------------

/** Vertex shader used by every world-space piece that needs depth. */
const WORLD_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNrm;

void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

/** Full-screen triangle-ish quad that ignores every matrix. */
const SCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Photosphere
// ---------------------------------------------------------------------------

const PHOTOSPHERE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uTemp;
uniform float uIntensity;
uniform float uGranAmp;
uniform float uGranScale;
uniform float uDetail;      // fractional octave count, driven by screen LOD
uniform float uSpotThresh;
uniform float uSpotDepth;
uniform float uFlow;
uniform vec2  uLimb;        // quadratic limb-darkening coefficients (a, b)
uniform vec3  uRim;         // chromospheric rim colour

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNrm;

void main() {
  #include <logdepthbuf_fragment>

  vec3 nrm = normalize(vNrm);
  vec3 V = normalize(cameraPosition - vWorld);
  // mu = cos(theta) between the surface normal and the line of sight. This is
  // the only quantity limb darkening depends on.
  float mu = clamp(dot(nrm, V), 0.0, 1.0);

  vec3 unit = normalize(vObj);
  vec3 p = unit * uGranScale;
  float t = uTime * uFlow;

  // One shared warp vector bends the cell walls into the sinuous shapes real
  // convection has, for the price of three snoise calls instead of 3 per octave.
  vec3 wv = vec3(
    os_snoise(p * 0.30 + vec3(0.0, 0.0, t * 0.22)),
    os_snoise(p * 0.30 + vec3(19.3, 7.1, t * 0.19)),
    os_snoise(p * 0.30 + vec3(3.7, 27.9, t * 0.17))
  ) * 0.55;

  // Foreshortening compresses the surface into 1/mu times fewer pixels near the
  // limb, so the octave budget has to fall off with mu as well as with
  // distance. Without this the limb is a band of aliased salt-and-pepper.
  float lod = uDetail + log(clamp(mu, 0.02, 1.0)) / log(2.6);

  float gran = 0.0;
  float wsum = 0.0;
  float freq = 1.0;
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    float w = clamp(lod - float(i), 0.0, 1.0);
    if (w <= 0.0) break;
    // Advecting along +z walks through the 3D field, so cells are born, drift
    // and die rather than sliding rigidly across the surface. Small cells
    // evolve faster, exactly as convective turnover time scales with size.
    vec3 q = (p + wv) * freq + vec3(0.0, 0.0, t * freq * 0.85);
    vec2 cw = os_worley(q);
    // cw.y = F2-F1 = distance to the cell wall, cw.x = distance to the cell
    // seed. The mapping matters more than the noise: a *wide* ramp on the wall
    // mask (as this had) saturates over almost the whole cell and leaves a flat
    // plateau with a hairline crack in it, which is what a granule must never
    // look like. The lane is a narrow dark feature and the dome is a broad
    // bright one, so the ramps have to be the other way round.
    float lane = smoothstep(0.0, 0.13, cw.y);
    float dome = 1.0 - smoothstep(0.02, 0.78, cw.x);
    // Pedestal chosen so the octave is zero-mean: without that the whole disc
    // is offset and only the tail of the distribution reads as texture.
    gran += amp * w * (lane * 0.55 + dome * 0.95 - 0.80);
    wsum += amp * w;
    freq *= 2.6;
    amp *= 0.52;
  }
  gran /= max(wsum, 1e-4);
  gran *= smoothstep(0.0, 0.16, mu);

  // Active regions. A low-frequency field thresholded twice gives umbra inside
  // penumbra; the threshold is what spec.activity actually controls. The two
  // thresholds have to be *separated* by more than the width of either ramp or
  // the umbra swallows the penumbra and a spot becomes a brown smudge with no
  // structure — which is exactly what the first pass shipped.
  float spotN = os_fbm(unit * 1.7 + vec3(4.3, 1.1, 9.7), 4, 2.1, 0.55);
  // Break the threshold contour with the granulation field so the spot boundary
  // is ragged. A perfectly smooth iso-contour of low-frequency fBm is an ink
  // blot; real penumbrae are frayed by the convection they are suppressing.
  float spotEdge = spotN + gran * 0.10;
  float pen = smoothstep(uSpotThresh, uSpotThresh + 0.30, spotEdge);
  float umb = smoothstep(uSpotThresh + 0.30, uSpotThresh + 0.46, spotEdge);
  // Contrast washes out towards the limb — partly foreshortening, partly the
  // fact that you are looking through more of the hot chromosphere above them.
  float limbFade = smoothstep(0.0, 0.30, mu);
  float spot = (0.45 * pen + 0.55 * umb) * uSpotDepth * limbFade;
  // Faculae: the bright magnetic network that rings a spot group. It is the
  // *only* term that goes bright at the limb, and it is what stops the outer
  // disc being a clean darkening ramp.
  float fac = smoothstep(uSpotThresh - 0.26, uSpotThresh - 0.02, spotN) * (1.0 - pen)
            * mix(1.0, 1.8, 1.0 - limbFade) * smoothstep(0.0, 0.10, mu);

  // Supergranulation-scale temperature provinces. Deliberately *not* under the
  // screen-space LOD: the granulation above fades out entirely once its cells
  // drop under a few pixels, and past that point limb darkening on its own is a
  // textbook smooth radial gradient — the exact flat field section 6 forbids.
  // These octaves are what keeps large-scale value structure on the disc at
  // every distance where the star is more than a handful of pixels wide, so
  // they carry roughly as much amplitude as the granulation itself.
  // (Reusing the granulation's warp vector rather than calling os_warp again:
  // it is the right scale already and three snoise calls are not free.)
  float prov = os_fbm(unit * 3.1 + wv * 0.5 + vec3(17.0, 2.3, 5.9), 3, 2.3, 0.55)
             * smoothstep(0.0, 0.10, mu);

  // Everything above is a *temperature* perturbation. Colour and radiance then
  // follow from physics rather than from taste. T^4 turns a +/-6% temperature
  // ripple into a +/-25% radiance ripple, so this is where the disc stops being
  // a beige ball; anything much smaller vanishes under the film grain.
  float tScale = 1.0 + (gran + prov * 0.70) * uGranAmp + fac * 0.075 - spot * 0.42;
  tScale = max(tScale, 0.30);

  vec3 col = os_blackbody(uTemp * tScale);
  float radiance = pow(tScale, 4.0);

  float om = 1.0 - mu;
  float ld = max(1.0 - uLimb.x * om - uLimb.y * om * om, 0.0);

  vec3 rgb = col * (radiance * ld * uIntensity);

  // A hair of chromosphere bleeding around the very edge of the disc.
  rgb += uRim * pow(1.0 - mu, 7.0) * uIntensity * 0.20;

  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Corona + chromosphere
// ---------------------------------------------------------------------------

const CORONA_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform vec3 uRight;
uniform vec3 uUp;
uniform float uSizeKm;
uniform float uMaxR;

varying vec3 vP;   // position in the view plane, in stellar radii

void main() {
  vec3 dir = uRight * position.x + uUp * position.y;
  vP = dir * uMaxR;
  vec4 wp = modelMatrix * vec4(dir * uSizeKm, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const CORONA_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uTemp;
uniform float uIntensity;
uniform float uActivity;
uniform float uMaxR;
uniform float uChromo;
uniform float uSilR;      // apparent silhouette radius of the disc, in stellar radii
uniform int   uOct;
uniform vec3  uAxis;

varying vec3 vP;

void main() {
  #include <logdepthbuf_fragment>

  // The quad lies in the plane through the star's centre, so a point at quad
  // radius 1 is *behind* the sphere and is killed by the depth test: the
  // silhouette actually sits at 1/sqrt(1-(R/d)^2). Measuring radius against the
  // silhouette instead of against the geometric radius is what makes the thin
  // chromospheric shell visible at all — before this it was entirely occluded
  // by the photosphere it is supposed to be sitting on.
  float rw = length(vP);                 // radius in the quad's own units
  float r = rw / max(uSilR, 1.0);        // radius measured against the silhouette
  float rr = max(r, 1.0);
  vec3 nd = vP / max(rw, 1e-4);

  // Sampling a *direction* makes every feature a perfect ray from the centre —
  // that is what makes streamers streamers, and it is also why the first pass
  // was a fan of dead-straight smears with nothing but one scale in it. Bending
  // the sampling direction tangentially by an amount that grows with radius
  // makes each streamer bow away from the radial, so they lean, cross and
  // converge the way field lines do. cross(noise, nd) is tangential by
  // construction, so the bend never stretches the ray, it only shears it.
  vec3 c1 = vec3(
    os_snoise(nd * 1.10 + vec3(0.0, 0.0, uTime * 0.004)),
    os_snoise(nd * 1.10 + vec3(11.7, 3.1, 0.0)),
    os_snoise(nd * 1.10 + vec3(2.3, 19.4, 0.0))
  );
  vec3 tang = cross(c1, nd);
  vec3 bend = normalize(nd + tang * (0.07 + 0.30 * log(rr)));
  vec3 sp = bend * 2.15 + bend * log(rr) * 0.30 + vec3(0.0, uTime * 0.006, 0.0);

  float f1 = os_fbm(sp * 0.85, uOct, 2.15, 0.55) * 0.5 + 0.5;
  float f2 = os_ridged(sp * 1.9 + 11.0, uOct - 1, 2.3, 0.5) * 0.5 + 0.5;
  // Wide dynamic range between streamer and coronal hole: an even fringe of
  // hair around the disc is the tell that this is a shader and not a corona.
  // Cubed rather than squared, and with the floor taken most of the way to
  // zero, so the gaps between streamers are genuinely empty.
  float streak = mix(0.03, 1.45, f1 * f1 * f1) * mix(0.40, 1.6, f2);

  // A quiet star's corona is a pair of equatorial streamers with polar holes;
  // an active one fills in. Without this it reads as a clean glow ring — and
  // with the old lat^2 / 0.16 floor the "holes" were still at 40% of the belt,
  // which at a glance is not a hole at all.
  float lat = abs(dot(nd, normalize(uAxis)));
  float belt = mix(mix(1.0, 0.05, pow(lat, 1.5)), 1.0, uActivity * 0.30);

  // Per-streamer falloff exponent — a single global exponent is the giveaway.
  float n = mix(5.4, 3.0, f1);
  // The shallow r^-2 component is the *outer* corona, and it is the only thing
  // carrying the far half of the frame. At -2.4 x 0.16 it had died by 3 R and
  // left bare grain; a real K-corona is still visible at 10 R.
  float k = pow(rr, -n) * 1.10 + pow(rr, -2.05) * 0.30 * f2;
  float d = k * streak * belt;

  // Arcades: closed loop systems over the active latitudes. They are an order
  // of magnitude larger than a streamer and they do not radiate away — they
  // arch and come back — which is the scale the corona was missing entirely.
  float arc = os_fbm(bend * 0.95 + vec3(31.0, 5.0, uTime * 0.003), 2, 2.3, 0.55) * 0.5 + 0.5;
  arc = smoothstep(0.54, 0.90, arc);
  float arcH = (rr - 1.24) / 0.34;   // squared by multiplication: pow() with a
  d += arc * exp(-arcH * arcH) * 0.55 * belt;   // negative base is undefined here

  // The chromosphere: a very thin, very red shell right on the limb.
  float chromo = exp(-(rr - 1.0) * 48.0) * uChromo;

  // Steel-blue: the corona is the cool half of the frame's two-tone palette,
  // against the warm cream of the photosphere.
  vec3 cCor = mix(os_blackbody(max(uTemp, 5200.0)), vec3(0.58, 0.74, 1.0), 0.78);
  vec3 cChr = mix(vec3(1.0, 0.23, 0.15), vec3(0.60, 0.76, 1.0),
                  smoothstep(6500.0, 13000.0, uTemp));

  vec3 col = cCor * d + cChr * chromo * 1.6;
  col *= uIntensity;
  // Fade the quad out well before its own edge so the square never shows.
  // Written edge0 < edge1: smoothstep with a descending pair is undefined by
  // the GLSL ES spec even though every desktop driver clamps its way through it.
  // Starting the fade at 0.55 of the quad cut the outer corona off a long way
  // inside the frame; 0.78 lets it run to the frame edge and die there instead.
  // ...against the quad's own radius, never the silhouette-normalised one, or
  // the fade misses the corner and the square shows.
  col *= 1.0 - smoothstep(uMaxR * 0.78, uMaxR, rw);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Prominences
// ---------------------------------------------------------------------------

const PROM_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec3 aParams;   // (seed, thickness, morph speed)

varying vec2 vQuad;
varying vec3 vPar;
varying float vLimb;

void main() {
  vQuad = uv;
  vPar = aParams;

  mat4 im = modelMatrix * instanceMatrix;
  vec4 wp = im * vec4(position, 1.0);
  vec3 radial = normalize((im * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 base = (im * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 V = normalize(cameraPosition - base);
  // Loops only read as loops when they stand off the limb. Face-on they are a
  // smear on the disc, so fade them out there.
  vLimb = 1.0 - clamp(abs(dot(radial, V)), 0.0, 1.0);

  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const PROM_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uIntensity;

varying vec2 vQuad;
varying vec3 vPar;
varying float vLimb;

void main() {
  #include <logdepthbuf_fragment>

  float x = vQuad.x - 0.5;
  float y = vQuad.y;
  // Per-instance lean and eccentricity: identical loops around the limb read as
  // a ring of decals, which is exactly what a prominence must not look like.
  //
  // The semi-axes are the whole ballgame. At (0.30..0.50, 0.92) the e = 1
  // contour ran *through* the quad border, so the Gaussian band around it, plus
  // its noise displacement, was sliced off by the quad on the top and both
  // sides — the salmon rectangle in the review. The arc now has to fit inside
  // the unit quad together with the widest band it can grow (out to the alpha
  // cut below) and the largest radial displacement the noise can apply, which
  // caps the semi-axes at (0.27, 0.62): worst case the arc reaches x = 0.40 and
  // y = 0.85, both inside the envelope at the bottom of this function.
  float lean = (vPar.x - 0.5) * 0.42;
  float ax = mix(0.19, 0.27, vPar.x);
  vec2 e2 = vec2((x - y * lean) / ax, y / 0.62);
  float e = length(e2);

  vec3 np = vec3(x * 3.0, y * 2.2, vPar.x * 37.0 + uTime * vPar.z);
  float nz = os_fbm(np, 4, 2.2, 0.55);
  // Displace the arc radius by noise: plasma follows kinked field lines, never
  // a clean semicircle.
  float ed = e + nz * 0.16;

  float w = vPar.y * (0.45 + 1.35 * y);
  float band = exp(-pow(abs(ed - 1.0) / max(w, 1e-3), 2.0));
  // A second, thinner strand offset inwards — loops come in bundles.
  float band2 = exp(-pow(abs(ed - 0.82 - nz * 0.06) / max(w * 0.55, 1e-3), 2.0)) * 0.55;
  // No pedestal. The 0.35 floor this used to carry meant the strand field could
  // only dim the arc, never break it, so every loop was a continuous airbrushed
  // ribbon *and* the alpha could not reach zero anywhere. Both halves of that
  // sentence were visible in the frame.
  float fil = os_fbm(np * 4.1 + 5.0, 3, 2.3, 0.5) * 0.5 + 0.5;
  float strands = smoothstep(0.20, 0.74, fil);
  // One octave of much finer structure so the strands themselves are threaded
  // rather than smooth.
  strands *= 0.60 + 0.40 * (os_snoise(np * 13.0 + 21.0) * 0.5 + 0.5);
  float foot = smoothstep(0.0, 0.10, y);
  // Material drains back down the field lines, so the crown is always thinner.
  float drain = 1.0 - 0.55 * smoothstep(0.15, 1.0, y);

  float a = (band + band2) * strands * foot * drain * pow(vLimb, 2.2);
  // A Gaussian never reaches zero, so a few per cent of alpha survived all the
  // way to the quad's own corners. Clip the tail and renormalise: below this
  // level the plasma is thinner than the film grain anyway.
  a = max(a - 0.04, 0.0) / 0.96;
  // Belt and braces — an explicit guarantee that nothing at all is emitted at
  // the quad boundary, whatever the noise does. With the geometry above this
  // only ever trims values that are already near zero, so it costs no shape.
  // Both smoothsteps written edge0 < edge1 and inverted: a descending pair is
  // undefined by the GLSL ES spec, however reliably desktop drivers clamp it.
  a *= (1.0 - smoothstep(0.40, 0.50, abs(x))) * (1.0 - smoothstep(0.86, 1.00, y));

  // H-alpha. This is the one saturated accent the star is allowed.
  // Hot, near-white footpoints grading into deep H-alpha as the plasma cools
  // on its way up the loop. This is the frame's single saturated accent.
  vec3 col = mix(vec3(1.0, 0.55, 0.30), vec3(1.0, 0.12, 0.07), smoothstep(0.0, 0.55, y))
           * a * uIntensity;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Neutron star beams
// ---------------------------------------------------------------------------

const BEAM_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uIntensity;
uniform float uLen;

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNrm;

void main() {
  #include <logdepthbuf_fragment>

  float h = clamp(vObj.y / uLen, 0.0, 1.0);
  vec3 V = normalize(cameraPosition - vWorld);
  // Limb-brightened shell: a hollow cone is bright where you look along its wall.
  float edge = 1.0 - abs(dot(normalize(vNrm), V));

  float ang = atan(vObj.z, vObj.x);
  float nz = os_fbm(vec3(cos(ang) * 2.0, sin(ang) * 2.0, h * 5.0 - uTime * 1.4),
                    4, 2.2, 0.55) * 0.5 + 0.5;

  float a = pow(max(edge, 0.0), 1.7) * (0.35 + 0.95 * nz) * exp(-h * 2.6) * (1.0 - h);
  vec3 col = mix(vec3(0.62, 0.80, 1.0), vec3(0.90, 0.95, 1.0), 1.0 - h) * a * uIntensity;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// Accretion disc
// ---------------------------------------------------------------------------

const DISC_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <onespace_noise>
#include <onespace_color>

uniform float uTime;
uniform float uRs;
uniform float uRin;
uniform float uRout;
uniform float uTempIn;
uniform float uIntensity;
uniform float uHalf;      // +1 weight the far half, -1 the near half, 0 all of it
uniform float uFeather;   // km over which the two passes cross-fade
uniform float uPixAngle;  // fovY / viewport height, radians per pixel
uniform int   uOct;

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vCentre;

void main() {
  #include <logdepthbuf_fragment>

  float r = length(vObj.xy);
  if (r < uRin || r > uRout) discard;

  vec3 V = normalize(vWorld - cameraPosition);
  // Positive => this patch of disc is on the far side of the hole from us.
  float side = dot(vWorld - vCentre, V);
  // The two passes must sum to exactly one everywhere, or the split shows up as
  // a straight bar across the disc. Complementary smoothsteps do that for free.
  float halfW = uHalf == 0.0 ? 1.0 : smoothstep(-uFeather, uFeather, side * uHalf);
  if (halfW <= 0.001) discard;

  float phi = atan(vObj.y, vObj.x);
  float rr = r / uRs;

  // Keplerian shear: the inner disc laps the outer one, which is what smears
  // the turbulence into spiral filaments instead of concentric rings.
  float omega = pow(max(rr, 1.0), -1.5) * 6.0;
  float ph = phi + uTime * omega;
  // The two halves of this coordinate are now cleanly separated: xy is purely
  // azimuthal, z is purely radial. That separation is what lets the LOD below
  // treat the two directions differently, which it has to, because at a grazing
  // view they are undersampled by wildly different amounts. (The old version
  // grew the xy ring radius with log(r) as well, which smuggled radial
  // variation into the azimuthal axis and made that impossible.)
  vec3 np = vec3(cos(ph), sin(ph), 0.0) * 2.6
          + vec3(0.0, 0.0, log(max(rr, 1.0)) * 2.6);

  // ---- Screen-space LOD -------------------------------------------------
  // The photosphere has had one of these from the start; the disc never did,
  // and it is the disc that needs it most. Seen ten degrees above the plane a
  // single pixel spans an enormous *radial* extent, so a fixed 8.5x octave was
  // sampled far under Nyquist and folded into the tight concentric arcs the
  // review saw. This is the cause of the moire, not a filter over it.
  vec3 Vw = vWorld - cameraPosition;
  float dist = length(Vw);
  // How obliquely we hit the plane. 0.012 caps the footprint at the exact
  // grazing limit rather than letting it run to infinity.
  float graze = max(abs(dot(normalize(vNrm), Vw / max(dist, 1e-4))), 0.012);
  float pxTan = dist * uPixAngle;             // km per pixel across the ray
  float pxRad = pxTan / graze;                // km per pixel along the plane
  // |d np / dr| = 2.6 / r along z; |d np / dphi| = 2.6 per radian in xy.
  float dR = pxRad * 2.6 / max(r, 1.0);
  float dA = pxTan * 2.6 / max(r, 1.0);
  // The octave index at which one cycle covers exactly two pixels, per axis.
  // weight = clamp(lod - i, 0, 1) therefore puts the zero crossing on Nyquist
  // and full weight at four pixels per cycle. Fading by *amplitude* rather than
  // by octave count matters: stepping the count would drop a visible ring at
  // every integer crossing, which is the same disease in a different costume.
  float lodA = -log2(max(dA * 2.4 * 2.0, 1e-6));
  float lodR = -log2(max(dR * 2.4 * 2.0, 1e-6));

  // A weighted, band-limited sum replaces the two fixed-frequency fbm calls and
  // is no more expensive than they were (uOct+1 snoise against uOct + uOct-2).
  // The octave *count* follows the azimuthal limit and the radial axis is
  // squashed per octave to satisfy the radial one — so instead of the disc
  // going smooth at grazing angles, its detail survives as filaments stretched
  // along the flow. Keplerian shear does exactly that to real plasma, so the
  // anti-aliasing measure and the physics happen to want the same picture.
  float sum = 0.0;
  float nw = 0.0;
  float nfq = 1.0;
  float namp = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uOct) break;
    float w = clamp(lodA - float(i), 0.0, 1.0);
    if (w <= 0.0) break;
    // Lacunarity is exactly 2 so that this cancels the 2^i in nfq and every
    // octave lands on the same radial sample rate — 0.33 cycles per pixel —
    // instead of creeping back over Nyquist as i climbs.
    float sq = clamp(exp2(lodR - float(i) - 0.6), 0.0, 1.0);
    sum += namp * w * os_snoise(vec3(np.xy, np.z * sq) * 2.4 * nfq);
    nw += namp * w;
    nfq *= 2.0;
    namp *= 0.55;
  }
  float turb = sum / max(nw, 1e-4) * 0.5 + 0.5;

  // Clumping. Roughly two cycles across the annulus and a handful around it, so
  // it is structure rather than texture: the disc had none of this at all, and
  // large-scale value is the difference between plasma and a spun ceramic bowl.
  // It doubles as the dust lane crossing the plane, since where it bottoms out
  // the disc goes nearly opaque-dark.
  float clump = os_snoise(np * 0.32 + 7.0) * 0.5 + 0.5;

  // Contrast. mix(0.45,1.55) x mix(0.70,1.30) is a 3.5:1 spread around a very
  // strong mean, i.e. a uniform wash with a texture painted on it.
  float dens = mix(0.16, 1.85, smoothstep(0.14, 0.86, turb)) * mix(0.30, 1.55, clump);
  // Hot knots: the top of the turbulence distribution is where the flow is
  // being compressed, and it should blow out rather than merely brighten.
  dens *= 1.0 + 1.6 * smoothstep(0.74, 0.97, turb);

  // Shakura–Sunyaev: T ~ r^-3/4 with a zero-torque inner boundary, so the disc
  // has a dark inner lip and its hottest ring sits just outside it.
  float x = r / uRin;
  float T = uTempIn * pow(x, -0.75) * pow(max(1.0 - sqrt(uRin / r), 0.0), 0.25);

  // Relativistic beaming. beta = sqrt(Rs / 2r) for a circular orbit.
  float beta = clamp(sqrt(uRs / (2.0 * r)), 0.0, 0.85);
  // The orbital velocity direction, built from world-space quantities because
  // modelMatrix is not available to a fragment shader. axis x radius is exactly
  // (-sin phi, cos phi, 0) carried through whatever transform the disc has.
  vec3 vhat = normalize(cross(normalize(vNrm), vWorld - vCentre));
  float cosA = dot(vhat, -V);
  float gamma = 1.0 / sqrt(max(1.0 - beta * beta, 1e-4));
  float dop = 1.0 / max(gamma * (1.0 - beta * cosA), 1e-3);
  float grav = sqrt(max(1.0 - uRs / r, 0.0));
  float g = clamp(dop * grav, 0.12, 5.0);

  // Doppler + gravitational shift move the *colour*, beaming moves the flux.
  vec3 col = os_blackbody(max(T * g, 900.0));
  // Bolometric intensity scales as g^4; g^3 keeps the approaching side from
  // clipping to a white slab while still reading as strongly asymmetric.
  float beam = pow(g, 3.0);
  // The true r^-3 radiance profile blacks out the outer disc within a few Rs;
  // a softer exponent keeps the outer structure legible without lying about
  // the direction of the gradient.
  float emiss = pow(max(T / uTempIn, 0.0), 2.2);

  float edge = smoothstep(uRin, uRin * 1.10, r) * (1.0 - smoothstep(uRout * 0.62, uRout, r));

  vec3 rgb = col * (emiss * beam * dens * edge * halfW * uIntensity);

  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

const DISC_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vObj;
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vCentre;

void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  vCentre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

// ---------------------------------------------------------------------------
// Gravitational lens
// ---------------------------------------------------------------------------

const LENS_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>

uniform sampler2D uScene;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uBhPos;
uniform float uRs;
uniform float uRin;      // accretion-disc inner radius, km
uniform float uRout;     // accretion-disc outer radius, km
uniform vec3  uDiscN;    // unit normal of the disc plane, world space
uniform vec3  uDiscCol;  // representative disc colour, linear
uniform float uHdr;      // 1 when we are writing into a linear HDR target
uniform float uLensOn;   // 0 when the framebuffer copy was not possible

varying vec2 vUv;

// NOTE: this shader deliberately omits <tonemapping_fragment> and
// <colorspace_fragment>. It resamples pixels that have already been written in
// whatever space the current target uses and hands them straight back; running
// them through the output transform a second time would double-encode them.
// uHdr tells the added terms which of the two worlds they are living in.

/**
 * A faint sprinkle of stars for deflected rays. Used both as extra Einstein-ring
 * imagery near the hole and as the substitute sky for rays that leave the
 * framebuffer entirely.
 */
vec3 backdrop(vec3 d) {
  vec3 g = d * 260.0;
  vec3 id = floor(g);
  float h = os_hash13(id);
  vec3 c = vec3(0.0);
  if (h > 0.978) {
    vec3 o = os_hash33(id) * 0.5 + 0.5;
    float dd = length(fract(g) - o);
    c += mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.88, 0.72), fract(h * 91.0))
       * exp(-dd * dd * 110.0) * (h - 0.978) * 34.0;
  }
  return c;
}

/**
 * What a ray that left the framebuffer is actually looking at.
 *
 * This is the term whose absence made the frame wrong. The scene texture only
 * holds what was inside the viewport, so a deflected ray pointing anywhere else
 * has no data — and the old code answered that by multiplying the pixel to
 * black. The set of rays with no data is bounded by the *screen rectangle*, so
 * blacking it out draws the viewport's own edges into the middle of a
 * gravitational lens: the straight diagonal cuts and the horizontal seam in the
 * review are literally the shape of the framebuffer. A lens has no straight
 * lines anywhere.
 *
 * The honest answer is cheap: the ray is a straight line in the far field once
 * the deflection has been applied, so intersect it analytically with the disc
 * plane and with the sky. Costs a handful of ALU and no texture fetch.
 */
vec3 offscreen(vec3 d) {
  vec3 c = backdrop(d) * mix(0.9, 5.0, uHdr);

  float dn = dot(d, uDiscN);
  if (abs(dn) > 1e-4) {
    vec3 rel = uBhPos - uCamPos;
    float t = dot(rel, uDiscN) / dn;
    if (t > 0.0) {
      vec3 hit = d * t - rel;               // hit point relative to the hole
      float rr = length(hit);
      if (rr > uRin && rr < uRout) {
        float x = rr / uRin;
        // Same r^-3/4 temperature profile the disc pass uses, folded straight
        // into a radiance so the substitute lines up with the real thing at the
        // seam instead of stepping across it.
        float prof = pow(x, -1.65) * pow(max(1.0 - sqrt(uRin / rr), 0.0), 0.6)
                   * (1.0 - smoothstep(uRout * 0.62, uRout, rr));
        float turb = os_snoise(normalize(hit) * (2.0 + log(x) * 2.2)) * 0.5 + 0.5;
        // Gain matched by hand against the real pass at x = 1.5 (prof 0.183 vs
        // emiss*uIntensity 0.6) so the substitute and the resampled disc meet at
        // the same value; anything else just moves the seam rather than
        // removing it. No column-length term, because the disc pass has none
        // either — it is a thin emissive sheet, not a volume.
        c += uDiscCol * prof * mix(0.45, 1.55, turb) * mix(0.6, 3.3, uHdr);
      }
    }
  }
  return c;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(ndc, -1.0, 1.0);
  vec3 dirCam = normalize(vp.xyz / vp.w);
  vec3 dir = normalize(mat3(uCamWorld) * dirCam);

  vec3 L = uBhPos - uCamPos;
  float along = dot(L, dir);
  vec3 perp = L - dir * along;      // from the ray's closest point to the hole
  float b = length(perp);           // impact parameter

  // Interstellar dust. Section 6 asks for a desaturated steel-blue base and
  // lifted-crushed blacks; without it the sky around the hole is #050506 and
  // the bottom third of the frame carries no information whatsoever. Deliberately
  // an order of magnitude under the bloom threshold — this is a base value, not
  // an emitter — and computed off dir rather than bent so that it is continuous
  // across the early-out below. (No backticks in here: this is a template
  // literal and they would end the shader.)
  float dust = os_snoise(dir * 2.2) * 0.5 + 0.5;
  vec3 haze = vec3(0.085, 0.115, 0.175) * (0.006 + 0.035 * dust * dust)
            * mix(0.9, 2.4, uHdr);

  vec3 base = texture2D(uScene, vUv).rgb + haze;

  // Behind us, or so far off axis that the deflection is under a pixel.
  if (along <= 0.0) {
    gl_FragColor = vec4(base, uLensOn);
    return;
  }

  float bph = PHOTON_B_CONST * uRs;
  float shadow = smoothstep(bph * 0.98, bph * 1.02, b);

  // Deflection. Weak field is 4GM/(c^2 b) = 2Rs/b; near the photon sphere the
  // exact strong-deflection limit diverges logarithmically. Taking the larger
  // of the two is monotonic and matches both ends.
  float weak = 2.0 * uRs / max(b, 1e-4);
  float xs = max(b / bph - 1.0, 1e-5);
  float strong = -log(xs) - 0.4002;   // ln(216(7-4sqrt3)) - pi
  float alpha = min(max(weak, strong), 7.0);

  // We are tracing backwards. A photon is deflected *towards* the mass on its
  // way here, so the source appears pushed *away* from the hole; to find what
  // is really at this apparent direction we must rotate back *towards* it.
  // Get this sign wrong and stars smear radially instead of into tangential
  // arcs, and the far side of the disc never lifts over the shadow.
  vec3 tHat = perp / max(b, 1e-4);
  vec3 bent = normalize(dir * cos(alpha) + tHat * sin(alpha));

  vec4 clip = uViewProj * vec4(bent, 0.0);
  vec2 uv2 = clip.xy / max(clip.w, 1e-6) * 0.5 + 0.5;
  float outside = max(max(-uv2.x, uv2.x - 1.0), max(-uv2.y, uv2.y - 1.0));
  vec2 cl = clamp(uv2, vec2(0.002), vec2(0.998));

  vec3 col = texture2D(uScene, cl).rgb;
  // clip.w < 0 means the deflected ray now points *behind* the camera, which
  // happens for every ray with alpha > pi/2 — i.e. the whole annulus just
  // outside the photon ring, the most looked-at part of the frame. Those rays
  // have no data at all; multiplying by step(0.0, clip.w) -- as this did before
  // -- does the exact opposite and smears a clamped screen-edge texel over the
  // whole annulus at full brightness.
  float behind = 1.0 - step(0.0, clip.w);
  // Wide feather. Near the photon ring the screen-to-sky mapping is violently
  // expansive, so a 0.05-uv ramp collapses to a couple of pixels on screen and
  // the boundary reads as an edge however smooth it is in uv.
  float lost = max(smoothstep(0.0, 0.16, outside), behind);
  // Substitute, never multiply to black.
  col = mix(col, offscreen(bent), lost);

  // Extra lensed starlight. This used to be gated to b < 9 Rs, so the tangential
  // star arcs — the entire reason a black hole is worth drawing — existed only
  // inside a disc barely wider than the shadow, and the rest of the sky was
  // literally nothing. Outside the strongly-lensed core it is dimmed rather
  // than switched off, so it reads as the real sky being bent rather than as a
  // second starfield pasted over Sky.ts's.
  float core = 1.0 - smoothstep(3.2 * uRs, 9.0 * uRs, b);
  col += backdrop(bent) * mix(0.22, 1.0, core) * (1.0 - lost) * mix(0.9, 5.0, uHdr);

  col += haze;

  col *= shadow;

  // The photon ring: light that orbited the hole before reaching us. Thin and
  // sitting just outside b_ph.
  //
  // At 9.0 linear against a bloom threshold of 1.0 this was, by a factor of
  // several, the brightest thing PostFX ever sees, and an isotropic multi-mip
  // bloom turned a 5 px ring into a 200 px halo that filled the shadow with
  // grey. The shadow has to be the darkest object in the frame or the ring has
  // nothing to be thin against, so the ring gives up peak and takes width: the
  // integrated energy is close to unchanged, the bloom driver drops by a third.
  // Cooled towards steel-white as well — its light comes from the inner disc,
  // which at the new uTempIn is blue-white rather than candle-warm, and it is
  // the frame's second hue.
  // (Squared by multiplication — pow() with a negative base, which this is for
  // every pixel inside the ring, is undefined in GLSL ES.)
  float rg = (b / bph - 1.038) / 0.056;
  float ring = exp(-rg * rg);
  vec3 ringCol = vec3(0.86, 0.92, 1.0) * ring * mix(1.3, 6.0, uHdr);
  // Nothing at all is emitted inside the horizon, including the Gaussian's tail.
  ringCol *= shadow;
  col += ringCol;

  // With uLensOn = 0 we could not read the framebuffer, so fall back to
  // compositing only the shadow and the ring over whatever is already there.
  float fallbackA = max(1.0 - shadow, ring);
  vec3 fallbackC = ringCol;

  gl_FragColor = vec4(mix(fallbackC, col, uLensOn), mix(fallbackA, 1.0, uLensOn));
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`.replace('PHOTON_B_CONST', PHOTON_B.toFixed(9));

// ---------------------------------------------------------------------------
// Lens flare / glare
// ---------------------------------------------------------------------------

const FLARE_FRAG = /* glsl */ `
#include <common>
#include <onespace_noise>
#include <onespace_color>

uniform vec2  uStar;        // star position in aspect-corrected NDC
uniform float uAspect;
uniform float uIntensity;
uniform float uOcclusion;
uniform float uAngularR;    // apparent radius of the disc, NDC-y units
uniform float uMinR;        // the PSF floor, a few pixels in NDC-y units
uniform vec3  uColor;
uniform float uAnamorphic;
uniform float uSpikes;
uniform float uDark;        // 1 for a black hole: the "source" emits nothing
uniform float uTime;

varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec2 q = vec2(p.x * uAspect, p.y);
  vec2 d = q - uStar;
  float r = length(d);

  float gate = uIntensity * uOcclusion;
  if (gate <= 0.0) { gl_FragColor = vec4(0.0); return; }

  // Fade as the source leaves the frame — a real flare does not switch off, it
  // drags out of shot.
  float off = 1.0 - smoothstep(1.05, 1.85, max(abs(uStar.x) / max(uAspect, 1e-3), abs(uStar.y)));

  float core = max(uAngularR, uMinR);
  // A *resolved* disc glares from its rim; only an unresolved point gets the
  // full inverse-power core. Without this the flare paints a flat white plate
  // over the photosphere and hides every bit of surface detail.
  float pointness = clamp(uMinR * 4.0 / core, 0.0, 1.0);
  // A black hole is a *dark* source: every term below is centred on uStar, and
  // uStar is the middle of the shadow. Once the shadow is resolved at all, a
  // veil or a streak painted across it turns the deepest black in the frame
  // into mid-grey — which is the single worst thing that can happen to this
  // shot. Squared so it collapses fast; at 1 px the hole is a point again and
  // it glares like any other bright source.
  float emit = mix(1.0, pointness * pointness, uDark);
  float psf = 1.6 * pointness * uSpikes / (1.0 + pow(r / core, 2.6));

  // The scattering veil. Fixed angular extent and small: this is the term that
  // turns a frame grey if it is allowed to reach the corners.
  float veil = exp(-r * 6.5) * 0.055 + exp(-r * 2.0) * 0.012;

  // Diffraction spikes from the aperture blades. Six, thin, and quiet.
  float ang = atan(d.y, d.x);
  float spike = pow(abs(cos(ang * 3.0)), 52.0) * exp(-r * 9.0) * 0.30 * uSpikes;

  // Anamorphic streak — horizontally stretched, broken up so it is not a rule.
  float streakN = 0.55 + 0.45 * (os_snoise(vec3(d.x * 9.0, uTime * 0.05, 0.0)) * 0.5 + 0.5);
  float streak = (exp(-abs(d.y) * 260.0) + 0.30 * exp(-abs(d.y) * 55.0))
               * exp(-abs(d.x) * 4.5) * streakN * uAnamorphic * 0.32;

  // A soft halo ring with a touch of lateral chromatic spread.
  vec3 haloC = vec3(
    exp(-abs(r - 0.330) * 9.0),
    exp(-abs(r - 0.345) * 9.0),
    exp(-abs(r - 0.362) * 9.0)
  ) * 0.030;

  vec3 col = uColor * (psf + veil + spike) + vec3(0.60, 0.76, 1.0) * streak + haloC;

  // Every term above is centred on uStar, and for a black hole uStar is the
  // middle of the shadow — the deepest black in the frame, and the only reason
  // the photon ring reads as razor-thin. Scaling them all down by pointness^2
  // was not enough: at a 0.18 NDC shadow that still leaves psf + veil + streak
  // at ~0.015 scene-linear, which comes out of ACES at 20/255 against a sky
  // floor of 3. Measured in the review frame as a "soft grey dome inside the
  // photon ring", and it was this, not bloom. So punch an actual hole the size
  // of the shadow instead of dimming: nothing is painted inside the horizon at
  // all, and the flare picks up again just outside the ring where the light
  // genuinely comes from. For an unresolved hole core collapses to uMinR and
  // the hole is two pixels wide, i.e. it does nothing.
  col *= mix(1.0, smoothstep(core * 0.55, core * 1.15, r), uDark);

  // Ghosts: internal reflections land on the line through the frame centre.
  // The palette is rationed to the project's two hues — amber glow and
  // steel-blue — rather than one tint per element. Five differently-coloured
  // discs is a lens-flare preset, not an art direction.
  //
  // A ghost is an out-of-focus image of the *iris*, so it is a polygon with as
  // many sides as the lens has blades, it is brighter towards its rim than at
  // its centre, its three channels focus at slightly different radii, and it
  // carries every scratch and dust mote on the glass. The previous version was
  // a flat fill with a hard shoulder, which is why the review read the two
  // large ones as smudges or a render bug rather than as optics.
  const int GHOSTS = 5;
  float ks[GHOSTS];
  ks[0] = -0.32; ks[1] = -0.68; ks[2] = 0.47; ks[3] = -1.12; ks[4] = 0.26;
  float szs[GHOSTS];
  szs[0] = 0.075; szs[1] = 0.130; szs[2] = 0.055; szs[3] = 0.185; szs[4] = 0.038;
  float warm[GHOSTS];
  warm[0] = 0.0; warm[1] = 1.0; warm[2] = 0.15; warm[3] = 0.85; warm[4] = 1.0;
  const vec3 GHOST_COOL = vec3(0.52, 0.70, 1.00);
  const vec3 GHOST_WARM = vec3(1.00, 0.74, 0.40);
  const float BLADES = 7.0;
  const float SEG = 6.2831853 / BLADES;
  for (int i = 0; i < GHOSTS; i++) {
    vec2 gp = uStar * ks[i];
    vec2 gd = (q - gp) / szs[i];
    float gr = length(gd);
    if (gr > 1.45) continue;
    // Boundary radius of a regular BLADES-gon with unit apothem, at this angle.
    // Each ghost sees the iris at its own roll so they are not clones.
    float ga = atan(gd.y, gd.x) + float(i) * 1.13;
    float bnd = 1.0 / max(cos(mod(ga, SEG) - SEG * 0.5), 0.35);
    // Per-channel focus: the three images of the aperture do not land on the
    // same radius, which is where a ghost's colour fringe comes from.
    vec3 k3 = vec3(gr / (bnd * 1.045), gr / bnd, gr / (bnd * 0.955));
    // Interior ramp — an aperture image is dimmest in the middle and piles up
    // against the blades. Never a plateau.
    vec3 body = (1.0 - smoothstep(vec3(0.80), vec3(1.0), k3))
              * (0.22 + 0.78 * smoothstep(vec3(0.0), vec3(0.72), k3));
    // Squared by multiplication, not pow(): pow() with a negative base is
    // undefined in GLSL ES and this argument is negative over the whole inside
    // of the ghost.
    vec3 dr = (k3 - 0.93) / 0.11;
    vec3 rim = exp(-dr * dr) * 0.9;
    // Dust and coating scratches on the element that made the reflection.
    float grime = 0.45 + 0.55 * (os_snoise(vec3(gd * 2.6, float(i) * 9.0)) * 0.5 + 0.5);
    grime *= 0.70 + 0.30 * (os_snoise(vec3(gd * 11.0, float(i) * 3.0 + 40.0)) * 0.5 + 0.5);
    // Roughly 60% of the old amplitude: a ghost sells the intensity of the
    // source by being *there*, not by being readable.
    col += mix(GHOST_COOL, GHOST_WARM, warm[i]) * grime * (body * 0.0065 + rim * 0.0055);
  }

  col *= gate * off * emit;
  // Vignette the whole thing so the corners never carry flare.
  col *= 1.0 - 0.55 * smoothstep(0.5, 1.5, length(q));

  gl_FragColor = vec4(col, 1.0);
  gl_FragColor.rgb = os_dither(gl_FragColor.rgb, gl_FragCoord.xy);
}
`;

// ---------------------------------------------------------------------------
// StarRenderer
// ---------------------------------------------------------------------------

type UniformMap = Record<string, IUniform>;

export class StarRenderer {
  readonly object3d: Object3D = new Group();

  /** Photosphere radius in kilometres. For a black hole, the horizon radius. */
  readonly radiusKm: number;
  /** Schwarzschild radius in kilometres — non-zero only for black holes. */
  readonly schwarzschildKm: number;
  readonly kind: StarKind;

  /**
   * The radius the *flare* should treat as the source's apparent size. For a
   * star that is the photosphere; for a hole it is the shadow, which is
   * 2.598 Rs across and is what the eye actually reads as "the object".
   */
  private readonly flareRadiusKm: number;

  private readonly spec: StarSpec;
  private readonly quality: QualitySettings;

  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  private photosphere: Mesh | null = null;
  private photoU: UniformMap | null = null;

  private corona: Mesh | null = null;
  private coronaU: UniformMap | null = null;
  private readonly coronaMaxR: number;

  private prominences: InstancedMesh | null = null;
  private promU: UniformMap | null = null;
  private promCount = 0;
  private readonly promDir: Vector3[] = [];
  private readonly promScale: number[] = [];

  private beamSpin: Group | null = null;
  private beamU: UniformMap | null = null;
  private beamRate = 0;

  private discFar: Mesh | null = null;
  private discNear: Mesh | null = null;
  private discU: UniformMap[] = [];
  /** The disc's parent transform — the lens needs its plane normal each frame. */
  private discPlane: Group | null = null;
  private discRin = 0;
  private discRout = 0;

  private lens: Mesh | null = null;
  private lensU: UniformMap | null = null;
  private sceneTex: FramebufferTexture | null = null;
  private sceneTexW = 0;
  private sceneTexH = 0;
  private sceneTexType = -1;
  private sceneTexFormat = -1;

  private flare: Mesh | null = null;
  private flareU: UniformMap | null = null;
  private flareEnabled = true;

  /** Driven by the integrator; damped internally so nothing ever snaps. */
  private occlusionTarget = 1;
  private occlusion = 1;

  private spinRate = 0;
  private time = 0;
  private distanceKm = 1e6;

  // Preallocated scratch — update() must not allocate.
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly tmpD = new Vector3();
  private readonly tmpScale = new Vector3();
  private readonly viewDir = new Vector3(0, 0, 1);
  private readonly right = new Vector3(1, 0, 0);
  private readonly up = new Vector3(0, 1, 0);
  private readonly mat = new Matrix4();
  private readonly size = new Vector2();

  constructor(spec: StarSpec, quality: QualitySettings) {
    registerShaderChunks();

    this.spec = spec;
    this.quality = quality;
    this.kind = kindOf(spec);
    this.object3d.name = `star:${spec.id}`;

    const rng = new Rng(spec.seed ^ 0x51a2);

    const rsFromMass = RS_PER_SOLAR_MASS * Math.max(spec.mass, 0.1);
    const rFromSpec = Math.max(spec.radius, 1e-9) * SOLAR_RADIUS;
    if (this.kind === 'bh') {
      // Trust the generator's radius only if it is already in the right
      // ballpark for the mass; otherwise the horizon comes from the mass,
      // because a black hole's size is not a free parameter.
      const plausible = rFromSpec > rsFromMass * 0.2 && rFromSpec < rsFromMass * 5;
      this.schwarzschildKm = plausible ? rFromSpec : rsFromMass;
      this.radiusKm = this.schwarzschildKm;
    } else {
      this.schwarzschildKm = 0;
      this.radiusKm = rFromSpec;
    }
    this.flareRadiusKm = this.kind === 'bh' ? this.radiusKm * PHOTON_B : this.radiusKm;

    // Rotation. Hot stars spin fast, red dwarfs and giants slowly; a pulsar is
    // in a class of its own. Period in seconds, then compressed for the game's
    // timescale so the surface is visibly alive without strobing.
    const dayHours = this.kind === 'ns' ? 0.0004 : rng.range(240, 900) / Math.max(spec.mass, 0.2);
    this.spinRate = (2 * Math.PI) / Math.max(dayHours * 3600, 1);

    this.coronaMaxR = this.kind === 'ns' ? 26 : this.kind === 'wd' ? 12 : 5.6;

    if (this.kind !== 'bh') this.buildPhotosphere();
    if (this.kind !== 'bh') this.buildCorona();
    if (this.kind === 'normal' && spec.activity > 0.12) this.buildProminences(rng);
    if (this.kind === 'ns') this.buildBeams(rng);
    if (this.kind === 'bh') {
      this.buildDisc(rng);
      this.buildLens();
    }
    this.buildFlare();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private track<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private trackMat<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private buildPhotosphere(): void {
    const t = tierIndex(this.quality);
    // PolyhedronGeometry's detail is linear, not exponential: faces =
    // 20*(detail+1)^2. A star fills a third of the frame in close approach, so
    // the silhouette needs ~60 segments around a great circle or it reads as a
    // polygon — which no amount of shading will save.
    const detail = [8, 14, 22, 30][t]!;
    const geo = this.track(new IcosahedronGeometry(this.radiusKm, detail));

    const spec = this.spec;
    // Limb darkening is stronger in cool stars (deeper convective envelope) and
    // nearly absent in a degenerate white-dwarf atmosphere.
    const cool = 1 - Math.min(Math.max((spec.temperature - 3000) / 12000, 0), 1);
    const a = this.kind === 'wd' ? 0.18 : 0.32 + 0.30 * cool;
    const b = this.kind === 'wd' ? 0.06 : 0.16 + 0.14 * cool;

    const degenerate = this.kind !== 'normal';

    const uniforms: UniformMap = {
      uTime: { value: 0 },
      uTemp: { value: Math.max(spec.temperature, 1200) },
      // Scene-linear, tone-mapped by PostFX (ACES) with a bloom threshold of
      // 1.0. At 1.45 the *hottest* granule core landed at ~1.6 — barely over
      // the threshold — so the disc came out as one matte value with no
      // emission anywhere. At 1.85 the quiet photosphere sits at ACES ~0.91 and
      // the granule cores, which run to twice the mean radiance, go to ~3.7 and
      // genuinely blow out. A star is an emitter; it has to have pixels that
      // clip, and it has to have them *locally* rather than as a white plate.
      uIntensity: { value: degenerate ? 4.6 : 1.85 },
      // A white dwarf is Earth-sized: you can park next to one, and a perfectly
      // uniform white disc is exactly the flat field section 6 forbids. Cool
      // dwarfs really do convect, so give it a fine, shallow granulation. A
      // neutron star is 10 km across and never resolves, so it keeps almost none.
      uGranAmp: {
        value: degenerate
          ? this.kind === 'wd'
            ? 0.075
            : 0.02
          : 0.125 + 0.05 * spec.activity,
      },
      // 14 rather than 18: the LOD below now retires an octave once its cells
      // reach ~4 px instead of ~1 px, so the base cell has to be bigger or the
      // star loses its texture as soon as it stops filling the frame.
      uGranScale: { value: degenerate ? 30 : 14 },
      uDetail: { value: 1 },
      // spotN is 4-octave fBm with a standard deviation near 0.30, so this
      // threshold is a coverage control: at activity 0.62 it puts penumbra over
      // roughly a tenth of the surface and umbra over about one per cent —
      // several spot groups instead of the single smudge the first pass showed,
      // without tipping over into a diseased-looking star.
      uSpotThresh: { value: degenerate ? 3 : 0.72 - 0.55 * spec.activity },
      uSpotDepth: { value: degenerate ? 0 : 1 },
      uFlow: { value: degenerate ? 0.5 : 1 },
      uLimb: { value: new Vector2(a, b) },
      // H-alpha, blue-shifted towards white for the hot degenerate cases.
      uRim: {
        value: degenerate ? new Color(0.62, 0.78, 1) : new Color(1, 0.28, 0.2),
      },
    };
    this.photoU = uniforms;

    const mat = this.trackMat(
      new ShaderMaterial({
        uniforms,
        vertexShader: WORLD_VERT,
        fragmentShader: PHOTOSPHERE_FRAG,
      }),
    );

    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = 10;
    this.photosphere = mesh;
    this.object3d.add(mesh);
  }

  private buildCorona(): void {
    const geo = this.track(new PlaneGeometry(2, 2));
    const t = tierIndex(this.quality);

    const uniforms: UniformMap = {
      uTime: { value: 0 },
      uTemp: { value: Math.max(this.spec.temperature, 1200) },
      uIntensity: { value: this.kind === 'normal' ? 0.55 : 1.5 },
      uActivity: { value: this.spec.activity },
      uMaxR: { value: this.coronaMaxR },
      uChromo: { value: this.kind === 'normal' ? 0.45 + 0.9 * this.spec.activity : 0.25 },
      uSilR: { value: 1 },
      uOct: { value: [3, 4, 5, 6][t]! },
      uAxis: { value: new Vector3(0, 1, 0) },
      uRight: { value: new Vector3(1, 0, 0) },
      uUp: { value: new Vector3(0, 1, 0) },
      uSizeKm: { value: this.radiusKm * this.coronaMaxR },
    };
    this.coronaU = uniforms;

    const mat = this.trackMat(
      new ShaderMaterial({
        uniforms,
        vertexShader: CORONA_VERT,
        fragmentShader: CORONA_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
      }),
    );

    const mesh = new Mesh(geo, mat);
    // The quad is assembled in the vertex shader from uniforms, so its own
    // bounding sphere is meaningless.
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    this.corona = mesh;
    this.object3d.add(mesh);
  }

  private buildProminences(rng: Rng): void {
    const t = tierIndex(this.quality);
    // Only the ~third of the footpoints near the limb ever draws, so the budget
    // has to be roughly three times what you want to see. At 4/7/11 the star
    // showed one or two loops and the limb read as bare.
    const budget = [6, 10, 16, 22][t]!;
    const count = Math.max(1, Math.round(budget * (0.35 + 0.65 * this.spec.activity)));

    const geo = this.track(new PlaneGeometry(1, 1));
    // Move the pivot to the bottom edge so the loop stands on the surface.
    geo.translate(0, 0.5, 0);

    const params = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = rng.onSphere();
      this.promDir.push(new Vector3(x, y, z));
      // Prominences cluster in the active latitudes, so bias the size by how
      // far the footpoint is from the pole.
      const lat = 1 - Math.abs(y);
      // Range widened by 0.92/0.62 to cancel the smaller arc the fragment
      // shader now draws inside its quad; the loops keep their old apparent
      // size, they simply no longer touch the sprite border.
      this.promScale.push(
        this.radiusKm * rng.range(0.19, 0.50) * (0.55 + 0.6 * lat) * (0.6 + 0.8 * this.spec.activity),
      );
      params[i * 3] = rng.next();
      params[i * 3 + 1] = rng.range(0.035, 0.10);
      params[i * 3 + 2] = rng.range(0.03, 0.12);
    }
    geo.setAttribute('aParams', new InstancedBufferAttribute(params, 3));

    const uniforms: UniformMap = {
      uTime: { value: 0 },
      // Nudged up from 2.6 to hold the same peak brightness now that the strand
      // field has no pedestal: the mean alpha fell, the maximum did not.
      uIntensity: { value: 2.9 * (0.4 + 0.6 * this.spec.activity) },
    };
    this.promU = uniforms;

    const mat = this.trackMat(
      new ShaderMaterial({
        uniforms,
        vertexShader: PROM_VERT,
        fragmentShader: PROM_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
      }),
    );

    const mesh = new InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    this.prominences = mesh;
    this.promCount = count;
    this.object3d.add(mesh);
  }

  private buildBeams(rng: Rng): void {
    // The light cylinder, r = cP/2pi, is the natural scale for a pulsar's
    // magnetosphere and is thousands of km even for a fast rotator — which is
    // the only reason a 10 km object is visible at all.
    const periodS = rng.range(0.9, 5.5);
    const len = Math.max((299792.458 * periodS) / (2 * Math.PI), 4000);
    const open = 0.26;
    this.beamRate = (2 * Math.PI) / periodS;

    const t = tierIndex(this.quality);
    const geo = this.track(
      new CylinderGeometry(len * open, 0, len, [12, 16, 24, 32][t]!, [3, 4, 6, 8][t]!, true),
    );
    geo.translate(0, len * 0.5, 0);

    const uniforms: UniformMap = {
      uTime: { value: 0 },
      uIntensity: { value: 2.2 },
      uLen: { value: len },
    };
    this.beamU = uniforms;

    const mat = this.trackMat(
      new ShaderMaterial({
        uniforms,
        vertexShader: WORLD_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: DoubleSide,
      }),
    );

    const spin = new Group();
    const tilt = new Group();
    // The magnetic axis is offset from the spin axis — no obliquity, no pulsar.
    tilt.rotation.z = rng.range(0.35, 0.9);

    const north = new Mesh(geo, mat);
    north.frustumCulled = false;
    north.renderOrder = 25;
    const south = new Mesh(geo, mat);
    south.rotation.x = Math.PI;
    south.frustumCulled = false;
    south.renderOrder = 25;

    tilt.add(north, south);
    spin.add(tilt);
    this.beamSpin = spin;
    this.object3d.add(spin);
  }

  private buildDisc(rng: Rng): void {
    const rs = this.schwarzschildKm;
    const rin = 3 * rs; // ISCO for a non-rotating hole
    const rout = rng.range(11, 15) * rs;
    this.discRin = rin;
    this.discRout = rout;
    const t = tierIndex(this.quality);

    // RingGeometry lies in XY and the shader reads polar coordinates straight
    // out of `position`, so the tilt into the equatorial plane has to live in a
    // parent transform rather than being baked into the attribute.
    // The shader is entirely per-pixel, so the tessellation only has to keep the
    // inner and outer rims from reading as polygons — but the inner rim is a
    // small circle blown up across half the frame, so it still needs scaling
    // with the tier rather than a fixed number.
    const geo = this.track(
      new RingGeometry(rin * 0.98, rout * 1.02, [160, 224, 320, 400][t]!, [6, 8, 12, 16][t]!),
    );
    const plane = new Group();
    plane.rotation.x = -Math.PI / 2;

    const mk = (half: number, order: number): Mesh => {
      const uniforms: UniformMap = {
        uTime: { value: 0 },
        uRs: { value: rs },
        uRin: { value: rin },
        uRout: { value: rout },
        // Not the real 10^7 K of a stellar-mass disc — that renders as a flat
        // white plate. This is the temperature that puts the blue-white/orange
        // transition where the eye can read the r^-3/4 gradient.
        //
        // 15000 put the *peak* of the Shakura-Sunyaev profile at 7250 K, which
        // is a candle: nowhere in the frame was there a second hue, and the
        // whole image came out sepia. The profile peaks at 0.483 x uTempIn, so
        // 21000 lands the hot ring at ~10000 K and lets the g-shift carry the
        // approaching limb to ~16000 (blue-white) and the receding one back
        // under 6500 (amber). That split *is* the palette.
        uTempIn: { value: 21000 },
        uIntensity: { value: 4.2 },
        uHalf: { value: half },
        uFeather: { value: rout * 0.16 },
        uPixAngle: { value: 1 / 1080 },
        uOct: { value: [4, 5, 6, 7][t]! },
      };
      this.discU.push(uniforms);
      const mat = this.trackMat(
        new ShaderMaterial({
          uniforms,
          vertexShader: DISC_VERT,
          fragmentShader: DISC_FRAG,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          depthTest: true,
          side: DoubleSide,
        }),
      );
      const m = new Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = order;
      return m;
    };

    // Far half first: it is in the framebuffer when the lens copies it, so it
    // is the half that gets bent up and over the hole.
    this.discFar = mk(1, 10);
    // Near half last: it is genuinely in front of the shadow and must not be
    // erased by it.
    this.discNear = mk(-1, 40);
    plane.add(this.discFar, this.discNear);
    this.discPlane = plane;
    this.object3d.add(plane);
  }

  private buildLens(): void {
    const geo = this.track(new PlaneGeometry(2, 2));
    const uniforms: UniformMap = {
      uScene: { value: null },
      uInvProj: { value: new Matrix4() },
      uCamWorld: { value: new Matrix4() },
      uViewProj: { value: new Matrix4() },
      uCamPos: { value: new Vector3() },
      uBhPos: { value: new Vector3() },
      uRs: { value: this.schwarzschildKm },
      uRin: { value: this.discRin },
      uRout: { value: this.discRout },
      uDiscN: { value: new Vector3(0, 1, 0) },
      // Mid-disc colour, roughly os_blackbody(0.5 * uTempIn) in linear. Only
      // used for rays that left the framebuffer, where the alternative is black.
      uDiscCol: { value: new Color(1.0, 0.88, 0.72) },
      uHdr: { value: 0 },
      uLensOn: { value: 0 },
    };
    this.lensU = uniforms;

    const mat = this.trackMat(
      new ShaderMaterial({
        uniforms,
        vertexShader: SCREEN_VERT,
        fragmentShader: LENS_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.onBeforeRender = this.onLensBeforeRender;
    this.lens = mesh;
    this.object3d.add(mesh);
  }

  private buildFlare(): void {
    const geo = this.track(new PlaneGeometry(2, 2));
    const c = this.spec.color;
    // Normalise so a red dwarf's flare is not dimmer than a blue giant's purely
    // because its RGB triplet sums to less.
    const peak = Math.max(c[0], c[1], c[2], 1e-3);
    const uniforms: UniformMap = {
      uStar: { value: new Vector2(0, 0) },
      uAspect: { value: 1.777 },
      uIntensity: { value: 0 },
      uOcclusion: { value: 1 },
      uAngularR: { value: 0.01 },
      uMinR: { value: 0.006 },
      uColor: { value: new Color(c[0] / peak, c[1] / peak, c[2] / peak) },
      uAnamorphic: { value: this.kind === 'bh' ? 0.3 : 1 },
      // Spikes stay on for a hole: when it is a sub-pixel point its disc is a
      // genuine bright source and the aperture does what it always does. uDark
      // is what suppresses everything once the shadow becomes resolvable.
      uSpikes: { value: 1 },
      uDark: { value: this.kind === 'bh' ? 1 : 0 },
      uTime: { value: 0 },
    };
    this.flareU = uniforms;

    const mat = this.trackMat(
      new ShaderMaterial({
        uniforms,
        vertexShader: SCREEN_VERT,
        fragmentShader: FLARE_FRAG,
        transparent: true,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3000;
    mesh.onBeforeRender = this.onFlareBeforeRender;
    this.flare = mesh;
    this.object3d.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Public controls
  // -------------------------------------------------------------------------

  /**
   * 0 = fully hidden behind something, 1 = clear line of sight. The integrator
   * drives this from its own occlusion query / depth probe; the transition is
   * damped here so a planet edge never pops the flare off.
   */
  setOcclusion(v: number): void {
    this.occlusionTarget = Math.min(Math.max(v, 0), 1);
  }

  setFlareEnabled(on: boolean): void {
    this.flareEnabled = on;
    if (this.flare) this.flare.visible = on;
  }

  /** Irradiance relative to Sol at 1 AU. Handy for the integrator's key light. */
  irradianceAt(distanceKm: number): number {
    const au = Math.max(distanceKm, 1) / AU;
    return this.spec.luminosity / (au * au);
  }

  /** Linear RGB of the star, written into `target`. */
  lightColor(target: Color): Color {
    const c = this.spec.color;
    return target.setRGB(c[0], c[1], c[2]);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext, view: ViewState): void {
    this.time = view.time;
    this.distanceKm = Math.max(view.distance, this.radiusKm * 1.0001);

    // Critically-damped-ish approach; nothing the player sees ever snaps.
    this.occlusion += (this.occlusionTarget - this.occlusion) * (1 - Math.exp(-dt * 7));

    if (this.photosphere) {
      this.photosphere.rotation.y += dt * this.spinRate;
      const u = this.photoU!;
      (u.uTime as IUniform<number>).value = this.time;

      // Screen-space LOD: fade an octave in only once its cells are a few
      // pixels across, which is the whole defence against noise aliasing.
      const pxPerRadius =
        (this.radiusKm / this.distanceKm) / (view.fovY / Math.max(view.viewportHeight, 1));
      const scale = (u.uGranScale as IUniform<number>).value;
      const k = pxPerRadius / (scale * 2.5);
      // The octave that carries full weight has cells of 2.5 / 2.6^(C-1) pixels
      // across, so the constant C is *literally* the alias margin. It used to be
      // 1, i.e. the top weighted octave had 2.5 px cells; that is inside the
      // Nyquist limit and is why the granulation had to be kept at an amplitude
      // low enough to hide the shimmer. At -0.6 the top weighted octave is
      // ~11 px and the fading one ~4 px, which is what buys the contrast above.
      const oct = -0.6 + Math.log(Math.max(k, 1e-3)) / Math.log(2.6);
      (u.uDetail as IUniform<number>).value = Math.min(Math.max(oct, 0), 4);
    }

    if (this.corona) {
      // Build an orthonormal basis in the star's own space that faces the
      // camera, so the corona is a slice of a 3D field rather than a decal.
      this.viewDir.copy(view.cameraLocal);
      if (this.viewDir.lengthSq() < 1e-12) this.viewDir.set(0, 0, 1);
      this.viewDir.normalize();
      this.tmpA.set(0, 1, 0);
      if (Math.abs(this.viewDir.y) > 0.985) this.tmpA.set(1, 0, 0);
      this.right.crossVectors(this.tmpA, this.viewDir).normalize();
      this.up.crossVectors(this.viewDir, this.right).normalize();

      const u = this.coronaU!;
      (u.uTime as IUniform<number>).value = this.time;
      (u.uRight as IUniform<Vector3>).value.copy(this.right);
      (u.uUp as IUniform<Vector3>).value.copy(this.up);
      // The corona quad sits in the plane through the star's centre, so the
      // sphere occludes everything inside the *tangent* circle, whose radius in
      // quad units is 1/sqrt(1 - (R/d)^2). Hand that to the shader so the
      // chromospheric shell lands where it can actually be seen.
      const s = Math.min(this.radiusKm / this.distanceKm, 0.999);
      (u.uSilR as IUniform<number>).value = 1 / Math.sqrt(1 - s * s);
    }

    if (this.prominences) {
      (this.promU!.uTime as IUniform<number>).value = this.time;
      this.updateProminences(view);
    }

    if (this.beamSpin) {
      this.beamSpin.rotation.y += dt * this.beamRate;
      (this.beamU!.uTime as IUniform<number>).value = this.time;
    }

    // Radians per pixel — the disc's noise LOD needs the same screen metric the
    // photosphere has always had, or its high octaves alias into moire arcs.
    const pixAngle = view.fovY / Math.max(view.viewportHeight, 1);
    for (const u of this.discU) {
      (u.uTime as IUniform<number>).value = this.time;
      (u.uPixAngle as IUniform<number>).value = pixAngle;
    }

    if (this.flareU) {
      const u = this.flareU;
      (u.uTime as IUniform<number>).value = this.time;
      (u.uOcclusion as IUniform<number>).value = this.occlusion;
      // Apparent brightness follows the inverse-square law; the shallow
      // exponent is the eye's response, not a fudge — a flare 100x brighter is
      // not 100x bigger.
      const irr = this.irradianceAt(this.distanceKm);
      const base = this.kind === 'bh' ? 0.25 : this.kind === 'ns' ? 1.3 : 1;
      // Heavy compression: irradiance spans six decades between 0.02 AU and
      // 40 AU, and a display spans two. The eye does the same thing — a star
      // stays a brilliant point right out to the edge of a system.
      (u.uIntensity as IUniform<number>).value = this.flareEnabled
        ? Math.min(Math.pow(Math.max(irr, 0), 0.14) * base, 1.35)
        : 0;
    }

    void ctx;
  }

  private updateProminences(view: ViewState): void {
    const mesh = this.prominences;
    if (!mesh) return;

    this.tmpD.copy(view.cameraLocal);
    if (this.tmpD.lengthSq() < 1e-12) this.tmpD.set(0, 0, 1);
    this.tmpD.normalize();

    for (let i = 0; i < this.promCount; i++) {
      const n = this.promDir[i]!;
      const s = this.promScale[i]!;

      // Billboard the loop about its own radial axis so every prominence at
      // the limb presents its face, never its edge.
      this.tmpA.copy(n).cross(this.tmpD);
      if (this.tmpA.lengthSq() < 1e-8) {
        // Footpoint directly towards or away from us: the loop is invisible
        // anyway, so any stable basis will do.
        this.tmpA.set(n.y, -n.x, 0);
        if (this.tmpA.lengthSq() < 1e-8) this.tmpA.set(1, 0, 0);
      }
      this.tmpA.normalize();
      this.tmpB.copy(this.tmpA).cross(n).normalize();
      this.tmpC.copy(n).multiplyScalar(this.radiusKm * 0.985);

      this.mat.makeBasis(this.tmpA, n, this.tmpB);
      this.mat.scale(this.tmpScale.set(s, s, s));
      this.mat.setPosition(this.tmpC);
      mesh.setMatrixAt(i, this.mat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Draw-time hooks (matrices and the framebuffer are only valid here)
  // -------------------------------------------------------------------------

  private onFlareBeforeRender = (renderer: WebGLRenderer, _s: Scene, camera: Camera): void => {
    const u = this.flareU;
    if (!u) return;

    this.tmpA.setFromMatrixPosition(this.object3d.matrixWorld);
    this.tmpB.copy(this.tmpA).applyMatrix4(camera.matrixWorldInverse);
    if (this.tmpB.z >= 0) {
      // Behind the camera — no flare, but keep the uniform sane.
      (u.uStar as IUniform<Vector2>).value.set(10, 10);
      return;
    }
    this.tmpA.project(camera);

    renderer.getDrawingBufferSize(this.size);
    const aspect = this.size.x / Math.max(this.size.y, 1);
    (u.uAspect as IUniform<number>).value = aspect;
    (u.uStar as IUniform<Vector2>).value.set(this.tmpA.x * aspect, this.tmpA.y);

    // projectionMatrix[5] is 1/tan(fovY/2), so this is the disc's true angular
    // radius expressed in NDC-y units, whatever camera we were handed.
    const invTan = camera.projectionMatrix.elements[5] ?? 1;
    const trueR = (this.flareRadiusKm / Math.max(-this.tmpB.z, 1e-3)) * invTan;
    // Floor at a few pixels: an unresolved source still has a PSF.
    const minR = (4 * 2) / Math.max(this.size.y, 1);
    (u.uMinR as IUniform<number>).value = minR;
    (u.uAngularR as IUniform<number>).value = Math.max(trueR, minR);
  };

  private onLensBeforeRender = (renderer: WebGLRenderer, _s: Scene, camera: Camera): void => {
    const u = this.lensU;
    if (!u) return;

    const rt = renderer.getRenderTarget();
    // copyTexSubImage2D cannot read a multisampled framebuffer. Rather than
    // spraying GL errors we degrade to shadow + photon ring only.
    const canCopy = !rt || rt.samples === 0;

    if (canCopy) {
      const w = rt ? rt.width : Math.round(renderer.getDrawingBufferSize(this.size).x);
      const h = rt ? rt.height : Math.round(this.size.y);
      // copyTexSubImage2D refuses to convert between a float and a fixed-point
      // framebuffer, so the scratch texture has to mirror whatever we are
      // currently drawing into.
      const type = rt ? rt.texture.type : UnsignedByteType;
      const format = rt ? rt.texture.format : RGBAFormat;

      if (
        !this.sceneTex ||
        this.sceneTexW !== w ||
        this.sceneTexH !== h ||
        this.sceneTexType !== type ||
        this.sceneTexFormat !== format
      ) {
        this.sceneTex?.dispose();
        const tex = new FramebufferTexture(w, h);
        tex.type = type;
        tex.format = format;
        tex.minFilter = LinearFilter;
        tex.magFilter = LinearFilter;
        // The copy is raw: whatever encoding the target uses, we hand it back
        // unchanged, so no colour-space conversion may be applied here.
        tex.generateMipmaps = false;
        this.sceneTex = tex;
        this.sceneTexW = w;
        this.sceneTexH = h;
        this.sceneTexType = type;
        this.sceneTexFormat = format;
        (u.uScene as IUniform<Texture | null>).value = tex;
      }
      renderer.copyFramebufferToTexture(this.sceneTex);
      // A linear HDR target means our additive ring must be pushed well past
      // 1.0 to survive the tone map; an LDR canvas means it must not be.
      (u.uHdr as IUniform<number>).value = rt && rt.texture.type !== UnsignedByteType ? 1 : 0;
    }
    (u.uLensOn as IUniform<number>).value = canCopy ? 1 : 0;

    (u.uInvProj as IUniform<Matrix4>).value.copy(camera.projectionMatrixInverse);
    (u.uCamWorld as IUniform<Matrix4>).value.copy(camera.matrixWorld);
    (u.uViewProj as IUniform<Matrix4>).value
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    (u.uCamPos as IUniform<Vector3>).value.setFromMatrixPosition(camera.matrixWorld);
    (u.uBhPos as IUniform<Vector3>).value.setFromMatrixPosition(this.object3d.matrixWorld);
    if (this.discPlane) {
      // RingGeometry lies in the plane group's XY, so its normal is that
      // group's +Z carried through whatever transform the hole has.
      (u.uDiscN as IUniform<Vector3>).value
        .set(0, 0, 1)
        .transformDirection(this.discPlane.matrixWorld)
        .normalize();
    }
  };

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Frees every GPU resource this class allocated. Safe to call twice.
   *
   * Inventory, so the next reader does not have to re-derive it:
   *   geometry   IcosahedronGeometry (photosphere)      -> this.geometries
   *   geometry   PlaneGeometry       (corona quad)      -> this.geometries
   *   geometry   PlaneGeometry       (prominence quad)  -> this.geometries
   *   geometry   CylinderGeometry    (pulsar beam, x1 shared by both cones)
   *   geometry   RingGeometry        (disc, x1 shared by the two half passes)
   *   geometry   PlaneGeometry       (lens quad)        -> this.geometries
   *   geometry   PlaneGeometry       (flare quad)       -> this.geometries
   *   material   8 x ShaderMaterial  (photo, corona, prom, beam, disc x2,
   *                                   lens, flare)      -> this.materials
   *   texture    FramebufferTexture  (lens scene copy)  -> this.sceneTex
   *   other      InstancedMesh instance buffers         -> prominences.dispose()
   *   none       no WebGLRenderTarget is ever allocated here.
   */
  dispose(): void {
    if (this.lens) this.lens.onBeforeRender = () => undefined;
    if (this.flare) this.flare.onBeforeRender = () => undefined;

    // clear() only unhooks the direct children; the disc and beam meshes hang
    // off intermediate Groups, so drop those too or the meshes stay reachable
    // from a detached subtree for as long as the caller holds `object3d`.
    // Collect first: clearing during traverse() truncates the walk.
    const nodes: Object3D[] = [];
    this.object3d.traverse((o) => {
      nodes.push(o);
    });
    for (const n of nodes) n.clear();

    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;

    if (this.lensU) (this.lensU.uScene as IUniform<Texture | null>).value = null;
    this.sceneTex?.dispose();
    this.sceneTex = null;
    this.sceneTexW = 0;
    this.sceneTexH = 0;
    this.sceneTexType = -1;
    this.sceneTexFormat = -1;

    this.prominences?.dispose();

    this.photosphere = null;
    this.corona = null;
    this.prominences = null;
    this.beamSpin = null;
    this.discFar = null;
    this.discNear = null;
    this.discPlane = null;
    this.lens = null;
    this.flare = null;

    // Drop the CPU-side references too: the uniform maps hold Color, Vector2,
    // Vector3 and Matrix4 instances, and promDir holds one Vector3 per loop.
    this.photoU = null;
    this.coronaU = null;
    this.promU = null;
    this.beamU = null;
    this.lensU = null;
    this.flareU = null;
    this.discU.length = 0;
    this.promDir.length = 0;
    this.promScale.length = 0;
    this.promCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Review shots
// ---------------------------------------------------------------------------

/**
 * Hand-authored specs so the shots do not depend on `gen/system.ts` landing
 * first. They are ordinary StarSpecs — nothing here is privileged.
 */
const SHOT_G_STAR: StarSpec = {
  id: 'shot-g',
  seed: 0x5eed_9017,
  name: 'KEPLER STANDARD',
  spectralClass: 'G',
  temperature: 5680,
  radius: 1,
  mass: 1.02,
  luminosity: 1,
  color: [1, 0.93, 0.84],
  activity: 0.62,
};

const SHOT_BH_MASS = 8;
const SHOT_BH: StarSpec = {
  id: 'shot-bh',
  seed: 0x00b1_ac4b,
  name: 'CYGNUS ANOMALY',
  spectralClass: 'BH',
  temperature: 0,
  radius: (RS_PER_SOLAR_MASS * SHOT_BH_MASS) / SOLAR_RADIUS,
  mass: SHOT_BH_MASS,
  luminosity: 0.4,
  color: [0.85, 0.9, 1],
  activity: 0.8,
};

/** One live star per shot; torn down when another shot takes over. */
let shotStar: StarRenderer | null = null;
const shotView = new MutableViewState();
const shotCamPos = new Vector3();
const shotTarget = new Vector3();
const shotLocal = new Vector3();
const shotSun = new Vector3(0, 0, 1);
const shotColor = new Color(1, 1, 1);

function teardown(ctx: EngineContext): void {
  if (!shotStar) return;
  ctx.scene.remove(shotStar.object3d);
  shotStar.dispose();
  shotStar = null;
}

function driveShot(dt: number, ctx: EngineContext): void {
  const star = shotStar;
  if (!star) return;

  // Re-assert the camera every frame: other modules are allowed to move it,
  // and a review shot must be the same frame every time.
  ctx.camera.position.copy(shotCamPos);
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.lookAt(shotTarget);
  ctx.camera.updateMatrixWorld(true);

  star.object3d.updateMatrixWorld(true);
  shotLocal.copy(ctx.camera.position);
  star.object3d.worldToLocal(shotLocal);

  star.lightColor(shotColor);
  shotView.set(
    shotLocal,
    shotSun,
    shotColor,
    ctx.elapsed,
    (ctx.camera.fov * Math.PI) / 180,
    ctx.height,
  );
  star.update(dt, ctx, shotView);
}

export function registerStarShots(): void {
  registerShot({
    name: 'star-close',
    description:
      'A G-class star at 0.014 AU, its limb cutting the lower-left of frame: granulation ' +
      'and sunspots on a strongly limb-darkened disc, filamentary corona with polar holes, ' +
      'H-alpha prominences standing off the limb, restrained anamorphic glare.',
    apply(ctx) {
      teardown(ctx);
      const star = new StarRenderer(SHOT_G_STAR, ctx.quality);
      // Tilt the pole 26 degrees out of the line of sight so the corona's
      // equatorial belt is seen edge-on: streamers to either side, dark polar
      // holes above and below. Face-on it degenerates into an even ring.
      star.object3d.rotation.set(0.28, 0.6, 0.34);
      ctx.scene.add(star.object3d);
      shotStar = star;

      // 2.95 stellar radii. The disc is 0.75 of frame height and its centre
      // sits at NDC (-0.54, -0.39), so the limb runs off both the left and the
      // bottom edge: a single hard-lit arc across the frame rather than a ball
      // floating in black. Section 6 wants something occluding, always; here
      // the star itself is the occluder and the upper right is left to the
      // corona, the prominences and the flare ghosts.
      const d = 2.05e6;
      shotCamPos.set(0, 0, d);
      shotTarget.set(1.15e6, 0.55e6, 0);
    },
    update: driveShot,
  });

  registerShot({
    name: 'star-blackhole',
    description:
      'An 8 solar-mass black hole seen 10 degrees above its accretion disc: real ' +
      'screen-space light deflection, photon ring, shadow, and a Doppler-beamed disc ' +
      'whose far half is lensed up and over the hole.',
    apply(ctx) {
      teardown(ctx);
      const rs = RS_PER_SOLAR_MASS * SHOT_BH_MASS;
      const star = new StarRenderer(SHOT_BH, ctx.quality);
      star.object3d.rotation.set(0, 0.4, 0.12);
      ctx.scene.add(star.object3d);
      shotStar = star;

      // 24 Rs out and 9 degrees above the disc plane. The image of a black hole
      // depends only on d/Rs, so this framing is scale-independent.
      const d = 24 * rs;
      const el = (9 * Math.PI) / 180;
      shotCamPos.set(0, Math.sin(el) * d, Math.cos(el) * d);
      // Push the hole slightly above frame centre; the lensed lower arc needs
      // the room underneath it.
      shotTarget.set(0, -0.10 * d, 0);
    },
    update: driveShot,
  });
}

