/**
 * [v3-T1] Shake is band-limited to what the frame rate can show (phase A8).
 */

import { describe, expect, it } from 'vitest';
import { SHAKE_MAX_HZ, SHAKE_OCTAVES, shakeNoise, shakeOctaveGain } from './cameraShake';

describe('shake octaves', () => {
  it('Given the octave table, Then there are at least two octaves and none is above 25 Hz', () => {
    expect(SHAKE_OCTAVES.length).toBeGreaterThanOrEqual(2);
    for (const o of SHAKE_OCTAVES) expect(o.hz).toBeLessThanOrEqual(SHAKE_MAX_HZ);
    expect(SHAKE_MAX_HZ).toBe(25);
  });

  it('Given the octave frequencies, Then no two are in an integer ratio (no audible beat / visible loop)', () => {
    for (let i = 0; i < SHAKE_OCTAVES.length; i++) {
      for (let j = i + 1; j < SHAKE_OCTAVES.length; j++) {
        const r = SHAKE_OCTAVES[j]!.hz / SHAKE_OCTAVES[i]!.hz;
        expect(Math.abs(r - Math.round(r))).toBeGreaterThan(0.05);
      }
    }
  });

  it('Given 60 fps, Then octaves above 24 Hz (0.4 × 60) are silent and those below 18 Hz are at full gain', () => {
    expect(shakeOctaveGain(24.5, 60)).toBe(0);
    expect(shakeOctaveGain(17.9, 60)).toBe(1);
  });

  it('Given 30 fps, Then nothing above 12 Hz is shaken', () => {
    for (const o of SHAKE_OCTAVES) if (o.hz >= 12) expect(shakeOctaveGain(o.hz, 30)).toBe(0);
  });

  it('Given 240 fps, Then the 25 Hz ceiling still holds', () => {
    expect(shakeOctaveGain(25.5, 240)).toBe(0);
  });

  it('Given a frequency sweep, Then the gain falls monotonically from 1 to 0', () => {
    let prev = 1;
    for (let hz = 0; hz <= 30; hz += 0.25) {
      const g = shakeOctaveGain(hz, 60);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      expect(g).toBeGreaterThanOrEqual(0);
      prev = g;
    }
  });
});

describe('shakeNoise', () => {
  it('Given any time and channel, Then it stays within -1..1 and is not constant', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 5000; i++) {
      const n = shakeNoise(i * 0.0037, 3, 60);
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.3);
  });

  it('Given a 60 fps sample stream, Then frame-to-frame change is bounded (no per-frame buzz)', () => {
    // A 24 Hz-limited signal of unit amplitude cannot move more than about
    // 2π·24/60 ≈ 2.5 per frame; v2's 51 Hz octave aliased into jumps.
    let worst = 0;
    let prev = shakeNoise(0, 1, 60);
    for (let i = 1; i < 6000; i++) {
      const n = shakeNoise(i / 60, 1, 60);
      worst = Math.max(worst, Math.abs(n - prev));
      prev = n;
    }
    expect(worst).toBeLessThan(0.8);
  });

  it('Given different channels, Then they are decorrelated', () => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < 4000; i++) {
      const a = shakeNoise(i / 60, 1, 60);
      const b = shakeNoise(i / 60, 2, 60);
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    expect(Math.abs(dot / Math.sqrt(na * nb))).toBeLessThan(0.3);
  });
});
