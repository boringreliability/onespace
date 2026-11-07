/**
 * Module gating. The frame loop is a pure function so it can be tested
 * without WebGL: which modules tick in which mode, in what order, with what dt.
 */

import { describe, expect, it } from 'vitest';
import { tickModules, type TickableModule } from './tick';
import type { Mode } from './Modes';

function recorder() {
  const calls: string[] = [];
  const mod = (name: string, activeIn?: Mode[]): TickableModule<null> => ({
    name,
    activeIn,
    update: (dt) => calls.push(`${name}.update(${dt})`),
    lateUpdate: (dt) => calls.push(`${name}.late(${dt})`),
  });
  return { calls, mod };
}

describe('tickModules', () => {
  it('Given a flight-only module and an always-on module, When ticking in yard, Then only the always-on one runs', () => {
    const { calls, mod } = recorder();
    tickModules([mod('pilot', ['flight']), mod('audio')], { base: 'yard', overlay: null }, 0.1, null);
    expect(calls).toEqual(['audio.update(0.1)', 'audio.late(0.1)']);
  });

  it('Given modules A then B, Then every update runs before any lateUpdate, in registration order', () => {
    const { calls, mod } = recorder();
    tickModules([mod('a'), mod('b')], { base: 'flight', overlay: null }, 0.5, null);
    expect(calls).toEqual(['a.update(0.5)', 'b.update(0.5)', 'a.late(0.5)', 'b.late(0.5)']);
  });

  it('Given a photo overlay over flight, Then flight modules tick with dt = 0 and photo modules with real dt', () => {
    const { calls, mod } = recorder();
    tickModules([mod('pilot', ['flight']), mod('photo', ['photo'])], { base: 'flight', overlay: 'photo' }, 0.2, null);
    expect(calls).toEqual(['pilot.update(0)', 'photo.update(0.2)', 'pilot.late(0)', 'photo.late(0.2)']);
  });

  it('Given a photo overlay, Then modules active in neither base nor overlay stay asleep', () => {
    const { calls, mod } = recorder();
    tickModules([mod('showroom', ['yard'])], { base: 'flight', overlay: 'photo' }, 0.2, null);
    expect(calls).toEqual([]);
  });

  it('Given an always-on module under an overlay, Then it keeps real dt (audio, log must not freeze)', () => {
    const { calls, mod } = recorder();
    tickModules([mod('log')], { base: 'flight', overlay: 'photo' }, 0.2, null);
    expect(calls).toEqual(['log.update(0.2)', 'log.late(0.2)']);
  });

  it('Given a module active in several modes, Then it runs in each of them', () => {
    const { calls, mod } = recorder();
    const map = mod('map-mode', ['flight', 'map']);
    tickModules([map], { base: 'map', overlay: null }, 0.1, null);
    tickModules([map], { base: 'flight', overlay: null }, 0.1, null);
    expect(calls.filter((c) => c.includes('update'))).toHaveLength(2);
  });

  it('Given modules without update or lateUpdate, Then nothing throws', () => {
    expect(() => tickModules([{ name: 'bare' }], { base: 'flight', overlay: null }, 0.1, null)).not.toThrow();
  });
});
