# Procedural Spaceship Engine — first delivery report

Written after four review rounds and the first integration into the live
universe. Everything below is measured unless it says otherwise.

---

## 1. Architecture

The system is split at one seam and everything follows from it:

```
seed ──▶ ShipBlueprint (pure data, no three.js) ──▶ Object3D
         │                                          │
         the authoritative truth                    a dumb visualiser
```

`src/gen/ships/` never imports three.js and never calls `Math.random()`. It
takes a seed and returns readonly data. `src/render/ships/` consumes that data
and invents none. The test that keeps the boundary honest is that a blueprint
can be printed as JSON and two seeds diffed against each other — which
`scripts/ship-smoke.mjs` does on every run.

| File | Owns |
|---|---|
| `gen/ships/types.ts` | the blueprint contract; append-only once published |
| `gen/ships/families.ts` | three manufacturing cultures and seven role requirements |
| `gen/ships/blueprint.ts` | the generator; one derived seed namespace per stage |
| `gen/ships/physics.ts` | mass, inertia, thrust, collision, scan |
| `render/ships/volumes.ts` | lofts, trusses, rings, panelling, LOD |
| `render/ships/greebles.ts` | the detail vocabulary and its scatter |
| `render/ships/ShipMaterial.ts` | surfaces, wear, markings, emissives |
| `render/ships/propulsion.ts` | nozzles, plumes, RCS, navigation lights |
| `render/ships/ShipMesh.ts` | **the assembler** — the only file that knows all four exist |
| `game/Showroom.ts` | isolated review mode and the shot table |
| `game/Traffic.ts` | the fleet in the live universe |

Generation runs in a fixed order — role and family, spine, primary volumes,
propulsion, module layout, secondary volumes, accents, greebles — and each
stage derives its own seed with `hashSeed(seed, stage)` so that adding a draw
in one stage can never renumber another. That property is asserted, not
assumed: the self-test generates the same params twice and deep-compares, and
also checks that call order does not affect the result.

**The assembler is a deliverable, not glue.** It owns three decisions no
individual module could make: the draw-call budget (a faction vocabulary is up
to 24 greeble families, so the dense ones stay instanced and the long tail is
welded into the hull buffer), the occluder set (only the assembler knows the
part ids the geometry allocated, and without them a caster whose id matches its
own surface cannot be rejected), and when uniforms are pushed (materials are
shared between ships of a family, so per-ship values go in `onBeforeRender`,
never in `update()`).

---

## 2. Visual decisions

**Function decides form.** The role is not a label on a shared hull. A
freighter's payload is its largest primary mass; a miner carries visible
industrial machinery as structure rather than as bolt-ons. The generator
refuses placements that violate this and records the refusals — 624 over 16
hulls, about 39 per ship. A generator that refuses nothing has not checked.

**Silhouette before greebles.** Detail is added last and may never rescue a
weak form. The silhouette shots render flat matte with rim light only, so the
critic judging form has no surface to hide behind.

**Greebles are assemblies, not primitives.** Inherited from the existing player
ship, where a bare box and a bare cylinder had given the whole hull exactly two
silhouettes. Each greeble is authored in a unit footprint so one per-instance
scale drives all of them.

**Panel size is derived from hull dimensions, not a constant.** A plate on a
30 m courier and on a 4 km capital cannot be the same size on screen. The
geometry and material modules agree on it through a uniform rather than each
inventing a rule.

**Colour is rationed.** Desaturated steel base, one saturated faction accent,
emissives as the only other saturated element. Three factions are three
manufacturing cultures — construction method, proportion rules, symmetry
policy, greeble vocabulary, radiator architecture — not three palettes.

**Twist is rationed too.** A quarter of non-arc volumes get under 0.42 rad in
total, eased along the run; a constant rate reads as a screw thread.

---

## 3. What the critics found

Five specialists, none of whom implemented what they judged: silhouette,
variation, visual AAA, performance, gameplay/physics. Findings were assigned to
the owning file, and each required a concrete fix and a way to verify it.

### Round one — 47 findings, all five FAIL

- **`ship-hero.png` was showing the wrong vessel.** The silhouette critic
  proved it by counting engine bells across frames with identical camera specs:
  2 versus 6. It was the hand-authored player ship.
- **Zero enclosed negative space**, measured by hole-filling the thresholded
  silhouettes. A monocoque tube with everything buried inside shows no load
  path at all.
- **The role read wrong.** Shown a freighter, the critic guessed submarine,
  patrol tender, gunboat. No payload mass anywhere in the outline.
- **The silhouette shifted at every LOD step**: IoU 0.928 / 0.891 / 0.863, area
  down 6.5% end to end, losing the sail apex, the bow wedge and the antenna
  masts.

### Round two — two critics flagged regression

The `regressed` field was added to the verdict schema for exactly this, and
earned its place immediately: performance and physics both judged the iteration
worse *as a design* than its predecessor, which no amount of finding-counting
would have surfaced.

- **The hero collision was a NAME, not a renderer bug.** The isolation fix had
  worked — `hero-close`, `high-quality` and `lod0` now agreed on one vessel.
  But `Ship.ts` registers a shot called `ship-hero`, and the ship set was being
  captured with `shoot.mjs`, which takes every registered shot.
  `scripts/ship-review.mjs` had read `SHOWROOM_SHOTS` explicitly all along.
- **The silhouette lens was 9 degrees**, two and a half times narrower than any
  other hull-framed shot. At that focal length the fill solver parks the camera
  on the plating: empty frame collapsed from 96.2% to 20.0% and the subject
  clipped all four edges.

### Round three — the attribution

The performance engineer bundled the generator and renderer with esbuild,
instantiated real `ShipMesh` objects under node, counted meshes, and reconciled
all 21 rows of the manifest to the exact triangle. Two findings followed, and
both inverted a conclusion.

- **The ships were never over budget.** `PostFX` sets
  `renderer.info.autoReset = false`, so `Engine.stats()` reports scene *plus*
  every post pass — 22 draws at high tier. Subtract it and a ship is 9–10
  against a budget of 12. The reported "23 to 67, two to five times over" was a
  whole-frame number read as a per-ship number.
- **Six review frames were not photographs of LOD0.** The showroom set the rung
  only when a shot named one, the visual is cached across shots, and the
  harness runs shots in registration order — so `ship-lod2` and
  `ship-extreme-distance` executed first and left their decimated hull behind.
  `ship-hero-close`, `ship-greeble-close` and `ship-high-quality` were pictures
  of a **two-triangle impostor**. `ship-high-quality` went from 2,250 triangles
  to 58,500 when it was fixed.

### Round four — the blind comparison

Scored on ten axes before provenance was revealed, the procedural hull beat the
hand-authored player ship **61 to 42**.

| | hand-authored | procedural |
|---|---|---|
| readable scale | 2 | 7 |
| detail hierarchy | 4 | 7 |
| functional credibility | 3 | 7 |
| silhouette | 4 | 7 |
| originality | 6 | 4 |
| lighting | 6 | 5 |

The judge's closing note is worth preserving: knowing that A was hand-authored
did not soften it, because "a human built that lozenge deliberately, chose to
hang the nacelles off the thrust axis, and chose to lay one noise density over
every surface — those are authored decisions and they are the wrong ones, and
'a person made it' is not a defence."

It also **struck its predecessors' work where the ground had been false**:
every prior finding about flat surfaces, absent greebles or low detail density
had been levelled at an impostor and was void. Two survived and were real — the
hull was too light, and every frame was composed on empty black.

---

## 4. Measured change between iterations

| | round 1 | current |
|---|---|---|
| enclosed negative space, side silhouette | 0 regions | present: lattice keel, payload on pylons |
| silhouette signatures distinct / 200 seeds | 66% | 89% |
| module mixes distinct / 200 seeds | 85% | 90% |
| lit-hull median luminance | 165/255 | brought down to near-black industrial |
| LOD ladder, triangles | non-monotonic | 58.5k / 22.0k / 3.0k / 0.1k |
| ship draw calls, LOD0 | unmeasured (frame counted instead) | 9–10 against a budget of 12 |
| hull archetypes reachable | 9 of 9 | 9 of 9 |
| twist axis | inert, pinned to 0 | corrected and in use |

Physics was validated against analytic solutions throughout: inertia tensors
against closed-form box and cylinder shells, and role ordering emerging from
the square-cube law rather than a table — courier 21.2 g, survey 11.4 g,
freighter 6.4 g, tanker 4.9 g, with mass proportional to L^2.927.

---

## 5. Remaining weaknesses

Stated plainly, because a report that only lists wins is not a report.

1. **Originality.** The blind judge scored it 4, and named it as the one axis
   provenance predicts and polish will not fix: a system that reliably produces
   competent haulers still owes an answer for how a seed produces something you
   would *remember*. Turning the twist axis back on helped; it is not the
   answer.
2. **Composition.** Showroom frames are a museum turntable on black — no
   occluder, no flare, and a drive that lights nothing around it. `Traffic.ts`
   addresses this structurally rather than cosmetically, but the showroom shots
   themselves are unchanged.
3. **Chequer artefacts** on some panels near the drive block read as untextured
   placeholder.
4. **LOD silhouette stability** was 10.66% XOR at the first step against a 3%
   bar at last measurement. Improved but not closed.
5. **Traffic drifts.** Parked vessels are stationary in world space while the
   player orbits at 3.89 km/s, so contacts separate over time.
6. **No `generationVersion` discipline.** Unlike Procedura, this project edits
   generators in place and pins nothing. The moment anything persists a ship,
   that becomes a defect.
7. **Ship.ts's `addBox`/`addCylinder` wind faces inward.** Reported by the
   geometry agent and verified against `three.BoxGeometry`. The reference hull
   is unaffected but its 31 bolt-on boxes, 13 cylinders and 240 greeble
   instances are not. Deliberately not fixed — `Ship.ts` is frozen by BRIEF §2
   and this needs its own review.

---

## 6. Process findings

More transferable than the code, and earned the hard way.

**Every defect of consequence lived on a boundary, not inside a module.** Two
agents defined `ShipDriveState` differently; `StarMap` declared a five-method
adapter of which three were implemented; the assembler appeared in the
ownership table but in nobody's brief, so nobody built it. A typechecker
validates the inside of each contract and nothing validates that the contracts
meet.

**Ownership written in a document is not ownership.** Agents read their prompt.
If a boundary does not appear in someone's *task*, it is unowned however
clearly the map assigns it.

**Contracts must cover the protocol, not only the data.** The data crossing
each seam was specified carefully; who calls whom each frame was not. Almost
every failure was of that shape — `StarMap.update()` never called, gallery
renderers never driven, `ShipMesh` never forwarding the rung to propulsion.
Four correct modules, none of them running.

**Measurement beat judgement, repeatedly.** The findings that changed
conclusions were all numbers: engine bells counted across frames, holes counted
in filled silhouettes, a manifest reconciled to the exact triangle. Three times
a measurement inverted a conclusion, and each time the wrong conclusion had
been mine.

**A review loop must be able to invalidate itself.** Two rounds critiqued a
two-triangle impostor. The round-four judge striking its predecessors' findings
was the most valuable single act in the process.

---

## 7. Next recommended Ward

**Co-orbital traffic and the approach.** Give parked vessels the orbit of the
body they are at, so a contact stays where you left it, and add the one thing
the showroom can never test: what a ship looks like while you fly towards it —
LOD switching under real motion, plume lighting against a planet, the hull
crossing a terminator.

It is small, it closes the most visible gap from the first integration, and it
puts the fleet in front of the only critic whose opinion has not yet been
collected: someone flying the game.

After that, in order: the composition problem in the showroom shots; the
chequer artefact; and `generationVersion` discipline before anything persists a
ship.
