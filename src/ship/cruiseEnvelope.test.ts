/**
 * v2 phase 1 — the cruise envelope, measured against the body, not the metre.
 *
 * The v1 envelope was absolute: 5 000 km to engage, 3 000 km to hold. The game
 * opens 4 474 km above Remit 31 (R 7 240 km), so the very first thing a player
 * tried — G — answered "MASS TOO CLOSE". And the same 5 000 km means nothing
 * next to a moon of R 1 000 km and less than nothing next to a gas giant of
 * R 79 000 km. Gravity wells scale with radius; so must the envelope.
 *
 * Three thresholds, each a multiple of the radius of the body in question,
 * each with an absolute floor so a pebble cannot shrink them to nothing:
 *
 *   engage   ≥ max(engageFloor, 0.5 R)   clearance needed to start
 *   hold     ≥ max(holdFloor,   0.3 R)   clearance below which it lets go
 *   arrival  = 2 R (r = 3 R), clipped inside the body's SOI
 *              — drop deliberately when closing on the body you came for
 *
 * The safety invariant from `cruise.test.ts` is untouched: the ceiling is
 * still `rate × clearance` and still clamps hard, so nothing here can make a
 * step longer than 0.58 % of the gap.
 */

import { describe, expect, it } from 'vitest';
import {
  CRUISE_DEFAULTS,
  CruiseDrive,
  arrivalClearanceKm,
  cruiseCapKmS,
  cruiseEtaSeconds,
  cruiseTravelSeconds,
  engageClearanceKm,
  holdClearanceKm,
  type CruiseInputs,
} from './CruiseDrive';

/** Remit 31, the opening world, as measured in GAMEPLAY.md. */
const REMIT_R = 7_240;
const OPENING_ALT = 4_474;
const MOON_R = 1_000;
const GIANT_R = 79_000;
const AU = 1.496e8;

function inputs(over: Partial<CruiseInputs> = {}): CruiseInputs {
  return {
    requested: true,
    clearanceKm: 1e6,
    grounded: false,
    atmosphericDensity: 0,
    ...over,
  };
}

function run(d: CruiseDrive, seconds: number, over: Partial<CruiseInputs> = {}): void {
  const h = 1 / 60;
  for (let t = 0; t < seconds; t += h) d.update(h, inputs(over));
}

function cruisingFarOut(): CruiseDrive {
  const d = new CruiseDrive();
  run(d, CRUISE_DEFAULTS.spoolTime + 0.2);
  expect(d.phase).toBe('cruise');
  return d;
}

describe('engaging from the opening orbit', () => {
  it('Given the measured opening state (R 7 240 km, alt 4 474 km), When G is pressed, Then the drive spools and engages', () => {
    const d = new CruiseDrive();
    run(d, CRUISE_DEFAULTS.spoolTime + 0.1, {
      clearanceKm: OPENING_ALT,
      nearestRadiusKm: REMIT_R,
      atmosphericDensity: Math.exp(-OPENING_ALT / 14.6),
    });
    expect(d.blocked).toBe(null);
    expect(d.phase).toBe('cruise');
  });

  it('Given the earlier measurement of 4 344 km, Then it engages too — the threshold is not tuned to one number', () => {
    expect(engageClearanceKm(REMIT_R)).toBeLessThan(4_344);
  });

  it('Given the opening world, Then the engage threshold is radius-relative (0.5 R), not the old absolute 5 000 km', () => {
    expect(engageClearanceKm(REMIT_R)).toBeCloseTo(0.5 * REMIT_R, 6);
  });

  it('Given a ship barely off the deck at Remit (0.2 R), Then the drive still refuses with MASS', () => {
    const d = new CruiseDrive();
    run(d, 3, { clearanceKm: 0.2 * REMIT_R, nearestRadiusKm: REMIT_R });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('mass');
  });
});

describe('the thresholds scale with the body', () => {
  it('Given a gas giant of R 79 000 km, Then engage needs 0.5 R (39 500 km) and 30 000 km is refused', () => {
    expect(engageClearanceKm(GIANT_R)).toBeCloseTo(39_500, 6);
    const d = new CruiseDrive();
    run(d, 3, { clearanceKm: 30_000, nearestRadiusKm: GIANT_R });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('mass');
  });

  it('Given a gas giant, When cruising, Then it lets go below 0.3 R (23 700 km)', () => {
    expect(holdClearanceKm(GIANT_R)).toBeCloseTo(23_700, 6);
    const d = cruisingFarOut();
    d.update(1 / 60, inputs({ clearanceKm: 23_000, nearestRadiusKm: GIANT_R }));
    expect(d.phase).toBe('dropping');
    expect(d.blocked).toBe('mass');
  });

  it('Given a moon of R 1 000 km, Then the absolute floors decide, not the radius', () => {
    expect(engageClearanceKm(MOON_R)).toBe(CRUISE_DEFAULTS.engageClearanceKm);
    expect(holdClearanceKm(MOON_R)).toBe(CRUISE_DEFAULTS.dropClearanceKm);
  });

  it('Given a pebble (R 10 km) or no radius at all, Then the floors still hold', () => {
    for (const r of [0, 10]) {
      expect(engageClearanceKm(r)).toBe(CRUISE_DEFAULTS.engageClearanceKm);
      expect(holdClearanceKm(r)).toBe(CRUISE_DEFAULTS.dropClearanceKm);
    }
  });

  it('Given no nearestRadiusKm in the inputs, Then the drive falls back to the floors (old callers keep working)', () => {
    const d = new CruiseDrive();
    run(d, 3, { clearanceKm: CRUISE_DEFAULTS.engageClearanceKm * 0.9 });
    expect(d.blocked).toBe('mass');
    const e = new CruiseDrive();
    run(e, CRUISE_DEFAULTS.spoolTime + 0.1, { clearanceKm: CRUISE_DEFAULTS.engageClearanceKm * 1.1 });
    expect(e.phase).toBe('cruise');
  });

  it('Given the hold floor, Then cruise there is still faster than boosted sublight', () => {
    // Otherwise holding the drive at its lowest legal clearance would be a
    // downgrade — the drive would feel broken exactly when it is closest.
    const boosted = 60 * 3;
    expect(cruiseCapKmS(CRUISE_DEFAULTS.dropClearanceKm)).toBeGreaterThan(boosted);
  });
});

describe('hysteresis, at every scale', () => {
  for (const r of [0, MOON_R, REMIT_R, GIANT_R, 7e5 /* a star */]) {
    it(`Given R = ${r} km, Then engage needs at least 1.2× the hold clearance`, () => {
      expect(engageClearanceKm(r)).toBeGreaterThan(holdClearanceKm(r) * 1.2);
    });

    it(`Given R = ${r} km and a ship parked between hold and engage, Then it cannot start there but keeps running there`, () => {
      const between = (engageClearanceKm(r) + holdClearanceKm(r)) / 2;
      const d = new CruiseDrive();
      run(d, 3, { clearanceKm: between, nearestRadiusKm: r });
      expect(d.phase).toBe('idle');

      const e = cruisingFarOut();
      run(e, 2, { clearanceKm: between, nearestRadiusKm: r });
      expect(e.phase).toBe('cruise');
    });
  }
});

describe('arrival — dropping on purpose', () => {
  const arrival = (clearanceKm: number, closing: boolean, soiRadiusKm = 1e7) => ({
    clearanceKm,
    radiusKm: REMIT_R,
    soiRadiusKm,
    closing,
  });

  it('Given Remit, Then arrival is at 2 R clearance (r = 3 R)', () => {
    expect(arrivalClearanceKm(REMIT_R)).toBeCloseTo(2 * REMIT_R, 6);
  });

  it('Given arrival lies outside the engage threshold, Then a ship dropped on arrival may engage again', () => {
    for (const r of [MOON_R, REMIT_R, GIANT_R]) {
      expect(arrivalClearanceKm(r)).toBeGreaterThan(engageClearanceKm(r));
    }
  });

  it('Given cruising and closing on the body, When clearance falls below 2 R, Then it drops for arrival', () => {
    const d = cruisingFarOut();
    d.update(1 / 60, inputs({
      clearanceKm: 1.9 * REMIT_R,
      nearestRadiusKm: REMIT_R,
      arrival: arrival(1.9 * REMIT_R, true),
    }));
    expect(d.phase).toBe('dropping');
    expect(d.dropReason).toBe('arrival');
  });

  it('Given cruising inside 2 R but moving away (departing the opening orbit), Then it keeps cruising', () => {
    const d = cruisingFarOut();
    run(d, 1, {
      clearanceKm: 0.7 * REMIT_R,
      nearestRadiusKm: REMIT_R,
      arrival: arrival(0.7 * REMIT_R, false),
    });
    expect(d.phase).toBe('cruise');
  });

  it('Given a moon whose SOI is 2.5 R (3 R would be outside it), Then arrival happens inside the SOI (≤ 0.9 SOI from the centre)', () => {
    // 1.6 R in the first draft: with the 700 km hold floor there is no
    // clearance that is both inside 0.9 SOI and above hold, and the next test
    // says which one wins. 2.5 R is a moon where clipping is possible.
    const soi = 2.5 * MOON_R;
    const c = arrivalClearanceKm(MOON_R, soi);
    expect(c).toBeLessThan(2 * MOON_R);
    expect(MOON_R + c).toBeLessThanOrEqual(0.9 * soi + 1e-9);
  });

  it('Given an SOI too small to arrive inside, Then arrival never sits below the hold threshold', () => {
    const c = arrivalClearanceKm(MOON_R, 1.5 * MOON_R);
    expect(c).toBeGreaterThanOrEqual(holdClearanceKm(MOON_R));
  });

  it('Given the pilot releases G, Then the drop reason is "released"', () => {
    const d = cruisingFarOut();
    d.update(1 / 60, inputs({ requested: false }));
    expect(d.dropReason).toBe('released');
  });
});

describe('the drop bleed', () => {
  it('Given an exit speed in the inputs (the circular speed), Then the bleed ends there, not at 60 km/s', () => {
    const d = cruisingFarOut();
    const vc = 4.8;
    let last = Infinity;
    const h = 1 / 60;
    d.update(h, inputs({ requested: false, exitSpeedKmS: vc }));
    for (let t = 0; t < CRUISE_DEFAULTS.dropTime - 2 * h; t += h) {
      d.update(h, inputs({ requested: false, exitSpeedKmS: vc }));
      if (d.phase === 'dropping') last = d.capKmS;
    }
    expect(last).toBeLessThan(vc * 1.5);
    expect(last).toBeGreaterThanOrEqual(vc * 0.999);
  });

  it('Given no exit speed, Then the legacy 60 km/s is used', () => {
    const d = cruisingFarOut();
    const h = 1 / 60;
    let last = Infinity;
    for (let t = 0; t < CRUISE_DEFAULTS.dropTime - 2 * h; t += h) {
      d.update(h, inputs({ requested: false }));
      if (d.phase === 'dropping') last = d.capKmS;
    }
    expect(last).toBeGreaterThanOrEqual(CRUISE_DEFAULTS.exitSpeedKmS * 0.999);
    expect(last).toBeLessThan(CRUISE_DEFAULTS.exitSpeedKmS * 1.5);
  });

  it('Given a gap that keeps closing during the bleed, Then the ceiling never exceeds the clearance law (safety invariant)', () => {
    const d = cruisingFarOut();
    const h = 1 / 60;
    let gap = 1e6;
    for (let i = 0; i < 120; i++) {
      d.update(h, inputs({ requested: false, clearanceKm: gap }));
      if (d.phase === 'dropping') {
        expect(d.capKmS).toBeLessThanOrEqual(cruiseCapKmS(gap) * (1 + 1e-9) + 1e-9);
      }
      gap *= 0.9; // collapsing far faster than any real approach
    }
  });
});

describe('the chart ETA stays honest', () => {
  it('Given a body at 1 AU, Then cruiseEtaSeconds is the closed-form time to its arrival threshold', () => {
    const eta = cruiseEtaSeconds(AU, REMIT_R);
    expect(eta).toBeCloseTo(
      cruiseTravelSeconds(AU - REMIT_R, arrivalClearanceKm(REMIT_R)),
      6,
    );
  });

  it('Given worlds from R 1 500 to 79 000 km, Then the ETA is no worse than the old "fly to 3 000 km" figure', () => {
    for (const r of [1_500, REMIT_R, GIANT_R]) {
      const old = cruiseTravelSeconds(AU - r, 3_000);
      expect(cruiseEtaSeconds(AU, r)).toBeLessThanOrEqual(old + 1e-9);
    }
  });

  it('Given a small moon with a tight SOI, Then the ETA uses the SOI-clipped arrival', () => {
    const soi = 1.6 * MOON_R;
    expect(cruiseEtaSeconds(1e6, MOON_R, soi)).toBeCloseTo(
      cruiseTravelSeconds(1e6 - MOON_R, arrivalClearanceKm(MOON_R, soi)),
      6,
    );
  });
});
