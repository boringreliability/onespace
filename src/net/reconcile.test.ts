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
 *                      state: SyncState; me: { id: string; name: string } | null;
 *                      localDirty: boolean; sameContent: boolean }): Decision
 *     // localDirty (Ruling R36): the boot load applied WAL critical entries on
 *     // top of the stored snapshot (BootLoad.walApplied) — paid progress the
 *     // cloud has never seen, so the local save counts as ahead.
 *     // sameContent (Ruling R43, fix round 1): local and cloud are deep-equal
 *     // as saves → 'in-sync' in every signed-in branch (other account included).
 *   unsyncedProgressText(name: string): string
 *     // 'UNSYNCED PROGRESS FOR <name> — SIGN IN AS <name> ONCE ONLINE TO SYNC'
 *
 * L = state.lastSeenCloud. Equal revisions do NOT mean in sync: only L does.
 * Ruling R37: in the bound branch, a cloud that moved on the SAME game but is
 * not strictly newer than local (rolled back) is a conflict, never use-cloud.
 * Ruling R41 (fix round 1): no local save and a cloud save → 'use-cloud' in
 * every signed-in branch.
 */

import { describe, expect, it } from 'vitest';

import type { SaveV1 } from '@/save/schema';
import { displayName } from '@/ui/accountMenu';

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

type Input = Omit<Parameters<typeof reconcile>[0], 'localDirty' | 'sameContent'> & {
  localDirty?: boolean;
  sameContent?: boolean;
};

/** `reconcile` with localDirty and sameContent false unless the test says otherwise. */
const rc = (input: Input): Decision => reconcile({ localDirty: false, sameContent: false, ...input });

function kind(input: Input): Decision['kind'] {
  const d = rc(input);
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

  it("Ruling R37: Given the cloud went BACK below L on the same game (cloud r6, local = L r7), Then 'conflict-same' — never go backwards silently", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 6 }), state: boundTo(me, L), me })).toBe('conflict-same');
  });

  it("Ruling R37: Given local = L = r9 and the cloud one revision back (r8) on the same game, Then 'conflict-same' (use-cloud needs a strictly newer cloud or another game)", () => {
    const L9 = save({ revision: 9 });
    expect(kind({ local: save({ revision: 9 }), cloud: save({ revision: 8 }), state: boundTo(me, L9), me })).toBe('conflict-same');
  });

  it("Ruling R37: Given another game in the cloud at a LOWER revision than local (local = L), Then still 'use-cloud' (another game is never compared by revision)", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ saveId: GAME_Y, revision: 2 }), state: boundTo(me, L), me })).toBe('use-cloud');
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

  // CHANGED by Ruling R41 (fix round 1): was "…Then 'in-sync'" / toBe('in-sync').
  it("Ruling R41: Given no local save and a cloud = L, Then 'use-cloud' (the cloud's save is what this device should load)", () => {
    expect(kind({ local: null, cloud: save({ revision: 7 }), state: boundTo(me, L), me })).toBe('use-cloud');
  });

  it("Given both present and L = null (bound, never saw the cloud), Then both count as moved: 'conflict-same' on one game", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: boundTo(me, null), me })).toBe('conflict-same');
  });

  it("Given another device started NEW GAME that sits at the SAME revision number as L (cloud Y r7, local = L X r7), Then 'use-cloud' — a new saveId is ahead whatever its revision", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ saveId: GAME_Y, revision: 7 }), state: boundTo(me, L), me })).toBe(
      'use-cloud',
    );
  });

  it("Ruling R37: Given the cloud moved to the SAME revision as local on the same game with other content (local r7 behind L r9, cloud r7), Then 'conflict-same' — an equal revision is not strictly newer", () => {
    const L9 = save({ revision: 9 });
    expect(kind({ local: save({ revision: 7, tank: 100 }), cloud: save({ revision: 7, tank: 9_000 }), state: boundTo(me, L9), me })).toBe(
      'conflict-same',
    );
  });

  it('Given the persisted state after a mid-game 409 (conflict: true, L unchanged at r7), local r12 and the cloud r9, When the game reloads, Then a conflict decision', () => {
    const state = boundTo(me, L, { conflict: true });
    expect(kind({ local: save({ revision: 12 }), cloud: save({ revision: 9 }), state, me })).toBe('conflict-same');
  });

  it('Given the same inputs, When reconciled twice, Then the same decision and the inputs are not changed (pure)', () => {
    const input = { local: save({ revision: 9 }), cloud: save({ revision: 8 }), state: boundTo(me, L), me };
    const before = structuredClone(input);
    expect(rc(input)).toEqual(rc(input));
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

  // EDITED by Ruling R43 (fix round 1): input gains sameContent: true and the name says so; the assertion is unchanged.
  it("Given a guest save of the cloud's game at the same revision with the same content, Then 'in-sync'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: syncState(), me, sameContent: true })).toBe('in-sync');
  });

  it("Ruling R43: Given a guest save of the cloud's game at the same revision but DIFFERENT content, Then 'conflict-same'", () => {
    expect(
      kind({ local: save({ revision: 7, tank: 100 }), cloud: save({ revision: 7, tank: 9_000 }), state: syncState(), me, sameContent: false }),
    ).toBe('conflict-same');
  });

  it("Given a guest save of the cloud's game at an OLDER revision (local r7, cloud r8), Then 'conflict-same' — a guest save is never silently replaced by the cloud", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 8 }), state: syncState(), me })).toBe('conflict-same');
  });

  it("Given a guest save of the cloud's game at another revision, Then 'conflict-same'", () => {
    expect(kind({ local: save({ revision: 8 }), cloud: save({ revision: 7 }), state: syncState(), me })).toBe('conflict-same');
  });
});

describe('reconcile — the local save is bound to another account (§5.4)', () => {
  const me = ACCT_B;
  const L = save({ revision: 7 });

  it('Given a save bound to A with unsynced progress (local r9, L r7) and B signed in, Then refuse-switch with the verbatim text naming A', () => {
    const d = rc({ local: save({ revision: 9 }), cloud: null, state: boundTo(ACCT_A, L), me });
    expect(d).toEqual({ kind: 'refuse-switch', message: 'UNSYNCED PROGRESS FOR Ava — SIGN IN AS Ava ONCE ONLINE TO SYNC' });
  });

  it('Given a save bound to A with unsynced progress but no stored account name and B signed in, Then the refuse-switch text names A by id', () => {
    const d = rc({ local: save({ revision: 9 }), cloud: null, state: boundTo(ACCT_A, L, { accountName: null }), me });
    expect(d).toEqual({ kind: 'refuse-switch', message: `UNSYNCED PROGRESS FOR ${ACCT_A.id} — SIGN IN AS ${ACCT_A.id} ONCE ONLINE TO SYNC` });
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

describe('Ruling R36 — a WAL-merged (dirty) local save counts as ahead', () => {
  const L = save({ revision: 7 });

  it("Ruling R36: Given bound, local = L but dirty, and cloud = L, Then 'push-local'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: boundTo(ACCT_A, L), me: ACCT_A, localDirty: true })).toBe('push-local');
  });

  it("Ruling R36: Given bound, local = L but dirty, and the cloud newer (r9) on the same game, Then 'conflict-same' — not use-cloud, which would drop the paid entries", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 9 }), state: boundTo(ACCT_A, L), me: ACCT_A, localDirty: true })).toBe('conflict-same');
  });

  it("Ruling R36: Given bound, local = L but dirty, and another game in the cloud, Then 'conflict-different'", () => {
    expect(
      kind({ local: save({ revision: 7 }), cloud: save({ saveId: GAME_Y, revision: 3 }), state: boundTo(ACCT_A, L), me: ACCT_A, localDirty: true }),
    ).toBe('conflict-different');
  });

  it("Ruling R36: Given bound, a dirty local and no cloud, Then 'push-local'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: null, state: boundTo(ACCT_A, L), me: ACCT_A, localDirty: true })).toBe('push-local');
  });

  it("Choice (R36 extended): Given a save bound to A that is at L but dirty, and B signed in, Then 'refuse-switch' (A's paid entries are unsynced progress)", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: null, state: boundTo(ACCT_A, L), me: ACCT_B, localDirty: true })).toBe('refuse-switch');
  });

  it("Ruling R36: Given a dirty guest save of the cloud's game at the same revision, Then 'conflict-same' instead of 'in-sync'", () => {
    expect(kind({ local: save({ revision: 7 }), cloud: save({ revision: 7 }), state: syncState(), me: ACCT_B, localDirty: true })).toBe('conflict-same');
  });

  it.each<[string, SaveV1, SaveV1 | null, string]>([
    ['an empty cloud', save(), null, 'adopt'],
    ['another game in the cloud', save(), save({ saveId: GAME_Y }), 'conflict-different'],
    ["the cloud's game at another revision", save({ revision: 8 }), save({ revision: 7 }), 'conflict-same'],
  ])('Ruling R36: Given a dirty guest save and %s, Then the guest branch is unchanged (%s)', (_what, local, cloud, expected) => {
    expect(kind({ local, cloud, state: syncState(), me: ACCT_B, localDirty: true })).toBe(expected);
  });

  it("Ruling R36: Given a dirty save and nobody signed in, Then 'guest'", () => {
    expect(kind({ local: save(), cloud: null, state: boundTo(ACCT_A, L), me: null, localDirty: true })).toBe('guest');
  });
});

describe('Ruling R41 — no local save and a cloud save: use-cloud everywhere', () => {
  const cloud = save({ revision: 9 });

  it.each<[string, SyncState]>([
    ['a guest state', syncState()],
    ['a state bound to me with cloud = L', boundTo(ACCT_B, save({ revision: 9 }))],
    ['a state bound to me with cloud ≠ L', boundTo(ACCT_B, save({ revision: 7 }))],
    ['a state bound to me with L = null', boundTo(ACCT_B, null)],
    ['a state bound to ANOTHER account', boundTo(ACCT_A, save({ revision: 7 }))],
  ])("Ruling R41: Given no local save, a cloud save and %s, Then 'use-cloud'", (_what, state) => {
    expect(kind({ local: null, cloud, state, me: ACCT_B })).toBe('use-cloud');
  });

  it("Ruling R41: Given no local save, a cloud save and a dirty flag (nothing to be dirty), Then still 'use-cloud'", () => {
    expect(kind({ local: null, cloud, state: boundTo(ACCT_B, save({ revision: 9 })), me: ACCT_B, localDirty: true })).toBe('use-cloud');
  });
});

describe('Ruling R43 — the same content is in sync, whatever the bookkeeping says', () => {
  const same = (): { local: SaveV1; cloud: SaveV1 } => ({ local: save({ revision: 9 }), cloud: save({ revision: 9 }) });

  it.each<[string, SyncState, { id: string; name: string }]>([
    ['bound to me, L = null', boundTo(ACCT_B, null), ACCT_B],
    ['bound to me, L behind (r7)', boundTo(ACCT_B, save({ revision: 7 })), ACCT_B],
    ['a guest state', syncState(), ACCT_B],
    ['bound to ANOTHER account with L behind (would be refuse-switch)', boundTo(ACCT_A, save({ revision: 7 })), ACCT_B],
    ['bound to ANOTHER account, L = null', boundTo(ACCT_A, null), ACCT_B],
  ])("Ruling R43: Given local and cloud with the same content and %s, Then 'in-sync'", (_what, state, me) => {
    expect(kind({ ...same(), state, me, sameContent: true })).toBe('in-sync');
  });

  it("Ruling R43: Given the same content but a dirty local (WAL entries merged), Then still 'in-sync' (the cloud already holds exactly this save)", () => {
    expect(kind({ ...same(), state: boundTo(ACCT_B, save({ revision: 7 })), me: ACCT_B, sameContent: true, localDirty: true })).toBe('in-sync');
  });

  it("Ruling R43: Given the same content but nobody signed in, Then 'guest'", () => {
    expect(kind({ ...same(), state: syncState(), me: null, sameContent: true })).toBe('guest');
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
            for (const localDirty of [false, true]) {
              const d = reconcile({ local, cloud, state, me, localDirty, sameContent: false });
              expect(KINDS).toContain(d.kind);
              if (d.kind === 'refuse-switch') expect(typeof d.message).toBe('string');
              else expect(Object.keys(d)).toEqual(['kind']);
            }
            const d = rc({ local, cloud, state, me });
            expect(KINDS).toContain(d.kind);
            if (d.kind === 'refuse-switch') expect(typeof d.message).toBe('string');
            else expect(Object.keys(d)).toEqual(['kind']);
          }
  });
});

// =============================================================================
//  Final fix round — Ruling R72: the refuse-switch text shows the account
//  name through displayName() (src/ui/accountMenu.ts: control and format
//  characters stripped, at most 32 code points), like every other place a
//  name is shown.
// =============================================================================

describe('Ruling R72 — the refuse-switch text passes the name through displayName()', () => {
  it('Ruling R72: Given a save bound to an account whose stored name holds a bidi override, a zero-width space, a newline and 40 more letters, When B signs in with unsynced progress, Then the text names displayName(name) — nothing hidden, at most 32 code points', () => {
    const raw = 'Ev‮il​\n' + 'x'.repeat(40);
    const d = rc({ local: save({ revision: 9 }), cloud: null, state: boundTo(ACCT_A, save({ revision: 7 }), { accountName: raw }), me: ACCT_B });
    const shown = displayName(raw);
    expect(shown).toBe('Evil' + 'x'.repeat(28));
    expect(d).toEqual({ kind: 'refuse-switch', message: unsyncedProgressText(shown) });
    expect((d as { message: string }).message).not.toMatch(/[‮​\n]/u);
  });
});

// =============================================================================
//  Addendum 2 — Ruling R79: the R75 conflict survives a reboot. The sync state
//  carries `unmergedCloud?: { saveId, revision }` (the head of a resolve result
//  that was NOT applied over a local save that had advanced). Bound to me,
//  while it is set and the cloud is that save or a newer revision of the same
//  game, the decision is conflict-same — never push-local — even though L
//  equals the cloud head. The rule lives in reconcile (it reads state).
// =============================================================================

describe('Ruling R79 — an unmerged cloud keeps the conflict', () => {
  const me = ACCT_B;
  const L10 = save({ revision: 10 });
  const unmerged = (o: Partial<SyncState> = {}): SyncState =>
    boundTo(me, L10, { conflict: true, unmergedCloud: { saveId: GAME_X, revision: 10 }, ...o });

  it("Ruling R79: Given unmergedCloud = r10 = L = the cloud head and local r11, Then 'conflict-same' (not push-local)", () => {
    expect(kind({ local: save({ revision: 11, tank: 4_000 }), cloud: save({ revision: 10, tank: 5_000 }), state: unmerged(), me })).toBe('conflict-same');
  });

  it("Ruling R79: Given the same, but the persisted conflict flag already cleared, Then still 'conflict-same' — unmergedCloud alone carries the rule", () => {
    expect(kind({ local: save({ revision: 11, tank: 4_000 }), cloud: save({ revision: 10, tank: 5_000 }), state: unmerged({ conflict: false }), me })).toBe('conflict-same');
  });

  it("Ruling R79 (guard): Given unmergedCloud = r10 and the cloud moved on to r12 on the same game, Then 'conflict-same'", () => {
    expect(kind({ local: save({ revision: 11, tank: 4_000 }), cloud: save({ revision: 12 }), state: unmerged(), me })).toBe('conflict-same');
  });

  it("Ruling R79 (guard): Given the R75 state WITHOUT unmergedCloud, Then 'push-local' — the rule is keyed on the field", () => {
    expect(kind({ local: save({ revision: 11, tank: 4_000 }), cloud: save({ revision: 10, tank: 5_000 }), state: boundTo(me, L10), me })).toBe('push-local');
  });

  it("Ruling R79 (guard): Given unmergedCloud and local identical to the cloud, Then 'in-sync' (R43 still first)", () => {
    expect(kind({ local: save({ revision: 10 }), cloud: save({ revision: 10 }), state: unmerged(), me, sameContent: true })).toBe('in-sync');
  });

  it("Ruling R79 (guard): Given unmergedCloud and no local save, Then 'use-cloud' (R41)", () => {
    expect(kind({ local: null, cloud: save({ revision: 10 }), state: unmerged(), me })).toBe('use-cloud');
  });
});

// =============================================================================
//  D51 follow-up — Ruling R84: after a replay answered 409 with resolvedAs, the
//  client sets L = resolvedAs (r10) and reconciles against the cloud head (r11)
//  as usual. What today's reconcile decides from that state (these PASS today;
//  they keep the rule from moving under SyncClient):
// =============================================================================

describe('Ruling R84 — reconcile with L = resolvedAs', () => {
  const me = ACCT_B;
  const atR10 = boundTo(me, save({ revision: 10 }), { conflict: true });

  it("Ruling R84 (guard): Given L = r10, the cloud r11 and the local save still at the device revision r9, Then 'use-cloud' (r11 descends from r10, which already holds r9)", () => {
    expect(kind({ local: save({ revision: 9 }), cloud: save({ revision: 11, tank: 7_500 }), state: atR10, me })).toBe('use-cloud');
  });

  it("Ruling R84 (guard): Given L = r10, the cloud r11 and a local save played on to r11 (other content), Then 'conflict-same'", () => {
    expect(kind({ local: save({ revision: 11, tank: 9_500 }), cloud: save({ revision: 11, tank: 7_500 }), state: atR10, me })).toBe('conflict-same');
  });
});
