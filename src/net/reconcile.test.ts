/**
 * v4 sub-plan 4, Task 5 (phase A) — `reconcile`, pure (R29; DESIGN-4 §5.2–5.4).
 *
 * Pinned surface (src/net/reconcile.ts):
 *
 *   type Decision =
 *     | { kind: 'guest' } | { kind: 'in-sync' } | { kind: 'use-cloud' }
 *     | { kind: 'push-local' } | { kind: 'adopt' }
 *     | { kind: 'conflict-same' } | { kind: 'conflict-different' }
 *     | { kind: 'refuse-switch'; message: string }
 *     | { kind: 'switch-account' }
 *   reconcile(input: { local: SaveV1 | null; cloud: SaveV1 | null;
 *                      state: SyncState; me: { id: string; name: string } | null }): Decision
 *   unsyncedProgressText(name: string): string
 *     // 'UNSYNCED PROGRESS FOR <name> — SIGN IN AS <name> ONCE ONLINE TO SYNC'
 *
 * L = state.lastSeenCloud. Equal revisions do NOT mean in sync: only L does.
 */

import { describe, expect, it } from 'vitest';

import type { SaveV1 } from '@/save/schema';

import { ACCT_A, ACCT_B, GAME_X, GAME_Y, head, save, syncState } from './__fixtures__/sync';
import { reconcile, unsyncedProgressText, type Decision } from './reconcile';
import type { SyncState } from './syncState';

const KINDS = [
  'guest',
  'in-sync',
  'use-cloud',
  'push-local',
  'adopt',
  'conflict-same',
  'conflict-different',
  'refuse-switch',
  'switch-account',
];

const boundTo = (acct: { id: string; name: string }, L: SaveV1 | null, o: Partial<SyncState> = {}): SyncState =>
  syncState({ accountId: acct.id, accountName: acct.name, lastSeenCloud: L ? head(L) : null, ...o });

function kind(input: Parameters<typeof reconcile>[0]): Decision['kind'] {
  const d = reconcile(input);
  expect(KINDS).toContain(d.kind);
  return d.kind;
}

describe('reconcile — the text', () => {
  it('Given a name, Then the refuse-switch text is verbatim', () => {
    expect(unsyncedProgressText('A')).toBe('UNSYNCED PROGRESS FOR A — SIGN IN AS A ONCE ONLINE TO SYNC');
  });
});

describe('reconcile — not signed in', () => {
  it.each<[string, SaveV1 | null, SaveV1 | null, SyncState]>([
    ['no save, fresh state', null, null, syncState()],
    ['a guest save', save(), null, syncState()],
    ['a save bound to A (signed out)', save(), null, boundTo(ACCT_A, save())],
    ['a save bound to A with unsynced progress', save({ revision: 9 }), null, boundTo(ACCT_A, save())],
  ])("Given me = null and %s, Then 'guest'", (_what, local, cloud, state) => {
    expect(kind({ local, cloud, state, me: null })).toBe('guest');
  });
});

describe('reconcile — signed in as the bound account', () => {
  const me = ACCT_A;
  const L = save({ revision: 7 });

  it("Given no local and no cloud, Then 'in-sync'", () => {
    expect(kind({ local: null, cloud: null, state: boundTo(me, null), me })).toBe('in-sync');
  });

  it("Given local = cloud = L, Then 'in-sync'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: boundTo(me, L), me })).toBe('in-sync');
  });

  it("Given the cloud newer (r9) and local = L (r7), Then 'use-cloud'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 9 }), state: boundTo(me, L), me })).toBe('use-cloud');
  });

  it("Given local newer (r9) and cloud = L (r7), Then 'push-local'", () => {
    expect(kind({ local: save({ revision: 9 }), cloud: save({ revision: 7 }), state: boundTo(me, L), me })).toBe('push-local');
  });

  it("Given both moved on the same game (local r9, cloud r8, L r7), Then 'conflict-same'", () => {
    expect(kind({ local: save({ revision: 9 }), cloud: save({ revision: 8 }), state: boundTo(me, L), me })).toBe('conflict-same');
  });

  it("Given two devices both went r5 → r6 separately (local r6, cloud r6, L r5), Then 'conflict-same' — equal revisions do NOT mean in sync", () => {
    const L5 = save({ revision: 5 });
    expect(
      kind({ local: save({ revision: 6, tank: 100 }), cloud: save({ revision: 6, tank: 9_000 }), state: boundTo(me, L5), me }),
    ).toBe('conflict-same');
  });

  it("Given NEW GAME locally while signed in (local is another saveId, cloud = L), Then 'push-local'", () => {
    expect(kind({ local: save({ saveId: GAME_Y, revision: 8 }), cloud: save({ revision: 7 }), state: boundTo(me, L), me })).toBe(
      'push-local',
    );
  });

  it("Given NEW GAME locally at a LOWER revision than L (local Y r2, cloud = L X r7), Then still 'push-local' (a new saveId is ahead whatever its revision)", () => {
    expect(kind({ local: save({ saveId: GAME_Y, revision: 2 }), cloud: save({ revision: 7 }), state: boundTo(me, L), me })).toBe(
      'push-local',
    );
  });

  it("Given another device started NEW GAME (cloud is another saveId, local = L), Then 'use-cloud'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ saveId: GAME_Y, revision: 3 }), state: boundTo(me, L), me })).toBe(
      'use-cloud',
    );
  });

  it("Given the cloud went BACK below L on the same game (cloud r6, local = L r7), Then 'use-cloud' (any change from L counts as the cloud moving)", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 6 }), state: boundTo(me, L), me })).toBe('use-cloud');
  });

  it("Given both moved and the games differ (local NEW GAME Y, cloud X r9, L X r7), Then 'conflict-different'", () => {
    expect(kind({ local: save({ saveId: GAME_Y, revision: 8 }), cloud: save({ revision: 9 }), state: boundTo(me, L), me })).toBe(
      'conflict-different',
    );
  });

  it("Given a local save and no cloud (L r7 — the cloud was emptied), Then 'push-local'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: null, state: boundTo(me, L), me })).toBe('push-local');
  });

  it("Given a local save, no cloud and L = null, Then 'push-local'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: null, state: boundTo(me, null), me })).toBe('push-local');
  });

  it("Given no local save and a cloud that moved (cloud r9, L r7), Then 'use-cloud'", () => {
    expect(kind({ local: null, cloud: save({ revision: 9 }), state: boundTo(me, L), me })).toBe('use-cloud');
  });

  it("Given no local save and a cloud = L, Then 'in-sync'", () => {
    expect(kind({ local: null, cloud: save({ revision: 7 }), state: boundTo(me, L), me })).toBe('in-sync');
  });

  it("Given both present and L = null (bound, never saw the cloud), Then both count as moved: 'conflict-same' on one game", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: boundTo(me, null), me })).toBe('conflict-same');
  });

  it('Given the persisted state after a mid-game 409 (conflict: true, L unchanged at r7), local r12 and the cloud r9, When the game reloads, Then a conflict decision', () => {
    const state = boundTo(me, L, { conflict: true });
    expect(kind({ local: save({ revision: 12 }), cloud: save({ revision: 9 }), state, me })).toBe('conflict-same');
  });

  it('Given the same inputs, When reconciled twice, Then the same decision and the inputs are not changed (pure)', () => {
    const input = { local: save({ revision: 9 }), cloud: save({ revision: 8 }), state: boundTo(me, L), me };
    const before = structuredClone(input);
    expect(reconcile(input)).toEqual(reconcile(input));
    expect(input).toEqual(before);
  });
});

describe('reconcile — a guest save or a fresh device (state.accountId = null)', () => {
  const me = ACCT_B;

  it("Given no local and no cloud, Then 'in-sync'", () => {
    expect(kind({ local: null, cloud: null, state: syncState(), me })).toBe('in-sync');
  });

  it("Given no local and a cloud save, Then 'use-cloud'", () => {
    expect(kind({ local: null, cloud: save(), state: syncState(), me })).toBe('use-cloud');
  });

  it("Given a guest save and an empty cloud, Then 'adopt'", () => {
    expect(kind({ local: save(), cloud: null, state: syncState(), me })).toBe('adopt');
  });

  it("Given a guest save and a cloud with another game, Then 'conflict-different'", () => {
    expect(kind({ local: save({ saveId: GAME_X }), cloud: save({ saveId: GAME_Y }), state: syncState(), me })).toBe(
      'conflict-different',
    );
  });

  it("Given a guest save of the cloud's game at the same revision, Then 'in-sync'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: syncState(), me })).toBe('in-sync');
  });

  it("Given a guest save of the cloud's game at another revision, Then 'conflict-same'", () => {
    expect(kind({ local: save({ revision: 8 }), cloud: save({ revision: 7 }), state: syncState(), me })).toBe('conflict-same');
  });
});

describe('reconcile — the local save is bound to another account (§5.4)', () => {
  const me = ACCT_B;
  const L = save({ revision: 7 });

  it('Given a save bound to A with unsynced progress (local r9, L r7) and B signed in, Then refuse-switch with the verbatim text naming A', () => {
    const d = reconcile({ local: save({ revision: 9 }), cloud: null, state: boundTo(ACCT_A, L), me });
    expect(d).toEqual({ kind: 'refuse-switch', message: 'UNSYNCED PROGRESS FOR Ava — SIGN IN AS Ava ONCE ONLINE TO SYNC' });
  });

  it("Given a save bound to A that never reached A's cloud (L = null) and B signed in, Then 'refuse-switch'", () => {
    expect(kind({ local: save(), cloud: save({ saveId: GAME_Y }), state: boundTo(ACCT_A, null), me })).toBe('refuse-switch');
  });

  it("Given a save bound to A that is a NEW GAME not yet pushed (local Y, L X r7) and B signed in, Then 'refuse-switch'", () => {
    expect(kind({ local: save({ saveId: GAME_Y, revision: 8 }), cloud: null, state: boundTo(ACCT_A, L), me })).toBe('refuse-switch');
  });

  it("Given a save bound to A and synced (local = L) and B signed in with an empty cloud, Then 'switch-account'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: null, state: boundTo(ACCT_A, L), me })).toBe('switch-account');
  });

  it("Given a save bound to A and synced and B signed in with a cloud save, Then 'switch-account' (B's cloud is never compared to A's save)", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ saveId: GAME_Y, revision: 2 }), state: boundTo(ACCT_A, L), me })).toBe(
      'switch-account',
    );
  });

  it("Given the state bound to A but no local save, and B signed in, Then 'switch-account'", () => {
    expect(kind({ local: null, cloud: null, state: boundTo(ACCT_A, L), me })).toBe('switch-account');
  });
});

describe('reconcile — only the nine kinds', () => {
  it('Given a sweep of inputs, Then every decision is one of the nine kinds and only refuse-switch carries a message', () => {
    const saves = [null, save({ revision: 5 }), save({ revision: 7 }), save({ revision: 9 }), save({ saveId: GAME_Y, revision: 7 })];
    const states = [syncState(), boundTo(ACCT_A, save({ revision: 7 })), boundTo(ACCT_A, null), boundTo(ACCT_B, save({ revision: 7 }))];
    const mes = [null, ACCT_A, ACCT_B];
    for (const local of saves)
      for (const cloud of saves)
        for (const state of states)
          for (const me of mes) {
            const d = reconcile({ local, cloud, state, me });
            expect(KINDS).toContain(d.kind);
            if (d.kind === 'refuse-switch') expect(typeof d.message).toBe('string');
            else expect(Object.keys(d)).toEqual(['kind']);
          }
  });
});
