/**
 * v4 sub-plan 3, Task 6 fix round 1 — ruling R17 (security): a link cannot
 * start a new game over a save.
 *
 * NEW GAME's confirmed second press issues a one-time nonce into
 * sessionStorage (`onespace.newgame.nonce`) and reloads with
 * `?new=1&nonce=<it>`. The boot honours `new` only when the URL's nonce
 * matches the stored one, and consumes it on the first check, right or wrong.
 *
 *   issueNewGameNonce(session, random?): string | null   // null: not stored
 *   consumeNewGameNonce(session, nonce): boolean
 *
 * Pure apart from the injected session storage; never throws.
 */

import { describe, expect, it } from 'vitest';

import { NEW_GAME_NONCE_KEY, consumeNewGameNonce, issueNewGameNonce } from './newGameNonce';

class FakeSession {
  m = new Map<string, string>();
  broken = false;
  getItem(k: string): string | null {
    if (this.broken) throw new DOMException('denied', 'SecurityError');
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.broken) throw new DOMException('denied', 'SecurityError');
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    if (this.broken) throw new DOMException('denied', 'SecurityError');
    this.m.delete(k);
  }
}

const HEX32 = /^[0-9a-f]{32}$/;

describe('issueNewGameNonce', () => {
  it('Given a session, Then it stores and returns a fresh 32-hex-digit nonce under onespace.newgame.nonce', () => {
    const s = new FakeSession();
    const n = issueNewGameNonce(s);
    expect(n).toMatch(HEX32);
    expect(s.getItem(NEW_GAME_NONCE_KEY)).toBe(n);
    expect(NEW_GAME_NONCE_KEY).toBe('onespace.newgame.nonce');
  });

  it('Given two issues, Then they differ and only the latest is stored', () => {
    const s = new FakeSession();
    const a = issueNewGameNonce(s);
    const b = issueNewGameNonce(s);
    expect(a).not.toBe(b);
    expect(s.getItem(NEW_GAME_NONCE_KEY)).toBe(b);
  });

  it('Given an injected random source, Then the nonce is what it gives', () => {
    expect(issueNewGameNonce(new FakeSession(), () => 'ab'.repeat(16))).toBe('ab'.repeat(16));
  });

  it('Given no session or one that throws, Then null and no throw', () => {
    expect(issueNewGameNonce(null)).toBeNull();
    const s = new FakeSession();
    s.broken = true;
    expect(issueNewGameNonce(s)).toBeNull();
  });
});

describe('consumeNewGameNonce', () => {
  it('Given the issued nonce, Then true once — and the stored nonce is gone', () => {
    const s = new FakeSession();
    const n = issueNewGameNonce(s)!;
    expect(consumeNewGameNonce(s, n)).toBe(true);
    expect(s.getItem(NEW_GAME_NONCE_KEY)).toBeNull();
    expect(consumeNewGameNonce(s, n)).toBe(false);
  });

  it('Given a wrong nonce, Then false, and the stored one is burnt too (one attempt)', () => {
    const s = new FakeSession();
    const n = issueNewGameNonce(s)!;
    expect(consumeNewGameNonce(s, 'f'.repeat(32))).toBe(false);
    expect(consumeNewGameNonce(s, n)).toBe(false);
  });

  it('Given no nonce in the URL, or nothing issued, Then false', () => {
    const s = new FakeSession();
    expect(consumeNewGameNonce(s, undefined)).toBe(false);
    expect(consumeNewGameNonce(s, 'a'.repeat(32))).toBe(false);
    issueNewGameNonce(s);
    expect(consumeNewGameNonce(s, undefined)).toBe(false);
  });

  it('Given no session or one that throws, Then false and no throw', () => {
    expect(consumeNewGameNonce(null, 'a'.repeat(32))).toBe(false);
    const s = new FakeSession();
    s.broken = true;
    expect(consumeNewGameNonce(s, 'a'.repeat(32))).toBe(false);
  });
});
