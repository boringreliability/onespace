/**
 * [v3-T1] The motion-blur "jumped" test is a speed, not a distance per frame.
 */

import { describe, expect, it } from 'vitest';
import { MOTION_JUMP_SPEED_KMS, motionJumped } from './motionJump';

describe('motionJumped', () => {
  it('Given 60 fps, Then it matches v2’s 25 km threshold (20 km is motion, 30 km is a cut)', () => {
    expect(motionJumped(20, 1 / 60)).toBe(false);
    expect(motionJumped(30, 1 / 60)).toBe(true);
  });

  it('Given 30 fps, When the camera moves at 1,200 km/s (40 km a frame), Then it is still motion', () => {
    expect(motionJumped(40, 1 / 30)).toBe(false);
  });

  it('Given 144 fps, When the camera moves 15 km in one frame (2,160 km/s), Then it is a cut', () => {
    expect(motionJumped(15, 1 / 144)).toBe(true);
  });

  it('Given the same speed at different frame rates, Then the verdict is the same', () => {
    for (const speed of [500, 1400, 1600, 5000]) {
      const v = motionJumped(speed / 60, 1 / 60);
      for (const fps of [30, 45, 90, 120, 144, 200]) expect(motionJumped(speed / fps, 1 / fps)).toBe(v);
    }
  });

  it('Given a zero-dt frame (photo mode), When the camera has not moved, Then it is not a cut; When it moved 10 km, Then it is', () => {
    expect(motionJumped(0, 0)).toBe(false);
    expect(motionJumped(10, 0)).toBe(true);
  });

  it('Given the default, Then it is 1,500 km/s', () => {
    expect(MOTION_JUMP_SPEED_KMS).toBe(1500);
  });
});
