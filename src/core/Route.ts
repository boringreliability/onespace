/**
 * URL parameters → typed overrides.
 *
 * Whitelist only. A value that is not exactly one the game knows is dropped,
 * never passed through, so a link cannot smuggle arbitrary data into the
 * engine. Pure: takes the query string, returns plain data.
 */

import type { QualityTier } from './Config';

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export interface DevParams {
  /** Force a quality tier instead of guessing from the GPU string. */
  readonly tier?: QualityTier;
  /** Force a device pixel ratio cap, 0 < dpr ≤ 3. */
  readonly dpr?: number;
}

/** Strict decimal: digits with an optional fraction. No exponents, no signs. */
const DECIMAL = /^\d+(\.\d+)?$/;

export function parseDevParams(search: string): DevParams {
  const q = new URLSearchParams(search);
  const out: { tier?: QualityTier; dpr?: number } = {};

  const tier = q.get('tier');
  if (tier !== null && (TIERS as readonly string[]).includes(tier)) out.tier = tier as QualityTier;

  const dpr = q.get('dpr');
  if (dpr !== null && DECIMAL.test(dpr)) {
    const v = Number(dpr);
    if (v > 0 && v <= 3) out.dpr = v;
  }
  return out;
}
