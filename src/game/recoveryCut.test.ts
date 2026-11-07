/**
 * review-p1 — the recovery cut's hand-off to the rest of the game, in node
 * (no `init()`, so no veil; `update()` needs none of the DOM).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext } from '@/core/Engine';
import type { Universe } from '@/game/Universe';
import { RecoveryCut } from './RecoveryCut';

const offs: Array<() => void> = [];
afterEach(() => {
  for (const o of offs.splice(0)) o();
});

function rig() {
  const command = { throttle: 0.6 };
  let recovered = 0;
  const universe = {
    insideStar: false,
    paused: false,
    flight: { command },
    recoverToOrbit: () => {
      recovered++;
    },
  };
  const lever: number[] = [];
  const ctx = { input: { setThrottle: (v: number) => lever.push(v) } } as unknown as EngineContext;
  const cut = new RecoveryCut(universe as unknown as Universe);
  return { cut, ctx, command, lever, recovered: () => recovered };
}

describe('review-p1: RecoveryCut', () => {
  it('Given RETURN TO ORBIT with the lever at 60 %, When the cut reaches black, Then the ship is moved once, the lever AND the stale command are cut, and ship:recovered is announced once', () => {
    const r = rig();
    const events: string[] = [];
    offs.push(bus.on('ship:recovered', ({ cause }) => events.push(cause)));
    r.cut.request('requested');
    for (let i = 0; i < 120; i++) r.cut.update(1 / 60, r.ctx);
    expect(r.recovered()).toBe(1);
    expect(r.lever).toEqual([0]);
    // Pilot is frozen through the fade; without this the first physics step
    // after it flew the old 60 % as an FA-ON speed hold (e = 0.12).
    expect(r.command.throttle).toBe(0);
    expect(events).toEqual(['requested']);
  });
});
