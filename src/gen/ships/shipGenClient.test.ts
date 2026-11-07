/**
 * The ship generation client — request bookkeeping, dedupe, LRU, cancellation,
 * fallback — and the proof that the worker path is byte-identical to the
 * synchronous one.
 *
 * Runs in node with a fake worker. The fake answers through the SAME
 * `answerShipRequest` the real worker entry uses and round-trips every message
 * through `structuredClone`, which is the exact transformation `postMessage`
 * applies. So "the fake worker's blueprint hashes to the golden" is the claim
 * that matters: what crosses the thread boundary is the ship the link promised.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateShip, type GeneratedShip, type ShipParams } from './blueprint';
import { PINNED } from './goldenParams';
import { ShipGenCancelled, ShipGenClient, shipParamsKey, type ShipWorkerPort } from './shipGenClient';
import { answerShipRequest, type ShipGenRequest, type ShipGenResponse } from './shipGenProtocol';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A stand-in generator: bookkeeping tests do not need a 40 ms hull. */
let generated: number[] = [];
function fakeGenerate(p: ShipParams): GeneratedShip {
  generated.push(p.seed);
  if (p.seed === 666) throw new Error('cursed hull');
  return { id: `bp-${p.seed}`, seed: p.seed } as unknown as GeneratedShip;
}

class FakeWorker implements ShipWorkerPort {
  readonly posted: ShipGenRequest[] = [];
  private answered = 0;
  terminated = false;
  onmessage: ((ev: { data: ShipGenResponse }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(private readonly generate: (p: ShipParams) => GeneratedShip) {}

  postMessage(msg: ShipGenRequest): void {
    this.posted.push(structuredClone(msg));
  }
  terminate(): void {
    this.terminated = true;
  }
  get pending(): number {
    return this.posted.length - this.answered;
  }
  /** Answer the oldest unanswered request exactly as shipWorker.ts would. */
  answerNext(): void {
    const req = this.posted[this.answered++]!;
    this.onmessage?.({ data: structuredClone(answerShipRequest(req, this.generate)) });
  }
  reply(data: ShipGenResponse): void {
    this.onmessage?.({ data });
  }
  crash(): void {
    this.onerror?.(new Error('worker died'));
  }
}

interface Rig {
  client: ShipGenClient;
  workers: FakeWorker[];
  tasks: Array<() => void>;
  runTask(): void;
}

function rig(opts: { poolSize?: number; capacity?: number; workers?: boolean; real?: boolean } = {}): Rig {
  generated = [];
  const gen = opts.real ? generateShip : fakeGenerate;
  const workers: FakeWorker[] = [];
  const tasks: Array<() => void> = [];
  const client = new ShipGenClient({
    poolSize: opts.poolSize ?? 1,
    capacity: opts.capacity ?? 8,
    generate: gen,
    schedule: (fn) => {
      tasks.push(fn);
    },
    createWorker:
      opts.workers === false
        ? null
        : () => {
            const w = new FakeWorker(gen);
            workers.push(w);
            return w;
          },
  });
  return { client, workers, tasks, runTask: () => tasks.shift()?.() };
}

/** Let resolved promises run their continuations. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function digest(bp: unknown): string {
  return createHash('sha256').update(JSON.stringify(bp)).digest('hex').slice(0, 16);
}

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('./golden.json', import.meta.url)), 'utf8'),
) as { hashes: string[] };

// ---------------------------------------------------------------------------
// Determinism — the one property that may never regress
// ---------------------------------------------------------------------------

describe('shipGenClient — determinism', () => {
  it('Given the golden params, When generated through the worker path, Then every blueprint hashes to the recorded golden', async () => {
    const { client, workers } = rig({ real: true });
    for (let i = 0; i < PINNED.length; i++) {
      const p = client.request(PINNED[i]!);
      workers[0]!.answerNext();
      expect(digest(await p)).toBe(GOLDEN.hashes[i]);
    }
    client.dispose();
  }, 30_000);

  it('Given the golden params, When generated through the synchronous fallback, Then every blueprint hashes to the recorded golden', async () => {
    const { client, runTask } = rig({ real: true, workers: false });
    for (let i = 0; i < PINNED.length; i++) {
      const p = client.request(PINNED[i]!);
      runTask();
      expect(digest(await p)).toBe(GOLDEN.hashes[i]);
    }
    client.dispose();
  }, 30_000);

  it('Given a golden param, When the worker blueprint is compared with generateShip, Then they are deeply equal (not merely same JSON)', async () => {
    const { client, workers } = rig({ real: true });
    const p = client.request(PINNED[4]!);
    workers[0]!.answerNext();
    expect(await p).toEqual(generateShip(PINNED[4]!));
    client.dispose();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe('shipParamsKey', () => {
  it('Given the same params in a different property order, Then the keys are equal', () => {
    expect(shipParamsKey({ seed: 1, role: 'tug', factionId: 'kessler' })).toBe(
      shipParamsKey({ factionId: 'kessler', seed: 1, role: 'tug' }),
    );
  });

  it('Given an explicit undefined field, Then it keys like an absent one', () => {
    expect(shipParamsKey({ seed: 1, role: undefined })).toBe(shipParamsKey({ seed: 1 }));
  });

  it('Given the current generation version spelled out, Then it keys like the default', async () => {
    const { SHIP_GENERATION_VERSION } = await import('./types');
    expect(shipParamsKey({ seed: 1, generationVersion: SHIP_GENERATION_VERSION })).toBe(shipParamsKey({ seed: 1 }));
  });

  it('Given different seeds or overrides, Then the keys differ', () => {
    expect(shipParamsKey({ seed: 1 })).not.toBe(shipParamsKey({ seed: 2 }));
    expect(shipParamsKey({ seed: 1, ageYears: 10 })).not.toBe(shipParamsKey({ seed: 1, ageYears: 11 }));
  });
});

// ---------------------------------------------------------------------------
// Request bookkeeping
// ---------------------------------------------------------------------------

describe('shipGenClient — requests', () => {
  it('Given a worker, When a ship is requested, Then nothing is generated on this thread and the worker answer resolves it', async () => {
    const { client, workers } = rig();
    const p = client.request({ seed: 1 });
    expect(client.mode).toBe('worker');
    expect(generated).toEqual([]);
    expect(workers[0]!.posted).toHaveLength(1);
    workers[0]!.answerNext();
    expect((await p).id).toBe('bp-1');
  });

  it('Given two requests for the same params in flight, When both are made, Then one message is posted and both get the same blueprint', async () => {
    const { client, workers } = rig();
    const a = client.request({ seed: 1 });
    const b = client.request({ seed: 1 });
    expect(workers[0]!.posted).toHaveLength(1);
    workers[0]!.answerNext();
    expect(await a).toBe(await b);
  });

  it('Given a resolved ship, When it is requested again, Then it comes from the cache with no message posted', async () => {
    const { client, workers } = rig();
    const a = client.request({ seed: 1 });
    workers[0]!.answerNext();
    const first = await a;
    const again = await client.request({ seed: 1 });
    expect(again).toBe(first);
    expect(workers[0]!.posted).toHaveLength(1);
    expect(client.peek({ seed: 1 })).toBe(first);
  });

  it('Given a pool of two, When three ships are requested, Then two are dispatched and the third waits for a free worker', async () => {
    const { client, workers } = rig({ poolSize: 2 });
    const ps = [1, 2, 3].map((seed) => client.request({ seed }));
    expect(workers).toHaveLength(2);
    expect(workers[0]!.pending + workers[1]!.pending).toBe(2);
    workers[1]!.answerNext();
    expect(workers[1]!.pending).toBe(1);
    workers[0]!.answerNext();
    workers[1]!.answerNext();
    expect((await Promise.all(ps)).map((b) => b.id)).toEqual(['bp-1', 'bp-2', 'bp-3']);
  });

  it('Given queued prefetches, When a high-priority request arrives, Then it is dispatched before them', async () => {
    const { client, workers } = rig();
    void client.request({ seed: 1 });
    client.prefetch({ seed: 2 });
    client.prefetch({ seed: 3 });
    void client.request({ seed: 4 });
    workers[0]!.answerNext();
    expect(workers[0]!.posted.map((r) => r.params.seed)).toEqual([1, 4]);
  });

  it('Given a queued prefetch, When the same ship is then requested at high priority, Then it is promoted rather than duplicated', async () => {
    const { client, workers } = rig();
    void client.request({ seed: 1 });
    client.prefetch({ seed: 2 });
    client.prefetch({ seed: 3 });
    const p = client.request({ seed: 3 });
    workers[0]!.answerNext();
    expect(workers[0]!.posted.map((r) => r.params.seed)).toEqual([1, 3]);
    workers[0]!.answerNext();
    expect((await p).id).toBe('bp-3');
  });

  it('Given the generator throws in the worker, When the answer arrives, Then the request rejects with its message and nothing is cached', async () => {
    const { client, workers } = rig();
    const p = client.request({ seed: 666 });
    workers[0]!.answerNext();
    await expect(p).rejects.toThrow(/cursed hull/);
    expect(client.peek({ seed: 666 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stale answers and cancellation
// ---------------------------------------------------------------------------

describe('shipGenClient — stale answers and cancellation', () => {
  it('Given an answer for an id nobody asked for, When it arrives, Then it is ignored', async () => {
    const { client, workers } = rig();
    const p = client.request({ seed: 1 });
    workers[0]!.reply({ id: 9999, ok: true, blueprint: fakeGenerate({ seed: 7 }) });
    expect(client.peek({ seed: 7 })).toBeUndefined();
    workers[0]!.answerNext();
    expect((await p).id).toBe('bp-1');
  });

  it('Given a request in flight, When get() builds it synchronously first, Then the promise resolves to that build and the late worker answer is ignored', async () => {
    const { client, workers } = rig();
    const p = client.request({ seed: 1 });
    const sync = client.get({ seed: 1 });
    expect(await p).toBe(sync);
    workers[0]!.answerNext();
    expect(client.peek({ seed: 1 })).toBe(sync);
  });

  it('Given a queued request, When it is cancelled, Then it is never posted and its promise rejects as cancelled', async () => {
    const { client, workers } = rig();
    void client.request({ seed: 1 });
    const p = client.request({ seed: 2 });
    client.cancel({ seed: 2 });
    await expect(p).rejects.toBeInstanceOf(ShipGenCancelled);
    workers[0]!.answerNext();
    expect(workers[0]!.posted.map((r) => r.params.seed)).toEqual([1]);
  });

  it('Given two callers want a queued ship, When one cancels, Then it still runs for the other', async () => {
    const { client, workers } = rig();
    void client.request({ seed: 1 });
    const a = client.request({ seed: 2 });
    void client.request({ seed: 2 });
    client.cancel({ seed: 2 });
    workers[0]!.answerNext();
    workers[0]!.answerNext();
    expect((await a).id).toBe('bp-2');
  });

  it('Given a dispatched request, When it is cancelled, Then the answer is still cached for next time', async () => {
    const { client, workers } = rig();
    const p = client.request({ seed: 1 });
    p.catch(() => undefined);
    client.cancel({ seed: 1 });
    workers[0]!.answerNext();
    await flush();
    expect(client.peek({ seed: 1 })?.id).toBe('bp-1');
  });
});

// ---------------------------------------------------------------------------
// LRU
// ---------------------------------------------------------------------------

describe('shipGenClient — LRU', () => {
  it('Given capacity 2, When a third ship resolves, Then the least recent is evicted', async () => {
    const { client } = rig({ capacity: 2, workers: false });
    for (const seed of [1, 2, 3]) client.get({ seed });
    expect(client.peek({ seed: 1 })).toBeUndefined();
    expect(client.peek({ seed: 2 })).toBeDefined();
    expect(client.peek({ seed: 3 })).toBeDefined();
  });

  it('Given capacity 2 and a re-read of the oldest, When a third ship resolves, Then the re-read one survives', () => {
    const { client } = rig({ capacity: 2, workers: false });
    client.get({ seed: 1 });
    client.get({ seed: 2 });
    client.get({ seed: 1 });
    client.get({ seed: 3 });
    expect(client.peek({ seed: 1 })).toBeDefined();
    expect(client.peek({ seed: 2 })).toBeUndefined();
  });

  it('Given a cached ship, When get() is called, Then the generator is not run again', () => {
    const { client } = rig({ workers: false });
    const a = client.get({ seed: 1 });
    expect(client.get({ seed: 1 })).toBe(a);
    expect(generated).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe('shipGenClient — synchronous fallback', () => {
  it('Given no worker is available, When ships are requested, Then they are generated on this thread one per task, never all at once', async () => {
    const { client, runTask } = rig({ workers: false });
    expect(client.mode).toBe('sync');
    const a = client.request({ seed: 1 });
    const b = client.request({ seed: 2 });
    expect(generated).toEqual([]);
    runTask();
    expect(generated).toEqual([1]);
    runTask();
    expect(generated).toEqual([1, 2]);
    expect([(await a).id, (await b).id]).toEqual(['bp-1', 'bp-2']);
  });

  it('Given the worker factory throws, When a ship is requested, Then the client falls back to sync and still resolves', async () => {
    generated = [];
    const tasks: Array<() => void> = [];
    const client = new ShipGenClient({
      generate: fakeGenerate,
      schedule: (fn) => {
        tasks.push(fn);
      },
      createWorker: () => {
        throw new Error('module workers unsupported');
      },
    });
    const p = client.request({ seed: 5 });
    expect(client.mode).toBe('sync');
    tasks.shift()?.();
    expect((await p).id).toBe('bp-5');
  });

  it('Given jobs in flight and queued, When the worker errors, Then the pool is terminated and every job completes through the fallback', async () => {
    const { client, workers, runTask } = rig();
    const a = client.request({ seed: 1 });
    const b = client.request({ seed: 2 });
    workers[0]!.crash();
    expect(workers[0]!.terminated).toBe(true);
    expect(client.mode).toBe('sync');
    runTask();
    runTask();
    expect([(await a).id, (await b).id]).toEqual(['bp-1', 'bp-2']);
    // Later requests stay on the fallback; no new worker is spawned.
    const c = client.request({ seed: 3 });
    runTask();
    expect((await c).id).toBe('bp-3');
    expect(workers).toHaveLength(1);
  });

  it('Given a crashed worker, When its late answer arrives anyway, Then it is ignored', async () => {
    const { client, workers, runTask } = rig();
    const a = client.request({ seed: 1 });
    workers[0]!.crash();
    workers[0]!.reply({ id: workers[0]!.posted[0]!.id, ok: true, blueprint: fakeGenerate({ seed: 99 }) });
    runTask();
    expect((await a).id).toBe('bp-1');
  });
});

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('shipGenClient — dispose', () => {
  it('Given workers and pending jobs, When disposed, Then workers are terminated, pending jobs reject and late answers are ignored', async () => {
    const { client, workers } = rig({ poolSize: 2 });
    const a = client.request({ seed: 1 });
    const b = client.request({ seed: 2 });
    const c = client.request({ seed: 3 });
    const settled = Promise.allSettled([a, b, c]);
    client.dispose();
    expect(workers.every((w) => w.terminated)).toBe(true);
    for (const r of await settled) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ShipGenCancelled);
    }
    workers[0]!.answerNext();
    expect(client.peek({ seed: 1 })).toBeUndefined();
  });
});
