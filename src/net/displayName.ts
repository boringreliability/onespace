/**
 * A Discord display name as shown anywhere (R52, R62b; R77). The name is
 * untrusted input: control (Cc) and format (Cf) characters — bidi overrides,
 * zero-width — are stripped, then it is cut to DISPLAY_NAME_MAX code points
 * (a surrogate pair is never split). Lives under net so the sync code can use
 * it without importing ui; src/ui/accountMenu.ts re-exports both.
 */

export const DISPLAY_NAME_MAX = 32;

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;

export function displayName(name: string): string {
  const cps = Array.from(name.replace(HIDDEN_CHARS, ''));
  return cps.slice(0, DISPLAY_NAME_MAX).join('');
}
