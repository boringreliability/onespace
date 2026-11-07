/**
 * Sky backdrop cubemap — when to bake, and when to throw the bake away.
 *
 * The backdrop is a 40-step line-of-sight integral plus five fBm per pixel,
 * and it depends on nothing but the galaxy (PERFORMANCE.md: 7 % of every
 * frame, for a picture that never changes). Phase 3 bakes it into a cubemap,
 * one face per frame so the bake itself never becomes the hitch, and samples
 * it thereafter. These tests pin the schedule: six faces, in order, then
 * done; a new galaxy restarts it; the same galaxy does not.
 */

import { describe, expect, it } from 'vitest';
import { SkyBakeSchedule } from './skyBake';

describe('SkyBakeSchedule', () => {
  it('Given a fresh schedule, Then nothing is ready and there is no face to bake until a key is set', () => {
    const s = new SkyBakeSchedule();
    expect(s.ready).toBe(false);
    expect(s.nextFace()).toBe(-1);
  });

  it('Given a key, When ticked, Then faces 0..5 come out one per call and it is ready after the sixth', () => {
    const s = new SkyBakeSchedule();
    s.invalidate('galaxy-a');
    const faces: number[] = [];
    for (let i = 0; i < 6; i++) {
      expect(s.ready).toBe(false);
      const f = s.nextFace();
      faces.push(f);
      s.faceDone(f);
    }
    expect(faces).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.ready).toBe(true);
    expect(s.nextFace()).toBe(-1);
  });

  it('Given a completed bake, When invalidated with the same key, Then nothing is rebaked', () => {
    const s = new SkyBakeSchedule();
    s.invalidate('galaxy-a');
    for (let i = 0; i < 6; i++) s.faceDone(s.nextFace());
    expect(s.invalidate('galaxy-a')).toBe(false);
    expect(s.ready).toBe(true);
    expect(s.nextFace()).toBe(-1);
  });

  it('Given a completed bake, When the galaxy changes, Then it is no longer ready and restarts at face 0', () => {
    const s = new SkyBakeSchedule();
    s.invalidate('galaxy-a');
    for (let i = 0; i < 6; i++) s.faceDone(s.nextFace());
    expect(s.invalidate('galaxy-b')).toBe(true);
    expect(s.ready).toBe(false);
    expect(s.nextFace()).toBe(0);
  });

  it('Given a bake half done, When the galaxy changes, Then the stale faces are not counted', () => {
    const s = new SkyBakeSchedule();
    s.invalidate('galaxy-a');
    for (let i = 0; i < 3; i++) s.faceDone(s.nextFace());
    s.invalidate('galaxy-b');
    let n = 0;
    while (!s.ready) {
      s.faceDone(s.nextFace());
      n++;
      if (n > 10) break;
    }
    expect(n).toBe(6);
  });

  it('Given faceDone for a face that is not the pending one, Then it is ignored', () => {
    const s = new SkyBakeSchedule();
    s.invalidate('galaxy-a');
    s.faceDone(3);
    expect(s.nextFace()).toBe(0);
  });

  it('Given a forced reset (context loss), Then the same key bakes again', () => {
    const s = new SkyBakeSchedule();
    s.invalidate('galaxy-a');
    for (let i = 0; i < 6; i++) s.faceDone(s.nextFace());
    s.reset();
    expect(s.ready).toBe(false);
    expect(s.nextFace()).toBe(0);
  });

  it('Given no key was ever set, When faces are reported done, Then the bake is still not ready', () => {
    const s = new SkyBakeSchedule();
    for (let f = 0; f < 6; f++) s.faceDone(f);
    expect(s.ready).toBe(false);
  });
});
