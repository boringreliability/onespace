/**
 * [v3-T1] Governor hysteresis (docs/v3/PLAN.md phase A4).
 *
 * Every change of scale reallocates the post stack and costs a 56-67 ms
 * frame. During an auto-land the governor stepped 8 times, and each step was
 * a visible hitch. Steps are rationed: ≥ 2 s apart, rises only after ≥ 5 s of
 * steady fast frames, and no rise while the autopilot or cruise is flying.
 */

import { describe, expect, it } from 'vitest';
import {
  GOVERNOR_MIN_STEP_INTERVAL_MS,
  GOVERNOR_UP_STABLE_MS,
  ResolutionGovernor,
  governorShouldStep,
} from './ResolutionGovernor';

describe('governorShouldStep', () => {
  const base = { sinceLastStepMs: 10_000, stableMs: 10_000, holdUp: false } as const;

  it('Given a step 1.9 s ago, When it wants either direction, Then it must wait', () => {
    expect(governorShouldStep({ ...base, direction: 'down', sinceLastStepMs: 1900 })).toBe(false);
    expect(governorShouldStep({ ...base, direction: 'up', sinceLastStepMs: 1900 })).toBe(false);
  });

  it('Given 2 s since the last step, When it wants down, Then it may', () => {
    expect(
      governorShouldStep({ ...base, direction: 'down', sinceLastStepMs: GOVERNOR_MIN_STEP_INTERVAL_MS }),
    ).toBe(true);
  });

  it('Given no step ever (Infinity), When it wants down, Then it may', () => {
    expect(governorShouldStep({ ...base, direction: 'down', sinceLastStepMs: Infinity, stableMs: 0 })).toBe(true);
  });

  it('Given only 4.9 s of steady fast frames, When it wants up, Then it must wait', () => {
    expect(governorShouldStep({ ...base, direction: 'up', stableMs: 4900 })).toBe(false);
  });

  it('Given 5 s of steady fast frames, When it wants up, Then it may', () => {
    expect(governorShouldStep({ ...base, direction: 'up', stableMs: GOVERNOR_UP_STABLE_MS })).toBe(true);
  });

  it('Given the autopilot or cruise is active, When it wants up, Then it may not; When it wants down, Then it still may', () => {
    expect(governorShouldStep({ ...base, direction: 'up', holdUp: true })).toBe(false);
    expect(governorShouldStep({ ...base, direction: 'down', holdUp: true })).toBe(true);
  });

  it('Given the constants, Then they are the plan’s numbers', () => {
    expect(GOVERNOR_MIN_STEP_INTERVAL_MS).toBe(2000);
    expect(GOVERNOR_UP_STABLE_MS).toBe(5000);
  });
});

describe('ResolutionGovernor with hysteresis', () => {
  it('Given sustained heavy load, When it steps down repeatedly, Then consecutive steps are at least 2 s of wall time apart', () => {
    const g = new ResolutionGovernor();
    let t = 0;
    const at: number[] = [];
    for (let i = 0; i < 500; i++) {
      t += 60;
      if (g.sample(60)) at.push(t);
    }
    expect(at.length).toBeGreaterThan(1);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(2000);
  });

  it('Given it has dropped and frames are fast again, When the autopilot holds rises for 30 s, Then the scale does not rise until released', () => {
    const g = new ResolutionGovernor();
    for (let i = 0; i < 20; i++) g.sample(60);
    const dropped = g.scale;
    expect(dropped).toBeLessThan(1);
    for (let i = 0; i < 3000; i++) g.sample(10, true);
    expect(g.scale).toBe(dropped);
    let rose = false;
    for (let i = 0; i < 3000 && !rose; i++) rose = g.sample(10, false) && g.scale > dropped;
    expect(rose).toBe(true);
  });

  it('Given it has dropped, When frames become fast, Then the first rise comes no sooner than 5 s later', () => {
    const g = new ResolutionGovernor();
    for (let i = 0; i < 20; i++) g.sample(60);
    const dropped = g.scale;
    let t = 0;
    let firstRise = -1;
    for (let i = 0; i < 2000 && firstRise < 0; i++) {
      t += 10;
      if (g.sample(10) && g.scale > dropped) firstRise = t;
    }
    expect(firstRise).toBeGreaterThanOrEqual(5000);
  });

  it('Given fast frames broken by a 1.5 s stretch between the thresholds, When it wants to rise, Then the 5 s of stability start again after it', () => {
    const g = new ResolutionGovernor();
    for (let i = 0; i < 20; i++) g.sample(60); // drop
    for (let i = 0; i < 400; i++) g.sample(10); // 4 s fast
    for (let i = 0; i < 79; i++) g.sample(19); // 1.5 s between thresholds: not "fast"
    const held = g.scale;
    let t = 0;
    let firstRise = -1;
    for (let i = 0; i < 2000 && firstRise < 0; i++) {
      t += 10;
      if (g.sample(10) && g.scale > held) firstRise = t;
    }
    expect(firstRise).toBeGreaterThanOrEqual(4500);
  });
});
