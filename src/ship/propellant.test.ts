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

describe('propellant — mutation hardening', () => {
  it('Given a fill above 1, Then the tank starts exactly full, never overfull', () => {
    expect(new Propellant(20_000, 5).massKg).toBe(20_000);
  });

  it('Given a capacityLossFrac above 1, Then it is clamped to 1 and the tank holds nothing', () => {
    const tank = new Propellant(20_000, 1);
    tank.capacityLossFrac = 5;
    expect(tank.capacityLossFrac).toBe(1);
    expect(tank.capacityKg).toBe(0);
    expect(tank.massKg).toBe(0);
  });

  it('Given a zero exhaust velocity, Then propellantForImpulse is exactly 0 (no NaN, no Infinity)', () => {
    expect(propellantForImpulse(1, 1000, 1, 0)).toBe(0);
  });

  it('Given extra mass, Then deltaVRemaining counts it in both the empty and the loaded mass', () => {
    // m1 = 1000 + 500, m0 = m1 + 500: 10 · ln(2000/1500)
    expect(deltaVRemaining(1000, 500, 500, 10)).toBeCloseTo(10 * Math.log(2000 / 1500), 12);
  });

  it('Given extra mass, Then massScale is dry / (dry + prop + extra) exactly', () => {
    expect(massScale(1000, 500, 500)).toBe(0.5);
  });
});

describe('v4 save — Propellant snapshot / restore', () => {
  it('Given a full tank at 50 % capacity loss, When snapshot → restore into a fresh tank, Then mass = capacity (loss restored first)', () => {
    const saved = new Propellant(20_000, 1);
    saved.capacityLossFrac = 0.5;
    expect(saved.massKg).toBe(10_000);
    const s = saved.snapshot();
    expect(s).toEqual({ massKg: 10_000, capacityLossFrac: 0.5 });

    const tank = new Propellant(20_000, 0.6);
    tank.restore(s);
    expect(tank.capacityLossFrac).toBe(0.5);
    expect(tank.massKg).toBe(tank.capacityKg);
    expect(tank.massKg).toBe(10_000);
  });

  it('Given a tank that has lost 90 % of its capacity, When a save with 50 % loss and 10 000 kg is restored, Then mass is 10 000 (not clamped to the old capacity)', () => {
    const tank = new Propellant(20_000, 0.1);
    tank.capacityLossFrac = 0.9;
    tank.restore({ massKg: 10_000, capacityLossFrac: 0.5 });
    expect(tank.capacityLossFrac).toBe(0.5);
    expect(tank.massKg).toBe(10_000);
  });

  it('Given a snapshot, Then it is a plain copy: changing the tank afterwards does not change it', () => {
    const tank = new Propellant(20_000, 0.6);
    const s = tank.snapshot();
    tank.consume(1_000);
    expect(s.massKg).toBeCloseTo(12_000, 6);
  });

  it('Given NaN (or another non-finite / negative value) in a save, When restored, Then it is refused by today’s rule: 0, never NaN', () => {
    for (const bad of BAD_NUMBERS) {
      const tank = new Propellant(20_000, 0.6);
      tank.restore({ massKg: bad, capacityLossFrac: bad });
      expect(tank.massKg).toBe(0);
      expect(tank.capacityLossFrac).toBe(0);
      expect(Number.isFinite(tank.fraction)).toBe(true);
    }
  });

  it('Given a mass above the restored capacity, When restored, Then it is clamped to capacity (as the setter does)', () => {
    const tank = new Propellant(20_000, 0.6);
    tank.restore({ massKg: 30_000, capacityLossFrac: 0.25 });
    expect(tank.capacityLossFrac).toBe(0.25);
    expect(tank.massKg).toBe(15_000);
  });

  it('Given a loss above 1, When restored, Then it is clamped to 1 and the tank is empty', () => {
    const tank = new Propellant(20_000, 0.6);
    tank.restore({ massKg: 5_000, capacityLossFrac: 7 });
    expect(tank.capacityLossFrac).toBe(1);
    expect(tank.massKg).toBe(0);
  });
});
