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

// Final whole-branch review, I3: after a cannibalization the cell and the HUD
// tank % speak the same unit, a share of the CURRENT tank. The price itself is
// still kg of BASE capacity (R17), so affordability does not move.
describe('final review I3 — the cell is a share of the current tank', () => {
  it('Given 50 % capacity lost, Then the jump cell shows the price as a share of the current tank: 5 ly reads PROPELLANT 12 %', () => {
    const p = new Propellant(CAP, 1);
    p.capacityLossFrac = 0.5;
    const cell = jumpCostCell(p, 5, false);
    expect(cell.text).toBe('PROPELLANT 12 %');
    expect(cell.warn).toBe(false);
  });

  it('Given 50 % capacity lost and 1 000 kg left (10 % on the HUD), Then a 5 ly jump reads 12 % and warns, so the two numbers compare directly', () => {
    const p = new Propellant(CAP, 1);
    p.capacityLossFrac = 0.5;
    p.consume(p.massKg - 1_000);
    expect(Math.round(p.fraction * 100)).toBe(10);
    const cell = jumpCostCell(p, 5, false);
    expect(cell.text).toBe('PROPELLANT 12 %');
    expect(cell.warn).toBe(true);
  });
});
