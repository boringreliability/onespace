/**
 * Module registry — the single place that decides what the game is made of.
 *
 * Registration order is dependency order and nothing else. Universe goes first
 * because it generates the galaxy every other module wants to look at; the
 * render pipeline goes last because it has to wrap a scene that already exists.
 */

import { Color, Group, Vector3 } from 'three';

import type { Engine, EngineContext, GameModule } from '@/core/Engine';
import { bus } from '@/core/EventBus';
import { config } from '@/core/Config';
import { modes } from '@/core/Modes';

import { Universe } from '@/game/Universe';
import { Pilot } from '@/game/Pilot';
import { MapMode } from '@/game/MapMode';
import { Traffic } from '@/game/Traffic';
import { ShipLog } from '@/game/Log';
import { Scanner } from '@/game/Scanner';
import { Targeting } from '@/game/Targeting';
import { Instruments } from '@/game/Instruments';
import { Cruise } from '@/game/Cruise';
import { AutoPilot } from '@/game/AutoPilot'; // [v2-p4]
import { TimeControl } from '@/game/TimeControl'; // [v2-p4]
import { Showroom, registerShowroomShots, setShipVisualFactory } from '@/game/Showroom';
import { createShipVisual } from '@/render/ships/ShipMesh';
import { activeShotName, registerShot, shotOwnsScene, updateActiveShot } from '@/game/Shots';
import type { NebulaSpec, PlanetSpec, RingSpec } from '@/gen/types';
// -- v2-p2b: the Yard and mode gating ---------------------------------------
import { Yard, YARD_DRIVES, YARD_FACTIONS, YARD_LIGHTS, YARD_VIEWS } from '@/game/Yard';
import { YardPanel } from '@/ui/YardPanel';
import { MODULE_MODES, applyGating } from '@/game/gating';
// ---------------------------------------------------------------------------

import { MutableViewState } from '@/render/ViewState';
import { Sky, registerSkyShots } from '@/render/Sky';
import { PostFX, registerPostFXShots } from '@/render/PostFX';
import { NebulaRenderer, registerNebulaShots } from '@/render/Nebula';
import { RingRenderer, registerRingsShots } from '@/render/Rings';
import { registerStarShots } from '@/render/Star';
import { PlanetRenderer, clearPlanetShotFixture, registerPlanetShots } from '@/render/Planet';
import { registerCloudShots } from '@/render/Clouds';
import { registerAtmosphereShots } from '@/render/Atmosphere';

import { Hud, registerHudShots } from '@/ui/Hud';
import { Codex, registerCodexShots } from '@/ui/Codex';
import { SystemMap, registerSystemMapShots } from '@/ui/SystemMap';
import { Audio } from '@/audio/Audio';
import { Photo } from '@/game/Photo';
import { DevOverlay } from '@/ui/DevOverlay';
import { Title } from '@/ui/Title';
import { companionShip, parseRoute, type BootPlan, type Route } from '@/core/Route';
// -- v3 T4: dust, drive field, audio feed, formation, SEE IN FLIGHT -----------
import { Dust } from '@/render/Dust';
import { FlightSense } from '@/game/FlightSense';
import { Belt } from '@/game/Belt'; // [v4-mining]
import { WorldState } from '@/game/worldState'; // [v4-mining]
import { Asteroids } from '@/render/Asteroids'; // [v4-mining]
import { selectionFromRoute, toShipParams } from '@/game/showroom/catalog';
// -----------------------------------------------------------------------------
import { RecoveryCut } from '@/game/RecoveryCut';
import { Pause } from '@/ui/Pause';
import { Hints } from '@/ui/Hints';
import { Emergency } from '@/game/Emergency'; // [v4-fuel]
import { Mining } from '@/game/Mining'; // [v4-mining]
// -- v4 sub-plan 3: the save -----------------------------------------------------
import { SaveGame } from '@/game/SaveGame';
import { ActionJournal } from '@/save/actionJournal';
import { idbStore } from '@/save/idbStore';
import { memoryStore } from '@/save/memoryStore';
import { wal } from '@/save/wal';
import { acquireWriterLock, type WriterLock } from '@/save/writerLock';
import { applySave } from '@/save/capture';
import { universeOptionsFor, type BootLoad } from '@/save/bootLoad';
import { decideBoot, logBeforeWorld, restartAfterRestoreFail } from '@/save/boot';
import type { SaveStore } from '@/save/store';
import type { GameEvents } from '@/core/EventBus';
// -----------------------------------------------------------------------------
import { Warp, registerWarpShots } from '@/ship/Warp';
import { registerCameraShots } from '@/ship/CameraRig';
import { registerShipShots } from '@/ship/Ship';

export type ProgressFn = (progress: number, status: string) => void;

/** Drives whichever review shot is active. Always registered; costs nothing. */
class ShotDriver implements GameModule {
  readonly name = 'shot-driver';
  update(dt: number, ctx: EngineContext): void {
    updateActiveShot(dt, ctx);
  }
}

/**
 * Holds the sky and pins it to the camera.
 *
 * The sky is at infinity, so it must never translate relative to the viewer —
 * without this it would slide away the moment the floating origin rebased, and
 * the stars would visibly parallax against nothing.
 */
class SkyModule implements GameModule {
  readonly name = 'sky';
  private readonly view = new MutableViewState();
  private readonly zero = new Vector3();
  private readonly sunDir = new Vector3(0, 0, 1);
  private readonly sunColor = new Color(1, 1, 1);

  constructor(readonly sky: Sky) {}

  init(ctx: EngineContext): void {
    ctx.scene.add(this.sky.object3d);
    this.sky.snap();
  }

  lateUpdate(dt: number, ctx: EngineContext): void {
    this.sky.object3d.position.copy(ctx.camera.position);
    this.view.set(
      this.zero,
      this.sunDir,
      this.sunColor,
      ctx.elapsed,
      (ctx.camera.fov * Math.PI) / 180,
      ctx.height,
    );
    this.sky.update(dt, ctx, this.view);
  }

  dispose(): void {
    this.sky.object3d.removeFromParent();
    this.sky.dispose();
  }
}

/**
 * Review-only instances.
 *
 * Nebulae and ring systems are owned by whatever body happens to have them, so
 * at boot there may be no instance for their hero shots to frame. The gallery
 * builds one of each from real generated data — never added to the scene unless
 * a shot asks for it — so every subsystem stays reviewable regardless of which
 * seed the game opened on.
 */
class Gallery implements GameModule {
  readonly name = 'gallery';
  readonly root = new Group();
  readonly planet: PlanetRenderer;
  private readonly ringPivot = new Group();
  nebula: NebulaRenderer | null = null;
  rings: RingRenderer | null = null;

  /**
   * The ring and cloud shots place a camera and aim a star, and assume the
   * integrator has put a PLANET at the centre of what they are framing. Give
   * them one. Without it the shots borrow whatever fixture the previous shot
   * left behind, which produces a frame that looks plausible and is wrong: a
   * ring annulus floating in front of an unrelated world at an unrelated
   * scale, with no far half to the ellipse because there is nothing to pass
   * behind.
   */
  constructor(nebulaSpec: NebulaSpec | undefined, readonly host: PlanetSpec) {
    // Hidden during play; a shot that needs it turns it on. See ReviewGuard.
    this.root.visible = false;

    this.planet = new PlanetRenderer(host, config.quality);
    this.root.add(this.planet.object3d);

    if (host.rings) {
      this.rings = new RingRenderer(host.rings, host.radius, config.quality);
      // The rings get their OWN pivot rather than being parented to the planet.
      // The ring shot isolates its subject by hiding every sibling of the ring
      // object — sensible when the siblings are an unrelated nebula, fatal when
      // the sibling is the planet the rings are supposed to encircle. The pivot
      // shares the planet's centre, so the geometry is identical and the shot's
      // isolation sweep has nothing to switch off.
      this.ringPivot.add(this.rings.object3d);
      this.root.add(this.ringPivot);
    }
    if (nebulaSpec) {
      this.nebula = new NebulaRenderer(nebulaSpec, config.quality);
      this.root.add(this.nebula.object3d);
    }
  }

  init(ctx: EngineContext): void {
    ctx.scene.add(this.root);
  }

  /**
   * Drive the gallery's renderers.
   *
   * A renderer that is never updated has never had its uniforms set, and both
   * of these hide themselves rather than draw a frame they cannot justify — so
   * without this the gallery is an invisible group full of invisible meshes.
   * The gallery sits at the origin, so the camera's render position *is* its
   * local position.
   */
  lateUpdate(dt: number, ctx: EngineContext): void {
    if (!this.root.visible) return;
    this.view.set(
      ctx.camera.position,
      this.sunDir,
      this.sunColor,
      ctx.elapsed,
      (ctx.camera.fov * Math.PI) / 180,
      ctx.height,
    );
    this.planet.update(dt, ctx, this.view);
    this.nebula?.update(dt, ctx, this.view);
    this.rings?.update(dt, ctx, this.view);
  }

  dispose(): void {
    this.planet.dispose();
    this.nebula?.dispose();
    this.rings?.dispose();
    this.root.removeFromParent();
  }

  private readonly view = new MutableViewState();
  /** A key light for the gallery; the real system's star is nowhere near it. */
  private readonly sunDir = new Vector3(1, 0.16, 0.34).normalize();
  private readonly sunColor = new Color(1, 0.94, 0.86);
}

/** A ring system for the gallery when the opening system happens to have none. */
const FALLBACK_RINGS: RingSpec = {
  innerRadius: 1.36,
  outerRadius: 2.28,
  color: [0.62, 0.58, 0.52],
  opacity: 0.86,
  seed: 0x2ea7,
  tilt: 0.11,
};

/** Shots whose subject lives in the gallery rather than the live system. */
const GALLERY_SHOTS = new Set([
  'nebula-hero',
  'nebula-closeup',
  'rings-backlit',
  'rings-grazing',
  'clouds-orbit',
  'clouds-full-disc',
  'atmosphere-limb',
  'atmosphere-sunset',
]);

/**
 * Reconciles the running game with whatever review shot is active.
 *
 * Instruments are part of the game, not part of a nebula: leaving the HUD up
 * over every captured frame would make each subsystem impossible to judge on
 * its own. Runs in lateUpdate so it sees the shot the frame actually used.
 */
class ReviewGuard implements GameModule {
  readonly name = 'review-guard';
  private lastShot: string | null = null;
  /** The chart is its own instrument; the flight HUD stands down under it. */
  private mapOpen = false;

  constructor(
    private readonly hud: Hud,
    private readonly gallery: Gallery,
  ) {}

  init(): void {
    // Either chart, not just the galactic one. The local chart shipped once
    // with the flight HUD legible straight through it.
    bus.on('ui:chart', ({ chart }) => {
      this.mapOpen = chart !== null;
    });
  }

  lateUpdate(_dt: number, ctx: EngineContext): void {
    const shot = activeShotName();
    const owned = shotOwnsScene();
    // v2-p2b: the flight HUD belongs to the flight modes. In the yard it is
    // frozen with the rest of flight (gating.ts) and must not hang over it;
    // the title is not flight either (review-p1: its menu sat under the
    // pitch ladder). Title/boot are excluded by this whitelist.
    const flightMode = modes.base === 'flight' || modes.base === 'map' || modes.base === 'review';
    this.hud.setVisible((!owned || shot === 'hud-full') && !this.mapOpen && flightMode);
    this.gallery.root.visible = shot !== null && GALLERY_SHOTS.has(shot);

    // Planet shots build a fixture and only clear it for each other. Leaving
    // one in the scene is how the ring shot ended up framing a borrowed world.
    if (shot !== this.lastShot) {
      if (this.lastShot?.startsWith('planet-') || this.lastShot === 'gas-giant') {
        if (!shot?.startsWith('planet-') && shot !== 'gas-giant') clearPlanetShotFixture(ctx);
      }
      this.lastShot = shot;
    }
  }
}

/** [v4-save] Task 6: what the boot found, decided before any module exists. */
export interface BootState {
  readonly route: Route;
  readonly plan: BootPlan;
  readonly load: BootLoad;
  readonly store: SaveStore;
  readonly lock: WriterLock;
  /** NEW GAME over a save: the new game's first save goes above this revision. */
  readonly afterRevision: number;
  /** Log lines for the player, shown once the HUD is up. */
  readonly notices: readonly string[];
}

/** sessionStorage, or null where the browser refuses it. */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * [v4-save] Task 6: load the latest save before the world is built — the
 * decisions live in `decideBoot` (src/save/boot.ts, node-tested): newest valid
 * save, WAL merged; `?new=1` only with NEW GAME's one-time nonce (R17); `new`
 * and `nonce` leave the URL before any module exists; only the writer writes.
 */
export async function loadBoot(): Promise<BootState> {
  const store = typeof indexedDB === 'undefined' ? memoryStore() : idbStore();
  const lock = await acquireWriterLock();
  const d = await decideBoot({
    search: window.location.search,
    store,
    wal,
    lock,
    session: sessionStore(),
    replaceSearch: (search) => {
      const u = new URL(window.location.href);
      u.search = search;
      window.history.replaceState(window.history.state, '', u.toString());
    },
  });
  return { ...d, store, lock };
}

export async function registerModules(engine: Engine, progress: ProgressFn, boot: BootState): Promise<void> {
  progress(0.03, 'opening the log');
  // First, ahead of Universe. `Universe.init()` calls `enterSystem`, which
  // emits `system:entered` — so a log registered after it would miss the
  // opening system every single session, silently, forever. The log depends on
  // nothing but the bus, so putting it first costs nothing and closes the seam.
  const shipLog = new ShipLog();
  // [v4-save] The save owns the log from here: no more writes to the legacy
  // key (it stays as a backup). Before the world exists the log is the NEW
  // game's (the legacy one imported once, or empty); a continued save's own
  // log comes with applySave below, so a failed restore leaves none of it.
  shipLog.setSink(() => undefined);
  const continued = boot.plan.start === 'continue' ? boot.load.save : null;
  shipLog.importState(logBeforeWorld(boot.load));
  await engine.add(shipLog);

  progress(0.05, 'seeding universe');
  // `?seed=` picks the universe (whitelisted hex, core/Route.ts).
  // [v4-save] A save boots straight into its own universe and place, so the
  // start system never flashes past.
  const route = boot.route;
  const universe = new Universe(universeOptionsFor(route, continued));
  await engine.add(universe);

  progress(0.35, 'mapping the sky');
  const sky = new Sky(universe.galaxy, config.quality);
  await engine.add(new SkyModule(sky));

  progress(0.55, 'spinning up audio');
  const audio = new Audio();
  await engine.add(audio);

  progress(0.62, 'powering instruments');
  const hud = new Hud();
  await engine.add(hud);

  progress(0.72, 'warming the drive');
  const warp = new Warp();
  await engine.add(warp);

  progress(0.82, 'undocking');
  const pilot = new Pilot({ universe, hud, audio });
  await engine.add(pilot);
  await engine.add(new ShotDriver());

  progress(0.84, 'reading transponders');
  // The procedural fleet, in the universe rather than the showroom.
  const traffic = new Traffic(universe);
  await engine.add(traffic);
  // -- v3 T4: `?mode=flight&ship=…` (generation-pinned) flies that hull beside
  // you; the Yard's SEE IN FLIGHT button does the same in-session.
  {
    const companion = companionShip(route);
    if (companion) traffic.setCompanion(toShipParams(selectionFromRoute(companion)));
  }
  // Orbital dust, after Traffic and Pilot so it sees this frame's camera.
  await engine.add(new Dust({ universe, warping: () => warp.phase !== 'idle' }));
  // ---------------------------------------------------------------------------

  progress(0.845, 'priming the cruise drive');
  // After Universe, whose `nearestGapKm` is its speed limit.
  // [v3-t5] kept in a const so Instruments can read the drive's phase (and
  // v3 T4's FlightSense, its field).
  // [v4-mining] The belt as game state: depletion (P2, in memory) and the
  // field/asteroid queries. Before Cruise (R21: it flies to `field:` targets)
  // and before Targeting, which resolves its targets.
  // [v4-save] The action log (P3): every named action from here on. A mine
  // reaches it through WorldState's onMined hook (both halves together), an
  // emergency exit through SaveGame's critical hook (R2).
  const journal = new ActionJournal({ wallMs: () => Date.now(), orbitSeconds: () => universe.orbitSeconds });
  const worldState = new WorldState({
    orbitSeconds: () => universe.orbitSeconds,
    wallMs: () => Date.now(),
    onMined: (e) => journal.noteMined(e),
  });
  const belt = new Belt({ universe, worldState });
  await engine.add(belt);
  const cruise = new Cruise({ universe, belt });
  await engine.add(cruise);
  // [v2-p4] L: auto-land / auto-orbit. After Pilot (it overwrites the command
  // Pilot copied from the stick) and after Cruise (which also reads L).
  // Time compression after both: it judges this frame's command and autopilot.
  const autopilot = new AutoPilot({ universe, warp, cruise, belt }); // [v3-t3] cruise: the L queue; [v4-mining] belt: L parks at a rock
  await engine.add(autopilot);
  universe.beforeSlice = (h) => autopilot.sliceStep(h); // [v3-t3] flies per sim slice
  await engine.add(new TimeControl({ universe, warp, autopilot, hud }));
  // [/v2-p4]

  progress(0.85, 'calibrating the array');
  // Scanner needs both the universe and the fleet, so it can only be built
  // once Traffic exists. The codex only needs the log.
  // Targeting before Scanner: the array scans the nav target. After Pilot, so
  // the camera it projects through has already moved this frame; Instruments
  // likewise, and its altitude replaces the sphere one Pilot just published.
  // [v4-mining] The rocks themselves: after the Belt (its memo is current) and
  // after Universe (the origin has already rebased this frame).
  await engine.add(new Asteroids({ belt, universe }));
  const targeting = new Targeting({ universe, traffic, hud, belt });
  await engine.add(targeting);
  // -- v3 T4: drive field → sky, silent events → audio, K formation ----------
  const flightSense = new FlightSense({ universe, cruise, traffic, targeting, audio, sky, belt });
  await engine.add(flightSense);
  // ---------------------------------------------------------------------------
  // [v3-t5] cruise + targeting: the throttle block's cruise readout and ETA.
  // [v4-mining] fieldFrame + belt: VEL and the markers relative to a belt field.
  await engine.add(new Instruments({ universe, hud, cruise, targeting, fieldFrame: flightSense, belt }));
  await engine.add(new Scanner({ universe, traffic, targeting, belt }));
  const codex = new Codex({ log: shipLog });
  await engine.add(codex);
  registerCodexShots(codex, universe, shipLog);

  progress(0.855, 'plotting the local chart');
  // Registered before MapMode: it owns the M key and decides when the galaxy
  // chart takes over, so it must be listening before anything can press it.
  const systemMap = new SystemMap({ universe });
  await engine.add(systemMap);
  registerSystemMapShots(systemMap);

  progress(0.86, 'charting the galaxy');
  const map = new MapMode({ universe, warp });
  await engine.add(map);

  // --- v2 phase 1, track D: J, pause, recovery, NAV ADVISORY -----------------
  // J reads the galaxy chart's selection; the chart only exists from here on.
  pilot.attachJump(map.ui, warp);
  progress(0.865, 'arming the recovery beacon');
  // [v4-save] The one writer, made below once Emergency and Mining exist; the
  // paying code paths reach it through this late-bound hook (R2).
  let saveGame: SaveGame | null = null;
  const critical = (used: GameEvents['emergency:used']): void => saveGame?.critical(used);
  const recovery = new RecoveryCut(universe, shipLog, critical);
  await engine.add(recovery);
  const pause = new Pause({
    universe,
    recovery,
    warp,
    input: engine.input,
    save: { saveNow: (reason) => saveGame?.saveNow(reason) ?? Promise.resolve(false) },
  });
  await engine.add(pause);
  // [v4-fuel] the emergency exit on an empty tank; its line rides NAV ADVISORY.
  const emergency = new Emergency({ universe, recovery, warp, log: shipLog, critical });
  await engine.add(emergency);
  // [v4-mining] B/U/N. After Belt and Targeting (this frame's target and rock),
  // Cruise and the emergency exit; its in-range flag drives the 'mine' hint.
  const mining = new Mining({ universe, belt, worldState, targeting, cruise, warp });
  await engine.add(mining);
  // [v4-save] After Emergency and Mining: one writing tab (navigator.locks),
  // IndexedDB (memory where it is missing), the WAL on localStorage.
  progress(0.87, 'opening the logbook vault');
  saveGame = new SaveGame({
    world: { universe, worldState, shipLog, emergency, journal, cruise, input: engine.input },
    store: boot.store,
    wal,
    lock: boot.lock,
    page: { document, window },
  });
  await engine.add(saveGame);
  // The same world, for applySave: what the save holds goes back into these.
  const saveWorld = { universe, worldState, shipLog, emergency, journal, cruise, input: engine.input };
  // [v4-save] Task 6: put the save back and continue it — before flight starts,
  // so revisions go on and nothing the boot queued saves the opening world.
  const notices: string[] = [...boot.notices];
  let hasSave = false;
  if (continued && !universe.restoreFailed && applySave(saveWorld, continued)) {
    saveGame.continueFrom(continued);
    hasSave = true;
  } else if (continued) {
    // The saved place cannot be found: a new start, above the kept old game.
    // The log already is the new start's (logBeforeWorld + its arrival).
    const r = await restartAfterRestoreFail({ store: boot.store, wal, lock: boot.lock, load: boot.load });
    notices.push(...r.notices);
    saveGame.startNew(r.afterRevision);
  } else {
    saveGame.startNew(boot.afterRevision);
  }
  // CONTINUE from the title: drop whatever the title time queued. Only while
  // nothing has been saved since the boot (a Yard visit may have saved already,
  // and its drained actions must not be dropped).
  const continueGame = (): void => {
    if (hasSave && continued && saveGame?.revision === continued.revision) saveGame.continueFrom(continued);
  };
  await engine.add(new Hints({ universe, pause, recovery, warp, emergency, mining }));
  // --- end track D -------------------------------------------------------------

  progress(0.88, 'assembling gallery');
  // One world carries every gallery shot, so rings, clouds and atmosphere are
  // all seen on the same body rather than three unrelated ones. Prefer a planet
  // that already has an atmosphere — that is the harder thing to fake — and
  // give it rings if the seed did not.
  const base =
    universe.system.planets.find((p) => p.atmosphere !== null && p.clouds !== null) ??
    universe.system.planets.find((p) => p.atmosphere !== null) ??
    universe.system.planets[0]!;
  const galleryHost: PlanetSpec = base.rings ? base : { ...base, rings: FALLBACK_RINGS };
  const gallery = new Gallery(universe.galaxy.nebulae[0], galleryHost);
  await engine.add(gallery);

  progress(0.90, 'opening the yard');
  // The procedural ships live in an isolated showroom until they are reviewed;
  // nothing here runs during flight. See docs/ships/BRIEF.md.
  setShipVisualFactory(createShipVisual);
  const showroom = new Showroom();
  // -- v2-p2b: the Yard. Ahead of the stage in tick order, so the stage lights
  // the hull from THIS frame's orbit camera rather than last frame's.
  const yard = new Yard({
    stage: showroom,
    panel: new YardPanel({ factions: YARD_FACTIONS, lights: YARD_LIGHTS, drives: YARD_DRIVES, views: YARD_VIEWS }),
    clock: engine,
    audio,
    // review-p2: Y mid-jump froze the tunnel; Y mid-recovery hung its black
    // veil (z 40) over the whole Yard.
    busy: () => warp.phase !== 'idle' || recovery.active,
    // v3 T4: SEE IN FLIGHT.
    onSeeInFlight: (params) => traffic.setCompanion(params),
  });
  await engine.add(yard);
  // ---------------------------------------------------------------------------
  await engine.add(showroom);
  registerShowroomShots(showroom);

  progress(0.94, 'grading');
  const postfx = new PostFX(engine.renderer, engine.scene, engine.camera, config.quality);
  engine.setPipeline(postfx);
  yard.iris = postfx; // v2-p2b: the yard snaps the iris at its scene cuts

  // Review shots. Each module frames its own work; see game/Shots.ts.
  registerSkyShots(sky);
  registerPostFXShots(postfx);
  registerStarShots();
  registerPlanetShots();
  registerHudShots(hud);
  registerWarpShots(warp);
  registerCameraShots(pilot.rig);
  registerShipShots(pilot.ship);
  if (gallery.nebula) registerNebulaShots(gallery.nebula);
  if (gallery.rings) registerRingsShots(gallery.rings);
  // Attached to the planet, not to the bare group, so the shells wrap the
  // surface they are meant to belong to.
  if (galleryHost.clouds) registerCloudShots(galleryHost, gallery.planet.object3d);
  if (galleryHost.atmosphere) registerAtmosphereShots(galleryHost, gallery.planet.object3d);

  await engine.add(new ReviewGuard(hud, gallery));

  // --- v2: photo overlay + dev overlay. Photo MUST stay last among camera
  // writers: its lateUpdate overrides the flight rig (see game/Photo.ts).
  await engine.add(new Photo(engine, postfx));
  await engine.add(new DevOverlay(engine, parseRoute(window.location.search).dev === true));
  await engine.add(new Title({ universeSeed: universe.seed, hasSave, onContinue: continueGame }));

  registerShot({
    name: 'game-opening',
    live: true,
    description:
      'The frame the game actually opens on — every subsystem at once, ' +
      'composed as the player first sees it.',
    apply(ctx) {
      ctx.camera.position.set(0, 0, 0);
      ctx.camera.quaternion.identity();
    },
  });

  // The audio context may only start from a gesture; arm it on the first click.
  const armAudio = (): void => {
    void audio.start();
    window.removeEventListener('pointerdown', armAudio);
  };
  window.addEventListener('pointerdown', armAudio);

  // -- v2-p2b: mode gating, applied by name once everything is registered.
  for (const name of Object.keys(MODULE_MODES)) {
    const m = engine.get(name);
    if (m) applyGating([m]);
  }
  // ---------------------------------------------------------------------------

  bus.emit('log', { text: 'ALL SYSTEMS NOMINAL', tone: 'good' });
  for (const text of notices) bus.emit('log', { text, tone: 'warn' });
  progress(1, 'systems nominal');
}
