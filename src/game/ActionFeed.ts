/**
 * v4 sub-plan 5, Task 4 — feeds the HUD's action block and VEL's mining tone.
 *
 * Each frame: `hud.setActions(actionRows(mining.status, mining.beamResource))`
 * (MINE / REFINE / REPAIR: ready, why not, or how far; the MINE row at rest
 * names the beam's choice, plan 6 Task 2 — read every frame) and `hud.setSpeedOk(...)` — Mining's
 * speed verdict while an asteroid is the nav target, null otherwise.
 *
 * Its own module, registered AFTER Mining: Instruments is built before Mining
 * and cannot read it, and status() must read this frame's measurements, which
 * Mining.update makes. Stands down while a review shot owns the scene, so the
 * shot's own rows survive. Allocates nothing per frame (actionRows reuses its
 * rows; the status callback is bound once).
 */

import type { GameModule } from '@/core/Engine';
import { shotOwnsScene } from '@/game/Shots';
import type { ActionState, MiningKind } from '@/game/Mining';
import type { Resource } from '@/gen/belt';
import type { Hud } from '@/ui/Hud';
import { actionRows } from '@/ui/actionRows';

export interface ActionFeedOptions {
  readonly hud: Pick<Hud, 'setActions' | 'setSpeedOk'>;
  readonly mining: { status(kind: MiningKind): ActionState; readonly speedOk: boolean; readonly beamResource: Resource };
  readonly targeting: { readonly targetId: string | null };
}

export class ActionFeed implements GameModule {
  readonly name = 'action-feed';

  private readonly opts: ActionFeedOptions;
  private readonly status: (kind: MiningKind) => ActionState;

  constructor(opts: ActionFeedOptions) {
    this.opts = opts;
    const mining = opts.mining;
    this.status = (kind) => mining.status(kind);
  }

  update(): void {
    if (shotOwnsScene()) return;
    const { hud, mining, targeting } = this.opts;
    hud.setActions(actionRows(this.status, mining.beamResource));
    const id = targeting.targetId;
    hud.setSpeedOk(id !== null && id.startsWith('ast:') ? mining.speedOk : null);
  }
}
