# Publication Parity

**Module**: [`packages/core/src/publication/`](../packages/core/src/publication/) ·
**Tests**: [`tests/publicationParity.test.js`](../tests/publicationParity.test.js),
[`tests/season2026Fixture.test.js`](../tests/season2026Fixture.test.js) ·
**Gaps**: [GAP-29](MODEL_GAPS.md#gap-29), [GAP-30](MODEL_GAPS.md#gap-30), [GAP-34](MODEL_GAPS.md#gap-34)

> _"Recovery was only possible by re-importing the published schedule and
> treating it as ground truth."_ — incident 1, on a season in which 366 of 679
> games had silently moved after a re-optimisation.

This module is the thing that made that recovery possible, built as code rather
than as a rescue operation: an immutable copy of what families were told, one
comparator that diffs the working schedule against it row by row, the
family-facing before/after list that comes out of a divergence, and the list of
every downstream destination that is serving a copy of the schedule.

---

## 1. What is here

| Piece                        | Entry point                                | What it is                                                                                |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **Publication snapshot**     | `makePublicationSnapshot()`                | An immutable, timestamped, attributed copy of a published artifact, with a content digest |
| **Parity**                   | `checkParity()` / `compareParityRows()`    | One comparator over two row sets, partitioning into matched / differing / added / removed |
| **Field-name mapping**       | `MappingRuleSchema`, `applyMappingRules()` | Exact-label rules with provenance, counted and reported                                   |
| **Change notices**           | `buildChangeNotices()`                     | A before/after list grouped by team, enumerated from the roster                           |
| **Downstream sync registry** | `buildSyncRegistryReport()`                | Every destination that consumes the schedule, and when it last took a copy                |

Everything follows the conventions of the eleven packages before it: a frozen
severity table (`publication/reasonCodes.js`), findings as a list, a status
derived mechanically from severities, additive `meta` counters, `.strict()` Zod
schemas, `YYYY-MM-DD` dates and minutes past local midnight.

---

## 2. Snapshots: four properties, and why each is load-bearing

**Frozen copies, not references.** `snapshot.rows` are copied out of whatever
produced them and deep-frozen. A "snapshot" that shared structure with the
working schedule would change when the schedule changed, which is the one thing
a snapshot must not do. Falsified in the tests by mutating the source array
afterwards and asserting the snapshot did not move.

**`publishedAt` and `publishedBy` are required inputs with no defaults.**
Nothing in this package reads a clock or invents an actor — a structural test
asserts no `new Date(` and no `Date.now(` appears anywhere in the package. A
self-stamped snapshot carries two fields that read as an audit trail and are
not one, and this repository has already lost a board waiver to a field that
read as load-bearing and was not.

**A content digest.** `publicationDigest()` hashes the cells in declared column
order, so a row object whose keys were inserted in a different order digests the
same and a row whose content changed does not. It is a **drift digest, not a
seal**: FNV-1a is not cryptographic and a determined forger can collide it. It
catches the accident, which is the failure that actually happens.
`verifySnapshotDigest()` takes the snapshot as an argument precisely so a test
can hand it a tampered one and watch `SNAPSHOT_DIGEST_MISMATCH` fire.

**`durability: 'in-memory'` is on the record, not only in the docs.** Phase 6
persists nothing. The reason it gave at the time was GAP-30 rather than
consistency with earlier phases: `SlotSchema` and `AssignmentSchema` then
normalised through `z.coerce.date()`, which turned a published wall-clock
`8:30 AM` into an absolute instant using the host timezone, and two corpus dates
fall after DST ends. Persisting a snapshot through a timezone-lossy schema would
have made **the parity checker cause the divergence it exists to detect**.

**That reason expired on 2026-09-19. GAP-30 is closed** (#396, #398, #400).
`z.coerce.date()` is gone: `SlotSchema.start/end` and
`AssignmentSchema.start/end` are `InstantSchema`, which **refuses** a zoneless
timestamp — both a naive `'2026-11-07T16:44:00'` and a bare `'2026-11-07'` —
rather than silently giving it the host's offset, and a wall time must be
composed on the season clock (`timing/seasonClock.js`,
`season_settings.timezone`) before it can reach a domain schema. Verified by
execution rather than by reading: an offset-carrying string parses to the
identical instant under `TZ=UTC` and `TZ=America/Los_Angeles`, and both zoneless
forms are refused in both zones. **So the timezone objection to persisting a
snapshot no longer holds.** What still holds is everything else: there is still
no SQL migration here, `durability: 'in-memory'` is still on every record, and a
consumer holding the object still learns the limitation from the object. The
remaining work is GAP-29's own — a durable published-baseline version — and it
is no longer waiting on anything.

---

## 3. Parity: four buckets, enumerated from both sides

`matched + differing + added + removed === rowsCompared`, and the identity is
**counted** rather than asserted from how the lists were built —
`parityPartitionFindings()` is exported and takes its counts as arguments, so a
test hands it a partition with a row dropped and one with a row counted twice
and proves `PARITY_PARTITION_INCOMPLETE` fires at blocking.

The distinction between `added` and `differing` is the acceptance test. The
published rec artifact holds 567 rows; the working workbook holds those 567 plus
a 112-row Select/11v11 layer that was never published to families. Those 112 are
**additions**, not differences. So:

- `PARITY_ROW_ADDED` is `info`, and reaches the findings as **one aggregate**
  with a count and example keys — 112 info findings would bury the four that
  matter;
- `PARITY_ROW_DIFFERS` and `PARITY_ROW_REMOVED` are `blocking`, and reach the
  findings **one row at a time** — a divergence and a vanished fixture each need
  a person to look at that row.

### One row shape, one key, thin adapters

`publication/rows.js` defines the normalised parity row — `date`,
`startMinutes`, `venue`, `field`, `format`, `division`, `home`, `away`, plus
`participant` for per-team artifacts — and `parityRowKey()`, the single key
derivation in the repository. `fixtures/season2026Parsers.js` `publicationKey()`
now delegates to it rather than joining eight fields itself.

`null` means **"this source does not carry that column"**. It never means
"empty" and never means "equal": a compared field that is `null` on either side
of a pair is `PARITY_FIELD_ABSENT` at blocking, never a silent match. The
corollary is `exportCell()`: a cell the artifact **carries and left blank** is a
value, so it stays `''` rather than folding into `null`.
`generateScheduleExports()` writes `fieldId ?? ''` and `division ?? ''`, so a
published fixture whose field was later cleared arrives as an empty `Field`
cell — and folding that into `null` put the pair in `matched`, counted it in
`PARITY_ROWS_MATCHED` and told the family whose pitch had gone nothing at all.
Absent and empty are different, exactly as unknown and zero are. A field
that both sides carry and the subject neither keys nor compares is
`PARITY_FIELD_UNCOMPARED` at `compromise`, because "567/567 match" means nothing
until you know on how many columns.

One consequence worth stating: an unplaced fixture exports as `TIME TBD`, which
is not a time, so a subject that compares kickoffs cannot compare that row's
kickoff on either side and says so at blocking. The fixture is still carried
through parity and still matched on everything it does have — it is the _claim
of time parity_ that is refused, not the row.

Adapters are deliberately thin, one per source, never one comparator per source:

| Source                       | Adapter                                        |
| ---------------------------- | ---------------------------------------------- |
| Export-vocabulary rows       | `parityRowsFromExportRows()` (`rows.js`)       |
| The corpus's schedule CSVs   | `season2026ParityRows()` (`adapters/`)         |
| The externally-published CSV | `season2026ExternalParityRows()` (`adapters/`) |

---

## 4. Field-name mapping, and the trap in the acceptance test

The build plan asks for parity "with field-name mapping, since the public view
uses different labels than internal storage", and gives three examples:
`Brookside Field 1` → `Brookside Upper 1`, `Minis01` → `MinisA`, a `TBD`
opponent → `-`.

**All three are invented.** Verified against the corpus: no row contains
`Brookside Field 1`; only `MinisA`–`MinisD` exist and never `Minis01`; the one
literal `TBD` is in the **Home** column rather than as an opponent.

Worse, the acceptance test does not exercise a mapping at all. The 567 rec rows
are **byte-identical across all eight columns** between
`published_rec_schedule.csv` and `combined_schedule.csv`, so **an empty mapping
table passes it** — and so would a table full of plausible rules for labels that
no longer exist. That is incident 4's shape: a perfect score meaning "I looked
at nothing."

So there are **two subjects**:

| Subject                                                         | Published side                            | Current side                                  | Result                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **A** — `season2026PublishedParityInput()`, the acceptance test | `published_rec_schedule.csv`, 567 rows    | `combined_schedule.csv`, 679 rows             | 567 matched, 112 added, 0 differing, 0 removed; **`mappingRulesApplied: 0`**             |
| **B** — `season2026ExternalParityInput()`, the mapping's run    | `external_fixtures_published.csv`, 8 rows | the 8 `external_fixture` rows of the workbook | 8 compared, 4 matched, 4 differing by the negotiated 30 minutes; 2 rules, 8 applications |

Subject A's report **states the zero** (`MAPPING_NOT_EXERCISED` at `info`)
rather than letting a reader assume a translation happened. Subject B is the run
that proves the mapping works: `Alder Park (Back Pitch 2)` is a label that
appears nowhere in internal storage, every one of the 8 rows goes through a
venue rule, and a negative control runs the same subject with the rules removed
and gets 0 matches and 8 differences.

### The mapping table is falsifiable independently of the corpus

- rules are **records with mandatory provenance**, not a lookup table;
- `mappingRulesDeclared` and `mappingRulesApplied` are both reported, neither
  inferred from the other;
- **a declared rule that matched nothing is `MAPPING_RULE_UNEXERCISED` at
  `blocking`** — the check that catches a table full of plausible rules for
  labels that have gone. The test constructs exactly that case using the build
  plan's own `Brookside Field 1` example and proves it fires;
- a rule may read or write labels only. `date` and `startMinutes` are refused by
  the schema: a rule that rewrote a kickoff would be a schedule edit wearing a
  translation layer's clothes, and the parity report would then agree with
  itself.

The corpus's own two rules are **derived from the loader's parse** rather than
typed in — `parseExternalFixtures()`'s regex is the one external-naming
transform and `season2026ExternalVenueMapping()` records its output as rules
with provenance. One transform, two representations.

---

## 5. Change notices

`buildChangeNotices()` turns a parity result into a family-facing before/after
list grouped by team. Four refusals:

**Teams are enumerated from the roster, never from the changed rows.** A team
whose games vanished produces no _changed_ row, so grouping from rows means the
family with the worst news is the one family that gets no notice. The
falsification is in the test: one team's rows are deleted from the working
schedule and the notice for that team, with nine removals, is asserted to exist
— alongside the independently-derived set of its opponents. A participant that
is neither a known team nor a declared non-team label (`-`, `Select Game 7`, a
visiting club, a Minis session) is `NOTICE_PARTICIPANT_UNKNOWN` at blocking
rather than a silent skip — and so is a label **more than one team answers to**
(`details.reason: 'ambiguous'`, with the claiming ids). The label-to-team map is
built with collision detection rather than a single overwriting pass, and an
ambiguous label is routed to neither team: misrouting a family's schedule change
to a different family is worse than failing to send it.

**A per-team row is addressed to the participant it names.** One fixture in a
per-team artifact is two rows, each written for one team; `ParityRow.participant`
is who each is _for_, and it is honoured when set. A row with no participant —
every row the corpus's schedule CSVs produce — is a fixture rather than a
letter, so both sides are told. Filing a per-team row under both sides regardless
gives every family the same change twice.

**A notice run is never sounder than the parity it was built from.** `parity.status`
is read, carried onto the result as `parityStatus` and reported in
`NOTICE_BUILT`'s details, and three shapes of an _unfounded_ quiet season are
`NOTICE_VACUOUS` at blocking: `no-team-universe`, `parity-examined-nothing` (the
parity carried `PARITY_VACUOUS`, partitioned no rows, or compared no fields), and
`divergence-told-to-nobody` (a `rejected` parity not one enumerated team was told
about). A `rejected` parity whose changes do reach families is none of these —
that is the ordinary case, and the run is `allowed`.

**Contact columns are out unless a caller names the flag.** `CLAUDE.md` §2 is
data minimisation: notices carry fixtures, not coaches' names and email
addresses. `includeContacts` defaults to `false`, and setting it emits
`NOTICE_CONTACTS_INCLUDED` at `compromise` so the inclusion is a decision that
shows up in the findings.

Kickoffs are rendered by `reserve/publication.js` `naiveDateTime()` — the only
GAP-30-safe human time renderer in this repository. There is not a second one.

---

## 6. Downstream sync registry

> The public site auto-synced daily from a master file. When that pointer went
> stale it kept publishing plausible-looking, internally consistent, wrong data,
> with no error anywhere.

`buildSyncRegistryReport()` checks each destination's last sync against the
active snapshot's `publishedAt`, comparing two naive stamps as text (no `Date`
is constructed). Three deliberate choices:

- **`destinationSyncedAt` is nullable but never optional.** Omitting the key is
  a schema error; writing `null` is `DESTINATION_NEVER_SYNCED` at **blocking**.
  Defaulting an unknown sync time to "fresh" is the failure above, written
  deliberately.
- **`kind: pull | push | manual` travels with every finding.** A pull
  destination fetches on its own schedule and cannot be told from here that it
  is stale; a report that said "stale" without saying which way the data flows
  would send an operator to the wrong end of the pipe.
- **Both sides of the comparison go through `PublicationStampSchema`.** The
  snapshot's own `publishedAt` is validated as well as every
  `destinationSyncedAt`, and a stamp in any other format throws. Ordering here
  is textual, so an ISO instant (`…T18:00:00Z`) sorts a destination that synced
  at the publication minute _before_ it and reports a current copy as stale —
  and staleness is this module's entire output.
- **The field is qualified `destinationSyncedAt`.** A bare `lastSyncedAt`
  already means something different in three persistence snapshots
  (`teamPersistenceSnapshot.js`, `practicePersistenceSnapshot.js`,
  `gamePersistenceSnapshot.js`).

**Nothing observes these values.** Every timestamp is an operator's assertion
that a sync happened; no code polls a destination and nothing is persisted. Every
report therefore carries `DESTINATION_SYNC_UNOBSERVED` at `compromise`, so the
registry can never read as monitoring. It is a notebook that does arithmetic.

---

## 7. What this deliberately is not

- **Not persisted.** No SQL migration. The GAP-30 reason §2 originally gave for
  that has expired — GAP-30 closed on 2026-09-19 — so this is now simply unbuilt
  rather than blocked; see §2 and [GAP-29](MODEL_GAPS.md#gap-29).
- **Not a second diff.** `compareParityRows()` is the only row comparator;
  `resolve/state.js` `diffAgainstBaseline()` remains the only game-by-game
  baseline diff, over a resolve run rather than over two artifacts. The scenario
  diff of the next prompt is meant to call through `compareParityRows()` rather
  than grow a third.
- **Not a second parity comparator.** The hand-rolled `publicationKey()` count
  map that used to live in `tests/season2026Fixture.test.js` is gone; that test
  now calls `checkParity()` and asserts the same numbers.
- **Not a second export vocabulary.** `rows.js` adapts
  `outputGeneration.js`'s `SCHEDULE_EXPORT_COLUMNS`.
- **Not a second time renderer.** See §5.
- **Not the teaming snapshot.** `teamSnapshot.js` owns `draft | review |
published | locked` for roster drafts. Nothing here reads or writes it, no type
  is shared, and every name in this package is qualified `Publication…` or
  `Parity…` so the two cannot be confused in an import list. It is also distinct
  from `reserve/publication.js`, which is a _projection_ of reserved slots and
  TIME TBD fixtures into export columns and knows nothing about snapshots.
- **Not wired into the shipping app.** No frontend, no Edge Function, no RPC.
