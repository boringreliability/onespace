# oneSpace — Architecture Contract

**Read this before writing a single line.** Every module in this project is
built independently, often in parallel. This document is the only thing that
keeps them fitting together.

---

## 1. The game

A noir space odyssey. You fly a single ship through a procedurally generated
universe: galaxy → star system → planet → surface. Tone is *Farscape* by way of
1940s film noir — hard shadows, amber instrument glow, dust in every light
shaft, colour drained everywhere except where it matters.

There is no combat system and no inventory. The loop is **travel, look,
scan, log**: the reward is arriving somewhere no one has been and having the
instruments tell you what it is.

Nothing is downloaded. Every star, planet, mountain and cloud is derived from
one 32-bit seed.

---

## 2. Absolute rules

1. **TypeScript, `strict: true`.** `npm run typecheck` must pass. No `any`
   unless you write a comment explaining why, no `@ts-ignore`.
2. **No `Math.random()` in generation code.** Ever. Use `Rng` from
   `src/math/rng.ts`, seeded via `hashSeed(parentSeed, salt)`. The universe
   must be identical on every machine and every reload.
3. **No new npm dependencies.** `three` only. If you think you need a library,
   write the 40 lines instead.
4. **Units are kilometres and seconds.** 1 render unit = 1 km. See
   `src/gen/types.ts`.
5. **Generation is pure.** Files under `src/gen/` must not import `three`
   except for pure math types. They take a seed, return plain data.
   Rendering code consumes that data and never invents any.
6. **Stay in your lane.** Only create/modify the files listed in your brief. If
   you need something from another module, import it from its declared public
   interface. If that interface is missing something, note it in your report —
   do not edit the other module.
7. **Dispose properly.** Every `BufferGeometry`, `Material`, `Texture` and
   `RenderTarget` you create must be freed in a `dispose()`. Leaks kill a game
   that never unloads a level.
8. **Comment the non-obvious.** Explain *why* a magic constant is that value or
   why the maths works — never restate what the code plainly says.

---

## 3. Scale and precision

`float32` has ~7 significant digits. Three techniques keep a 1:1 universe
renderable:

| Problem | Solution | Where |
|---|---|---|
| Depth precision from 0.05 km to 1e12 km | `logarithmicDepthBuffer: true` | `Engine.ts` |
| Vertex jitter far from origin | Floating origin — world stays float64, render space stays near zero | `core/FloatingOrigin.ts` |
| Interstellar distances | Other stars are never geometry; they are points/impostors in the sky | `render/Sky.ts` |

**If you upload a position to the GPU, it must be render-space.** Convert with
`origin.toRender(worldVec)`.

Reference scales:

```
ship                 0.03 km  (30 m)
planet radius     2000–70000 km
star radius     ~700000 km per solar radius
1 AU              1.496e8 km
1 light year      9.461e12 km
```

---

## 4. Module system

Everything is a `GameModule` (see `src/core/Engine.ts`):

```ts
export interface GameModule {
  readonly name: string;
  init?(ctx: EngineContext): Promise<void> | void;
  update?(dt: number, ctx: EngineContext): void;
  lateUpdate?(dt: number, ctx: EngineContext): void;
  resize?(w: number, h: number, ctx: EngineContext): void;
  dispose?(): void;
}
```

`EngineContext` gives you `renderer`, `scene`, `camera`, `input`, `origin`,
`quality`, `elapsed`, `frame`, `width`, `height`. Nothing else is global.

Cross-module communication goes through the typed bus:

```ts
import { bus } from '@/core/EventBus';
bus.emit('log', { text: 'ATMOSPHERE: METHANE', tone: 'warn' });
const off = bus.on('system:entered', ({ system }) => { ... });
```

Add new event names to `GameEvents` in `EventBus.ts` if you need them — that is
the one shared file you may extend (append only, never reorder or rename).

---

## 5. Performance budgets

Read your budget from `ctx.quality` (`src/core/Config.ts`). Never hard-code a
resolution, step count or LOD depth.

Hard limits at `high` tier, 1080p:

- **16.7 ms total frame time.** Your module gets a slice, not the whole thing.
- **< 400 draw calls.** Use `InstancedMesh` and merged geometry aggressively.
- **No allocation in `update()`.** Preallocate vectors, matrices and arrays as
  class fields. A `new Vector3()` per frame per object is how you get GC hitches.
- **No synchronous work > 4 ms.** Terrain patch building must be amortised
  across frames using `quality.patchBuildBudget`.

---

## 6. Visual direction — non-negotiable

This is what "AAA" means in this project. It is a *look*, enforced by review.

**Lighting.** One dominant key light (the star), everything else is bounce and
emissive. Contrast is high; shadow terminators are hard. There is no ambient
fill light in space — if a surface faces away from the star it is *black*,
lit only by planetshine.

**Palette.** Desaturated steel-blue and near-black base. Colour is rationed:
amber instrument glow, one saturated accent per location (a cyan nebula, a
sodium-orange sunset). Never more than two saturated hues on screen at once.

**Composition.** Something always occludes: a ring plane, a hull strut, a dust
lane. Empty black screens are a failure state. There is always a light source
in or just outside frame producing flare and glare.

**Materials.** Everything is dirty. Micro-detail noise on every surface at
every scale — a planet must hold up from 20,000 km and from 2 km. No flat
gradients: use `os_dither` from `shaders/chunks.ts` on anything smooth.

**Motion.** Nothing snaps. Every value the player sees is critically damped
towards its target. Camera has weight, lag and subtle shake under thrust.

**Grade.** Filmic tone map, lifted crushed blacks (noir), bloom only on real
emitters, film grain always on, chromatic aberration at frame edges only.

---

## 7. Shader library

Import `registerShaderChunks()` from `src/shaders/chunks.ts` once, then in any
GLSL string:

```glsl
#include <onespace_noise>       // os_snoise, os_fbm, os_ridged, os_billow,
                                // os_worley, os_warp, os_hash33, os_gradient
#include <onespace_color>       // os_blackbody, os_aces, os_filmic, os_dither,
                                // os_linearToSrgb, os_srgbToLinear
#include <onespace_atmosphere>  // os_raySphere, os_phaseRayleigh, os_phaseMie
```

Do not write your own noise. If you need a variant, add it to `chunks.ts` in a
clearly-marked block and say so in your report.

---

## 8. Directory map

```
src/
  main.ts               bootstrap + module wiring          [OWNER: integrator]
  core/                 engine, bus, config, input, origin [OWNER: integrator]
  math/rng.ts           deterministic RNG                  [OWNER: integrator]
  shaders/chunks.ts     shared GLSL                        [OWNER: integrator]
  gen/types.ts          data contracts                     [OWNER: integrator]

  gen/galaxy.ts         galaxy + star catalogue generation
  gen/system.ts         star + planet + moon generation
  gen/terrain.ts        CPU terrain sampler (mirrors GPU)
  gen/names.ts          procedural naming

  render/Sky.ts         starfield, distant galaxies, milky band
  render/Nebula.ts      raymarched volumetric nebulae
  render/GalaxyView.ts  the galaxy map render
  render/Star.ts        star surface, corona, flare
  render/Planet.ts      quadtree LOD sphere + terrain material
  render/Atmosphere.ts  physically based scattering shell
  render/Clouds.ts      volumetric cloud shell
  render/Rings.ts       ring system
  render/PostFX.ts      the noir grade pipeline

  ship/Ship.ts          procedural hull + thrusters
  ship/FlightModel.ts   6DOF newtonian flight
  ship/CameraRig.ts     damped chase camera
  ship/Warp.ts          FTL transition

  ui/Hud.ts             DOM overlay HUD
  ui/StarMap.ts         galaxy/system map UI
  audio/Audio.ts        procedural ambience

  game/Universe.ts      current galaxy/system/planet state machine
```

---

## 9. Definition of done

Your module is done when:

- `npm run typecheck` passes with zero errors.
- `npm run build` succeeds.
- It renders without WebGL warnings in the console.
- It holds 60 fps at `high` tier in the scene it is responsible for.
- `dispose()` releases every GPU resource it allocated.
- It looks like section 6 describes. A reviewer will screenshot it and compare
  it, blind, against reference frames from shipped AAA space games. "It works"
  is not done.

---

## 10. Renderer API contract

Every renderer follows the same three-part shape so the integrator can wire
them without reading their internals:

```ts
export class XRenderer {
  constructor(spec: <its spec type>, quality: QualitySettings);
  /** Add this to the scene yourself. The renderer never touches ctx.scene. */
  readonly object3d: Object3D;
  update(dt: number, ctx: EngineContext, view: ViewState): void;
  dispose(): void;
}
```

`ViewState` is passed to every renderer each frame and is defined in
`src/render/ViewState.ts`:

```ts
export interface ViewState {
  /** Camera position in this object's LOCAL space, kilometres. */
  readonly cameraLocal: Vector3;
  /** Unit vector from this object towards the dominant star. */
  readonly sunDirection: Vector3;
  /** Linear RGB of the dominant star, pre-multiplied by its intensity. */
  readonly sunColor: Color;
  /** Distance from camera to this object's centre, kilometres. */
  readonly distance: number;
  /** Seconds since boot — use for animation, never Date.now(). */
  readonly time: number;
}
```

Rules:

- A renderer **never** adds itself to the scene, reads global state, or looks
  up another renderer. It gets a spec, it produces an `Object3D`.
- A renderer **never** mutates its spec.
- Positions inside `object3d` are local (planet-centred). The integrator sets
  `object3d.position` in render space using the floating origin.
- Each renderer registers at least one shot via `registerShot()` from
  `@/game/Shots` inside a `registerXShots()` exported function.
