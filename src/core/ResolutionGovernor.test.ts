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

/** Feed exactly `n` frames of a fixed interval; return how many changes. */
function feedN(g: ResolutionGovernor, frameMs: number, n: number): number {
  let changes = 0;
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
    // Knock it down ONCE, to a scale with room both ways. (Knocking it to the
    // floor made this vacuous: a governor at minScale cannot drop further.)
    expect(feedN(g, 21, 24)).toBe(1); // 504 ms at 21 ms → one drop, ≈ 0.89
    const held = g.scale;
    expect(held).toBeLessThan(1);
    expect(held).toBeGreaterThan(GOVERNOR_DEFAULTS.minScale);
    const between = GOVERNOR_DEFAULTS.targetMs * 1.12;
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

  // --- review-p0: cases the first suite let through --------------------------

  it('Given sustained 400 ms frames (a GPU on its knees), When ten seconds pass, Then the scale drops to its floor', () => {
    // Every sample is over spikeMs. v2.0 discarded each as a "hitch", so the
    // slowest machines — the ones the governor exists for — kept full scale.
    const g = new ResolutionGovernor();
    feed(g, 400, 10);
    expect(g.scale).toBeCloseTo(GOVERNOR_DEFAULTS.minScale, 6);
  });

  it('Given two back-to-back 500 ms hitches in a steady 60 fps run, Then both are ignored', () => {
    const g = new ResolutionGovernor();
    feed(g, 1000 / 60, 2);
    expect(g.sample(500)).toBe(false);
    expect(g.sample(500)).toBe(false);
    expect(feed(g, 1000 / 60, 2)).toBe(0);
    expect(g.scale).toBe(1);
  });

  it('Given one window of catastrophic 200 ms frames, Then the single drop is clamped to maxDownStep', () => {
    const g = new ResolutionGovernor();
    expect(feedN(g, 200, 3)).toBe(1); // 600 ms: exactly one window
    expect(g.scale).toBeCloseTo(1 - GOVERNOR_DEFAULTS.maxDownStep, 9);
  });

  it('Given it just dropped, When frames are fast, Then it rises only once upCooldownMs of wall time has passed', () => {
    const g = new ResolutionGovernor();
    expect(feedN(g, 60, 9)).toBe(1); // 540 ms → one drop, window now empty
    const dropped = g.scale;
    // Just short of the cooldown: several full windows of fast frames, no rise.
    feedN(g, 10, (GOVERNOR_DEFAULTS.upCooldownMs - 10) / 10);
    expect(g.scale).toBe(dropped);
    // One more window crosses it — counted in milliseconds, not in frames.
    feedN(g, 10, GOVERNOR_DEFAULTS.windowMs / 10);
    expect(g.scale).toBeGreaterThan(dropped);
  });

  it('Given it is at its floor, When frames are fast, Then it climbs back in small equal steps, never a jump', () => {
    const g = new ResolutionGovernor();
    feed(g, 200, 60);
    let prev = g.scale;
    let rises = 0;
    for (let i = 0; i < 6000; i++) {
      if (g.sample(10)) {
        expect(g.scale - prev).toBeCloseTo(GOVERNOR_DEFAULTS.upStep, 9);
        prev = g.scale;
        rises++;
      }
    }
    expect(g.scale).toBe(1);
    // A rise reallocates every post target and risks re-entering the load that
    // caused the drop; floor to full must be a walk, not a leap.
    expect(rises).toBeGreaterThanOrEqual(5);
  });

  it('Given frames exactly at the down threshold, Then it holds (the threshold is exclusive)', () => {
    // At the defaults this is a 50 Hz display: 20 ms is exactly 1.2 × 16.67.
    const g = new ResolutionGovernor();
    expect(feed(g, 20, 10)).toBe(0);
    expect(g.scale).toBe(1);
  });

  it('Given zero-length intervals among slow frames (two rAFs, one timestamp), Then they do not dilute the average', () => {
    const g = new ResolutionGovernor();
    for (let i = 0; i < 60; i++) {
      g.sample(40);
      g.sample(0);
      g.sample(0);
    }
    expect(g.scale).toBeLessThan(1);
  });

  it('Given three lone hitches seconds apart in a steady 60 fps run, Then none counts (a run must be consecutive)', () => {
    const g = new ResolutionGovernor();
    for (let k = 0; k < 3; k++) {
      feed(g, 1000 / 60, 2);
      expect(g.sample(500)).toBe(false);
    }
    expect(feed(g, 1000 / 60, 2)).toBe(0);
    expect(g.scale).toBe(1);
  });

  // --- refresh-capped displays (review-p0 #6) ------------------------------
  // At 30 Hz (Energy Saver, some TVs) every frame is 33 ms whatever the GPU
  // does. Pixels are not the bottleneck; dropping them buys nothing, and v2.0
  // drove the scale to its floor and kept it there.

  it('Given a display capped at 30 Hz with an idle GPU, Then the scale drops at most once and then holds', () => {
    const g = new ResolutionGovernor();
    feed(g, 1000 / 30, 30);
    expect(g.scale).toBeGreaterThanOrEqual(1 - GOVERNOR_DEFAULTS.maxDownStep - 1e-9);
  });

  it('Given a drop that did help, Then a further drop is still allowed under heavier load', () => {
    const g = new ResolutionGovernor();
    feed(g, 60, 1); // drops
    const first = g.scale;
    // [v3-T1] steps are ≥ 2 s apart now (governorHysteresis.test.ts).
    feed(g, 45, 2.5); // improved (60 → 45) but still slow: keep going
    expect(g.scale).toBeLessThan(first);
  });
});
