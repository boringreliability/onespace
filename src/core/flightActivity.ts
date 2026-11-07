/**
 * [v3-T1] What the ship is doing, as plain flags — read by the engine's
 * resolution governor and the camera's FOV policy without either importing
 * the cruise or autopilot modules.
 *
 * Writers: Pilot (cruise, from FlightModel.cruising, as a fallback), and the
 * owners of cruise and the autopilot when they choose to (one assignment a
 * frame). Readers never write.
 */
export const flightActivity = {
  /** The autopilot is flying the ship. */
  autopilot: false,
  /** The cruise drive is spooling, cruising or dropping. */
  cruise: false,
  /** 0..1: how far the cruise drive is spooled (drives FOV breathing). */
  cruiseSpool: 0,
};
