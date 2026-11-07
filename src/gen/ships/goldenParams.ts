/**
 * The parameter sets the golden guard pins (see golden.test.ts).
 *
 * Shared, not duplicated, because a second test proves against the SAME set
 * that the worker path is byte-identical to the synchronous one
 * (shipGenClient.test.ts). Two copies of this list would drift apart, and
 * the copy that drifted would no longer be proving anything about the golden.
 */

import type { ShipParams } from './blueprint';
import { FACTIONS, ROLE_IDS, factionRoleWeight, roleById } from './families';

export const PINNED: readonly ShipParams[] = [
  { seed: 0x5a17c0de, factionId: 'kessler', role: 'freighter', sizeClass: 'medium' },
  { seed: 0x00000001, factionId: 'sillane', role: 'survey' },
  { seed: 0x0badf00d, factionId: 'ossuary', role: 'salvager' },
  { seed: 0xdeadbeef },
  { seed: 0x13371337, factionId: 'kessler', role: 'tug', ageYears: 40, damageLevel: 0.4, maintenance: 0.3 },
];

/** Every combination the Yard offers, one deterministic seed each. */
export function sweepParams(): ShipParams[] {
  const out: ShipParams[] = [];
  for (const f of FACTIONS) {
    for (const role of ROLE_IDS) {
      if (factionRoleWeight(f, role) <= 0) continue;
      for (const sizeClass of roleById(role).sizeClasses) {
        out.push({ seed: (0x9e3779b9 * (out.length + 1)) >>> 0, factionId: f.id, role, sizeClass });
      }
    }
  }
  return out;
}
