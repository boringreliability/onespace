import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

const DEFAULT_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** Applies pending `NNN_*.sql` files in name order, each in a transaction. Returns the applied names. */
export async function migrate(sql: Sql, dir: string = DEFAULT_DIR): Promise<string[]> {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    applied.push(file);
  }
  return applied;
}
