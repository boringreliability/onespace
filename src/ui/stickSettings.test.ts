/**
 * Mouse settings shown in the pause overlay.
 *
 * The virtual stick itself is another module's; this file only owns the two
 * localStorage keys it reads, so the overlay can show and write them. Stored
 * values come from the player's own browser but are still parsed defensively:
 * a bad number here becomes an unflyable ship there.
 */

import { describe, expect, it } from 'vitest';

import {
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  STICK_DEFAULTS,
  STICK_INVERT_KEY,
  STICK_SENSITIVITY_KEY,
  loadStickSettings,
  saveStickSettings,
} from './stickSettings';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

describe('stick settings', () => {
  it('Given the agreed key names, Then they are os.stick.sensitivity and os.stick.invertY', () => {
    expect(STICK_SENSITIVITY_KEY).toBe('os.stick.sensitivity');
    expect(STICK_INVERT_KEY).toBe('os.stick.invertY');
  });

  it('Given nothing stored, Then the defaults are sensitivity 1 and no inversion', () => {
    expect(loadStickSettings(new MemoryStorage())).toEqual(STICK_DEFAULTS);
    expect(STICK_DEFAULTS).toEqual({ sensitivity: 1, invertY: false });
  });

  it('Given saved settings, When reloaded, Then they round-trip', () => {
    const s = new MemoryStorage();
    saveStickSettings(s, { sensitivity: 1.75, invertY: true });
    expect(s.getItem(STICK_SENSITIVITY_KEY)).toBe('1.75');
    expect(s.getItem(STICK_INVERT_KEY)).toBe('true');
    expect(loadStickSettings(s)).toEqual({ sensitivity: 1.75, invertY: true });
  });

  it('Given an out-of-range or non-numeric sensitivity, Then it is clamped or defaulted', () => {
    const s = new MemoryStorage();
    s.setItem(STICK_SENSITIVITY_KEY, '99');
    expect(loadStickSettings(s).sensitivity).toBe(SENSITIVITY_MAX);
    s.setItem(STICK_SENSITIVITY_KEY, '0');
    expect(loadStickSettings(s).sensitivity).toBe(SENSITIVITY_MIN);
    s.setItem(STICK_SENSITIVITY_KEY, 'banana');
    expect(loadStickSettings(s).sensitivity).toBe(1);
  });

  it('Given an invertY that is not exactly "true", Then it is false', () => {
    const s = new MemoryStorage();
    for (const v of ['1', 'yes', 'TRUE', '']) {
      s.setItem(STICK_INVERT_KEY, v);
      expect(loadStickSettings(s).invertY).toBe(false);
    }
  });

  it('Given no or throwing storage, Then load returns the defaults and save does not throw', () => {
    const throwing = {
      getItem(): string | null {
        throw new Error('SecurityError');
      },
      setItem(): void {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadStickSettings(null)).toEqual(STICK_DEFAULTS);
    expect(loadStickSettings(throwing)).toEqual(STICK_DEFAULTS);
    expect(() => saveStickSettings(throwing, { sensitivity: 2, invertY: true })).not.toThrow();
  });
});
