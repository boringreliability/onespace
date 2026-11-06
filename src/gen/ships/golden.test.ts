/**
 * Golden ships — the version guard.
 *
 * A shared yard link is a promise: the same seed shows the same ship. That
 * promise only holds while generation is frozen per `SHIP_GENERATION_VERSION`.
 * Any change to the generator that moves a single byte of these five
 * blueprints must bump the version and re-record the golden — otherwise every
 * link anyone has saved silently starts showing a different ship.
 *
 * To re-record after a deliberate change:
 *   1. bump SHIP_GENERATION_VERSION in src/gen/ships/types.ts
 *   2. UPDATE_GOLDEN=1 npx vitest run src/gen/ships/golden.test.ts
 *   3. commit golden.json together with the generator change
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateShip, type ShipParams } from './blueprint';
import { SHIP_GENERATION_VERSION } from './types';

const GOLDEN_PATH = fileURLToPath(new URL('./golden.json', import.meta.url));

const PINNED: readonly ShipParams[] = [
  { seed: 0x5a17c0de, factionId: 'kessler', role: 'freighter', sizeClass: 'medium' },
  { seed: 0x00000001, factionId: 'sillane', role: 'survey' },
  { seed: 0x0badf00d, factionId: 'ossuary', role: 'salvager' },
  { seed: 0xdeadbeef },
  { seed: 0x13371337, factionId: 'kessler', role: 'tug', ageYears: 40, damageLevel: 0.4, maintenance: 0.3 },
];

function digest(p: ShipParams): string {
  return createHash('sha256').update(JSON.stringify(generateShip(p))).digest('hex').slice(0, 16);
}

interface Golden {
  version: number;
  hashes: string[];
}

describe('golden ships', () => {
  it('Given the same params twice, Then the blueprints are deeply equal (determinism)', () => {
    for (const p of PINNED.slice(0, 2)) expect(generateShip(p)).toEqual(generateShip(p));
  });

  it('Given the pinned params, Then their hashes match the golden recorded for this generation version', () => {
    const hashes = PINNED.map(digest);
    if (process.env.UPDATE_GOLDEN) {
      const g: Golden = { version: SHIP_GENERATION_VERSION, hashes };
      writeFileSync(GOLDEN_PATH, JSON.stringify(g, null, 2) + '\n');
    }
    expect(existsSync(GOLDEN_PATH), 'golden.json is missing — record it (see header)').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    expect(
      golden.version,
      'golden.json was recorded for another SHIP_GENERATION_VERSION — re-record it (see header)',
    ).toBe(SHIP_GENERATION_VERSION);
    expect(
      hashes,
      'ship generation changed without a version bump — bump SHIP_GENERATION_VERSION and re-record (see header)',
    ).toEqual(golden.hashes);
  });
});
