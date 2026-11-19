/**
 * Pitch ladder at rest (v3 PLAN F / H1).
 *
 * The ladder sits over the hull in the chase view (audit thrust-03-w.png): ten
 * dashed rungs drawn across the ship the pilot is looking at. It is only
 * information while the attitude is changing. At rest it recedes to a quarter
 * and comes back the instant the pilot or the ship moves.
 */

import { describe, expect, it } from 'vitest';

import {
  LADDER_CALM_DELAY_S,
  LADDER_REST_OPACITY,
  createLadderFade,
  stepLadderFade,
  type LadderFadeInput,
} from './ladderFade';

const DT = 1 / 60;

const still: LadderFadeInput = { pitchRateDegS: 0, rollRateDegS: 0, stickActive: false };

function run(s: ReturnType<typeof createLadderFade>, inp: LadderFadeInput, seconds: number): number[] {
  const trace: number[] = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    stepLadderFade(s, inp, DT);
    trace.push(s.opacity);
  }
  return trace;
}

describe('stepLadderFade', () => {
  it('Given a fresh HUD, Then the ladder starts fully lit', () => {
    expect(createLadderFade().opacity).toBe(1);
  });

  it('Given steady attitude and no input for 5 s, Then the ladder rests at ~25 %', () => {
    const s = createLadderFade();
    run(s, still, 5);
    expect(LADDER_REST_OPACITY).toBeCloseTo(0.25, 9);
    expect(s.opacity).toBeCloseTo(LADDER_REST_OPACITY, 2);
  });

  it('Given steady attitude for less than the calm delay, Then the ladder has not started to fade', () => {
    const s = createLadderFade();
    run(s, still, LADDER_CALM_DELAY_S * 0.8);
    expect(s.opacity).toBe(1);
  });

  it('Given a resting ladder, When the pilot deflects the stick, Then it is back above 90 % within a quarter second', () => {
    const s = createLadderFade();
    run(s, still, 5);
    run(s, { ...still, stickActive: true }, 0.25);
    expect(s.opacity).toBeGreaterThan(0.9);
  });

  it('Given no input but the ship still pitching at 6°/s (a rotation coasting down), Then the ladder stays lit', () => {
    const s = createLadderFade();
    run(s, { pitchRateDegS: 6, rollRateDegS: 0, stickActive: false }, 5);
    expect(s.opacity).toBeGreaterThan(0.95);
  });

  it('Given no input but the ship still rolling at 10°/s, Then the ladder stays lit', () => {
    const s = createLadderFade();
    run(s, { pitchRateDegS: 0, rollRateDegS: -10, stickActive: false }, 5);
    expect(s.opacity).toBeGreaterThan(0.95);
  });

  it('Given an orbit at constant pitch rate below the threshold (the horizon creeping, 0.06°/s), Then the ladder still rests', () => {
    const s = createLadderFade();
    run(s, { pitchRateDegS: 0.06, rollRateDegS: 0, stickActive: false }, 5);
    expect(s.opacity).toBeLessThan(0.3);
  });

  it('Given any sequence, Then nothing snaps: fading moves at most 0.03 per 60 Hz frame and recovering at most 0.2', () => {
    const s = createLadderFade();
    const t1 = run(s, still, 5);
    const t2 = run(s, { ...still, stickActive: true }, 1);
    const t3 = run(s, still, 5);
    const all = [1, ...t1, ...t2, ...t3];
    for (let i = 1; i < all.length; i++) {
      const d = all[i]! - all[i - 1]!;
      expect(d).toBeLessThanOrEqual(0.2 + 1e-9);
      expect(-d).toBeLessThanOrEqual(0.03 + 1e-9);
    }
  });

  it('Given any sequence, Then the opacity never leaves [rest, 1]', () => {
    const s = createLadderFade();
    const t = [...run(s, still, 10), ...run(s, { ...still, stickActive: true }, 3), ...run(s, still, 10)];
    for (const o of t) {
      expect(o).toBeGreaterThanOrEqual(LADDER_REST_OPACITY - 1e-9);
      expect(o).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('Given a brief twitch after resting, Then the calm timer restarts — the ladder waits the full delay again before fading', () => {
    const s = createLadderFade();
    run(s, still, 5);
    run(s, { ...still, stickActive: true }, 0.5);
    const lit = s.opacity;
    run(s, still, LADDER_CALM_DELAY_S * 0.8);
    expect(s.opacity).toBeGreaterThanOrEqual(lit - 1e-9);
  });

  it('Given dt = 0 (paused), Then nothing changes', () => {
    const s = createLadderFade();
    stepLadderFade(s, still, 0);
    expect(s.opacity).toBe(1);
  });
});
