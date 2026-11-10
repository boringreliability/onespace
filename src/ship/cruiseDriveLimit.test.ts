/**
 * v4 sub-plan 2, Task 7 fix round 1 (R22 §5) — the drive's two new inputs.
 *
 * `limitKm` (a gap the ceiling follows but the envelope does not) and
 * `arrivalFirst` were added for belt fields. Unset, the drive must be the v3
 * drive exactly; and a limit at or below zero must never reach the ceiling,
 * or a ship engaged inside or at the edge of a field sits at 0 km/s forever
 * with its spool already paid (review IMPORTANT 1).
 */

import { describe, expect, it } from 'vitest';

import { FIELD_RADIUS_KM } from '@/gen/belt';
import { CRUISE_DEFAULTS, CruiseDrive, cruiseCapKmS, holdClearanceKm, type CruiseInputs } from './CruiseDrive';
import { sequenceFingerprint } from './testing/cruiseSequence';

/**
 * The fingerprint of the v3 drive (commit ab61a0c, before `limitKm` existed)
 * over `cruiseSequence` — every phase and every drop reason (released,
 * arrival, mass), including the align hold.
 */
const V3_FINGERPRINT = 'ada8d15304f82fb1b3326511ba9db09722ea9807d931be574285b6dce035da1e';

describe('CruiseDrive — limitKm / arrivalFirst unset is v3', () => {
  it('Given limitKm and arrivalFirst unset, When the fixed sequence is run, Then the drive is bit-identical to v3', () => {
    expect(sequenceFingerprint(new CruiseDrive() as never)).toBe(V3_FINGERPRINT);
  });

  it('Given limitKm undefined and arrivalFirst false spelled out, Then it is still bit-identical to v3', () => {
    expect(sequenceFingerprint(new CruiseDrive() as never, { limitKm: undefined, arrivalFirst: false })).toBe(V3_FINGERPRINT);
  });
});

describe('CruiseDrive — a limit at or below zero is never used', () => {
  /** Spool and engage in open space (clearance 10^6 km), then cruise with `limitKm`. */
  function cruisingWith(limitKm: number): CruiseDrive {
    const d = new CruiseDrive();
    const base: CruiseInputs = { requested: true, clearanceKm: 1e6, grounded: false, atmosphericDensity: 0 };
    for (let t = 0; t < CRUISE_DEFAULTS.spoolTime + 0.2; t += 1 / 60) d.update(1 / 60, base);
    expect(d.phase).toBe('cruise');
    for (let i = 0; i < 30; i++) d.update(1 / 60, { ...base, limitKm });
    return d;
  }

  for (const limitKm of [0, -5, -1e6]) {
    it(`Given cruise with limitKm = ${limitKm}, Then the ceiling is floored at the hold clearance (never 0 km/s)`, () => {
      const d = cruisingWith(limitKm);
      expect(d.phase).toBe('cruise');
      expect(d.capKmS).toBeGreaterThan(0);
      // holdClearanceKm(FIELD_RADIUS_KM) is the floor R22 names; it equals the
      // drive's own drop clearance (700 km), so the drive can floor without
      // knowing what the limit belongs to.
      expect(holdClearanceKm(FIELD_RADIUS_KM)).toBe(CRUISE_DEFAULTS.dropClearanceKm);
      expect(d.capKmS).toBeGreaterThanOrEqual(cruiseCapKmS(holdClearanceKm(FIELD_RADIUS_KM)));
    });
  }

  it('Given a positive limit above the floor, Then the ceiling follows it (rate × limit)', () => {
    const d = cruisingWith(50_000);
    expect(d.capKmS).toBe(cruiseCapKmS(50_000));
  });
});
