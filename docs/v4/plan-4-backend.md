# Delplan 4: backend og sky

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Inviterede spillere logger ind med Discord, og deres spil synkroniseres til en server, så det
kan fortsættes på en anden maskine. Konflikter vælges på en skærm, aldrig stille. Gæster spiller som i
dag. Alt kører som én Railway-klar tjeneste.

**Architecture:**
- **Server:** `server/` er en Hono-app på `@hono/node-server`, der serverer `dist/` og `/api/*` fra samme
  origin. Postgres tilgås med postgres.js og nummererede `.sql`-migreringer. Discord-OAuth går gennem
  Arctic.
- **Fælles kode:** serveren importerer `src/save/schema.ts`, `migrate.ts` og den nye `conflict.ts`
  direkte, så formatet stadig kun defineres ét sted.
- **Klient:** `src/net/` holder et lille API-lag og `SyncClient`. Synkronisering sker efter et vellykket
  lokalt save og ved opstart før `decideBoot`. Det lokale save (delplan 3) forbliver sandheden på enheden.

**Tech Stack:** Hono 4 + `@hono/node-server`, postgres (postgres.js 3), arctic 3, zod 4 (findes),
esbuild (findes) til server-bundlen, Vitest, Docker (Postgres 17) til server-tests, Playwright.

**Spec:** `docs/v4/DESIGN-4-backend.md` (godkendt 2026-11-15). Baggrund: `docs/v4/DESIGN.md` §4,
§5.1, §5.2, §5.6 og `docs/v4/DECISIONS.md` D29–D38. Overblik: `docs/v4/PLAN.md`.

## Global Constraints

- **Login:** kun Discord. Scopes `identify guilds.members.read`, aldrig `email`. Adgang kræver
  medlemskab af `DISCORD_GUILD_ID` med rollen `DISCORD_ROLE_ID`, tjekket via
  `GET https://discord.com/api/users/@me/guilds/{guild}/member`. Discord-tokens gemmes ikke.
- **Persondata:** kun Discord-bruger-id og visningsnavn (`global_name ?? username`).
- **Session:**
  - Tokenet er ≥ 32 tilfældige bytes (base64url). Kun SHA-256 af tokenet gemmes.
  - Cookie `__Host-onespace_session` med HttpOnly, Secure, SameSite=Lax og Path=/.
  - Udløber efter 30 dage (`SESSION_TTL_MS = 30 * 24 * 3600 * 1000`).
- **CSRF:** alle ikke-GET-kald under `/api` kræver `Origin` = `PUBLIC_ORIGIN`, ellers 403.
- **Grænser:**
  - Request-body højst `MAX_BODY_BYTES = 2 * 1024 * 1024`, ellers 413.
  - Skrivninger pr. konto: `WRITE_LIMIT = 30` pr. 60 s, ellers 429.
  - Login-ruter pr. IP: 20 pr. 60 s, ellers 429.
  - Rate limiting holdes i hukommelsen, fordi der kun kører én instans.
- **Test-login:** `POST /api/test/login` findes kun, når `ONESPACE_TEST_LOGIN=1` og
  `NODE_ENV !== 'production'`. Er begge sat i produktion, nægter serveren at starte og skriver
  `ONESPACE_TEST_LOGIN is not allowed in production`.
- **Miljøvariabler:** `DATABASE_URL`, `PUBLIC_ORIGIN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_GUILD_ID`, `DISCORD_ROLE_ID`, `PORT` (default 8787), `NODE_ENV`, `ONESPACE_TEST_LOGIN`. De
  valideres med Zod ved start, og en fejl giver exit 1 med feltets navn.
- **Ruter:**
  - `GET /api/health`
  - `GET /api/auth/discord`
  - `GET /api/auth/discord/callback`
  - `POST /api/auth/logout`
  - `GET /api/me`
  - `GET /api/save`
  - `PUT /api/save`
  - `POST /api/save/resolve`
  - `DELETE /api/account`
  - `POST /api/test/login`
- **Spillets tekster** (verbatim):
  - `SIGN IN WITH DISCORD`
  - `SIGNED IN AS <name>`
  - `SIGN OUT`
  - `DELETE ACCOUNT — PRESS AGAIN TO CONFIRM`
  - `NOT INVITED — PLAYING AS GUEST`
  - `OFFLINE — SAVED LOCALLY`
  - `SIGN IN AGAIN TO SYNC`
  - `SYNC CONFLICT — CHOOSE ON NEXT START`
  - `TWO SAVES DIVERGED`
  - `THIS DEVICE`
  - `CLOUD`
  - `KEEP THIS`
  - `KEEP CLOUD`
  - `UNSYNCED PROGRESS FOR <name> — SIGN IN AS <name> ONCE ONLINE TO SYNC`
- **Lokal sync-tilstand:**
  - Ligger i localStorage under nøglen `onespace.sync.v1`.
  - Indhold: `{ deviceId: uuid, accountId: string | null, accountName: string | null, lastSeenCloud: { saveId, revision } | null, conflict: boolean }`.
  - Valideres med Zod. Er værdien ugyldig, nulstilles den, men `deviceId` bevares, hvis det er gyldigt.
- **Timeouts:**
  - `SYNC_TIMEOUT_MS = 3_000` for kald ved opstart. Ved timeout fortsætter spillet lokalt.
  - Push sker med backoff på 5 s, 15 s, 60 s og derefter hver 5. minut.
- **Formatet:** `SaveV1` ændres ikke. Delplan 4 kræver ikke format v2 (Ruling i Task 3).
- **Testopdeling:**
  - `npm test` forbliver uden Docker.
  - Server-tests ligger i `server/**/*.test.ts` og kører med `npm run test:server` mod
    `TEST_DATABASE_URL` (default `postgres://onespace:onespace@127.0.0.1:54329/onespace_test`), som
    `docker compose up -d db-test` starter.
- **v2's performance-budget og delplan 3's < 2 ms** for den synkrone del af en autosave gælder stadig.
  Push må ikke serialisere i framen. `JSON.stringify` af savet sker i en `setTimeout(0)`/idle-callback
  efter `store.save`.
- **Commit-trailers:** som i delplan 1–3.

## Review Focus

1. **En session udløber midt i spillet:** PUT får 401. Spillet skal gemme videre lokalt, vise `SIGN IN
   AGAIN TO SYNC` og aldrig smide noget væk. Testes i Task 5.
2. **Samme PUT sendes to gange** (backoff efter en timeout, hvor serveren faktisk committede): anden
   gang må ikke give 409 eller dobble handlinger. Testes i Task 4 (idempotent PUT).
3. **To faner logget ind:** kun writer-fanen synkroniserer. En reader må aldrig PUT'e. Testes i Task 5.
4. **Skyens save er fra et nyere format eller ugyldigt:** klienten må ikke overskrive det lokale. Den
   behandler det som "ingen sky", viser ingen konflikt og PUT'er ikke over det. Testes i Task 5.
5. **Den fravalgte gren mistede last, den valgte ikke har:** fx kun is i den valgte, mens den fravalgte
   brugte metal. Klampningen til ≥ 0 skal ske pr. ressource, og der må aldrig opstå negativ last. Testes
   i Task 3.

---

### Task 1: Serveren står op: config, health, migreringer og én origin

**Files:**
- Create:
  - `server/config.ts`
  - `server/db.ts`
  - `server/migrate.ts`
  - `server/migrations/001_init.sql`
  - `server/app.ts`
  - `server/index.ts`
  - `server/test/db.ts` (test-helper: frisk skema pr. testfil)
  - `vitest.server.config.ts`
  - `docker-compose.yml` (`db` på 5432 og `db-test` på 54329, postgres:17)
  - `scripts/build-server.mjs` (esbuild → `dist-server/index.mjs`, alias `@` → `src`, platform node)
- Modify:
  - `package.json` (deps; scripts `test:server`, `build` = klient + server, `start` =
    `node dist-server/index.mjs`)
  - `vite.config.ts` (dev-proxy `/api` → `http://127.0.0.1:8787`)
  - `tsconfig.json` (include `server`)
  - `.gitignore` (`dist-server`)
- Test:
  - `server/config.test.ts`
  - `server/migrate.test.ts`
  - `server/app.test.ts`
  - `src/save/purity.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string, string | undefined>): Config` (kaster `ConfigError` med feltnavn)
  - `type Config = { databaseUrl, publicOrigin, discord: { clientId, clientSecret, guildId, roleId }, port, production: boolean, testLogin: boolean }`
  - `createDb(url: string): Sql`
  - `migrate(sql: Sql, dir?: string): Promise<string[]>` (returnerer de anvendte filnavne; tabellen
    `schema_migrations`)
  - `createApp(deps: { config: Config; sql: Sql; now?: () => number; fetch?: typeof fetch; staticRoot?: string }): Hono`
- Tabeller i `001_init.sql`:
  - `users(id uuid pk, discord_id text unique, name text, created_at)`
  - `sessions(token_hash bytea pk, user_id fk on delete cascade, expires_at)`
  - `saves(user_id pk fk cascade, save_id uuid, revision int, body jsonb, updated_at)`
  - `save_archive(user_id pk fk cascade, save_id, revision, body jsonb, archived_at)`
  - `save_revisions(user_id fk cascade, save_id, revision, digest jsonb, pk(user_id, save_id, revision))`
  - `actions(user_id fk cascade, save_id, device_id uuid, seq int, entry jsonb, received_at, pk(user_id, save_id, device_id, seq))`

- [ ] **Step 1: Write the failing tests**
  - **Config:**
    - Mangler `DISCORD_ROLE_ID` → `ConfigError` med teksten `DISCORD_ROLE_ID`.
    - `NODE_ENV=production` + `ONESPACE_TEST_LOGIN=1` → `ConfigError` med teksten
      `ONESPACE_TEST_LOGIN is not allowed in production`.
    - `PORT` udeladt → 8787.
  - **Migrate:** på et tomt skema anvendes `['001_init.sql']`. Anden kørsel → `[]`. Alle seks tabeller
    findes.
  - **App:**
    - `GET /api/health` → 200 `{ ok: true }`. Med en lukket `sql` → 503.
    - `GET /` med `staticRoot` → `index.html`. `GET /api/nope` → 404 JSON, ikke index.html.
    - Et POST med `Origin: https://evil.example` → 403.
    - Et POST-body over `MAX_BODY_BYTES` → 413.
    - Hvert svar har `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` og ingen
      `Access-Control-Allow-Origin`.
    - Hvert svar har `Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self';
      style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
      img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
      index.html har inline `<style>` og preconnect til Google Fonts, og ship-generatoren kører i en
      same-origin Worker. Task 7's e2e bekræfter, at spillet viser 0 CSP-fejl i konsollen.
  - **Purity:** `src/save/schema.ts`, `migrate.ts`, `replay.ts` og `conflict.ts` med deres transitive
    imports indeholder ikke `three` og bruger ikke `window`, `document`, `indexedDB` eller `localStorage`
    på modul-niveau. Testen bygger dem med esbuild-metafile og læser input-listen.
- [ ] **Step 2:** Kør `npm run test:server` og `npx vitest run src/save/purity.test.ts` → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér. `index.ts` læser config, kører `migrate` og serverer på `PORT`.
- [ ] **Step 5:** Kør `npm run test:server`, `npm test` og `npm run build` → PASS. Kør derefter
  `NODE_ENV=production … npm start` med en lokal db, og tjek at `curl /api/health` giver 200. Commit.

### Task 2: Login med Discord, rolle-adgang og sessioner

**Files:**
- Create:
  - `server/auth/discord.ts`
  - `server/auth/session.ts`
  - `server/auth/routes.ts`
  - `server/rateLimit.ts`
- Modify: `server/app.ts`
- Test:
  - `server/auth/discord.test.ts`
  - `server/auth/session.test.ts`
  - `server/auth/routes.test.ts`
  - `server/rateLimit.test.ts`

**Interfaces:**
- Consumes: `createApp`, `Config` og tabellerne fra Task 1.
- Produces:
  - `checkMembership(fetch, accessToken, guildId, roleId): Promise<{ ok: true; id; name } | { ok: false; reason: 'not-member' | 'no-role' }>`
  - `createSession(sql, userId, now): Promise<string>` (returnerer tokenet)
  - `sessionUser(sql, token, now): Promise<{ id; name } | null>`
  - Hono-middleware `requireUser`, der sætter `c.var.user` og ellers giver 401 `{ error: 'unauthenticated' }`.
  - `rateLimiter({ limit, windowMs, key }): MiddlewareHandler`
  - Callback-redirects:
    - `/?auth=ok`
    - `/?auth=not-invited`
    - `/?auth=error`
  - `GET /api/me` → `{ id, name }` eller 401.

- [ ] **Step 1: Write the failing tests.** Discord mockes med en injiceret `fetch`.
  - **`/api/auth/discord`:**
    - Giver 302 til `discord.com/oauth2/authorize` med `scope=identify+guilds.members.read`, `state`
      og `code_challenge`.
    - Sætter en kortlivet HttpOnly-cookie med state og verifier.
  - **Callback:**
    - Forkert `state` → `/?auth=error`, og der oprettes ingen bruger.
    - Medlem uden rollen → `/?auth=not-invited`, med 0 rækker i `users` og `sessions`.
    - Med rollen → `/?auth=ok`, plus `Set-Cookie: __Host-onespace_session=…; HttpOnly; Secure;
      SameSite=Lax; Path=/; Max-Age=2592000`, én bruger med `discord_id` og `name`, og ingen e-mail i
      nogen kolonne.
    - Anden login for samme Discord-id → samme bruger (upsert), og navnet opdateres.
  - **Session:**
    - Databasen indeholder kun hash'en: tokenet findes ikke i `sessions`.
    - Udløbet session → `/api/me` 401.
    - `POST /api/auth/logout` → rækken slettes, og cookien ryddes.
  - **Test-login:**
    - Med `testLogin: true` opretter `POST /api/test/login {name}` bruger og session.
    - Med `testLogin: false` → 404.
  - **Rate limit:** 21. login-kald fra samme IP inden for 60 s → 429. Efter vinduet → OK igen (med
    injiceret `now`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér med Arctic `Discord` (PKCE).
- [ ] **Step 5:** Run → PASS. Commit.

### Task 3: Konfliktreglen (ren og delt)

**Files:**
- Create: `src/save/conflict.ts`
- Test: `src/save/conflict.test.ts`

**Interfaces:**
- Consumes: `SaveV1`, `Resource` (src/save/schema.ts, src/gen/belt).
- Produces:
  - `type ShipDigest = { tankKg: number; capacityLossFrac: number; cargo: Record<Resource, number>; emergencyTimesUsed: number }`
  - `shipDigest(s: SaveV1): ShipDigest`
  - `sameGame(a: SaveV1, b: SaveV1): boolean` (samme `saveId`)
  - `resolveSameGame(chosen: SaveV1, unchosen: SaveV1, base: ShipDigest): SaveV1`
    - kaster, hvis de ikke er samme spil
    - returnerer en ny `SaveV1`, revision = max(begge) + 1
    - valideret med `SaveV1Schema`
  - `type CardSummary = { systemName: string; place: string; tankFrac: number; cargoKg: number; savedAtWallMs: number }`
    og `cardSummary(s: SaveV1, capacityKg: number): CardSummary` til konfliktskærmen.

**Ruling (planens):** den fravalgte grens nettoændring beregnes som `shipDigest(unchosen) − base`, hvor
`base` er digesten for det fælles udgangspunkt. Serveren gemmer en digest pr. accepteret revision
(`save_revisions`). Det er robust over for kompaktering (MAX_ACTIONS = 5 000, checkpoints) og kræver
intet nyt felt i savet, altså ingen format v2. Handlingsloggen gemmes stadig append-only på serveren som
revisionsspor (Task 4). Det valgte snapshots `actions` beholdes uændret.

- [ ] **Step 1: Write the failing tests.** Given-When-Then med fixtures bygget som i `replay.test.ts`.
  - **Tank:** fravalgt tank 9 000 kg mod base 12 000 kg, valgt 11 000 kg → resultatet har 8 000 kg.
  - **Refunderet hop:** fravalgt = base (betalt og refunderet) → valgt uændret.
  - **Reparation:** fravalgt har metal −600, silikat −400 og kapacitetstab −0,05. Valgt har metal 1 000,
    silikat 200 og tab 0,10 → metal 400, silikat 0 (klampet), tab 0,10 (gevinsten ignoreres).
  - **Raffinering:** fravalgt har is −2 000 og tank +1 500. Valgt har is 3 000 → is 1 000, og tanken er
    uændret.
  - **Nødsignal:** fravalgt har `emergencyTimesUsed` +1, tank ned til 5 % og last 0. Resultatet har
    tællere +1, tanken trukket ned med fravalgtes netto-fald (klampet ≥ 0) og hver ressource trukket fra
    (klampet ≥ 0, Review Focus 5).
  - **Udtømning:** `world.entries` er foreningen. Pr. (id, resource) beholdes det største `kg`. Ure og
    rækkefølge følger delplan 3's C6.
  - **Kapacitet:** fravalgt kapacitetstab +0,2 mod base → lagt til, og højst 1.
  - **Revision og identitet:** revision = max + 1, og `saveId` og `universeId` er som det valgtes.
  - **Fejl:** forskelligt `saveId` → kaster.
  - **Kort:** `cardSummary` for et grounded save giver `place` som `landed <parent name>`, ellers
    `orbit <parent name>`.
- [ ] **Step 2:** Run `npx vitest run src/save/conflict.test.ts` → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér.
- [ ] **Step 5:** Run → PASS, og purity-testen fra Task 1 er grøn. Commit.

### Task 4: Sky-save-API'et

**Files:**
- Create:
  - `server/save/routes.ts`
  - `server/save/repo.ts`
- Modify: `server/app.ts`
- Test:
  - `server/save/routes.test.ts`
  - `server/save/repo.test.ts`

**Interfaces:**
- Consumes: `requireUser` og `rateLimiter` (Task 2). `migrate` (src/save/migrate.ts) og `shipDigest`,
  `sameGame` og `resolveSameGame` (Task 3).
- Produces (JSON, alle bag `requireUser`):
  - `GET /api/save` → 200 `{ revision, save }` eller 404.
  - `PUT /api/save` med body `{ deviceId: uuid, base: { saveId, revision } | null, save: SaveV1 }`:
    - `base` matcher skyens hoved, eller skyen er tom og `base` er null → 200 `{ revision }`. Gemmer
      hovedet, en `save_revisions`-digest og nye `actions` (`ON CONFLICT DO NOTHING`).
    - Samme `saveId` og `save.revision` som skyens hoved, og identisk body → 200 (idempotent, Review
      Focus 2).
    - Ellers → 409 `{ cloud: { revision, save } }`.
  - `POST /api/save/resolve` med body
    `{ deviceId, keep: 'device' | 'cloud', device: SaveV1, base: { saveId, revision } | null }`:
    - Samme spil → `resolveSameGame` med base-digesten fra `save_revisions`. Mangler den → den fravalgtes
      egen digest, så der ikke lægges noget til.
    - Forskellige spil → et rent valg. Det tidligere aktive spil flyttes til `save_archive` i samme
      transaktion, hvis det ikke er det valgte.
    - → 200 `{ revision, save }`.
  - `DELETE /api/account` → 204. Bruger, sessioner, saves, arkiv, revisioner og actions slettes i én
    transaktion (cascade), og cookien ryddes.
  - Body valideres med Zod. Savet går gennem `migrate`, og afvises det → 400 `{ error: 'invalid-save' }`.

- [ ] **Step 1: Write the failing tests** mod rigtig Postgres:
  - **Første PUT** (base null) → 200. GET → samme save.
  - **Fremad:** PUT med base = hoved → 200. Revision og digest gemmes.
  - **Forældet base** → 409 med skyens hoved, og intet ændres.
  - **Idempotent gentagelse** → 200, og antallet af actions er uændret.
  - **Ugyldigt save** (sten-id `__proto__`, format 99) → 400, og intet ændres.
  - **Body > 2 MB** → 413.
  - **Rate limit:** 31. skrivning på 60 s → 429.
  - **Resolve, samme spil, `keep:'device'`:** skyens gren er fravalgt, og dens tankfald er trukket fra
    → resultatet er gemt som hoved med revision max + 1.
  - **Resolve, forskellige spil:** det gamle hoved er i `save_archive`, og det valgte er hoved.
  - **NEW GAME logget ind:** PUT med nyt `saveId` og base = det gamle hoved → 200. Det gamle spil er i
    `save_archive`.
  - **Slet konto** → 204. 0 rækker for brugeren i alle tabeller, og `/api/me` 401.
  - **Isolation:** bruger B kan ikke læse eller ændre A's save.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér. Hver skrivning er én transaktion med `SELECT … FOR UPDATE` på `saves`.
- [ ] **Step 5:** Run → PASS. Commit.

### Task 5: Klientens synkronisering

**Files:**
- Create:
  - `src/net/api.ts`
  - `src/net/syncState.ts`
  - `src/net/reconcile.ts`
  - `src/net/SyncClient.ts`
- Modify:
  - `src/game/SaveGame.ts` (`SaveGameOptions.onStored?: (s: SaveV1) => void`, kaldt efter et vellykket
    `store.save`, aldrig i inert-tilstand)
  - `src/game/registry.ts` (sync ved opstart før `decideBoot`)
- Test:
  - `src/net/syncState.test.ts`
  - `src/net/reconcile.test.ts`
  - `src/net/SyncClient.test.ts`
  - `src/game/SaveGame.test.ts` (udvidet)

**Interfaces:**
- Consumes: ruterne fra Task 2 og 4, `newestOf` og `sameGame`.
- Produces:
  - `api` med `me()`, `getSave()`, `putSave(body)`, `resolve(body)`, `logout()` og `deleteAccount()`.
    Hvert kald returnerer
    `{ ok: true, status, body } | { ok: false, status: number | 'offline' | 'timeout' }`.
    `fetch` er injiceret.
  - `readSyncState(storage)` / `writeSyncState(storage, s)` (nøgle `onespace.sync.v1`).
  - `reconcile(input: { local: SaveV1 | null; cloud: SaveV1 | null; state: SyncState; me: { id; name } | null }): Decision` med
    `Decision.kind` ∈:
    - `'guest'`
    - `'in-sync'`
    - `'use-cloud'`
    - `'push-local'`
    - `'adopt'`
    - `'conflict-same'`
    - `'conflict-different'`
    - `'refuse-switch'`
    - `'switch-account'`
  - `class SyncClient`:
    - `constructor({ api, storage, isWriter, schedule })`
    - `boot(local): Promise<BootSync>`, der returnerer `{ decision, cloud, notice: string | null }`
    - `onStored(save)`
    - `status(): 'off' | 'synced' | 'pending' | 'offline' | 'reauth' | 'conflict'`
    - `resolve(keep): Promise<SaveV1>`

- [ ] **Step 1: Write the failing tests:**
  - **`reconcile`, hver af grenene:**
    - Ikke logget ind → `guest`.
    - Logget ind uden lokalt og uden sky → `in-sync`.
    - Sky nyere, og lokal = sidst sete → `use-cloud`.
    - Lokal nyere, og sky = sidst sete → `push-local`.
    - Begge flyttet med samme `saveId` → `conflict-same`.
    - Gæste-save og tom sky → `adopt`.
    - Gæste-save og sky med andet spil → `conflict-different`.
    - Lokalt bundet til A med A usynkroniseret, og B logget ind → `refuse-switch` med teksten
      `UNSYNCED PROGRESS FOR A — SIGN IN AS A ONCE ONLINE TO SYNC`.
    - Bundet til A og synkroniseret, B logget ind → `switch-account`.
  - **Opstart:**
    - `use-cloud` skriver skyens save til store, før `decideBoot` læser.
    - `refuse-switch` kalder `logout()`.
    - Svarer sky-kaldet ikke inden for 3 s → spillet fortsætter lokalt, og der kommer ingen konflikt.
  - **Skyens save er ugyldigt eller format 99** → behandles som ingen sky, og der kommer ingen PUT
    (Review Focus 4).
  - **Push:**
    - `onStored` → en PUT efter en timer, ikke synkront.
    - 401 → status `reauth` og teksten `SIGN IN AGAIN TO SYNC` (Review Focus 1).
    - Netværksfejl → `offline`, `OFFLINE — SAVED LOCALLY` og backoff 5 s, 15 s, 60 s, 300 s.
    - 409 midt i spillet → `conflict`, `SYNC CONFLICT — CHOOSE ON NEXT START`, ingen flere PUT'er og
      ingen pause.
  - **Reader-fane** → aldrig PUT (Review Focus 3).
  - **SaveGame:** `onStored` kaldes én gang pr. vellykket store-save, ikke ved fejl og ikke i inert-tilstand.
    Den synkrone del af en autosave er stadig < 2 ms (delplan 3's perf-test er uændret grøn).
  - **Sync-tilstand:** ugyldig JSON nulstilles, og `deviceId` bevares.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér.
- [ ] **Step 5:** Run `npm test` → PASS, og `npx vite build`. Commit.

### Task 6: Login, konto og konfliktskærmen i UI'et

**Files:**
- Create:
  - `src/ui/conflictScreen.ts` (ren state og tekster)
  - `src/ui/ConflictScreen.ts` (DOM)
  - `src/ui/accountMenu.ts`
- Modify:
  - `src/ui/titleMenu.ts`
  - `src/ui/Title.ts`
  - `src/ui/Pause.ts`
  - `src/ui/pauseState.ts`
  - `src/game/registry.ts`
- Test:
  - `src/ui/conflictScreen.test.ts`
  - `src/ui/accountMenu.test.ts`
  - `src/ui/titleMenu.test.ts` (udvidet)

**Interfaces:**
- Consumes: `SyncClient`, `cardSummary` og `BootSync`.
- Produces:
  - Titelmenuens items får `'signin'`, når man ikke er logget ind, og `'account'`, når man er.
  - Effekterne `{ kind: 'signin' }`, som navigerer til `/api/auth/discord`, og `{ kind: 'signout' }`.
  - Pause får `DELETE ACCOUNT`, der kræver dobbelttryk som NEW GAME.
  - Konfliktskærmen viser `TWO SAVES DIVERGED` med kortene `THIS DEVICE` og `CLOUD` og vælges med
    `KEEP THIS` eller `KEEP CLOUD`. Det fravalgte lokale save lægges på kopi-hylden (`keepCorrupt`).

- [ ] **Step 1: Write the failing tests:**
  - **Titelmenu:**
    - Gæst → `SIGN IN WITH DISCORD` står sidst.
    - Logget ind → `SIGNED IN AS Dennis` og `SIGN OUT`.
    - Login er aldrig et krav for CONTINUE eller UNDOCK.
  - **`?auth=not-invited`** → noticen `NOT INVITED — PLAYING AS GUEST`, og parameteren fjernes fra URL'en.
  - **Konfliktskærm:**
    - To fixtures giver de forventede kort (system, sted, tank %, last t, "14 min ago").
    - Pil venstre og højre skifter valg, og Enter vælger.
    - Skærmen fanger tasterne, mens den er synlig.
    - Efter et valg fortsætter spillet med resultatet.
  - **Sync-status:**
    - `SyncClient.status()` vises i Pause under kontolinjen: `offline` → `OFFLINE — SAVED LOCALLY`,
      `reauth` → `SIGN IN AGAIN TO SYNC`, `conflict` → `SYNC CONFLICT — CHOOSE ON NEXT START`.
    - Ved et statusskift vises den samme tekst én gang som log-notice.
  - **Slet konto:** første tryk viser `DELETE ACCOUNT — PRESS AGAIN TO CONFIRM`, og andet tryk kalder
    `deleteAccount()`. Det lokale save er urørt, og menuen viser gæst.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: ⏸** Vent på ejerens godkendelse.
- [ ] **Step 4:** Implementér i samme noir-stil som titel og Pause.
- [ ] **Step 5:** Run `npm test` → PASS og `npx vite build`. Commit.

### Task 7: Hele vejen, mutation og afslutning

- [ ] **Step 1: E2E med Playwright mod `npm run build && npm start`** (lokal Postgres,
  `ONESPACE_TEST_LOGIN=1`, ikke production):
  1. Test-login → flyv til bælte → min is → raffinér → tanken stiger → genindlæs → stadig fyldt (DESIGN §6).
  2. En anden browser-kontekst med samme konto → CONTINUE giver samme system og samme tank.
  3. Begge kontekster spiller videre offline. Kontekst 1 går online først, og kontekst 2 får 409 →
     `SYNC CONFLICT — CHOOSE ON NEXT START` → genindlæs → konfliktskærm → `KEEP THIS` → resultatets
     tank ≤ den valgte (regnereglen).
  4. Serveren stoppes midt i spillet → `OFFLINE — SAVED LOCALLY`. Genindlæs → fremdriften er der stadig
     (lokalt).
  5. Frametid under push (ingen synlig hakken) og 0 konsol-fejl.
- [ ] **Step 2:** Mutation testing på `src/save/conflict.ts`, `src/net/reconcile.ts`,
  `server/auth/session.ts` og `server/save/repo.ts`. Reelle huller lukkes med tests (ejerens godkendelse).
- [ ] **Step 3:** Afsluttende review af hele grenen, én fix-runde, DECISIONS fra D39 (inkl. "kun Discord,
  rolle-adgang" som ejerbeslutning) og push `v4`.
