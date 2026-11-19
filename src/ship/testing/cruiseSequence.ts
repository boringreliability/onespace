/**
 * A fixed, deterministic input sequence for `CruiseDrive`, and a fingerprint
 * of what the drive does with it (v4 sub-plan 2, Task 7 fix round 1, R22).
 *
 * The sequence walks the drive through every phase and every drop reason the
 * v3 drive knows: spool, cruise under a falling clearance, a release and
 * re-engage, an arrival, the align hold during a drop, and finally a mass
 * lock. The fingerprint is the exact decimal of every number the drive
 * exposes after every step, hashed — so "bit-identical to v3" is a string
 * comparison against a hash recorded from the v3 drive (commit ab61a0c).
 */

import { createHash } from 'node:crypto';

/** The structural part of CruiseInputs the sequence fills (v3 fields only). */
export interface SequenceInputs {
  requested: boolean;
  clearanceKm: number;
  grounded: boolean;
  atmosphericDensity: number;
  nearestRadiusKm: number;
  arrival: { clearanceKm: number; radiusKm: number; soiRadiusKm: number; closing: boolean } | null;
  exitSpeedKmS: number;
  aligned: boolean;
}

export const SEQUENCE_DT = 1 / 60;
export const SEQUENCE_STEPS = 900;

export function sequenceInputs(i: number): SequenceInputs {
  const released = i >= 200 && i < 206;
  return {
    requested: i < 860 && !released,
    clearanceKm: 5e6 * Math.exp(-i / 100) + 300,
    grounded: false,
    atmosphericDensity: 0,
    nearestRadiusKm: 7_240,
    arrival:
      i >= 320 && i < 520
        ? { clearanceKm: 2e5 * Math.exp(-(i - 320) / 25), radiusKm: 7_240, soiRadiusKm: 5e5, closing: true }
        : null,
    exitSpeedKmS: 7,
    aligned: i % 7 !== 0,
  };
}

/** What a drive exposes, structurally (both the v3 and the current class fit). */
export interface DriveLike {
  phase: string;
  progress: number;
  capKmS: number;
  blocked: string | null;
  dropReason: string | null;
  update(dt: number, inputs: never): void;
}

/**
 * Run `drive` through the sequence, inputs optionally extended by `extra`,
 * and return the SHA-256 of its exact state after every step.
 */
export function sequenceFingerprint(drive: DriveLike, extra: Record<string, unknown> = {}): string {
  const h = createHash('sha256');
  for (let i = 0; i < SEQUENCE_STEPS; i++) {
    drive.update(SEQUENCE_DT, { ...sequenceInputs(i), ...extra } as never);
    h.update(`${i}|${drive.phase}|${drive.progress}|${drive.capKmS}|${drive.blocked}|${drive.dropReason}\n`);
  }
  return h.digest('hex');
}
