/**
 * oneSpace — universe data contracts.
 *
 * These types are the seam between *generation* (pure, deterministic, no
 * three.js) and *rendering* (impure, GPU-bound, no randomness). Generators
 * produce plain data; renderers consume it. Neither imports the other.
 *
 * UNITS
 *   Distance : kilometres (1 render unit = 1 km)
 *   Time     : seconds
 *   Mass     : Earth masses (planets) / Solar masses (stars)
 *   Angles   : radians
 *   Colour   : linear sRGB triplets in 0..1
 *
 * Interstellar positions are stored as plain JS numbers (float64) and are far
 * too large for float32 GPU precision — the renderer must apply the floating
 * origin from `core/FloatingOrigin.ts` before uploading anything.
 */

// ---------------------------------------------------------------------------
// Units & constants
// ---------------------------------------------------------------------------

/** Kilometres per astronomical unit. */
export const AU = 1.495978707e8;
/** Kilometres per light year. */
export const LY = 9.4607304725808e12;
/** Kilometres — radius of Earth, the reference rocky world. */
export const EARTH_RADIUS = 6371;
/** Kilometres — radius of Sol. */
export const SOLAR_RADIUS = 695700;

export type Vec3 = readonly [number, number, number];
/** Linear RGB, each channel 0..1. */
export type RGB = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Galaxy
// ---------------------------------------------------------------------------

export type GalaxyShape = 'spiral' | 'barred-spiral' | 'elliptical' | 'irregular' | 'ring';

export interface GalaxySpec {
  readonly id: string;
  readonly seed: number;
  readonly name: string;
  readonly shape: GalaxyShape;
  /** Radius of the visible disc, in light years. */
  readonly radiusLy: number;
  /** Disc scale height in light years. */
  readonly thicknessLy: number;
  readonly armCount: number;
  /** How tightly arms wind. Higher = tighter. Typical 0.15 – 0.45. */
  readonly armTwist: number;
  /** 0 = arms invisible, 1 = razor-sharp arms. */
  readonly armContrast: number;
  /** Fraction of stars in the central bulge, 0..1. */
  readonly bulgeFraction: number;
  /** Number of stars to instantiate for the galaxy map view. */
  readonly starCount: number;
  readonly coreColor: RGB;
  readonly armColor: RGB;
  readonly dustColor: RGB;
  readonly nebulae: readonly NebulaSpec[];
  /** Flavour text shown in the codex. */
  readonly blurb: string;
}

export interface NebulaSpec {
  readonly id: string;
  readonly seed: number;
  readonly name: string;
  /** Position in galaxy-local light years. */
  readonly position: Vec3;
  readonly radiusLy: number;
  readonly color: RGB;
  readonly accentColor: RGB;
  readonly density: number;
  readonly kind: 'emission' | 'reflection' | 'dark' | 'planetary' | 'supernova-remnant';
}

// ---------------------------------------------------------------------------
// Stars & systems
// ---------------------------------------------------------------------------

/** Morgan–Keenan spectral classes, hottest to coolest, plus exotica. */
export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'NS' | 'BH';

export interface StarSpec {
  readonly id: string;
  readonly seed: number;
  readonly name: string;
  readonly spectralClass: SpectralClass;
  /** Effective surface temperature in kelvin. Drives colour. */
  readonly temperature: number;
  /** Solar radii. */
  readonly radius: number;
  /** Solar masses. */
  readonly mass: number;
  /** Solar luminosities. */
  readonly luminosity: number;
  /** Linear RGB derived from blackbody temperature. */
  readonly color: RGB;
  /** 0..1 — how violent the surface granulation and flares are. */
  readonly activity: number;
}

/** A star's position in the galaxy, used by the map and the jump drive. */
export interface StarSystemSpec {
  readonly id: string;
  readonly seed: number;
  readonly name: string;
  /** Galaxy-local position, light years. */
  readonly position: Vec3;
  readonly galaxyId: string;
  /** Primary plus any companions. Index 0 is always the primary. */
  readonly stars: readonly StarSpec[];
  readonly planets: readonly PlanetSpec[];
  /** Inner and outer edge of the liquid-water zone, in AU. */
  readonly habitableZone: readonly [number, number];
  /** 0..1 — how picked-over this system is. Drives station/wreck density. */
  readonly civilisation: number;
  readonly hasAsteroidBelt: boolean;
  readonly blurb: string;
}

// ---------------------------------------------------------------------------
// Planets
// ---------------------------------------------------------------------------

export type PlanetType =
  | 'rocky'
  | 'ocean'
  | 'desert'
  | 'ice'
  | 'volcanic'
  | 'toxic'
  | 'barren'
  | 'terran'
  | 'gas-giant'
  | 'ice-giant';

export interface OrbitSpec {
  /** Semi-major axis in km. */
  readonly semiMajorAxis: number;
  readonly eccentricity: number;
  /** Radians, relative to the system's invariable plane. */
  readonly inclination: number;
  readonly longitudeOfAscendingNode: number;
  readonly argumentOfPeriapsis: number;
  /** Radians at epoch 0. */
  readonly meanAnomalyAtEpoch: number;
  /** Seconds for one revolution. */
  readonly period: number;
}

/**
 * Terrain is evaluated identically on CPU (for collision / landing sites) and
 * GPU (for displacement). Any change here must be mirrored in both.
 */
export interface TerrainSpec {
  /** Base fBm frequency, in cycles per planet radius. */
  readonly frequency: number;
  readonly octaves: number;
  readonly lacunarity: number;
  readonly gain: number;
  /** Peak-to-trough elevation, in km. */
  readonly amplitude: number;
  /** 0..1 blend towards ridged (mountainous) noise. */
  readonly ridged: number;
  /** 0..1 — erosion-like warping of the noise domain. */
  readonly warp: number;
  /** 0..1 — density of impact craters. */
  readonly craters: number;
  /** Exponent applied to the height field. >1 flattens plains, sharpens peaks. */
  readonly sharpness: number;
  /** Height (0..1 normalised) below which terrain is submerged. */
  readonly seaLevel: number;
}

export interface AtmosphereSpec {
  /** Scale height in km — how fast density falls with altitude. */
  readonly scaleHeight: number;
  /** Total atmosphere thickness in km (where it fades to vacuum). */
  readonly thickness: number;
  /** Rayleigh scattering coefficients per RGB channel, 1/km. */
  readonly rayleigh: RGB;
  /** Mie scattering coefficient, 1/km. */
  readonly mie: number;
  /** Mie phase asymmetry, -1..1. ~0.76 for Earth haze. */
  readonly mieAnisotropy: number;
  /** Overall intensity multiplier for artistic control. */
  readonly intensity: number;
  /** Surface pressure in bar — shown in the scanner. */
  readonly pressure: number;
}

export interface CloudSpec {
  /** 0..1 coverage. */
  readonly coverage: number;
  readonly altitude: number;
  readonly color: RGB;
  /** Rotation speed relative to the surface, radians/second. */
  readonly drift: number;
  readonly detail: number;
}

export interface OceanSpec {
  readonly color: RGB;
  readonly deepColor: RGB;
  /** 0..1 — how mirror-like the surface is. */
  readonly specular: number;
  readonly waveHeight: number;
  /** Set for lava, liquid methane etc. */
  readonly emissive: RGB | null;
}

export interface RingSpec {
  /** Inner and outer radius as a multiple of planet radius. */
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly color: RGB;
  readonly opacity: number;
  readonly seed: number;
  /** Radians — tilt relative to the planet's equator. */
  readonly tilt: number;
}

export interface PlanetPalette {
  /** Lowest terrain (abyss / basin floor). */
  readonly low: RGB;
  /** Mid elevations (plains). */
  readonly mid: RGB;
  /** High elevations (rock, exposed strata). */
  readonly high: RGB;
  /** Peaks (snow, ash, salt). */
  readonly peak: RGB;
  /** Steep slopes — cliff faces read as a distinct material. */
  readonly cliff: RGB;
  /** Poles. Blended in by latitude. */
  readonly polar: RGB;
  /** Sand / regolith seen at grazing angles. */
  readonly accent: RGB;
}

export interface PlanetSpec {
  readonly id: string;
  readonly seed: number;
  readonly name: string;
  readonly type: PlanetType;
  /** Kilometres. */
  readonly radius: number;
  /** Earth masses. */
  readonly mass: number;
  /** Surface gravity in m/s². */
  readonly gravity: number;
  readonly orbit: OrbitSpec;
  /** Seconds for one rotation. Negative for retrograde. */
  readonly rotationPeriod: number;
  /** Radians. */
  readonly axialTilt: number;
  /** Mean surface temperature in kelvin. */
  readonly temperature: number;
  readonly terrain: TerrainSpec;
  readonly palette: PlanetPalette;
  readonly atmosphere: AtmosphereSpec | null;
  readonly clouds: CloudSpec | null;
  readonly ocean: OceanSpec | null;
  readonly rings: RingSpec | null;
  readonly moons: readonly PlanetSpec[];
  /** Set for gas giants: banded flow field parameters. */
  readonly bands: BandSpec | null;
  /** 0..1 — chance the scanner flags something worth landing for. */
  readonly interest: number;
  readonly blurb: string;
  /** True when this body is a moon of another. */
  readonly isMoon: boolean;
}

export interface BandSpec {
  readonly count: number;
  readonly turbulence: number;
  readonly shearSpeed: number;
  readonly stormCount: number;
  readonly palette: readonly RGB[];
}

// ---------------------------------------------------------------------------
// Runtime view-model shared between systems (renderers, HUD, audio)
// ---------------------------------------------------------------------------

export type GameScale = 'surface' | 'orbit' | 'system' | 'interstellar' | 'intergalactic';

export interface ScanResult {
  readonly targetId: string;
  readonly name: string;
  readonly lines: readonly string[];
  /**
   * What was scanned. Optional for backward compatibility with the showroom
   * fixtures written before the log existed; consumers that care should treat
   * an absent value as 'world'.
   *
   * The ship's log needs this and cannot recover it from `targetId` — a hull
   * id and a planet id are both opaque strings, and guessing from their shape
   * is exactly the kind of cross-module assumption that has cost this project
   * a day at a time.
   */
  readonly kind?: 'world' | 'vessel' | 'asteroid';
}
