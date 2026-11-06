/**
 * The Yard's orbit camera, as numbers: critically damped, clamped, and
 * stable at any frame time. ARCHITECTURE §6: nothing snaps.
 */

import { describe, expect, it } from 'vitest';
import { Damped, OrbitController, PITCH_LIMIT } from './orbit';

describe('Damped', () => {
  it('Given a target of 1 from 0, When stepped for 2 s at 60 Hz, Then it arrives without ever overshooting', () => {
    const d = new Damped(0, 8);
    d.target = 1;
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      d.step(1 / 60);
      expect(d.value).toBeLessThanOrEqual(1 + 1e-12);
      expect(d.value).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = d.value;
    }
    expect(d.value).toBeCloseTo(1, 3);
  });

  it('Given the same total time, When stepped at 15 Hz or 240 Hz, Then it lands in the same place (frame-rate independent)', () => {
    const a = new Damped(0, 6);
    const b = new Damped(0, 6);
    a.target = b.target = 5;
    for (let i = 0; i < 15; i++) a.step(1 / 15);
    for (let i = 0; i < 240; i++) b.step(1 / 240);
    expect(a.value).toBeCloseTo(b.value, 9);
  });

  it('Given dt = 0, When stepped, Then nothing moves', () => {
    const d = new Damped(2, 8);
    d.target = 9;
    d.step(0);
    expect(d.value).toBe(2);
  });

  it('Given snap(), Then value and target agree and velocity is zero', () => {
    const d = new Damped(0, 8);
    d.target = 1;
    d.step(0.05);
    d.snap(3);
    expect(d.value).toBe(3);
    expect(d.target).toBe(3);
    expect(d.velocity).toBe(0);
  });
});

describe('OrbitController', () => {
  it('Given a drag far upwards, When applied, Then pitch is clamped short of the pole', () => {
    const o = new OrbitController();
    o.drag(0, -100000);
    expect(o.pitch.target).toBeLessThanOrEqual(PITCH_LIMIT);
    o.drag(0, 200000);
    expect(o.pitch.target).toBeGreaterThanOrEqual(-PITCH_LIMIT);
  });

  it('Given distance limits, When zoomed far out or in, Then distance is clamped to them', () => {
    const o = new OrbitController();
    o.setLimits(0.05, 2);
    o.distance.snap(1);
    for (let i = 0; i < 100; i++) o.zoom(1);
    expect(o.distance.target).toBe(2);
    for (let i = 0; i < 200; i++) o.zoom(-1);
    expect(o.distance.target).toBe(0.05);
  });

  it('Given a zoom step, Then it scales the distance multiplicatively (same feel at any ship size)', () => {
    const o = new OrbitController();
    o.setLimits(1e-4, 1e4);
    o.distance.snap(1);
    o.zoom(1);
    const k = o.distance.target;
    o.distance.snap(100);
    o.zoom(1);
    expect(o.distance.target / 100).toBeCloseTo(k, 12);
  });

  it('Given yaw 0 and pitch 0, When the eye is computed, Then it sits on +Z at the orbit distance from the centre', () => {
    const o = new OrbitController();
    o.setLimits(0.01, 10);
    o.centre[0].snap(1);
    o.yaw.snap(0);
    o.pitch.snap(0);
    o.distance.snap(2);
    const out = { x: 0, y: 0, z: 0 };
    o.eye(out);
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(2, 12);
  });

  it('Given a direction, When aimed along it, Then yaw/pitch reproduce that direction', () => {
    const o = new OrbitController();
    o.setLimits(0.01, 10);
    const dir = { x: 0.66, y: 0.28, z: 0.7 };
    o.lookFrom(dir.x, dir.y, dir.z, true);
    o.distance.snap(1);
    const out = { x: 0, y: 0, z: 0 };
    o.eye(out);
    const n = Math.hypot(dir.x, dir.y, dir.z);
    expect(out.x).toBeCloseTo(dir.x / n, 9);
    expect(out.y).toBeCloseTo(dir.y / n, 9);
    expect(out.z).toBeCloseTo(dir.z / n, 9);
  });

  it('Given yaw 3 rad and a target of -3 rad, When aimed, Then it takes the short way round', () => {
    const o = new OrbitController();
    o.yaw.snap(3);
    o.lookFrom(Math.sin(-3), 0, Math.cos(-3), false);
    expect(Math.abs(o.yaw.target - o.yaw.value)).toBeLessThan(Math.PI);
  });
});
