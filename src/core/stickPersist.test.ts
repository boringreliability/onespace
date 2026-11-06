/**
 * Mouse-stick settings persisted in localStorage.
 *
 * Storage contract (shared with the pause UI, Track D): two keys,
 *   `os.stick.sensitivity`  a decimal multiplier, default 1, clamped [0.25, 4]
 *   `os.stick.invertY`      the literal string 'true' or 'false'
 *
 * localStorage is user-writable and survives across builds, so whatever comes
 * out of it is untrusted text. Parsing is whitelist-only: exact formats, no
 * coercion, anything unrecognised falls back to that key's default.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STICK_SETTINGS,
  STICK_INVERT_Y_KEY,
  STICK_SENSITIVITY_KEY,
  STICK_SENSITIVITY_MAX,
  STICK_SENSITIVITY_MIN,
  loadStickSettings,
  parseStickSettings,
  saveStickSettings,
} from './stick';

describe('stick settings: the storage contract', () => {
  it('Given the contract, Then the keys are os.stick.sensitivity and os.stick.invertY', () => {
    expect(STICK_SENSITIVITY_KEY).toBe('os.stick.sensitivity');
    expect(STICK_INVERT_Y_KEY).toBe('os.stick.invertY');
  });

  it('Given the contract, Then sensitivity is clamped to [0.25, 4] and defaults to 1 with Y not inverted', () => {
    expect(STICK_SENSITIVITY_MIN).toBe(0.25);
    expect(STICK_SENSITIVITY_MAX).toBe(4);
    expect(DEFAULT_STICK_SETTINGS).toEqual({ sensitivity: 1, invertY: false });
  });
});

describe('parseStickSettings', () => {
  it('Given nothing stored, Then the defaults are returned', () => {
    expect(parseStickSettings(null, null)).toEqual(DEFAULT_STICK_SETTINGS);
    expect(parseStickSettings(undefined, undefined)).toEqual(DEFAULT_STICK_SETTINGS);
    expect(parseStickSettings('', '')).toEqual(DEFAULT_STICK_SETTINGS);
  });

  it('Given valid values, Then both are taken', () => {
    expect(parseStickSettings('1.5', 'true')).toEqual({ sensitivity: 1.5, invertY: true });
    expect(parseStickSettings('0.5', 'false')).toEqual({ sensitivity: 0.5, invertY: false });
  });

  it('Given only one key stored, Then the other keeps its default', () => {
    expect(parseStickSettings(null, 'true')).toEqual({ sensitivity: 1, invertY: true });
    expect(parseStickSettings('2', null)).toEqual({ sensitivity: 2, invertY: false });
  });

  it('Given a sensitivity outside the range, Then it is clamped into it', () => {
    expect(parseStickSettings('1000', null).sensitivity).toBe(4);
    expect(parseStickSettings('0.01', null).sensitivity).toBe(0.25);
  });

  it('Given a sensitivity that is not a plain positive decimal, Then the default is used (no coercion)', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', '-1', '0', '1e3', '0x2', ' 2', '2px', '{}', 'true', '<script>']) {
      expect(parseStickSettings(bad, null).sensitivity, `sensitivity "${bad}"`).toBe(1);
    }
  });

  it('Given invertY that is not exactly "true" or "false", Then the default is used (no truthiness)', () => {
    for (const bad of ['1', 'yes', 'TRUE', 'True', ' true', 'null', '{}']) {
      expect(parseStickSettings(null, bad).invertY, `invertY "${bad}"`).toBe(false);
    }
  });

  it('Given any input, Then only the two whitelisted fields come out', () => {
    expect(Object.keys(parseStickSettings('2', 'true')).sort()).toEqual(['invertY', 'sensitivity']);
  });
});

describe('load/save against storage', () => {
  function memoryStorage(): {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    data: Map<string, string>;
  } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
    };
  }

  it('Given no storage at all, Then load returns the defaults and save reports false', () => {
    expect(loadStickSettings(null)).toEqual(DEFAULT_STICK_SETTINGS);
    expect(saveStickSettings(null, DEFAULT_STICK_SETTINGS)).toBe(false);
  });

  it('Given storage that throws on read (private mode, blocked site data), Then load returns the defaults and does not throw', () => {
    const throwing = {
      getItem(): string | null {
        throw new Error('SecurityError');
      },
    };
    expect(() => loadStickSettings(throwing)).not.toThrow();
    expect(loadStickSettings(throwing)).toEqual(DEFAULT_STICK_SETTINGS);
  });

  it('Given storage that throws on write (quota), Then save reports false and does not throw', () => {
    const throwing = {
      setItem(): void {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveStickSettings(throwing, DEFAULT_STICK_SETTINGS)).not.toThrow();
    expect(saveStickSettings(throwing, DEFAULT_STICK_SETTINGS)).toBe(false);
  });

  it('Given working storage, When saved, Then both keys hold the contract format', () => {
    const st = memoryStorage();
    expect(saveStickSettings(st, { sensitivity: 1.25, invertY: true })).toBe(true);
    expect(st.data.get('os.stick.sensitivity')).toBe('1.25');
    expect(st.data.get('os.stick.invertY')).toBe('true');
  });

  it('Given working storage, When saved and loaded, Then the settings round-trip', () => {
    const st = memoryStorage();
    saveStickSettings(st, { sensitivity: 0.75, invertY: false });
    expect(loadStickSettings(st)).toEqual({ sensitivity: 0.75, invertY: false });
  });

  it('Given garbage under the keys, Then load returns the defaults', () => {
    const st = memoryStorage();
    st.setItem('os.stick.sensitivity', '{{{garbage');
    st.setItem('os.stick.invertY', 'maybe');
    expect(loadStickSettings(st)).toEqual(DEFAULT_STICK_SETTINGS);
  });

  it('Given an out-of-range sensitivity handed to save, Then what is stored is already clamped', () => {
    const st = memoryStorage();
    saveStickSettings(st, { sensitivity: 100, invertY: false });
    expect(st.data.get(STICK_SENSITIVITY_KEY)).toBe(String(STICK_SENSITIVITY_MAX));
    saveStickSettings(st, { sensitivity: 0.01, invertY: false });
    expect(st.data.get(STICK_SENSITIVITY_KEY)).toBe(String(STICK_SENSITIVITY_MIN));
  });
});
