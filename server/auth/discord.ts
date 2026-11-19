/** Discord OAuth2 helpers. Hand-rolled (no OAuth library); Discord tokens are never stored or logged. */

export type Membership =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: 'not-member' | 'no-role' };

export type MemberLookup =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: 'not-member' }
  | { ok: false; reason: 'no-role'; discordId: string };

export const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
export const DISCORD_SCOPE = 'identify guilds.members.read';

/**
 * Asks Discord whether the token's user is in the guild and holds the role.
 * Returns a reason for a definite "no"; throws for anything uncertain (5xx, 401, network, bad body).
 */
export async function checkMembership(
  fetchFn: typeof fetch,
  accessToken: string,
  guildId: string,
  roleId: string,
): Promise<Membership> {
  const m = await lookupMember(fetchFn, accessToken, guildId, roleId);
  return m.ok || m.reason === 'not-member' ? m : { ok: false, reason: 'no-role' };
}

/**
 * checkMembership, but a "no-role" answer keeps the Discord user id: a de-invited user's
 * sessions are deleted by it (R72). Same throwing rules as checkMembership.
 */
export async function lookupMember(
  fetchFn: typeof fetch,
  accessToken: string,
  guildId: string,
  roleId: string,
): Promise<MemberLookup> {
  const res = await fetchFn(`https://discord.com/api/users/@me/guilds/${encodeURIComponent(guildId)}/member`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return { ok: false, reason: 'not-member' };
  if (!res.ok) throw new Error(`Discord member lookup failed: ${res.status}`);
  const body = (await res.json()) as {
    user?: { id?: unknown; username?: unknown; global_name?: unknown };
    roles?: unknown;
  };
  const u = body.user;
  if (!u || typeof u.id !== 'string' || typeof u.username !== 'string' || !Array.isArray(body.roles)) {
    throw new Error('Discord member lookup returned an unexpected body');
  }
  if (!body.roles.includes(roleId)) return { ok: false, reason: 'no-role', discordId: u.id };
  const name = typeof u.global_name === 'string' && u.global_name ? u.global_name : u.username;
  return { ok: true, id: u.id, name };
}

/** Exchanges the authorization code (PKCE) for an access token. Throws on any failure. */
export async function exchangeCode(
  fetchFn: typeof fetch,
  p: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string },
): Promise<string> {
  const res = await fetchFn(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
      client_id: p.clientId,
      client_secret: p.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Discord token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('Discord token response has no access_token');
  return body.access_token;
}
