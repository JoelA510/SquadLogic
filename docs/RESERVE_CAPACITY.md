# Placeholders, reservations, unplaced fixtures and reserve capacity

Phase 5.1. Scheduled things that are **not fully known yet**, and how much ground
a date actually holds.

The build plan's sentence for this phase:

> Add first-class support for scheduled things that aren't fully known yet.
> Three distinct kinds appeared in the source project and all were handled with
> ad-hoc string hacks.

Code: `packages/core/src/reserve/`. Tests: `tests/reserveCapacity.test.js`.
In-memory only, exactly as Phases 1–4: there is still no SQL home for a reserved
slot, a slot condition, an unplaced fixture or a capacity report, and this work
deliberately does not create one.

---

## 1. The four things the corpus spells with one `-`

`combined_schedule.csv` puts a single hyphen in the `Away` column of 137 rows,
and it means four different things:

```text
MinisA          -                              there is no opponent, and there never will be
Select Game 7   -                              the external league has not said yet
Scrimmage TBD   -                              this is not a fixture at all; it is held ground
14GSelect02     Visiting Club A - U14G North   a real opponent with no identity in this system
```

`FIXTURE_SIDE` (`reserve/reasonCodes.js`) is the enum that keeps them apart —
`none`, `tbd`, `session`, `external`, `team` — and
`season2026FixtureSides()` classifies a row from the **row kind** the loader
already derived structurally, never from the `-` itself, which cannot carry the
distinction, and never from a name heuristic on the label, which is the second
half of incident 4.

`tests/reserveCapacity.test.js` classifies all 679 rows and asserts the
partition: 36 Minis sessions (`session` v `none`), 100 unnamed league fixtures
and 1 reservation (`tbd` v `tbd`), 5 external fixtures facing a visiting club and
3 facing another member team.

---

## 2. An unnamed fixture must not move

> *"The club chooses field and time. So 10 slots per Saturday are real,
> committed, and team-less. They must occupy fields, appear in exports, and
> accept team assignment later **without moving**."*

A `ReservedSlot` has two halves, and the split is the whole design:

| half | fields |
| --- | --- |
| the **footprint** | `id`, `kind`, `date`, `venueId`, `surfaceId`, `startMinutes`, `endMinutes`, `format` — what families already have |
| the **occupants** | `homeSide`/`awaySide`, `homeTeamId`/`awayTeamId`, `homeLabel`/`awayLabel` — what can still change |

`SLOT_FOOTPRINT_FIELDS` is exported because it is a contract: a field added to
the record is either part of the commitment or part of what can still change, and
that list is where the decision is recorded.

`applySlotBindings()` builds each bound slot by spreading the original and
overriding occupant fields only — and then **proves** it did, by running
`checkSlotsUnmoved()` over its own before-and-after and folding those findings
into its result. The guarantee is enforced on the production path, not only in a
test. `checkSlotsUnmoved()` compares the rendered footprint string byte for byte,
reports a slot present before and absent after as `RESERVED_SLOT_DROPPED`
(vanishing is a stronger form of moving), and refuses to certify a comparison
that examined zero pairs.

The test asserts identity on the footprint string across all 100 slots, and then
constructs the failure — one slot nudged 30 minutes, one moved to another field,
one removed — and shows the check firing on each.

Refusals, all of them findings rather than exceptions so that one bad row in a
league's batch does not discard the other ninety-nine:
`RESERVED_SLOT_UNKNOWN`, `RESERVED_SLOT_TEAM_UNKNOWN` (a team identifier is a
member of the roster or it is not one), `RESERVED_SLOT_SIDE_NOT_BINDABLE` (a
Minis session's absent opponent is not a side waiting to be filled),
`RESERVED_SLOT_SIDE_ALREADY_NAMED`, `RESERVED_SLOT_SIDES_IDENTICAL`,
`RESERVED_SLOT_TEAM_DOUBLE_BOOKED` and `RESERVED_SLOT_PARTIALLY_BOUND`.

---

## 3. Conditional slots are evaluated, not annotated

> *"A slot available only if another field is idle. Encode the condition; do not
> put it in a note field."*

`conditionForSurface()` derives a `SlotCondition` from the facility graph:
the surfaces a slot depends on are exactly those `surfacesConflict()` reports as
`OCCUPIED_SPATIAL_OVERLAP`. Alder Park's Pitch 2 therefore depends on Pitch 1
**and its halves 1A and 1B**, through the overlap relation's lineage clause;
Pitch 3 depends on Pitch 4, 4A and 4B. Riverbend's Turf and Summit HS's Stadium
are the only 11v11 ground at their venues and carry no condition at all — which
is a real answer, and the reason the two capacity columns mean something.

`evaluateSlotCondition()` checks it against real bookings and returns one of
four verdicts: `satisfied`, `blocked`, `undecidable` or `unconditional`. There is
**no second overlap test** in the package: concurrency is
`bookingsOverlapInTime()`, whose deliberate `null` for an unknown footprint
(GAP-14) becomes `undecidable` here rather than a fabricated all-clear. The
corpus's single reservation is a `Scrimmage`, which has no `game_formats.csv`
row, so that path is exercised by real data.

A condition that is stored and nobody checked is `SLOT_CONDITION_UNENFORCED` at
`compromise` — the constraint registry's `declared-only` distinction, applied to
a slot. `ReserveCapacityInputSchema` therefore **requires** its `bookings`: an
empty array is a caller stating that nothing else is booked, an omitted one is
nobody having looked, and defaulting the second to the first would report every
conditional slot satisfied on the ground the build plan asks to keep separate.

Severity is split by who is standing on the ground: an unreserved candidate whose
condition fails is `SLOT_CONDITION_BLOCKED` at `info` (a fact about the day),
while a slot the club actually reserved is `RESERVED_SLOT_CONDITION_BLOCKED` at
`blocking` (ground held that cannot be used). `capacity.js` makes that split on
the production path — a candidate kickoff that coincides with a reserved slot on
the same surface and date is evaluated as held ground — rather than leaving the
blocking code reachable only from a test that sets the flag by hand.

**This corpus produces no such case, and the suite says so rather than implying
otherwise.** Its twenty-six blocked conditional candidates are all on Alder
Pitch 2, where the club reserved nothing; Pitch 3 *is* reserved and conditional,
but the only rows ever standing on its overlapping neighbours (Pitch 4 and its
halves) fall on two August dates the reserve season does not reach. So
`RESERVED_SLOT_CONDITION_BLOCKED` is reachable in principle and fired by a
constructed case — ground held on Pitch 4 across a Pitch 3 kickoff the club
reserved — with the twenty-six unreserved blocks staying at `info` in the same
report as the control that makes the escalation falsifiable.

---

## 4. Unplaced fixtures — incident 10

> *"It must remain VISIBLE, be counted in totals, and export with explicit TIME
> TBD / LOCATION TBD plus the reason. It must never be silently dropped — that's
> how a team loses a game."*

Three verbs, three functions:

- **visible** — `makeUnplacedFixture()` stamps `PUBLICATION_TBD.TIME` and
  `PUBLICATION_TBD.LOCATION` itself; they are not inputs, because they are what
  an unplaced fixture *is*.
- **counted** — `accountForFixtures()` reconciles what must exist against what a
  run produced. It takes `expectedFixtureIds` **as an argument and will not
  derive them from the run**: a fixture the run dropped is precisely the record
  missing from the run's own output, so a check enumerating its subjects from
  there would report a clean season. Anything in neither list is
  `FIXTURE_DROPPED` at `blocking`; an accounting that reconciled nothing is
  `FIXTURE_ACCOUNTING_VACUOUS`. A fixture a run reports as **both** placed and
  unplaced is `FIXTURE_DOUBLE_COUNTED` at `blocking` and is counted **once** in
  `accounted`: `placed` and `unplaced` report each source's own claim,
  `doubleCounted` names the overlap, and `accounted + missing === expected`
  always — a disagreement the reconciler has just reported must not also inflate
  the total it is reconciling. All three inputs are required, for the same reason
  the first one is: an absent list is not an empty one.
- **exported** — `publicationRowsFor()` emits rows carrying both tokens and the
  reason, and reports `FIXTURE_DROPPED` for any subject that produced no row,
  because the export is the last place a fixture can quietly disappear.

Nothing here decides that a fixture is unplaceable or computes the reason. Both
already exist: `resolve/stages.js` carries a thawed game with no legal slot as
TIME TBD, and `placement/replaceGames.js` does the same for its bounded harness.
`unplacedFromResolveRun()` and `unplacedFromPlacementRun()` read those; a third
opinion about why a game cannot be placed would be free to disagree with the one
the solver acted on.

`causeKind` is a field rather than an inference. `resolve/stages.js` gives the
TIME TBD move no cause on purpose — the move that *lifted the game out* already
named what forced it — so this module follows that to the run's move ledger and
takes the last cause-bearing entry for the game. On this corpus that is
`global-reoptimisation`, with no reason codes at all, which is the honest answer:
nothing forced these four games out individually, a whole-season re-place did.
"No constraint decided this" and "nobody recorded what decided this" must not
look the same, so the record says which.

The test runs both paths — the harness's incident-10 case, and a real
`applyChangeRequest()` that strands a game on Summit HS's 09/19 permit blackout,
which the corpus supplies.

### Why the exports are not rewired

`generateScheduleExports()` (`packages/core/src/outputGeneration.js`) requires a
truthy `homeTeamId` **and** `awayTeamId`, requires both to resolve in the team
directory, requires truthy `start` and `end`, and normalises both through
`new Date(value)`. Every one of those is a wall an unnamed fixture or a `TIME
TBD` row hits by construction. Relaxing four validators and a date normaliser
inside a function the shipping app already calls is not a small additive change,
so `publication.js` emits rows in that function's **own column vocabulary**
instead — `SCHEDULE_EXPORT_HEADERS` and `SCHEDULE_EXPORT_COLUMNS` are now
exported from it, and `generateScheduleExports()` uses the same constant, so the
two cannot drift into two spellings of "Event Type". The wiring itself is
follow-up; see GAP-16, GAP-17 and GAP-28 in [`MODEL_GAPS.md`](MODEL_GAPS.md).

---

## 5. Reserve capacity

> *"Per-date reserved capacity against a stated requirement, e.g. 'every Saturday
> from 09/12 must hold all 14 teams if the league sends them all home.' Report
> slots reserved / assigned / spare / meets-requirement, and which constraint
> caps the number."*

### 5.1 Where every number comes from

| number | decided by |
| --- | --- |
| is this kickoff legal here on this date | `availability/kickoff.js` — `checkKickoffAvailability()` |
| which of the four edges bounds it, and by how much | the same call's `bindingKinds` / `slackMinutes`, ordered by `orderByTightness()` |
| how long 11v11 occupies the ground | `timing/` — 90 minutes, because `game_formats.csv` says `85-90 (schedule as 90)` |
| how far apart two kickoffs on one field must be | the same table's `blockMinutes` — 120 |
| does this ground overlap other ground | `facility/occupancy.js` — `surfacesConflict()` |
| which registry constraint claims a blocking code | `resolve/errors.js` — `registryConstraintIdsFor()` |

`capacity.js` re-implements none of them. What it adds is the counting.

### 5.2 Two choices that change the numbers

1. **Candidates are judged with no existing bookings.** Capacity asks how many
   slots a date *could* hold, not how many are free after the club filled some
   in. What is already reserved is reported as `reserved` / `spare`; what stands
   on *overlapping* ground is reported through the condition. Feeding the
   reservations back in as occupancy would make a fully booked date's capacity
   zero.

   That holds for the **same** ground only. A condition names *other*,
   overlapping surfaces, and held ground standing there is exactly what it asks
   about (GAP-17), so every reservation stays in the bookings a condition is
   judged against. A candidate cannot block itself, and that is structural
   rather than filtered: `conditionForSurface()` never names the surface its own
   slot stands on, so nothing standing there is watched at all. Ignoring every
   reservation instead would mean a reservation could never block a conditional
   slot, which is most of what a conditional slot is for.
2. **The grid is anchored at a stated first kickoff, not at the permit open.**
   Five venues open at 07:00 and the club does not play at 07:00.
   `earliestKickoffMinutes` is a required input with no default, and the model
   **proves** the anchor rather than assuming it: every one of the 100 published
   reservations must land on a generated slot or the date reports
   `RESERVED_SLOT_OFF_GRID` at `blocking`. All 100 do. Raising the anchor to
   09:00 leaves 94 of them off the grid, which is the positive control.

   That guarantee needs both of its halves. `RESERVED_SLOT_OFF_GRID` catches a
   reservation misplaced in **time**; `RESERVED_SLOT_UNCOVERED` catches one
   misplaced in **space** — a slot standing on a surface, or a date, the report
   does not cover. Without the second, a slot outside the reported surfaces was
   filtered out before any count or check saw it, so an eleventh reservation on
   ground the report did not cover left its date reading `reserved: 10,
   atCap: true` rather than over its cap: a commitment vanishing without a word,
   which is exactly what Phase 5 exists to prevent. A slot on a covered date is
   still counted against that date's cap — the cap is a rule about how many games
   a day carries, not about where they stand — and one on an uncovered date has
   no row to be counted on, which its finding states in `countedOnDate`.

   Every reserved slot handed in therefore lands in exactly one of four buckets,
   and the counters name it:
   `slotsOtherFormat + reservedSlotsUncovered + reservedSlotsMatched +
   reservedSlotsOffGrid === slotsExamined`. On this corpus that reads
   `1 + 0 + 100 + 0 === 101`; the one is the `Scrimmage` reservation, which is
   held ground rather than a game of the format being counted, and it is a number
   rather than a silence for that reason.

The candidate loop stops at the first rejection. That is sound rather than an
optimisation: with no bookings in play, permit close, lights-off and the daylight
limit are all monotone in the kickoff. The rejected candidate is kept, because it
is what names the capping constraint.

### 5.3 The figures this corpus produces

Requirement: **14** — the number of Select teams on `coach_roster.csv`, derived
rather than typed, and enumerated from the roster rather than the fixtures
(`16BSelect02` is on the roster and appears in no fixture at all, so a
fixture-derived requirement would quietly be one team short).

Cap: **10** — the external league's rule. A policy input, recorded with its
provenance, and checked against the corpus rather than derived from it.

| date | Alder P2 (cond) | Alder P3 (cond) | Riverbend Turf | Summit Stadium | slots | reserved | spare |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 09/12 | 6 | 6 | 5 | **3** | **20** | 10 | 10 |
| 09/19 | 6 | 6 | 5 | **0** | **17** | 10 | 7 |
| 09/26 – 11/14 (8 dates) | 6 | 6 | 5 | 2 | **19** | 10 | 9 |

**17–20 slots per week**, every date at the 10-game cap, nothing assigned —
the league had not published its picks, which is why these rows exist at all.
(Before the owner's decision of 2026-11-02 the report said 14–18: sunset bounded
the unlit surfaces and trimmed the two November dates to the bare minimum. See
"Sunset only warns" below.)

- **09/12 is the maximum** because Summit HS's permit opens at 14:00 that day
  instead of 17:00 — the date-scoped exception, read by the availability
  calendar. Three slots instead of two.
- **09/19 is 17** because Summit HS has **no permit at all** that date. The
  stadium contributes zero and is `cappedBy: permit`.
- **Sunset only warns.** Owner, 2026-11-02: "Yes to legal-with-a-warning for
  kickoffs after sunset, because some orgs have portable lighting or other
  workarounds." A kickoff that ends inside the club's 15-minute daylight margin is
  a legal slot that carries `SUNSET_MARGIN_VIOLATED` as a compromise, so it is
  counted. What stops a day's slots is the permit close (and a lights-off time,
  where one is recorded). Every surface on every date is `cappedBy: permit`, and no
  date is at the bare minimum: the 11/07 and 11/14 dates, which carry the earliest
  sunsets of the season, hold the same 19 slots as the other Saturdays.

**The warning is kept.** Counting a past-sunset slot must not hide it: each surface row carries
`sunsetWarnedKickoffMinutes` (the slots that end after the daylight limit, a subset of `kickoffMinutes`) and
`sunsetWarnedSlots`, each date carries `sunsetWarnedSlots`, and the report carries the total. On this corpus 26 of the
189 slots need a lighting workaround (Alder P2 and P3 lose their last slot of each date to it, 2 a date before November and
5 on 11/07 and 11/14, when Riverbend's last slot joins); the other 163 are daylight capacity, which is the figure the report
gave before the decision. The status is not changed by it.

The test derives every one of these counts independently, from the permit rows
and the format's timing (`tests/helpers/reserveOracle.js`), and checks the report
against them, so a regression in either direction is a disagreement rather than a
number that moved.

### 5.4 The number the tab does not show

`slots` counts conditional ground as an asset. `available` evaluates the
conditions against what is standing, and the two differ on seven of the ten
dates, because the rec layer occupies Alder Pitch 1A/1B on every rec Saturday and
Pitch 2 therefore is not free at those hours:

| date | slots | available |
| --- | --- | --- |
| 09/12 | 20 | 17 |
| 09/19 | 17 | 13 |
| 09/26 | 19 | 15 |
| 10/03 | 19 | 15 |
| 10/10 | 19 | **19** (no rec games) |
| 10/17 | 19 | 15 |
| 10/24 | 19 | 16 |
| 10/31 | 19 | 15 |
| 11/07 | 19 | **19** |
| 11/14 | 19 | **19** |

One date, 09/19, clears the requirement on `slots` and fails it on `available`,
which is `RESERVE_CAPACITY_CONDITIONAL_SHORTFALL` at `compromise` (it fell short
by one: Summit's blackout takes the stadium's three slots away and the rec layer
blocks four conditional ones). It is the same declared-versus-enforced gap this
repository keeps finding: a capacity tab that counts conditional ground as free is
reporting a number nobody can use. Both columns are in the report; neither is
hidden behind the other. (Before 2026-11-02 five dates failed it. The number of
conditional slots the rec layer blocks did not move on any date; the later slots
sunset used to remove are never blocked by it, so `available` rose by as many as
`slots` did.)

---

## 6. What this module deliberately is not

- **Not a solver.** Nothing here places a game.
- **Not a second evaluator.** No overlap test, no permit reading, no occupancy
  arithmetic, no tightness comparison.
- **Not persisted.** Phase 5 is in-memory only.
- **Not wired into the shipping exports.** See §4.

## 7. Reason codes

Thirty-two, in one frozen table with one severity each, and
`tests/reserveCapacity.test.js` asserts that **every one of them is actually
emitted somewhere in the suite** — a code a module can declare but never produce
is a code nothing proves the meaning of. Adding a temporary code with no case
makes that assertion fail, which is how it was checked.
