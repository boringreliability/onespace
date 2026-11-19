/**
 * Migrations (v4 sub-plan 4, Task 1). Runs against the docker `db-test`
 * Postgres (`docker compose up -d db-test`), in a fresh schema per file.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('migrate rollback', () => {
  describe('given a migrations dir whose second file fails halfway', () => {
    it('when run, then it rejects, 002 is not recorded and its first statement is rolled back', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'onespace-mig-'));
      const own = await withTestSchema();
      try {
        writeFileSync(join(dir, '001_ok.sql'), 'create table ok_one (id int);');
        writeFileSync(join(dir, '002_bad.sql'), 'create table half_done (id int);\nthis is not sql;');
        await expect(migrate(own.sql, dir)).rejects.toThrow();
        const recorded = await own.sql<{ name: string }[]>`select name from schema_migrations order by name`;
        expect(recorded.map((r) => r.name)).toEqual(['001_ok.sql']);
        const tables = await own.sql<{ table_name: string }[]>`
          select table_name from information_schema.tables where table_schema = current_schema()`;
        const names = tables.map((r) => r.table_name);
        expect(names).toContain('ok_one');
        expect(names).not.toContain('half_done');
      } finally {
        await own.drop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('migrate', () => {
  describe('given an empty schema', () => {
    // CHANGED by Ruling R84 (D51b): a third migration adds save_revisions.resolve_key; was
    // "…applies 001_init.sql and 002_resolve_key.sql…" / toEqual(['001_init.sql', '002_resolve_key.sql']).
    it('when run, then it applies 001_init.sql, 002_resolve_key.sql and 003_revision_resolve_key.sql and returns their names', async () => {
      expect(await migrate(t.sql)).toEqual(['001_init.sql', '002_resolve_key.sql', '003_revision_resolve_key.sql']);
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

// ---- Ruling R84 (D51b) -------------------------------------------------------

describe('Ruling R84 — save_revisions carries the resolve key', () => {
  it('Ruling R84: Given the migrated schema, When the columns of save_revisions are read, Then resolve_key is a NULLABLE text column (rows written by a PUT carry none)', async () => {
    await migrate(t.sql);
    const cols = await t.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = current_schema() and table_name = 'save_revisions' and column_name = 'resolve_key'`;
    expect(cols).toEqual([{ column_name: 'resolve_key', data_type: 'text', is_nullable: 'YES' }]);
  });
});
