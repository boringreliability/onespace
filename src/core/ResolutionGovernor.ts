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
 *   load. It is dropped rather than averaged in — unless `spikeRunLimit` of
 *   them arrive back to back. Then it is a GPU that cannot keep up, which is
 *   exactly the case the governor exists for; those count, clamped to
 *   `spikeMs` so one frozen frame cannot dominate the window.
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
  /** Consecutive over-`spikeMs` samples after which they count as load. */
  readonly spikeRunLimit: number;
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
  upCooldownMs: 5000, // [v3-T1] was 3000; matches GOVERNOR_UP_STABLE_MS
  spikeMs: 250,
  spikeRunLimit: 3,
};

// --- [v3-T1] hysteresis ------------------------------------------------------
// Every step reallocates the post stack's targets and costs a 56-67 ms frame
// (8 of 8 steps during an auto-land, docs/v3/PLAN.md §1). Steps are therefore
// rationed: never closer than 2 s, rises only after 5 s of steady fast frames,
// and no rise at all while the autopilot or cruise is flying.

export const GOVERNOR_MIN_STEP_INTERVAL_MS = 2000;
export const GOVERNOR_UP_STABLE_MS = 5000;

export interface GovernorStepQuery {
  readonly direction: 'up' | 'down';
  /** Wall time since the last change of scale, ms (Infinity if none). */
  readonly sinceLastStepMs: number;
  /** Wall time the frame rate has been continuously under the up threshold, ms. */
  readonly stableMs: number;
  /** True while the autopilot or cruise is active: rises wait. */
  readonly holdUp: boolean;
}

/** May the governor take the step it wants? */
export function governorShouldStep(q: GovernorStepQuery): boolean {
  if (!(q.sinceLastStepMs >= GOVERNOR_MIN_STEP_INTERVAL_MS)) return false;
  if (q.direction === 'down') return true;
  return !q.holdUp && q.stableMs >= GOVERNOR_UP_STABLE_MS;
}
// --- [/v3-T1] ------------------------------------------------------------------

export class ResolutionGovernor {
  readonly config: GovernorConfig;
  scale: number;

  private windowSum = 0;
  private windowCount = 0;
  private sinceDropMs = Infinity;
  private spikeRun = 0;
  /** Window average that triggered the last drop; null after any rise. */
  private avgAtLastDrop: number | null = null;
  /** [v3-T1] Wall time since the last change of scale, ms. */
  private sinceStepMs = Infinity;
  /** [v3-T1] Wall time of consecutive windows under the up threshold, ms. */
  private stableMs = 0;
  /** [v3-T1] Longest frame in the current window, ms. */
  private windowMax = 0;

  constructor(config: Partial<GovernorConfig> = {}) {
    this.config = { ...GOVERNOR_DEFAULTS, ...config };
    this.scale = this.config.maxScale;
  }

  /** Feed one frame interval in ms. Returns true when `scale` changed. */
  sample(frameMs: number, holdUp = false): boolean {
    const c = this.config;
    if (!Number.isFinite(frameMs) || frameMs <= 0) return false;
    // [v3-T1] Real wall time, before any spike clamp: a 400 ms frame is 400 ms.
    this.sinceStepMs += frameMs;
    if (frameMs > c.spikeMs) {
      // A lone long interval is a hitch. A run of them is a 3 fps GPU: v2.0
      // dropped every one and so held full scale on the slowest machines.
      if (++this.spikeRun < c.spikeRunLimit) return false;
      frameMs = c.spikeMs;
    } else {
      this.spikeRun = 0;
    }

    this.windowSum += frameMs;
    this.windowCount++;
    if (frameMs > this.windowMax) this.windowMax = frameMs;
    this.sinceDropMs += frameMs;
    if (this.windowSum < c.windowMs) return false;

    const avg = this.windowSum / this.windowCount;
    // [v3-T1] Stability is counted in whole windows under the up threshold
    // that held no frame of real load (> 2.5 × target; a lone vsync miss at
    // 2 × target is not load, or a machine that misses one would never rise).
    if (avg < c.targetMs * c.upRatio && this.windowMax <= c.targetMs * 2.5) this.stableMs += this.windowSum;
    else this.stableMs = 0;
    this.windowMax = 0;
    this.windowSum = 0;
    this.windowCount = 0;

    let next = this.scale;
    if (avg > c.targetMs * c.downRatio) {
      // Pixel cost scales with area, i.e. with scale²: to bring avg back to
      // target, multiply scale by sqrt(target/avg). Clamp the step so one bad
      // window cannot halve the image.
      //
      // But only if the last drop bought anything. On a display capped at
      // 30 Hz every frame is 33 ms however few pixels are drawn; when the
      // average is unchanged (±5 %) since the last drop, pixels are not the
      // bottleneck and dropping more would only blur the image for nothing.
      // A load that got WORSE since then is new information, so it may drop.
      const prev = this.avgAtLastDrop;
      // Only plausible for a refresh cap (≤ 2.5 × target, i.e. 24-30 Hz and
      // up); a machine at 5 fps is better served blurry than unplayable.
      const futile =
        prev !== null && avg <= c.targetMs * 2.5 && Math.abs(avg - prev) < prev * 0.05;
      if (!futile && governorShouldStep(this.query('down', holdUp))) {
        const ideal = this.scale * Math.sqrt(c.targetMs / avg);
        next = Math.max(ideal, this.scale - c.maxDownStep);
      }
    } else if (
      avg < c.targetMs * c.upRatio &&
      this.sinceDropMs >= c.upCooldownMs &&
      governorShouldStep(this.query('up', holdUp))
    ) {
      next = this.scale + c.upStep;
    }

    next = Math.min(c.maxScale, Math.max(c.minScale, next));
    if (Math.abs(next - this.scale) < 1e-6) return false;
    this.sinceStepMs = 0;
    // A rise re-enters load; the next one has to earn its 5 s again.
    this.stableMs = 0;
    if (next < this.scale) {
      this.sinceDropMs = 0;
      this.avgAtLastDrop = avg;
    } else {
      this.avgAtLastDrop = null;
    }
    this.scale = next;
    return true;
  }

  private readonly q: { direction: 'up' | 'down'; sinceLastStepMs: number; stableMs: number; holdUp: boolean } = {
    direction: 'down',
    sinceLastStepMs: 0,
    stableMs: 0,
    holdUp: false,
  };

  private query(direction: 'up' | 'down', holdUp: boolean): GovernorStepQuery {
    const q = this.q;
    q.direction = direction;
    q.sinceLastStepMs = this.sinceStepMs;
    q.stableMs = this.stableMs;
    q.holdUp = holdUp;
    return q;
  }
}
