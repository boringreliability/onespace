import postgres, { type Sql } from 'postgres';

export type { Sql };

export function createDb(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}
