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

// v4 sub-plan 5, Task 4 (review): the HUD's action rows are read from Mining,
// so the feed must sleep whenever Mining sleeps — else it prints a frozen verdict.
describe('the action feed follows Mining', () => {
  it('Given the gating table, Then action-feed is listed and ticks in exactly the modes mining ticks in', () => {
    expect(MODULE_MODES['action-feed']).toBeDefined();
    expect(MODULE_MODES['action-feed']).toEqual(MODULE_MODES['mining']);
  });

  it('Given the map, the title, the yard or a review shot, Then the action feed sleeps; in flight it ticks', () => {
    for (const base of ['map', 'title', 'yard', 'review', 'boot'] as const) expect(ticks('action-feed', base), base).toBe(false);
    expect(ticks('action-feed', 'flight')).toBe(true);
  });
});

// Plan 5 final review, fix round (phase A) — I-2. Photo is an overlay: under
// it Mining and its beam are NOT asleep — they tick with dt = 0 — and Pause
// ticks too (it is what freezes the world while an overlay is up). Mining's
// and MiningBeams' "photo holds the extraction / keeps the beam" tests rest
// on exactly this; leaving flight for a base mode puts both to sleep.
describe('photo over flight: Mining and its beam stand still, they do not sleep (plan 5 final review I-2)', () => {
  const dtIn = (name: string, base: BaseMode, overlay: 'photo' | null): number =>
    moduleDt({ activeIn: MODULE_MODES[name] }, { base, overlay }, 1 / 60);

  it('Given a photo overlay over flight, Then mining, mining-beams, action-feed, pause and universe tick with dt = 0', () => {
    for (const m of ['mining', 'mining-beams', 'action-feed', 'pause', 'universe']) expect(dtIn(m, 'flight', 'photo'), m).toBe(0);
  });

  it('Given flight with no overlay, Then mining and mining-beams tick with the frame dt; in map, Yard or title they sleep', () => {
    for (const m of ['mining', 'mining-beams']) {
      expect(dtIn(m, 'flight', null), m).toBe(1 / 60);
      for (const b of ['map', 'yard', 'title'] as const) expect(dtIn(m, b, null), `${m} in ${b}`).toBe(-1);
    }
  });
});
