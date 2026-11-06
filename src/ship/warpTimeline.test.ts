/**
 * The chart's "JUMP EST" and the jump itself must be the same number.
 *
 * The chart used to promise 22 s + 41 s/ly — about a minute for a short hop —
 * and the warp then took 7.4 s, every time, whatever the distance. An estimate
 * that disagrees with the event by a factor of eight is not an estimate. Both
 * now read one timeline.
 */

import { describe, expect, it } from 'vitest';

import { WARP_TIMELINE, WARP_TOTAL_SECONDS, jumpEstimateSeconds } from './warpTimeline';

describe('warp timeline', () => {
  it('Given the warp beats, Then the total is their sum (charge + flash + tunnel + arrive + tail)', () => {
    const t = WARP_TIMELINE;
    expect(WARP_TOTAL_SECONDS).toBeCloseTo(t.charge + t.flash + t.tunnel + t.arrive + t.tail, 12);
  });

  it('Given the current tuning, Then a jump lasts 7.4 s (the measured duration)', () => {
    expect(WARP_TOTAL_SECONDS).toBeCloseTo(7.4, 9);
  });

  it('Given the beats, Then the world swap lands after the tunnel and before the tail', () => {
    const t = WARP_TIMELINE;
    expect(t.arriveAt).toBeCloseTo(t.charge + t.flash + t.tunnel, 12);
    expect(t.arriveAt).toBeLessThan(WARP_TOTAL_SECONDS);
  });
});

describe('jumpEstimateSeconds — what the chart shows', () => {
  it('Given any jump distance, When the chart estimates it, Then it equals the warp duration', () => {
    for (const ly of [0.5, 4.2, 40, 139]) {
      expect(jumpEstimateSeconds(ly)).toBeCloseTo(WARP_TOTAL_SECONDS, 9);
    }
  });

  it('Given the old formula (22 s + 41 s/ly), Then the estimate no longer uses it', () => {
    expect(jumpEstimateSeconds(10)).not.toBeCloseTo(22 + 41 * 10, 0);
  });

  it('Given a nonsense distance (negative, NaN), Then the estimate is still the warp duration, never NaN', () => {
    expect(jumpEstimateSeconds(-3)).toBeCloseTo(WARP_TOTAL_SECONDS, 9);
    expect(jumpEstimateSeconds(Number.NaN)).toBeCloseTo(WARP_TOTAL_SECONDS, 9);
  });
});
