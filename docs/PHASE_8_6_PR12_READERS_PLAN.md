# 8.6 PR 3b, PR 12: calendar readers apply saved practice exceptions: plan

Status: **DRAFT, awaiting the operator.** Nothing here is approved. The
questions in §9 are open; each carries a recommendation, which is not an
answer.

It refines row 12 of the approved 3b plan (`docs/PHASE_8_6_PR3B_PLAN.md:286`,
"Readers apply exceptions, P reads, ~400"). That plan's §1 defines the table
(`:57-75`) and says: "Readers (PR 12) expand each row by its own range, then
apply exceptions within their windows (show the moved practice, or TIME TBD)."
It also carries two notes that wait on this PR: PR 9 refuses mid-range TIME
TBD windows "until PR 12" (`:320-324`), and the PR 11 plan
(`docs/PHASE_8_6_PR11_ENACT_PLAN.md:23`, `:204-238`) refuses every blackout
exception until PR 12, with blackout enact as **PR 11d** after it.

Every claim about current code was **statically reviewed** at `9a5ef80`
(origin/main, after #514) and cites file:line on that commit. **Nothing was
executed.** No test was run and no database was queried for this plan. The
production row counts in §2 are therefore unknown; §2 gives a read-only query
for the operator to run.

## 0. Summary

- **Census: 10 readers** turn stored practice rows into dated (or
  date-validated) practices. **None of them reads `practice_exceptions`.**
  §1 lists them, and also names 17 readers that were excluded and why.
- **Live defect (§2).** Two merged writers record TIME TBD **tail** windows:
  the daylight Apply (8.9 PR 6b) and the retirement enact with a TIME TBD
  decision (11c, #514). In both, the row ends at D-1 and the exception covers
  `[D, until]`. Every reader expands only the row's range. After D-1, the
  team's practices therefore **vanish** from the portal and the calendar feed,
  with no TIME TBD entry and no CALDESC count. That breaks CLAUDE.md §3,
  "Never silently drop an unplaceable fixture". The admin is told at save time
  (`teams_time_tbd`). Families are not.
- **One shared function**, `applyPracticeExceptions`, in core
  `utils/practiceExceptions.js`, with an import-free Deno twin beside
  `icsFeed.ts`. A drift test runs both over an enumerated product (§3, §5).
- **Split into four PRs** (12a-12d, §7), about 1,450 lines in total against
  the plan's ~400.

## 1. Census of readers

### 1.1 Method (the meta-check)

The subject set was enumerated **from code on disk**, not from docs. The scope
was `frontend/src`, `packages/core/src`, `supabase/functions`,
`supabase/migrations` and `scripts`; `docs/`, `tests/`, `node_modules/` and
`dist/` were excluded. These patterns were used:

| # | Pattern | Scope | Hits at `9a5ef80` |
|---|---|---|---|
| G1 | `practice_assignments\|practiceAssignments` | all of the above | 65 files, 312 occurrences (one is `CHANGELOG.md`) |
| G2 | `practice_exceptions` | same | 13 files (writer, Edge persistence, enact, adapter, lock, mocks, dbharness) |
| G3 | `practiceOccurrences\|expandPractice\|practiceRangeBounds\|occurrencesOf\|expandRecurring\|expandWeekly\|practiceDates` | repo | 4 production importers |
| G4 | `effective_date_range\|effectiveDateRange\|practiceOccurrence\|on_date\|occurrence` | `frontend/src` | 17 files |
| G5 | `day_of_week\|dayOfWeek` | `frontend/src` | 18 files |
| G6 | `CREATE (OR REPLACE )?(FUNCTION\|VIEW)` next to a `practice_assignments` line, plus `FROM public.practice_assignments pa` | `supabase/migrations` | 20 functions and views |

Every G1 file was classified, either into the census below or into the
exclusion list with a reason. G3-G5 were run to catch readers that expand a
weekday without naming the table. They found one: the enact dialog's count
(R8). G6 was run because a SQL reader is invisible to a JavaScript grep. It
found two: the RSVP validator (R6) and the booking guard (excluded, X13).

**This census can go stale. The fix is in the plan, not in this document.**
PR 12a adds `tests/practiceReaderCensus.test.js`, which follows the
`scripts/deno-mirror-tests.sh` "EXCLUDED" precedent:

- The subject set is every production file that selects from
  `practice_assignments`, plus the latest SQL definition of every function
  that reads it.
- Each file must appear in a registry, as `applies`, `series-only (declared)`
  or `writer`.
- The test fails on an unclassified file **and** on a registry entry whose
  file no longer reads the table.

Plant: add a new file with `.from('practice_assignments')`, and the test must
turn red.

### 1.2 The readers

"Relocated" and "TIME TBD" say what each reader shows **today** for dates
inside a live exception window. No reader applies exceptions, so each answer
is what the bare series produces.

| # | Reader | Where | Reads `practice_exceptions`? | During a `relocated` window, today | During a `time_tbd` window, today |
|---|---|---|---|---|---|
| R1 | Core series expander `practiceRangeBounds` / `practiceOccurrenceDates` | `packages/core/src/utils/practiceOccurrences.js:82-94`, `:106-124` | No | The original weekday dates | Inside the row's range: timed dates. After it (tail): nothing |
| R2 | Team portal hook: read and `expandPractices` | `frontend/src/hooks/useTeamPortal.js:157-177` (read, `team_id` only), `:397-450` (expand) | No | The original practice at the original ground, RSVP-able | Mid-range: a timed practice. Tail: **nothing** |
| R3 | Team portal page (coach and parent view) | `frontend/src/pages/TeamRecordPage.jsx:51`, `:193`, `:215-226` (TBD text), `:237` (RSVP hidden only for `timeTbd`) | No (renders R2) | Same as R2 | Same as R2. Its TIME TBD rendering exists only for undated refusals |
| R4 | Calendar feed Edge Function: reads | `supabase/functions/calendar-feed/index.ts:166-175` (select `id, effective_date_range, practice_slots!practice_slot_id(...)`, `team_id` only, service role `:72-81`); season clock `:127-137` | No | The original VEVENT, UID `<assignment>_<date>` | Mid-range: a timed VEVENT. Tail: **no VEVENT, no CALDESC count** |
| R5 | Feed expansion, the Deno twin of R1 | `supabase/functions/_shared/calendar/icsFeed.ts:314-326` (`dateRangeBounds`), `:346-468` (practice arm), `:421` (UID), `:675-679` (CALDESC), `:689-720` (TBD VEVENT) | No | As R4 | As R4. A dated `unplaceable` already renders as an all-day TENTATIVE "TIME TBD" VEVENT (`:707-720`), but the practice arm never makes one for an exception |
| R6 | RSVP validator RPC `upsert_team_event_rsvp` | `supabase/migrations/20260504070000_team_portal_communication_rpcs.sql:141-154` (latest definition, found by G6) | No | Accepts the original date. **Refuses** a relocated date on another weekday (`:150-152`) | Accepts an RSVP for a date that has no confirmed time |
| R7 | Mock client: RSVP mirror, embed, table | `frontend/src/lib/mockSupabaseClient.js:2877-2883` (RSVP check, mirrors R6), `:865` (`rangeLastDay`), `:1540-1584` (embed); `frontend/src/lib/mockPracticeEnact.js:263-276` (the only mock writer of `practice_exceptions`) | Written by the enact mock only; read by no reader | As R6 and R2 | As R6 and R2 |
| R8 | Enact dialog's "published practices that could change" count | `frontend/src/utils/practiceRepairEnact.js:138-162` (`practiceOccurrenceDates` over `[D, until]`) | No | Counts original dates, including ones already moved | Counts dates already TIME TBD as "published practices" |
| R9 | Exports: CSV rows and coach email drafts | `frontend/src/components/OutputGenerationPanel.jsx:105-162` (one row per assignment, **first** weekday on or after the range's lower bound, `Date`-based), `:178-209`, `:495-504` (drafts: weekday and time per row); core `packages/core/src/outputGeneration.js:125-147`; rows from `frontend/src/hooks/usePracticeAssignments.js:27-53` | No | A series row; if its one date falls in a window, it is wrong | A series row; nothing says TBD |
| R10 | Player record: team practices | `frontend/src/pages/PlayerRecordPage.jsx:80-86` (weekday and time, `limit(10)`, **no range**) | No | The series weekday and time | The series, including rows already closed |

**Census size: 10.** R1-R8 expand or validate dated practices, and PR 12
adopts them. R9 and R10 are series readers that a family or coach sees as a
schedule. They are in the census because they show a practice that an
exception changes. Whether PR 12 adopts them is question Q6.

### 1.3 Excluded, with reasons

| # | Reader | Where | Why it is excluded |
|---|---|---|---|
| X1 | `loadSeasonPracticeAssignments` | `packages/core/src/practiceSupabase.js:368-410` | Series: the lock and the writer's cross-check. It makes no dates |
| X2 | Auto-scheduler lock load | `supabase/functions/_shared/engines/practice-lock.ts:250-300` | Series. It **already** reads live `time_tbd` exceptions (`:269-283`, `.is('withdrawn_at', null)`) to exclude TBD teams (3b decision 4). It makes no dates |
| X3 | `buildPracticeRepairInput` / snapshot loader | `packages/core/src/practice/repairAdapter.js:155-366`; `frontend/src/hooks/usePracticeRepairSnapshot.js:96-103` | Solver input. Reading live exceptions is **PR 11d** (PR 11 plan `:233-238`) |
| X4 | `buildPracticeRepairPayload` | `repairAdapter.js:602-790` | Writer side |
| X5 | Scheduling page staging, `toPersistenceAssignment` | `frontend/src/pages/PracticeSchedulingPage.jsx:313-394` | Writer side (payload keys) |
| X6 | `PracticeAssignmentList` | `frontend/src/components/PracticeAssignmentList.jsx:81` | Admin series list (prints the range text) |
| X7 | Coach-preference preview and review | `frontend/src/utils/coachPreferencePreview.js:131-165`; `frontend/src/components/preferences/AdminPreferenceReview.jsx:81-83` | Series in force on a date; they judge a placement, not dates |
| X8 | Lighting-override coached slots | `frontend/src/utils/lightingOverrides.js:49-88`; `frontend/src/hooks/usePracticeLightingOverrides.js:267-291` | Slot membership, not dates |
| X9 | `practice_schedule_fingerprint` | `supabase/migrations/20260929000000_practice_writer_v3_lock_by_default.sql:179-206` | A hash (it already covers exception ids and `withdrawn_at`) |
| X10 | `persist_practice_schedule`, `enact_practice_recommendation`, `admin_cancel_practice_assignment` | `20261002000000:99-`; `20261004000000:80-`; `20260929000000:1325-` | Writers |
| X11 | `view_facility_usage`, reporting views | `20260331000000_definitive_schema.sql:1250-1262`; `20251220000000_reporting_views.sql:63` | Counts per slot. No dates |
| X12 | Field-import finalize and rollback | `20260503070000:997`, `20260909000000:965` | Existence checks |
| X13 | `field_bookings` (booking guard), its mock and `fieldBookings.js` | `20260911000000_venue_subunit_effective_dating.sql:262-299` (a row's **last day**, not occurrences); `mockSupabaseClient.js:1101-1110`; `frontend/src/utils/fieldBookings.js:96-118` (slots) | Judged per row, not expanded. **Gap for 11d:** a relocated exception is not a booking of its target field (§8, D5) |
| X14 | Game scheduling, dashboard workflow | `frontend/src/pages/GameSchedulingPage.jsx:379` (comment only); `frontend/src/components/DashboardWorkflow.jsx:336` (passes rows to R9) | They show no practices |
| X15 | Daylight post-pass | `packages/core/src/practice/daylight.js:182-266` | Solver input over placements, before persistence |
| X16 | `event_rsvps` realtime | `useTeamPortal.js:280-306` | RSVPs, not practices |
| X17 | dbharness | `scripts/dbharness/{run.sh,prove.sh,scenarios.py}` | Test harness |

## 2. What exception rows can exist today

### Writers

| Path | What it records | Window position | Evidence |
|---|---|---|---|
| Daylight Apply (8.9 PR 6b) | `time_tbd`, `past-sunset`, `cause_kind: 'daylight'`, on the row the same save inserts (`new_assignment`) | **After** the row: the row is `[from, D-1]`, the window `[D, until]` | `frontend/src/utils/daylightExceptions.js:40-71`; sent at `PracticeSchedulingPage.jsx:914` |
| Retirement enact, TIME TBD decision (11b/11c) | `time_tbd` with the repair's reason, `cause_kind: 'retirement'`, on the **closed** row | **After** the row: closed at D-1 (`closes`), window `[D, until]` | `repairAdapter.js:688-748`; the wrapper requires exactly one recorded exception for a `time_tbd` decision (`20261004000000_enact_practice_recommendation.sql:339-340`) and is retirement-only (`:173`) |
| Retirement enact, re-home | No exception: a new row `[D, until]` | — | `repairAdapter.js:703-730` |
| Blackout (any) | Nothing reaches the writer: the adapter refuses every blackout exception | Would be **inside** the row | `repairAdapter.js:641-657`, `:752-773`; PR 11 plan `:206-217` |

### Rows the database admits but no in-app path writes

- **A `relocated` row, or a mid-range non-daylight `time_tbd` row.** The Edge
  schema admits both (`supabase/functions/practice-persistence/index.ts:57-111`).
  The writer refuses a mid-range window **only for the two daylight reasons**
  (`20261002000000_practice_exceptions_daylight.sql:1111-1123`). An admin
  calling the Edge Function with a hand-built payload could therefore record
  one, and every reader would still show those dates as ordinary practices.
- **A daylight window that starts inside the row and runs to its end.** The
  writer's tail test is `upper(window) >= upper(range)`, which admits it
  (`:1116-1118`). The in-app builder always truncates the row first
  (`daylightExceptions.js:41-47`).

Both are **declared, not enforced** gaps (§8, D1-D2). **Neither is reachable
from the app today.**

### The live defect

**Tail TIME TBD windows are silently dropped by every reader.**

Take a row `[Sep 1, Sep 30]` on Tuesdays, with a live exception `time_tbd`
over `[Oct 1, Nov 30]`, reason `past-sunset`:

- **Portal (R2/R3).** It shows Tuesday practices through Sep 30, then
  nothing. It emits a TIME TBD entry only when the row itself cannot be
  expanded (`useTeamPortal.js:422-434`).
- **Feed (R4/R5).** It emits VEVENTs through Sep 30. It emits no all-day TIME
  TBD VEVENT and adds nothing to the CALDESC's "N of M events have no
  confirmed time" (`icsFeed.ts:675-679`).
- **Only the writer's result shows it.** It names the team in
  `teams_time_tbd` (`20261002000000:1153-1178`). An admin sees it at save
  time. A family subscribed to the feed sees a season that simply stops.

It is **reachable today** in two ways: after a daylight Apply that truncated
a placement, and after any retirement enact whose decision is TIME TBD (#514
merged). It is **not** the "still shown" failure the 3b plan warned of: tail
windows were declared safe (`PHASE_8_6_PR3B_PLAN.md:322-324`) because nothing
wrong is *shown*. But nothing *right* is shown either, and CLAUDE.md §3
forbids exactly that.

**Unknown: whether production holds any such row.** Per the task rules, no
database was touched. The operator can check, read-only:

```sql
SELECT pe.kind, pe.tbd_reason, pe.cause_kind,
       upper(pa.effective_date_range) <= lower(pe."window") AS after_row,
       count(*)
  FROM public.practice_exceptions pe
  JOIN public.practice_assignments pa ON pa.id = pe.assignment_id
 WHERE pe.withdrawn_at IS NULL
 GROUP BY 1, 2, 3, 4;
```

A non-zero `after_row = true` count is the defect in production. A non-zero
`after_row = false` count would be the worse, "still shown" case (D1).

**Adjacent, not verified end to end, and out of PR 12's scope.** The exports
(R9) read rows by the latest run id (`usePracticeAssignments.js:53`).
`useSeasonPracticeAssignments.js:11-13` states that such a reader "stops
listing them from the second run on", because writer v3 is add-only. After an
enact (a new run), the CSV and email drafts may cover only the enacted team.
Recommended as its own issue, not folded into PR 12.

## 3. The shared application function

### Where it lives

- **Core:** new `packages/core/src/utils/practiceExceptions.js`, a sibling of
  `utils/practiceOccurrences.js`. It lives under `utils/`, not `practice/`,
  for the reason `practiceOccurrences.js:22-25` gives: a live reader calling
  into `practice/` falsifies the unwired-layer pins
  (`tests/unwiredLayerImporters.test.js`). It imports only
  `practiceOccurrences.js` and `facility/eligibility.js` day arithmetic.
- **Deno twin:** new `supabase/functions/_shared/calendar/practiceExceptions.ts`,
  import-free (the Edge cannot import core). It sits beside `icsFeed.ts`,
  which imports it.

### Contract

```js
/**
 * @param {{
 *   rows: Array<{ id, effective_date_range, slot: { day_of_week, start_time, end_time, field? } | null }>,
 *   exceptions: Array<{ id, assignment_id, window, kind, practice_slot_id, tbd_reason,
 *                       cause_kind, withdrawn_at, slot?: {...} | null }>,
 * }} input  -- one team's rows and every exception read for them
 * @returns {{
 *   occurrences: Array<
 *     | { assignmentId, date, kind: 'series', slot }
 *     | { assignmentId, date, kind: 'relocated', slot, exceptionId, replaces: slot, causeKind }
 *     | { assignmentId, date, kind: 'time_tbd', exceptionId, code, causeKind }>,
 *   undated: Array<{ assignmentId, exceptionId|null, code }>,   // TIME TBD with no day
 *   findings: Array<{ code, assignmentId, exceptionId? }>,
 *   meta: { rowsRead, exceptionsRead, exceptionsLive, exceptionsApplied, datesSuppressed }
 * }}
 */
export function applyPracticeExceptions({ rows, exceptions }) {}
```

It is deterministic, calendar-date only, and constructs **no `Date`** (the
GAP-30 contract, `practiceOccurrences.js:9-17`). Output is ordered by date,
then assignment id.

### Rules (adopted from siblings where one exists)

1. **Series first.** Each row expands by its own range through
   `practiceOccurrenceDates` (R1), unchanged. A row refusal (`SLOT_MISSING`,
   `RANGE_UNREADABLE`, `DAY_UNREADABLE`) stays one undated TIME TBD with the
   existing code (`practiceOccurrences.js:53-70`).
2. **Only live rows apply, and the helper filters them itself.**
   - "Live" means `withdrawn_at == null`. That is the predicate of the table's
     EXCLUDE constraint (`20260929000000:144-146`) and of the lock load
     (`practice-lock.ts:276`).
   - The filter is **inside the helper, whatever the caller selected**. That
     is the lighting-override contract (`practice/lightingOverrides.js:11-13`,
     `:77`): a reader that forgets `.is('withdrawn_at', null)` still cannot
     apply a withdrawn exception.
   - Withdrawn rows are counted in `meta`, never applied.
3. **Windows are read by `practiceRangeBounds`**, the marker-honouring reader
   pinned to the feed's `dateRangeBounds` (`practiceOccurrences.js:27-32`).
   There is no third range parser.
4. **`time_tbd` over window W.**
   - Every series date of the row in W is replaced by a dated TIME TBD, with
     `code` = the `tbd_reason` enum value.
   - **For a tail window** (W after the row's range), the dates are the row's
     slot weekday **over W itself**, not clipped to the range. This is what
     makes the §2 defect visible.
5. **`relocated` over W.**
   - The row's series dates in W are removed.
   - The relocated slot's weekday dates in **W ∩ the row's range** are added,
     with the relocated slot's times and ground, and `replaces` names the
     original slot.
   - If the relocated slot is missing or has an unreadable day, the removed
     dates become dated TIME TBD with the existing code, so they are never
     dropped.
   - Clipping to the row's range is Q9.
6. **An unreadable or unbounded window never shows a timed practice.**
   - The writer admits `upper_inf` for daylight (`20261002000000:1116`).
   - If the lower bound reads: series dates from it on are suppressed, and one
     undated TIME TBD is emitted, `PRACTICE_EXCEPTION_WINDOW_OPEN`.
   - If it does not read: the whole row becomes undated TIME TBD,
     `PRACTICE_EXCEPTION_WINDOW_UNREADABLE`.
   - Each case adds a finding.
7. **Overlapping live windows on one assignment.** The EXCLUDE constraint
   forbids them, but the helper does not trust that. Dates in the overlap
   become TIME TBD `PRACTICE_EXCEPTION_CONFLICT`, with a finding. It reports
   rather than throws, as the feed does for bad rows (`icsFeed.ts:351-374`):
   the feed must not 500.
8. **An exception naming an assignment not in `rows`** is a partial read. It
   is never applied silently: finding `PRACTICE_EXCEPTION_ROW_UNREAD`. This is
   the adapter's "names unread field" rule (`repairAdapter.js:488-500`) as a
   finding, not a throw.
9. **Shadowing.** A team-level post-pass reports a TIME TBD date on which
   another row of the same team has a timed practice:
   `PRACTICE_TBD_SHADOWED`. Both are shown (Q10).

### Wording

- `PRACTICE_TBD_CAUSES` (`practiceOccurrences.js:66-70`) and the feed's
  `UNPLACEABLE_CAUSES` (`icsFeed.ts:121-132`) each gain the same family-facing
  sentence for every `tbd_reason` in the CHECK. That list is pinned by
  `tests/practiceWriterV3.test.js` to `index.ts:77-87`.
- They also gain sentences for the four new codes. The existing
  `tests/practiceOccurrences.test.js` pin keeps the two tables equal.
- Enum values only; the free-text notes never appear (no PII).

## 4. How each reader adopts it

| # | Change | PR |
|---|---|---|
| R1 | Unchanged. The new sibling module calls it | 12a |
| R2 | A second read: `from('practice_exceptions').select('id, assignment_id, window, kind, practice_slot_id, tbd_reason, cause_kind, withdrawn_at, slot:practice_slots(day_of_week, start_time, end_time, field:fields(name, location:locations(name)))').eq('team_id', teamId)`. `expandPractices(rows, exceptions)` calls the helper. It emits `{kind:'relocated', movedFrom}` events and **dated** TIME TBD events (`date` set, `timeTbd: true`). A failed exceptions read follows Q5. RLS: `practice_exceptions` select is `is_org_member(organization_id)` (`20260929000000:159-162`), the same predicate as `practice_assignments` (`20260331000000:1052-1053`) | 12c |
| R3 | A dated TIME TBD renders as "Time TBD on <date>: <reason>" (today's text reads "Date and time TBD", `:215-216`). A moved practice shows its new time and place, plus one "Moved from <weekday> <time>, <ground>" line (Q3). RSVP stays hidden for TIME TBD. It is shown for moved practices only once 12d lands | 12c |
| R4 | Service-role read of `practice_exceptions` for `team_id = teamId AND organization_id = team.organization_id`, with the relocated slot's fields embedded. A failure is pushed to `readFailures` as `'practice changes'` (Q5) | 12b |
| R5 | `buildFeedEvents` takes `exceptions` and runs the twin. Relocated: a `timed` event on the relocated slot, composed on the season clock by the existing `resolveZonedInstant`, UID per Q1. Time TBD: a dated `unplaceable`, so the existing all-day TENTATIVE VEVENT and CALDESC count apply (Q2). Undated: CALDESC only (`:693`) | 12b |
| R6 | New migration, `CREATE OR REPLACE upsert_team_event_rsvp`. A practice date is allowed when it is a series date **not** inside a live exception window, **or** a relocated date of a live `relocated` exception on that assignment. A date inside a live `time_tbd` window is refused with 22023. Existing RSVPs are untouched (Q4). Revert and smoke under `docs/sql/`, pgTAP | 12d |
| R7 | The mock RSVP check (`:2877-2883`) mirrors R6. A `practice_exceptions` mock table is seeded with `organization_id`. The generic `.from('practice_exceptions')` and its `practice_slots` embed are served (one FK, so no PGRST201) | 12c (read), 12d (RSVP) |
| R8 | The count excludes dates the helper already marks TIME TBD or relocated. Retirement-only enact rarely meets one, so this is small, and it is required before 11d | 12c |
| R9 | Q6. Recommendation: stays series-level in PR 12. The export message states "N practices have temporary changes not shown in this export" (a count from the helper's `meta`) | 12c |
| R10 | Q6. Recommendation: stays series-level. Declared | — |

## 5. The Deno twin and the season clock

- **The twin.** `_shared/calendar/practiceExceptions.ts` restates the helper
  with no imports.
  - `tests/practiceExceptionsDrift.test.js` (vitest imports `.ts` directly, as
    `tests/practiceOccurrences.test.js:24` already does) runs both arms over
    an **enumerated product**, not samples. The product: kind × window
    position (before, overlapping the start, inside, whole range, reaching the
    end, tail after, open upper, unreadable) × withdrawn yes/no × relocated
    weekday same/other/slot missing × zero, one or two overlapping live
    windows × a range crossing a DST change.
  - Precedent: `_shared/tests/lighting-override-product.ts` and its
    `.digest.json`, held by `tests/lightingOverrideDrift.test.js`. The digest
    pins the product's size, so a shrunk product fails.
  - A Deno test `_shared/tests/practice-exceptions_test.ts` runs the same
    product. `scripts/deno-mirror-tests.sh` discovers it and runs it under
    both `UTC` and `America/Los_Angeles`. Its floor is raised by one.
- **The season clock.**
  - Application works on **wall dates only**. It never reads a zone.
  - Instants are composed afterwards, exactly as today:
    `resolveZonedInstant({date, time, timeZone: season.timezone})`
    (`icsFeed.ts:425-436`), with the **relocated** slot's times.
  - A season with no zone still makes every event `unplaceable`
    `SEASON_TIMEZONE_MISSING` (`:329-336`). Relocated events inherit that, and
    TIME TBD events stay TIME TBD.
  - The vitest drift file sets `process.env.TZ = 'America/Los_Angeles'`
    (`practiceOccurrences.test.js:14`).

## 6. Witnesses and plants

Each subject set is enumerated from the **seeded exception rows and roster
rows**, never from the reader's output. Every fixture also asserts that it
exercised data: at least one live `relocated`, one live mid-range
`time_tbd`, one live tail `time_tbd`, one withdrawn, and one open-upper
window. **Meta-plant (all rows):** move every window off every row, and each
of those assertions must turn red.

| # | Guarantee | Test | Plant that must turn it red |
|---|---|---|---|
| W1 | Every live exception is applied exactly once | `tests/practiceExceptions.test.js`: for each seeded live exception, the dates in its window, from the seed, equal the output's dates carrying its `exceptionId` | Skip exceptions whose `assignment_id` sorts last |
| W2 | Withdrawn never applies, whatever the caller selected | Same: the fixture passes withdrawn rows unfiltered | Remove the helper's own `withdrawn_at` filter |
| W3 | No series date survives inside a live window | Same: the series dates from `practiceOccurrenceDates` ∩ each window, all absent as `kind:'series'` | Apply relocated additions without removing originals |
| W4 | Tail TIME TBD is visible (the §2 defect) | Same, plus R2 and R5 tests: row `[.., D-1]`, window `[D, until]` gives one dated TBD per weekday in the window | Clip TBD dates to the row's range |
| W5 | Relocated uses the new slot's weekday, times and ground | Same | Keep the original slot's times |
| W6 | Nothing is dropped | Same: series dates − suppressed + added + TBD = output, counted from the seed | Drop the dates of a missing relocated slot |
| W7 | Open or unreadable windows never show timed | Same | Treat an open upper as "until the row ends" |
| W8 | Overlap is loud | Same, with a forged overlap. The DB forbids it, so the test says it is a **defence of an unreachable state** and is not claimed as coverage of a real path (CLAUDE.md §3) | Last-writer-wins |
| W9 | The arms agree | `tests/practiceExceptionsDrift.test.js`, the full product + digest | Flip one cell in the twin |
| W10 | Zone-free | The Deno test under both zones; vitest under Los Angeles | Construct `new Date(date)` in the helper |
| W11 | The feed shows TBD and moved practices | `_shared/tests/ics-feed_test.ts`: VEVENT set from the seed, the CALDESC count including tail TBDs, UIDs per Q1 | Pass `exceptions: []` from `index.ts` |
| W12 | The portal shows them | `tests/teamPortalPracticeExceptions.test.jsx` (the `teamPortalPracticeTbd.test.jsx` precedent) | Drop the second read |
| W13 | A failed exceptions read is said, never silent | R2 and R4 tests: the read errors, and there is a banner / CALDESC INCOMPLETE | Swallow the error to `[]` |
| W14 | RSVP follows the applied calendar | pgTAP: relocated date accepted, original date in a relocated window refused, TBD date refused, outside windows unchanged. Mock arm identical | Keep the weekday-only check |
| W15 | Parents read exceptions as they read assignments | pgTAP: a parent member sees the same exception rows | Tighten the select policy to admins |
| W16 | The census stays complete | `tests/practiceReaderCensus.test.js` (§1.1) | Add an unregistered reader |
| W17 | The enact count is true | `practiceRepairEnact` test: the count excludes seeded TBD dates | Count raw weekdays |

E2E: `tests/e2e/features/team_portal_practice_changes.feature` covers a
parent who sees a moved practice and a TIME TBD date, and whose RSVP is hidden
on the TBD date. Mock data carries `organization_id` (CLAUDE.md §8, rule 1).

The season-2026 fixture suite runs on 12a (a domain helper). No solver stage
changes.

## 7. Size and split

The estimate is about 1,450 lines against the plan's ~400.

| PR | Contents | Touches | Size |
|---|---|---|---|
| **12a** core | `utils/practiceExceptions.js`, the Deno twin, drift test + product + digest, Deno test, wording tables, census test (W1-W10, W16), barrel export | D | ~550 |
| **12b** feed | `calendar-feed/index.ts` read, `buildFeedEvents` adoption, `readFailures` (W11, W13 feed) | P reads | ~250 |
| **12c** portal | `useTeamPortal`, `TeamRecordPage`, mock table and embed, enact count, export note, E2E (W12, W13 portal, W17) | — | ~400 |
| **12d** RSVP | Migration `upsert_team_event_rsvp` + revert + smoke + pgTAP, mock RSVP mirror (W14-W15) | P | ~250 |

Order: **12a → (12b ∥ 12c ∥ 12d)**. 12c shows RSVP on moved practices only
after 12d. **12a alone fixes nothing a family sees.** The §2 defect is fixed
for the feed by 12b and for the portal by 12c.

**What PR 12 does not do:**

- It does not lift the writer's mid-range daylight refusal
  (`20261002000000:1106-1123`) or the adapter's refusals
  (`repairAdapter.js:65-73`).
- It does not enable blackout enact (PR 11d).

## 8. Declared, not enforced

- **D1.** The writer refuses mid-range windows only for daylight reasons.
  `relocated` and other `time_tbd` rows are admitted anywhere
  (`20261002000000:1111-1123`; Edge `index.ts:57-111`). The only guard is the
  adapter. After PR 12 the readers render them correctly, but the RSVP rule
  depends on 12d.
- **D2.** The daylight "tail" test admits a window that starts inside the row
  (`:1116-1118`). The helper renders it correctly (rule 4), but the writer
  comment's "tail" is wider than the builder's.
- **D3.** Nothing forbids a live TIME TBD window overlapping **another** row of
  the same team (the EXCLUDE constraint is per assignment). The helper
  reports `PRACTICE_TBD_SHADOWED`. It does not prevent it.
- **D4.** The exports (R9) and the player record (R10) stay series-level if Q6
  is answered as recommended. The export states it.
- **D5.** The booking guard (X13) does not count relocated exceptions as
  bookings of their target field. A retirement of that field would miss
  them. Deleting the slot is refused loudly (the `practice_slot_id` FK has no
  ON DELETE, `20260929000000:114`). This is for 11d, which first writes
  relocated rows.
- **D6.** Existing RSVPs for dates that became TIME TBD or moved are kept and
  not shown (Q4). No notification is sent. Notification is out of scope.
- **D7.** Overlapping live windows (W8) are defended, but the database makes
  them unreachable. The defence is declared as such, not claimed as coverage.

## 9. Questions for the operator

**Q1. How does a relocated practice show in the ICS feed?**

*Recommendation (not an answer):*

- UID `<assignment>_<actual date>`, the scheme used today. A same-day move
  (new time or ground) then updates the family's existing event. A move to
  another weekday deletes the original and adds a new one.
- The original dates in the window are **removed**, not sent as
  `STATUS:CANCELLED`, because a subscribed calendar drops a removed event.
- SUMMARY is `Practice (moved) - <team>`.
- DESCRIPTION names what it replaces (weekday, time, ground) and the cause
  kind in words ("a field closure", "a field retirement"). It holds enum
  wording only, no notes.

**Q2. Do TIME TBD practices appear in the feed at all?**

*Recommendation (not an answer):* **yes**, using the existing convention: one
all-day `STATUS:TENTATIVE` "TIME TBD - Practice - <team>" VEVENT on each
series date in the window, counted in the CALDESC (`icsFeed.ts:675-679`,
`:707-720`). An open or unreadable window has no day, so it goes in the
CALDESC only.

**Q3. What do the coach and parent views show?**

*Recommendation (not an answer):*

- A moved practice shows at its new time and place, with a "Moved from
  <weekday> <time>, <ground>" line.
- A TIME TBD date shows "Time TBD on <date>: <reason>" in date order, with
  RSVP hidden.
- Coaches and parents see the same thing. There is no role difference in
  PR 12.

**Q4. RSVPs.**

*Recommendation (not an answer):*

- A moved practice is RSVP'd as (assignment id, **new** date).
- The RPC refuses new RSVPs for TBD dates, and for original dates inside a
  relocated window.
- Stored RSVPs are never deleted or rewritten (audit immutability). They are
  simply not shown.

**Q5. What if the exceptions read fails while the practices read succeeds?**

*Recommendation (not an answer):* do not 500 and do not hide practices.

- Feed: `readFailures` gains "practice changes", and the CALDESC says
  "INCOMPLETE: practice changes could not be read, so some practices shown may
  have moved or have no confirmed time."
- Portal: the same sentence in a `role="alert"` banner.

**Q6. Do the exports (R9) and the player record (R10) adopt the helper in
PR 12?**

*Recommendation (not an answer):* **no**. Both are series views. The export
message states how many practices have temporary changes it does not show,
and a follow-up makes the CSV occurrence-based. The latest-run-id question
(§2, adjacent) is filed as its own issue.

**Q7. Unreadable or open windows, and overlapping live windows.**

*Recommendation (not an answer):* be conservative, as in §3 rules 6-7. Never
show a timed practice an exception might supersede. Emit TIME TBD with a
finding.

**Q8. Who lifts the mid-range refusals, and when?**

*Recommendation (not an answer):* **not PR 12.**

- The adapter's refusals are lifted by PR 11d.
- The writer's daylight refusal is lifted by a separate migration, only after
  12b, 12c and 12d have merged and Q6 is settled, because R9 and R10 still
  show the series.

**Q9. Relocated dates outside the row's own range: clip, or follow the
window?**

*Recommendation (not an answer):* **clip to the row's range**. A relocation
changes the series; it does not extend it. Blackout windows lie inside the
row anyway (`repairAdapter.js:641-643`). TIME TBD is deliberately **not**
clipped, so tail windows show (§3 rule 4).

**Q10. A TIME TBD date on which the same team has a timed practice from
another row.**

*Recommendation (not an answer):* show both and log `PRACTICE_TBD_SHADOWED`.
A writer-side check (a live `time_tbd` window may not overlap another row of
the team) is a follow-up migration. It is declared (D3).

**Q11. Fix the §2 defect ahead of the full split?**

*Recommendation (not an answer):* **no separate hotfix.** Land 12a, then 12b
first: the feed is where families look.

- If the §2 query shows live tail rows in production and 12b cannot land
  soon, a stopgap is possible: the feed emits dated TBDs for tail `time_tbd`
  rows only.
- That stopgap would be a second, narrower contract, which CLAUDE.md §3 warns
  against. It should be taken only by explicit ruling.
