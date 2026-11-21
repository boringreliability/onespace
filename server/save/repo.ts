/**
 * Cloud save repository (v4 sub-plan 4, Task 4). One cloud save per account, optimistic
 * concurrency, a single archive slot. Every write runs in ONE transaction that first locks
 * the user's `users` row (`select … for no key update`): that row always exists, so even two first
 * PUTs against an empty cloud (no `saves` row to lock yet) serialise and yield one winner.
 * Saves arrive already validated (`migrate`); this module trusts them.
 *
 * Rows an older build stored keep the format it wrote (format 1 before plan 6). GET and a 409
 * hand them back as stored — the client migrates what it reads. Where the repo itself COMPARES or
 * COMBINES a head with an incoming save (the idempotent-PUT check and a same-game resolve), both
 * sides are first lifted to the current format with `migrate` (`current`), so formats never mix.
 */

import type { Sql, TransactionSql } from 'postgres';

import { resolveSameGame, shipDigest, type ShipDigest } from '../../src/save/conflict';
import { migrate } from '../../src/save/migrate';
import type { Save } from '../../src/save/schema';

export type Base = { saveId: string; revision: number } | null;

/**
 * A row's body as stored: whatever format the build that wrote it used (format 1 before plan 6).
 * Typed `unknown` on purpose — `current()` is the way to a `Save`.
 */
export type StoredBody = unknown;

export type Head = { saveId: string; revision: number; save: StoredBody };

export type PutResult =
  | { kind: 'stored'; revision: number; archived: boolean }
  | { kind: 'unchanged'; revision: number }
  | { kind: 'conflict'; cloud: { revision: number; save: StoredBody } };

export type ResolveResult =
  | { kind: 'resolved' | 'replayed'; revision: number; save: Save }
  | { kind: 'conflict'; cloud: { revision: number; save: StoredBody }; resolvedAs?: { saveId: string; revision: number } };

/** The user row vanished (account deleted) before the write took its lock. */
export class UserGoneError extends Error {
  constructor() {
    super('user not found');
    this.name = 'UserGoneError';
  }
}

/** A same-game resolve would need revision max + 1 beyond Postgres int4. */
export class RevisionOverflowError extends Error {
  constructor() {
    super('revision overflow');
    this.name = 'RevisionOverflowError';
  }
}

const INT4_MAX = 2_147_483_647;

type Tx = TransactionSql;
type HeadRow = { save_id: string; revision: number; body: StoredBody; resolve_key: string | null };

const json = (tx: Tx, v: unknown) => tx.json(v as Parameters<Tx['json']>[0]);

async function lockUser(tx: Tx, userId: string): Promise<void> {
  // NO KEY UPDATE: still conflicts with the delete of the row, but not with FK key-shares (session inserts).
  const rows = await tx`select id from users where id = ${userId} for no key update`;
  if (rows.length === 0) throw new UserGoneError();
}

async function readHead(tx: Tx, userId: string): Promise<HeadRow | undefined> {
  const rows = await tx<HeadRow[]>`select save_id, revision, body, resolve_key from saves where user_id = ${userId}`;
  return rows[0];
}

const cloudOf = (h: HeadRow) => ({ revision: h.revision, save: h.body });

/**
 * A save in the current format: a row an older build stored (or a save handed in unlifted) is
 * lifted by `migrate`. A body `migrate` refuses is returned as it is, so what reads it next
 * (resolveSameGame's schema check) still fails loudly instead of being skipped.
 */
function current(s: StoredBody): Save {
  const m = migrate(s);
  return m.ok ? m.save : (s as Save);
}

/**
 * A head handed back as stored (a replayed resolve, KEEP CLOUD across games): verbatim, so a row
 * an older build wrote keeps its format and the client migrates it, as GET and a 409 do. Typed
 * `Save` only because `ResolveResult`'s contract says so; nothing here reads it as one.
 */
function verbatim(h: HeadRow): Save {
  return h.body as Save;
}

async function archiveHead(tx: Tx, userId: string, h: HeadRow): Promise<void> {
  await tx`
    insert into save_archive (user_id, save_id, revision, body, archived_at)
    values (${userId}, ${h.save_id}, ${h.revision}, ${json(tx, h.body)}::jsonb, now())
    on conflict (user_id) do update
      set save_id = excluded.save_id, revision = excluded.revision, body = excluded.body, archived_at = excluded.archived_at`;
}

async function storeHead(
  tx: Tx,
  userId: string,
  deviceId: string,
  save: Save,
  resolveKey: string | null,
): Promise<void> {
  await tx`
    insert into saves (user_id, save_id, revision, body, updated_at, resolve_key)
    values (${userId}, ${save.saveId}, ${save.revision}, ${json(tx, save)}::jsonb, now(), ${resolveKey})
    on conflict (user_id) do update
      set save_id = excluded.save_id, revision = excluded.revision, body = excluded.body,
          updated_at = excluded.updated_at, resolve_key = excluded.resolve_key`;
  // R84: a resolve stamps its key on the result's revision row too (a row that already exists included).
  await tx`
    insert into save_revisions (user_id, save_id, revision, digest, resolve_key)
    values (${userId}, ${save.saveId}, ${save.revision}, ${json(tx, shipDigest(save))}::jsonb, ${resolveKey})
    on conflict (user_id, save_id, revision) ${
      resolveKey === null ? tx`do nothing` : tx`do update set resolve_key = excluded.resolve_key`
    }`;
  if (save.actions.length > 0) {
    await tx`
      insert into actions (user_id, save_id, device_id, seq, entry)
      select ${userId}, ${save.saveId}, ${deviceId}, (e.value ->> 'seq')::int, e.value
      from jsonb_array_elements(${json(tx, save.actions)}::jsonb) as e
      on conflict (user_id, save_id, device_id, seq) do nothing`;
  }
}

export async function getHead(sql: Sql, userId: string): Promise<Head | null> {
  const rows = await sql<HeadRow[]>`select save_id, revision, body, resolve_key from saves where user_id = ${userId}`;
  const r = rows[0];
  return r ? { saveId: r.save_id, revision: r.revision, save: r.body } : null;
}

export async function putSave(
  sql: Sql,
  userId: string,
  input: { deviceId: string; base: Base; save: Save },
): Promise<PutResult> {
  const { deviceId, base, save } = input;
  return sql.begin(async (tx): Promise<PutResult> => {
    await lockUser(tx, userId);
    const head = await readHead(tx, userId);
    if (!head) {
      await storeHead(tx, userId, deviceId, save, null);
      return { kind: 'stored', revision: save.revision, archived: false };
    }
    if (head.save_id === save.saveId && head.revision === save.revision) {
      // jsonb equality: key order does not matter. A head an older build stored as format 1 is
      // also compared lifted, so the same save sent again in the current format is `unchanged`.
      const [eq] = await tx<{ same: boolean }[]>`
        select (body = ${json(tx, save)}::jsonb or ${json(tx, current(head.body))}::jsonb = ${json(tx, save)}::jsonb) as same
        from saves where user_id = ${userId}`;
      if (eq?.same) return { kind: 'unchanged', revision: head.revision };
      return { kind: 'conflict', cloud: cloudOf(head) };
    }
    const baseIsHead = base !== null && base.saveId === head.save_id && base.revision === head.revision;
    if (baseIsHead && save.saveId === head.save_id && save.revision > head.revision) {
      await storeHead(tx, userId, deviceId, save, null);
      return { kind: 'stored', revision: save.revision, archived: false };
    }
    if (baseIsHead && save.saveId !== head.save_id) {
      await archiveHead(tx, userId, head);
      await storeHead(tx, userId, deviceId, save, null);
      return { kind: 'stored', revision: save.revision, archived: true };
    }
    return { kind: 'conflict', cloud: cloudOf(head) };
  });
}

export async function resolveSave(
  sql: Sql,
  userId: string,
  input: { deviceId: string; keep: 'device' | 'cloud'; device: Save; base: Base; cloud: Base },
): Promise<ResolveResult> {
  const { deviceId, keep, device, base, cloud } = input;
  const key = `${keep}:${device.saveId}:${device.revision}:${cloud ? `${cloud.saveId}:${cloud.revision}` : 'none'}`;
  return sql.begin(async (tx): Promise<ResolveResult> => {
    await lockUser(tx, userId);
    const head = await readHead(tx, userId);
    if (!head) {
      // R27: nothing in the cloud (never there, or deleted meanwhile): the device save becomes the head.
      await storeHead(tx, userId, deviceId, device, key);
      return { kind: 'resolved', revision: device.revision, save: device };
    }
    if (head.resolve_key === key) return { kind: 'replayed', revision: head.revision, save: verbatim(head) };
    const sawHead = cloud !== null && cloud.saveId === head.save_id && cloud.revision === head.revision;
    if (!sawHead) {
      // R84: committed before another device moved the head on — name the revision it became.
      // Matched on (session user, key) alone: the head may since be another game.
      const [hit] = await tx<{ save_id: string; revision: number }[]>`
        select save_id, revision from save_revisions
        where user_id = ${userId} and resolve_key = ${key}
        order by revision desc limit 1`;
      return hit
        ? { kind: 'conflict', cloud: cloudOf(head), resolvedAs: { saveId: hit.save_id, revision: hit.revision } }
        : { kind: 'conflict', cloud: cloudOf(head) };
    }

    // sameGame, read off the row's save_id column (storeHead writes it from the body's saveId).
    if (head.save_id === device.saveId) {
      if (Math.max(head.revision, device.revision) >= INT4_MAX) throw new RevisionOverflowError();
      // Both in the current format: a head an older build stored as format 1 is lifted (never mixed).
      const [headNow, deviceNow] = [current(head.body), current(device)];
      const [chosen, unchosen] = keep === 'device' ? [deviceNow, headNow] : [headNow, deviceNow];
      let baseDigest: ShipDigest = shipDigest(unchosen);
      // A base only counts for the head's own game.
      if (base && base.saveId === head.save_id) {
        const rows = await tx<{ digest: ShipDigest }[]>`
          select digest from save_revisions
          where user_id = ${userId} and save_id = ${base.saveId} and revision = ${base.revision}`;
        if (rows[0]) baseDigest = rows[0].digest;
      }
      const resolved = resolveSameGame(chosen, unchosen, baseDigest);
      await storeHead(tx, userId, deviceId, resolved, key);
      return { kind: 'resolved', revision: resolved.revision, save: resolved };
    }
    if (keep === 'device') {
      await archiveHead(tx, userId, head);
      await storeHead(tx, userId, deviceId, device, key);
      return { kind: 'resolved', revision: device.revision, save: device };
    }
    await tx`update saves set resolve_key = ${key} where user_id = ${userId}`;
    await tx`
      update save_revisions set resolve_key = ${key}
      where user_id = ${userId} and save_id = ${head.save_id} and revision = ${head.revision}`;
    return { kind: 'resolved', revision: head.revision, save: verbatim(head) };
  });
}

/** Deletes the account; users, sessions, saves, archive, revisions and actions go by cascade. */
export async function deleteAccount(sql: Sql, userId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from users where id = ${userId}`;
  });
}
