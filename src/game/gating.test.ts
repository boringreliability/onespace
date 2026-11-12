/**
 * Which modules tick in which mode. The table is applied by name in
 * registry.ts; these tests pin the two properties that make it safe:
 * the Yard freezes flight, and every mode v1 already had behaves as before.
 */

import { describe, expect, it } from 'vitest';

import { moduleDt } from '@/core/tick';
import type { BaseMode, Mode } from '@/core/Modes';
import { MODULE_MODES, applyGating } from './gating';

const FLIGHT_MODULES = ['universe', 'pilot', 'traffic', 'cruise', 'scanner', 'warp', 'hud', 'map-mode', 'system-map'];
const ALWAYS = ['log', 'audio', 'codex', 'sky', 'shot-driver', 'review-guard'];

function ticks(name: string, base: BaseMode, overlay: 'photo' | null = null): boolean {
  return moduleDt({ activeIn: MODULE_MODES[name] }, { base, overlay }, 1 / 60) >= 0;
}

describe('module gating table', () => {
  it('Given the yard, When modules tick, Then every flight module sleeps and the stage runs', () => {
    for (const m of FLIGHT_MODULES) expect(ticks(m, 'yard'), m).toBe(false);
    expect(ticks('showroom', 'yard')).toBe(true);
    expect(ticks('yard', 'yard')).toBe(true);
    expect(ticks('gallery', 'yard')).toBe(false);
  });

  it('Given review, When modules tick, Then flight modules still tick (shotOwnsScene keeps v1 semantics, live shots keep the game running)', () => {
    for (const m of FLIGHT_MODULES) expect(ticks(m, 'review'), m).toBe(true);
    expect(ticks('showroom', 'review')).toBe(true);
    expect(ticks('gallery', 'review')).toBe(true);
  });

  it('Given flight, When modules tick, Then the yard, the stage and the gallery sleep', () => {
    for (const m of FLIGHT_MODULES) expect(ticks(m, 'flight'), m).toBe(true);
    expect(ticks('showroom', 'flight')).toBe(false);
    expect(ticks('yard', 'flight')).toBe(false);
    expect(ticks('gallery', 'flight')).toBe(false);
  });

  it('Given map, When modules tick, Then flight modules tick exactly as in flight (v1 map is a pause, not a freeze)', () => {
    for (const m of FLIGHT_MODULES) expect(ticks(m, 'map'), m).toBe(true);
  });

  it('Given modules whose clock must not stop, Then they are not in the table at all', () => {
    for (const m of ALWAYS) expect(MODULE_MODES[m]).toBeUndefined();
  });

  it('Given a list of modules, When the table is applied, Then named modules get activeIn and others are untouched', () => {
    const mods: Array<{ name: string; activeIn?: readonly Mode[] }> = [{ name: 'universe' }, { name: 'log' }];
    applyGating(mods);
    expect(mods[0]!.activeIn).toEqual(MODULE_MODES.universe);
    expect(mods[1]!.activeIn).toBeUndefined();
  });
});

// v4 sub-plan 3, Task 5: the save module ticks (interval, triggers) only in
// the piloting modes. Never over the title — the opening world drifting behind
// the menu is not the pilot's game and must not overwrite their save — nor in
// the Yard or a review shot.
describe('v4-save — the save module is gated to piloting', () => {
  it('Given the save module, Then it ticks in flight and map and in nothing else', () => {
    expect(MODULE_MODES.save).toBeDefined();
    expect(ticks('save', 'flight')).toBe(true);
    expect(ticks('save', 'map')).toBe(true);
    for (const b of ['title', 'boot', 'yard', 'review'] as const) expect(ticks('save', b), b).toBe(false);
  });
});
