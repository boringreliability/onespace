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

/**
 * v4 sub-plan 2, Task 3 — formation on an asteroid. The reference velocity is
 * parent-relative (the flight model's frame): the asteroid's world velocity
 * minus the parent body's world velocity, or the asteroid's world velocity
 * itself in the star's frame.
 */
const AST_ID = 'ast:sys-fyss:398:4';

function rockRig(opts: { distanceKm?: number; parentVel?: Vector3 | null; targetId?: string } = {}) {
  const fm = new FlightModel(DEFAULT_SHIP_CONFIG);
  fm.setParent({ position: new Vector3(), velocity: new Vector3(), mu: 1_500, radius: 1_000 });
  const p = new Vector3(1_600, 0, 0);
  fm.teleport(p, fm.orbitalVelocityAt(p));
  fm.flightAssist = true;
  const astVel = new Vector3(14.2, -0.3, 6.1);
  const parentVel = opts.parentVel === undefined ? new Vector3(9.5, 0.1, 3.0) : opts.parentVel;
  const d = opts.distanceKm ?? 10;
  const noop = (): void => undefined;
  const opts2 = {
    universe: { flight: fm, shipParent: parentVel ? { worldVelocity: parentVel } : null },
    cruise: { drive: { phase: 'idle', capKmS: 0 } },
    traffic: {
      loudest: () => null,
      vesselVelocity: () => false,
      vesselWorld: () => false,
    },
    belt: {
      asteroidWorld: (id: string, out: Vector3) =>
        id === AST_ID ? (out.copy(fm.worldPosition).add(new Vector3(0, 0, d)), true) : false,
      asteroidVelocity: (id: string, out: Vector3) => (id === AST_ID ? (out.copy(astVel), true) : false),
      fieldWorld: () => false,
      // [v4-mining] No field near: the field frame (fieldFrame.test.ts) stays out of these.
      nearestField: () => null,
      fieldVelocity: () => false,
    },
    targeting: { targetId: opts.targetId ?? AST_ID },
    audio: { setCruise: noop, setRcs: noop, setVesselProximity: noop, setHullStress: noop },
    sky: { setDriveField: noop },
  } as unknown as FlightSenseOptions;
  const fs = new FlightSense(opts2);
  const logs: string[] = [];
  offs.push(bus.on('log', ({ text }) => logs.push(text)));
  const ctx = {} as EngineContext;
  const pressK = (): void => {
    (fs as unknown as { wantToggle: boolean }).wantToggle = true;
    fs.update(1 / 60, ctx);
  };
  return { fs, fm, logs, astVel, parentVel, pressK, frame: () => fs.update(1 / 60, ctx) };
}

describe('FlightSense: formation on an asteroid', () => {
  it("Given an asteroid target within 50 km with FA on, When K, Then formation holds with the asteroid's velocity (minus the parent's) as reference", () => {
    const r = rockRig({ distanceKm: 10 });
    r.pressK();
    expect(r.fs.formation).toBe(AST_ID);
    expect(r.logs).toContain('FORMATION — HOLDING ON TARGET');
    const want = r.astVel.clone().sub(r.parentVel!);
    const ref = r.fm.assistReferenceVelocity;
    expect(ref).not.toBeNull();
    expect(ref!.distanceTo(want)).toBeLessThan(1e-9);
    // And it keeps holding frame after frame.
    r.frame();
    expect(r.fs.formation).toBe(AST_ID);
    expect(r.fm.assistReferenceVelocity!.distanceTo(want)).toBeLessThan(1e-9);
  });

  it("Given the ship in the star's frame (no parent body), Then the reference is the asteroid's world velocity itself", () => {
    const r = rockRig({ parentVel: null });
    r.pressK();
    expect(r.fs.formation).toBe(AST_ID);
    expect(r.fm.assistReferenceVelocity!.distanceTo(r.astVel)).toBeLessThan(1e-9);
  });

  it('Given the asteroid beyond 50 km, When K, Then no formation and a warning', () => {
    const r = rockRig({ distanceKm: 80 });
    r.pressK();
    expect(r.fs.formation).toBeNull();
    expect(r.fm.assistReferenceVelocity).toBeNull();
    expect(r.logs.some((t) => t.startsWith('FORMATION —') && t !== 'FORMATION — HOLDING ON TARGET')).toBe(true);
  });

  it('Given a field (not an asteroid) targeted, When K, Then no formation', () => {
    const r = rockRig({ targetId: 'field:sys-fyss:398' });
    r.pressK();
    expect(r.fs.formation).toBeNull();
  });
});

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
