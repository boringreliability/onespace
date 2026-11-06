/**
 * The recovery cut: fade to black, move the ship, fade back.
 *
 * Respawn is a teleport, and the one rule for a teleport is that the player
 * must not see it. So the ship moves exactly once, and only when the screen is
 * fully black. Nothing snaps (ARCHITECTURE §6): the fade is eased both ways.
 */

import { describe, expect, it } from 'vitest';

import { RecoveryTimeline } from './recovery';

describe('RecoveryTimeline', () => {
  it('Given idle, Then it is not active and the screen is clear', () => {
    const t = new RecoveryTimeline();
    expect(t.active).toBe(false);
    expect(t.blackout).toBe(0);
  });

  it('Given a recovery started, When stepped through, Then the respawn fires exactly once, at full black', () => {
    const t = new RecoveryTimeline();
    t.start();
    let fired = 0;
    let blackAtFire = -1;
    for (let i = 0; i < 400; i++) {
      if (t.step(1 / 60)) {
        fired++;
        blackAtFire = t.blackout;
      }
    }
    expect(fired).toBe(1);
    expect(blackAtFire).toBeCloseTo(1, 9);
    expect(t.active).toBe(false);
    expect(t.blackout).toBe(0);
  });

  it('Given a recovery in progress, When started again (a second crash event), Then it does not restart or fire twice', () => {
    const t = new RecoveryTimeline();
    t.start();
    let fired = 0;
    for (let i = 0; i < 400; i++) {
      if (i === 10 || i === 60) t.start();
      if (t.step(1 / 60)) fired++;
    }
    expect(fired).toBe(1);
  });

  it('Given a recovery, Then the blackout rises and falls monotonically (no snap)', () => {
    const t = new RecoveryTimeline();
    t.start();
    const trace: number[] = [];
    for (let i = 0; i < 400 && (t.active || i === 0); i++) {
      t.step(1 / 60);
      trace.push(t.blackout);
    }
    const peak = trace.indexOf(Math.max(...trace));
    for (let i = 1; i <= peak; i++) expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]!);
    for (let i = peak + 1; i < trace.length; i++) expect(trace[i]!).toBeLessThanOrEqual(trace[i - 1]!);
    // Largest single-frame step stays well under a cut.
    for (let i = 1; i < trace.length; i++) expect(Math.abs(trace[i]! - trace[i - 1]!)).toBeLessThan(0.1);
  });

  it('Given the whole cut, Then it takes between 1 and 3 seconds', () => {
    const t = new RecoveryTimeline();
    t.start();
    let s = 0;
    while (t.active && s < 10) {
      t.step(1 / 60);
      s += 1 / 60;
    }
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThan(3);
  });
});
