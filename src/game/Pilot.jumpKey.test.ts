/**
 * v4 sub-plan 1 (propellant) — the J key leaves the jump log to paidJump.
 *
 * `paidJump` owns every line about a jump's authorisation (JUMP AUTHORISED /
 * JUMP · NO PROPELLANT). Pilot's `J` only makes the request; if it logged
 * "JUMP AUTHORISED" itself, a refused jump would read NO PROPELLANT and then
 * AUTHORISED, and an affordable one would be authorised twice.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import { Universe } from '@/game/Universe';
import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { paidJump } from './jumpPayment';
import { Pilot } from './Pilot';

const CAP = PROBE_TANK_CAPACITY_KG;

const logs: string[] = [];
const offs: Array<() => void> = [];
beforeEach(() => {
  logs.length = 0;
  offs.push(bus.on('log', (e) => logs.push(e.text)));
});
afterEach(() => {
  while (offs.length) offs.pop()!();
});

/** Pilot with a chart that has a system 5 ly away selected; `J` is pressed through the real handler. */
function pressJ(tank: Propellant): void {
  const pilot = new Pilot({ universe: new Universe() });
  pilot.attachJump(
    { selectedTarget: () => ({ id: 'sys-b', name: 'Vassa', distanceLy: 5 }), origin: 'sys-a' },
    { phase: 'idle' },
  );
  // MapMode's side of the request: pay, then engage.
  offs.push(
    bus.on('nav:jump-requested', (req) => {
      void paidJump({
        tank,
        distanceLy: req.distanceLy,
        name: req.name,
        warpIdle: true,
        engage: () => Promise.resolve(),
      });
    }),
  );
  (pilot as unknown as { onJumpKey(): void }).onJumpKey();
}

describe('Pilot — the J key leaves the jump log to paidJump', () => {
  it('Given J is pressed with too little propellant, Then the only jump line is JUMP · NO PROPELLANT (Pilot logs nothing about authorisation)', () => {
    pressJ(new Propellant(CAP, 0.05));
    expect(logs.filter((t) => t.startsWith('JUMP'))).toEqual(['JUMP · NO PROPELLANT']);
  });

  it('Given J is pressed with enough propellant, Then JUMP AUTHORISED appears exactly once (from paidJump)', async () => {
    pressJ(new Propellant(CAP, 1));
    await Promise.resolve();
    expect(logs.filter((t) => t.startsWith('JUMP'))).toEqual(['JUMP AUTHORISED — Vassa']);
  });
});
