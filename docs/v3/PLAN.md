# oneSpace v3: oplevelsen af at flyve

*Plan 2026-11-07, bygger på tre audits af `main` @ 13cdfc3 (v2), alle målt i Chromium på GPU
med rådata i `~/.claude/jobs/9463fd62/tmp/v3/`. Tema: **flyvningen skal føles rigtig**.
Ny gameplay venter til v4.*

## 1. Diagnosen

### Ejerens "skibet hopper frem og tilbage og nulstilles" er bevist

Hoppet skyldes fem mekanismer, som forstærker hinanden.

**1. Tidstab ved lange frames.** Det er den primære årsag, og den forklarer de største hop.

- *Kilde:* governoren skifter opløsning og reallokerer render targets. Det giver frames på 56-67 ms (8 af 8 trin under auto-land) (`Engine.ts` ~323).
- *Mekanisme:* FlightModel capper sin accumulator ved 8 × 1/120 s = 66,7 ms. Engine clamper dt til netop 1/15 s. Ved dt ≳ 58 ms smides op til 8,3 ms skibstid væk, mens verden og kamera går fuldt frem (`FlightModel.ts` 793-797, `Engine.ts` 220).
- *Effekt:* chase-kameraet differentierer positioner (`CameraRig.ts` 813-842), så tidstabet ligner et hastighedsstød på op til ~4 km/s. Lag-fjederen rammer sit 45 m-loft.
- *Målt:* skibet popper 230-1.400 px ved hver af de 7 hitches under en realtids-landing. Ved 50 ms sker intet, ved 66,7 ms er der altid et hop.

**2. Cruise-drop.** Snap-tærsklen er 50 km/frame (`CameraRig.ts:700`), så den afhænger af framerate. Lag-loftet er symmetrisk. Kameraet kastes 11 m fra skroget, og skibet er ude af billedet i 0,83 s.

**3. Orbit-indsættelse.** Både attitude-teleport og hastighedsretning skifter 30° på ét frame (`Cruise.ts:276`, `cruiseOrbit.ts`). Skibet springer frem og tilbage og falder først til ro efter ~1,3 s.

**4. Liftoff fra landing.** Blendet fra landet kamera til chase drejer kameraet med 512°/s og passerer 7 m fra skroget.

**5. Attitude-flips under auto-land.** Aim-fjederen kører på 0,44 Hz, så skibet er ude af billedet i 430 frames.

**Afkræftet ved måling:** FA-ON-chatter, floating-origin-rebases, substep-hak, FOV-ånding (står stille på 77,7°) og autopilotens feed-forward-rysten.

### Det andet, der gør flyvningen dårligere

| # | Fund | Evidens |
|---|---|---|
| S1 | **Musen æder sig selv.** Konstant recentrering fjerner små udslag (0,25 er væk efter 2 s), så præcisionssigte er umuligt. Musen når aldrig tasternes rate | `stick.ts:46` |
| S2 | **Næsen stopper blødt.** Den glider 8,8° (mus), 14,2° (taster) og 21,7° (roll) efter slip, og raten er først under 1°/s efter 1,2-1,5 s | `FlightModel.ts` 1058 (ren eksponentiel τ 0,35) |
| S3 | **Chase-aim lagger ~33° i fulde drej.** Skibet ryger 45 % af skærmhøjden op | `CameraRig.ts:267` |
| B1 | **Bug:** på det frame, hvor cruise kobler ind, går farten 5 → 0 → 15,8 km/s | `CruiseDrive.ts` 308-310 |
| F1 | **FOV-ånding følger absolut fart**, så den står i loftet i kredsløb. Det giver 110-124° vandret og en ægformet planet. Under landing zoomer den 78 → 62°. Åbningsbilledet lever af den for brede FOV | `CameraRig.ts` 359-371 |
| A1 | **Auto-land tager 157-501 s uden agency**, og time compression er spærret. 71 g boost, 39 km/s dyk, fem næsesving på 90-180° og 73 s på 30 m/s til sidst | `autopilot.ts`, `timeCompression.ts:109` |
| A2 | **Autopilotens boost-trin** giver ~1.040 g/s jerk. Den skifter thrust↔hover 4 gange tæt på jorden | `autopilot.ts:436` |
| A3 | **FA-ON:** aktuatoren går 0 → 20 g på 1/120 s, og farten overskrides med +20 % efter et 55°-drej | `FlightModel.ts` 950 |
| V1 | **Intet i billedet ændrer sig med fart.** Ingen partikler eller støv, stjernerne står stille, og 0,78c ser ud som coast | — |
| V2 | **Trafikskibet ses aldrig.** Det ligger lige over billedkanten. Skibene er orienteret efter verdensakserne, motorerne er slukket (`throttle: 0`), og ground-ref motion blur smører dem | `Traffic.ts:131` |
| V3 | **Lyden er tavs** ved cruise spool/engage/drop, RCS, touchdown, crash og passage af skibe | `Audio.ts` 546-622 |
| V4 | **Ankomstbillederne er tomme:** ~12 s stjerner efter warp, og planeten forsvinder efter et cruise-drop | — |
| H1 | **HUD'en:** pitch-ladder og G-tal ligger over skroget. Fart-tapen snapper ved dekadeskift. THR 100 % står ved siden af "FA · COAST" i cruise. Verdenslåste markører dæmpes i skærmrum, så de svømmer | `Hud.ts` |

## 2. Faser

### Fase A: Ro på billedet (tid og kamera). Fjerner ejerens hop.

1. **Ingen tabt tid.** Invariant: `Engine max-dt ≤ MAX_SUBSTEPS·FIXED_H` (`substepBudget`, testet).
2. **Robust ankerhastighed.** Analytisk ankerhastighed (parent + flight + ω×offset) og Δv-limiter, hvor overskud behandles som teleport (`limitAnchorVelocity`).
3. **Lag fra filtreret proper acceleration.** τ 0,15 s med tanh-mætning L ≈ 12-20 m. Ingen snap-tærskel i km/frame. Cruise får eget stift kamera med blendet reseat (`chaseLagOffset`).
4. **Governor-hysterese.** Mindst 2 s mellem trin, op-trin tidligst efter 5 s, intet op-trin under autopilot eller cruise (`governorShouldStep`).
5. **Cruise-engage-bug:** cap > 0 på overgangs-framet.
6. **Indsættelsen flyves.** Under drop styres næse og hastighed mod indsættelses-tangenten. Kun en rest under 2° slerpes.
7. **Kameraovergange:**
   - Liftoff-blend i sfæriske koordinater over 1,5 s.
   - Landed reveal med skibet i billedet.
   - Frame-constraint, der holder skibet inden for 60 % af halv-FOV (`constrainAimToFrame`).
   - Aim-fjeder 0,7 Hz med rate-feed-forward.
8. **HUD og shake.** HUD-markører dæmpes i world space. Shake-oktaver under 25 Hz og kun fra thrust. Motion blur-tærskler uafhængige af framerate.

### Fase B: Styringen

- **Stick:** ingen konstant recentrering, eventuelt auto-centre efter 1 s idle. Deadzone 2,5 % og kurve `0,35x + 0,65x³`.
- **Taster:** akserne rampes op på 0,15 s og ned på 0,08 s.
- **Rate-command rotation** (når attitudeHold er tændt):

  | | Pitch | Yaw | Roll |
  |---|---|---|---|
  | Maks rate | 35°/s | 28°/s | 75°/s |
  | α_max | 2,5 rad/s² | 2,5 rad/s² | 4 rad/s² |

  τ_up 0,22 s og τ_down 0,10 s. Mål: højst 4° glid efter slip og under 1°/s inden for 0,35 s. Gains i `cruiseSteer` og autopilotens styring udledes igen.
- **FA-ON:**
  - Aktuator-lag τa 0,15 s, så ζ ≈ 0,9 og der ikke er overshoot.
  - Main slukkes ved |v| > 1,02·vset.
  - Stop med afrundet √ i stedet for en lang hale.

### Fase C: FOV og framing

- `fovPolicy({aspect, thrustFrac, cruiseSpool, mode})`: hfov 88° ved 16:9, Hor+ op til 100° og derefter Vert-. Cockpit maks 100°.
- **Ånding:** +4° ud fra thrust og +10° under cruise-spool. **Aldrig fra absolut fart.**
- **Ny chase-framing**, så åbningsbilledet stadig viser planeten ved smallere FOV: aim-pitch-bias -6 til -8° og skibet i nederste tredjedel.

### Fase D: Autopilotens tempo og glathed

- `Autopilot.step` kører pr. sim-slice. Auto-10× over 20 km AGL uden for tæt luft, 1× derunder.
- `FINAL_ALTITUDE` sænkes fra 2 til 0,6 km. Målt: −42-47 s, og touchdown er stadig 0,1 m/s.
- Afrundet √ på begge felter.
- HOVER låses under 20 km.
- Boost-ramp over 0,5 s, også for pilotens Shift.
- Attitude-slew maks 25°/s under flips.
- L under cruise sættes i kø og engager, når cruise er idle.
- **Mål:** Remit-landing højst ~60 s væg-tid, tyk atmosfære højst 90 s, højst ét mode-skift under 20 km, jerk højst 150 g/s.

### Fase E: Fart og skala

1. **Orbitalt støv:** ~2-3k instanced streaks i en wrap-kube på 400 m i det lokale cirkulære banesystem. Coast i bane er næsten stille, mens en brænding får støvet til at strømme ∝ Δv. Belyst kun mod stjernen, slukket i cruise og warp. Ét draw call, ~0,1-0,2 ms.
2. **Cruise drive field:** stjerne-aberration ∝ log(cap/c) og en svag kant-sheen. Det er warp-vokabularet ved ~5 %.
3. **Trafik:**
   - skibene orienteres langs deres bane
   - tændt drev med motorflamme og vindueslys
   - de undtages fra ground-ref blur
   - kontakt 0 placeres i åbningsbilledet ~15° over næsen og 1,5-2,5 km væk
4. **Skala gennem bevægelse:** store skrog drejer langsomt med RCS-pust, og projektører fejer over skroget.
5. **Lyd:**
   - cruise spool, engage og drop
   - RCS-hvæs
   - touchdown-dunk og crash
   - nærhedssummen fra skibe
   - knirken i skroget under g (cockpit)
6. **Ankomstbilleder:** stjerne eller primær i billedet efter warp, og VEL viser noget meningsfuldt.

### Fase F: HUD under flyvning

- Pitch-ladder fades til 25 % i ro, og G-tallet flyttes væk fra skroget.
- Svage brackets på kontakter inden for 50 km.
- Fart-tapen bliver log/banded uden snap.
- I cruise vises `CRUISE · ×c / ETA` i stedet for THR 100 %.
- ALT-etiketten bliver konsistent.

### Fase G: "SEE IN FLIGHT" (flyv-dette-skib, S)

- Yard-knappen `?mode=flight&ship=<link>` spawner præcis det skrog som co-orbitalt nabo-skib, 1,5-2,5 km væk og i billedet, oriented, powered og med motorflamme.
- Valgfri "formation"-assist: FA-hold i forhold til målets hastighed.
- Dit eget 30 m-skib er målestokken. Flyvemodellen ændres ikke.

## 3. Proces

Som v2:
- Ejeren træffer beslutningerne i §4.
- Derefter autonom kørsel: spor i worktrees, tests først (GS-TDD) og godkendelse, adversarial review og manuel mutation testing pr. fase, browser-måling på GPU før og efter, og beslutningslog i `docs/v3/DECISIONS.md`.

**Acceptance-målinger** (gentages med auditternes harness):
- Med injicerede hitches på 66 ms: skibets skærm-hop under 5 px.
- Cruise-drop og indsættelse: skibet inden for NDC ±0,8 hvert frame, og Δ i retning højst 3° pr. frame.
- Liftoff: kameraafstand mindst 30 m og drejehastighed højst 90°/s.
- Glid efter slip højst 4°.
- Auto-land på Remit højst ~60 s væg-tid.
- Performance-budgettet fra v2 holder.

## 4. Beslutninger der kræver ejeren

Se spørgsmålene i chatten. Svarene registreres som D0 i `docs/v3/DECISIONS.md`.
