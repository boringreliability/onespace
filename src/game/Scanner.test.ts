/**
 * v4 sub-plan 2, Task 3 — the scanner reads asteroids.
 *
 * T on an asteroid target sweeps it (SWEEP_TIME 1.4 s) and reports what it is
 * made of: for each resource, the generated kilograms AND what is left after
 * mining (Belt.remainingKg, WorldState). The result is `kind: 'asteroid'`, and
 * the ship's log files it once under `scan:<asteroid id>` as a note.
 *
 * Harness: the real Scanner, Belt and ShipLog over a plain universe stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import type { Resource } from '@/gen/belt';
import type { ScanResult } from '@/gen/types';
import { Belt } from './Belt';
import { ShipLog } from './Log';
import { Scanner, type ScannerOptions } from './Scanner';
import { WorldState } from './worldState';
import { fieldCentre, fyssField, nodeCtx, startSystem } from './testing/beltFixture';

const RESOURCES: readonly Resource[] = ['ice', 'metal', 'silicate', 'rare'];

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const offs: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.unstubAllGlobals();
});

const F = fyssField(398);
const AST = F.asteroids.find((a) => a.composition.ice >= 1_000)!;

function rig() {
  const centre = fieldCentre(F, 0);
  // 5 km from the asteroid, nose on it.
  const astWorld = new Vector3(centre.x + AST.offsetKm[0], centre.y + AST.offsetKm[1], centre.z + AST.offsetKm[2]);
  const ship = astWorld.clone().add(new Vector3(5, 0, 0));
  const universe = {
    system: startSystem(),
    orbitSeconds: 0,
    shipParent: null,
    allBodies: () => [],
    flight: { worldPosition: ship, forward: new Vector3(-1, 0, 0) },
  };
  const worldState = new WorldState({ orbitSeconds: () => 0, wallMs: () => 0 });
  const belt = new Belt({ universe, worldState });
  const targeting = { targetId: AST.id as string | null };
  const scanner = new Scanner({ universe, traffic: null, targeting, belt } as unknown as ScannerOptions);

  const results: ScanResult[] = [];
  const logs: string[] = [];
  offs.push(bus.on('scan:complete', (s) => results.push(s)));
  offs.push(bus.on('log', ({ text }) => logs.push(text)));

  let t = false;
  const ctx = nodeCtx({ input: { pressed: (a: string) => a === 'scan' && t, down: () => false } });
  const scan = (): ScanResult | undefined => {
    const before = results.length;
    belt.update(1 / 60, ctx);
    t = true;
    scanner.update(1 / 60, ctx);
    t = false;
    for (let i = 0; i < 120 && results.length === before; i++) {
      belt.update(1 / 60, ctx);
      scanner.update(1 / 60, ctx);
    }
    return results[before];
  };
  return { scan, worldState, belt, logs };
}

/** Integers in a line, with digit-group separators (`,` thin/normal space) removed. */
function numbersIn(line: string): number[] {
  const joined = line.replace(/(\d)[,   ](?=\d{3}(?!\d))/g, '$1');
  return (joined.match(/\d+/g) ?? []).map(Number);
}

function lineFor(lines: readonly string[], r: Resource): string {
  const l = lines.find((x) => x.toLowerCase().trimStart().startsWith(r));
  expect(l, `a line for ${r} in ${JSON.stringify(lines)}`).toBeDefined();
  return l!;
}

describe('Scanner — asteroids', () => {
  it("Given T on an asteroid target, Then the scan lists composition kg and remaining kg; ScanResult.kind = 'asteroid'", () => {
    const r = rig();
    const res = r.scan();
    expect(res, `logs: ${r.logs.join(' | ')}`).toBeDefined();
    expect(res!.targetId).toBe(AST.id);
    expect(res!.kind).toBe('asteroid');
    expect(res!.name.length).toBeGreaterThan(0);
    for (const k of RESOURCES) {
      const nums = numbersIn(lineFor(res!.lines, k));
      const kg = Math.round(AST.composition[k]);
      // Untouched: generated and remaining are the same number, and it is shown.
      expect(nums, `${k}: ${lineFor(res!.lines, k)}`).toContain(kg);
    }
  });

  it('Given part of the asteroid mined since the last scan, Then a new scan shows the new remaining kg next to the generated kg (no stale cache)', () => {
    const r = rig();
    r.scan();
    r.worldState.recordMined(AST.id, 'ice', 1_000, 'local');
    const res = r.scan()!;
    const nums = numbersIn(lineFor(res.lines, 'ice'));
    expect(nums).toContain(Math.round(AST.composition.ice));
    expect(nums).toContain(Math.round(AST.composition.ice - 1_000));
    // The other resources are untouched.
    expect(numbersIn(lineFor(res.lines, 'metal'))).toContain(Math.round(AST.composition.metal));
  });

  it('Given an asteroid scanned twice, Then the log records key scan:ast:… once, as a note', () => {
    const log = new ShipLog();
    log.init();
    offs.push(() => log.dispose());
    const r = rig();
    r.scan();
    r.scan();
    const entries = log.all().filter((e) => e.key === `scan:${AST.id}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('note');
    expect(entries[0]!.visits).toBe(2);
  });

  it('Given an asteroid scanned, then mined, then scanned again (final review I3a), Then its logbook note shows the NEW remaining kg, not the first scan\'s', () => {
    const log = new ShipLog();
    log.init();
    offs.push(() => log.dispose());
    const r = rig();
    r.scan();
    r.worldState.recordMined(AST.id, 'ice', 1_000, 'local');
    const second = r.scan()!;
    const entries = log.all().filter((e) => e.key === `scan:${AST.id}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toEqual(second.lines);
    expect(numbersIn(lineFor(entries[0]!.body, 'ice'))).toContain(Math.round(AST.composition.ice - 1_000));
  });
});
