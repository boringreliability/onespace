# Delplan 6: ressourceskærmen

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spilleren bestemmer, hvilken ressource strålen tager, kan smide en valgt mængde last ud,
og gør begge dele på en egen skærm, som næste fases byggemuligheder kan vokse i.

**Architecture:**
- **Regler (rene):** `src/ship/cargo.ts` får handlingen `jettison`. `src/ui/resourcesState.ts`
  beskriver skærmen som tilstand → linjer og tast → hændelse, uden DOM.
- **Save:** format 2 (`src/save/schema.ts`, `migrate.ts`, `replay.ts`): den nye handling og feltet
  `ship.beamResource`. Format 1 læses og løftes af `UPGRADES[1]`.
- **Tilstand:** `Mining` ejer strålens valg (`beamResource`) og tager kun den ressource.
- **Skærm:** `src/ui/Resources.ts` (DOM) i en ny tilstand `resources`, åbnet med `I` fra flyvning.

**Tech Stack:** TypeScript strict, Zod, DOM/CSS, Vitest, Playwright (`scripts/e2e-cloud.mjs`,
`scripts/shoot.mjs`), Node/Postgres-serveren deler skemaet.

**Spec:** `docs/v4/DESIGN-6-resources.md` (godkendt 2026-11-21). Baggrund: `docs/v4/DESIGN.md` §4,
§5.2, §5.5; `docs/v4/DECISIONS.md` D14, D29, D51 d, D53; `docs/v4/plan-3-save.md`. Overblik:
`docs/v4/PLAN.md`.

## Global Constraints

- **GS-TDD:** BDD Given-When-Then-tests skrives først, ejeren siger "godkendt", derefter
  implementeres. Hver task har et ⏸-trin. Ændres en allerede godkendt assertion, listes den med
  fil:linje, før → efter, og ejeren godkender den, før den røres.
- **Formatreglen R4:** format 1-skemaet bevares uændret som `SaveV1Schema`; alt nyt ligger i
  format 2. Den nye handling må aldrig stå i et save med `format: 1`.
- **Tal og navne, ordret:** `JETTISON_STEP_KG = 250`; handlingen
  `{ kind: 'jettison', resource, kg }`; feltet `ship.beamResource`; standardvalg `'ice'`;
  taster `KeyI` (åbn/luk), `KeyO` (smid 250 kg), `Shift+KeyO` (smid alt), `ArrowUp`/`ArrowDown`,
  `Enter`, `Escape`.
- **Tekster, ordret:** skærmens titel `RESOURCES`; kolonnerne `HOLD`, `BEAM`, `USES`; fodlinjen
  `↑↓ SELECT   ENTER BEAM TAKES THIS   O JETTISON 250 KG   SHIFT+O ALL   I CLOSE`;
  log `JETTISONED · 250 KG ICE` (kilo med `formatKg`, ressourcen i versaler); afvisning
  `NO RARE HERE` (ressourcens navn i versaler); MINE-rækken i ro `▸ READY · RARE`; besked
  `SAVE IS FROM A NEWER VERSION — KEPT, NOT LOADED`.
- **D14:** én tast må ikke betyde to ting. Skærmens taster læses kun, mens skærmen er åben, og
  flyvningens taster virker ikke imens.
- **Ingen DOM-tests, ingen jsdom, ingen ny dependency.** DOM bedømmes på review-shots.
- **Server og klient deler skemaet.** Server-suiten køres i hver task, der rører `src/save/`.
- **Test-kørsel:** `npx vitest run --maxWorkers=2 --testTimeout=120000`, `npm run typecheck`,
  `npm run test:server` (kræver `docker compose up -d db-test`), også på rene test-commits.
- **Git:** kun gren `v4` i worktree'et; ingen push eller merge uden ejerens ord.

## Review Focus

1. **Et format 1-save med en lang handlingslog og et checkpoint:** efter opgradering er last, tank,
   tabt kapacitet og udvundne sten præcis som før, og valget er is. → Task 1.
2. **Udsmidning af mere, end der er:** der smides kun det, der er; lasten bliver aldrig negativ,
   og en mængde på 0, negativ eller NaN afvises uden post i loggen. → Task 1.
3. **Fanen lukkes lige efter en udsmidning:** efter genindlæsning er lasten uden det udsmidte, og
   det dobbelt-tælles ikke af genspilning plus snapshot. → Task 1 og Task 4.
4. **Valget står på en ressource, stenen ikke har:** `B` starter intet, rækken og loggen siger
   `NO RARE HERE`, og et tryk på `B` kan aldrig få strålen til at tage noget andet. → Task 2.
5. **`I` trykket i cruise, hop, under nødsignal, på kortet og i pause:** skærmen åbner ikke, og
   intet tastetryk på skærmen når flyvningen (ingen hop på `J`, intet gas på pilene). → Task 4.

---

### Task 1: Udsmidning som regel og save-format 2

**Files:**
- Modify: `src/ship/cargo.ts`, `src/save/schema.ts`, `src/save/migrate.ts`, `src/save/replay.ts`,
  `src/save/bootLoad.ts`, `src/save/actionJournal.ts` (kun hvis nødvendigt), fixtures i
  `src/save/fixtures/`, og de tilhørende testfiler inkl. `src/save/schemaDrift.test.ts`
- Test: `src/ship/cargo.test.ts`, `src/save/migrate.test.ts`, `src/save/replay.test.ts`,
  `src/save/bootLoad.test.ts`, server-testene under `server/`

**Interfaces:**
- Produces:
  - `cargo.ts`: `JETTISON_STEP_KG = 250`; `CargoAction` får
    `{ kind: 'jettison'; resource: Resource; kg: number }`. Resultat: `ok: true`, `kgOut` = det
    faktisk udsmidte (`min(kg, beholdning)`); `reason: 'empty'`, når der intet er af ressourcen;
    `reason: 'invalid'`, når `kg` ikke er et endeligt tal over 0. Ingen ny `reason`.
  - `schema.ts`: `CURRENT_FORMAT = 2`; `SaveV1Schema` uændret med `format: z.literal(1)`;
    `SaveV2Schema` = format 1 plus `jettison` i `CargoActionSchema` og `ship.beamResource`
    (en `Resource`); `type Save = z.infer<typeof SaveV2Schema>` er det, resten af koden bruger.
  - `migrate.ts`: `UPGRADES[1]` sætter `format: 2` og `ship.beamResource: 'ice'` og ændrer intet
    andet; et formatnummer over `CURRENT_FORMAT` giver `reason: 'newer-build'`, et under
    `OLDEST_FORMAT` stadig `'unknown-format'`.
  - `replay.ts`: `applyEntry` trækker `result.kgOut` fra `cargo[action.resource]` for `jettison`.
  - `bootLoad.ts`: `SAVE_NEWER_TEXT = 'SAVE IS FROM A NEWER VERSION — KEPT, NOT LOADED'`, brugt når
    `migrate` svarer `'newer-build'`; kopien lægges stadig på hylden med `keepCorrupt`.

- [ ] **Step 1: Skriv de fejlende tests:**
  - **Regel:** udsmidning af 250 kg is fra 1 000 giver 750 og `kgOut 250`; af 250 fra 100 giver 0 og
    `kgOut 100`; af en ressource med 0 kg giver `empty` og uændret last; `kg` 0, −1, NaN og
    Infinity giver `invalid`; de andre tre ressourcer røres aldrig; `cargo:action` udsendes præcis
    én gang.
  - **Skema:** et format 2-save med en `jettison`-post og `beamResource: 'metal'` er gyldigt; samme
    post i et save med `format: 1` er `invalid`; `beamResource` uden for de fire ressourcer er
    `invalid`; `schemaDrift` holder for den nye handling.
  - **Opgradering (Review Focus 1):** hver fixture i `src/save/fixtures/` i format 1 løftes til
    format 2 med `migratedFrom: 1`, `beamResource: 'ice'`, og genspilning giver samme last, tank,
    `capacityLossFrac` og verden som før opgraderingen; `migrate` ændrer ikke sit input.
  - **Genspilning og komprimering (Review Focus 2, 3):** en log med mine 500, jettison 250, mine 250
    giver 500 kg; samme log komprimeret til et checkpoint giver samme last.
  - **Nyere version:** `format: 3` giver `newer-build`; `bootLoad` viser `SAVE_NEWER_TEXT`, kalder
    `keepCorrupt` med det rå save uændret og starter et nyt spil; et ødelagt save viser stadig
    `SAVE UNREADABLE — KEPT A COPY`.
  - **Nødsignalets note:** en frivillig `jettison` før et nødsignal ændrer ikke nødsignalets
    "hold jettisoned"-tal (`bootLoad.ts:122` læser fortsat kun `jettison-all`).
  - **Server:** et format 2-save accepteres; et format 1-save accepteres og gemmes som format 2;
    et `format: 3`-save afvises med samme status som et ugyldigt save i dag.
- [ ] **Step 2:** Run → FAIL. List godkendte assertions, der skal ændres (forventet: tests, der
  låser `CURRENT_FORMAT` til 1, `unknown-format` for et højere nummer, og listen af `kind`).
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér. Typen `SaveV1` erstattes af `Save` dér, hvor koden mener "det
  aktuelle format"; `SaveV1Schema` bruges kun af opgraderingen og dens tests.
- [ ] **Step 5:** Klient-suite, server-suite, typecheck → PASS. Commit.

### Task 2: Strålens valg i `Mining`

**Files:**
- Modify: `src/game/miningRules.ts`, `src/game/Mining.ts`, `src/ui/actionRows.ts`,
  `src/game/ActionFeed.ts`, `src/game/SaveGame.ts` (gem og gendan valget), tilhørende tests

**Interfaces:**
- Consumes: `ship.beamResource` (Task 1).
- Produces:
  - `miningRules.ts`: `MayMineReason` får `'not-here'`; `REFUSAL_LOG['not-here']` bygges af
    ressourcen (`NO RARE HERE`) via `notHereText(r: Resource): string`. `chooseResource` fjernes
    eller gøres til `hasResource(remaining, r): boolean`; ingen funktion må vælge for spilleren.
  - `Mining`: `get beamResource(): Resource` (standard `'ice'`), `setBeamResource(r: Resource): void`
    (ændrer ikke en udvinding i gang; gælder fra næste `B`).
  - `actionRows(status, beam: Resource)`: MINE-rækken i ro viser `▸ READY · <RESSOURCE>`; en
    blokeret række viser årsagen som i dag; `not-here` viser `NO <RESSOURCE> HERE`.

- [ ] **Step 1: Skriv de fejlende tests:**
  - Valget metal ved en sten med is og metal: `B` starter en udvinding af metal;
    `mining:started` bærer `resource: 'metal'`.
  - Valget rare ved en sten uden rare (Review Focus 4): `B` starter intet, loggen siger
    `NO RARE HERE`, `status('mine')` er blokeret med `not-here`, og ti tryk på `B` giver aldrig en
    `mining:started` for en anden ressource.
  - Den valgte ressource løber tør midt i en udvinding: udvindingen ender som i dag (`… DEPLETED`),
    og et nyt `B` giver `not-here`, ikke den næste ressource.
  - `setBeamResource` under en udvinding ændrer ikke den kørende; næste `B` bruger det nye valg.
  - Rækken: `▸ READY · ICE` i ro; ingen rækketekst er længere end den længste i dag (mål i tegn mod
    den eksisterende længste tekst).
  - Save: valget metal gemmes i `ship.beamResource` og er metal efter genindlæsning; et opgraderet
    format 1-save giver is.
- [ ] **Step 2:** Run → FAIL. List godkendte assertions, der skal ændres (forventet: tests af
  `chooseResource`'s rækkefølge, `REFUSAL_LOG` i `src/game/miningRules.test.ts:203-219`, og
  `▸ READY` i `src/ui/actionRows.test.ts` og e2e).
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér.
- [ ] **Step 5:** Suiter og typecheck → PASS. Commit.

### Task 3: Skærmens regler

**Files:**
- Create: `src/ui/resourcesState.ts`, `src/ui/resourcesState.test.ts`

**Interfaces:**
- Consumes: `Cargo.snapshot()`, `CARGO_CAPACITY_KG`, `JETTISON_STEP_KG`, `formatKg`,
  `Mining.status`, `actionRow` (samme statuskilde som HUD'en).
- Produces:
  - `RESOURCE_ORDER: readonly Resource[] = ['ice', 'rare', 'metal', 'silicate']`.
  - `interface ResourcesView { header: string; hold: ReadonlyArray<{ resource: Resource; text: string; selected: boolean; beam: boolean }>; uses: ReadonlyArray<{ label: string; cost: string; status: string; tone: 'ready' | 'blocked' | 'running' }>; footer: string }`
  - `resourcesView(s: { cargo: Readonly<Record<Resource, number>>; capacityKg: number; selected: Resource; beam: Resource; refine: ActionState; repair: ActionState }): ResourcesView`
  - `type ResourcesEvent = { kind: 'select'; resource: Resource } | { kind: 'beam'; resource: Resource } | { kind: 'jettison'; resource: Resource; kg: number } | { kind: 'close' }`
  - `resourcesKey(k: { code: string; shift: boolean; repeat: boolean }, s: { selected: Resource; cargo: Readonly<Record<Resource, number>> }): { event: ResourcesEvent | null; preventDefault: boolean }`
  - `USES`: tabellen bag USES-listen, to rækker: `REFINE` / `ICE → PROPELLANT` og
    `REPAIR` / `600 METAL + 400 SIL` (tallene læses fra `REPAIR_METAL_KG`, `REPAIR_SILICATE_KG`).

- [ ] **Step 1: Skriv de fejlende tests:**
  - Visning: alle fire ressourcer vises altid i `RESOURCE_ORDER`, også med 0 kg; header
    `HOLD 6 250 / 8 000 KG`; præcis én linje er `selected` og præcis én er `beam`; fodlinjen ordret.
  - USES: status og tone er lig `actionRow('refine' | 'repair', …)` for samme tilstand (ét
    eksempel pr. tone), så HUD og skærm ikke kan sige forskelligt.
  - Taster: pil ned fra silikat bliver på silikat, pil op fra is bliver på is; `Enter` giver
    `beam` for den markerede; `KeyO` giver `jettison` med 250, `Shift+KeyO` med hele beholdningen;
    `KeyO` på en ressource med 0 kg giver ingen hændelse; `KeyI` og `Escape` giver `close`;
    en gentaget tast (`repeat`) giver aldrig `jettison` eller `close`; enhver anden `Key…`,
    `Digit…`, pil eller `Space` giver ingen hændelse, men `preventDefault: true`
    (Review Focus 5: intet når flyvningen).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér.
- [ ] **Step 5:** Suiter og typecheck → PASS. Commit.

### Task 4: Skærmen i spillet

**Files:**
- Create: `src/ui/Resources.ts`
- Modify: `src/core/Modes.ts`, `src/core/Input.ts`, `src/game/gating.ts`, `src/game/registry.ts`,
  `src/game/saveTriggers.ts`, `src/game/SaveGame.ts`, `src/game/Shots.ts` (review-shots),
  tilhørende tests

**Interfaces:**
- Consumes: Task 1 (`jettison`), Task 2 (`setBeamResource`), Task 3 (`resourcesView`,
  `resourcesKey`).
- Produces:
  - `Modes`: ny `BaseMode` `'resources'`; lovlige skift `flight → resources`, `resources → flight`
    og `resources → review`; ingen overlay oven på den.
  - `Input`: `RESOURCES_KEY = 'KeyI'`, `ActionName` får `'resources'`.
  - `gating`: modulet `resources` er aktivt i `['resources']`; `mining`, `action-feed`,
    `mining-beams` forbliver `['flight']`.
  - `saveTriggers`: `SaveReason` får `'jettison'` med samme regel som `'mined'`
    (`AUTOSAVE_MIN_GAP_S`); skærmen lukket (`resources → flight`) beder også om et save, hvis noget
    blev smidt ud siden sidst.
  - `class Resources implements GameModule`, `name = 'resources'`; åbner på `'resources'`-handlingen
    fra flyvning, læser sine taster råt kun i tilstanden `resources`, og udfører hændelserne fra
    `resourcesKey` (`applyCargoAction`, `mining.setBeamResource`, `modes.go('flight')`).

- [ ] **Step 1: Skriv de fejlende tests:**
  - Tilstande: `flight → resources → flight` er lovlig; `map`, `yard`, `title` → `resources` kaster;
    foto-overlay kan ikke lægges på `resources`.
  - Åbning (Review Focus 5): `I` i flyvning åbner; i cruise, under hop, under nødsignal og i pause
    åbner den ikke og logger årsagen (`IN CRUISE`, `IN JUMP`, …, samme tekster som
    `OCCUPIED_TEXT`); på kortet og i værftet sker intet.
  - En udvinding i gang ender med `interrupted`, når skærmen åbnes; en raffinering afbrydes med
    `action:ended ok:false`; universets ur står stille, mens skærmen er åben.
  - Udsmidning: hændelsen `jettison` giver én `cargo:action` med `kind: 'jettison'`, loggen
    `JETTISONED · 250 KG ICE`, og et save bliver ønsket med årsagen `jettison`.
  - Genindlæsning efter udsmidning (Review Focus 3): lasten er uden det udsmidte, én gang.
  - Tastevagt: `KeyI` står ikke råt uden for `src/core/Input.ts`; `KeyO` står kun råt i
    `src/ui/resourcesState.ts`; `actionForKey('KeyI')` er `'resources'` og intet andet.
  - `registry.ts`: modulet er registreret efter `mining` (læst som tekst, som de øvrige
    registreringstests).
- [ ] **Step 2:** Run → FAIL. List godkendte assertions, der skal ændres (forventet: tests, der
  opregner `Mode`, `TRANSITIONS` eller `SaveReason`).
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér DOM og CSS i HUD'ens noir-stil. Registrér review-shots
  `resources-empty`, `resources-full` (fuld last, lange statustekster) og `hud-beam-choice`
  (MINE-rækken med valget).
- [ ] **Step 5:** `npx vite build`, `node scripts/shoot.mjs resources-empty resources-full
  hud-beam-choice --width 1280 --height 700 --out review/plan6-task4`; kig på billederne; send dem
  til ejeren. Suiter og typecheck → PASS. Commit.

### Task 5: Opslag, e2e og afslutning

**Files:**
- Modify: `src/ui/pauseState.ts` og test, `README.md`, `scripts/e2e-cloud.mjs`,
  `docs/v4/DECISIONS.md`, `docs/v4/PLAN.md`, `docs/v4/DESIGN.md`

- [ ] **Step 1: Skriv de fejlende tests:** pausearket får linjen `I` med teksten
  `RESOURCES — HOLD, BEAM, JETTISON`, læst fra `RESOURCES_KEY`. Det ændrer
  `src/ui/pauseState.test.ts:566` (`before.length + 5` → `+ 6`, 23 → 24 linjer): list den til
  ejeren.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse, også af e2e-ændringen i Step 5.
- [ ] **Step 4:** Implementér. README: `I` og skærmens taster under Controls.
- [ ] **Step 5:** `scripts/e2e-cloud.mjs`, scenarie 1 udvides efter raffineringen: åbn med `I`,
  smid 250 kg is ud med `O`, vælg metal med pil og `Enter`, luk; kræv `JETTISONED`-linjen, at
  lastens is faldt med det udsmidte, og at MINE-rækken viser `· METAL`; efter genindlæsning er
  begge dele uændret. Kravene i scenarie 1–4 er ellers uændrede. Det er en ændring i en godkendt
  acceptanstest.
- [ ] **Step 6:** Klient-suite, server-suite, typecheck, `npm run build`, `npm run e2e:cloud`.
- [ ] **Step 7:** DECISIONS: ny post D54 (valg A; fast valg af ressource erstatter rækkefølgen i
  D53 d; `jettison` og format 2; `newer-build` for et højere formatnummer; server og klient
  udrulles sammen; `O`/`I` og D14; USES er en tabel, ikke en motor). PLAN.md: ✅ ud for delplan 4
  og 5, og række 6. DESIGN.md §5.2 og §5.5: en note om format 2 og om skærmen.
- [ ] **Step 8:** Afsluttende review af hele delplanen (mest kapable model), én rettelsesrunde,
  Saga. Push og merge kun på ejerens ord.
