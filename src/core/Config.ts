/**
 * Quality tiers and global tuning.
 *
 * Every expensive subsystem reads its budget from here rather than hard-coding
 * numbers, so one switch scales the whole renderer. The tier is auto-detected
 * from the GPU on first boot and can be overridden from the pause menu.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  readonly tier: QualityTier;
  /** Multiplier on devicePixelRatio. */
  readonly renderScale: number;
  readonly maxPixelRatio: number;
  /** Max subdivision depth of the planet LOD quadtree. */
  readonly planetMaxDepth: number;
  /** Vertices per side of a single terrain patch. Must be 2^n + 1. */
  readonly patchResolution: number;
  /** Number of patches allowed to be built per frame — controls hitching. */
  readonly patchBuildBudget: number;
  /** Raymarch steps for atmospheric scattering. */
  readonly atmosphereSteps: number;
  readonly atmosphereLightSteps: number;
  /** Raymarch steps for volumetric nebulae. */
  readonly nebulaSteps: number;
  readonly bloom: boolean;
  readonly bloomStrength: number;
  readonly motionBlur: boolean;
  readonly ambientOcclusion: boolean;
  readonly filmGrain: boolean;
  readonly chromaticAberration: boolean;
  readonly anisotropy: number;
  /** Stars drawn in the galaxy map. */
  readonly galaxyStarBudget: number;
  /** Shadow map resolution; 0 disables shadows. */
  readonly shadowMapSize: number;
}

const TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    renderScale: 0.7,
    maxPixelRatio: 1,
    planetMaxDepth: 7,
    patchResolution: 33,
    patchBuildBudget: 2,
    atmosphereSteps: 10,
    atmosphereLightSteps: 4,
    nebulaSteps: 24,
    bloom: true,
    bloomStrength: 0.5,
    motionBlur: false,
    ambientOcclusion: false,
    filmGrain: true,
    chromaticAberration: false,
    anisotropy: 2,
    galaxyStarBudget: 40_000,
    shadowMapSize: 0,
  },
  medium: {
    tier: 'medium',
    renderScale: 0.85,
    maxPixelRatio: 1.5,
    planetMaxDepth: 9,
    patchResolution: 33,
    patchBuildBudget: 3,
    atmosphereSteps: 16,
    atmosphereLightSteps: 6,
    nebulaSteps: 40,
    bloom: true,
    bloomStrength: 0.6,
    motionBlur: false,
    ambientOcclusion: false,
    filmGrain: true,
    chromaticAberration: true,
    anisotropy: 4,
    galaxyStarBudget: 90_000,
    shadowMapSize: 1024,
  },
  high: {
    tier: 'high',
    renderScale: 1,
    maxPixelRatio: 2,
    planetMaxDepth: 11,
    patchResolution: 65,
    patchBuildBudget: 4,
    atmosphereSteps: 24,
    atmosphereLightSteps: 8,
    nebulaSteps: 64,
    bloom: true,
    bloomStrength: 0.7,
    motionBlur: true,
    ambientOcclusion: true,
    filmGrain: true,
    chromaticAberration: true,
    anisotropy: 8,
    galaxyStarBudget: 160_000,
    shadowMapSize: 2048,
  },
  ultra: {
    tier: 'ultra',
    renderScale: 1,
    maxPixelRatio: 2,
    planetMaxDepth: 13,
    patchResolution: 65,
    patchBuildBudget: 6,
    atmosphereSteps: 40,
    atmosphereLightSteps: 12,
    nebulaSteps: 96,
    bloom: true,
    bloomStrength: 0.75,
    motionBlur: true,
    ambientOcclusion: true,
    filmGrain: true,
    chromaticAberration: true,
    anisotropy: 16,
    galaxyStarBudget: 260_000,
    shadowMapSize: 4096,
  },
};

/**
 * Guess a sensible tier from the GPU string. Crude, but it only needs to pick
 * a starting point — the adaptive resolution controller corrects from there.
 */
export function detectTier(gl: WebGL2RenderingContext | null): QualityTier {
  if (!gl) return 'medium';
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
  } catch {
    /* some browsers block this — fall through to the default */
  }
  const r = renderer.toLowerCase();
  const mobile = /adreno|mali|powervr|apple a\d/.test(r);
  if (mobile) return 'low';
  if (/rtx\s*(40|50)|rx\s*7\d00|m[123456]\s*(max|ultra)/.test(r)) return 'ultra';
  if (/rtx|radeon rx|apple m\d/.test(r)) return 'high';
  if (/intel|uhd|iris/.test(r)) return 'low';
  return 'medium';
}

export class Config {
  quality: QualitySettings = TIERS.high;

  /** Master render distance multiplier, tuned by the adaptive controller. */
  dynamicResolution = 1;

  /** Debug switches, toggled with F-keys. */
  debug = {
    wireframe: false,
    showLodBounds: false,
    freezeLod: false,
    stats: false,
  };

  setTier(tier: QualityTier): QualitySettings {
    this.quality = TIERS[tier];
    return this.quality;
  }

  static tiers(): QualityTier[] {
    return ['low', 'medium', 'high', 'ultra'];
  }
}

export const config = new Config();
