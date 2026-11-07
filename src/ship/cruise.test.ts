/**
 * The cruise drive.
 *
 * One property in this file matters more than all the others: **the drive can
 * never move the ship further in one step than a fraction of its own
 * clearance.** That is what makes a 500c speed cap safe in a fixed-step
 * integrator. Break it and the ship tunnels through planets, skips sphere-of-
 * influence boundaries, and the whole patched-conic model quietly stops
 * holding — none of which throws.
 *
 * The rest is the safety envelope: when the drive may engage, when it must let
 * go, and the hysteresis that stops it chattering on the boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  CRUISE_DEFAULTS,
  CruiseDrive,
  cruiseCapKmS,
  type CruiseInputs,
} from './CruiseDrive';

/** Safe, far from everything, drive requested. */
function inputs(over: Partial<CruiseInputs> = {}): CruiseInputs {
  return {
    requested: true,
    clearanceKm: 1e6,
    grounded: false,
    atmosphericDensity: 0,
    ...over,
  };
}

/** Run the drive for `seconds` at 60 Hz. */
function run(d: CruiseDrive, seconds: number, over: Partial<CruiseInputs> = {}): void {
  const h = 1 / 60;
  for (let t = 0; t < seconds; t += h) d.update(h, inputs(over));
}

describe('the speed law', () => {
  it('scales linearly with clearance', () => {
    expect(cruiseCapKmS(1e5)).toBeCloseTo(1e5 * CRUISE_DEFAULTS.rate, 6);
    expect(cruiseCapKmS(2e5)).toBeCloseTo(2 * cruiseCapKmS(1e5), 6);
  });

  it('is clamped so an outer-system gap does not produce a nonsense number', () => {
    expect(cruiseCapKmS(1e12)).toBe(CRUISE_DEFAULTS.maxCapKmS);
  });

  it('never returns a negative or a NaN, whatever it is handed', () => {
    for (const c of [0, -1, -1e9, Number.EPSILON]) {
      const v = cruiseCapKmS(c);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('is meaningfully faster than the sublight ceiling wherever it can engage', () => {
    // Otherwise engaging it would be a downgrade at the very moment it becomes
    // legal, which is how a drive ends up feeling broken rather than fast.
    const atDrop = cruiseCapKmS(CRUISE_DEFAULTS.dropClearanceKm);
    expect(atDrop).toBeGreaterThan(CRUISE_DEFAULTS.exitSpeedKmS * 4);
  });
});

describe('the safety invariant', () => {
  it('cannot cross more than a fraction of its own clearance in one step', () => {
    // This is the whole reason the law is proportional rather than constant.
    // At 60 Hz the drive covers rate/60 of the gap per step — 0.58%.
    for (const clearance of [3e3, 1e4, 1e6, 1e8, 1.5e8, 1e10, 1e12]) {
      for (const h of [1 / 120, 1 / 60, 1 / 30]) {
        const travelled = cruiseCapKmS(clearance) * h;
        expect(travelled).toBeLessThan(clearance * 0.5);
      }
    }
  });

  it('holds even at the clamp, where proportionality stops applying', () => {
    // Above the clamp the cap is constant, so the invariant has to be checked
    // against the SMALLEST clearance that still clamps — the worst case.
    const clamped = CRUISE_DEFAULTS.maxCapKmS / CRUISE_DEFAULTS.rate;
    expect(CRUISE_DEFAULTS.maxCapKmS * (1 / 30)).toBeLessThan(clamped * 0.5);
  });

  it('approaches a body asymptotically instead of arriving at it', () => {
    // Integrate the closing distance under the law. It must never reach zero.
    let gap = 1e8;
    const h = 1 / 60;
    for (let i = 0; i < 60 * 600; i++) {
      gap -= cruiseCapKmS(gap) * h;
      if (gap < CRUISE_DEFAULTS.dropClearanceKm) break;
    }
    expect(gap).toBeGreaterThan(0);
  });
});

describe('engaging', () => {
  it('starts idle', () => {
    expect(new CruiseDrive().phase).toBe('idle');
  });

  it('spools before it engages, rather than snapping on', () => {
    const d = new CruiseDrive();
    d.update(1 / 60, inputs());
    expect(d.phase).toBe('spooling');
    expect(d.capKmS).toBe(0);
  });

  it('reaches cruise after the spool time', () => {
    const d = new CruiseDrive();
    run(d, CRUISE_DEFAULTS.spoolTime + 0.1);
    expect(d.phase).toBe('cruise');
    expect(d.capKmS).toBeGreaterThan(0);
  });

  it('refuses to engage while landed', () => {
    const d = new CruiseDrive();
    run(d, 5, { grounded: true });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('landed');
  });

  it('refuses to engage inside an atmosphere', () => {
    const d = new CruiseDrive();
    run(d, 5, { atmosphericDensity: 0.2 });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('atmosphere');
  });

  // v2 — an exponential atmosphere never reaches zero. Float64 only underflows
  // at ~745 scale heights, so a `> 0` gate kept the drive locked at 4 344 km
  // over a world whose air is 187 km thick. The gate is a threshold, not zero.
  describe('the atmosphere gate is a threshold, not zero', () => {
    it('Given the opening orbit, 4 344 km over a 14.6 km scale height, When the drive is requested, Then it engages', () => {
      const d = new CruiseDrive();
      const density = Math.exp(-4344 / 14.6); // ≈ 9.5e-130 — hard vacuum
      expect(density).toBeGreaterThan(0);
      run(d, CRUISE_DEFAULTS.spoolTime + 0.1, { atmosphericDensity: density });
      expect(d.blocked).toBe(null);
      expect(d.phase).toBe('cruise');
    });

    it('Given density just under the cutoff, Then it engages; just over, Then it refuses', () => {
      const under = new CruiseDrive();
      run(under, CRUISE_DEFAULTS.spoolTime + 0.1, {
        atmosphericDensity: CRUISE_DEFAULTS.atmosphereCutoff * 0.99,
      });
      expect(under.phase).toBe('cruise');

      const over = new CruiseDrive();
      run(over, 5, { atmosphericDensity: CRUISE_DEFAULTS.atmosphereCutoff * 1.01 });
      expect(over.phase).toBe('idle');
      expect(over.blocked).toBe('atmosphere');
    });

    it('Given the cutoff, Then it sits at the top of a real atmosphere (≈ 14 scale heights), not hundreds', () => {
      const heights = -Math.log(CRUISE_DEFAULTS.atmosphereCutoff);
      expect(heights).toBeGreaterThan(8);
      expect(heights).toBeLessThan(20);
    });

    it('Given density exactly at the cutoff, Then it engages (only density ABOVE the cutoff is air)', () => {
      const d = new CruiseDrive();
      run(d, CRUISE_DEFAULTS.spoolTime + 0.1, { atmosphericDensity: CRUISE_DEFAULTS.atmosphereCutoff });
      expect(d.phase).toBe('cruise');
    });

    it('Given a ship ten scale heights up (inside any real atmosphere), Then it refuses', () => {
      // Earth's Kármán line is ~12 scale heights; ten is still air.
      const d = new CruiseDrive();
      run(d, 5, { atmosphericDensity: Math.exp(-10) });
      expect(d.blocked).toBe('atmosphere');
    });

    it('Given a drive built with its own cutoff, Then that cutoff is the one obeyed', () => {
      const d = new CruiseDrive({ ...CRUISE_DEFAULTS, atmosphereCutoff: 1e-3 });
      run(d, CRUISE_DEFAULTS.spoolTime + 0.1, { atmosphericDensity: 1e-4 });
      expect(d.phase).toBe('cruise');
    });

    it('Given the drive is cruising, When the ship descends into real air, Then it lets go', () => {
      const d = new CruiseDrive();
      run(d, CRUISE_DEFAULTS.spoolTime + 0.1);
      expect(d.phase).toBe('cruise');
      run(d, 2, { atmosphericDensity: 0.01 });
      expect(d.phase).not.toBe('cruise');
    });
  });

  it('refuses to engage too close to a body', () => {
    const d = new CruiseDrive();
    run(d, 5, { clearanceKm: CRUISE_DEFAULTS.engageClearanceKm * 0.5 });
    expect(d.phase).toBe('idle');
    expect(d.blocked).toBe('mass');
  });

  it('reports no obstacle when there is none', () => {
    const d = new CruiseDrive();
    d.update(1 / 60, inputs());
    expect(d.blocked).toBe(null);
  });

  it('aborts the spool if the request is released', () => {
    const d = new CruiseDrive();
    run(d, CRUISE_DEFAULTS.spoolTime * 0.5);
    expect(d.phase).toBe('spooling');
    run(d, 0.5, { requested: false });
    expect(d.phase).toBe('idle');
  });

  it('aborts the spool if the ship strays too close mid-charge', () => {
    const d = new CruiseDrive();
    run(d, CRUISE_DEFAULTS.spoolTime * 0.5);
    run(d, 0.2, { clearanceKm: 100 });
    expect(d.phase).toBe('idle');
  });
});

describe('dropping', () => {
  function cruising(): CruiseDrive {
    const d = new CruiseDrive();
    run(d, CRUISE_DEFAULTS.spoolTime + 0.2);
    expect(d.phase).toBe('cruise');
    return d;
  }

  it('lets go when the request is released', () => {
    const d = cruising();
    d.update(1 / 60, inputs({ requested: false }));
    expect(d.phase).toBe('dropping');
  });

  it('lets go on its own when a body gets close', () => {
    const d = cruising();
    d.update(1 / 60, inputs({ clearanceKm: CRUISE_DEFAULTS.dropClearanceKm * 0.9 }));
    expect(d.phase).toBe('dropping');
    expect(d.blocked).toBe('mass');
  });

  it('bleeds the ceiling down to sublight rather than snapping it', () => {
    const d = cruising();
    const before = d.capKmS;
    d.update(1 / 60, inputs({ requested: false }));
    expect(d.capKmS).toBeLessThan(before);
    expect(d.capKmS).toBeGreaterThan(CRUISE_DEFAULTS.exitSpeedKmS);
  });

  it('finishes at the sublight ceiling and returns to idle', () => {
    const d = cruising();
    run(d, CRUISE_DEFAULTS.dropTime + 0.2, { requested: false });
    expect(d.phase).toBe('idle');
    expect(d.capKmS).toBe(0);
  });

  it('reports the drop so the camera can be shaken exactly once', () => {
    const d = cruising();
    expect(d.takeDropEvent()).toBe(false);
    d.update(1 / 60, inputs({ requested: false }));
    expect(d.takeDropEvent()).toBe(true);
    expect(d.takeDropEvent()).toBe(false);
  });
});

describe('hysteresis', () => {
  it('needs more clearance to engage than to keep running', () => {
    // Equal thresholds would let a ship on the boundary engage and drop on
    // alternate frames for as long as it sat there.
    expect(CRUISE_DEFAULTS.engageClearanceKm).toBeGreaterThan(
      CRUISE_DEFAULTS.dropClearanceKm * 1.2,
    );
  });

  it('does not chatter for a ship parked between the two thresholds', () => {
    const between =
      (CRUISE_DEFAULTS.engageClearanceKm + CRUISE_DEFAULTS.dropClearanceKm) / 2;
    const d = new CruiseDrive();
    // Cannot start there...
    run(d, 3, { clearanceKm: between });
    expect(d.phase).toBe('idle');
    // ...but having started further out, it keeps running there.
    const e = new CruiseDrive();
    run(e, CRUISE_DEFAULTS.spoolTime + 0.2);
    run(e, 2, { clearanceKm: between });
    expect(e.phase).toBe('cruise');
  });
});
