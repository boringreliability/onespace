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

    it('when PORT is omitted, then the port is 8787', () => {
      expect(loadConfig(VALID_ENV).port).toBe(8787);
    });

    it('when NODE_ENV is production, then production is true', () => {
      expect(loadConfig({ ...VALID_ENV, NODE_ENV: 'production' }).production).toBe(true);
    });

    it('when ONESPACE_TEST_LOGIN=1 outside production, then testLogin is true', () => {
      expect(loadConfig({ ...VALID_ENV, ONESPACE_TEST_LOGIN: '1' }).testLogin).toBe(true);
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

  describe('given the test login in production', () => {
    it('when NODE_ENV=production and ONESPACE_TEST_LOGIN=1, then it throws "ONESPACE_TEST_LOGIN is not allowed in production"', () => {
      const env = { ...VALID_ENV, NODE_ENV: 'production', ONESPACE_TEST_LOGIN: '1' };
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow('ONESPACE_TEST_LOGIN is not allowed in production');
    });
  });
});
