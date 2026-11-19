/**
 * Targeting — the one current target, and how the pilot moves it.
 *
 * GAMEPLAY B2: `Hud.setTarget()` was finished and never called, `Tab` had no
 * consumer, and a selection on the local chart only ever cleared the glass.
 * These are the pure rules the Targeting module is built from: which candidate
 * `Tab` picks, how a chart selection becomes the same target, when a target
 * stops existing, and the two numbers printed under the bracket.
 *
 * Shared contract (all tracks): body ids are `body:<spec.name>`, vessel ids are
 * the blueprint id, and the target travels on the existing `target:changed`.
 */

import { describe, expect, it } from 'vitest';

import {
  ETA_MIN_CLOSING_KMS,
  TargetSelection,
  bodyTargetId,
  canonicalTargetId,
  closingSpeed,
  etaSeconds,
  targetEtaSeconds,
  nextTargetId,
  orderByNoseAngle,
  resolveTarget,
  targetRangeKm,
  type TargetCandidate,
} from './targets';

/** Nose along -Z, the hull's forward axis. */
const NOSE = { x: 0, y: 0, z: -1 };

const cand = (id: string, x: number, y: number, z: number, name = id): TargetCandidate => ({
  id,
  name,
  rel: { x, y, z },
});

/** Ten degrees off the nose per step, all at the same range. */
function fan(...degs: number[]): TargetCandidate[] {
  return degs.map((d, i) => {
    const r = (d * Math.PI) / 180;
    return cand(`t${i}@${d}`, Math.sin(r) * 1000, 0, -Math.cos(r) * 1000);
  });
}

const BODIES = [
  { id: 'sys42:p2', name: 'Fyss' },
  { id: 'sys42:p2:m0', name: 'Fyss I' },
];

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe('bodyTargetId', () => {
  it('Given a body named "Fyss I", When it is targeted, Then its id is "body:Fyss I"', () => {
    expect(bodyTargetId('Fyss I')).toBe('body:Fyss I');
  });
});

describe('canonicalTargetId', () => {
  it('Given an id already in body: form, Then it is returned unchanged', () => {
    expect(canonicalTargetId('body:Fyss', BODIES)).toBe('body:Fyss');
  });

  it('Given the raw spec id the system map emits, When it matches a body, Then it becomes body:<name>', () => {
    expect(canonicalTargetId('sys42:p2:m0', BODIES)).toBe('body:Fyss I');
  });

  it('Given an id that is no body (a vessel blueprint id), Then it is returned unchanged', () => {
    expect(canonicalTargetId('5a17c0de', BODIES)).toBe('5a17c0de');
  });

  it('Given null, Then the result is null', () => {
    expect(canonicalTargetId(null, BODIES)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tab ordering
// ---------------------------------------------------------------------------

describe('orderByNoseAngle', () => {
  it('Given candidates scattered around the ship, When ordered, Then the one nearest the nose comes first', () => {
    const c = fan(40, 5, 120, 20);
    expect(orderByNoseAngle(c, NOSE).map((x) => x.id)).toEqual(['t1@5', 't3@20', 't0@40', 't2@120']);
  });

  it('Given a candidate directly behind the ship, Then it is ordered last', () => {
    const c = [cand('behind', 0, 0, 500), ...fan(60, 10)];
    expect(orderByNoseAngle(c, NOSE).at(-1)!.id).toBe('behind');
  });

  it('Given two candidates at the same angle, Then the nearer comes first, so the order is deterministic', () => {
    const far = cand('far', 0, 0, -9000);
    const near = cand('near', 0, 0, -10);
    expect(orderByNoseAngle([far, near], NOSE).map((x) => x.id)).toEqual(['near', 'far']);
  });

  it('Given a candidate at zero range, Then it sorts last and no angle is NaN', () => {
    const c = [cand('on-top', 0, 0, 0), ...fan(170)];
    const out = orderByNoseAngle(c, NOSE);
    expect(out.at(-1)!.id).toBe('on-top');
  });

  it('Given no candidates, Then the order is empty', () => {
    expect(orderByNoseAngle([], NOSE)).toEqual([]);
  });

  it('Given candidates, When ordered, Then the input array is not mutated', () => {
    const c = fan(50, 10);
    const before = c.map((x) => x.id);
    orderByNoseAngle(c, NOSE);
    expect(c.map((x) => x.id)).toEqual(before);
  });
});

describe('nextTargetId — what Tab selects', () => {
  const ordered = ['a', 'b', 'c'];

  it('Given no current target, When Tab is pressed, Then the candidate nearest the nose is selected', () => {
    expect(nextTargetId(ordered, null)).toBe('a');
  });

  it('Given the first candidate is targeted, When Tab is pressed, Then the next one is selected', () => {
    expect(nextTargetId(ordered, 'a')).toBe('b');
  });

  it('Given the last candidate is targeted, When Tab is pressed, Then it wraps to the first', () => {
    expect(nextTargetId(ordered, 'c')).toBe('a');
  });

  it('Given no candidates at all, When Tab is pressed, Then there is no target', () => {
    expect(nextTargetId([], null)).toBeNull();
    expect(nextTargetId([], 'a')).toBeNull();
  });

  it('Given the current target is not among the candidates, When Tab is pressed, Then the one nearest the nose is selected', () => {
    expect(nextTargetId(ordered, 'gone')).toBe('a');
  });

  it('Given a single candidate that is already targeted, When Tab is pressed, Then it stays targeted', () => {
    expect(nextTargetId(['solo'], 'solo')).toBe('solo');
  });
});

// ---------------------------------------------------------------------------
// The one target, and its lifetime
// ---------------------------------------------------------------------------

describe('TargetSelection', () => {
  it('Given nothing targeted, Then the id is null', () => {
    expect(new TargetSelection().id).toBeNull();
  });

  it('Given the system map emits a raw spec id, When applied, Then the target is the same body:<name> Tab would give, and it reports a change', () => {
    const s = new TargetSelection();
    expect(s.apply('sys42:p2', BODIES)).toBe(true);
    expect(s.id).toBe('body:Fyss');
  });

  it('Given a target, When the same target is applied again (our own echo on the bus), Then nothing changes', () => {
    const s = new TargetSelection();
    s.apply('body:Fyss', BODIES);
    expect(s.apply('body:Fyss', BODIES)).toBe(false);
    expect(s.apply('sys42:p2', BODIES)).toBe(false);
  });

  it('Given a target, When null is applied, Then the target is cleared and it reports a change', () => {
    const s = new TargetSelection();
    s.apply('body:Fyss', BODIES);
    expect(s.apply(null, BODIES)).toBe(true);
    expect(s.id).toBeNull();
  });

  it('Given a targeted body, When the system is left and the body no longer exists, Then validate clears it and reports a change', () => {
    const s = new TargetSelection();
    s.apply('body:Fyss', BODIES);
    expect(s.validate(['body:Vhessvaem', 'body:Vhessvaem I'])).toBe(true);
    expect(s.id).toBeNull();
  });

  it('Given a targeted body still in the system, When validated, Then it is kept and nothing changes', () => {
    const s = new TargetSelection();
    s.apply('body:Fyss I', BODIES);
    expect(s.validate(['body:Fyss', 'body:Fyss I'])).toBe(false);
    expect(s.id).toBe('body:Fyss I');
  });

  it('Given nothing targeted, When validated, Then nothing changes', () => {
    expect(new TargetSelection().validate([])).toBe(false);
  });
});

describe('resolveTarget', () => {
  const list = [cand('body:Fyss', 0, 0, -1), cand('5a17c0de', 1, 0, 0)];

  it('Given an id among the candidates, Then that candidate is returned', () => {
    expect(resolveTarget('5a17c0de', list)?.id).toBe('5a17c0de');
  });

  it('Given an id whose body has left the system, Then nothing is returned', () => {
    expect(resolveTarget('body:Gone', list)).toBeNull();
  });

  it('Given no id, Then nothing is returned', () => {
    expect(resolveTarget(null, list)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Numbers under the bracket
// ---------------------------------------------------------------------------

describe('closingSpeed', () => {
  it('Given a target dead ahead and the gap shrinking at 3 km/s, Then the closing speed is +3', () => {
    // rel = target − ship; relVel = d(rel)/dt. Shrinking gap ⇒ relVel opposes rel.
    expect(closingSpeed({ x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: 3 })).toBeCloseTo(3, 9);
  });

  it('Given the target receding at 2 km/s, Then the closing speed is negative', () => {
    expect(closingSpeed({ x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: -2 })).toBeCloseTo(-2, 9);
  });

  it('Given purely tangential relative motion, Then the closing speed is zero', () => {
    expect(closingSpeed({ x: 0, y: 0, z: -1000 }, { x: 5, y: 0, z: 0 })).toBeCloseTo(0, 9);
  });

  it('Given zero range, Then the closing speed is zero rather than NaN', () => {
    expect(closingSpeed({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 3 })).toBe(0);
  });
});

describe('etaSeconds', () => {
  it('Given 100 km to go at 2 km/s closing, Then the ETA is 50 s', () => {
    expect(etaSeconds(100, 2)).toBeCloseTo(50, 9);
  });

  it('Given the target is receding, Then there is no ETA', () => {
    expect(etaSeconds(100, -2)).toBeNull();
  });

  it('Given a closing speed below the threshold (station-keeping drift), Then there is no ETA', () => {
    expect(etaSeconds(100, ETA_MIN_CLOSING_KMS * 0.5)).toBeNull();
  });

  // review-v3b (T5 × T3 seam): under cruise the target box showed a straight-
  // line ETA at the current speed ("eta 13:04:14") beside the drive's own
  // readout ("ETA 0:52") — two contradictory times on one screen, and the
  // straight-line one is wrong by 900× because the drive's speed is not
  // constant. The drive's readout owns the ETA while it runs.
  it('Given the cruise drive carrying the ship, Then the target box has no ETA of its own (the cruise readout owns it)', () => {
    expect(targetEtaSeconds(57_000_000, 1215, true)).toBeNull();
  });

  it('Given sublight flight, Then the target box ETA is the straight-line one, unchanged', () => {
    expect(targetEtaSeconds(100, 2, false)).toBe(etaSeconds(100, 2));
    expect(targetEtaSeconds(100, -2, false)).toBeNull();
  });

  it('Given zero range while closing, Then the ETA is zero', () => {
    expect(etaSeconds(0, 1)).toBe(0);
  });
});

describe('targetRangeKm', () => {
  it('Given a body, Then the range is to its surface, not its centre', () => {
    expect(targetRangeKm(10_000, 6_000)).toBe(4_000);
  });

  it('Given a ship inside the body radius (on the ground), Then the range is never negative', () => {
    expect(targetRangeKm(5_990, 6_000)).toBe(0);
  });

  it('Given a vessel (no radius), Then the range is centre to centre', () => {
    expect(targetRangeKm(3.3, 0)).toBe(3.3);
  });
});
