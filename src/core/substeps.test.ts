/**
 * [v3-T1] No lost time (docs/v3/PLAN.md §1 mechanism 1, phase A1).
 *
 * The engine clamped dt at 1/15 s and the flight model clamped its
 * accumulator at 8 × 1/120 s — equal, so it looked safe. But the accumulator
 * also carries up to one substep from the previous frame, and every frame of
 * 58-67 ms threw up to 8.3 ms of ship time away while the world and the
 * camera advanced the full frame. Measured: the ship popped 230-1,400 px at
 * each of 7 hitches during a realtime landing.
 */

import { describe, expect, it } from 'vitest';
import { ENGINE_MAX_DT, FIXED_H, MAX_SUBSTEPS, substepBudget } from './substeps';

describe('substepBudget', () => {
  it('Given an empty accumulator and a 60 fps frame, When budgeted, Then it takes two substeps and carries nothing', () => {
    const b = substepBudget(0, 1 / 60, FIXED_H, MAX_SUBSTEPS);
    expect(b.steps).toBe(2);
    expect(b.carry).toBeCloseTo(0, 12);
    expect(b.dropped).toBe(0);
  });

  it('Given 8 ms already carried, When a clamped 66.7 ms hitch arrives, Then nothing is dropped (the v2 bug)', () => {
    const b = substepBudget(0.008, ENGINE_MAX_DT, FIXED_H, MAX_SUBSTEPS);
    expect(b.dropped).toBe(0);
    expect(b.steps * FIXED_H + b.carry).toBeCloseTo(0.008 + ENGINE_MAX_DT, 12);
  });

  it('Given any carry below one substep and any dt the engine can produce, Then dropped is exactly 0 and the carry stays below one substep', () => {
    for (let i = 0; i <= 40; i++) {
      const acc = (i / 40) * FIXED_H * (1 - 1e-9);
      for (let j = 0; j <= 200; j++) {
        const dt = (j / 200) * ENGINE_MAX_DT;
        const b = substepBudget(acc, dt, FIXED_H, MAX_SUBSTEPS);
        expect(b.dropped).toBe(0);
        expect(b.carry).toBeGreaterThanOrEqual(0);
        expect(b.carry).toBeLessThan(FIXED_H);
        expect(b.steps).toBeLessThanOrEqual(MAX_SUBSTEPS);
      }
    }
  });

  it('Given the shared constants, Then the engine clamp plus one carried substep fits inside the substep ceiling', () => {
    expect(ENGINE_MAX_DT + FIXED_H).toBeLessThanOrEqual(MAX_SUBSTEPS * FIXED_H + 1e-12);
  });

  it('Given any budget, Then time is conserved: steps·h + carry + dropped = acc + dt', () => {
    for (const [acc, dt] of [
      [0, 0],
      [0.004, 0.016],
      [0.0083, 0.0667],
      [0.001, 2],
      [0.005, 0.25],
    ] as const) {
      const b = substepBudget(acc, dt, FIXED_H, MAX_SUBSTEPS);
      expect(b.steps * FIXED_H + b.carry + b.dropped).toBeCloseTo(acc + dt, 12);
    }
  });

  it('Given a 2 s stall (not reachable through the engine), When budgeted, Then it takes the ceiling of substeps and drops the rest instead of spiralling', () => {
    const b = substepBudget(0, 2, FIXED_H, MAX_SUBSTEPS);
    expect(b.steps).toBe(MAX_SUBSTEPS);
    expect(b.carry).toBeLessThan(FIXED_H);
    expect(b.dropped).toBeGreaterThan(1.8);
  });

  it('Given a negative or NaN dt, When budgeted, Then it takes no step and keeps the carry', () => {
    for (const dt of [-0.01, Number.NaN]) {
      const b = substepBudget(0.004, dt, FIXED_H, MAX_SUBSTEPS);
      expect(b.steps).toBe(0);
      expect(b.carry).toBeCloseTo(0.004, 12);
      expect(b.dropped).toBe(0);
    }
  });

  it('Given an out object, When budgeted, Then it is written and returned (no allocation per frame)', () => {
    const out = { steps: -1, carry: -1, dropped: -1 };
    expect(substepBudget(0, 1 / 60, FIXED_H, MAX_SUBSTEPS, out)).toBe(out);
    expect(out.steps).toBe(2);
  });
});
