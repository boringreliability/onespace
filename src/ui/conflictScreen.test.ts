/**
 * v4 sub-plan 4, Task 6 (phase A) — the conflict screen (DESIGN-4 §5.3;
 * rulings R49, R55). Two saves diverged; the player keeps one. The pure
 * state, texts and the boot orchestration live in src/ui/conflictScreen.ts;
 * the DOM in src/ui/ConflictScreen.ts.
 *
 * Assumed surface (src/ui/conflictScreen.ts):
 *
 *   CONFLICT_TITLE      === 'TWO SAVES DIVERGED'
 *   CONFLICT_DEVICE     === 'THIS DEVICE'
 *   CONFLICT_CLOUD      === 'CLOUD'
 *   KEEP_THIS_TEXT      === 'KEEP THIS'
 *   KEEP_CLOUD_TEXT     === 'KEEP CLOUD'
 *
 *   type ConflictChoice = 'device' | 'cloud'
 *   interface ConflictCard { label; system; place; tank; cargo; ago }   // all strings
 *   conflictCard(s: SaveV1, label: string, o: { nowMs: number; bodyName?: (id: string) => string | null }): ConflictCard
 *      // via cardSummary(s, capacityKg, bodyName) — capacity = PROBE_TANK_CAPACITY_KG × (1 − capacityLossFrac),
 *      // the tank as the HUD reads it; tank `${round(%)} %`, cargo `${t.toFixed(1)} t`
 *   agoText(savedAtMs: number, nowMs: number): string
 *      // < 1 min (or in the future) 'just now'; < 60 min 'N min ago'; < 24 h 'N h ago'; else 'N d ago' (floored)
 *   interface ConflictState { choice: ConflictChoice; device: ConflictCard; cloud: ConflictCard }
 *   initialConflict(local: SaveV1, cloud: SaveV1, o: { nowMs: number; bodyName?: … }): ConflictState  // choice 'device'
 *   type ConflictEvent = { kind: 'left' } | { kind: 'right' } | { kind: 'enter' } | { kind: 'click'; choice: ConflictChoice }
 *   conflictStep(s, e): { state: ConflictState; effect: { kind: 'none' } | { kind: 'choose'; keep: ConflictChoice } }
 *   conflictKey(k: { code; metaKey?; ctrlKey?; altKey? }): { event: ConflictEvent | null; preventDefault: boolean }
 *   keepLabel(choice: ConflictChoice): string     // device → KEEP THIS, cloud → KEEP CLOUD
 *
 *   settleBootConflict(d: {
 *     boot: { decision: BootDecision; cloud: SaveV1 | null; local: SaveV1 | null };
 *     sync: Pick<SyncClient, 'resolve'>;
 *     choose: (view: ConflictState) => Promise<ConflictChoice>;   // the screen; resolves on a choice
 *     nowMs: () => number;
 *     bodyName?: (id: string) => string | null;                   // R55, from the registry
 *   }): Promise<{ resolved: SaveV1 | null; notices: string[] }>
 *
 * R49: shown only at boot (before decideBoot); after a resolve that
 * succeeds, boot continues with the returned save (it is in the store).
 * resolve fails: offline → the offline text, continue local, conflict kept;
 * reauth → the reauth text, continue local; moved → the screen once more
 * with the new cloud card; moved again → continue local with the conflict
 * text. There is no way out of the screen without a choice.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideBoot } from '@/save/boot';
import { loadForBoot } from '@/save/bootLoad';
import type { SaveV1 } from '@/save/schema';
import { createWal } from '@/save/wal';
import {
  ACCT_B,
  DEVICE_ID,
  MemoryStorage,
  WALL,
  cloudReply,
  fail,
  fakeApi,
  head,
  ok,
  save,
  syncState,
  testStore,
  timerSchedule,
  type FakeApi,
} from '@/net/__fixtures__/sync';
import { runBootSync } from '@/net/bootSync';
import {
  SYNC_CONFLICT_TEXT,
  SYNC_OFFLINE_TEXT,
  SYNC_REAUTH_TEXT,
  SyncClient,
  type BootDecision,
  type ResolveResult,
} from '@/net/SyncClient';

import {
  CONFLICT_CLOUD,
  CONFLICT_DEVICE,
  CONFLICT_TITLE,
  KEEP_CLOUD_TEXT,
  KEEP_THIS_TEXT,
  agoText,
  conflictCard,
  conflictKey,
  conflictStep,
  initialConflict,
  keepLabel,
  settleBootConflict,
  type ConflictChoice,
  type ConflictState,
} from './conflictScreen';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** The golden save's parent body (src/save/fixtures/v1-golden.json). */
const PID = 'gx-1mwhji--377.-3.266.1:p2';
const bodyName = (id: string): string | null => (id === PID ? 'Remit 31' : null);

/** THIS DEVICE: the golden save at r9 — Fyss, orbit p2, 14 250.5 kg at 10 % loss, 1 227.75 kg aboard. */
function deviceSave(wallMs = WALL): SaveV1 {
  return save({ revision: 9, wallMs });
}

/** CLOUD: r8, Kesh, landed on p2, 5 000 kg at no loss, an empty hold. */
function cloudSave(wallMs = WALL): SaveV1 {
  const s = save({ revision: 8, tank: 5_000, wallMs });
  s.player.system.name = 'Kesh';
  s.player.flight.grounded = true;
  s.ship.propellant.capacityLossFrac = 0;
  s.ship.cargo = { ice: 0, metal: 0, silicate: 0, rare: 0 };
  return s;
}

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// =============================================================================

describe('conflict screen — the texts, verbatim', () => {
  it('Given the module, Then the title, card labels and buttons read as the brief says', () => {
    expect(CONFLICT_TITLE).toBe('TWO SAVES DIVERGED');
    expect(CONFLICT_DEVICE).toBe('THIS DEVICE');
    expect(CONFLICT_CLOUD).toBe('CLOUD');
    expect(KEEP_THIS_TEXT).toBe('KEEP THIS');
    expect(KEEP_CLOUD_TEXT).toBe('KEEP CLOUD');
    expect(keepLabel('device')).toBe('KEEP THIS');
    expect(keepLabel('cloud')).toBe('KEEP CLOUD');
  });
});

describe('conflict screen — the cards', () => {
  it('Given the device fixture saved 14 min ago, Then its card reads Fyss · orbit Remit 31 · 79 % · 1.2 t · 14 min ago', () => {
    const card = conflictCard(deviceSave(), CONFLICT_DEVICE, { nowMs: WALL + 14 * MIN, bodyName });
    expect(card).toEqual({
      label: 'THIS DEVICE',
      system: 'Fyss',
      place: 'orbit Remit 31',
      // 14 250.5 kg of 20 000 × (1 − 0.1) = 18 000 kg — the tank as the HUD reads it.
      tank: '79 %',
      // 820 + 310.5 + 95 + 2.25 = 1 227.75 kg.
      cargo: '1.2 t',
      ago: '14 min ago',
    });
  });

  it('Given the cloud fixture saved 2 h ago, Then its card reads Kesh · landed Remit 31 · 25 % · 0.0 t · 2 h ago', () => {
    const card = conflictCard(cloudSave(), CONFLICT_CLOUD, { nowMs: WALL + 2 * HOUR, bodyName });
    expect(card).toEqual({
      label: 'CLOUD',
      system: 'Kesh',
      place: 'landed Remit 31',
      tank: '25 %',
      cargo: '0.0 t',
      ago: '2 h ago',
    });
  });

  it('R55: Given a body-name resolver, Then the card asks it for the parent id and shows its name; without one the raw id stands in', () => {
    const seen: string[] = [];
    const named = conflictCard(deviceSave(), CONFLICT_DEVICE, { nowMs: WALL, bodyName: (id) => (seen.push(id), 'Remit 31') });
    expect(seen).toEqual([PID]);
    expect(named.place).toBe('orbit Remit 31');
    expect(conflictCard(deviceSave(), CONFLICT_DEVICE, { nowMs: WALL }).place).toBe(`orbit ${PID}`);
  });

  it('Given both fixtures, When the initial state is built, Then THIS DEVICE and CLOUD hold the two cards and THIS DEVICE is chosen', () => {
    const s = initialConflict(deviceSave(WALL), cloudSave(WALL - 2 * HOUR + 14 * MIN), { nowMs: WALL + 14 * MIN, bodyName });
    expect(s.choice).toBe('device');
    expect(s.device.label).toBe('THIS DEVICE');
    expect(s.device.ago).toBe('14 min ago');
    expect(s.cloud.label).toBe('CLOUD');
    expect(s.cloud.system).toBe('Kesh');
    expect(s.cloud.ago).toBe('2 h ago');
  });

  it.each<[string, number, string]>([
    ['0 s', 0, 'just now'],
    ['59 s', 59_000, 'just now'],
    ['1 min', MIN, '1 min ago'],
    ['14 min 59 s', 14 * MIN + 59_000, '14 min ago'],
    ['59 min', 59 * MIN, '59 min ago'],
    ['60 min', HOUR, '1 h ago'],
    ['23 h 59 min', 24 * HOUR - MIN, '23 h ago'],
    ['3 days', 72 * HOUR, '3 d ago'],
    ['a save from the future (clock skew)', -5 * MIN, 'just now'],
  ])('Given a save %s old, Then the card says %s', (_what, age, text) => {
    expect(agoText(WALL, WALL + age)).toBe(text);
  });
});

describe('conflict screen — choosing (keys)', () => {
  const view = (): ConflictState => initialConflict(deviceSave(), cloudSave(), { nowMs: WALL, bodyName });

  it('Given THIS DEVICE chosen, When right, Then CLOUD; When left, Then THIS DEVICE again; neither press chooses', () => {
    const r1 = conflictStep(view(), { kind: 'right' });
    expect(r1.state.choice).toBe('cloud');
    expect(r1.effect).toEqual({ kind: 'none' });
    const r2 = conflictStep(r1.state, { kind: 'left' });
    expect(r2.state.choice).toBe('device');
    expect(r2.effect).toEqual({ kind: 'none' });
  });

  it('Given THIS DEVICE (the left card), When left, Then it stays THIS DEVICE; given CLOUD, When right, Then it stays CLOUD (no wrap)', () => {
    expect(conflictStep(view(), { kind: 'left' }).state.choice).toBe('device');
    const cloud = conflictStep(view(), { kind: 'right' }).state;
    expect(conflictStep(cloud, { kind: 'right' }).state.choice).toBe('cloud');
  });

  it('Given a choice, When enter, Then the effect chooses it', () => {
    expect(conflictStep(view(), { kind: 'enter' }).effect).toEqual({ kind: 'choose', keep: 'device' });
    const cloud = conflictStep(view(), { kind: 'right' }).state;
    expect(conflictStep(cloud, { kind: 'enter' }).effect).toEqual({ kind: 'choose', keep: 'cloud' });
  });

  it('Given a click on KEEP CLOUD or KEEP THIS, Then that one is chosen in one step', () => {
    const r = conflictStep(view(), { kind: 'click', choice: 'cloud' });
    expect(r.state.choice).toBe('cloud');
    expect(r.effect).toEqual({ kind: 'choose', keep: 'cloud' });
    expect(conflictStep(view(), { kind: 'click', choice: 'device' }).effect).toEqual({ kind: 'choose', keep: 'device' });
  });

  it('Given the reducer, Then it never mutates the state it was given', () => {
    const s = view();
    const frozen = JSON.stringify(s);
    conflictStep(s, { kind: 'right' });
    conflictStep(s, { kind: 'enter' });
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it.each([
    ['ArrowLeft', 'left'],
    ['KeyA', 'left'],
    ['ArrowRight', 'right'],
    ['KeyD', 'right'],
    ['Enter', 'enter'],
    ['Space', 'enter'],
  ] as const)('Given %s on the screen, Then it is the %s event and the browser default is suppressed', (code, kind) => {
    expect(conflictKey({ code })).toEqual({ event: { kind }, preventDefault: true });
  });

  it.each(['Escape', 'KeyW', 'KeyS', 'ArrowUp', 'KeyM', 'Tab'])(
    'Given %s (Esc, a flight or menu key), Then it does nothing — there is no way out without a choice — and it is kept from the browser',
    (code) => {
      expect(conflictKey({ code })).toEqual({ event: null, preventDefault: true });
    },
  );

  it.each([
    { code: 'KeyR', metaKey: true },
    { code: 'KeyR', ctrlKey: true },
    { code: 'ArrowLeft', altKey: true },
  ])('Given the browser chord %o, Then the browser keeps its default and the choice does not move', (k) => {
    expect(conflictKey(k)).toEqual({ event: null, preventDefault: false });
  });
});

describe('ConflictScreen.ts — the DOM captures the keys (source)', () => {
  const src = (): string => readFileSync(join(SRC_DIR, 'ConflictScreen.ts'), 'utf8');

  it('Given the DOM module, Then it listens to keydown on window in the capture phase and stops every key from propagating while shown', () => {
    const s = src();
    expect(s).toMatch(/addEventListener\(\s*'keydown'[^)]*,\s*true\s*\)/);
    expect(s).toMatch(/stopPropagation\(\)/);
    expect(s).toMatch(/conflictKey\(/);
    expect(s).toMatch(/conflictStep\(/);
  });

  it('Given the DOM module (CSP), Then it writes no HTML strings and no inline handlers: no innerHTML, no on…= properties or attributes', () => {
    const s = src();
    expect(s).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(s).not.toMatch(/\.on[a-z]+\s*=/);
    expect(s).not.toMatch(/setAttribute\(\s*'on/);
    expect(s).not.toMatch(/setAttribute\(\s*'style'/);
    expect(s).toMatch(/textContent/);
  });
});

// =============================================================================
//  R49 — the boot orchestration, with a scripted sync
// =============================================================================

describe('settleBootConflict — R49 (scripted sync)', () => {
  const conflictBoot = (kind: 'conflict-same' | 'conflict-different' = 'conflict-same') => ({
    decision: { kind } as BootDecision,
    cloud: cloudSave(),
    local: deviceSave(),
  });

  function scripted(replies: ResolveResult[]): { sync: Pick<SyncClient, 'resolve'>; keeps: string[] } {
    const keeps: string[] = [];
    return {
      keeps,
      sync: {
        resolve: vi.fn(async (keep: 'device' | 'cloud') => {
          keeps.push(keep);
          const r = replies.shift();
          if (!r) throw new Error('resolve called more often than scripted');
          return r;
        }),
      },
    };
  }

  function chooser(keeps: ConflictChoice[]): { choose: (v: ConflictState) => Promise<ConflictChoice>; views: ConflictState[] } {
    const views: ConflictState[] = [];
    return {
      views,
      choose: async (v) => {
        views.push(v);
        const k = keeps.shift();
        if (!k) throw new Error('the screen was shown more often than scripted');
        return k;
      },
    };
  }

  it.each<BootDecision>([
    { kind: 'guest' },
    { kind: 'in-sync' },
    { kind: 'use-cloud' },
    { kind: 'push-local' },
    { kind: 'adopt' },
    { kind: 'switch-account' },
    { kind: 'refuse-switch', message: 'x' },
    { kind: 'local-only', reason: 'offline' },
    { kind: 'local-only', reason: 'reader' },
  ])('Given the boot decided %o, Then no screen, no resolve, nothing resolved and no notices', async (decision) => {
    const s = scripted([]);
    const c = chooser([]);
    const out = await settleBootConflict({ boot: { decision, cloud: cloudSave(), local: deviceSave() }, sync: s.sync, choose: c.choose, nowMs: () => WALL });
    expect(c.views).toEqual([]);
    expect(s.sync.resolve).not.toHaveBeenCalled();
    expect(out).toEqual({ resolved: null, notices: [] });
  });

  it.each(['conflict-same', 'conflict-different'] as const)(
    'Given %s at boot, When the player keeps CLOUD and resolve succeeds, Then the screen showed both cards once, resolve got "cloud", and boot continues with the returned save',
    async (kind) => {
      const result = save({ revision: 10, tank: 3_000 });
      const s = scripted([{ ok: true, save: result }]);
      const c = chooser(['cloud']);
      const out = await settleBootConflict({
        boot: conflictBoot(kind),
        sync: s.sync,
        choose: c.choose,
        nowMs: () => WALL + 14 * MIN,
        bodyName,
      });
      expect(c.views).toHaveLength(1);
      expect(c.views[0]!.device).toEqual(conflictCard(deviceSave(), CONFLICT_DEVICE, { nowMs: WALL + 14 * MIN, bodyName }));
      expect(c.views[0]!.cloud).toEqual(conflictCard(cloudSave(), CONFLICT_CLOUD, { nowMs: WALL + 14 * MIN, bodyName }));
      expect(s.keeps).toEqual(['cloud']);
      expect(out).toEqual({ resolved: result, notices: [] });
    },
  );

  it('R55: Given a resolver from the registry, Then the cards on the screen read the body name, not its id', async () => {
    const s = scripted([{ ok: true, save: deviceSave() }]);
    const c = chooser(['device']);
    await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL, bodyName });
    expect(c.views[0]!.device.place).toBe('orbit Remit 31');
    expect(c.views[0]!.cloud.place).toBe('landed Remit 31');
  });

  it('R49: Given resolve answers offline, Then the offline text is the notice and boot continues with the local save (nothing resolved), no second screen', async () => {
    const s = scripted([{ ok: false, reason: 'offline' }]);
    const c = chooser(['device']);
    const out = await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL });
    expect(out).toEqual({ resolved: null, notices: [SYNC_OFFLINE_TEXT] });
    expect(c.views).toHaveLength(1);
  });

  it('R49: Given resolve answers reauth, Then the reauth text is the notice and boot continues with the local save, no second screen', async () => {
    const s = scripted([{ ok: false, reason: 'reauth' }]);
    const c = chooser(['cloud']);
    const out = await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL });
    expect(out).toEqual({ resolved: null, notices: [SYNC_REAUTH_TEXT] });
    expect(c.views).toHaveLength(1);
  });

  it('R49: Given resolve answers moved with a new cloud, Then the screen is shown ONCE more with the new cloud card, and a successful second resolve is what boot continues with', async () => {
    const moved = save({ revision: 11, tank: 1_000, wallMs: WALL - 3 * MIN });
    const result = save({ revision: 12 });
    const s = scripted([
      { ok: false, reason: 'moved', cloud: moved },
      { ok: true, save: result },
    ]);
    const c = chooser(['cloud', 'device']);
    const out = await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL, bodyName });
    expect(c.views).toHaveLength(2);
    expect(c.views[1]!.cloud).toEqual(conflictCard(moved, CONFLICT_CLOUD, { nowMs: WALL, bodyName }));
    expect(c.views[1]!.cloud.ago).toBe('3 min ago');
    expect(c.views[1]!.device).toEqual(c.views[0]!.device);
    expect(s.keeps).toEqual(['cloud', 'device']);
    expect(out).toEqual({ resolved: result, notices: [] });
  });

  it('R49: Given resolve answers moved twice, Then the screen was shown exactly twice and boot continues with the local save and the conflict text', async () => {
    const s = scripted([
      { ok: false, reason: 'moved', cloud: save({ revision: 11 }) },
      { ok: false, reason: 'moved', cloud: save({ revision: 12 }) },
    ]);
    const c = chooser(['device', 'device']);
    const out = await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL });
    expect(c.views).toHaveLength(2);
    expect(s.sync.resolve).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ resolved: null, notices: [SYNC_CONFLICT_TEXT] });
  });

  it('R49: Given moved and then offline on the second try, Then boot continues with the local save and the offline text', async () => {
    const s = scripted([
      { ok: false, reason: 'moved', cloud: save({ revision: 11 }) },
      { ok: false, reason: 'offline' },
    ]);
    const c = chooser(['device', 'cloud']);
    const out = await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL });
    expect(out).toEqual({ resolved: null, notices: [SYNC_OFFLINE_TEXT] });
  });

  it('R49: Given moved without a readable cloud (nothing to show on a new card), Then no second screen — boot continues with the local save and the conflict text', async () => {
    const s = scripted([{ ok: false, reason: 'moved' }]);
    const c = chooser(['device']);
    const out = await settleBootConflict({ boot: conflictBoot(), sync: s.sync, choose: c.choose, nowMs: () => WALL });
    expect(c.views).toHaveLength(1);
    expect(out).toEqual({ resolved: null, notices: [SYNC_CONFLICT_TEXT] });
  });
});

// =============================================================================
//  R49 — end to end with the real SyncClient, store and decideBoot
// =============================================================================

describe('settleBootConflict — R49 end to end (real SyncClient, store, decideBoot)', () => {
  const SYNC_KEY = 'onespace.sync.v1';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(WALL);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Bound to B, L r7; local r9 stored, cloud r8 → conflict-same at boot. */
  async function conflictRig(resolve: FakeApi['reply']['resolve']) {
    const ts = testStore();
    const walStorage = new MemoryStorage();
    const wal = createWal(walStorage as unknown as Storage);
    const local = save({ revision: 9 });
    const cloud = save({ revision: 8, tank: 2_000 });
    await ts.store.save(local);
    const storage = new MemoryStorage();
    storage.setItem(
      SYNC_KEY,
      JSON.stringify(syncState({ accountId: ACCT_B.id, accountName: ACCT_B.name, lastSeenCloud: head(save({ revision: 7 })) })),
    );
    const api = fakeApi({ getSave: () => cloudReply(cloud), resolve });
    const sync = new SyncClient({ api, storage, isWriter: () => true, schedule: timerSchedule, store: ts.store, wal, uuid: () => DEVICE_ID });
    const boot = await runBootSync({ sync, store: ts.store, wal, writer: true });
    expect(boot.decision).toEqual({ kind: 'conflict-same' });
    const decide = () =>
      decideBoot({ search: '', store: ts.store, wal, lock: { writer: true, release: () => undefined }, session: null, replaceSearch: () => undefined });
    return { ts, wal, local, cloud, sync, boot, storage, decide, state: () => JSON.parse(storage.getItem(SYNC_KEY)!) as { conflict: boolean } };
  }

  it('Given a conflict at boot, When the player keeps CLOUD and the server merges, Then decideBoot continues the returned save, the unchosen local is on the shelf, and sync is synced', async () => {
    const merged = save({ revision: 10, tank: 1_500 });
    const r = await conflictRig(() => ok(200, { revision: 10, save: merged }));
    const out = await settleBootConflict({ boot: r.boot, sync: r.sync, choose: async () => 'cloud', nowMs: () => WALL });
    expect(out).toEqual({ resolved: merged, notices: [] });
    const d = await r.decide();
    expect(d.plan.start).toBe('continue');
    expect(d.load.save).toEqual(merged);
    expect(r.ts.shelf.map((e) => e.raw)).toContainEqual(r.local);
    expect(r.sync.status()).toBe('synced');
    expect(r.state().conflict).toBe(false);
  });

  it('Given a conflict at boot and the server unreachable, When the player chooses, Then boot continues the LOCAL save, the offline text is the notice, and the conflict is kept for the next start', async () => {
    const r = await conflictRig(() => fail('offline'));
    const out = await settleBootConflict({ boot: r.boot, sync: r.sync, choose: async () => 'cloud', nowMs: () => WALL });
    expect(out).toEqual({ resolved: null, notices: [SYNC_OFFLINE_TEXT] });
    const d = await r.decide();
    expect(d.load.save).toEqual((await loadForBoot(r.ts.store, r.wal)).save);
    expect(d.load.save).toEqual(r.local);
    expect(r.state().conflict).toBe(true);
    expect(r.sync.status()).toBe('conflict');
  });
});
