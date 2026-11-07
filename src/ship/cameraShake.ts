/**
 * [v3-T1] Camera shake noise.
 *
 * v2 summed value noise at 11, 23.7 and 51.3 Hz. At 60 fps anything above
 * ~24 Hz (0.4 × the frame rate) cannot be shown, only aliased into a random
 * per-frame jitter — which reads as the image buzzing, not the hull shaking.
 * Octaves are capped at 25 Hz and fade out above 0.3 × the frame rate.
 *
 * Ratios stay irrational-ish (no two octaves in an integer ratio), so the sum
 * never comes back into phase and reads as a machine wobble.
 */

export interface ShakeOctave {
  readonly hz: number;
  readonly weight: number;
}

/** Absolute ceiling on any octave, Hz. */
export const SHAKE_MAX_HZ = 25;

export const SHAKE_OCTAVES: readonly ShakeOctave[] = [
  { hz: 5.3, weight: 0.55 },
  { hz: 11.0, weight: 0.3 },
  { hz: 23.7, weight: 0.15 },
];

const WEIGHT_SUM = SHAKE_OCTAVES.reduce((a, o) => a + o.weight, 0);

/** 1 at or below 0.3·frameHz, 0 at or above min(0.4·frameHz, SHAKE_MAX_HZ), smooth between. */
export function shakeOctaveGain(hz: number, frameHz: number): number {
  const f = frameHz > 0 && Number.isFinite(frameHz) ? frameHz : 60;
  const hi = Math.min(0.4 * f, SHAKE_MAX_HZ);
  const lo = Math.min(0.3 * f, 0.75 * hi);
  if (hz <= lo) return 1;
  if (hz >= hi) return 0;
  const x = (hz - lo) / (hi - lo);
  return 1 - x * x * (3 - 2 * x);
}

/** Cheap 1-D hash. Adequate for shake; never used for world generation. */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smoothed value noise in -1..1. */
function valueNoise1(x: number, seed: number): number {
  const o = seed * 57.31;
  const i = Math.floor(x + o);
  const f = x + o - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i);
  const b = hash1(i + 1);
  return (a + (b - a) * u) * 2 - 1;
}

/** Shake noise in -1..1 for channel `seed` at time `t`, band-limited for `frameHz`. */
export function shakeNoise(t: number, seed: number, frameHz: number): number {
  let n = 0;
  for (let k = 0; k < SHAKE_OCTAVES.length; k++) {
    const o = SHAKE_OCTAVES[k]!;
    const g = shakeOctaveGain(o.hz, frameHz);
    if (g > 0) n += valueNoise1(t * o.hz, seed + k * 7.13) * o.weight * g;
  }
  return n / WEIGHT_SUM;
}
