/**
 * FA-ON across an SOI boundary (review-p1a finding M1).
 *
 * The hold target is relative to the parent. Crossing into a new SOI changes
 * that reference by the parent's orbital velocity — up to ~49 km/s — so the
 * computer would suddenly burn for minutes to re-null a speed the pilot never
 * asked to change. After a rebase the assist latches to coast until the pilot
 * moves the lever.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { DEFAULT_SHIP_CONFIG, FlightModel } from './FlightModel';

const H = 1 / 120;
function run(fm: FlightModel, seconds: number): void {
  for (let i = 0, n = Math.round(seconds / H); i < n; i++) fm.update(H);
}

function holding(): FlightModel {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.flightAssist = true;
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
  fm.teleport(new Vector3(0, 0, 0), new Vector3(0, 0, 0), new Quaternion());
  fm.command.throttle = 0.5;
  run(fm, 1);
  return fm;
}

/** A new parent moving at 30 km/s relative to the old one. */
const moving = () => ({ position: new Vector3(1e9, 0, 0), velocity: new Vector3(30, 0, 0), mu: 0 });

describe('FA-ON across an SOI rebase', () => {
  it('Given FA-ON holding speed, When the ship rebases to a new parent, Then the assist coasts instead of burning', () => {
    const fm = holding();
    expect(fm.assistState).toBe('hold');
    fm.rebase(moving());
    const v0 = fm.velocity.clone();
    run(fm, 2);
    expect(fm.assistState).toBe('coast');
    expect(fm.velocity.distanceTo(v0)).toBeLessThan(1e-9); // no thrust at all (mu 0)
  });

  it('Given the latch, When the pilot moves the lever, Then the hold resumes against the new parent', () => {
    const fm = holding();
    fm.rebase(moving());
    run(fm, 0.5);
    fm.command.throttle = 0.6;
    run(fm, 0.1);
    expect(fm.assistState).toBe('hold');
  });

  it('Given the latch, When the pilot brakes, Then the active stop still works', () => {
    const fm = holding();
    fm.rebase(moving());
    fm.command.brake = true;
    run(fm, 0.1);
    expect(fm.assistState).toBe('stop');
  });

  it('Given FA-OFF, When rebasing, Then nothing about the Newtonian throttle changes', () => {
    const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
    fm.flightAssist = false;
    fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 0 });
    fm.teleport(new Vector3(), new Vector3(), new Quaternion());
    fm.command.throttle = 0.5;
    run(fm, 1);
    // A parent at rest relative to the old one: the speed limiter stays out
    // of it, so any change in thrust would be the rebase's doing.
    fm.rebase({ position: new Vector3(1e9, 0, 0), velocity: new Vector3(), mu: 0 });
    const s0 = fm.velocity.length();
    run(fm, 1);
    expect(fm.velocity.length()).not.toBeCloseTo(s0, 3); // still thrusting
  });
});
