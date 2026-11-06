/**
 * Named ship sets, drive states and the standard key light the review shots
 * and the Yard are composed from. Plain data; moved verbatim out of
 * `Showroom.ts` when it was split.
 */

import { Vector3 } from 'three';

import { hashSeed } from '@/math/rng';
import type { ShipParams } from '@/gen/ships/blueprint';
import type { ShipRole } from '@/gen/ships/types';
import type { ShipDriveState, Triple } from './Stage';

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
