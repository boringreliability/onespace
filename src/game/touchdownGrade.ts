/**
 * The touchdown line (v3 polish, D22a). Pure.
 *
 * Graded on the worse of the sink rate and the slip against the ground —
 * a hull set down gently while the world slides past at 22 m/s has not
 * landed cleanly — with the v2 thresholds: < 2 m/s CLEAN, < 8 m/s plain,
 * else HARD. The sink rate is always quoted; a slip of 1 m/s or more is named.
 */

export interface TouchdownLine {
  text: string;
  tone: 'good' | 'warn';
}

const CLEAN_MS = 2;
const HARD_MS = 8;
const SKID_NAMED_MS = 1;

export function touchdownGrade(verticalKmS: number, slipKmS: number): TouchdownLine {
  const down = Number.isFinite(verticalKmS) ? Math.abs(verticalKmS) * 1000 : 0;
  const skid = Number.isFinite(slipKmS) && slipKmS > 0 ? slipKmS * 1000 : 0;
  const worst = Math.max(down, skid);
  const grade = worst < CLEAN_MS ? 'TOUCHDOWN — CLEAN' : worst < HARD_MS ? 'TOUCHDOWN' : 'TOUCHDOWN — HARD';
  const named = skid >= SKID_NAMED_MS ? ` · SKID ${skid.toFixed(0)} M/S` : '';
  return { text: `${grade} · ${down.toFixed(1)} M/S${named}`, tone: worst < HARD_MS ? 'good' : 'warn' };
}
