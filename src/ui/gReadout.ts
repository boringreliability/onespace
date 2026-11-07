/**
 * The G meter's voice (v3 PLAN F, item 7). The number stays true; what the
 * meter does not do is shout: lower-case unit, one size, and a high load gets
 * the rationed amber accent and nothing louder. Pure.
 */

export type GTone = 'idle' | 'normal' | 'high';

/** At and above this load the reading takes the amber accent. */
export const G_HIGH = 6;
/** Below this the ship is in free fall as far as a pilot is concerned. */
const G_IDLE = 0.05;

export interface GReadout {
  text: string;
  tone: GTone;
}

export function gReadout(g: number): GReadout {
  if (!Number.isFinite(g) || g < 0) return { text: '— g', tone: 'idle' };
  const text = g >= 9.95 ? `${Math.round(g)} g` : `${g.toFixed(1)} g`;
  const tone: GTone = g >= G_HIGH ? 'high' : g < G_IDLE ? 'idle' : 'normal';
  return { text, tone };
}
