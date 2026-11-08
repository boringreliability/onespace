/**
 * v4 sub-plan 1 (propellant), Task 3 — the fuel tuning targets as tests.
 *
 * The only knob these targets tune is EXHAUST_VELOCITY_KMS (propellant.ts).
 * Both run the REAL FlightModel with a full probe tank attached, the way
 * Universe will attach it:
 *
 *  (a) auto-land from the opening orbit at Remit 31, flown by the shared
 *      landing simulation (the same leg the pacing test flies: auto-10×,
 *      autopilot stepped per slice), uses 4–10 % of the tank;
 *  (b) 10 s of full main thrust (FA-OFF, no boost) in the same orbit uses
 *      ≤ 2 %.
 *
 * The third target in the brief (two landings and back on one tank, with the
 * jump) waits for Task 4's jumpPropellantFraction (controller ruling R2).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { openingAttitude } from '@/game/recovery';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from './propellant';
import { FRAME, REMIT, flyLeg, releaseLegListeners } from './testing/landingSim';

afterEach(releaseLegListeners);

const CAP = PROBE_TANK_CAPACITY_KG;

function fullTank(fm: FlightModel): void {
  fm.attachPropellant(new Propellant(CAP, 1.0), EXHAUST_VELOCITY_KMS);
}

/** Fraction of capacity drawn from the hull's tank. */
function usedFraction(fm: FlightModel): number {
  return (CAP - fm.propellant!.massKg) / CAP;
}

describe('fuel tuning targets (D1)', () => {
  it('Given a full tank on the opening orbit at Remit, When auto-land runs to touchdown, Then it uses 4–10 % of capacity', () => {
    let hull: FlightModel | null = null;
    const l = flyLeg(REMIT, true, (fm) => {
      fullTank(fm);
      hull = fm;
    });
    const used = usedFraction(hull!);
    console.info(`[fuel tuning] ve ${EXHAUST_VELOCITY_KMS} km/s · Remit auto-land: ${l.result} · used ${(used * 100).toFixed(2)} %`);
    expect(l.result).toBe('landed');
    expect(l.crashes).toBe(0);
    expect(used).toBeGreaterThanOrEqual(0.04);
    expect(used).toBeLessThanOrEqual(0.1);
  });

  // D2: the owner's ve. Phase B sets EXHAUST_VELOCITY_KMS to it; until then the
  // CLEAN bar is also flown here, because a full tank that stays heavy all the
  // way down (high ve) is the hard case: at ve 1000 the leg burns 80 % and
  // lands light, which would hide the miss.
  const D2_VE_KMS = 11_500;

  it('Given a full tank, When auto-land runs to touchdown, Then it is CLEAN (vertical < 2 m/s, the pacing test\'s bar)', () => {
    for (const ve of new Set([EXHAUST_VELOCITY_KMS, D2_VE_KMS])) {
      const l = flyLeg(REMIT, true, (fm) => fm.attachPropellant(new Propellant(CAP, 1.0), ve));
      releaseLegListeners();
      const v = l.touchdowns[0]?.vertical ?? Number.NaN;
      console.info(`[fuel tuning] ve ${ve} km/s · full-tank auto-land: ${l.result} · touchdown ${(v * 1000).toFixed(2)} m/s`);
      expect(l.result, `ve ${ve}`).toBe('landed');
      expect(l.crashes, `ve ${ve}`).toBe(0);
      expect(v, `ve ${ve}: touchdown vertical km/s`).toBeLessThan(0.002);
    }
  });

  it('Given a full tank in orbit, When main is held for 10 s, Then it uses ≤ 2 %', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fullTank(fm);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: REMIT.mu, radius: REMIT.radiusKm });
    // The opening orbit, as the landing simulation places it (1.6 R, circular, vacuum).
    const pos = new Vector3(-0.8, 0.35, -0.5).normalize().multiplyScalar(REMIT.radiusKm * 1.6);
    const vel = fm.orbitalVelocityAt(pos);
    fm.teleport(pos, vel, openingAttitude(vel, pos, new Quaternion()));
    fm.setAtmosphere(0);
    fm.flightAssist = false;
    fm.command.throttle = 1;
    for (let i = 0; i < Math.round(10 / FRAME); i++) fm.update(FRAME);
    const used = usedFraction(fm);
    console.info(`[fuel tuning] ve ${EXHAUST_VELOCITY_KMS} km/s · 10 s full main in orbit: used ${(used * 100).toFixed(3)} %`);
    expect(fm.thrustStarved).toBe(false);
    expect(used).toBeGreaterThan(0); // the burn actually drew
    expect(used).toBeLessThanOrEqual(0.02);
  });
});
