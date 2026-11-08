/**
 * v4 sub-plan 1 (propellant) — the probe's tank and its consumption formulas.
 *
 * A pure model: a tank that can be drained, refilled and shrunk (capacity
 * loss), plus the three formulas the flight model will lean on —
 * kg burned for an impulse (a·m·dt/ve), the Tsiolkovsky dv left, and the
 * mass scale that keeps tank mass from dulling the ship's response.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SHIP_CONFIG } from './FlightModel';
import {
  EXHAUST_VELOCITY_KMS,
  PROBE_DRY_MASS_KG,
  PROBE_TANK_CAPACITY_KG,
  Propellant,
  START_FILL,
  deltaVRemaining,
  massScale,
  propellantForImpulse,
} from './propellant';

const BAD_NUMBERS = [NaN, -1, -1e9, Infinity, -Infinity];

describe('propellant constants', () => {
  it('Given the global constraints, Then the probe constants have the specified values', () => {
    expect(PROBE_TANK_CAPACITY_KG).toBe(20_000);
    expect(PROBE_DRY_MASS_KG).toBe(DEFAULT_SHIP_CONFIG.mass);
    expect(EXHAUST_VELOCITY_KMS).toBe(11_500);
    expect(START_FILL).toBe(0.6);
  });
});

describe('Propellant tank', () => {
  it('Given a 20 t tank at 0.6, Then it holds 12 000 kg and fraction is 0.6', () => {
    const tank = new Propellant(20_000, 0.6);
    expect(tank.massKg).toBeCloseTo(12_000, 6);
    expect(tank.capacityKg).toBe(20_000);
    expect(tank.fraction).toBeCloseTo(0.6, 9);
    expect(tank.empty).toBe(false);
  });

  it('When consuming more than is left, Then it returns only what was there and ends at exactly 0', () => {
    const tank = new Propellant(20_000, 0.6);
    const taken = tank.consume(50_000);
    expect(taken).toBeCloseTo(12_000, 6);
    expect(tank.massKg).toBe(0);
    expect(tank.fraction).toBe(0);
    expect(tank.empty).toBe(true);
  });

  it('When consuming less than is left, Then it returns exactly that and the rest remains', () => {
    const tank = new Propellant(20_000, 0.6);
    expect(tank.consume(2_000)).toBeCloseTo(2_000, 6);
    expect(tank.massKg).toBeCloseTo(10_000, 6);
  });

  it('When adding beyond free capacity, Then it returns only what fit', () => {
    const tank = new Propellant(20_000, 0.6);
    const added = tank.add(50_000);
    expect(added).toBeCloseTo(8_000, 6);
    expect(tank.massKg).toBeCloseTo(20_000, 6);
    expect(tank.fraction).toBeCloseTo(1, 9);
    expect(tank.add(1)).toBe(0);
  });

  it('Given capacityLossFrac 0.25, Then capacityKg is 15 000 and a tank fuller than that is clamped down', () => {
    const tank = new Propellant(20_000, 0.9); // 18 000 kg
    tank.capacityLossFrac = 0.25;
    expect(tank.baseCapacityKg).toBe(20_000);
    expect(tank.capacityKg).toBeCloseTo(15_000, 6);
    expect(tank.massKg).toBeLessThanOrEqual(15_000 + 1e-9);
    expect(tank.fraction).toBeLessThanOrEqual(1);
    expect(tank.add(1_000)).toBe(0);
  });
});

describe('propellantForImpulse', () => {
  it('propellantForImpulse: 0.2 km/s² on 200 t for 1 s at ve 1000 → 40 kg', () => {
    expect(propellantForImpulse(0.2, 200_000, 1, 1000)).toBeCloseTo(40, 9);
  });
});

describe('deltaVRemaining', () => {
  it('deltaVRemaining(200 t, 20 t, 0, 1000) ≈ 95.3 km/s', () => {
    expect(deltaVRemaining(200_000, 20_000, 0, 1000)).toBeCloseTo(95.3, 1);
  });
});

describe('massScale', () => {
  it('massScale(200 t, 20 t, 0) ≈ 0.909', () => {
    const s = massScale(200_000, 20_000, 0);
    expect(s).toBeCloseTo(0.909, 3);
    // Under 10 % loss of response pins the mass constraint.
    expect(1 - s).toBeLessThan(0.1);
  });
});

describe('bad input', () => {
  it('Given NaN, negative or Infinity input, Then no function returns NaN and the tank never goes negative', () => {
    for (const bad of BAD_NUMBERS) {
      expect(Number.isNaN(propellantForImpulse(bad, 200_000, 1, 1000))).toBe(false);
      expect(Number.isNaN(propellantForImpulse(0.2, bad, 1, 1000))).toBe(false);
      expect(Number.isNaN(propellantForImpulse(0.2, 200_000, bad, 1000))).toBe(false);
      expect(Number.isNaN(propellantForImpulse(0.2, 200_000, 1, bad))).toBe(false);

      expect(Number.isNaN(deltaVRemaining(bad, 20_000, 0, 1000))).toBe(false);
      expect(Number.isNaN(deltaVRemaining(200_000, bad, 0, 1000))).toBe(false);
      expect(Number.isNaN(deltaVRemaining(200_000, 20_000, bad, 1000))).toBe(false);
      expect(Number.isNaN(deltaVRemaining(200_000, 20_000, 0, bad))).toBe(false);

      expect(Number.isNaN(massScale(bad, 20_000, 0))).toBe(false);
      expect(Number.isNaN(massScale(200_000, bad, 0))).toBe(false);
      expect(Number.isNaN(massScale(200_000, 20_000, bad))).toBe(false);

      const tank = new Propellant(20_000, 0.6);
      expect(Number.isNaN(tank.consume(bad))).toBe(false);
      expect(Number.isNaN(tank.add(bad))).toBe(false);
      expect(Number.isNaN(tank.massKg)).toBe(false);
      expect(tank.massKg).toBeGreaterThanOrEqual(0);
      expect(tank.massKg).toBeLessThanOrEqual(tank.capacityKg);
      expect(Number.isNaN(tank.fraction)).toBe(false);

      const odd = new Propellant(bad, bad);
      expect(Number.isNaN(odd.massKg)).toBe(false);
      expect(odd.massKg).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(odd.fraction)).toBe(false);
    }

    expect(Number.isNaN(massScale(0, 0, 0))).toBe(false);
    expect(Number.isNaN(deltaVRemaining(0, 0, 0, 1000))).toBe(false);
  });

  it('Given a negative or NaN amount, Then consume and add take nothing and leave the tank untouched', () => {
    const tank = new Propellant(20_000, 0.6);
    for (const bad of [NaN, -5, -Infinity]) {
      expect(tank.consume(bad)).toBe(0);
      expect(tank.add(bad)).toBe(0);
    }
    expect(tank.massKg).toBeCloseTo(12_000, 6);
  });
});
