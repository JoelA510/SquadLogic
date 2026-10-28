# Phase D: scheduling (home/away, practices per division, preferences, big leagues, TIME TBD)

Kind: FEATURE · Drawn up: 2026-10-27 · Owner: the product owner · Status: **APPROVED by the owner 2026-10-27** (AGENTS.md
rule 14: the solver, the domain model and persistence); decisions as recorded at the end.

Every claim about the code is _statically reviewed_ at `origin/main` `ff2eb6a` (#673) unless marked
_executed_. Production figures are _executed (read-only)_, 2026-10-27, catalogue and counts only,
through the SQL endpoint; no personal value was read. This plan replaces
`2026-10-22-phase-d-home-away.md` as Phase D's plan and absorbs P1/P2 of
`2026-10-26-coach-preference-rules.md` (branch `...-prefs-plan`, revised 2026-10-27).

## Why

League admins (the only people who sign in since #673) schedule practices and games. The behaviour
below fails them on six counts; Phase D is the roadmap's scheduling phase
(`2026-10-20-core-roadmap.md`) for `docs/product.md`'s admin user.

## What holds today

- **Production** (_executed_): ledger at `20261103020000`; 1 organization, 1 season, 1 program, 32
  divisions (0 practice-only), 0 teams, 0 practice slots, 0 practice assignments, 0 practice
  exceptions, 0 game slots, 0 game assignments, 0 games, 1 scheduler run (`team`), 0
  `coach_practice_preferences`, 0 publication baselines, 0 demo organizations. `demo_seed` holds 21
  divisions, 128 teams and 196 practice slots (4 reserved to U4). md5 (CR stripped):
  `persist_practice_schedule` 2d3b68c1…, `persist_game_schedule` 1a9ad54a…,
  `admin_upsert_division_settings` fe36f0e2…, `start_demo_session` 09adc994… (equal to the body
  #672 restored, per its commit message). One overload of the division settings RPC.
- **One practice per team.** The solver's state is `assignmentMap: Map<teamId, slotId>`
  (`auto-scheduler-solver.ts:545`), every mutation moves a team (`:632-735`), the greedy seed places
  each team once (`:739-810`). `classifyTeamsForRun` (`practice-lock.ts:179-195`) makes a team with
  any row `locked` and only a team with none `placeable`. Nothing says a team's practices fall on
  different days (grep for a different-day or same-weekday rule in `packages/core/src` and
  `_shared`: the only hits are unrelated). Core `schedulePractices` (`practiceScheduling.js:304`)
  is also one-per-team, and nothing in `frontend/src` imports it (grep: only core and tests).
- **Several rows per team persist already.** `persist_practice_schedule` keys rows by (team, slot,
  range) and prunes by that key (`20261002000000`, body lines 619-675), so two rows per team save
  and lock as two series; the season-2026 corpus has 176 such pairs (solver header, `:11`).
- **Practice length is the slot's length.** `practice_slots` has `start_time`, `end_time`,
  `capacity`, `division_id` (D2's reservation, read by the solver) and `day_of_week` (_executed_
  catalogue); duration phases only report (`practice/durationPhases.js`). No division names a count
  or a length (grep `practicesPerWeek|practice_minutes`: none). `p_turnover_minutes` is the clash gap
  at slot import (`practice_slot_conflicts`, `20261029010000`, default 0).
- **The 2 s CPU limit.** `runPracticeOptimizer` stops at `CPU_CAP_MS = 1_500` from the request's
  start (`:925-988`, #672) and returns its best schedule (`terminationReason: 'cpu-cap'`).
  `frontend/src/lib/demo.js:17-26` records the measurement: 1000 iterations cost 2.06-2.41 s of CPU
  on the 128-team demo, 100 about 0.45 s.
- **The server checks structure, not fit, at write.** `persist_practice_schedule` (SECURITY
  INVOKER, granted to `authenticated`) refuses bad references, another organization, a stale
  fingerprint and an unlocked change to a locked row; it does not check slot capacity, coach
  overlap, reservations or preferences. The auto-scheduler computes fit; the page writes.
- **Unplaced is half-recorded.** A practice run's `results.unassigned` keeps only teams with no
  applied row (`practiceRunResults.js:164-170`): a team given one of two practices would vanish
  from it. Unscheduled games are not persisted at all (`persist_game_schedule` has no such
  input). The master export (`OutputGenerationPanel.jsx:209-236`) leaves out every assignment with
  no start or end and says how many (R7); `generateScheduleExports` requires both
  (`outputGeneration.js:71-180`), and the publication parity key is date plus sides
  (`publication/rows.js:103`). `PUBLICATION_TBD` (`reserve/reasonCodes.js:172`) already spells
  `TIME TBD` / `LOCATION TBD`.
- **Demo.** `start_demo_session` (`20261101020000:657-866`) copies `demo_seed` (no practice
  schedule; #672 took it out because the owner changed the spec). The grid
  (`fixtures/demo-2026/fields.csv`) is 6 grounds of two halves, 45-minute slots Monday to Thursday
  16:00-19:00 (192), plus U4's four 30-minute Saturday cohort slots (_executed_: counted from the
  CSV). The reverted seed generator and its tests are on `origin/...-solver-clamp-demo` at
  `10694eb` (`scripts/build-demo-practice-seed.mjs`, `tests/demoPracticeSeed.test.js`,
  `supabase/tests/demo_practice_schedule.sql`), reusable.
- **Home/away** (the 2026-10-22 plan): its facts hold at `ff2eb6a`, but its line numbers predate
  D2: the pair sort is now `gameScheduling.js:70-71`, `scheduleGames` and its `freeze` refusal
  `:162-175`, `evaluateGameSchedule` `gameMetrics.js:89`, the home count `:455`. None of D1-D3 is
  built (grep `home-away-imbalance|keepSides`: none).
- **Pending elsewhere.** Admin-only PR 2 (server) is not merged: its planned `20261103020000` is now
  taken by #672's `drop_unused_views`, so it takes new numbers; its S2 (coach email unique per
  organization) is what the preference import matches on. Phase E3 (coach rows per season) is not
  started.

## Behavior

- **Now:** as above.
- **After:**
  1. **Home/away** balanced by index parity (spread at most 1; odd n exactly (n-1)/2), saved sides
     kept, and a `home-away-imbalance` warning. Unchanged from the 2026-10-22 plan.
  2. **Practices per division.** Each division says how many practices a week its teams get (0-7)
     and how long each is (minutes, or any slot length). The auto-scheduler gives each team that
     many practices, each on a different weekday, each in a slot of that length; what it cannot
     place is TIME TBD with the reason, per missing practice, never dropped.
  3. **Preferences** are imported by an admin from a CSV (one row one rule, several values per
     condition), edited in the app, and a requested must counts only after an admin accepts it
     (one by one, or Accept all after a confirmation that names the count and the conflicts).
  4. **Big leagues** run the optimizer in the browser (a Web Worker) as long as it needs; the
     server reloads every input, re-checks every placement and persists, as it does today.
  5. **The master CSV/XLSX** lists every missing practice and every unscheduled game as a row with
     `TIME TBD`, `LOCATION TBD` and the reason.
  6. **The demo** starts with U14+ at 2 x 90 minutes and U5-U12 at 2 x 60 minutes, Monday to
     Friday, U4 with no practices; U5-U8 already scheduled, U9 and older left for the visitor's
     auto-scheduler run.
- **Unchanged** (each gets a test): a division at 1 practice a week with no length set schedules
  byte-identically to today (the dated golden sweep, `tests/autoSchedulerDatedSweep.test.js`);
  every saved practice stays locked and is never moved; pairings, weeks and slots of games; the
  season-2026 fixture suite; manual, repair and override writes keep today's checks; the per-team
  downloads; the 1.5 s cap on the server path.

## Out of scope

- A per-division allowed-days setting (Mon-Fri is said by the field grid; decision 3).
- Splitting a slot into several practices; spacing practices apart; a double round robin;
  rebalancing saved home/away sides; re-optimising a saved schedule (only when the owner names it).
- The team page's own downloads and the calendar feed listing missing practices (the master and its
  per-team files do; the feed keeps today's TIME TBD exceptions).
- Coach screens and notifications (gone with #673); Phase E3.

## Against the rules

- **Rule 14** (solver, domain model, persistence): this plan; nothing is built before agreement.
- **Maximum freeze / minimal diff:** saved rows are locked and only missing practices are placed;
  lowering a division's count removes nothing (decision 10). No global re-optimisation.
- **Never silently drop:** every missing practice and unscheduled game is persisted with a reason
  and exported; the subject set is the roster and each division's count, never the solver output.
- **CI is the only migration writer;** md5 guards (`md5(replace(p.prosrc, E'\r', ''))`) before
  every replaced body; revert and smoke in `docs/sql/`; harness plants; snapshot regenerated.
- **Budgets:** the server path keeps its cap and `verify` is linear in placements, measured in its
  PR (`edge-function-budget.md`); the worker is a lazy chunk with its own rule, first paint unchanged.
- **The frontend importing `supabase/functions`** follows R7 (`scheduleDownloads.js:140` imports
  `_shared/calendar/icsFeed.ts`): one solver, not a third copy. No new dependency, variable or
  service; no ADR folder, lessons to `docs/LESSONS_LEARNED.md`. **Departures: none.**

## Design

### A. Home/away (folded in from 2026-10-22, unchanged in substance)

Index parity in `generateRoundRobinWeeks`, matchups kept in today's alphabetised order so every pair
keeps its week and slot; `keepSides` from the latest saved run per division; `home-away-imbalance`
(`|home - away| > 1`, severity `warning`) in `evaluateGameSchedule`. Proof table, freeze design and
tests as in that plan (its simulations were _executed_ there and are re-run by A's tests).
**Changed:** line numbers above; practice-only divisions get no round robin (D2), so no warning for
them; Phase D's game TIME TBD rows (E) carry their home/away sides.

### B. Practices per division

- **Data.** `divisions.practices_per_week smallint NOT NULL DEFAULT 1 CHECK (0..7)` and
  `divisions.practice_minutes smallint NULL CHECK (15..240)`; NULL means any slot length. Defaults
  keep today's behaviour for every existing league (production: 32 divisions take 1 / NULL).
  `admin_upsert_division_settings` gains `p_practices_per_week` and `p_practice_minutes` (NULL keeps
  the stored value; `p_practice_minutes => 0` clears it to "any length"), the old signature dropped
  by its exact signature, the new one from the latest body (`20261101010000:1814`) behind its md5;
  both fields in the `settings.updated` before and after. Edited on the division settings form
  (`TeamingConfiguration.jsx`, beside "plays games"): "Practices per week" (0-7) and "Practice
  length" (Any slot length, or minutes), labelled, keyboard-operable, both themes.
- **Units.** The solver searches practice units, not teams: a team whose division wants N, holding
  r live rows (not ended from `liveFrom`), gets `max(N - r, 0)` units; `classifyTeamsForRun`
  becomes `planTeamsForRun`, returning units and, per team, N and r. A unit's id is the team id when
  the team needs one unit (so N=1 runs are byte-identical) and `teamId#k` otherwise. A team whose
  series is TIME TBD stays out (decision 4 of 8.6). N=0 divisions produce no unit and no TIME TBD.
- **Admissible** gains two checks, in `practice-coaches.ts` beside `checkHardConstraints` so the
  solver, the verifier (D) and the writer's twin tests share one rule: the slot's length equals the
  division's `practice_minutes` when set (`endSec - startSec`, the dated reading); and no other row
  or unit of the same team is live on the same weekday on a shared date. Coaches, capacity and
  reservations are unchanged; seat and remove work per unit.
- **Why a practice is missing** (`explainUnplaced`, per unit, against the final schedule):
  `no-slot-available` and `coach-preference` as today, plus `practice-length` (no run slot of the
  division's length) and `not-enough-days` (the slots open to the division cover fewer weekdays than
  N). Reason codes in one core enum, its Deno twin and the table CHECK, pinned by a drift test.
- **The page.** Placements are already a list; every consumer that keys by team is searched and
  changed (AGENTS.md: search every changed shape). `practiceRunResults.js:164-170` stops filtering
  `unassigned` by team: an entry is a unit. The panel says "2 of 2 practices" per team.
- **Lowering N** below a team's rows keeps the rows and adds `practices-over-target` to the run
  report (decision 10).
- **Core `schedulePractices`** stays one-per-team (unused by the app) and refuses a team whose
  `practicesPerWeek` is not 1, by name, rather than place one silently.
- **The writer** (`persist_practice_schedule`, replaced behind its md5; TimeZone restated from
  `20261021040000`) refuses a save whose **new `auto` rows** break a rule SQL can check: capacity
  on a shared date, a reservation, the division's length, two rows of a team on one weekday on a
  shared date, or more live rows than N (P0001, naming each row). Manual, repair, recommendation
  and override rows keep today's checks (the override prompt governs them; declared). Coach
  overlap, preferences and daylight are checked by the server's verify (D), not the writer
  (declared, decision 9).

### C. Preferences: P1 and P2 of the prefs plan, as revised 2026-10-27

The prefs plan stands as revised; what Phase D fixes about it:

- **Model** (P1): rules per team with `weekdays text[]`, `start_minutes int[]`, `venue_ids uuid[]`,
  keep-current per dimension, optional `coach_priority`, a date window, `requested_level`
  (prefer or must, as the file asked), `level` in force, `must_decision` (pending, accepted,
  kept_prefer, or NULL), `source` (import or admin) with the import job id; all RPCs admin-only and
  audited (`admin_add_`, `admin_edit_`, `admin_remove_practice_preference`,
  `admin_decide_must_preference`, `admin_accept_all_musts(p_import_job_id, p_expected_count)`, which
  refuses when the count differs from what the confirmation showed). The old `dimension`/`value`
  columns go after the end-state check. Production has 0 rows (_executed_), so the backfill moves
  nothing; it stays written and tested. The admin-only plan's recommendation to drop
  `requested_level` and `must_decision` is superseded by the owner's amended decision 5.
- **Judged per practice.** Each unit is judged against every in-force, in-window rule of its team:
  must filters, prefer counts one breach per unmet rule. {Tue, Thu} must with N=2 and the
  different-day rule lands on Tuesday and Thursday. Keep-current means any value the team's live
  rows hold; with none it does nothing and says so (today's `COACH_PREFERENCE_NO_REFERENCE`,
  `coachPreferences.js:203-215`), pinned by a test.
- **Import** (server side in P1): import type `practice_preferences` through `import_jobs`, staging
  and a new `finalize_practice_preference_import_job`, columns on the import allowlist. Coach by
  email within the organization (needs admin-only S2), team by name within the season; a blank team
  for a coach of several teams makes one rule per team; an unknown coach or team is listed, never
  created; a re-import replaces the imported rules of the teams the file names and leaves admin rules
  alone. Teams must exist first; the screen says so.
- **Screens** (P2): the import preview (rules, unknown rows, would-be musts and conflicts), Pending
  musts (Accept as must, Keep as prefer, impact preview from `previewMustKeep`, Accept all), the
  rules list and editor (checkbox groups, time lists, a summary sentence), the conflicts view.

### D. Big leagues: the optimizer in a Web Worker

- **What runs where.** `auto-scheduler` keeps its default `solve` mode (today, capped). Two modes are
  added: `prepare` loads every input as the caller through RLS, as `solve` does (lock, coaches,
  preferences, daylight, overrides, reservations, the divisions' N and length), and returns the
  solver's input with a digest of it; `verify` takes placements and that digest, reloads everything
  itself (never the body's copy), refuses 409 `INPUT_CHANGED` when the digest differs, seats the
  placements in sorted order through the same `admissible` the solver uses, runs the daylight
  post-pass, scores with `scoring-engine.ts`, persists the evaluation run, and answers in `solve`'s
  response shape. A placement that fails is returned unplaced with `verify-refused` and its rule:
  TIME TBD, never dropped. The page then stages, reviews and applies exactly as today.
- **The worker** (`frontend/src/workers/practiceOptimizer.worker.js`, a module worker, CSP
  `worker-src 'self' blob:` allows it) imports `runPracticeOptimizer` from
  `supabase/functions/_shared/engines/auto-scheduler-solver.ts` (already import-free and executed
  by Vitest) with `cpuCapMs` off and a wall budget (default 20 s, decision 8), posts progress, and
  can be cancelled. Deterministic for a seed and an iteration count; a wall budget makes the result
  depend on the machine, which the panel says.
- **Fallback.** No module workers, a worker error, or a `verify` that refuses the input: the page
  runs the server `solve` (1.5 s, best-so-far) and says which ran.
- **Budget.** The solver bundles to 45.1 KB raw, **16.1 KB gzip** without zod (_executed_: esbuild
  0.25.12, minified ESM, browser target); zod is already in the frontend. New lazy
  rule "practice optimizer worker" at 40,000 B gzip in `config/bundle-budget.json`; first paint
  unchanged; the PR records the measured chunk.
- **Trust.** The worker's output is a proposal. `verify` is the server's own check on its own reads;
  the writer's gate (B) holds the SQL-checkable rules whichever path wrote the rows.

### E. TIME TBD in the master export

- **Persisted.** New `public.schedule_tbd` (organization, season, `kind` practice|game, team (or
  home and away, week index), division, `missing_count >= 1` for practices, `reason` (CHECK, the
  enum of B plus `not-scheduled-yet`, and the game reasons `scheduleGames` emits), `detail jsonb`,
  run id, created). Read by admins of the organization (RLS); written only by the two writers below.
- **Practices: computed by the writer from the roster.** After its write, `persist_practice_schedule`
  replaces the season's practice rows: for every team of the season with N > live rows, one row
  with `missing_count = N - r` and the reason the save's `tbd` entry gives for that team, else
  `not-scheduled-yet`. The subject set is the season's teams and their divisions' N, never the
  payload (AGENTS.md: enumerate from what a break leaves intact).
- **Games.** `persist_game_schedule` (replaced behind its md5) takes the run's `unscheduled`
  (week, home, away, division, reason), validated in Zod and in SQL, and writes them for that run;
  the master reads the latest run's, as it reads its assignments.
- **Export.** `generateScheduleExports` gains `tbdItems`: a practice item gives `missing_count` rows
  (Event Type Practice), a game item a home and an away row, each with Start `TIME TBD`, End blank,
  Field `LOCATION TBD`, Notes the reason sentence; sorted after the team's dated rows; validated by
  a Zod schema. `OutputGenerationPanel` reads them through an admin RPC `get_schedule_tbd(season)`
  and keeps its untimed count only for rows with a broken time.
- **Publication baseline.** A TBD row has no date, so two of one team share the parity key:
  `parityRowFromExportRow` adds an ordinal for TBD rows of one (participant, event type, opponent),
  and `checkParity` reports "2 TBD then, 1 now". The SQL document check already accepts any string
  cell (`20260920000000`, row check).

### F. The demo

- `demo_seed.divisions` gains `practices_per_week` and `practice_minutes`: U4 0 / NULL, U5-U12 2 /
  60, U14-U19 2 / 90. `start_demo_session` copies them.
- **Grid** (`fixtures/demo-2026/fields.csv`, regenerated by `scripts/build-demo-seed.mjs`): Monday
  to Friday on the same six grounds; Eastgate Field 1's two halves carry 90-minute slots at 16:00,
  17:30 and 19:00 (30), the other ten halves 60-minute slots 16:00-21:00 (250). Demand: 224
  sixty-minute and 24 ninety-minute practices (90% and 80%). U4's four Saturday cohort slots go
  (decision 5). Final numbers are what the generator's test proves (below), not this paragraph.
- **Seeded schedule.** `demo_seed.practice_schedule` holds U5-U8's 128 practices (64 teams x 2),
  generated by the real solver from the fixture (`scripts/build-demo-practice-seed.mjs`, rebuilt
  from `10694eb`), placed 16:00-19:00; `start_demo_session` writes a completed practice run and one
  `practice_assignments` row per seeded row, and refuses the start if a row finds no slot. U9 and
  older (60 teams, 120 practices) are left for the visitor (decision 6).
- **Demo search.** 120 units with 128 locked rows; `demo.js`'s 150 iterations are re-measured
  against the cap on the server path in F's PR; the worker (D) takes over where available.

## Risks and rollback

- **Solver regression for today's leagues.** — **watch:** the dated golden sweep and the season
  fixture suite, byte-identical at N=1. — **if it happens:** the unit id rule is wrong; fix before
  merge.
- **The writer gate refuses a legitimate auto save** (a slot shortened by a duration phase reads
  as the wrong length). — **watch:** P0001 in CI's E2E and the demo scenario. — **if it happens:**
  compare the base slot length, as the solver does, and say so in the header.
- **Demo grid too tight** for coaches with two teams. — **watch:** the seed test runs the solver on
  the rest and asserts 0 TIME TBD. — **if it happens:** add a ground or an evening hour (decision 7).
- **Worker and server disagree** (zod 4 in the browser, the import map's zod 3 on Deno). Vitest
  already executes these engines under zod 4 (root `package.json`). — **watch:** a test that runs
  the worker's module and `verify` on one input and requires equal placements and score.
- **Teams already holding two rows at N=1** (176 pairs in the season-2026 corpus) read as over
  target: info-level advisory only; the admin sets N=2. Production holds 0 rows (_executed_).
- **Rollback:** each migration's revert (B: columns, bodies, table; C: the prefs plan's, refusing
  rows with several values; F: `start_demo_session` back to 09adc994…); D's PR reverts alone.

## Tasks

Six PRs (seven if E goes alone), each reviewed once (`/code-review`) before it opens; at most two
in flight, admin-only PR 2 counting as one: A with B, then F with D, then C1, then C2.
Migration numbers are taken at build time, after admin-only PR 2's.
Each PR runs the season fixture suite and the full Definition of Done.

**PR A, home/away** (no migration): the three tasks of the 2026-10-22 plan in one PR.

- [ ] A1 Warning — `tests/gameMetrics.test.js`: A hosting B, C and D gives one
  `home-away-imbalance` for A (3-0); the season extract gives 0; `tests/countUnits.test.js` and
  `tests/scoringEngineDrift.test.js` declare it. Fails today (no such type).
- [ ] A2 `keepSides` and page wiring — `tests/gameScheduling.test.js` (team-2 hosts when kept; bad
  entries throw) and `tests/gameSchedulingKeepSides.test.jsx` (a saved team-2 home game stays).
- [ ] A3 Index parity — `tests/gameScheduling.test.js`: n=2..16 ordered and shuffled UUIDs, spread
  <= 1, odd n exactly (n-1)/2, longest run <= 2; identical (week, slot, field, pair) sets to today;
  shown failing against the loose rule and with matchups re-sorted by home id.

**PR B, practices per division and practice TIME TBD** (migration 1).

- [ ] B1 Columns, RPC, form — pgTAP `supabase/tests/practices_per_division.sql`: defaults 1 / NULL
  on an existing division; 8 and 14 refused (23514); the RPC keeps on NULL, clears on 0, audits
  before and after, refuses a non-admin; `tests/divisionPracticeSettings.test.jsx`: the two fields
  save and read back (axe, keyboard).
- [ ] B2 Units and the two checks — `tests/autoSchedulerPracticeUnits.test.js` (new, executes the
  solver): a division at 2 with 5 open weekdays places 2 per team on 2 weekdays; a 60-minute
  division never takes a 45-minute slot; a team holding 1 of 2 rows gets 1 unit and its new one
  avoids that weekday; slots on one weekday only give `not-enough-days`; no slot of the length
  gives `practice-length`; N=0 places nothing and reports nothing. Shown failing against
  today's solver. `tests/autoSchedulerDatedSweep.test.js` stays byte-identical (unchanged).
- [ ] B3 Run results per unit — `tests/practiceMetrics.test.js` (`buildPracticeRunResults`): a team
  given 1 of 2 keeps an `unassigned` entry (fails today: it is filtered out); the panel shows "1 of 2".
- [ ] B4 Writer gate — pgTAP `practice_writer_v3.sql` gains: a new auto row over capacity, in
  another division's slot, of the wrong length, on a weekday the team holds, or past N is refused
  naming the row; the same rows `manual` are accepted (unchanged); `tests/practiceWriterV3.test.js`
  pins the reason list to core and Deno.
- [ ] B5 `schedule_tbd` and the practice shortfall — pgTAP `schedule_tbd.sql`: a save leaving a
  team at 1 of 2 writes `missing_count 1` with the payload's reason; a team absent from the payload
  is still counted (roster subject set; planted: derived from the payload fails); a later full save
  removes it; RLS: another organization's admin and a non-member read nothing.
- [ ] B6 Core `schedulePractices` refusal — `tests/practiceScheduling.test.js`: `practicesPerWeek: 2`
  throws by name.
- [ ] B7 Mock twin, E2E — `tests/e2e/features/practices_per_division.feature`: set U10 to 2 x 60,
  run, stage, apply; each U10 team shows two practices on two days; a forced shortfall shows TIME
  TBD with its reason. Harness plants (each run, each failing): the length check skipped, the
  weekday check skipped, the shortfall derived from the payload, the md5 guard skipped; revert by
  catalogue fingerprint; snapshot regenerated.

**E, the master export:** inside PR B if its review stays one sitting, else its own small PR after B
(decision 11).

- [ ] E1 Game TBD persistence — pgTAP: `persist_game_schedule` writes the run's unscheduled games;
  bad entries refused; md5 guard planted.
- [ ] E2 Export rows — `tests/outputGeneration.test.js`: a practice item with `missing_count 2` gives
  two `TIME TBD` rows; a game item a home and an away row; `tests/publicationBaseline.test.js`:
  2 TBD then 1 now is reported, not ambiguous (fails today: `PARITY_KEY_AMBIGUOUS`);
  `tests/scheduleExportsUi.test.jsx`: the master lists them and no longer says they are missing.

**PR F, the demo** (migration 2; after B).

- [ ] F1 Seed and grid — `tests/demoSeed.test.js` and `tests/demoPracticeSeed.test.js`: U4 0, U5-U12
  2 x 60, U14+ 2 x 90; every slot Monday to Friday; 128 seeded rows, two per U5-U8 team on two
  weekdays, none overlapping a coach's other team; the solver run on the rest (executed in the test)
  places all 120 with 0 TIME TBD. pgTAP `demo_practice_schedule.sql`: a started demo holds them and
  a completed practice run; a seed row with no slot refuses the start (planted).
- [ ] F2 Real-backend demo scenario: start, see U5-U8 scheduled, run the auto-scheduler, apply, the
  master CSV has every team's two practices; the CPU measurement in the PR body.

**PR D, the browser optimizer** (no migration; after B).

- [ ] D1 `prepare` and `verify` — Deno tests: `verify` refuses a changed input (409), refuses an
  over-capacity placement, a coach double-booking and a must breach as `verify-refused`, and
  persists the evaluation run; a body carrying its own lock or preferences is ignored (planted).
- [ ] D2 Worker — `tests/practiceOptimizerWorker.test.js`: the worker module and `verify` on one
  input give equal placements and score; cancel stops it; an error falls back to `solve`;
  `config/bundle-budget.json` rule shown failing at a 1 KB cap, then set.
- [ ] D3 Panel — `tests/autoSchedulerPanelTermination.test.jsx`: progress, cancel, "ran in your
  browser" or "ran on the server" said; E2E `auto_scheduler.feature` runs through the worker in mock mode.

**PR C1, preference rules: server and import** (migration 3; after admin-only PR 2).

- [ ] C1 The prefs plan's P1 tests (pgTAP CHECKs, admin-only RPCs, Accept all's expected count,
  backfill on planted rows) plus: per-unit judging (`tests/coachPreferenceRules.test.js`: {Tue, Thu}
  must at N=2 lands Tue and Thu; a must no slot meets gives TIME TBD naming the rule); the drift
  test over the new shape; pgTAP `practice_preference_import.sql` (blank team for a two-team coach
  makes two rules; an unknown coach is listed; a re-import replaces only imported rules).

**PR C2, preference screens** (no migration; after C1).

- [ ] C2 Import preview, Pending musts with Accept all, rules list and editor, conflicts —
  `tests/preferenceImport.test.jsx`, `tests/pendingMusts.test.jsx` (Accept all's dialog names the
  count and conflicts; keyboard and axe); E2E `practice_preferences_import.feature`.

## Done when

- [ ] Every task's test passes on its branch and was shown failing first; the Unchanged list's
  tests pass; the season fixture suite and the Definition of Done gates pass on every PR.
- [ ] `docs/LESSONS_LEARNED.md`, `docs/MODEL_GAPS.md` (GAP-28's export half closed),
  `docs/operations/edge-function-budget.md` (the modes), `bundle-budget.md`,
  `fixtures/demo-2026/README.md`, and the two folded plans point here.

## Owner decisions (each with a recommendation; none blocks PR A)

1. **Settings per division** (recommended; divisions are per season), or per program with overrides.
2. **A practice takes a slot of exactly its length** (recommended: no field time wasted, no new slot
   model), or any slot at least that long (the team holds the whole slot).
3. **Monday to Friday said by the field grid** (recommended), or a per-division allowed-days setting.
4. **Distinct weekdays as a hard rule** (recommended); no spacing rule now.
5. **U4 in the demo has no practices** (owner, 2026-10-27). This **replaces** the four 30-minute
   Saturday cohort sessions (one cohort at a time, 15 minutes apart) the demo shipped with; U4 then
   has neither games nor practices, rosters only. Recommend removing U4's Saturday slots. Confirm.
6. **Demo split:** U5-U8 start scheduled, U9 and older left for the visitor's run (agreed earlier on
   my recommendation; carried). Confirm under the new settings.
7. **Demo grid:** Monday to Friday 16:00-21:00 on the same six grounds (recommended), or add a ground
   so evenings end by 20:00.
8. **Worker use:** every run in a browser that supports module workers, server as fallback
   (recommended), or only above a league size; wall budget 20 s (recommended).
9. **Server checks:** the writer refuses new auto rows that break capacity, reservation, length,
   weekday or N, and `verify` checks coaches, preferences and daylight (recommended); or `verify`
   alone.
10. **Lowering a count** below saved rows: keep the rows and warn (recommended), or offer a named
    "trim to target" action later.
11. **TIME TBD store:** a `schedule_tbd` table the writer computes from the roster (recommended), or
    reading run results; E inside PR B if its review stays one sitting (recommended), else alone.
12. **Carried:** home/away 1-3 (no rebalance of saved sides; warn at |home - away| > 1; a mirrored
    second leg later); preferences 1-3. New: a downloadable preference CSV template (recommended).

## Owner answers (2026-10-27)

- **1-4, 8, 10, 12:** as recommended (9, the server checks, read as recommended too; see 11).
- **5, U4:** keep the demo's U4 Saturday sessions as **practices** (one weekly 30-minute session
  per cohort, one cohort at a time, at least 15 minutes apart), so the field shows as in use and is
  not offered to games. U4's division settings: 1 practice a week, 30 minutes, on its reserved
  Saturday slots. Owner: "it is truly a once weekly practice in the example program... It is an
  odd case."
- **6:** confirmed: U5-U8 start scheduled, U9 and older left for the visitor's run.
- **7, demo grid and sunset:** practices fit before sunset; only **one lit field** in the demo may
  be used after sunset. **Past sunset is flagged, never blocked** (owner: "Flag, but don't block,
  anything that goes past sunset"): where the daylight pass refuses a placement today, it warns
  instead, with the reason shown, for every league, not only the demo.
- **11, TIME TBD:** listed **in the same schedule**, a row with its date and time TBD, unless that
  really breaks the schedule tables; only then a separate TBD table. Owner: TBD rows should be rare
  outside SuperRec before its games are scheduled. PR B's builder decides with evidence and says
  which in the PR.

## Build notes: PR B (2026-10-27)

- **Built:** B1 to B7 and the owner's sunset answer (flag, never block) for the Edge pass and the
  repair, in migration `20261105010000`. Owner answers applied: settings per division; a practice
  takes a slot of exactly its length; Monday to Friday comes from the field grid (no weekday list
  is added); different weekdays is a hard rule; lowering a count below saved rows keeps the rows and
  reports `overTarget`.
- **E (TIME TBD in the master export) is NOT in this PR.** Decision, with evidence: **a separate
  `schedule_tbd` table**, not rows in the schedule tables. A TIME TBD row in `practice_assignments`
  has no slot and no dates, and everything that reads that table treats a row as a placed or locked
  practice: the lock loader (`practice-lock.ts` loads every row, a null `slotId` included, as a
  locked occupant of the team), the writer's prune and lock rules (`persist_practice_schedule`
  prunes and locks by team and slot), `teams_without_practice` (a team with a TBD row would count as
  having a practice), and the metrics (`practiceMetrics.js` counts a row as an assigned team). Each
  would need a "not a real practice" filter, and a reader missed would count a missing practice as a
  held one, which is the failure this plan exists to prevent. A table read only by the export and
  the roster check cannot be mistaken for a placement. E is its own migration, writer change and
  export change; it fits a review of its own, not this one.
- **Daylight:** both passes flag past-sunset (Edge `practice-daylight.ts`: `daylight.pastSunset`,
  finding `PRACTICE_PAST_SUNSET`, audit `daylightPastSunset`; core `repair.js`: `daylightPastSunset`
  on the re-home and the recommendation, `PRACTICE_REPAIR_CANDIDATES_PAST_SUNSET` now a compromise).
  `frontend/src/utils/daylightExceptions.js` (which built the exceptions that wrote a truncation) is
  deleted. An unknown sunset is still refused. `PRACTICE_TBD_REASON.PAST_SUNSET` stays for rows
  saved before.
- **Migration contents:** the two columns with their CHECKs, the helper
  `practice_new_auto_row_refusals`, `persist_practice_schedule` replaced behind its md5 (production's
  body; the gate is the only change, `now()` for `timezone('utc', now())` in the one place it was
  written), `admin_upsert_division_settings` replaced by its 13-argument form (the 11-argument one
  dropped by its exact signature, no CASCADE).

## Build notes: PR E (2026-10-28)

- **Built:** E1 and E2 in migration `20261107010000`: the `schedule_tbd` table (admin-only RLS), the
  admin read `get_schedule_tbd(season)`, `persist_practice_schedule` and `persist_game_schedule`
  replaced behind their md5, `admin_delete_team` replaced to count `schedule_tbd_deleted` (the table
  cascades from teams, and the delete's pgTAP and smoke walk the catalogue for a counter per cascading
  table). `generateScheduleExports` takes `tbdItems`; the Exports panel reads the list when it generates,
  lists it, and stops the files when it cannot be read.
- **Why a separate table** (decision 11, owner answer: only if keeping the rows in the schedule breaks
  it; PR B's evidence stands): the lock loader, the writer's prune and lock rules,
  `teams_without_practice` and the metrics each read a `practice_assignments` row as a held practice.
- **Where the game list comes from:** the run's `results.unscheduled`, already part of the save, not a
  new argument. A new RPC argument would have changed the writer's signature (a drop and a create, the
  Edge function's schema and its drift test) for nothing the existing field does not carry. The
  save replaces the season's list only when `results.unscheduled` is an array; the game page sends it
  only for a scheduler run, so a hand edit and a rollback leave it alone (declared: a rollback does not
  restore the list of the run it undoes). Each entry is checked in Zod before the save and in SQL in it.
- **Departures from the text above:** (1) `get_schedule_tbd` is a definer with its own admin check (42501),
  where the plan said "an admin RPC" without saying which; (2) the practice writer reads the run's reason
  for a team from `results.unassigned` (the auto-scheduler's own) and labels the row with it when it is on
  the closed list, else `not-scheduled-yet`; the subject set stays the roster; (3) the baseline
  comparison reads a declared `TIME TBD` Start as a value on both sides (`withDeclaredTbdTime`), which the
  generic reader still refuses to do (its test holds that), because the plan's ordinal alone would have left
  every baseline with a TBD row "unreadable as a verdict".
- **Not done (stated):** the per-team page downloads and the calendar feed (out of scope above); the
  demo's seeded list (PR F); no `schedule_tbd` writer in the mock (the E2E seeds the table).

## Plan-change output

Size: planned (PRs, migrations, the solver, RPC shapes, an Edge Function). Departures: none.
Questions: 1-12, none blocking; 2 and 9 shape PR B and have defaults. First task: A1
(`tests/gameMetrics.test.js`). Lesson: a run's "unassigned" keyed by team stops being true once a
team can need more than one of something; count shortfalls from the roster and the requirement.
