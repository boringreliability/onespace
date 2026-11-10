/**
 * v4 sub-plan 2, Task 7 fix round 1 (R22 §4) — the scanner names a field the
 * way the chart and the nav target do: `BELT · <system> <k>`, not `Field k`.
 *
 * Harness as in `Scanner.test.ts`: the real Scanner and Belt over a plain
 * universe stub, the ship 200 000 km off field 398 with the field targeted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';

import { bus } from '@/core/EventBus';
import { Belt } from './Belt';
import { Scanner, type ScannerOptions } from './Scanner';
import { WorldState } from './worldState';
import { fieldCentre, fyssField, nodeCtx, startSystem } from './testing/beltFixture';

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

describe('Scanner — a field target is named BELT · <system> <k>', () => {
  it('Given field 398 targeted from 200 000 km, When T is pressed, Then the log reads BELT · FYSS 398 BEYOND ARRAY RANGE', () => {
    const f = fyssField(398);
    const centre = fieldCentre(f, 0);
    const ship = centre.clone().add(new Vector3(0, 200_000, 0));
    const universe = {
      system: startSystem(),
      orbitSeconds: 0,
      shipParent: null,
      allBodies: () => [],
      flight: { worldPosition: ship, forward: new Vector3(0, -1, 0) },
    };
    const worldState = new WorldState({ orbitSeconds: () => 0, wallMs: () => 0 });
    const belt = new Belt({ universe, worldState });
    const targeting = { targetId: f.id as string | null };
    const scanner = new Scanner({ universe, traffic: null, targeting, belt } as unknown as ScannerOptions);

    const logs: string[] = [];
    offs.push(bus.on('log', ({ text }) => logs.push(text)));
    let t = false;
    const ctx = nodeCtx({ input: { pressed: (a: string) => a === 'scan' && t, down: () => false } });
    belt.update(1 / 60, ctx);
    t = true;
    scanner.update(1 / 60, ctx);
    t = false;
    for (let i = 0; i < 120; i++) {
      belt.update(1 / 60, ctx);
      scanner.update(1 / 60, ctx);
    }

    expect(logs, logs.join(' | ')).toContain('BELT · FYSS 398 BEYOND ARRAY RANGE');
    expect(logs.some((l) => l.includes('FIELD 398'))).toBe(false);
  });
});
