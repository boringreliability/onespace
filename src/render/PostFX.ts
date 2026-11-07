/**
 * PostFX — the noir grade pipeline.
 *
 * Everything the player ever sees passes through this file, so it is written to
 * be *the* look rather than a bag of effects. The chain, in order:
 *
 *   1. RenderPass            scene -> linear HDR (RGBA16F)
 *   2. SceneSpacePass        screen-space AO + reprojected motion blur (optional)
 *   3. LuminancePass         64 -> 1 log-luminance pyramid + damped iris
 *   4. BloomPass             6-level Karis/tent pyramid + anamorphic streak
 *   5. GradePass             exposure, ACES, noir curve, split-tone, CA, vignette
 *   6. FinalPass             FXAA, luminance-weighted film grain, dither
 *
 * DEVIATIONS from the brief's ordering, and why:
 *
 *  - AO and motion blur run *before* bloom, not after. Occluded crevices must
 *    not glow, and bloom applied to an already-smeared frame reads as vaseline
 *    rather than motion. This is the order Unreal uses (AO -> motion blur ->
 *    bloom -> tonemap) and it is the reason a UE frame looks like film.
 *  - AO and motion blur share one full-resolution pass. Both need linear depth
 *    and nothing else; splitting them would cost a second full-res depth fetch
 *    and a second round trip through a 16F target for no visual gain.
 *  - The bright-pass/streak composite is folded into the grade pass as extra
 *    texture reads instead of a separate additive full-screen pass. Saves one
 *    full-resolution read-modify-write of a half-float target (~0.35 ms at
 *    1080p) and lets chromatic aberration act on the glow as well as the scene,
 *    which is what a real lens does.
 *  - Film grain and dither live in the FXAA pass rather than the grade. Grain
 *    applied before AA is chewed up by the AA; every film-look pipeline applies
 *    it after the resolve. Dither is the last arithmetic before the framebuffer,
 *    which is the only place it does its job.
 *
 * PASS COUNT at `high`: 4 full-resolution passes (scene, scene-space, grade,
 * final), 11 bloom passes at <= half resolution, 3 streak passes at 1/8, and 5
 * passes on 64x64-or-smaller targets. 22 post draws — measured, not counted by
 * hand; see the renderer.info note in the constructor — of which only four
 * touch more than a quarter of the pixels. `low` is 16, `ultra` 22.
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  DataTexture,
  DepthTexture,
  Group,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  Object3D,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

import type { QualitySettings } from '@/core/Config';
import type { EngineContext, RenderPipeline } from '@/core/Engine';
import { Rng } from '@/math/rng';
import { activeShot, registerShot } from '@/game/Shots';
import { registerShaderChunks } from '@/shaders/chunks';
import { motionJumped } from './motionJump';
import { MAX_MOTION_EXCLUSIONS, motionExclusionBuffer } from './motionExclusion'; // v3 T4

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

/**
 * All passes draw the same fullscreen triangle from `FullScreenQuad`, whose
 * vertices are already in clip space — no matrices needed.
 */
const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const LUMA_GLSL = /* glsl */ `
const vec3 OS_LUMA = vec3(0.2126, 0.7152, 0.0722);
float os_luma(vec3 c) { return dot(c, OS_LUMA); }
`;

/** Per-tier tuning that has no home in QualitySettings. */
interface TierBudget {
  readonly bloomLevels: number;
  readonly streakPasses: number;
  readonly motionSamples: number;
  readonly aoSamples: number;
}

function budgetFor(q: QualitySettings): TierBudget {
  switch (q.tier) {
    case 'low':
      return { bloomLevels: 4, streakPasses: 2, motionSamples: 6, aoSamples: 6 };
    case 'medium':
      return { bloomLevels: 5, streakPasses: 2, motionSamples: 7, aoSamples: 8 };
    case 'ultra':
      return { bloomLevels: 6, streakPasses: 3, motionSamples: 12, aoSamples: 12 };
    default:
      return { bloomLevels: 6, streakPasses: 3, motionSamples: 8, aoSamples: 8 };
  }
}

/**
 * Which bloom mip feeds the streak. Mip 1 is quarter resolution: low enough to
 * be nearly free, high enough that the streak keeps its vertical sharpness.
 * Taking it from mip 2 or 3 turns every highlight into a wide horizontal slab.
 */
const STREAK_SOURCE_MIP = 1;

/**
 * Shutter angle, as a fraction of the frame interval. A reprojection blur that
 * spans the *whole* frame-to-frame delta is a 360 degree shutter — twice what
 * any camera has ever had, and it reads as vaseline rather than as motion.
 * Film is 180 degrees; 0.6 gives that plus a touch, which is what games use to
 * sell weight without losing readability.
 */
const MOTION_SHUTTER = 0.6;

function makeTarget(w: number, h: number, name: string): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = name;
  return rt;
}

// ---------------------------------------------------------------------------
// 1. Scene-space pass: ambient occlusion + reprojected motion blur
// ---------------------------------------------------------------------------

/**
 * One full-resolution pass that reconstructs view-space position from the
 * logarithmic depth buffer and uses it for two things: a cheap hemisphere AO
 * on near geometry, and a reprojection motion blur against last frame's
 * view-projection matrix.
 *
 * The depth buffer is logarithmic (see ARCHITECTURE §3), so linearisation is
 *   d = log2(1 + w) / log2(far + 1)   =>   w = pow(far + 1, d) - 1
 * where `w` is the positive view-space distance in kilometres.
 */
class SceneSpacePass extends Pass {
  readonly material: ShaderMaterial;

  constructor(
    private readonly quad: FullScreenQuad,
    budget: TierBudget,
    useAo: boolean,
    useMotion: boolean,
  ) {
    super();
    this.needsSwap = true;
    this.material = new ShaderMaterial({
      name: 'os.scenespace',
      defines: {
        AO_SAMPLES: budget.aoSamples,
        MOTION_SAMPLES: budget.motionSamples,
        USE_AO: useAo ? 1 : 0,
        USE_MOTION: useMotion ? 1 : 0,
      },
      uniforms: {
        tDiffuse: { value: null as Texture | null },
        tDepth: { value: null as Texture | null },
        /** log2(camera.far + 1) — the logarithmic depth decoder. */
        uLogFar: { value: 40 },
        /** projectionMatrix[0][0] and [1][1]; unprojects uv to a view ray. */
        uProj: { value: new Vector2(1, 1) },
        uCamToWorld: { value: new Matrix4() },
        uPrevViewProj: { value: new Matrix4() },
        /** x: blur scale, y: max screen-space smear (uv), z: near cutoff (km). */
        uMotion: { value: new Vector3(MOTION_SHUTTER, 0.022, 0.25) },
        /** x: world radius (km), y: bias, z: intensity, w: far fade (km). */
        uAo: { value: new Vector4(0.05, 0.04, 0.9, 60) },
        uTexel: { value: new Vector2(1 / 1920, 1 / 1080) },
        // v3 T4: render-space spheres left sharp (render/motionExclusion.ts).
        uExclude: { value: motionExclusionBuffer },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        #include <onespace_color>
        ${LUMA_GLSL}
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uLogFar;
        uniform vec2 uProj;
        uniform mat4 uCamToWorld;
        uniform mat4 uPrevViewProj;
        uniform vec3 uMotion;
        uniform vec4 uAo;
        uniform vec2 uTexel;
        uniform vec4 uExclude[${MAX_MOTION_EXCLUSIONS}]; // v3 T4
        varying vec2 vUv;

        float viewDist(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          return exp2(d * uLogFar) - 1.0;
        }

        vec3 viewPos(vec2 uv, float w) {
          vec2 ndc = uv * 2.0 - 1.0;
          return vec3(ndc.x * w / uProj.x, ndc.y * w / uProj.y, -w);
        }

        #if AO_SAMPLES > 0
        // Fixed vogel-ish disc; rotated per pixel so the 8 taps read as noise
        // rather than as eight rings.
        vec2 discSample(int i, float rot) {
          float fi = float(i) + 0.5;
          float a = fi * 2.39996323 + rot;              // golden angle
          float r = sqrt(fi / float(AO_SAMPLES));
          return vec2(cos(a), sin(a)) * r;
        }
        #endif

        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          float w = viewDist(vUv);
          vec3 p = viewPos(vUv, w);

          #if USE_MOTION == 1
          {
            // Reproject through the previous frame's view-projection. Geometry
            // closer than uMotion.z is cockpit/hull that rides with the camera:
            // reprojection would smear it even though it never moves on screen,
            // so it is faded out. Real velocity buffers solve this properly;
            // this costs nothing and is invisible in practice.
            vec4 world = uCamToWorld * vec4(p, 1.0);
            vec4 prev = uPrevViewProj * world;
            vec2 prevUv = prev.xy / max(abs(prev.w), 1e-6) * sign(prev.w) * 0.5 + 0.5;
            vec2 vel = (vUv - prevUv) * uMotion.x;
            float near = smoothstep(uMotion.z * 0.5, uMotion.z * 2.0, w);
            vel *= near;
            // --- v3 T4: per-object exclusion (traffic) ------------------------
            // A co-orbiting hull moves with the ship, not with the ground the
            // blur is referenced to; inside its sphere the pixel stays sharp.
            for (int k = 0; k < ${MAX_MOTION_EXCLUSIONS}; k++) {
              vec4 ex = uExclude[k];
              if (ex.w > 0.0) vel *= smoothstep(ex.w * 0.85, ex.w, distance(world.xyz, ex.xyz));
            }
            // --- end v3 T4 ----------------------------------------------------
            float len = length(vel);
            if (len > uMotion.y) vel *= uMotion.y / len;
            if (len > 1e-5) {
              // Jitter the gather so the samples do not band into ghost copies.
              float j = os_igNoise(gl_FragCoord.xy) - 0.5;
              vec3 sum = vec3(0.0);
              for (int i = 0; i < MOTION_SAMPLES; i++) {
                float t = (float(i) + 0.5 + j) / float(MOTION_SAMPLES) - 0.5;
                sum += texture2D(tDiffuse, vUv + vel * t).rgb;
              }
              color = sum / float(MOTION_SAMPLES);
            }
          }
          #endif

          #if USE_AO == 1
          {
            // Only near geometry is occluded. A planet limb 20 000 km away has
            // no business growing a contact shadow, and screen-space AO at that
            // scale produces halos, so it fades out with distance.
            float fade = 1.0 - smoothstep(uAo.w * 0.5, uAo.w, w);
            if (fade > 0.001) {
              vec3 n = normalize(cross(dFdx(p), dFdy(p)));
              float rot = os_igNoise(gl_FragCoord.xy) * 6.2831853;
              // World radius projected to uv: r / w scaled by the focal term.
              float radiusUv = uAo.x / max(w, 1e-4) * uProj.y * 0.5;
              radiusUv = clamp(radiusUv, uTexel.y, 0.08);
              float occ = 0.0;
              for (int i = 0; i < AO_SAMPLES; i++) {
                vec2 o = discSample(i, rot) * radiusUv;
                o.x *= uProj.y / uProj.x;   // keep the disc circular on screen
                vec2 suv = clamp(vUv + o, vec2(0.0), vec2(1.0));
                float sw = viewDist(suv);
                vec3 sp = viewPos(suv, sw);
                vec3 v = sp - p;
                float d = length(v);
                float h = max(dot(n, v / max(d, 1e-6)) - uAo.y, 0.0);
                occ += h / (1.0 + d / uAo.x);
              }
              float ao = 1.0 - clamp(occ / float(AO_SAMPLES) * uAo.z, 0.0, 1.0);
              color *= mix(1.0, ao, fade);
            }
          }
          #endif

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms.uTexel.value as Vector2).set(1 / width, 1 / height);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    // Always take depth from the buffer the scene was actually rendered into.
    // The composer's two buffers each own a private DepthTexture, so writing
    // into `writeBuffer` while sampling `readBuffer`'s depth is not a feedback
    // loop — which is exactly why this pass may only ever run once.
    u.tDepth.value = readBuffer.depthTexture;
    this.quad.material = this.material;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// 2. Luminance pyramid + damped auto exposure
// ---------------------------------------------------------------------------

/**
 * Centre- AND subject-weighted average log-luminance, reduced 64 -> 16 -> 4 -> 1
 * and then eased into a persistent 1x1 target. Everything stays on the GPU: a
 * readback would stall the pipeline for a value we only use to scale one
 * multiply.
 *
 * SUBJECT WEIGHTING is the important part, and it is what a plain mean-luminance
 * meter gets wrong in this game. A nebula frame is 90% empty space; a ship in
 * deep space is 85% empty space. The arithmetic (or geometric) mean of such a
 * frame is a measurement of the *void*, not of the thing the shot is about, and
 * it lands within a few percent of the same number whether the subject is a
 * bright emission nebula or a dark hull — so it carries almost no information
 * about how the frame should be exposed. Worse, it is a feedback loop: the meter
 * tries to drive the void itself to the key, which is exactly the failure the
 * old three-stop clamp existed to suppress. Clamping a broken measurement is not
 * the same as measuring the right thing.
 *
 * So each tap carries a weight that rises with its own luminance
 * (`uSubject.x .. uSubject.y`, a smoothstep in scene-linear units), plus a small
 * baseline so a frame with no subject at all still divides by something. The
 * reduction is unchanged — it was already a weighted sum over a weight sum, the
 * weights simply mean more now. Empty space contributes ~2% of the weight of a
 * lit surface, so the meter reports the subject's level and the exposure is free
 * to span the range this game actually covers.
 *
 * The iris closes faster than it opens, like a real one — flying into sunlight
 * stops down over ~1.1 s, flying into shadow opens up over ~2.2 s.
 */
class LuminancePass extends Pass {
  private readonly rts: WebGLRenderTarget[] = [];
  private readonly adapt: [WebGLRenderTarget, WebGLRenderTarget];
  private adaptIndex = 0;
  private readonly reduceMat: ShaderMaterial;
  private readonly sampleMat: ShaderMaterial;
  private readonly adaptMat: ShaderMaterial;
  private first = true;

  /** 1x1 target holding log2(adapted luminance) in .r. */
  get texture(): Texture {
    return this.adapt[this.adaptIndex].texture;
  }

  constructor(private readonly quad: FullScreenQuad) {
    super();
    this.needsSwap = false;

    for (let size = 64; size >= 1; size = size >> 2) this.rts.push(makeTarget(size, size, `os.lum${size}`));
    this.adapt = [makeTarget(1, 1, 'os.adaptA'), makeTarget(1, 1, 'os.adaptB')];

    this.sampleMat = new ShaderMaterial({
      name: 'os.lum.sample',
      uniforms: {
        tDiffuse: { value: null as Texture | null },
        uTexel: { value: new Vector2() },
        /**
         * Metering clamp, in scene-linear units. The floor bounds how far one
         * black tap can drag a *geometric* mean (log2(0) is -inf, and even
         * log2(1e-6) is -20 stops of pull); the ceiling stops one 10^5 star core
         * from stopping the whole lens down.
         */
        uClamp: { value: new Vector2(3e-3, 24) },
        /**
         * Subject discrimination. x/y are the scene-linear luminances between
         * which a tap goes from "void" to "subject"; z is the weight void keeps
         * so that a genuinely empty frame still meters something instead of
         * dividing by zero.
         *
         * x is set just above the level of interstellar dust and just below the
         * dimmest thing that is meant to read as lit — a nebula filament sits
         * around 0.02, a hull in planetshine around 0.01, and true void is
         * several orders below both.
         */
        uSubject: { value: new Vector3(2.5e-3, 7.5e-3, 0.02) },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        ${LUMA_GLSL}
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform vec2 uClamp;
        uniform vec3 uSubject;
        varying vec2 vUv;
        void main() {
          // Four taps spread across the source footprint. Undersampling adds
          // temporal noise, which the 1-2 s adaptation filters out completely.
          vec3 c = texture2D(tDiffuse, vUv + vec2(-2.0, -2.0) * uTexel).rgb
                 + texture2D(tDiffuse, vUv + vec2( 2.0, -2.0) * uTexel).rgb
                 + texture2D(tDiffuse, vUv + vec2(-2.0,  2.0) * uTexel).rgb
                 + texture2D(tDiffuse, vUv + vec2( 2.0,  2.0) * uTexel).rgb;
          float raw = os_luma(c * 0.25);
          float l = clamp(raw, uClamp.x, uClamp.y);
          // Centre-weighted metering: the frame is exposed for what the pilot
          // is looking at, not for the corner the sun happens to sit in.
          vec2 d = vUv - 0.5;
          float centre = mix(0.25, 1.0, 1.0 - smoothstep(0.1, 0.55, length(d)));
          // Subject weighting — see the class comment. Measured on the *raw*
          // luminance, not the clamped one, so the metering floor cannot make
          // the void look like a subject.
          float subject = smoothstep(uSubject.x, uSubject.y, raw);
          float wgt = centre * (uSubject.z + subject);
          gl_FragColor = vec4(log2(l) * wgt, wgt, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.reduceMat = new ShaderMaterial({
      name: 'os.lum.reduce',
      uniforms: {
        tDiffuse: { value: null as Texture | null },
        uTexel: { value: new Vector2() },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          // 4 bilinear taps = a 4x4 box on the source.
          vec4 s = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel)
                 + texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel)
                 + texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel)
                 + texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel);
          gl_FragColor = s * 0.25;
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.adaptMat = new ShaderMaterial({
      name: 'os.lum.adapt',
      uniforms: {
        tPrev: { value: null as Texture | null },
        tCur: { value: null as Texture | null },
        uDt: { value: 1 / 60 },
        /** x: time constant closing down, y: opening up, z: 1 on the first frame. */
        uTau: { value: new Vector3(1.1, 2.2, 1) },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tPrev;
        uniform sampler2D tCur;
        uniform float uDt;
        uniform vec3 uTau;
        void main() {
          vec2 c = texture2D(tCur, vec2(0.5)).rg;
          float target = c.r / max(c.g, 1e-5);
          float prev = texture2D(tPrev, vec2(0.5)).r;
          float tau = target > prev ? uTau.x : uTau.y;
          float k = 1.0 - exp(-uDt / max(tau, 1e-3));
          float v = mix(prev, target, clamp(k, 0.0, 1.0));
          gl_FragColor = vec4(mix(v, target, uTau.z), 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
  }

  render(
    renderer: WebGLRenderer,
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
    deltaTime: number,
  ): void {
    const srcW = readBuffer.width;
    const srcH = readBuffer.height;

    this.sampleMat.uniforms.tDiffuse.value = readBuffer.texture;
    (this.sampleMat.uniforms.uTexel.value as Vector2).set(1 / srcW, 1 / srcH);
    this.quad.material = this.sampleMat;
    renderer.setRenderTarget(this.rts[0]);
    this.quad.render(renderer);

    this.quad.material = this.reduceMat;
    for (let i = 1; i < this.rts.length; i++) {
      const src = this.rts[i - 1];
      this.reduceMat.uniforms.tDiffuse.value = src.texture;
      (this.reduceMat.uniforms.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.rts[i]);
      this.quad.render(renderer);
    }

    const prev = this.adapt[this.adaptIndex];
    const next = this.adapt[this.adaptIndex ^ 1];
    this.adaptMat.uniforms.tPrev.value = prev.texture;
    this.adaptMat.uniforms.tCur.value = this.rts[this.rts.length - 1].texture;
    this.adaptMat.uniforms.uDt.value = deltaTime;
    (this.adaptMat.uniforms.uTau.value as Vector3).z = this.first ? 1 : 0;
    this.quad.material = this.adaptMat;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.adaptIndex ^= 1;
    this.first = false;
  }

  /** Forces the iris to snap on the next frame — used after a scene cut. */
  resetAdaptation(): void {
    this.first = true;
  }

  dispose(): void {
    for (const rt of this.rts) rt.dispose();
    this.adapt[0].dispose();
    this.adapt[1].dispose();
    this.sampleMat.dispose();
    this.reduceMat.dispose();
    this.adaptMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// 3. Bloom pyramid + anamorphic streak
// ---------------------------------------------------------------------------

/**
 * Multi-scale bloom, Jimenez/COD style: a soft-knee bright pass, a 13-tap
 * downsample chain with a Karis average on the first level (which is what stops
 * a single 10^5 star texel from strobing), then a 9-tap tent upsample chain
 * blended additively back up the pyramid.
 *
 * Why this and not UnrealBloomPass: a fixed 5-tap gaussian per level gives the
 * same radius to a star and to an instrument LED. Here the pyramid does it for
 * free — a huge bright source survives to the 1/64 mip and blooms across the
 * frame, a two-pixel LED dies after the second downsample and keeps a tight,
 * hot core. That difference is most of what separates a film frame from a
 * WebGL demo.
 *
 * The streak is a separate horizontal-only chain off mip 1, three passes with
 * geometrically growing stride so 6 taps reach ~200 source texels, blue-shifted
 * per channel because that is what a real anamorphic element does to a highlight.
 */
class BloomPass extends Pass {
  private mips: WebGLRenderTarget[] = [];
  private streakRts: [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  private streakOut: WebGLRenderTarget | null = null;
  private readonly prefilterMat: ShaderMaterial;
  private readonly downMat: ShaderMaterial;
  private readonly upMat: ShaderMaterial;
  private readonly streakMat: ShaderMaterial;
  private readonly levels: number;
  private readonly streakPasses: number;

  /**
   * Threshold in *scene-linear* units above which a pixel is an emitter. It is
   * deliberately pre-exposure: the scene is authored in physical-ish units, so
   * what bloom is a property of the surface, not of the current iris.
   */
  threshold = 1.0;
  knee = 0.55;
  /** Length of the streak as a fraction of frame width. Keep it restrained. */
  streakLength = 0.17;
  /**
   * Only pixels this far above the bright pass streak at all. Set low and every
   * warning light in the cockpit grows a flare and the frame turns to soup;
   * this keeps the streak for stars, thruster cores and welding arcs.
   */
  streakThreshold = 2.5;
  /**
   * Per-octave upsample taper. Equal weights (a true 1/r^2 glare PSF) veil the
   * whole frame in a milky wash; a good lens is far tighter than that. 0.72
   * keeps the near halo and kills the frame-wide fog.
   */
  bloomTaper = 0.72;

  get texture(): Texture | null {
    return this.mips.length ? this.mips[0].texture : null;
  }

  get streakTexture(): Texture | null {
    return this.streakOut ? this.streakOut.texture : null;
  }

  constructor(private readonly quad: FullScreenQuad, budget: TierBudget) {
    super();
    this.needsSwap = false;
    this.levels = budget.bloomLevels;
    this.streakPasses = budget.streakPasses;

    const downSrc = /* glsl */ `
      ${LUMA_GLSL}
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform vec4 uPrefilter;
      varying vec2 vUv;

      vec3 T(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }

      void main() {
        vec3 a = T(vec2(-2.0,  2.0)); vec3 b = T(vec2(0.0,  2.0)); vec3 c = T(vec2(2.0,  2.0));
        vec3 d = T(vec2(-2.0,  0.0)); vec3 e = T(vec2(0.0,  0.0)); vec3 f = T(vec2(2.0,  0.0));
        vec3 g = T(vec2(-2.0, -2.0)); vec3 h = T(vec2(0.0, -2.0)); vec3 i = T(vec2(2.0, -2.0));
        vec3 j = T(vec2(-1.0,  1.0)); vec3 k = T(vec2(1.0,  1.0));
        vec3 l = T(vec2(-1.0, -1.0)); vec3 m = T(vec2(1.0, -1.0));

        vec3 g0 = (j + k + l + m) * 0.25;
        vec3 g1 = (a + b + d + e) * 0.25;
        vec3 g2 = (b + c + e + f) * 0.25;
        vec3 g3 = (d + e + g + h) * 0.25;
        vec3 g4 = (e + f + h + i) * 0.25;

        #ifdef KARIS
          // Weight each group by 1/(1+luma) before averaging. Without this a
          // single sub-pixel specular hit aliases into a crawling firefly.
          float w0 = 0.5   / (1.0 + os_luma(g0));
          float w1 = 0.125 / (1.0 + os_luma(g1));
          float w2 = 0.125 / (1.0 + os_luma(g2));
          float w3 = 0.125 / (1.0 + os_luma(g3));
          float w4 = 0.125 / (1.0 + os_luma(g4));
          vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4)
                   / max(w0 + w1 + w2 + w3 + w4, 1e-5);
        #else
          vec3 col = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
        #endif

        #ifdef PREFILTER
          // Soft-knee bright pass (uPrefilter = threshold, threshold-knee,
          // 2*knee, 0.25/knee). A hard cut pops as an object crosses it.
          float br = max(max(col.r, col.g), col.b);
          float rq = clamp(br - uPrefilter.y, 0.0, uPrefilter.z);
          rq = rq * rq * uPrefilter.w;
          col *= max(rq, br - uPrefilter.x) / max(br, 1e-5);
        #endif

        gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
      }
    `;

    const mkDown = (defines: Record<string, number>, name: string): ShaderMaterial =>
      new ShaderMaterial({
        name,
        defines,
        uniforms: {
          tSrc: { value: null as Texture | null },
          uTexel: { value: new Vector2() },
          uPrefilter: { value: new Vector4() },
        },
        vertexShader: FS_VERT,
        fragmentShader: downSrc,
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
      });

    this.prefilterMat = mkDown({ KARIS: 1, PREFILTER: 1 }, 'os.bloom.prefilter');
    this.downMat = mkDown({}, 'os.bloom.down');

    this.upMat = new ShaderMaterial({
      name: 'os.bloom.up',
      uniforms: {
        tSrc: { value: null as Texture | null },
        uTexel: { value: new Vector2() },
        uRadius: { value: 1 },
        uWeight: { value: 1 },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc;
        uniform vec2 uTexel;
        uniform float uRadius;
        uniform float uWeight;
        varying vec2 vUv;
        vec3 T(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
        void main() {
          // 9-tap tent. Cheaper than a gaussian and, chained up six levels,
          // indistinguishable from one.
          vec3 s = T(vec2(-1.0,  1.0)) + T(vec2(0.0,  1.0)) * 2.0 + T(vec2(1.0,  1.0))
                 + T(vec2(-1.0,  0.0)) * 2.0 + T(vec2(0.0, 0.0)) * 4.0 + T(vec2(1.0, 0.0)) * 2.0
                 + T(vec2(-1.0, -1.0)) + T(vec2(0.0, -1.0)) * 2.0 + T(vec2(1.0, -1.0));
          gl_FragColor = vec4(s * (1.0 / 16.0) * uWeight, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.streakMat = new ShaderMaterial({
      name: 'os.bloom.streak',
      uniforms: {
        tSrc: { value: null as Texture | null },
        uTexel: { value: new Vector2() },
        /** x: stride in texels, y: falloff distance in texels, z: threshold, w: tint mix. */
        uStreak: { value: new Vector4(1, 24, 0.35, 0) },
        uTint: { value: new Color(0.74, 0.87, 1.0) },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        ${LUMA_GLSL}
        uniform sampler2D tSrc;
        uniform vec2 uTexel;
        uniform vec4 uStreak;
        uniform vec3 uTint;
        varying vec2 vUv;

        #define STREAK_TAPS 7

        vec3 fetch(vec2 uv, float dTexels) {
          // Per-channel horizontal offset: the blue end of a highlight throws
          // slightly further through an anamorphic element than the red end.
          // Hard-capped at a couple of texels — let it scale with tap distance
          // and the tail separates into a rainbow, which reads as a bug.
          float s = clamp(dTexels * 0.08, -2.0, 2.0) * uTexel.x * uStreak.w;
          vec3 c;
          c.r = texture2D(tSrc, uv - vec2(s, 0.0)).r;
          c.g = texture2D(tSrc, uv).g;
          c.b = texture2D(tSrc, uv + vec2(s * 1.35, 0.0)).b;
          return c;
        }

        void main() {
          vec3 sum = vec3(0.0);
          float wsum = 0.0;
          for (int i = 0; i < STREAK_TAPS; i++) {
            float o = float(i) - float(STREAK_TAPS - 1) * 0.5;
            float dist = o * uStreak.x;
            // Falloff by *distance*, not per tap. With per-tap attenuation and
            // a stride that grows 5x per pass, the far taps end up as bright as
            // the near ones and the streak becomes a bar across the frame.
            float w = exp(-abs(dist) / max(uStreak.y, 1e-3));
            sum += fetch(vUv + vec2(dist * uTexel.x, 0.0), dist) * w;
            wsum += w;
          }
          vec3 col = sum / max(wsum, 1e-5);
          // Only genuinely hot pixels streak. Everything else would smear.
          col = max(col - uStreak.z, vec3(0.0));
          // Tint once, on the last pass. Applied per pass it compounds into a
          // saturated green-cyan slab.
          gl_FragColor = vec4(mix(col, col * uTint, uStreak.w), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
  }

  setSize(width: number, height: number): void {
    this.disposeTargets();
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    this.mips = [];
    for (let i = 0; i < this.levels; i++) {
      this.mips.push(makeTarget(w, h, `os.bloom.mip${i}`));
      if (w <= 2 || h <= 2) break;
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    if (this.streakPasses > 0 && this.mips.length > STREAK_SOURCE_MIP) {
      const sw = this.mips[STREAK_SOURCE_MIP].width;
      const sh = this.mips[STREAK_SOURCE_MIP].height;
      this.streakRts = [makeTarget(sw, sh, 'os.streakA'), makeTarget(sw, sh, 'os.streakB')];
      this.streakOut = null;
    }
  }

  render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    if (!this.mips.length) return;
    const oldAutoClear = renderer.autoClear;
    // Every draw here covers its whole target, and the upsample steps must
    // accumulate — so clearing is both unnecessary and wrong.
    renderer.autoClear = false;

    const knee = Math.max(this.knee, 1e-4);
    (this.prefilterMat.uniforms.uPrefilter.value as Vector4).set(
      this.threshold,
      this.threshold - knee,
      2 * knee,
      0.25 / knee,
    );
    this.prefilterMat.uniforms.tSrc.value = readBuffer.texture;
    (this.prefilterMat.uniforms.uTexel.value as Vector2).set(1 / readBuffer.width, 1 / readBuffer.height);
    this.quad.material = this.prefilterMat;
    renderer.setRenderTarget(this.mips[0]);
    this.quad.render(renderer);

    this.quad.material = this.downMat;
    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      this.downMat.uniforms.tSrc.value = src.texture;
      (this.downMat.uniforms.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.mips[i]);
      this.quad.render(renderer);
    }

    // The streak is taken here, BEFORE the upsample chain runs, because the
    // upsample adds every coarser octave back into mip 1. Reading it afterwards
    // would feed the streak an already-veiled signal several times brighter
    // than the bright pass, so `streakThreshold` would no longer mean what it
    // says and half the frame would grow flares.
    if (this.streakRts && this.streakPasses > 0) {
      // Indexed rather than destructured: `const [a, b] = tuple` goes through
      // the array iterator protocol, which allocates — every frame, forever
      // (ARCHITECTURE §5).
      const a = this.streakRts[0];
      const b = this.streakRts[1];
      // Stride grows 5x per pass so N passes reach 3*(1 + 5 + 25 ...) source
      // texels. Solve the base stride from the requested fraction of frame
      // width, so the streak is the same length at every resolution.
      let sum = 0;
      for (let p = 0; p < this.streakPasses; p++) sum += Math.pow(5, p);
      const reachTexels = this.streakLength * a.width;
      const base = Math.max(1, reachTexels / (3 * sum));
      let src: Texture = this.mips[STREAK_SOURCE_MIP].texture;
      let dst = a;
      let other = b;
      this.quad.material = this.streakMat;
      (this.streakMat.uniforms.uTexel.value as Vector2).set(1 / a.width, 1 / a.height);
      for (let p = 0; p < this.streakPasses; p++) {
        const u = this.streakMat.uniforms.uStreak.value as Vector4;
        u.x = base * Math.pow(5, p);
        u.y = reachTexels * 0.42;
        // Threshold only on the first pass; afterwards the signal is already
        // spread thin and thresholding again would chop the tail off.
        u.z = p === 0 ? this.streakThreshold : 0;
        u.w = p === this.streakPasses - 1 ? 1 : 0;
        this.streakMat.uniforms.tSrc.value = src;
        renderer.setRenderTarget(dst);
        this.quad.render(renderer);
        src = dst.texture;
        const swap = dst;
        dst = other;
        other = swap;
      }
      this.streakOut = other;
    }

    // Upsample. Each octave is added with a taper, so a star core — which
    // survives all the way to the 1/64 mip — still throws a halo across a
    // sixth of the screen, while a two-pixel LED that dies after the second
    // downsample keeps a tight, hot core. That difference is the whole point.
    this.quad.material = this.upMat;
    for (let i = this.mips.length - 1; i >= 1; i--) {
      const src = this.mips[i];
      this.upMat.uniforms.tSrc.value = src.texture;
      (this.upMat.uniforms.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
      this.upMat.uniforms.uRadius.value = 1;
      // Constant per-step weight => level k contributes taper^k to mip 0.
      this.upMat.uniforms.uWeight.value = this.bloomTaper;
      renderer.setRenderTarget(this.mips[i - 1]);
      this.quad.render(renderer);
    }

    renderer.autoClear = oldAutoClear;
  }

  private disposeTargets(): void {
    for (const rt of this.mips) rt.dispose();
    this.mips = [];
    if (this.streakRts) {
      this.streakRts[0].dispose();
      this.streakRts[1].dispose();
      this.streakRts = null;
    }
    this.streakOut = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.prefilterMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.streakMat.dispose();
  }
}

// ---------------------------------------------------------------------------
// 4. The grade
// ---------------------------------------------------------------------------

/**
 * One pass: composite, expose, tone map, and grade.
 *
 * The curve is deliberately not a "neutral" one. After ACES the image is pushed
 * through a log-space contrast around a low pivot, a hyperbolic shoulder that
 * asymptotes to 0.93 rather than paper white, a black lift that puts the
 * darkest pixel at ~0.03, and a split tone that runs steel-cyan in the shadows
 * and sodium-amber in the highlights. That combination is the entire noir look:
 * nothing is ever pure black, nothing is ever pure white, and the only
 * saturated things in frame are the emitters.
 */
class GradePass extends Pass {
  readonly material: ShaderMaterial;

  constructor(private readonly quad: FullScreenQuad, useCa: boolean) {
    super();
    this.needsSwap = true;
    this.material = new ShaderMaterial({
      name: 'os.grade',
      defines: { USE_CA: useCa ? 1 : 0 },
      uniforms: {
        tDiffuse: { value: null as Texture | null },
        tBloom: { value: null as Texture | null },
        tStreak: { value: null as Texture | null },
        tLum: { value: null as Texture | null },
        uBloom: { value: 0.7 },
        uStreak: { value: 0.16 },
        /**
         * x: exposure compensation, y: metering key, z/w: exposure clamp.
         *
         * The clamp used to be about three stops (0.25 .. 1.6), which is what a
         * mean-luminance meter needs to stop it opening the iris until the void
         * turns grey. The cost was that it did not expose anything: metered
         * against the void, 22 of the 24 review shots — a nebula, a galactic
         * band, a lit planet, a ship, and a star seen from 0.01 AU alike — came
         * out pinned to the *same* end of that clamp, ev = 1.6. A three-stop
         * iris cannot straddle a fifteen-stop game, so it stops straddling and
         * just saturates, and every frame that is not itself a light source
         * lands in the mud.
         *
         * Now that LuminancePass meters the subject rather than the void (see
         * its class comment), the iris can be given the range it needs — about
         * six stops, 0.15 .. 12 — without the void chasing the key, because the
         * void no longer carries the vote. Empty space is still empty space:
         * multiplying a near-zero radiance by 12 leaves it near zero, and the
         * black lift below is what actually decides how dark black is.
         */
        uExposure: { value: new Vector4(1, 0.25, 0.15, 12) },
        /**
         * How much of the metered error the iris actually corrects, as an
         * exponent on the measurement: 1 is a full auto-exposure that drives
         * every subject to the same mid-grey, 0 disables metering entirely.
         *
         * This is the knob that keeps the brief's intent — auto exposure is a
         * correction on top of a physically authored key light, not a
         * replacement for one. At 1.0 a ship that is *meant* to be a dark shape
         * in deep space is normalised to exactly the same grey as a nebula that
         * is meant to glow, and the authored lighting stops meaning anything.
         * At 0.65 a subject four stops below the key is brought up two and a
         * half, which is enough to make it read and not enough to erase the
         * difference between a dim scene and a bright one.
         */
        uMeterGain: { value: 0.65 },
        uFlash: { value: 0 },
        uCa: { value: 0.0055 },
        /** x: contrast, y: pivot, z: shoulder start, w: white point. */
        uCurve: { value: new Vector4(1.3, 0.36, 0.56, 0.95) },
        /** x: black lift, y: shadow saturation, z: highlight saturation. */
        uNoir: { value: new Vector3(0.03, 0.42, 0.95) },
        uShadowTint: { value: new Color(0.84, 0.97, 1.14) },
        uHighTint: { value: new Color(1.12, 1.0, 0.84) },
        /** x: strength, y: inner radius, z: vertical ellipse factor. */
        uVignette: { value: new Vector3(0.62, 0.26, 1.22) },
        uAspect: { value: 16 / 9 },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        #include <onespace_color>
        ${LUMA_GLSL}
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform sampler2D tStreak;
        uniform sampler2D tLum;
        uniform float uBloom;
        uniform float uStreak;
        uniform vec4 uExposure;
        uniform float uMeterGain;
        uniform float uFlash;
        uniform float uCa;
        uniform vec4 uCurve;
        uniform vec3 uNoir;
        uniform vec3 uShadowTint;
        uniform vec3 uHighTint;
        uniform vec3 uVignette;
        uniform float uAspect;
        varying vec2 vUv;

        vec3 sceneAt(vec2 uv) {
          vec3 c = texture2D(tDiffuse, uv).rgb;
          c += texture2D(tBloom, uv).rgb * uBloom;
          c += texture2D(tStreak, uv).rgb * uStreak;
          return c;
        }

        void main() {
          vec2 uv = vUv;
          vec3 hdr;

          #if USE_CA == 1
            // Transverse chromatic aberration: exactly zero at the optical
            // centre, growing with r^2 like a real uncorrected lens. The glow
            // is sampled through it too, because the lens does not know which
            // photons came from the bloom.
            vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
            float r2 = dot(d, d);
            vec2 off = d * r2 * uCa / vec2(uAspect, 1.0);
            hdr.r = sceneAt(uv - off).r;
            hdr.g = sceneAt(uv).g;
            hdr.b = sceneAt(uv + off).b;
          #else
            hdr = sceneAt(uv);
          #endif

          // --- exposure ------------------------------------------------------
          // The meter hands us log2 of the adapted subject luminance, so the
          // whole iris is one exp2 — no divide, no pow, and no chance of the
          // 1/x blowing up when the frame is genuinely dark.
          float logAvg = texture2D(tLum, vec2(0.5)).r;
          float ev = clamp(uExposure.y * exp2(-uMeterGain * logAvg), uExposure.z, uExposure.w);
          hdr *= ev * uExposure.x;
          // Flash is added AFTER the iris, not before. A hull breach is a fixed
          // number of photons arriving at the sensor; running it through a six
          // stop iris would make the same breach nine times brighter in deep
          // space than next to a star, which is backwards.
          hdr += uFlash * vec3(1.0, 0.97, 0.9) * 6.0;

          // --- tone map ------------------------------------------------------
          vec3 c = os_aces(hdr);
          c = os_linearToSrgb(c);

          // --- noir curve ----------------------------------------------------
          // Contrast about a low pivot, in display space where a curve behaves
          // the way a colourist expects it to.
          c = uCurve.y * pow(max(c / uCurve.y, 1e-5), vec3(uCurve.x));
          // Hyperbolic shoulder: highlights asymptote to uCurve.w, never 1.0.
          vec3 s = max(c - uCurve.z, vec3(0.0));
          c = min(c, vec3(uCurve.z)) + s / (1.0 + s / max(uCurve.w - uCurve.z, 1e-3));
          // Lifted blacks. pow(1-c, 3) confines the lift to the toe so the
          // midtones keep their contrast.
          vec3 inv = 1.0 - c;
          c += uNoir.x * inv * inv * inv;

          // --- split tone ----------------------------------------------------
          float l = os_luma(c);
          float sat = mix(uNoir.y, uNoir.z, smoothstep(0.0, 0.55, l));
          c = mix(vec3(l), c, sat);
          vec3 tint = mix(uShadowTint, uHighTint, smoothstep(0.05, 0.7, l));
          // Let a genuinely blown highlight go clean white. A split tone that
          // runs all the way to the top turns every flash and specular into
          // sepia, which reads as an old photograph rather than a hot light.
          tint = mix(tint, vec3(1.0), smoothstep(0.78, 0.99, l));
          c *= tint;

          // --- vignette ------------------------------------------------------
          // Elliptical: wider than tall, so it reads as a lens rather than a
          // circular mask pasted on the frame.
          vec2 v = (uv - 0.5) * vec2(1.0, uVignette.z);
          float vd = length(v) * 2.0;
          c *= 1.0 - uVignette.x * smoothstep(uVignette.y, 1.25, vd);

          gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.material;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// 5. FXAA + grain + dither
// ---------------------------------------------------------------------------

/**
 * The last thing that touches the frame. FXAA (the classic 5-tap console
 * variant — at 1080p with grain over the top the difference from FXAA 3.11 is
 * not visible, and it costs half as much), then film grain, then dither.
 *
 * Grain is luminance-weighted: real film grain lives in the shadows and all but
 * vanishes in a blown highlight, which is why uniform "noise overlay" grain
 * always looks like a filter and this does not.
 */
class FinalPass extends Pass {
  readonly material: ShaderMaterial;

  constructor(private readonly quad: FullScreenQuad, useGrain: boolean) {
    super();
    this.needsSwap = true;
    this.material = new ShaderMaterial({
      name: 'os.final',
      defines: { USE_GRAIN: useGrain ? 1 : 0 },
      uniforms: {
        tDiffuse: { value: null as Texture | null },
        uTexel: { value: new Vector2(1 / 1920, 1 / 1080) },
        uGrain: { value: 0.055 },
        uTime: { value: 0 },
        uFxaa: { value: 1 },
      },
      vertexShader: FS_VERT,
      fragmentShader: /* glsl */ `
        #include <onespace_noise>
        #include <onespace_color>
        ${LUMA_GLSL}
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform float uGrain;
        uniform float uTime;
        uniform float uFxaa;
        varying vec2 vUv;

        #define FXAA_SPAN_MAX 8.0
        #define FXAA_REDUCE_MUL (1.0 / 8.0)
        #define FXAA_REDUCE_MIN (1.0 / 128.0)

        vec3 fxaa(vec2 uv) {
          vec3 rgbNW = texture2D(tDiffuse, uv + vec2(-1.0, -1.0) * uTexel).rgb;
          vec3 rgbNE = texture2D(tDiffuse, uv + vec2( 1.0, -1.0) * uTexel).rgb;
          vec3 rgbSW = texture2D(tDiffuse, uv + vec2(-1.0,  1.0) * uTexel).rgb;
          vec3 rgbSE = texture2D(tDiffuse, uv + vec2( 1.0,  1.0) * uTexel).rgb;
          vec3 rgbM  = texture2D(tDiffuse, uv).rgb;

          float lNW = os_luma(rgbNW);
          float lNE = os_luma(rgbNE);
          float lSW = os_luma(rgbSW);
          float lSE = os_luma(rgbSE);
          float lM  = os_luma(rgbM);

          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

          vec2 dir = vec2(
            -((lNW + lNE) - (lSW + lSE)),
             ((lNW + lSW) - (lNE + lSE))
          );

          float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
          float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
          dir = clamp(dir * rcpDirMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * uTexel;

          vec3 rgbA = 0.5 * (
            texture2D(tDiffuse, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
            texture2D(tDiffuse, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
          vec3 rgbB = rgbA * 0.5 + 0.25 * (
            texture2D(tDiffuse, uv + dir * -0.5).rgb +
            texture2D(tDiffuse, uv + dir *  0.5).rgb);

          float lB = os_luma(rgbB);
          return (lB < lMin || lB > lMax) ? rgbA : rgbB;
        }

        void main() {
          vec3 c = uFxaa > 0.5 ? fxaa(vUv) : texture2D(tDiffuse, vUv).rgb;

          #if USE_GRAIN == 1
          {
            // Two decorrelated hashes per frame give a grain that crawls like
            // emulsion instead of flickering like TV static.
            vec3 seed = vec3(gl_FragCoord.xy, floor(uTime * 24.0));
            float n = os_hash13(seed) + os_hash13(seed.yxz + 17.13) - 1.0;
            float l = os_luma(c);
            // Grain peaks in the LOWER MIDTONES, not at Dmin. Unexposed
            // emulsion has no developed silver, so the deepest toe is nearly as
            // clean as a blown highlight — and, more practically, a flat 1.4x
            // weight down there is +-0.077 of noise sitting on a black lifted to
            // 0.03, which clips half the void back to pure zero and throws away
            // the entire point of the lift.
            float w = smoothstep(0.0, 0.10, l) * mix(1.35, 0.12, smoothstep(0.06, 0.7, l));
            c += n * uGrain * w;
          }
          #endif

          gl_FragColor = vec4(os_dither(max(c, vec3(0.0)), gl_FragCoord.xy), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms.uTexel.value as Vector2).set(1 / width, 1 / height);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.material;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Scene depth, published for the modules that sample it from *inside* the scene
// ---------------------------------------------------------------------------

/**
 * The depth attachment of the buffer the scene was last rendered into.
 *
 * `Atmosphere` needs scene depth while it is itself drawing inside the scene —
 * which is the one moment the current frame's depth attachment is bound for
 * writing, and sampling a texture that is attached to the bound framebuffer is
 * undefined behaviour, not a slightly wrong number. What *is* safe is the other
 * half of the composer's ping-pong pair: the chain swaps the two HDR targets an
 * odd number of times per frame, so the buffer that holds frame N's depth is
 * untouched for the whole of frame N+1. That is what this publishes.
 *
 * The consequence is that aerial perspective is keyed on depth one frame old.
 * On a field as smooth as haze that is invisible, and it has one property that
 * matters more than currency: the march, the extinction and the bilateral
 * upsample all read the *same* buffer, so they cannot disagree about where the
 * terrain is — a disagreement of one pixel there is a bright seam along a whole
 * ridge line. The alternative is a depth prepass, which would mean submitting
 * every planet's terrain quadtree twice.
 *
 * Null when no pipeline is live, on the first frame, and for one frame after a
 * resize — the attachments are reallocated there and their contents are
 * undefined until the next scene render fills them.
 */
let publishedSceneDepth: Texture | null = null;

/**
 * Full-resolution scene depth for modules that cannot use the composer
 * themselves. Logarithmic (`Engine` sets `logarithmicDepthBuffer`), so decode it
 * as `w = exp2(d * log2(camera.far + 1)) - 1`; `w` is then distance along the
 * camera axis in kilometres. Read it every frame — it is replaced on resize and
 * goes null when the pipeline is torn down.
 */
export function sceneDepthTexture(): Texture | null {
  return publishedSceneDepth;
}

/**
 * How far the ground under the ship moved through render space since the last
 * frame, km (see render/motionReference.ts). The motion-blur reprojection
 * assumes a world that stands still in render space; between floating-origin
 * rebases a world and the ship on it travel together at orbital speed, and on
 * the ground that read as a 0.9 km per frame dolly which smeared the hull and
 * the near terrain (measured, v2-landed). Universe publishes it once per frame;
 * the pipeline consumes it and zeroes it, so a frame nobody describes is
 * treated as a still world, which is what it was before this existed.
 */
const motionReference = new Vector3();

export function setMotionReferenceDisplacement(d: Vector3 | null): void {
  if (d) motionReference.copy(d);
  else motionReference.set(0, 0, 0);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export class PostFX implements RenderPipeline {
  readonly composer: EffectComposer;

  private readonly quad = new FullScreenQuad();
  private readonly renderPass: RenderPass;
  private readonly scenePass: SceneSpacePass | null;
  private readonly lumPass: LuminancePass;
  private readonly bloomPass: BloomPass;
  private readonly gradePass: GradePass;
  private readonly finalPass: FinalPass;
  private readonly hdrTarget: WebGLRenderTarget;
  private readonly blackTexture: Texture;

  // --- preallocated per-frame scratch (ARCHITECTURE §5: no allocation in the
  // frame loop) -------------------------------------------------------------
  private readonly size = new Vector2();
  private readonly prevViewProj = new Matrix4();
  private readonly curViewProj = new Matrix4();
  private readonly viewInverse = new Matrix4();
  private readonly camWorldPos = new Vector3();
  private readonly prevCamWorldPos = new Vector3();
  private readonly refScratch = new Vector3();
  private readonly refMatrix = new Matrix4();

  private exposureBias = 1;
  private exposureBiasTarget = 1;
  private flashValue = 0;
  private flashPeak = 0;
  private flashRemaining = 0;
  private flashDuration = 1;
  private hasPrevFrame = false;
  private prevOriginVersion = -1;
  private elapsed = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly quality: QualitySettings,
  ) {
    registerShaderChunks();

    // Every pass draws through `FullScreenQuad.render`, which is a full
    // `renderer.render()` call — and that resets `renderer.info` when
    // autoReset is on. The consequence is that `Engine.stats()` reports 1 draw
    // call and 1 triangle for the entire frame, so the < 400 draw call budget
    // in ARCHITECTURE §5 becomes unmeasurable the moment post is switched on.
    // Take ownership of the counter and reset it once, at the top of our frame.
    renderer.info.autoReset = false;

    const budget = budgetFor(quality);

    this.renderer.getDrawingBufferSize(this.size);
    this.hdrTarget = new WebGLRenderTarget(this.size.x, this.size.y, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.hdrTarget.texture.name = 'os.hdr';

    // A depth *texture* rather than the implicit renderbuffer, on every tier —
    // it is the same storage, and it is no longer only AO and motion blur that
    // want it. Every atmosphere in the game reads scene depth to stop its march
    // at the terrain, and on a tier without one a landscape has no distance
    // haze and the sky draws straight over the cockpit.
    //
    // The composer clones this target for its second buffer, and
    // RenderTarget.copy() *clones* the depth texture rather than sharing it.
    // Both buffers therefore own a private depth attachment, which is what
    // makes it safe for SceneSpacePass to read one while writing the other, and
    // what `sceneDepthTexture()` hands out.
    const depth = new DepthTexture(this.size.x, this.size.y, UnsignedIntType);
    depth.name = 'os.depth';
    depth.minFilter = NearestFilter;
    depth.magFilter = NearestFilter;
    this.hdrTarget.depthTexture = depth;

    this.composer = new EffectComposer(renderer, this.hdrTarget);
    // The engine already folded devicePixelRatio into the drawing buffer size;
    // letting the composer multiply by it again would render at 4x.
    this.composer.setPixelRatio(1);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.scenePass =
      quality.ambientOcclusion || quality.motionBlur
        ? new SceneSpacePass(this.quad, budget, quality.ambientOcclusion, quality.motionBlur)
        : null;
    if (this.scenePass) this.composer.addPass(this.scenePass);

    this.lumPass = new LuminancePass(this.quad);
    this.composer.addPass(this.lumPass);

    this.bloomPass = new BloomPass(this.quad, budget);
    this.bloomPass.enabled = quality.bloom;
    this.composer.addPass(this.bloomPass);

    this.gradePass = new GradePass(this.quad, quality.chromaticAberration);
    this.composer.addPass(this.gradePass);

    this.finalPass = new FinalPass(this.quad, quality.filmGrain);
    this.composer.addPass(this.finalPass);

    // 1x1 black stand-in so the grade's bloom/streak samplers are always bound,
    // even at boot or with bloom disabled. An unbound sampler2D is undefined
    // behaviour and shows up as a magenta or white frame on some drivers.
    this.blackTexture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blackTexture.needsUpdate = true;
    this.blackTexture.name = 'os.black';

    const g = this.gradePass.material.uniforms;
    // Level k contributes taper^k of its energy to mip 0, so the pyramid's
    // total gain is the geometric sum. Dividing it out keeps bloomStrength
    // meaning the same thing on every tier.
    let gain = 0;
    for (let k = 0; k < budget.bloomLevels; k++) gain += Math.pow(this.bloomPass.bloomTaper, k);
    g.uBloom.value = (quality.bloomStrength * 0.75) / gain;
    g.uStreak.value = quality.bloomStrength * 0.1;

    this.resize(this.size.x, this.size.y);
  }

  // -- public controls ------------------------------------------------------

  /**
   * Push the exposure up or down — the warp effect stops the lens down as the
   * tunnel brightens. 1 is neutral. Eased internally; nothing snaps.
   */
  setExposureBias(v: number): void {
    this.exposureBiasTarget = Math.max(0.02, v);
  }

  /**
   * Photo-mode grade overrides; null restores the authored grade. Values are
   * expected pre-clamped (game/photo/flycam.ts clampGrade). Exposure rides
   * the eased bias, so even a photo adjustment never snaps.
   */
  setGrade(g: { exposure?: number; grain?: number; ca?: number; vignette?: number } | null): void {
    const gu = this.gradePass.material.uniforms;
    const fu = this.finalPass.material.uniforms;
    if (!this.gradeDefaults) {
      this.gradeDefaults = {
        grain: fu.uGrain.value as number,
        ca: gu.uCa.value as number,
        vignette: (gu.uVignette.value as Vector3).x,
      };
    }
    const d = this.gradeDefaults;
    fu.uGrain.value = g?.grain ?? d.grain;
    gu.uCa.value = g?.ca ?? d.ca;
    (gu.uVignette.value as Vector3).x = g?.vignette ?? d.vignette;
    this.setExposureBias(g?.exposure ?? 1);
  }

  private gradeDefaults: { grain: number; ca: number; vignette: number } | null = null;

  /** Blow the frame out — jump entry, hull breach, a very close star. */
  flash(intensity: number, durationSeconds: number): void {
    this.flashPeak = Math.max(this.flashPeak, intensity);
    this.flashDuration = Math.max(durationSeconds, 1e-3);
    this.flashRemaining = this.flashDuration;
  }

  /** Snap the iris instead of easing it — for a hard cut between scenes. */
  resetExposure(): void {
    this.lumPass.resetAdaptation();
  }

  // -- frame ----------------------------------------------------------------

  render(dt: number, ctx: EngineContext): void {
    // See the constructor: we own renderer.info now, so the whole frame —
    // scene plus every post pass — accumulates into one honest count.
    this.renderer.info.reset();

    // ctx.elapsed rather than a local accumulator: the screenshot harness runs
    // a fixed timestep, and the grain must land identically on every machine.
    this.elapsed = ctx.elapsed;

    // Critically damped exposure bias: 6/s reaches 95% in ~0.5 s.
    this.exposureBias += (this.exposureBiasTarget - this.exposureBias) * Math.min(1, dt * 6);

    if (this.flashRemaining > 0) {
      this.flashRemaining = Math.max(0, this.flashRemaining - dt);
      const t = this.flashRemaining / this.flashDuration;
      this.flashValue = this.flashPeak * t * t;
      if (this.flashRemaining === 0) this.flashPeak = 0;
    } else {
      this.flashValue = 0;
    }

    const g = this.gradePass.material.uniforms;
    (g.uExposure.value as Vector4).x = this.exposureBias;
    g.uFlash.value = this.flashValue;
    g.uAspect.value = Math.max(this.size.x, 1) / Math.max(this.size.y, 1);
    g.tLum.value = this.lumPass.texture;
    g.tBloom.value = (this.bloomPass.enabled && this.bloomPass.texture) || this.blackTexture;
    g.tStreak.value = (this.bloomPass.enabled && this.bloomPass.streakTexture) || this.blackTexture;

    this.finalPass.material.uniforms.uTime.value = this.elapsed;

    if (this.scenePass) this.updateSceneSpaceUniforms(ctx, dt);

    // Keep the shot rig out of everyone else's frames — see registerPostFXShots.
    // It is also rebuilt here if a pipeline swap (a quality-tier change) tore it
    // down while it was still on screen.
    const mine = activeShot()?.name === SHOT_NAME;
    if (mine && !shotRig) {
      shotRig = buildShotRig();
      ctx.scene.add(shotRig.root);
      shotRig.refreshSun(ctx.camera);
    }
    if (shotRig) shotRig.root.visible = mine;

    // RenderPass draws into whichever target the composer currently calls its
    // read buffer. Note it *before* the chain runs, because the passes swap the
    // pair around underneath us as they go.
    const sceneTarget = this.composer.readBuffer;

    this.composer.render(dt);

    // After the chain, `readBuffer` names the target the next frame's scene will
    // be drawn into. Handing out the depth we just filled is only safe when that
    // is the other buffer; if the enabled passes ever swap an even number of
    // times, the texture would be the one bound for writing while the atmosphere
    // shell samples it, so degrade to null rather than publish a feedback loop.
    publishedSceneDepth =
      this.composer.readBuffer !== sceneTarget ? sceneTarget.depthTexture : null;
  }

  private updateSceneSpaceUniforms(ctx: EngineContext, dt: number): void {
    const pass = this.scenePass;
    if (!pass) return;
    const u = pass.material.uniforms;
    const cam = this.camera;

    u.uLogFar.value = Math.log2(cam.far + 1);
    (u.uProj.value as Vector2).set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);

    // The renderer has not run yet this frame, so `matrixWorld` and especially
    // `matrixWorldInverse` still describe the *previous* frame. Deriving both
    // here is the difference between a motion blur that lags a frame and one
    // that does not.
    cam.updateMatrixWorld();
    this.viewInverse.copy(cam.matrixWorld).invert();
    (u.uCamToWorld.value as Matrix4).copy(cam.matrixWorld);

    this.curViewProj.multiplyMatrices(cam.projectionMatrix, this.viewInverse);
    this.camWorldPos.setFromMatrixPosition(cam.matrixWorld);

    const motion = u.uMotion.value as Vector3;
    // A floating-origin rebase teleports render space; the previous matrix is
    // then meaningless and reprojection would smear the whole frame. Same for
    // the first frame after a resize or a warp jump.
    const rebased = ctx.origin.version !== this.prevOriginVersion;
    // Measured against the ground under the ship, not render space: a landed
    // camera sweeps ~1 km per frame through render space without moving at all.
    // [v3-T1] A speed, not 25 km per frame: the same flight was motion at
    // 30 fps and a cut at 144 (render/motionJump.ts).
    const jumped = motionJumped(
      this.refScratch.copy(this.camWorldPos).sub(this.prevCamWorldPos).sub(motionReference).length(),
      dt,
    );
    motion.x = this.hasPrevFrame && !rebased && !jumped ? MOTION_SHUTTER : 0;

    // A point at X now was at X - d a frame ago, so reproject through
    // prevViewProj * T(-d). Zero d leaves the old behaviour bit-for-bit.
    const prev = u.uPrevViewProj.value as Matrix4;
    if (this.hasPrevFrame) {
      prev.copy(this.prevViewProj).multiply(
        this.refMatrix.makeTranslation(-motionReference.x, -motionReference.y, -motionReference.z),
      );
    } else {
      prev.copy(this.curViewProj);
    }
    motionReference.set(0, 0, 0);

    this.prevViewProj.copy(this.curViewProj);
    this.prevCamWorldPos.copy(this.camWorldPos);
    this.prevOriginVersion = ctx.origin.version;
    this.hasPrevFrame = true;
  }

  resize(_width: number, _height: number): void {
    // The engine hands us CSS pixels; the targets have to match the drawing
    // buffer, which already includes pixel ratio and the adaptive resolution
    // scale.
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    this.composer.setSize(w, h);
    this.hasPrevFrame = false;
    // Both attachments were just reallocated at the new size and hold nothing.
    // The adaptive resolution scaler comes through here every thirty frames, so
    // this is a real case, not a boot-time nicety.
    publishedSceneDepth = null;
  }

  dispose(): void {
    // Hand the frame counter back to whoever renders next.
    this.renderer.info.autoReset = true;
    // The targets go with the composer below; nobody may keep sampling them.
    publishedSceneDepth = null;
    this.renderPass.dispose();
    this.scenePass?.dispose();
    this.lumPass.dispose();
    this.bloomPass.dispose();
    this.gradePass.dispose();
    this.finalPass.dispose();
    this.composer.dispose(); // disposes renderTarget1/2 (and their depth textures)
    this.quad.dispose();
    this.blackTexture.dispose();
    disposeShotRig();
  }
}

// ---------------------------------------------------------------------------
// Hero shot
// ---------------------------------------------------------------------------

const SHOT_NAME = 'postfx-grade';

interface ShotRig {
  readonly root: Group;
  /** Re-express the key light in view space. Cheap; called once per frame. */
  refreshSun(camera: PerspectiveCamera): void;
  dispose(): void;
}

let shotRig: ShotRig | null = null;

function disposeShotRig(): void {
  shotRig?.dispose();
  shotRig = null;
}

/**
 * The grade needs something to grade. This builds a deliberately minimal but
 * fully lit vignette: one hot emitter just off centre, a large dark body whose
 * terminator runs through the frame, and a near-black foreground strut carrying
 * three amber instrument LEDs.
 *
 * That covers everything the pass does at once — the emitter drives the wide
 * bloom and the anamorphic streak, the LEDs prove the tight bloom, the body's
 * unlit hemisphere is literally zero and shows the black lift, and the strut
 * occludes so the frame is never an empty rectangle.
 */
function buildShotRig(): ShotRig {
  const rng = new Rng('postfx-grade-rig');
  const root = new Group();
  root.name = 'postfx-shot-rig';
  root.frustumCulled = false;

  const geometries: Array<{ dispose(): void }> = [];
  const materials: ShaderMaterial[] = [];

  // Direction from the dark body towards the emitter, in the rig's space. The
  // two sit at nearly the same depth on purpose: a key light that is 45 degrees
  // behind the camera flattens the sphere into a gradient. Side-on puts the
  // terminator straight through the visible disc, which is the whole shot.
  const emitterPos = new Vector3(-2.35, 0.85, -11.1);
  const bodyPos = new Vector3(2.5, -0.7, -11.6);
  const sunDir = new Vector3().subVectors(emitterPos, bodyPos).normalize();

  // --- backdrop ------------------------------------------------------------
  // ARCHITECTURE §6: "Empty black screens are a failure state." Without this
  // the frame is ~45% pure void, which is both a compositional failure and a
  // dishonest test of the grade — a pipeline is judged on what it does to the
  // *dark* end, and there has to be something down there to judge.
  //
  // Drawn first with depth test and write off, so it can never sort against or
  // z-fight the rig. Direction comes straight from the local vertex position,
  // which is only valid because the shot pins the camera to the rig origin.
  const skyGeo = new SphereGeometry(600, 48, 32);
  const skyMat = new ShaderMaterial({
    name: 'os.shot.sky',
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      /** x: faintest star flux, y: brightest allowed, z: cells, w: density. */
      uStars: { value: new Vector4(0.016, 40, 220, 0.05) },
      uDust: { value: 0.05 },
      /** The one saturated accent for this location (§6: colour is rationed). */
      uAccent: { value: new Color(0.26, 0.62, 1.0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <onespace_noise>
      #include <onespace_color>
      uniform vec4 uStars;
      uniform float uDust;
      uniform vec3 uAccent;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);

        // --- dust ----------------------------------------------------------
        // Warped fBm times a higher-frequency band, so the wash has lanes and
        // filaments instead of being one soft blob. A smooth radial haze is
        // exactly the "flat gradient" §6 forbids.
        vec3 q = os_warp(d * 2.1, 0.55);
        float lane = os_fbm(q, 4, 2.12, 0.5) * 0.5 + 0.5;
        lane *= lane;                                // keep it sparse, not global fog
        float fil = os_fbm(q * 4.7, 3, 2.3, 0.55) * 0.5 + 0.5;
        vec3 col = uAccent * uDust * lane * (0.30 + 0.70 * fil);

        // --- stars ---------------------------------------------------------
        // One star per occupied cell, placed inside its own cell so it is never
        // clipped by the cell boundary (no 27-cell neighbourhood needed).
        vec3 p = d * uStars.z;
        vec3 id = floor(p);
        vec3 f = p - id - 0.5;
        float on = step(1.0 - uStars.w, os_hash13(id * 1.37 + 4.1));
        vec3 h = os_hash33(id + 2.7);
        float r = length(f - h * 0.3);
        // sigma ~0.19 cell, i.e. a hair under a pixel at 1080p: a star is a
        // point of light, not a disc.
        float core = exp(-r * r * 14.0);
        // Real magnitude statistics: N(brighter than F) goes as F^-1.5, so
        // F = Fmin * u^(-2/3). That is what gives a field where almost every
        // star is faint and one or two per frame are hot enough to bloom —
        // a uniform or pow() distribution gives either mush or a disco.
        float u = max(os_hash13(id * 0.71 + 9.3), 2e-4);
        float flux = min(uStars.x * pow(u, -0.6667), uStars.y);
        col += os_blackbody(mix(3600.0, 11500.0, h.z * 0.5 + 0.5)) * core * flux * on;

        gl_FragColor = vec4(os_dither(col, gl_FragCoord.xy), 1.0);
      }
    `,
  });
  const sky = new Mesh(skyGeo, skyMat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  root.add(sky);
  geometries.push(skyGeo);
  materials.push(skyMat);

  // --- the emitter ---------------------------------------------------------
  const emitterGeo = new SphereGeometry(0.2, 48, 32);
  const emitterMat = new ShaderMaterial({
    name: 'os.shot.emitter',
    uniforms: { uIntensity: { value: 140 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <onespace_color>
      #include <logdepthbuf_pars_fragment>
      uniform float uIntensity;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        // Limb-darkened disc: white-hot core falling to a cooler edge, so the
        // bloom pyramid gets a genuine high-dynamic-range gradient to chew on.
        float f = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        vec3 core = os_blackbody(9200.0);
        vec3 limb = os_blackbody(6100.0);
        vec3 c = mix(limb, core, pow(f, 0.6)) * uIntensity * (0.22 + 0.78 * pow(f, 1.6));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const emitter = new Mesh(emitterGeo, emitterMat);
  emitter.position.copy(emitterPos);
  root.add(emitter);
  geometries.push(emitterGeo);
  materials.push(emitterMat);

  // --- matte surface material (body + strut) -------------------------------
  // NOTE on the #includes: the renderer runs with `logarithmicDepthBuffer`
  // (ARCHITECTURE §3). Three only *defines* USE_LOGARITHMIC_DEPTH_BUFFER for a
  // ShaderMaterial — it does not inject the code. A custom material that skips
  // these chunks writes ordinary perspective depth, which (a) cannot be sorted
  // against any other module's geometry in the same scene and (b) makes the
  // depth texture undecodable by SceneSpacePass, silently killing AO on exactly
  // the geometry this shot exists to show.
  const matteVert = /* glsl */ `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vN;
    varying vec3 vLocal;
    varying vec3 vView;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vLocal = position;
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }
  `;
  const matteFrag = /* glsl */ `
    #include <onespace_noise>
    #include <onespace_color>
    #include <logdepthbuf_pars_fragment>
    uniform vec3 uAlbedo;
    uniform vec3 uSunDir;      // view space
    uniform vec3 uSunColor;
    uniform float uNoiseScale;
    uniform float uRim;
    uniform float uBounce;
    varying vec3 vN;
    varying vec3 vLocal;
    varying vec3 vView;
    void main() {
      #include <logdepthbuf_fragment>
      vec3 n = normalize(vN);
      // Micro-detail at three octave bands, so the surface holds up whether it
      // fills the frame or sits at the edge of it. Nothing is a flat gradient.
      vec3 p = vLocal * uNoiseScale;
      vec3 wp = os_warp(p, 0.6);
      float coarse = os_fbm(wp, 5, 2.05, 0.52);
      float fine = os_fbm(p * 9.0, 4, 2.3, 0.5);
      float grit = os_hash13(p * 96.0);
      // Three bands so the surface keeps giving detail as the frame gets closer
      // to it — the whole "holds up at 20 000 km and at 2 km" requirement.
      // Floored: the three bands sum to a range that dips just below zero, and
      // a negative albedo pushes negative light into the bloom prefilter and
      // the luminance meter.
      float detail = max(0.55 + 0.38 * coarse + 0.16 * fine + 0.10 * (grit - 0.5), 0.04);

      // Perturb the normal by the coarse field. Relief at the terminator is
      // what stops a lit sphere from reading as a gradient-filled circle.
      vec3 grad = os_gradient(wp, 0.35, 3, 2.05, 0.52);
      n = normalize(n - (grad - n * dot(grad, n)) * 0.10);

      vec3 sd = normalize(uSunDir);
      float ndl = max(dot(n, sd), 0.0);
      // No ambient term anywhere. If it faces away from the star it is black.
      vec3 c = uAlbedo * detail * ndl * uSunColor;

      // Planetshine, and nothing else. §6 permits exactly one source of light on
      // the dark side: bounce off a nearby lit body. Without it the foreground
      // strut is a flat black cut-out with no micro-detail at all — a hard-edged
      // bar across a quarter of the frame — which is a worse failure than a
      // slightly lifted shadow. Weighted towards the ANTI-sun hemisphere, since
      // that is where the lit body actually is, and tinted cool: a warm key with
      // a cool fill is the oldest trick in the book and it is what keeps the two
      // rationed hues (amber, steel) opposed instead of muddled.
      // uBounce is 0 on the body itself — nothing large enough sits next to it.
      float fill = 0.5 - 0.5 * dot(n, sd);
      c += uAlbedo * detail * uBounce * fill * uSunColor * vec3(0.72, 0.84, 1.0);

      // Grazing sheen — the silver lining along the terminator and the limb.
      float fres = pow(1.0 - clamp(dot(n, normalize(vView)), 0.0, 1.0), 4.0);
      c += uSunColor * fres * ndl * uRim * (0.55 + 0.45 * detail);

      gl_FragColor = vec4(os_dither(c, gl_FragCoord.xy), 1.0);
    }
  `;

  const sunColor = new Color(1.0, 0.93, 0.82);

  const bodyGeo = new SphereGeometry(3.6, 128, 96);
  const bodyMat = new ShaderMaterial({
    name: 'os.shot.body',
    uniforms: {
      uAlbedo: { value: new Color(0.09, 0.098, 0.115) },
      uSunDir: { value: new Vector3() },
      // Deliberately dimmer than it wants to be. At 1.35 the lit hemisphere
      // landed at ~0.66 display — up on the shoulder, where the curve
      // compresses everything into one washed grey and the mottling stops
      // reading. At 0.9 it sits at ~0.5, in the steep part of the contrast
      // curve, and the terminator falls away with some drama.
      uSunColor: { value: sunColor.clone().multiplyScalar(0.9) },
      uNoiseScale: { value: 0.55 },
      uRim: { value: 0.32 },
      uBounce: { value: 0 },
    },
    vertexShader: matteVert,
    fragmentShader: matteFrag,
  });
  const body = new Mesh(bodyGeo, bodyMat);
  body.position.copy(bodyPos);
  root.add(body);
  geometries.push(bodyGeo);
  materials.push(bodyMat);

  // --- foreground strut ----------------------------------------------------
  // Wide, and turned to present a face. The first version was 0.16 km thick and
  // yawed 0.55 rad, which put it almost exactly edge-on to the camera: it
  // rendered as a 4-pixel bright line — a scratch on the lens, not a hull
  // member — and occluded nothing, which fails §6 outright. The face we see is
  // the one turned away from the key, so the strut is a silhouette with a lit
  // sliver down its outer edge and planetshine picking out its grime.
  const strutGeo = new BoxGeometry(0.62, 7.5, 0.4);
  const strutMat = new ShaderMaterial({
    name: 'os.shot.strut',
    uniforms: {
      // Painted hull, not coal: at 0.055 albedo the planetshine could not lift
      // the silhouette off the void no matter how large uBounce got, and the
      // strut rendered as a featureless black rectangle.
      uAlbedo: { value: new Color(0.17, 0.175, 0.19) },
      uSunDir: { value: new Vector3() },
      uSunColor: { value: sunColor.clone().multiplyScalar(0.9) },
      uNoiseScale: { value: 5.5 },
      uRim: { value: 1.6 },
      uBounce: { value: 0.42 },
    },
    vertexShader: matteVert,
    fragmentShader: matteFrag,
  });
  const strut = new Mesh(strutGeo, strutMat);
  strut.position.set(-1.62, -0.3, -2.25);
  strut.rotation.set(0.08, 0.22, -0.14);
  root.add(strut);
  geometries.push(strutGeo);
  materials.push(strutMat);

  // --- instrument LEDs -----------------------------------------------------
  const ledGeo = new SphereGeometry(0.013, 10, 8);
  const ledMat = new ShaderMaterial({
    name: 'os.shot.led',
    uniforms: { uColor: { value: new Color(1.0, 0.42, 0.07) }, uIntensity: { value: 34 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uIntensity;
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(uColor * uIntensity, 1.0);
      }
    `,
  });
  for (let i = 0; i < 3; i++) {
    const led = new Mesh(ledGeo, ledMat);
    // Parented to the strut, in its local space, so they read as instruments
    // bolted to a hull rather than as three orange dots floating in the void.
    // x = 0.33 is just proud of the +X face (half-extent 0.31) — no z-fight.
    // Seeded, not random: the same three LEDs in the same three places forever.
    led.position.set(0.33, -0.34 - i * 0.24 + rng.range(-0.012, 0.012), 0.06);
    strut.add(led);
  }
  geometries.push(ledGeo);
  materials.push(ledMat);

  // Both matte materials share one key light, expressed in view space because
  // that is the space their normals arrive in.
  const viewSun = new Vector3();
  const invView = new Matrix4();

  return {
    root,
    refreshSun(camera: PerspectiveCamera): void {
      // The renderer normally maintains matrixWorldInverse, but it has not run
      // yet on the frame a shot is applied — derive it rather than use a stale one.
      invView.copy(camera.matrixWorld).invert();
      viewSun.copy(sunDir).transformDirection(invView);
      (bodyMat.uniforms.uSunDir.value as Vector3).copy(viewSun);
      (strutMat.uniforms.uSunDir.value as Vector3).copy(viewSun);
    },
    dispose(): void {
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

/**
 * Registers the hero shot. Call once after constructing PostFX.
 *
 * The rig is built lazily on first use and hidden whenever another shot is
 * active, so nothing here leaks into another module's review frame.
 */
export function registerPostFXShots(postfx: PostFX): void {
  registerShot({
    name: SHOT_NAME,
    description:
      'The noir grade: a hot emitter with wide bloom and a blue anamorphic streak, ' +
      'amber instrument LEDs blooming tight, a dark body whose unlit half sits on the ' +
      'lifted black, and a near-black foreground strut catching a silver edge.',
    apply(ctx: EngineContext): void {
      if (!shotRig) shotRig = buildShotRig();
      const rig = shotRig;
      if (rig.root.parent !== ctx.scene) ctx.scene.add(rig.root);
      rig.root.visible = true;

      ctx.camera.position.set(0, 0, 0);
      // A degree of roll: a level horizon is the most boring frame in cinema.
      ctx.camera.rotation.set(0.02, 0, -0.035);
      ctx.camera.updateMatrixWorld(true);
      rig.refreshSun(ctx.camera);

      // Let the iris land on this frame immediately rather than easing in from
      // whatever the previous shot was exposed for.
      postfx.resetExposure();
      postfx.setExposureBias(1);
    },
    update(_dt: number, ctx: EngineContext): void {
      // Other modules may be flying the camera. This shot owns it while it is
      // active, so it is re-pinned every frame and the capture is deterministic.
      ctx.camera.position.set(0, 0, 0);
      ctx.camera.rotation.set(0.02, 0, -0.035);
      ctx.camera.updateMatrixWorld(true);
      shotRig?.refreshSun(ctx.camera);
    },
  });
}

/** Exposed so a host that never constructs PostFX can still free the rig. */
export function disposePostFXShots(): void {
  disposeShotRig();
}

/** Re-exported for the integrator: the rig root, or null if never shown. */
export function postFXShotRoot(): Object3D | null {
  return shotRig ? shotRig.root : null;
}
