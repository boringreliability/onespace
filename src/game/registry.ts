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

import { Universe } from '@/game/Universe';
import { Pilot } from '@/game/Pilot';
import { MapMode } from '@/game/MapMode';
import { activeShotName, registerShot, shotOwnsScene, updateActiveShot } from '@/game/Shots';
import type { NebulaSpec, PlanetSpec, RingSpec } from '@/gen/types';

import { MutableViewState } from '@/render/ViewState';
import { Sky, registerSkyShots } from '@/render/Sky';
import { PostFX, registerPostFXShots } from '@/render/PostFX';
import { NebulaRenderer, registerNebulaShots } from '@/render/Nebula';
import { RingRenderer, registerRingsShots } from '@/render/Rings';
import { registerStarShots } from '@/render/Star';
import { registerPlanetShots } from '@/render/Planet';
import { registerCloudShots } from '@/render/Clouds';
import { registerAtmosphereShots } from '@/render/Atmosphere';

import { Hud, registerHudShots } from '@/ui/Hud';
import { Audio } from '@/audio/Audio';
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
  nebula: NebulaRenderer | null = null;
  rings: RingRenderer | null = null;

  constructor(nebulaSpec: NebulaSpec | undefined, ringHost: PlanetSpec | null) {
    // Hidden during play; a shot that needs it turns it on. See ReviewGuard.
    this.root.visible = false;
    if (nebulaSpec) this.nebula = new NebulaRenderer(nebulaSpec, config.quality);
    if (ringHost?.rings) {
      this.rings = new RingRenderer(ringHost.rings, ringHost.radius, config.quality);
    }
    if (this.nebula) this.root.add(this.nebula.object3d);
    if (this.rings) this.root.add(this.rings.object3d);
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
    this.nebula?.update(dt, ctx, this.view);
    this.rings?.update(dt, ctx, this.view);
  }

  dispose(): void {
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
  constructor(
    private readonly hud: Hud,
    private readonly gallery: Gallery,
  ) {}

  lateUpdate(): void {
    const shot = activeShotName();
    const owned = shotOwnsScene();
    this.hud.setVisible(!owned || shot === 'hud-full');
    this.gallery.root.visible = shot !== null && GALLERY_SHOTS.has(shot);
  }
}

export async function registerModules(engine: Engine, progress: ProgressFn): Promise<void> {
  progress(0.05, 'seeding universe');
  const universe = new Universe();
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

  progress(0.86, 'charting the galaxy');
  const map = new MapMode({ universe, warp });
  await engine.add(map);

  progress(0.88, 'assembling gallery');
  const ringHost =
    universe.system.planets.find((p) => p.rings !== null) ??
    ({ ...universe.system.planets[0]!, rings: FALLBACK_RINGS } as PlanetSpec);
  const cloudHost = universe.system.planets.find((p) => p.clouds !== null) ?? null;
  const atmoHost = universe.system.planets.find((p) => p.atmosphere !== null) ?? null;
  const gallery = new Gallery(universe.galaxy.nebulae[0], ringHost);
  await engine.add(gallery);

  progress(0.94, 'grading');
  const postfx = new PostFX(engine.renderer, engine.scene, engine.camera, config.quality);
  engine.setPipeline(postfx);

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
  if (cloudHost) registerCloudShots(cloudHost, gallery.root);
  if (atmoHost) registerAtmosphereShots(atmoHost, gallery.root);

  await engine.add(new ReviewGuard(hud, gallery));

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

  bus.emit('log', { text: 'ALL SYSTEMS NOMINAL', tone: 'good' });
  progress(1, 'systems nominal');
}
