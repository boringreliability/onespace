/**
 * review-p1 — the pause module's seams with the rest of the game, in node.
 *
 * `Pause` builds its DOM in `init()`; the constructor and `update()` need
 * none of it, which is all these tests touch.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { EngineContext } from '@/core/Engine';
import { modes } from '@/core/Modes';
import type { StickSettings } from '@/core/stick';
import type { RecoveryCut } from '@/game/RecoveryCut';
import type { Universe } from '@/game/Universe';
import { Pause } from './Pause';
import { ESC_DEBOUNCE_MS, PAUSE_CLOSED, pauseStep } from './pauseState';
import { bus } from '@/core/EventBus';
import { SYNC_OFFLINE_TEXT, SYNC_REAUTH_TEXT, type SyncStatus } from '@/net/SyncClient';

function rig(): { pause: Pause; universe: { frozen: boolean }; applied: StickSettings[]; ctx: EngineContext } {
  const universe = { frozen: false };
  const applied: StickSettings[] = [];
  const pause = new Pause({
    universe: universe as unknown as Universe,
    recovery: { active: false } as unknown as RecoveryCut,
    warp: { phase: 'idle' },
    input: { setStickSettings: (s) => applied.push(s) },
  });
  const ctx = { input: { pressed: () => false } } as unknown as EngineContext;
  return { pause, universe, applied, ctx };
}

afterEach(() => {
  if (modes.overlay) modes.pop();
});

describe('review-p1: pauseStep timing, pinned', () => {
  const flying = { overlayOpen: false, busy: false };
  it('Given opened at t 1 000, When Esc arrives at exactly t 1 350, Then it closes', () => {
    expect(pauseStep({ open: true, openedAt: 1_000 }, { type: 'escKey', t: 1_350 }, flying).state.open).toBe(false);
  });

  it('Given opened at t 0, When Esc arrives at t 400, Then it closes (the debounce is 350 ms, not longer)', () => {
    expect(ESC_DEBOUNCE_MS).toBe(350);
    expect(pauseStep({ open: true, openedAt: 0 }, { type: 'escKey', t: 400 }, flying).state.open).toBe(false);
  });

  it('Given a lock loss at t 5 000 opened it, When the same Esc arrives at t 5 100, Then it stays open', () => {
    const a = pauseStep(PAUSE_CLOSED, { type: 'lockLost', t: 5_000 }, flying).state;
    expect(a.openedAt).toBe(5_000);
    expect(pauseStep(a, { type: 'escKey', t: 5_100 }, flying).state.open).toBe(true);
  });

  it('Given an Esc at t 5 000 opened it, When a repeat arrives at t 5 100, Then it stays open', () => {
    const a = pauseStep(PAUSE_CLOSED, { type: 'escKey', t: 5_000 }, flying).state;
    expect(a.openedAt).toBe(5_000);
    expect(pauseStep(a, { type: 'escKey', t: 5_100 }, flying).state.open).toBe(true);
  });
});

describe('review-p1: Pause wiring', () => {
  it('Given the pause sheet, When MOUSE SENSITIVITY or INVERT PITCH changes, Then the live Input gets it now — not after a reload', () => {
    const r = rig();
    r.pause.applyStickSettings({ sensitivity: 2, invertY: true });
    expect(r.applied).toEqual([{ sensitivity: 2, invertY: true }]);
  });

  it('Given flight with nothing open, When Pause updates, Then the world is not frozen', () => {
    const r = rig();
    if (modes.base !== 'flight') modes.go('flight');
    r.pause.update(1 / 60, r.ctx);
    expect(r.universe.frozen).toBe(false);
  });

  it('Given the photo overlay is up, When Pause updates, Then the world is frozen (the ship no longer flies on behind the photo camera)', () => {
    const r = rig();
    if (modes.base !== 'flight') modes.go('flight');
    modes.push('photo');
    r.pause.update(1 / 60, r.ctx);
    expect(r.universe.frozen).toBe(true);
    modes.pop();
    r.pause.update(1 / 60, r.ctx);
    expect(r.universe.frozen).toBe(false);
  });
});

// v4-net Task 6 (phase A): PauseOptions gains
//   sync?: Pick<SyncClient, 'status' | 'statusText'> | null
// and Pause.update logs a status change once (tone 'warn'), not per frame;
// the status at construction is the boot's, already in the boot notices.
describe('v4-net Task 6: Pause logs a sync status change once', () => {
  function syncRig(status: SyncStatus, text: string | null) {
    const sync = { st: status, text, status: () => sync.st, statusText: () => sync.text };
    const pause = new Pause({
      universe: { frozen: false } as unknown as Universe,
      recovery: { active: false } as unknown as RecoveryCut,
      warp: { phase: 'idle' },
      sync,
    } as ConstructorParameters<typeof Pause>[0]);
    const ctx = { input: { pressed: () => false } } as unknown as EngineContext;
    const logs: string[] = [];
    const off = bus.on('log', (e) => logs.push(e.text));
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) pause.update(1 / 60, ctx);
    };
    return { sync, frames, logs, off };
  }

  it('Given the boot status offline (already logged at boot), When Pause updates for many frames, Then it is not logged again', () => {
    const r = syncRig('offline', SYNC_OFFLINE_TEXT);
    r.frames(30);
    r.off();
    expect(r.logs.filter((t) => t === SYNC_OFFLINE_TEXT)).toEqual([]);
  });

  it('Given synced, When the status turns reauth, Then SIGN IN AGAIN TO SYNC is logged exactly once over many frames', () => {
    const r = syncRig('synced', null);
    r.frames(3);
    r.sync.st = 'reauth';
    r.sync.text = SYNC_REAUTH_TEXT;
    r.frames(30);
    r.off();
    expect(r.logs.filter((t) => t === SYNC_REAUTH_TEXT)).toEqual([SYNC_REAUTH_TEXT]);
  });

  it('Given synced, When it goes offline, a retry is pending, and it fails offline again, Then OFFLINE — SAVED LOCALLY is logged once', () => {
    const r = syncRig('synced', null);
    r.frames(2);
    Object.assign(r.sync, { st: 'offline', text: SYNC_OFFLINE_TEXT });
    r.frames(5);
    Object.assign(r.sync, { st: 'pending', text: null });
    r.frames(5);
    Object.assign(r.sync, { st: 'offline', text: SYNC_OFFLINE_TEXT });
    r.frames(5);
    r.off();
    expect(r.logs.filter((t) => t === SYNC_OFFLINE_TEXT)).toEqual([SYNC_OFFLINE_TEXT]);
  });
});
