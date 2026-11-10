/**
 * v4 sub-plan 2, Task 5 — the pure half of mining: when B may mine, which
 * resource a mine takes, and what the log says.
 *
 * `mayMine` is the one gate (as `emergencyMayAct`, R16): the key asks it on
 * the press, and Mining asks it again every frame of the 4 s action and at
 * completion. Precedence, first failure wins:
 *   busy → no-target → range → speed → hold-full → depleted
 * Every limit is inclusive, and NaN never passes.
 */

import { describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';
import {
  MINE_ACTION_S,
  MINE_MAX_REL_KMS,
  MINE_RANGE_KM,
  MINE_YIELD_KG,
  MINING_ABORTED_TEXT,
  REFINE_ACTION_S,
  REFUSAL_LOG,
  REPAIR_ACTION_S,
  chooseResource,
  formatKg,
  mayMine,
  minedLog,
  refinedLog,
  repairedLog,
} from './miningRules';

type Gate = Parameters<typeof mayMine>[0];

/** A gate that passes: a targeted asteroid in reach, matched, room and rock left. */
const OK: Gate = {
  paused: false,
  frozen: false,
  cruise: false,
  warpPhase: 'idle',
  targetIsAsteroid: true,
  surfaceRangeKm: 0.2,
  relSpeedKmS: 0.001,
  holdFreeKg: 8_000,
  remainingKg: 10_000,
};

const all = (ice: number, metal: number, silicate: number, rare: number): Record<Resource, number> => ({
  ice,
  metal,
  silicate,
  rare,
});

describe('the constants (pinned, from the plan)', () => {
  it('Given the plan, Then range 0.5 km from the surface, 0.005 km/s, 4 s, 2 000 kg, refine 8 s, repair 10 s', () => {
    expect(MINE_RANGE_KM).toBe(0.5);
    expect(MINE_MAX_REL_KMS).toBe(0.005);
    expect(MINE_ACTION_S).toBe(4);
    expect(MINE_YIELD_KG).toBe(2_000);
    expect(REFINE_ACTION_S).toBe(8);
    expect(REPAIR_ACTION_S).toBe(10);
  });
});

describe('mayMine — each reason at its exact boundary', () => {
  it('Given a targeted asteroid in range, matched, with room and rock left, Then ok with no reason', () => {
    expect(mayMine(OK)).toEqual({ ok: true });
  });

  it('Given a surface range of exactly 0.5 km, Then ok; 0.5001 km, Then range', () => {
    expect(mayMine({ ...OK, surfaceRangeKm: 0.5 })).toEqual({ ok: true });
    expect(mayMine({ ...OK, surfaceRangeKm: 0.5001 })).toEqual({ ok: false, reason: 'range' });
  });

  it('Given a relative speed of exactly 0.005 km/s, Then ok; 0.0051 km/s, Then speed', () => {
    expect(mayMine({ ...OK, relSpeedKmS: 0.005 })).toEqual({ ok: true });
    expect(mayMine({ ...OK, relSpeedKmS: 0.0051 })).toEqual({ ok: false, reason: 'speed' });
  });

  it('Given a hold with 0 kg free, Then hold-full; 1 kg free, Then ok', () => {
    expect(mayMine({ ...OK, holdFreeKg: 0 })).toEqual({ ok: false, reason: 'hold-full' });
    expect(mayMine({ ...OK, holdFreeKg: 1 })).toEqual({ ok: true });
  });

  it('Given 0 kg left in the asteroid, Then depleted; 1 kg left, Then ok', () => {
    expect(mayMine({ ...OK, remainingKg: 0 })).toEqual({ ok: false, reason: 'depleted' });
    expect(mayMine({ ...OK, remainingKg: 1 })).toEqual({ ok: true });
  });

  it('Given no asteroid targeted (nothing, a body or a field), Then no-target', () => {
    expect(mayMine({ ...OK, targetIsAsteroid: false })).toEqual({ ok: false, reason: 'no-target' });
  });

  it('Given paused, frozen, cruise or a warp in any phase but idle, Then busy', () => {
    expect(mayMine({ ...OK, paused: true })).toEqual({ ok: false, reason: 'busy' });
    expect(mayMine({ ...OK, frozen: true })).toEqual({ ok: false, reason: 'busy' });
    expect(mayMine({ ...OK, cruise: true })).toEqual({ ok: false, reason: 'busy' });
    for (const phase of ['charging', 'tunnel', 'arriving']) {
      expect(mayMine({ ...OK, warpPhase: phase }), phase).toEqual({ ok: false, reason: 'busy' });
    }
  });

  it('Given a NaN or infinite range or speed, Then it never passes (range / speed)', () => {
    expect(mayMine({ ...OK, surfaceRangeKm: Number.NaN }).reason).toBe('range');
    expect(mayMine({ ...OK, surfaceRangeKm: Number.POSITIVE_INFINITY }).reason).toBe('range');
    expect(mayMine({ ...OK, relSpeedKmS: Number.NaN }).reason).toBe('speed');
    expect(mayMine({ ...OK, holdFreeKg: Number.NaN }).reason).toBe('hold-full');
    expect(mayMine({ ...OK, remainingKg: Number.NaN }).reason).toBe('depleted');
  });

  it('Given everything wrong at once, Then the reasons come in order busy → no-target → range → speed → hold-full → depleted', () => {
    let g: Gate = {
      paused: true,
      frozen: false,
      cruise: false,
      warpPhase: 'idle',
      targetIsAsteroid: false,
      surfaceRangeKm: 9,
      relSpeedKmS: 9,
      holdFreeKg: 0,
      remainingKg: 0,
    };
    expect(mayMine(g).reason).toBe('busy');
    g = { ...g, paused: false };
    expect(mayMine(g).reason).toBe('no-target');
    g = { ...g, targetIsAsteroid: true };
    expect(mayMine(g).reason).toBe('range');
    g = { ...g, surfaceRangeKm: 0.1 };
    expect(mayMine(g).reason).toBe('speed');
    g = { ...g, relSpeedKmS: 0 };
    expect(mayMine(g).reason).toBe('hold-full');
    g = { ...g, holdFreeKg: 100 };
    expect(mayMine(g).reason).toBe('depleted');
    g = { ...g, remainingKg: 100 };
    expect(mayMine(g)).toEqual({ ok: true });
  });
});

describe('chooseResource — ice, then rare, then metal, then silicate', () => {
  it('Given every resource present, Then ice', () => {
    expect(chooseResource(all(1, 1, 1, 1))).toBe('ice');
  });

  it('Given no ice, Then rare; no ice or rare, Then metal; only silicate, Then silicate', () => {
    expect(chooseResource(all(0, 5, 5, 5))).toBe('rare');
    expect(chooseResource(all(0, 5, 5, 0))).toBe('metal');
    expect(chooseResource(all(0, 0, 5, 0))).toBe('silicate');
  });

  it('Given nothing left, Then null', () => {
    expect(chooseResource(all(0, 0, 0, 0))).toBeNull();
  });

  it('Given a preferred resource that is present, Then it; absent, Then the usual order', () => {
    expect(chooseResource(all(5, 5, 5, 5), 'metal')).toBe('metal');
    expect(chooseResource(all(5, 0, 5, 5), 'metal')).toBe('ice');
  });

  it('Given NaN or negative amounts, Then they count as nothing (never chosen, no NaN out)', () => {
    expect(chooseResource(all(Number.NaN, -5, 3, -1))).toBe('silicate');
    expect(chooseResource(all(Number.NaN, Number.NaN, Number.NaN, Number.NaN))).toBeNull();
    expect(chooseResource(all(Number.NaN, 0, 0, 0), 'ice')).toBeNull();
  });
});

describe('the log texts', () => {
  it('Given kilograms, Then they are whole and grouped by thousands with a space', () => {
    expect(formatKg(0)).toBe('0');
    expect(formatKg(500)).toBe('500');
    expect(formatKg(2_000)).toBe('2 000');
    expect(formatKg(1_250.4)).toBe('1 250');
    expect(formatKg(999.6)).toBe('1 000');
    expect(formatKg(1_234_567)).toBe('1 234 567');
  });

  it('Given a completed mine, Then "MINED · 2 000 KG ICE" (the resource in capitals)', () => {
    expect(minedLog(2_000, 'ice')).toBe('MINED · 2 000 KG ICE');
    expect(minedLog(500, 'rare')).toBe('MINED · 500 KG RARE');
    expect(minedLog(2_000, 'silicate')).toBe('MINED · 2 000 KG SILICATE');
  });

  it('Given a completed refine of 4 000 kg propellant, Then "REFINED · 4 000 KG PROPELLANT"', () => {
    expect(refinedLog(4_000)).toBe('REFINED · 4 000 KG PROPELLANT');
  });

  it('Given a completed repair restoring 0.04, Then "REPAIRED · TANK +4 %" (whole percent)', () => {
    expect(repairedLog(0.04)).toBe('REPAIRED · TANK +4 %');
    expect(repairedLog(0.012)).toBe('REPAIRED · TANK +1 %');
  });

  it('Given an aborted action, Then "MINING ABORTED"', () => {
    expect(MINING_ABORTED_TEXT).toBe('MINING ABORTED');
  });

  it('Given every refusal reason (mayMine and CargoResult), Then each has its own log line', () => {
    expect(REFUSAL_LOG).toEqual({
      // mayMine
      busy: 'BUSY',
      'no-target': 'NO ASTEROID TARGETED',
      range: 'OUT OF RANGE',
      speed: 'MATCH SPEED',
      'hold-full': 'HOLD FULL',
      depleted: 'DEPLETED',
      // CargoResult
      'nothing-to-refine': 'NO ICE',
      'tank-full': 'TANK FULL',
      insufficient: 'NEED 600 KG METAL · 400 KG SILICATE',
      'nothing-to-repair': 'TANK UNDAMAGED',
      empty: 'HOLD EMPTY',
      'not-empty': 'TANK NOT EMPTY',
      'no-tank': 'NO TANK',
      invalid: 'INVALID AMOUNT',
    });
  });
});
