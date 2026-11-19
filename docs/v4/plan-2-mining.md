# Delplan 2: asteroider og mining

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Systemer med `hasAsteroidBelt` får et rigtigt bælte med flyvbare asteroider. Spilleren kan
sætte kurs mod bæltet, matche fart med en asteroide, scanne den, udvinde ressourcer til lasten,
raffinere is til brændstof og reparere kannibaliseret tank. Det er DESIGN-succeskriteriets "min en
asteroide og tank op".

**Architecture:**
- **Ren generator:** `gen/belt.ts` er ren og deterministisk. Ud fra systemets seed placerer den et
  bælte og et fast sæt *felter* (klynger) langs bæltet. Hvert felt har sin egen Kepler-bane og 12-30
  asteroider med faste offsets omkring feltets centrum.
- **Positioner:** beregnes statsløst af `orbitalPosition`/`orbitalVelocity` med `universe.orbitSeconds`.
  Intet skal gemmes ud over udtømning (verdens-tilstand, P2).
- **Last:** `ship/cargo.ts` følger `Propellant`-mønstret. Alle ressource-ændringer er navngivne
  `CargoAction`s gennem én `applyCargoAction`, der udsender `cargo:action` (P3, D13).
- **Game-moduler:** `Belt` (forespørgsler, mål, udtømning) og `Mining` (udvind, raffinér, reparér).
- **Rendering:** `render/Asteroids.ts` (instanced varianter, få draw calls).

**Tech Stack:** TypeScript strict, Three.js r180, Vitest og Playwright (GPU).

**Spec:** `docs/v4/DESIGN.md` §5.5 (og §5.3 Start, §5.4 nødudgang, §4 P2-P4). Overblik:
`docs/v4/PLAN.md`. Beslutninger: `docs/v4/DECISIONS.md`.

## Global Constraints

- **Startsystem:** Fyss (`Universe.pickStartSystem`) har `hasAsteroidBelt = true`, målt over de 24
  kandidater. **Startsystemet ændres ikke.** Åbningsbillede, `AUTOLAND_DV_FACTOR` og D1-målingerne
  består.
- **Starttank:** et nyt spil starter med `START_FILL = 0.6` (Universe bruger i dag 1.0).
- **Ingen tilfældighed uden seed:** ingen `Math.random`. Bæltets seeds udledes med
  `hashSeed(system.seed, 'belt')` og `hashSeed(system.seed, \`field:${k}\`)`, aldrig fra
  `generateSystem`'s sekventielle rng (det ville flytte alle senere planeter).
- **Id'er (P4):**
  - felt: `field:<systemId>:<k>`
  - asteroide: `ast:<systemId>:<k>:<n>`
  - Begge er stabile på tværs af sessioner og klienter.
- **Last:** `CARGO_CAPACITY_KG = 8_000`. Lastens masse lægges i `flight.extraMassKg`, og en fuld last
  mærkes (DESIGN §5.3): tom → fuld tank og last ≈ 11 % trægere.
- **Ressourcer:** `'ice' | 'metal' | 'silicate' | 'rare'`.
- **Udvinding:**
  - inden for `MINE_RANGE_KM = 0.5` fra asteroidens overflade
  - relativ fart under `MINE_MAX_REL_KMS = 0.005`
  - én handling tager `MINE_ACTION_S = 4` s sim-tid og giver op til `MINE_YIELD_KG = 2_000` kg
  - begrænset af lastens frie plads og asteroidens rest
- **Raffinering:** al is → brændstof med `REFINE_ICE_TO_FUEL = 0.8` (kg/kg), begrænset af tankens frie
  plads. Uforbrugt is bliver i lasten. Tager `REFINE_ACTION_S = 8` s.
- **Reparation:** bruger `REPAIR_METAL_KG = 600` + `REPAIR_SILICATE_KG = 400` og sænker
  `capacityLossFrac` med `REPAIR_RESTORE_FRAC = 0.04`, aldrig under 0. Tager `REPAIR_ACTION_S = 10` s.
- **Taster (min beslutning, D14):** B = udvind, U = raffinér, N = reparér (R17: Y åbner Yard'en fra flight). De er frie i
  `src/core/Input.ts`, og en test sikrer det.
- **Sim-tid:** alle handlingstider er sim-tid. Formation-assist og handlinger skal virke ved 1×, og
  time compression må ikke ødelægge en handling (afbrydes rent).
- **Uden tank** (Yard, showroom, tests) er alle nye moduler inerte.
- **Ydelse:** v2/v3-budgettet holder.
  - Asteroiderne bruger højst ~8 draw calls (én instanced mesh pr. formvariant).
  - Ingen allokering pr. frame.
  - Alle `ShaderMaterial`s har `logdepthbuf`-chunks, og lyset kommer fra `keyLightAt`.
- **GS-TDD:** hver task stopper ved ⏸, til ejeren har sagt "godkendt" til testene.
- **Log:** beslutninger skrives i `docs/v4/DECISIONS.md` (fra D14).

## Review Focus

1. **Udtømt asteroide.** Udvinding giver intet, loggen siger "DEPLETED", og intet NaN. Testes i
   Task 5.
2. **Lasten fuld midt i udvinding.** Der tages kun den frie plads, loggen siger "HOLD FULL", og ingen
   negativ last. Testes i Task 2 og Task 5.
3. **Handlingen afbrydes** (skibet driver ud af rækkevidde, cruise, hop, pause, nødsignal).
   Forventet: intet udbytte, ingen halv handling, og ingen action udsendes. Testes i Task 5.
4. **Floating-origin-rebase og spring i `orbitSeconds`** (systemskifte, recovery). Asteroiderne
   springer ikke i forhold til skibet, og nye feltforespørgsler er korrekte. Testes i Task 3 og
   Task 4.
5. **Raffinering med fuld tank.** Kun det, der kan være, raffineres. Resten forbliver is i lasten, og
   der forsvinder ingen kg. Testes i Task 2.

---

### Task 1: Bæltet og dets felter (ren generator)

**Files:**
- Create: `src/gen/belt.ts`
- Test: `src/gen/belt.test.ts`

**Interfaces:**
- Produces:
  - `interface BeltSpec { systemId: string; innerAU: number; outerAU: number; halfThicknessAU: number; fieldCount: number }`
  - `function beltFor(system: StarSystemSpec): BeltSpec | null` — returns null when
    `!system.hasAsteroidBelt`
  - `interface AsteroidSpec { id: string; offsetKm: [number, number, number]; radiusKm: number; seed: number; composition: Record<Resource, number> /* kg extractable */ }`
  - `interface FieldSpec { id: string; index: number; orbit: OrbitSpec; radiusKm: number; asteroids: readonly AsteroidSpec[] }`
  - `function fieldSpec(belt: BeltSpec, systemSeed: number, k: number): FieldSpec` (memo-friendly,
    pure)
  - `function nearestFieldIndex(belt: BeltSpec, systemSeed: number, worldPos: Vec3Like, orbitSeconds: number, starMu: number): number`
  - Constants:
    - `FIELDS_PER_BELT = 512`
    - `FIELD_RADIUS_KM = 40`
    - asteroids pr. felt `[12, 30]`
    - radius `[0.05, 0.6]` km
  - `type Resource` is exported from `ship/cargo.ts` (Task 2). Task 1 defines it here *first* as
    `export type Resource = 'ice' | 'metal' | 'silicate' | 'rare'`, and Task 2 re-exports it.

- [ ] **Step 1: Write the failing tests.**
  - **Placement:** `Given Fyss (start system), Then beltFor returns a belt whose band [inner, outer] AU contains no planet's semi-major axis and lies between 0.6× and 3× the snow line 2.7·√max(0.02, L)`
  - **No belt:** `Given a system without hasAsteroidBelt, Then beltFor is null`
  - **Determinism:** `Given the same system twice (fresh generation), Then belt and fieldSpec(k) are deep-equal; a different k gives a different field`
  - **Ids:** `Given field k, Then its id is field:<systemId>:<k> and each asteroid id is ast:<systemId>:<k>:<n>, all unique`
  - **Asteroids:** `Given any field, Then 12–30 asteroids, radii in [0.05, 0.6] km, every offset within FIELD_RADIUS_KM, composition kg all ≥ 0 and finite`
  - **Is i hvert felt:** `Given any field, Then at least 3 asteroids carry ≥ 1 000 kg ice` (successkriteriet må ikke afhænge af held)
  - **Bane:** `Given a field orbit, Then its semi-major axis lies inside the band, e < 0.05, |i| < halfThickness/a`
  - **Nærmeste felt:** `Given a world position placed exactly at field k's position at time t, Then nearestFieldIndex returns k (for t = 0 and t = one tenth of an orbit)`
  - **Seeds:** `Given generateSystem before and after this task, Then planets are unchanged` (belt seeds use hashSeed, not the system rng)
- [ ] **Step 2:** `npx vitest run src/gen/belt.test.ts` → FAIL (module missing).
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4: Implement.**
  - Band: the largest gap between consecutive planet semi-major axes in AU whose ratio is ≥ 1.4 and
    which touches [0.6·snow, 3·snow].
  - Centre `c = √(a_in·a_out)`, half-width `0.15·c`, half-thickness `0.03·c`.
  - Without such a gap, `c = 1.2·snow`.
  - Fields sit on evenly spaced mean longitudes (k/FIELDS_PER_BELT·2π) with seed jitter.
  - `nearestFieldIndex` converts the ship's longitude to the epoch longitude for each field's a, so
    it searches ±2 indices and picks the smallest real distance.
- [ ] **Step 5:** Run → PASS, plus `npx tsc --noEmit`.
- [ ] **Step 6:** Commit (`test(v4-mining): …`, then `feat(v4-mining): belts and fields`).

### Task 2: Lasten og ressourcehandlinger (ren model)

**Files:**
- Create: `src/ship/cargo.ts`
- Modify:
  - `src/ship/propellant.ts` (no change in behaviour)
  - `src/core/EventBus.ts` (`cargo:action`)
- Test: `src/ship/cargo.test.ts`

**Interfaces:**
- Consumes: `Propellant` (Task 1 of plan 1), `Resource` (Task 1).
- Produces:
  - `class Cargo { constructor(capacityKg: number); readonly capacityKg: number; kg(r: Resource): number; get totalKg(): number; get freeKg(): number; }`
    - Mutation happens only through actions.
  - `type CargoAction = { kind: 'mine'; asteroidId: string; resource: Resource; kg: number } | { kind: 'refine' } | { kind: 'repair' } | { kind: 'jettison-all' } | { kind: 'cannibalize-cargo' }`
  - `interface CargoResult { ok: boolean; kgIn: number; kgOut: number; fuelKg: number; restoredFrac: number; reason?: 'hold-full' | 'nothing-to-refine' | 'tank-full' | 'insufficient' | 'nothing-to-repair' | 'empty' }`
  - `function applyCargoAction(cargo: Cargo, tank: Propellant | null, a: CargoAction): CargoResult`
    - emits `cargo:action { action, result }` exactly once
  - Constants:
    - `CARGO_CAPACITY_KG`
    - `REFINE_ICE_TO_FUEL`
    - `REPAIR_METAL_KG`
    - `REPAIR_SILICATE_KG`
    - `REPAIR_RESTORE_FRAC`
    - `CANNIBALIZE_CARGO_MIN_KG = 1_000`
  - `cannibalize-cargo` burns all cargo for 3 % of base tank capacity as propellant. There is no
    capacity loss; it is the cheaper half of the emergency exit (DESIGN §5.4 "last eller dele af sig
    selv").

- [ ] **Step 1: Write the failing tests.**
  - `mine`:
    - adds `min(kg, freeKg)`
    - with a full hold: `ok:false, reason:'hold-full'`, cargo unchanged
    - NaN or negative kg: refused, cargo unchanged
  - `refine`:
    - 5 000 kg ice into an empty 20 t tank gives 4 000 kg fuel, and the ice is removed
    - tank with only 1 000 kg free: 1 250 kg ice is used, the rest stays, and the totals balance to
      the kg
    - with no ice: `'nothing-to-refine'`
    - with a full tank: `'tank-full'`
    - without a tank: refused
  - `repair`:
    - with loss 0.12 and 600/400 kg: loss becomes 0.08 and the materials are removed
    - with loss 0.02: becomes 0, never negative
    - without materials: `'insufficient'`
    - with loss 0: `'nothing-to-repair'`, and nothing is spent
  - `jettison-all`: empties the hold; `kgOut` = total
  - `cannibalize-cargo`:
    - under 1 000 kg: refused
    - otherwise the hold empties and the tank rises by 3 % of base
  - Every action emits `cargo:action` exactly once, including refusals.
  - `totalKg` + `freeKg` = `capacityKg` always (a property test over a random sequence of actions with
    a seeded Rng).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement. Pure, no three import.
- [ ] **Step 5:** Run → PASS. Commit.

### Task 3: Bæltet i spillet: forespørgsler, mål, scanning, formation og start

**Files:**
- Create:
  - `src/game/Belt.ts` (`GameModule`, inert without a belt)
  - `src/game/worldState.ts` (depletion, in memory, P2)
- Modify:
  - `src/game/registry.ts`
  - `src/game/Universe.ts` (`START_FILL`; attach `Cargo`; `flight.extraMassKg = cargo.totalKg` every
    step)
  - `src/game/Targeting.ts` + `src/game/targets.ts` (third and fourth kind: `'field'`, `'asteroid'`)
  - `src/game/Scanner.ts` + `src/game/scanChoice.ts` (asteroid branch)
  - `src/gen/types.ts:294` (`ScanResult.kind` += `'asteroid'`)
  - `src/game/Log.ts` (`'asteroid'` → logbook `kind:'note'`)
  - `src/game/FlightSense.ts` + `src/ship/formation.ts` (`mayHoldFormation` also for asteroids)
- Test: `src/game/Belt.test.ts`, `src/game/worldState.test.ts`, and extensions in `Targeting`, `Scanner`,
  `FlightSense` and `Log` tests.

**Interfaces:**
- Consumes: Task 1-2.
- Produces:
  - `Belt`:
    - `get belt(): BeltSpec | null`
    - `nearestField(): FieldSpec | null`
    - `fieldWorld(id, out): boolean`
    - `asteroidWorld(id, out): boolean`
    - `asteroidVelocity(id, out): boolean` (world velocity, star frame)
    - `asteroidsNear(world, maxKm, out: string[]): number`
    - `asteroidSpec(id): AsteroidSpec | null`
    - `remainingKg(id, r): number`
  - `WorldState` (P2):
    - `depleted(id): Readonly<Record<Resource, number>>`
    - `recordMined(id, r, kg, playerId: 'local')`
    - entries `{ id, by, orbitSeconds, wallMs }` (P5: both clocks are stored)
  - Target ids are resolved by Targeting:
    - `field:…`: target radius = `FIELD_RADIUS_KM`, so cruise drops out ahead of the field
    - `ast:…`
  - Formation: the reference velocity is the asteroid's world velocity minus `shipParent.worldVelocity`
    when the parent is a body.

- [ ] **Step 1: Write the failing tests.**
  - `Given the start (new game), Then the tank is at START_FILL (0.6) and cargo is empty`
  - `Given 4 t ice in the hold, Then flight.extraMassKg = 4 000`
  - `Given Fyss's belt, When the ship sits at field k's position, Then nearestField().index = k and asteroidsNear returns that field's asteroids within FIELD_RADIUS_KM`
  - `Given orbitSeconds advances 600 s, Then asteroidWorld moves along orbitalPosition, and asteroidWorld minus fieldWorld stays the fixed offset`
  - `Given a floating-origin rebase, Then world positions are unchanged` (world is float64 star frame)
  - `Given Tab near a field, Then asteroids are among the cycle candidates; Given target ast:…, Then range, closing speed and HUD marker resolve`
  - `Given T on an asteroid target, Then the scan lists composition kg and remaining kg; ScanResult.kind = 'asteroid'; the log records key scan:ast:… once`
  - `Given an asteroid target within 50 km with FA on, When K, Then formation holds with the asteroid's velocity as reference`
  - `Given 3 kg mined from an asteroid, Then remainingKg falls by 3 kg and depleted is recorded with by='local' and both clocks`
  - `Given a system without a belt, Then Belt is inert and Targeting is unchanged`
  - **Budget:** `Given START_FILL at the opening orbit, Then a round trip (cruise spool + legs) from Remit 31 to the nearest field and back costs ≤ 10 % of base capacity`
    - Computed with `cruiseSpoolKg` + `cruiseLegKg` over the straight distance at t = 0.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4: Implement.**
  - Belt keeps a small memo of `FieldSpec` (the nearest ±2) and reuses arrays; no allocation per frame.
  - Targeting's `resolve()` gets two new branches.
  - The tank fill in Universe changes to `START_FILL`.
- [ ] **Step 5:** Run the full suite → PASS. Commit.

### Task 4: Asteroiderne kan ses

**Files:**
- Create: `src/render/Asteroids.ts`, `src/render/asteroidShape.ts` (pure: seed → displaced icosphere
  vertex data)
- Modify: `src/game/registry.ts`
- Test: `src/render/asteroidShape.test.ts`, `src/render/Asteroids.test.ts` (CPU part: instance
  allocation and positions)

**Interfaces:**
- Consumes: `Belt.asteroidsNear`, `asteroidWorld`, `asteroidSpec` (Task 3); `keyLightAt`;
  `ctx.origin.toRender`.
- Produces:
  - `ASTEROID_VARIANTS = 8` shared geometries (detail 4, ~2.5k tris), one `InstancedMesh` each,
    `MAX_ASTEROID_INSTANCES = 256`
  - The variant is chosen by `seed % 8`. Scale = radius, and rotation spins slowly from the seed.
  - `ASTEROID_DRAW_KM = 400`: asteroids beyond that are not drawn. Distant fields are shown as
    `BodyDots`-like points via Targeting's dot capacity, or not at all (builder's choice, recorded in
    DECISIONS).

- [ ] **Step 1: Write the failing tests.**
  - `asteroidShape(seed)`:
    - deterministic
    - no NaN
    - radius per vertex within [0.6, 1.25] of nominal
    - closed and well-formed normals (sum of face normals ≈ 0)
  - `Given 30 asteroids within 400 km, Then exactly 30 instances are active, spread over ≤ 8 meshes, and each instance's matrix places it at origin.toRender(asteroidWorld)`
  - `Given a rebase, Then the instance positions follow the new origin the same frame`
  - `Given 600 asteroids in range, Then at most MAX_ASTEROID_INSTANCES, the nearest first`
  - `Given the material, Then its shaders contain logdepthbuf_pars_vertex/…_fragment` (scene contract,
    as in Dust)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4: Implement.**
  - Linear HDR, `toneMapped:false`.
  - Lambert plus a weak ambient from keyLight. Composition gives the tint: ice a light blue-grey,
    metal darker and brighter in the specular, silicate brown-grey.
  - No allocation in `update`.
- [ ] **Step 5:** Run → PASS. Commit.

### Task 5: Udvind, raffinér, reparér, og lasten på HUD'en

**Files:**
- Create:
  - `src/game/Mining.ts` (`GameModule`)
  - `src/game/miningRules.ts` (pure gates: `mayMine`, `chooseResource`)
- Modify:
  - `src/core/Input.ts` (`MINING_KEYS = { mine: 'KeyB', refine: 'KeyU', repair: 'KeyN' }`)
  - `src/ui/Hud.ts` + `src/game/Instruments.ts` (CARGO block under PROP, following the
    `setPropellant`/`drawPropellant`/`os-void` pattern)
  - `src/ui/hintRules.ts` (hint `'mine'`)
  - `src/game/registry.ts`
- Test: `src/game/Mining.test.ts`, `src/game/miningRules.test.ts`, `hintRules.test.ts`

**Interfaces:**
- Consumes: Task 2-3; `emergencyMayAct`-style gate.
- Produces:
  - `function mayMine(s: { paused: boolean; frozen: boolean; cruise: boolean; warpPhase: string; targetIsAsteroid: boolean; surfaceRangeKm: number; relSpeedKmS: number; holdFreeKg: number; remainingKg: number }): { ok: boolean; reason?: 'no-target' | 'range' | 'speed' | 'hold-full' | 'depleted' | 'busy' }`
  - `function chooseResource(remaining: Record<Resource, number>, prefer?: Resource): Resource | null`
    - prefers ice, then rare, then metal, then silicate
  - `Mining.busy: null | { kind: 'mine' | 'refine' | 'repair'; leftS: number }`
  - Every completed action goes through `applyCargoAction`, and `worldState.recordMined` is called on
    mine.
  - Logs:
    - `MINED · 2 000 KG ICE`
    - `HOLD FULL`
    - `DEPLETED`
    - `REFINED · 4 000 KG PROPELLANT`
    - `REPAIRED · TANK +4 %`
    - `MINING ABORTED`
    - plus one log per refusal reason: `OUT OF RANGE`, `MATCH SPEED`, `NO ICE` and so on

- [ ] **Step 1: Write the failing tests.**
  - `mayMine`: each reason at its exact boundary
    - range 0.5 km is ok, 0.5001 km is not
    - relative speed 0.005 km/s is ok, 0.0051 km/s is not
  - `Given a targeted asteroid in range and matched, When B, Then after 4 s sim the hold has +2 000 kg ice (or the remainder), cargo:action mine emitted once, worldState updated, log MINED`
  - Mining aborts cleanly when any of these happens during the 4 s:
    - the ship drifts out of range
    - pause
    - cruise
    - warp
    - the emergency beacon

    Result: no yield, no action, log `MINING ABORTED`.
  - `Given 10× time compression, Then the action completes after 4 s sim (0.4 s wall)`
  - `Given ice in the hold and room in the tank, When U, Then after 8 s the tank rises by 0.8 × the ice used`
    - This is the success criterion's "tank op".
  - `Given materials and loss, When Y, Then after 10 s the loss falls by 0.04`
  - `HUD CARGO block`:
    - total/capacity
    - one line per resource > 0
    - hidden without cargo
    - the `'mine'` hint appears the first time an asteroid is targeted in range and retires after 2
      completed mines
  - `Given a hull without a tank or cargo, Then B/U/N do nothing`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement. Keys are re-checked at completion (as R16).
- [ ] **Step 5:** Run → PASS. Commit.

### Task 6: Nødudgangen kender lasten

**Files:**
- Modify:
  - `src/game/Emergency.ts`, `src/ship/emergency.ts`
  - `src/ship/travelCost.ts` (the `cannibalize` `part:'cargo'` refusal → delegate to
    `cannibalize-cargo`)
  - `src/game/RecoveryCut.ts` (paid rescue)
  - `src/game/Log.ts`
- Test: extensions in `Emergency.test.ts`, `emergency.test.ts`, `recoveryCut.test.ts`

**Interfaces:**
- Consumes: Task 2 (`applyCargoAction` `jettison-all`, `cannibalize-cargo`).
- Produces:
  - A beacon (Emergency key 2 **and** RETURN TO ORBIT with a tank, D11):
    - `jettison-all` (the whole cargo)
    - plus a logbook entry `record({ key: 'beacon:<n>', kind: 'note', title: 'BEACON RECOVERY', … })`
  - The emergency menu offers `cannibalize-cargo` (key 3, add `Digit3` to `EMERGENCY_KEYS`) **first**
    when the hold holds ≥ 1 000 kg. Tank cannibalization (1) stays, and the beacon (2) stays.

- [ ] **Step 1: Write the failing tests.**
  - `Given cargo 3 t and an empty tank, Then the menu offers 3 (cargo), 1 (tank), 2 (beacon); When 3, Then the hold empties, the tank gains 3 % of base, capacity is untouched, emergency:used {kind:'cannibalize-cargo'}`
  - `Given cargo 500 kg, Then 3 is not offered`
  - `Given cargo and a beacon (key 2), Then the hold is emptied via jettison-all and a BEACON RECOVERY logbook note exists`
  - `Given cargo and RETURN TO ORBIT with a tank, Then the same as the beacon`
  - `Given a crash recovery, Then the cargo is untouched` (free, v3)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement through a single shared function `payBeacon(tank, cargo, log)`, used by both
  Emergency and RecoveryCut.
- [ ] **Step 5:** Run → PASS. Commit.

### Task 7: Kortene viser bæltet, og man kan sætte kurs

**Files:**
- Modify: `src/ui/SystemMap.ts`, `src/ui/StarMap.ts`, `src/game/MapMode.ts`, `src/game/Cruise.ts`
  (`target()` must resolve `field:` targets with `FIELD_RADIUS_KM` as their radius; today it resolves
  bodies only, per the Task 3 review)
- Test: `src/ui/beltChart.test.ts` (pure helpers)

**Interfaces:**
- Consumes: `beltFor`, `Belt.nearestField` (Task 1, 3).
- Produces:
  - `function beltRing(belt: BeltSpec, maxKm: number): { inner: number; outer: number }` (radial
    chart radii through the existing `radial()`)
  - The system chart draws a dashed annulus plus a "BELT" node. Selecting it emits
    `target:changed { id: field:<nearest k>, name: 'BELT · <system> <k>' }`.
  - The galaxy chart's info panel shows "BELT" for systems with `hasAsteroidBelt` (MapMode already
    generates the selected system).

- [ ] **Step 1: Write the failing tests.**
  - `beltRing`: inner < outer, both within the chart's maximum, and monotonic with AU
  - `Given the BELT node selected, Then target:changed carries the nearest field id at the current orbitSeconds`
  - `Given G (cruise) toward a field target, Then the drop distance respects FIELD_RADIUS_KM` (no drop
    into the cluster's middle)
  - `Given the star chart with a belt system selected, Then the info lists BELT; without, it does not`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run → PASS. Commit.

### Task 8: Hele loopet i browseren, mutation og afslutning

**Files:**
- Script: `~/.claude/jobs/<job>/tmp/v4/mining.mjs` (the GPU harness from plan 1)
- Modify: `docs/v4/DECISIONS.md` (D14…)

- [ ] **Step 1: Build and serve 4173.**
- [ ] **Step 2: Run the GPU end-to-end without login.** It is succeskriteriet minus login, which comes
  in delplan 3/4:
  1. New game (tank 60 %).
  2. System chart, then BELT.
  3. G (cruise), then drop out near the field.
  4. Tab to an asteroid.
  5. K (formation) and close in to < 0.5 km.
  6. T (scan).
  7. B ×3 (mine).
  8. U (refine). The tank must rise.
  9. Y (repair) after a cannibalization.

  Also measure:
  - frame time near the field (30 asteroids) against the baseline
  - console errors (0)
  - screenshots
- [ ] **Step 3:** Run an adversarial review plus mutation testing of `belt.ts`, `cargo.ts`,
  `miningRules.ts` and `worldState.ts`, and close real gaps with tests.
- [ ] **Step 4:** Do a final whole-branch review, apply the fixes, commit and push `v4`. Hand over to the
  owner for a playtest.
