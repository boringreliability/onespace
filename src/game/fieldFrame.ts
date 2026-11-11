/**
 * v4 mining — the field frame (owner decision: fly among the rocks).
 *
 * A belt field has no SOI, so a ship at a field flies in the star's frame and
 * every FA reference (lever hold, detent, Space-stop) and the VEL readout
 * would be measured against the star: a small W sheds the field's ~18 km/s
 * and the rocks slide away. Within FIELD_FRAME_KM of the nearest field's
 * centre the FA and the glass are referenced to the field instead.
 * Pure: no three.js, no bus.
 */

/** Enter the field frame at this centre distance or closer, km. */
export const FIELD_FRAME_KM = 300;
/** Leave it only beyond this centre distance, km (hysteresis). */
export const FIELD_FRAME_EXIT_KM = 330;

/**
 * Whether the ship is in the field frame now, given whether it was and its
 * distance to the nearest field's centre. Limits inclusive; NaN / ∞ never in.
 */
export function fieldFrameHeld(wasIn: boolean, centreDistanceKm: number): boolean {
  if (!Number.isFinite(centreDistanceKm)) return false;
  return centreDistanceKm <= (wasIn ? FIELD_FRAME_EXIT_KM : FIELD_FRAME_KM);
}
