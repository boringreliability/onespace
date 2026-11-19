/**
 * The key light (the star) as every lit thing in a system receives it.
 *
 * One function, used by worlds and moons (game/Universe.ts), traffic hulls
 * (game/Traffic.ts) and the player's own hull (game/Pilot.ts), so a hull and
 * the world beside it can never be lit by different suns. That was the
 * outskirts bug (v3-light): worlds took a raw luminosity/distance² while the
 * player's hull stayed at a flat 1.0, the iris metered the hull, and the day
 * side of Fyss VIII (3.55 AU of an M dwarf, 1/1300 of the opening world's
 * light) rendered as a black disc.
 *
 * WHY COMPRESS. Irradiance across a system spans six decades (a hot Jupiter
 * at 0.02 AU to a Kuiper world at 100 AU); a six-stop iris over an 8-bit
 * display covers about two. A real eye adapts across that range — Neptune at
 * 30 AU receives 1/900 of Earth's sunlight and is plainly a lit blue world to
 * anyone standing there. Below the knee the key light is therefore compressed
 * with a power law in log space: every halving of distance still brightens
 * the world (distance reads), but the outskirts land within the iris's reach.
 * Above the knee nothing changes, so the opening world and every inner world
 * are bit-identical to before.
 *
 * Only the LEVEL is compressed, never the direction: the night side stays
 * black and the terminator hard — this is the one key light, not a fill.
 * `starDirectionLocal` gives a hull its real direction to the star; the
 * player's hull used to keep an authored bow-side sun at every attitude.
 */

import { Quaternion, type Vector3 } from 'three';
import { AU } from '@/gen/types';

/**
 * Below this irradiance (Earth = 1) the key light is compressed. A quarter of
 * Earth's sunlight is Mars-and-a-bit — still an unremarkable daylight subject
 * for the iris. The home opening (Remit 31, ~1.05) sits well above it; an
 * opening world is only guaranteed >= 0.12 (Universe MIN_ARRIVAL_ILLUMINATION),
 * so a dim opening elsewhere may come out slightly brighter than before.
 */
export const KEY_LIGHT_KNEE = 0.25;

/**
 * Exponent of the compression below the knee. 0.25 maps 30 AU of Sol (1/900)
 * to ~6.5% of Earth and 100 AU (1/10,000) to ~3.5%; Fyss VIII (3.55 AU of an
 * M dwarf, 1/1300 of the opening world) to ~5.6% of it. Measured on the GPU,
 * 0.4 left Fyss VIII a muddy brown disc lost in film grain; 0.25 reads as a
 * dim, lit world with a hard terminator, still plainly darker than the
 * opening.
 */
export const KEY_LIGHT_EXPONENT = 0.25;

/** Star luminosity (L☉) over distance² in AU — Earth at 1 AU of Sol is 1. */
export function physicalIrradiance(luminosity: number, distanceKm: number): number {
  const lum = Number.isFinite(luminosity) && luminosity > 0 ? luminosity : 1;
  const au = distanceKm / AU;
  return lum / Math.max(au * au, 1e-6);
}

/** The key light's level for a body receiving `irradiance` (Earth = 1). */
export function keyIrradiance(irradiance: number): number {
  if (!(irradiance > 0)) return 0;
  if (irradiance >= KEY_LIGHT_KNEE) return irradiance;
  return KEY_LIGHT_KNEE * Math.pow(irradiance / KEY_LIGHT_KNEE, KEY_LIGHT_EXPONENT);
}

const invAttitude = new Quaternion();

/**
 * Unit direction to the star (at the world origin) from `worldPos`, in the
 * LOCAL axes of a hull whose world attitude is `attitude`. Writes `out`.
 */
export function starDirectionLocal(worldPos: Vector3, attitude: Quaternion, out: Vector3): Vector3 {
  invAttitude.copy(attitude).invert();
  return out.copy(worldPos).negate().normalize().applyQuaternion(invAttitude);
}

/** `keyIrradiance(physicalIrradiance(...))` — what the call sites want. */
export function keyLightAt(luminosity: number, distanceKm: number): number {
  return keyIrradiance(physicalIrradiance(luminosity, distanceKm));
}
