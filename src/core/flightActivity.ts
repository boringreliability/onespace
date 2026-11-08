/**
 * [v3-T1] What the ship is doing, as plain flags — read by the engine's
 * resolution governor and the camera's FOV policy without either importing
 * the cruise or autopilot modules.
 *
 * Writers:
 * - the cruise and autopilot modules (`cruise`, `cruiseSpool`, `autopilot`),
 *   one assignment a frame;
 * - Pilot, as a fallback from what FlightModel alone can tell
 *   (`cruiseFallback`, `cruiseSpoolFallback`), so the camera and governor work
 *   even where those modules do not write.
 * Readers use the helpers below and never write.
 */
export const flightActivity = {
  /** The autopilot is flying the ship. */
  autopilot: false,
  /** The cruise drive is spooling, cruising or dropping. */
  cruise: false,
  /** 0..1: how far the cruise drive is spooled (drives FOV breathing). */
  cruiseSpool: 0,
  /** Pilot's fallback: FlightModel is under a cruise ceiling. */
  cruiseFallback: false,
  /** Pilot's fallback spool, eased from `cruiseFallback`. */
  cruiseSpoolFallback: 0,
};

/** Cruise in any phase, by whichever writer knows. */
export function cruiseActive(): boolean {
  return flightActivity.cruise || flightActivity.cruiseFallback;
}

/** 0..1 cruise spool, by whichever writer knows more. */
export function cruiseSpoolNow(): number {
  return Math.max(flightActivity.cruiseSpool, flightActivity.cruiseSpoolFallback);
}

/**
 * [review-v3a] Base modes in which the flight simulation runs — the same list
 * as `universe` in game/gating.ts (tested). The cruise and autopilot modules
 * stop ticking outside it (the Yard), so their flags freeze at whatever they
 * last were: enter the Yard while cruising and the governor held its rises for
 * the whole Yard session.
 */
export const FLIGHT_RUNNING_MODES: readonly string[] = ['boot', 'title', 'flight', 'map', 'review'];

/**
 * The governor holds its rises while something other than the pilot flies.
 * `base` is the current base mode; omitted means "flight is running".
 */
export function governorHoldUp(base?: string): boolean {
  if (base !== undefined && !FLIGHT_RUNNING_MODES.includes(base)) return false;
  return flightActivity.autopilot || cruiseActive();
}
