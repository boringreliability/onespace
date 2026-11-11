# Delplan 3: gemt spil (lokalt)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spillet huskes mellem sessioner. Position, skib, last, logbog og verdens-tilstand gemmes lokalt
i et versioneret format (snapshot plus handlingslog), automatisk og manuelt, og "CONTINUE" på titelskærmen
bringer dig tilbage, hvor du slap. Formatet overtages uændret af delplan 4 (sky).

**Architecture:**
- **Format:** `src/save/` holder formatet: Zod-skemaer, migrering og byg/anvend af et save.
- **Lager:** et `SaveStore`-interface med en IndexedDB-implementering og en hukommelses-implementering til
  tests (samme DI-mønster som `loadHintCounts(store)`). Kritiske handlinger skrives synkront til en
  localStorage-journal (WAL), før effekten vises.
- **Gendannelse:** spilobjekterne får små, validerede restore-API'er. Universe kan starte direkte i et gemt
  system, så start-systemet ikke blinker forbi.
- **Modul:** `SaveGame` er det eneste modul, der skriver.

**Tech Stack:** TypeScript strict, Vitest (node), **Zod** (ny afhængighed), **fake-indexeddb**
(ny devDependency, kun tests), Playwright (GPU).

**Spec:** `docs/v4/DESIGN.md` §5.2, §4 P1-P5. Beslutninger: `docs/v4/DECISIONS.md` (D3, D11, D13, D17,
D18, D19, D28). Overblik: `docs/v4/PLAN.md`.

## Global Constraints

- **Format v1 (Zod):**

  ```text
  SaveV1 {
    format: 1,
    saveId: uuid,
    universeId: `${galaxy.id}:v1`,
    revision: int ≥ 1,
    savedAt: { wallMs, orbitSeconds },
    player: {
      system: { id, seed, name, positionLy: [x, y, z] },
      parentId: string | null,
      flight: { position, velocity, orientation: [x, y, z, w], grounded: boolean, flightAssist: boolean }
    },
    ship: {
      propellant: { massKg, capacityLossFrac },
      cargo: Record<Resource, number>,
      emergencyTimesUsed: int
    },
    log: { time, entries: LogEntry[] },
    world: { universeId, entries: MinedEntry[] },
    actions: ActionEntry[]
  }
  ```

  - **Player og world adskilt (P2).**
  - **Begge ure på alt (P5).**
  - **Id'er (P4):** `saveId` er en UUID via `crypto.randomUUID()`. Felt- og sten-id'er er deterministiske
    som i dag.
- **Handlingslog (P3, D13):**
  - Format: `ActionEntry { seq, source: 'propellant' | 'cargo' | 'emergency' | 'mined' | 'thrust', payload, wallMs, orbitSeconds }`.
  - Den er append-only og kildes fra `propellant:action`, `cargo:action` (kun `result.ok`),
    `emergency:used` og `WorldState.recordMined`.
  - **Thrust** (som ikke annonceres) logges som én aggregeret `thrust`-post pr. gem med de kg, tanken er
    faldet ud over de navngivne handlinger, så tankens regnskab altid går op.
  - Loftet er `MAX_ACTIONS = 5 000`. Er det nået, komprimeres de ældste poster til én `checkpoint`-post
    med summer.
- **Kritiske handlinger skrives før effekten (§5.2):**
  - Nødudgang og beacon skrives synkront til localStorage-nøglen `onespace.wal.v1`, før nødudgangens
    effekt vises.
  - WAL'en flettes ind i IndexedDB ved næste gem. Ved indlæsning vinder den nyeste `revision`.
- **Lukning (§5.2):** `visibilitychange → hidden` udløser et asynkront IndexedDB-gem. `pagehide`
  skriver hele snapshottet synkront til WAL'en.
- **Autosave (§5.2):**
  - **Hvornår:** efter landing (`planet:landed`), efter en gennemført udvinding (efter `recordMined`, én
    tick efter `cargo:action`), efter nødudgang/beacon (WAL straks), ved `system:entered`, hvert
    `AUTOSAVE_INTERVAL_S = 120` s spil, og ved skjult fane.
  - **Grænse:** mindst `AUTOSAVE_MIN_GAP_S = 5` s mellem automatiske gem, undtagen ved nødudgang og
    skjult fane.
  - **Manuelt:** `SAVE` i pausemenuen. Loggen skriver `SAVED` / `SAVE FAILED`.
- **Én skrivende fane:**
  - `navigator.locks` med navnet `onespace-save`. Får en anden fane ikke låsen, kan man spille, men den
    gemmer ikke og viser `SAVING DISABLED — OPEN IN ANOTHER TAB`.
  - Uden Locks-API (test eller node) er den eneste fane skriver.
- **Cruise ved gem:** gemmes som "droppet ud ved nærmeste stabile punkt" (§5.2): en cirkulær bane om
  nærmeste krop på skibets nuværende radius (`circularOrbitState`, som `recoverToOrbit`).
- **Landet ved gem:**
  - **Gemmes:** forælder-id, forælder-relativ position og orientering, `grounded: true` og `orbitSeconds`.
  - **Gendannes:** stille, uden `planet:landed`/`ship:touchdown` og uden logbogsbesøg.
- **Logbogen:**
  - **Migrering:** den eksisterende `onespace.log.v1` importeres én gang i det første save. Den gamle
    nøgle bevares som backup og slettes ikke.
  - **Lagring:** derefter lever logbogen i savet, og `ShipLog` skriver gennem en sink, ikke direkte til
    localStorage.
- **Migrering:**
  - `migrate(raw): SaveV1 | MigrationError`. Hver version har en eksplicit trin-funktion.
  - Et ukendt eller forkert save **kasseres aldrig stille**. Det bevares under `onespace.save.corrupt.<wallMs>`
    i IndexedDB, og loggen skriver `SAVE UNREADABLE — KEPT A COPY`.
  - Golden saves ligger i `src/save/fixtures/`.
- **Ikke gemt (transient):** mål, formation, autopilot og approach, mining-job, cruise-interne,
  `simRate` (1), `paused`/`frozen`, kamera, HUD, trafik, warp og RecoveryCut.
- **Per-enhed-indstillinger** (`os.hints.v1`, `os.stick.*`, `os.flight.preset`, `?tier=`) er ikke en del
  af savet.
- **Ét save-slot** plus `previous` (det forrige save bevares ved overskrivning).
  - `NEW GAME`, mens der findes et save, kræver bekræftelse (andet tryk: `NEW GAME — PRESS AGAIN TO
    OVERWRITE`).
  - `?mode=flight` fortsætter, hvis der findes et save. `?new=1` (ny route-nøgle) tvinger et nyt spil.
- **Ydelse:** gem kører uden for render-loopet (async). Ingen allokering pr. frame i `SaveGame` ud over
  på selve gem-tidspunktet. Budgettet fra v2/v3 holder.
- **Uden tank** (Yard, showroom, review shots) gemmes intet.
- **GS-TDD:** hver task stopper ved ⏸, til ejeren har sagt "godkendt" til testene.
- **Log:** beslutninger skrives i `docs/v4/DECISIONS.md` (fra D29).

## Review Focus

1. **Fanen lukkes midt i en handling** (udvinding, raffinering, nødudgang). Efter Continue er handlingen
   enten sket helt eller slet ikke, og en nødudgang er altid betalt. Testes i Task 5.
2. **To faner samtidig.** Kun én gemmer, og handlingsloggen dobbelttæller eller taber aldrig. Testes i
   Task 4 og Task 5.
3. **Gammelt eller ødelagt save.** Det migreres, eller det bevares og meldes, og det kasseres aldrig
   stille. Testes i Task 1.
4. **Continue efter landing på en roterende planet.** Skibet står på samme overfladepunkt og glider ikke,
   og der kommer ingen ny landing i logbogen. Testes i Task 2.
5. **Continue i et andet system end start-systemet.** Der blinker ikke et forkert system forbi, og
   asteroiderne er stadig udtømte. Testes i Task 6.

---

### Task 1: Formatet, skemaerne og migreringen

**Files:**
- Create: `src/save/schema.ts`, `src/save/migrate.ts`, `src/save/fixtures/v1-golden.json`,
  `src/save/fixtures/v0-legacy-log.json`
- Modify: `package.json` (add `zod` as a dependency and `fake-indexeddb` as a devDependency)
- Test: `src/save/schema.test.ts`, `src/save/migrate.test.ts`

**Interfaces:**
- Produces:
  - `SaveV1Schema` (Zod) and `type SaveV1 = z.infer<typeof SaveV1Schema>`
  - `ActionEntrySchema`
  - `CURRENT_FORMAT = 1`
  - `function migrate(raw: unknown): { ok: true; save: SaveV1; migratedFrom: number } | { ok: false; reason: 'unknown-format' | 'invalid'; issues: string[] }`
  - `function legacyLogToV1(legacy: unknown, ctx: { universeId: string; system: ...; now: { wallMs: number; orbitSeconds: number } }): SaveV1['log'] | null`

- [ ] **Step 1: Write the failing tests.**
  - `Given the golden v1 save, Then it parses and round-trips through JSON unchanged`
  - `Given each field of the golden save broken in turn (NaN mass, negative cargo, unknown resource, missing universeId, revision 0, quaternion of length 0), Then migrate reports invalid with the path and never throws`
  - `Given format 99, Then unknown-format (never silently discarded — the caller keeps it)`
  - `Given the legacy {version:1,time,entries} log, Then legacyLogToV1 yields the same entries and time; Given garbage, Then null`
  - `Given a save with 6 000 actions, Then the schema accepts it` (compaction is Task 3's job, not the schema's)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement with whitelist schemas (`.strict()`). Numbers must be finite. Quaternions are
  normalised after parsing.
- [ ] **Step 5:** Run → PASS, plus `npx tsc --noEmit` and `npx vite build` (record the bundle growth from
  Zod in the report). Commit.

### Task 2: Gendannelse i spilobjekterne

**Files:**
- Modify:
  - `src/ship/propellant.ts`
  - `src/game/worldState.ts`
  - `src/game/Log.ts`
  - `src/ship/FlightModel.ts`
  - `src/game/Universe.ts`
- Test: extensions in the existing test files, plus `src/game/universeRestore.test.ts` (real
  `Universe.init`, the GPU steps stubbed as in `rocksClock.test.ts`)

**Interfaces:**
- Produces:
  - `Propellant.snapshot(): { massKg; capacityLossFrac }` and `Propellant.restore(s)`
    - sets loss first, then mass
    - sanitises with the same rule as today
  - `WorldState.restore(entries: readonly MinedEntry[])`
    - rebuilds the map and the log without stamping new clocks
    - `entries()` returns a copy
  - `ShipLog.exportState(): { time; entries }` and `ShipLog.importState(s)`
    - `importState` sends no log events
  - `ShipLog.setSink(sink: ((state) => void) | null)`
    - with a sink, every write goes to the sink instead of localStorage
  - `ShipLog.legacyState(): { time; entries } | null`
    - reads `onespace.log.v1` without deleting it
  - `FlightModel.restoreState({ position, velocity, orientation, grounded })`
    - like `teleport`, but grounded can be set without events
    - zero spin
  - `Universe.restoreState(r: { system: { id; seed; name; positionLy }; orbitSeconds; parentId; flight: ...; flightAssist })`
    - re-finds the stub (`sampleSystemsNear` around `positionLy`, matched on id)
    - `enterSystem`
    - `setOrbitSeconds` (new; calls `updateOrbits`)
    - public `restoreParent(id)` (wraps the private `setShipParent` plus `syncGroundSampler`)
    - `flight.restoreState`
    - returns `false` and does nothing if the system is not found
  - `Universe` option `restore?: UniverseRestore`: `init` uses it instead of `pickStartSystem`, so there
    is no flash

- [ ] **Step 1: Write the failing tests.**
  - Propellant: the restore order (a full tank and 50 % loss gives mass = capacity); NaN is refused.
  - WorldState: after restore, `remainingKg` is the same as before, and the clocks are preserved.
  - ShipLog: export → import is identical, no `LOGGED` event; with a sink, localStorage is untouched;
    `legacyState` leaves the key in place.
  - **Universe in orbit:** `Given a save in Fyss at a planet, When restored, Then position/velocity/orientation, orbitSeconds and parent match to 1e-9 and no system:entered for the start system was emitted first`.
  - **Universe landed:** `Given a ship landed on Remit 31, When restored and stepped 30 s, Then it is still grounded at the same surface point (± 1 m), no planet:landed/ship:touchdown fired, and the log has no new landing visit`.
  - **Another system:** `Given a save in another system (a neighbour of Fyss), Then restore enters that system (not Fyss)`.
  - **System not found:** `Given an unknown system id, Then restore returns false and nothing changes`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run → PASS (full suite). Commit.

### Task 3: At bygge et save og handlingsloggen

**Files:**
- Create: `src/save/capture.ts`, `src/save/actionJournal.ts`
- Test: `src/save/capture.test.ts`, `src/save/actionJournal.test.ts`

**Interfaces:**
- Consumes: Task 1-2.
- Produces:
  - `class ActionJournal`
    - `constructor(clock: { wallMs(): number; orbitSeconds(): number })`
    - subscribes to `propellant:action`, `cargo:action` (ok only) and `emergency:used`
    - `noteMined(entry)`, called by `WorldState.recordMined` through a hook
    - `noteThrust(tankBefore, tankAfter, namedKg)`
    - `drain(): ActionEntry[]`
    - `restore(entries)`
    - `compact()`: keeps at most `MAX_ACTIONS`; the oldest become a `checkpoint` with summed kg per
      resource and propellant
    - `seq` increases strictly and never repeats, even after restore
  - `function buildSave(w: SaveWorld, prev: SaveV1 | null): SaveV1`
    - `revision` = prev + 1
    - `saveId` is kept, or a new UUID
    - cruise is replaced by a circular orbit around the nearest body
  - `function applySave(w: SaveWorld, s: SaveV1): boolean`
  - `interface SaveWorld`: the minimal surface `SaveGame` needs (universe, worldState, shipLog,
    emergency, journal)

- [ ] **Step 1: Write the failing tests.**
  - **Journal:**
    - each event gives exactly one entry with both clocks
    - refused cargo actions give none
    - `noteThrust` balances the books (Σ named + thrust = tank delta to 1e-9)
    - compact at 5 001 → 5 000 entries with the same sums
    - `seq` is unique after restore
  - **buildSave:**
    - revision +1; saveId kept
    - a cruising ship is saved in a circular orbit (|v| = √(µ/r) ± 1e-6) around the nearest body
    - player and world are separated
    - the log comes from `exportState`
  - **Round-trip:** `Given a played state (moved, mined 2 t, refined, cannibalised once), When buildSave → JSON → migrate → applySave into a fresh Universe, Then tank, capacity loss, cargo, timesUsed, depletion, log and position match`
  - **Ordering:** `Given a mine completes, Then the journal has the cargo action AND the mined entry before any save is built` (the hook ordering problem: `recordMined` comes after `cargo:action`)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run → PASS. Commit.

### Task 4: Lageret: IndexedDB, WAL og én skrivende fane

**Files:**
- Create: `src/save/store.ts`, `src/save/idbStore.ts`, `src/save/memoryStore.ts`, `src/save/wal.ts`,
  `src/save/writerLock.ts`
- Test: `src/save/idbStore.test.ts` (fake-indexeddb), `src/save/wal.test.ts`, `src/save/writerLock.test.ts`

**Interfaces:**
- Produces:
  - `interface SaveStore`:
    - `load(): Promise<{ current: unknown | null; previous: unknown | null }>`
    - `save(s: SaveV1): Promise<void>` (the old current becomes previous)
    - `keepCorrupt(raw: unknown, wallMs: number): Promise<void>`
  - `idbStore(name = 'onespace')` with object stores `slots` and `corrupt`
  - `memoryStore()`
  - `wal`, a synchronous localStorage store with key `onespace.wal.v1`:
    - `wal.appendCritical(entry: ActionEntry)`
    - `wal.writeSnapshot(s: SaveV1)`
    - `wal.read(): { snapshot: unknown | null; critical: ActionEntry[] }`
    - `wal.clear(upToRevision: number)`
  - `function newestOf(a: SaveV1 | null, b: SaveV1 | null): SaveV1 | null` (by revision, then `wallMs`)
  - `function acquireWriterLock(locks?: LockManager): Promise<{ writer: boolean; release(): void }>`

- [ ] **Step 1: Write the failing tests.**
  - **IndexedDB:**
    - save/load round-trip
    - the old current becomes previous
    - a write error rejects without corrupting
    - corrupt saves are kept with a time stamp
  - **WAL:**
    - synchronous append is visible immediately
    - a full localStorage (quota) gives false, never throw
    - `clear(upTo)` removes only up to the revision
  - **newestOf:** a higher revision wins; on equal revisions the newest `wallMs` wins
  - **Writer lock:**
    - two acquires give one writer
    - without Locks-API: writer
    - `release` lets the next one in
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement (no external IndexedDB wrapper; a small promise wrapper).
- [ ] **Step 5:** Run → PASS. Commit.

### Task 5: `SaveGame`: autosave, manuelt gem og nødudgangen først

**Files:**
- Create: `src/game/SaveGame.ts`, `src/game/saveTriggers.ts` (pure: what triggers a save now)
- Modify:
  - `src/game/registry.ts` (wired after Emergency/Mining)
  - `src/ui/Pause.ts` + `src/ui/pauseState.ts` (`SAVE` button; event `{type:'save'}` → effect `'save'`)
  - `src/game/gating.ts`
- Test: `src/game/saveTriggers.test.ts`, `src/game/SaveGame.test.ts`, extension of `pauseState.test.ts`

**Interfaces:**
- Consumes: Task 1-4.
- Produces:
  - `function shouldAutosave(s: { sinceLastS: number; reason: 'landed' | 'mined' | 'emergency' | 'system' | 'interval' | 'hidden' | 'manual' }): boolean`
    - `emergency`, `hidden` and `manual` always save
    - the other reasons save only when `sinceLastS ≥ AUTOSAVE_MIN_GAP_S`
    - `interval` saves every 120 s
  - `SaveGame`:
    - `saveNow(reason): Promise<boolean>`
    - `get status(): 'idle' | 'saving' | 'disabled'`
    - logs `SAVED` (quietly, only on manual), `SAVE FAILED` (warn) and the disabled text from Global
      Constraints

- [ ] **Step 1: Write the failing tests.**
  - **Triggers:** each `shouldAutosave` reason at its limit.
  - **SaveGame with memoryStore:**
    - landing → saved
    - mining → saved, and the save contains the mined entry (not only the cargo action)
    - 120 s → saved
    - two triggers within 5 s → one save
  - **Emergency first:** `Given the emergency key 2 (beacon), Then the WAL holds the beacon entry BEFORE ship:recovered is emitted` (synchronous). The same for cannibalisation and the paid RETURN TO ORBIT.
  - **Tab hidden and closed:** `visibilitychange hidden` → IndexedDB save; `pagehide` → WAL snapshot
    synchronously.
  - **Two tabs:** the second `SaveGame` without the lock saves nothing and shows the disabled text; the
    journal from tab 1 is untouched.
  - **Closing mid-action:** `Given a mine 2 s in, When pagehide fires, Then the saved state has no half mine (cargo unchanged, no mined entry)`.
  - **Pause:** the `SAVE` button saves and the log says `SAVED`.
  - **No tank (Yard/showroom):** nothing is saved.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement. `SaveGame` is the only writer. The journal hooks into `WorldState` via an
  injected callback.
- [ ] **Step 5:** Run → PASS (full suite). Commit.

### Task 6: Boot, CONTINUE og NEW GAME

**Files:**
- Modify:
  - `src/main.ts` (load the latest before `registerModules`: IndexedDB plus WAL → `newestOf` → `migrate`)
  - `src/game/registry.ts` (`Universe({ seed, restore })`)
  - `src/core/Route.ts` (key `new`)
  - `src/ui/titleMenu.ts` + `src/ui/Title.ts` (CONTINUE / NEW GAME with overwrite confirmation)
- Test: `src/ui/titleMenu.test.ts` (extended), `src/core/route.test.ts` (extended),
  `src/save/bootLoad.test.ts`

**Interfaces:**
- Produces:
  - `async function loadForBoot(store: SaveStore, wal: Wal): Promise<{ save: SaveV1 | null; notice: string | null }>`
    - migrate, keep corrupt saves, merge WAL critical entries into the journal
    - logbook migration on the first save
  - `TITLE_ITEMS` becomes dynamic:
    - `['continue', 'newgame', 'yard', 'settings']` with a save
    - `['undock', 'yard', 'settings']` without
  - effects `{ kind: 'continue' }` and `{ kind: 'newgame', confirmed: boolean }`

- [ ] **Step 1: Write the failing tests.**
  - **Title menu:** with a save, CONTINUE is first; NEW GAME needs two presses; without a save it is v3's
    menu.
  - **Route:** `?new=1` is parsed (whitelisted); `?mode=flight` with a save → continue.
  - **loadForBoot:**
    - IndexedDB revision 7 and WAL revision 8 → WAL wins
    - a corrupt current with a valid previous → previous plus a notice
    - format 99 → kept plus a notice, and a new game
    - first time with a legacy logbook → the log is imported
  - **Universe with restore:** no `system:entered` for the start system, and the first frame is the
    saved system.
  - **Depletion after Continue:** `Given a mined rock, When continued, Then remainingKg is still reduced`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Wait for owner approval.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run → PASS, plus `npx vite build`. Commit.

### Task 7: Hele vejen i browseren, mutation og afslutning

- [ ] **Step 1: GPU end-to-end on the preview (Playwright, a real IndexedDB):**
  1. New game → BELT → G → L → B ×2 → U.
  2. Reload: Continue → same place (± 1 m), same tank, cargo and log, the rock still depleted.
  3. Land on Remit 31 → reload → still landed, no new landing in the log.
  4. Beacon → reload at once (no autosave in between) → the beacon is paid (WAL).
  5. Two tabs → the second shows SAVING DISABLED.
  6. An old-format fixture in IndexedDB → the notice is shown and the save is kept.

  Also measure frame time during an autosave (no visible stall) and console errors (0).
- [ ] **Step 2:** Run mutation testing on `schema.ts`, `migrate.ts`, `actionJournal.ts`,
  `saveTriggers.ts`, `wal.ts` and `newestOf`. Close real gaps with tests (owner approval).
- [ ] **Step 3:** Run a final whole-branch review, apply one fix round, update DECISIONS from D29, and
  push `v4`.
