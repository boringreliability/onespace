/**
 * Renderer streaming — which bodies get full geometry.
 *
 * v1 used one threshold (60 radii) for both acquire and release. A ship
 * parked near the boundary built and destroyed a planet renderer — shaders,
 * quadtree, cloud shell — every time it crossed, and each build is a
 * 140-740 ms compile hitch. Acquire and release are now two thresholds.
 */

import { describe, expect, it } from 'vitest';
import {
  STREAM_ACQUIRE_RADII,
  STREAM_RELEASE_RADII,
  planStreaming,
  type StreamCandidate,
} from './streaming';

const R = 6000;
const at = (radii: number, streamed = false): StreamCandidate => ({
  distanceKm: radii * R,
  radiusKm: R,
  streamed,
});

describe('planStreaming', () => {
  it('Given the thresholds, Then release is meaningfully further out than acquire', () => {
    expect(STREAM_RELEASE_RADII).toBeGreaterThan(STREAM_ACQUIRE_RADII * 1.1);
  });

  it('Given a body inside the acquire distance, Then it is wanted', () => {
    expect(planStreaming([at(STREAM_ACQUIRE_RADII * 0.98)], 4)).toEqual([true]);
  });

  it('Given an unstreamed body between the thresholds, Then it is not acquired', () => {
    const mid = (STREAM_ACQUIRE_RADII + STREAM_RELEASE_RADII) / 2;
    expect(planStreaming([at(mid, false)], 4)).toEqual([false]);
  });

  it('Given a streamed body between the thresholds, Then it is kept', () => {
    const mid = (STREAM_ACQUIRE_RADII + STREAM_RELEASE_RADII) / 2;
    expect(planStreaming([at(mid, true)], 4)).toEqual([true]);
  });

  it('Given a streamed body beyond the release distance, Then it is released', () => {
    expect(planStreaming([at(STREAM_RELEASE_RADII * 1.02, true)], 4)).toEqual([false]);
  });

  it('Given more eligible bodies than the budget, Then only the closest are wanted', () => {
    const bodies = [at(30), at(5), at(50), at(10), at(20)];
    expect(planStreaming(bodies, 3)).toEqual([false, true, false, true, true]);
  });

  it('Given a ship oscillating across the acquire boundary, Then the body is built once and never churned', () => {
    let streamed = false;
    let builds = 0;
    let releases = 0;
    for (let i = 0; i < 200; i++) {
      const radii = STREAM_ACQUIRE_RADII * (i % 2 === 0 ? 0.99 : 1.01);
      const [want] = planStreaming([at(radii, streamed)], 4);
      if (want && !streamed) builds++;
      if (!want && streamed) releases++;
      streamed = want!;
    }
    expect(builds).toBe(1);
    expect(releases).toBe(0);
  });

  it('Given different sizes, Then thresholds are in each body\'s own radii', () => {
    const moon: StreamCandidate = { distanceKm: 50 * 1000, radiusKm: 1000, streamed: false };
    const giant: StreamCandidate = { distanceKm: 50 * 1000, radiusKm: 70000, streamed: false };
    // 50 moon radii is inside; 50 000 km is under one giant radius — also inside.
    expect(planStreaming([moon, giant], 4)).toEqual([true, true]);
    const farMoon: StreamCandidate = { distanceKm: 100 * 1000, radiusKm: 1000, streamed: false };
    expect(planStreaming([farMoon], 4)).toEqual([false]);
  });

  it('Given an empty list or a zero budget, Then nothing is wanted and nothing throws', () => {
    expect(planStreaming([], 4)).toEqual([]);
    expect(planStreaming([at(1)], 0)).toEqual([false]);
  });

  // --- review-p0 ------------------------------------------------------------

  it('Given an unstreamed body exactly at the acquire distance, Then it is not acquired (inside means strictly inside)', () => {
    expect(planStreaming([at(STREAM_ACQUIRE_RADII)], 4)).toEqual([false]);
  });

  it('Given a streamed body exactly at the release distance, Then it is released', () => {
    expect(planStreaming([at(STREAM_RELEASE_RADII, true)], 4)).toEqual([false]);
  });

  it('Given an output array from last frame, Then it is reused and fully overwritten (no allocation per frame, ARCHITECTURE §5)', () => {
    const out = [true, true, true, true];
    const res = planStreaming([at(80), at(10)], 4, out);
    expect(res).toBe(out);
    expect(res).toEqual([false, true]);
  });

  it('Given equally distant bodies over budget, Then the earlier one wins (stable, so the choice does not flicker)', () => {
    expect(planStreaming([at(20), at(20), at(20)], 2)).toEqual([true, true, false]);
  });
});

