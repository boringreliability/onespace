/**
 * v4 sub-plan 6, Task 4 review fix (phase A) — M-1 (R12): the dust stays in
 * view behind the resources sheet.
 *
 * The resources screen is flight paused (DESIGN-6 §7.1: time stands still), not
 * flight left. Dust hid itself on every mode outside its own activeIn
 * (title / flight / map), so the motes vanished while the sheet was open and
 * popped back on close. Really leaving flight (the Yard) still hides them.
 *
 * Only the mode change is exercised: no frame is drawn (three.js objects need
 * no WebGL in node), and the universe is never read by onModeChange.
 */

import { describe, expect, it } from 'vitest';

import type { GameModule } from '@/core/Engine';
import { Dust, type DustOptions } from './Dust';

function shownDust(): Dust {
  const dust = new Dust({ universe: {}, warping: () => false } as unknown as DustOptions);
  // As after a flight frame in a lit field: the motes are drawn.
  dust.mesh.visible = true;
  return dust;
}

describe('Dust — the resources screen does not hide the motes (plan 6 task 4, M-1)', () => {
  it('Given dust in view, When the resources screen opens, Then it stays drawn', () => {
    const dust = shownDust();
    (dust as GameModule).onModeChange?.('flight', 'resources', {} as never);
    expect(dust.mesh.visible).toBe(true);
  });

  it('Given dust in view, When the screen opens and closes, Then it is still drawn (no pop on close)', () => {
    const dust = shownDust();
    (dust as GameModule).onModeChange?.('flight', 'resources', {} as never);
    (dust as GameModule).onModeChange?.('resources', 'flight', {} as never);
    expect(dust.mesh.visible).toBe(true);
  });

  it('Given dust in view, When flight is left for the Yard, Then it is hidden, as before — guard', () => {
    const dust = shownDust();
    (dust as GameModule).onModeChange?.('flight', 'yard', {} as never);
    expect(dust.mesh.visible).toBe(false);
  });
});
