/**
 * The client's cloud sync (v4 sub-plan 4, Task 5; rulings R29–R39;
 * DESIGN-4 §5.2–5.4). The local save stays the truth on the device: sync
 * runs after a durable local save, in the background, and never blocks or
 * changes local saving.
 *
 * Boot (`boot`): me() and getSave() in parallel under ONE 3 s budget, then
 * `reconcile`, then that decision's effects — applied before boot resolves,
 * so `decideBoot` reads the save sync chose. A reader tab never syncs; an
 * unreadable cloud save (format 99, invalid) syncs nothing all session.
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
 * 60 s, then 300 s, retrying the latest; 429 (R39) → pending, retry after
 * max(Retry-After, the current step) without advancing it; 409 → conflict
 * (persisted, no more PUTs, the game goes on); other 4xx (400, 413) → stop.
 */

import * as z from 'zod';

import { migrate } from '@/save/migrate';
import type { SaveV1 } from '@/save/schema';
import { STORE_TIMEOUT_MS, rawKey, withTimeout, type SaveStore } from '@/save/store';
import type { Wal } from '@/save/wal';

import { SYNC_TIMEOUT_MS, type Api, type ApiResult } from './api';
import { reconcile, type Decision } from './reconcile';
import { readSyncState, writeSyncState, type CloudHead, type StorageLike, type SyncState } from './syncState';

export const PUSH_MIN_INTERVAL_MS = 5_000;
/** Backoff after a failed push; the last step repeats. */
export const PUSH_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];

export const SYNC_OFFLINE_TEXT = 'OFFLINE — SAVED LOCALLY';
export const SYNC_REAUTH_TEXT = 'SIGN IN AGAIN TO SYNC';
export const SYNC_CONFLICT_TEXT = 'SYNC CONFLICT — CHOOSE ON NEXT START';

export type SyncStatus = 'off' | 'synced' | 'pending' | 'offline' | 'reauth' | 'conflict';

export type BootDecision = Decision | { kind: 'local-only'; reason: 'reader' | 'offline' | 'timeout' | 'unreadable' };

export interface BootSync {
  decision: BootDecision;
  cloud: SaveV1 | null;
  notice: string | null;
}

export type ResolveResult =
  | { ok: true; save: SaveV1 }
  | { ok: false; reason: 'offline' | 'reauth' | 'moved'; cloud?: SaveV1 };

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
const ConflictBodySchema = z.object({ cloud: CloudBodySchema });
const NoSaveSchema = z.object({ error: z.literal('no-save') });

type Me = z.infer<typeof MeSchema>;

const head = (s: SaveV1): CloudHead => ({ saveId: s.saveId, revision: s.revision });

/** The save inside a `{revision, save}` body, migrated; null when unreadable. */
function cloudSave(body: unknown): { save: SaveV1; revision: number } | null {
  const b = CloudBodySchema.safeParse(body);
  if (!b.success) return null;
  const m = migrate(b.data.save);
  return m.ok ? { save: m.save, revision: b.data.revision } : null;
}

const isTimeout = (r: ApiResult): boolean => !r.ok && r.status === 'timeout';
const retryable = (status: number | 'offline' | 'timeout'): boolean =>
  status === 'offline' || status === 'timeout' || status === 408 || (typeof status === 'number' && status >= 500);

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
  private latest: SaveV1 | null = null;
  /** A save waiting to be pushed. */
  private queued: SaveV1 | null = null;
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
  private reportedFatal = false;

  constructor(deps: SyncClientDeps) {
    this.d = deps;
    this.state = readSyncState(deps.storage, deps.uuid);
  }

  status(): SyncStatus {
    return this.st;
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

  async boot(local: SaveV1 | null, opts: { localDirty?: boolean } = {}): Promise<BootSync> {
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

    // One budget for both calls (they run in parallel).
    let cancelBudget: () => void = () => undefined;
    const budget = new Promise<'timeout'>((resolve) => {
      cancelBudget = this.d.schedule(() => resolve('timeout'), SYNC_TIMEOUT_MS);
    });
    const meCall = this.d.api.me();
    const saveCall = this.d.api.getSave();
    const answered = await Promise.race([Promise.all([meCall, saveCall]), budget]);
    cancelBudget();

    if (answered === 'timeout') {
      // me() may still have answered in time.
      const early = await Promise.race([meCall, Promise.resolve(null)]);
      this.afterOffline(early);
      return localOnly('timeout');
    }
    const [meRes, saveRes] = answered;

    if (!meRes.ok && meRes.status === 401) {
      this.pushing = false;
      this.st = this.state.accountId !== null ? 'reauth' : 'off';
      return { decision: { kind: 'guest' }, cloud: null, notice: null };
    }
    if (isTimeout(meRes) || isTimeout(saveRes)) {
      this.afterOffline(meRes);
      return localOnly('timeout');
    }
    const me = meRes.ok ? MeSchema.safeParse(meRes.body) : null;
    const emptyCloud = !saveRes.ok && saveRes.status === 404 && NoSaveSchema.safeParse(saveRes.body).success;
    if (!me?.success || (!saveRes.ok && !emptyCloud)) {
      this.afterOffline(meRes);
      return localOnly('offline');
    }

    let cloud: SaveV1 | null = null;
    if (!emptyCloud) {
      const c = cloudSave(saveRes.ok ? saveRes.body : null);
      if (!c) {
        // Review Focus 4: an unreadable cloud is no cloud, and nothing is pushed over it.
        this.pushing = false;
        this.st = 'off';
        return localOnly('unreadable');
      }
      cloud = c.save;
      this.cloudHead = { saveId: c.save.saveId, revision: c.revision };
    }

    this.me = me.data;
    const decision = reconcile({ local, cloud, state: this.state, me: me.data, localDirty: opts.localDirty === true });
    try {
      return await this.apply(decision, local, cloud, me.data, opts.localDirty === true);
    } catch {
      // A store that failed the replacement keeps the old local save (one transaction).
      this.pushing = false;
      this.st = 'offline';
      return localOnly('offline');
    }
  }

  /** An offline/timed-out boot: pushes wait for an identity check (R38), if the save is bound at all. */
  private afterOffline(meRes: ApiResult | null): void {
    this.st = 'offline';
    if (this.state.accountId === null) {
      this.pushing = false;
      return;
    }
    const me = meRes && meRes.ok ? MeSchema.safeParse(meRes.body) : null;
    if (me?.success) {
      this.me = me.data;
      this.pushing = me.data.id === this.state.accountId;
      this.needsIdentity = false;
      return;
    }
    this.pushing = true;
    this.needsIdentity = true;
  }

  private async apply(decision: Decision, local: SaveV1 | null, cloud: SaveV1 | null, me: Me, dirty: boolean): Promise<BootSync> {
    const out = (notice: string | null = null): BootSync => ({ decision, cloud, notice });
    const bind = (L: CloudHead | null): void => {
      this.state = { ...this.state, accountId: me.id, accountName: me.name, lastSeenCloud: L };
    };

    switch (decision.kind) {
      case 'guest':
        this.st = 'off';
        return out();

      case 'refuse-switch':
        await this.d.api.logout();
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
        await this.replaceLocal(local && local.saveId !== c.saveId ? local : null, c);
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
        await this.replaceLocal(local, cloud);
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
        // Unbound and equal to the cloud: L is the cloud's head, or the next PUT would 409.
        if (this.state.accountId === null) bind(cloud ? head(cloud) : null);
        this.persist();
        this.pushing = true;
        this.st = 'synced';
        return out();

      case 'adopt':
        bind(null);
        this.persist();
        this.pushing = true;
        this.enqueue(local!);
        return out();

      case 'push-local': {
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

  /** R35: shelve (when given), reset the WAL, replace the store's save. */
  private async replaceLocal(shelve: SaveV1 | null, next: SaveV1 | null): Promise<void> {
    if (shelve) await withTimeout(() => this.d.store.keepCorrupt(shelve, Date.now()), STORE_TIMEOUT_MS);
    this.d.wal.reset();
    await withTimeout(() => this.d.store.replaceAll(next), STORE_TIMEOUT_MS);
  }

  private persist(): void {
    writeSyncState(this.d.storage, this.state);
  }

  // ---------------------------------------------------------------------------
  // Push

  onStored(save: SaveV1): void {
    this.latest = save;
    if (!this.pushing) return;
    if (this.holdAtOrBelow !== null) {
      if (save.saveId === this.state.lastSeenCloud?.saveId && save.revision <= this.holdAtOrBelow) return;
      this.holdAtOrBelow = null;
    }
    this.enqueue(save);
  }

  private enqueue(save: SaveV1): void {
    this.queued = save;
    if (!this.backingOff) this.st = 'pending';
    this.kick();
  }

  /** Schedule the next push attempt, if none is scheduled or running. */
  private kick(): void {
    if (this.cancelTimer || this.inFlight || !this.queued || !this.pushing) return;
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
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.backingOff = false;
    this.st = status;
  }

  /** A retryable failure: keep the latest, wait the current step, advance it. */
  private backoff(save: SaveV1): void {
    this.queued = this.queued ?? save;
    this.st = 'offline';
    const ms = PUSH_BACKOFF_MS[Math.min(this.step, PUSH_BACKOFF_MS.length - 1)]!;
    this.step++;
    this.arm(ms, true);
  }

  private async pump(): Promise<void> {
    const save = this.queued;
    if (!save || !this.pushing || this.inFlight) return;
    this.inFlight = true;
    try {
      if (this.needsIdentity) {
        const r = await this.d.api.me();
        if (!r.ok) {
          if (r.status === 401) return this.stop('reauth');
          return this.backoff(save);
        }
        const me = MeSchema.safeParse(r.body);
        if (!me.success) return this.backoff(save);
        if (me.data.id !== this.state.accountId) return this.stop('off'); // never push A's save with B's cookie
        this.me = me.data;
        this.needsIdentity = false;
      }

      this.queued = null;
      this.lastPutStart = Date.now();
      this.st = 'pending';
      const base = this.state.lastSeenCloud;
      const r = await this.d.api.putSave({ deviceId: this.state.deviceId, base, save });

      if (r.ok) {
        const body = PutOkSchema.safeParse(r.body);
        this.state = {
          ...this.state,
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
          if (cs) this.cloudHead = { saveId: cs.save.saveId, revision: cs.revision };
        }
        return this.stop('conflict');
      }
      if (r.status === 429) {
        // R39: rate limited — pending, the step is not advanced.
        this.queued = this.queued ?? save;
        const ra = typeof r.retryAfterS === 'number' ? r.retryAfterS * 1000 : 0;
        const ms = Math.max(ra, PUSH_BACKOFF_MS[Math.min(this.step, PUSH_BACKOFF_MS.length - 1)]!);
        this.st = 'pending';
        return this.arm(ms, true);
      }
      if (retryable(r.status)) return this.backoff(save);
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
  // Resolve

  async resolve(keep: 'device' | 'cloud'): Promise<ResolveResult> {
    const device = this.latest;
    if (!device) return { ok: false, reason: 'offline' };
    const r = await this.d.api.resolve({
      deviceId: this.state.deviceId,
      keep,
      device,
      base: this.state.lastSeenCloud,
      cloud: this.cloudHead,
    });

    if (!r.ok) {
      if (r.status === 401) {
        this.st = 'reauth';
        return { ok: false, reason: 'reauth' };
      }
      if (r.status === 409) {
        const c = ConflictBodySchema.safeParse(r.body);
        const cs = c.success ? cloudSave(c.data.cloud) : null;
        if (cs) {
          this.cloudHead = { saveId: cs.save.saveId, revision: cs.revision };
          this.st = 'conflict';
          return { ok: false, reason: 'moved', cloud: cs.save };
        }
        return { ok: false, reason: 'moved' };
      }
      return { ok: false, reason: 'offline' };
    }

    const result = cloudSave(r.body);
    if (!result) return { ok: false, reason: 'offline' };
    const save = result.save;
    try {
      await this.replaceLocal(rawKey(save) === rawKey(device) ? null : device, save);
    } catch {
      return { ok: false, reason: 'offline' };
    }
    this.state = {
      ...this.state,
      ...(this.me ? { accountId: this.me.id, accountName: this.me.name } : {}),
      lastSeenCloud: { saveId: save.saveId, revision: result.revision },
      conflict: false,
    };
    this.persist();
    this.cloudHead = { saveId: save.saveId, revision: result.revision };
    this.latest = save;
    this.pushing = this.me !== null && this.me.id === this.state.accountId;
    this.needsIdentity = false;
    this.st = 'synced';
    return { ok: true, save };
  }
}
