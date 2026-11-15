export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Config = {
  databaseUrl: string;
  publicOrigin: string;
  discord: { clientId: string; clientSecret: string; guildId: string; roleId: string };
  port: number;
  production: boolean;
  testLogin: boolean;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new ConfigError(`Missing environment variable ${name}`);
    return v;
  };
  const production = env.NODE_ENV === 'production';
  const testLogin = env.ONESPACE_TEST_LOGIN === '1';
  if (production && testLogin) throw new ConfigError('ONESPACE_TEST_LOGIN is not allowed in production');

  const portRaw = env.PORT;
  const port = portRaw ? Number(portRaw) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT is not a valid port: ${portRaw}`);

  return {
    databaseUrl: need('DATABASE_URL'),
    publicOrigin: need('PUBLIC_ORIGIN'),
    discord: {
      clientId: need('DISCORD_CLIENT_ID'),
      clientSecret: need('DISCORD_CLIENT_SECRET'),
      guildId: need('DISCORD_GUILD_ID'),
      roleId: need('DISCORD_ROLE_ID'),
    },
    port,
    production,
    testLogin,
  };
}
