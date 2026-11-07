/**
 * Ship generation off the main thread.
 *
 * `generateShip` is 30-75 ms of pure computation, and it ran on the main
 * thread in two places that both felt it: Traffic, one hull per frame after a
 * system change, and the Yard, where every seed change was a 60-100 ms long
 * task behind the veil — hidden, but input froze with it (PERFORMANCE.md #6,
 * D10, D46, D56). This client hands the work to a small pool of workers and
 * gives back the same blueprint, byte for byte, as a promise.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT KEEPS TRACK OF
 *
 * - One job per distinct ship (`shipParamsKey`). A second request for a ship
 *   already queued or running shares the first one's promise: holding → in
 *   the Yard, or two callers wanting the same hull, never generates it twice.
 * - Each worker runs ONE job at a time, so the client always knows which jobs
 *   a crashed worker took with it, and an answer is accepted only from the
 *   worker running that job under that request id. Anything else — a crashed
 *   worker's last word, an answer for a job `get()` already built in place —
 *   is stale and dropped.
 * - Two priorities. A request is what someone is waiting for; a prefetch is a
 *   guess. A request jumps every queued prefetch, and a request for a ship
 *   that is already queued as a prefetch promotes it instead of duplicating it.
 * - Cancellation is reference counted and only ever drops QUEUED work. A job
 *   already on a worker runs to the end and its answer is cached — the
 *   worker's time is spent either way, and the next ask is then free.
 * - Results go into a small LRU, so a cycled-back-to hull is instant.
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS THE SAME FUNCTION
 *
 * No `Worker` (node, vitest, an old browser), a factory that throws (module
 * workers unsupported), or a worker that errors: the client switches to
 * generating on this thread and stays there. It still never runs more than one
 * hull per task — jobs drain one per `schedule` tick — so the fallback is
 * D10's one-heavy-build-at-a-time rule rather than the v1 burst. `get()` is
 * the synchronous door for callers that cannot wait at all (the review
 * harness, whose frames are captured on a fixed step; D42).
 *
 * Determinism needs no special handling: both paths call `generateShip` with
 * the same params, and the worker's answer crosses as a structured clone,
 * which preserves every value exactly. shipGenClient.test.ts proves it on the
 * golden params.
 */

import { generateShip, type GeneratedShip, type ShipParams } from './blueprint';
import type { ShipGenRequest, ShipGenResponse } from './shipGenProtocol';
import { SHIP_GENERATION_VERSION } from './types';

/** The parts of a `Worker` the client uses — a fake one in tests. */
export interface ShipWorkerPort {
  postMessage(msg: ShipGenRequest): void;
  terminate(): void;
  onmessage: ((ev: { data: ShipGenResponse }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type ShipGenPriority = 'high' | 'low';
export type ShipGenMode = 'worker' | 'sync';

/** Rejection for a request that was cancelled or whose client was disposed. */
export class ShipGenCancelled extends Error {
  constructor() {
    super('ship generation cancelled');
    this.name = 'ShipGenCancelled';
  }
}

export interface ShipGenClientOptions {
  /**
   * Makes one worker. Omitted: a real module worker when `Worker` exists.
   * `null`: no workers, the synchronous fallback from the start.
   */
  readonly createWorker?: (() => ShipWorkerPort) | null;
  /** Workers in the pool. Default: hardware threads − 1, at most 2. */
  readonly poolSize?: number;
  /** Blueprints kept. ~75-200 KB each, so 24 is a few MB. */
  readonly capacity?: number;
  /** The generator for the fallback. Only tests replace it. */
  readonly generate?: (p: ShipParams) => GeneratedShip;
  /** Paces the fallback, one job per call. Default: a macrotask. */
  readonly schedule?: (fn: () => void) => void;
}

/**
 * A canonical key: fixed field order, absent and undefined alike, and the
 * default generation version written out — `{seed}` and `{seed, gen: current}`
 * are the same ship, so they must be the same job and the same cache entry.
 */
export function shipParamsKey(p: ShipParams): string {
  return JSON.stringify([
    p.seed,
    p.factionId ?? null,
    p.role ?? null,
    p.sizeClass ?? null,
    p.ageYears ?? null,
    p.damageLevel ?? null,
    p.maintenance ?? null,
    p.generationVersion ?? SHIP_GENERATION_VERSION,
  ]);
}

interface Job {
  readonly key: string;
  readonly params: ShipParams;
  readonly promise: Promise<GeneratedShip>;
  readonly resolve: (bp: GeneratedShip) => void;
  readonly reject: (e: unknown) => void;
  /** Callers still interested. Prefetches count as one. */
  wanted: number;
  priority: ShipGenPriority;
  state: 'queued' | 'running' | 'done';
  /** Request id of the current dispatch; 0 while queued. */
  id: number;
}

interface Slot {
  readonly port: ShipWorkerPort;
  job: Job | null;
}

const noop = (): void => undefined;

function defaultWorkerFactory(): (() => ShipWorkerPort) | null {
  if (typeof Worker === 'undefined') return null;
  // The literal `new Worker(new URL(...), ...)` is what Vite looks for to emit
  // the worker as its own chunk; do not route the URL through a variable.
  return () =>
    new Worker(new URL('./shipWorker.ts', import.meta.url), { type: 'module', name: 'ship-gen' }) as unknown as ShipWorkerPort;
}

function defaultPoolSize(): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  // Two is enough: the Yard wants one hull and its two neighbours, Traffic at
  // most four, and every extra worker is another copy of the generator's heap.
  return Math.max(1, Math.min(2, (hw || 2) - 1));
}

export class ShipGenClient {
  private readonly factory: (() => ShipWorkerPort) | null;
  private readonly poolSize: number;
  private readonly capacity: number;
  private readonly generate: (p: ShipParams) => GeneratedShip;
  private readonly schedule: (fn: () => void) => void;

  private readonly cache = new Map<string, GeneratedShip>();
  private readonly jobs = new Map<string, Job>();
  private readonly high: Job[] = [];
  private readonly low: Job[] = [];
  private slots: Slot[] = [];
  private nextId = 0;
  private fallenBack = false;
  private drainScheduled = false;
  private disposed = false;

  constructor(opts: ShipGenClientOptions = {}) {
    this.factory = opts.createWorker === undefined ? defaultWorkerFactory() : opts.createWorker;
    this.poolSize = Math.max(1, Math.floor(opts.poolSize ?? defaultPoolSize()));
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? 24));
    this.generate = opts.generate ?? generateShip;
    this.schedule = opts.schedule ?? ((fn) => void setTimeout(fn, 0));
  }

  get mode(): ShipGenMode {
    return this.factory && !this.fallenBack ? 'worker' : 'sync';
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  /** The blueprint for `params`, from the cache, a job in flight, or a new job. */
  request(params: ShipParams, priority: ShipGenPriority = 'high'): Promise<GeneratedShip> {
    if (this.disposed) return Promise.reject(new ShipGenCancelled());
    const key = shipParamsKey(params);
    const hit = this.touch(key);
    if (hit) return Promise.resolve(hit);
    const job = this.jobs.get(key);
    if (job) {
      job.wanted++;
      if (priority === 'high') this.promote(job);
      return job.promise;
    }
    return this.enqueue(key, params, priority).promise;
  }

  /**
   * Warm the cache with a ship nobody is waiting for yet. Queued behind every
   * request; cancel it with `cancel(params)` once the guess is wrong.
   */
  prefetch(params: ShipParams): void {
    if (this.disposed) return;
    const key = shipParamsKey(params);
    if (this.cache.has(key)) return;
    const job = this.jobs.get(key);
    if (job) {
      job.wanted++;
      return;
    }
    this.enqueue(key, params, 'low');
  }

  /**
   * Drop one caller's interest. When nobody is left and the job has not
   * started, it is removed and its promise rejects with `ShipGenCancelled`.
   */
  cancel(params: ShipParams): void {
    const key = shipParamsKey(params);
    const job = this.jobs.get(key);
    if (!job) return;
    job.wanted = Math.max(0, job.wanted - 1);
    if (job.wanted > 0 || job.state !== 'queued') return;
    this.unqueue(job);
    this.jobs.delete(key);
    job.state = 'done';
    job.reject(new ShipGenCancelled());
  }

  /** The cached blueprint, if there is one. Marks it most recent. */
  peek(params: ShipParams): GeneratedShip | undefined {
    return this.touch(shipParamsKey(params));
  }

  /**
   * The blueprint NOW: the cache, or built on this thread. For callers that
   * cannot wait — the review harness, and a cut that has waited long enough.
   * Settles a pending job for the same ship with this build, so nobody gets a
   * second, different object for it later.
   */
  get(params: ShipParams): GeneratedShip {
    const key = shipParamsKey(params);
    const hit = this.touch(key);
    if (hit) return hit;
    const bp = this.generate(params);
    const job = this.jobs.get(key);
    if (job) {
      this.unqueue(job);
      this.succeed(job, bp);
    } else {
      this.store(key, bp);
    }
    return bp;
  }

  /** Terminate the workers, reject everything pending, forget the cache. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.slots) this.close(s);
    this.slots = [];
    this.high.length = 0;
    this.low.length = 0;
    const pending = [...this.jobs.values()];
    this.jobs.clear();
    for (const j of pending) {
      j.state = 'done';
      j.reject(new ShipGenCancelled());
    }
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  private enqueue(key: string, params: ShipParams, priority: ShipGenPriority): Job {
    let resolve!: (bp: GeneratedShip) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<GeneratedShip>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Handled at the source: a cancelled prefetch nobody awaits must not be
    // reported as an unhandled rejection. Callers still see the rejection.
    promise.catch(noop);
    const job: Job = { key, params, promise, resolve, reject, wanted: 1, priority, state: 'queued', id: 0 };
    this.jobs.set(key, job);
    (priority === 'high' ? this.high : this.low).push(job);
    this.pump();
    return job;
  }

  private promote(job: Job): void {
    if (job.priority === 'high') return;
    job.priority = 'high';
    if (job.state !== 'queued') return;
    const i = this.low.indexOf(job);
    if (i >= 0) this.low.splice(i, 1);
    this.high.push(job);
  }

  private unqueue(job: Job): void {
    const q = job.priority === 'high' ? this.high : this.low;
    const i = q.indexOf(job);
    if (i >= 0) q.splice(i, 1);
  }

  private next(): Job | undefined {
    return this.high.shift() ?? this.low.shift();
  }

  private succeed(job: Job, bp: GeneratedShip): void {
    job.state = 'done';
    this.jobs.delete(job.key);
    this.store(job.key, bp);
    job.resolve(bp);
  }

  private fail(job: Job, error: unknown): void {
    job.state = 'done';
    this.jobs.delete(job.key);
    job.reject(error);
  }

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  private touch(key: string): GeneratedShip | undefined {
    const v = this.cache.get(key);
    if (v === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, v);
    return v;
  }

  private store(key: string, bp: GeneratedShip): void {
    this.cache.delete(key);
    this.cache.set(key, bp);
    // Map iterates in insertion order, so the first key is the least recent.
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.disposed) return;
    if (this.mode === 'sync') {
      this.scheduleDrain();
      return;
    }
    // Idle workers first, then grow the pool lazily — a session that never
    // meets a ship never starts a worker.
    for (const s of this.slots) {
      if (s.job) continue;
      const job = this.next();
      if (!job) return;
      this.dispatch(s, job);
      if (this.fallenBack) return;
    }
    while (this.slots.length < this.poolSize && (this.high.length > 0 || this.low.length > 0)) {
      const slot = this.spawn();
      if (!slot) return;
      this.dispatch(slot, this.next()!);
      if (this.fallenBack) return;
    }
  }

  private spawn(): Slot | null {
    let port: ShipWorkerPort;
    try {
      port = this.factory!();
    } catch {
      this.fallBack();
      return null;
    }
    const slot: Slot = { port, job: null };
    port.onmessage = (ev) => this.onAnswer(slot, ev.data);
    port.onerror = () => this.fallBack();
    this.slots.push(slot);
    return slot;
  }

  private dispatch(slot: Slot, job: Job): void {
    job.state = 'running';
    job.id = ++this.nextId;
    slot.job = job;
    try {
      slot.port.postMessage({ id: job.id, params: job.params });
    } catch {
      this.fallBack();
    }
  }

  private onAnswer(slot: Slot, data: ShipGenResponse): void {
    const job = slot.job;
    // Only the answer to the job this worker is running, under its current id.
    if (!job || job.id !== data.id) return;
    slot.job = null;
    // `get()` may already have built it in place; its answer is then stale.
    if (job.state === 'running') {
      if (data.ok) this.succeed(job, data.blueprint);
      else this.fail(job, new Error(data.error));
    }
    this.pump();
  }

  private close(s: Slot): void {
    s.port.onmessage = null;
    s.port.onerror = null;
    s.port.terminate();
  }

  /**
   * Off the workers for good. Whatever they were running goes back to the
   * head of the queue, in order, and is built on this thread one per task.
   */
  private fallBack(): void {
    if (this.fallenBack) return;
    this.fallenBack = true;
    const orphans: Job[] = [];
    for (const s of this.slots) {
      if (s.job && s.job.state === 'running') orphans.push(s.job);
      s.job = null;
      this.close(s);
    }
    this.slots = [];
    for (let i = orphans.length - 1; i >= 0; i--) {
      const j = orphans[i]!;
      j.state = 'queued';
      j.id = 0;
      (j.priority === 'high' ? this.high : this.low).unshift(j);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.disposed) return;
    if (this.high.length === 0 && this.low.length === 0) return;
    this.drainScheduled = true;
    this.schedule(() => this.drainOne());
  }

  private drainOne(): void {
    this.drainScheduled = false;
    if (this.disposed) return;
    const job = this.next();
    if (job) {
      try {
        this.succeed(job, this.generate(job.params));
      } catch (e) {
        this.fail(job, e);
      }
    }
    this.scheduleDrain();
  }
}

/** The game's one client. Workers start on the first request, not on import. */
export const shipGen = new ShipGenClient();
