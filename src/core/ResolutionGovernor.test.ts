/**
 * The resolution governor.
 *
 * v1 timed `performance.now()` around `step()`, which measures the CPU and the
 * command submission — never the GPU, which runs asynchronously after it. On a
 * GPU-bound frame of 112 ms it read 1-3 ms and held the scale at 1.0 forever.
 *
 * The governor is fed the WALL-CLOCK interval between frames, which is the
 * only number that includes the GPU. It is pure so it can be tested here.
 */

import { describe, expect, it } from 'vitest';
import { GOVERNOR_DEFAULTS, ResolutionGovernor } from './ResolutionGovernor';

/** Feed `seconds` of frames of a fixed interval; return how many changes. */
function feed(g: ResolutionGovernor, frameMs: number, seconds: number): number {
  let changes = 0;
  const n = Math.ceil((seconds * 1000) / frameMs);
  for (let i = 0; i < n; i++) if (g.sample(frameMs)) changes++;
  return changes;
}

describe('ResolutionGovernor', () => {
  it('Given sustained 40 ms frames, When one second passes, Then the scale drops below 1', () => {
    const g = new ResolutionGovernor();
    feed(g, 40, 1);
    expect(g.scale).toBeLessThan(1);
  });

  it('Given 200 ms frames for a minute, Then the scale never goes below its floor', () => {
    const g = new ResolutionGovernor();
    feed(g, 200, 60);
    expect(g.scale).toBeGreaterThanOrEqual(GOVERNOR_DEFAULTS.minScale);
    expect(g.scale).toBeCloseTo(GOVERNOR_DEFAULTS.minScale, 6);
  });

  it('Given steady 60 fps at full scale, Then it never reports a change', () => {
    const g = new ResolutionGovernor();
    expect(feed(g, 1000 / 60, 30)).toBe(0);
    expect(g.scale).toBe(1);
  });

  it('Given it has dropped, When frames recover to 10 ms, Then it climbs back to exactly 1 and no further', () => {
    const g = new ResolutionGovernor();
    feed(g, 60, 3);
    expect(g.scale).toBeLessThan(0.9);
    feed(g, 10, 120);
    expect(g.scale).toBe(1);
  });

  it('Given a lone 500 ms hitch in a steady 60 fps run (tab switch, GC), Then it is ignored', () => {
    const g = new ResolutionGovernor();
    feed(g, 1000 / 60, 2);
    expect(g.sample(500)).toBe(false);
    expect(feed(g, 1000 / 60, 2)).toBe(0);
    expect(g.scale).toBe(1);
  });

  it('Given sustained slow frames, Then it changes at most once per window (every resize reallocates targets)', () => {
    const g = new ResolutionGovernor();
    const changes = feed(g, 40, 5);
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThanOrEqual(Math.ceil(5000 / GOVERNOR_DEFAULTS.windowMs));
  });

  it('Given frames between the up and down thresholds, Then it holds still (no flapping)', () => {
    const g = new ResolutionGovernor();
    feed(g, 60, 2); // knock it down first
    const between = GOVERNOR_DEFAULTS.targetMs * 1.12;
    feed(g, between, 1); // flush the partial window still holding 60 ms frames
    const held = g.scale;
    expect(feed(g, between, 20)).toBe(0);
    expect(g.scale).toBe(held);
  });

  it('Given it just dropped, When frames are immediately fast, Then it waits out the up-cooldown before rising', () => {
    const g = new ResolutionGovernor();
    feed(g, 60, 1);
    const dropped = g.scale;
    expect(dropped).toBeLessThan(1);
    feed(g, 10, (GOVERNOR_DEFAULTS.upCooldownMs * 0.5) / 1000);
    // The partial window may still carry slow frames and drop once more;
    // what must not happen is a rise.
    expect(g.scale).toBeLessThanOrEqual(dropped);
  });

  it('Given heavier load, Then it drops further than under lighter load (proportional, not fixed)', () => {
    const light = new ResolutionGovernor();
    const heavy = new ResolutionGovernor();
    feed(light, 21, 0.6); // ideal ≈ 0.89 — under the max step
    feed(heavy, 100, 0.6);
    expect(heavy.scale).toBeLessThan(light.scale);
  });

  it('Given garbage samples (NaN, negative, zero), Then they are ignored', () => {
    const g = new ResolutionGovernor();
    for (const bad of [NaN, -5, 0, Infinity]) expect(g.sample(bad)).toBe(false);
    expect(g.scale).toBe(1);
  });
});
