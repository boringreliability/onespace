/**
 * Cloud save repository (v4 sub-plan 4, Task 4, phase A). Real Postgres, no HTTP.
 *
 * Repo API pinned here (server/save/repo.ts, phase B):
 *   type Base = { saveId: string; revision: number } | null
 *   getHead(sql, userId): Promise<{ saveId: string; revision: number; save: SaveV1 } | null>
 *   putSave(sql, userId, { deviceId, base, save }): Promise<
 *       | { kind: 'stored'; revision: number; archived: boolean }   // archived: old head moved to save_archive
 *       | { kind: 'unchanged'; revision: number }                   // idempotent retry, nothing written
 *       | { kind: 'conflict'; cloud: { revision: number; save: SaveV1 } }>
 *   resolveSave(sql, userId, { deviceId, keep: 'device' | 'cloud', device, base }): Promise<
 *       { revision: number; save: SaveV1 }>
 *   deleteAccount(sql, userId): Promise<void>
 *
 * `save` / `device` arrive already validated (routes call `migrate`); the repo trusts them.
 * Every function runs its writes in ONE transaction with `select … for update` on the user's saves row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { shipDigest } from '../../src/save/conflict';
import golden from '../../src/save/fixtures/v1-golden.json';
import type { SaveV1 } from '../../src/save/schema';
import { migrate } from '../migrate';
import { withTestSchema, type TestSchema } from '../test/db';

import { deleteAccount, getHead, putSave, resolveSave } from './repo';

const SAVE_X = '3f9c2b1e-7a4d-4e8b-9c61-2d5f0a8e7b14';
const SAVE_Y = '11111111-2222-4333-8444-555555555555';
const SAVE_Z = '99999999-2222-4333-8444-555555555555';
const DEV_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DEV_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const N_ACTIONS = (golden as { actions: unknown[] }).actions.length;

let t: TestSchema;
beforeAll(async () => {
  t = await withTestSchema();
  await migrate(t.sql);
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.sql`truncate users cascade`;
});

function mk(o: { saveId?: string; revision?: number; tank?: number; extraActions?: number } = {}): SaveV1 {
  const s = structuredClone(golden) as unknown as SaveV1;
  s.saveId = o.saveId ?? SAVE_X;
  s.revision = o.revision ?? 1;
  if (o.tank !== undefined) s.ship.propellant.massKg = o.tank;
  const last = s.actions.length;
  for (let i = 1; i <= (o.extraActions ?? 0); i++) {
    s.actions.push({ seq: last + i, source: 'thrust', payload: { kg: 1 }, wallMs: 1, orbitSeconds: 1 } as SaveV1['actions'][number]);
  }
  return s;
}
const head = (s: SaveV1) => ({ saveId: s.saveId, revision: s.revision });
const user = async (name: string) =>
  (await t.sql<{ id: string }[]>`insert into users (discord_id, name) values (${`d:${name}`}, ${name}) returning id`)[0]!.id;
const n = async (table: string, userId: string) =>
  (await t.sql.unsafe(`select count(*)::int n from ${table} where user_id = $1`, [userId]))[0]!.n as number;

describe('getHead', () => {
  it('Given no save, When getHead, Then null', async () => {
    expect(await getHead(t.sql, await user('a'))).toBeNull();
  });

  it('Given a stored save, When getHead, Then { saveId, revision, save } with revision = save.revision', async () => {
    const a = await user('a');
    const s = mk({ revision: 7 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s });
    expect(await getHead(t.sql, a)).toEqual({ saveId: SAVE_X, revision: 7, save: s });
  });

  it('Given only another user has a save, When getHead, Then null', async () => {
    const a = await user('a');
    const b = await user('b');
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: mk() });
    expect(await getHead(t.sql, b)).toBeNull();
  });
});

describe('putSave', () => {
  it('Given an empty cloud, When put with base null, Then stored, not archived; head, digest and actions written', async () => {
    const a = await user('a');
    const s = mk({ revision: 3 });
    expect(await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s })).toEqual({ kind: 'stored', revision: 3, archived: false });
    expect(await n('saves', a)).toBe(1);
    expect(await n('actions', a)).toBe(N_ACTIONS);
    const [rev] = await t.sql<{ digest: unknown }[]>`select digest from save_revisions where user_id = ${a} and save_id = ${SAVE_X} and revision = 3`;
    expect(rev!.digest).toEqual(shipDigest(s));
  });

  it('Given an empty cloud, When put with a non-null base, Then stored too', async () => {
    const a = await user('a');
    const r = await putSave(t.sql, a, { deviceId: DEV_A, base: { saveId: SAVE_X, revision: 1 }, save: mk({ revision: 2 }) });
    expect(r).toEqual({ kind: 'stored', revision: 2, archived: false });
  });

  it('Given head r1, When put r2 with base = head, Then stored and only the new actions are added', async () => {
    const a = await user('a');
    const s1 = mk({ revision: 1 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s1 });
    const r = await putSave(t.sql, a, { deviceId: DEV_A, base: head(s1), save: mk({ revision: 2, extraActions: 2 }) });
    expect(r).toEqual({ kind: 'stored', revision: 2, archived: false });
    expect(await n('actions', a)).toBe(N_ACTIONS + 2);
    expect(await n('save_revisions', a)).toBe(2);
  });

  it('Given head r3, When the identical save is put again, Then unchanged and nothing is written', async () => {
    const a = await user('a');
    const s = mk({ revision: 3 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s });
    const [before] = await t.sql<{ at: Date }[]>`select updated_at as at from saves where user_id = ${a}`;
    expect(await putSave(t.sql, a, { deviceId: DEV_A, base: head(s), save: s })).toEqual({ kind: 'unchanged', revision: 3 });
    expect(await putSave(t.sql, a, { deviceId: DEV_B, base: null, save: s })).toEqual({ kind: 'unchanged', revision: 3 });
    expect(await n('actions', a)).toBe(N_ACTIONS);
    expect(await n('save_revisions', a)).toBe(1);
    const [after] = await t.sql<{ at: Date }[]>`select updated_at as at from saves where user_id = ${a}`;
    expect(after!.at).toEqual(before!.at);
  });

  it('Given head r2, When put with a stale base, base null, an equal revision with a different body, or a lower revision, Then conflict with the cloud head, nothing changes', async () => {
    const a = await user('a');
    const s1 = mk({ revision: 1 });
    const s2 = mk({ revision: 2, tank: 10_000 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s1 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: head(s1), save: s2 });
    const attempts = [
      { base: head(s1), save: mk({ revision: 3 }) },
      { base: null, save: mk({ revision: 3 }) },
      { base: head(s2), save: mk({ revision: 2, tank: 1 }) },
      { base: head(s2), save: mk({ revision: 1 }) },
    ];
    for (const at of attempts) {
      expect(await putSave(t.sql, a, { deviceId: DEV_B, ...at })).toEqual({ kind: 'conflict', cloud: { revision: 2, save: s2 } });
    }
    expect(await getHead(t.sql, a)).toEqual({ saveId: SAVE_X, revision: 2, save: s2 });
    expect(await n('actions', a)).toBe(N_ACTIONS);
    expect(await n('save_revisions', a)).toBe(2);
  });

  it('Given head X, When put a new saveId with base = head, Then stored with archived: true and X is the single archive row', async () => {
    const a = await user('a');
    const x = mk({ revision: 4 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: x });
    const y = mk({ saveId: SAVE_Y, revision: 1 });
    expect(await putSave(t.sql, a, { deviceId: DEV_A, base: head(x), save: y })).toEqual({ kind: 'stored', revision: 1, archived: true });
    expect((await getHead(t.sql, a))?.saveId).toBe(SAVE_Y);
    const arch = await t.sql<{ save_id: string; revision: number; body: SaveV1 }[]>`select save_id, revision, body from save_archive where user_id = ${a}`;
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatchObject({ save_id: SAVE_X, revision: 4 });
    expect(arch[0]!.body).toEqual(x);
  });

  it('Given an archive, When a second new game is put, Then the archive is overwritten and still one row', async () => {
    const a = await user('a');
    const x = mk({ revision: 1 });
    const y = mk({ saveId: SAVE_Y, revision: 2 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: x });
    await putSave(t.sql, a, { deviceId: DEV_A, base: head(x), save: y });
    await putSave(t.sql, a, { deviceId: DEV_A, base: head(y), save: mk({ saveId: SAVE_Z, revision: 1 }) });
    const arch = await t.sql<{ save_id: string }[]>`select save_id from save_archive where user_id = ${a}`;
    expect(arch.map((r: { save_id: string }) => r.save_id)).toEqual([SAVE_Y]);
  });

  it('Given two devices, When they put the same seqs, Then actions are keyed (user, save, device, seq): one row per device and seq, entry = the whole entry', async () => {
    const a = await user('a');
    const s1 = mk({ revision: 1 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s1 });
    await putSave(t.sql, a, { deviceId: DEV_B, base: head(s1), save: mk({ revision: 2 }) });
    expect(await n('actions', a)).toBe(N_ACTIONS * 2);
    const [row] = await t.sql<{ entry: unknown }[]>`select entry from actions where user_id = ${a} and device_id = ${DEV_B} and seq = 1`;
    expect(row!.entry).toEqual(s1.actions[0]);
  });

  it('Given an action row already stored, When a later put repeats its seq with the same device, Then ON CONFLICT DO NOTHING: no error, no duplicate, original kept', async () => {
    const a = await user('a');
    const s1 = mk({ revision: 1 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s1 });
    const s2 = mk({ revision: 2 });
    s2.actions[0] = { ...s2.actions[0]!, wallMs: 123 } as SaveV1['actions'][number];
    expect((await putSave(t.sql, a, { deviceId: DEV_A, base: head(s1), save: s2 })).kind).toBe('stored');
    expect(await n('actions', a)).toBe(N_ACTIONS);
    const [row] = await t.sql<{ entry: unknown }[]>`select entry from actions where user_id = ${a} and seq = 1`;
    expect(row!.entry).toEqual(s1.actions[0]);
  });

  it('Given two racing puts from the same base, When run in parallel, Then exactly one stored and one conflict', async () => {
    const a = await user('a');
    const [r1, r2] = await Promise.all([
      putSave(t.sql, a, { deviceId: DEV_A, base: null, save: mk({ tank: 1 }) }),
      putSave(t.sql, a, { deviceId: DEV_B, base: null, save: mk({ tank: 2 }) }),
    ]);
    expect([r1.kind, r2.kind].sort()).toEqual(['conflict', 'stored']);
    expect(await n('saves', a)).toBe(1);
  });

  it('Given a failure part-way (a save whose action seq would violate a column), When put, Then the transaction rolls back: no head, no digest, no actions', async () => {
    const a = await user('a');
    const bad = mk({ revision: 1 });
    // seq beyond int4 makes the actions insert fail after the head insert
    bad.actions[bad.actions.length - 1] = { ...bad.actions[bad.actions.length - 1]!, seq: 2 ** 40 } as SaveV1['actions'][number];
    await expect(putSave(t.sql, a, { deviceId: DEV_A, base: null, save: bad })).rejects.toThrow();
    expect(await n('saves', a)).toBe(0);
    expect(await n('save_revisions', a)).toBe(0);
    expect(await n('actions', a)).toBe(0);
  });

  it('Given user A has a head, When user B puts with base = A head, Then A rows are untouched', async () => {
    const a = await user('a');
    const b = await user('b');
    const s = mk({ revision: 5 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: s });
    await putSave(t.sql, b, { deviceId: DEV_B, base: head(s), save: mk({ revision: 1, tank: 3 }) });
    expect(await getHead(t.sql, a)).toEqual({ saveId: SAVE_X, revision: 5, save: s });
    expect(await n('actions', a)).toBe(N_ACTIONS);
  });
});

describe('resolveSave', () => {
  async function diverged(a: string) {
    const base = mk({ revision: 5, tank: 12_000 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: base });
    await putSave(t.sql, a, { deviceId: DEV_A, base: head(base), save: mk({ revision: 6, tank: 9_000 }) });
    return { base, device: mk({ revision: 6, tank: 11_000 }) };
  }

  it('Given no head, When resolve, Then the device save is stored and returned', async () => {
    const a = await user('a');
    const s = mk({ revision: 2 });
    expect(await resolveSave(t.sql, a, { deviceId: DEV_A, keep: 'device', device: s, base: null })).toEqual({ revision: 2, save: s });
    expect((await getHead(t.sql, a))?.save).toEqual(s);
  });

  it('Given a diverged same game, When keep "device" with the base digest, Then the cloud fall is subtracted, revision = max + 1, head and digest row stored', async () => {
    const a = await user('a');
    const { base, device } = await diverged(a);
    const r = await resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'device', device, base: head(base) });
    expect(r.revision).toBe(7);
    expect(r.save.ship.propellant.massKg).toBe(8_000);
    expect(await getHead(t.sql, a)).toEqual({ saveId: SAVE_X, revision: 7, save: r.save });
    const [rev] = await t.sql<{ digest: unknown }[]>`select digest from save_revisions where user_id = ${a} and revision = 7`;
    expect(rev!.digest).toEqual(shipDigest(r.save));
  });

  it('Given a diverged same game, When keep "cloud", Then the device fall is subtracted from the cloud save', async () => {
    const a = await user('a');
    const { base, device } = await diverged(a);
    const r = await resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'cloud', device, base: head(base) });
    expect(r.revision).toBe(7);
    expect(r.save.ship.propellant.massKg).toBe(8_000);
  });

  it('Given base null or a base without a digest row, When resolve, Then nothing is subtracted', async () => {
    const a = await user('a');
    const { device } = await diverged(a);
    const r1 = await resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'device', device, base: null });
    expect(r1.save.ship.propellant.massKg).toBe(11_000);
    const r2 = await resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'device', device: mk({ revision: 6, tank: 11_000 }), base: { saveId: SAVE_X, revision: 99 } });
    expect(r2.save.ship.propellant.massKg).toBeGreaterThan(0);
  });

  it('Given another user holds the base digest, When this user resolves with that base, Then it is treated as missing', async () => {
    const a = await user('a');
    const b = await user('b');
    const { base } = await diverged(a);
    await putSave(t.sql, b, { deviceId: DEV_B, base: null, save: mk({ revision: 6, tank: 9_000 }) });
    const r = await resolveSave(t.sql, b, { deviceId: DEV_B, keep: 'device', device: mk({ revision: 6, tank: 11_000 }), base: head(base) });
    expect(r.save.ship.propellant.massKg).toBe(11_000);
  });

  it('Given different games, When keep "device", Then the head X is archived and Y is head', async () => {
    const a = await user('a');
    const x = mk({ revision: 3 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: x });
    const y = mk({ saveId: SAVE_Y, revision: 1 });
    expect(await resolveSave(t.sql, a, { deviceId: DEV_A, keep: 'device', device: y, base: head(x) })).toEqual({ revision: 1, save: y });
    const arch = await t.sql<{ save_id: string; body: SaveV1 }[]>`select save_id, body from save_archive where user_id = ${a}`;
    expect(arch).toHaveLength(1);
    expect(arch[0]!.save_id).toBe(SAVE_X);
    expect(arch[0]!.body).toEqual(x);
  });

  it('Given different games, When keep "cloud", Then nothing changes and the head is returned', async () => {
    const a = await user('a');
    const x = mk({ revision: 3 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: x });
    expect(await resolveSave(t.sql, a, { deviceId: DEV_A, keep: 'cloud', device: mk({ saveId: SAVE_Y }), base: head(x) })).toEqual({ revision: 3, save: x });
    expect(await n('save_archive', a)).toBe(0);
    expect(await n('save_revisions', a)).toBe(1);
  });

  it('Given a resolved game, When the same resolve repeats, Then it does not throw and the head stays a valid save', async () => {
    const a = await user('a');
    const { base, device } = await diverged(a);
    await resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'device', device, base: head(base) });
    const again = await resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'device', device, base: head(base) });
    expect(again.revision).toBeGreaterThanOrEqual(7);
    expect((await getHead(t.sql, a))?.revision).toBe(again.revision);
  });

  it('Given two racing resolves, When run in parallel, Then both settle without error and the head revision is one of the results', async () => {
    const a = await user('a');
    const { base, device } = await diverged(a);
    const rs = await Promise.all([
      resolveSave(t.sql, a, { deviceId: DEV_A, keep: 'device', device, base: head(base) }),
      resolveSave(t.sql, a, { deviceId: DEV_B, keep: 'device', device, base: head(base) }),
    ]);
    const h = await getHead(t.sql, a);
    expect(rs.map((r) => r.revision)).toContain(h!.revision);
  });
});

describe('deleteAccount', () => {
  it('Given a full account and another user, When deleteAccount, Then every table has zero rows for it and the other user is untouched', async () => {
    const a = await user('a');
    const b = await user('b');
    const x = mk({ revision: 1 });
    await putSave(t.sql, a, { deviceId: DEV_A, base: null, save: x });
    await putSave(t.sql, a, { deviceId: DEV_A, base: head(x), save: mk({ saveId: SAVE_Y, revision: 1 }) });
    await putSave(t.sql, b, { deviceId: DEV_B, base: null, save: mk({ revision: 2 }) });
    await t.sql`insert into sessions (token_hash, user_id, expires_at) values (${Buffer.from('tok-a')}, ${a}, now() + interval '1 day')`;
    const bRows = { saves: await n('saves', b), actions: await n('actions', b), revisions: await n('save_revisions', b) };

    await deleteAccount(t.sql, a);

    for (const table of ['sessions', 'saves', 'save_archive', 'save_revisions', 'actions']) expect(await n(table, a)).toBe(0);
    expect((await t.sql`select 1 from users where id = ${a}`).length).toBe(0);
    expect({ saves: await n('saves', b), actions: await n('actions', b), revisions: await n('save_revisions', b) }).toEqual(bRows);
    expect((await t.sql`select 1 from users where id = ${b}`).length).toBe(1);
  });

  it('Given an unknown user id, When deleteAccount, Then it resolves without error', async () => {
    await expect(deleteAccount(t.sql, '00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });
});
