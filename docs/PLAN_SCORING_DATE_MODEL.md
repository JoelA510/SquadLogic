# Plan: M4.7, a date model for the practice scoring engines

Status: **AWAITING THE OWNER'S APPROVAL (2026-10-13).** Docs only; no code
changes. Remediation plan item M4.7
(`docs/audits/2026-10-production-readiness/remediation-plan.md`). CLAUDE.md
requires a plan the owner approves before any change to the domain model, so
nothing below is built until §12's questions are answered.

Evidence labels, per CLAUDE.md: _read_ (statically reviewed), _executed_ (run,
output quoted), _test-verified_ (a committed test asserts it). Everything in §1
is _read_ on `main` at `64bd751` unless marked otherwise; line numbers are from
that commit.

---

## 0. Headline

Both practice scoring engines reduce a weekly practice slot to **one instant**:
the first occurrence of its weekday on or after the slot's `valid_from`. They
compare those instants and ignore every date range the data carries. So:

- **False conflicts.** Two series of one coach on the same weekday and time
  are reported as a clash even when their date ranges never meet. Writer v3
  keeps closed series in the season, and #546's override closes the old series
  and starts a new one, so this is the normal shape after any mid-season change.
  On the corpus, modelling the club's real plan revision ("Select OLD" closed,
  "93 Combined" from 2026-10-05), the engines report **11 coach conflicts where
  1 is real**, and the Edge's fairness score falls from 0.68 to **0** (§2).
- **Missed conflicts.** Two slots on the same weekday and time whose
  `valid_from` differ have first occurrences in different weeks, so they never
  overlap. On the corpus, re-creating one slot valid from 2026-09-14 (what a
  field's effective-dating split does) makes the plan's one real conflict, which
  falls on 10 Fridays, **disappear** from both engines (§2).
- **False overbooking.** A closed series and its successor on one slot count
  twice against its capacity.

Both engines agree with each other in every case measured: the defect is shared,
not drift, so M1.2's parity test cannot see it.

The proposal (§3): compare **dated occurrences**. An assignment is live on the
dates of its slot's weekday inside (its own range ∩ the slot's validity). Two
assignments clash when they share a coach, share a live date, and their wall
windows overlap. Capacity is judged per date. The same rule goes into
`packages/core/src/practiceMetrics.js` and
`supabase/functions/_shared/engines/scoring-engine.ts`, held together by M1.2's
parity check extended with a dated extract, and into the override panel's
per-slot count. On the corpus's undated plan the change is behaviour-neutral
(executed with an oracle, §2.3), so the existing parity extract stays as it is.

Production holds **no** practice slots, assignments or exceptions today
(_executed_, §2.4), so no live schedule is affected either way and nothing needs
a backfill.

---

## 1. What exists today (_read_)

### 1.1 Which inputs carry dates

| Input                                   | Date fields                                                                              | Where                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `practice_slots` row                    | `valid_from`, `valid_until` (`date`, both nullable)                                      | `supabase/migrations/20260331000000_definitive_schema.sql:496-511`             |
| A slot as the page holds it             | `effectiveFrom`/`effectiveUntil` (null falls back to the season's start/end)             | `PracticeSchedulingPage.jsx:179-208` `normalizePracticeSlot`                   |
| `practice_assignments` row (a "series") | `effective_date_range` (`daterange`; Postgres canonical `[from, until+1)`)               | `20260331000000_definitive_schema.sql:522-536`                                 |
| A new placement staged by the page      | `effectiveDateRange` = `[max(slot.validFrom, season today), slot.validUntil]`            | `PracticeSchedulingPage.jsx:394-402` `newPlacementRange`                       |
| A closed series (#541, #546)            | its range ends before its successor starts; kept in the season, sent by its key          | `PracticeSchedulingPage.jsx` staging, `docs/PLAN_GRID_OVERRIDE_PROMPT.md` §1.3 |
| `practice_exceptions` row               | `"window"` (`daterange`); `kind` `relocated` (moves to `practice_slot_id`) or `time_tbd` | `20260929000000_practice_writer_v3_lock_by_default.sql:106-146`                |
| The season                              | `season_start`, `season_end`, `timezone`                                                 | `season_settings`; read by the page (`getSeasonDateRange`, `:147-151`)         |

The season read the page evaluates (`loadSeasonPracticeAssignments`,
`packages/core/src/practiceSupabase.js:420-442`, via
`useSeasonPracticeAssignments`) has **no date filter**: every row of the season,
closed series included, with its `effectiveDateRange`.

There is already a dated reader of these rows, used by the portal, the feed and
the RSVP check: `practiceRangeBounds` and `practiceOccurrenceDates`
(`packages/core/src/utils/practiceOccurrences.js:101-113`, `:151-169`), with an
Edge twin `dateRangeBounds` (`supabase/functions/_shared/calendar/icsFeed.ts:398`),
and `applyPracticeExceptions` (`packages/core/src/utils/practiceExceptions.js:223`)
with its twin in `supabase/functions/_shared/calendar/practiceExceptions.ts:266`.
Both pairs are pinned equal by existing drift tests. CLAUDE.md: when a sibling
already handles an edge case, adopt its contract. §3 does.

### 1.2 What the engines do with them

**Nothing.** Each engine reads a slot as `{ id, day, capacity, start, end }` and
an assignment as `{ teamId, slotId }`:

- The page sends exactly that (`PracticeSchedulingPage.jsx:760-784`,
  `evaluationPracticeData`): each slot's `start`/`end` is its **first
  occurrence** (`getSlotDateForDay(effectiveFrom, day)`, `:191-196`), and each
  assignment loses its range.
- **Coach conflicts.** Core sorts each coach's assignments by `start` and
  reports every pair with `candidate.start < current.end`
  (`practiceMetrics.js:684-723`, the break at `:705`). The Edge does the same
  (`scoring-engine.ts:256-285`, the break at `:264`). Two first-occurrence
  instants in different weeks never overlap; two equal ones always do, whatever
  the series' ranges.
- **Capacity.** Both count every row naming the slot (`practiceMetrics.js:532-551`,
  `scoring-engine.ts:185-209`). A closed series and its successor are two.
- Neither engine reads `practice_exceptions`, so a relocated practice is judged
  at its original slot, and a TIME TBD window still counts.

### 1.3 Who reads those answers

| Consumer                                         | Path                                                                                                                                                                 | Shares the gap?                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `EvaluationPanel` (practice page)                | `evaluationPracticeData` → `fairness-scoring` → `scoring-engine.ts` (`EvaluationPanel.jsx:174`, `fairness-scoring/index.ts:135`)                                     | Yes: conflicts, utilisation, score                            |
| The auto-scheduler review                        | after a run the page shows season rows **plus** placements (`:694-725`); the panel evaluates them as above                                                           | Yes, the same path                                            |
| Apply-time metrics (persisted run results)       | `buildPracticeRunResults` → core `evaluatePracticeSchedule` (`:1229-1238`; `practiceRunResults.js:119`), shown by `PracticeReadinessPanel`                           | Yes                                                           |
| The override panel's "N free" per slot           | `overrideBaseSlots` counts every local row per slot (`:794-809`; `PracticeOverridePanel.jsx:161`)                                                                    | Yes: the backlog entry from #541 (`PHASE_8_PROGRESS.md:7797`) |
| The auto-scheduler's own score                   | `scoreSchedule` → `scoring-engine.ts` inside the hill climb (`auto-scheduler-solver.ts:224-253`), persisted as `edgeEvaluation`                                      | Yes, and it steers the search                                 |
| The auto-scheduler's hard constraints            | `checkHardConstraints` on first-occurrence windows (`practice-coaches.ts:138-152`); locked rows hold a slot season-long (`auto-scheduler-solver.ts:19-20`, declared) | Yes; it is the **solver** (§8, Q2)                            |
| Core `autoScheduler.js`, `evaluationPipeline.js` | core callers of `evaluatePracticeSchedule`; no frontend or Edge file imports either (_executed_ grep)                                                                | Inputs carry no dates; unaffected                             |

---

## 2. Measurement (_executed_)

### 2.1 Method

A scratch Vitest file (in the session scratchpad, copied into `tests/` only to
run and deleted after; not committed). It:

1. builds `practice_slots`-shaped rows and passes them through the page's own
   exported `partitionPracticeSlots`, then maps them exactly as
   `evaluationPracticeData` does, so the engines see what the panel sends;
2. runs **both** engines (core `evaluatePracticeSchedule`, and the Edge's
   `scoring-engine.ts` under Node, as `tests/scoringParity.test.js` does);
3. compares them with a **date-aware oracle** built on core's
   `practiceRangeBounds` and `practiceOccurrenceDates`: live dates are the
   slot's weekday inside (row range ∩ slot validity); a clash needs a shared
   coach, a shared live date and overlapping wall windows; capacity is the peak
   count on any one date.

Season for every case: 2026-08-10 to 2026-11-20 (the corpus permits' window at
Maplewood, `permit_reservations.csv`), zone `America/New_York`.

### 2.2 Witnesses (synthetic, smallest inputs)

| Case | Input                                                                                 | Engines report    | Oracle (truth)     | Both arms agree |
| ---- | ------------------------------------------------------------------------------------- | ----------------- | ------------------ | --------------- |
| W1   | One team moved to another field, same Tue 16:00: old series to 10-04, new from 10-05  | 1 conflict        | 0                  | yes             |
| W2   | Two teams sharing a coach, Tue 16:00 and 16:30, ranges to 09-28 and from 09-29        | 1 conflict        | 0                  | yes             |
| W2b  | As W2 but both include Tue 09-29 (touching on one date)                               | 1 conflict        | 1 (one date)       | yes             |
| W3   | Closed series and its successor on one Wed slot, capacity 1                           | 1 slot overbooked | 0                  | yes             |
| W4   | Two Tue 16:00 slots, one valid from 09-01; one coach on both, season-long             | 0 conflicts       | **1, on 12 dates** | yes             |
| W5   | Two Thu 16:00 slots with `valid_from`/`valid_until` null (season fallback); one coach | 1 conflict        | 1                  | yes             |

W1-W4 are the defect. W2b and W5 show the oracle is not "fewer conflicts"
by construction: it keeps a one-date clash and the season fallback.

### 2.3 The season-2026 corpus

The corpus practice plan (`fixtures/season-2026/practice/practice_grid.csv`) is
a **weekly** plan with no dates, in seven revisions whose order the source does
not state (its README, point 4). So the corpus cannot show the defect on its own;
C1, C2 and C4 add one stated modelling assumption each.

| Case | Input                                                                                                                         | Engines report | Truth | False | Missed | Edge `fairnessScore` today → true |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- | ----- | ------ | --------------------------------- |
| C0   | "93 Combined" (142 rows, 88 teams, full 132-team roster), every slot and row season-long: the M1.2 parity extract's shape     | 1              | 1     | 0     | 0      | 0.68 → 0.68                       |
| C1   | C0, plus "Select OLD" (28 rows, 14 teams) as closed series to 2026-10-04, and those teams' "93 Combined" rows from 2026-10-05 | 11             | 1     | 10    | 0      | **0 → 0.68**                      |
| C2   | As C1 with "New Practices based on Alder Park b" (28 rows, 14 teams) as the closed revision                                   | 24             | 1     | 23    | 0      | **0 → 0.68**                      |
| C3   | C0, with the 3 "New Schedule w 8-21 edits" rows' slots re-created valid from 2026-08-21                                       | 1              | 1     | 0     | 0      | 0.68 → 0.68                       |
| C4   | C0, with the Friday 18:00 Alder Park Pitch 3B slot re-created valid from 2026-09-14                                           | **0**          | 1     | 0     | **1**  | 1 conflict hidden                 |

- In C1 and C2 every false conflict is a revised team against **its own** closed
  series (for example `14GSelect02` at `#129` and `#440`). The score moves from
  `max(0, 1 − (0.15·1 + 0.5·(1 − 88/132)))` = 0.68 to
  `max(0, 1 − (0.15·11 + 0.167))` = 0: one revision of 14 teams zeroes the
  panel's score.
- C4's lost conflict is the plan's one real clash: `14BSelect03` (Pitch 3B) and
  `16BSelect02` (Pitch 3A), Friday 18:00, one shared coach, 10 Fridays from
  2026-09-14 to 2026-11-20.
- C0 and C3 show neutrality: with no range that cuts a series, the oracle and
  both engines agree. That is the property that keeps the existing parity extract
  valid (§4).
- No case overbooks, because each corpus grid row is its own capacity-1 slot,
  as in the parity extract. W3 is the capacity witness.

Limits: the oracle is mine, written for this measurement; it is not the
implementation, and it ignores exceptions (no corpus input carries one). The
revision dates in C1/C2/C4 are assumptions, stated above.

### 2.4 Production (_executed_, read-only)

One `SELECT` through the Supabase MCP against `mmwupqsjkikqzvmdvuzm` on
2026-10-13: `practice_slots` 0 rows, `practice_assignments` 0 rows,
`practice_exceptions` 0 rows. Nothing was written.

---

## 3. The design

### 3.1 What "live" means

An assignment is **live on date D** when all of these hold:

1. D falls on the slot's weekday;
2. D is inside the assignment's range: the stored `effective_date_range`, or the
   staged `effectiveDateRange` of a new placement, read by `practiceRangeBounds`
   (core) / `dateRangeBounds` (Edge), never by a third parser;
3. D is inside the slot's validity: `valid_from`/`valid_until`, each falling back
   to the season's start/end when null. That fallback is the page's existing rule
   (`normalizePracticeSlot`, `:181-182`); the engines are sent its result, so they
   never need season settings.

Dates are `YYYY-MM-DD` day numbers, as `practiceOccurrences.js` does: no `Date`
is constructed for a date (GAP-30). The page already knows each slot's first
occurrence date (`slotDate`, `:191`), so it sends that and the validity end; the
live dates are first date + 7k up to the earlier of the two ends, clipped to the
assignment range. No weekday label is parsed by either engine.

**Edges, stated:**

- **Touching ranges** clash only if they share a date of the weekday
  (W2b: a range ending Tuesday 09-29 and one starting 09-29 share it; ending
  09-28 and starting 09-29 do not). Inclusive bounds both sides, after the
  `[`/`(` markers are honoured.
- **Open-ended upper bound** (`[2026-11-02,)`, storable in a `daterange`):
  read to the slot's validity end (Q3). Writer v3 refuses to save one from this
  app (`toPersistenceAssignment`, `:356-371`), so it can only come from
  elsewhere.
- **Unreadable range or empty intersection**: an unreadable range is dropped and
  reported in `dataQualityWarnings` / a `data-quality` issue, the existing
  contract for a row naming an unknown slot. A readable range with no live date
  (a series wholly outside its slot's validity) is kept as assigned but holds no
  date, and is reported once ("assignment for team X has no date inside slot Y's
  validity") so it is never silently free.
- **Absent range** on an assignment (a caller that sends none): live on every
  date of the slot's validity. That is what a range-less row means today.
- **Closed series** need no special case: their range ends, so they hold no date
  after it.
- **Exceptions** (`relocated`, `time_tbd`) are **not** in the first PR (Q1). When
  added, they go through `applyPracticeExceptions` and its Edge twin, which
  already turn a team's rows plus exceptions into dated occurrences; the evaluator
  consumes those occurrences instead of expanding rows itself.

### 3.2 What clashes and what is counted

- **Coach conflict:** two assignments share a coach (head or assistant, as now),
  share at least one live date, and their wall windows overlap on it
  (`a.start < b.end && b.start < a.end` in minutes of the day, so back-to-back is
  not a clash, as today). The slot's wall `startTime`/`endTime` are sent (the page
  has them, `:200-201`): comparing wall readings on one date needs no zone and
  is right across a DST change, where shifting the first occurrence by whole weeks
  is an hour off.
- **Identity unchanged:** one entry per pair of `(team, slot)` placements,
  merging coaches, keyed by `conflictPairKey`. Two fields are added (Q7):
  `firstDate` and `sharedDates` (count). The message names the first date.
- **Capacity:** per slot, the count on each live date; `assignedCount` becomes
  the **peak** (the slot's busiest date), `overbooked` is peak > capacity, and the
  old number survives as a labelled `assignmentRows` (Q4).
  `PRACTICE_METRICS_COUNT_UNITS` gets the new labels, so `assertCountsLabelled`
  keeps every count's unit stated.
- **Coverage** (`assignedTeams`, `assignmentRate`) is unchanged: a team with any
  readable row counts (Q6).
- **School-hours check** (core only): unchanged; it reads the weekday and clock
  time, which do not move with the date.

### 3.3 Dated and undated calls

The date fields are **all or nothing per call**: either every slot carries
`firstDate`, `lastDate`, `startTime` and `endTime`, or none does. None means
today's comparison, unchanged ("undated"); a mix refuses (core: `TypeError`;
Edge: 422 from the schema), so half a calendar is never scored as a whole one.
Both engines report which mode they ran in (`summary.dateModel: 'dated' |
'undated'`), so a caller that forgot the fields is visible in a test and in
the persisted run (Q8). Undated mode exists for two callers:

- the auto-scheduler's own scoring, which must not change while the solver is
  frozen (§8, Q2), and
- the corpus parity extract, which has no dates (C0 shows it is neutral).

### 3.4 Engine lockstep (M1.2)

- **Same rule twice, twin parsers.** Core uses `practiceRangeBounds`; the Edge
  uses `dateRangeBounds` from `_shared/calendar/icsFeed.ts`, already pinned to
  the same answers by `tests/practiceOccurrences.test.js`. The day arithmetic is
  the same `isoDayNumber` shape on both sides.
- **Schemas.** Edge `SlotSchema` gains optional `firstDate`, `lastDate`
  (`YYYY-MM-DD`), `startTime`, `endTime` (`HH:MM[:SS]`);
  `PracticeAssignmentSchema` gains optional `effectiveDateRange`. Core reads the
  same names. Both `passthrough` today, so an old client's request still parses
  (undated).
- **`tests/scoringEngineDrift.test.js`** gains the W1-W5 vectors and the
  disjoint / touching / overlapping triple; its "arms differ exactly where this
  file says" list does not grow.
- **Parity on the corpus.** The existing extract stays (undated, C0). A second
  extract, `scoring-parity-dated.season-2026.json`, generated by the same script
  from C1 and C4's inputs, records core's answer; `tests/scoringParity.test.js`
  and `scoring-parity_test.ts` run both arms over it, with literal floors (11
  rows read as 1 conflict; the C4 conflict present) so a vacuous extract fails.

### 3.5 Consumers

- **Practice page:** `evaluationPracticeData` sends each slot's `firstDate`,
  `lastDate`, `startTime`, `endTime` and each assignment's `effectiveDateRange`
  (the stored value, or `newPlacementRange` for a staged placement). The review
  path is covered by the same memo. `buildPracticeRunResults` gets the same
  inputs (Q9).
- **Override panel:** `overrideBaseSlots` computes, per slot, the peak count over
  live dates **from the season's today on** (an override starts today, #546), in
  a pure helper in `frontend/src/utils/` built on `practiceRangeBounds` (Q5).
- **`fairness-scoring`:** no handler change beyond the schema; anchoring still
  places `start`/`end`.
- **Auto-scheduler:** unchanged (undated), declared (§8).

---

## 4. Test gate, witnesses and plants

Every subject set is enumerated from the inputs (the roster, the stored rows),
never from what an engine returned.

- **Core** (`tests/practiceMetrics.test.js`): W1-W5, plus disjoint / touching /
  one-week-overlap ranges, open-ended upper, unreadable range (dropped and
  reported), a series with no live date (reported), mixed dated/undated (throws).
- **Deno** (`_shared/tests/scoring-engine_test.ts`): the same cases.
- **Drift** (`tests/scoringEngineDrift.test.js`): the same vectors, both arms.
- **Parity:** the dated extract, both runtimes (§3.4). The undated extract
  unchanged (C0), which is the neutrality proof.
- **Page wiring** (`tests/practiceFairnessWiring.test.jsx`): the request body
  carries the date fields for every slot and a range for every row, the review
  path's placements carry `newPlacementRange`, and the response's `dateModel`
  is `dated`.
- **Override panel:** a closed series does not consume a slot from today on;
  a current one does.
- **Season-2026 fixture suite** (CLAUDE.md): the `season2026*` and parity tests,
  plus the full `npm run test`.

Each is shown failing on today's engines first (§2 already measures that they
are wrong on W1-W4 and C1/C2/C4). **Plants**, each shown caught before the PR
opens:

- P1 ignore the assignment range (W1, W2, W3, C1);
- P2 ignore slot validity (W4, C4);
- P3 an exclusive upper bound where inclusive is meant (W2b);
- P4 count rows instead of the peak (W3);
- P5 the page stops sending the date fields (wiring test's `dateModel`);
- P6 the change in one engine only (drift and parity);
- P7 compare first-occurrence instants instead of wall windows across a DST
  change (a slot pair straddling 2026-11-01).

Meta: each witness asserts its truth set is non-empty where a conflict is
expected, and the dated extract asserts its literal counts, so a check that
examined nothing fails.

---

## 5. Season fixture and digest impact

- Undated callers are byte-identical: C0 shows the corpus plan gives the same
  1 conflict and the same per-slot counts; the existing parity extract is not
  regenerated.
- No solver code changes, so the season sweep and the rule-engine digests are
  untouched; the implementing PR quotes them equal.
- `slotUtilization[].assignedCount` changes meaning for dated calls only (peak
  per date). Fairness runs persisted before and after are comparable on counts
  only where no series was cut by a range.

---

## 6. Declared, not enforced (after the implementing PR)

- **The auto-scheduler stays undated** (Q2): its hard constraint can still place
  one coach on two teams in W4's shape, and its locked rows still hold a slot all
  season (already declared at `auto-scheduler-solver.ts:19-20`). Its persisted
  `edgeEvaluation` says `dateModel: 'undated'`.
- **Exceptions** are not read until the follow-up (Q1): a relocated week is
  judged at its original slot; a TIME TBD window still counts.
- **Coverage** is season-level (Q6): a team whose only series ended counts as
  assigned.
- **Game evaluation** (`evaluateGameSchedule`) is untouched: games are dated
  instants already.

---

## 7. Size estimate

| Piece                                                               | Est. LOC |
| ------------------------------------------------------------------- | -------- |
| Core `practiceMetrics.js`: dated expansion, conflicts, peak, labels | 110      |
| Edge `scoring-engine.ts` + `schemas/scoring.ts`                     | 110      |
| Page payload and `buildPracticeRunResults` inputs                   | 30       |
| Override panel helper                                               | 40       |
| Generator: the dated extract                                        | 50       |
| Tests (core, Deno, drift vectors, parity both arms, wiring, panel)  | 450      |
| Extract JSON (generated)                                            | ~3,000   |

About 340 lines of product code and 500 of tests, **one PR**
(`fix/practice-scoring-date-model`), plus the exceptions follow-up if Q1 is
answered as recommended (about 120 + 200). No migration, no RPC change; an Edge
deploy of `fairness-scoring` (and of `auto-scheduler`, which imports the engine
unchanged in behaviour). Effort M, as the remediation plan says.

---

## 8. Risks

- **The solver's objective.** `scoreSchedule` calls this engine. If the solver's
  slots arrive with date fields, its search changes, which the plan forbids. The
  undated mode and an explicit undated call in `auto-scheduler-solver.ts`, pinned
  by `tests/autoSchedulerLock.test.js` producing the same placements on its seeds,
  is the guard.
- **A field sent and unread.** If the page stops sending a field the engine falls
  back to undated without failing. `dateModel` in the response and the wiring
  test (P5) make that visible.
- **Bound arithmetic.** `daterange` is canonical `[from, until+1)`; the page's
  staged ranges are inclusive `[from,until]`. Both go through the one parser per
  runtime; W2b and P3 guard the off-by-one.
- **Host-zone dates.** Day numbers only, wall windows only, as GAP-30 requires;
  P7 guards DST.
- **Count meaning.** `assignedCount` changes meaning in dated runs (Q4); the old
  number is kept under its own label.
- **Size of the payload.** Four short fields per slot and one per row; the page's
  142-slot season adds about 10 KB to the request.

---

## 9. Rollback

Revert the PR and redeploy `fairness-scoring` and `auto-scheduler`. No data, no
migration. Fairness runs persisted in between keep their dated numbers in
`metrics_summary`; they read correctly and nothing recomputes them.

---

## 10. Questions for the owner

**Q1. Scope: ranges and slot validity in one PR, and exceptions (`relocated`,
`time_tbd`) in a follow-up?**
_Recommendation (not an answer):_ yes, split. Ranges and validity are the
measured defect (§2) and need no new read on the page. Exceptions need the page
to read and send them and the evaluator to consume `applyPracticeExceptions`'
occurrences; they arise only from daylight, enact and repair saves, and the
twins that expand them are already pinned. One PR each keeps each reviewable.

**Q2. The auto-scheduler: keep the solver undated here, and open a separate
plan-first item for it?**
_Recommendation (not an answer):_ yes. The remediation plan forbids a change to
the solver's behaviour, and a dated score or hard constraint changes the search.
But the solver can place one coach on two teams in W4's shape, which is a real
defect, so it should be its own item (proposed M4.8, plan first, with the season
sweep) rather than forgotten.

**Q3. An open-ended assignment range (`[D,)`): read to the slot's validity end?**
_Recommendation (not an answer):_ yes. It is what the slot allows, it never
invents a date the slot does not have, and the writer refuses to store one from
this app. The alternative, dropping the row as unreadable, would hide a practice
that exists.

**Q4. `slotUtilization[].assignedCount`: the peak per date, with the row count
kept as `assignmentRows`?**
_Recommendation (not an answer):_ yes. "Is this slot overbooked" is a per-date
question; the peak answers it. Keeping the row count under its own label loses
nothing and keeps the count-unit registry honest.

**Q5. The override panel's "N free": from the season's today on, or across the
whole season?**
_Recommendation (not an answer):_ from today on. An override starts today
(#546), so a closed series must not consume the slot, and a past week's load is
irrelevant to the choice.

**Q6. Coverage: keep `assignedTeams` season-level (any readable row)?**
_Recommendation (not an answer):_ yes, in this item. "Which teams have no
practice from today on" is a different question; #64's team warnings already
answer part of it at Apply. Declared in §6.

**Q7. Add `firstDate` and `sharedDates` to each conflict, and name the first
date in its message?**
_Recommendation (not an answer):_ yes. "Overlapping practices on Friday" no
longer says when; an operator fixing a clash that starts in three weeks needs the
date. The conflict's identity, which parity compares, is unchanged.

**Q8. Undated mode: all-or-nothing date fields, mixed refuses, and
`summary.dateModel` reported?**
_Recommendation (not an answer):_ yes. It is what lets the solver and the
undated parity extract stay byte-identical, and it makes a dropped field loud.

**Q9. Apply-time metrics (`buildPracticeRunResults`, persisted with the run):
dated in the same PR?**
_Recommendation (not an answer):_ yes. It is the same core function with the same
inputs on the same page; leaving it undated would persist a different answer
from the one the panel showed.
