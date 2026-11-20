# Delplan 5: mining man kan se

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spilleren kan altid se, hvilke handlinger skibet har og hvorfor de ikke er mulige, kan se
mining og raffinering ske, og kan se stenen blive slidt og til sidst ødelagt.

**Architecture:**
- **Regler (rene):** `src/game/extraction.ts` beskriver en løbende udvinding som tid → bidder.
  `miningRules.ts` beholder kravene (`mayMine`) og får de nye tekster.
- **Tilstand:** `Mining` kører udvindingen, lægger hver bid i lasten som en almindelig `mine`-post
  og udstiller en liste af operationer og en status pr. handling. Intet nyt i save-formatet.
- **Afledt verden:** `Belt` afleder slid og "ødelagt" af `WorldState` og sorterer tomme sten fra ét
  sted. Renderer, HUD og lyd læser kun: `Asteroids` (slid, opbrud), `MiningBeams` (stråle, småsten),
  `Hud` (handlingsblok), `Audio`.

**Tech Stack:** TypeScript strict, Three.js 0.180 (ShaderMaterial, InstancedMesh), DOM/CSS-HUD,
WebAudio-syntese, Vitest, Playwright (`scripts/e2e-cloud.mjs`, `scripts/shoot.mjs`).

**Spec:** `docs/v4/DESIGN-5-mining-feel.md` (godkendt 2026-11-20). Baggrund: `docs/v4/DESIGN.md` §2,
§4, §5.5; `docs/v4/plan-2-mining.md`; `docs/v4/DECISIONS.md` D14, D27, D28, D37, D51 d. Overblik:
`docs/v4/PLAN.md`.

## Global Constraints

- **GS-TDD:** BDD Given-When-Then-tests skrives først, ejeren siger "godkendt", derefter
  implementeres. Hver task har et ⏸-trin. Ændres en allerede godkendt assertion, listes den med
  fil:linje, før → efter, og ejeren godkender den.
- **Save-formatet v1 ændres ikke.** En bid gemmes som `{ kind: 'mine', asteroidId, resource, kg }`.
- **Tal fra spec'en, ordret:** tempo `150` kg/s spiltid; bid `250` kg; krav som i dag
  (`MINE_RANGE_KM = 0.5`, `MINE_MAX_REL_KMS = 0.005`, `MINE_MIN_KG = 0.5`); raffinering `8` s og
  reparation `10` s uændret.
- **Tekster, ordret:** `▸ READY`, `IN CRUISE`, `IN JUMP`, `OUT OF RANGE — L TO APPROACH`,
  `MATCH SPEED — SPACE TO STOP`, `MINING STOPPED — <årsag>`, `— HOLD FULL`, `— ICE DEPLETED`
  (ressourcens navn i versaler), samt de eksisterende afvisningstekster i `REFUSAL_LOG`.
- **Draw calls:** stenene forbliver otte draw calls. Stråle, glød og småsten koster et fast antal
  draw calls uanset antallet af operationer.
- **Performance:** v2's budget måles på GPU før (HEAD ved start) og efter, i et bæltefelt, med og
  uden en udvinding i gang.
- **Farver:** rav er skibets systemer, cyan er navigationsmålet. Strålen er varm hvid-rav.
- **Test-kørsel:** `npx vitest run --maxWorkers=2 --testTimeout=120000` og `npm run typecheck`,
  også på rene test-commits.
- **Git:** kun gren `v4` i worktree'et; ingen push eller merge uden ejerens ord.

## Review Focus

1. **Flere bidder i én frame (100× tidskompression):** summen i lasten må aldrig overstige pladsen
   eller det, stenen har tilbage, og ingen bid må være under 0,5 kg. → Task 1 og Task 3.
2. **Fanen lukkes midt i en udvinding:** alle færdige bidder er gemt, den ufærdige er ikke sket, og
   last og sten stemmer efter genindlæsning. → Task 3.
3. **Den sidste bid tømmer stenen, mens den er målet:** årsagen er `DEPLETED`, målet ryddes,
   formationshold slippes, og hverken HUD, autopilot eller scanner fejler på et id, der ikke
   længere findes. → Task 2 og Task 3.
4. **En sten tømt på en anden enhed, mens man holder ved den:** efter at skyens save er taget, er
   stenen væk som mål uden opbrudsanimation og uden fejl. → Task 2.
5. **Lavt vindue (700 px højde) med fuld last og lange årsager:** handlingsblokken overlapper ikke
   loggen. → Task 4.

---

### Task 1: Udvinding som regler

**Files:**
- Create: `src/game/extraction.ts`, `src/game/extraction.test.ts`
- Modify: `src/game/miningRules.ts`, `src/game/miningRules.test.ts`

**Interfaces:**
- Consumes: `Resource` (`@/gen/belt`), `MINE_MIN_KG`, `formatKg`, `MayMineReason` (`miningRules`).
- Produces (i `extraction.ts`):
  - `MINE_RATE_KG_S = 150`, `MINE_BITE_KG = 250`.
  - `interface Extraction { asteroidId: string; resource: Resource; minedKg: number; carryKg: number }`
  - `startExtraction(asteroidId: string, resource: Resource): Extraction`
  - `accrue(e: Extraction, simSeconds: number): void` — lægger `MINE_RATE_KG_S × simSeconds` til
    `carryKg` (negativ eller NaN tid tæller som 0).
  - `nextBiteKg(e: Extraction, holdFreeKg: number, remainingKg: number): number` — størrelsen af den
    bid, der er forfalden nu, ellers `0`. En bid er `min(MINE_BITE_KG, holdFreeKg, remainingKg)` og
    er forfalden, når `carryKg` ≥ biddens størrelse; under `MINE_MIN_KG` er der ingen bid.
  - `commitBite(e: Extraction, kg: number): void` — `minedKg += kg`, `carryKg -= kg`.
  - `shownKg(e: Extraction, holdFreeKg: number, remainingKg: number): number` — `minedKg` plus den
    påbegyndte del af næste bid, til HUD'ens jævne tal; aldrig over det, der kan nås.
  - `type ExtractionEnd = 'stopped' | 'hold-full' | 'resource-depleted' | 'rock-depleted' | 'range' | 'speed' | 'no-target' | 'busy' | 'interrupted'`
  - `extractionLog(end: ExtractionEnd, minedKg: number, resource: Resource): string`
- Produces (i `miningRules.ts`): `MINE_ACTION_S` og `MINE_YIELD_KG` fjernes; `ACTION_HINT:
  Readonly<Partial<Record<MiningRefusal, string>>>` med `range: 'L TO APPROACH'` og
  `speed: 'SPACE TO STOP'`.

- [ ] **Step 1: Skriv de fejlende tests:**
  - **Tempo:** fra tom last, sten med 2 000 kg is: efter `accrue` på i alt 10/6 s er præcis én bid
    på 250 kg forfalden; efter 13,34 s i trin på 1/60 s er der taget 8 bidder à 250 kg, i alt 2 000.
  - **Flere bidder pr. frame:** ét `accrue(3.4)` giver to bidder à 250 kg ved gentagne
    `nextBiteKg`/`commitBite`, og `carryKg` er derefter 10.
  - **Sidste bid er mindre:** 100 kg tilbage i ressourcen → bidden er 100 kg og forfalder ved
    `carryKg` ≥ 100; 300 kg plads → 250 og derefter 50.
  - **Støv:** plads eller rest under 0,5 kg → `nextBiteKg` er 0, uanset `carryKg`.
  - **Aldrig over:** for vilkårlige trin (tabel med 1/60, 1/6, 3.33 s) er summen af bidder aldrig
    større end `min(plads, rest)` ved start.
  - **`shownKg`:** vokser jævnt mellem bidder, er lig `minedKg` lige efter en bid, og overstiger
    aldrig `minedKg + min(MINE_BITE_KG, plads, rest)`.
  - **Tekster:**
    - `('stopped', 1250, 'ice')` → `MINED · 1 250 KG ICE`
    - `('hold-full', 2000, 'ice')` → `MINED · 2 000 KG ICE — HOLD FULL`
    - `('resource-depleted', 1250, 'ice')` → `MINED · 1 250 KG ICE — ICE DEPLETED`
    - `('rock-depleted', 500, 'silicate')` → `MINED · 500 KG SILICATE — DEPLETED`
    - `('range', 750, 'ice')` → `MINING STOPPED — OUT OF RANGE · 750 KG ICE`
    - `('speed', 0, 'ice')` → `MINING STOPPED — MATCH SPEED`
    - `('interrupted', 0, 'ice')` → `MINING STOPPED`
  - **`miningRules.test.ts`:** tests, der låser `MINE_ACTION_S` og `MINE_YIELD_KG`, fjernes eller
    ændres (godkendte assertions: list dem).
- [ ] **Step 2:** Run → FAIL. `npm run typecheck`: kun fejl for manglende eksport.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér.
- [ ] **Step 5:** Run → PASS, typecheck ren. Commit.

### Task 2: Slid og ødelagte sten i `Belt`

**Files:**
- Modify: `src/game/Belt.ts`, `src/game/Belt.test.ts`

**Interfaces:**
- Consumes: `WorldState.depleted(id)`, `MINE_MIN_KG`.
- Produces:
  - `Belt.wear(id: string): number` — udvundet masse / oprindelig masse, 0..1; 0 for ukendt id.
  - `Belt.isDestroyed(id: string): boolean` — alle fire ressourcer har under `MINE_MIN_KG` tilbage.
  - En ødelagt sten findes ikke: `asteroidSpec`, `asteroidWorld`, `asteroidVelocity` og alle
    `asteroidsNear*`-opslag udelader den; den "nærmeste isrige sten" og dens faldgrube til "en
    hvilken som helst sten" returnerer `null`, når feltet er tomt.
  - `Belt.asteroidSpecRaw(id)` — den oprindelige spec også for en ødelagt sten (til opbruddet i
    Task 5); bruges ingen andre steder.

- [ ] **Step 1: Skriv de fejlende tests:**
  - Slid er 0 for en urørt sten, `2000/total` efter 2 000 kg, og 1 for en tømt.
  - En sten med 0,4 kg tilbage af hver ressource er ødelagt; med 0,5 kg af én er den ikke.
  - En ødelagt sten mangler i hvert af de nævnte opslag (én test pr. opslag).
  - Et felt, hvor alle sten er ødelagt, giver `null` som første mål.
  - Efter `WorldState` er genindlæst med en tømt sten, er stenen væk uden nogen hændelse
    (Review Focus 4).
  - Eksisterende tests for `remainingKg` og nærmeste isrige sten er uændrede.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér. Filtrér ét sted, så ingen kalder behøver egne regler.
- [ ] **Step 5:** Run hele klient-suiten → PASS. Commit.

### Task 3: `Mining` kører udvindingen

**Files:**
- Modify: `src/game/Mining.ts`, `src/game/Mining.test.ts`, `src/core/EventBus.ts`,
  `src/ui/hintRules.ts`, `src/ui/hintRules.test.ts`, `src/ui/Hints.ts`, `src/game/registry.ts`

**Interfaces:**
- Consumes: Task 1 (`extraction.ts`), Task 2 (`Belt.isDestroyed`), `applyCargoAction`,
  `worldState.recordMined`.
- Produces:
  - `interface MiningOperation { readonly asteroidId: string; readonly resource: Resource; readonly source: Readonly<Vec3>; readonly impact: Readonly<Vec3> }`
    — `source` er skibets næse i verden, `impact` det punkt på stenens overflade, der er nærmest
    skibet; begge opdateres pr. frame uden allokering.
  - `Mining.operations: readonly MiningOperation[]` — tom eller ét element i denne delplan.
  - `type ActionState = { readonly kind: 'ready' } | { readonly kind: 'blocked'; readonly reason: MiningRefusal | 'cruise' | 'jump' } | { readonly kind: 'running'; readonly progress: number; readonly shownKg: number; readonly leftS: number; readonly resource: Resource | null }`
  - `Mining.status(kind: MiningKind): ActionState` — for mining er `progress` lastens fyldning
    (0..1) og `shownKg` fra `shownKg()`; for raffinering/reparation er `progress` andel af tiden og
    `leftS` resten.
  - `Mining.relSpeedKmS: number` og `Mining.speedOk: boolean` (kun meningsfulde med en sten som mål).
  - Hændelser på bussen: `'mining:started' { asteroidId, resource }`, `'mining:bite' { asteroidId, resource, kg }`,
    `'mining:ended' { asteroidId, resource, minedKg, end: ExtractionEnd }`,
    `'asteroid:destroyed' { asteroidId }` (udsendt i den frame, den sidste bid tømmer stenen).
  - `'mine'`-lektionen tæller `mining:ended` med `minedKg > 0`, ikke `cargo:action`.

- [ ] **Step 0: Mål tidskompression.** Hold ved en sten med farthold (FA) og mål, om
  tidskompression 10× kan slås til og forbliver til (`engineOutput < 0.01`). Skriv resultatet i
  rapporten. Kan den ikke, stoppes tasken efter fase A, og ejeren afgør (spec §9).
- [ ] **Step 1: Skriv de fejlende tests:**
  - **Start og forløb:** `B` med opfyldte krav starter; efter 10/6 s spiltid er 250 kg is i lasten,
    `recordMined` er kaldt én gang med 250, og `mining:bite` er udsendt én gang.
  - **Ressourcevalg:** en udvinding tager den første ikke-tomme i rækkefølgen is, sjælden, metal,
    silikat og skifter ikke undervejs.
  - **Stop:** `B` igen → `MINED · … KG ICE`, det udvundne er i lasten; fuld last → `— HOLD FULL`;
    ressourcen tom, men stenen har andet → `— ICE DEPLETED`; nyt `B` starter på næste ressource.
  - **Brudt krav:** ude af rækkevidde / for høj fart / nyt mål / cruise / hop / pause /
    `ship:recovered` / forladt flyvetilstand → udvindingen slutter med den rette årsag, og de
    færdige bidder er bevaret (én test pr. årsag; godkendte "ABORTED giver intet"-tests ændres).
  - **Review Focus 1:** ved `simulatedSeconds = 3.4` lægges to bidder i samme frame; med 300 kg
    plads lægges 250 + 50 og derefter `HOLD FULL`; kravene tjekkes én gang pr. frame.
  - **Review Focus 2:** efter 3 bidder og en afbrudt fjerde er lasten 750 kg, stenens rest
    reduceret med 750, og journalen har 3 `mine`-poster; replay af journalen giver samme last.
  - **Review Focus 3:** den sidste bid tømmer stenen → `asteroid:destroyed` én gang,
    `mining:ended` med `end: 'rock-depleted'`, loglinjen ender på `— DEPLETED`, og næste frame
    kaster ikke, selv om målets id ikke længere findes i `Belt`.
  - **Tømt mål:** var den tømte sten spillerens mål, er målet ryddet i næste frame, og et
    formationshold slippes med den eksisterende linje `FORMATION RELEASED`.
  - **`U`/`N` under udvinding** → `BUSY`. Raffinering og reparation: uændrede regler og tekster.
  - **Status:** `status('mine')` er `ready`, `blocked` med hver årsag (inkl. `cruise` og `jump`,
    som ikke længere er `busy`) eller `running` med stigende `shownKg`; `status('refine')` er
    `running` med `progress` 0,5 efter 4 s.
  - **Operationer:** listen har ét element under udvinding og er tom ellers; `impact` ligger på
    stenens overflade (afstand til centrum = radius ± 1 mm).
  - **Lektion:** to bidder i én udvinding tæller som én; `mining:ended` med 0 kg tæller ikke.
- [ ] **Step 2:** Run → FAIL. Typecheck: kun manglende felter.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse (med listen over ændrede godkendte assertions).
- [ ] **Step 4:** Implementér. Bidderne lægges i en løkke pr. frame; ingen allokering pr. frame.
- [ ] **Step 5:** Run hele klient-suiten → PASS, typecheck ren, `npx vite build`. Commit.

### Task 4: Handlingsblokken i HUD'en

**Files:**
- Create: `src/ui/actionRows.ts`, `src/ui/actionRows.test.ts`
- Modify: `src/ui/Hud.ts`, `src/ui/Hud.test.ts` (eller den eksisterende HUD-testfil), `src/game/registry.ts`

**Interfaces:**
- Consumes: `ActionState`, `Mining.status`, `Mining.speedOk` (Task 3); `REFUSAL_LOG`,
  `ACTION_HINT` (Task 1); `MINING_KEYS`.
- Produces:
  - `interface ActionRow { readonly label: 'MINE' | 'REFINE' | 'REPAIR'; readonly key: string; readonly tone: 'ready' | 'blocked' | 'running'; readonly text: string; readonly fill: number | null }`
  - `actionRow(kind: MiningKind, state: ActionState): ActionRow` (ren).
  - `Hud.setActions(rows: readonly [ActionRow, ActionRow, ActionRow]): void` og
    `Hud.setSpeedOk(ok: boolean | null): void` (`null`: ingen sten som mål).

- [ ] **Step 1: Skriv de fejlende tests:**
  - `ready` → tekst `▸ READY`, tone `ready`, `fill` null.
  - `blocked` med `range` → `OUT OF RANGE — L TO APPROACH`; `speed` → `MATCH SPEED — SPACE TO STOP`;
    `cruise` → `IN CRUISE`; `jump` → `IN JUMP`; `busy` → `BUSY`; `insufficient` → den forkortede
    `NEED METAL · SILICATE`; øvrige årsager → teksten fra `REFUSAL_LOG`.
  - `running` mining med `shownKg` 1240 og `resource` is → tekst `ICE 1 240 KG`, `fill` = `progress`.
  - `running` raffinering med `leftS` 4,2 → tekst `5 S` (rundet op), `fill` = `progress`.
  - Tasten vises uden `Key`-præfiks: `B`, `U`, `N`.
  - **HUD:** blokken har altid tre rækker i flyvetilstand, også med tom last; `setActions` skriver
    kun tekst og CSS-variabler (ingen nye DOM-noder pr. kald); `setSpeedOk(true)` sætter VEL's tone.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér i HUD'ens eksisterende stil (`panel`, `TextSlot`, `CssVar`,
  `os-prop-track`-mønstret til bjælken), under CARGO i venstre panel.
- [ ] **Step 5:** Run → PASS. **Review Focus 5:** tag skærmbilleder med `scripts/shoot.mjs` ved
  1280×700 med fuld last (5 CARGO-linjer) og de længste årsager på alle tre rækker; blokken må
  ikke overlappe loggen. Læg billederne i rapporten. Commit.

### Task 5: Synligt slid og opbrud

**Files:**
- Modify: `src/render/Asteroids.ts`, `src/render/Asteroids.test.ts`, `src/render/asteroidSurface.ts`,
  `src/render/asteroidSurface.test.ts`, `src/game/registry.ts`

**Interfaces:**
- Consumes: `Belt.wear`, `Belt.asteroidSpecRaw` (Task 2), `'asteroid:destroyed'` (Task 3).
- Produces:
  - Instance-attributten `aWear` (float pr. sten) ved siden af `aSurface` og `aMetal`.
  - `wearVisual(wear: number): number` i `asteroidSurface.ts` (ren): 0 → 0, 1 → 1, monotont
    voksende og konkav, med `wearVisual(2000 / 65000) ≥ 0.15` ("synligt fra første bid").
  - Opbrud: ved `'asteroid:destroyed'` tegnes stenen i `BREAKUP_S = 2.5` s som stykker, der driver
    fra hinanden og toner ud, inden for de samme otte draw calls plus højst ét.

- [ ] **Step 1: Skriv de fejlende tests:**
  - `wearVisual` opfylder de fire krav ovenfor (tabel).
  - `aWear` skrives pr. synlig sten fra `belt.wear(id)` og opdateres, når sliddet ændres.
  - Antallet af `InstancedMesh` er uændret otte; opbruddet tilføjer højst ét draw call.
  - En sten, der er ødelagt ved indlæsning, tegnes ikke og giver intet opbrud.
  - Efter `BREAKUP_S` er opbruddet væk, og dets ressourcer er frigivet.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér. Arrenes placering kommer af stenens seed (samme hos alle spillere);
  ar mørkner og udhuler overfladen i shaderen. Udseendet er builderens valg inden for dette.
- [ ] **Step 5:** Run → PASS. Skærmbilleder af samme sten ved slid 0, 3 %, 40 % og 95 % samt midt i
  et opbrud lægges i rapporten til ejeren. Commit.

### Task 6: Strålen

**Files:**
- Create: `src/render/MiningBeams.ts`, `src/render/MiningBeams.test.ts`
- Modify: `src/game/registry.ts`

**Interfaces:**
- Consumes: `Mining.operations` (Task 3), `'mining:bite'`; scenens HDR-kontrakt og den
  kamera-relative tegning, som `Asteroids` bruger.
- Produces: `class MiningBeams implements GameModule` med `MAX_BEAMS = 8`; stråle, nedslagsglød og
  småsten for hver operation i højst tre draw calls i alt, uanset antal.

- [ ] **Step 1: Skriv de fejlende tests:**
  - Ingen operationer → intet synligt (instance-antal 0); én operation → én stråle fra `source` til
    `impact`, kamera-relativt.
  - Strålen toner ind over `BEAM_FADE_S = 0.25` og ud over det samme, når operationen forsvinder.
  - Otte operationer giver stadig højst tre draw calls; en niende ignoreres uden fejl.
  - Hver `'mining:bite'` udsender et pust af småsten ved `impact`; antallet af levende småsten har
    et fast loft.
  - Materialerne følger scenens kontrakt (`toneMapped` false, lineær farve); farven er varm
    hvid-rav og ikke cyan.
  - Ingen allokering pr. frame i `update`/`lateUpdate` (samme mønster som `Asteroids`-testen).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér.
- [ ] **Step 5:** Run → PASS. GPU-måling før/efter i et felt med og uden udvinding; skærmbillede af
  strålen i rapporten. Commit.

### Task 7: Lyd

**Files:**
- Modify: `src/audio/Audio.ts`, `src/audio/Audio.test.ts` (eller den eksisterende lydtestfil),
  `src/game/Mining.ts`, `src/game/Mining.test.ts`, `src/core/EventBus.ts`

**Interfaces:**
- Consumes: `'mining:started'`, `'mining:bite'`, `'mining:ended'`, `'asteroid:destroyed'` (Task 3).
- Produces (i `Mining`): `'action:started' { kind: 'refine' | 'repair' }` og
  `'action:ended' { kind: 'refine' | 'repair'; ok: boolean }` på bussen, udsendt når en raffinering
  eller reparation starter og slutter (fuldført eller afbrudt).
- Produces: en vedvarende tone under udvinding, en kort lyd pr. bid (højst én pr. 0,06 s som de
  øvrige blip), en dybere lyd ved opbrud, og en anden vedvarende tone under raffinering og
  reparation.

- [ ] **Step 1: Skriv de fejlende tests** (mod lydmodulets eksisterende testbare lag):
  - `Mining` udsender `action:started` og `action:ended` for raffinering og reparation, med
    `ok: false` ved afbrydelse.
  - Tonen starter ved `mining:started` og stopper ved `mining:ended`, også når udvindingen slutter
    af et brudt krav, ved pause og ved forladt flyvetilstand (ingen hængende tone).
  - Ti bidder i samme frame giver højst én bid-lyd.
  - Raffineringens tone starter og stopper med handlingen og har en anden grundfrekvens end minings.
  - Lyd slået fra eller ikke låst op af browseren → ingen fejl.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér i den eksisterende syntese (ingen lydfiler).
- [ ] **Step 5:** Run → PASS. Commit.

### Task 8: Opslag, lektioner og afslutning

**Files:**
- Modify: `src/ui/Pause.ts`, `src/ui/pauseState.ts` og tests, `src/ui/hintRules.ts`,
  `src/ui/hintRules.test.ts`, `src/ui/Hints.ts`, `README.md`, `scripts/e2e-cloud.mjs`,
  `docs/v4/DECISIONS.md`, `docs/v4/PLAN.md`, `docs/v4/DESIGN.md`

**Interfaces:**
- Consumes: `Mining.status` (Task 3), tastekortet i `src/core/Input.ts`.
- Produces: `HintId` får `'approach'` og `'refine'`; Pause-arkets taster får fem nye linjer.

- [ ] **Step 1: Skriv de fejlende tests:**
  - **Pause-arket** lister `B` mine, `U` raffinér, `N` reparér, `K` formationshold, `H` nødudgang
    med `1`/`2`/`3`; `L` har teksten `AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET`. Tasterne
    læses fra tastekortet, ikke skrevet i hånden (én test, der fejler, hvis kortet ændres).
  - **Lektioner:** `L — APPROACH`, når en asteroide er valgt og uden for rækkevidde; `U — REFINE`,
    når der er is i lasten og plads i tanken; begge pensioneres efter 2 brug; rækkefølgen i forhold
    til `mine` og nødlinjen er: nødlinje, klik, `mine`, `approach`, `refine`, de øvrige.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér. Opdatér README'ens Controls (mining, raffinering, reparation,
  nødudgang; ret linjerne om `L` og "no inventory").
- [ ] **Step 5:** `scripts/e2e-cloud.mjs` tilpasses den løbende udvinding (start med `B`, vent på
  `MINED`-linjen, stop med `B` eller ved fuld last); kravene i scenarie 1–4 er uændrede. Det er en
  ændring i en godkendt acceptanstest: list den til ejeren.
- [ ] **Step 6:** Kør hele klient-suiten, server-suiten, typecheck, `npm run build` og
  `npm run e2e:cloud`. GPU-måling samlet før/efter.
- [ ] **Step 7:** DECISIONS: ny post, der erstatter D14 for mining og noterer §5.5; tempo og bid;
  slid og ødelæggelse afledt; én ressource pr. udvinding (ejer); `IN CRUISE`/`IN JUMP`; flere
  poster i loggen (D51 d); resultatet af målingen i Task 3 Step 0. PLAN.md: delplan 5 i tabellen.
  DESIGN.md §5.5: note om, at udvinding nu er løbende.
- [ ] **Step 8:** Afsluttende review af hele delplanen (mest kapable model), én rettelsesrunde,
  Saga. Push og merge kun på ejerens ord.
