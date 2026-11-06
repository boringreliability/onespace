/**
 * ResolutionGovernor — holds the frame rate by trading pixels.
 *
 * Fed the wall-clock interval between frames. That is the one number that
 * includes the GPU: timing `step()` measures only CPU work and command
 * submission, because the GPU runs asynchronously after the call returns. v1
 * did exactly that, read 1-3 ms on a 112 ms frame, and never moved.
 *
 * Shape of the controller:
 * - Samples are averaged over a window. Every change reallocates the post
 *   stack's render targets, so the scale may move at most once per window.
 * - Down is fast and proportional (pixel cost is ~area, so scale goes with
 *   sqrt of the overshoot). Up is slow, small, and waits out a cooldown after
 *   any drop — rising straight back into the load that caused the drop is how
 *   a controller oscillates.
 * - Between the two thresholds it holds still. With vsync a frame is either
 *   one or two refresh intervals; a dead band is what stops it chattering.
 * - A sample over `spikeMs` is a tab switch, a GC or a shader compile, not
 *   load. It is dropped rather than averaged in.
 */

export interface GovernorConfig {
  readonly targetMs: number;
  readonly minScale: number;
  readonly maxScale: number;
  /** Average frame time above target × this lowers the scale. */
  readonly downRatio: number;
  /** Average frame time below target × this may raise the scale. */
  readonly upRatio: number;
  /** Largest single drop. */
  readonly maxDownStep: number;
  readonly upStep: number;
  readonly windowMs: number;
  /** Minimum wait after a drop before any rise. */
  readonly upCooldownMs: number;
  readonly spikeMs: number;
}

export const GOVERNOR_DEFAULTS: GovernorConfig = {
  targetMs: 1000 / 60,
  minScale: 0.5,
  maxScale: 1,
  downRatio: 1.2,
  upRatio: 1.05,
  maxDownStep: 0.15,
  upStep: 0.05,
  windowMs: 500,
  upCooldownMs: 3000,
  spikeMs: 250,
};

export class ResolutionGovernor {
  readonly config: GovernorConfig;
  scale: number;

  private windowSum = 0;
  private windowCount = 0;
  private sinceDropMs = Infinity;

  constructor(config: Partial<GovernorConfig> = {}) {
    this.config = { ...GOVERNOR_DEFAULTS, ...config };
    this.scale = this.config.maxScale;
  }

  /** Feed one frame interval in ms. Returns true when `scale` changed. */
  sample(frameMs: number): boolean {
    const c = this.config;
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > c.spikeMs) return false;

    this.windowSum += frameMs;
    this.windowCount++;
    this.sinceDropMs += frameMs;
    if (this.windowSum < c.windowMs) return false;

    const avg = this.windowSum / this.windowCount;
    this.windowSum = 0;
    this.windowCount = 0;

    let next = this.scale;
    if (avg > c.targetMs * c.downRatio) {
      // Pixel cost scales with area, i.e. with scale²: to bring avg back to
      // target, multiply scale by sqrt(target/avg). Clamp the step so one bad
      // window cannot halve the image.
      const ideal = this.scale * Math.sqrt(c.targetMs / avg);
      next = Math.max(ideal, this.scale - c.maxDownStep);
    } else if (avg < c.targetMs * c.upRatio && this.sinceDropMs >= c.upCooldownMs) {
      next = this.scale + c.upStep;
    }

    next = Math.min(c.maxScale, Math.max(c.minScale, next));
    if (Math.abs(next - this.scale) < 1e-6) return false;
    if (next < this.scale) this.sinceDropMs = 0;
    this.scale = next;
    return true;
  }
}
