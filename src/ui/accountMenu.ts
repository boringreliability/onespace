/**
 * Sign-in with Discord and the account, as the menus show them (v4 sub-plan
 * 4, Task 6; rulings R50–R54). Pure but for `renderAccountLine`, which takes
 * the document it builds with. The title (Title.ts) and the pause sheet
 * (Pause.ts) render what this module decides.
 *
 * The Discord display name is untrusted input (R52): it is only ever set as
 * textContent, and shown truncated to DISPLAY_NAME_MAX characters.
 */

import type { SyncClient } from '@/net/SyncClient';

/** server/auth/routes.ts `GET /auth/discord`, mounted under /api (server/app.ts). */
export const SIGN_IN_PATH = '/api/auth/discord';

export const SIGN_IN_TEXT = 'SIGN IN WITH DISCORD';
export const SIGN_OUT_TEXT = 'SIGN OUT';
export const NOT_INVITED_TEXT = 'NOT INVITED — PLAYING AS GUEST';
export const SIGN_IN_FAILED_TEXT = 'SIGN-IN FAILED — PLAYING AS GUEST';
export const SIGN_OUT_FAILED_TEXT = 'SIGN OUT FAILED — STILL SIGNED IN';
export const DELETE_FAILED_TEXT = 'DELETE ACCOUNT FAILED — NOTHING CHANGED';
export const DISPLAY_NAME_MAX = 32;

/**
 * What the menus show of the account (R51):
 *  - hidden: a reader tab — no sign-in or account items at all;
 *  - guest: no identity confirmed this session (unknown, 401, offline);
 *  - signed-in: the identity the boot's me() confirmed.
 */
export type AccountView = { kind: 'hidden' } | { kind: 'guest' } | { kind: 'signed-in'; name: string };

export function accountView(o: { reader: boolean; identity: { id: string; name: string } | null }): AccountView {
  if (o.reader) return { kind: 'hidden' };
  return o.identity ? { kind: 'signed-in', name: o.identity.name } : { kind: 'guest' };
}

/** R52: at most DISPLAY_NAME_MAX characters (code points: a surrogate pair is never split). */
export function displayName(name: string): string {
  const cps = Array.from(name);
  return cps.length <= DISPLAY_NAME_MAX ? name : cps.slice(0, DISPLAY_NAME_MAX).join('');
}

export function signedInText(name: string): string {
  return `SIGNED IN AS ${displayName(name)}`;
}

/** The account line as one element, its text by textContent only (R52); null unless signed in. */
export function renderAccountLine(doc: Pick<Document, 'createElement'>, account: AccountView): HTMLElement | null {
  if (account.kind !== 'signed-in') return null;
  const el = doc.createElement('div');
  el.className = 'os-account-line';
  el.textContent = signedInText(account.name);
  return el;
}

const AUTH_NOTICES: Readonly<Record<string, string>> = {
  'not-invited': NOT_INVITED_TEXT,
  error: SIGN_IN_FAILED_TEXT,
};

/**
 * R50: the server sends the player back as /?auth=ok | not-invited | error.
 * The notice for a known failure; the parameter leaves the URL either way
 * (unknown values silently). Other parameters, their order and the hash stay.
 * `href` null: there was nothing to rewrite.
 */
export function authReturn(href: string): { notice: string | null; href: string | null } {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { notice: null, href: null };
  }
  if (!u.searchParams.has('auth')) return { notice: null, href: null };
  const value = u.searchParams.get('auth') ?? '';
  const notice = Object.prototype.hasOwnProperty.call(AUTH_NOTICES, value) ? AUTH_NOTICES[value]! : null;
  u.searchParams.delete('auth');
  const rest = u.searchParams.toString();
  u.search = rest ? `?${rest}` : '';
  return { notice, href: u.toString() };
}

export interface AccountOutcome {
  readonly account: AccountView;
  readonly notice: string | null;
}

/** R53: sign out; on failure a notice and the menu as it was. */
export async function runSignOut(sync: Pick<SyncClient, 'signOut'>, current: AccountView): Promise<AccountOutcome> {
  const ok = await sync.signOut().catch(() => false);
  return ok ? { account: { kind: 'guest' }, notice: null } : { account: current, notice: SIGN_OUT_FAILED_TEXT };
}

/** R54: delete the account (only when signed in); on failure a notice and nothing changed. */
export async function runDeleteAccount(sync: Pick<SyncClient, 'deleteAccount'>, current: AccountView): Promise<AccountOutcome> {
  if (current.kind !== 'signed-in') return { account: current, notice: null };
  const ok = await sync.deleteAccount().catch(() => false);
  return ok ? { account: { kind: 'guest' }, notice: null } : { account: current, notice: DELETE_FAILED_TEXT };
}
