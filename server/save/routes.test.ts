/**
 * Cloud save API over HTTP (v4 sub-plan 4, Task 4, phase A). Real Postgres,
 * real createApp; users and sessions are seeded straight into the database.
 *
 * Pinned (controller rulings R20-R24):
 *   GET    /api/save          -> 200 { revision, save } | 404 { error: 'no-save' }
 *   PUT    /api/save          -> 200 { revision } | 409 { cloud: { revision, save } }
 *   POST   /api/save/resolve  -> 200 { revision, save }
 *   DELETE /api/account       -> 204, session cookie cleared
 *   400 { error: 'invalid-save' } (migrate rejects) | 400 { error: 'invalid-body' } (envelope)
 *   401 { error: 'unauthenticated' } | 403 wrong Origin | 413 body > 2 MB | 429 write budget
 *   WRITE_LIMIT: PUT + resolve + DELETE share 30 per 60 s per user id.
 *
 * Action entries are keyed (user_id, save_id, device_id, seq); `seq` is the entry's own `seq`
 * and `entry` is the whole entry as jsonb.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSameGame, shipDigest } from '../../src/save/conflict';
import golden from '../../src/save/fixtures/v1-golden.json';
import { migrate as migrateSave } from '../../src/save/migrate';
import type { SaveV1 } from '../../src/save/schema';
import { createApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import type { Config } from '../config';
import { migrate } from '../migrate';
import { withTestSchema, type TestSchema } from '../test/db';

const ORIGIN = 'https://onespace.example';
const T0 = 1_700_000_000_000;
const SAVE_X = '3f9c2b1e-7a4d-4e8b-9c61-2d5f0a8e7b14';
const SAVE_Y = '11111111-2222-4333-8444-555555555555';
const SAVE_Z = '99999999-2222-4333-8444-555555555555';
const DEV_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DEV_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const config: Config = {
  databaseUrl: 'postgres://unused',
  publicOrigin: ORIGIN,
  discord: { clientId: 'c', clientSecret: 's', guildId: 'g', roleId: 'r' },
  port: 8787,
  production: false,
  testLogin: false,
};

let t: TestSchema;
let clock: number;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await withTestSchema();
  await migrate(t.sql);
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.sql`truncate users cascade`;
  clock = T0;
  app = createApp({ config, sql: t.sql, now: () => clock, staticRoot: '/nonexistent' });
});

// ---- fixtures ---------------------------------------------------------------

type Base = { saveId: string; revision: number } | null;

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
const head = (s: SaveV1): Base => ({ saveId: s.saveId, revision: s.revision });
const ACTIONS_IN_GOLDEN = (golden as { actions: unknown[] }).actions.length;

type User = { id: string; cookie: string };
async function mkUser(name: string): Promise<User> {
  const [u] = await t.sql<{ id: string }[]>`insert into users (discord_id, name) values (${`d:${name}`}, ${name}) returning id`;
  const token = await createSession(t.sql, u!.id, clock);
  return { id: u!.id, cookie: `${SESSION_COOKIE}=${token}` };
}

function call(method: string, path: string, u: User | null, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, ...extra };
  if (u) headers.cookie = u.cookie;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, { method, headers, body: payload });
}
const get = (u: User | null) => call('GET', '/api/save', u);
const put = (u: User | null, save: unknown, base: Base = null, deviceId = DEV_A) =>
  call('PUT', '/api/save', u, { deviceId, base, save });
const resolve = (u: User | null, keep: 'device' | 'cloud', device: unknown, base: Base, cloud: Base, deviceId = DEV_A) =>
  call('POST', '/api/save/resolve', u, { deviceId, keep, device, base, cloud });

async function snapshot(userId: string) {
  const q = async (table: string) => (await t.sql.unsafe(`select * from ${table} where user_id = $1`, [userId])).length;
  const heads = await t.sql`select save_id, revision, body from saves where user_id = ${userId}`;
  const arch = await t.sql`select save_id, revision, body from save_archive where user_id = ${userId}`;
  return {
    saves: await q('saves'),
    archive: await q('save_archive'),
    revisions: await q('save_revisions'),
    actions: await q('actions'),
    heads: JSON.stringify(heads),
    arch: JSON.stringify(arch),
  };
}
const actionCount = async (userId: string) =>
  (await t.sql<{ n: number }[]>`select count(*)::int as n from actions where user_id = ${userId}`)[0]!.n;
const headRow = async (userId: string) =>
  (await t.sql<{ save_id: string; revision: number; body: SaveV1 }[]>`select save_id, revision, body from saves where user_id = ${userId}`)[0];
const archiveRows = (userId: string) =>
  t.sql<{ save_id: string; revision: number; body: SaveV1 }[]>`select save_id, revision, body from save_archive where user_id = ${userId}`;

// ---- GET / first PUT --------------------------------------------------------

describe('GET /api/save and the first PUT', () => {
  it('Given an empty cloud, When GET, Then 404 { error: "no-save" }', async () => {
    const a = await mkUser('a');
    const res = await get(a);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no-save' });
  });

  it('Given an empty cloud, When PUT with base null, Then 200 { revision } and GET returns the same save', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 4 });
    const res = await put(a, s, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 4 });
    const got = await get(a);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ revision: 4, save: s });
  });

  it('Given an empty cloud, When PUT with a NON-null base (cloud was deleted), Then 200 and the save is stored', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 9 });
    const res = await put(a, s, { saveId: SAVE_X, revision: 8 });
    expect(res.status).toBe(200);
    expect((await headRow(a.id))?.revision).toBe(9);
  });

  it('Given a first PUT, When stored, Then the head row has the save revision, a save_revisions row holds shipDigest(save), and the actions are keyed (device_id, seq)', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 4 });
    await put(a, s, null, DEV_A);
    const h = await headRow(a.id);
    expect(h?.save_id).toBe(SAVE_X);
    expect(h?.revision).toBe(4);
    expect(h?.body).toEqual(s);
    const revs = await t.sql<{ save_id: string; revision: number; digest: unknown }[]>`select save_id, revision, digest from save_revisions where user_id = ${a.id}`;
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ save_id: SAVE_X, revision: 4 });
    expect(revs[0]!.digest).toEqual(shipDigest(s));
    const acts = await t.sql<{ device_id: string; seq: number; save_id: string; entry: unknown }[]>`select device_id, seq, save_id, entry from actions where user_id = ${a.id} order by seq`;
    expect(acts).toHaveLength(ACTIONS_IN_GOLDEN);
    expect(acts.every((r) => r.device_id === DEV_A && r.save_id === SAVE_X)).toBe(true);
    expect(acts.map((r) => r.seq)).toEqual(s.actions.map((e) => e.seq));
    expect(acts[0]!.entry).toEqual(s.actions[0]);
  });

  it('Given a stored save, When another user GETs, Then they see 404, not the save', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    await put(a, mk(), null);
    const res = await get(b);
    expect(res.status).toBe(404);
  });
});

// ---- PUT decision table -----------------------------------------------------

describe('PUT /api/save: the decision table (R21)', () => {
  it('Given head r1, When PUT r2 with base = head, Then 200, head is r2, digest row r2 written and new actions added', async () => {
    const a = await mkUser('a');
    const s1 = mk({ revision: 1 });
    await put(a, s1, null);
    const s2 = mk({ revision: 2, tank: 10_000, extraActions: 1 });
    const res = await put(a, s2, head(s1));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 2 });
    expect((await headRow(a.id))?.body).toEqual(s2);
    const revs = await t.sql<{ revision: number; digest: unknown }[]>`select revision, digest from save_revisions where user_id = ${a.id} order by revision`;
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    expect(revs[1]!.digest).toEqual(shipDigest(s2));
    expect(await actionCount(a.id)).toBe(ACTIONS_IN_GOLDEN + 1);
  });

  it('Given head r2 and a device still at base r1, When PUT with the stale base, Then 409 with the cloud head and nothing changes', async () => {
    const a = await mkUser('a');
    const s1 = mk({ revision: 1 });
    const s2 = mk({ revision: 2, tank: 10_000 });
    await put(a, s1, null);
    await put(a, s2, head(s1));
    const before = await snapshot(a.id);
    const stale = mk({ revision: 2, tank: 5_000, extraActions: 2 });
    const res = await put(a, stale, head(s1), DEV_B);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ cloud: { revision: 2, save: s2 } });
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given a head, When PUT with base null, Then 409 and nothing changes', async () => {
    const a = await mkUser('a');
    await put(a, mk({ revision: 3 }), null);
    const before = await snapshot(a.id);
    const res = await put(a, mk({ revision: 4, tank: 1 }), null, DEV_B);
    expect(res.status).toBe(409);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given head r3, When PUT the same revision with a DIFFERENT body, Then 409 and nothing changes', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 3 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await put(a, mk({ revision: 3, tank: 77 }), head(s));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { cloud: { revision: number } }).cloud.revision).toBe(3);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given head r3, When PUT a LOWER revision with base = head, Then 409 and nothing changes', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 3 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await put(a, mk({ revision: 2, tank: 1 }), head(s));
    expect(res.status).toBe(409);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given head r3, When the identical save is PUT again (retry), Then 200 { revision } and the action count is unchanged', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 3 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await put(a, s, head(s));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 3 });
    expect(await actionCount(a.id)).toBe(ACTIONS_IN_GOLDEN);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given head r3, When the identical save is PUT again with base null (a retry that lost its response), Then 200 and nothing is written', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 3 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await put(a, s, null);
    expect(res.status).toBe(200);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given head r1, When a second device PUTs r2 with the same seqs under ITS device id, Then actions are keyed per device', async () => {
    const a = await mkUser('a');
    const s1 = mk({ revision: 1 });
    await put(a, s1, null, DEV_A);
    await put(a, mk({ revision: 2 }), head(s1), DEV_B);
    const per = await t.sql<{ device_id: string; n: number }[]>`select device_id, count(*)::int as n from actions where user_id = ${a.id} group by device_id order by device_id`;
    expect(per).toEqual([
      { device_id: DEV_A, n: ACTIONS_IN_GOLDEN },
      { device_id: DEV_B, n: ACTIONS_IN_GOLDEN },
    ]);
  });

  it('Given head X, When PUT a NEW saveId Y with base = head X (new game while signed in), Then 200, X is in save_archive and Y is the head', async () => {
    const a = await mkUser('a');
    const x = mk({ saveId: SAVE_X, revision: 6 });
    await put(a, x, null);
    const y = mk({ saveId: SAVE_Y, revision: 1, tank: 20_000 });
    const res = await put(a, y, head(x));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 1 });
    const h = await headRow(a.id);
    expect(h?.save_id).toBe(SAVE_Y);
    expect(h?.body).toEqual(y);
    const arch = await archiveRows(a.id);
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatchObject({ save_id: SAVE_X, revision: 6 });
    expect(arch[0]!.body).toEqual(x);
  });

  it('Given an archived game, When a SECOND new game replaces the head, Then the archive still has exactly one row: the previous head', async () => {
    const a = await mkUser('a');
    const x = mk({ saveId: SAVE_X, revision: 2 });
    const y = mk({ saveId: SAVE_Y, revision: 3 });
    const z = mk({ saveId: SAVE_Z, revision: 1 });
    await put(a, x, null);
    await put(a, y, head(x));
    expect((await put(a, z, head(y))).status).toBe(200);
    const arch = await archiveRows(a.id);
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatchObject({ save_id: SAVE_Y, revision: 3 });
    expect((await headRow(a.id))?.save_id).toBe(SAVE_Z);
  });

  it('Given head X, When PUT a new saveId with a STALE base, Then 409 and the archive stays empty', async () => {
    const a = await mkUser('a');
    const x1 = mk({ revision: 1 });
    await put(a, x1, null);
    await put(a, mk({ revision: 2 }), head(x1));
    const res = await put(a, mk({ saveId: SAVE_Y, revision: 1 }), head(x1));
    expect(res.status).toBe(409);
    expect(await archiveRows(a.id)).toHaveLength(0);
  });
});

// ---- Validation -------------------------------------------------------------

describe('Validation (R23)', () => {
  const bad = (label: string, make: () => unknown) =>
    it(`Given ${label}, When PUT, Then 400 { error: "invalid-save" } and nothing changes`, async () => {
      const a = await mkUser('a');
      const s = mk({ revision: 1 });
      await put(a, s, null);
      const before = await snapshot(a.id);
      const res = await put(a, make(), head(s));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-save' });
      expect(await snapshot(a.id)).toEqual(before);
    });

  bad('format 99', () => ({ ...mk({ revision: 2 }), format: 99 }));
  bad('a rock id "__proto__"', () => {
    const s = mk({ revision: 2 });
    s.world.entries = [{ id: '__proto__', by: 'local', resource: 'ice', kg: 1, wallMs: 1, orbitSeconds: 1 }] as SaveV1['world']['entries'];
    return s;
  });
  bad('garbage as the save', () => 'not a save');
  bad('a save with an unknown extra key', () => ({ ...mk({ revision: 2 }), extra: true }));

  it('Given an invalid save on an EMPTY cloud, When PUT, Then 400 and nothing is stored', async () => {
    const a = await mkUser('a');
    const res = await put(a, { ...mk(), format: 99 }, null);
    expect(res.status).toBe(400);
    expect((await get(a)).status).toBe(404);
    expect(await actionCount(a.id)).toBe(0);
  });

  it('Given an invalid device save, When resolve, Then 400 { error: "invalid-save" } and nothing changes', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 1 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'device', { ...mk({ revision: 2 }), format: 99 }, head(s), head(s));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-save' });
    expect(await snapshot(a.id)).toEqual(before);
  });

  const withSeq = (seq: number) => {
    const s = mk({ revision: 2 });
    s.actions[s.actions.length - 1] = { ...s.actions[s.actions.length - 1]!, seq } as SaveV1['actions'][number];
    return s;
  };
  bad('an action seq of 2147483648 (beyond int4, R25)', () => withSeq(2_147_483_648));
  bad('an action seq of 2**40', () => withSeq(2 ** 40));

  it('Given an action seq of exactly 2147483647, When PUT, Then it is accepted (200) and stored', async () => {
    const a = await mkUser('a');
    const res = await put(a, withSeq(2_147_483_647), null);
    expect(res.status).toBe(200);
    expect(await actionCount(a.id)).toBe(ACTIONS_IN_GOLDEN);
  });

  it('Given an out-of-range action seq in the device save, When resolve, Then 400 invalid-save and nothing is written', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 1 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'device', withSeq(2_147_483_648), head(s), head(s));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-save' });
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given the actions table is unavailable, When PUT, Then 500 { error: "internal" } and no head and no digest row were written (transaction rolled back)', async () => {
    const a = await mkUser('a');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await t.sql`alter table actions rename to actions_gone`;
    let res: Response;
    try {
      res = await put(a, mk({ revision: 1 }), null);
    } finally {
      await t.sql`alter table actions_gone rename to actions`;
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect((await snapshot(a.id))).toMatchObject({ saves: 0, revisions: 0, actions: 0 });
  });

  const envelope = (label: string, send: (a: User) => Response | Promise<Response>) =>
    it(`Given ${label}, Then 400 { error: "invalid-body" } and nothing changes`, async () => {
      const a = await mkUser('a');
      const s = mk({ revision: 1 });
      await put(a, s, null);
      const before = await snapshot(a.id);
      const res = await send(a);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-body' });
      expect(await snapshot(a.id)).toEqual(before);
    });

  envelope('PUT with malformed JSON', (a) => call('PUT', '/api/save', a, '{nope'));
  envelope('PUT with a deviceId that is not a uuid', (a) => call('PUT', '/api/save', a, { deviceId: 'dev-1', base: null, save: mk({ revision: 2 }) }));
  envelope('PUT with a malformed base', (a) => call('PUT', '/api/save', a, { deviceId: DEV_A, base: { saveId: 5 }, save: mk({ revision: 2 }) }));
  envelope('PUT with the base key missing', (a) => call('PUT', '/api/save', a, { deviceId: DEV_A, save: mk({ revision: 2 }) }));
  envelope('PUT without a save', (a) => call('PUT', '/api/save', a, { deviceId: DEV_A, base: null }));
  envelope('resolve with keep "both"', (a) => call('POST', '/api/save/resolve', a, { deviceId: DEV_A, keep: 'both', device: mk({ revision: 2 }), base: null, cloud: null }));
  envelope('resolve with malformed JSON', (a) => call('POST', '/api/save/resolve', a, 'garbage'));
  envelope('resolve with a non-uuid deviceId', (a) => call('POST', '/api/save/resolve', a, { deviceId: 'x', keep: 'device', device: mk({ revision: 2 }), base: null, cloud: null }));
  envelope('resolve without the cloud key', (a) => call('POST', '/api/save/resolve', a, { deviceId: DEV_A, keep: 'device', device: mk({ revision: 2 }), base: null }));
  envelope('resolve with a malformed cloud', (a) => call('POST', '/api/save/resolve', a, { deviceId: DEV_A, keep: 'device', device: mk({ revision: 2 }), base: null, cloud: { saveId: 3 } }));
});

// ---- Resolve ----------------------------------------------------------------

describe('POST /api/save/resolve (R22)', () => {
  it('Given an empty cloud, When resolve, Then the device save is stored and returned: 200 { revision, save }', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 5 });
    const res = await resolve(a, 'device', s, null, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 5, save: s });
    expect((await headRow(a.id))?.body).toEqual(s);
  });

  /** Base r5 (tank 12000) -> cloud branch r6 (tank 9000) and a device branch r6 (tank 11000). */
  async function diverged(a: User) {
    const base = mk({ revision: 5, tank: 12_000 });
    await put(a, base, null);
    const cloud = mk({ revision: 6, tank: 9_000 });
    await put(a, cloud, head(base));
    const device = mk({ revision: 6, tank: 11_000 });
    return { base, cloud, device, cloudHead: head(cloud) };
  }

  it('Given a diverged same game, When keep "device", Then the cloud branch tank fall (12000 -> 9000) is subtracted: tank 8000, revision max + 1 = 7, stored as head with a digest row', async () => {
    const a = await mkUser('a');
    const { base, device, cloudHead } = await diverged(a);
    const res = await resolve(a, 'device', device, head(base), cloudHead, DEV_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; save: SaveV1 };
    expect(body.revision).toBe(7);
    expect(body.save.revision).toBe(7);
    expect(body.save.saveId).toBe(SAVE_X);
    expect(body.save.ship.propellant.massKg).toBe(8_000);
    const h = await headRow(a.id);
    expect(h?.revision).toBe(7);
    expect(h?.body).toEqual(body.save);
    const rev = await t.sql<{ digest: unknown }[]>`select digest from save_revisions where user_id = ${a.id} and save_id = ${SAVE_X} and revision = 7`;
    expect(rev).toHaveLength(1);
    expect(rev[0]!.digest).toEqual(shipDigest(body.save));
    expect(await archiveRows(a.id)).toHaveLength(0);
  });

  it('Given a diverged same game, When keep "cloud", Then the cloud save is the chosen one and the device fall (12000 -> 11000) is subtracted: tank 8000, revision 7', async () => {
    const a = await mkUser('a');
    const { base, device, cloudHead } = await diverged(a);
    const res = await resolve(a, 'cloud', device, head(base), cloudHead, DEV_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; save: SaveV1 };
    expect(body.revision).toBe(7);
    expect(body.save.ship.propellant.massKg).toBe(8_000);
    expect((await headRow(a.id))?.revision).toBe(7);
  });

  it('Given a diverged same game and base null, When resolve, Then the unchosen own digest is the base: nothing is subtracted, revision is still max + 1', async () => {
    const a = await mkUser('a');
    const { device, cloudHead } = await diverged(a);
    const res = await resolve(a, 'device', device, null, cloudHead, DEV_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; save: SaveV1 };
    expect(body.revision).toBe(7);
    expect(body.save.ship.propellant.massKg).toBe(11_000);
  });

  it('Given a base that has no save_revisions row, When resolve, Then it behaves like base null (nothing subtracted)', async () => {
    const a = await mkUser('a');
    const { device, cloudHead } = await diverged(a);
    const res = await resolve(a, 'device', device, { saveId: SAVE_X, revision: 2 }, cloudHead, DEV_B);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { save: SaveV1 }).save.ship.propellant.massKg).toBe(11_000);
  });

  it('Given user A has the base digest, When user B (same saveId, own head) resolves with that base, Then A digest is NOT used: nothing subtracted', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const { base } = await diverged(a);
    await put(b, mk({ revision: 6, tank: 9_000 }), null);
    const before = await snapshot(a.id);
    const res = await resolve(b, 'device', mk({ revision: 6, tank: 11_000 }), head(base), { saveId: SAVE_X, revision: 6 }, DEV_B);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { save: SaveV1 }).save.ship.propellant.massKg).toBe(11_000);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given different games and keep "device", Then the cloud head X is archived, the device save Y becomes head and is returned', async () => {
    const a = await mkUser('a');
    const x = mk({ saveId: SAVE_X, revision: 3 });
    await put(a, x, null);
    const y = mk({ saveId: SAVE_Y, revision: 2, tank: 1_000 });
    const res = await resolve(a, 'device', y, head(x), head(x));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 2, save: y });
    expect((await headRow(a.id))?.save_id).toBe(SAVE_Y);
    const arch = await archiveRows(a.id);
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatchObject({ save_id: SAVE_X, revision: 3 });
    expect(arch[0]!.body).toEqual(x);
  });

  it('Given different games and keep "cloud", Then the head is unchanged, nothing is archived, and the response is the head', async () => {
    const a = await mkUser('a');
    const x = mk({ saveId: SAVE_X, revision: 3 });
    await put(a, x, null);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'cloud', mk({ saveId: SAVE_Y, revision: 2 }), head(x), head(x));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 3, save: x });
    expect(await snapshot(a.id)).toEqual(before);
    expect(await archiveRows(a.id)).toHaveLength(0);
  });

  it('Given a successful resolve, When the identical resolve is repeated (response lost), Then 200 with the SAME revision and save, tank NOT subtracted twice (8000), no extra save_revisions row (R26)', async () => {
    const a = await mkUser('a');
    const { base, device, cloudHead } = await diverged(a);
    const r1 = await resolve(a, 'device', device, head(base), cloudHead, DEV_B);
    const b1 = (await r1.json()) as { revision: number; save: SaveV1 };
    const revs = (await snapshot(a.id)).revisions;
    const r2 = await resolve(a, 'device', device, head(base), cloudHead, DEV_B);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { revision: number; save: SaveV1 };
    expect(b1.save.ship.propellant.massKg).toBe(8_000);
    expect(b2.save.ship.propellant.massKg).toBe(8_000);
    expect(b2).toEqual(b1);
    expect((await snapshot(a.id)).revisions).toBe(revs);
    const got = (await (await get(a)).json()) as { revision: number; save: SaveV1 };
    expect(got).toEqual(b1);
  });

  // CHANGED by Ruling R84 (D51b): the key is still on r7's revision row, so the 409 also names it; was
  // toEqual({ cloud: { revision: r1.revision + 1, save: next } }) and the title without "naming the revision it resolved as".
  it('Given a resolved head, When a later forward PUT moves it (key cleared) and the same resolve is repeated, Then 409 with the new head naming the revision it resolved as, and nothing changes', async () => {
    const a = await mkUser('a');
    const { base, device, cloudHead } = await diverged(a);
    const r1 = (await (await resolve(a, 'device', device, head(base), cloudHead, DEV_B)).json()) as { revision: number; save: SaveV1 };
    const next = mk({ revision: r1.revision + 1, tank: 7_000 });
    expect((await put(a, next, head(r1.save))).status).toBe(200);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'device', device, head(base), cloudHead, DEV_B);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ cloud: { revision: r1.revision + 1, save: next }, resolvedAs: { saveId: SAVE_X, revision: r1.revision } });
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given the cloud moved since the client looked, When resolve names the stale cloud head, Then 409 with the current head and nothing changes', async () => {
    const a = await mkUser('a');
    const { base, device } = await diverged(a);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'device', device, head(base), head(base), DEV_B);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { cloud: { revision: number } }).cloud.revision).toBe(6);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given a cloud head, When resolve says it saw NO cloud (cloud null), Then 409 and nothing changes', async () => {
    const a = await mkUser('a');
    const { device } = await diverged(a);
    const before = await snapshot(a.id);
    expect((await resolve(a, 'device', device, null, null, DEV_B)).status).toBe(409);
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given no cloud head but a non-null cloud (deleted meanwhile, R27), When resolve, Then 200 and the device save is stored', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 2 });
    const res = await resolve(a, 'device', s, null, { saveId: SAVE_X, revision: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 2, save: s });
    expect((await headRow(a.id))?.body).toEqual(s);
  });

  it('Given a different-game keep "cloud" (no-op), When repeated after a PUT moved the head, Then 409', async () => {
    const a = await mkUser('a');
    const x = mk({ revision: 3 });
    await put(a, x, null);
    const y = mk({ saveId: SAVE_Y, revision: 1 });
    expect((await resolve(a, 'cloud', y, head(x), head(x))).status).toBe(200);
    const x4 = mk({ revision: 4 });
    expect((await put(a, x4, head(x))).status).toBe(200);
    expect((await resolve(a, 'cloud', y, head(x), head(x))).status).toBe(409);
  });

  it('Given user A resolved, When user B (own head) sends the same resolve body, Then B does not replay A key: B is judged against B own head', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const { base, device, cloudHead } = await diverged(a);
    await resolve(a, 'device', device, head(base), cloudHead, DEV_B);
    await put(b, mk({ revision: 6, tank: 9_000 }), null);
    const bBefore = await headRow(b.id);
    const aBefore = await snapshot(a.id);
    const res = await resolve(b, 'device', device, head(base), cloudHead, DEV_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; save: SaveV1 };
    // B had no digest for the base: nothing subtracted, revision bumped: a fresh resolve, not a replay of A
    expect(body.revision).toBe(7);
    expect(body.save.ship.propellant.massKg).toBe(11_000);
    expect(bBefore?.revision).toBe(6);
    expect(await snapshot(a.id)).toEqual(aBefore);
  });

  it('Given a diverged same game, When two identical resolves race, Then both 200 with the same revision and save (one resolved, one replayed), tank 8000', async () => {
    const a = await mkUser('a');
    const { base, device, cloudHead } = await diverged(a);
    const [r1, r2] = await Promise.all([
      resolve(a, 'device', device, head(base), cloudHead, DEV_B),
      resolve(a, 'device', device, head(base), cloudHead, DEV_B),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const [b1, b2] = [(await r1.json()) as { revision: number; save: SaveV1 }, (await r2.json()) as { revision: number; save: SaveV1 }];
    expect(b1).toEqual(b2);
    expect(b1.revision).toBe(7);
    expect(b1.save.ship.propellant.massKg).toBe(8_000);
    expect((await snapshot(a.id)).revisions).toBe(3);
  });

  it('Given a stored save, When a later PUT stores a new head, Then saves.resolve_key is NULL again (it was `<keep>:<device saveId>:<device rev>:<cloud saveId>:<cloud rev>`)', async () => {
    const a = await mkUser('a');
    const { base, device, cloudHead } = await diverged(a);
    const r1 = (await (await resolve(a, 'device', device, head(base), cloudHead, DEV_B)).json()) as { save: SaveV1 };
    const [row] = await t.sql<{ resolve_key: string | null }[]>`select resolve_key from saves where user_id = ${a.id}`;
    expect(row!.resolve_key).toBe(`device:${SAVE_X}:6:${SAVE_X}:6`);
    await put(a, mk({ revision: 8 }), head(r1.save));
    const [after] = await t.sql<{ resolve_key: string | null }[]>`select resolve_key from saves where user_id = ${a.id}`;
    expect(after!.resolve_key).toBeNull();
  });
});

// ---- Ruling R84 (D51b): a replay is recognised after another device moved on ----
//
//   POST /api/save/resolve -> 409 { cloud: { revision, save }, resolvedAs?: { saveId, revision } }
//   resolvedAs: the revision (of the session user) whose save_revisions row holds the request's resolve key,
//   when the head does not hold it. A key found nowhere: 409 { cloud } exactly as before.

describe('Ruling R84 — POST /api/save/resolve names the revision a replayed resolve became', () => {
  /** As in the R22 block: base r5 (tank 12000) -> cloud branch r6 (tank 9000) and a device branch r6 (tank 11000). */
  async function diverged(a: User) {
    const base = mk({ revision: 5, tank: 12_000 });
    await put(a, base, null);
    const cloud = mk({ revision: 6, tank: 9_000 });
    await put(a, cloud, head(base));
    return { base, device: mk({ revision: 6, tank: 11_000 }), cloudHead: head(cloud) };
  }

  it(
    'Ruling R84 (end to end): Given A resolves r9 vs r8 into r10 (answer lost), B takes r10 and PUTs r11, ' +
      'When A replays the IDENTICAL body, Then 409 { cloud: r11, resolvedAs: r10 }; ' +
      'When A (played on to r11 locally) resolves the new conflict with base = r10, Then the tank is 9000 (one deduction), not 5000 (A\'s r7→r9 spending deducted twice)',
    async () => {
      const a = await mkUser('a');
      // The shared start: r7, tank 12000.
      const r7 = mk({ revision: 7, tank: 12_000 });
      expect((await put(a, r7, null, DEV_A)).status).toBe(200);
      // Device B spends 3000 → r8 (tank 9000).
      const r8 = mk({ revision: 8, tank: 9_000 });
      expect((await put(a, r8, head(r7), DEV_B)).status).toBe(200);
      // Device A spent 1000 from r7 → r9 (tank 11000); its PUT conflicts.
      const aR9 = mk({ revision: 9, tank: 11_000 });
      expect((await put(a, aR9, head(r7), DEV_A)).status).toBe(409);

      // A resolves KEEP THIS: 11000 − (12000 − 9000) = 8000, revision max(9, 8) + 1 = 10. The answer is lost.
      const first = await resolve(a, 'device', aR9, head(r7), head(r8), DEV_A);
      expect(first.status).toBe(200);
      const r10 = ((await first.json()) as { revision: number; save: SaveV1 }).save;
      expect(r10.revision).toBe(10);
      expect(r10.ship.propellant.massKg).toBe(8_000);

      // B takes r10 and spends 500 → r11 (tank 7500).
      expect(((await (await get(a)).json()) as { revision: number }).revision).toBe(10);
      const bR11 = mk({ revision: 11, tank: 7_500 });
      expect((await put(a, bR11, head(r10), DEV_B)).status).toBe(200);

      // A boots and replays the identical body.
      const before = await snapshot(a.id);
      const replay = await resolve(a, 'device', aR9, head(r7), head(r8), DEV_A);
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ cloud: { revision: 11, save: bR11 }, resolvedAs: { saveId: SAVE_X, revision: 10 } });
      expect(await snapshot(a.id)).toEqual(before);

      // Meanwhile A played on from r9: spent 1500 more → r11 (tank 9500). A keeps it, base = resolvedAs r10.
      const aR11 = mk({ revision: 11, tank: 9_500 });
      // The two numbers, from the real rule (src/save/conflict.ts resolveSameGame):
      //   base r10 (8000): 9500 − max(0, 8000 − 7500) = 9000  — B's 500 deducted once, A's 1000 already inside both;
      //   base r7 (12000): 9500 − max(0, 12000 − 7500) = 5000 — A's r7→r9 1000 (inside r10, hence inside B's r11) deducted again.
      // (Neither is the full ledger 12000 − 3000 − 1000 − 500 − 1500 = 6000: keeping A's branch drops the r7→r8 spending
      //  that only r10 carried — the known D45 under-deduction, never a double one.)
      expect(resolveSameGame(aR11, bR11, shipDigest(r10)).ship.propellant.massKg).toBe(9_000);
      expect(resolveSameGame(aR11, bR11, shipDigest(r7)).ship.propellant.massKg).toBe(5_000);

      const second = await resolve(a, 'device', aR11, { saveId: SAVE_X, revision: 10 }, head(bR11), DEV_A);
      expect(second.status).toBe(200);
      const out = (await second.json()) as { revision: number; save: SaveV1 };
      expect(out.revision).toBe(12);
      expect(out.save.ship.propellant.massKg).toBe(9_000);
      expect(out.save.ship.propellant.massKg).not.toBe(5_000);
    },
  );

  it('Ruling R84 (guard): Given a resolve that was never committed (its key is on no row) and a moved cloud, When it arrives, Then 409 with exactly { cloud } — no resolvedAs field at all', async () => {
    const a = await mkUser('a');
    const { base, device } = await diverged(a);
    const res = await resolve(a, 'device', device, head(base), head(base), DEV_B);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['cloud']);
  });

  it("Ruling R84: Given user A's key sits on A's earlier revision row, When user B (whose own rows include the same saveId and revision, without a key) sends the identical body, Then B gets 409 WITHOUT resolvedAs — the lookup is scoped to the session user — and A's rows are untouched", async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const { base, device, cloudHead } = await diverged(a);
    const r1 = (await (await resolve(a, 'device', device, head(base), cloudHead, DEV_B)).json()) as { revision: number; save: SaveV1 };
    expect((await put(a, mk({ revision: r1.revision + 1, tank: 7_000 }), head(r1.save))).status).toBe(200);
    // B: X r5 → r7 → r8 in its own cloud (so B has an (X, 7) row of its own, with no key).
    const b5 = mk({ revision: 5, tank: 12_000 });
    const b7 = mk({ revision: 7, tank: 10_000 });
    expect((await put(b, b5, null)).status).toBe(200);
    expect((await put(b, b7, head(b5))).status).toBe(200);
    expect((await put(b, mk({ revision: 8, tank: 9_500 }), head(b7))).status).toBe(200);
    const aBefore = await snapshot(a.id);
    const bBefore = await snapshot(b.id);

    const res = await resolve(b, 'device', device, head(base), cloudHead, DEV_B);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['cloud']);
    expect(await snapshot(a.id)).toEqual(aBefore);
    expect(await snapshot(b.id)).toEqual(bBefore);
    // …while A itself is told where its resolve went.
    const own = await resolve(a, 'device', device, head(base), cloudHead, DEV_B);
    expect(((await own.json()) as { resolvedAs?: unknown }).resolvedAs).toEqual({ saveId: SAVE_X, revision: r1.revision });
  });
});

// ---- Auth, origin, limits ---------------------------------------------------

describe('Auth, Origin and limits', () => {
  it('Given no session, Then GET, PUT, resolve and DELETE all answer 401 { error: "unauthenticated" }', async () => {
    const s = mk();
    for (const res of [
      await get(null),
      await put(null, s, null),
      await resolve(null, 'device', s, null, null),
      await call('DELETE', '/api/account', null),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    }
  });

  it('Given a valid session but a wrong Origin, Then PUT, POST resolve and DELETE answer 403 and nothing changes', async () => {
    const a = await mkUser('a');
    const evil = { Origin: 'https://evil.example' };
    const s = mk();
    const r1 = await call('PUT', '/api/save', a, { deviceId: DEV_A, base: null, save: s }, evil);
    const r2 = await call('POST', '/api/save/resolve', a, { deviceId: DEV_A, keep: 'device', device: s, base: null, cloud: null }, evil);
    const r3 = await call('DELETE', '/api/account', a, undefined, evil);
    expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403]);
    expect((await snapshot(a.id)).saves).toBe(0);
    expect((await t.sql`select 1 from users where id = ${a.id}`).length).toBe(1);
  });

  it('Given a valid session, When PUT a body over 2 MB, Then 413 and nothing is stored', async () => {
    const a = await mkUser('a');
    const big = JSON.stringify({ deviceId: DEV_A, base: null, save: mk(), pad: 'x'.repeat(2 * 1024 * 1024 + 1024) });
    const res = await call('PUT', '/api/save', a, big);
    expect(res.status).toBe(413);
    expect((await snapshot(a.id)).saves).toBe(0);
  });

  it('Given 30 writes (PUT and resolve mixed) in 60 s, When the 31st (a DELETE) comes, Then 429 and the account still exists; a second user is unaffected', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const s = mk({ revision: 2 });
    for (let i = 0; i < 15; i++) {
      expect((await put(a, s, null)).status).toBe(200);
      // different game + keep "cloud": a no-op write that still spends budget
      expect((await resolve(a, 'cloud', mk({ saveId: SAVE_Y }), head(s), head(s))).status).toBe(200);
    }
    const over = await call('DELETE', '/api/account', a);
    expect(over.status).toBe(429);
    expect((await t.sql`select 1 from users where id = ${a.id}`).length).toBe(1);
    expect((await put(b, s, null)).status).toBe(200);
  });

  it('Given the write budget is spent, Then the 31st PUT is 429 (reads are not budgeted), and after the 60 s window it works again', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 2 });
    for (let i = 0; i < 30; i++) expect((await put(a, s, null)).status).toBe(200);
    const over = await put(a, s, null);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBeTruthy();
    expect((await get(a)).status).toBe(200);
    clock += 61_000;
    expect((await put(a, s, null)).status).toBe(200);
  });
});

// ---- Delete account ---------------------------------------------------------

describe('DELETE /api/account', () => {
  async function rowsFor(userId: string) {
    const n = async (sqlText: string) => (await t.sql.unsafe(sqlText, [userId]))[0]!.n as number;
    return {
      users: await n('select count(*)::int n from users where id = $1'),
      sessions: await n('select count(*)::int n from sessions where user_id = $1'),
      saves: await n('select count(*)::int n from saves where user_id = $1'),
      archive: await n('select count(*)::int n from save_archive where user_id = $1'),
      revisions: await n('select count(*)::int n from save_revisions where user_id = $1'),
      actions: await n('select count(*)::int n from actions where user_id = $1'),
    };
  }

  it('Given an account with head, archive, revisions and actions, When DELETE, Then 204, zero rows in every table, the cookie is cleared and /api/me is 401; another user is untouched', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const x = mk({ saveId: SAVE_X, revision: 2 });
    await put(a, x, null);
    await put(a, mk({ saveId: SAVE_Y, revision: 1 }), head(x));
    await put(b, mk({ revision: 4 }), null);
    expect(await rowsFor(a.id)).toMatchObject({ users: 1, saves: 1, archive: 1 });
    const bBefore = await snapshot(b.id);

    const res = await call('DELETE', '/api/account', a);
    expect(res.status).toBe(204);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toBeDefined();
    expect(cookie!.toLowerCase()).toContain('max-age=0');

    expect(await rowsFor(a.id)).toEqual({ users: 0, sessions: 0, saves: 0, archive: 0, revisions: 0, actions: 0 });
    expect((await call('GET', '/api/me', a)).status).toBe(401);
    expect(await snapshot(b.id)).toEqual(bBefore);
    expect((await get(b)).status).toBe(200);
  });
});

// ---- Isolation --------------------------------------------------------------

describe('Isolation between accounts', () => {
  it('Given A has a save, When B PUTs with base = A head, Then B gets its own head (empty cloud, R21 case 2) and A rows are unchanged', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    const sa = mk({ revision: 5, tank: 12_000 });
    await put(a, sa, null);
    const before = await snapshot(a.id);
    const res = await put(b, mk({ revision: 1, tank: 5 }), head(sa), DEV_B);
    expect(res.status).toBe(200);
    expect(await snapshot(a.id)).toEqual(before);
    expect((await headRow(b.id))?.revision).toBe(1);
  });

  it('Given A and B each have a head, When B PUTs a stale base or resolves keep "device" with a new game, Then only B rows change', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    await put(a, mk({ saveId: SAVE_X, revision: 5 }), null);
    await put(b, mk({ saveId: SAVE_Z, revision: 2 }), null, DEV_B);
    const before = await snapshot(a.id);
    expect((await put(b, mk({ saveId: SAVE_X, revision: 6 }), { saveId: SAVE_X, revision: 5 }, DEV_B)).status).toBe(409);
    expect((await resolve(b, 'device', mk({ saveId: SAVE_Y, revision: 1 }), { saveId: SAVE_Z, revision: 2 }, { saveId: SAVE_Z, revision: 2 }, DEV_B)).status).toBe(200);
    expect(await snapshot(a.id)).toEqual(before);
    expect((await headRow(b.id))?.save_id).toBe(SAVE_Y);
    expect((await archiveRows(b.id))[0]?.save_id).toBe(SAVE_Z);
  });

  it('Given A and B hold the same saveId and revision, When both PUT, Then actions are stored per user', async () => {
    const a = await mkUser('a');
    const b = await mkUser('b');
    await put(a, mk({ revision: 1 }), null);
    await put(b, mk({ revision: 1 }), null);
    expect(await actionCount(a.id)).toBe(ACTIONS_IN_GOLDEN);
    expect(await actionCount(b.id)).toBe(ACTIONS_IN_GOLDEN);
  });
});

// ---- Concurrency ------------------------------------------------------------

describe('Concurrent writes', () => {
  it('Given an empty cloud, When two DIFFERENT first saves are PUT at once with base null, Then exactly one 200 and one 409, and the head is the winner', async () => {
    const a = await mkUser('a');
    const s1 = mk({ revision: 1, tank: 1_000 });
    const s2 = mk({ revision: 1, tank: 2_000 });
    const [r1, r2] = await Promise.all([put(a, s1, null, DEV_A), put(a, s2, null, DEV_B)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? s1 : s2;
    expect((await headRow(a.id))?.body).toEqual(winner);
    const loser = r1.status === 409 ? r1 : r2;
    expect(((await loser.json()) as { cloud: { save: SaveV1 } }).cloud.save).toEqual(winner);
  });

  it('Given head r1, When two DIFFERENT forward PUTs with base = head race, Then exactly one 200 and one 409', async () => {
    const a = await mkUser('a');
    const s1 = mk({ revision: 1 });
    await put(a, s1, null);
    const [r1, r2] = await Promise.all([
      put(a, mk({ revision: 2, tank: 1_000 }), head(s1), DEV_A),
      put(a, mk({ revision: 2, tank: 2_000 }), head(s1), DEV_B),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await headRow(a.id))?.revision).toBe(2);
  });

  it('Given head r1, When two IDENTICAL forward PUTs race, Then both are 200 (one stores, one is idempotent) and actions are not duplicated', async () => {
    const a = await mkUser('a');
    const s1 = mk({ revision: 1 });
    await put(a, s1, null);
    const s2 = mk({ revision: 2, extraActions: 1 });
    const [r1, r2] = await Promise.all([put(a, s2, head(s1), DEV_A), put(a, s2, head(s1), DEV_A)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await actionCount(a.id)).toBe(ACTIONS_IN_GOLDEN + 1);
  });

  it('Given head X, When a new-game PUT and a forward PUT of X race on the same base, Then exactly one wins and the archive holds at most one row', async () => {
    const a = await mkUser('a');
    const x1 = mk({ saveId: SAVE_X, revision: 1 });
    await put(a, x1, null);
    const [r1, r2] = await Promise.all([
      put(a, mk({ saveId: SAVE_Y, revision: 1 }), head(x1), DEV_A),
      put(a, mk({ saveId: SAVE_X, revision: 2 }), head(x1), DEV_B),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await archiveRows(a.id)).length).toBeLessThanOrEqual(1);
  });
});

// ---- Fix round 1 (review of Task 4, R33) -------------------------------------

describe('Revision range (M1)', () => {
  const INT4_MAX = 2_147_483_647;

  it('Given a save at revision 2147483647, When PUT, Then it is accepted; 2147483648 is invalid-save', async () => {
    const a = await mkUser('a');
    expect((await put(a, mk({ revision: INT4_MAX }), null)).status).toBe(200);
    const b = await mkUser('b');
    const res = await put(b, mk({ revision: INT4_MAX + 1 }), null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-save' });
  });

  it('Given a same-game resolve whose max revision is 2147483647 (max + 1 would overflow), When resolve, Then 400 invalid-save and nothing changes (not 500)', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: INT4_MAX, tank: 9_000 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'device', mk({ revision: INT4_MAX - 1, tank: 8_000 }), null, head(s));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-save' });
    expect(await snapshot(a.id)).toEqual(before);
  });

  it('Given a device save at 2147483647 and a lower head, When same-game resolve, Then 400 invalid-save too', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 3 });
    await put(a, s, null);
    const before = await snapshot(a.id);
    const res = await resolve(a, 'device', mk({ revision: INT4_MAX }), null, head(s));
    expect(res.status).toBe(400);
    expect(await snapshot(a.id)).toEqual(before);
  });
});

describe('Unstorable strings (M2)', () => {
  const variants: [string, (s: SaveV1) => void][] = [
    ['NUL in player.system.name', (s) => void (s.player.system.name = 'a\u0000b')],
    ['a lone surrogate in player.system.name', (s) => void (s.player.system.name = '\ud800')],
    ['NUL in a log entry title', (s) => void (s.log.entries[0]!.title = 'x\u0000y')],
    ['a lone surrogate in a log entry body line', (s) => void (s.log.entries[1]!.body = ['ok', 'bad\udc00'])],
    ['NUL in a log entry key', (s) => void (s.log.entries[2]!.key = 'k\u0000')],
  ];
  for (const [label, mutate] of variants) {
    it(`Given ${label}, When PUT, Then 400 invalid-save and nothing changes (not 500)`, async () => {
      const a = await mkUser('a');
      const s1 = mk({ revision: 1 });
      await put(a, s1, null);
      const before = await snapshot(a.id);
      const bad = mk({ revision: 2 });
      mutate(bad);
      const res = await put(a, bad, head(s1));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-save' });
      expect(await snapshot(a.id)).toEqual(before);
    });

    it(`Given ${label}, When resolve, Then 400 invalid-save and nothing changes`, async () => {
      const a = await mkUser('a');
      const s1 = mk({ revision: 1 });
      await put(a, s1, null);
      const before = await snapshot(a.id);
      const bad = mk({ revision: 2 });
      mutate(bad);
      const res = await resolve(a, 'device', bad, head(s1), head(s1));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-save' });
      expect(await snapshot(a.id)).toEqual(before);
    });
  }

  it('Given an ordinary non-ASCII save (valid surrogate pair, accents), When PUT, Then it is accepted', async () => {
    const a = await mkUser('a');
    const s = mk({ revision: 1 });
    s.player.system.name = 'Æther \u{1F680} ø';
    expect((await put(a, s, null)).status).toBe(200);
    expect(((await (await get(a)).json()) as { save: SaveV1 }).save.player.system.name).toBe('Æther \u{1F680} ø');
  });
});

describe('Delete racing a write (M3)', () => {
  it('Given DELETE /api/account and a PUT fired together (several rounds), Then both settle, PUT is 200 or 401, never 500, and no rows remain for the user', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await mkUser(`race-${i}`);
      const [del, wr] = await Promise.all([call('DELETE', '/api/account', a), put(a, mk({ revision: 1 }), null)]);
      expect(del.status).toBe(204);
      expect([200, 401]).toContain(wr.status);
      if (wr.status === 401) expect(await wr.json()).toEqual({ error: 'unauthenticated' });
      for (const table of ['users', 'sessions', 'saves', 'save_archive', 'save_revisions', 'actions']) {
        const col = table === 'users' ? 'id' : 'user_id';
        const rows = await t.sql.unsafe(`select 1 from ${table} where ${col} = $1`, [a.id]);
        expect(rows, table).toHaveLength(0);
      }
    }
  });
});

describe('Resolve base from another game (M5)', () => {
  it('Given a base naming a revision of an ARCHIVED other game (digest row exists), When same-game resolve, Then the base is ignored: nothing subtracted', async () => {
    const a = await mkUser('a');
    const x = mk({ saveId: SAVE_X, revision: 1, tank: 20_000 });
    await put(a, x, null);
    const y1 = mk({ saveId: SAVE_Y, revision: 1, tank: 9_000 });
    expect((await put(a, y1, head(x))).status).toBe(200); // X archived, digest (X,1) tank 20000 kept
    const res = await resolve(a, 'device', mk({ saveId: SAVE_Y, revision: 1, tank: 8_000 }), head(x), head(y1), DEV_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revision: number; save: SaveV1 };
    expect(body.revision).toBe(2);
    expect(body.save.ship.propellant.massKg).toBe(8_000); // 20000 -> 9000 would have driven it to 0
  });
});

describe('Digest history is immutable (M7)', () => {
  it('Given digest (X, 1) exists, When a resolve (different game, keep device) restores X rev 1 with a different tank, Then the ORIGINAL digest row survives', async () => {
    const a = await mkUser('a');
    const x = mk({ saveId: SAVE_X, revision: 1, tank: 20_000 });
    await put(a, x, null);
    const y1 = mk({ saveId: SAVE_Y, revision: 1, tank: 9_000 });
    await put(a, y1, head(x));
    const res = await resolve(a, 'device', mk({ saveId: SAVE_X, revision: 1, tank: 5_000 }), head(y1), head(y1), DEV_B);
    expect(res.status).toBe(200);
    expect((await headRow(a.id))?.body.ship.propellant.massKg).toBe(5_000);
    const [row] = await t.sql<{ digest: { tankKg: number } }[]>`select digest from save_revisions where user_id = ${a.id} and save_id = ${SAVE_X} and revision = 1`;
    expect(row!.digest.tankKg).toBe(20_000);
  });
});
