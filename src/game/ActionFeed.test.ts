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
