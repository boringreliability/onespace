/**
 * Config (v4 sub-plan 4, Task 1).
 *
 * The server refuses to start on a bad environment rather than limp along:
 * a missing Discord role id would silently lock everyone out, and the test
 * login (a door that skips Discord) must never exist in production.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://onespace:onespace@127.0.0.1:5432/onespace',
  PUBLIC_ORIGIN: 'https://onespace.example',
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  DISCORD_GUILD_ID: 'guild-id',
  DISCORD_ROLE_ID: 'role-id',
};

describe('loadConfig', () => {
  describe('given a complete environment', () => {
    it('when loaded, then it maps every variable to its Config field', () => {
      const config = loadConfig({ ...VALID_ENV, PORT: '9000' });
      expect(config).toEqual({
        databaseUrl: VALID_ENV.DATABASE_URL,
        publicOrigin: VALID_ENV.PUBLIC_ORIGIN,
        discord: { clientId: 'client-id', clientSecret: 'client-secret', guildId: 'guild-id', roleId: 'role-id' },
        port: 9000,
        production: false,
        testLogin: false,
      });
    });

    it('when PORT is omitted, then the port is 8790', () => {
      expect(loadConfig(VALID_ENV).port).toBe(8790);
    });

    it('when NODE_ENV is production, then production is true', () => {
      expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'production' }).production).toBe(true);
    });

    // CHANGED by Ruling R72 (final fix round): the env gains a localhost PUBLIC_ORIGIN — test login now also needs one.
    it('when ONESPACE_TEST_LOGIN=1 outside production with a localhost PUBLIC_ORIGIN, then testLogin is true', () => {
      expect(loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: 'http://localhost:5173', ONESPACE_TEST_LOGIN: '1' }).testLogin).toBe(true);
    });
  });

  describe('given a missing variable', () => {
    it('when DISCORD_ROLE_ID is missing, then it throws a ConfigError naming DISCORD_ROLE_ID', () => {
      const { DISCORD_ROLE_ID: _omitted, ...env } = VALID_ENV;
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(/DISCORD_ROLE_ID/);
    });

    it('when DATABASE_URL is empty, then it throws a ConfigError naming DATABASE_URL', () => {
      expect(() => loadConfig({ ...VALID_ENV, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    });
  });

  describe('given a PUBLIC_ORIGIN that is not a bare origin', () => {
    it.each(['https://x.example/', 'x.example', 'ftp://x', 'https://x.example/path'])(
      'when PUBLIC_ORIGIN is %s, then it throws a ConfigError naming PUBLIC_ORIGIN',
      (value) => {
        const env = { ...VALID_ENV, PUBLIC_ORIGIN: value };
        expect(() => loadConfig(env)).toThrow(ConfigError);
        expect(() => loadConfig(env)).toThrow(/PUBLIC_ORIGIN/);
      },
    );

    it.each(['https://x.example', 'http://localhost:8787'])(
      'when PUBLIC_ORIGIN is %s, then it is accepted unchanged',
      (value) => {
        expect(loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: value }).publicOrigin).toBe(value);
      },
    );
  });

  describe('given an invalid PORT', () => {
    it.each(['abc', '0', '70000', '-1', '80.5'])(
      'when PORT is %s, then it throws a ConfigError naming PORT',
      (value) => {
        const env = { ...VALID_ENV, PORT: value };
        expect(() => loadConfig(env)).toThrow(ConfigError);
        expect(() => loadConfig(env)).toThrow(/PORT/);
      },
    );

    it.each([['1', 1], ['8787', 8787], ['65535', 65535]] as const)(
      'when PORT is %s, then the port is %i',
      (value, expected) => {
        expect(loadConfig({ ...VALID_ENV, PORT: value }).port).toBe(expected);
      },
    );
  });

  describe('given the test login in production', () => {
    it('when NODE_ENV=production and ONESPACE_TEST_LOGIN=1, then it throws "ONESPACE_TEST_LOGIN is not allowed in production"', () => {
      const env = { ...VALID_ENV, NODE_ENV: 'production', ONESPACE_TEST_LOGIN: '1' };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow('ONESPACE_TEST_LOGIN is not allowed in production');
    });
  });

  // Final fix round — Ruling R72: the test login (a door that skips Discord) also needs a
  // localhost PUBLIC_ORIGIN, on top of NODE_ENV and ONESPACE_TEST_LOGIN — NODE_ENV alone
  // must not be what keeps it shut on a deployed host.
  describe('given the test login and PUBLIC_ORIGIN (R72)', () => {
    it.each(['http://localhost:5173', 'http://localhost', 'http://127.0.0.1:8787', 'http://[::1]:5173', 'https://localhost:5173'])(
      'when ONESPACE_TEST_LOGIN=1 and PUBLIC_ORIGIN is the localhost origin %s, then testLogin is true',
      (value) => {
        expect(loadConfig({ ...VALID_ENV, PUBLIC_ORIGIN: value, ONESPACE_TEST_LOGIN: '1' }).testLogin).toBe(true);
      },
    );

    it.each([
      'https://onespace.example',
      'https://onespace.up.railway.app',
      'http://localhost.evil.example',
      'http://127.0.0.2:5173',
      'http://10.0.0.5:5173',
      'http://[::2]:5173',
    ])('when ONESPACE_TEST_LOGIN=1 and PUBLIC_ORIGIN is %s (not localhost), then it throws a ConfigError naming ONESPACE_TEST_LOGIN', (value) => {
      const env = { ...VALID_ENV, PUBLIC_ORIGIN: value, ONESPACE_TEST_LOGIN: '1' };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(/ONESPACE_TEST_LOGIN/);
    });

    it('when ONESPACE_TEST_LOGIN is not set, then a non-localhost PUBLIC_ORIGIN is fine and testLogin is false', () => {
      expect(loadConfig(VALID_ENV).testLogin).toBe(false);
    });
  });
});
