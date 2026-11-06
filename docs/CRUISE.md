# Travelling inside a system

Two features, built together because neither is much use alone: a drive that
crosses a system in under a minute, and a chart that tells you what is worth
crossing to.

## The arithmetic that made this necessary

Sublight top speed is 60 km/s, boosted 180. One astronomical unit is 149.6
million km. Crossing it under thrust takes **nine and a half days**. Before
this, the inner system was scenery.

## The model: Elite, not KSP

The ceiling is proportional to how far the nearest surface is:

```
v_max = clearance × 0.35 /s        (clamped at 1.5e8 km/s ≈ 500 c)
```

Chosen over time compression after weighing both. Time warp is the physically
honest option and fits the patched-conic model already in use, but it turns
travel into waiting. This is a game about flying.

The proportional law buys three things at once:

1. **It cannot tunnel.** One step covers `rate × h` of the ship's own clearance
   — 0.58% at 60 Hz. That is what makes a 500 c ceiling safe inside a fixed-step
   integrator: the ship can never skip a planet or step across a
   sphere-of-influence boundary. `cruise.test.ts` asserts it for clearances
   spanning nine orders of magnitude, and `cruiseFlight.test.ts` asserts it
   again through the real `FlightModel` at three timesteps.
2. **It brakes itself.** Closing on a body, the ceiling falls with the gap, so
   arrival is asymptotic. You point; you are slowed.
3. **Travel is logarithmic.** `t = ln(r1/r0) / rate` — about 29 s from low orbit
   to 1 AU, and only a few more to reach five.

### What it costs

The ceiling is not a physical speed. At 1 AU of clearance it is roughly 170 c.
The code does not pretend otherwise: `FlightModel.stepCruise` suspends gravity
and drag, because a ship under cruise is not on a trajectory. On disengage the
drive bleeds the ceiling to 60 km/s over 0.9 s and hands back an ordinary state
vector, and the orbital machinery resumes with no special case. That bleed is
the one deliberate cheat in the model.

### The line that must not be softened

```ts
this.cruiseSpeed = Math.min(this.cruiseSpeed, cap);   // hard, every substep
```

Easing towards the ceiling instead of clamping to it would let speed lag the
ceiling on approach, which is exactly how a ship ends up inside a planet. It
looks identical at every moment except that one.

## Safety envelope

| | |
|---|---|
| Engage | max(1 200 km, 0.5 R) clearance, not landed, not in atmosphere |
| Hold | max(700 km, 0.3 R) clearance |
| Arrival | closing on the target (else the nearest body) inside 2 R clearance (r = 3 R), clipped to 0.9 r_soi |
| Spool | 2.0 s, abortable |
| Drop | 0.9 s geometric bleed to the circular speed √(μ/r), still under the clearance law; then orbit insertion |

v2: R is the radius of the body the clearance is measured to. The opening orbit
(4 474 km over Remit 31, R 7 240 km = 0.62 R) can now engage; v1's absolute
5 000 km refused it. On the drop, `ship/cruiseOrbit.ts` replaces the velocity
with the circular one about the ship's SOI parent, in the plane of (r, v), and
`Cruise` holds the engine at idle until the lever moves. That replaces the old
"bleed to 60 km/s along the nose" as the one deliberate cheat. With a target
locked (`target:changed`), the nose is steered (PD, critically damped, via
`FlightModel.command`) to the limb of the arrival sphere, so arrival is
near-tangential. Any pilot rotation input wins immediately.

Engage and hold thresholds differ on purpose: equal thresholds would flip the
drive on alternate frames for as long as a ship sat on the boundary.

`Universe.nearestGapKm` supplies the clearance. Unlike `nearestAltitudeKm`,
which goes null once a body is far away, this is never null and includes the
star — the one thing in a system you most want a fast drive to notice.

## Ownership

| File | Owns |
|---|---|
| `src/ship/CruiseDrive.ts` | The law and the state machine. Pure: no three.js, no clock. |
| `src/game/Cruise.ts` | The G key. Clearance in, ceiling into `FlightModel`. |
| `src/ship/FlightModel.ts` | `setCruise()` and `stepCruise()`. |
| `src/ui/SystemMap.ts` | The local chart, and all chart-key routing. |

`G`, not F — F is strafe-down. `J` remains the interstellar jump.

## The local chart

`M` now opens the **local** chart; wheeling out hands over to the galactic one.

**Radius is logarithmic.** A rocky world at 0.4 AU and an ice giant at 28 drawn
linearly is a dot at the centre and a dot at the rim. The log scale costs
geometric truth and buys a chart you can read; the exact numbers are printed
beside the selection, so nothing is hidden.

**Orbits are sampled, not ellipses.** A log radial scale maps an ellipse to
something that is not an ellipse, so an SVG `<ellipse>` would be a lie in
exactly the eccentric cases where the shape matters. Sixty-four samples through
the real Kepler solution, scaled radially, is honest and cheap.

The readout quotes a crossing time from `cruiseTravelSeconds`, the closed form
of the same law the drive flies by — so the chart and the drive cannot disagree.

## Two seams this uncovered

- **The galactic chart's open state has two owners.** `MapMode` holds the
  camera, `ui/StarMap` holds the UI, and each had its own `ui:toggle-map`
  listener. Rerouting only one of them opened both charts at once on the first
  press. Both now listen to `ui:toggle-galaxy`.
- **`M` could never stow the galactic chart.** `MapMode` pauses the universe
  while its chart is up, and `Pilot` — which turns the key into `ui:toggle-map`
  — returns before reading input when paused, so only Escape worked. That was
  true before this change too. `SystemMap`'s capture-phase key handler now
  covers it, because chart routing lives in one place.

A new bus event, `ui:chart { chart: 'system' | 'galaxy' | null }`, says which
chart owns the screen. Anything that must stand down while a chart is up listens
there rather than to one chart's private open/close events — which is how the
local chart first shipped with the flight HUD legible straight through it.

## Known gaps

- **No moons on the chart.** They exist in the data and are not drawn; at system
  scale they would sit inside their planet's dot. Needs a zoom level.
- **No route line or auto-approach.** You select a body, read the time, and fly
  it yourself. A "point me at it" affordance is the obvious next step.
- **Cruise has no fuel, heat or interdiction cost.** It is free, so there is no
  reason not to use it. That is fine for now and will not stay interesting.
