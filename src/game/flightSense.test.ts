/**
 * review-v3b — FlightSense's formation toggle across mode changes.
 *
 * K is read by a window listener that runs in every mode, while the module
 * only updates in flight and the chart. A K pressed in the Yard or on the
 * title was latched and fired on the first flight frame after — formation
 * engaged on a vessel the pilot never asked to hold on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import { DEFAULT_SHIP_CONFIG, FlightModel } from '@/ship/FlightModel';
import { FlightSense, type FlightSenseOptions } from './FlightSense';

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function rig() {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 1_500, radius: 1_000 });
  const p = new Vector3(1_600, 0, 0);
  fm.teleport(p, fm.orbitalVelocityAt(p));
  fm.flightAssist = true;
  const noop = (): void => undefined;
  const opts = {
    universe: { flight: fm },
    cruise: { drive: { phase: 'idle', capKmS: 0 } },
    traffic: {
      loudest: () => null,
      vesselVelocity: (_id: string, out: Vector3) => (out.copy(fm.velocity), true),
      vesselWorld: (_id: string, out: Vector3) => (out.copy(fm.worldPosition).add(new Vector3(2, 0, 0)), true),
    },
    targeting: { targetId: 'ship:companion' },
    audio: { setCruise: noop, setRcs: noop, setVesselProximity: noop, setHullStress: noop },
    sky: { setDriveField: noop },
  } as unknown as FlightSenseOptions;
  const fs = new FlightSense(opts);
  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));
  const ctx = {} as EngineContext;
  return { fs, fm, logs, frame: () => fs.update(1 / 60, ctx) };
}

describe('FlightSense: K does not carry across modes', () => {
  it('Given K pressed while the Yard was up, When flight resumes with a vessel targeted, Then formation is NOT engaged by the stale key', () => {
    const r = rig();
    // The window listener latched K while FlightSense was inactive (Yard).
    (r.fs as unknown as { wantToggle: boolean }).wantToggle = true;
    r.fs.onModeChange('yard', 'flight');
    r.frame();
    expect(r.fs.formation).toBeNull();
    expect(r.logs).not.toContain('FORMATION — HOLDING ON TARGET');
  });

  it('Given K pressed in flight with a vessel in range, Then formation engages (the toggle itself still works)', () => {
    const r = rig();
    (r.fs as unknown as { wantToggle: boolean }).wantToggle = true;
    r.frame();
    expect(r.fs.formation).toBe('ship:companion');
  });
});
