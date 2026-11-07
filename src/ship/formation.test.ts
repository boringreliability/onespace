/**
 * v3 T4 / PLAN G — the optional formation assist.
 *
 * FA-hold referenced to the target's velocity: with formation on, the lever's
 * set speed is relative to the companion, not the parent, so the detent means
 * "sit beside it" instead of "coast". The flight model itself is not changed
 * (D0 (4)); it gains one OPTIONAL reference velocity read in the hold target,
 * in a marked block, so T2's rewrite of the assist internals keeps a one-line
 * merge.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bus } from '@/core/EventBus';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { FORMATION_KEY, FORMATION_RANGE_KM, formationHoldVelocity, mayHoldFormation } from './formation';

const H = 1 / 120;

function deepSpace(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.flightAssist = true;
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(), new Vector3(), new Quaternion());
  return fm;
}

function run(fm: FlightModel, seconds: number): void {
  const n = Math.round(seconds / H);
  for (let i = 0; i < n; i++) fm.update(H);
}

const quiet: Array<() => void> = [];
afterEach(() => {
  while (quiet.length) quiet.pop()!();
});

describe('formationHoldVelocity: the hold target, referenced', () => {
  const nose = new Vector3(0, 0, -1);

  it('Given no reference, Then it is the plain FA target (nose · vset) — unchanged behaviour', () => {
    expect(formationHoldVelocity(nose, 0.3, null, new Vector3()).toArray()).toEqual([0, 0, -0.3]);
  });

  it('Given a reference and the lever at the detent, Then the target is exactly the reference (sit beside it)', () => {
    const ref = new Vector3(0.1, -0.2, 5.4);
    expect(formationHoldVelocity(nose, 0, ref, new Vector3()).equals(ref)).toBe(true);
  });

  it('Given a reference and lever speed, Then the set speed is added along the nose (closing speed relative to it)', () => {
    const ref = new Vector3(1, 0, 0);
    expect(formationHoldVelocity(nose, 0.05, ref, new Vector3()).toArray()).toEqual([1, 0, -0.05]);
  });
});

describe('mayHoldFormation: only against a real, near, targeted vessel', () => {
  const ok = { fa: true, targetIsVessel: true, distanceKm: 2, cruise: false };

  it('Given FA on, a vessel targeted within range and no cruise, Then formation is allowed', () => {
    expect(mayHoldFormation(ok)).toBe(true);
  });
  it('Given FA off, Then not (FA-off is yours to fly)', () => {
    expect(mayHoldFormation({ ...ok, fa: false })).toBe(false);
  });
  it('Given a body or nothing targeted, Then not', () => {
    expect(mayHoldFormation({ ...ok, targetIsVessel: false })).toBe(false);
  });
  it('Given the vessel beyond the formation range, Then not', () => {
    expect(mayHoldFormation({ ...ok, distanceKm: FORMATION_RANGE_KM + 1 })).toBe(false);
    expect(mayHoldFormation({ ...ok, distanceKm: Number.NaN })).toBe(false);
  });
  it('Given the cruise drive, Then not', () => {
    expect(mayHoldFormation({ ...ok, cruise: true })).toBe(false);
  });
  it('Given the key, Then it is one no other binding uses (K)', () => {
    expect(FORMATION_KEY).toBe('KeyK');
  });
});

describe('FlightModel.assistReferenceVelocity: the one optional hook', () => {
  it('Given FA on, a reference set and the lever at the detent, Then the ship flies to the reference velocity', () => {
    quiet.push(bus.on('log', () => {}));
    const fm = deepSpace();
    fm.command.throttle = 0;
    fm.assistReferenceVelocity = new Vector3(0, 0, -0.05); // 50 m/s along the nose
    run(fm, 20);
    expect(fm.velocity.distanceTo(new Vector3(0, 0, -0.05))).toBeLessThan(1e-3);
  });

  it('Given a reference to the side, Then the RCS matches it (the computer flies, it does not teleport)', () => {
    const fm = deepSpace();
    fm.assistReferenceVelocity = new Vector3(0.01, 0, 0);
    fm.update(H);
    // One substep can only buy what the RCS authority allows.
    const rcs = (DEFAULT_SHIP_CONFIG.rcsThrust / DEFAULT_SHIP_CONFIG.mass) * 1e-3;
    expect(fm.velocity.length()).toBeLessThanOrEqual(rcs * H * 1.0001);
    run(fm, 30);
    expect(fm.velocity.distanceTo(new Vector3(0.01, 0, 0))).toBeLessThan(1e-3);
  });

  it('Given the reference cleared (null), Then the detent is COAST again — an orbit survives hands-off', () => {
    const fm = deepSpace();
    fm.teleport(new Vector3(), new Vector3(0.2, 0, 0), new Quaternion());
    fm.assistReferenceVelocity = new Vector3();
    fm.assistReferenceVelocity = null;
    fm.command.throttle = 0;
    run(fm, 5);
    expect(fm.velocity.x).toBeCloseTo(0.2, 9);
    expect(fm.assistState).toBe('coast');
  });

  it('Given FA off, Then the reference is ignored (Newtonian is Newtonian)', () => {
    const fm = deepSpace();
    fm.flightAssist = false;
    fm.assistReferenceVelocity = new Vector3(0.1, 0, 0);
    run(fm, 5);
    expect(fm.velocity.length()).toBe(0);
  });

  it('Given a non-finite reference, Then it is treated as no reference', () => {
    const fm = deepSpace();
    fm.assistReferenceVelocity = new Vector3(Number.NaN, 0, 0);
    run(fm, 1);
    expect(Number.isFinite(fm.velocity.x)).toBe(true);
    expect(fm.velocity.length()).toBe(0);
  });
});
