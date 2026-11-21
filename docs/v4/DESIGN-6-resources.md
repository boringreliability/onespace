# oneSpace v4, delplan 6: ressourceskærmen

> Status: udkast til ejerens godkendelse (2026-11-21). Mærket **[ejer]** er sagt af ejeren;
> **[Claude]** er mit valg og kan rettes.

## 1. Hvorfor

Ejeren har spillet delplan 5 og fandt ét hul **[ejer]**: lasten fyldes med is, tanken er fuld, og så
kan man ikke mine "de gode ting". Der er ingen måde at komme af med last på.

Koden viser, at hullet har to halvdele:

- **Lasten kan kun bruges op, ikke tømmes.** Is forsvinder ved raffinering, metal og silikat ved
  reparation. Med fuld tank er isen død vægt i en last på 8 000 kg.
- **Spilleren vælger ikke, hvad strålen tager.** `B` tager altid is først, så rare, metal og silikat
  (`chooseResource`, `src/game/miningRules.ts:84`). Smider man isen ud og trykker `B` igen, får man
  is igen, indtil stenens is er tom.

Næste fase **[ejer]**: man er en von Neumann-sonde, der er dukket op et ukendt sted. Man bygger
langsomt ressourcer op for at komme videre fra det system, man er vågnet i: udvikler skibet, laver
baser, 3D-printere m.m. Derfor skal ressourcerne have **en egen skærm** **[ejer]**, som næste fase
kan vokse i, og ikke bare to taster i HUD'en.

## 2. Mål

- **G1** Spilleren kan se hele lasten ét sted.
- **G2** Spilleren bestemmer, hvilken ressource strålen tager, og kan se valget uden at åbne skærmen.
- **G3** Spilleren kan smide en valgt mængde af en valgt ressource ud.
- **G4** Skærmen viser, hvad lasten kan blive til i dag (raffinering, reparation), og den liste er
  stedet, hvor næste fases muligheder lægges til.
- **G5** Gamle saves virker videre uden at spilleren mærker det.

## 3. Ikke-mål

- **Ingen generel opskriftsmotor** (valg A, **[ejer]**: "A for nu"). Raffinering og reparation
  forbliver de to handlinger, de er.
- Ingen baser, printere, skibsopgraderinger eller handel. De hører til næste fase.
- Udsmidt materiale kan ikke samles op igen og findes ikke i verden bagefter.
- Raffinering og reparation startes ikke fra skærmen.

## 4. Anti-mål

- En skærm, der skal laves om, når den første ting, man kan bygge, kommer til.
- Et save, der bliver afvist eller ender på "corrupt"-hylden, fordi formatet blev ændret.
- En stråle, der stadig tager noget andet end det, spilleren valgte.
- At spilleren kan smide last ud ved et uheld med ét tastetryk i flyvningen.

## 5. Rammer

- **Save-formatet er låst (R4, `src/save/schema.ts:15-20`).** Enhver ændring af formen, også en ny
  slags handling eller et nyt valgfrit felt, kræver `CURRENT_FORMAT + 1` og et trin i `UPGRADES`
  (`src/save/migrate.ts:32-35`). I dag er begge tomme: dette bliver første formatskift.
- **Server og klient deler skemaet** (`server/save/routes.ts:38` kalder `migrate`). De skal udrulles
  sammen. Databasen skal ikke ændres; handlinger ligger som `jsonb`.
- **Et ukendt `kind` i et format 1-save gør hele savet ugyldigt** (`migrate.ts:66-70`). Derfor må
  den nye handling aldrig skrives i et save, der kalder sig format 1.
- **Et højere formatnummer afvises som `unknown-format`** (`migrate.ts:55-57`), før indholdet læses.
  Det er sådan, en klient eller server, der kun kender format 1, møder et format 2-save. Hvad
  spilleren så ser, og at savet ikke går tabt, skal slås op og låses af en test.
- **Multiplayer må ikke låses ude** (DESIGN §4): udsmidning er en handling i loggen med mængde og
  ressource, som en server senere kan validere.
- **Ingen DOM-tests og ingen jsdom.** Skærmens regler ligger i rene funktioner med tests; selve
  DOM'en bedømmes på skærmbilleder (review-shots), som i delplan 5.
- **Taster:** `I` og `O` læses ingen steder i `src/` i dag. D14: én tast må ikke betyde to ting. Rå-tast-testene
  (`src/game/Mining.test.ts:247`, `src/game/Emergency.test.ts:532`) scanner citerede tastnavne; nye
  taster skal ind i tastekortet i `src/core/Input.ts` og have deres egen vagt.
- **Enhver skærm afslutter en udvinding** (D53). Det forbliver sådan.
- Ingen ny dependency. GS-TDD: tests først, ejerens "godkendt", så kode.

## 6. Måder at bygge det på

| | Hvad | Hvorfor / hvorfor ikke |
|---|---|---|
| Kun tømning | én tast smider al is ud | Næste `B` henter is igen. Løser ikke problemet. |
| Valg og tømning i HUD'en | markør i CARGO-oversigten, to taster | Lille og virker midt i en udvinding, men giver ingen plads til næste fase. Fravalgt af ejeren. |
| **A: egen skærm til lasten** | last, valg af ressource, udsmidning, liste over anvendelser | **Valgt [ejer].** Skærmen får sin form nu; næste fase lægger linjer til. |
| B: skærm med generel opskriftsmotor | som A, men raffinering og reparation bliver "opskrifter" med egen handling i savet | Vi ville gætte på, hvordan baser og printere virker, og låse gættet i formatet. Fravalgt. |

Valget af A betyder, at formatet skal hæves igen i næste fase, når baser og printere får egen
tilstand. Det er accepteret: gevinsten nu er, at vejen fra format 1 til 2 bliver bygget og prøvet.

## 7. Designet

### 7.1 Skærmen

```
RESOURCES                                    HOLD 6 250 / 8 000 KG

 HOLD                          BEAM      USES
 ▸ ICE        5 000 KG         ◉         REFINE   ICE → PROPELLANT      TANK FULL
   RARE         250 KG                   REPAIR   600 METAL + 400 SIL   ▸ READY
   METAL      1 000 KG
   SILICATE       0 KG

 ↑↓ SELECT   ENTER BEAM TAKES THIS   O JETTISON 250 KG   SHIFT+O ALL   I CLOSE
```

- **Åbnes og lukkes med `I`** fra flyvningen; `Esc` lukker også **[Claude]**.
- **Tiden står stille,** mens skærmen er åben, som på kortet og i værftet. En udvinding, raffinering
  eller reparation i gang afsluttes ved åbning, som ved enhver anden skærm.
- **HOLD** viser altid alle fire ressourcer, også dem med 0 kg, i samme rækkefølge som strålens
  gamle rækkefølge: is, rare, metal, silikat **[Claude]**. (HUD'ens CARGO-oversigt skjuler stadig
  nul-linjer og beholder sin egen rækkefølge.)
- **BEAM** markerer den ressource, strålen tager.
- **USES** er kun til at læse **[Claude]**. Den viser de to ting, lasten kan blive til i dag, med
  pris og samme status som HUD-rækkerne (`▸ READY`, `TANK FULL`, `NEED 600 KG METAL` …). Status
  kommer fra samme kilde som HUD-rækkerne, så de to aldrig siger noget forskelligt.
- **Kan kun åbnes fra flyvning** og ikke i cruise, hop, under nødsignal eller på titelskærmen
  **[Claude]**. Et afvist tryk logger årsagen i samme stil som de øvrige afvisninger.

### 7.2 Strålens valg

- Spilleren vælger én ressource. Valget er **fast** **[ejer, ved ikke at rette forslaget]**: `B`
  tager den valgte ressource og intet andet.
- **Har stenen ikke den valgte ressource,** starter udvindingen ikke. MINE-rækken og loggen siger
  det med en ny, entydig årsag (fx `NO RARE HERE`) **[Claude: ordlyd]**.
- **MINE-rækken i HUD'en viser valget,** også når der ikke mines, så spilleren kan se det uden at
  åbne skærmen (fx `▸ READY · RARE`) **[Claude: udformning]**. Den må ikke blive bredere end den
  længste tekst, rækken kan vise i dag.
- **Standardvalget er is,** så et nyt spil og et opgraderet save opfører sig som før, indtil
  spilleren vælger noget andet.
- **Valget gemmes i savet** (nyt felt i format 2).
- Reglen "én ressource pr. udvinding" (D53 d) er uændret: udvindingen stopper, når den valgte
  ressource er tom, og et nyt `B` tager **samme** valg, ikke den næste i rækken.
- `chooseResource` har allerede en `prefer`-parameter, som ingen bruger. Den gamle rækkefølge skal
  ikke længere kunne vælge for spilleren.

### 7.3 Udsmidning

- **`O` smider 250 kg** af den markerede ressource ud (eller resten, hvis der er mindre);
  **`Shift+O` smider alt** af den ud **[Claude]**. 250 kg er samme størrelse som en bid fra strålen.
  `J` kan ikke bruges: den er hop-tasten, og D14 siger, at én tast ikke må betyde to ting. `O` og
  `I` er de eneste bogstaver, spillet ikke bruger. Pilene og `Enter` bruges allerede på samme måde
  på titelskærmen og konfliktskærmen.
- Virker kun på skærmen, aldrig i flyvningen (anti-mål: ingen udsmidning ved et uheld).
- Er der intet af ressourcen, sker der intet, og linjen siger det.
- **Det udsmidte forsvinder.** Verden ændres ikke; stenen får intet tilbage.
- Hver udsmidning er **én handling i handlingsloggen** med ressource og kilo, så savet kan genspilles
  og en server senere kan validere den.
- **En udsmidning beder om et save** **[Claude]**. I dag beder kun `mine` om et save
  (`src/game/SaveGame.ts:199-201`); raffinering og reparation gør ikke. Der skal derfor en ny
  årsag til i `src/game/saveTriggers.ts` med sin egen regel. Et skift af strålens valg beder ikke
  selv om et save; det kommer med ved det næste.
- Nødsignalets eksisterende "smid hele lasten" (`jettison-all`, `src/ship/emergency.ts:159`) er
  uændret og beholder sit eget navn i loggen.
- En loglinje bekræfter i spillets stil (fx `JETTISONED · 250 KG ICE`) **[Claude: ordlyd]**.

### 7.4 Save-format 2

- `CURRENT_FORMAT` bliver 2. Format 1-skemaet bevares, og `UPGRADES[1]` løfter et format 1-save til
  format 2.
- Nyt i format 2:
  - en ny lasthandling for udsmidning af én ressource (`kind`, `resource`, `kg`);
  - feltet for strålens valgte ressource.
- **Opgraderingen:** et format 1-save får valget "is" og er ellers uændret. Ingen handling i en
  gammel log skal omskrives.
- **Genspilning og komprimering** (`src/save/replay.ts`, `compactEntries`) skal kende den nye
  handling. Checkpointet regner allerede lasten pr. ressource og skal ikke ændres.
- **Format 1 → 2 skal testes:** samme last, tank og verden som før, og valget "is".
- **Et save fra en nyere version skal siges som det, det er** **[Claude]**. I dag giver et for højt
  formatnummer samme besked som et ødelagt save (`SAVE_UNREADABLE_TEXT`, `src/save/bootLoad.ts:45`
  og `:245`); savet lægges på kopi-hylden, og et nyt spil starter. Den opførsel beholdes, men
  beskeden for et højere formatnummer bliver sin egen (fx `SAVE IS FROM A NEWER VERSION — KEPT, NOT
  LOADED`), og en test låser, at kopien på hylden er urørt. Det hjælper ikke gamle builds, som ikke
  kan ændres; det hjælper næste formatskift.
- `src/save/schemaDrift.test.ts` og fixtures i `src/save/fixtures/` skal følge med.
- `src/save/bootLoad.ts:122` læser `jettison-all` for at skrive nødsignalets lognote ("hold
  jettisoned"). Den nye handling må **ikke** tælles dér, ellers bliver en frivillig udsmidning
  meldt som nødsignalets.
- **Server og klient udrulles sammen.** Det er ikke et problem i dag, hvor der ikke er nogen
  udrulning, men det skal stå i DECISIONS.

### 7.5 Hvor man slår det op

- Pausearket får én ny linje for `I` (resource-skærmen). Det ændrer en godkendt assertion
  (`src/ui/pauseState.test.ts:566`, 23 linjer → 24), som forelægges ejeren før ændringen.
- README'ens Controls får `I` og tasterne på skærmen.
- En lektion er ikke med i denne delplan **[Claude]**: skærmens egen fodlinje viser tasterne.

### 7.6 Plads til næste fase

- USES-listen bygges af en lille tabel over anvendelser (navn, pris, status). Næste fase lægger
  rækker til og gør dem valgbare. Tabellen er **ikke** en opskriftsmotor: den udfører intet.
- Skærmen er delt i "hvad jeg har" og "hvad det kan blive til". Baser og printere får senere egne
  afsnit eller faner; det afgøres, når de designes.

## 8. Overladt til den, der bygger

- Hvordan skærmen passer ind i tilstandsmaskinen (`src/core/Modes.ts`): egen tilstand som `map` og
  `yard`, eller et overlay som pausearket. Kravene er: tiden står stille, flyvningens taster virker
  ikke, og en udvinding afsluttes ved åbning.
- Den præcise ordlyd på nye log- og rækketekster, inden for stilen i `src/game/miningRules.ts`.
- Markering, farver og typografi, inden for HUD'ens eksisterende noir-stil.
- Navnet på den nye handling og det nye felt i savet.
- Review-shots af skærmen ved 1280 × 700 og ved fuld last.

## 9. Kendte følger

- **At skifte ressource midt i en udvinding koster fire tryk:** `I`, vælg, `I`, `B`.
- **Et fast valg kan forvirre første gang:** står valget på rare ved en sten uden rare, sker der
  intet ved `B`. Rækken skal derfor sige præcis hvorfor.
- **Formatskiftet er den dyreste del** af delplanen og den med størst risiko.
- **Handlingsloggen vokser lidt:** én post pr. udsmidning (kendt gæld, D51 d).

## 10. Afgjort af ejeren

- Egen skærm til ressourcehåndtering, fordi næste fase skal bruge ressourcer til at udvikle.
- Valg A: skærm til lasten nu, ingen generel opskriftsmotor.
- Næste fases retning: von Neumann-sonde, opbygning af ressourcer, udvikling af skibet, baser,
  3D-printere.
