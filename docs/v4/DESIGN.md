# oneSpace v4: fundamentet under et spil

*Design 2026-11-08, aftalt med ejeren i chatten. Bygger på grenen `v3` (PR #2, endnu ikke merget).
Markeringer: **[ejer]** = ejeren har besluttet det. **[Claude]** = min beslutning, som ejeren kan
underkende. Alt andet ligger åbent for bygherren.*

## 1. Hensigt

oneSpace skal bevæge sig fra flyvesimulator mod et spil.

- **Inspiration [ejer]:** No Man's Sky.
- **Retning [ejer]:** en egen fortælling om en selvreplikerende **von Neumann-sonde**, der starter alene
  og fattig. Den udforsker, udvinder ressourcer og bygger på sigt kopier af sig selv, så spilleren
  vokser til et netværk. Det skal være vores egen fiktion og vores egne navne, ikke en genskabelse
  af Bobiverse eller No Man's Sky.
- **Fremtidige lag [ejer]:** handel, risici, faktioner og fjender, exploration og senere biosfærer
  på planeter.

**Først skal grundtingene være stabile [ejer].** Derfor er v4 det fundament, som alle senere lag
bygger på:

1. spillet kan gemmes og indlæses i skyen
2. andre kan logge ind
3. det første rigtige gameplay-loop: et brændstofbudget og simpel mining af asteroider

**Succeskriterium [ejer]:** *"Når jeg kan logge ind, mine en asteroide og tanke op."* Udvidet med de
krav, der følger af det: spillet huskes til næste session, og den tankede mængde er der stadig efter
genindlæsning.

## 2. Mål, ikke-mål og anti-mål

**Mål**
- **G1 Konti:** andre kan oprette sig, logge ind og have deres eget gemte spil **[ejer]**.
- **G2 Gemt spil:** gemt i skyen og indlæst ved næste session. Formatet er versioneret, så det kan
  vokse uden at ødelægge gamle saves.
- **G3 Brændstof:** et budget, der gør hvert valg om at tage ud til en beslutning **[ejer]**.
- **G4 Asteroider og mining:** flyvbare asteroider i systemernes bælter. Man scanner, udvinder og får
  ressourcer, herunder brændstof **[ejer]**.
- **G5 Nødudgang:** løber man tør, er der en vej ud, men den koster noget **[ejer]**.
- **G6 Railway-klar:** frontend og backend kan udrulles på Railway, men selve udrulningen er et
  separat skridt **[ejer]**.

**Ikke-mål (designes der plads til, men bygges ikke):** handel, faktioner og fjender, replikation af
sonder, biosfærer og multiplayer.

**Anti-mål (er v4 fejlet, hvis dette sker, selv om alt teknisk virker):**
- **Tabt fremdrift:** en netværksfejl, en lukket fane eller et deploy må aldrig koste spilleren
  fremdrift.
- **Gratis nødudgang:** genindlæsning må ikke kunne omgå prisen for nødudgangen eller nulstille
  forbruget.
- **Tankmas:** brændstoffet må ikke blive en konstant påmindelse. Kort, almindelig flyvning omkring
  en planet skal ikke føles som kassebogføring.
- **Grind:** mining må ikke blive minutter med at holde en tast nede uden beslutninger.
- **Ødelagt flyvning:** v3's flyveoplevelse (kamera, styring, landing) og v2's performance-budget må
  ikke gå tilbage.
- **Multiplayer låst ude:** en beslutning, der gør multiplayer umulig uden en omskrivning (se §4).

## 3. Nuværende tilstand (kort)

- **Frontend:** ren frontend uden server. Three.js r180, TypeScript strict, Vite 6 og Vitest. Ét
  npm-projekt i roden.
- **Det eneste, der gemmes:** indstillinger og logbogen (`src/game/Log.ts`) i `localStorage`.
  Position, system og skib nulstilles ved genindlæsning.
- **Galaksen:** deterministisk ud fra seed (`src/gen/galaxy.ts`, `src/gen/system.ts`).
  `SystemSpec.hasAsteroidBelt` findes som flag, men bælterne har ingen geometri og ingen asteroider.
- **Brændstof:** skibs-blueprints har `fuelMassKg` og tankkapacitet (`src/gen/ships/types.ts`). Det
  bruges ikke af flyvemodellen (`src/ship/FlightModel.ts`), hvor thrust er gratis.
- **Byggesten, der kan genbruges:**
  - `Targeting`
  - formation-assist / FA-hold mod et mål (`src/ship/formation.ts`)
  - `RecoveryCut` og `recoverToOrbit` (`src/game/recovery.ts`)
  - autopilot
  - HUD-tapes
  - Pause-menu
  - title screen

## 4. Bindende principper: multiplayer må ikke låses ude [ejer → konkretiseret af Claude]

- **P1 Ét fælles univers.** Hvert save hører til et `universeId` (seed + version). Flere spillere kan
  senere dele samme univers.
- **P2 Spiller-tilstand og verdens-tilstand adskilles.**
  - Spiller-tilstand er skib, last, position og logbog.
  - Verdens-tilstand er fx hvilke asteroider der er udvundet og hvor meget.
  - De gemmes hver for sig. Verdens-tilstand nøgles på `universeId` + et stabilt objekt-id (fx
    `asteroidId`) og registrerer, hvilken spiller der ændrede den.
  - I v4 er verdens-tilstand privat pr. spiller, men skemaet skal kunne deles uden migrering af
    nøglerne.
- **P3 Ændringer er handlinger, som serveren *kan* validere.**
  - Ressource-ændringer (udvinding, raffinering, nødudgang) sendes som navngivne handlinger med
    parametre, ikke kun som en ny totaltilstand.
  - I v4 må serveren stole på klienten, men API'et og formatet skal tillade, at serveren senere
    validerer og bliver autoritativ. Det samme fundament forhindrer snyd i handel senere.
- **P5 Universets ur [ejer: mellemvejen].**
  - I v4 har hver spiller sit eget sim-ur (`orbitTime`). Time compression, pausen på kortet og
    autopilotens 10× forbliver uændret.
  - Saves gemmer urets værdi og **vægtiden** ved hvert gem, og verdens-tilstand tidsstemples med
    begge. Så kan et fælles ur indføres senere uden at miste data.
  - **Kendt pris, som ejeren har accepteret:** multiplayer vil kræve, at time compression fjernes
    eller begrænses, fx kun når ingen andre spillere er i nærheden.
  - **Krav til den fremtidige multiplayer-version [ejer]:** der skal findes en måde at lande på, som
    ikke tager for lang tid uden time compression. Det er ikke en del af v4, men intet i v4 må
    gøre landing længere.
- **P4 Globale id'er.** Spillere, saves og objekter, spilleren skaber, får globalt unikke id'er
  (UUID). Procedurale objekter får deterministiske id'er ud fra seed og indeks, så to klienter er
  enige om, at "asteroide X" er den samme.

## 5. Det, der skal bygges

### 5.1 Backend og konti

- **Teknologi [Claude]:**
  - et lille Node/TypeScript-API i samme repo (fx `server/`)
  - Postgres
  - delte typer og **Zod**-skemaer i et fælles modul, som både klient og server importerer, så
    save-formatet kun defineres ét sted
- **Framework:** valg af framework og ORM/query-lag er op til bygherren.
- **Login [Claude]:**
  - Ingen passwords. OAuth med GitHub og Google, og sessionen i en HTTP-only, Secure,
    SameSite-cookie.
  - Magic link på e-mail er udskudt, fordi det kræver en mail-tjeneste.
- **Gæst [Claude]:**
  - Man kan spille uden login med lokalt save.
  - Logger man ind, kan det lokale save adopteres til kontoen én gang (ikke flettes med et
    eksisterende sky-save; spørg spilleren, hvilket der skal beholdes).
- **Sikkerhed:**
  - whitelist-validering af alt input med Zod
  - størrelsesgrænse på saves
  - rate limiting på skrivninger
  - ingen hemmeligheder i frontend-bundlen
  - CORS kun til spillets egen origin

### 5.2 Gemt spil

- **Indhold (version 1):**
  - format-version og `universeId`
  - spillerens position: system, forælder-legeme, banetilstand eller landet koordinat på overfladen,
    og hvorvidt man er i cruise (cruise gemmes som "dropped ud ved nærmeste stabile punkt")
  - skibets tilstand: brændstof, tank-kapacitet inkl. permanente tab, skader og last
  - logbogen (de nuværende `localStorage`-opdagelser migreres ind én gang)
  - verdens-tilstand efter P2
- **Migrering:** hver formatversion har en eksplicit migrering fra forrige version. Den testes med
  gemte "golden" saves, ligesom golden-skibstesten.
- **Hvornår der gemmes:**
  - **Automatisk:** efter landing, efter en udvinding, efter brug af nødudgangen, hvert ~2. minut og
    når fanen skjules eller lukkes.
  - **Manuelt:** fra Pause-menuen.
- **Indlæsning:** title screen får "Continue". Et nyt spil starter som i dag.
- **Offline først:**
  - Saves skrives altid lokalt først (IndexedDB) og synkroniseres derefter til skyen.
  - Sync bruger optimistisk samtidighed med et revisionsnummer. Afviser serveren en forældet
    revision, bevares begge versioner, og spilleren vælger. Intet overskrives stille.
- **Snapshot plus handlingslog [Claude]:** serveren gemmer to ting.
  - **(a) Et snapshot:** position, logbog og skibets øjeblikkelige tilstand.
  - **(b) En append-only handlingslog (P3)** for alle ressource-kritiske handlinger: udvinding,
    raffinering, brændstofforbrug pr. segment, kannibalisering, nødsignal og reparation.
  - **Konflikter:** spillerens valg ved en konflikt (og ved adoption af et gæste-save) gælder kun
    snapshottet. Handlinger, der allerede står i loggen, gælder uanset valget. Et valgt snapshot
    genberegnes, så det ikke kan have mere brændstof, last eller kapacitet, end loggen tillader.
  - **Konsekvens:** to faner eller to enheder kan altså ikke bruges til at gøre en nødudgang gratis.
- **Nødudgangen kan ikke omgås:** dens brug skrives til det lokale save, før effekten vises.

### 5.3 Brændstof

- **Hvad koster [ejer: budget på fremdrift; Claude: hvad det omfatter]:**
  - Al thrust trækker på tanken: hovedmotor, RCS, boost, FA-ON's farthold og stop, og autopilot.
  - Cruise koster ved spool-up og pr. tilbagelagt afstand.
  - Et hop mellem systemer koster en stor, kendt portion.
- **Model:** Tsiolkovsky-agtigt forbrug (thrust/Isp). Skibets masse inkl. brændstof og last påvirker
  accelerationen let, så en fuld last mærkes. Den præcise model er bygherrens valg inden for målene
  nedenfor.
- **Tuning-mål [Claude]:**
  - En fuld tank rækker til flere landinger og opstigninger på hjemplaneten **og** ét hop til et
    nabosystem og tilbage igen.
  - Almindelig manøvrering i bane mærkes knap.
  - Det er landinger, opstigninger, cruise og hop, der tæller.
- **HUD:**
  - en brændstof-tape med tydelige advarselsniveauer
  - et Δv-estimat
  - før hop og før auto-land: en vurdering af, om brændstoffet rækker
  - autopiloten og galaksekortets JUMP EST advarer og afviser, hvis det tydeligvis ikke rækker
- **Tom tank:** motorerne dør. Kun nødudgangen virker.
- **Sonden [Claude]:**
  - Spilleren flyver stadig v3's skib (`DEFAULT_SHIP_CONFIG`), så styring og håndtering er uændret.
  - Skibet får nye tal for tank, lastrum og tørmasse, som ikke er taget fra en Yard-blueprint.
  - Massen påvirker accelerationen kun let: under ~10 % forskel mellem tom og fuld, så v3-følelsen
    bevares.
  - At skifte skrog i Yard hører til "flyv dette skib", som ligger efter v4.
- **Start [Claude]:**
  - Et nyt spil starter med tanken ~60 % fuld i et hjemsystem, der **har** et bælte, som kan nås uden
    hop på startbrændstoffet.
  - Har det nuværende startsystem ikke et bælte, vælges et andet startsystem fra seed-surveyen med et
    tilsvarende åbningsbillede (planet i billedet, trafik, lys). Dette skal ejeren se og godkende i
    browseren.

### 5.4 Nødudgang [ejer: skal findes og koste; Claude: hvordan]

1. **Kannibalisering:**
   - Sonden omdanner last eller dele af sig selv til en lille portion reaktionsmasse, nok til at nå
     nærmeste asteroide eller en sikker bane.
   - Det giver et permanent tab, fx lavere tank-kapacitet eller en skadet komponent, som senere
     repareres med ressourcer.
   - Det kan gentages, men hver gang bliver det dyrere.
2. **Nødsignal (sidste udvej):**
   - Ingen dele eller last tilbage.
   - Sonden bliver bjærget med eksisterende `RecoveryCut`/`recoverToOrbit` til nærmeste sikre bane
     med minimal tank.
   - Prisen er tab af hele lasten og en markering i logbogen.

Begge veje er spillerens bevidste valg via en tydelig prompt, aldrig automatiske.

### 5.5 Asteroider og mining

- **Generering:**
  - Systemer med `hasAsteroidBelt` får et bælte ud fra systemets seed: radius-bånd, tykkelse og
    tæthed.
  - Asteroider genereres deterministisk pr. sektor af bæltet, nær spilleren, med stabile id'er
    (P4).
  - Hver asteroide har form, størrelse og sammensætning ud fra sit seed.
  - Et bælte skal kunne nås og bruges uden at skulle findes ved et tilfælde: galaksekort og
    systemvisning viser bæltet, og man kan sætte kurs mod det.
- **Rendering:** instanced og LOD inden for v2's performance-budget. Tæt på er asteroiden en rigtig
  form, man kan flyve rundt om.
- **Fysik:** asteroiderne kredser i bæltet. Deres tyngde er ubetydelig. Spilleren matcher fart med
  formation-assist mod målet.
- **Scanning:** man vælger en asteroide (Targeting) og scanner den. Det afslører sammensætning og
  mængde og skrives i logbogen.
- **Udvinding:**
  - Inden for en rækkevidde og under en relativ fart.
  - Udvinding tager kort tid og er en handling, ikke at holde en tast nede i minutter.
  - Man får ressourcer i lasten, begrænset af kapaciteten.
  - Asteroiden tømmes gradvist (verdens-tilstand, P2).
- **Ressourcer, første sæt [Claude]:**
  - vandis, som raffineres til brændstof
  - metal (jern/nikkel)
  - silikater
  - én sjælden ressource

  De tre sidste har ingen funktion i v4 ud over reparation af kannibaliseringsskader. De er
  designet, så handel og replikation senere kan bruge dem.
- **Reparation er med i v4 [Claude]:**
  - Én handling, "reparér", der bruger metal og silikater til at genvinde tabt tank-kapacitet.
  - Ingen komponent- og skademodel ud over "tabt kapacitet i procent".
  - Den sjældne ressource har ingen brug endnu.
- **Tank op:** is raffineres til brændstof ombord med en enkelt handling, der tager lidt tid og har
  en omregningsfaktor. Det er succeskriteriets "tanke op".

### 5.6 Railway

- **Forberedt:**
  - Frontend og API kan bygges og køres som Railway-tjenester.
  - Postgres som Railway-plugin.
  - Al konfiguration via miljøvariabler.
  - En health-endpoint.
  - Database-migreringer, der køres ved deploy.
- **Ikke forberedt:** selve udrulningen og domænet er et senere skridt, når ejeren beder om det.
- **Én origin [Claude]:**
  - Frontend og API serveres fra samme origin: én Railway-tjeneste, hvor API'et også serverer den
    byggede frontend.
  - Det gør det muligt at bruge en SameSite=Lax-cookie og simple OAuth-redirects. Det undgår også,
    at `*.up.railway.app` ligger på Public Suffix List, hvilket ellers gør to tjenester til to
    forskellige sites.
  - Et eget domæne ændrer ikke på det.

## 6. Proces og kvalitet (som v2/v3)

- **GS-TDD:** BDD-tests skrives først og godkendes, før der implementeres.
- **Review og mutation:** adversarial review og mutation testing pr. fase.
- **Browser:** før/efter-måling på GPU.
- **Beslutningslog:** `docs/v4/DECISIONS.md`.
- **Backend-tests:** mod en rigtig Postgres (bygherrens valg af hvordan).
- **End-to-end:** en Playwright-test af succeskriteriet. Log ind (testkonto), flyv til et bælte, min
  is, raffinér, se tanken stige, genindlæs og se den stadig være fyldt.
- **Udenfor processen:** v3's PR #2 skal merges af ejeren. v4 bygges på grenen `v4` fra `v3`.

## 7. Overladt til bygherren

- server-framework, ORM og migreringsværktøj
- OAuth-bibliotek
- IndexedDB-indpakning
- den præcise brændstofmodel og tal inden for tuning-målene
- bæltets og asteroidernes udseende
- rækkefølgen af faser, så længe hver fase kan spilles og testes for sig
