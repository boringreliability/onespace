# oneSpace: playability-audit

*Audit af `main` @ 6bb512d, 2026-11-06. Playtest i Chromium (`--use-angle=metal`)
mod en dev-server. Pointer lock virker ikke headless, så musen er målt ved at
skrive `pointerDX` ind i `Input` frame for frame. Det er den samme vej, en rigtig mus går.*

## Kort fortalt

Det visuelle, instrumentsproget, codex'en og kortene er gode. Spillet er
uspilleligt af fem målbare grunde, som forstærker hinanden:

1. Musen kan reelt ikke styre. Et skærmbredt swipe (2000 px) drejer næsen 2,6°.
2. Man kan ikke se destinationerne. Andre planeter tegnes ikke, og der er ingen målmarkør.
3. Cruise afvises ved spawn med "ATMOSPHERE". Skibet er 4.344 km oppe, mens atmosfæren er 187 km tyk.
4. Cruise-ankomst ender i et nedslag eller en forbiflyvning, fordi drevet slipper ved 60 km/s, og det kan ikke bremses.
5. Halvdelen af de dokumenterede taster er døde. `V` springer desuden to af fire kameraer over.

---

## A. Blockers (rangeret)

### B1. Musestyringen virker ikke (S)

- `Input.ts:68` sætter `mouseSensitivity = 0.0022`. I `Input.ts:165-168` bliver én frames pixel-delta til en akse, og deltaet nulstilles bagefter.
- Aksen er et *drejningsmoment* (`FlightModel.stepRotation`, α ≈ 2 rad/s²). Assist dæmper det med τ = 0,35 s.
- Den samlede drejning er cirka P·0,0022·α·dt·τ ≈ P·2,6e-5 rad ved 60 fps.

Målt drejning af næsen efter 1 s jævn bevægelse:

| Input | Drejning |
|---|---|
| 600 px mus | 0,78° |
| 2000 px mus | 2,61° |
| 6000 px mus | 7,84° |
| `ArrowLeft` holdt i 1 s | 35,6° |

- Effekten afhænger af framerate, fordi `dt` indgår. Ved 144 Hz er musen 2,4× svagere.
- Et 90°-sving kræver omkring 35 skærmbredder.
- README kalder musen den primære styring. Piletasterne er den eneste brugbare styring, og de står ikke i README.

**Fix: musen som virtuel joystick.**
- Akkumulér delta i en udslagsvektor, clampet til en radius på ~300 px, med deadzone og langsom recentrering.
- Akse = udslag/radius, og den holdes så længe udslaget står.
- Vis udslaget som en amber prik på HUD'en.
- Sensitivity og invert-Y gemmes i `localStorage`.

### B2. Destinationerne er usynlige, og der er ingen målmarkør (M)

- `Universe.ts:641` giver ingen renderer til planeter, der er mere end 60 radier væk. Kommentaren nævner en "point-light impostor", men den findes kun for stjernen.
- Ved spawn har kun 2 af 13 legemer en renderer: spawn-planeten og dens måne.
- `Hud.setTarget()` (`Hud.ts:527`) er færdigbygget med bracket, afstand, lead-pip og kant-clamp (`Hud.ts:690`). Den kaldes kun fra review-shots (`Hud.ts:1315`, `1335`).
- `SystemMap.select()` udsender `target:changed` (`SystemMap.ts:365`). HUD'en bruger kun eventet til at rydde markøren (`Hud.ts:839-843`).
- `Tab` (`cycleTarget`) har ingen modtager.
- Drejer man væk fra spawn-planeten, ser man kun stjerner og pitch-stigen.
- Cruise flyver derhen, hvor næsen peger, men man kan ikke pege på noget, man ikke kan se. `docs/CRUISE.md` nævner det selv under "Known gaps".

**Fix:**
1. Et `Targeting`-modul projicerer `body.world` og kalder `hud.setTarget`. (S)
2. `Tab` skifter mål sorteret efter vinkel fra næsen, og et valg på kortet sætter samme mål. (S)
3. Ikke-renderede planeter tegnes som point-sprites på 1-2 px i dæmpet amber. (M)
4. ETA og lukkehastighed vises under bracketen.

### B3. Atmosfærens hale bliver aldrig 0, så cruise nægtes ved spawn (S, én linje)

- `Universe.ts:857-859` beregner `density = exp(-alt/H)·pressure`. Den er større end 0, indtil float64 underflower ved omkring 745·H.
- `CruiseDrive.ts:170` blokerer med `if (atmosphericDensity > 0) return 'atmosphere'`.
- Eksempel fra spawn-verdenen Remit 31: H = 14,6 km, og atmosfæren er 187 km tyk.
  - Ved spawn er skibet 4.344 km oppe, og density er 9,5e-130.
  - Resultatet er `CRUISE DENIED — ATMOSPHERE`.
  - Cruise kan først aktiveres over ~10.900 km, hvilket kræver ~4 min radial brænding.
- Ved Vhessvaem (H = 72 km) ligger grænsen på ~54.000 km.

**Fix:** blokér på `alt > atmosphere.thickness` eller `density > 1e-6`, og tilføj en test med realistisk hale i `cruise.test.ts`.

### B4. Cruise slipper ved 60 km/s, og det kan ikke bremses (M)

**Tallene:**
- `exitSpeedKmS: 60` langs næsen (`CruiseDrive.ts:73`). Drop sker ved 3.000 km clearance, så der er 50 s til overfladen.
- Bremsen giver 1,6e7 N / 2e5 kg = 0,08 km/s². At bremse 60→0 tager 750 s og 22.500 km.
- Flip-and-burn på hovedmotoren (0,2 km/s²) tager 300 s og 9.000 km.
- Der er ingen revers: throttle går fra 0 til 1, og `strafeZ` er altid 0 (`Input.ts:184`).
- Til sammenligning er cirkulær banehastighed 2-7 km/s.

**Playtest "dive":**
- W holdt fra spawn med næsen mod planeten.
- Efter 200 s er skibet 519 km oppe og flyver 37,9 km/s. Det er 316× over crash-grænsen på 120 m/s.

**Playtest "brake":**
- Space holdt fra 3.314 km og 35,6 km/s.
- Hastigheden *steg* til 41 km/s, og skibet ramte jorden efter ~85 s.
- Årsagen er, at throttle bliver stående på 100 %, når W slippes, så bremsen kæmper mod motoren uden at sige det.

**Fix: orbit insertion ved drop.**
- Drevet blender ind i cirkulær banehastighed i målets frame. `flight.orbitalVelocityAt(pos)` findes allerede og projiceres på tangentplanet.
- Drop sker ved ~3 radier i stedet for en fast afstand.
- Det er den samme bevidste snyd, som CRUISE.md allerede accepterer. Den er bare flyttet.

### B5. Døde og dobbeltfyrende taster (S)

- `J` (warp): død. Kun `Cruise.ts:68` læser den, og kun for at annullere cruise. Et hop kræver M, så hjulet ud, så klik, så Enter.
- `L` (land): død.
- `Tab`: ingen modtager.
- `Esc`: slipper kun pointer lock. Der er ingen pause og ingen menu.
- `F2` (screenshot): død.
- `V` fyrer i både `Pilot.ts:155` og `CameraRig.ts:590` (`handleToggleKey` sættes aldrig til false).
  - Den målte rækkefølge er chase → orbit → chase → orbit, så cockpit og cinematic kan ikke nås.
  - Orbit viser skibet mod sort rum.
- `G` (cruise) og `C` (codex) virker, men står ikke i README.

**Fix:** `rig.handleToggleKey = false`, og bind `J`, `L`, `Tab` og `Esc` (pause-overlay). Ret README.

### B6. Ingen onboarding (S)

- Efter boot står der kun `ALL SYSTEMS NOMINAL · CONTACTS — 1 VESSEL`. Der er intet "klik for at flyve", ingen tasthints og intet hjælpe-overlay.
- Alle kort slipper pointer lock (`SystemMap.ts:217`, `MapMode.ts:231`) uden at sige, at man skal klikke igen.
- Logbeskeder lever 8 s (`Hud.ts:283`) i ~9 px tekst. Det er den eneste kanal, der fortæller hvorfor noget blev afvist.

---

## B. Friktion

- **F1.** Der er ingen prograde-/velocity-markør. Flyvningen er newtonsk, men man kan ikke se, hvor skibet driver hen. (S)
- **F2.** Der er ingen vertikal hastighed og ingen time-to-impact. Landing kræver under 40 m/s vertikalt, men VEL viser kun total fart. På jorden viste ALT −13,8 km, fordi højden måles mod kuglen og ikke mod terrænet. (S)
- **F3.** Scanneren låser på et skib 3,3 km væk (`VESSEL_PRIORITY_KM = 400` i `Scanner.ts`), så spawn-planeten kan ikke scannes. Fix: scan det valgte mål, eller verdenen som default. (S)
- **F4.** Der er ingen revers og ingen speed hold. Assist dæmper kun rotation. Der er ingen tast til FA, selvom setteren findes (`FlightModel.ts:501`). Throttle bliver stående på 100 %. (M)
- **F5.** ETA'erne passer ikke. Galaksekortet viser "JUMP EST" 22 s + 41 s/ly, men et warp tager faktisk 7,4 s. Systemkortets ETA mangler udflyvningsbenet. (S)
- **F6.** Et nedslag har ingen konsekvens og er den bedste bremse. Velocity sættes til 0 og `grounded` til true (`FlightModel.ts:926-931`), og "HULL BREACH" logges to gange. Fix: fade til sort, "RECOVERED TO ORBIT" og en log-post. (S)
- **F7.** Stjernen har ingen kollision, så man kan flyve gennem fotosfæren. (S)
- **F8.** Ved spawn peger næsen lige mod planetens centrum (`Universe.ts:397`), så første tryk på W er et dyk. (S)
- **F9.** HUD-titlen viser "REMIT 31 / FYSS I" (månen), selvom man er ved planeten "Fyss". (S)
- **F10.** Der er ingen hurtig vej til throttle 0. Hjulet flytter 8 % pr. klik, og `S` tager 1,1 s. Foreslået: `X` sætter throttle til 0. (S)
- **F11.** VEL og ALT kan handle om forskellige legemer, og ALT forsvinder over 40 R. Skriv legemets navn ved ALT. (S)

---

## C. Playability-lag

Princippet er, at hjælpere må *flyve* fysikken for spilleren, men aldrig lyve
om den. Alt går gennem `FlightModel.command`. Der er to undtagelser: cruise-exit,
som allerede er legitimeret, og respawn, som er et cut.

- **P1. Målvalg og approach.** Et `targetId` sættes med `Tab` eller ved klik på kortet. Det giver HUD-bracket, ETA, lukkehastighed og cruise-status.
- **P2. Flight assist med to niveauer (`Z`).**
  - FA-ON (default) svarer til Elite: throttle betyder ønsket fremadfart.
  - FA-OFF er den nuværende newtonske model.
  - Retro-autoriteten skal op.
- **P3. Supercruise til mål.** En P-regulator styrer næsen, og musen tager over med det samme. Drop sker i cirkulær bane ved ~3 R. Et hop på 0,1 AU tager ~45 s.
- **P4. Auto-land og auto-orbit (`L`).**
  - Deorbit, retrograde-hold og suicide burn, så skibet er under 30 m/s de sidste 2 km.
  - Fra jorden: løft og cirkularisér til 1,6 R.
- **P5. Sikker respawn** efter et crash, ved kollision med stjernen og via Esc → "Return to orbit".
- **P6. Time compression** kun på jorden og i stabil bane (1×/10×/100×). Lav prioritet.
- **P7. Kontekst-hint-linje ("NAV ADVISORY").** Den forsvinder efter 2-3 brug.
- **P8. Presets:** Survey, Pilot og Newtonian.

Fravalgt med vilje: brændstof og varme, kamp og quest-waypoints. Ingen af dem løser en blocker.

---

## D. Rækkefølge

1. B3 + B5 (`V`-fix) + README (~1 time)
2. B1 virtuel joystick
3. B2.1-2 mål, bracket og `Tab`
4. F1 prograde, F2 VSI/impact og F3 scan-mål
5. B4/P3 orbit insertion og NAV-hold
6. P7 hints, P5 respawn og F8 spawn-orientering
7. P2 FA-ON og P4 auto-land
8. Planet-impostors, ærlige ETA'er og tid på jorden
