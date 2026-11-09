/**
 * v4 sub-plan 1 (propellant), Task 4 fix round 1 — the chart's price cell.
 *
 * StarMap's info row and confirm column both write `jumpCostCell(...)`; the
 * DOM write itself does not run in node, so the cell's text and warning
 * state are tested here (review minor 3: the confirm panel priced the origin).
 */

import { describe, expect, it } from 'vitest';

import { PROBE_TANK_CAPACITY_KG, Propellant } from '@/ship/propellant';
import { jumpCostCell } from './StarMap';

const CAP = PROBE_TANK_CAPACITY_KG;

describe('jumpCostCell — the PROPELLANT cell in the info row and the confirm panel', () => {
  it('Given the origin system selected, Then the confirm price reads --', () => {
    const cell = jumpCostCell(new Propellant(CAP, 1), 0, true);
    expect(cell.text).toBe('--');
    expect(cell.warn).toBe(false);
  });

  it('Given a system 5 ly away with 5 % left, Then it reads PROPELLANT 6 % in the warning tone', () => {
    const cell = jumpCostCell(new Propellant(CAP, 0.05), 5, false);
    expect(cell.text).toBe('PROPELLANT 6 %');
    expect(cell.warn).toBe(true);
  });

  it('Given a full tank, Then the same price is not a warning', () => {
    const cell = jumpCostCell(new Propellant(CAP, 1), 5, false);
    expect(cell.text).toBe('PROPELLANT 6 %');
    expect(cell.warn).toBe(false);
  });

  it('Given a hull without a tank, Then the cell reads --', () => {
    expect(jumpCostCell(null, 5, false)).toEqual({ text: '--', warn: false });
  });
});
