/**
 * v4 sub-plan 2, Task 5 — the HUD's CARGO block, under PROP.
 *
 * Pure seam (src/ui/cargoReadout.ts), read by Instruments → Hud.setCargo:
 *  - readCargo(cargo, out): fills a preallocated readout — visible only with
 *    something in the hold; total and capacity; one line per resource > 0, in
 *    the order ICE, METAL, SILICATE, RARE. Writes into `out` (no per-frame
 *    allocation) and returns it.
 *  - cargoTotalText / cargoLineText: what the block prints.
 */

import { describe, expect, it } from 'vitest';

import { CARGO_CAPACITY_KG, Cargo, applyCargoAction } from '@/ship/cargo';
import { Propellant } from '@/ship/propellant';
import { cargoLineText, cargoTotalText, createCargoReadout, readCargo } from './cargoReadout';

function hold(c: Partial<Record<'ice' | 'metal' | 'silicate' | 'rare', number>>): Cargo {
  const cargo = new Cargo(CARGO_CAPACITY_KG);
  cargo.restore(c);
  return cargo;
}

describe('HUD CARGO block', () => {
  it('Given an empty hold, Then the block is hidden', () => {
    const r = readCargo(hold({}), createCargoReadout());
    expect(r.visible).toBe(false);
    expect(r.count).toBe(0);
  });

  it('Given no hold at all (a bare hull), Then the block is hidden', () => {
    const r = readCargo(null, createCargoReadout());
    expect(r.visible).toBe(false);
    expect(r.count).toBe(0);
  });

  it('Given cargo, Then it shows total / capacity', () => {
    const r = readCargo(hold({ ice: 2_000, metal: 600 }), createCargoReadout());
    expect(r.visible).toBe(true);
    expect(r.totalKg).toBe(2_600);
    expect(r.capacityKg).toBe(CARGO_CAPACITY_KG);
    expect(cargoTotalText(r.totalKg, r.capacityKg)).toBe('CARGO 2 600 / 8 000 KG');
  });

  it('Given ice and rare but no metal or silicate, Then one line per resource > 0, in order ICE, METAL, SILICATE, RARE', () => {
    const r = readCargo(hold({ rare: 150, ice: 2_000 }), createCargoReadout());
    expect(r.count).toBe(2);
    expect(r.resources.slice(0, r.count)).toEqual(['ice', 'rare']);
    expect(r.kg.slice(0, r.count)).toEqual([2_000, 150]);
    expect(cargoLineText('ice', 2_000)).toBe('ICE 2 000 KG');
    expect(cargoLineText('rare', 150)).toBe('RARE 150 KG');
    expect(cargoLineText('silicate', 1_234.6)).toBe('SILICATE 1 235 KG');
  });

  it('Given the same readout read twice, Then it is the same object, refilled — and lines that went to 0 are gone', () => {
    const out = createCargoReadout();
    const a = readCargo(hold({ ice: 1, metal: 2, silicate: 3, rare: 4 }), out);
    expect(a).toBe(out);
    expect(a.count).toBe(4);
    const resources = out.resources;
    const kg = out.kg;
    const b = readCargo(hold({ metal: 2 }), out);
    expect(b).toBe(out);
    expect(out.resources).toBe(resources); // no new arrays per frame
    expect(out.kg).toBe(kg);
    expect(b.count).toBe(1);
    expect(b.resources[0]).toBe('metal');
    expect(b.kg[0]).toBe(2);
    expect(b.visible).toBe(true);
  });

  it('Given 43 kg ice and room in the tank, When refined, Then the hold has exactly 0 ice and the CARGO block is hidden (R18: no ghost "ICE 0 KG")', () => {
    const cargo = hold({ ice: 43 });
    expect(applyCargoAction(cargo, new Propellant(20_000, 0), { kind: 'refine' }).ok).toBe(true);
    expect(cargo.kg('ice')).toBe(0);
    const r = readCargo(cargo, createCargoReadout());
    expect(r.visible).toBe(false);
    expect(r.count).toBe(0);
  });
});
