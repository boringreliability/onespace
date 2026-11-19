/**
 * Contact brackets and off-glass chevrons (v3 PLAN F). Pure and
 * allocation-free: the caller owns every array and output object.
 */

/** Vessels within this range get a faint bracket without Tab. */
export const CONTACT_RANGE_KM = 50;
/** Bracket slots in the HUD. */
export const MAX_CONTACT_BRACKETS = 6;

export interface ContactIn {
  readonly id: string;
  /** Position relative to the ship, km, world axes. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/**
 * Indices of the contacts to bracket, nearest first, written into `out`.
 * The nav target is excluded: the target reticle draws it. Returns the count.
 * Insertion sort into at most `max` slots — n is a handful of vessels.
 */
export function selectContacts(
  list: readonly ContactIn[],
  excludeId: string | null,
  out: number[],
  rangeKm = CONTACT_RANGE_KM,
  max = MAX_CONTACT_BRACKETS,
): number {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (excludeId !== null && c.id === excludeId) continue;
    const r = Math.hypot(c.dx, c.dy, c.dz);
    if (!Number.isFinite(r) || r > rangeKm) continue;
    let j = n < max ? n : max;
    if (n >= max) {
      // Full: only enters if nearer than the farthest kept.
      if (r >= rangeOf(list[out[max - 1]!]!)) continue;
      j = max - 1;
    } else {
      n++;
    }
    while (j > 0 && rangeOf(list[out[j - 1]!]!) > r) {
      out[j] = out[j - 1]!;
      j--;
    }
    out[j] = i;
  }
  return n;
}

function rangeOf(c: ContactIn): number {
  return Math.hypot(c.dx, c.dy, c.dz);
}

export interface EdgePlacement {
  x: number;
  y: number;
  /** False when the point was clamped to the margin (draw a chevron). */
  onScreen: boolean;
  /** Direction from the screen centre to the point, degrees, CSS (y down). */
  angleDeg: number;
}

/**
 * Place a projected point on the glass, or on the margin box along the ray
 * from the centre when it is off the glass or behind the camera. A point
 * behind projects mirrored; flipping it makes the chevron point the short
 * way round. A point exactly behind on the axis gets "down".
 */
export function edgePlace(
  x: number,
  y: number,
  behind: boolean,
  w: number,
  h: number,
  margin: number,
  out: EdgePlacement,
): EdgePlacement {
  const cx = w * 0.5;
  const cy = h * 0.5;
  let dx = x - cx;
  let dy = y - cy;
  if (behind) {
    dx = -dx;
    dy = -dy;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
  }
  const mx = Math.max(1, cx - margin);
  const my = Math.max(1, cy - margin);
  out.angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (!behind && Math.abs(dx) <= mx && Math.abs(dy) <= my) {
    out.x = x;
    out.y = y;
    out.onScreen = true;
    return out;
  }
  const s = Math.min(mx / Math.max(Math.abs(dx), 1e-9), my / Math.max(Math.abs(dy), 1e-9));
  out.x = cx + dx * s;
  out.y = cy + dy * s;
  out.onScreen = false;
  return out;
}
