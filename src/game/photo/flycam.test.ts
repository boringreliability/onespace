/**
 * Photo mode's free camera and grade controls — the pure parts.
 */

import { describe, expect, it } from 'vitest';
import {
  FLYCAM_DEFAULTS,
  clampGrade,
  createFlyCam,
  stepFlyCam,
  type FlyCamInput,
} from './flycam';

const idle: FlyCamInput = { move: [0, 0, 0], lookDx: 0, lookDy: 0, zoom: 0, fast: false };

describe('stepFlyCam', () => {
  it('Given no input, Then the camera does not move', () => {
    const c = createFlyCam([1, 2, 3], 0.5, 0.1, 40);
    stepFlyCam(c, idle, 1);
    expect(c.position).toEqual([1, 2, 3]);
    expect(c.yaw).toBe(0.5);
    expect(c.pitch).toBe(0.1);
  });

  it('Given held forward input, Then it eases up to speed rather than snapping', () => {
    const c = createFlyCam([0, 0, 0], 0, 0, 40);
    stepFlyCam(c, { ...idle, move: [0, 0, -1] }, 1 / 60);
    const first = Math.hypot(...c.position);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan((FLYCAM_DEFAULTS.speedKmS * 1) / 60);
  });

  it('Given forward input at yaw 0, Then it moves along −Z (three.js forward)', () => {
    const c = createFlyCam([0, 0, 0], 0, 0, 40);
    for (let i = 0; i < 120; i++) stepFlyCam(c, { ...idle, move: [0, 0, -1] }, 1 / 60);
    expect(c.position[2]).toBeLessThan(0);
    expect(Math.abs(c.position[0])).toBeLessThan(1e-9);
  });

  it('Given the same input at 30 and 144 Hz over one second, Then it ends within 5 % of the same place', () => {
    const run = (hz: number) => {
      const c = createFlyCam([0, 0, 0], 0, 0, 40);
      for (let i = 0; i < hz; i++) stepFlyCam(c, { ...idle, move: [1, 0, 0] }, 1 / hz);
      return c.position[0];
    };
    const a = run(30);
    const b = run(144);
    expect(Math.abs(a - b) / Math.abs(b)).toBeLessThan(0.05);
  });

  it('Given fast held, Then it travels further', () => {
    const go = (fast: boolean) => {
      const c = createFlyCam([0, 0, 0], 0, 0, 40);
      for (let i = 0; i < 60; i++) stepFlyCam(c, { ...idle, move: [1, 0, 0], fast }, 1 / 60);
      return c.position[0];
    };
    expect(go(true)).toBeGreaterThan(go(false) * 3);
  });

  it('Given a huge upward look, Then pitch is clamped short of the pole (no gimbal flip)', () => {
    const c = createFlyCam([0, 0, 0], 0, 0, 40);
    stepFlyCam(c, { ...idle, lookDy: -1e6 }, 1 / 60);
    expect(c.pitch).toBeLessThan(Math.PI / 2);
    expect(c.pitch).toBeGreaterThan(Math.PI / 2 - 0.1);
  });

  it('Given zoom input, Then fov changes and stays within its bounds', () => {
    const c = createFlyCam([0, 0, 0], 0, 0, 40);
    stepFlyCam(c, { ...idle, zoom: 1e6 }, 1 / 60);
    expect(c.fov).toBe(FLYCAM_DEFAULTS.maxFov);
    stepFlyCam(c, { ...idle, zoom: -1e6 }, 1 / 60);
    expect(c.fov).toBe(FLYCAM_DEFAULTS.minFov);
  });

  it('Given garbage dt (NaN, negative), Then nothing changes', () => {
    const c = createFlyCam([1, 1, 1], 0, 0, 40);
    stepFlyCam(c, { ...idle, move: [1, 1, 1] }, NaN);
    stepFlyCam(c, { ...idle, move: [1, 1, 1] }, -1);
    expect(c.position).toEqual([1, 1, 1]);
  });
});

describe('clampGrade', () => {
  it('Given values in range, Then they pass through', () => {
    expect(clampGrade({ exposure: 1.2, grain: 0.05, ca: 0.004, vignette: 0.5 })).toEqual({
      exposure: 1.2,
      grain: 0.05,
      ca: 0.004,
      vignette: 0.5,
    });
  });

  it('Given out-of-range or non-finite values, Then they are clamped or dropped to safe ones', () => {
    const g = clampGrade({ exposure: 99, grain: -1, ca: NaN, vignette: 7 });
    expect(g.exposure).toBeLessThanOrEqual(4);
    expect(g.grain).toBe(0);
    expect(g.ca).toBeUndefined();
    expect(g.vignette).toBeLessThanOrEqual(1);
  });

  it('Given grain at zero, Then it is allowed — but only photo mode may ask for it', () => {
    // ARCHITECTURE §6 says grain is always on in play. Photo mode is the one
    // place a player may take it off, so the clamp allows 0.
    expect(clampGrade({ grain: 0 }).grain).toBe(0);
  });
});
