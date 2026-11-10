/**
 * RecoveryCut: the cut that puts a wrecked ship back in orbit (GAMEPLAY F6, F7, P5).
 *
 * A crash used to be the best brake in the game — velocity to zero, grounded,
 * carry on. Flying into the star did nothing at all. Now either one fades to
 * black, moves the ship to a stable circular orbit, logs RECOVERED TO ORBIT and
 * fades back. The pause overlay's RETURN TO ORBIT runs the same cut.
 *
 * The timing and the state vector are pure (`game/recovery.ts`, tested); this
 * module owns only the black veil and the wiring.
 */

import type { EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { shotOwnsScene } from '@/game/Shots';
import type { Universe } from '@/game/Universe';
import { RecoveryTimeline } from '@/game/recovery';
import { payBeacon, type BeaconLog } from '@/ship/emergency';

export type RecoveryCause = 'crash' | 'star' | 'requested';

export class RecoveryCut implements GameModule {
  readonly name = 'recovery';

  private readonly timeline = new RecoveryTimeline();
  private veil: HTMLDivElement | null = null;
  private lastOpacity = -1;
  private cause: RecoveryCause = 'requested';
  private disposers: Array<() => void> = [];

  /** `log`: the ship's log; the paid RETURN TO ORBIT writes its BEACON RECOVERY note there. */
  constructor(
    private readonly universe: Universe,
    private readonly log: BeaconLog | null = null,
  ) {}

  /** True from the first frame of the fade until the screen is clear again. */
  get active(): boolean {
    return this.timeline.active;
  }

  /** Start the cut. A second request during one is ignored. */
  request(cause: RecoveryCause): void {
    if (this.timeline.active || shotOwnsScene()) return;
    this.cause = cause;
    this.timeline.start();
    if (cause === 'star') bus.emit('log', { text: 'PHOTOSPHERE CONTACT', tone: 'warn' });
  }

  init(): void {
    const host = document.getElementById('ui-root') ?? document.body;
    const veil = document.createElement('div');
    veil.className = 'os-recovery-veil';
    // Above the HUD and the hint line, below the boot veil. Inline: one rule.
    veil.style.cssText =
      'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:40;';
    host.appendChild(veil);
    this.veil = veil;

    this.disposers.push(bus.on('ship:crashed', () => this.request('crash')));
  }

  update(dt: number, ctx: EngineContext): void {
    if (!this.timeline.active && this.universe.insideStar && !this.universe.paused) {
      this.request('star');
    }

    if (this.timeline.step(dt)) {
      this.universe.recoverToOrbit();
      // Arrive coasting. A throttle left at full is how a recovered pilot
      // finds themselves leaving the orbit they were just given.
      ctx.input.setThrottle(0);
      // …and the command too. Pilot stands still while the world is frozen,
      // so the command still holds the old lever; the first physics step after
      // the fade flew it — an FA-ON speed hold that kicked the fresh orbit
      // eccentric (playtest: e = 0.12 from a 60 % lever).
      this.universe.flight.command.throttle = 0;
      // [v4-fuel] I1 (owner ruling): RETURN TO ORBIT with a tank is a rescue,
      // not a refill — it costs exactly what the beacon costs. A crash or star
      // recovery stays free (v3), and so does a hull without a tank.
      // [v4-mining] D11: the same beacon, cargo included — the hold is
      // jettisoned and noted before ship:recovered below. Crash and star keep it.
      const tank = this.universe.flight.propellant;
      if (this.cause === 'requested' && tank) {
        payBeacon(tank, this.universe.cargo ?? null, this.log, this.universe.system?.name ?? '—');
        bus.emit('emergency:used', { kind: 'beacon' });
      }
      // review-p1: the cruise drive kept running through the cut and flew the
      // ship straight back out of the recovery orbit.
      bus.emit('ship:recovered', { cause: this.cause });
      bus.emit('log', {
        text: this.cause === 'requested' ? 'RETURNED TO ORBIT' : 'RECOVERED TO ORBIT',
        tone: 'good',
      });
    }

    const o = this.timeline.blackout;
    if (this.veil && Math.abs(o - this.lastOpacity) > 0.002) {
      this.lastOpacity = o;
      this.veil.style.opacity = o.toFixed(3);
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.veil?.remove();
    this.veil = null;
  }
}
