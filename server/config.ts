import { z } from 'zod';

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

const required = z.string().min(1);

/** A bare http(s) origin: scheme, host, optional port, nothing else. */
const origin = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v;
    } catch {
      return false;
    }
  },
  { message: 'must be an http(s) origin without path or trailing slash, e.g. https://example.com' },
);

const EnvSchema = z.object({
  DATABASE_URL: required,
  PUBLIC_ORIGIN: origin,
  DISCORD_CLIENT_ID: required,
  DISCORD_CLIENT_SECRET: required,
  DISCORD_GUILD_ID: required,
  DISCORD_ROLE_ID: required,
  PORT: z
    .string()
    .regex(/^\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .optional()
    .or(z.literal('').transform(() => undefined)),
  NODE_ENV: z.string().optional(),
  ONESPACE_TEST_LOGIN: z.string().optional(),
});

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an http(s) origin on localhost, 127.0.0.1 or [::1] (any port). */
function isLocalhostOrigin(value: string): boolean {
  try {
    return LOCALHOST_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue.path[0] ?? 'environment');
    const missing = env[field] === undefined || env[field] === '';
    throw new ConfigError(missing ? `Missing environment variable ${field}` : `Invalid environment variable ${field}: ${issue.message}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const testLogin = e.ONESPACE_TEST_LOGIN === '1';
  if (production && testLogin) throw new ConfigError('ONESPACE_TEST_LOGIN is not allowed in production');
  // R72: NODE_ENV alone must not be what keeps the test login shut on a deployed host.
  if (testLogin && !isLocalhostOrigin(e.PUBLIC_ORIGIN)) {
    throw new ConfigError('ONESPACE_TEST_LOGIN needs a localhost PUBLIC_ORIGIN (localhost, 127.0.0.1 or [::1])');
  }

  return {
    databaseUrl: e.DATABASE_URL,
    publicOrigin: e.PUBLIC_ORIGIN,
    discord: {
      clientId: e.DISCORD_CLIENT_ID,
      clientSecret: e.DISCORD_CLIENT_SECRET,
      guildId: e.DISCORD_GUILD_ID,
      roleId: e.DISCORD_ROLE_ID,
    },
    port: e.PORT ?? 8790,
    production,
    testLogin,
  };
}
