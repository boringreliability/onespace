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

import { WorldState, type MinedEntry } from './worldState';

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

// ---------------------------------------------------------------------------
// Mutation hardening (Task 8, phase A).
// ---------------------------------------------------------------------------

describe('WorldState — the shared empty record and the by field (hardening)', () => {
  it('Given two ids never mined, Then depleted() returns the SAME frozen record for both (allocation-free, unwritable)', () => {
    const { ws } = rig();
    const a = ws.depleted('ast:never:1');
    const b = ws.depleted('ast:never:2');
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(ws.depleted('ast:never:1')).toBe(a);
  });

  it('Given an id that was mined, Then depleted() is its own (unfrozen, unshared) record, not the empty one', () => {
    const { ws } = rig();
    const none = ws.depleted('ast:other');
    ws.recordMined(AST, 'ice', 3, 'local');
    expect(ws.depleted(AST)).not.toBe(none);
    expect(ws.depleted(AST).ice).toBe(3);
    expect(ws.depleted('ast:other')).toBe(none);
    expect(none.ice).toBe(0);
  });

  it('Given recordMined with a given `by`, Then the entry carries exactly that value', () => {
    const { ws } = rig();
    ws.recordMined(AST, 'metal', 2, 'someone-else' as never);
    expect(ws.entries()[0]!.by).toBe('someone-else');
  });
});

describe('v4 save — WorldState.restore', () => {
  function played() {
    const { ws, clock } = rig(10, 1_000);
    ws.recordMined(AST, 'ice', 3, 'local');
    clock.orbit = 500;
    clock.wall = 90_000;
    ws.recordMined(AST, 'metal', 2.5, 'local');
    ws.recordMined('ast:sys-fyss:398:5', 'rare', 0.25, 'local');
    return ws;
  }

  it('Given a played world, When its entries are restored into a fresh one, Then remainingKg (depletion) is the same for every rock', () => {
    const before = played();
    const after = rig(9_999, 9_999_999).ws;
    after.restore(before.entries());
    for (const id of [AST, 'ast:sys-fyss:398:5', 'ast:sys-fyss:398:6']) {
      expect(after.depleted(id)).toEqual(before.depleted(id));
    }
  });

  it('Given a restore, Then the entries keep their own clocks — no new clocks are stamped', () => {
    const before = played();
    const after = rig(9_999, 9_999_999).ws;
    after.restore(before.entries());
    expect(after.entries()).toEqual(before.entries());
    expect(after.entries()[0]).toMatchObject({ orbitSeconds: 10, wallMs: 1_000 });
    expect(after.entries()[1]).toMatchObject({ orbitSeconds: 500, wallMs: 90_000 });
  });

  it('Given a world that already has mines, When restored, Then it is replaced, not added to', () => {
    const before = played();
    const after = rig().ws;
    after.recordMined(AST, 'ice', 100, 'local');
    after.recordMined('ast:other', 'silicate', 7, 'local');
    after.restore(before.entries());
    expect(after.depleted(AST)).toEqual(before.depleted(AST));
    expect(after.depleted('ast:other')).toEqual({ ice: 0, metal: 0, silicate: 0, rare: 0 });
    expect(after.entries()).toHaveLength(3);
  });

  it('Given a restore and then a new mine, Then it adds to the restored depletion and carries the current clocks', () => {
    const before = played();
    const after = rig(700, 123_000).ws;
    after.restore(before.entries());
    after.recordMined(AST, 'ice', 1, 'local');
    expect(after.depleted(AST).ice).toBeCloseTo(4, 12);
    expect(after.entries()[3]).toMatchObject({ orbitSeconds: 700, wallMs: 123_000 });
  });

  it('Given entries(), Then it returns a copy: changing it (or the array restored from) does not change the world', () => {
    const before = played();
    const source = [...before.entries()];
    const after = rig().ws;
    after.restore(source);
    source.length = 0;
    expect(after.entries()).toHaveLength(3);
    const got = after.entries() as MinedEntry[];
    got.length = 0;
    expect(after.entries()).toHaveLength(3);
    expect(after.entries()).not.toBe(after.entries());
  });
});
