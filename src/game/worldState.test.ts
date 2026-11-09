/**
 * v4 sub-plan 2, Task 3 — world state (P2): what the player has taken out of
 * the generated universe.
 *
 * The universe regenerates from one seed; a mined-out asteroid does not. This
 * is the in-memory record of depletion, keyed by asteroid id. Every entry
 * carries who mined (P2: 'local' until there is more than one player) and
 * BOTH clocks (P5): the orbit clock the world moves on, and wall time.
 */

import { describe, expect, it } from 'vitest';

import { WorldState } from './worldState';

const AST = 'ast:sys-fyss:398:4';

function rig(orbit = 120, wall = 1_700_000_000_000) {
  const clock = { orbit, wall };
  const ws = new WorldState({ orbitSeconds: () => clock.orbit, wallMs: () => clock.wall });
  return { ws, clock };
}

describe('WorldState — depletion (P2)', () => {
  it('Given nothing mined, Then depleted(id) is zero for every resource', () => {
    const { ws } = rig();
    expect(ws.depleted(AST)).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(ws.entries()).toEqual([]);
  });

  it("Given 3 kg ice mined, Then depleted(id).ice = 3 and one entry is recorded with by='local' and both clocks", () => {
    const { ws } = rig(120, 1_700_000_000_000);
    ws.recordMined(AST, 'ice', 3, 'local');
    expect(ws.depleted(AST)).toEqual({ ice: 3, metal: 0, silicate: 0, rare: 0 });
    expect(ws.entries()).toHaveLength(1);
    expect(ws.entries()[0]).toMatchObject({ id: AST, by: 'local', orbitSeconds: 120, wallMs: 1_700_000_000_000 });
  });

  it('Given two mines of the same resource at different times, Then depletion accumulates and each entry carries its own clocks', () => {
    const { ws, clock } = rig(10, 1000);
    ws.recordMined(AST, 'metal', 2.5, 'local');
    clock.orbit = 610;
    clock.wall = 601_000;
    ws.recordMined(AST, 'metal', 4, 'local');
    expect(ws.depleted(AST).metal).toBeCloseTo(6.5, 12);
    const e = ws.entries();
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ orbitSeconds: 10, wallMs: 1000 });
    expect(e[1]).toMatchObject({ orbitSeconds: 610, wallMs: 601_000 });
  });

  it('Given mining on one asteroid and one resource, Then other asteroids and other resources are untouched', () => {
    const { ws } = rig();
    ws.recordMined(AST, 'rare', 1, 'local');
    expect(ws.depleted('ast:sys-fyss:398:5')).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(ws.depleted(AST)).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 1 });
  });

  it('Given a non-finite or negative kg, Then nothing is recorded (no NaN in the world)', () => {
    const { ws } = rig();
    for (const kg of [Number.NaN, Number.POSITIVE_INFINITY, -5]) ws.recordMined(AST, 'ice', kg, 'local');
    expect(ws.depleted(AST)).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(ws.entries()).toEqual([]);
  });
});
