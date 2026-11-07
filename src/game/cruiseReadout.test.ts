/**
 * The throttle block under cruise (v3 PLAN F / H1; audit cruise-04-cruise4.png).
 *
 * Under cruise the drive carries the ship and the sublight throttle means
 * nothing, yet the block read "100 %" over "FA · COAST" at 0.78 c. While the
 * drive is doing anything the block says what the drive is doing — spool
 * progress, speed as a fraction or multiple of c, and the time to arrival —
 * and goes back to THR / FA when the drive is idle.
 */

import { describe, expect, it } from 'vitest';

import {
  CRUISE_DEFAULTS,
  arrivalClearanceKm,
  cruiseEtaSeconds,
  cruiseTravelSeconds,
} from '@/ship/CruiseDrive';

import { clockText, cruiseArrivalEta, cruiseReadout, cruiseSpeedText } from './cruiseReadout';

const C = 299792.458;

describe('cruiseSpeedText', () => {
  it('Given 0.7815 c, Then a fraction of c with two decimals: "0.78 c"', () => {
    expect(cruiseSpeedText(0.7815 * C)).toBe('0.78 c');
  });

  it('Given 0.0042 c, Then three decimals so it is not "0.00 c"', () => {
    expect(cruiseSpeedText(0.0042 * C)).toBe('0.004 c');
  });

  it('Given 12.37 c, Then a multiple of c: "×12.4 c"', () => {
    expect(cruiseSpeedText(12.37 * C)).toBe('×12.4 c');
  });

  it('Given 340 c, Then a whole multiple: "×340 c"', () => {
    expect(cruiseSpeedText(340.4 * C)).toBe('×340 c');
  });

  it('Given exactly 1 c, Then "×1.0 c" (the multiple form starts at c)', () => {
    expect(cruiseSpeedText(C)).toBe('×1.0 c');
  });

  it('Given 180 km/s (below 0.001 c, early in the engage), Then plain km/s: "180 KM/S"', () => {
    expect(cruiseSpeedText(180)).toBe('180 KM/S');
  });
});

describe('clockText', () => {
  it('Given 83 s, Then "1:23"', () => {
    expect(clockText(83)).toBe('1:23');
  });

  it('Given 3725 s, Then "1:02:05"', () => {
    expect(clockText(3725)).toBe('1:02:05');
  });

  it('Given more than 99 h, Then ">99h"', () => {
    expect(clockText(100 * 3600)).toBe('>99h');
  });
});

describe('cruiseReadout', () => {
  const base = { progress: 0, speedKmS: 0, etaS: null, destination: null } as const;

  it('Given the drive is idle, Then there is no cruise readout (the block shows THR / FA)', () => {
    expect(cruiseReadout({ ...base, phase: 'idle' })).toBeNull();
  });

  it('Given the drive spooling at 63 %, Then "CRUISE · SPOOL 63 %"', () => {
    const r = cruiseReadout({ ...base, phase: 'spooling', progress: 0.634 });
    expect(r?.primary).toBe('CRUISE · SPOOL 63 %');
  });

  it('Given cruise at 0.78 c with an ETA of 1:23 to Fyss I, Then "CRUISE · 0.78 c" over "ETA 1:23 · FYSS I"', () => {
    const r = cruiseReadout({ ...base, phase: 'cruise', speedKmS: 0.7815 * C, etaS: 83.2, destination: 'Fyss I' });
    expect(r).toEqual({ primary: 'CRUISE · 0.78 c', secondary: 'ETA 1:23 · FYSS I' });
  });

  it('Given cruise with no arrival (not closing on anything), Then the ETA reads a dash and names nothing', () => {
    const r = cruiseReadout({ ...base, phase: 'cruise', speedKmS: 0.1 * C });
    expect(r?.secondary).toBe('ETA —');
  });

  it('Given cruise toward a destination we are not closing on, Then the dash ETA still names the destination', () => {
    const r = cruiseReadout({ ...base, phase: 'cruise', speedKmS: 0.1 * C, destination: 'Remit 31' });
    expect(r?.secondary).toBe('ETA — · REMIT 31');
  });

  it('Given the drive dropping, Then "CRUISE · DROP"', () => {
    const r = cruiseReadout({ ...base, phase: 'dropping', speedKmS: 400, etaS: 0.4, destination: 'Fyss' });
    expect(r?.primary).toBe('CRUISE · DROP');
  });

  it('Given any engaged phase, Then the readout never mentions THR or a percentage of throttle', () => {
    for (const phase of ['spooling', 'cruise', 'dropping'] as const) {
      const r = cruiseReadout({ ...base, phase, speedKmS: 0.5 * C, progress: 0.5, etaS: 10, destination: 'X' })!;
      expect(r.primary + r.secondary).not.toMatch(/THR|100 %/);
    }
  });
});

describe('cruiseArrivalEta', () => {
  it('Given the ship is closing, Then the ETA is the drive’s own crossing time (same law as the chart)', () => {
    expect(cruiseArrivalEta(2e7, 6000, 9e5, true)).toBeCloseTo(cruiseEtaSeconds(2e7, 6000, 9e5), 9);
  });

  it('Given the ship is not closing, Then there is no ETA (the drive will never arrive)', () => {
    expect(cruiseArrivalEta(2e7, 6000, 9e5, false)).toBeNull();
  });

  it('Given the ship is still climbing out of ANOTHER body’s well (drive clearance 2 000 km, target 13.4 Mkm away), Then the ETA includes that climb — the target-only law said a constant 0:18 for the first half minute (GPU run)', () => {
    const d = 13.4e6;
    const R = 11324;
    const soi = 101421;
    const gap = d - R;
    const mid = gap / 2;
    const climb = Math.log(mid / 2000) / CRUISE_DEFAULTS.rate;
    const eta = cruiseArrivalEta(d, R, soi, true, 2000)!;
    expect(eta).toBeGreaterThan(cruiseEtaSeconds(d, R, soi) + 10);
    expect(eta).toBeCloseTo(climb + cruiseTravelSeconds(mid, arrivalClearanceKm(R, soi)), 6);
  });

  it('Given the drive clearance is the target itself (nothing else nearer), Then the ETA is exactly the target-only law', () => {
    expect(cruiseArrivalEta(2e7, 6000, 9e5, true, 2e7 - 6000)).toBeCloseTo(cruiseEtaSeconds(2e7, 6000, 9e5), 9);
  });

  it('Given a non-finite distance, Then there is no ETA', () => {
    expect(cruiseArrivalEta(Number.NaN, 6000, 9e5, true)).toBeNull();
  });
});
