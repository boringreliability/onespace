# oneSpace v4, delplan 5: mining man kan se

> Design til godkendelse. Bygger på delplan 2 (asteroider og mining) og ændrer dens regler for
> udvinding. Mærkerne **[ejer]** og **[Claude]** viser, hvem der har truffet et valg.

## 1. Hvorfor

Ejeren prøvede selv at mine og raffinere og kunne hverken huske tasterne eller se, om noget var i
gang **[ejer]**. Koden bekræfter det:

- Mining varer 4 s spiltid og raffinering 8 s. Det eneste, spilleren ser, er en loglinje bagefter.
  Der er ingen bjælke, ingen lyd og ingen stråle. `Mining.busy` findes, men intet læser den.
- Mining har fire krav (asteroide som mål, ≤ 0,5 km fra overfladen, ≤ 0,005 km/s i forhold til
  stenen, plads i lasten). Farten vises (HUD'ens VEL måles mod feltet, og alle sten har feltets
  fart), men grænsen på 0,005 km/s står ingen steder, og intet fortæller, hvilken tast der løser
  det.
- Raffinering (U), reparation (N), formationshold (K) og nødtasterne (H, 1/2/3) står hverken i
  Pause-arket eller i lektionerne. `L` flyver hen til en sten, men Pause-arket siger kun
  "LAND · TO ORBIT".
- Spillet husker, hvor meget der er taget af hver sten, men intet viser det.

## 2. Mål

- **M1 [ejer]:** Man kan altid se, hvilke handlinger skibet har, hvilken tast de sidder på, og
  hvorfor en handling ikke er mulig lige nu.
- **M2 [ejer]:** Man kan se, at mining og raffinering er i gang, og hvor langt de er.
- **M3 [ejer]:** Mining er en oplevelse: en synlig stråle, og den må gerne tage tid.
- **M4 [ejer]:** Sliddet på stenen er synligt, og en tom sten ødelægges.
- **M5 [ejer]:** Tasterne kan slås op et sted i spillet.

## 3. Ikke-mål

- Droner, der miner for spilleren, og al progression. De kommer i en senere iteration **[ejer]**.
  Se §7 for, hvad dette design gør klar til dem.
- Nye ressourcer, handel, eller ændret omregning ved raffinering.
- Et minispil eller en færdighedsprøve under mining.
- En egentlig tutorial. Lektionerne (NAV ADVISORY) udvides kun.

## 4. Anti-mål

- **Grind.** Mining må ikke være at holde en tast nede eller at vente uden at kunne gøre andet
  (DESIGN §2). Derfor: ét tryk starter, tidskompression virker under mining, og man kan stoppe når
  som helst.
- **Tab ved afbrydelse.** En lang handling, der giver nul ved afbrydelse, straffer hårdere, jo
  længere den varer.
- **Skjulte krav.** Ingen handling må afvises med en grund, spilleren ikke kan aflæse og rette.
- **To sandheder.** Sliddet på en sten må ikke være en ny, selvstændig tilstand, der kan komme ud
  af trit med, hvad der er udvundet.

## 5. Rammer

- PLAN.md's globale krav gælder: TypeScript strict, GS-TDD (tests først, ejerens "godkendt"),
  v2's performance-budget målt på GPU før og efter, multiplayer-principperne P1–P5.
- **Save-formatet v1 ændres ikke.** En udvinding gemmes som i dag:
  `{ kind: 'mine', asteroidId, resource, kg }`.
- Tværgående review-fokus 1 (PLAN.md): lukkes fanen midt i en handling, er handlingen enten sket
  helt eller slet ikke. Det skal stadig gælde for hver gemt post.
- HUD'en er DOM og CSS, bygget én gang; pr. frame skrives kun tekst og CSS-variabler. Rav er
  skibets systemer, cyan er navigationsmålet.
- Stenene tegnes instanced i otte draw calls. Det tal må ikke vokse med antallet af sten.

## 6. Måder at bygge det på

| | Måde | Pris | Valg |
|---|---|---|---|
| A | **Løbende udvinding.** Ét tryk starter strålen; materialet strømmer ind, til man stopper, lasten er fuld, stenen er tom, eller kravene brydes. Det udvundne beholdes. | Reglerne fra delplan 2 skrives om, og godkendte tests ændres. | **Valgt [ejer]** |
| B | Længere fast handling (ca. 20 s), alt eller intet, med stråle og bjælke. | Næsten ingen regelændring, men afbrydelse giver nul. | Fravalgt: rammer anti-målet om tab. |
| C | Hold tasten nede. | — | Fravalgt: rammer anti-målet om grind. |

## 7. Designet

### 7.1 Løbende udvinding

- **Start:** `B` med de samme krav som i dag (mål er en asteroide, ≤ 0,5 km fra overfladen,
  relativ fart ≤ 0,005 km/s, ≥ 0,5 kg plads, ≥ 0,5 kg tilbage i stenen).
- **Forløb:** udvindingen kører i spiltid med **150 kg/s [Claude]**. 2 000 kg tager ca. 13 s, en
  fuld last på 8 000 kg ca. 53 s. Tidskompression virker som på alt andet.
- **Bidder:** materialet lægges i lasten i hele bidder på **250 kg [Claude]** (den sidste bid kan
  være mindre). Hver bid er én almindelig `mine`-post: den trækker fra stenen, lægger i lasten og
  gemmes som i dag. HUD'ens tal tæller jævnt op mellem bidderne. Lukkes fanen, er alle færdige
  bidder gemt, og den ufærdige er ikke sket.
- **Flere bidder pr. frame.** Ved 100× tidskompression kan én frame dække flere bidder. Kravene
  tjekkes én gang pr. frame, og alle bidder, tiden rækker til, lægges i lasten i samme frame.
- **Ressourcer:** rækkefølgen er som i dag (is, sjælden, metal, silikat). **Åbent spørgsmål til
  ejeren:** hvad der sker, når den ressource, der udvindes, slipper op (se §10).
- **Lektionen `B — MINE`** tæller udvindinger, ikke bidder, så den ikke forsvinder efter et halvt
  sekund.
- **Stop:** `B` igen, fuld last, tom sten, eller et brudt krav (ude af rækkevidde, for høj relativ
  fart, nyt mål, pause, cruise, hop, nødsignal, forladt flyvetilstand). I alle tilfælde beholdes
  det, der er lagt i lasten.
- **Beskeder:** én loglinje, når udvindingen slutter, med summen pr. ressource og årsagen, når den
  ikke er spillerens eget stop:
  - `MINED · 1 250 KG ICE`
  - `MINED · 2 000 KG ICE · 500 KG METAL — HOLD FULL`
  - `MINING STOPPED — OUT OF RANGE · 750 KG ICE`
  Sluttede den uden en eneste bid: `MINING STOPPED — <årsag>`.
- Tømmer den sidste bid stenen, er årsagen `DEPLETED`, ikke et afbrud: stenen forsvinder som mål i
  samme øjeblik (§7.5), og det må ikke læses som "målet blev skiftet".
- `U` og `N` under en udvinding svarer `BUSY` som i dag.

### 7.2 Raffinering og reparation

Reglerne er uændrede: faste handlinger på 8 s og 10 s, alt eller intet, ét tryk. De får samme
fremdriftsvisning som mining (§7.3) og en lyd (§7.6). At de forbliver alt eller intet er bevidst:
de er korte, og en halv raffinering ville kræve en ny post i save-formatet.

### 7.3 Handlingsblokken i HUD'en

En fast blok i venstre panel under CARGO **[Claude]**, synlig i flyvetilstand, også når lasten er
tom:

```
 MINE     B   ▸ READY
 REFINE   U   · NO ICE
 REPAIR   N   · TANK UNDAMAGED
```

- Hver række viser navn, tast og tilstand.
- **Klar:** `▸ READY` i lys rav.
- **Ikke mulig:** årsagen i dæmpet rav. Årsagerne er de samme tekster som afvisningerne i loggen
  (`NO ASTEROID TARGETED`, `OUT OF RANGE`, `MATCH SPEED`, `HOLD FULL`, `DEPLETED`, `NO ICE`,
  `TANK FULL`, `NEED 600 KG METAL · 400 KG SILICATE`, `TANK UNDAMAGED`, `NO TANK`, `BUSY`).
- **Vejen videre står på rækken**, når en tast kan løse det:
  - `OUT OF RANGE — L TO APPROACH`
  - `MATCH SPEED — SPACE TO STOP` (mellemrum bremser; `K` er en til/fra-tast og ville slippe et
    hold, man allerede har)
- **Cruise og hop skelnes fra "optaget":** rækkerne viser `IN CRUISE` eller `IN JUMP` i stedet for
  `BUSY`, som kun bruges, når en anden handling kører.
- **I gang:**
  ```
   MINE     B   ▓▓▓▓▓▓▓░░░░  ICE 1 240 KG
   REFINE   U   ▓▓▓▓░░░░░░░  5 S
  ```
  Minings bjælke viser lastens fyldning; tallet er det, denne udvinding har givet, og tæller jævnt.
  Raffinering og reparation viser andel af tiden og sekunder tilbage.
- Rækken for mining viser kun `NO ASTEROID TARGETED`, når intet er valgt; blokken fylder altid
  tre linjer, så den ikke hopper.

**Farten og grænsen.** Den samlede fart i forhold til stenen (i dag en privat værdi i `Mining`)
gøres tilgængelig, og HUD'ens VEL skifter tone, når en asteroide er valgt, og farten er under
grænsen for mining. Dermed kan `MATCH SPEED` aflæses og rettes.

**Plads.** Venstre panel er centreret lodret, og loggen sidder i bunden. Blokken må ikke overlappe
loggen ned til en vindueshøjde på 700 px; lange årsager forkortes om nødvendigt
(`NEED METAL · SILICATE`). Det kontrolleres med et skærmbillede.

### 7.4 Strålen

- En stråle fra skibets næse til det punkt på stenens overflade, der ligger nærmest skibet.
- Den tændes, når udvindingen starter, og slukkes, når den stopper, med en kort ind- og udtoning.
- Ved nedslaget: en glød og løsrevne småsten, der driver væk fra overfladen.
- Farven er varm hvid-rav **[Claude]**, så den hører til skibets systemer og ikke forveksles med
  navigationsmålets cyan.
- Strålen følger HDR-scenens regler (lineær, ikke tonemappet for sig) og må ikke koste mere end
  et fast, lille antal draw calls, uanset hvor mange strålerne bliver.

### 7.5 Slid og ødelæggelse

- **Sliddet afledes, det gemmes ikke.** Slid = udvundet masse / stenens oprindelige masse, læst
  fra den verdens-tilstand, der allerede gemmes og synkroniseres. Efter genindlæsning og på en
  anden enhed ser stenen derfor ens ud (P2, P4).
- **Udseende:** stenen får mørke, udhulede ar, hvis antal og størrelse vokser med sliddet. Arrenes
  placering kommer af stenens seed, så to spillere ser de samme ar. Tallet sendes som én ekstra
  værdi pr. sten til den eksisterende shader; antallet af draw calls er uændret.
- **Synligt fra første bid.** Sammenhængen mellem slid og udseende er ikke lineær: også 2 000 kg
  af en sten på 65 000 kg skal kunne ses.
- **Tom sten:** når alle fire ressourcer er under 0,5 kg, bryder stenen op i stykker, der driver
  fra hinanden og toner ud. Derefter findes den ikke længere: den tegnes ikke, kan ikke vælges som
  mål, tæller ikke i "nærmeste isrige sten", og autopiloten kan ikke flyve til den. Også det
  afledes af verdens-tilstanden, så stenen er væk efter genindlæsning.
- Var den tomme sten spillerens mål, ryddes målet, og en eventuel formationsholdning slippes med
  den loglinje, der allerede findes ved målskift.
- **Ét sted filtrerer.** Tomme sten sorteres fra i `Belt`, så målvalg, autopilot, formationshold,
  scanner og mining følger med uden egne regler. Er et helt felt tomt, findes der ingen "nærmeste
  sten" ved ankomst.
- **Opbruddet er en overgang, ikke en tilstand.** Selve animationen udløses af en hændelse i det
  øjeblik, stenen tømmes. En sten, der var tom ved indlæsning, er bare væk.
- Logbogens gamle scanninger af en ødelagt sten bliver stående som historik.

### 7.6 Lyd

En lav, vedvarende tone, mens strålen er tændt; en kort lyd ved hver bid; en dybere lyd, når en
sten bryder op; og en vedvarende, anderledes tone under raffinering og reparation. Alt laves i
den eksisterende, syntetiserede lyd (ingen lydfiler). Lyden skal alene kunne svare på "er den i
gang?".

### 7.7 Hvor man slår tasterne op

- **Pause-arket** får de manglende linjer: `B` mine, `U` raffinér, `N` reparér, `K` formationshold,
  `H` nødudgang med `1`/`2`/`3`. `L` beskrives som "AUTOPILOT — LAND · TO ORBIT · APPROACH TARGET".
- **Lektionerne (NAV ADVISORY)** får to nye, efter samme mønster som `B — MINE`:
  - `L — APPROACH`, når en asteroide er valgt og er uden for rækkevidde.
  - `U — REFINE`, når der er is i lasten og plads i tanken.
- **README'ens Controls** bringes i trit med spillet (mining, raffinering, reparation, nødudgang),
  og de forældede linjer om `L` og "no inventory" rettes.

### 7.8 Klar til droner

En udvinding beskrives som en **operation** med en kilde (en position i verden), en sten og en
tilstand. Strålen, sliddet og gløden tegnes ud fra listen af operationer, ikke ud fra spillerens
skib. I denne delplan har listen højst ét element, og kilden er altid skibets næse. Handlings-
blokken viser spillerens egen operation. Droner, deres styring og deres visning bygges ikke.

## 8. Overladt til den, der bygger

- Arrenes præcise udseende i shaderen og kurven mellem slid og udseende.
- Strålens og småstenenes teknik (geometri, antal partikler) inden for budgettet.
- Lydenes præcise klang.
- Den nøjagtige placering og typografi i handlingsblokken, inden for HUD'ens eksisterende stil.
- Opdelingen i tasks.

## 9. Kendte følger

- **D14 og DESIGN §5.5 ændres for mining.** D14 siger, at en afbrudt handling ikke må give halv
  gevinst, og §5.5, at udvinding tager kort tid. Begge erstattes for mining af dette design og får
  en ny post i DECISIONS. For raffinering og reparation gælder D14 uændret.
- Godkendte tests fra delplan 2 for udvinding (varighed, "afbrudt giver intet", én post pr.
  mining) ændres. Planen lister dem, og ejeren godkender ændringerne.
- Et felt kan nu mines helt tomt. Nødudgangen (delplan 1) er fortsat vejen ud for en spiller uden
  brændstof.
- Flere poster i handlingsloggen: hver bid giver to poster (last og sten), så en fuld last giver
  op til 64 poster mod 8 i dag. Loggen komprimeres ved 5 000 poster, og autosave og sync er
  allerede begrænset i takt, men serverens `actions`-tabel vokser hurtigere (kendt gæld, D51 d).
- **Tidskompression under mining skal måles.** Kompression slås fra, når hovedmotoren arbejder.
  Bruger farthold ved stenen hovedmotoren, virker "10× under mining" ikke; så skal det meldes og
  afgøres, før strålen bygges.
- **Uden tidskompression** (multiplayer, P5) tager en fuld last 53 s. Tempoet er en konstant og
  kan justeres.

## 10. Åbent spørgsmål til ejeren

**Hvad sker der, når isen i stenen slipper op?** Lasten kan kun tømmes helt (der findes ingen
måde at smide én ressource ud), så en udvinding, der fortsætter fra is til metal og silikat uden
nyt tryk, kan fylde lasten med noget, spilleren ikke ville have.

- **Stop ved skift [Claude anbefaler]:** udvindingen stopper, når den aktuelle ressource er tom,
  og siger `MINED · 1 250 KG ICE — ICE DEPLETED`. Et nyt tryk på `B` fortsætter med den næste.
- **Fortsæt:** udvindingen tager det næste uden nyt tryk, til lasten er fuld eller stenen tom.
