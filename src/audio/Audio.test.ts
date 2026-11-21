/**
 * v4 sub-plan 5, Task 7 (phase A) — mining, refining and repair can be heard.
 *
 * DESIGN-5 §7.6: a low, held tone while the beam is on; a short sound per
 * bite; a deeper sound when a rock breaks up; and a held, different tone while
 * a refine or repair runs. All synthesised (no audio files).
 *
 * Until now Audio.ts had no test of its own: its testable layer was the pure
 * cue mappings in audioCues.ts, and the voices were "verified by ear". Holding
 * and releasing a tone is not a pure mapping — the claims here are about the
 * module's life (start, stop, stacking, dispose, a locked browser) — so this
 * file drives the real `Audio` class against a recording fake of the Web Audio
 * API (FakeAudioContext below). Nothing in it knows HOW a tone is built:
 *
 *   a tone at f Hz is AUDIBLE  ⇔  the context is running, and some started,
 *   not-stopped oscillator whose frequency was last set within 2 % of f has a
 *   path of connections to the destination on which every GainNode's gain was
 *   last set above 0.001.
 *
 * So a tone may be a voice built per extraction (stopped at the end) or a
 * permanent oscillator whose gain opens and closes (gain set to 0 at the end);
 * both pass, and a tone left sounding fails either way. A "voice" is a source
 * node (oscillator, buffer source, constant source) created by an event.
 *
 * The tone frequencies are `MINING_TONE_HZ` and `ACTION_TONE_HZ` from
 * audioCues.ts (their own tests: audible range, more than a semitone apart).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '@/core/EventBus';
import type { EngineContext, GameModule } from '@/core/Engine';
import type { Mode } from '@/core/Modes';
import type { StarSystemSpec } from '@/gen/types';
import type { ExtractionEnd } from '@/game/extraction';
import { Audio } from './Audio';
import { ACTION_TONE_HZ, MINING_TONE_HZ } from './audioCues';

// ---------------------------------------------------------------------------
// A recording fake of the Web Audio API — just enough for buildGraph and the
// one-shot voices, and strict where the real API is strict (a source starts
// once; stop before start throws).
// ---------------------------------------------------------------------------

class FakeParam {
  private v: number;
  /** Every value written, in order (set, ramp and target values alike). */
  readonly history: number[] = [];
  constructor(v = 0) {
    this.v = v;
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    this.write(x);
  }
  private write(x: number): this {
    this.v = x;
    this.history.push(x);
    return this;
  }
  setValueAtTime(x: number): this {
    return this.write(x);
  }
  setTargetAtTime(x: number): this {
    return this.write(x);
  }
  linearRampToValueAtTime(x: number): this {
    return this.write(x);
  }
  exponentialRampToValueAtTime(x: number): this {
    return this.write(x);
  }
  setValueCurveAtTime(): this {
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
  cancelAndHoldAtTime(): this {
    return this;
  }
}

const SOURCE_KINDS = new Set(['oscillator', 'buffer-source', 'constant-source']);

class FakeNode {
  readonly gain = new FakeParam(1);
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  readonly Q = new FakeParam(1);
  readonly pan = new FakeParam(0);
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
  readonly playbackRate = new FakeParam(1);
  readonly delayTime = new FakeParam(0);
  readonly offset = new FakeParam(1);
  type = '';
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  normalize = true;
  curve: unknown = null;
  oversample = 'none';
  started = false;
  stopped = false;
  onended: ((ev: unknown) => void) | null = null;
  readonly outputs: unknown[] = [];
  constructor(readonly kind: string) {}
  connect<T>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
  start(): void {
    if (this.started) throw new Error(`InvalidStateError: ${this.kind} started twice`);
    this.started = true;
  }
  stop(): void {
    if (!this.started) throw new Error(`InvalidStateError: ${this.kind} stopped before it started`);
    if (this.stopped) return;
    this.stopped = true;
    // Ended at once: a scheduled stop is as good as done for these claims.
    this.onended?.({});
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** The browser refuses to let the context run (no gesture yet). */
  static refuseResume = false;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  readonly sampleRate = 3000; // small: buildGraph fills seconds of noise and reverb
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  constructor(_opts?: unknown) {
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    if (!FakeAudioContext.refuseResume && this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    if (this.state === 'running') this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  private make(kind: string): FakeNode {
    const n = new FakeNode(kind);
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeNode {
    return this.make('gain');
  }
  createOscillator(): FakeNode {
    return this.make('oscillator');
  }
  createBufferSource(): FakeNode {
    return this.make('buffer-source');
  }
  createConstantSource(): FakeNode {
    return this.make('constant-source');
  }
  createBiquadFilter(): FakeNode {
    return this.make('biquad');
  }
  createConvolver(): FakeNode {
    return this.make('convolver');
  }
  createDynamicsCompressor(): FakeNode {
    return this.make('compressor');
  }
  createWaveShaper(): FakeNode {
    return this.make('waveshaper');
  }
  createStereoPanner(): FakeNode {
    return this.make('panner');
  }
  createDelay(): FakeNode {
    return this.make('delay');
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (ch: number) => data[ch]!,
    };
  }
}

// ---------------------------------------------------------------------------
// What the ear would hear
// ---------------------------------------------------------------------------

function reaches(n: FakeNode, dest: FakeNode, seen: Set<FakeNode>): boolean {
  if (n === dest) return true;
  if (seen.has(n)) return false;
  seen.add(n);
  if (n.kind === 'gain' && !(Math.abs(n.gain.value) > 1e-3)) return false;
  for (const o of n.outputs) if (o instanceof FakeNode && reaches(o, dest, seen)) return true;
  return false;
}

/** How many oscillators sound at `hz` (± 2 %) right now. */
function audibleAt(ac: FakeAudioContext | undefined, hz: number): number {
  if (!Number.isFinite(hz)) throw new Error(`the tone's frequency is not defined yet (got ${String(hz)})`);
  if (!ac || ac.state !== 'running') return 0;
  return ac.nodes.filter(
    (n) =>
      n.kind === 'oscillator' &&
      n.started &&
      !n.stopped &&
      Math.abs(n.frequency.value - hz) <= hz * 0.02 &&
      reaches(n, ac.destination, new Set()),
  ).length;
}

/** Sources started and not stopped (the permanent bed included). */
function liveSources(ac: FakeAudioContext): number {
  return ac.nodes.filter((n) => SOURCE_KINDS.has(n.kind) && n.started && !n.stopped).length;
}

/** Voices (source nodes) created after node index `from`. */
function voicesSince(ac: FakeAudioContext, from: number): number {
  return ac.nodes.slice(from).filter((n) => SOURCE_KINDS.has(n.kind)).length;
}

/** The lowest frequency any oscillator or filter created after `from` was ever set to. */
function lowestPitchSince(ac: FakeAudioContext, from: number): number {
  let lo = Number.POSITIVE_INFINITY;
  for (const n of ac.nodes.slice(from)) {
    if (n.kind !== 'oscillator' && n.kind !== 'biquad') continue;
    for (const f of n.frequency.history) if (f > 0 && f < lo) lo = f;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const ctx = {
  input: { axes: { throttle: 0 }, isDown: () => false },
} as unknown as EngineContext;

/** 'action:started' / 'action:ended' are not in GameEvents yet (Task 7 adds them). */
function emitAction(event: 'action:started', p: { kind: 'refine' | 'repair' }): void;
function emitAction(event: 'action:ended', p: { kind: 'refine' | 'repair'; ok: boolean }): void;
function emitAction(event: string, p: unknown): void {
  (bus as unknown as { emit(e: string, payload: unknown): void }).emit(event, p);
}

const ROCK = 'ast:test-rock';
const started = (): void => bus.emit('mining:started', { asteroidId: ROCK, resource: 'ice' });
const ended = (end: ExtractionEnd = 'stopped'): void =>
  bus.emit('mining:ended', { asteroidId: ROCK, resource: 'ice', minedKg: 250, end });
const bite = (): void => bus.emit('mining:bite', { asteroidId: ROCK, resource: 'ice', kg: 250 });
const destroyed = (): void => bus.emit('asteroid:destroyed', { asteroidId: ROCK });

let live: Audio[] = [];
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.refuseResume = false;
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  errors = vi.spyOn(console, 'error');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  // Every Audio is disposed with its test: no bus listener outlives it.
  for (const a of live.splice(0)) a.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** An Audio, initialised; unlocked (started) unless `locked`. */
async function rig(o: { locked?: boolean } = {}) {
  const audio = new Audio();
  live.push(audio);
  audio.init(ctx);
  if (!o.locked) await audio.start();
  const ac = (): FakeAudioContext | undefined => FakeAudioContext.instances[0];
  /** A few control ticks of wall time (a tone may be driven from the 30 Hz tick). */
  const settle = (frames = 4): void => {
    for (let i = 0; i < frames; i++) {
      const c = ac();
      if (c) c.currentTime += 1 / 30;
      audio.update(1 / 30, ctx);
    }
  };
  settle();
  const mining = (): number => audibleAt(ac(), MINING_TONE_HZ);
  const action = (): number => audibleAt(ac(), ACTION_TONE_HZ);
  const modeChange = (from: Mode, to: Mode): void => (audio as GameModule).onModeChange?.(from, to, ctx);
  return { audio, ac, settle, mining, action, modeChange };
}

/** Every event this task adds sound to, plus the module's own life calls. */
function everything(a: Awaited<ReturnType<typeof rig>>): void {
  started();
  bite();
  for (let i = 0; i < 10; i++) bite();
  destroyed();
  ended('rock-depleted');
  started();
  ended('interrupted');
  emitAction('action:started', { kind: 'refine' });
  emitAction('action:ended', { kind: 'refine', ok: true });
  emitAction('action:started', { kind: 'repair' });
  emitAction('action:ended', { kind: 'repair', ok: false });
  a.settle();
  a.modeChange('flight', 'map');
  a.modeChange('map', 'flight');
}

const ALL_ENDS: ReadonlyArray<[ExtractionEnd, string]> = [
  ['stopped', 'B again'],
  ['hold-full', 'a full hold'],
  ['resource-depleted', 'the resource running out'],
  ['rock-depleted', 'the rock running out'],
  ['range', 'a broken requirement: out of range'],
  ['speed', 'a broken requirement: too fast'],
  ['no-target', 'a broken requirement: the target dropped'],
  ['busy', 'busy'],
  ['interrupted', 'pause, freeze, cruise, a jump, the beacon, another rock or leaving flight (Mining ends it "interrupted")'],
];

// ---------------------------------------------------------------------------

describe('the mining tone — held while an extraction runs (plan 5 task 7)', () => {
  it('Given a running context and nothing underway, Then neither the mining tone nor the refine/repair tone is audible (they are not part of the ambient bed)', async () => {
    const a = await rig();
    expect(a.ac()?.state).toBe('running');
    expect(a.mining()).toBe(0);
    expect(a.action()).toBe(0);
  });

  it('Given a running context, When mining:started, Then a tone at MINING_TONE_HZ is audible, and the refine/repair tone is not', async () => {
    const a = await rig();
    started();
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    expect(a.action()).toBe(0);
  });

  for (const [end, why] of ALL_ENDS) {
    it(`Given the mining tone held, When mining:ended { end: '${end}' } (${why}), Then it is silent and no voice is left running`, async () => {
      const a = await rig();
      const base = liveSources(a.ac()!);
      started();
      a.settle();
      expect(a.mining()).toBeGreaterThan(0);
      ended(end);
      a.settle();
      expect(a.mining()).toBe(0);
      expect(liveSources(a.ac()!)).toBe(base);
    });
  }

  it('Given mining:started twice with no end between, Then the tone is not stacked (as many oscillators sound as after one start), and one mining:ended silences it', async () => {
    const one = await rig();
    started();
    one.settle();
    const single = one.mining();
    const singleLive = liveSources(one.ac()!);
    expect(single).toBeGreaterThan(0);
    started();
    one.settle();
    expect(one.mining()).toBe(single);
    expect(liveSources(one.ac()!)).toBe(singleLive);
    ended('stopped');
    one.settle();
    expect(one.mining()).toBe(0);
  });

  it('Given five extractions back to back, Then each is heard exactly like the first, and after the last no voice is left running', async () => {
    const a = await rig();
    const base = liveSources(a.ac()!);
    started();
    a.settle();
    const single = a.mining();
    expect(single).toBeGreaterThan(0);
    ended('hold-full');
    for (let i = 0; i < 4; i++) {
      started(); // in the same frame as the previous end, as B pressed the next frame can be
      a.settle();
      expect(a.mining()).toBe(single);
      ended('stopped');
    }
    a.settle();
    expect(a.mining()).toBe(0);
    expect(liveSources(a.ac()!)).toBe(base);
  });

  it('Given no extraction, When a stray mining:ended arrives, Then no error and nothing is audible', async () => {
    const a = await rig();
    ended('interrupted');
    a.settle();
    expect(a.mining()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('no hanging tone — the audio stops its tones on its own (F5: Mining.dispose() sends no mining:ended)', () => {
  const LEAVE: readonly Mode[] = ['map', 'yard', 'title', 'review', 'photo'];
  for (const to of LEAVE) {
    it(`Given the mining and refine tones held, When the game leaves flight for ${to} and no mining:ended or action:ended ever comes, Then both are silent`, async () => {
      const a = await rig();
      started();
      emitAction('action:started', { kind: 'refine' });
      a.settle();
      expect(a.mining()).toBeGreaterThan(0);
      expect(a.action()).toBeGreaterThan(0);
      a.modeChange('flight', to);
      a.settle();
      expect(a.mining()).toBe(0);
      expect(a.action()).toBe(0);
    });
  }

  it('Given the tone stopped by leaving flight, When the game returns to flight, Then it does not come back by itself', async () => {
    const a = await rig();
    started();
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    a.modeChange('flight', 'map');
    a.modeChange('map', 'flight');
    a.settle();
    expect(a.mining()).toBe(0);
  });

  it('Given the mining tone held, When the ship leaves the system (system:left) with no mining:ended, Then it is silent', async () => {
    const a = await rig();
    started();
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    bus.emit('system:left', { system: {} as StarSystemSpec });
    a.settle();
    expect(a.mining()).toBe(0);
  });

  it('Given the mining and refine tones held, When the audio module is disposed, Then nothing sounds (every source stopped, or the context closed)', async () => {
    const a = await rig();
    started();
    emitAction('action:started', { kind: 'repair' });
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    expect(a.action()).toBeGreaterThan(0);
    const c = a.ac()!;
    a.audio.dispose();
    expect(c.state === 'closed' || liveSources(c) === 0).toBe(true);
    expect(audibleAt(c, MINING_TONE_HZ)).toBe(0);
    expect(audibleAt(c, ACTION_TONE_HZ)).toBe(0);
  });

  it('Given a disposed audio module, When every mining event arrives afterwards, Then no error, no node is created and nothing sounds', async () => {
    const a = await rig();
    started();
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    const c = a.ac()!;
    a.audio.dispose();
    const nodes = c.nodes.length;
    started();
    bite();
    destroyed();
    emitAction('action:started', { kind: 'refine' });
    ended('stopped');
    emitAction('action:ended', { kind: 'refine', ok: true });
    expect(c.nodes.length).toBe(nodes);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('one short sound per bite, at most one per 0.06 s (plan 5 task 7)', () => {
  it('Given a running context, When one mining:bite arrives, Then a short sound plays (a new voice, and it is not a held tone)', async () => {
    const a = await rig();
    const c = a.ac()!;
    const base = liveSources(c);
    const mark = c.nodes.length;
    bite();
    expect(voicesSince(c, mark)).toBeGreaterThan(0);
    a.settle();
    expect(liveSources(c)).toBe(base);
    expect(a.mining()).toBe(0);
  });

  it('Given ten bites in one frame (time compression), Then they make no more voices than one bite does', async () => {
    const a = await rig();
    const c = a.ac()!;
    let mark = c.nodes.length;
    bite();
    const one = voicesSince(c, mark);
    expect(one).toBeGreaterThan(0);
    c.currentTime += 1;
    mark = c.nodes.length;
    for (let i = 0; i < 10; i++) bite();
    const ten = voicesSince(c, mark);
    expect(ten).toBeGreaterThan(0);
    expect(ten).toBeLessThanOrEqual(one);
  });

  it('Given a bite just sounded, When another comes 0.05 s later, Then it is silent; When one comes 0.061 s after the first, Then it sounds', async () => {
    const a = await rig();
    const c = a.ac()!;
    c.currentTime = 5;
    bite();
    let mark = c.nodes.length;
    c.currentTime = 5.05;
    bite();
    expect(voicesSince(c, mark)).toBe(0);
    mark = c.nodes.length;
    c.currentTime = 5.061;
    bite();
    expect(voicesSince(c, mark)).toBeGreaterThan(0);
  });
});

describe('the break-up — a deeper sound (plan 5 task 7)', () => {
  it('Given a bite in this very instant, When asteroid:destroyed arrives in the same instant (Mining sends both in one frame), Then the break-up still sounds', async () => {
    const a = await rig();
    const c = a.ac()!;
    c.currentTime = 3;
    bite();
    const mark = c.nodes.length;
    destroyed();
    expect(voicesSince(c, mark)).toBeGreaterThan(0);
  });

  it("Given a bite and a break-up, Then the break-up's lowest pitch is below the bite's", async () => {
    const a = await rig();
    const c = a.ac()!;
    c.currentTime = 3;
    let mark = c.nodes.length;
    bite();
    const biteLow = lowestPitchSince(c, mark);
    c.currentTime = 4;
    mark = c.nodes.length;
    destroyed();
    const breakLow = lowestPitchSince(c, mark);
    expect(Number.isFinite(breakLow)).toBe(true);
    expect(breakLow).toBeLessThan(biteLow);
  });
});

describe('the refine/repair tone — held while the action runs (plan 5 task 7)', () => {
  for (const kind of ['refine', 'repair'] as const) {
    it(`Given a running context, When action:started { kind: '${kind}' }, Then a tone at ACTION_TONE_HZ is audible, and the mining tone is not`, async () => {
      const a = await rig();
      emitAction('action:started', { kind });
      a.settle();
      expect(a.action()).toBeGreaterThan(0);
      expect(a.mining()).toBe(0);
    });

    for (const ok of [true, false]) {
      it(`Given the ${kind} tone held, When action:ended { kind: '${kind}', ok: ${ok} } (${ok ? 'completed' : 'aborted'}), Then it is silent and no voice is left running`, async () => {
        const a = await rig();
        const base = liveSources(a.ac()!);
        emitAction('action:started', { kind });
        a.settle();
        expect(a.action()).toBeGreaterThan(0);
        emitAction('action:ended', { kind, ok });
        a.settle();
        expect(a.action()).toBe(0);
        expect(liveSources(a.ac()!)).toBe(base);
      });
    }
  }

  it('Given action:started twice with no end between, Then the tone is not stacked, and one action:ended silences it', async () => {
    const a = await rig();
    emitAction('action:started', { kind: 'refine' });
    a.settle();
    const single = a.action();
    const singleLive = liveSources(a.ac()!);
    expect(single).toBeGreaterThan(0);
    emitAction('action:started', { kind: 'repair' });
    a.settle();
    expect(a.action()).toBe(single);
    expect(liveSources(a.ac()!)).toBe(singleLive);
    emitAction('action:ended', { kind: 'repair', ok: true });
    a.settle();
    expect(a.action()).toBe(0);
  });

  it('Given both tones held, Then each stops only with its own end: action:ended leaves the mining tone, mining:ended leaves the refine tone', async () => {
    const a = await rig();
    started();
    emitAction('action:started', { kind: 'refine' });
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    expect(a.action()).toBeGreaterThan(0);
    emitAction('action:ended', { kind: 'refine', ok: true });
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    expect(a.action()).toBe(0);
    emitAction('action:started', { kind: 'repair' });
    ended('stopped');
    a.settle();
    expect(a.mining()).toBe(0);
    expect(a.action()).toBeGreaterThan(0);
  });
});

describe('audio off, or not yet unlocked by the browser (plan 5 task 7)', () => {
  it('Given no Web Audio at all, When every mining and action event arrives, Then no error and nothing throws', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const a = await rig();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(() => everything(a)).not.toThrow();
    expect(() => a.audio.dispose()).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given audio not yet unlocked (no gesture: start() never called), When every mining and action event arrives, Then no error and no AudioContext is made', async () => {
    const a = await rig({ locked: true });
    expect(() => everything(a)).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given an extraction and a refine that both started and ended while audio was locked, When the browser unlocks it, Then neither tone sounds (nothing was left pending)', async () => {
    const a = await rig({ locked: true });
    started();
    emitAction('action:started', { kind: 'refine' });
    a.settle();
    ended('stopped');
    emitAction('action:ended', { kind: 'refine', ok: true });
    a.settle();
    await a.audio.start();
    a.settle();
    expect(a.ac()?.state).toBe('running');
    expect(a.mining()).toBe(0);
    expect(a.action()).toBe(0);
  });

  // Choice (phase A): a held tone follows the game's state, as the engine,
  // cruise bed and hull hum already do when the context arrives late. An
  // extraction still underway when audio unlocks is heard from then on.
  it('Given an extraction that started while audio was locked and is still underway, When the browser unlocks it, Then its tone is heard from then on, and it stops at mining:ended', async () => {
    const a = await rig({ locked: true });
    started();
    a.settle();
    await a.audio.start();
    a.settle();
    expect(a.mining()).toBeGreaterThan(0);
    ended('stopped');
    a.settle();
    expect(a.mining()).toBe(0);
  });

  it('Given a context the browser keeps suspended, When every mining and action event arrives, Then no error, no bite voice is made and nothing sounds', async () => {
    FakeAudioContext.refuseResume = true;
    const a = await rig();
    const c = a.ac()!;
    expect(c.state).toBe('suspended');
    const mark = c.nodes.length;
    for (let i = 0; i < 5; i++) {
      c.currentTime += 0.2;
      bite();
    }
    expect(voicesSince(c, mark)).toBe(0);
    expect(() => everything(a)).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
  });

  it('Given a suspended context during a whole extraction, When it finally runs, Then the ended extraction is not heard', async () => {
    FakeAudioContext.refuseResume = true;
    const a = await rig();
    started();
    for (let i = 0; i < 3; i++) bite();
    ended('hold-full');
    a.settle();
    FakeAudioContext.refuseResume = false;
    await a.audio.start();
    a.settle();
    expect(a.ac()?.state).toBe('running');
    expect(a.mining()).toBe(0);
  });

  it('Given the master volume at 0, When every mining and action event arrives, Then no error', async () => {
    const a = await rig();
    a.audio.setMasterVolume(0);
    expect(() => everything(a)).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
  });
});
