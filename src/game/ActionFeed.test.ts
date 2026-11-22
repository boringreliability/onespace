/**
 * v4 sub-plan 6, Task 2 (phase A) — the feed hands the HUD the beam's choice.
 *
 * ActionFeed builds the HUD's action rows each frame from `mining.status`.
 * DESIGN-6 §7.2: the MINE row at rest shows the resource the beam takes
 * (`▸ READY · RARE`), so the feed reads `mining.beamResource` every frame and
 * passes it to `actionRows(status, beam)`.
 *
 * Assumed API (not there yet): ActionFeedOptions.mining has
 * `beamResource: Resource`. The options are built through a cast so
 * `npm run typecheck` stays clean before it exists.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Resource } from '@/gen/belt';
import type { ActionRow } from '@/ui/actionRows';
import { ActionFeed, type ActionFeedOptions } from './ActionFeed';
import type { ActionState, MiningKind } from './Mining';

const READY: ActionState = { kind: 'ready', progress: 0, shownKg: 0, leftS: 0, resource: null };

function feed(beam: { value: Resource }) {
  const shown: string[][] = [];
  const mining = {
    status: (_k: MiningKind): ActionState => READY,
    speedOk: true,
    get beamResource(): Resource {
      return beam.value;
    },
  };
  const hud = {
    // The rows are reused by the next frame: copy what they say now.
    setActions: (rows: readonly [ActionRow, ActionRow, ActionRow]) => shown.push(rows.map((r) => r.text)),
    setSpeedOk: () => undefined,
  };
  const f = new ActionFeed({ hud, mining, targeting: { targetId: null } } as unknown as ActionFeedOptions);
  return { f, shown };
}

describe('ActionFeed — the MINE row shows the beam\'s choice (plan 6 task 2)', () => {
  it('Given every action ready and the beam on rare, When the feed updates, Then the HUD gets MINE "▸ READY · RARE" and REFINE / REPAIR "▸ READY"', () => {
    const { f, shown } = feed({ value: 'rare' });
    f.update();
    expect(shown).toEqual([['▸ READY · RARE', '▸ READY', '▸ READY']]);
  });

  it('Given the beam changes between two frames, Then the next frame shows the new choice (read every frame, not at construction)', () => {
    const beam: { value: Resource } = { value: 'ice' };
    const { f, shown } = feed(beam);
    f.update();
    beam.value = 'silicate';
    f.update();
    expect(shown.map((rows) => rows[0])).toEqual(['▸ READY · ICE', '▸ READY · SILICATE']);
  });
});

// v4 sub-plan 6, Task 4 (phase A) — carried finding M-3 (Task 2 review):
// `actionRow('mine', …)` without a beam silently says NO ICE HERE for
// 'not-here'. The approved tests that call it without a beam stay as they are;
// these pin that the game's own call sites always hand over the ship's beam.
describe('M-3: the HUD always names the beam the ship actually has (plan 6 task 4)', () => {
  const NOT_HERE: ActionState = { kind: 'blocked', reason: 'not-here', progress: 0, shownKg: 0, leftS: 0, resource: null };

  for (const beam of ['metal', 'rare', 'silicate', 'ice'] as const) {
    it(`Given the beam on ${beam} and a rock without it, When the feed updates, Then the MINE row says NO ${beam.toUpperCase()} HERE — guard`, () => {
      const shown: string[][] = [];
      const mining = { status: (k: MiningKind): ActionState => (k === 'mine' ? NOT_HERE : READY), speedOk: true, beamResource: beam };
      const hud = {
        setActions: (rows: readonly [ActionRow, ActionRow, ActionRow]) => shown.push(rows.map((r) => r.text)),
        setSpeedOk: () => undefined,
      };
      new ActionFeed({ hud, mining, targeting: { targetId: null } } as unknown as ActionFeedOptions).update();
      expect(shown[0]![0]).toBe(`NO ${beam.toUpperCase()} HERE`);
      if (beam !== 'ice') expect(shown[0]![0]).not.toBe('NO ICE HERE');
    });
  }

  it("Given every source file, Then each actionRows(...) call passes the beam, and each actionRow('mine', ...) call passes a third argument — guard", () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, f.name);
        if (f.isDirectory()) walk(abs);
        else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) files.push(abs);
      }
    };
    walk(root);
    /** The argument list of the call starting at `open` (the index of its '('), split at top-level commas. */
    const args = (src: string, open: number): string[] => {
      let depth = 0;
      let cur = '';
      const out: string[] = [];
      for (let i = open; i < src.length; i++) {
        const c = src[i]!;
        if (c === '(' || c === '[' || c === '{') {
          depth++;
          if (depth === 1) continue;
        } else if (c === ')' || c === ']' || c === '}') {
          depth--;
          if (depth === 0) {
            out.push(cur.trim());
            return out.filter((a) => a.length > 0);
          }
        } else if (c === ',' && depth === 1) {
          out.push(cur.trim());
          cur = '';
          continue;
        }
        cur += c;
      }
      return out;
    };
    const bad: string[] = [];
    let calls = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(actionRows?)\(/g)) {
        const before = src.slice(Math.max(0, m.index! - 9), m.index!);
        if (/function\s$/.test(before)) continue; // the definitions
        const a = args(src, m.index! + m[1]!.length);
        const where = `${file.slice(root.length)}: ${m[1]}(${a.join(', ')})`;
        if (m[1] === 'actionRows') {
          calls++;
          if (a.length < 2) bad.push(where);
        } else if (/^['"`]mine['"`]$/.test(a[0] ?? '') || !/^(?:u\.kind|kind)$/.test(a[0] ?? '')) {
          // A literal 'mine', or a kind the scan cannot prove is refine/repair, must pass the beam.
          calls++;
          if (a.length < 3) bad.push(where);
        }
      }
    }
    expect(calls).toBeGreaterThan(0); // the scan sees ActionFeed's call
    expect(bad).toEqual([]);
  });
});
