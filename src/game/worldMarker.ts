/**
 * World-locked HUD markers, damped in WORLD space (v3 PLAN A8 / H1).
 *
 * v2 damped the projected marker in screen space, so every camera rotation —
 * a turn, the chase aim, a frame of shake — dragged the marker off its point
 * and it swam against the stars. Here the filter runs on a world direction
 * (or a point held at its exact range) and the caller projects the result
 * through the camera every frame. A camera that only rotates cannot move a
 * marker off the thing it marks. Pure and allocation-free.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Approach rate, 1/s, for prograde/retrograde: what v2's screen damper used. */
export const MARKER_LAMBDA = 12;
/** Approach rate, 1/s, for target and contact brackets. */
export const BRACKET_LAMBDA = 14;

function normalise(v: Vec3): void {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l > 1e-300) {
    v.x /= l;
    v.y /= l;
    v.z /= l;
  }
}

/**
 * Rotate unit `cur` towards unit `target` so the angle between them decays as
 * e^(−λ·dt): a slerp by angle, so splitting a frame changes nothing. An
 * (almost) antipodal target has no defined short way round; take it outright.
 * Writes `cur` in place and returns it.
 */
export function dampDirection(cur: Vec3, target: Vec3, lambda: number, dt: number): Vec3 {
  if (!(dt > 0)) return cur;
  const dot = Math.max(-1, Math.min(1, cur.x * target.x + cur.y * target.y + cur.z * target.z));
  if (dot < -0.9999) {
    cur.x = target.x;
    cur.y = target.y;
    cur.z = target.z;
    return cur;
  }
  const theta = Math.acos(dot);
  if (theta < 1e-12) return cur;
  const remain = theta * Math.exp(-lambda * dt);
  // Slerp weights for moving from cur to target by (theta − remain).
  const s = Math.sin(theta);
  const wCur = Math.sin(remain) / s;
  const wTgt = Math.sin(theta - remain) / s;
  cur.x = cur.x * wCur + target.x * wTgt;
  cur.y = cur.y * wCur + target.y * wTgt;
  cur.z = cur.z * wCur + target.z * wTgt;
  normalise(cur);
  return cur;
}

/** A marker at infinity: prograde, retrograde. `dir` is unit, world space. */
export class WorldMarker {
  readonly dir: Vec3 = { x: 0, y: 0, z: -1 };
  private live = false;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly lambda = MARKER_LAMBDA) {}

  /** Feed the true direction (any length); returns the damped unit direction. */
  step(target: Vec3, dt: number): Vec3 {
    const t = this.tmp;
    t.x = target.x;
    t.y = target.y;
    t.z = target.z;
    normalise(t);
    if (!this.live) {
      this.dir.x = t.x;
      this.dir.y = t.y;
      this.dir.z = t.z;
      this.live = true;
      return this.dir;
    }
    return dampDirection(this.dir, t, this.lambda, dt);
  }

  /** Forget the history: the next step starts exactly on its direction. */
  reset(): void {
    this.live = false;
  }
}

/**
 * A marker on a point at finite range: the direction FROM THE SHIP is damped,
 * the range is always exact. The camera is not involved, so neither its
 * rotation nor its lag or shake can move the marker off the point.
 */
export class WorldPointMarker {
  private readonly marker: WorldMarker;
  private range = 0;
  private readonly rel: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(lambda = BRACKET_LAMBDA) {
    this.marker = new WorldMarker(lambda);
  }

  step(origin: Vec3, target: Vec3, dt: number): void {
    const r = this.rel;
    r.x = target.x - origin.x;
    r.y = target.y - origin.y;
    r.z = target.z - origin.z;
    this.range = Math.hypot(r.x, r.y, r.z);
    if (this.range > 0) this.marker.step(r, dt);
  }

  /** The marked point, for this frame's projection. */
  point<T extends Vec3>(origin: Vec3, out: T): T {
    const d = this.marker.dir;
    out.x = origin.x + d.x * this.range;
    out.y = origin.y + d.y * this.range;
    out.z = origin.z + d.z * this.range;
    return out;
  }

  reset(): void {
    this.marker.reset();
  }
}
