/**
 * NEW GAME's one-time nonce (v4 sub-plan 3, Task 6 fix round 1, ruling R17).
 *
 * A link alone must never start a new game over a save. NEW GAME's confirmed
 * second press issues a nonce into sessionStorage and reloads with
 * `?new=1&nonce=<it>`; the boot honours `new` only when the two match, and
 * consumes the stored nonce on the first check — right or wrong. Never throws.
 */

export const NEW_GAME_NONCE_KEY = 'onespace.newgame.nonce';

export type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const HEX32 = /^[0-9a-f]{32}$/;

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store and return a fresh nonce; null when it cannot be stored. */
export function issueNewGameNonce(session: SessionLike | null, random: () => string = randomHex32): string | null {
  if (!session) return null;
  try {
    const nonce = random();
    if (!HEX32.test(nonce)) return null;
    session.setItem(NEW_GAME_NONCE_KEY, nonce);
    return session.getItem(NEW_GAME_NONCE_KEY) === nonce ? nonce : null;
  } catch {
    return null;
  }
}

/** True once, for exactly the stored nonce. The stored nonce is gone after any check. */
export function consumeNewGameNonce(session: SessionLike | null, nonce: string | undefined): boolean {
  if (!session) return false;
  try {
    const stored = session.getItem(NEW_GAME_NONCE_KEY);
    if (stored !== null) session.removeItem(NEW_GAME_NONCE_KEY);
    return nonce !== undefined && stored !== null && HEX32.test(stored) && stored === nonce;
  } catch {
    return false;
  }
}
