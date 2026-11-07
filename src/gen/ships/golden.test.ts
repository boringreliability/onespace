/**
 * Golden ships — the version guard.
 *
 * A shared yard link is a promise: the same seed shows the same ship. That
 * promise only holds while generation is frozen per `SHIP_GENERATION_VERSION`.
 * Any change to the generator that moves a single byte of these blueprints
 * must bump the version and re-record the golden — otherwise every link
 * anyone has saved silently starts showing a different ship.
 *
 * To re-record after a deliberate change:
 *   1. bump SHIP_GENERATION_VERSION in src/gen/ships/types.ts
 *   2. UPDATE_GOLDEN=1 npx vitest run src/gen/ships/golden.test.ts
 *   3. commit golden.json together with the generator change
 *
 * review-p2: two holes closed.
 *  - Re-recording WITHOUT step 1 used to pass: UPDATE_GOLDEN overwrote the
 *    hashes under the same version number and the guard went green. It now
 *    refuses to change a recorded hash under an unchanged version.
 *  - Five hand-picked ships left most of the generator unpinned (one ship per
 *    faction at most, two size classes). `sweep` pins one hull for every
 *    legal faction × role × size combination the Yard can offer.
 *
 * The guard covers the BLUEPRINT only. The mesh built from it
 * (render/ships/*) has its own seeded detail and is not pinned here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateShip, type ShipParams } from './blueprint';
import { PINNED, sweepParams } from './goldenParams';
import { SHIP_GENERATION_VERSION } from './types';

const GOLDEN_PATH = fileURLToPath(new URL('./golden.json', import.meta.url));

function digest(p: ShipParams): string {
  return createHash('sha256').update(JSON.stringify(generateShip(p))).digest('hex').slice(0, 16);
}

function sweepDigest(): string {
  const h = createHash('sha256');
  for (const p of sweepParams()) h.update(digest(p));
  return h.digest('hex').slice(0, 16);
}

export interface Golden {
  version: number;
  hashes: string[];
  sweep?: string;
}

/**
 * Why re-recording `next` over `prev` must be refused, or null if it may go
 * ahead. A new version may record anything; the same version may only ADD
 * a field it did not have.
 */
export function rerecordRefusal(prev: Golden | null, next: Golden): string | null {
  if (!prev || prev.version !== next.version) return null;
  const same = prev.hashes.length === next.hashes.length && prev.hashes.every((h, i) => h === next.hashes[i]);
  if (!same || (prev.sweep !== undefined && prev.sweep !== next.sweep)) {
    return `generation changed under version ${next.version} — bump SHIP_GENERATION_VERSION before re-recording`;
  }
  return null;
}

describe('golden ships', () => {
  it('Given the same params twice, Then the blueprints are deeply equal (determinism)', () => {
    for (const p of PINNED.slice(0, 2)) expect(generateShip(p)).toEqual(generateShip(p));
  });

  it('Given the pinned params and the full sweep, Then their hashes match the golden recorded for this generation version', () => {
    const next: Golden = { version: SHIP_GENERATION_VERSION, hashes: PINNED.map(digest), sweep: sweepDigest() };
    const prev = existsSync(GOLDEN_PATH) ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden) : null;
    if (process.env.UPDATE_GOLDEN) {
      const refusal = rerecordRefusal(prev, next);
      if (refusal) throw new Error(refusal);
      writeFileSync(GOLDEN_PATH, JSON.stringify(next, null, 2) + '\n');
    }
    expect(existsSync(GOLDEN_PATH), 'golden.json is missing — record it (see header)').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;
    expect(
      golden.version,
      'golden.json was recorded for another SHIP_GENERATION_VERSION — re-record it (see header)',
    ).toBe(SHIP_GENERATION_VERSION);
    expect(
      next.hashes,
      'ship generation changed without a version bump — bump SHIP_GENERATION_VERSION and re-record (see header)',
    ).toEqual(golden.hashes);
    expect(golden.sweep, 'golden.json has no sweep — record it (see header)').toBeDefined();
    expect(
      next.sweep,
      'ship generation changed (sweep) without a version bump — bump SHIP_GENERATION_VERSION and re-record (see header)',
    ).toBe(golden.sweep);
    // ~150 hulls, super-capitals included: a few seconds, paid once per run.
  }, 30_000);
});

describe('rerecordRefusal', () => {
  const v1: Golden = { version: 1, hashes: ['a', 'b'], sweep: 's' };

  it('Given changed hashes under the same version, When re-recording, Then it is refused', () => {
    expect(rerecordRefusal(v1, { ...v1, hashes: ['a', 'c'] })).toMatch(/bump SHIP_GENERATION_VERSION/);
  });

  it('Given a changed sweep under the same version, When re-recording, Then it is refused', () => {
    expect(rerecordRefusal(v1, { ...v1, sweep: 't' })).not.toBeNull();
  });

  it('Given a bumped version, When re-recording changed hashes, Then it may go ahead', () => {
    expect(rerecordRefusal(v1, { version: 2, hashes: ['x', 'y'], sweep: 'z' })).toBeNull();
  });

  it('Given an older golden with no sweep, When the same version adds one, Then it may go ahead', () => {
    expect(rerecordRefusal({ version: 1, hashes: ['a', 'b'] }, v1)).toBeNull();
  });

  it('Given no golden at all, When recording, Then it may go ahead', () => {
    expect(rerecordRefusal(null, v1)).toBeNull();
  });
});
