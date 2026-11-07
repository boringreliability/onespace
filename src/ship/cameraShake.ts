/**
 * [v3-T1] Camera shake noise.
 *
 * v2 summed value noise at 11, 23.7 and 51.3 Hz. At 60 fps anything above
 * ~24 Hz (0.4 × the frame rate) cannot be shown, only aliased into a random
 * per-frame jitter — which reads as the image buzzing, not the hull shaking.
 * Octaves are capped at 25 Hz and fade out above 0.3 × the frame rate.
 *
 * STAGE-1 STUB: signatures only. Implemented in stage 2.
 */

export interface ShakeOctave {
  readonly hz: number;
  readonly weight: number;
}

/** Absolute ceiling on any octave, Hz. */
export const SHAKE_MAX_HZ = 25;

export const SHAKE_OCTAVES: readonly ShakeOctave[] = [];

/** 1 at or below 0.3·frameHz, 0 at or above min(0.4·frameHz, SHAKE_MAX_HZ), smooth between. */
export function shakeOctaveGain(hz: number, frameHz: number): number {
  void hz;
  void frameHz;
  throw new Error('shakeOctaveGain: not implemented (v3-T1 stage 1)');
}

/** Shake noise in -1..1 for channel `seed` at time `t`, band-limited for `frameHz`. */
export function shakeNoise(t: number, seed: number, frameHz: number): number {
  void t;
  void seed;
  void frameHz;
  throw new Error('shakeNoise: not implemented (v3-T1 stage 1)');
}
