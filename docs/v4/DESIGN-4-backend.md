# v4 delplan 4 — Backend og sky: design

> Uddyber `docs/v4/DESIGN.md` §5.1, §5.2 (offline først) og §5.6 for delplan 4. Hvor dette dokument
> og DESIGN.md er uenige, gælder dette dokument, og afvigelsen står i § 9.
> Markeringer: **[ejer]** = ejerens beslutning i samtalen 2026-11-14/15, **[Claude]** = mit valg,
> som ejeren kan rette.

## 1. Hensigt

Andre end ejeren skal kunne spille oneSpace med deres eget spil i skyen, og ejeren skal kunne
skifte maskine uden at miste noget. I første omgang logger kun ejeren og en håndfuld inviterede
testere ind **[ejer]**. Gæster spiller som i dag med lokalt save.

Delplan 3 byggede det lokale fundament (save-format v1, IndexedDB, WAL, `revision`, `saveId`,
handlingslog med `replay`). Delplan 4 lægger skyen ovenpå uden at gøre det lokale save mindre
pålideligt.

## 2. Mål, ikke-mål og anti-mål

**Mål**
- **B1 Login med Discord** — og kun Discord til at starte med **[ejer]**.
- **B2 Kun inviterede:** adgang kræver en bestemt rolle på ejerens Discord-server **[ejer]**.
- **B3 Sky-save:** et logget ind spil synkroniseres til serveren og hentes ved næste opstart, også
  på en anden maskine.
- **B4 Konflikter vælges, aldrig stille:** har to enheder spillet videre fra samme punkt, vælger
  spilleren på en skærm med to kort **[ejer]**.
- **B5 Gæst → konto:** et lokalt gæste-save adopteres ved første login.
- **B6 Slet min konto** **[Claude]**.
- **B7 Railway-klar:** én tjeneste, der serverer både den byggede frontend og API'et; Postgres;
  migreringer ved deploy; health-endpoint; al konfiguration i miljøvariabler.

**Ikke-mål**
- GitHub/Google-login, magic link, e-mail (kan tilføjes senere uden omskrivning).
- Selve udrulningen på Railway og et eget domæne.
- En skærm til at gendanne kopier fra kopi-hylden (stadig kendt gæld, D38).
- Server-autoritativ validering af hver handling (P3 tillader at stole på klienten i v4).
- Forfremmelse af en læse-fane til skrive-fane (D38 M3).

**Anti-mål** (fejl, selv om alt teknisk virker)
- **Tabt fremdrift:** en netværksfejl, en udløbet session, en 409 eller et deploy må aldrig koste
  fremdrift. Lokalt gemmes altid først; skyen er en kopi, der kan halte bagefter.
- **Gratis nødudgang via to enheder:** at vælge den anden enheds save må ikke gøre en brugt
  nødudgang, brugt brændstof eller tabt kapacitet ugjort.
- **Login-mur:** man må aldrig skulle logge ind for at spille. Uden net, uden rolle eller med Discord
  nede spiller man videre som gæst/lokalt.
- **Langsommere spil:** synkronisering må ikke hakke i framen (v2's budget; delplan 3's < 2 ms for
  den synkrone del af en autosave gælder stadig).
- **Multiplayer låst ude** (DESIGN §4).

## 3. Begrænsninger

- Node 24, TypeScript strict, ESM, samme repo. Save-formatet defineres ét sted: serveren importerer
  `src/save/schema.ts`, `migrate.ts` og `replay.ts` direkte. De (og deres imports `@/gen/belt`,
  `@/ship/cargo`, `@/ship/emergency`) skal forblive fri for `three` og DOM — en test vogter det.
- Persondata minimeres **[Claude]**: vi gemmer Discord-bruger-id og visningsnavn, ingen e-mail
  (scopes `identify` og `guilds.members.read`, ikke `email`). Derfor ingen privatlivstekst nu.
- Ingen hemmeligheder i frontend-bundlen; CORS kun til egen origin (= ingen CORS-headers, én
  origin).
- Tests mod en rigtig Postgres i Docker (Docker 28 findes på maskinen).

## 4. Tilgange (valgt: A) [ejer]

| | Tilgang | Pris |
|---|---|---|
| **A ✔** | **Hono + postgres.js + rene `.sql`-migreringer + Arctic (Discord OAuth)** | Vi skriver SQL selv (~3–4 tabeller) |
| B | Fastify + Drizzle ORM | Flere afhængigheder; Drizzles eget skema ved siden af Zod = to sandheder om formen |
| C | Ren `node:http` | Routing, cookies, body-grænser og fejlhåndtering skrevet selv — sikkerhedskode man ikke bør skrive selv |

A valgt, fordi den holder formatet ét sted (Zod), kan testes med `app.request()` uden port og mod
Postgres i Docker, og kører uændret på Railway.

## 5. Sådan virker det

### 5.1 Login og adgang [ejer: Discord + rolle; Claude: detaljer]

1. Titelskærmen viser `SIGN IN WITH DISCORD` (aldrig som krav for at spille).
2. `GET /api/auth/discord` → redirect til Discord med `state` + PKCE (Arctic), scopes `identify
   guilds.members.read`.
3. `GET /api/auth/discord/callback` → bytter koden, henter `/users/@me` og
   `/users/@me/guilds/{DISCORD_GUILD_ID}/member`. Har brugeren ikke rollen `DISCORD_ROLE_ID` (eller
   er ikke medlem), oprettes ingen konto og ingen session; tilbage til spillet med beskeden
   `NOT INVITED — PLAYING AS GUEST`.
4. Med rollen: upsert af brugeren (Discord-id, visningsnavn), ny session, redirect til `/`.
5. **Session:** tilfældigt token (≥ 256 bit), kun hash'en gemmes i databasen; cookie
   `__Host-onespace_session`, HttpOnly, Secure, SameSite=Lax, Path=/, 30 dages udløb. Rollen
   gentjekkes ved næste login, ikke ved hvert kald.
6. **CSRF:** alle skrivende kald kræver `Origin` = `PUBLIC_ORIGIN` ud over SameSite=Lax.
7. `POST /api/auth/logout` sletter sessionen; det lokale save bliver liggende.
8. Discord-tokens gemmes ikke efter callback.

### 5.2 Sky-save og synkronisering

**Model.** Pr. konto ét aktivt spil i skyen: seneste snapshot (`SaveV1`, migreret) med dets
`revision`, plus en append-only log over alle handlingsposter, serveren har modtaget for kontoen.
Protokollen kender både `saveId` og `revision`.

**Arkiv-plads [Claude].** Pr. konto én arkiv-plads til det seneste erstattede spil: når et spil
med et andet `saveId` bliver det aktive (NEW GAME logget ind, eller et valg på konfliktskærmen),
flyttes det gamle aktive spil dertil i samme transaktion, så et spil, der kun lå i skyen, aldrig
forsvinder. Ingen UI til at hente det frem endnu (som kopi-hylden).

**Hvem synkroniserer.** Kun skrive-fanen (writer-låsen fra delplan 3) og kun når man er logget ind.
Synkronisering sker *efter* et vellykket lokalt IndexedDB-save, i baggrunden, og må aldrig blokere
eller forsinke det lokale save.

**Protokol** (navne er bygherrens; semantikken er bindende):
- `GET /api/save` → sky-hovedet (`revision`, snapshot) eller 404.
- `PUT /api/save` med `{ baseRevision, save }`:
  - `baseRevision` = den sky-revision, denne enhed sidst så (gemt lokalt ved siden af savet).
  - Er `baseRevision` = skyens revision → accepteret, skyen får `save` og dets nye handlinger.
  - Ellers → `409` med sky-hovedet → konfliktskærmen (5.3).
- **Ved opstart, logget ind:** hent sky-hovedet *før* titelskærmen bliver interaktiv (med timeout,
  fx 3 s som i delplan 3; uden svar fortsættes lokalt og synkroniseres senere). Er skyen bare nyere
  end det lokale (lokal revision = sidst sete sky-revision) → CONTINUE bruger skyens. Er det lokale
  bare nyere → skub op. Har begge flyttet sig → konflikt.
- **Ved lukning:** intet net-kald. `sendBeacon`/`keepalive` er begrænset til ~64 kB, og et save er
  op til ~1,4 MB. Det lokale save + WAL bærer fremdriften, og næste session synkroniserer.
- **Fejl:** netværksfejl, 401, 429 og 5xx giver en lille status (`OFFLINE — SAVED LOCALLY` /
  `SIGN IN AGAIN TO SYNC`) og et nyt forsøg med backoff. Intet af det rører det lokale save.

**Handlingsposters identitet på tværs af enheder.** `seq` er i dag kun unik pr. enhed, så to
enheder, der spiller videre fra samme save, laver begge post N+1. Skyens log skal kunne skelne dem
og dedupe genfremsendte poster. Mekanismen er bygherrens valg (fx et enheds-id pr. post eller pr.
gren); kræver den et nyt felt i savet, er det **format v2 med eksplicit migrering v1→v2 og en golden
test**, som DESIGN §5.2 foreskriver.

### 5.3 Konflikter [ejer: skærmen; Claude: regnereglen]

```
  TWO SAVES DIVERGED
  ┌ THIS DEVICE ─────────┐  ┌ CLOUD ───────────────┐
  │ Fyss · orbit Remit 31│  │ Kesh · landed Kesh II│
  │ tank 41 % · 2.1 t    │  │ tank 18 % · 0 t      │
  │ 14 min ago           │  │ 2 h ago              │
  └──────────────────────┘  └──────────────────────┘
       KEEP THIS               KEEP CLOUD
```

- **Hvornår [Claude]:** ved opstart (før CONTINUE). Får en `PUT` 409 midt i spillet, pauses der
  *ikke*: spillet gemmer videre lokalt, holder op med at skubbe og viser
  `SYNC CONFLICT — CHOOSE ON NEXT START`. Skærmen kommer ved næste opstart eller når man går til
  titlen. Så skal tilstanden aldrig skiftes ud midt i en manøvre.
- **Valget afgøres på serveren** (`POST /api/save/resolve` el.lign.) med den delte `replay`, så samme
  regel senere kan gælde i multiplayer.
- **Samme spil (samme `saveId`) — regnereglen [Claude]:** det valgte snapshot beholdes (position,
  logbog, last). For den fravalgte gren (handlinger efter det fælles udgangspunkt) beregnes
  *nettoændringen pr. størrelse*: tankens masse, kapacitetstab og hver ressource i lasten. Kun den
  ugunstige retning lægges oven i det valgte: et netto-fald i tank eller last trækkes fra, en
  netto-stigning i kapacitetstab lægges til; netto-gevinster ignoreres. Nødudgangs-tællere lægges
  altid til, og asteroide-udtømning er foreningen af begge. Tank og last klampes til ≥ 0.
  Resultatet får revision = max(begge) + 1.
  - Eksempler: et hop, der blev betalt og refunderet i den fravalgte gren, går i nul og koster intet.
    En reparation (−600 kg metal, −400 kg silikat, −kapacitetstab) trækker metal og silikat fra,
    men kapacitets-gevinsten følger ikke med. Raffinering trækker is fra, men brændstoffet følger
    ikke med. Et nødsignal tæller som brugt, og dets tømning af tanken og lasten trækkes fra.
- **Forskellige spil (forskelligt `saveId`) [Claude]:** to forskellige spil flettes aldrig (DESIGN
  §5.1). Det er et rent valg af snapshot; det fravalgte spil gemmes, ikke slettes (lokalt på
  kopi-hylden; i skyen på en arkiv-plads pr. konto, se 5.2). Opstår ved første login med et
  gæste-save (5.4) og når en anden enhed har startet NEW GAME.
- Det fravalgte snapshot lægges altid på den lokale kopi-hylde (`corrupt`-storen) — intet slettes.
- **Konsekvens:** en nødudgang brugt på én enhed kan ikke gøres gratis ved at vælge den anden.

### 5.4 Gæst → konto og skift af konto [Claude]

- **Første login, lokalt gæste-save, intet i skyen** → savet adopteres automatisk (ingen
  spørgsmål) og bindes til kontoen lokalt.
- **Første login, lokalt gæste-save, og skyen har allerede et spil** → konfliktskærmen (5.3) med
  `THIS DEVICE` / `CLOUD`. Adoption sker én gang.
- **Et lokalt save, der er bundet til konto A, og konto B logger ind:**
  - Er A's lokale save synkroniseret (lokal revision = sidst sete sky-revision) → det lægges på
    kopi-hylden (det findes jo i A's sky), og B's sky-save hentes. Har B intet i skyen, starter B et
    nyt spil; A's save adopteres aldrig af B.
  - Har A ikke-synkroniseret fremdrift → login som B afvises med
    `UNSYNCED PROGRESS FOR <A> — SIGN IN AS <A> ONCE ONLINE TO SYNC`. Ingen fremdrift kan dermed
    forsvinde ud af syne på hylden. (Delt maskine med flere konti er et sjældent tilfælde; det
    enkleste sikre valg er at afvise.)
- Logger man ud, bliver det lokale save liggende, bundet til kontoen, og synkroniseres næste gang
  samme konto logger ind.

### 5.5 Slet min konto [Claude]

`DELETE /api/account` (fra Pause/Settings med dobbelttryk som NEW GAME): sletter bruger, sessioner,
sky-save og handlingslog i én transaktion og logger ud. Det lokale save bliver liggende som gæst.

### 5.6 Sikkerhed og grænser

- Alt input valideres med Zod (whitelist; `SaveV1Schema` er allerede `strictObject`, sten-id'er
  whitelistet).
- **Størrelsesgrænse:** request-body ≤ 2 MB **[Claude]** (målt loft 1,39 MB i delplan 3). Over →
  413, og det lokale save er urørt.
- **Rate limiting** pr. konto på skrivende kald, i hukommelsen (én instans), fx 30/min; over → 429 →
  backoff på klienten.
- Login-endpoints rate-limites pr. IP.
- Sikkerheds-headers på alle svar (CSP der tillader det, spillet bruger; `X-Content-Type-Options`,
  `Referrer-Policy`).

### 5.7 Test-login og testbarhed

- Playwright kan ikke logge ind hos Discord. Et test-login (`POST /api/test/login`) findes kun, når
  `ONESPACE_TEST_LOGIN=1` **og** `NODE_ENV !== 'production'`. Serveren nægter at starte, hvis begge
  er sat i produktion. En test vogter det.
- Backend-tests kører mod Postgres i Docker; Discord mockes på HTTP-niveau.
- End-to-end (DESIGN §6): test-login → flyv til bælte → min is → raffinér → tanken stiger → genindlæs
  → stadig fyldt; og en anden browser-kontekst med samme konto ser samme spil.

### 5.8 Drift (Railway-klar)

- `npm run build` bygger klient (`dist/`) og server; `npm start` kører migreringer og starter
  serveren, som serverer `dist/` og `/api/*` fra samme origin, på `PORT`.
- `GET /api/health` → 200 når databasen svarer.
- Miljøvariabler: `DATABASE_URL`, `PUBLIC_ORIGIN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_GUILD_ID`, `DISCORD_ROLE_ID`, `PORT`, `NODE_ENV`.
- Lokal udvikling: Vite dev-server proxy'er `/api` til den lokale server; Postgres via
  `docker compose`.

## 6. Det, ejeren skal gøre (uden for koden)

- Oprette en Discord-applikation (client id/secret, redirect-URL for localhost og senere Railway).
- Oprette rollen (fx `oneSpace tester`) på sin server og give sig selv den.

## 7. Overladt til bygherren

- Tabeldesign, migreringsrunnerens form, mappestruktur under `server/`.
- Mekanismen for handlingsposters identitet på tværs af enheder (inkl. om det kræver format v2).
- Præcise endpoint-navne, statustekster ud over dem ovenfor, backoff-kurve, rate-limit-tal.
- Hvordan konfliktskærmen og login-knappen passer ind i titel/Pause-UI'et (stil som i dag).
- Opdeling i tasks, så hver kan testes for sig.

## 8. Kendt gæld, der berøres

Fra D38: ingen størrelsesgrænse (løses her på serveren; lokalt stadig ubegrænset), ingen
hylde-UI (uændret), reader-fanen forfremmes ikke (uændret — kun writer synkroniserer).

## 9. Afvigelser fra DESIGN.md

- §5.1 "OAuth med GitHub og Google" → **kun Discord, adgang via rolle** **[ejer]**.
- §5.1 rate limiting og størrelsesgrænse er konkretiseret (5.6).
- §5.2 "spilleren vælger" er konkretiseret med regnereglen i 5.3 **[Claude]**.
