/**
 * Migrations (v4 sub-plan 4, Task 1). Runs against the docker `db-test`
 * Postgres (`docker compose up -d db-test`), in a fresh schema per file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from './migrate';
import { withTestSchema, type TestSchema } from './test/db';

let t: TestSchema;
beforeAll(async () => {
  t = await withTestSchema();
});
afterAll(async () => {
  await t.drop();
});

describe('migrate', () => {
  describe('given an empty schema', () => {
    it('when run, then it applies 001_init.sql and returns its name', async () => {
      expect(await migrate(t.sql)).toEqual(['001_init.sql']);
    });

    it('when run a second time, then nothing is applied', async () => {
      expect(await migrate(t.sql)).toEqual([]);
    });

    it('when run, then all six tables exist in the schema', async () => {
      const rows = await t.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = current_schema()`;
      const names = rows.map((r) => r.table_name);
      for (const table of ['users', 'sessions', 'saves', 'save_archive', 'save_revisions', 'actions']) {
        expect(names).toContain(table);
      }
    });
  });
});
