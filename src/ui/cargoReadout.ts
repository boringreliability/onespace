/**
 * v4 sub-plan 2, Task 5 — what the HUD's CARGO block (under PROP) says.
 * Pure: no DOM, no bus. `readCargo` fills a preallocated readout in place, so
 * Instruments can call it every frame without allocating.
 */

import type { Resource } from '@/gen/belt';
import type { Cargo } from '@/ship/cargo';
import { formatKg } from '@/game/miningRules';

/** Line order on the HUD. */
export const CARGO_LINE_ORDER: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

export interface CargoReadout {
  /** Something is in the hold (and there is a hold). */
  visible: boolean;
  totalKg: number;
  capacityKg: number;
  /** Lines in use: `resources[0..count)` and `kg[0..count)`. */
  count: number;
  readonly resources: Resource[];
  readonly kg: number[];
}

export function createCargoReadout(): CargoReadout {
  return {
    visible: false,
    totalKg: 0,
    capacityKg: 0,
    count: 0,
    resources: CARGO_LINE_ORDER.slice(),
    kg: [0, 0, 0, 0],
  };
}

/** Fill `out` from the hold: one line per resource > 0, hidden when empty or absent. Returns `out`. */
export function readCargo(cargo: Pick<Cargo, 'kg' | 'totalKg' | 'capacityKg'> | null, out: CargoReadout): CargoReadout {
  out.count = 0;
  if (!cargo) {
    out.visible = false;
    out.totalKg = 0;
    out.capacityKg = 0;
    return out;
  }
  let total = 0;
  for (let i = 0; i < CARGO_LINE_ORDER.length; i++) {
    const r = CARGO_LINE_ORDER[i]!;
    const kg = cargo.kg(r);
    if (!(kg > 0)) continue;
    out.resources[out.count] = r;
    out.kg[out.count] = kg;
    out.count++;
    total += kg;
  }
  out.totalKg = total;
  out.capacityKg = cargo.capacityKg;
  out.visible = out.count > 0;
  return out;
}

export function cargoTotalText(totalKg: number, capacityKg: number): string {
  return `CARGO ${formatKg(totalKg)} / ${formatKg(capacityKg)} KG`;
}

export function cargoLineText(r: Resource, kg: number): string {
  return `${r.toUpperCase()} ${formatKg(kg)} KG`;
}
