# oneSpace — Procedural Spaceship Engine

**Read this before writing a line.** It is the contract every agent on this
system builds and is reviewed against. `ARCHITECTURE.md` still applies in full;
this document adds to it and never overrides it.

---

## 1. What we are building

A generator that turns `(seed, faction, role, sizeClass, age, …)` into a
**serialisable blueprint**, and a renderer that visualises only that blueprint.

```
seed ──▶ ShipBlueprint (pure data, no three.js) ──▶ Object3D
         ▲                                         ▲
         the authoritative truth                   dumb visualiser
```

The generator must never return a scene graph. If you cannot print the ship as
JSON and diff two seeds, the architecture is wrong.

Same seed + same `generationVersion` ⇒ byte-identical blueprint. Forever, on
every machine. Never call `Math.random()`; derive with `hashSeed(parent, salt)`
from `@/math/rng`.

---

## 2. What already exists, and what to reuse

`src/ship/Ship.ts` is the player's ship. **It is baseline and reference. Do not
rewrite it, do not degrade it, do not "unify" it into the new system.** It stays
as the hero vessel. Read it — it solved several problems you are about to hit:

| Technique | Where | Why it matters |
|---|---|---|
| Swept superellipse hull | `class HullShape` | One parameter family spans boxy freighter to rounded courier without changing code paths |
| Greebles as *assemblies*, not primitives | `greebleHatch/Bracket/Ribbed/Stack/Pipe` | A bare box and a bare cylinder gave the whole hull exactly two silhouettes. Each greeble is authored in a unit footprint so one per-instance scale drives all of them |
| One merged indexed buffer | `class HullBuilder` | The whole hull is a handful of draw calls |
| Per-vertex `aAO`, `aWear`, `aPart` | `HULL_VERT` | Wear and occlusion ride the geometry rather than a screen-space pass |
| Analytic contact shadows | `uOcc[28]` + `uOccPart` | Greebles darken the hull under them without a shadow map. `uOccPart` stops a part shadowing itself |
| Analytic window lamps | `uLamp[6]` | Lit interiors spill onto surrounding plate |
| `logdepthbuf` chunks | `HULL_VERT`/`HULL_FRAG` | **Mandatory.** The engine runs a logarithmic depth buffer; a material that omits these writes linear depth and sorts wrongly against everything else. This cost us a day |

Also reuse from the wider codebase: `shaders/chunks.ts` (`onespace_noise`,
`onespace_color`), `Rng`, `registerShot`, the `ViewState` contract, and the
capture harness in `scripts/shoot.mjs`.

---

## 3. Ownership map — stay in your lane

```
docs/ships/BRIEF.md            this file                        [integrator]
docs/ships/ANALYSIS.md         technique catalogue              [analyst]
docs/ships/REPORT.md           final written report             [integrator]

src/gen/ships/types.ts         BLUEPRINT CONTRACT               [architect]
src/gen/ships/families.ts      faction visual DNA + roles       [industrial designer]
src/gen/ships/blueprint.ts     the generator                    [architect]
src/gen/ships/physics.ts       mass, inertia, collision, scan   [physics]

src/render/ships/ShipMesh.ts       assembly + LOD               [geometry]
src/render/ships/volumes.ts        lofts, trusses, profiles     [geometry]
src/render/ships/greebles.ts       detail families              [geometry]
src/render/ships/ShipMaterial.ts   surfaces, wear, markings     [material]
src/render/ships/propulsion.ts     engines, plumes, RCS, lights [propulsion]

src/game/Showroom.ts           isolated review mode             [integrator]
```

Only create or modify files listed against your role. If you need something
from another module, import its declared interface and say so in your report.
`src/gen/ships/types.ts` is append-only once the architect has published it.

---

## 4. Non-negotiable design order

Generate in this order. Each stage may only read what earlier stages produced.

1. **Role and family** — what is this ship *for*, and who built it
2. **Structural spine** — the load path from engines to nose
3. **Primary volumes** — the two or three masses that make the silhouette
4. **Propulsion architecture** — thrust axis through the centre of mass
5. **Module layout** — placed on compatible sockets, checked for clearance
6. **Secondary volumes** — radiators, tanks, gear, sensors
7. **Silhouette accents** — the one or two shapes that make it recognisable
8. **Greebles** — last, and never to rescue a weak form

**Function decides form.** A freighter must look like it carries cargo; a miner
must carry visible industrial machinery. A role that is only a label on the same
hull is a failure, not a variation.

---

## 5. Socket rules

Modules mount on typed sockets: `engine`, `rcs`, `cockpit`, `bridge`, `sensor`,
`docking`, `airlock`, `cargo`, `habitat`, `reactor`, `radiator`, `weapon`,
`mining`, `salvage`, `landing`, `service`, `navlight`, `emblem`.

Placement must respect, and the physics reviewer will check:

- no engine exhaust intersecting the hull
- a cockpit with an actual view cone forward
- landing gear on the underside, with clearance below every other part
- radiators not buried inside other volumes
- weapons with unobstructed fields of fire
- docking ports reachable from outside
- thrust axis through the centre of mass, or an explicit reason why not

---

## 6. Performance budgets

Per ship, at `high` tier:

| | budget |
|---|---|
| draw calls, LOD0 | ≤ 12 |
| triangles, LOD0 | ≤ 120 k medium hull |
| triangles, LOD1 | ≤ 25 k |
| triangles, LOD2 | ≤ 3 k |
| impostor | 1 quad |
| materials per ship | ≤ 3, shared across ships of a family |
| generation time | ≤ 25 ms medium hull, and never blocking for capital ships |
| allocations in `update()` | zero |

Repeated details use `InstancedMesh`. Geometry and materials are shared between
compatible ships. Every GPU resource is freed in `dispose()`; say in your report
what you allocated and where it is freed.

---

## 7. Art direction

`ARCHITECTURE.md` section 6 is binding and unchanged: dark industrial noir,
rationed colour, amber instrument accents, cool engine light, enormous dark
surfaces, hard terminators, everything dirty.

Additionally, for ships specifically:

- **Panels scale with the ship.** A plate on a 30 m courier and a plate on a
  4 km capital cannot be the same size on screen. Panel size is derived from
  hull dimensions, not a constant.
- **Detail follows function and orientation.** Soot aft of thrusters, grime
  streaked along the airflow, wear on edges and around hatches, heat staining
  near radiators. Uniform noise laid evenly over everything is the single most
  common failure and will be rejected.
- **History must be visible in the geometry**, not only in the material: a
  replaced panel sits slightly proud and in the wrong shade, a field repair is
  an asymmetric plate, a torn-off module leaves its mounting stubs.

---

## 8. Definition of done

A ship is approved only when a critic who did not build it agrees that:

- the silhouette is distinct and interesting from side, front and three-quarter,
  **as a black shape with no materials**
- the role is roughly readable without a label
- large, medium and small forms form a clear hierarchy
- it looks engineered, not assembled at random
- engines and thrusters make physical sense
- scale is readable
- wear tells a specific story
- the faction's DNA is recognisable across seeds, and different seeds are
  genuinely different ships rather than the same ship redressed
- it holds up against black space, against a star, and against planetshine
- it holds up at low, medium and high quality, and at LOD0 through impostor
- the budgets in section 6 are met

"Good enough", "impressive for procedural", "works technically" and "can be
improved later" are not approvals.
