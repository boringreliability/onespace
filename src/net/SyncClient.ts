/**
 * The client's cloud sync (v4 sub-plan 4, Task 5; rulings R29–R39;
 * DESIGN-4 §5.2–5.4). The local save stays the truth on the device: sync
 * runs after a durable local save, in the background, and never blocks or
 * changes local saving.
 *
 * Boot (`boot`): me(), then (R69) the replay of a pending resolve, then
 * getSave() — one after the other (R66), under ONE 3 s budget; R83: a
 * replay gets its own SYNC_WRITE_TIMEOUT_MS from when it is sent, and the
 * getSave after it a fresh 3 s — then `reconcile`, then that decision's
 * effects — applied before boot resolves, so `decideBoot` reads the save
 * sync chose. A request answering after the boot ended changes nothing
 * (R80). A reader tab never syncs; an unreadable cloud save (format 99,
 * invalid) syncs nothing all session.
 *
 * Replacing the local save (use-cloud, switch-account, a resolved conflict)
 * — R35, in this order:
 *   1. shelve the old (WAL-merged) local with store.keepCorrupt, when the
 *      rule shelves it;
 *   2. wal.reset();
 *   3. store.replaceAll(new | null).
 * A crash after (2) leaves the old stored snapshot, and the next boot
 * reconciles again. The opposite order could apply the old WAL's entries on
 * top of the new save.
 *
 * Push (`onStored`): never works synchronously — it keeps the save and
 * schedules. Only the latest save is pushed, one PUT at a time, at least
 * PUSH_MIN_INTERVAL_MS between PUT starts, base = L. Pushes need an identity
 * confirmed THIS session whose id is the bound account's (R38). Failures:
 * 401 → reauth (no more PUTs); offline/timeout/5xx → backoff 5 s, 15 s,
 * 60 s, then 300 s; 429 (R39) → pending, retry after max(Retry-After, the
 * current step) without advancing it; 409 → conflict (persisted, no more
 * PUTs, the game goes on); other 4xx (400, 413) → stop. R68: after a
 * retryable failure the SAME save is resent before any newer one (the server
 * may have committed it: the resend is `unchanged`), and every PUT is
 * announced first by an in-flight marker in the sync state.
 *
 * Resolve (R69): the exact body is persisted before the POST, retried once
 * at once on a retryable failure, and — still unanswered — replayed
 * verbatim at the next boot. Never decided a second time.
 */

import * as z from 'zod';

import { sameGame } from '@/save/conflict';
import { migrate } from '@/save/migrate';
import type { Save } from '@/save/schema';
import { STORE_TIMEOUT_MS, rawKey, withTimeout, type SaveStore } from '@/save/store';
import type { Wal } from '@/save/wal';

import { ConflictBodySchema, SYNC_TIMEOUT_MS, SYNC_WRITE_TIMEOUT_MS, type Api, type ApiResult, type ResolveBody } from './api';
import { reconcile, type Decision } from './reconcile';
import {
  SYNC_STATE_KEY,
  readSyncState,
  writeSyncState,
  type CloudHead,
  type InFlightPut,
  type StorageLike,
  type SyncState,
} from './syncState';

export const PUSH_MIN_INTERVAL_MS = 5_000;
/** Backoff after a failed push; the last step repeats. */
export const PUSH_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];

export const SYNC_OFFLINE_TEXT = 'OFFLINE — SAVED LOCALLY';
export const SYNC_REAUTH_TEXT = 'SIGN IN AGAIN TO SYNC';
export const SYNC_CONFLICT_TEXT = 'SYNC CONFLICT — CHOOSE ON NEXT START';
/** R47: the cloud holds a save this build cannot read; sync stays off this session. */
export const SYNC_UNREADABLE_TEXT = 'CLOUD SAVE UNREADABLE — SYNC OFF';

export type SyncStatus = 'off' | 'synced' | 'pending' | 'offline' | 'reauth' | 'conflict';

export type BootDecision = Decision | { kind: 'local-only'; reason: 'reader' | 'offline' | 'timeout' | 'unreadable' };

export interface BootSync {
  decision: BootDecision;
  cloud: Save | null;
  notice: string | null;
}

export type ResolveResult =
  | { ok: true; save: Save }
  | { ok: false; reason: 'offline' | 'reauth' | 'moved'; cloud?: Save };

export interface SyncClientDeps {
  readonly api: Api;
  /** Where the sync state lives (localStorage); null where there is none. */
  readonly storage: StorageLike | null;
  readonly isWriter: () => boolean;
  /** A timer: run `fn` after `ms`; returns its cancel. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
  readonly store: SaveStore;
  readonly wal: Wal;
  readonly uuid: () => string;
}

const MeSchema = z.object({ id: z.string().min(1), name: z.string() });
const CloudBodySchema = z.object({ revision: z.number().int().min(0), save: z.unknown() });
const PutOkSchema = z.object({ revision: z.number().int().min(0) });
const NoSaveSchema = z.object({ error: z.literal('no-save') });

type Me = z.infer<typeof MeSchema>;

const head = (s: Save): CloudHead => ({ saveId: s.saveId, revision: s.revision });

/** The save inside a `{revision, save}` body, migrated; null when unreadable. */
function cloudSave(body: unknown): { save: Save; revision: number } | null {
  const b = CloudBodySchema.safeParse(body);
  if (!b.success) return null;
  const m = migrate(b.data.save);
  return m.ok ? { save: m.save, revision: b.data.revision } : null;
}

const isTimeout = (r: ApiResult): boolean => !r.ok && r.status === 'timeout';
const retryable = (status: number | 'offline' | 'timeout'): boolean =>
  status === 'offline' || status === 'timeout' || status === 408 || (typeof status === 'number' && status >= 500);
/** A resolve that may not have reached the server, or may come back later: the body is kept (R69). */
const resolveRetryable = (status: number | 'offline' | 'timeout'): boolean => retryable(status) || status === 429;

/** The sync state without the named optional fields (cleared = absent). */
function without(s: SyncState, ...keys: ('inFlightPut' | 'pendingResolve' | 'pendingResolveFor' | 'unmergedCloud')[]): SyncState {
  const out = { ...s };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * R68(b): a cheap deterministic hash of a save's content key (rawKey) —
 * cyrb53, 53 bits as hex. Not cryptographic: it only tells this device's own
 * PUT from another body at the same saveId + revision.
 */
export function saveFingerprint(save: Save): string {
  const key = rawKey(save) ?? '';
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * R75: `local` holds progress the resolved device save does not — another
 * game, a higher revision, or other content (WAL entries) at its revision.
 * A resolve result must then never overwrite it.
 */
function advancedPast(local: Save | null, device: Save, dirty: boolean): boolean {
  if (local === null || local === device) return false;
  if (local.saveId !== device.saveId || local.revision > device.revision) return true;
  return local.revision === device.revision && (dirty || rawKey(local) !== rawKey(lifted(device)));
}

/**
 * A pending resolve's device body is stored verbatim (R69) and may have been
 * written by an older build in an older save format; `local` and the result
 * have been through `migrate`. Content is compared on the lifted body — the
 * body that is re-sent stays verbatim. A body `migrate` refuses is compared
 * raw, as before (it then never matches a migrated save: counts as advanced).
 */
function lifted(device: Save): Save {
  const m = migrate(device);
  return m.ok ? m.save : device;
}

/** What the boot's replay of a pending resolve got (R69), when it answered within the budget. */
interface Replay {
  body: ResolveBody;
  res: ApiResult;
}

export class SyncClient {
  private readonly d: SyncClientDeps;
  private state: SyncState;
  private st: SyncStatus = 'off';

  /** The identity confirmed this session (R38); null = not (yet) confirmed. */
  private me: Me | null = null;
  /** Pushing is allowed this session (signed in, bound to me, nothing stopped it). */
  private pushing = false;
  /** R38: after an offline boot, me() must confirm the bound account before any PUT. */
  private needsIdentity = false;
  /** The latest save the game stored (or the boot's local): what is pushed, and what resolve sends. */
  private latest: Save | null = null;
  /** A save waiting to be pushed. */
  private queued: Save | null = null;
  /** R68(a): a save whose PUT failed retryably — the server may hold it — resent before `queued`. */
  private unacked: Save | null = null;
  /** R36: a WAL-merged local at L's revision is not pushed; wait for a save above this revision. */
  private holdAtOrBelow: number | null = null;
  private inFlight = false;
  private cancelTimer: (() => void) | null = null;
  /** The pending timer is a backoff retry (a new save does not cut it short). */
  private backingOff = false;
  private lastPutStart: number | null = null;
  private step = 0;
  /** The cloud head seen at boot (or in a 409): what resolve says it saw. */
  private cloudHead: CloudHead | null = null;
  /** R71: the cloud save behind cloudHead — shelved when the player keeps the device's save. */
  private cloudSnapshot: Save | null = null;
  /**
   * R74/R78: the sync state lives in storage that works (it was read from it,
   * or a write succeeded). Only then does a pending resolve that cannot be
   * recorded block the POST; in memory mode resolve goes on unrecorded.
   */
  private persistent = false;
  private reportedFatal = false;
  /**
   * R60: bumped when pushing halts for good (sign-out, deleted account). A
   * request already in flight then answers into a session that has moved
   * on: it must not touch status or the persisted state.
   */
  private epoch = 0;

  constructor(deps: SyncClientDeps) {
    this.d = deps;
    this.state = readSyncState(deps.storage, deps.uuid);
    try {
      this.persistent = deps.storage !== null && deps.storage.getItem(SYNC_STATE_KEY) !== null;
    } catch {
      this.persistent = false;
    }
  }

  status(): SyncStatus {
    return this.st;
  }

  /** R51: the identity confirmed THIS session (the boot's me); null when not confirmed. */
  identity(): { id: string; name: string } | null {
    return this.me ? { id: this.me.id, name: this.me.name } : null;
  }

  statusText(): string | null {
    switch (this.st) {
      case 'offline':
        return SYNC_OFFLINE_TEXT;
      case 'reauth':
        return SYNC_REAUTH_TEXT;
      case 'conflict':
        return SYNC_CONFLICT_TEXT;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Boot

  async boot(local: Save | null, opts: { localDirty?: boolean } = {}): Promise<BootSync> {
    this.latest = local;
    const localOnly = (reason: 'reader' | 'offline' | 'timeout' | 'unreadable'): BootSync => ({
      decision: { kind: 'local-only', reason },
      cloud: null,
      notice: null,
    });

    if (!this.d.isWriter()) {
      this.st = 'off';
      return localOnly('reader');
    }

    // One 3 s budget for every call (R30). R66: the save is asked for only
    // once me() says who is signed in — a guest boot makes exactly one
    // request. R69: a pending resolve is replayed before the save is read.
    // R83: the replay gets its own SYNC_WRITE_TIMEOUT_MS from when it is
    // sent, and the getSave after it a fresh SYNC_TIMEOUT_MS; a boot without
    // a replay keeps the one 3 s budget. The calls only fetch: every effect
    // happens below, after the race, so a call answering after the boot
    // ended changes nothing (R80).
    let bootOver = false;
    let endBoot: (v: 'timeout') => void = () => undefined;
    const budget = new Promise<'timeout'>((resolve) => {
      endBoot = resolve;
    });
    const arm = (ms: number): (() => void) =>
      this.d.schedule(() => {
        bootOver = true; // at once: no call is sent after the end, even before the race settles
        endBoot('timeout');
      }, ms);
    let cancelBudget = arm(SYNC_TIMEOUT_MS);
    const rearm = (ms: number): void => {
      cancelBudget();
      cancelBudget = arm(ms);
    };
    const seen: { me: ApiResult | null; replay: Replay | null } = { me: null, replay: null };
    const calls = (async (): Promise<[ApiResult, ApiResult | null, Replay | null]> => {
      const m = await this.d.api.me();
      seen.me = m;
      const who = m.ok ? MeSchema.safeParse(m.body) : null;
      if (bootOver || !who?.success) return [m, null, null];
      let replay: Replay | null = null;
      const pending = this.replayable(who.data);
      if (pending) {
        rearm(SYNC_WRITE_TIMEOUT_MS);
        const res = await this.d.api.resolve(pending);
        if (bootOver) return [m, null, null];
        replay = { body: pending, res };
        seen.replay = replay;
        // Unanswered: the body stays pending; boot goes on local (the conflict holds, R46).
        if (!replay.res.ok && resolveRetryable(replay.res.status)) return [m, null, replay];
        rearm(SYNC_TIMEOUT_MS);
      }
      return [m, await this.d.api.getSave(), replay];
    })();
    const answered = await Promise.race([calls, budget]);
    cancelBudget();
    bootOver = true;

    if (answered === 'timeout') {
      // me() may still have answered in time — and R83: a replay that answered in time is
      // applied even when the getSave after it did not.
      const who = seen.me?.ok ? MeSchema.safeParse(seen.me.body) : null;
      if (who?.success && seen.replay) {
        const r = await this.applyReplay(seen.replay, local, who.data, opts.localDirty === true);
        if (typeof r === 'object' && r !== null) this.latest = r;
      }
      this.afterOffline(seen.me);
      return localOnly('timeout');
    }
    const [meRes, saveRes, replay] = answered;

    if (!meRes.ok && meRes.status === 401) {
      this.pushing = false;
      this.st = this.state.accountId !== null ? 'reauth' : 'off';
      return { decision: { kind: 'guest' }, cloud: null, notice: null };
    }
    const me = meRes.ok ? MeSchema.safeParse(meRes.body) : null;
    let dirty = opts.localDirty === true;
    /** R85: the replay was committed before another device moved on, and the local save holds nothing past it. */
    let takeCloud = false;
    // R69: the replay answered within the budget — its effect first, whatever getSave got.
    if (me?.success && replay) {
      const r = await this.applyReplay(replay, local, me.data, dirty);
      if (r === 'unanswered') {
        this.afterOffline(meRes);
        return localOnly(isTimeout(replay.res) ? 'timeout' : 'offline');
      }
      if (r === 'take-cloud') takeCloud = true;
      else if (r !== 'kept') {
        // The result replaced the local save (the WAL was reset with it).
        local = r;
        this.latest = r;
        dirty = false;
      }
    }
    if (isTimeout(meRes) || (saveRes !== null && isTimeout(saveRes))) {
      this.afterOffline(meRes);
      return localOnly('timeout');
    }
    if (!me?.success || saveRes === null) {
      this.afterOffline(meRes);
      return localOnly('offline');
    }
    const emptyCloud = !saveRes.ok && saveRes.status === 404 && NoSaveSchema.safeParse(saveRes.body).success;
    if (!saveRes.ok && !emptyCloud) {
      this.afterOffline(meRes);
      return localOnly('offline');
    }

    let cloud: Save | null = null;
    if (!emptyCloud) {
      const c = cloudSave(saveRes.ok ? saveRes.body : null);
      if (!c) {
        // Review Focus 4: an unreadable cloud is no cloud, and nothing is pushed over it.
        // The identity itself was confirmed (R51): the menus show it.
        this.me = me.data;
        this.pushing = false;
        this.st = 'off';
        return { ...localOnly('unreadable'), notice: SYNC_UNREADABLE_TEXT };
      }
      cloud = c.save;
      this.cloudHead = { saveId: c.save.saveId, revision: c.revision };
      this.cloudSnapshot = c.save;
      this.trustOwnPut(me.data, c.save, c.revision);
    }

    this.me = me.data;
    const localKey = local !== null ? rawKey(local) : null;
    const sameContent = localKey !== null && cloud !== null && localKey === rawKey(cloud);
    // R85: the player's choice is already inside the cloud — take it; the local save is shelved
    // as a save replaced by a resolve result is.
    const shelveLocal = takeCloud && cloud !== null && !sameContent;
    const decision: Decision = shelveLocal
      ? { kind: 'use-cloud' }
      : reconcile({
          local,
          cloud,
          state: this.state,
          me: me.data,
          localDirty: dirty,
          sameContent,
        });
    try {
      return await this.apply(decision, local, cloud, me.data, dirty, shelveLocal);
    } catch {
      // A store that failed the replacement keeps the old local save (one transaction).
      this.pushing = false;
      this.st = 'offline';
      return localOnly('offline');
    }
  }

  /** R69/R48: the pending resolve body, when it was sent as `me` and the save is not bound to another account. */
  private replayable(me: Me): ResolveBody | null {
    const p = this.state.pendingResolve;
    if (!p) return null;
    if (this.state.accountId !== null && this.state.accountId !== me.id) return null;
    return (this.state.pendingResolveFor ?? this.state.accountId) === me.id ? p : null;
  }

  /**
   * R69/R75: the boot's replay answered in time. Returns the result save when
   * it replaced the local save, 'kept' when the local save stays (refused, or
   * R75: the local save advanced past the replayed device save),
   * 'unanswered' when the body stays pending, or (R85) 'take-cloud' when the
   * server says the body was committed as `resolvedAs` and the cloud has
   * moved on since, with the local save not advanced past the device save.
   */
  private async applyReplay(
    replay: Replay,
    local: Save | null,
    me: Me,
    dirty: boolean,
  ): Promise<Save | 'kept' | 'unanswered' | 'take-cloud'> {
    const { body, res } = replay;
    if (!res.ok) {
      if (resolveRetryable(res.status)) return 'unanswered';
      // R85: committed as `resolvedAs`, then another device moved the cloud on. L = resolvedAs
      // (the merge base of any next choice: nothing is deducted twice).
      const resolvedAs = res.status === 409 ? ConflictBodySchema.safeParse(res.body).data?.resolvedAs : undefined;
      if (resolvedAs) {
        if (advancedPast(local, body.device, dirty)) {
          // The local save holds progress past the choice: a conflict, kept across reboots (R79).
          this.keepUnmerged(resolvedAs);
          return 'kept';
        }
        this.state = { ...without(this.state, 'pendingResolve', 'pendingResolveFor'), lastSeenCloud: resolvedAs };
        this.persist();
        return 'take-cloud';
      }
      // A definitive refusal (409, 400, …): nothing was committed — the boot decides afresh.
      this.state = without(this.state, 'pendingResolve', 'pendingResolveFor');
      this.persist();
      return 'kept';
    }
    const result = cloudSave(res.body);
    // Committed but unreadable: keep the body; the next boot replays it (the server answers it again).
    if (!result) return 'unanswered';
    const resultHead = { saveId: result.save.saveId, revision: result.revision };
    if (advancedPast(local, body.device, dirty)) {
      this.keepUnmerged(resultHead);
      return 'kept';
    }
    // Applied exactly as a normal resolve.
    try {
      await this.replaceLocal([local && rawKey(local) !== rawKey(result.save) ? local : null], result.save);
    } catch {
      return 'unanswered'; // committed but not applied: the next boot replays it again
    }
    this.state = {
      ...without(this.state, 'pendingResolve', 'pendingResolveFor', 'unmergedCloud'),
      accountId: me.id,
      accountName: me.name,
      lastSeenCloud: resultHead,
      conflict: false,
    };
    this.persist();
    return result.save;
  }

  /**
   * R75: a committed resolve result that is not applied because the local
   * save advanced past the resolved device save. L = the result head (the
   * merge base of the next choice, so nothing is deducted twice), and the
   * conflict stays a choice across reboots (R79).
   */
  private keepUnmerged(resultHead: CloudHead): void {
    this.state = {
      ...without(this.state, 'pendingResolve', 'pendingResolveFor'),
      lastSeenCloud: resultHead,
      unmergedCloud: resultHead,
      conflict: true,
    };
    this.persist();
  }

  /**
   * R68(b): the cloud head is exactly the save this device's unacknowledged
   * PUT sent (saveId, revision AND content) — the server committed it, so it
   * is last-seen-cloud, not a conflict.
   */
  private trustOwnPut(me: Me, cloud: Save, revision: number): void {
    const m = this.state.inFlightPut;
    if (!m || this.state.accountId !== me.id) return;
    if (m.saveId !== cloud.saveId || m.revision !== revision || m.fingerprint !== saveFingerprint(cloud)) return;
    this.state = { ...without(this.state, 'inFlightPut'), lastSeenCloud: { saveId: cloud.saveId, revision } };
    this.persist();
  }

  /** An offline/timed-out boot: pushes wait for an identity check (R38), if the save is bound at all. */
  private afterOffline(meRes: ApiResult | null): void {
    this.st = 'offline';
    const me = meRes && meRes.ok ? MeSchema.safeParse(meRes.body) : null;
    if (me?.success) this.me = me.data;
    // R46: a conflict chosen nowhere yet holds until a boot reaches the cloud.
    if (this.state.conflict) {
      this.pushing = false;
      this.st = 'conflict';
      return;
    }
    if (this.state.accountId === null) {
      this.pushing = false;
      return;
    }
    if (me?.success) {
      this.needsIdentity = false;
      this.pushing = me.data.id === this.state.accountId;
      // R44: a confirmed other account is not "offline" — sync is off for it.
      if (!this.pushing) this.st = 'off';
      return;
    }
    this.pushing = true;
    this.needsIdentity = true;
  }

  private async apply(
    decision: Decision,
    local: Save | null,
    cloud: Save | null,
    me: Me,
    dirty: boolean,
    shelveLocal = false,
  ): Promise<BootSync> {
    const out = (notice: string | null = null): BootSync => ({ decision, cloud, notice });
    // R79: once device and cloud agree again, nothing is left unmerged.
    const bind = (L: CloudHead | null): void => {
      this.state = { ...without(this.state, 'unmergedCloud'), accountId: me.id, accountName: me.name, lastSeenCloud: L };
    };

    switch (decision.kind) {
      case 'guest':
        this.st = 'off';
        return out();

      case 'refuse-switch':
        await this.d.api.logout();
        this.me = null;
        this.pushing = false;
        this.st = 'off';
        return out(decision.message);

      case 'conflict-same':
      case 'conflict-different':
        this.state = { ...this.state, conflict: true };
        this.persist();
        this.pushing = false;
        this.st = 'conflict';
        return out();

      case 'use-cloud': {
        const c = cloud!;
        await this.replaceLocal([local && (shelveLocal || local.saveId !== c.saveId) ? local : null], c);
        bind(head(c));
        this.state.conflict = false;
        this.persist();
        this.latest = c;
        this.pushing = true;
        this.st = 'synced';
        return out();
      }

      case 'switch-account':
        // A's save is in A's cloud (synced); B never adopts it.
        await this.replaceLocal([local], cloud);
        this.state = {
          deviceId: this.state.deviceId,
          accountId: me.id,
          accountName: me.name,
          lastSeenCloud: cloud ? head(cloud) : null,
          conflict: false,
        };
        this.persist();
        this.latest = cloud;
        this.pushing = true;
        this.st = 'synced';
        return out();

      case 'in-sync':
        // R43: (re-)bound to the confirmed me, L = the cloud's head (or the next PUT would 409);
        // R46: a boot that reached the cloud clears a stale conflict flag.
        bind(cloud ? head(cloud) : this.state.accountId === me.id ? this.state.lastSeenCloud : null);
        this.state.conflict = false;
        this.persist();
        this.pushing = true;
        this.st = 'synced';
        return out();

      case 'adopt':
        bind(null);
        this.state.conflict = false;
        this.persist();
        this.pushing = true;
        this.enqueue(local!);
        return out();

      case 'push-local': {
        if (this.state.conflict || this.state.unmergedCloud) {
          this.state = { ...without(this.state, 'unmergedCloud'), conflict: false };
          this.persist();
        }
        this.pushing = true;
        const L = this.state.lastSeenCloud;
        const l = local!;
        if (dirty && L && l.saveId === L.saveId && l.revision <= L.revision) {
          // R36: the server holds this revision with another body; push the next save instead.
          this.holdAtOrBelow = l.revision;
          this.st = 'pending';
          return out();
        }
        this.enqueue(l);
        return out();
      }
    }
  }

  /** R35: shelve (each one given, in order), reset the WAL, replace the store's save. */
  private async replaceLocal(shelve: ReadonlyArray<Save | null>, next: Save | null): Promise<void> {
    for (const s of shelve) {
      if (s) await withTimeout(() => this.d.store.keepCorrupt(s, Date.now()), STORE_TIMEOUT_MS);
    }
    this.d.wal.reset();
    await withTimeout(() => this.d.store.replaceAll(next), STORE_TIMEOUT_MS);
  }

  /** Writes the sync state; false when it could not be written. */
  private persist(): boolean {
    const ok = writeSyncState(this.d.storage, this.state);
    if (ok) this.persistent = true;
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Push

  onStored(save: Save): void {
    this.latest = save;
    if (!this.pushing) return;
    if (this.holdAtOrBelow !== null) {
      if (save.saveId === this.state.lastSeenCloud?.saveId && save.revision <= this.holdAtOrBelow) return;
      this.holdAtOrBelow = null;
    }
    this.enqueue(save);
  }

  private enqueue(save: Save): void {
    this.queued = save;
    if (!this.backingOff) this.st = 'pending';
    this.kick();
  }

  /** Schedule the next push attempt, if none is scheduled or running. */
  private kick(): void {
    if (this.cancelTimer || this.inFlight || !(this.unacked ?? this.queued) || !this.pushing) return;
    const wait = this.lastPutStart === null ? 0 : Math.max(0, this.lastPutStart + PUSH_MIN_INTERVAL_MS - Date.now());
    this.arm(wait, false);
  }

  private arm(ms: number, backoff: boolean): void {
    this.backingOff = backoff;
    this.cancelTimer = this.d.schedule(() => {
      this.cancelTimer = null;
      this.backingOff = false;
      void this.pump();
    }, ms);
  }

  private stop(status: SyncStatus): void {
    this.pushing = false;
    this.queued = null;
    this.unacked = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.backingOff = false;
    this.st = status;
  }

  /** A retryable failure: wait the current step, advance it (what is sent next is unacked ?? queued). */
  private backoff(): void {
    this.st = 'offline';
    const ms = PUSH_BACKOFF_MS[Math.min(this.step, PUSH_BACKOFF_MS.length - 1)]!;
    this.step++;
    this.arm(ms, true);
  }

  private async pump(): Promise<void> {
    if (!(this.unacked ?? this.queued) || !this.pushing || this.inFlight) return;
    this.inFlight = true;
    const epoch = this.epoch;
    try {
      if (this.needsIdentity) {
        const r = await this.d.api.me();
        if (epoch !== this.epoch) return; // R60: signed out / deleted meanwhile
        if (!r.ok) {
          if (r.status === 401) return this.stop('reauth');
          return this.backoff();
        }
        const me = MeSchema.safeParse(r.body);
        if (!me.success) return this.backoff();
        if (me.data.id !== this.state.accountId) return this.stop('off'); // never push A's save with B's cookie
        this.me = me.data;
        this.needsIdentity = false;
      }

      // R68(a): a save the server may already hold is resent first — then it is `unchanged`, L
      // advances, and the newer save follows with the right base (never a false 409).
      // R40: otherwise the newest save queued NOW — a save stored during the identity check included.
      const save = this.unacked ?? this.queued;
      if (!save) return;
      if (save !== this.unacked) this.queued = null;
      this.lastPutStart = Date.now();
      this.st = 'pending';
      const base = this.state.lastSeenCloud;
      // R68(b): announce the PUT before it leaves. R74: a failed write never blocks the PUT.
      const marker: InFlightPut = { saveId: save.saveId, revision: save.revision, fingerprint: saveFingerprint(save) };
      this.state = { ...this.state, inFlightPut: marker };
      this.persist();
      const r = await this.d.api.putSave({ deviceId: this.state.deviceId, base, save });
      if (epoch !== this.epoch) return; // R60: signed out / deleted meanwhile

      if (r.ok) {
        const body = PutOkSchema.safeParse(r.body);
        this.unacked = null;
        this.state = {
          ...without(this.state, 'inFlightPut'),
          lastSeenCloud: { saveId: save.saveId, revision: body.success ? body.data.revision : save.revision },
        };
        this.persist();
        this.step = 0;
        this.st = this.queued ? 'pending' : 'synced';
        return;
      }
      if (r.status === 401) return this.stop('reauth');
      if (r.status === 409) {
        this.state = { ...this.state, conflict: true };
        this.persist();
        const c = ConflictBodySchema.safeParse(r.body);
        if (c.success) {
          const cs = cloudSave(c.data.cloud);
          if (cs) {
            this.cloudHead = { saveId: cs.save.saveId, revision: cs.revision };
            this.cloudSnapshot = cs.save;
          }
        }
        return this.stop('conflict');
      }
      if (r.status === 429) {
        // R39: rate limited — pending, the step is not advanced. R68(a): this save is resent first.
        this.unacked = save;
        const ra = typeof r.retryAfterS === 'number' ? r.retryAfterS * 1000 : 0;
        const ms = Math.max(ra, PUSH_BACKOFF_MS[Math.min(this.step, PUSH_BACKOFF_MS.length - 1)]!);
        this.st = 'pending';
        return this.arm(ms, true);
      }
      if (retryable(r.status)) {
        this.unacked = save; // R68(a): it may have been committed — resend it before anything newer
        return this.backoff();
      }
      // 400, 413, …: this save will never be accepted; stop for the session.
      if (!this.reportedFatal) {
        this.reportedFatal = true;
        console.error(`cloud sync stopped: the server refused the save (${String(r.status)})`);
      }
      return this.stop('off');
    } finally {
      this.inFlight = false;
      this.kick();
    }
  }

  // ---------------------------------------------------------------------------
  // Account (Task 6; R53, R54, R56)

  /** Stop pushing for the session: nothing queued, no timer. */
  private halt(): void {
    this.epoch++;
    this.pushing = false;
    this.needsIdentity = false;
    this.queued = null;
    this.unacked = null;
    this.holdAtOrBelow = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.backingOff = false;
  }

  /**
   * R53/R56: sign out. The server forgets the session; the local save and
   * the binding stay as they are (the next sign-in as the same account
   * syncs on). A voluntary sign-out is not a reauth: status 'off'.
   */
  async signOut(): Promise<boolean> {
    const r = await this.d.api.logout();
    if (!r.ok) return false;
    this.me = null;
    this.halt();
    this.st = 'off';
    return true;
  }

  /**
   * R54: delete the account (server: user, saves, sessions). The device's
   * sync state starts over with the same deviceId; the local save is kept.
   */
  async deleteAccount(): Promise<boolean> {
    if (!this.me) return false;
    const r = await this.d.api.deleteAccount();
    if (!r.ok) return false;
    this.me = null;
    this.halt();
    this.state = { deviceId: this.state.deviceId, accountId: null, accountName: null, lastSeenCloud: null, conflict: false };
    this.persist();
    this.cloudHead = null;
    this.cloudSnapshot = null;
    this.st = 'off';
    return true;
  }

  // ---------------------------------------------------------------------------
  // Resolve

  async resolve(keep: 'device' | 'cloud'): Promise<ResolveResult> {
    // R48: only for an identity confirmed this session — and, when bound, the bound account's.
    const me = this.me;
    if (!me || (this.state.accountId !== null && me.id !== this.state.accountId)) return { ok: false, reason: 'reauth' };

    // R69: a body sent before and never answered is sent again verbatim — never decided anew
    // (the server may have committed it).
    let body = this.state.pendingResolveFor === me.id ? (this.state.pendingResolve ?? null) : null;
    if (!body) {
      const device = this.latest;
      if (!device) return { ok: false, reason: 'offline' };
      body = { deviceId: this.state.deviceId, keep, device, base: this.state.lastSeenCloud, cloud: this.cloudHead };
      this.state = { ...this.state, pendingResolve: body, pendingResolveFor: me.id };
      // R74/R78: a body that cannot be recorded on storage in use is not sent (a lost answer
      // could not be replayed). In memory mode it is sent unrecorded.
      if (!this.persist() && this.persistent) {
        this.state = without(this.state, 'pendingResolve', 'pendingResolveFor');
        return { ok: false, reason: 'offline' };
      }
    }

    let r = await this.d.api.resolve(body);
    if (!r.ok && resolveRetryable(r.status)) r = await this.d.api.resolve(body); // once, at once

    if (!r.ok) {
      if (resolveRetryable(r.status)) return { ok: false, reason: 'offline' }; // the body stays pending
      // A definitive answer: nothing was committed; the next choice is a new one.
      // R86: unless a 409 names the revision this body was committed as (another device moved on
      // since): that is the base of the next choice, so nothing is deducted twice.
      const resolvedAs = r.status === 409 ? ConflictBodySchema.safeParse(r.body).data?.resolvedAs : undefined;
      this.state = without(this.state, 'pendingResolve', 'pendingResolveFor');
      if (resolvedAs) this.state.lastSeenCloud = resolvedAs;
      this.persist();
      if (r.status === 401) {
        this.st = 'reauth';
        return { ok: false, reason: 'reauth' };
      }
      if (r.status === 409) {
        const c = ConflictBodySchema.safeParse(r.body);
        const cs = c.success ? cloudSave(c.data.cloud) : null;
        if (cs) {
          this.cloudHead = { saveId: cs.save.saveId, revision: cs.revision };
          this.cloudSnapshot = cs.save;
          this.st = 'conflict';
          return { ok: false, reason: 'moved', cloud: cs.save };
        }
        return { ok: false, reason: 'moved' };
      }
      return { ok: false, reason: 'offline' };
    }

    // Committed. Until it is applied the body stays pending: the next boot replays it.
    const result = cloudSave(r.body);
    if (!result) return { ok: false, reason: 'offline' };
    const save = result.save;
    const device = body.device;
    if (advancedPast(this.latest, device, false)) {
      // R75 in session: a re-sent body whose device save the game has since moved past — the
      // result is the cloud's new head, to be chosen against like any moved cloud.
      this.keepUnmerged({ saveId: save.saveId, revision: result.revision });
      this.cloudHead = { saveId: save.saveId, revision: result.revision };
      this.cloudSnapshot = save;
      this.st = 'conflict';
      return { ok: false, reason: 'moved', cloud: save };
    }
    // R71 (§5.3): the unchosen snapshot is always shelved — on KEEP THIS, the cloud save the
    // choice overruled (the one body.cloud names), before the local save changes.
    const snap = this.cloudSnapshot;
    const overruled =
      body.keep === 'device' &&
      snap !== null &&
      body.cloud !== null &&
      this.cloudHead !== null &&
      this.cloudHead.saveId === body.cloud.saveId &&
      this.cloudHead.revision === body.cloud.revision &&
      sameGame(snap, device) &&
      rawKey(snap) !== rawKey(save)
        ? snap
        : null;
    try {
      await this.replaceLocal([overruled, rawKey(save) === rawKey(lifted(device)) ? null : device], save);
    } catch {
      return { ok: false, reason: 'offline' };
    }
    this.state = {
      ...without(this.state, 'pendingResolve', 'pendingResolveFor', 'unmergedCloud'),
      accountId: me.id,
      accountName: me.name,
      lastSeenCloud: { saveId: save.saveId, revision: result.revision },
      conflict: false,
    };
    this.persist();
    this.cloudHead = { saveId: save.saveId, revision: result.revision };
    this.cloudSnapshot = save;
    this.latest = save;
    this.pushing = true;
    this.needsIdentity = false;
    this.st = 'synced';
    return { ok: true, save };
  }
}
