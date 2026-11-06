/**
 * The Yard's orbit camera, as plain numbers.
 *
 * Every value the player sees moves on a critically damped spring
 * (ARCHITECTURE §6: nothing snaps). The spring is integrated ANALYTICALLY, not
 * with an Euler step: the closed form for a critically damped oscillator is
 * exact for any dt, so a 15 fps frame and four 60 fps frames land in the same
 * place, and a long frame can never make the camera overshoot or explode.
 *
 *   x(t) = (x0 + (v0 + ω·x0)·t) · e^(−ωt)        (x measured from the target)
 *   v(t) = (v0 − ω·(v0 + ω·x0)·t) · e^(−ωt)
 *
 * ω is the only tuning knob: the response reaches ~95% of a step in 4.7/ω s.
 * Pure TypeScript — no three — so it is tested in node and allocates nothing.
 */

export class Damped {
  value: number;
  target: number;
  velocity = 0;

  constructor(
    initial: number,
    /** Natural frequency, rad/s. */
    public omega: number,
  ) {
    this.value = initial;
    this.target = initial;
  }

  step(dt: number): void {
    if (dt <= 0) return;
    const w = this.omega;
    const x = this.value - this.target;
    const k = this.velocity + w * x;
    const e = Math.exp(-w * dt);
    this.value = this.target + (x + k * dt) * e;
    this.velocity = (this.velocity - w * k * dt) * e;
  }

  /** Jump straight to `v` and stop — only while the frame is dark (a ship swap). */
  snap(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }
}

/** Short of the pole: at ±90° the orbit's yaw axis degenerates and the horizon flips. */
export const PITCH_LIMIT = 1.45;

/** Radians of orbit per pixel of drag. ~0.34°/px: a full turn is a long sweep across a laptop. */
const DRAG_RAD_PER_PX = 0.006;
/** Per wheel notch. Multiplicative so the feel is the same for a shuttle and a capital. */
const ZOOM_STEP = 1.12;

export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

export class OrbitController {
  readonly yaw = new Damped(0, 10);
  readonly pitch = new Damped(0.25, 10);
  readonly distance = new Damped(1, 8);
  readonly fov = new Damped(24, 6);
  /** The point orbited, world km. Damped so a bookmark's re-aim glides. */
  readonly centre: readonly [Damped, Damped, Damped] = [new Damped(0, 6), new Damped(0, 6), new Damped(0, 6)];

  private minDistance = 1e-4;
  private maxDistance = 1e6;

  setLimits(min: number, max: number): void {
    this.minDistance = Math.max(1e-6, min);
    this.maxDistance = Math.max(this.minDistance, max);
    this.distance.target = clamp(this.distance.target, this.minDistance, this.maxDistance);
  }

  /** Pointer drag in CSS pixels. Right drags the ship right; down looks from above. */
  drag(dxPx: number, dyPx: number): void {
    this.yaw.target -= dxPx * DRAG_RAD_PER_PX;
    this.pitch.target = clamp(this.pitch.target + dyPx * DRAG_RAD_PER_PX, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Wheel notches; positive is out. */
  zoom(steps: number): void {
    this.distance.target = clamp(
      this.distance.target * Math.pow(ZOOM_STEP, steps),
      this.minDistance,
      this.maxDistance,
    );
  }

  /**
   * Aim the orbit so the eye lies along (x, y, z) from the centre. Yaw takes
   * the short way round from where the camera is now — a bookmark should
   * swing ninety degrees, never two hundred and seventy.
   */
  lookFrom(x: number, y: number, z: number, immediate: boolean): void {
    const len = Math.hypot(x, y, z);
    if (len < 1e-12) return;
    let yaw = Math.atan2(x, z);
    const pitch = clamp(Math.asin(clamp(y / len, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT);
    const from = this.yaw.value;
    yaw += Math.round((from - yaw) / (Math.PI * 2)) * Math.PI * 2;
    if (immediate) {
      this.yaw.snap(yaw);
      this.pitch.snap(pitch);
    } else {
      this.yaw.target = yaw;
      this.pitch.target = pitch;
    }
  }

  update(dt: number): void {
    this.yaw.step(dt);
    this.pitch.step(dt);
    this.distance.step(dt);
    this.fov.step(dt);
    this.centre[0].step(dt);
    this.centre[1].step(dt);
    this.centre[2].step(dt);
  }

  /** Unit direction from the centre to the eye, from the CURRENT (damped) values. */
  direction(out: Vec3Out): Vec3Out {
    const cp = Math.cos(this.pitch.value);
    out.x = cp * Math.sin(this.yaw.value);
    out.y = Math.sin(this.pitch.value);
    out.z = cp * Math.cos(this.yaw.value);
    return out;
  }

  /** The eye position, world km. */
  eye(out: Vec3Out): Vec3Out {
    this.direction(out);
    const d = this.distance.value;
    out.x = this.centre[0].value + out.x * d;
    out.y = this.centre[1].value + out.y * d;
    out.z = this.centre[2].value + out.z * d;
    return out;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
