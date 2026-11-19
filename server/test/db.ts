/**
 * Test helper: a fresh Postgres schema per test file.
 *
 * `withTestSchema()` creates a uniquely named schema, hands back a postgres.js
 * client whose `search_path` points at it, and drops the schema afterwards.
 * Needs `docker compose up -d db-test`.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://onespace:onespace@127.0.0.1:54329/onespace_test';

export type TestSchema = {
  sql: Sql;
  schema: string;
  /** Drops the schema and closes the client. Safe to call after `sql.end()`. */
  drop: () => Promise<void>;
};

export async function withTestSchema(): Promise<TestSchema> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create schema "${schema}"`);
  const sql = postgres(TEST_DATABASE_URL, {
    max: 4,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  return {
    sql,
    schema,
    drop: async () => {
      try {
        await sql.end({ timeout: 1 });
      } catch {
        /* already closed */
      }
      await admin.unsafe(`drop schema if exists "${schema}" cascade`);
      await admin.end({ timeout: 1 });
    },
  };
}
