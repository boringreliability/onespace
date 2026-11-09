/**
 * v4 sub-plan 1 (propellant), Task 4 fix round 1 — paying for a jump.
 *
 * MapMode builds the galaxy view and the chart's DOM, so it does not run in
 * node. Its pay → engage → refund-on-reject sequence lives in `paidJump`
 * (`jumpPayment.ts`), which MapMode calls with `warp.engage` and which owns
 * every log line about the jump's authorisation. That keeps the affordability
 * rule in one place: the chart no longer judges it a second time after the
 * tank has already paid (review finding 2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { paidJump } from './jumpPayment';

const CAP = PROBE_TANK_CAPACITY_KG;

const logs: Array<{ text: string; tone?: string }> = [];
let off: (() => void) | null = null;
beforeEach(() => {
  logs.length = 0;
  off = bus.on('log', (e) => logs.push(e));
});
afterEach(() => {
  off?.();
  off = null;
});

/** A warp stub: counts calls and resolves, or rejects as Warp does on abort. */
function warp(outcome: 'arrive' | 'reject'): { calls: number; engage: () => Promise<void> } {
  const w = {
    calls: 0,
    engage: (): Promise<void> => {
      w.calls++;
      return outcome === 'arrive' ? Promise.resolve() : Promise.reject(new Error('WarpAbortedError'));
    },
  };
  return w;
}

const texts = (): string[] => logs.map((l) => l.text);

describe('paidJump — pay, engage, refund on reject', () => {
  it('Given 10 % left and a 6 % jump, Then the jump is paid once and JUMP AUTHORISED is logged', async () => {
    const tank = new Propellant(CAP, 0.1);
    const w = warp('arrive');
    const out = await paidJump({ tank, distanceLy: 5, name: 'Vassa', warpIdle: true, engage: w.engage });
    expect(out).toBe('jumped');
    expect(w.calls).toBe(1);
    expect(tank.massKg).toBeCloseTo(0.04 * CAP, 6);
    expect(texts().filter((t) => t === 'JUMP AUTHORISED — Vassa')).toHaveLength(1);
    expect(logs.find((l) => l.text === 'JUMP AUTHORISED — Vassa')!.tone).toBe('good');
  });

  it('Given a paid jump, When the warp rejects (pilot abort), Then the full price is refunded and the log says JUMP ABORTED', async () => {
    const tank = new Propellant(CAP, 1);
    const w = warp('reject');
    const out = await paidJump({ tank, distanceLy: 5, name: 'Vassa', warpIdle: true, engage: w.engage });
    expect(out).toBe('aborted');
    expect(w.calls).toBe(1);
    expect(tank.massKg).toBe(CAP);
    const aborted = logs.find((l) => l.text === 'JUMP ABORTED');
    expect(aborted).toBeDefined();
    expect(aborted!.tone).toBe('warn');
  });

  it('Given a warp already running, When another jump is requested, Then nothing is charged and the warp is not asked', async () => {
    const tank = new Propellant(CAP, 1);
    const w = warp('reject');
    const out = await paidJump({ tank, distanceLy: 5, name: 'Vassa', warpIdle: false, engage: w.engage });
    expect(out).toBe('busy');
    expect(w.calls).toBe(0);
    expect(tank.massKg).toBe(CAP);
    expect(texts().some((t) => t.startsWith('JUMP AUTHORISED'))).toBe(false);
  });

  it('Given 5 % left and a 6 % jump, Then it is refused with JUMP · NO PROPELLANT, the warp is not asked, and the tank is unchanged', async () => {
    const tank = new Propellant(CAP, 0.05);
    const w = warp('arrive');
    const out = await paidJump({ tank, distanceLy: 5, name: 'Vassa', warpIdle: true, engage: w.engage });
    expect(out).toBe('refused');
    expect(w.calls).toBe(0);
    expect(tank.massKg).toBeCloseTo(0.05 * CAP, 9);
    const refused = logs.find((l) => l.text === 'JUMP · NO PROPELLANT');
    expect(refused).toBeDefined();
    expect(refused!.tone).toBe('warn');
    expect(texts().some((t) => t.startsWith('JUMP AUTHORISED'))).toBe(false);
  });

  it('Given a hull without a tank, Then the jump is free and authorised as in v3', async () => {
    const w = warp('arrive');
    const out = await paidJump({ tank: null, distanceLy: 5, name: 'Vassa', warpIdle: true, engage: w.engage });
    expect(out).toBe('jumped');
    expect(w.calls).toBe(1);
    expect(texts()).toContain('JUMP AUTHORISED — Vassa');
  });
});
