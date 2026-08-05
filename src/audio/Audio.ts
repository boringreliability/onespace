/**
 * ===========================================================================
 * oneSpace — procedural audio.
 *
 * Nothing is downloaded. Every sound in the game is synthesised by the Web
 * Audio API from oscillators and one deterministically generated noise buffer.
 * Even the reverb tail is manufactured: the impulse response is noise shaped
 * by an exponential decay and a progressively darkening one-pole filter, which
 * is what a real room does to a click anyway.
 *
 * SIGNAL GRAPH
 * ------------
 *
 *  ENGINE (layered — one oscillator sounds like a toy)
 *    sine   sub      f/2   ─┐   the weight you feel in your chest
 *    tri    fundamental f  ─┤   the body of the reactor
 *    saw    mid    f*2.51  ─┼─▶ engLp (lowpass, cutoff opens with throttle)
 *    saw    bright f*5.02  ─┤     └▶ engHp (18 Hz, keeps DC out of the limiter)
 *    pink noise ▶ engNoiseBp ─┘        └▶ engOut ─────────────────────┐
 *      · f is deliberately multiplied by non-integers so the layers                │
 *        beat against each other instead of fusing into one buzzy tone.            │
 *      · three ultra-slow LFOs (0.071 / 0.13 / 4.7 Hz) trim the layers'            │
 *        detune so the sound never sits still. A static engine reads as            │
 *        "digital" within about four seconds.                                      │
 *                                                                                  │
 *  ATMOSPHERE (air pressure, not wind)                                             │
 *    pink noise ▶ atmBp (centre rises, bandwidth WIDENS with density·v²)           │
 *                   └▶ atmPeak (resonant formant, climbs with speed) ▶ atmOut ─────┤
 *                                                                                  │
 *  SPACE AMBIENCE (the noir)                                                       │
 *    4 detuned oscillators at a wide open voicing (1 : 1.5 : 2.996 : 4.49)         │
 *      each ▶ its own gain, breathed on by an LFO at 0.0071–0.0173 Hz              │
 *      each ▶ its own stereo position                                              │
 *        └▶ droneLp (cutoff drifts on a sum of incommensurate sines, so the        │
 *            texture never repeats) ▶ droneOut ─┬─▶ droneDry ────────────────────┤
 *                                               └─▶ droneWet ▶ reverbSend ─┐      │
 *                                                                          │      │
 *  PROXIMITY (mass, felt before it is seen)                                 │      │
 *    sine ~18–30 Hz + a 2.51× partial ▶ proxLp ▶ proxOut ──────────────────┼──────┤
 *      gain follows the body's angular radius, weighted by its physical     │      │
 *      size — a gas giant announces itself far earlier than a moon.         │      │
 *                                                                          │      │
 *  WARP (four beats: charge · engage · tunnel · arrival)                    │      │
 *    warpSub  sine 22→56 Hz, gain ∝ progress²        ▶ warpSubLp ──────────┼──────┤
 *    warpBed  pink noise ▶ warpBp (swept bandpass)   ▶ warpBedG ──────────┤      │
 *    engage/arrival transients are one-shot voices, arrival goes wet ──────┤      │
 *                                                                          │      │
 *  UI  one-shot blips ▶ uiOut ▶ uiHp (dry, clicky, quiet) ─────────────────┼──────┤
 *                                                                          │      │
 *    reverbSend ▶ convolver(procedural IR) ▶ reverbReturn ─────────────────┘      │
 *                                                                                 │
 *  MASTER  sum ─┴─▶ limiter (compressor, ratio 20:1) ▶ clip (tanh waveshaper,
 *                    an absolute ceiling nothing can cross) ▶ master ▶ speakers
 *
 * FEEL
 * ----
 * Every continuous parameter is moved with `setTargetAtTime`, never by writing
 * `.value`. Direct assignment steps the parameter between render quanta and
 * you hear the step as zipper noise. `setTargetAtTime` is a one-pole filter
 * running on the audio thread: it is exactly the critical damping the rest of
 * the game uses, and it is free.
 *
 * Targets are recomputed on a 30 Hz control tick, not per frame, and only
 * pushed to the graph when they actually moved — the smoothing lives in the
 * audio thread, so the control rate is irrelevant to how it sounds.
 * ===========================================================================
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { Rng } from '@/math/rng';
import type { GameScale } from '@/gen/types';

// --- Time constants for setTargetAtTime, in seconds. -----------------------
// These ARE the feel. A time constant is how long the parameter takes to cover
// 63% of the remaining distance; audibly "settled" is about 4× that.
const TC_ENGINE_GAIN = 0.30;
const TC_ENGINE_PITCH = 0.65; // a heavy turbine spools; it does not step
const TC_ENGINE_FILTER = 0.40;
const TC_ATMOS = 0.45;
const TC_PROX = 1.40; // mass arrives slowly or it is not mass
const TC_DRONE = 4.00;
const TC_MASTER = 0.12;
const TC_WARP_FAST = 0.10;
const TC_WARP_TAIL = 2.20;

/** Control-rate period. Targets change 30×/s; the audio thread interpolates. */
const CONTROL_DT = 1 / 30;

/** Speed, in km/s, at which atmospheric pressure noise is considered maximal. */
const ATMOS_REF_SPEED = 2.4;

const DRONE_VOICES = 4;
/** Wide, open voicing. 2.996 and 4.49 are near-but-not-exactly harmonic so the
 *  upper voices beat slowly against the root instead of locking to it. */
const DRONE_RATIOS = [1, 1.5, 2.996, 4.49] as const;
const DRONE_BASE_GAIN = [0.085, 0.062, 0.042, 0.028] as const;
/** Breathing rates, in Hz. Mutually incommensurate: the combined pattern does
 *  not repeat for hours, which is what "non-periodic" means in practice. */
const DRONE_LFO_HZ = [0.0071, 0.0113, 0.0173, 0.0091] as const;
const DRONE_PAN = [-0.55, 0.42, -0.28, 0.66] as const;
/** Root of the drone, Hz. Low E-ish — below the ship, under everything. */
const DRONE_ROOT = 41.2;

type WarpPhase = 'idle' | 'charging' | 'tunnel' | 'arriving';

/**
 * Every long-lived node, created once in `start()`. Held in one object so
 * "has the graph been built" is a single null check and teardown is one place.
 */
interface Graph {
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly clip: WaveShaperNode;
  readonly sum: GainNode;
  readonly reverb: ConvolverNode;
  readonly reverbSend: GainNode;
  readonly reverbReturn: GainNode;

  readonly engSub: OscillatorNode;
  readonly engSubG: GainNode;
  readonly engFund: OscillatorNode;
  readonly engFundG: GainNode;
  readonly engMid: OscillatorNode;
  readonly engMidG: GainNode;
  readonly engBright: OscillatorNode;
  readonly engBrightG: GainNode;
  readonly engNoise: AudioBufferSourceNode;
  readonly engNoiseBp: BiquadFilterNode;
  readonly engNoiseG: GainNode;
  readonly engLp: BiquadFilterNode;
  readonly engHp: BiquadFilterNode;
  readonly engOut: GainNode;

  readonly atmNoise: AudioBufferSourceNode;
  readonly atmBp: BiquadFilterNode;
  readonly atmPeak: BiquadFilterNode;
  readonly atmOut: GainNode;

  readonly droneOsc: OscillatorNode[];
  readonly droneG: GainNode[];
  readonly droneLp: BiquadFilterNode;
  readonly droneOut: GainNode;
  readonly droneDry: GainNode;
  readonly droneWet: GainNode;

  readonly proxOsc: OscillatorNode;
  readonly proxOscG: GainNode;
  readonly proxPartial: OscillatorNode;
  readonly proxPartialG: GainNode;
  readonly proxLp: BiquadFilterNode;
  readonly proxOut: GainNode;

  readonly warpSub: OscillatorNode;
  readonly warpSubG: GainNode;
  readonly warpSubLp: BiquadFilterNode;
  readonly warpBed: AudioBufferSourceNode;
  readonly warpBp: BiquadFilterNode;
  readonly warpBedG: GainNode;

  readonly uiOut: GainNode;
  readonly uiHp: BiquadFilterNode;

  /** Everything that must be stopped before the context is closed. */
  readonly sources: AudioScheduledSourceNode[];
  readonly noiseBuffer: AudioBuffer;
}

export class Audio implements GameModule {
  readonly name = 'audio';

  private ac: AudioContext | null = null;
  private g: Graph | null = null;
  private starting: Promise<void> | null = null;

  // --- control state, written by the setters, read by the control tick -----
  private throttle = 0;
  private boost = 0;
  private atmDensity = 0;
  private atmSpeed = 0;
  private proxPresence = 0;
  private proxSize = 0;
  private masterVolume = 0.8;
  private scale: GameScale = 'system';

  private warpPhase: WarpPhase = 'idle';
  private warpCharge = 0;
  private warpTail = 0;
  /** Extra drone level that blooms on warp arrival and decays away. */
  private droneBloom = 0;

  /**
   * Until something calls `setEngine` (or the bus reports a throttle change)
   * we drive the engine straight from the pilot's input, so the module is
   * audible the moment it is registered, with or without a flight model.
   */
  private engineDriven = false;

  private controlAcc = 0;
  private driftT = 0;
  private audioTime = 0;
  /** Last target pushed to each AudioParam — lets us skip redundant events. */
  private lastTargets = new Map<AudioParam, number>();

  private offs: Array<() => void> = [];
  private disarmGesture: (() => void) | null = null;
  private voices = 0;
  private lastLogBlip = -1;
  private disposed = false;
  private suspendTimer = 0;

  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) this.sleep();
    else this.wake();
  };

  private onGesture = (): void => {
    void this.start();
  };

  // -------------------------------------------------------------------------
  // GameModule lifecycle
  // -------------------------------------------------------------------------

  init(_ctx: EngineContext): void {
    this.subscribe();

    // A browser will not let audio run before the user touches the page, so we
    // arm ourselves on the first gesture. The integrator may also call start()
    // directly from their own "click to fly" handler; start() is idempotent.
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onGesture);
      window.addEventListener('keydown', this.onGesture);
      this.disarmGesture = () => {
        window.removeEventListener('pointerdown', this.onGesture);
        window.removeEventListener('keydown', this.onGesture);
        this.disarmGesture = null;
      };
      this.offs.push(() => this.disarmGesture?.());
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.offs.push(() => document.removeEventListener('visibilitychange', this.onVisibility));
    }
  }

  /**
   * Build the audio context and the whole graph. Must be reached from a user
   * gesture; calling it twice is harmless and calling it while suspended
   * resumes instead.
   */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.ac) {
      if (this.ac.state === 'suspended') await this.ac.resume();
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.build();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async build(): Promise<void> {
    const Ctor = pickAudioContext();
    if (!Ctor) {
      console.warn('[Audio] Web Audio unavailable — running silent');
      this.disarmGesture?.();
      return;
    }
    const ac = new Ctor({ latencyHint: 'interactive' });
    this.ac = ac;
    this.disarmGesture?.();
    this.g = buildGraph(ac);
    this.audioTime = ac.currentTime;

    // Master starts silent and fades in: a context that begins at full gain
    // pops, and the first thing the player hears should arrive, not appear.
    this.g.master.gain.setValueAtTime(0, ac.currentTime);
    this.g.master.gain.setTargetAtTime(this.masterVolume, ac.currentTime, 0.9);
    this.lastTargets.set(this.g.master.gain, this.masterVolume);

    if (ac.state === 'suspended') await ac.resume();
    this.tick(CONTROL_DT);
  }

  update(dt: number, ctx: EngineContext): void {
    const g = this.g;
    const ac = this.ac;
    if (!g || !ac || ac.state !== 'running') return;

    if (!this.engineDriven) {
      // Fallback control source: the pilot's own hands. Deliberately isDown()
      // and not held() — held() walks Object.entries and would allocate here.
      this.throttle = ctx.input.axes.throttle;
      this.boost = ctx.input.isDown('ShiftLeft') || ctx.input.isDown('ShiftRight') ? 1 : 0;
    }

    this.driftT += dt;
    if (this.warpTail > 0) this.warpTail -= dt;
    if (this.droneBloom > 0) this.droneBloom = Math.max(0, this.droneBloom - dt * 0.16);
    if (this.suspendTimer > 0) {
      this.suspendTimer -= dt;
      if (this.suspendTimer <= 0 && typeof document !== 'undefined' && document.hidden) {
        void ac.suspend();
      }
    }

    this.controlAcc += dt;
    if (this.controlAcc < CONTROL_DT) return;
    // Never run more than a handful of catch-up ticks after a stall.
    const steps = Math.min(4, Math.floor(this.controlAcc / CONTROL_DT));
    this.controlAcc -= steps * CONTROL_DT;
    this.tick(steps * CONTROL_DT);
  }

  dispose(): void {
    this.disposed = true;
    for (let i = 0; i < this.offs.length; i++) this.offs[i]!();
    this.offs.length = 0;

    const g = this.g;
    const ac = this.ac;
    if (g && ac) {
      const t = ac.currentTime;
      for (let i = 0; i < g.sources.length; i++) {
        const s = g.sources[i]!;
        try {
          s.stop(t);
        } catch {
          // Already stopped; a double stop is not an error worth surfacing.
        }
        s.disconnect();
      }
      g.master.disconnect();
      g.sum.disconnect();
      g.reverb.disconnect();
    }
    this.lastTargets.clear();
    this.g = null;
    if (ac && ac.state !== 'closed') void ac.close();
    this.ac = null;
  }

  // -------------------------------------------------------------------------
  // Public control surface
  // -------------------------------------------------------------------------

  /**
   * @param throttle 0..1 main engine demand.
   * @param boost    0..1 overdrive; adds a brighter layer and opens the filter.
   */
  setEngine(throttle: number, boost: number): void {
    this.engineDriven = true;
    this.throttle = clamp01(throttle);
    this.boost = clamp01(boost);
  }

  /**
   * @param density 0..1, atmospheric density relative to sea level.
   * @param speed   km/s through that atmosphere.
   */
  setAtmosphere(density: number, speed: number): void {
    this.atmDensity = clamp01(density);
    this.atmSpeed = finite(speed) ? Math.max(0, speed) : 0;
  }

  /**
   * The subharmonic of a nearby mass. Pass the nearest significant body only.
   * @param nearestBodyDistanceKm centre-to-ship distance in km.
   * @param bodyRadiusKm          that body's radius in km; <= 0 silences it.
   */
  setProximity(nearestBodyDistanceKm: number, bodyRadiusKm: number): void {
    if (!finite(nearestBodyDistanceKm) || !finite(bodyRadiusKm) || bodyRadiusKm <= 0) {
      this.proxPresence = 0;
      return;
    }
    const r = bodyRadiusKm;
    const d = Math.max(nearestBodyDistanceKm, r);
    // sin of the angular radius: 1 at the surface, ~0 far away. This, not raw
    // distance, is what "looming" means — it is how big the thing looks.
    const subtend = r / d;
    // A 70 000 km gas giant should be felt from much further out than a 1 700 km
    // moon, so weight by physical size on a log scale.
    this.proxSize = clamp01(Math.log(1 + r / 900) / Math.log(1 + 80));
    this.proxPresence = clamp01(Math.pow(clamp01(subtend * 1.3), 1.6) * (0.35 + 0.65 * this.proxSize));
  }

  /** 0..1. Safe to call before start(). */
  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    const g = this.g;
    const ac = this.ac;
    if (!g || !ac) return;
    this.audioTime = ac.currentTime;
    this.set(g.master.gain, this.masterVolume, TC_MASTER);
  }

  /** True once the graph exists and the context is running. */
  get running(): boolean {
    return this.ac?.state === 'running' && this.g !== null;
  }

  // -------------------------------------------------------------------------
  // Control tick — the only place continuous targets are written
  // -------------------------------------------------------------------------

  private tick(dt: number): void {
    const g = this.g;
    const ac = this.ac;
    if (!g || !ac) return;
    this.audioTime = ac.currentTime;
    const t = this.driftT;

    // --- engine ------------------------------------------------------------
    const th = this.throttle;
    const bo = this.boost;
    const drive = th + bo * 0.45;

    const fund = 26 + drive * 54;
    this.set(g.engSub.frequency, fund * 0.5, TC_ENGINE_PITCH);
    this.set(g.engFund.frequency, fund, TC_ENGINE_PITCH);
    this.set(g.engMid.frequency, fund * 2.51, TC_ENGINE_PITCH);
    this.set(g.engBright.frequency, fund * 5.02, TC_ENGINE_PITCH);

    // Idle terms are non-zero on purpose: a reactor at rest still hums, and
    // silence at zero throttle makes the ship feel switched off rather than
    // coasting.
    this.set(g.engSubG.gain, 0.10 + th * 0.22, TC_ENGINE_GAIN);
    this.set(g.engFundG.gain, 0.06 + th * 0.20, TC_ENGINE_GAIN);
    this.set(g.engMidG.gain, 0.014 + th * 0.070, TC_ENGINE_GAIN);
    this.set(g.engBrightG.gain, bo * 0.075, TC_ENGINE_GAIN);
    this.set(g.engNoiseG.gain, 0.020 + th * 0.150 + bo * 0.090, TC_ENGINE_GAIN);

    this.set(g.engNoiseBp.frequency, 340 + drive * 1400, TC_ENGINE_FILTER);
    this.set(g.engLp.frequency, 180 + drive * 2600 + bo * 1800, TC_ENGINE_FILTER);
    // Resonance climbs slightly under load — the character of a machine
    // approaching the edge of what it was built for.
    this.set(g.engLp.Q, 0.7 + drive * 0.9, TC_ENGINE_FILTER);

    // --- atmosphere --------------------------------------------------------
    const v = this.atmSpeed / ATMOS_REF_SPEED;
    const q = clamp01(this.atmDensity * v * v);
    this.set(g.atmOut.gain, q * 0.42, TC_ATMOS);
    this.set(g.atmBp.frequency, 260 + q * 2400, TC_ATMOS);
    // Lower Q = wider band. Pressure builds by getting *broader*, not shriller.
    this.set(g.atmBp.Q, 1.7 - q * 1.15, TC_ATMOS);
    this.set(g.atmPeak.frequency, 900 + q * 2600, TC_ATMOS);
    this.set(g.atmPeak.gain, q * 14, TC_ATMOS);
    this.set(g.atmPeak.Q, 3 + q * 5, TC_ATMOS);

    // --- proximity ---------------------------------------------------------
    const p = this.proxPresence;
    // Bigger reads as lower. 18 Hz is below most speakers, hence the partial.
    this.set(g.proxOsc.frequency, 30 - p * 12, TC_PROX);
    this.set(g.proxPartial.frequency, (30 - p * 12) * 2.51, TC_PROX);
    this.set(g.proxOscG.gain, p * 0.30, TC_PROX);
    this.set(g.proxPartialG.gain, p * 0.085 * (0.4 + 0.6 * this.proxSize), TC_PROX);
    this.set(g.proxLp.frequency, 90 + p * 150, TC_PROX);

    // --- drone -------------------------------------------------------------
    // Sum of incommensurate sines: bounded, smooth, and never repeating.
    const drift = Math.sin(t * 0.0190) * 0.5 + Math.sin(t * 0.0071 + 1.3) * 0.33 + Math.sin(t * 0.0037 + 2.7) * 0.17;
    const openness = this.scaleOpenness();
    this.set(g.droneLp.frequency, (230 + drift * 150) * (0.7 + openness * 0.75), TC_DRONE);
    this.set(g.droneOut.gain, 0.22 + this.droneBloom, TC_DRONE);
    this.set(g.droneWet.gain, 0.35 + openness * 0.55, TC_DRONE);
    this.set(g.droneDry.gain, 0.55 - openness * 0.22, TC_DRONE);
    for (let i = 0; i < DRONE_VOICES; i++) {
      // Voices drift apart and back together over minutes; the beating between
      // them is most of what makes the drone feel alive rather than held.
      const cents = Math.sin(t * (0.0043 + i * 0.0017) + i * 1.7) * (5 + i * 3);
      this.set(g.droneOsc[i]!.detune, cents, TC_DRONE);
      this.set(g.droneG[i]!.gain, DRONE_BASE_GAIN[i]! * (0.6 + openness * 0.6), TC_DRONE);
    }

    // --- warp --------------------------------------------------------------
    this.tickWarp(g, t, dt);
  }

  private tickWarp(g: Graph, t: number, _dt: number): void {
    switch (this.warpPhase) {
      case 'charging': {
        const c = this.warpCharge;
        this.set(g.warpSub.frequency, 22 + c * 34, 0.35);
        this.set(g.warpSubG.gain, c * c * 0.34, 0.25);
        this.set(g.warpSubLp.frequency, 60 + c * 320, 0.35);
        this.set(g.warpSubLp.Q, 1 + c * 7, 0.35);
        this.set(g.warpBedG.gain, c * 0.05, 0.4);
        this.set(g.warpBp.frequency, 200 + c * 400, 0.4);
        break;
      }
      case 'tunnel': {
        // Two sweeps at unrelated rates: the bed rushes without ever settling
        // into a rhythm you could tap along to.
        const f = 420 + Math.sin(t * 0.37) * 260 + Math.sin(t * 0.91 + 0.7) * 150;
        this.set(g.warpBp.frequency, f, 0.30);
        this.set(g.warpBp.Q, 2.6, 0.5);
        this.set(g.warpBedG.gain, 0.26, 0.8);
        this.set(g.warpSubG.gain, 0.18, 0.8);
        this.set(g.warpSub.frequency, 34 + Math.sin(t * 0.13) * 6, 1.2);
        this.set(g.warpSubLp.frequency, 220, 1.0);
        break;
      }
      case 'arriving': {
        this.set(g.warpBedG.gain, 0, TC_WARP_TAIL);
        this.set(g.warpSubG.gain, 0, TC_WARP_TAIL * 0.7);
        this.set(g.warpBp.frequency, 180, TC_WARP_TAIL);
        if (this.warpTail <= 0) this.warpPhase = 'idle';
        break;
      }
      case 'idle':
      default:
        break;
    }
  }

  /** How wide and wet the ambience should be for the current game scale. */
  private scaleOpenness(): number {
    switch (this.scale) {
      case 'surface':
        return 0.15;
      case 'orbit':
        return 0.45;
      case 'system':
        return 0.7;
      case 'interstellar':
        return 0.9;
      case 'intergalactic':
        return 1;
      default:
        return 0.7;
    }
  }

  // -------------------------------------------------------------------------
  // Bus wiring
  // -------------------------------------------------------------------------

  private subscribe(): void {
    this.offs.push(
      bus.on('throttle:changed', ({ value }) => {
        this.engineDriven = true;
        this.throttle = clamp01(value);
      }),

      bus.on('scale:changed', ({ to }) => {
        this.scale = to;
      }),

      bus.on('log', ({ tone }) => {
        const ac = this.ac;
        if (!ac) return;
        // Log lines arrive in bursts; a blip per line becomes a machine gun.
        if (ac.currentTime - this.lastLogBlip < 0.06) return;
        this.lastLogBlip = ac.currentTime;
        if (tone === 'warn') {
          this.blip(880, 0.09, 0.055, 'square');
          this.blip(660, 0.13, 0.045, 'square', 0.055);
        } else if (tone === 'good') {
          this.blip(1320, 0.07, 0.040, 'triangle');
          this.blip(1760, 0.10, 0.035, 'triangle', 0.055);
        } else {
          this.blip(2100, 0.045, 0.028, 'square');
        }
      }),

      bus.on('scan:started', () => {
        this.blip(1480, 0.05, 0.026, 'triangle');
      }),

      bus.on('scan:complete', () => {
        // An instrument confirming, not a game rewarding.
        this.blip(1046, 0.07, 0.032, 'triangle');
        this.blip(1396, 0.07, 0.030, 'triangle', 0.075);
        this.blip(2093, 0.16, 0.026, 'sine', 0.15);
      }),

      bus.on('target:changed', ({ id }) => {
        if (id) {
          this.blip(1760, 0.035, 0.030, 'square');
          this.blip(2640, 0.030, 0.018, 'square', 0.035);
        } else {
          this.blip(620, 0.045, 0.026, 'square');
        }
      }),

      bus.on('warp:charging', ({ progress }) => {
        this.warpCharge = clamp01(progress);
        if (this.warpPhase !== 'charging') {
          this.warpPhase = 'charging';
          this.blip(310, 0.06, 0.030, 'square');
        }
      }),

      bus.on('warp:engaged', () => {
        this.warpPhase = 'tunnel';
        this.warpEngageTransient();
      }),

      bus.on('warp:arrived', () => {
        this.warpPhase = 'arriving';
        this.warpTail = 6;
        this.droneBloom = 0.26;
        this.warpArriveTransient();
      }),

      bus.on('warp:aborted', () => {
        this.warpPhase = 'idle';
        this.warpCharge = 0;
        const g = this.g;
        if (!g || !this.ac) return;
        this.audioTime = this.ac.currentTime;
        this.set(g.warpSubG.gain, 0, 0.35);
        this.set(g.warpBedG.gain, 0, 0.35);
        this.sweep(420, 90, 0.45, 0.06);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // One-shot voices
  //
  // These build two or three nodes and throw them away. That is allocation,
  // but it happens on discrete events, never inside update(), and a one-shot
  // voice cannot suffer zipper noise because nothing modifies it while it
  // sounds — its whole envelope is scheduled up front on the audio thread.
  // -------------------------------------------------------------------------

  private blip(freq: number, dur: number, level: number, type: OscillatorType, delay = 0): void {
    const ac = this.ac;
    const g = this.g;
    if (!ac || !g || ac.state !== 'running') return;
    if (this.voices > 14) return; // a hard ceiling beats a mush of overlaps

    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, t0);
    // 3 ms attack: fast enough to read as a click, slow enough not to pop.
    env.gain.linearRampToValueAtTime(level, t0 + 0.003);
    env.gain.setTargetAtTime(0, t0 + 0.004, dur * 0.30);
    osc.connect(env);
    env.connect(g.uiOut);
    this.voices++;
    osc.onended = () => {
      this.voices--;
      osc.disconnect();
      env.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + dur + 0.12);
  }

  /** A pitched fall — used for aborts and as the spine of the warp transient. */
  private sweep(from: number, to: number, dur: number, level: number, wet = 0): void {
    const ac = this.ac;
    const g = this.g;
    if (!ac || !g || ac.state !== 'running') return;
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(8, to), t0 + dur);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(level, t0 + 0.006);
    env.gain.setTargetAtTime(0, t0 + 0.01, dur * 0.45);
    osc.connect(env);
    env.connect(g.sum);
    if (wet > 0) {
      const send = ac.createGain();
      send.gain.setValueAtTime(wet, t0);
      env.connect(send);
      send.connect(g.reverbSend);
      osc.onended = () => {
        osc.disconnect();
        env.disconnect();
        send.disconnect();
      };
    } else {
      osc.onended = () => {
        osc.disconnect();
        env.disconnect();
      };
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.6);
  }

  /** A filtered noise crack — the physical part of a transient. */
  private crack(centre: number, dur: number, level: number, wet: number): void {
    const ac = this.ac;
    const g = this.g;
    if (!ac || !g || ac.state !== 'running') return;
    const t0 = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = g.noiseBuffer;
    // Start at a deterministic-but-arbitrary offset so repeated cracks are not
    // literally the same waveform.
    src.loopStart = 0;
    src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.setValueAtTime(1.4, t0);
    bp.frequency.setValueAtTime(centre, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, centre * 0.12), t0 + dur);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(level, t0 + 0.004);
    env.gain.setTargetAtTime(0, t0 + 0.006, dur * 0.35);
    src.connect(bp);
    bp.connect(env);
    env.connect(g.sum);
    const send = ac.createGain();
    send.gain.setValueAtTime(wet, t0);
    env.connect(send);
    send.connect(g.reverbSend);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      env.disconnect();
      send.disconnect();
    };
    src.start(t0, (this.driftT * 0.37) % 2.5);
    src.stop(t0 + dur + 0.5);
  }

  private warpEngageTransient(): void {
    // Beat 2: the snap. A bright crack collapsing into a sub, so the ear hears
    // the event and the body hears the mass behind it.
    this.crack(3200, 0.22, 0.34, 0.25);
    this.sweep(760, 42, 0.30, 0.30, 0.2);
  }

  private warpArriveTransient(): void {
    // Beat 4: the room. Mostly wet — the tail is the point, not the hit.
    this.crack(1400, 0.35, 0.20, 0.85);
    this.sweep(180, 30, 1.30, 0.22, 0.9);
  }

  // -------------------------------------------------------------------------
  // Tab visibility
  // -------------------------------------------------------------------------

  private sleep(): void {
    const g = this.g;
    const ac = this.ac;
    if (!g || !ac || ac.state !== 'running') return;
    this.audioTime = ac.currentTime;
    // Fade before suspending: suspend() freezes the graph mid-sample and a
    // frozen non-zero sample is a click on the way out and on the way back.
    this.set(g.master.gain, 0, 0.08);
    this.suspendTimer = 0.35;
    // The frame loop stops in a hidden tab, so also arm a timer that does not
    // depend on update() running.
    setTimeout(() => {
      if (typeof document !== 'undefined' && document.hidden && this.ac?.state === 'running') {
        void this.ac.suspend();
      }
    }, 350);
  }

  private wake(): void {
    const ac = this.ac;
    const g = this.g;
    if (!ac || !g) return;
    this.suspendTimer = 0;
    const resumed = ac.state === 'suspended' ? ac.resume() : Promise.resolve();
    void resumed.then(() => {
      if (this.disposed || !this.g || !this.ac) return;
      this.audioTime = this.ac.currentTime;
      this.set(this.g.master.gain, this.masterVolume, 0.35);
    });
  }

  // -------------------------------------------------------------------------
  // The only way this class writes to an AudioParam.
  // -------------------------------------------------------------------------

  /**
   * Move `param` towards `target` with a one-pole approach of time constant
   * `tc`. Redundant targets are dropped so a held stick does not queue 30
   * automation events per second onto the audio thread for nothing.
   */
  private set(param: AudioParam, target: number, tc: number): void {
    const prev = this.lastTargets.get(param);
    if (prev !== undefined && Math.abs(prev - target) <= 1e-4 * Math.max(1, Math.abs(target))) return;
    this.lastTargets.set(param, target);
    param.setTargetAtTime(target, this.audioTime, tc);
  }
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function buildGraph(ac: AudioContext): Graph {
  const sources: AudioScheduledSourceNode[] = [];
  const t0 = ac.currentTime;

  // --- master chain --------------------------------------------------------
  const master = ac.createGain();
  master.gain.setValueAtTime(0, t0);

  const clip = ac.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = '4x';

  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-8, t0);
  limiter.knee.setValueAtTime(0, t0);
  limiter.ratio.setValueAtTime(20, t0);
  limiter.attack.setValueAtTime(0.003, t0);
  limiter.release.setValueAtTime(0.25, t0);

  const sum = ac.createGain();
  sum.gain.setValueAtTime(1, t0);

  sum.connect(limiter);
  limiter.connect(clip);
  clip.connect(master);
  master.connect(ac.destination);

  // --- reverb (procedural impulse response) --------------------------------
  const reverb = ac.createConvolver();
  reverb.normalize = false; // we normalise the IR ourselves, predictably
  reverb.buffer = makeImpulseResponse(ac, 6.5, 3.1, 0x51a3c0de);
  const reverbSend = ac.createGain();
  reverbSend.gain.setValueAtTime(1, t0);
  const reverbReturn = ac.createGain();
  reverbReturn.gain.setValueAtTime(0.9, t0);
  reverbSend.connect(reverb);
  reverb.connect(reverbReturn);
  reverbReturn.connect(sum);

  // --- shared noise --------------------------------------------------------
  // Pink, not white: white noise through a bandpass hisses, pink roars. Two
  // independent channels make every noise layer stereo for free.
  const noiseBuffer = makeNoiseBuffer(ac, 3.7, 0x0ff5eed1);
  const noiseBufferB = makeNoiseBuffer(ac, 5.3, 0x7ab19c44);

  // --- engine --------------------------------------------------------------
  const engOut = ac.createGain();
  engOut.gain.setValueAtTime(0.55, t0);
  const engHp = ac.createBiquadFilter();
  engHp.type = 'highpass';
  engHp.frequency.setValueAtTime(18, t0);
  const engLp = ac.createBiquadFilter();
  engLp.type = 'lowpass';
  engLp.frequency.setValueAtTime(200, t0);
  engLp.Q.setValueAtTime(0.7, t0);
  engLp.connect(engHp);
  engHp.connect(engOut);
  engOut.connect(sum);

  const engSub = osc(ac, 'sine', 13);
  const engSubG = gain(ac, 0.0001);
  const engFund = osc(ac, 'triangle', 26);
  const engFundG = gain(ac, 0.0001);
  const engMid = osc(ac, 'sawtooth', 65);
  const engMidG = gain(ac, 0.0001);
  const engBright = osc(ac, 'sawtooth', 130);
  const engBrightG = gain(ac, 0.0001);
  connectChain(engSub, engSubG, engLp);
  connectChain(engFund, engFundG, engLp);
  connectChain(engMid, engMidG, engLp);
  connectChain(engBright, engBrightG, engLp);

  const engNoise = looper(ac, noiseBuffer);
  const engNoiseBp = ac.createBiquadFilter();
  engNoiseBp.type = 'bandpass';
  engNoiseBp.frequency.setValueAtTime(340, t0);
  engNoiseBp.Q.setValueAtTime(0.7, t0);
  const engNoiseG = gain(ac, 0.0001);
  engNoise.connect(engNoiseBp);
  engNoiseBp.connect(engNoiseG);
  engNoiseG.connect(engLp);

  // Detune LFOs. Without these the engine is a synth patch; with them it is a
  // machine with bearings in it.
  const engLfoA = osc(ac, 'sine', 0.13);
  const engLfoAG = gain(ac, 11);
  engLfoA.connect(engLfoAG);
  engLfoAG.connect(engMid.detune);

  const engLfoB = osc(ac, 'sine', 0.071);
  const engLfoBG = gain(ac, 6);
  engLfoB.connect(engLfoBG);
  engLfoBG.connect(engFund.detune);

  const engLfoC = osc(ac, 'triangle', 4.7);
  const engLfoCG = gain(ac, 2.5);
  engLfoC.connect(engLfoCG);
  engLfoCG.connect(engBright.detune);
  engLfoCG.connect(engSub.detune);

  sources.push(engSub, engFund, engMid, engBright, engNoise, engLfoA, engLfoB, engLfoC);

  // --- atmosphere ----------------------------------------------------------
  const atmNoise = looper(ac, noiseBufferB);
  const atmBp = ac.createBiquadFilter();
  atmBp.type = 'bandpass';
  atmBp.frequency.setValueAtTime(260, t0);
  atmBp.Q.setValueAtTime(1.7, t0);
  const atmPeak = ac.createBiquadFilter();
  atmPeak.type = 'peaking';
  atmPeak.frequency.setValueAtTime(900, t0);
  atmPeak.Q.setValueAtTime(3, t0);
  atmPeak.gain.setValueAtTime(0, t0);
  const atmOut = gain(ac, 0.0001);
  atmNoise.connect(atmBp);
  atmBp.connect(atmPeak);
  atmPeak.connect(atmOut);
  atmOut.connect(sum);
  sources.push(atmNoise);

  // --- drone ---------------------------------------------------------------
  const droneLp = ac.createBiquadFilter();
  droneLp.type = 'lowpass';
  droneLp.frequency.setValueAtTime(230, t0);
  droneLp.Q.setValueAtTime(0.8, t0);
  const droneOut = gain(ac, 0.0001);
  const droneDry = gain(ac, 0.5);
  const droneWet = gain(ac, 0.6);
  droneLp.connect(droneOut);
  droneOut.connect(droneDry);
  droneOut.connect(droneWet);
  droneDry.connect(sum);
  droneWet.connect(reverbSend);

  const droneOsc: OscillatorNode[] = [];
  const droneG: GainNode[] = [];
  for (let i = 0; i < DRONE_VOICES; i++) {
    const o = osc(ac, i === 0 ? 'sine' : 'triangle', DRONE_ROOT * DRONE_RATIOS[i]!);
    const gN = gain(ac, DRONE_BASE_GAIN[i]!);
    const pan = ac.createStereoPanner();
    pan.pan.setValueAtTime(DRONE_PAN[i]!, t0);
    o.connect(gN);
    gN.connect(pan);
    pan.connect(droneLp);

    // Each voice breathes on its own clock, so no two swells ever coincide
    // twice in the same way.
    const lfo = osc(ac, 'sine', DRONE_LFO_HZ[i]!);
    const lfoG = gain(ac, DRONE_BASE_GAIN[i]! * 0.55);
    lfo.connect(lfoG);
    lfoG.connect(gN.gain); // sums with the intrinsic value, never goes negative

    droneOsc.push(o);
    droneG.push(gN);
    sources.push(o, lfo);
  }

  // --- proximity -----------------------------------------------------------
  const proxLp = ac.createBiquadFilter();
  proxLp.type = 'lowpass';
  proxLp.frequency.setValueAtTime(90, t0);
  proxLp.Q.setValueAtTime(1.2, t0);
  const proxOut = gain(ac, 1);
  proxLp.connect(proxOut);
  proxOut.connect(sum);
  proxOut.connect(reverbSend);

  const proxOsc = osc(ac, 'sine', 30);
  const proxOscG = gain(ac, 0.0001);
  connectChain(proxOsc, proxOscG, proxLp);
  const proxPartial = osc(ac, 'sine', 75);
  const proxPartialG = gain(ac, 0.0001);
  connectChain(proxPartial, proxPartialG, proxLp);

  // A slow tremolo so the mass breathes rather than sits.
  const proxLfo = osc(ac, 'sine', 0.083);
  const proxLfoG = gain(ac, 0.35);
  proxLfo.connect(proxLfoG);
  proxLfoG.connect(proxOut.gain);
  sources.push(proxOsc, proxPartial, proxLfo);

  // --- warp ----------------------------------------------------------------
  const warpSubLp = ac.createBiquadFilter();
  warpSubLp.type = 'lowpass';
  warpSubLp.frequency.setValueAtTime(60, t0);
  warpSubLp.Q.setValueAtTime(1, t0);
  warpSubLp.connect(sum);
  const warpSub = osc(ac, 'sine', 22);
  const warpSubG = gain(ac, 0.0001);
  connectChain(warpSub, warpSubG, warpSubLp);

  const warpBed = looper(ac, noiseBuffer);
  const warpBp = ac.createBiquadFilter();
  warpBp.type = 'bandpass';
  warpBp.frequency.setValueAtTime(200, t0);
  warpBp.Q.setValueAtTime(2.6, t0);
  const warpBedG = gain(ac, 0.0001);
  warpBed.connect(warpBp);
  warpBp.connect(warpBedG);
  warpBedG.connect(sum);
  warpBedG.connect(reverbSend);
  sources.push(warpSub, warpBed);

  // --- UI ------------------------------------------------------------------
  const uiHp = ac.createBiquadFilter();
  uiHp.type = 'highpass';
  uiHp.frequency.setValueAtTime(420, t0); // strip body: instruments, not games
  const uiOut = gain(ac, 1);
  uiOut.connect(uiHp);
  uiHp.connect(sum);

  for (let i = 0; i < sources.length; i++) sources[i]!.start(t0);

  return {
    master, limiter, clip, sum, reverb, reverbSend, reverbReturn,
    engSub, engSubG, engFund, engFundG, engMid, engMidG, engBright, engBrightG,
    engNoise, engNoiseBp, engNoiseG, engLp, engHp, engOut,
    atmNoise, atmBp, atmPeak, atmOut,
    droneOsc, droneG, droneLp, droneOut, droneDry, droneWet,
    proxOsc, proxOscG, proxPartial, proxPartialG, proxLp, proxOut,
    warpSub, warpSubG, warpSubLp, warpBed, warpBp, warpBedG,
    uiOut, uiHp,
    sources, noiseBuffer,
  };
}

function osc(ac: AudioContext, type: OscillatorType, freq: number): OscillatorNode {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, ac.currentTime);
  return o;
}

function gain(ac: AudioContext, value: number): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(value, ac.currentTime);
  return g;
}

function looper(ac: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  return s;
}

function connectChain(a: AudioNode, b: AudioNode, c: AudioNode): void {
  a.connect(b);
  b.connect(c);
}

// ---------------------------------------------------------------------------
// Procedural buffers
// ---------------------------------------------------------------------------

/**
 * tanh soft clip. The limiter ahead of it does the musical work; this is the
 * brick wall behind it that guarantees no sample ever leaves at |x| > 1,
 * whatever a caller does with setMasterVolume or however many voices collide.
 */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1.6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  return curve;
}

/**
 * Looping pink noise, two independent channels.
 *
 * Pink (−3 dB/octave) rather than white because filtered white noise reads as
 * hiss and filtered pink reads as air. Kellet's economical approximation is
 * accurate to ±0.05 dB from 10 Hz to 20 kHz, which is far better than needed.
 *
 * The last `XFADE` samples are crossfaded into the first so the loop point is
 * continuous — otherwise you get a click every few seconds, which the ear
 * finds instantly.
 */
function makeNoiseBuffer(ac: AudioContext, seconds: number, seed: number): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.floor(seconds * sr);
  const xfade = Math.min(2048, n >> 2);
  const buf = ac.createBuffer(2, n, sr);
  const tmp = new Float32Array(n + xfade);

  for (let ch = 0; ch < 2; ch++) {
    const rng = new Rng(seed + ch * 0x9e3779b9);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n + xfade; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      tmp[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    const out = buf.getChannelData(ch);
    for (let i = 0; i < xfade; i++) {
      const t = i / xfade;
      out[i] = tmp[i]! * t + tmp[n + i]! * (1 - t);
    }
    for (let i = xfade; i < n; i++) out[i] = tmp[i]!;
  }
  return buf;
}

/**
 * Procedurally generated impulse response — the whole reverb, no file.
 *
 * A room's response to a click is: a few discrete early reflections, then a
 * dense noise tail whose amplitude decays exponentially and whose spectrum
 * darkens as it decays (air and soft surfaces absorb treble first). All three
 * of those are cheap to synthesise, and together they are indistinguishable
 * from a recorded hall for a bed this quiet.
 */
function makeImpulseResponse(ac: AudioContext, seconds: number, decay: number, seed: number): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ac.createBuffer(2, n, sr);

  for (let ch = 0; ch < 2; ch++) {
    const rng = new Rng(seed + ch * 0x85ebca6b);
    const data = buf.getChannelData(ch);
    let lp = 0;
    let peak = 1e-6;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // Onset ramp: an IR that starts at full amplitude on sample 0 makes every
      // wet signal sound like it was slapped.
      const onset = Math.min(1, t / 0.012);
      const env = Math.exp(-decay * t) * onset;
      const w = rng.next() * 2 - 1;
      // Coefficient falls with time, so the tail gets progressively darker.
      const coef = 0.02 + 0.33 * Math.exp(-t * 0.55);
      lp += (w - lp) * coef;
      const v = lp * env;
      data[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    // Eight early reflections in the first 90 ms give the tail a place to be.
    for (let r = 0; r < 8; r++) {
      const idx = Math.floor(rng.range(0.004, 0.09) * sr);
      if (idx < n) data[idx] = data[idx]! + rng.range(-0.6, 0.6) * Math.exp(-decay * (idx / sr));
    }
    // Normalise deterministically; the convolver has normalize = false so this
    // is the only thing setting the reverb's absolute level.
    const k = 0.35 / peak;
    for (let i = 0; i < n; i++) data[i] = data[i]! * k;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v > 1 ? 1 : v > 0 ? v : 0; // NaN falls through to 0, which is what we want
}

function finite(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * Safari shipped Web Audio behind a prefix and still exposes it that way in
 * some builds. The cast is the narrowest possible: we are only asserting that
 * the legacy global, if present, is an AudioContext constructor.
 */
function pickAudioContext(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}
