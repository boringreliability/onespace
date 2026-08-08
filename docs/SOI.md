# Sphere of influence — design

**Decision.** oneSpace adopts the Kerbal Space Program model: patched conics
with an explicit parent body. The ship's canonical state is stored *relative to
its parent*, exactly one body's gravity acts at a time, and crossing a boundary
converts the state vector once.

**Why.** The engine already carries two frames without having decided to.
`FlightModel.referenceVelocity` exists and feeds the thrust limiter and the HUD,
but positions are still integrated in the star-centred inertial frame. So a body
is the parent of your *velocity* and not of your *position*, and every consumer
has to remember to add the planet's 49 km/s by hand. Traffic forgot, landing
forgot, and both looked like an engine-level frame mismatch when they were not.
Making the choice complete removes the class of bug rather than the instances.

The alternative — what No Man's Sky does — is to give planets no orbital motion
at all. That genuinely dissolves the problem, and it costs the thing this
project has: a system where the world you are orbiting is going somewhere.

---

## 1. The model

```
ship.parent      : Body | null      // null = the star itself
ship.position    : Vector3          // km, RELATIVE TO PARENT
ship.velocity    : Vector3          // km/s, RELATIVE TO PARENT
```

World position, needed only for rendering and for the floating origin, is
derived: `world = parent.world + position`.

**Gravity.** One source: the parent. Not a sum. This is the patched-conic
approximation and it is a feature — it makes trajectories predictable and
cheap, and it is what makes an orbit *stay* an orbit over hours of play.

**SOI radius.** The standard two-body result:

```
r_soi = a · (m / M)^(2/5)
```

`a` is the body's semi-major axis about *its* parent, `m` its mass, `M` the
parent's. Compute it once per body at system entry and cache it on the body.
The star's SOI is unbounded within the system.

## 2. Transitions

Checked once per frame, after the ship has been integrated:

- **Descending:** if the ship is inside a child's SOI, that child becomes the
  parent.
- **Ascending:** if the ship is outside the current parent's SOI, the parent's
  own parent takes over.

Both use the same conversion, and it is the only place frames are crossed:

```
position += oldParent.world - newParent.world
velocity += oldParent.velocity - newParent.velocity
```

Nothing else in the game may perform this conversion. If a second copy of these
two lines appears anywhere, the design has failed.

Hysteresis: leave at `1.02 · r_soi`, enter at `0.98 · r_soi`, so a ship
skimming the boundary does not flip parents every frame.

## 3. What this fixes for free

- **Traffic.** A vessel placed at a parent-relative offset stays there. No
  station-keeping, no captured basis, no 49 km/s drift.
- **Landing.** A landing site is a parent-relative position. It does not slide.
- **Docking.** Two ships with the same parent share a frame by construction.
- **Procedura.** Its surface layer already works in a planet-local frame, so
  the handover becomes "here is your parent and your relative state" rather
  than a coordinate negotiation.

## 4. What must not regress

- A coasting ship holds its altitude to the centimetre. That is measured today
  and must stay true.
- `src/gen/frame.test.ts` must keep passing: analytic orbital velocity agrees
  with the derivative of position, and stored periods satisfy Kepler's third
  law.
- The floating origin still tracks the ship's *world* position; only the
  authoritative storage changes.
- The 52 existing tests stay green.

## 5. Migration

`FlightModel.position` and `.velocity` change meaning. Every consumer must be
found and converted, not just the obvious ones:

| Consumer | Today | After |
|---|---|---|
| `Universe.applyGravity` | sums star + nearby bodies | one source: the parent |
| `Universe` rendering | `origin.toRender(body.world)` | unchanged — bodies stay in world coordinates |
| `Pilot` | `origin.toRender(flight.position)` | `origin.toRender(flight.worldPosition)` |
| `Traffic` | station-keeping offsets | parent-relative offsets |
| `Universe.placeShipOnArrival` | world position + composed velocity | parent-relative, and the composition disappears |
| HUD speed | `relativeSpeed` | `velocity.length()` — it is already relative |
| `referenceVelocity` | a patch over the missing frame | deleted |

That last row is the tell that this is the right change: the mechanism that
exists today to work around the missing frame stops being needed.

## 6. Acceptance

1. A ship spawned in orbit holds altitude to the centimetre over five minutes.
2. A ship given a parent-relative position and zero relative velocity stays put
   above the same terrain, indefinitely.
3. Dropping a ship from 1.5 km with 20 m/s of descent reaches the ground and
   emits `ship:touchdown`. This is the measurement that has failed all session.
4. Flying from low orbit out past the SOI boundary and back switches parents
   exactly twice, with no visible discontinuity in position or velocity.
5. A moon's SOI is entered and left correctly when passing near it.
6. All existing tests stay green, plus new ones for the SOI radius formula, the
   transition conversion, and hysteresis.
