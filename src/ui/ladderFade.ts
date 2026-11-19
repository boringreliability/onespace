/**
 * Pitch ladder at rest (v3 PLAN F). The ladder is information only while the
 * attitude is changing; at rest it recedes to a quarter so the hull it is
 * drawn over can be seen, and it returns the moment anything moves. Pure.
 */

export const LADDER_REST_OPACITY = 0.25;
/** Seconds of calm before the ladder starts to recede. */
export const LADDER_CALM_DELAY_S = 1.5;
/** Below these rates the attitude counts as steady, °/s. */
export const LADDER_STEADY_PITCH_DEG_S = 1.5;
export const LADDER_STEADY_ROLL_DEG_S = 3;
/** Recede slowly, return fast. 1/s. */
const LAMBDA_OUT = 1.6;
const LAMBDA_IN = 12;

export interface LadderFadeInput {
  readonly pitchRateDegS: number;
  readonly rollRateDegS: number;
  /** Any rotation input from the pilot this frame. */
  readonly stickActive: boolean;
}

export interface LadderFadeState {
  opacity: number;
  /** Seconds the attitude has been steady with no input. */
  calmFor: number;
}

export function createLadderFade(): LadderFadeState {
  return { opacity: 1, calmFor: 0 };
}

export function stepLadderFade(s: LadderFadeState, i: LadderFadeInput, dt: number): LadderFadeState {
  if (!(dt > 0)) return s;
  const calm =
    !i.stickActive &&
    Math.abs(i.pitchRateDegS) < LADDER_STEADY_PITCH_DEG_S &&
    Math.abs(i.rollRateDegS) < LADDER_STEADY_ROLL_DEG_S;
  s.calmFor = calm ? s.calmFor + dt : 0;
  const resting = s.calmFor >= LADDER_CALM_DELAY_S;
  const target = resting ? LADDER_REST_OPACITY : 1;
  const lambda = resting ? LAMBDA_OUT : LAMBDA_IN;
  s.opacity = target + (s.opacity - target) * Math.exp(-lambda * dt);
  s.opacity = Math.min(1, Math.max(LADDER_REST_OPACITY, s.opacity));
  return s;
}
