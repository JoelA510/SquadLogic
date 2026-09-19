# Phase 8 — the plan ahead

Continues [`BUILD_PLAN_STATUS.md`](BUILD_PLAN_STATUS.md), which closed prompts
0.1–7.3. Each task below carries a prompt written to be handed to a sub-agent
whole. They are ordered; later ones name what they depend on.

Every prompt inherits the working conventions in [`../CLAUDE.md`](../CLAUDE.md)
§3 and the ones §4 of `BUILD_PLAN_STATUS.md` records as having earned their
keep — pure JS, `.strict()` Zod, frozen severity tables, findings as a list,
`meta` counters, a single producer for any derived status, minutes past
midnight, `YYYY-MM-DD`, and **no `Date` construction**.

---

## The decision that gates everything from 8.5 onward

There are two schedulers in this repo and they do not meet:

|                         | Games engine (0.1–7.3)                              | Shipped MVP path                |
| ----------------------- | --------------------------------------------------- | ------------------------------- |
| Size                    | 161 files, 58,199 lines                             | 2,218 lines across four modules |
| Tests                   | 2,165                                               | ~35                             |
| Practices               | none                                                | all of them                     |
| Imported by `frontend/` | **zero modules**                                    | 17 modules                      |
| Persisted               | no — every snapshot emits `SNAPSHOT_IN_MEMORY_ONLY` | yes                             |

Tasks 8.0–8.4 are worth doing under either answer — 8.4 in particular is
app-side and therefore lands on the half users can already reach. From 8.5 the work
either extends an engine nobody can reach, or moves the engine under the app.
**Decide before 8.5**, and record the decision in `BUILD_PLAN_STATUS.md`.

Two open items from §3 are really this decision in disguise: _"Nothing is
persisted"_ and _"Nothing is wired into the shipping app"_. This paragraph used
to add that GAP-30 (`z.coerce.date()` in `SlotSchema`/`AssignmentSchema`) must
close before any snapshot persists, or the parity checker causes the divergence
it detects. **GAP-30 closed on 2026-09-19** (#396, #398, #400): `InstantSchema`
replaced the coercion and refuses a zoneless timestamp, `season_settings.timezone`
has a writer, and `calendar-feed` composes through the season clock — verified by
execution, see [`BUILD_PLAN_STATUS.md`](BUILD_PLAN_STATUS.md) §7. **So nothing
now blocks a snapshot from persisting except that no store has been built.** The
remaining precondition is GAP-29, which was narrowed the same day to the
published baseline, with freeze plans, resolve runs and scenarios split out as
[GAP-35](MODEL_GAPS.md#gap-35).

---

## 8.0 — Corpus loader and integrity test

**Depends on:** nothing. **Everything else asserts against this.**

```
Add a fixture loader and integrity test for fixtures/season-2026/practice/,
mirroring what packages/core/src/fixtures/ and tests/ already do for the game
corpus.

Parse all seven files into typed records with .strict() Zod schemas. Assert
every invariant the corpus README states, and make each assertion prove it
examined non-zero records — a check that matches nothing is a loud failure,
never a silent pass.

The invariants, from fixtures/season-2026/practice/README.md:
- 457 practice rows across 7 source sheets; 88 distinct teams hold a slot.
- Exactly one practice team (16BSelect02) plays no game in
  ../combined_schedule.csv.
- Two slot regimes and no third: 45 min at 16:00/16:45/17:30, 60 min at
  16:00/17:00/18:00.
- 19 Friday rows.
- 201 coach registrations, 19 naming a second player.
- 1153 players, 29 playing up.
- 13 constraint rows; 3 venues closed effectively all season.
- 4 permits and 767 reservation windows, 2026-08-10 to 2026-12-20.
- 14 venue inventory rows, 27 field code names, 42 weekly availability rows.
- The two decoder rings share 20 codes and disagree on exactly 12 of them.
  Assert the disagreement rather than resolving it; a run that finds fewer than
  12 has silently reconciled something.

Add cross-corpus assertions the README does not state but the join implies:
every team_code in practice_grid.csv resolves in the game corpus except the one
named above; every person_key in coach_registration.csv and select_coaches.csv
is either in ../coach_roster.csv or minted (assert which, do not assume).

Report the 28 rows carrying venue = "(unresolved)" as a named finding rather
than filtering them out. Do the same for every
field_weekly_availability.csv row whose interpretation is
"excel-date-corruption" or "unparsed": the raw value is retained beside the
interpretation precisely so a later reader can overrule it.
```

---

## 8.1 — Two live defects on the shipped practice path

**Depends on:** nothing. Small, independent, on code families actually use.

```
Fix two defects in the shipped practice scheduler. Minimal diffs; do not
refactor around them.

1. Assistant coaches are invisible to the practice conflict check.
   packages/core/src/practiceScheduling.js and autoScheduler.js check coach
   double-booking against team.coachId only. teams.assistant_coach_ids never
   enters the check. The season-2026 corpus has 215 assignments across 132
   teams and 196 people, so roughly 83 co-coach assignments are unseen.
   Make the conflict check consult every coach on a team. Add a test that
   fails before the fix: two teams sharing an assistant coach, scheduled into
   overlapping slots, must be reported as a conflict.

2. packages/core/src/practiceSlotExpansion.js:13 claims it produces slots that
   "account for daylight adjustments". The file contains no sunset, daylight or
   lighting reference and takes no such input. Either implement it or correct
   the docstring — correcting it is in scope here, implementing it is 8.9.
   Whichever you choose, say so in the commit.

Also raise, without fixing: supabase/migrations/20260331000000_definitive_schema.sql
constrains practice_slots.day_of_week to ('mon','tue','wed','thu'), but
fixtures/season-2026/practice/practice_grid.csv has 19 Friday rows. The
schema forbids a slot the league actually runs. A migration is its own PR.
```

---

## 8.2 — One coach model, and counts that name their unit

**Depends on:** 8.0. Cheap, and both errors it fixes reached people outside the club.

```
Two model corrections.

1. Reconcile the two coach models. packages/core/src/people/ orders coaches by
   an integer slot (slot 1 is primary, duplicates blocking) and uses it only to
   break clashes — that design is defended in roster.js and should survive. The
   legacy path (teams.coach_id + assistant_coach_ids[], and the frontend's
   headCoach / assistantCoaches) renders order AS A ROLE, and the frontend has
   no knowledge of slot at all.
   Keep slot as the clash-breaker. Stop rendering it as a role. Export every
   coach on every artifact. Where two sources disagree about who is primary,
   surface the disagreement rather than picking one — availability/ already has
   this shape in LIGHTING_SOURCE_DISAGREES; follow it.
   Note the tension before you start: fixtures/season-2026/README.md says
   "Coach Slot 1 = the team's primary coach", which contradicts the claim that
   the league does not recognise head vs assistant for rec. Resolve it with the
   operator, in the PR description, before changing any rendering.

2. Every exposed count must name its unit. fairness/ already distinguishes
   fixturesRead / fixturesCounted / fixturesPlaceholder and a three-valued
   subject kind; gameMetrics.js and practiceMetrics.js carry no unit label at
   all. Add the missing axis: rostered team vs schedulable entity vs slot-unit
   (for practices: team, practice group, field-hour). A report that says "132"
   must say 132 of what.

Acceptance: every artifact lists all coaches per team, zero teams truncated
against the corpus roster; a team whose sources disagree on coach order is
surfaced; every count in every report names its unit.
```

---

## 8.3 — The practice facility graph

**Depends on:** 8.0. This is where the new corpus pays for itself.

```
Extend packages/core/src/facility/ to hold the practice layer, and reconcile
the constraint log with it.

Three things the game layer does not model, all evidenced in
fixtures/season-2026/practice/:

1. A level below the game halves. Games use Alder Park / Pitch 2 and Pitch 3
   whole. Practices split both into 2A/2B and 3A/3B, and split Pitch 1A, 1B, 4A
   and 4B again into "Side 1". The existing containment forest and the bipartite
   overlapPairs relation in facility/occupancy.js are the right shape — extend
   the tree, do not flatten it. The property to preserve: two practices on 2A
   and 2B do not conflict, and a game on Pitch 2 excludes both.

2. The published field name is not the field.
   practice_field_aliases.csv maps "Junior Field 1" to Maplewood Field 1.
   Model the alias as a display layer over a surface id. Any conflict check
   that reasons over the published name is checking the wrong ground; add a
   test that would catch exactly that.

3. field_constraints.csv is a second source of ground truth about availability
   and nothing reconciles it with the facility graph today. Ingest it as
   availability windows (it has date bounds, time bounds, venue, fields and a
   reason). Its "Fields 1&2 or 3&4 may not run concurrently" row is the same
   adjacency the graph already carries as overlap pairs — assert they agree
   rather than encoding it twice.

Acceptance test, from the corpus: the alias "7v7 Field 1" resolves to
Cedarbrook Park, which field_constraints.csv declares Offline from 2026-08-01
to 2026-11-28. A practice booked there must be reported, with the constraint
named. Eight further aliases resolve to Maplewood, closed 2026-10-23; those
must be reported for that date and not for others.
```

---

## 8.4 — Field and blackout administration: import, export, CRUD

**Depends on:** 8.3. This is the task that makes the rest maintainable by the
club rather than by whoever last edited a spreadsheet.

```
Make fields and their blackout windows a first-class, editable domain object
with a round trip, and expose it in the app.

Today the ground truth is four working sheets and four PDF permits that nobody
reconciles: fixtures/season-2026/practice/ now holds all of them, and its README
records that the club's two decoder rings disagree on 12 of the 20 field codes
they share, that one branch of that disagreement points at a venue closed for
the whole season, and that a working sheet's own availability cells were
corrupted by Excel into dates.

Three capabilities, in this order:

1. IMPORT. Parse each source into the domain model: permits.csv and
   permit_reservations.csv into availability windows; field_inventory.csv and
   field_equipment.csv into surface attributes; field_weekly_availability.csv
   into recurring windows; field_constraints.csv into blackouts; both decoder
   rings into the alias layer from 8.3.
   Import must be non-destructive and reviewable: produce a proposed change set
   against current state, with per-row disposition (new / unchanged / differing
   / unresolvable) and a reason. Never apply silently. Where two sources
   disagree, surface BOTH and refuse to pick — publication/parity.js already
   has the partitioning shape (matched / differing / added / removed); reuse it
   rather than inventing a second vocabulary.
   Preserve the raw cell beside every interpretation, as
   field_weekly_availability.csv does with raw_value / interpreted_window /
   interpretation. An operator must be able to see what the sheet said and why
   the importer read it that way. This is the single most important property
   for troubleshooting a bad import later.

2. EXPORT. The same model back out to CSV, byte-stable and re-importable, so an
   export → import round trip is the identity. Assert that as a test on the
   committed fixtures. externalImport/mapping.js already has the seam shape
   (serialiseExternalMappingRegistry / readExternalMappingRegistry, byte-
   identical round trip asserted) — follow it.

3. CRUD in the app. Add, edit and retire venues, surfaces and sub-surfaces, and
   add, edit and remove blackout windows (a date or date range, a time range or
   all-day, a reason, and a source). Retire is an END DATE, never a delete —
   surfaces are not effective-dated today (facility/schemas.js carries no date
   fields at all) and 8.8 needs them to be. Do that here rather than twice.
   Every mutation writes an audit_log entry with before and after. Every
   mutation that would invalidate an existing booking shows the consequence
   BEFORE commit: which games and practices are affected and what the repair
   from 8.6 proposes.

Constraints that are not negotiable:
- All persistence through dedicated RPCs and Zod-validated, per CLAUDE.md.
- RLS on every new table; blackouts and permits are organisation-scoped.
- WCAG 2.2 AA on the new UI: the blackout editor is a date/time form, so label
  every field, make the calendar keyboard-operable, and give a non-drag path to
  anything draggable.
- Reuse the design system. No new colours, radii or spacings.

Acceptance:
- Importing fixtures/season-2026/practice/ produces a change set that names all
  12 decoder-ring disagreements as `differing` and applies none of them.
- The Excel-corrupted availability rows import with their raw value intact and
  are flagged for review, not silently accepted.
- Export then import is the identity on the committed fixtures.
- Retiring a surface that hosts a booked practice is refused with the list of
  affected bookings, and succeeds with an end date once the operator confirms.
- A blackout added through the UI makes the affected games and practices show
  as conflicts, and removing it clears them.
```

---

## 8.5 — Recurring practice slots

**Depends on:** 8.3, and the wiring decision above.

```
Add a recurring PracticeSlot model to packages/core/src/.

A slot is: team(s), surface (a facility-graph id, at the depth 8.3 added),
day-of-week, start, duration, and an effective date range. A team's practice
history is a sequence of non-overlapping ranges, not a mutable row. Materialise
to concrete dates on demand; never store per-date rows as truth. Dated
exceptions (holiday, closure, rain-out) are overrides on the slot, not edits.

Read the storage that already exists before designing: practice_slots already
has field_subunit_id, day_of_week, start_time, end_time, capacity, valid_from
and valid_until, and practice_assignments already has an effective_date_range
daterange. Most of the model is in the database. Say in the PR what is genuinely
new versus what only needed lifting into the domain layer.

Two hazards, both real:
- practice_assignments carries slot_id AND practice_slot_id plus denormalised
  day_of_week / start_time / end_time / field_id beside the FK. The frontend
  reads five spellings of the same field. Do not propagate that; state whether
  you are fixing it or working around it.
- packages/core/src/utils/date.js applyMinutesToDate() uses setUTCHours, so a
  17:00 practice is 17:00 UTC, while practiceScheduling.js interprets instants
  as America/Los_Angeles (see the comment in tests/practiceSchedulingTimezone.js
  about CI at UTC filtering both slots). This new model uses minutes past
  midnight and YYYY-MM-DD and constructs no Date. Name the seam you are
  crossing and where the conversion lives.

Acceptance: a team's season history exports as a readable phase list; a slot
materialises to the right dates across a month; an exception on one date
removes that occurrence and no other.
```

---

## 8.6 — Bounded local repair

**Depends on:** 8.5 for the practice side; the game side can start earlier.

```
Make repair local and cost-bounded, and route every mid-season change through it.

Read resolve/stages.js chooseSlot() first — most of the operator already exists.
It orders candidates by ascending change cost and rejects any that grows a
blocking-code count. Three things are missing or wrong, and the prompt is those
three, not a rewrite:

1. It is keyed per GAME, not per violation. Two violations sharing an entity
   should be fixable by one move; today each game is considered alone.
2. It takes the BEST admitted candidate, not the first. Under default weights
   two short-circuits make it behave like first-fit; that is an accident of the
   weights, not a property.
3. The change budget does not bound the search. report.js:421 checks it after
   the fact and commit.js:104 throws at commit. A run that would move 40 games
   moves 40, builds the whole report, and is refused. Make the budget bound the
   neighbourhood.

Add published-time hold as a TRACKED METRIC, not just behaviour. Today the hold
exists as the anchor and the never-move-a-legal-game rule, and nothing counts
games that kept their published kickoff.

Then point it at the practice optimizer, which is where the roaming actually
happens: autoScheduler.js is hill-climbing with random restarts, zero churn
awareness, and no notion of a published time. Its swap/relocate/chain-swap
mutations are exactly the search that a bounded operator should replace.

Acceptance: a field lost mid-season displaces N practice slots; the repair
re-homes them with the minimum number of published-time changes, reports any it
cannot place as TIME TBD with a reason, and leaves every tracked metric
unchanged or better. Never silently drop an unplaceable slot.
```

---

## 8.7 — Move-request analysis

**Depends on:** 8.3. The most-repeated manual computation in the club's season.

```
Add analyseMoveRequest(entity, targetWindow) as a read-only query over both
games and practices.

feasibility/ already answers a related but narrower question: canGameMove()
takes ONE named destination, canTeamPlay() gives a dates × surfaces grid at one
caller-supplied kickoff, feasibleKickoffBounds() returns a boundary. None of
them enumerates open positions, and nothing anywhere in packages/core computes
a two-sided swap.

Return four things and a classification:
- feasible slots given the entity's own commitments and travel
- vacancies among them — reserve/capacity.js already computes spare ground;
  join to it rather than recomputing
- admissible swaps, legal for BOTH parties
- per-swap counterparty cost: which objective the other party currently
  satisfies and would lose

Classify: vacancy_available | free_swap_available | zero_sum_only | infeasible.
The class is what determines what the club can say, so it must be derived
mechanically by a single producer, not assembled by callers.

Keep feasibility/'s existing three-valued verdict and tightness; this is a new
question, not a replacement.

Acceptance: an entity whose every feasible slot is occupied by holders who all
rely on theirs for the same objective classifies zero_sum_only, and the answer
names the count. An entity with free end-of-day slots at no counterparty cost
classifies vacancy_available.
```

---

## 8.8 — Changelog, notification state, and entity lifecycle

**Depends on:** the wiring decision, and 8.5. The largest task here.

```
Add an append-only changelog and effective-dated lifecycle.

What exists: publication/ has immutable point-in-time snapshots, a parity
comparator over two row sets, and buildChangeNotices() which composes what to
say. What does not exist: any log, any ordering of snapshots, any per-entity
history, and any record of whether a notice was sent.

What NOT to invent: resolve/ already carries a richer causal taxonomy than the
four kinds usually proposed — ConsequentialChange has causeKind, constraintIds,
bindingKinds, slackMinutes, forcedByStageId, and RequestedChange has an outcome
of applied | displaced | refused | no-op | unplaced. It is discarded with the
run. Persist that rather than designing a parallel vocabulary.

Add: reason (required, not nullable as ScheduleChangeRequestSchema has it),
requester, approver, and notification state — who was told, when, by what
channel, and whether it is outstanding. The outstanding-notification report is
the list the scheduler actually works from; it is the point of this task.

Lifecycle: coaches, fields and teams carry effective ranges. people/ already
has effectiveFrom / effectiveTo on assignments, applies them via asOf, and
reports ASSIGNMENT_WINDOW_UNJUDGED at compromise when asOf is omitted — but the
adapter hardcodes both to null, and facility surfaces and TeamSchema have no
dates at all. Close those two gaps. "Remove coach" becomes an end-date.

Every lifecycle event produces a consequence report BEFORE commit: which teams
drop to a single coach (soleCoachRiskRegister already derives this), which
conflict checks change, which slots are displaced with the 8.6 repair proposal,
and what cannot be re-homed.

Acceptance: ending a coach's assignment on a date leaves "who coached this team
three weeks earlier" answerable, and flags the team sole-coach from that date;
a field lost produces a repair proposal, a list of families to notify, and zero
silent changes to any other team's slot; fixtures/season-2026/practice/
game_change_log.csv's 167 rows load and classify.
```

---

## 8.9 — Season phases, sunset, and the DST cliff

**Depends on:** 8.5. **Blocked on data — do not start without it.**

```
BLOCKED. Before any code: obtain weekday sunset values for the club's location
across the season.

fixtures/season-2026/sunsets.csv has 13 rows and every one is a Saturday — it
is a game-day table. Practices run Monday to Friday. The transition dates this
task is supposed to derive cannot be computed from the data in the repo. Either
extend the table with weekday values from the same source the club used, or
decide (and record) that interpolation between Saturdays is acceptable and what
its error bound is.

Do NOT take sunset values from any planning document that disagrees with
sunsets.csv. The corpus is authoritative because the season was built against
it. A table that disagrees by more than the 15-minute safety margin can flip
legality, and at least one circulating table disagrees by up to 16 minutes.

Then:

1. A DurationPhase schedule: an ordered list of (effective_from, duration) with
   an adjustable number of phases. Derive each transition from the sunset table
   plus the club's margin — the first date the last unlit slot's end would
   exceed sunset less margin at the current duration — and show the derivation.
   Allow override. Note that the corpus practice grid shows NO seasonal
   shortening: two fixed regimes, 45 and 60 minutes. Whatever the club does is
   not recorded there, so confirm the pattern before encoding it.

2. Support both compression strategies and report per slot which stay legal:
   hold starts and shorten ends (flagging any slot still ending past sunset), or
   cascade so each slot starts when the previous ends (every start moves, which
   is a published-time change and must route through 8.8's changelog).

3. Model DST-end as a named season event. The model today is DST-safe by
   construction — clock-free, minutes past midnight, no Date — but DST-blind:
   sunsets.csv carries the note "DST ends 11/01" in a column that is parsed into
   the schema and read by nothing, and nothing detects the 75-minute drop
   between 10/31 (5:59 PM) and 11/07 (4:44 PM). For every unlit slot, report
   whether it survives that date at any phase duration, and if not, what would
   fix it: a lit field, an earlier start, or a different night.

Lighting is already modelled: availability/ resolves per-surface lit and
lightsOffMinutes with provenance codes, falling back to venue level for every
field in this corpus (GAP-05). Use it; do not add a second lighting source.
```

---

## 8.10 — Reply context

**Depends on:** 8.7, and 8.8 for the notice half. Build last; it is presentation
over queries that must exist first.

```
Add a reply-context API returning, as structured data, everything needed to
answer a scheduling question about one entity: its own times and gaps, the
binding constraint with its computed value AND ITS KIND, the full
analyseMoveRequest result, the alternatives that exist right now and what each
means for this entity, and any standing policy that applies.

The kinds must distinguish four things that attribution/ today distinguishes
only three of. It has 'sunset' and 'occupancy' (field already booked) as
first-class kinds, and publishes the arithmetic as numbers across three sources
(coach-travel gapMinutes / minimumGapMinutes, availability occupancyMinutes and
limitMinutes, warm-up warmupMinutes) without a unified identifier. It has NO
kind for "there is no supply in this window" — NO_LEGAL_KICKOFF means the
searched range was exhausted and ATTRIBUTION_BOUND_UNSTATED means nothing bound
it at all. Add that kind.

This matters because attributing a bound to the wrong kind is a real, recorded
failure: a coach was told his cutoff followed from arrival plus duration plus
buffer plus travel, checked the arithmetic, and was right — the true bound was
that supply stopped for 90 minutes. Same recommendation, different constraint,
and the wrong attribution invites correction from anyone who checks.

Support saved response policies so identical situations yield identical
commitments, and generate both a season-opening phase notice per team and an
individual change notice per changelog entry.

Acceptance: for an entity whose binding reason is a supply gap, the answer names
the gap and NOT an arithmetic travel calculation, and the arithmetic bound is
present and separately identified.
```

---

## Carried forward from `BUILD_PLAN_STATUS.md` §3

These stay open and are not superseded by anything above. Fold them into
whichever task touches their module rather than scheduling them separately:

- 11 unreachable reason codes, each named with a reason; the audit header is a
  checked claim.
- Four call sites still drop the severity-seam report.
- `resolve/stages.js` reads neither half of the registry trace — a stated bound,
  not an oversight.
- `attribution/minimal.js` does not surface the trace at either call site.
- The three capacity codes are readable only on `capacities` and nothing reads
  them — same shape as the inert-field defect, one level down.
- `conflictFairnessRule`'s undecidable pairs do not reach `violations`.
- `reserve/conditions.js` answers `null` for ground the graph does not hold.
- The `underRegistry()` seam is triplicated across attribution, feasibility and
  resolve.
- ~44 markdown files fail `prettier --check` at baseline.
- A standing warm-up rule ships empty, so a season run does not check it.
- `coach-maximum-gap` is still `RULE_CONSTRAINT_UNENFORCED`.
- Division is still a label, not a key (GAP-24) — this one bites 8.2 directly.
- Promote `NOTICE_PARITY_VACUOUS` / `NOTICE_LABEL_AMBIGUOUS` to first-class.
- The external-import impact analysis consults two layers and names the five it
  does not.
