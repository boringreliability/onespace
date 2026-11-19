# Delplan 1: brændstof

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Sonden får en tank. Al fremdrift, cruise og hop koster brændstof. Massen mærkes let. HUD'en
viser budgettet, og en tom tank har en nødudgang, der koster noget.

**Architecture:**
- **Ren model:** `src/ship/propellant.ts` (tank og forbrugsformler) er ren og testet.
- **Opt-in:** `FlightModel` får en *valgfri* tank. Uden tank er den bit-for-bit v3, så alle
  eksisterende tests står uændret. Universe giver spillerens skib en tank.
- **Cruise og hop:** pris og afvisning ligger i rene funktioner, som `Cruise`, `MapMode` og
  `StarMap` kalder.
- **Handlinger:** alle ændringer af tanken, der ikke kommer fra thrust (cruise, hop, nødudgang), er
  navngivne handlinger (`PropellantAction`) med henblik på handlingsloggen i delplan 3 (P3).

**Tech Stack:** TypeScript strict, Three.js r180, Vitest og Playwright (GPU).

**Spec:** `docs/v4/DESIGN.md` §5.3-5.4. Overblik: `docs/v4/PLAN.md`.

## Global Constraints

- **Uden tank uændret:** `new FlightModel(config)` uden tank opfører sig præcis som i dag. Hele den
  eksisterende suite (1745 tests) skal være grøn uden ændrede forventninger.
- **Rotation er gratis.** Kun translation (main, boost, RCS-strafe, brake og FA-assistens) bruger
  brændstof (anti-mål "tankmas").
- **Forbruget følger sim-tid.** Det samme sker ved 1×, 10× og 100×.
- **Masse:** total = tør + brændstof (+ `extraMassKg`, last fra delplan 2). Accelerationen skaleres
  med `dryMass / totalMass`. Forskellen mellem tom og fuld er under 10 %.
- **Tuning-mål (DESIGN §5.3):**
  - **(a) Landing:** en auto-land fra åbningsbanen på Remit bruger 4-10 % af en fuld tank.
  - **(b) Manøvrering:** et 10 s fuldt main-burn i bane bruger højst 2 % af en fuld tank.
  - **(c) Hop:** et hop til et nabosystem koster højst 15 %.
  - Samlet skal en fuld tank kunne dække 3 × (landing + opstigning) + 2 hop.
- **Tal for v4, i `propellant.ts`:**
  - `PROBE_TANK_CAPACITY_KG = 20_000`
  - `PROBE_DRY_MASS_KG = DEFAULT_SHIP_CONFIG.mass` (200 t)
  - `EXHAUST_VELOCITY_KMS`, startværdi 1000, tunes i Task 3 (ejerbeslutning D2: ≈ 11 500 — autopiloten er en hurtig, dyr bekvemmelighed)
  - `START_FILL = 0.6` (bruges først i delplan 2/3, men konstanten bor her)
- **GS-TDD:** hver task stopper ved ⏸ til ejeren har sagt "godkendt" til testene.
- **Log:** beslutninger skrives i `docs/v4/DECISIONS.md`.

## Review Focus

1. **Tanken løber tør midt i en auto-land.** Forventet: autopiloten slipper med en log-linje ("AUTOPILOT
   OFF · PROPELLANT"), skibet falder ballistisk, og nødudgangen bliver tilbudt. Spillet må aldrig
   ende i en låst tilstand. Testes i Task 5.
2. **Time compression 100× med lav tank.** Forventet: tanken rammer præcis 0, aldrig negativ, og
   thrust stopper i samme substep. Testes i Task 2.
3. **Cruise på tom tank eller under cruise.** Forventet: cruise kan ikke spoole. I cruise dropper
   drevet ud kontrolleret, når tanken ikke kan betale næste stykke. Testes i Task 4.
4. **Hop bestilt med for lidt.** Forventet: afvist før animationen starter, ingen delvis betaling, og
   kortet viser hvorfor. Testes i Task 4.
5. **Nødudgang gentaget, til kapaciteten er 0.** Forventet: kannibalisering afvises, når der ikke er
   mere at ofre, og nødsignalet bliver eneste vej. Kapaciteten går aldrig under 0. Testes i Task 6.

---

### Task 1: Tank og forbrugsformler (ren model)

**Files:**
- Create: `src/ship/propellant.ts`
- Test: `src/ship/propellant.test.ts`

**Interfaces:**
- Produces:
  - `class Propellant { constructor(capacityKg: number, fill: number /*0..1*/); readonly baseCapacityKg; capacityLossFrac: number /*0..1*/; massKg: number; get capacityKg(): number /* base·(1−loss) */; get fraction(): number; consume(kg: number): number /* returns kg actually taken, ≤ massKg */; add(kg: number): number /* returns kg actually added, ≤ free capacity */; get empty(): boolean }`
  - `function propellantForImpulse(accelKmS2: number, massKg: number, dtS: number, exhaustKmS: number): number /* kg = a·m·dt/ve */`
  - `function deltaVRemaining(dryKg: number, propKg: number, extraKg: number, exhaustKmS: number): number /* km/s, ve·ln(m0/m1) */`
  - `function massScale(dryKg: number, propKg: number, extraKg: number): number /* dry/(dry+prop+extra) */`
  - The constants from Global Constraints.

- [ ] **Step 1: Write the failing tests.** These are BDD names. Assertions use the constants directly.
  - `Given a 20 t tank at 0.6, Then it holds 12 000 kg and fraction is 0.6`
  - `When consuming more than is left, Then it returns only what was there and ends at exactly 0`
  - `When adding beyond free capacity, Then it returns only what fit`
  - `Given capacityLossFrac 0.25, Then capacityKg is 15 000 and a tank fuller than that is clamped down`
  - `propellantForImpulse: 0.2 km/s² on 200 t for 1 s at ve 1000 → 40 kg`
  - `deltaVRemaining(200 t, 20 t, 0, 1000) ≈ 95.3 km/s`
  - `massScale(200 t, 20 t, 0) ≈ 0.909` (under 10 %, which pins the mass constraint)
  - `Given NaN, negative or Infinity input, Then no function returns NaN and the tank never goes negative`
- [ ] **Step 2:** `npx vitest run src/ship/propellant.test.ts` → FAIL (the module is missing).
- [ ] **Step 3: ⏸** Show the tests to the owner and wait for "godkendt".
- [ ] **Step 4:** Implement `src/ship/propellant.ts`. Pure, no three import.
- [ ] **Step 5:** Run the tests → PASS. Run `npx tsc --noEmit` → clean.
- [ ] **Step 6:** Commit with `test(v4-fuel): …` and then `feat(v4-fuel): propellant model`.

### Task 2: FlightModel bruger tanken

**Files:**
- Modify: `src/ship/FlightModel.ts`. Touch three places: the constructor/fields, `step()` where thrust
  is gathered in `sAcc` before drag, and `stepAssist` (unchanged, it writes into `sAcc`).
- Test: `src/ship/FlightModel.propellant.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `FlightModel.attachPropellant(p: Propellant | null, exhaustKmS: number): void`
  - `FlightModel.propellant: Propellant | null`
  - `FlightModel.extraMassKg: number` (default 0)
  - `FlightModel.thrustStarved: boolean` (true in the substep where thrust was wanted but the tank
    was empty)

- [ ] **Step 1: Write the failing tests.**
  - `Given no tank attached, When the same input sequence as a v3 test is flown, Then position and velocity match a FlightModel built the v3 way to 1e-12`
    - Fly one 5 s main burn plus FA stop.
  - `Given a tank, When a 1 s full main burn is flown in vacuum, Then propellant drops by propellantForImpulse(thrust accel, total mass, 1, ve) ± 1 %`
  - `Given a tank, When only rotating for 10 s, Then propellant is unchanged` (rotation is free)
  - `Given a tank, When drag decelerates a coasting hull, Then no propellant is used` (measure thrust
    before drag)
  - `Given a full vs an empty tank, Then main-burn acceleration differs by massScale and by less than 10 %`
  - `Given 1 kg left, When burning at 100× sim rate (simulate with large dt in slices), Then propellant ends at exactly 0, never negative, thrust stops in the same substep, and thrustStarved is true`
  - `Given an empty tank, When FA-ON hold is commanded, Then no thrust is applied and gravity still acts`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4: Implement in `step()`.** Copy the thrust part of `sAcc` into a new scratch vector
  `sThrust` *before* drag is added. Scale thrust by `massScale(...)`. If a tank is attached:
  1. Compute need = `propellantForImpulse(|sThrust|, totalMass, h, ve)`.
  2. Get `got = consume(need)`.
  3. If `got < need`, scale thrust by `got/need` and set `thrustStarved`.

  Without a tank, the old code path runs untouched.
- [ ] **Step 5:** Run the new tests and the full suite → PASS. The existing 1745 are unchanged.
- [ ] **Step 6:** Commit.

### Task 3: Spillerens tank og tuning-målene

**Files:**
- Modify: `src/game/Universe.ts`, where `flight = new FlightModel(DEFAULT_SHIP_CONFIG)`. Call
  `attachPropellant(new Propellant(PROBE_TANK_CAPACITY_KG, 1.0), EXHAUST_VELOCITY_KMS)`. The starting
  fill is 1.0 until delplan 2 introduces belts and `START_FILL`.
- Create: `src/ship/testing/landingSim.ts`. Move `flyLeg`/`TestWorld` from
  `src/ship/autopilotPacing.test.ts` here. The pacing test imports from here, unchanged.
- Test: `src/ship/propellantTuning.test.ts`
- Modify: `src/ship/propellant.ts`, but only the number `EXHAUST_VELOCITY_KMS`.
- Modify: the auto-land guidance (`src/ship/autopilot.ts` / `src/game/AutoPilot.ts`) so its capability model reads the hull's
  current `massScale` (owner decision D2: with a full tank the landing touched down at 2.2 m/s, above the CLEAN bar).

**Interfaces:**
- Consumes: Task 1-2.
- Produces: `flyLeg(w, auto)` exported from `landingSim.ts`, same signature as today.

- [ ] **Step 1: Write the failing tests** (the tuning targets):
  - `Given a full tank on the opening orbit at Remit, When auto-land runs to touchdown, Then it uses 4–10 % of capacity`
  - `Given a full tank in orbit, When main is held for 10 s, Then it uses ≤ 2 %`
  - `Given a full tank, When auto-land runs to touchdown, Then it is CLEAN (vertical < 2 m/s, the pacing test's bar)`
  - (The jump-budget assertion moved to Task 4, ruling R2.)
- [ ] **Step 2:** Run → FAIL. Then adjust *only* `EXHAUST_VELOCITY_KMS` until (a) and (b) hold.
  Record the value and the measured percentages in DECISIONS (D1).
- [ ] **Step 3: ⏸** Wait for owner approval of the tests.
- [ ] **Step 4:** Run the full suite → PASS except the jump assertion, which waits for Task 4.
- [ ] **Step 5:** Commit.

### Task 4: Pris for cruise og hop

**Files:**
- Create: `src/ship/travelCost.ts`
- Modify:
  - `src/game/Cruise.ts`: refuse to spool if it cannot be paid; pay per distance in cruise; drop out
    when the tank runs dry.
  - `src/game/MapMode.ts`: check and pay before `warp.engage(...)`.
  - `src/ui/StarMap.ts`: show `PROPELLANT xx %` next to `JUMP EST`, and mark the line red if
    `!canAfford`.
- Test: `src/ship/travelCost.test.ts`, plus extend `src/game/Cruise.test.ts` (or create it if missing).

**Interfaces:**
- Consumes: `Propellant` from Task 1.
- Produces:
  - `type PropellantAction = { kind: 'cruise-spool' } | { kind: 'cruise-leg'; distanceKm: number } | { kind: 'jump'; distanceLy: number } | { kind: 'cannibalize'; part: 'tank' | 'cargo' } | { kind: 'beacon' }`
    (the last two are used in Task 6)
  - `function jumpPropellantFraction(distanceLy: number): number /* 0.04 + 0.004·ly, clamped to [0.04, 0.3] — retuned by D2 */`
  - `function cruiseSpoolKg(capacityKg: number): number /* 0.5 % of capacity */`
  - `function cruiseLegKg(distanceKm: number, capacityKg: number): number /* 1 % of capacity per AU, linear */`
  - `function canAfford(p: Propellant, kg: number): boolean`
  - `function applyAction(p: Propellant, a: PropellantAction): { ok: boolean; kg: number; reason?: 'insufficient' | 'nothing-left' }`
    This is all-or-nothing for spool and jump. For cruise-leg it takes what is there and reports
    `ok: false` when it runs dry.

- [ ] **Step 1: Write the failing tests.**
  - `jumpPropellantFraction(5) === 0.06` and `(0) === 0.04`. The value is clamped to `0.3` for 80 ly.
  - `Given the measured auto-land use L (from Task 3's landingSim), Then 3·2L + 2·jumpPropellantFraction(neighbourLy) ≤ 1` (moved here by R2; `neighbourLy` = nearest neighbour of the start system, from the generator)
  - `Given 5 % left, When a 6 % jump is applied, Then ok is false, reason is insufficient, and the tank is unchanged`
  - `Given an empty tank, When cruise is requested, Then it does not spool and logs "CRUISE · NO PROPELLANT"`
  - `Given cruise in progress and a tank that runs dry, Then the drive drops out through its normal 'dropping' phase (no teleport) and logs it`
  - `Given the chart open on a system 5 ly away with 5 % left, Then the jump row shows PROPELLANT 6 % in the warning tone and the jump command is refused`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement the pure functions. Then make three calls:
  - in `Cruise` at the spool request and once per frame in cruise, with the distance travelled
  - in `MapMode` before `engage`
  - in `StarMap` in the row that already shows `jumpEstimateSeconds`
- [ ] **Step 5:** Run Task 3's tests and the full suite → PASS.
- [ ] **Step 6:** Commit.

### Task 5: HUD, advarsler og autopilot-tjek

**Files:**
- Create: `src/ui/propellantReadout.ts`, a pure formatting and threshold module.
- Modify:
  - `src/ui/Hud.ts`: a propellant tape or bar in the THR column under the FA line, and Δv in
    km/s.
  - `src/game/AutoPilot.ts`: pre-check on L, and release on `thrustStarved`.
- Test: `src/ui/propellantReadout.test.ts`, plus extend `src/game/AutoPilot.test.ts`.

**Interfaces:**
- Consumes: Task 1-2 (`fraction`, `deltaVRemaining`, `thrustStarved`).
- Produces:
  - `function propellantTone(fraction: number): 'normal' | 'caution' | 'warning'`
    - caution below 0.25
    - warning below 0.10
  - `function landingEstimateKg(flight: FlightModel): number`
    - conservative: 1.3 × the Δv for circular orbit speed + `FINAL` hover
  - `function autoLandVerdict(have: number, need: number): 'go' | 'marginal' | 'refuse'`
    - refuse below 0.5·need
    - marginal below need

- [ ] **Step 1: Write the failing tests.**
  - Thresholds: 0.26 → normal, 0.25 → caution, 0.099 → warning.
  - `Given propellant below half the landing estimate, When L is pressed, Then autopilot does not engage and logs "AUTOPILOT · PROPELLANT LOW"`
  - `Given marginal propellant, Then it engages with a caution log`
  - `Given autopilot engaged, When the tank runs dry (thrustStarved), Then autopilot disengages with "AUTOPILOT OFF · PROPELLANT" and never re-engages by itself`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement. The HUD readout follows the existing tape and TextSlot pattern in
  `Hud.ts`. No allocation per frame.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit.

### Task 6: Nødudgang (kannibalisering og nødsignal)

**Files:**
- Create: `src/game/Emergency.ts` (`GameModule`: prompt and key handling) and
  `src/ship/emergency.ts` (pure rules).
- Modify: register the module in `src/game/registry.ts`. Bind the key in `src/core/Input.ts`; the
  free-key choice is the builder's, recorded in DECISIONS.
- Test: `src/ship/emergency.test.ts` and `src/game/Emergency.test.ts`.

**Interfaces:**
- Consumes:
  - `Propellant` and `applyAction`/`PropellantAction` (Task 4)
  - `Universe.recoverToOrbit()` (existing)
  - the `log` event on `bus`
- Produces:
  - `function cannibalizeYield(p: Propellant, timesUsed: number): { gainKg: number; lossFrac: number } | null`
    - Gain: 3 % of base capacity.
    - Loss: 0.08 · 1.5^timesUsed of the base capacity, permanent.
    - Returns null if the remaining capacity cannot carry the loss.
  - `class Emergency` emits `bus` event `'emergency:used'` with `{ kind: 'cannibalize' | 'beacon' }`
    (delplan 3 logs it).

- [ ] **Step 1: Write the failing tests.**
  - `Given an empty tank, Then the HUD offers "EMERGENCY · [key]" and nothing happens without the player's choice`
  - `Given an empty tank, When cannibalize is chosen, Then propellant rises by 3 % of base capacity and capacityLossFrac rises by 8 %`
  - `When used a second time, Then the loss is 12 %`
  - `Given capacity too low to pay the loss, Then cannibalize is refused and only the beacon is offered`
  - `When beacon is chosen, Then recoverToOrbit runs, the tank is set to 5 % of current capacity, and the log says "RECOVERED · BEACON"`
    - Cargo loss is added in delplan 2.
  - `Given propellant above 0, Then the emergency prompt is not offered`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit.

### Task 7: Verifikation i browseren og afslutning

**Files:**
- Create: `docs/v4/DECISIONS.md` if it is missing (from Task 3), with entries D1… for the
  propellant numbers, the key and the tuning measurements.
- Script: `~/.claude/jobs/<job>/tmp/v4/fuel.mjs`, the Playwright GPU harness used in v3.

- [ ] **Step 1:** Build and serve: `npx vite build`, and preview on 4173.
- [ ] **Step 2: Measure on the GPU with a script.**
  - **(a)** HUD tank and Δv in the opening orbit.
  - **(b)** auto-land: % used and touchdown CLEAN.
  - **(c)** 10 s burn: % used.
  - **(d)** jump on the chart: the PROPELLANT row, refused at low tank.
  - **(e)** empty the tank, then cannibalize and beacon.
  - **(f)** frame time against the v3 baseline (the v2 budget holds).

  Expected: everything matches Task 3-6, with no console errors.
- [ ] **Step 3:** Run an adversarial review plus mutation testing of `propellant.ts`, `travelCost.ts`
  and `emergency.ts` (as v3). Record the mutation score in DECISIONS.
- [ ] **Step 4:** Commit and push `v4`. Hand over to the owner for a playtest of "brændstof".
