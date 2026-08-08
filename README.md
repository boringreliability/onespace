# oneSpace

A procedurally generated noir space odyssey, rendered in the browser with
Three.js. Every galaxy, star, planet, mountain and cloud is derived from a
single 32-bit seed — nothing is downloaded, and the same seed produces the same
universe on every machine, forever.

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Click the canvas to capture the pointer.

## Controls

**Click the canvas first.** Steering is on the mouse and needs pointer capture;
until you click, only the keyboard works. `Esc` releases it again.

| | |
|---|---|
| mouse | pitch and yaw |
| `Q` / `E` | roll |
| `W` / `S` / wheel | throttle (integrated, not instant — it spools) |
| `A` `D` | lateral thrusters |
| `R` `F` | up / down thrusters |
| `Shift` | boost |
| `Space` | brake |
| `V` | camera: chase → cockpit → orbit → cinematic |
| `M` | galaxy chart |
| `T` | scan |
| `Tab` | cycle target |
| `J` | warp |
| `L` | land |

### In the chart

Drag to orbit, wheel to zoom, click a system or use the arrow keys, `Enter` to
jump, `F` to search, `Esc` to close. Opening the chart releases the pointer so
you can click; click the canvas again afterwards to fly.

### Reading the instruments

**VEL** is speed relative to the nearest body — the thing you are about to
arrive at or hit — not relative to the star. Parked in a stable orbit it holds
steady; the same ship reads ~53 km/s against the star, which is a true number
that answers no useful question.

**ALT** is height above that body's *surface*: distance to its centre minus its
radius. In a circular orbit it should barely move. If it climbs steadily you
are not in an orbit, you are leaving.

**0.0G** is the accelerometer. Free fall reads zero, as a real one does — so an
orbit reads 0G no matter how fast you are going.

## What it is

You fly one ship through a universe generated on demand: galaxy → star system →
planet → surface. There is no combat and no inventory. The loop is **travel,
look, scan, log** — the reward is arriving somewhere no one has been and having
the instruments tell you what it is.

The tone is *Farscape* by way of 1940s film noir: hard shadows, amber
instrument glow, colour rationed everywhere except where it matters.

## How it is built

```
src/
  core/      engine, event bus, quality tiers, input, floating origin
  math/      deterministic RNG (splitmix32) — generation never calls Math.random
  shaders/   one shared GLSL library, registered into three.js's #include
  gen/       PURE generation: galaxy, systems, planets, terrain, orbits, names
  render/    sky, nebulae, stars, planets, atmosphere, clouds, rings, post
  ship/      6DOF flight, camera rig, procedural hull, warp
  ui/        instrument HUD, star map
  audio/     fully synthesised — no audio files
  game/      universe state, pilot loop, map mode, module registry
```

The seam that makes this work is `gen/types.ts`. Generation is pure — it takes a
seed and returns plain data, and never imports three.js. Rendering consumes that
data and never invents any. Neither half imports the other, which is what let
twenty subsystems be built independently and then wired together.

`ARCHITECTURE.md` is the contract every module was built and reviewed against.
Read it before changing anything.

### Three tricks make a 1:1 universe renderable

1. **1 render unit = 1 km**, so the numbers stay small.
2. **Logarithmic depth buffer**, so a cockpit 2 m away and a star 150 million km
   away can share a depth buffer.
3. **Floating origin** (`core/FloatingOrigin.ts`) — world positions stay float64
   and the world moves to the camera, so float32 never has to represent a large
   coordinate.

## Verification

```bash
npm run typecheck            # strict, must be clean
npm run build
node scripts/gen-smoke.mjs   # 195 seam assertions over the generation layer
node scripts/shoot.mjs       # capture every hero shot to review/latest
```

`scripts/shoot.mjs` boots the built game in headless Chromium, drives it to each
named camera setup registered via `game/Shots.ts`, advances a **fixed** number of
simulated frames so streaming and damping settle identically on any machine, and
writes a PNG per shot. It reports draw calls, triangle count and any console
error. That harness is how the visual work was reviewed, and it is the fastest
way to see whether a change broke something you were not looking at.

```bash
node scripts/shoot.mjs planet-orbit --out review/mine --width 2560 --height 1440
```

## Known gaps

- The atmosphere shell is not yet fed the scene depth texture, so there is no
  aerial perspective over terrain — the limb and sky are correct, distant
  ground haze is not. `AtmosphereRenderer.setDepthTexture()` is waiting for it.
- `Planet.ts` still applies its own cheap limb and haze terms, which
  double-count against the real scattering shell on worlds that have one.
- Landing works and the game now knows it: the ship touches down, the throttle
  is cut, the arrival is graded in the log, and the HUD reads 0 m/s at 0 m.
  The surface camera works and is level: land in daylight and you get lit
  terrain and stars, with the camera's roll about the local vertical measured
  at 1.6e-15 degrees. The hull itself is still outside the frame — the orbit
  rig's elevation puts it below the view — so the last piece is a landed
  framing of its own rather than reusing the inspection camera's.
