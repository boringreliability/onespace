/**
 * v4 sub-plan 6, Task 4 review fix (phase A) — I-1 (R11): the HUD behind the
 * resources sheet must not contradict it (DESIGN-6 §7.1: USES and the HUD rows
 * "never say different things").
 *
 * While the mode is `resources`, `hud`, `instruments` and `action-feed` sleep
 * (gating.ts), so the HUD's CARGO block and its MINE / REFINE / REPAIR rows
 * would stand still on what they said before the sheet opened — a stale CARGO
 * 1 000 beside the sheet's HOLD 0. Owner ruling: hide those two blocks while
 * the sheet is open, keep the log (the JETTISONED line is read there). The rest
 * of the HUD is not decided here.
 *
 * The DOM write does not run in node (as StarMap's `jumpCostCell` or the
 * hints): the rule is pure and tested here; that the HUD applies it is pinned
 * by a scan.
 *
 * Assumed surface (src/ui/hudBlocks.ts), for the owner's approval:
 *
 *   export interface HudBlocks { readonly cargo: boolean; readonly actions: boolean; readonly log: boolean }
 *   export function hudBlocks(base: BaseMode): HudBlocks;
 *
 * The module does not exist yet: it is loaded by a path the type checker does
 * not follow, and every test first asserts the export it needs.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BaseMode } from '@/core/Modes';

interface HudBlocks {
  readonly cargo: boolean;
  readonly actions: boolean;
  readonly log: boolean;
}
interface Mod {
  hudBlocks?: (base: BaseMode) => HudBlocks;
}

const MODULE = './hudBlocks';
let mod: Mod = {};
let loadError: unknown = null;

beforeAll(async () => {
  try {
    mod = (await import(/* @vite-ignore */ MODULE)) as Mod;
  } catch (e) {
    loadError = e;
  }
});

function hudBlocks(base: BaseMode): HudBlocks {
  expect(loadError, 'src/ui/hudBlocks.ts must exist').toBeNull();
  expect(mod.hudBlocks, 'hudBlocks.ts must export hudBlocks').toBeDefined();
  return mod.hudBlocks!(base);
}

describe('I-1 (R11): which HUD blocks show over which mode', () => {
  it('Given the resources screen open, Then the CARGO block and the action rows are hidden, and the log is shown', () => {
    expect(hudBlocks('resources')).toEqual({ cargo: false, actions: false, log: true });
  });

  for (const base of ['flight', 'map', 'review'] as const) {
    it(`Given ${base}, Then the CARGO block, the action rows and the log all show, as before (the HUD's own visibility is ReviewGuard's)`, () => {
      expect(hudBlocks(base)).toEqual({ cargo: true, actions: true, log: true });
    });
  }

  it('Given every source file, Then hudBlocks is imported and called outside its own module (the HUD applies it)', () => {
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
    const users = files
      .filter((f) => f !== join(root, 'ui', 'hudBlocks.ts'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return (
          /import\s*\{[^}]*\bhudBlocks\b[^}]*\}\s*from\s*'(?:@\/ui\/hudBlocks|\.\/hudBlocks|\.\.\/ui\/hudBlocks)'/.test(src) &&
          /\bhudBlocks\(/.test(src)
        );
      });
    expect(users.length).toBeGreaterThan(0);
  });
});
