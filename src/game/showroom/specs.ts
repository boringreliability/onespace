/**
 * The Yard's spec readout — a registry page, not a second scanner.
 *
 * Every value comes from `shipScanLines`, the formatter the HUD scan uses, so
 * the Yard and the scanner can never disagree about a ship. What changes is
 * the order (a registry leads with what the ship IS: class, hull, mass, drive,
 * acceleration) and one line the ten-row scanner has no room for: delta-v,
 * straight off the physics profile. Registry and operator move out of the
 * readout into the page header, where a registry puts them.
 *
 * Pure: blueprint in, plain strings out.
 */

import { shipScanLines } from '@/gen/ships/physics';
import type { ShipBlueprint } from '@/gen/ships/types';

export interface SpecLine {
  readonly label: string;
  readonly value: string;
}

export interface ShipRegistryHeader {
  readonly name: string;
  readonly className: string;
  readonly registry: string;
  readonly operator: string;
}

/** The scanner's row shape: `label ..... value`. Labels are single words. */
const ROW = /^(\S+) \.{3,} (.*)$/;

/** Rows that head the page instead of sitting in the readout. */
const HEADER_LABELS: ReadonlySet<string> = new Set(['registry', 'operator']);

/** Leading order. Anything else the scanner wrote follows in its own order. */
const LEAD: readonly string[] = ['class', 'hull', 'mass', 'drive', 'accel'];

export const DELTA_V_LABEL = 'Δv';

/** Three significant figures, the precision a mass ratio is known to. */
export function formatDeltaV(kmS: number): string {
  const v = Math.max(0, kmS);
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} km/s`;
}

/** The scanner's own wording for an unpowered hull. */
const NO_DRIVE = 'no active drive signature';

export function shipSpecs(bp: ShipBlueprint): readonly SpecLine[] {
  const rows: SpecLine[] = [];
  // A derelict is "hulk: no power, history only" (types.ts), but the
  // generator still fits it working engines and `shipScanLines` reports them
  // — measured, every derelict seed sampled read "2 × fusion torch, 7 GN".
  // That is a generator gap (reported, not fixed here: gen/ is frozen by the
  // golden test). The registry states what the hull IS: no drive, so no
  // acceleration and no delta-v either.
  const dead = bp.role === 'derelict';
  for (const line of shipScanLines(bp)) {
    const m = ROW.exec(line);
    if (!m || HEADER_LABELS.has(m[1]!)) continue;
    if (dead && m[1] === 'accel') continue;
    rows.push({ label: m[1]!, value: dead && m[1] === 'drive' ? NO_DRIVE : m[2]! });
  }
  const lead: SpecLine[] = [];
  for (const label of LEAD) {
    const r = rows.find((x) => x.label === label);
    if (r) lead.push(r);
  }
  // Delta-v only means something for a ship with a working drive; on a
  // derelict it is a number about engines that are not there. `accel` is the
  // scanner's own "this ship is powered" marker, so the two travel together.
  if (lead.some((r) => r.label === 'accel')) {
    lead.push({ label: DELTA_V_LABEL, value: formatDeltaV(bp.physics.deltaVKmS) });
  }
  for (const r of rows) if (!LEAD.includes(r.label)) lead.push(r);
  return lead;
}

export function shipRegistry(bp: ShipBlueprint): ShipRegistryHeader {
  return {
    name: bp.scan.displayName || bp.name,
    className: bp.scan.className || `${bp.familyId} ${bp.role}`,
    registry: bp.scan.registry,
    operator: bp.scan.operator,
  };
}
