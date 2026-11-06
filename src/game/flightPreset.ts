/**
 * Flight presets (v2 phase 4, GAMEPLAY P8): the single source for what each
 * one means and for its localStorage contract.
 *
 *   os.flight.preset — 'survey' | 'pilot' | 'newtonian', default 'survey'
 *
 * - SURVEY     FA-ON by default, the auto-land/auto-orbit computer fitted.
 *              The game as the first ten minutes describe it.
 * - PILOT      FA-ON, no autopilot: you land it yourself.
 * - NEWTONIAN  FA-OFF by default (Z still toggles), no autopilot.
 *
 * Crash recovery stays on in all three. A crash has no other consequence model
 * in this game — without the cut the ship would sit in its crater at zero
 * velocity, which is the F6 bug, not a difficulty setting.
 *
 * Parsed through a whitelist: storage is user-writable, and a bad value must
 * come back as the default, never as an unknown preset.
 */

import type { KeyValueStore } from '@/ui/hintRules';

export const FLIGHT_PRESET_KEY = 'os.flight.preset';

export const FLIGHT_PRESET_IDS = ['survey', 'pilot', 'newtonian'] as const;
export type FlightPresetId = (typeof FLIGHT_PRESET_IDS)[number];

export interface FlightPresetSpec {
  readonly id: FlightPresetId;
  /** Shown in the pause sheet and the log. */
  readonly label: string;
  /** Flight assist at load (and when the preset is chosen). */
  readonly flightAssist: boolean;
  /** Whether `L` flies the ship. */
  readonly autopilot: boolean;
  readonly recovery: boolean;
  /** One line for the pause sheet. */
  readonly blurb: string;
}

export const FLIGHT_PRESETS: Readonly<Record<FlightPresetId, FlightPresetSpec>> = Object.freeze({
  survey: {
    id: 'survey',
    label: 'SURVEY',
    flightAssist: true,
    autopilot: true,
    recovery: true,
    blurb: 'ASSIST ON · AUTOPILOT ON L',
  },
  pilot: {
    id: 'pilot',
    label: 'PILOT',
    flightAssist: true,
    autopilot: false,
    recovery: true,
    blurb: 'ASSIST ON · NO AUTOPILOT',
  },
  newtonian: {
    id: 'newtonian',
    label: 'NEWTONIAN',
    flightAssist: false,
    autopilot: false,
    recovery: true,
    blurb: 'ASSIST OFF · NO AUTOPILOT',
  },
});

export const DEFAULT_FLIGHT_PRESET: FlightPresetId = 'survey';

/** Whitelist: one of the three ids exactly, else the default. */
export function parseFlightPreset(raw: unknown): FlightPresetId {
  if (typeof raw !== 'string') return DEFAULT_FLIGHT_PRESET;
  // `includes` on the tuple, not `raw in FLIGHT_PRESETS`: the latter is true
  // for 'constructor' and '__proto__'.
  return (FLIGHT_PRESET_IDS as readonly string[]).includes(raw) ? (raw as FlightPresetId) : DEFAULT_FLIGHT_PRESET;
}

export function loadFlightPreset(store: KeyValueStore | null): FlightPresetId {
  if (!store) return DEFAULT_FLIGHT_PRESET;
  try {
    return parseFlightPreset(store.getItem(FLIGHT_PRESET_KEY));
  } catch {
    return DEFAULT_FLIGHT_PRESET;
  }
}

export function saveFlightPreset(store: KeyValueStore | null, id: FlightPresetId): void {
  if (!store) return;
  try {
    store.setItem(FLIGHT_PRESET_KEY, parseFlightPreset(id));
  } catch {
    // Blocked or full storage: the preset lasts this session only.
  }
}

// ---------------------------------------------------------------------------
// The session's preset. Read lazily, so headless tests never touch storage.
// ---------------------------------------------------------------------------

let current: FlightPresetId | null = null;

/** localStorage, or null where even touching the accessor throws. */
function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The preset in force: the stored one, loaded on first use. */
export function activeFlightPreset(): FlightPresetSpec {
  if (current === null) current = loadFlightPreset(storage());
  return FLIGHT_PRESETS[current];
}

/** Choose a preset for this session and persist it. Returns what was applied. */
export function setActiveFlightPreset(raw: unknown): FlightPresetSpec {
  current = parseFlightPreset(raw);
  saveFlightPreset(storage(), current);
  return FLIGHT_PRESETS[current];
}
