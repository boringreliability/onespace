/**
 * v3 T4 / PLAN E5 — the flight events that were silent.
 *
 * The audit's V3: cruise spool/engage/drop, RCS, touchdown, crash and passing
 * a ship made no sound; the warp, by contrast, has a full four-beat score.
 * These are the pure mappings from game state to sound parameters; the
 * voices themselves are one-shots in Audio.ts and are verified by ear.
 */

import { describe, expect, it } from 'vitest';
import {
  CREAK_ONSET_G,
  crashCue,
  creakLevel,
  cruiseCue,
  loudestHull,
  rcsHiss,
  touchdownThud,
  vesselHum,
} from './audioCues';

describe('cruiseCue: phase transitions → one-shot cues', () => {
  it('Given idle → spooling, Then the spool cue fires', () => {
    expect(cruiseCue('idle', 'spooling')).toBe('spool');
  });
  it('Given spooling → cruise, Then the engage cue fires', () => {
    expect(cruiseCue('spooling', 'cruise')).toBe('engage');
  });
  it('Given cruise → dropping, Then the drop cue fires', () => {
    expect(cruiseCue('cruise', 'dropping')).toBe('drop');
  });
  it('Given spooling → idle (refused or cancelled), Then the spool winds down (abort)', () => {
    expect(cruiseCue('spooling', 'idle')).toBe('abort');
  });
  it('Given no change, or dropping → idle (the drop already sounded), Then no cue', () => {
    expect(cruiseCue('cruise', 'cruise')).toBeNull();
    expect(cruiseCue('idle', 'idle')).toBeNull();
    expect(cruiseCue('dropping', 'idle')).toBeNull();
  });
});

describe('touchdownThud: a thud ∝ impact', () => {
  it('Given a feather landing (0.5 m/s), Then a soft but audible thud', () => {
    const t = touchdownThud(0.0005);
    expect(t.gain).toBeGreaterThan(0.05);
    expect(t.gain).toBeLessThan(0.35);
  });

  it('Given harder impacts, Then the thud is louder and lower, monotonically, up to a ceiling', () => {
    let prevGain = -1;
    let prevHz = Infinity;
    for (const mps of [0.5, 2, 5, 10, 30, 80]) {
      const t = touchdownThud(mps / 1000);
      expect(t.gain).toBeGreaterThan(prevGain);
      expect(t.freqHz).toBeLessThanOrEqual(prevHz);
      expect(t.gain).toBeLessThanOrEqual(1);
      prevGain = t.gain;
      prevHz = t.freqHz;
    }
  });

  it('Given the frequency, Then it sits in the chest (30-120 Hz), not a click', () => {
    for (const mps of [0.5, 10, 100]) {
      const f = touchdownThud(mps / 1000).freqHz;
      expect(f).toBeGreaterThanOrEqual(30);
      expect(f).toBeLessThanOrEqual(120);
    }
  });

  it('Given a non-finite or negative impact, Then the thud is silent', () => {
    expect(touchdownThud(Number.NaN).gain).toBe(0);
    expect(touchdownThud(-1).gain).toBe(0);
  });
});

describe('crashCue', () => {
  it('Given any crash, Then it is louder than the hardest touchdown', () => {
    expect(crashCue(0.12).gain).toBeGreaterThan(touchdownThud(0.119).gain);
  });
  it('Given a faster crash, Then it is no quieter and stays ≤ 1', () => {
    expect(crashCue(0.5).gain).toBeGreaterThanOrEqual(crashCue(0.12).gain);
    expect(crashCue(50).gain).toBeLessThanOrEqual(1);
  });
});

describe('rcsHiss: level and stereo pan from the ship-local RCS command', () => {
  it('Given no RCS, Then silence', () => {
    expect(rcsHiss(0, 0, 0).level).toBe(0);
  });

  it('Given starboard strafe (+X), Then the hiss is panned right; port (-X) left', () => {
    expect(rcsHiss(1, 0, 0).pan).toBeGreaterThan(0.3);
    expect(rcsHiss(-1, 0, 0).pan).toBeLessThan(-0.3);
  });

  it('Given vertical or fore-aft strafe only, Then the hiss is centred', () => {
    expect(rcsHiss(0, 1, 0).pan).toBeCloseTo(0, 9);
    expect(rcsHiss(0, 0, -1).pan).toBeCloseTo(0, 9);
  });

  it('Given more axes or more stick, Then it is louder, within [0, 1], and the pan within [-1, 1]', () => {
    expect(rcsHiss(1, 1, 0).level).toBeGreaterThan(rcsHiss(1, 0, 0).level);
    expect(rcsHiss(0.5, 0, 0).level).toBeLessThan(rcsHiss(1, 0, 0).level);
    const h = rcsHiss(5, 5, 5);
    expect(h.level).toBeLessThanOrEqual(1);
    expect(Math.abs(h.pan)).toBeLessThanOrEqual(1);
  });

  it('Given NaN, Then silence', () => {
    expect(rcsHiss(Number.NaN, 0, 0).level).toBe(0);
  });
});

describe('vesselHum / loudestHull: a passing ship is heard', () => {
  it('Given a 400 m hull at 1 km, Then the hum is clearly present', () => {
    expect(vesselHum(1, 0.2)).toBeGreaterThan(0.4);
  });

  it('Given distance growing, Then the hum fades monotonically to silence well before 100 km', () => {
    let prev = 2;
    for (const d of [0.3, 1, 2, 5, 10, 30]) {
      const h = vesselHum(d, 0.2);
      expect(h).toBeLessThanOrEqual(prev);
      prev = h;
    }
    expect(vesselHum(100, 0.2)).toBe(0);
  });

  it('Given two hulls at the same range, Then the bigger one is louder (weighted by bounding radius)', () => {
    expect(vesselHum(3, 0.6)).toBeGreaterThan(vesselHum(3, 0.05));
  });

  it('Given a contact inside its own bounds, Then the hum is full but ≤ 1', () => {
    expect(vesselHum(0.01, 0.2)).toBeLessThanOrEqual(1);
    expect(vesselHum(0.01, 0.2)).toBeGreaterThan(0.9);
  });

  it('Given a list of hulls, Then the one that looms largest wins, not merely the nearest', () => {
    const hulls = [
      { distanceKm: 1.0, radiusKm: 0.015 }, // a shuttle, near
      { distanceKm: 2.0, radiusKm: 0.6 }, // a capital, further
      { distanceKm: 50, radiusKm: 0.6 },
    ];
    expect(loudestHull(hulls)).toBe(1);
  });

  it('Given no hulls or only invalid ones, Then -1', () => {
    expect(loudestHull([])).toBe(-1);
    expect(loudestHull([{ distanceKm: Number.NaN, radiusKm: 1 }, { distanceKm: 1, radiusKm: 0 }])).toBe(-1);
  });
});

describe('creakLevel: the cockpit hull creaks under g', () => {
  it('Given free fall or a gentle burn (below onset), Then nothing creaks', () => {
    expect(creakLevel(0, true)).toBe(0);
    expect(creakLevel(CREAK_ONSET_G * 0.9, true)).toBe(0);
  });

  it('Given g rising past onset, Then the creak rises monotonically to ≤ 1', () => {
    let prev = -1;
    for (const g of [CREAK_ONSET_G + 0.1, 3, 5, 8, 20]) {
      const c = creakLevel(g, true);
      expect(c).toBeGreaterThan(prev);
      expect(c).toBeLessThanOrEqual(1);
      prev = c;
    }
  });

  it('Given an outside camera, Then no creak (it is the cockpit you are sitting in)', () => {
    expect(creakLevel(8, false)).toBe(0);
  });

  it('Given the onset, Then it is above 1 g (sitting on a planet does not creak)', () => {
    expect(CREAK_ONSET_G).toBeGreaterThan(1.2);
  });
});
