/**
 * checkMembership (v4 sub-plan 4, Task 2): asks Discord whether the user is in
 * our guild and holds the invite role. Discord is a mocked `fetch`.
 */

import { describe, expect, it } from 'vitest';

import { checkMembership } from './discord';

const GUILD = 'guild-1';
const ROLE = 'role-1';
const MEMBER_URL = `https://discord.com/api/users/@me/guilds/${GUILD}/member`;

type Call = { url: string; init?: RequestInit };

function mockFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('checkMembership', () => {
  describe('given a guild member who has the invite role', () => {
    it('when checked, then it is ok with the Discord id and global_name', async () => {
      const { fetchFn } = mockFetch(() =>
        json({ user: { id: '42', username: 'plain', global_name: 'Fancy Name' }, roles: ['x', ROLE] }),
      );
      expect(await checkMembership(fetchFn, 'tok', GUILD, ROLE)).toEqual({ ok: true, id: '42', name: 'Fancy Name' });
    });

    it('when global_name is null, then the name falls back to username', async () => {
      const { fetchFn } = mockFetch(() => json({ user: { id: '42', username: 'plain', global_name: null }, roles: [ROLE] }));
      expect(await checkMembership(fetchFn, 'tok', GUILD, ROLE)).toEqual({ ok: true, id: '42', name: 'plain' });
    });

    it('when checked, then it makes one GET to the guild-member endpoint with the Bearer token', async () => {
      const { fetchFn, calls } = mockFetch(() => json({ user: { id: '1', username: 'u', global_name: null }, roles: [ROLE] }));
      await checkMembership(fetchFn, 'access-123', GUILD, ROLE);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(MEMBER_URL);
      expect((calls[0]!.init?.method ?? 'GET').toUpperCase()).toBe('GET');
      expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer access-123');
    });
  });

  describe('given a guild member without the invite role', () => {
    it('when checked, then the reason is no-role', async () => {
      const { fetchFn } = mockFetch(() => json({ user: { id: '42', username: 'u', global_name: null }, roles: ['other'] }));
      expect(await checkMembership(fetchFn, 'tok', GUILD, ROLE)).toEqual({ ok: false, reason: 'no-role' });
    });

    it('when the member has no roles at all, then the reason is no-role', async () => {
      const { fetchFn } = mockFetch(() => json({ user: { id: '42', username: 'u', global_name: null }, roles: [] }));
      expect(await checkMembership(fetchFn, 'tok', GUILD, ROLE)).toEqual({ ok: false, reason: 'no-role' });
    });
  });

  describe('given a user who is not in the guild', () => {
    it('when Discord answers 404, then the reason is not-member', async () => {
      const { fetchFn } = mockFetch(() => json({ message: 'Unknown Guild Member', code: 10007 }, 404));
      expect(await checkMembership(fetchFn, 'tok', GUILD, ROLE)).toEqual({ ok: false, reason: 'not-member' });
    });
  });

  describe('given Discord is failing', () => {
    it('when it answers 500, then checkMembership throws (the caller maps that to an error)', async () => {
      const { fetchFn } = mockFetch(() => json({ message: 'boom' }, 500));
      await expect(checkMembership(fetchFn, 'tok', GUILD, ROLE)).rejects.toThrow();
    });

    it('when it answers 503, then checkMembership throws', async () => {
      const { fetchFn } = mockFetch(() => new Response('unavailable', { status: 503 }));
      await expect(checkMembership(fetchFn, 'tok', GUILD, ROLE)).rejects.toThrow();
    });

    it('when the network call itself throws, then checkMembership throws', async () => {
      const fetchFn = (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch;
      await expect(checkMembership(fetchFn, 'tok', GUILD, ROLE)).rejects.toThrow();
    });

    it('when it answers 401 (bad token), then checkMembership throws rather than reporting not-member', async () => {
      const { fetchFn } = mockFetch(() => json({ message: '401: Unauthorized' }, 401));
      await expect(checkMembership(fetchFn, 'tok', GUILD, ROLE)).rejects.toThrow();
    });

    it('when the body has no user or roles, then checkMembership throws', async () => {
      const { fetchFn } = mockFetch(() => json({ unexpected: true }));
      await expect(checkMembership(fetchFn, 'tok', GUILD, ROLE)).rejects.toThrow();
    });
  });
});
