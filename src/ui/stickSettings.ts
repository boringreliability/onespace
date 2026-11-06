/**
 * Mouse-stick settings: the single source for their localStorage contract.
 *
 *   os.stick.sensitivity — multiplier, decimal string, default 1, clamped [0.25, 4]
 *   os.stick.invertY     — 'true' | 'false', default false
 *
 * The pause overlay writes these; the virtual stick reads them. Parsed
 * defensively: a bad number here is an unflyable ship there.
 */

import type { KeyValueStore } from '@/ui/hintRules';

export const STICK_SENSITIVITY_KEY = 'os.stick.sensitivity';
export const STICK_INVERT_KEY = 'os.stick.invertY';

export const SENSITIVITY_MIN = 0.25;
export const SENSITIVITY_MAX = 4;

export interface StickSettings {
  readonly sensitivity: number;
  readonly invertY: boolean;
}

export const STICK_DEFAULTS: StickSettings = Object.freeze({ sensitivity: 1, invertY: false });

function read(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

export function clampSensitivity(v: number): number {
  if (!Number.isFinite(v)) return STICK_DEFAULTS.sensitivity;
  return v < SENSITIVITY_MIN ? SENSITIVITY_MIN : v > SENSITIVITY_MAX ? SENSITIVITY_MAX : v;
}

export function loadStickSettings(store: KeyValueStore | null): StickSettings {
  if (!store) return STICK_DEFAULTS;
  const s = read(store, STICK_SENSITIVITY_KEY);
  const i = read(store, STICK_INVERT_KEY);
  const n = s === null || s.trim() === '' ? Number.NaN : Number(s);
  return {
    sensitivity: Number.isNaN(n) ? STICK_DEFAULTS.sensitivity : clampSensitivity(n),
    invertY: i === 'true',
  };
}

export function saveStickSettings(store: KeyValueStore | null, settings: StickSettings): void {
  if (!store) return;
  try {
    store.setItem(STICK_SENSITIVITY_KEY, String(clampSensitivity(settings.sensitivity)));
    store.setItem(STICK_INVERT_KEY, settings.invertY ? 'true' : 'false');
  } catch {
    // Blocked or full storage: the setting lasts this session only.
  }
}
