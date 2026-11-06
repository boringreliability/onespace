/**
 * Named ship sets, drive states and the standard key light the review shots
 * and the Yard are composed from. Plain data; moved verbatim out of
 * `Showroom.ts` when it was split.
 */

import { Vector3 } from 'three';

import { hashSeed } from '@/math/rng';
import type { ShipParams } from '@/gen/ships/blueprint';
import type { ShipRole } from '@/gen/ships/types';
import type { ShipDriveState, ShowroomAim, Triple } from './Stage';

/** The hull almost every shot is about. One hull, many conditions. */
export const HERO_SHIP: ShipParams = {
  seed: 0x5a17c0de,
  factionId: 'kessler',
  role: 'freighter',
  sizeClass: 'medium',
  ageYears: 18,
  maintenance: 0.62,
  damageLevel: 0.3,
};

/** A hull whose whole story is what has happened to it. */
export const WRECK_SHIP: ShipParams = {
  seed: 0x00dd5eed,
  factionId: 'ossuary',
  role: 'salvager',
  sizeClass: 'medium',
  ageYears: 62,
  maintenance: 0.08,
  damageLevel: 0.95,
};

/**
 * Five seeds from one yard, size band pinned, and FIVE DIFFERENT JOBS.
 *
 * Pinning the size class is what makes the frame judgeable: `generateFleet`
 * walks every role, which spans 27 m to 400 m and leaves the small hulls at
 * seven pixels. The DNA question is "do these look related", and that cannot
 * be answered about something too small to see.
 *
 * The role used to be left free, and r5 is what that costs: the five seeds drew
 * gunship / tug / patrol / tanker / tanker. A plate with two tankers on it
 * cannot answer either half of its own question — a critic looking at two
 * similar hulls cannot tell "this yard has a house style" from "these two are
 * the same ship", because the one variable that would have separated them was
 * duplicated by chance. Role is now a CONTROL, one per hull, and the remaining
 * free variable is the seed.
 *
 * These five are all roles Kessler builds by doctrine (`families.ts`
 * `roleAffinity`, none of them in `neverBuilds`) and all five list `medium`
 * among their size classes, so nothing here is a role the generator has to
 * talk itself into. They are also as far apart in FORM as one size band
 * allows — sealed countable units, one pressure vessel, machinery outboard,
 * almost-all-engine, arms and collars — which is what makes "same builder"
 * a claim about construction language rather than about shape.
 */
export const FAMILY_ROLES: readonly ShipRole[] = ['freighter', 'tanker', 'miner', 'tug', 'station-tender'];

export const FAMILY_FLEET: readonly ShipParams[] = FAMILY_ROLES.map((role, i) => ({
  seed: hashSeed(0x4c17f11e, `showroom/family/${i}`),
  factionId: 'kessler',
  role,
  sizeClass: 'medium' as const,
}));

/**
 * One hull per faction with every other variable held constant.
 *
 * Same seed, same role, same size class. Any difference in the frame is
 * faction DNA and nothing else — which is the only way the contrast test
 * proves anything.
 */
export const FACTION_FLEET: readonly ShipParams[] = ['kessler', 'sillane', 'ossuary'].map((factionId) => ({
  seed: 0x00c0ffee,
  factionId,
  role: 'freighter' as const,
  sizeClass: 'medium' as const,
}));

export const CRUISE: ShipDriveState = {
  throttle: 0.68,
  // Light on the boost: it is what shifts the plume white, and the plume is
  // the only cold accent on the hull.
  boost: 0.12,
  heating: 0,
  // Mostly a down-translation, so the dorsal thrusters fire broadside to the
  // camera. A thruster firing straight at the lens is not a detail.
  rcs: new Vector3(-0.24, -0.7, 0),
};

export const BURN: ShipDriveState = {
  throttle: 1.0,
  boost: 0.65,
  heating: 0,
  rcs: new Vector3(0, 0, 0),
};

export const COLD: ShipDriveState = {
  throttle: 0,
  boost: 0,
  heating: 0,
  rcs: new Vector3(0, 0, 0),
};

/** Key light for everything that is not a lighting test. */
export const KEY_LIGHT = {
  sunDirection: [0.4, 0.74, -0.54] as Triple,
  sunColor: [1.0, 0.93, 0.82] as Triple,
  sunIntensity: 3.0,
  fillColor: [0.011, 0.015, 0.024] as Triple,
  fillDirection: [0.1, -1, 0.2] as Triple,
};

// ===========================================================================
// The Yard's named presets
//
// Lifted out of the review shots' per-shot overrides rather than invented:
// each is a lighting or a lens that has already been argued over frame by
// frame (see the comments on the source shots in `shots.ts`). The review
// shots keep their own literal copies — they are frozen for byte-identical
// review — and `presets.test.ts` pins every entry here to its source shot, so
// the two cannot drift apart without a red test.
// ===========================================================================

/** A complete key + fill setup, in the shape `ShowroomSetup` takes it. */
export interface LightPreset {
  readonly sunDirection: Triple;
  readonly sunColor: Triple;
  readonly sunIntensity: number;
  readonly fillColor: Triple;
  readonly fillDirection: Triple;
}

export type LightPresetId = 'raking' | 'rim' | 'dark-side' | 'planetshine';
export const LIGHT_PRESET_IDS: readonly LightPresetId[] = ['raking', 'rim', 'dark-side', 'planetshine'];

export const LIGHT_PRESETS: Readonly<Record<LightPresetId, LightPreset>> = {
  /** The standard raking key (KEY_LIGHT). */
  raking: KEY_LIGHT,
  /** `ship-star-rimlight`: a true back-key, six times the hero, zero fill. */
  rim: {
    sunDirection: [-0.84, 0.23, -0.49],
    sunColor: [1.0, 0.95, 0.88],
    sunIntensity: 6.0,
    fillColor: [0, 0, 0],
    fillDirection: [0, -1, 0.1],
  },
  /** `ship-dark-side`: key behind the hull, almost no fill. */
  'dark-side': {
    sunDirection: [-0.62, 0.36, -0.7],
    sunColor: [1.0, 0.93, 0.82],
    sunIntensity: 3.0,
    fillColor: [0.004, 0.005, 0.008],
    fillDirection: [0, -1, 0],
  },
  /** `ship-planetshine`: weak star, strong cool fill from below. */
  planetshine: {
    sunDirection: [0.44, 0.66, -0.6],
    sunColor: [1.0, 0.93, 0.82],
    sunIntensity: 0.55,
    fillColor: [0.11, 0.14, 0.22],
    fillDirection: [0.05, -1, 0.12],
  },
};

export type DrivePresetId = 'cold' | 'cruise' | 'burn';
export const DRIVE_PRESET_IDS: readonly DrivePresetId[] = ['cold', 'cruise', 'burn'];
export const DRIVE_PRESETS: Readonly<Record<DrivePresetId, ShipDriveState>> = {
  cold: COLD,
  cruise: CRUISE,
  burn: BURN,
};

/**
 * Camera bookmarks for the Yard's orbit: `CameraSpec` minus roll and offsets,
 * because an orbit camera frames dead centre and keeps the horizon level.
 * Structurally assignable to `CameraSpec`.
 */
export interface ViewPreset {
  readonly dir: Triple;
  readonly fovDeg: number;
  readonly fill: number;
  readonly aimAt: ShowroomAim;
  readonly faceAim?: number;
  readonly roll?: undefined;
  readonly offsetX?: undefined;
  readonly offsetY?: undefined;
}

export type ViewPresetId = 'side' | 'front' | 'three-quarter' | 'engine' | 'detail';
export const VIEW_PRESET_IDS: readonly ViewPresetId[] = ['side', 'front', 'three-quarter', 'engine', 'detail'];

export const VIEW_PRESETS: Readonly<Record<ViewPresetId, ViewPreset>> = {
  /** `ship-silhouette-side`: dead abeam, the profile as a drawing. */
  side: { dir: [1, 0, 0], fovDeg: 22, fill: 0.86, aimAt: 'hull' },
  /** `ship-silhouette-front`: head on, the cross-section. */
  front: { dir: [0.06, 0.09, -1], fovDeg: 20, fill: 0.8, aimAt: 'hull' },
  /** `ship-showroom-hero`: the whole hull, rear three-quarter. */
  'three-quarter': { dir: [0.66, 0.28, 0.7], fovDeg: 24, fill: 0.82, aimAt: 'hull' },
  /** `ship-engine-close`: the drive cluster. */
  engine: { dir: [0.62, 0.36, 0.7], fovDeg: 34, fill: 0.72, aimAt: 'engine' },
  /** `ship-greeble-close`: crew hardware at arm's length. */
  detail: { dir: [0.66, 0.46, 0.6], fovDeg: 38, fill: 0.86, aimAt: 'hardware', faceAim: 0.7 },
};
