/**
 * v2 phase 4 (GAMEPLAY P8) — flight presets: SURVEY, PILOT, NEWTONIAN.
 *
 * One setting, persisted as `os.flight.preset`, parsed through a whitelist:
 * whatever is in storage, the game gets one of three known presets or the
 * default. Storage can be missing, blocked or throwing (private windows,
 * sandboxed frames) and the game must still boot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FLIGHT_PRESET,
  FLIGHT_PRESETS,
  FLIGHT_PRESET_IDS,
  FLIGHT_PRESET_KEY,
  loadFlightPreset,
  parseFlightPreset,
  saveFlightPreset,
} from './flightPreset';

function memory(init: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    get length() {
      return Object.keys(data).length;
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    getItem: (k: string) => (k in data ? data[k]! : null),
    key: (i: number) => Object.keys(data)[i] ?? null,
    removeItem: (k: string) => {
      delete data[k];
    },
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

const throwing: Storage = {
  length: 0,
  clear: () => undefined,
  getItem: () => {
    throw new Error('SecurityError');
  },
  key: () => null,
  removeItem: () => undefined,
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('what each preset means', () => {
  it('SURVEY: flight assist on, autopilot fitted — the default', () => {
    expect(DEFAULT_FLIGHT_PRESET).toBe('survey');
    expect(FLIGHT_PRESETS.survey.flightAssist).toBe(true);
    expect(FLIGHT_PRESETS.survey.autopilot).toBe(true);
  });
  it('PILOT: flight assist on, no autopilot', () => {
    expect(FLIGHT_PRESETS.pilot.flightAssist).toBe(true);
    expect(FLIGHT_PRESETS.pilot.autopilot).toBe(false);
  });
  it('NEWTONIAN: flight assist off by default, no autopilot', () => {
    expect(FLIGHT_PRESETS.newtonian.flightAssist).toBe(false);
    expect(FLIGHT_PRESETS.newtonian.autopilot).toBe(false);
  });
  it('Every preset keeps crash recovery on (there is no other consequence model to fall back to)', () => {
    for (const id of FLIGHT_PRESET_IDS) expect(FLIGHT_PRESETS[id].recovery).toBe(true);
  });
  it('Every preset has an upper-case label for the pause sheet', () => {
    for (const id of FLIGHT_PRESET_IDS) expect(FLIGHT_PRESETS[id].label).toBe(id.toUpperCase());
  });
});

describe('parsing (whitelist)', () => {
  it('Given each known id, Then it parses to itself', () => {
    for (const id of FLIGHT_PRESET_IDS) expect(parseFlightPreset(id)).toBe(id);
  });
  it('Given junk, a near-miss, a prototype key or a non-string, Then it falls back to the default', () => {
    for (const raw of ['', 'SURVEY ', 'Survey', 'arcade', 'constructor', '__proto__', 'toString', null, undefined, 3, {}]) {
      expect(parseFlightPreset(raw as unknown)).toBe(DEFAULT_FLIGHT_PRESET);
    }
  });
});

describe('persistence', () => {
  it(`Given nothing stored, Then the preset loads as the default`, () => {
    expect(loadFlightPreset(memory())).toBe('survey');
  });
  it(`Given "${FLIGHT_PRESET_KEY}" = newtonian, Then it loads newtonian`, () => {
    expect(loadFlightPreset(memory({ [FLIGHT_PRESET_KEY]: 'newtonian' }))).toBe('newtonian');
  });
  it('Given a save then a load, Then the preset round-trips under the documented key', () => {
    const s = memory();
    saveFlightPreset(s, 'pilot');
    expect(s.data[FLIGHT_PRESET_KEY]).toBe('pilot');
    expect(loadFlightPreset(s)).toBe('pilot');
  });
  it('Given storage that throws on every call, Then load returns the default and save does not throw', () => {
    expect(loadFlightPreset(throwing)).toBe('survey');
    expect(() => saveFlightPreset(throwing, 'pilot')).not.toThrow();
  });
  it('Given no storage at all, Then load returns the default and save is a no-op', () => {
    expect(loadFlightPreset(null)).toBe('survey');
    expect(() => saveFlightPreset(null, 'newtonian')).not.toThrow();
  });
});

describe('review-p4: the contract, literally', () => {
  it('Given the documented key, Then it is exactly "os.flight.preset" — renaming it would silently reset every player', () => {
    expect(FLIGHT_PRESET_KEY).toBe('os.flight.preset');
  });
  it('Given a case or whitespace variant of a NON-default id, Then it is junk (the default), not that preset', () => {
    for (const raw of ['PILOT', 'Pilot', ' pilot', 'pilot ', 'NEWTONIAN', '\tnewtonian']) {
      expect(parseFlightPreset(raw)).toBe(DEFAULT_FLIGHT_PRESET);
    }
  });
});

describe('review-p4: the session preset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('Given a preset chosen in the pause sheet, Then it is persisted under the key, and a fresh session loads it', async () => {
    const store = memory();
    vi.stubGlobal('localStorage', store);
    vi.resetModules();
    const a = await import('./flightPreset');
    expect(a.setActiveFlightPreset('newtonian').id).toBe('newtonian');
    expect(store.data['os.flight.preset']).toBe('newtonian');
    vi.resetModules();
    const b = await import('./flightPreset');
    expect(b.activeFlightPreset().id).toBe('newtonian');
  });

  it('Given garbage chosen (a tampered select), Then the default is applied AND persisted', async () => {
    const store = memory({ 'os.flight.preset': 'pilot' });
    vi.stubGlobal('localStorage', store);
    vi.resetModules();
    const a = await import('./flightPreset');
    expect(a.setActiveFlightPreset('__proto__').id).toBe('survey');
    expect(store.data['os.flight.preset']).toBe('survey');
  });

  it('Given the session preset was read once, When storage is edited behind its back, Then the session keeps its preset (read once, not per frame)', async () => {
    const store = memory({ 'os.flight.preset': 'pilot' });
    vi.stubGlobal('localStorage', store);
    vi.resetModules();
    const a = await import('./flightPreset');
    expect(a.activeFlightPreset().id).toBe('pilot');
    store.data['os.flight.preset'] = 'newtonian';
    expect(a.activeFlightPreset().id).toBe('pilot');
  });
});
