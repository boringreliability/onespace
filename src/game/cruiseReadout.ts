/**
 * The throttle block under cruise (v3 PLAN F / H1). While the drive is doing
 * anything the block says what the drive is doing — spool, speed against c,
 * time to arrival — instead of "100 %" over "FA · COAST". Pure.
 */

import {
  CRUISE_DEFAULTS,
  arrivalClearanceKm,
  cruiseEtaSeconds,
  cruiseTravelSeconds,
  type CruisePhase,
} from '@/ship/CruiseDrive';

const C_KMS = 299792.458;

/** m:ss, h:mm:ss, or a floor for absurd waits. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 100 * 3600) return '>99h';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "180 KM/S" below 0.001 c, "0.78 c" below c, "×12.4 c" / "×340 c" above. */
export function cruiseSpeedText(kmS: number): string {
  const v = Math.max(0, kmS);
  const f = v / C_KMS;
  if (f < 0.001) return `${Math.round(v)} KM/S`;
  if (f < 0.01) return `${f.toFixed(3)} c`;
  if (f < 1) return `${f.toFixed(2)} c`;
  if (f < 99.95) return `×${f.toFixed(1)} c`;
  return `×${Math.round(f)} c`;
}

export interface CruiseReadoutInput {
  readonly phase: CruisePhase;
  /** 0..1 through spool or drop. */
  readonly progress: number;
  readonly speedKmS: number;
  readonly etaS: number | null;
  readonly destination: string | null;
  /**
   * v3 polish (D22b): the world the drive is steering round, or null/absent.
   * While set there is no ETA: the straight-line law under-reported the
   * skirt ~2× (Remit 31 → Vassa: 0:40 shown, 79 s flown).
   */
  readonly skirting?: string | null;
}

export interface CruiseReadout {
  primary: string;
  secondary: string;
}

export function cruiseReadout(i: CruiseReadoutInput): CruiseReadout | null {
  if (i.phase === 'idle') return null;
  const primary =
    i.phase === 'spooling'
      ? `CRUISE · SPOOL ${Math.round(Math.max(0, Math.min(1, i.progress)) * 100)} %`
      : i.phase === 'dropping'
        ? 'CRUISE · DROP'
        : `CRUISE · ${cruiseSpeedText(i.speedKmS)}`;
  // The drop is not steered past anything, so it always counts down.
  if (i.skirting && i.phase !== 'dropping') return { primary, secondary: `SKIRTING · ${i.skirting.toUpperCase()}` };
  const eta = i.etaS !== null && Number.isFinite(i.etaS) ? clockText(i.etaS) : '—';
  const dest = i.destination ? ` · ${i.destination.toUpperCase()}` : '';
  return { primary, secondary: `ETA ${eta}${dest}` };
}

/**
 * Seconds to the drive's arrival at a body, or null when it is not closing.
 *
 * `clearanceKm` is the drive's own clearance (the nearest surface anywhere,
 * which sets its speed ceiling). While that is some OTHER body — the world
 * being left — the ceiling grows with the climb out of its well, not with the
 * gap to the target, so the target-only law (the chart's) under-reports by the
 * climb. Model: the ceiling is governed by the departure until the ship is
 * about halfway (gap/2), then by the target. Same law, both legs.
 */
export function cruiseArrivalEta(
  distanceKm: number,
  radiusKm: number,
  soiRadiusKm: number,
  closing: boolean,
  clearanceKm = Number.POSITIVE_INFINITY,
): number | null {
  if (!closing || !Number.isFinite(distanceKm)) return null;
  const gap = Math.max(distanceKm - radiusKm, 1);
  const mid = gap / 2;
  let t: number;
  if (clearanceKm > 0 && clearanceKm < mid) {
    const climb = Math.log(mid / clearanceKm) / CRUISE_DEFAULTS.rate;
    t = climb + cruiseTravelSeconds(mid, arrivalClearanceKm(radiusKm, soiRadiusKm));
  } else {
    t = cruiseEtaSeconds(distanceKm, radiusKm, soiRadiusKm);
  }
  return Number.isFinite(t) ? t : null;
}
