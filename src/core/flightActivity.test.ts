/**
 * [review-v3a] The flags the governor and the FOV read (core/flightActivity.ts).
 * Mutating `governorHoldUp` to ignore cruise, or `cruiseActive` to ignore
 * Pilot's fallback, left every test green.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { FLIGHT_RUNNING_MODES, cruiseActive, cruiseSpoolNow, flightActivity, governorHoldUp } from './flightActivity';
import { MODULE_MODES } from '@/game/gating';

afterEach(() => {
  Object.assign(flightActivity, { autopilot: false, cruise: false, cruiseSpool: 0, cruiseFallback: false, cruiseSpoolFallback: 0 });
});

describe('flightActivity', () => {
  it('Given nothing flies, Then the governor may rise', () => {
    expect(governorHoldUp()).toBe(false);
    expect(governorHoldUp('flight')).toBe(false);
  });

  it('Given only the cruise module says cruise, or only Pilot’s fallback does, Then cruise is active and rises are held', () => {
    flightActivity.cruise = true;
    expect(cruiseActive()).toBe(true);
    expect(governorHoldUp('flight')).toBe(true);
    flightActivity.cruise = false;
    flightActivity.cruiseFallback = true;
    expect(cruiseActive()).toBe(true);
    expect(governorHoldUp('flight')).toBe(true);
  });

  it('Given the autopilot flies, Then rises are held in every mode where flight runs (title included: it keeps flying behind the menu)', () => {
    flightActivity.autopilot = true;
    for (const m of ['boot', 'title', 'flight', 'map', 'review']) expect(governorHoldUp(m)).toBe(true);
  });

  it('Given the Yard was entered with cruise and autopilot flags still set, Then they do not hold the governor there', () => {
    flightActivity.autopilot = true;
    flightActivity.cruise = true;
    expect(governorHoldUp('yard')).toBe(false);
  });

  it('Given the gating table, Then the modes where flight runs are exactly where Universe ticks', () => {
    expect([...FLIGHT_RUNNING_MODES].sort()).toEqual([...MODULE_MODES.universe!].sort());
  });

  it('Given two writers of the spool, Then the larger wins', () => {
    flightActivity.cruiseSpool = 0.2;
    flightActivity.cruiseSpoolFallback = 0.7;
    expect(cruiseSpoolNow()).toBe(0.7);
    flightActivity.cruiseSpool = 0.9;
    expect(cruiseSpoolNow()).toBe(0.9);
  });
});
