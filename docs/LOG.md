# The ship's log

`ARCHITECTURE.md` says the loop is *travel, look, scan, log*. Three of those
existed. This is the fourth, plus the half of the third that was never wired.

## What was actually missing

`KeyT` had been bound to `'scan'` in the input map since the first week. The
HUD had rendered `ScanResult` with a typewriter reveal for just as long. The
bus declared `scan:complete`. Nothing read the key, and the only two emitters
of `scan:complete` in the entire codebase were showroom fixtures — so the
scanner was a thing you could photograph but not use.

`ui:toggle-codex` was likewise on the bus, bound to `KeyC`, emitted by `Pilot`,
and listened to by nobody.

Both are the project's recurring defect: **every part existed and no one owned
the seam between them.**

## The pieces

| File | Owns |
|---|---|
| `src/gen/scan.ts` | The planet readout. Pure: spec in, ten strings out. |
| `src/game/Scanner.ts` | The T key. Picks a target, sweeps, emits `scan:complete`. |
| `src/game/Log.ts` | The journal. Subscribes to the bus; persists to `localStorage`. |
| `src/ui/Codex.ts` | The C key. Renders the journal as a document. |

Nothing here required a change to the modules that emit the events it listens
to. That is deliberate — the log is additive, and a log that needed edits in
`Universe`, `FlightModel` and `Traffic` to work would rot the first time one of
them changed.

## Why the log is the only thing that gets saved

The universe is a pure function of one seed. Every star, world and hull can be
regenerated on demand. What cannot be regenerated is *which* of them you went
to, and in what order. So the log stores references and impressions — an id, a
timestamp, the sentence the game wrote — never a copy of the world.

That is also why an entry is keyed by subject. Visiting a world twice is one
discovery with two dates, not two discoveries, so a revisit bumps a counter and
leaves the entry where it sits. A log that reordered on revisit would be a
recency list, and the point of a log is the order things were found in.

## Registration order matters here

`ShipLog` is registered **before** `Universe`, which is the only module that
breaks the file's "Universe goes first" rule. `Universe.init()` calls
`enterSystem`, which emits `system:entered`. A log added after it would miss the
opening system every session, silently, forever. The log depends on nothing but
the bus, so putting it first costs nothing.

## The readout is set by its instrument

`MAX_VALUE` in `scan.ts` is 30 characters, and that number is not taste. The
HUD's scanner panel is 330px of 9px monospace with 0.1em tracking — about 48
characters. At 46 the rows ran to 63 and clipped mid-word against the panel
edge. `scan.test.ts` asserts the width, and asserts that *only* the prose note
may end in an ellipsis: losing a clause off a sentence is a style, losing
"tidally locked" off a classification is losing a fact.

Case is meaning, not styling. An earlier version lower-cased whole rows, which
produced `266 k mean` — lower-case k is the kilo prefix — and `co2 / so2`. The
label is lower-cased; the value is not.

## Known gaps

- **Hull contacts are reachable but rarely triggered.** `Scanner` prefers a
  vessel within 400 km, and `Traffic` seldom puts one that close. The `contact`
  kind works and is tested; it is just quiet in practice.
- **Two bodies can read as one.** The generator produced `Fyss I` (a toxic
  planet, 11 324 km, 27.5 m/s²) and `Remit 31 / Fyss I` (a barren moon, 982 km,
  0.4 m/s²) in the same system. The data is consistent; the *names* are not
  distinguishable at a glance, and a reviewer read them as a single body with
  contradictory physics. That is a naming problem in `gen/names.ts`, not a log
  problem, but the log is where it becomes visible.
- **The codex repeats the scanner's field order.** A critic's fair point: the
  document and the instrument currently present the same ten fields in the same
  sequence, so they differ in case and colour rather than in structure. Leading
  with the written line and demoting the numbers to a subordinate register
  would separate them properly. Not done.
