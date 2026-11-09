/**
 * v4 sub-plan 1 (propellant), Task 5 — what the HUD says about the tank, and
 * the numbers the autopilot checks before a landing.
 *
 * Pure seams (src/ui/propellantReadout.ts):
 *  - propellantTone(fraction): caution below 0.25, warning below 0.10.
 *  - landingEstimateKg(flight): conservative — 1.3 × the Δv for circular
 *    orbit speed + the FINAL hover. Conservative means: never less than what
 *    the real auto-land from the opening orbit at Remit actually burns.
 *  - autoLandVerdict(have, need): refuse below 0.5·need, marginal below need.
 *  - effectiveThrottle(throttle, starved): a starved engine delivers nothing,
 *    so the throttle readout must not show thrust (Task 2 deferred finding).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';

import { openingAttitude } from '@/game/recovery';
import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import { EXHAUST_VELOCITY_KMS, PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { REMIT, flyLeg, releaseLegListeners } from '@/ship/testing/landingSim';
import { autoLandVerdict, effectiveThrottle, landingEstimateKg, propellantTone } from './propellantReadout';

afterEach(releaseLegListeners);

const CAP = PROBE_TANK_CAPACITY_KG;

describe('propellantTone', () => {
  it('Given a tank at 26 %, Then the tone is normal', () => {
    expect(propellantTone(0.26)).toBe('normal');
  });

  it('Given a tank at exactly 25 %, Then the tone is caution', () => {
    expect(propellantTone(0.25)).toBe('caution');
  });

  it('Given a tank at 9.9 %, Then the tone is warning', () => {
    expect(propellantTone(0.099)).toBe('warning');
  });

  it('Given a full tank, Then normal; Given an empty tank, Then warning', () => {
    expect(propellantTone(1)).toBe('normal');
    expect(propellantTone(0)).toBe('warning');
  });
});

describe('autoLandVerdict', () => {
  it('Given at least the estimate on board, Then go', () => {
    expect(autoLandVerdict(100, 100)).toBe('go');
    expect(autoLandVerdict(250, 100)).toBe('go');
  });

  it('Given less than the estimate but at least half of it, Then marginal', () => {
    expect(autoLandVerdict(99, 100)).toBe('marginal');
    expect(autoLandVerdict(50, 100)).toBe('marginal');
  });

  it('Given less than half the estimate, Then refuse', () => {
    expect(autoLandVerdict(49, 100)).toBe('refuse');
    expect(autoLandVerdict(0, 100)).toBe('refuse');
  });
});

describe('effectiveThrottle (the readout never shows a starved engine delivering thrust)', () => {
  it('Given the engine not starved, Then the readout shows the throttle as it is', () => {
    expect(effectiveThrottle(0.7, false)).toBe(0.7);
  });

  it('Given thrustStarved, When the throttle is still spooled up, Then the readout shows 0', () => {
    expect(effectiveThrottle(0.7, true)).toBe(0);
    expect(effectiveThrottle(1, true)).toBe(0);
  });
});

describe('landingEstimateKg is conservative', () => {
  /** A full-tank hull on the opening orbit at Remit, placed as the landing simulation places it. */
  function openingOrbitHull(): FlightModel {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.attachPropellant(new Propellant(CAP, 1.0), EXHAUST_VELOCITY_KMS);
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: REMIT.mu, radius: REMIT.radiusKm });
    const pos = new Vector3(-0.8, 0.35, -0.5).normalize().multiplyScalar(REMIT.radiusKm * 1.6);
    const vel = fm.orbitalVelocityAt(pos);
    fm.teleport(pos, vel, openingAttitude(vel, pos, new Quaternion()));
    fm.setAtmosphere(0);
    return fm;
  }

  it('Given a full tank on the opening orbit at Remit, Then the estimate is ≥ what the real auto-land burns to touchdown', () => {
    const estimate = landingEstimateKg(openingOrbitHull());

    let hull: FlightModel | null = null;
    const leg = flyLeg(REMIT, true, (fm) => {
      fm.attachPropellant(new Propellant(CAP, 1.0), EXHAUST_VELOCITY_KMS);
      hull = fm;
    });
    const usedKg = CAP - hull!.propellant!.massKg;
    console.info(`[fuel HUD] Remit opening orbit: estimate ${estimate.toFixed(0)} kg · measured ${usedKg.toFixed(0)} kg`);

    expect(leg.result).toBe('landed');
    expect(Number.isFinite(estimate)).toBe(true);
    expect(estimate).toBeGreaterThanOrEqual(usedKg);
    // So a full tank on the opening orbit is a GO, not a refusal.
    expect(autoLandVerdict(CAP, estimate)).toBe('go');
  }, 60_000);
});
