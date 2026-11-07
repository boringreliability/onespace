/**
 * The module → mode table (docs/v2/SHOWROOM.md §3, "Gating i Engine").
 *
 * Applied BY NAME after registration rather than written into each class, so
 * the modules themselves — several of them owned by other tracks — need no
 * edit, and the whole policy is readable in one place.
 *
 * Deviation from the SHOWROOM.md table, on purpose: the flight modules also
 * live in `map` and `review`, not in `flight` alone.
 *  - review: a `live` shot (`game-opening`, the HUD frames) wants the running
 *    game, and a non-live shot is already stood down by `shotOwnsScene()`
 *    inside each module. Gating them off in review would break the first and
 *    change nothing for the second.
 *  - map: v1's chart is a PAUSE (`Universe.paused`), and MapMode drives the
 *    StarMap from its own update. Nothing enters the `map` mode yet; when
 *    something does, it must find flight exactly as v1 left it.
 * So in v2-p2b the one mode that actually freezes flight is `yard` (plus
 * `title`/`boot`, which nothing boots into yet).
 *
 * Modules absent from the table are always on: log, audio, codex, sky (its
 * subject is hidden by the stage's isolation; its clock costs nothing), the
 * shot driver and the review guard (which owns HUD visibility per mode).
 */

import type { Mode } from '@/core/Modes';

// v2 merge: `boot` and `title` too. Engine.prewarm() steps one frame in
// `boot` so Universe acquires the home planet before programs are compiled —
// with Universe asleep there, the planet was never built. And the title screen
// sits over the LIVE opening frame (the world drifting behind the menu); with
// flight asleep it was a still image. Title owns the keyboard while shown, so
// the pilot behind it cannot be flown by accident.
const FLIGHT: readonly Mode[] = ['boot', 'title', 'flight', 'map', 'review'];
/** Player-facing flight aids: never over the title, the Yard or a shot. */
const PILOTING: readonly Mode[] = ['flight', 'map'];

export const MODULE_MODES: Readonly<Record<string, readonly Mode[]>> = {
  universe: FLIGHT,
  pilot: FLIGHT,
  traffic: FLIGHT,
  cruise: FLIGHT,
  scanner: FLIGHT,
  warp: FLIGHT,
  hud: FLIGHT,
  'map-mode': FLIGHT,
  'system-map': FLIGHT,
  showroom: ['yard', 'review'],
  yard: ['yard'],
  gallery: ['review'],
  // v2 phase 1 modules (merged after this table was written).
  targeting: FLIGHT,
  instruments: FLIGHT,
  hints: PILOTING,
  pause: ['flight'],
  recovery: PILOTING,
  // v2 phase 4.
  autopilot: PILOTING,
  'time-compression': PILOTING,
};

/**
 * Stamp `activeIn` onto registered modules. `GameModule.activeIn` is readonly
 * to everyone else; this is the one writer, run once at boot.
 */
export function applyGating(modules: Iterable<{ readonly name: string; readonly activeIn?: readonly Mode[] }>): void {
  for (const m of modules) {
    const on = MODULE_MODES[m.name];
    if (on) (m as { activeIn?: readonly Mode[] }).activeIn = on;
  }
}
