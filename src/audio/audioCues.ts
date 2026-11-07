/**
 * Game state → sound parameters for the flight events that were silent
 * (v3 T4, PLAN E5). Pure; the voices live in Audio.ts.
 */

export type CruisePhaseName = 'idle' | 'spooling' | 'cruise' | 'dropping';
export type CruiseCue = 'spool' | 'engage' | 'drop' | 'abort' | null;

export function cruiseCue(prev: CruisePhaseName, next: CruisePhaseName): CruiseCue {
  if (prev === next) return null;
  if (next === 'spooling') return 'spool';
  if (next === 'cruise') return 'engage';
  if (next === 'dropping') return 'drop';
  if (next === 'idle' && prev === 'spooling') return 'abort';
  return null;
}

export interface Thud {
  readonly gain: number;
  readonly freqHz: number;
}

/** Touchdown, vertical impact in km/s. */
export function touchdownThud(verticalKmS: number): Thud {
  if (!Number.isFinite(verticalKmS) || verticalKmS <= 0) return { gain: 0, freqHz: 60 };
  const mps = verticalKmS * 1000;
  // Log-ish: 0.5 m/s ≈ 0.14, 10 m/s ≈ 0.6, 120 m/s (crash) ≈ 0.85.
  const k = Math.log1p(mps) / Math.log1p(250);
  const gain = Math.min(0.85, 0.06 + 0.9 * k);
  const freqHz = Math.max(32, 95 - 55 * Math.min(1, k * 1.15));
  return { gain, freqHz };
}

/** Crash, impact speed in km/s: always above the hardest touchdown. */
export function crashCue(speedKmS: number): Thud {
  const s = Number.isFinite(speedKmS) && speedKmS > 0 ? speedKmS : 0;
  return { gain: Math.min(1, 0.9 + 0.1 * Math.min(1, s / 0.5)), freqHz: 34 };
}

/** RCS hiss from the ship-local strafe command (x starboard, y up, z aft). */
export function rcsHiss(x: number, y: number, z: number): { level: number; pan: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return { level: 0, pan: 0 };
  const ax = Math.min(1, Math.abs(x));
  const ay = Math.min(1, Math.abs(y));
  const az = Math.min(1, Math.abs(z));
  const sum = ax + ay + az;
  if (sum < 1e-6) return { level: 0, pan: 0 };
  const level = Math.min(1, Math.sqrt(ax * ax + ay * ay + az * az) / Math.sqrt(3) * 1.4);
  // The jets that fire to push starboard are on the port side, but the ear
  // reads the motion, not the nozzle: pan with the push.
  const pan = Math.max(-1, Math.min(1, (Math.sign(x) * ax) / sum * 0.8));
  return { level, pan };
}

const HUM_SILENT_KM = 60;

/** Proximity hum for a hull of bounding radius `radiusKm` at `distanceKm`. 0..1. */
export function vesselHum(distanceKm: number, radiusKm: number): number {
  if (!Number.isFinite(distanceKm) || !Number.isFinite(radiusKm) || radiusKm <= 0 || distanceKm >= HUM_SILENT_KM) return 0;
  const d = Math.max(distanceKm, 1e-6);
  // Angular size, weighted up for physical size (a capital is felt further out).
  const loom = Math.min(1, (radiusKm / d) * (2.5 + 4 * Math.min(1, radiusKm / 0.5)));
  const base = Math.pow(loom, 0.6);
  // Hard fade to silence by HUM_SILENT_KM regardless of size.
  const fade = 1 - Math.min(1, Math.max(0, (distanceKm - 20) / (HUM_SILENT_KM - 20)));
  return Math.min(1, base * fade);
}

/** Index of the hull that looms largest (radius-weighted), or -1. */
export function loudestHull(hulls: ReadonlyArray<{ readonly distanceKm: number; readonly radiusKm: number }>): number {
  let best = -1;
  let bestHum = 0;
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i]!;
    const v = vesselHum(h.distanceKm, h.radiusKm);
    if (v > bestHum) {
      bestHum = v;
      best = i;
    }
  }
  return best;
}

/** Above this the cockpit starts to complain. */
export const CREAK_ONSET_G = 1.8;

export function creakLevel(gForce: number, cockpit: boolean): number {
  if (!cockpit || !Number.isFinite(gForce) || gForce <= CREAK_ONSET_G) return 0;
  return Math.min(1, 1 - Math.exp(-(gForce - CREAK_ONSET_G) / 3.5));
}
