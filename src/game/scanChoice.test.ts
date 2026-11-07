/**
 * What the scanner locks onto.
 *
 * GAMEPLAY F3: the array preferred any hull within 400 km over the world
 * underneath it, so with a co-orbiting freighter 3.3 km off the shoulder the
 * spawn planet could never be scanned. The rule is now: the current target if
 * there is one; else the world under (or near) the reticle; else the world you
 * are orbiting. A vessel is only scanned when it is the target.
 */

import { describe, expect, it } from 'vitest';

import { RETICLE_MARGIN_RAD, chooseScanTarget, type ScanBody } from './scanChoice';

const deg = (d: number): number => (d * Math.PI) / 180;

const body = (id: string, angleDeg: number, angularRadiusDeg: number, distanceKm: number, inRange = true): ScanBody => ({
  id,
  angleRad: deg(angleDeg),
  angularRadiusRad: deg(angularRadiusDeg),
  distanceKm,
  inRange,
});

describe('chooseScanTarget', () => {
  it('Given a target in range, When T is pressed, Then the target is scanned even with another world under the reticle', () => {
    const r = chooseScanTarget({
      target: { id: 'body:Fyss I', inRange: true },
      bodies: [body('body:Fyss', 0, 30, 10_000)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'scan', id: 'body:Fyss I' });
  });

  it('Given a targeted vessel, When T is pressed, Then the vessel is scanned', () => {
    const r = chooseScanTarget({
      target: { id: '5a17c0de', inRange: true },
      bodies: [body('body:Fyss', 0, 30, 10_000)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'scan', id: '5a17c0de' });
  });

  it('Given a target out of range, When T is pressed, Then it reports out-of-range rather than silently scanning something else', () => {
    const r = chooseScanTarget({
      target: { id: 'body:Vhessvaem', inRange: false },
      bodies: [body('body:Fyss', 0, 30, 10_000)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'out-of-range', id: 'body:Vhessvaem' });
  });

  it('Given no target and a world under the reticle, Then that world is scanned rather than the parent', () => {
    const r = chooseScanTarget({
      target: null,
      bodies: [body('body:Fyss', 70, 30, 10_000), body('body:Fyss I', 0.5, 1, 40_000)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'scan', id: 'body:Fyss I' });
  });

  it('Given no target and a small world just outside its disc but within the reticle margin, Then it is still scanned', () => {
    const r = chooseScanTarget({
      target: null,
      bodies: [body('body:Fyss', 120, 30, 10_000), { ...body('body:Fyss I', 0, 0.2, 40_000), angleRad: deg(0.2) + RETICLE_MARGIN_RAD * 0.5 }],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'scan', id: 'body:Fyss I' });
  });

  it('Given no target and a moon in front of its planet, both under the reticle, Then the nearer (the moon) is scanned', () => {
    const r = chooseScanTarget({
      target: null,
      bodies: [body('body:Fyss', 2, 10, 60_000), body('body:Fyss I', 1, 2, 20_000)],
      parentId: null,
    });
    expect(r).toEqual({ kind: 'scan', id: 'body:Fyss I' });
  });

  it('Given no target and empty sky under the reticle, Then the parent world is scanned (not the hull 3 km away)', () => {
    const r = chooseScanTarget({
      target: null,
      bodies: [body('body:Fyss', 95, 40, 10_000), body('body:Fyss I', 60, 1, 40_000)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'scan', id: 'body:Fyss' });
  });

  it('Given no target and the world under the reticle is out of range, Then it falls through to the parent', () => {
    const r = chooseScanTarget({
      target: null,
      bodies: [body('body:Fyss', 95, 40, 10_000), body('body:Vhessvaem', 0, 0.3, 2e8, false)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'scan', id: 'body:Fyss' });
  });

  it('Given no target and the parent is out of range, Then nothing is scanned', () => {
    const r = chooseScanTarget({
      target: null,
      bodies: [body('body:Fyss', 95, 0.1, 5e6, false)],
      parentId: 'body:Fyss',
    });
    expect(r).toEqual({ kind: 'none' });
  });

  it('Given no target, no parent world and nothing under the reticle, Then nothing is scanned', () => {
    const r = chooseScanTarget({ target: null, bodies: [body('body:Fyss', 90, 0.1, 5e5)], parentId: null });
    expect(r).toEqual({ kind: 'none' });
  });
});
