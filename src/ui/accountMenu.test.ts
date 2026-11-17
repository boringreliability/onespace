/**
 * v4 sub-plan 4, Task 6 (phase A) — sign-in with Discord, the account, the
 * auth return (rulings R50–R54). Pure; the title (Title.ts) and the pause
 * (Pause.ts) render what this module decides.
 *
 * Assumed surface (src/ui/accountMenu.ts):
 *
 *   SIGN_IN_PATH          === '/api/auth/discord'      // server/auth/routes.ts GET /auth/discord under /api
 *   SIGN_IN_TEXT          === 'SIGN IN WITH DISCORD'
 *   SIGN_OUT_TEXT         === 'SIGN OUT'
 *   NOT_INVITED_TEXT      === 'NOT INVITED — PLAYING AS GUEST'
 *   SIGN_IN_FAILED_TEXT   === 'SIGN-IN FAILED — PLAYING AS GUEST'
 *   SIGN_OUT_FAILED_TEXT  === 'SIGN OUT FAILED — STILL SIGNED IN'        (phase A proposal)
 *   DELETE_FAILED_TEXT    === 'DELETE ACCOUNT FAILED — NOTHING CHANGED'  (phase A proposal)
 *   DISPLAY_NAME_MAX      === 32
 *
 *   type AccountView = { kind: 'hidden' } | { kind: 'guest' } | { kind: 'signed-in'; name: string }
 *   accountView(o: { reader: boolean; identity: { id: string; name: string } | null }): AccountView
 *      // R51: reader → hidden; a confirmed identity → signed-in; else guest
 *   displayName(name: string): string           // R52: at most 32 code points, never split a surrogate pair
 *   signedInText(name: string): string          // 'SIGNED IN AS ' + displayName(name)
 *   renderAccountLine(doc: Pick<Document, 'createElement'>, account: AccountView): HTMLElement | null
 *      // R52: one element, the text by textContent only; null unless signed in
 *   authReturn(href: string): { notice: string | null; href: string | null }
 *      // R50: ?auth=… → its notice, the parameter gone (others and the hash kept); href null = nothing to rewrite
 *   runSignOut(sync: Pick<SyncClient, 'signOut'>, current: AccountView): Promise<{ account: AccountView; notice: string | null }>
 *   runDeleteAccount(sync: Pick<SyncClient, 'deleteAccount'>, current: AccountView): Promise<{ account: AccountView; notice: string | null }>
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCT_B,
  DEVICE_ID,
  MemoryStorage,
  WALL,
  cloudReply,
  fail,
  fakeApi,
  head,
  recordingWal,
  save,
  syncState,
  testStore,
  timerSchedule,
  type FakeApi,
} from '@/net/__fixtures__/sync';
import { SyncClient } from '@/net/SyncClient';

import {
  DELETE_FAILED_TEXT,
  DISPLAY_NAME_MAX,
  NOT_INVITED_TEXT,
  SIGN_IN_FAILED_TEXT,
  SIGN_IN_PATH,
  SIGN_IN_TEXT,
  SIGN_OUT_FAILED_TEXT,
  SIGN_OUT_TEXT,
  accountView,
  authReturn,
  displayName,
  renderAccountLine,
  runDeleteAccount,
  runSignOut,
  signedInText,
  type AccountView,
} from './accountMenu';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DENNIS: AccountView = { kind: 'signed-in', name: 'Dennis' };
const GUEST: AccountView = { kind: 'guest' };

describe('accountMenu — the texts and the route, verbatim', () => {
  it('Given the module, Then the texts read as the brief and rulings say', () => {
    expect(SIGN_IN_TEXT).toBe('SIGN IN WITH DISCORD');
    expect(SIGN_OUT_TEXT).toBe('SIGN OUT');
    expect(NOT_INVITED_TEXT).toBe('NOT INVITED — PLAYING AS GUEST');
    expect(SIGN_IN_FAILED_TEXT).toBe('SIGN-IN FAILED — PLAYING AS GUEST');
    expect(SIGN_OUT_FAILED_TEXT).toBe('SIGN OUT FAILED — STILL SIGNED IN');
    expect(DELETE_FAILED_TEXT).toBe('DELETE ACCOUNT FAILED — NOTHING CHANGED');
    expect(DISPLAY_NAME_MAX).toBe(32);
    expect(signedInText('Dennis')).toBe('SIGNED IN AS Dennis');
  });

  it('Given the server, Then sign-in starts at the real route: GET /auth/discord mounted under /api', () => {
    expect(SIGN_IN_PATH).toBe('/api/auth/discord');
    const routes = readFileSync(join(SRC_DIR, '../../server/auth/routes.ts'), 'utf8');
    expect(routes).toMatch(/app\.get\('\/auth\/discord',/);
    const app = readFileSync(join(SRC_DIR, '../../server/app.ts'), 'utf8');
    expect(app).toMatch(/app\.route\(\s*'\/api'/);
  });
});

describe('accountView — R51: what the menus show', () => {
  it('Given a writer tab and an identity confirmed this session, Then signed in, with that name', () => {
    expect(accountView({ reader: false, identity: { id: ACCT_B.id, name: 'Dennis' } })).toEqual(DENNIS);
  });

  it('Given a writer tab and no confirmed identity (unknown, 401, offline), Then guest', () => {
    expect(accountView({ reader: false, identity: null })).toEqual(GUEST);
  });

  it('Given a reader tab (the second tab), Then hidden — no sign-in or account items at all, whatever the identity', () => {
    expect(accountView({ reader: true, identity: null })).toEqual({ kind: 'hidden' });
    expect(accountView({ reader: true, identity: { id: ACCT_B.id, name: 'Dennis' } })).toEqual({ kind: 'hidden' });
  });
});

describe('the Discord display name — R52: untrusted input', () => {
  it('Given a name of 32 characters or fewer, Then it is shown whole', () => {
    expect(displayName('Dennis')).toBe('Dennis');
    expect(displayName('x'.repeat(32))).toBe('x'.repeat(32));
  });

  it('Given a 40-character name, Then it is shown truncated to its first 32 characters', () => {
    const name = 'abcdefghij'.repeat(4);
    expect(displayName(name)).toBe(name.slice(0, 32));
    expect(signedInText(name)).toBe(`SIGNED IN AS ${name.slice(0, 32)}`);
  });

  it('Given a name of 40 astral characters, Then 32 characters are kept and none is split in half', () => {
    const name = '𝔸'.repeat(40);
    const shown = displayName(name);
    expect(Array.from(shown)).toHaveLength(32);
    expect(shown).toBe('𝔸'.repeat(32));
  });

  /** A document that records what is created and refuses every HTML-string sink. */
  function fakeDoc() {
    const created: string[] = [];
    const refuse = (what: string) => () => {
      throw new Error(`${what} used`);
    };
    const doc = {
      createElement(tag: string) {
        created.push(tag.toLowerCase());
        const children: unknown[] = [];
        const el = {
          tagName: tag.toUpperCase(),
          textContent: '' as string | null,
          className: '',
          children,
          classList: { add: () => undefined, toggle: () => undefined, remove: () => undefined },
          appendChild: (c: unknown) => (children.push(c), c),
          append: (...c: unknown[]) => void children.push(...c),
          setAttribute: (n: string) => {
            if (/^on|^style$/i.test(n)) throw new Error(`setAttribute(${n}) used`);
          },
          insertAdjacentHTML: refuse('insertAdjacentHTML'),
        };
        Object.defineProperty(el, 'innerHTML', { set: refuse('innerHTML'), get: () => '' });
        Object.defineProperty(el, 'outerHTML', { set: refuse('outerHTML'), get: () => '' });
        return el;
      },
    };
    return { doc: doc as unknown as Pick<Document, 'createElement'>, created };
  }

  it('Given a name with markup, When the account line is rendered, Then exactly one element is made, no child elements, and the markup appears literally as text', () => {
    const name = '<img src=x onerror=alert(1)>';
    const { doc, created } = fakeDoc();
    const el = renderAccountLine(doc, { kind: 'signed-in', name }) as unknown as { textContent: string; children: unknown[] };
    expect(created).toHaveLength(1);
    expect(created).not.toContain('img');
    expect(el.children).toEqual([]);
    expect(el.textContent).toBe(`SIGNED IN AS ${name}`);
  });

  it('Given a long name with markup, When rendered, Then the text is the truncated name, still literal', () => {
    const name = '<img src=x onerror=alert(1)>' + 'y'.repeat(20);
    const { doc } = fakeDoc();
    const el = renderAccountLine(doc, { kind: 'signed-in', name }) as unknown as { textContent: string };
    expect(el.textContent).toBe(`SIGNED IN AS ${name.slice(0, 32)}`);
  });

  it('Given a guest or a hidden account, Then there is no account line (nothing is created)', () => {
    const { doc, created } = fakeDoc();
    expect(renderAccountLine(doc, GUEST)).toBeNull();
    expect(renderAccountLine(doc, { kind: 'hidden' })).toBeNull();
    expect(created).toEqual([]);
  });

  it('Given Title.ts and Pause.ts, Then neither writes the account into HTML: Title keeps its one static innerHTML template, Pause has none, both render the line via renderAccountLine', () => {
    const title = readFileSync(join(SRC_DIR, 'Title.ts'), 'utf8');
    const pause = readFileSync(join(SRC_DIR, 'Pause.ts'), 'utf8');
    expect(title.match(/innerHTML/g) ?? []).toHaveLength(1);
    expect(pause).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(title).toMatch(/renderAccountLine\(/);
    expect(pause).toMatch(/renderAccountLine\(/);
  });
});

describe('authReturn — R50: the server sends the player back with ?auth=…', () => {
  it('Given ?auth=not-invited, Then the notice is NOT INVITED — PLAYING AS GUEST and the parameter leaves the URL', () => {
    expect(authReturn('https://onespace.example/?auth=not-invited')).toEqual({
      notice: NOT_INVITED_TEXT,
      href: 'https://onespace.example/',
    });
  });

  it('Given ?auth=error, Then the notice is SIGN-IN FAILED — PLAYING AS GUEST and the parameter leaves the URL, the same way', () => {
    expect(authReturn('https://onespace.example/?auth=error')).toEqual({
      notice: SIGN_IN_FAILED_TEXT,
      href: 'https://onespace.example/',
    });
  });

  it('Given other parameters and a hash around it, Then only auth leaves — the others, their order and the hash are kept', () => {
    expect(authReturn('https://onespace.example/?seed=1f&auth=error&tier=low#dev')).toEqual({
      notice: SIGN_IN_FAILED_TEXT,
      href: 'https://onespace.example/?seed=1f&tier=low#dev',
    });
    expect(authReturn('https://onespace.example/play?auth=not-invited&seed=1f#x')).toEqual({
      notice: NOT_INVITED_TEXT,
      href: 'https://onespace.example/play?seed=1f#x',
    });
  });

  it.each(['ok', 'banana', '', '<script>'])('Given ?auth=%s (signed in fine, or unknown), Then it is removed silently: no notice', (v) => {
    expect(authReturn(`https://onespace.example/?seed=1f&auth=${encodeURIComponent(v)}`)).toEqual({
      notice: null,
      href: 'https://onespace.example/?seed=1f',
    });
  });

  it('Given no auth parameter, Then nothing to say and nothing to rewrite', () => {
    expect(authReturn('https://onespace.example/?seed=1f#dev')).toEqual({ notice: null, href: null });
    expect(authReturn('https://onespace.example/')).toEqual({ notice: null, href: null });
  });

  it('Given the server, Then the redirects this module reads are the real ones', () => {
    const routes = readFileSync(join(SRC_DIR, '../../server/auth/routes.ts'), 'utf8');
    expect(routes).toContain("'/?auth=not-invited'");
    expect(routes).toContain("'/?auth=error'");
  });
});

describe('runSignOut / runDeleteAccount — the menu after the request (scripted sync)', () => {
  it('R53: Given signed in, When sign-out succeeds, Then the menu shows guest and there is no notice', async () => {
    const sync = { signOut: vi.fn(async () => true) };
    expect(await runSignOut(sync, DENNIS)).toEqual({ account: GUEST, notice: null });
    expect(sync.signOut).toHaveBeenCalledTimes(1);
  });

  it('R53: Given signed in, When the logout request fails, Then a notice and the menu stays as it was', async () => {
    const sync = { signOut: vi.fn(async () => false) };
    expect(await runSignOut(sync, DENNIS)).toEqual({ account: DENNIS, notice: SIGN_OUT_FAILED_TEXT });
  });

  it('R54: Given signed in, When delete succeeds, Then the menu shows guest and there is no notice', async () => {
    const sync = { deleteAccount: vi.fn(async () => true) };
    expect(await runDeleteAccount(sync, DENNIS)).toEqual({ account: GUEST, notice: null });
    expect(sync.deleteAccount).toHaveBeenCalledTimes(1);
  });

  it('R54: Given signed in, When the delete request fails, Then a notice and nothing changed', async () => {
    const sync = { deleteAccount: vi.fn(async () => false) };
    expect(await runDeleteAccount(sync, DENNIS)).toEqual({ account: DENNIS, notice: DELETE_FAILED_TEXT });
  });

  it('R54: Given a guest (DELETE ACCOUNT is not offered), When runDeleteAccount is reached anyway, Then nothing is sent and nothing changes', async () => {
    const sync = { deleteAccount: vi.fn(async () => true) };
    expect(await runDeleteAccount(sync, GUEST)).toEqual({ account: GUEST, notice: null });
    expect(sync.deleteAccount).not.toHaveBeenCalled();
  });
});

describe('sign out and delete account — end to end with the real SyncClient (R53, R54)', () => {
  const SYNC_KEY = 'onespace.sync.v1';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(WALL);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Signed in as Dennis (ACCT_B's id), bound, in sync at r7, the save stored. */
  async function signedIn(api: Partial<FakeApi['reply']> = {}) {
    const ts = testStore();
    const local = save({ revision: 7 });
    await ts.store.save(local);
    const storage = new MemoryStorage();
    const bound = syncState({ accountId: ACCT_B.id, accountName: 'Dennis', lastSeenCloud: head(local) });
    storage.setItem(SYNC_KEY, JSON.stringify(bound));
    const fapi = fakeApi({ me: () => ({ ok: true, status: 200, body: { id: ACCT_B.id, name: 'Dennis' } }), getSave: () => cloudReply(local), ...api });
    const wal = recordingWal(new MemoryStorage(), ts.calls);
    const sync = new SyncClient({ api: fapi, storage, isWriter: () => true, schedule: timerSchedule, store: ts.store, wal, uuid: () => DEVICE_ID });
    await sync.boot(local);
    ts.calls.length = 0;
    const account = accountView({ reader: false, identity: sync.identity() });
    expect(account).toEqual(DENNIS);
    return { ts, local, storage, bound, api: fapi, sync, account };
  }

  it('R53: Given signed in, When SIGN OUT, Then logout is POSTed, the menu shows guest, and the local save and the sync binding are untouched', async () => {
    const r = await signedIn();
    const out = await runSignOut(r.sync, r.account);
    expect(r.api.calls).toContain('logout');
    expect(out).toEqual({ account: GUEST, notice: null });
    expect(accountView({ reader: false, identity: r.sync.identity() })).toEqual(GUEST);
    expect(r.ts.calls).toEqual([]);
    expect(await r.ts.current()).toEqual(r.local);
    expect(JSON.parse(r.storage.getItem(SYNC_KEY)!)).toEqual(r.bound);
  });

  it('R53: Given the logout request fails, When SIGN OUT, Then a notice and the menu still shows Dennis', async () => {
    const r = await signedIn({ logout: () => fail('offline') });
    expect(await runSignOut(r.sync, r.account)).toEqual({ account: DENNIS, notice: SIGN_OUT_FAILED_TEXT });
    expect(accountView({ reader: false, identity: r.sync.identity() })).toEqual(DENNIS);
  });

  it('R54: Given signed in, When DELETE ACCOUNT is confirmed, Then DELETE is sent, the menu shows guest, the sync state is fresh with the same deviceId, and the local save is untouched', async () => {
    const r = await signedIn();
    const out = await runDeleteAccount(r.sync, r.account);
    expect(r.api.calls).toContain('deleteAccount');
    expect(out).toEqual({ account: GUEST, notice: null });
    expect(JSON.parse(r.storage.getItem(SYNC_KEY)!)).toEqual(syncState({ deviceId: DEVICE_ID }));
    expect(r.ts.calls).toEqual([]);
    expect(await r.ts.current()).toEqual(r.local);
  });

  it('R54: Given the delete request fails, When DELETE ACCOUNT is confirmed, Then a notice, the binding kept, and the menu still shows Dennis', async () => {
    const r = await signedIn({ deleteAccount: () => fail(500) });
    expect(await runDeleteAccount(r.sync, r.account)).toEqual({ account: DENNIS, notice: DELETE_FAILED_TEXT });
    expect(JSON.parse(r.storage.getItem(SYNC_KEY)!)).toEqual(r.bound);
    expect(r.ts.calls).toEqual([]);
  });
});
