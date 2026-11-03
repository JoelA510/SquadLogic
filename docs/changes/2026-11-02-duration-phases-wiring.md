# Duration phases: wire the practice duration-phase reports, flagging what they cannot save

Kind: FEATURE · Drawn up: 2026-11-02 against `origin/main` `228980a` · Owner: the repository owner ·
Status: **DECIDED 2026-11-02: Reading A, decisions 1 to 7 as recommended. PR A (core, tasks A1 to A5) is
merged (#698); PR B (the page, tasks B1 to B5) is built in the pull request that follows it.**
AGENTS.md rule 14 applied (the change touches the practice domain layer), so no code started until the
owner chose a reading in "Owner decisions" (below, as drawn up).

Every claim about the code is _statically reviewed_ (read) unless marked _executed_. Executed figures
come from `npx vitest run` on the unmodified tree and from throwaway scripts kept outside the repository
(they import the core package by absolute path and change nothing), run on 2026-11-02. A claim of absence
was only made after the same search, with a positive control, matched something.

## Owner decision (2026-11-02, verbatim)

> "Wire the durationPhases as recommended."

and, of the two readings section 3 offers:

> "Go with A on durationPhases"

Reading A is a read-only "Practice daylight" outlook. Reading B (apply the retimed lengths, which needs a
schema change) is **not** part of this work. The defaults of section 12 are accepted: a flagged date still
occupies its field; the page lives at `/schedule/practice-daylight` under the Practices permission with no
feature flag; the builders are duplicated behind a parity test, not extracted from the repair adapter; the
G4 cascade stays unwired.

Context: `docs/changes/2026-11-02-unknown-sunset-flag.md` section 6 (B4) found that
`packages/core/src/practice/durationPhases.js` holds a known past-sunset date out as TIME TBD (`:654`,
`:730`), that nothing in the app calls the module, and recommended: when it is wired, apply the owner's
principle there (a sunset condition is flagged as a warning, never refused or held out, because coaches
and organizations may accept conditions outside the app).

## Size verdict (prompts/plan-change.md, Step 0)

Planned, not small. It meets three of the "needs a plan" tests: it spans more than one pull request (two
for the reading recommended below, six or more for the other), it adds a screen people rely on, and its
second reading changes what is stored. The plan is in the owner's hands before any task starts.

## 1. What a duration phase is, who sets one, and why nothing calls it

_Statically reviewed._

**The product problem.** An unlit practice must end by sunset (owner ruling 2026-09-27, margin 0). In
autumn sunset comes about a minute earlier each day and about an hour earlier when daylight saving ends
(1 November 2026), so a Tuesday 18:00 to 19:00 practice that is legal in early September is dark by late
September. A _duration phase_ is a dated step in one slot's timeline: "from this date the slot runs this
long, starting this early". The module derives those steps; it is a proposal tool and **applies
nothing** (its header, `:3-7`).

**What it computes**, over the input plan's slots and dates (never the output):

| Report                              | Says                                                                                                                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3 `derivePracticeDurationPhases`   | per unlit slot, the ordered phases: shorten in 10-minute steps down to a 40-minute minimum, or start earlier (never before school-day end, never into an earlier slot that night), each with the sunset and the binding date; dates nothing can save are "held out" (`tbd`) |
| G4 `buildPracticeCompressionReport` | hold-starts (every slot-date still past sunset under the schedule) and a cascade proposal (later slots of a night start earlier), which leaves only as an 8.8 change-log, never applied                                                                                     |
| G5 `buildDstSurvivalReport`         | per unlit slot: survives, does not survive, unknown, exempt, or no dates; for a non-survivor, the fixes (lit field, earlier start, another night, portable lighting) and a `d8` block naming the date D8 "would truncate"                                                   |

**Who sets a phase.** Nobody; a phase is derived from sunset, the strategy, the minimum, the step and
the floor. What an admin may supply (D14, operator 2026-09-29, `docs/PHASE_8_9_D14_PLAN.md`):

| Input                                            | Stored today?                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Venue coordinates and `lighting_available`       | Yes: `locations`, with an admin form (`LocationCoordinatesForm.jsx`)                                                                          |
| Earliest start: `season_settings.school_day_end` | Yes: column, default 16:00 (`20251214000002_timezone_settings.sql:9`); the Practices page already reads it (`PracticeSchedulingPage.jsx:948`) |
| Portable-lighting windows                        | Yes: `practice_lighting_overrides`, an admin page (`PracticeLightingPage.jsx`), read by the Edge pass                                         |
| Minimum 40 and step 10                           | Constants (`schemas.js`), not settings                                                                                                        |
| Per-slot strategy (shorten or shift)             | **No** storage, **no** UI: only a parameter of the module                                                                                     |
| Operator duration pins (`overrides`)             | **No** storage, **no** UI: only a parameter of the module                                                                                     |

**Who wrote it and why it is unwired** (`git log`, the D14 plan, the 8.9 plan). Two commits, both under the
owner's git identity on 2026-09-28: 8.9 PR 5 (#474, `bffe156`) and D14 PR A (#494, `339bfae`); the file has
not changed since. The 8.9 plan table (section 3) leaves the core schedulers "unchanged; stated
unenforced"; D14 default 6 says the Edge "proposes shortening or shifting and does not apply it ... applying
needs a stored 'retimed' representation, which would be a later PR E"; default 8 says "G3 stays core-only
until the UI PR". The D14 PR table then spent PR B on the lighting-override table, PR C on the Edge read of
approved windows, and PR D on the lighting request/approval screens (`D14 plan, PR split`): **no PR was ever
scheduled to show the phases or to apply them.** `tests/unwiredLayerImporters.test.js:816-830` pins that,
in both directions: the only importer is `practice/index.js`, the only consumer is
`tests/practiceDurationPhases.test.js`, and the expected production consumers are empty.

Two things in the module are stale against the live path. (1) It describes D8 ("a weekly slot ... is truncated
at its first illegal date and the remainder goes TIME TBD; that truncation belongs to the Edge post-pass",
`:77-84`, and the `d8` block of G5, `:1446-1451`); the Edge pass stopped truncating on 2026-10-27 and now
keeps and flags (`practice-daylight.ts:30-40`). (2) Its `tbd` list is named for a persisted state
(`time_tbd`) that nothing in this module writes.

**Executed on the season-2026 corpus** (the '93 Combined' revision, 141 unlit slots, 1,833 slot-dates,
17 Aug to 13 Nov 2026, school-day end 16:00; one synthetic coordinate pair at every venue, as the existing
test uses, because the corpus ships none): 341 phase transitions (160 shortenings, 181 fallback shifts),
the first on 21 September; 51 slots survive and 90 do not; 312 slot-dates cannot be saved (166 in October,
146 from 1 November); 98 cascade proposals; the three reports together take about 113 ms. A concrete slot,
`s2026-practice::33`, Tuesday 18:00 for 60 minutes: 50 minutes from 22 Sep, 40 from 29 Sep; on 6 Oct a
40-minute practice ends 18:40, after sunset (18:34), shortening would leave 30 minutes, below the minimum,
and starting at 17:50 would overlap an earlier slot that ends at 18:00, so 6 Oct and three more Tuesdays
cannot be saved; from 3 Nov (sunset about 16:55) it moves to 16:10, then 16:00. **As the corpus ships,
with no coordinates, all 1,833 slot-dates are unknown and all 141 slots read `unknown`**: the module has
nothing to say until a venue has coordinates.

## 2. Everything wiring would touch

| Surface                                                        | Today (evidence)                                                                                                                                                                                                                                                                                                      | Reading A (outlook)                                                         | Reading B (apply)                                                                                                                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live callers of the module                                     | None. `git grep` of the module's name and its three entry points over `packages frontend supabase tests scripts` finds the module, its barrel `practice/index.js`, `tests/practiceDurationPhases.test.js`, the census, and three comments (`daylight.js:80`, `schemas.js:448`, the `practice-daylight` registry note) | A frontend hook calls it                                                    | Same, plus the apply path                                                                                                                                                                       |
| Practice repair (`repair.js`, `repairAdapter.js`)              | Judges candidates by `evaluatePracticeDaylight`; does not import the module                                                                                                                                                                                                                                           | None                                                                        | Must learn a slot that runs retimed                                                                                                                                                             |
| Auto-scheduler Edge (`practice-daylight.ts`) and its core twin | Flags new placements and locked rows past sunset; no ladder, shorten, shift or compress code in `supabase/functions` (searched with a positive control: `sunset` matches 19 files). The core `practiceScheduling.js` and `autoScheduler.js` do not call the module                                                    | None. The report is browser-side, like the repair, so there is no Deno twin | A Deno twin of a 1,473-line module (about 1,000 lines of logic, an estimate), a committed product digest like the three existing ones, the Deno mirror under both host zones, the 1.5 s CPU cap |
| Writer and enact RPCs (`persist_practice_schedule`)            | Persist `relocated` and `time_tbd` exceptions only: `practice_exceptions_kind_check` is `('relocated','time_tbd')` (`20260929000000:125`) and no later migration replaces it; the writer's gate refuses a "wrong length" auto row (`practice-scheduling.md:130-133`)                                                  | None                                                                        | A new exception kind or table, the writer body copied whole (lesson 11), the gate taught the retimed length, revert and smoke, harness plants                                                   |
| Persisted shapes                                               | `practice_slots` has no phase or retime column (`season_overrides` and `season_phases` match no migration); core's `shortened` and `moved` exception kinds (`practice/schemas.js:220-227`) exist in memory only (`materialise.js:273-283`)                                                                            | **None**                                                                    | **Yes**                                                                                                                                                                                         |
| Settings and columns it needs                                  | All exist except per-slot strategy and pins (table above)                                                                                                                                                                                                                                                             | None new; strategy and pins stay at their defaults                          | Strategy and pins need storage and a screen                                                                                                                                                     |
| Feature flags                                                  | `featureFlags.js` has no practice or daylight flag; daylight is a ruling for "every league" (owner 2026-10-27)                                                                                                                                                                                                        | None recommended                                                            | None                                                                                                                                                                                            |
| Readers of what is stored                                      | ICS feed (`_shared/calendar/icsFeed.ts`, `practiceExceptions.ts` and its core twin), master export, publication parity, team calendars, `useCurrentPracticeSchedule`                                                                                                                                                  | Untouched: nothing is stored                                                | Every reader and its twin must show the retimed practice                                                                                                                                        |
| Mock client and demo                                           | The browser runs core, so the mock path needs no mirror; the demo seed gives its four venues coordinates (`20261110010000_demo_practices.sql`), the mock client's own seeds give none (the repair's E2E sets them: `practice_repair_panel.ts:274`)                                                                    | Demo works; mock E2E seeds coordinates                                      | Mock must mirror the new write; CHECKs exist only in the real database (lesson 4)                                                                                                               |
| Drift and mirror tests                                         | None to add: there is no Edge arm                                                                                                                                                                                                                                                                                     | None                                                                        | New digest, Deno test, drift test                                                                                                                                                               |
| UI                                                             | Nothing shows a phase. The Practices page shows the Edge pass's "runs past sunset ... kept" line (`daylightReport.js`); the repair panel shows per-row flags                                                                                                                                                          | One read-only page (Design)                                                 | That page, plus an apply action with its enact dialog, plus the strategy and pin authoring                                                                                                      |

## 3. Two readings of "wire it"

**Reading A, the outlook (recommended).** A read-only admin page runs G3 and G5 over the saved season
schedule and shows what the rest of the season will do to each unlit slot. Nothing is applied and nothing
is stored. This is what the module was built to be (a proposal tool) and what "wire ... as recommended"
most directly asks: the principle in B4 is about the module's own hold-outs, which only matter once it is
called.

**Reading B, apply.** The retimed practice becomes real: calendars, exports and the feed show 50 minutes
from 22 September. That needs a stored representation that does not exist, readers that understand it, an
apply action, and authoring for the per-slot strategy. It is the "PR E" D14 deferred, and it is a feature in
the full sense (new persisted shape, new screens, a second source of truth for a practice's length beside
`practice_slots` and the division's `practice_minutes`). It is sized in section 10 so the choice is
informed; it is **not** part of this plan.

Reading A is advice. An admin who reads "shorten to 50 minutes from 22 September" still edits the slot or
the assignment by hand, or accepts the flag. The page says so on its face.

## 4. Behaviour under Reading A

For a league admin (docs/product.md: the only user who signs in):

- **Now.** After an auto-scheduler run the Practices page says "N new practices run past sunset on unlit
  ground and are kept as placed, for you to decide: team X from 25 Sep (ends 19:00, the latest allowed is
  18:41)". The repair panel flags a candidate that runs past sunset. Nothing says what the rest of the season
  holds: which slots go dark in October, how short they would have to get, which can never be saved after
  daylight saving ends, and what would fix them. The admin works that out by hand.
- **After.** A page under Scheduling, "Practice daylight", lists every unlit slot of the season with:
  its verdict (runs to the end of the season, goes dark from a date, cannot be saved on some dates, sunset
  unknown, or covered by portable lighting); the proposed lengths by date ("60 min now; 50 min from 22
  Sep; 40 min from 29 Sep; starts 16:10 from 3 Nov"); the dates no shortening or earlier start saves,
  shown as **kept as scheduled and past sunset** with the reason in words (the same wording family as the
  repair's flag); and the fixes (a lit field, an earlier start, another night, portable lighting, with a
  link to Practice lighting). A banner states it is proposed, not applied. Where no venue has coordinates
  the page says so and points at the coordinates form, instead of showing a list of "unknown".
- **Unchanged (each becomes a regression test).** No practice, assignment, exception, export, calendar or
  feed changes. The auto-scheduler, the repair, the writer and every migration are untouched, and so is
  every solver result on `fixtures/season-2026` (section 8). The Edge pass still flags and never blocks.

## 5. Flag, not hold out: each place in the module

The principle (owner, 2026-11-02): a sunset condition is a warning; the date stays, with a flag. In this
module a date nothing can save today leaves `deriveSlotTimelines` with `tbd.push(...)` and `continue`.

| #   | Place (line refs on `228980a`)                                                          | Today                                                                                        | After                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | `:651-668`, `:654` (a shifted slot would overlap an earlier slot that night)            | held out as TIME TBD `overlap`; the practice is treated as **not on the surface** that night | `flagged` entry, the date stays at its current timing, and **it occupies the surface at that timing**. The overlap is a facility conflict, not a sunset one, so the flag says "the proposed earlier start would overlap" |
| F2  | `:721-744`, `:730` (neither a shorter practice nor an earlier start saves the date)     | same hold-out, same "occupies nothing"                                                       | the same `flagged` entry with `shortenRefused` and `shiftRefused`; the date keeps its current timing and occupies the surface; the state is unchanged for later dates                                                    |
| F3  | `:636-639` (no sunset for the date)                                                     | already flag-like: kept at its current end, counted, never read as legal                     | unchanged in behaviour; wording only                                                                                                                                                                                     |
| F4  | `:1118-1121` (G4) and `:1322-1334` (G5 `UNKNOWN`)                                       | already flag-like                                                                            | unchanged                                                                                                                                                                                                                |
| F5  | `:1446-1451`, the G5 `d8` block (`legalThrough`, `tbdFrom`, `tbdDates`, `heldOutDates`) | describes a truncation the Edge no longer does                                               | replaced by `firstFlaggedDate` and `flaggedDates`; the verdict names (`does-not-survive`) stay, being a verdict about a proposal                                                                                         |
| F6  | The header (`:53-56`, `:77-84`, `:95-97`) and `PRACTICE_RETIME_REFUSAL` text            | "TIME TBD (D8)", "Enforced nowhere live"                                                     | rewritten to what is true: flags, and called by the outlook                                                                                                                                                              |

**What carries the flag.** An in-memory entry on the report, exactly as `daylightPastSunset` rides on a
repair recommendation: `slotPhases[i].flagged[]` of `{ date, code: 'PRACTICE_PAST_SUNSET', shortenRefused,
shiftRefused, reason, startMinutes, durationMinutes, wouldStartMinutes, floorMinutes, earlierEndMinutes,
sunsetMinutes, limitMinutes, sunsetSource }`, the counter `slotDatesFlagged` (replacing `slotDatesHeldOut`),
and G5's `flaggedDates`. It is not persisted, in no Zod schema, no CHECK, no enum. The module stores only
the finding **code**; the severity the page shows comes from the severity map, so it follows whatever the
separate sunset-severity relabel (constraints, reason codes, game kickoff) decides, and this change does not
edit that map or the `practice-daylight` registry note.

**The one real design decision: does a flagged date occupy the surface?** Today a held-out date
"occupies nothing", so a later slot may shift into the room it vacated (`:722-725`). Under the principle the
practice is not held out; it still happens, past sunset, and a later slot cannot be proposed into its
minutes. So a flagged date occupies. This is not a relabel: **executed** on a patched copy of the module
kept outside the repository, on the corpus above, it changes the reports (now / flagged): 341 / 317
phase transitions, 181 / 157 fallback shifts, 312 / 336 slot-dates that cannot be saved (24 more, none
fewer), and 17 of the 141 slots derive different phases. A pure relabel (keep "occupies nothing") moves
nothing, but then proposes a shift into minutes a still-running practice holds. The recommendation is to
occupy (Owner decision 2).

## 6. Design (Reading A)

**Core, `packages/core/src/practice/`** (domain, rule 14):

- `durationPhases.js`: section 5. Same inputs, same ladder, same floor, same minimum, same margin; the
  comparison stays in `endsByDaylightLimit` only.
- `durationPhaseAdapter.js` (new, registered in `practice/index.js`): `buildDurationPhaseInput(rows)` turns
  the rows the page reads (locations, fields, field subunits, practice slots, practice assignments,
  approved lighting windows, the season's dates, zone and `school_day_end`) into the module's input. It
  follows the repair adapter's contract for every shared edge (uuid check, `numeric` coordinates as strings,
  `HH:MM:SS` times, a sub-unit's parent) and **adds three rules the repair does not need**: an undated
  slot (`valid_from` or `valid_until` null) is dated by the season window, as the Edge pass does, and never
  skipped (the module lists undated slots as `undatedSlots` and judges nothing for them, which a page must
  not present as "fine"); a missing season zone is an error the page shows, not a guess; an unreadable
  `school_day_end` is `null`, so a shift is refused with a reason, never assumed.
- The repair adapter is **not** refactored. The graph, slot and calendar construction is about 45 lines
  that both adapters need. Extracting it is a refactor beyond the request (rule 2): the cost of the status
  quo is a second copy; the risk of the change is that it exposes the 61 fixture and repair test files to a
  shared edit. The plan duplicates the lines and holds the copy to the original with a parity test over one
  snapshot (lesson 77), and leaves the extraction to the owner (Owner decision 6).

**Frontend** (UI):

- `hooks/usePracticeDaylightOutlook.js`: reads the snapshot's tables (the repair snapshot's column lists
  for locations, fields, subunits and slots) plus the season's assignments (`loadSeasonPracticeAssignments`,
  the page's complete-read contract), approved lighting windows and the season settings. **All or nothing**,
  as `loadPracticeRepairSnapshot` is: any failed read is `{ ok: false }` naming the table, and the page
  then says it could not be read, never "survives". Read-only; no RPC; as the signed-in user through RLS.
- `pages/PracticeDaylightPage.jsx`, `components/daylight/DaylightOutlook.jsx`, `utils/daylightOutlook.js`
  (wording helpers, in the style of `practiceRepairPanel.js` and `daylightReport.js`), a route
  `/schedule/practice-daylight` guarded by `VIEW_SCHEDULE` (the Practices page's permission: it reads the
  same data) and a navigation entry. No new permission, no new environment variable, no flag.
- States: loading; unreadable (names the table); no season or no zone; no unlit slots; no venue with
  coordinates (points at the form); some venues without (those slots read "sunset unknown", never "fine");
  everything fits; some flagged. A semantic table (a caption, header cells with scope), the verdict in words
  as well as colour, both themes through tokens, keyboard-reachable links to Practice lighting.
- The page declares what it does not do: proposed, not applied; "declared, not optimised" (D11); the
  strategy is the default (shorten, then move earlier when the minimum would be broken) because there is no
  setting to change it.

**Edge and database: nothing.** No Edge change, no migration, no RPC, no policy, no audit action.

**G4's cascade is not wired in step 1.** Its hold-starts equal G3's flagged set (the existing test asserts
the equality), and its proposals leave only as an 8.8 change-log that no screen renders (`buildChangeLog`
has no frontend importer; searched with a positive control). The page therefore calls G3 and G5. The cascade
stays in the module as it is, which makes `buildPracticeCompressionReport` still unconsumed in production;
the plan says so rather than hiding it (Owner decision 5).

## 7. The stop conditions, checked

| Stop condition                                                | Reading A                                                                                                                                                                                                      | Reading B                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A schema, CHECK, enum, column or other persisted-shape change | **Triggered: no.** The flag is an in-memory key; every input is an existing column; `practice_exceptions_kind_check` is untouched                                                                              | **Triggered: yes** (a new exception kind or table; the kind CHECK admits only `relocated` and `time_tbd`) |
| A new setting or UI to author phases                          | **Triggered in part.** A new read-only screen, yes; nothing authors a phase; the per-slot strategy and the duration pins have no storage or UI today and stay at their defaults (a stated limitation)          | **Triggered: yes** (strategy and pins need storage and a screen; so does the apply action)                |
| Changes to solver results on the season fixture               | **Triggered: no for the solver and the repair.** The module's own corpus output moves under the recommended occupancy rule (section 5, executed); the fixture suite is rerun in PR A to show nothing else does | **Triggered: likely** (a retimed length reaches the writer's gate and the feeds)                          |
| More than one PR of work                                      | **Triggered: yes**, two PRs (A about 450 to 600 lines, B about 800 to 1,000, estimates)                                                                                                                        | **Triggered: yes**, six or more, about 2,500 to 3,500 lines (estimate)                                    |

So even the smaller reading stops on two conditions (a new screen, and more than one PR), which is why this
is a plan for the owner and not a build.

## 8. Season-2026 and the test files

_Executed, 2026-11-02, on the unmodified tree._

- `npx vitest run tests/practiceDurationPhases.test.js tests/unwiredLayerImporters.test.js`: 2 files,
  112 tests, all passing. The full suite, `npx vitest run`: 489 test files and 7,794 tests, all passing,
  exit 0 (656 s, under load shared with another run). That is the baseline PR A is compared against.
- Test files that load the fixtures or run the repair: **61** by the pattern `fixtures/index|season2026|
repairPracticeLoss|loadSeason2026|loadFacilityGeometry|loadSunsets|buildPracticeRepairInput|
loadCombinedSchedule|loadCoachRoster|season-2026` over `tests/` (the brief's "60" is the same family; 53 by
  a narrower pattern). **Only one of them imports the module**: `tests/practiceDurationPhases.test.js`. The
  census test names it too. So the core change cannot move the other 60 unless a shared module is edited,
  and the plan edits none (the adapter duplicates rather than extracts).
- What does move, and only in `tests/practiceDurationPhases.test.js` (55 lines match `tbd`, `heldOut`,
  `d8`, `DOES_NOT_SURVIVE`, "held out"): the cases that pin the hold-out (W19, W20, W22, the corpus
  hold-starts equality and `slotDatesHeldOut`, the G5 `d8` assertions) and, if occupancy is chosen, the
  independent sweep's line "TIME TBD tonight: not on the surface, so it occupies nothing" (`:1076`).
- `fixtures/season-2026`: no fixture file changes. Its practice corpus ships no coordinates, so the outlook
  would read `unknown` for all 141 slots until a venue has them; nothing in the solver, the constraints or
  the repair reads the module, so their results are unchanged by construction. PR A reruns the season
  fixture suite and the corpus sweep to show that, rather than rely on the construction.
- The census entry for the module (`tests/unwiredLayerImporters.test.js:816-830`) is exact in both
  directions, so adding the adapter and the frontend consumer fails it until the entry lists them; that is
  the check working, shown red before the edit (plant P5).

## 9. Risks and rollback

- **Risk:** the page reads as enforcement, and an admin believes the schedule shortens itself. — **watch:**
  the page's banner and a test that finds the sentence; a support question. — **if it happens:** the copy
  is wrong, not the data; fix the copy.
- **Risk:** a partial read shows slots as surviving. — **watch:** the all-or-nothing hook test (P4). — **if
  it happens:** `{ ok: false }` already forbids it; a regression turns that test red.
- **Risk:** occupancy changes the proposal for 17 of 141 corpus slots, and an admin who saw a proposal
  elsewhere sees it move. — **watch:** none, the module has no users yet. — **if it happens:** none needed.
- **Risk:** the relabel PR edits the `practice-daylight` registry note that
  `tests/practiceDurationPhases.test.js:1283-1290` pins by text (`declared, not optimised (D11)`, `never
applied`). — **watch:** whichever merges second sees the test red. — **if it happens:** rebase and keep
  both phrases in the note.
- **Risk:** the module's 113 ms on 141 slots grows with a large league and blocks the browser. — **watch:**
  a timing test on the demo grid (128 teams, 196 slots) at the default 5 s timeout. — **if it happens:** run
  it in the optimizer's worker precedent.
- **Rollback:** PR B reverts alone (a page, a hook, a route, a nav entry). PR A reverts alone (the module's
  flag rename and an adapter nothing else calls). No migration, no data, nothing to undo.

## 10. Tasks

Sizes are estimates, not measurements: S under 150 lines, M 150 to 500, L over 500 with tests.

**PR A, core** (domain; rule 14; no migration, no UI). Run the season fixture suite and the Definition of
Done.

- [x] A1 (M) Flag, not hold out, in G3 (F1, F2, the occupancy rule). Proved by
      `tests/practiceDurationPhases.test.js`: a slot below the minimum with no legal shift keeps its
      timing, appears in `flagged` with its date and both refusals, and nothing shorter than 40 minutes is
      emitted; **new**: a flagged practice occupies its surface, so a later slot's shift into its minutes
      is itself flagged `overlap` (fails against today's module, plant P1); the corpus sweep's independent
      model rewritten to occupy and equal to the module's retimings and flagged set, non-empty.
- [x] A2 (S) G5 and G4 follow (F5): `d8` gone, `firstFlaggedDate` and `flaggedDates` present. Proved by the
      same file: each non-survivor's `firstFlaggedDate` equals its first flagged date; no `reason` or key
      contains "TIME TBD" or "d8" (the search is run with a positive control that it matches the old
      module); hold-starts still equal the flagged set.
- [x] A3 (M) `durationPhaseAdapter.js`. Proved by `tests/practiceDurationPhaseAdapter.test.js` (new): over
      one snapshot with a lit and an unlit venue, a string-typed coordinate, a sub-unit, and an undated
      slot, its graph, slots and calendar equal `buildPracticeRepairInput`'s (the twin held by a test);
      the undated slot is dated by the season window and present in the output (the subject set comes from
      the rows, plant P3); no zone throws; an unreadable `school_day_end` makes a shift
      `earliest-start-unknown`.
- [x] A4 (S) Stale statements: the module header (F6), `docs/PHASE_8_9_D14_PLAN.md` (a dated note under
      defaults 6 and 8), `docs/PHASE_8_9_PLAN.md` (the G3 row), `docs/architecture/practice-scheduling.md`
      (the Daylight section), and `docs/changes/2026-11-02-unknown-sunset-flag.md` section 6 (B4 marked
      decided). Proved by reading; `tests/sourceHygiene.test.js` stays green (no raw control characters).
- [x] A5 (S) Census: the adapter is registered in `practice/index.js`; `tests/unwiredLayerImporters.test.js`
      lists its new importers. Proved by that test, shown red before the entry is edited.

**What PR A did differently from the tasks above** (each is a finding of the build, not a change of
scope; nothing here needed a schema, CHECK, enum, column or persisted shape, and the season fixture suite
did not move):

- **Hold-starts are a subset of the flagged dates, not always equal to them (A2).** The corpus equality
  holds (every corpus flag is past sunset at its timing). But F1's `overlap` flag is raised before the
  sunset comparison, so a shifted slot that a pinned or lit earlier slot now blocks is flagged although it
  ends inside daylight (the existing "re-checked every night" case: 16:50 to 17:50 against a 17:50 limit).
  G4's hold-starts are the dates left past sunset, so they do not list it. The tests pin both: equality on
  the corpus, and the strict subset on the rig. That flag carries `PRACTICE_PAST_SUNSET` as the old TIME TBD
  entry did; the entry has `startMinutes`, `durationMinutes` and `limitMinutes`, so the page (PR B) can word
  an overlap-only flag as an overlap.
- **G5 row shape (A2).** Every row has `flaggedDates`, `firstFlaggedDate` and `refusals` (empty or null
  where there is nothing to name), so the keys do not depend on the verdict. `failingDates` became
  `flaggedDates` (one name for one list); `d8` and its `legalThrough` are gone; the counter
  `slotDatesHeldOut` is `slotDatesFlagged`.
- **The adapter is stricter than the repair's in three places (A3).** All six tables must be present (a
  forgotten read must not look like "nothing to judge"); a season with no dates is an error as well as one
  with no zone; and an approved lighting window the module would refuse (a slot now on lit ground, or no
  slot read) is left out and named in `declared.lightingOverrides.notApplied`, so it cannot take the whole
  report down. A half-dated slot's missing end is the season's, never beyond the end it does state.
- **Census (A5).** Besides the module's own entry, the adapter's imports and calls changed four other
  entries (`slots.js`, `lightingOverrides.js`, `coachPreferences.js`, `repairAdapter.js`), which the test
  caught and which are updated; the adapter has an entry of its own.
- **Executed on the season-2026 corpus** (141 unlit slots, 1,833 slot-dates), before and after: phase
  changes 341 and 317; shortenings 160 and 160; fallback shifts 181 and 157; flagged (held-out) dates 312
  and 336, 24 more and none fewer; slots with different phases 17 of 141; survivors 51 and 51; the cascade's
  98 proposals unchanged.
- **Plants** (the owner's cap is three): P1, P2 and P3, the three that guard the one design decision, the
  "none dropped" meta-assertion and the hollow-guarantee shape (the adapter's subject set). P4 and P5 belong
  to PR B; P6 (a missing zone read as UTC) has a plain test and was not planted.

**PR B, frontend** (after A merges; at most two PRs in flight).

- [x] B1 (S) The read hook. Proved by `tests/practiceDaylightOutlookHook.test.jsx` (new): each of the
      tables failing in turn gives `{ ok: false }` naming it; no row renders as surviving (plant P4);
      a season with no zone is a message.
- [x] B2 (M) Page, component, helper, route, navigation. Proved by `tests/practiceDaylightOutlook.test.jsx`
      (new): one estate with a surviving slot, a slot that goes dark with its phases in words, a slot with
      a flagged date ("kept as scheduled"), a slot at a venue with no coordinates ("sunset unknown"), a
      slot under a lighting window; the banner sentence; the empty, loading and unreadable states; axe
      clean; the link to Practice lighting is a real link.
- [x] B3 (S) Wording helper. Proved by `tests/daylightOutlookText.test.js` (new): the exact sentences,
      including a minimum-breaking date and the DST date.
- [x] B4 (M) One E2E scenario, `tests/e2e/features/practice_daylight_outlook.feature` with its steps:
      coordinates set through the mock (as `practice_repair_panel.ts:274` does), the page lists the dark
      slot with its first date; with no coordinates it says so; axe (WCAG 2.0 to 2.2 A and AA, serious and
      critical) in both themes. Run after `bddgen`.
- [x] B5 (S) Census and docs: `tests/unwiredLayerImporters.test.js` gains the frontend importer and the
      first expected production consumer for the module (the claim that it is unwired is retired); the
      docs index and `docs/architecture/practice-scheduling.md`; a lesson.

**What PR B did differently from the tasks above** (each is a finding of the build, not a change of scope;
no migration, schema, Edge or Deno change, and no core behaviour changed: two header comments in `practice/`
stopped saying nothing calls the module):

- **Seven reads, not six (B1).** The adapter needs six tables; the page also reads `teams` (id and name),
  so a slot shows the teams on it by name. It is part of the same all-or-nothing read: any one failing, by an
  error answer or a rejected request, is `{ ok: false }` naming the table. The rejected-request case found a
  gap in the first draft: core's `loadSeasonPracticeAssignments` returns `{ ok: false }` for a refused read
  and **throws** for a rejected one, so the assignments read is caught and named like the others.
- **The season row comes from the organization context** (it is already read there), not from an eighth
  read. A season with no time zone, no season, or a season still being read is answered without reading.
- **Imports are direct, not through the barrel (B5).** The page's model imports `durationPhases.js` and
  `durationPhaseAdapter.js` by path (the precedent of `utils/lightingOverrides.js`), so the census lists it as
  an importer and as the first production consumer of both; it also names the wording test as a consumer of
  `slots.js` and of both sunset arms by name (the test calls them to re-derive every limit a sentence quotes).
  G4 stays uncalled, as decided.
- **Two kinds of flag are worded apart (the PR A note).** An entry raised by the overlap check before any
  retiming is tried (`shiftRefused` overlap, nothing shortened, `wouldStartMinutes` equal to `startMinutes`) is
  worded as an overlap, "another practice is on this field at that time", and counted apart in the slot's
  verdict; it says "it also ends after the latest it may end" only when it does. **No stored-row case reached
  it** (statically reviewed; not proven impossible): the earlier slot's end only grows back through an operator
  duration pin or a lighting window, and a shifted slot has to fit between a retimed slot's end and the limit,
  a gap the ladder leaves under a step; the pin has no storage. So that sentence is pinned from the module's own
  output on a rig (as `practiceDurationPhases.test.js` builds it), and the reachable overlap (a shift refused
  because another practice holds the field) is pinned through the page.
- **An unknown-sunset slot's fix is the coordinates**, a fix the module has no entry for (its fixes are for a
  slot that does not survive); the page adds it, with a link to Fields & Venues, and does not print the
  "candidates only" line under it.
- **No venue with coordinates** is one message with a link, not a list of "unknown" (every judged date unknown
  and no unlit venue with a coordinate pair); some venues without is a row each.
- **The table is a real table.** The class name `grid` (the data grid's) also takes Tailwind's `grid`
  utility, `display: grid`, so a header and each row lay out as separate tables: invisible to the tests and to
  axe, and plain in a screenshot (header columns narrower than the body's). `table.grid.grid-prose` restores
  `display: table` for this one table, in `styles/grid.css`; the other tables are untouched.
- **Timing, executed.** `buildDaylightOutlook` over the demo league's grid (`DEMO_GRID`: 304 slots, 274 on
  unlit ground, 3,014 slot-dates, 128 teams; the plan's 196 slots was the grid before PR F) took 130 ms the
  first time and 47 to 66 ms after, on the main thread, so there is no worker; the test asserts it finishes
  well inside the default 5 s.
- **Axe is run in Chromium**, in both themes, by the E2E scenario (axe-core is not a direct dependency, so
  the jsdom test checks structure: a caption, column headers with scope, landmarks, headings, real links).
- **Plants** (the owner's cap is three): P4 (a failed read made an empty one: 22 tests red), P5 (a frontend
  importer with no census entry: 4 red) and one of the builder's choice, the overlap sentence replaced by the
  past-sunset one (2 red); each reverted and confirmed byte-identical.

**Reading B, sized only** (a separate plan, not these tasks): (1) a migration widening
`practice_exceptions_kind_check` and its shape CHECK, or a phases table, with revert, smoke, harness plants
and census (L); (2) the writer body copied whole, taught the retimed length, and the Zod schemas (L); (3)
every reader and its twin: the ICS feed, `practiceExceptions` in core and Deno, the master export,
publication parity, the team calendar (L); (4) per-slot strategy and pins: storage and a screen (M to L);
(5) an apply action and its enact dialog on the repair's pattern (L); (6) the Deno twin and digest if the
auto-scheduler is to propose (L). About six PRs. Nothing in this plan needs it.

**Plants** (each red, then reverted): P1 occupancy off; P2 the flagged entry dropped (the "none dropped"
check red); P3 the adapter's subject set taken from the assignments; P4 the hook renders on a failed read;
P5 a frontend importer added without the census entry; P6 a missing zone read as UTC.

## 11. Out of scope

- Applying any retiming, in any representation (Reading B).
- Per-slot strategy, duration pins, and any setting to change the minimum, the step or the floor.
- G4's cascade proposals and any rendering of an 8.8 change-log.
- A Deno twin of the module, a change to the auto-scheduler's response, or any change to the repair.
- The sunset-severity relabel (constraints, reason codes, game kickoff) and the practice-preference
  follow-ups, which other work owns. In particular `season2026Constraints.js:495-513`,
  `availability/reasonCodes.js` and `availability/kickoff.js` are not edited here.
- Pre-filling a portable-lighting request from a non-survivor's window (a natural follow-up).
- Games: the principle in B6 stays a separate decision.

## 12. Owner decisions (each with a recommendation; only the first blocks)

1. **Which reading of "wire it"?** Recommended: **A**, the outlook; B only after its own plan. Blocks.
2. **Does a flagged date occupy its surface?** Recommended: **yes**. It moves the module's corpus output
   (24 more flagged dates, 17 of 141 slots differ, executed) and no solver or repair result. The
   alternative is a pure relabel that moves nothing and can propose a shift into a running practice's
   minutes.
3. **Where does it live?** Recommended: a new page, `/schedule/practice-daylight`, under Scheduling.
   Alternatives: a section of the 2,083-line Practices page, or a tab of Practice lighting.
4. **Feature flag?** Recommended: none (a ruling for every league, and the page is read-only).
5. **G4's cascade:** leave it unwired and say so (recommended), wire a change-log view later, or delete it.
   The 8.8 change-log module's only non-test consumer is this one.
6. **Extract the shared graph, slot and calendar builders from the repair adapter** into one module, in
   its own PR before PR A (rule 2 asks first)? Recommended: no for now; duplicate with the parity test.
7. **Sequence with the sunset-severity relabel:** either order works; whichever merges second rebases on the
   pinned note text (Risks).

## 13. Records to write in the PRs

A lesson (85): a report nothing calls goes stale against the live path (this one still described a
truncation the Edge dropped on 2026-10-27), so wiring starts by reading it against what the live path does
now. A dated note under D14 defaults 6 and 8 in `docs/PHASE_8_9_D14_PLAN.md`.

## Done when

- [x] Every task's test passes, and each item of "Unchanged" (section 4) has a test: the page's only
      requests are reads (no write, no RPC; `practiceDaylightOutlook.test.jsx`), nothing it draws applies
      anything, and no solver, repair, writer or migration file is in the diff.
- [x] The Definition of Done (AGENTS.md section 3) is green on the final tree of each pull request, and every
      new check was shown failing first (P1 to P5; P6 has a plain test).
- [x] `docs/product.md` is unchanged (a read-only screen for the existing user); the docs named in A4 and B5
      are updated.
