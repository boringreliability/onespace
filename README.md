# oneSpace

A procedurally generated noir space odyssey, rendered in the browser with
Three.js. Every galaxy, star, planet, mountain and cloud is derived from a
single 32-bit seed — nothing is downloaded, and the same seed produces the same
universe on every machine, forever.

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

### Local development with the cloud save

The game runs without a server (guest, local saves only). To sign in and sync,
run the API server beside Vite; Vite proxies `/api` to `127.0.0.1:8790`.
Node 24 or newer.

```bash
cp .env.example .env     # once; then fill in the Discord values
npm run dev:cloud        # database + server + Vite; Ctrl-C stops server and Vite
```

`dev:cloud` starts Postgres on 127.0.0.1:54328, builds `server/` into
`dist-server/`, then runs the server (migrates, listens on :8790) and Vite
together. The same by hand:

```bash
docker compose up -d db
node scripts/build-server.mjs
node --env-file=.env dist-server/index.mjs
npm run dev                                      # in another terminal
```

`PUBLIC_ORIGIN` must equal the Vite origin exactly (`http://127.0.0.1:5173`):
every write is refused unless its `Origin` header matches, and the Discord
redirect URL (`<PUBLIC_ORIGIN>/api/auth/discord/callback`) must be registered
in the Discord application. Rebuild the server after changing `server/`.
Server tests: `docker compose up -d db-test`, then `npm run test:server`.

## Controls

**Click the canvas first.** Steering is on the mouse and needs pointer capture;
until you click, only the keyboard works. The NAV ADVISORY line at the bottom
of the screen says so, and says it again whenever a chart has released the
pointer. It then suggests the next useful key, and stops suggesting each one
once you have used it a couple of times.

| | |
|---|---|
| mouse · arrow keys | pitch and yaw |
| `Q` / `E` | roll |
| `W` / `S` / wheel | throttle (integrated, not instant — it spools) |
| `X` | throttle to zero |
| `A` `D` | lateral thrusters |
| `R` `F` | up / down thrusters |
| `Shift` | boost |
| `Space` | brake |
| `Z` | flight assist on / off |
| `Tab` | cycle target |
| `K` | formation hold (flight assist on): hold speed relative to a targeted vessel or asteroid |
| `G` | cruise drive (in-system) |
| `T` | scan |
| `M` | local chart; wheel out for the galaxy chart |
| `J` | jump to the system selected on the galaxy chart |
| `C` | codex (the ship's log) |
| `V` | camera: chase → cockpit → orbit → cinematic |
| `F2` | screenshot (saved as a PNG) |
| `Esc` | pause: controls, mouse settings, quality, return to orbit |
| `L` | autopilot: land, lift off to orbit, or — with an asteroid targeted — fly to it and park |
| `,` / `.` | time compression (on the ground or in a stable orbit) |
| `B` | mine the targeted asteroid (within 0.5 km, nearly at rest relative to it); `B` again stops |
| `U` | refine the ice in the hold into propellant |
| `N` | repair the tank (600 kg metal and 400 kg silicate restore 4 % of its capacity) |
| `H`, then `1` / `2` / `3` | emergency exit, offered only with an empty tank: `1` cannibalizes the tank, `2` fires the beacon (the hold is jettisoned), `3` burns the cargo (from 1 000 kg) |
| `I` | resources screen: the hold, the beam's choice and what the cargo can become (refine, repair). Time stands still while it is open; not in cruise, a jump or the beacon's recovery |

Mining takes one resource per extraction, 150 kg a second, into an 8 000 kg
hold, and stops by itself when the hold is full or the resource runs out. The
beam takes only the resource chosen on the resources screen (ice to begin with);
a rock without it says `NO METAL HERE` (or whichever was chosen) and nothing
starts. The pause sheet lists every key.

On the resources screen:

| | |
|---|---|
| `↑` / `↓` | select a resource |
| `Enter` | the beam takes the selected resource (the HUD's MINE row shows it, e.g. `▸ READY · METAL`) |
| `O` | jettison 250 kg of it (or what is left) |
| `Shift+O` | jettison all of it |
| `I` / `Esc` | close |

Jettisoned cargo is gone, and the rock gets nothing back: the log says
`JETTISONED · 250 KG ICE`, and the jettison is kept in the save.

Crashing, or flying into the star, fades to black and puts the ship back in a
stable orbit, 0.6 radii above the nearest world, with the nose prograde. The
pause menu's **Return to orbit** does the same on request.

### In the chart

Drag to orbit, wheel to zoom, click a system or use the arrow keys, `Enter` (or
`J`, after closing the chart) to jump, `F` to search, `Esc` to close. A jump
takes 7.4 s whatever the distance, and the chart's estimate says so. Opening the
chart releases the pointer so you can click; click the canvas again afterwards
to fly.

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
planet → surface. There is no combat. The loop is **travel,
look, scan, log** — with a hold to fill from the asteroid belts and a tank to
keep topped up — and the reward is arriving somewhere no one has been and having
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
  The surface camera works: land in daylight and you get a level horizon, lit
  ground and the hull in frame. Measured on a landed ship — camera 72 m above
  the surface, pitched 20 degrees down, roll about the local vertical 6e-15
  degrees, horizon inside the field of view. The hull still reads small at the
  rig's default 200 m standoff; a closer landed framing is the remaining
  polish.
