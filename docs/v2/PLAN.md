# oneSpace v2 — fra smukt til spilbart

*Samlet plan, 2026-11-06, baseret på tre uafhængige audits af `main` @ `6bb512d`.*

| Bilag | Indhold |
|---|---|
| [GAMEPLAY.md](GAMEPLAY.md) | Playability-audit (game designer, playtest via Playwright) |
| [PERFORMANCE.md](PERFORMANCE.md) | Perf-audit, målt på M4 Pro med ægte GPU (ANGLE/Metal) |
| [SHOWROOM.md](SHOWROOM.md) | Showroom, modes og indholdsbrowser |

---

## 1. Diagnosen i én side

Spillet er **uspilleligt af målbare grunde**, ikke af smag. Flere af dem
forstærker hinanden:

| # | Problem | Bevis | Effort |
|---|---|---|---|
| G1 | **Musen kan ikke styre.** Et skærmbredt swipe drejer næsen 2,6°; et 90°-sving kræver ~35 skærmbredder. Pixel-delta pr. frame bliver tolket som drejningsmoment, som assist så dæmper væk. Musen virker derfor dårligere jo højere framerate. | `Input.ts:165-168`, `FlightModel.stepRotation` | S |
| G2 | **Mål er usynlige.** Kun 2 af 13 legemer har en renderer ved spawn, og der er ingen målmarkør. `Hud.setTarget()` er færdigbygget, men kaldes kun fra review-shots. `Tab` har ingen modtager. | `Universe.ts:641`, `Hud.ts:527/1315` | M |
| G3 | **Cruise nægtes ved spawn ("ATMOSPHERE").** `density > 0` på en eksponentiel, der aldrig bliver 0. Cruise virker først over ~10.900 km. | `CruiseDrive.ts:170`, `Universe.ts:858` | S |
| G4 | **Cruise slipper ved 60 km/s, og det kan ikke bremses.** Retro-bremsen giver 0,08 km/s², så det tager 750 s og 22.500 km at stoppe. Resultatet er nedslag eller forbiflyvning hver gang. | `CruiseDrive.ts:73` | M |
| G5 | **Halvdelen af tasterne er døde.** `J`, `L`, `Tab`, `Esc` og `F2` gør intet. `V` fyrer to gange, så cockpit- og cinematic-kameraet kan aldrig nås. | `Pilot.ts:155` + `CameraRig.ts:590` | S |
| G6 | **Ingen onboarding.** Intet "klik for at flyve", ingen tasthints, og afvisninger vises kun som 9 px log-tekst i 8 s. | `Hud.ts:283` | S |
| P1 | **Terrain beregnes forfra pr. vertex hver frame.** 5 fulde fbm-evalueringer med 11-13 oktaver pr. vertex, ~3,7 M evalueringer pr. frame. Uden pixelomkostning går framen fra 191 til 25,6 ms, når terrain skjules. | `Planet.ts:252,274` | S→M |
| P2 | **Fuld retina, 5,8-7,7 Mpx.** `maxPixelRatio: 2` på high. DPR 2→1 sparer 40 %. | `Config.ts:84` | S |
| P3 | **Adaptiv opløsning er blind.** Den måler CPU-tid omkring `step()` (1-3 ms), aldrig GPU, og står derfor fast på 1.0. Når den reagerer, reallokerer den alle render targets. | `Engine.ts:202`, `PostFX.ts:1514` | S |
| P4 | **Hitches.** Lazy shader-compile giver 140-740 ms pr. ny scene og 2,8 s ved kold cache. Synkron skibsgenerering giver ~600 ms kort efter boot. Ingen `compileAsync` nogen steder. | `Universe.ts:653`, `Traffic.ts:151` | S/M |
| A1 | **Spillet har ingen modes.** 7 moduler tjekker et globalt `shotOwnsScene()`-flag, og alle 17 moduler kører hver frame. Showroom kan kun nås via `__osSetShot`. | `Shots.ts:82`, `Engine.ts:193` | M |

**Målte frame-tider (prod, M4 Pro, DPR 2):** opening 112 ms, planet-approach
211-264 ms, atmosphere-sunset 165 ms. Draw calls ligger på 34-195 og er
altså ikke problemet. Problemet er hvor meget hver vertex og hver pixel koster.

**Om "den har det svært på dev-server":** under kørsel er dev = prod
(112,9 mod 112,2 ms). Det dev-specifikke er, at **hver gemning er en fuld
reload**, fordi der ikke er HMR. Det betyder ny boot, ~600 ms skibsgenerering og
ny shader-compile, og ved ændret shader-tekst en freeze på 2,8 s. Dertil
kommer fuld retina i en rigtig Chrome, ofte med DevTools åbne. GPU-problemet
gør ondt overalt, men dev-loopet føles værre.

---

## 2. Faser

Rækkefølgen er valgt sådan, at hver fase gør spillet mærkbart bedre for
sig selv, og at det billigste med størst effekt kommer først.

### Fase 0: Quick wins (≈1-2 dage, ingen arkitekturændring)

| Fix | Gevinst |
|---|---|
| G3: cruise-blokering ved `alt > atmosphere.thickness` (eller `density > 1e-6`) plus test med realistisk hale | Cruise virker fra spawn |
| G5: `rig.handleToggleKey = false`. README får `G`, `C` og piletaster | Alle 4 kameraer kan nås |
| P2: DPR-cap, high 1,0-1,25 og ultra 1,5 | −40-60 % på fill-bundne scener |
| P1a: `patchResolution` 65 → 33 på high | 4× færre terrain-vertices, −20-25 % |
| P3: adaptiv opløsning på wall-clock (rAF-delta) med hysterese | Holder 60 fps-målet selv |
| P4a: `compileAsync`-prewarm bag boot-skærmen, streaming-hysterese (opret ved 60 R, frigiv ved 75 R), højst ét trafik-skib pr. frame | Hitches væk |
| Dev: `?tier=` / `?dpr=` i URL, gem seed og kamera i `sessionStorage` ved reload, `shoot.mjs` → `--use-angle=metal` | Dev-loopet føles hurtigt |

**Forventet:** fra 5-15 fps til et sted omkring 30-60 fps i de fleste scener.
Det skal måles igen efter fasen, ikke antages.

### Fase 1: Spilbar flyvning (≈1-1,5 uge)

1. **Virtuel stick-mus (G1).** Musen flytter en udslagsprik (radius ~300 px,
   deadzone, langsom recentrering). Aksen er udslag/radius, holdt konstant.
   Den er vist som en amber prik på HUD'en. Sensitivity og invert-Y gemmes i `localStorage`.
2. **Mål og approach (G2).** Ét `targetId`, som sættes med `Tab` (sorteret efter
   vinkel fra næsen) eller ved klik på kortet. HUD-bracket med afstand, ETA,
   lukkehastighed og cruise-status. Ikke-renderede planeter vises som 1-2 px
   amber point-sprites.
3. **Ankomst (G4).** Cruise-drop blender ind i *cirkulær banehastighed*
   (`flight.orbitalVelocityAt`, findes allerede) ved ~3 R i stedet for
   næse·60 km/s ved 3.000 km. Supercruise til et låst mål styrer næsen selv,
   og musen tager over med det samme.
4. **Instrumenter.** Prograde/retrograde-markør, VSI og time-to-impact, legemets
   navn ved ALT og ALT målt mod terrænet. Scanneren tager det valgte mål og ellers
   verdenen, ikke nærmeste skib.
5. **Taster (G5).** `J` hop, `L` auto-land/lift, `Tab` mål, `X` throttle 0,
   `Esc` pause-overlay med kontroller, settings og "Return to orbit".
6. **Sikkerhedsnet.** Crash eller kollision med stjernen fader til sort og viser
   "RECOVERED TO ORBIT" med en log-post. Spawn sker med næsen prograde, ikke
   mod planetens centrum.
7. **Hint-linje (G6).** Én "NAV ADVISORY"-linje med den næste handling.
   Den forsvinder efter 2-3 brug og erstatter en tutorial.

**Designprincip:** hjælpere må *flyve* fysikken for spilleren, men aldrig lyve
om den. Alt går gennem `FlightModel.command`. Autopiloten er skibets
computer. Det bevarer noir-realismen.

### Fase 2: Modes, The Yard og Photo (≈2-3 uger)

1. **Mode-maskine (A1).** `src/core/Modes.ts` (ren TS) med `title | flight |
   map | yard | photo | review`, en tabel over tilladte overgange og `push/pop` for
   photo-overlay. `GameModule.activeIn?: Mode[]`. Engine-løkken trækkes ud
   i en ren `tickModules()`, så den kan testes uden WebGL. Migreringen
   er blød: `shotOwnsScene()` og `Universe.paused` bliver getters på modes.
2. **URL-routing.** `src/core/Route.ts` med whitelist-validering:
   `?mode=yard&ship=5a17c0de&faction=kessler&role=freighter&size=medium&gen=1`,
   `?seed=`, `?shot=`, `?dev`. Det gør også dev-iteration langt hurtigere.
3. **Versionsvagt.** Golden-test af `generateShip` for faste parametre
   mod `SHIP_GENERATION_VERSION`. Det er en forudsætning for at kunne dele skibe via link.
4. **Titelskærm.** Den vokser ud af `#boot`-sløret, med opening-billedet i langsom
   drift bagved. Valg: UNDOCK, THE YARD, SETTINGS (quality) og seed-felt
   (reload med `?seed=`).
5. **The Yard.** Skibsværft og register inde i fiktionen. Valg af fraktion, rolle,
   størrelse og seed, hvor kun lovlige kombinationer kan vælges. Orbit- og zoom-kamera, lys- og drive-presets,
   skalafigur, silhuet og spec-ark fra `shipScanLines`. "Kopiér link", sammenligning
   (multi-ship-layout findes allerede) og baggrund "void" eller "anchorage".
   `Showroom.ts` deles ved sine naturlige grænser uden logikændringer, og de 22
   review-frames PNG-diffes før og efter.
6. **FlightSnapshot.** Kamera, rig-mode, HUD, exposure, pointer lock og `fixedDt`
   gemmes, når man forlader flight, og gendannes. Universe behøver ikke gemmes,
   fordi det ikke kører, mens det er inaktivt.
7. **Photo mode** (`P`). Pause, frit kamera, skjult HUD, FOV, exposure,
   grain og CA, og PNG via `canvas.toBlob` lige efter render.
8. **Dev-overlay** (`?dev`, backtick). fps, wall-ms, governor-scale,
   calls, tris, programs, tier-vælger, shot-vælger og "ticking 9/17".

### Fase 3: Dyb performance (≈2 uger, kan køre parallelt med fase 2)

| Fix | Gevinst |
|---|---|
| Bag højde og normal pr. patch til en tekstur (samme `terrainGlsl()`). Skygge-march og ocean sampler teksturen | −40-80 % på planet-frames |
| Sky-backdrop bagt til cubemap én gang pr. system | −7 % altid |
| Skibsgenerering i Web Worker (`generateShip` er ren og bruger ikke three) | ~600 ms hitch væk |
| Faste render targets med skaleret viewport | Ingen reallokerings-hitches |
| Reversed-Z i stedet for log-depth (three r180 + `EXT_clip_control`) | Early-Z tilbage. Effekten er umålt, så den skal måles først |
| `PerfGovernor`: render-scale, så raymarch-steps, så LOD-dybde | Selvjusterende |
| Perf-regressionstest: Playwright + Metal på fast sekvens, fejler ved +10 % | Holder det hurtigt |

### Fase 4: Assists og komfort (v2.1)

- **Flight assist FA-ON/FA-OFF** (`Z`). Med FA-ON betyder throttle ønsket fremadfart,
  og computeren holder velocity = næse·v_set. FA-OFF er den nuværende newtonske
  model. Retro-autoriteten skal op.
- **Auto-land og auto-orbit** (`L`). Deorbit, retrograde-hold, suicide burn og
  under 30 m/s de sidste 2 km.
- **Time compression** kun på jorden eller i stabil bane (1×/10×/100×).
- **Presets:** Survey, Pilot og Newtonian.

### Senere (v3)

- **Body viewer** (planeter, stjerner og ringe isoleret). Gallery skal først
  generaliseres fra én krop til N.
- **Univers-browser** uden reload.
- **"Flyv dette skib":** kræver ændring af BRIEF §2, og at kamera, cockpit,
  kollision og LOD virker for skibe fra 8 m til 6 km.

---

## 3. De første 10 minutter i v2

- **0:00:** Titel → UNDOCK. Spawn i bane med næsen prograde. Hint: *KLIK FOR AT TAGE STYRINGEN.*
- **0:10:** Musen drejer 30-40°/s, og stick-prikken er synlig.
- **0:45:** `T` scanner verdenen, og loggen viser "LOGGED". Første belønning kommer inden for ét minut.
- **1:30:** `M`, klik på næste planet ("cruise 0:45"), `Enter`. Bracket ved skærmkanten.
- **2:40:** `G` aktiverer cruise med NAV-hold. ETA tæller ned, og prikken vokser til en skive.
- **3:30:** Automatisk drop i stabil bane. Det er spillets money shot, og nu er det garanteret.
- **4:30:** `L` lander. "TOUCHDOWN — CLEAN · 1,8 M/S". Går det galt: "RECOVERED TO ORBIT".
- **8:00:** `M`, vælg system, `J` hop (ærlig ETA på 7 s), ankomst i bane.
- **10:00:** Spilleren har hele *travel, look, scan, log* uden at have læst README.

---

## 4. Beslutninger der kræver ejeren

1. **FA-ON som default?** Elite-modellen er hvor throttle betyder fart, og
   newtonsk flyvning er et valg. Anbefaling: ja.
2. **Det ucommittede MAP-Elites-arbejde** (`applyEvolvedHeroSculpt`) forskyder
   RNG-strømmen. Alle seeds giver andre skibe end i dag, også HERO_SHIP og
   trafik, og `SHIP_GENERATION_VERSION` står stadig på 1. Anbefaling: bump til 2,
   og indfør golden-testen før det merges.
3. **"Flyv dette skib" udskydes til v3?** Anbefaling: ja. Yard er "registry only" i v2.
4. **Rækkefølge:** fase 0 og 1 først (spilbarhed), derefter fase 2 og 3 parallelt.

---

## 5. Proces

Projektet følger GS-TDD: BDD-tests (Given-When-Then) skrives først og
godkendes, før der implementeres. Første PR'er i den rækkefølge:

1. **Fase 0** med tests for cruise-tærskel, `V`-dobbeltfyring, wall-clock-governor
   (ren funktion) og streaming-hysterese.
2. **Fase 1, punkt 1-3**, med tests for stick-akkumulator (ren), mål-cyklus
   og orbit-insertion-drop (`cruiseFlight.test.ts`-mønster).
3. **Fase 2, punkt 1-3** (Modes, Route, tickModules og golden-test). Ingen synlig
   ændring, men det gør alt det efterfølgende billigt.

Den fulde testliste for modes, routing, katalog og snapshot står i
[SHOWROOM.md §4](SHOWROOM.md).
