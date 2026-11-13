# Schedule expansion: a per-game "Published" switch, a schedule import, and the scheduling tools a spreadsheet scheduler has that this product lacks

Kind: FEATURE (thirteen active pull requests, PR 1 to 13; PR 14 is held by the owner. PR 1 to 8 drawn up 2026-11-03,
9 to 14 added 2026-11-06; four migrations, one below the limit of five) ; Drawn up: 2026-11-03 against `origin/main`
`c3d190d` (the owner's brief was written against `a3395eb`; #703 landed since, and nothing below depends on it); amended
2026-11-06 twice, `origin/main` still `c3d190d` ; Owner: the repository owner ; Status: **PLAN ONLY: no code, migration,
fixture or test is written by this change.** The owner approved the scope on 2026-11-03 and the practice-side
additions on 2026-11-06, answered all thirty-one decisions on 2026-11-06 and said "Let's proceed with your changes and
recommendations" (the messages are verbatim at the top of section 10). **The hold is lifted.** The gate before PR 5, the
F11 plan (decision 12), was approved on 2026-11-07 and its F11-1 is merged; PR 14 is held (decision 28). Work started with
PR 1 together with PR 4; what is merged and what is next is in section 14 (updated 2026-11-10; the rest of this header is
the 2026-11-06 text). A new scope, a new dependency or anything outside this plan still needs the owner.
Order of work around this plan (owner, 2026-11-06): dependency updates are cleared now and are a separate wave, not in
this plan; then this expansion; then the owner's manual testing; then the test-suite audit; then the desktop build (the
desktop build, including the Windows version, is **not** in this plan).

## Amendments (2026-11-06)

**Later on 2026-11-06: the owner's answers, the restructure and the review policy.** The owner answered all
thirty-one decisions and lifted the hold; the two messages (verbatim), the nine agreed changes and the answer table are
the block at the top of section 10. Numbers of findings, decisions, sections and PRs are unchanged. This amendment:

- **Hold lifted; PR 14 held.** Decision 28 = no stored hold, so the plan has thirteen active PRs and four migrations
  (PR 1, 5, 10, 12; the limit is five).
- **A gate before PR 5: the F11 plan** (decision 12), with four criteria; it is a separate document and the owner
  approves it (section 7).
- **Restructure (delegated by the owner).** A dependency table and one priority rule replace the waves and the diagram;
  G3 and G5 move from PR 7 to PR 6, so PR 7 needs only PR 1 (section 7).
- **Review policy, final (decision 16).** Content-based: (c) for PRs 1, 2, 4, 5, 6, 8, 9, 10, 11, 12; (a) for PRs 3, 7, 13;
  Codex first, then one `/code-review high`, none on documentation, minor or dependency PRs. PR 1 gains task A6, which
  edits AGENTS.md and CLAUDE.md so agents stop seeing a contradiction (sections 7 and 9).
- **Outside clubs (decision 5):** the census classes and the standings split (4.6). **Practice re-import (decision 24):**
  probable moves, paired by team, new rows unticked (4.11.4, 4.11.6; PR 9, 10, 11). **Held times (decisions 28, 29):**
  PR 13 states its basis and gives an upper bound; PR 10 reports every path that creates practice slots (5.8, 5.9).
  **Decision 1:** helper text and a counter on the note (PR 3, C3).
- **Settings scope (the owner's principle):** optional behaviours at organization, program and division level; new
  section 6.2; it widens PR 12 (5.7) and the F11 plan.
- **Stale text corrected:** the hold, the wave order and PR counts, PR 7's dependency on PR 6, the "no `/code-review`"
  passage, and the places that named PR 7 for G3 and G5 (header, 1, 5.4, 5.6, 6.1, 7, 9, 10, 13, 14).

**Earlier on 2026-11-06: the practice side.** The owner approved adding the practice side, drawn from a second workbook
(a hand-built weekly practice grid).
Findings F1 to F12, verification findings 1 to 11, decisions 1 to 18 and PRs 1 to 8 keep their numbers; everything
new is appended.

- **Added:** findings F13 to F17 (section 1; designs in 4.11, 5.7, 5.8, 5.9, and a sentence in 5.1); verification
  findings 12 to 18 (above section 1); section 2.1 (the practice side today); PR 9 to 14, and task G2b in PR 7
  (section 7); decisions 19 to 31 (section 10); receipts R12 to R30 and the second workbook's counts (section 11);
  lessons (section 12); section 6.1 and 8.1 (behaviour and "already exists" for practices).
- **Corrected, section 4.10:** the `import_application_records` CHECK edits were listed as gaining `locations` and
  `fields`. Both, and `field_subunits`, `practice_slots` and `game_slots`, are already on the `target_table` list
  (`20260522120000:19-24`, statically reviewed; no later migration redefines it). The games import adds
  `game_assignments`, `teams` and `divisions`; the `import_type` list there is `coaches`, `fields`,
  `field_availability` and gains `games` (and `practice_schedule`, PR 10).
- **Corrected, sections 2, 3.3 and 14 (and the PR 1 task A1 by reference):** the plan said `admin_delete_team` is
  copied whole from `20261108020000`. Its **latest** body is `20261112010000:1413` (it also counts the practice
  preference rules its cascade takes, `coach_practice_preferences_deleted`); a copy of the older body would silently
  drop that (lessons 70 and 87: replace from the latest body). `persist_game_schedule` (`20261108020000:1763`) and
  `admin_cancel_game_assignment` (`20260613000003`) are the latest of theirs (`rg` over `supabase/migrations`, R19).
- **Updated, not wrong:** counts and orderings that were true for eight PRs: the header, the size verdict, the
  opening of section 7 (waves, migrations, rule 14), the dependency diagram, section 9, the "silence" sentence and
  the blocker list of section 10, sections 13 and 14. Each now covers PR 9 to 14.
- **Reported, not fixed:** `docs/operations/ingestion-pipeline.md` section 2.3 says a practice slot "starts less than
  15 minutes from" another on the same ground is refused; the migration's own default turnover is 0, back-to-back
  slots are allowed (owner, 2026-10-25), and the field import passes no turnover (`20261029010000:31-35`, `:577-588`).
  The doc is stale; PR 10's docs task fixes it. Also reported: the writer's double-booking check does not look inside
  one payload (verification finding 13).

## Labels and method

Every claim about the code is _statically reviewed_ (read) unless marked _executed_. _Executed_ means a search or a
script was run in a clean worktree of `c3d190d` (on 2026-11-03; the last file checks on 2026-11-04, the session crossed midnight), or a web page was fetched on 2026-11-03; nothing in this plan comes from
a test run (none was run; section 11 lists what was not). A claim of absence was made only after a search that matches
something; the positive control is named beside it. Figures about the owner's workbooks are counts and shapes only,
recomputed by scratch scripts kept outside the repository (section 11); **no name, venue, team, coach or value from
those files is in this plan, and none may enter a fixture, a test or a commit** (the real-name guard
`tests/realNameDenylist.test.js` scans `docs/` and fails on a hit). The workbooks are the owner's data and stay outside
the repository. The second workbook's figures were recomputed on 2026-11-06 (_executed_); where a figure of the
owner's brief for it was not re-run, it says "from the coordinator's scripted read, not re-run".

## Owner requirement (2026-11-03, verbatim intent)

> "Make a plan only, committed on a new branch, that would add in the currently missing functionality. Locking games
> can be a toggle in-app that reads 'Published' that requires the Published flag to be overridden for those games to
> be changed, rather than a 'once-means-forever' type of lock. As you plan it out, leave your recommendations for each
> of those findings for currently absent functionality/behavior. As for what already exists, but stronger; yay. The
> schedule itself should be import-able, though, because some orgs may come to this to manage an already generated
> schedule (same as teaming in this regard.)"

The findings are what a spreadsheet scheduler (a template and a filled example, attached by the owner) offers that
this product may lack. The ten findings F1 to F10 are in section 1; two more that verification turned up are F11 and
F12.

**Owner addition (2026-11-06; the scope as approved, not a verbatim quote).** A second workbook, a hand-built weekly
practice grid, shows the same story on the practice side: an organization that already has a practice schedule should
be able to bring it in. Added as findings F13 to F17: a practice-schedule import as a second import kind sharing the
machinery planned for games; an optional "paired days, same slot" pattern; a labelled non-team slot hold; a
capacity-versus-demand panel; and alias mapping with a coach lookup that shows practices. Recorded and not built:
coach shirt and bag tracking, and the holiday-week copy (5.10). The Windows desktop version is not in scope.

## Size verdict (prompts/plan-change.md, Step 0)

Planned, not small. It meets: spans more than one pull request (thirteen are active; PR 14 is held); changes a data model and
migrations (four migrations: a per-game flag and a guard, a games import kind with its columns, a practice import
kind, and a per-division pairing setting; the fifth, for a stored slot hold, is not planned: PR 14 is held); changes what is stored (games gain a
flag, a provenance column and a reference; teams gain an external marker; divisions may gain a pairing setting);
changes behaviour other code and people rely on (what a save, a cancel, a drag and a regeneration may do to a game; how
a practice schedule can arrive); touches the solver (`scheduleGames` gains an input; the practice solver may gain an
optional per-division rule; rule 14). It does not meet: no new dependency (reading `.xlsx` would add one and is
deferred, decisions 8 and 21), no service, no environment variable, no new authorization model (every write is an
admin RPC that checks `is_org_admin` and a signed-in user, as the practice writer does).

## Findings that change the question

1. **"Locked" does not exist for games, though the architecture note says it was planned.**
   `docs/architecture/game-scheduling.md:56` ("Locking Mechanism: ... mark specific games as locked ... unless
   explicitly unlocked") sits under a header that says the doc's implementation is COMPLETE. In the code the word is
   decoration: the only game "source" values are `auto` and `manual` (`source_enum`, `20251208000000:20`), `locked` is
   rewritten to `manual` in three places (`GameSchedulingPage.jsx:63-65`, `gameSupabase.js:16`, and the SQL
   `CASE ... = 'locked'` at `20261108020000:2000` and `:2206`), and `manual` only draws a badge (`GameCard.jsx:142`,
   `:178`). Nothing refuses a change to any game. Published is therefore new enforcement, not a rename. _Statically
   reviewed._
2. **The practice writer already implements the owner's rule for practices; reuse its vocabulary, not a parallel one.**
   `persist_practice_schedule` v3 (`20260929000000`) refuses to delete, re-range or move an assigned row unless the
   caller lists it in `unlock` with a reason, requires an org admin **with a uid** for that, writes one
   `practice.unlock_accepted` audit row per row carrying the before-image, and answers 409
   `PRACTICE_ASSIGNMENT_LOCKED` through `_shared/practice-repair-errors.ts`; the grid asks first with
   `GridOverrideDialog` (a reason picklist, one box per team; `docs/PLAN_GRID_OVERRIDE_PROMPT.md`). Two differences
   matter: practices lock **everything assigned, by default**; games lock **only what the admin marks Published**. And
   a practice unlock is one-shot (the row is locked again by the next save); the owner asked for a Published override
   that stays until it is turned back on (decision 11).
3. **Regeneration today is a whole-schedule replace that ignores the saved games, and a save deletes nothing.**
   `handleAutoGenerate` (`GameSchedulingPage.jsx:918`) calls `scheduleGames({ teams, slots, roundRobinByDivision })`
   from scratch; `handleApplySchedule` (`:1099`) saves the whole reviewed list as a **new run**;
   `persist_game_schedule` upserts on `(home_team_id, away_team_id, game_slot_id, week_index)` and deletes nothing
   (`20261108020000:2289`); the page shows one run (`useGameAssignments.js`, `.eq('run_id', runId)`), the latest
   completed (`useSchedulerRun.js:53-57`). So a game a save leaves out is not deleted: it is **orphaned in an older
   run and invisible** (the Phase D home/away plan says the same, `docs/changes/2026-10-22-phase-d-home-away.md:29-34`).
   A Published rule that only forbids edits would still let a regeneration make a Published game vanish from view. The
   server must therefore also refuse a save that **omits** a Published game (section 3.3).
4. **The freeze model is real, in memory, date-indexed and unwired; `scheduleGames` refuses a freeze on purpose.**
   `packages/core/src/freeze/` and `resolve/` have no importer in `frontend/src`, `supabase` or `scripts` (_executed_,
   section 11, R3, control: `publication` has two and tests import `externalImport` five times).
   `scheduleGames` throws on a `freeze` argument (`gameScheduling.js:321`) because it is week-indexed and its
   assignments carry no game id. `docs/MODEL_GAPS.md` GAP-29 names "no `frozen` flag" and GAP-35 "nothing persisted";
   Published **is** that stored flag, narrowed to games. The plan does not wire `freeze/` (that needs GAP-32, dates
   versus week indexes); it gives the generator a narrower, additive input, `pinned` (section 3.4), and keeps the
   throw and its test.
5. **Two readers of "the games" disagree, and the consumers of a published schedule read the one nothing fills.**
   The Games page and the master export read `game_assignments` (`useGameAssignments.js`; `useDashboardData`). The
   team page (`fetchTeamEvents`, `useTeamPortal.js:198`), the per-team CSV/XLSX export that reuses it, the `.ics` feed
   (`teamFeed.ts:154`), the Scores page and the standings read the legacy `games` table, and nothing writes `games`
   from a saved schedule: the only inserts outside tests are the 2025 seeds and the harness (_executed_, R1; the latest
   `persist_game_schedule` never names `games`, R2; `docs/changes/2026-10-22-phase-d-home-away.md:35` and
   `docs/ARCHITECTURE.md:364-366, 1542` say the same). Production holds no players and no season yet to show it
   (`20261108010000:51`). So "per-team export and `.ics`" is **not** a present strength for a league that scheduled
   through the Games page (section 8 says so), and an imported schedule would have the same blind spot. This plan
   builds everything new on `game_assignments` and reports the split as F11 (decision 12); it is its own plan.
6. **"Same as teaming" is only half true today.** Incremental teaming preserves a roster that **SquadLogic generated**
   (a persisted team run: `generationMode: 'review'`, UUIDs, manual moves and coaches kept;
   `incremental-teaming-hardening.md` 6c, `TeamAnalysisPage.jsx:1898`), reading the latest team **run's** payload
   (`useTeamPersistence.js:70-125`, `scheduler_runs.results.teams`), not the `teams` table. The roster statuses
   `draft | review | published | locked` are core vocabulary (`teamSnapshot.js:51`); no table stores one, and `locked`
   is an in-memory boolean. An organization that **arrives** with teams formed elsewhere has no way in: the player
   import keeps `team name`, `team age`, `team gender` in `custom_attributes` "for Phase B" and **nothing reads them**
   (`importAllowlist.js:115, 411` are their only mentions; the play-down plan found the same for `team_age`), team
   creation is "pending follow-up" (`docs/operations/ingestion-pipeline.md:71`), and a team row is only ever inserted by
   team generation or the demo seed (`persist_team_schedule`, `20261018070000:544`). A team **can** exist with no
   players (the Edge schema allows an empty `teamPlayerRows`; "shells survive, even empty", hardening 6c). So the
   games analogue the owner asked for needs one thing teaming never built: a way to create team shells from the file,
   recorded as a team run so a later generation sees them (section 4.5). Decision 6.
7. **The Import panel does not accept `.xlsx`; the brief's premise is false.** `ImportPanel.jsx:950` is
   `accept=".csv"`, the preference panel `.csv,text/csv`; the only spreadsheet code is a **writer**
   (`write-excel-file`, `scheduleDownloads.js:88`); the parser is `papaparse` (R4). Reading a workbook is a new
   dependency; recommended CSV first (decision 8). The owner's workbook has an `Import` sheet whose nine columns a
   "Save as CSV" turns into exactly the file this plan specifies.
8. **The generator does not consult shared space or a coach travel buffer, so two "present and stronger" claims need a
   caveat.** `scheduleGames`' own header says the facility model (containment, spatial overlap) "is deliberately not
   consulted here" (`gameScheduling.js:283-291`); its coach check is a raw time overlap (`:899-912`); the 60-minute
   travel evaluator (`waivers/coachTravel.js`) and the whole rule engine have no production importer (R3). The
   example workbook has six fields with shared space and a 20-minute travel buffer setting. The import's conflict
   audit therefore uses the three checks that **do** run on the Games page (`team-double-booked`, `coach-conflict`,
   `field-overlap`, `gameMetrics.js:281-300`) and says plainly what it did not check (F12).
9. **The workbook's own conflict counts could not be reproduced by a plain check.** Its cached summary says 4 games in
   field double-bookings, 20 games in coach clashes and 8 teams flagged (labels say "games" and "flagged"; the brief
   called the last "uneven home/away", which the label does not say). A plain overlap check by date, venue and field
   on its `Schedule` sheet finds **0** pairs (_executed_, section 11), so the 4 come from the workbook's own rule
   (shared space and/or the turnover). The fixture therefore plants clashes by **SquadLogic's** checks and pins what
   they report, never the workbook's numbers.
10. **A schedule importer was already named as missing, with the incident that needs it.** `docs/ARCHITECTURE.md:1547`
    ("no schedule importer ... 're-import the published schedule as ground truth' - the only recovery that worked in
    incident #1 - has no path today"). F10 closes a recorded gap, and the Published flag is what keeps incident 1 (366
    games moved by a re-solve; `docs/FREEZE_SCOPES.md`) from happening through the UI.
11. **Outside opponents are real teams to every reader of `game_assignments`.** Both team ids are `NOT NULL` on
    `games` and required by `persist_game_schedule`, and 52 files under `frontend/src`, `packages/core/src` and `supabase/functions` (mocks and `*.test.*` left out) read
    `awayTeamId` or `away_team_id` (_executed_). The example has 31 labels on its schedule that are not on its `Teams` sheet and 39 games that name one,
    always as the away side, on one venue, in six divisions; its `Fixed Games` sheet has 43 rows. Representation:
    section 4.6, decision 5.
12. **The practice side has no "latest run hides the rest" problem, but its writer is the wrong door for an import.**
    Every practice reader is keyed on the season, not on a run (`useSeasonPracticeAssignments.js`: "writer v3 is
    add-only, so the season holds rows from every earlier save under their own run ids"), and
    `practice_assignments.run_id` is nullable (`20260503020000:5`), so a row an import writes is visible to every
    reader at once and needs no run (games did, finding 3). `persist_practice_schedule` is a whole-season replace with
    lock-by-default: an empty payload is refused (`20261108020000:715`), a team's auto row the payload omits is pruned
    only if listed in `unlock` with a reason (`:1186-1209`), and its gate judges only a new row that is both
    `source = 'auto'` and `assigned_via = 'auto'` (`:1470`, `:1485`); "manual, repair, recommendation and override
    rows keep today's checks" (`:1481-1484`). An import is additive and must accept what the gate would refuse, so it
    gets a writer of its own that only inserts (4.11.4). _Statically reviewed._
13. **The writer's own double-booking check does not look inside one payload.** "A new key must not double-book its
    team" compares the payload's keys with rows already **stored** (`20261108020000:1324-1368`; the payload's own rows
    are inserted after it, `:1370-1473`), and the gate skips manual rows, so two new manual rows of one team on one
    weekday at overlapping times in one save both pass. `docs/PLAN_GRID_OVERRIDE_PROMPT.md` 1.1 says such a row
    "refuses the same way"; that holds for a row against a stored one, which is what the grid sends (one row at a
    time). _Statically reviewed, not executed._ PR 10's first pgTAP case turns it into a fact (smallest input: one
    team, two slots on one weekday and time, both `manual`, one payload). Reported, not fixed (rule 2); it matters here
    because the import must judge its own team clashes, and does (4.11.4).
14. **A grid is not a file.** In the owner's practice grid the weekday sits only in a header merged over three
    columns; there are two blocks with different time headers (the 45-minute block has times on two of the five
    weekdays, the 60-minute block on all five); two rows hold a `.` marker; two team names carry stray whitespace; and
    20 of the 235 team cells are merged over two field rows (two halves of one field, so the whole field). A reader that
    takes each merged range's top-left cell records those 20 on the first half only and sees the second half as free.
    There is no division column: the team name carries an age and gender code. _Executed_ (R12 to R15). This is why
    the import takes a flat file (4.11.2).
15. **The TIME TBD refresh is an importer's only door to the TIME TBD list, and "fill the gaps only" already exists for
    practices.** `sync_schedule_tbd_practices` refuses any caller but `persist_practice_schedule` and
    `refresh_schedule_tbd_practices` (a `PG_CONTEXT` check, `20261108020000:236-240`), so the import calls the refresh
    (signed-in admin, same season lock, `:347-440`); the example's 29 one-practice teams then appear in the TIME TBD
    list with `missing_count` by the existing roster-times-division-count rule, with no new code. The next
    auto-scheduler run fills them and touches nothing else: `planTeamsForRun` gives a team `max(target - held, 0)`
    units, leaves a team at or over its count `locked`, and reports an over-count (`overTarget`) without trimming it
    (`supabase/functions/_shared/engines/practice-lock.ts:232-275`, "maximum freeze"). _Statically reviewed._
16. **Capacity 0 is not a hold.** It looks like a no-schema way to keep a time free: the writer gate refuses a new auto
    row on a slot whose peak exceeds `COALESCE(capacity, 1)` (`20261105010000:167-178`) and the solver's capacity rule
    does the same (`practice-coaches.ts:310`). But the Practices page raises 0 to 1 when it builds a run's slots
    (`PracticeSchedulingPage.jsx:209`), the core loader throws on a non-positive capacity (`practiceSupabase.js:98-102`)
    and the fields CSV refuses `Capacity` below 1 (`import-validation/index.ts:443`). Refuted; F15 builds on that.
    _Statically reviewed._
17. **The workbook's alias tab cannot be tied to its grid by a plain match.** It has 21 rows and 20 distinct targets;
    none of its 21 names occurs on any other tab, and 4 of its 20 targets occur as row labels on the main grid
    (_executed_, R13). What it aliases is unknown; the question that resolves it: which list is "the schedule" in its
    header. The import's existing `HEADER_ALIASES` (`import-validation/index.ts`) aliases column headers, a different
    thing from a value alias.
18. **A venue the import creates is unlit and has no coordinates.** The field import creates a location with
    `lighting_available` false unless the row says otherwise (`20261029010000:629`), undeclared lighting is unlit, and
    no coordinates reads "sunset unknown", never "within daylight" (`docs/architecture/practice-scheduling.md`, Daylight).
    A practice import that creates venues therefore makes every practice there read sunset-unknown on the Practice
    daylight page until the admin enters coordinates; the confirm step says so (4.11.5). _Statically reviewed._

## 1. The findings: what exists, what is absent, what to do

Effort is S under 150 lines, M 150 to 500, L over 500, tests included (estimates, not measurements). "Schema" says
whether the item needs a migration.

| #   | Finding                                       | Exists today (verified, with reference)                                                                                                                                                                                                                                                                                                                                  | Absent                                                                                | Recommendation                                                                                                                                                                                                           | Effort | Schema                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------- |
| F1  | Set-up / take-down duty roster per field-day  | Nothing (0 files match `take down`, `setup duty`, `field duties`; control: 27 files match `blackout`). Practice daylight code uses "teardown window" for sunset only (`practice/daylight.js:10`).                                                                                                                                                                        | The whole feature                                                                     | **Build later** (after PR 8), list-only, derived from the saved games, no automatic team assignment unless the owner chooses it (decision 9). Admin export, never a team view.                                           | M      | No                                                                          |
| F2  | Day Sheet (one date, optional venue)          | Nothing (0 files match `day sheet`; same control). The master export has every game with start, end, field (`outputGeneration.js:36-54`).                                                                                                                                                                                                                                | A one-date, one-venue view and file                                                   | **Build** (PR 7): a read-only section of the Exports page plus CSV, over `game_assignments`, TIME TBD listed. Admin only.                                                                                                | S      | No                                                                          |
| F3  | Coach Lookup (a coach's teams together)       | Partial. Coaches page lists each coach with their teams, divisions and status (`CoachesPage.jsx:97`, `buildCoachReviewRows`); `listTeamCoachIds` reads head and assistants; the master export has `Coaches` and `Coach Emails`. No games per coach.                                                                                                                      | Games per coach in one place, with the clash flag                                     | **Build** (PR 7): a "Schedule" action per coach (CSV/XLSX) over `game_assignments`, with a coach-clash column from `evaluateGameSchedule`. Admin only; not a coach view.                                                 | S      | No                                                                          |
| F4  | Per-team Early/Late preference                | Not for games (`early/late` matches one file, `practiceSlotExpansion.js`, which is about season boundaries). Games keep only "repeat the team's usual start" (`teamStartPreferences`, `gameScheduling.js:342`); practices have coach preference rules (`practice/coachPreferences.js`).                                                                                  | A stored preference and any use of it                                                 | **Do not build in the solver.** Generation already refuses a coach overlap outright (hard); an unplaceable game is TIME TBD with a reason. Revisit only as a flag (decision 10).                                         | M      | Yes, if ever stored                                                         |
| F5  | TeamSnap / GotSport-ready schedule export     | Only prose: "TeamSnap Integration Considerations" and "not implemented, out of scope for v1.0" (`output-generation.md:12`, `:52`; the note's "CSV only" is stale, XLSX exists). Master and per-team CSV/XLSX and `.ics` exist.                                                                                                                                           | Any platform-shaped file                                                              | **Build now** one file: SquadLogic's own schedule CSV, the import's format, so export and import round-trip (PR 6). **Build later** TeamSnap and GotSport shapes (section 5.5).                                          | S now  | No                                                                          |
| F6  | Add one game by hand                          | Cancel (`admin_cancel_game_assignment`, a hard `DELETE`, `20260613000003:68`) and move (drag and "Move to", `GameSchedulingPage.jsx:1203`). No create path in the UI; the only writer that inserts is the whole-schedule save.                                                                                                                                           | Create                                                                                | **Build** (PR 8), after Published and the import's slot helper: stage a manual game, Apply through the existing save. Starts unpublished.                                                                                | M      | One RPC (find-or-create a game slot), shared with the import; no new column |
| F7  | Fixed external fixtures that hold field time  | `packages/core/src/externalImport/` (mapping, resolution, impact, avoid windows) has no importer outside tests and says it persists nothing (`index.js:45-52`; R3). The unknown-team plan treats visiting clubs as _expected unknowns_ (`PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md` s2.2).                                                                                     | A way for an outside side to be a game participant; a way for those games to stay put | **Build, inside F10 and F9**: outside sides are flagged team rows (decision 5); imported fixtures arrive Published, so regeneration keeps their field time. Do not wire `externalImport` yet; reuse its name normaliser. | M      | Yes (`teams.is_external`), in PR 5                                          |
| F8  | A Changes log: originally versus now          | The pieces: baselines (`publication_baselines`, immutable, versioned, wired in the Exports panel), `checkBaselineParity` (named differing and removed rows), the audit trail (`game.saved`, `game.cancelled`); `buildChangeNotices` is exported (`publication/index.js:142`) and has no importer in `frontend/src` (_executed_; control: `checkBaselineParity` has one). | A per-game "originally, now, why" view                                                | **Build as a view** over baselines, the saved schedule and the new override audit rows (PR 7); no new store.                                                                                                             | M      | Read RPC only (in PR 1)                                                     |
| F9  | The Published toggle                          | Nothing enforces anything for games (finding 1). Practices have lock-by-default and `unlock`; completed seasons are read-only by trigger (`20261111010000:520-655`).                                                                                                                                                                                                     | Everything                                                                            | **Build** (PR 1 to 3), as section 3 designs it.                                                                                                                                                                          | L      | Yes (PR 1)                                                                  |
| F10 | Import an already generated schedule          | No schedule importer (`ARCHITECTURE.md:1547`). Machinery to reuse: job lifecycle, staging, application records and rollback (`20260503060000`), find-or-create game slot (`20261029010000:1008-1100`), dry-run finalizer (lesson 74).                                                                                                                                    | The import kind, mapping, preview, rollback, fixture                                  | **Build** (PR 4 to 6), as section 4 designs it; CSV, not `.xlsx`.                                                                                                                                                        | L      | Yes (PR 5)                                                                  |
| F11 | _Found:_ team page, feed, scores read `games` | See finding 5 and R1/R2.                                                                                                                                                                                                                                                                                                                                                 | Any writer of `games` from a saved schedule                                           | **Report; its own plan, before PR 5** (decision 12). Not fixed here; this plan does not read `games`.                                                                                                                    | M      | Probably (a view, or readers moved)                                         |
| F12 | _Found:_ shared space and travel buffer       | Modelled and enforced for **practice** slots (`practice_slot_conflicts`, `20261029010000`; `ingestion-pipeline.md:164`); modelled but unwired for games (finding 8).                                                                                                                                                                                                     | Games honouring shared space or a travel buffer                                       | **Do not build now.** The import audit says what it did not check. Revisit with the date-indexed bridge (GAP-32).                                                                                                        | L      | No                                                                          |
| F13 | Import a practice schedule already made       | No importer for placements (`import_type` list: players, coaches, fields, field_availability, practice_preferences, evaluations, `import-validation/index.ts:524`; R17). The fields CSV makes practice slots (`finalize_field_import_job`). The writer locks everything saved and gates only new `auto` rows (`20261108020000:1485`); readers are keyed on the season.   | The import kind, mapping, preview, flags, rollback, fixture                           | **Build** (PR 9 to 11): a flat CSV, an additive writer, accept-and-flag, rows arrive locked; shares PR 4 to 6's machinery (4.11).                                                                                        | L      | Yes (PR 10): types, RPCs; no column on assignments                          |
| F14 | Paired days, same slot, per division          | A team's practices must fall on different weekdays (`practice-coaches.ts:280-345`; writer rule `weekday`, `20261105010000:192`). No pairing or same-slot rule (R20; control: the weekday rule matches). `keepVenue` is a per-coach rule (`coachPreferences.js:130`). In the example, 83 of 98 two-weekday teams use one field and start on both days.                    | A per-division setting, and the solver and writer honouring it                        | **Build later** (PR 12): optional, off by default so nothing changes for existing leagues; solver and writer rule (rule 14); decision 27.                                                                                | L      | Yes (a division column; a gate rule)                                        |
| F15 | Labelled recurring non-team slot hold         | Date-based `field_blackouts` (no weekday; the practice solver never reads them, R21), division reservations (need a division), `practice_slots.label`, and `Clinic` as a field size option (`FieldManagementPage.jsx:1009`). Capacity 0 is refuted (finding 16).                                                                                                         | A way to keep a weekly time free for a non-team activity                              | **Now** (S, inside PR 10 and 11): a non-team cell makes no slot and is listed. **Held** (PR 14, M): a stored hold; not built (decision 28).                                                                              | S, M   | No now; yes for a stored hold                                               |
| F16 | Capacity versus demand, before a run          | After a run only: readiness shows manual actions and reasons (`PracticeReadinessPanel.jsx:134-139`); the run lists per-team shortfalls; `get_schedule_tbd` lists short teams. `slotUtilization` is computed (`practiceMetrics.js:748`) and no component renders it (R24).                                                                                                | A per-division view of slots against need, before a run                               | **Build** (PR 13): a read-only panel on the Practices page, labelled an upper bound, with no schema; decision 29.                                                                                                        | M      | No                                                                          |
| F17 | Alias mapping; Coach Lookup shows practices   | `externalImport/mapping.js` has one normaliser and no alias table (R25). The Coaches page lists a coach's teams; its `multi` badge is the stored flag (`CoachesPage.jsx:131, 570`), not derived from the teams. No practices or games per coach.                                                                                                                         | Alias proposals; practices and derived multi-team coaches in the coach view           | **Build**: alias file and last-job proposals in the mapping step (PR 9, decision 30); practices in F3's coach schedule (PR 7, task G2b, decision 31).                                                                    | S      | No                                                                          |

F13 to F17 were added on 2026-11-06 from the second workbook. Their designs are 4.11 (F13, with the F17 mapping), 5.7
(F14), 5.8 (F15), 5.9 (F16) and the last paragraph of 5.1 (F17's coach lookup); two things from the workbook are
recorded and **not** built (5.10).

## 2. Today: who writes and reads a game, and what already guards something

**Writers of `game_assignments`** (_statically reviewed_; the list is the census the Published guard has to cover,
lesson 64 "a lock that only some writers take is not a lock", lesson 73 "walk the pipeline's lists"). Members hold
`SELECT` only (`20261104010000:1488`), so every write is a `SECURITY DEFINER` function or a foreign-key cascade:

| Writer                                                      | What it does to a game                                                                                                     | Reference                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `persist_game_schedule(run_data, assignments)`              | Inserts a run, upserts every assignment on `(home, away, slot, week)`, replaces the TIME TBD list                          | `20261108020000:1763`, upsert `:2289`, TIME TBD `:2313`   |
| `admin_cancel_game_assignment(id)`                          | Hard `DELETE`, audited `game.cancelled`; the page asks with `window.confirm`                                               | `20260613000003:68`; `GameSchedulingPage.jsx:1374`        |
| Cascade from `teams` (`admin_delete_team`)                  | Deletes the team's assignments (home and away keys are `ON DELETE CASCADE`)                                                | `20261112010000:1413` (latest); `20260503030000:76`       |
| Cascade from `game_slots` (field import rollback, etc.)     | Deletes assignments on the slot; already refused while the slot is booked                                                  | `20260909000000` (rollback booking guard)                 |
| Field delete or retire (`field_id` is `ON DELETE SET NULL`) | An update of `field_id` by the foreign-key action; refused first by `field_bookings`, so the Published guard is a backstop | `20260907000000`; `20260503030000:65`                     |
| Cascade from `organizations`; no-signed-in-user jobs        | Retention and demo purge reach every row                                                                                   | `20261111010000:520-630` (the same exemptions, lesson 56) |
| `scheduler_runs` delete                                     | `run_id` is `ON DELETE SET NULL`: orphans a game, deletes none                                                             | `20260503030000:27-30`                                    |
| `persistGameAssignments` (direct table write)               | No importer anywhere (_executed_ search finds only its own file); RLS would refuse it                                      | `gameSupabase.js:80`                                      |

**Readers of "the games"** (finding 5): `game_assignments` through the latest completed `game` run for the Games page,
the master export and the Exports panel's publish and parity; `games` for the team page, per-team exports, the
`.ics` feed, Scores and standings.

**What already guards a game or a schedule:** completed seasons are read-only by trigger on `game_assignments`
(`games_readonly_when_completed` and `game_assignments_readonly_when_completed`, `20261111010000:632-655`), refusing a
signed-in caller with 22023 `season_completed` and letting no-user jobs and org-gone cascades through; the Exports
panel's "Publish" uploads the files and records an **immutable baseline** (`publication_baselines`, a per-organization
monotonic `baseline_version`, `admin_publish_schedule_baseline`, audited `publication.baseline_recorded`); parity says
"the working schedule has moved since publication vN" and names the rows (`checkBaselineParity`,
`OutputGenerationPanel.jsx:279-410`). None of these stops a single game from being moved in a live season.

### 2.1 The practice side today: who writes and reads a practice (added 2026-11-06)

_Statically reviewed_ unless marked. The census the practice import has to join (lesson 64: the practice lock lives in
the writer's body, not in a trigger, so every other writer is a place the lock does not reach; lesson 73).

**Writers of `practice_assignments`** (latest definitions):

| Writer                                                   | What it does to a practice row                                                                                                                                          | Reference                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `persist_practice_schedule` v3 (invoker; admin)          | Upserts on `(team, slot, range)`; deletes, re-ranges or withdraws an exception only for rows listed in `unlock` with a reason; gates new `auto` rows; rebuilds TIME TBD | `20261108020000:515`; lock `:1186-1209`; insert `:1425`; gate `:1485`; TIME TBD `:1638` |
| `admin_delete_team`                                      | Deletes the team's assignments                                                                                                                                          | `20261112010000:1413` (delete at `:1497`)                                               |
| Cascades from `teams`, `practice_slots`, `organizations` | Delete assignments (the field import's rollback is refused while a slot is booked)                                                                                      | `20260331000000:522-535`; `20260909000000`                                              |
| Demo seeds                                               | Insert the demo league's practices                                                                                                                                      | `20261110010000:861`; `20261114010000:401`                                              |
| Completed seasons                                        | Every signed-in write is refused by trigger (no-user jobs and org-gone cascades pass)                                                                                   | `20261111010000:641`                                                                    |

**What the writer accepts and what its gate judges.** `source` is `auto` or `manual`; `assigned_via` is `auto`,
`manual`, `repair`, `recommendation` or `override` (`20261108020000:866-870`; the table CHECK, `20260929000000:100`). A
new row that is not both `auto` and `auto` skips the gate. The gate, `practice_new_auto_row_refusals`
(`20261105010000:115-215`, read-only, invoker), judges five rules (capacity, reservation, length, weekday, count) and
takes any assignment ids: it judges whatever source they carry (`judged AS ... WHERE l.id = ANY (p_assignment_ids)`,
`:161-166`); the writer decides which rows to hand it. The writer is where "lock by default" lives: everything saved
is held, whatever its `source` (`PracticeAssignmentList.jsx` says so beside the lock button: "Provenance, not a lock").

**Readers and what the Practices page shows.** The page lists the season's assignments as a **table** (team and
division, day and time and field, date range, a lock toggle and a cancel button: `PracticeAssignmentList.jsx`); there is
**no field-by-day grid** on it (`GameScheduleGrid.jsx` and `FieldColumn.jsx` are the Games page's; `DataGrid` serves the
players, coaches, blackouts and scores pages), so this plan proposes no new list of assignments. Readiness is
`PracticeReadinessPanel.jsx:134-139` (manual actions, reasons, data-quality warnings, after a run). The Practice
daylight and lighting pages read slots and assignments and write nothing. Every reader is keyed on the season, not a
run (`useSeasonPracticeAssignments.js`).

**The solver, for an import's sake.** It holds saved rows (finding 15): a team needs `max(target - held, 0)` more, so
imported rows are never moved by a run and a team short of its division's count is what the next run fills.

## 3. Design A: the Published switch (F9)

### 3.1 Vocabulary: reuse the words the repository already has

| Word in use                                                             | What it means now                                                                 | Decision for this plan                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Published** (Exports panel, `publication_baselines`)                  | An export went out; an immutable record of its rows exists                        | The switch is called **Published** because it means the same thing to the admin: these games were told to families. The baseline stays the evidence and is never edited. The switch is the working-state guard. They are linked by one optional act (decision 3): publishing a baseline offers to mark its games. |
| **locked / unlock + reason** (practice writer v3, `GridOverrideDialog`) | Everything assigned is held; one row at a time is released by an accepted prompt  | The **override** reuses its mechanics: admin with a uid, a closed reason list, one audit row per row with the before-image, 409 with a stable code, a dialog with one tick and a reason. It is **not** lock-by-default: only Published games are held. Difference stated in finding 2.                            |
| **freeze / thaw** (`freeze/`, `resolve/`)                               | In-memory scopes for a date-indexed re-solver; nothing persists                   | Published is the **stored per-game flag** GAP-29 and GAP-35 say is missing. It reaches the generator as `pinned` (3.5), not as a freeze plan. A `FreezeMatch` with `gameId` is the same idea; wiring it waits for GAP-32.                                                                                         |
| `draft / review / published / locked` (`teamSnapshot.js`)               | Roster lifecycle words in core; nothing stored; any persisted roster is preserved | Unchanged. The same four words could one day be stored for rosters; out of scope. The games flag is boolean on purpose (decision 11).                                                                                                                                                                             |
| `assignment_source` `auto / manual`                                     | Who placed it; `manual` draws a badge                                             | Unchanged, and **independent** of Published: a manual game can be unpublished, a generated one published. `locked` keeps mapping to `manual` (do not touch).                                                                                                                                                      |

### 3.2 Data (PR 1, one migration; rule 14)

`game_assignments` gains three columns: `published boolean NOT NULL DEFAULT false`, `published_at timestamptz`,
`published_by uuid` (an actor id, no contact details; `ON DELETE SET NULL`), and a partial index on
`(organization_id) WHERE published`. `published_at` and `published_by` record the most recent time the flag was
turned on and are **kept** when it is turned off, so "changes allowed" (off after having been on) is `NOT published AND
published_at IS NOT NULL`, with no fourth column. The default makes the migration a no-op for every existing row and every league
until someone publishes, so a league that never touches the switch behaves exactly as today (lesson 94's
"nothing changes" is a test, 7.1). The two audit actions go into `audit_actions` (the FK fails at runtime
otherwise, lesson 5): `game.published_set` and `game.publish_overridden`. No other table changes; the baseline store
is untouched.

### 3.3 What is refused, on every path (server-side; the UI is only the friendly half)

| Path                                                                           | Today                         | With a Published game                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger `game_assignments_published_guard`, `BEFORE UPDATE OR DELETE`, per row | n/a                           | For a signed-in caller, judged on the **old** row (so clearing the flag and moving in one statement is refused): refuses a `DELETE` of a published row, and an `UPDATE` of a published row that changes `game_slot_id`, `slot_id`, `field_id`, `home_team_id`, `away_team_id`, `week_index`, `start` or `"end"`. Allows `run_id`, `assignment_source`, `division` (a label that follows a division rename, not a placement), `updated_at` and the `published*` columns. 22023, `DETAIL game_published`. No signed-in user passes; an organization-gone cascade passes (the completed-season trigger's two exemptions, copied by contract). A team or slot **cascade is refused**. |
| `persist_game_schedule`: payload moves a published row                         | Upsert moves it               | The trigger refuses (the upsert's `DO UPDATE` names `slot_id`, `field_id`, `start`, `"end"`; an unchanged value is not "changes", so carrying a row forward unchanged passes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `persist_game_schedule`: payload **omits** a published row                     | Row orphaned in the older run | New check inside the RPC (a row trigger cannot see an absence): every published row of the season (every season when none is given) whose key `(home, away, slot, week)` is not in the payload refuses the whole save, 22023 `game_published_omitted`, `DETAIL` the first 50 ids and the count. Nothing is written.                                                                                                                                                                                                                                                                                                                                                               |
| `admin_cancel_game_assignment`                                                 | Deletes                       | Refuses a published row, 22023 `game_published`. The message tells the admin to allow changes first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `admin_delete_team`                                                            | Cascades                      | A pre-check counts the team's Published games and refuses with the count (friendlier than the cascade's trigger message, which stays as the backstop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Drag, "Move to" (keyboard), "Apply"                                            | Stage, then the save above    | `moveGameTo` (the one handler both use, `GameSchedulingPage.jsx:1203`) refuses a Published game with a status sentence, no staging; the card shows no drag handle and its "Move to" is replaced by "Allow changes". The server refuses regardless.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Regeneration                                                                   | Replaces everything           | Published games are `pinned` (3.5) and carried unchanged into the new run; the omission check proves they were.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Import (PR 5)                                                                  | n/a                           | A row that would change a Published game is `skipped-published` in the preview and not written, unless the admin has allowed changes for that game first. New games arrive Published by default (decision 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Score entry, TIME TBD list, exports, baselines                                 | Unchanged                     | Unchanged: scores live on `games`; the flag is per assignment; an export reads it nowhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`persist_game_schedule` and `admin_delete_team` are replaced whole (`persist_game_schedule` copied from
`20261108020000:1763`; `admin_delete_team` from `20261112010000:1413`, its **latest** body, which counts the practice
preference rules its cascade takes: amended 2026-11-06, see the Amendments); that is a flagged
cost: replacing a function moves every mutation plant aimed at its old body (lesson 70), so PR 1 re-aims them and its
description lists them. `admin_cancel_game_assignment` is re-created from `20260613000003`.

### 3.4 The override: deliberate, visible, audited, reversible

The override **is turning the flag off**, as its own act with its own reason; the edit is then an ordinary edit; turning
the flag back on is the reversal. (Lesson 86: a decision made as a side effect of saving is a decision nobody made; no
save, move or cancel ever overrides anything implicitly.)

`admin_set_games_published(p_organization_id, p_assignment_ids uuid[], p_published boolean, p_reason_code text,
p_note text, p_scope jsonb)` returns `{ changed, unchanged, ids }`. Gates, in this order, each a test:

1. A signed-in caller. No user (the service role) is refused 42501, as `unlock` requires a uid.
2. `is_org_admin(p_organization_id)` (admin, tenant admin and staff, owner decision 2026-10-20), else 42501.
3. Between 1 and 2,400 ids (the spreadsheet's own row limit; documented), all existing, all in the organization.
4. The rows are locked `FOR UPDATE` in id order (lesson 64: lock order). A completed season refuses through the
   existing trigger (the read-only rule wins over the flag).
5. Turning **off** needs a reason code from the closed list `field-change`, `coach-request`, `conflict-fix`,
   `published-in-error`, `other` (the first four are exactly `GRID_OVERRIDE_REASONS`; a test holds them equal) and
   takes an optional note of at most 200 characters (decision 1, answered: allowed, with helper text and a counter in the dialog, PR 3 task C3). Turning **on** needs none.
6. Setting a game to the value it already has is a no-op, counted as `unchanged`, never audited.

Audit (`audit_log`, written in the same transaction; a failed audit write rolls the change back, SQLSTATE `SLA01`, as
the save does): `game.publish_overridden`, **one row per game**, with the before-image (slot, field, teams, week,
start, end), `reason_code`, the note, and the scope; `game.published_set`, **one row per call**, with the scope
(`{kind: all | division | date | venue | selection, value}`), the count and the ids (at most 2,400, about 90 KB; a PR 1
task measures it). A new read RPC `get_schedule_audit_log(p_organization_id, p_assignment_id, p_limit)` (admin only,
like `get_settings_audit_log`) returns those rows with the actor, for the Games page's per-game history and for F8.

Who: any `is_org_admin`. The alternative (admin and tenant admin only, not staff) is decision 1.

### 3.5 The generator: one additive input, `pinned` (PR 2; solver, rule 14)

`scheduleGames({ teams, slots, roundRobinByDivision, pinned })`, `pinned` an array of saved assignments in the shape
the function already returns. With none, **the function is byte for byte today's** (the season fixture and the
generation goldens, run in PR 2). With some:

1. Each pinned game's slot loses one unit of capacity, so nothing is generated on top of it.
2. Each pinned game consumes one matchup of its unordered pair, preferring the same `weekIndex`; a pinned game whose
   pair is not in the round robin (an outside side, an extra game) consumes none and still occupies its slot.
3. Its team and coach times are registered for the existing double-booking and coach checks, so a new game cannot
   clash with a pinned one.
4. Its home/away sides feed the existing `keepSides` (`savedSides`, `gameScheduling.js:84`, already fed from the saved
   run by the page, `GameSchedulingPage.jsx:743`).
5. Pinned games are returned as `carried`, separately from new `assignments`, and the page saves both.

`freeze` stays refused with its message (the test stays, and gains a sentence naming `pinned`). Unpublished games
are still re-solved as today; "regeneration fills gaps only" is a different product choice (decision 14).
A matchup that no longer fits stays TIME TBD with a reason, never silently dropped (AGENTS.md section 3).

### 3.6 The Games page (PR 3)

- Each saved game's card shows **Published** as text on a switch (`role="switch"`, an accessible name "Published: home
  versus away", state also in words, not color alone), in both themes with existing tokens. A game that is not saved
  yet (a staged review) has no switch and says "Apply the schedule first".
- A bulk bar: "Publish" for all unpublished, one division, one date, one venue; "Allow changes" for the same scopes. The
  page resolves the scope to ids **from the saved set**, never from a filtered view, and shows the count before it
  sends (lesson 92: say what the number is a count of).
- "Allow changes" opens a dialog built on `GridOverrideDialog`'s pattern: the count, the first ten games, a reason
  picklist, the optional note (with its helper text and a counter of 200), one tick, Confirm disabled with a visible reason until both are given; focus to the
  heading and back to the opener; a refusal shown as an alert in the dialog.
- A persistent line: "N games Published, M with changes allowed" and a filter for each, so a forgotten override is
  visible (decision 11 chooses whether it ever reverts by itself; the recommendation is no, and visible).
- States: loading, no saved schedule (controls disabled with the reason), no permission (the badge shows, controls do
  not), completed season (read-only note already on the page, `SeasonReadOnlyNote`), a refused call (the database's
  words). Drag has the non-drag alternative AGENTS.md section 9 requires: the keyboard "Move to" already exists, and
  for a Published game "Allow changes" is its keyboard path.
- The Exports panel's "Publish" gains one checkbox, "Mark these games Published" (default on, decision 3), calling the
  bulk RPC with the ids in the export.

### 3.7 Regeneration, moves, cancel and import, in one table

| Act                         | Published game                                               | Game with changes allowed           | Unpublished game     |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------- | -------------------- |
| Regenerate                  | Carried unchanged (pinned); never reshuffled                 | Re-solved like any unpublished game | Re-solved (as today) |
| Drag, "Move to"             | Refused in the UI and on the server                          | Staged, then Apply                  | Staged, then Apply   |
| Cancel                      | Refused; "Allow changes" first                               | Allowed (audited `game.cancelled`)  | Allowed              |
| Re-import of the same row   | Unchanged (idempotent); a changed row is `skipped-published` | Updated                             | Updated              |
| Delete the team or the slot | Refused with the count                                       | Allowed as today                    | Allowed as today     |
| Turn the flag back on       | n/a                                                          | Published again (audited)           | Published (audited)  |

## 4. Design B: importing an already generated schedule (F10, with F7)

### 4.1 The analogue of what teaming does, and where it stops

| Question                          | Teaming today (finding 6)                                                               | Games (this plan)                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| How does existing work arrive?    | A registration file (players). Teams cannot arrive: only generation creates them        | A schedule CSV (games). Teams the file names can be created as shells, on confirmation (4.5)                |
| Identity on a re-import           | `external_registration_id` (the player import's key)                                    | A `Game ID` column kept as `external_ref`; without it `(home, away, slot, week)`, the existing unique index |
| What a later run must not disturb | A persisted roster: ids, manual moves, coaches (`preserve-existing`; `teamSnapshot.js`) | Published games, carried unchanged (`pinned`, 3.5)                                                          |
| Stored lifecycle                  | None; `draft/review/published/locked` are words in core                                 | One boolean, Published                                                                                      |
| Undo                              | Coach and field imports have rollback by application records                            | `rollback_game_import_job`, the same record table                                                           |
| Left open by this plan            | "Keep teams formed outside" (the unread `team name` columns)                            | Shares the mapping step and the shell writer, so that plan reuses them (out of scope here)                  |

### 4.2 The flow (reuse in italics)

1. _Upload and parse in the browser_ (`papaparse`; the Import panel gets a Games tab; `accept=".csv"`; a downloadable
   template whose header row is the file format in 4.3). Demo sessions are fenced as every import is (`isDemo`,
   `demo_sessions.sql`).
2. _`create_import_job`_ for the new type, into the organization's active season as every import (a draft or
   completed season is refused, 22023).
3. _`import-validation`_ gains `import_type: 'games'`: allowlist the columns, validate each row (Zod), put wall times on
   the season clock, stage into _`staging_import_rows`_ with `normalized_payload` and `validation_errors`. No mapping
   happens in the Edge function.
4. **Mapping** in the browser: core proposes by exact normalised label (4.5) and the admin resolves the rest;
   `map_game_import_job(job, mapping)` validates every id against the organization and season and stores the mapping on
   the job. Nothing is guessed (the rule of `externalImport/mapping.js`: one normaliser that trims, collapses spaces and
   folds case, never drops a word).
5. **Preview** = `apply_game_import_job(job, dry_run => true)`: _one statement with its writes off_ (lesson 74, the
   evaluations finalizer's shape), so the counts cannot disagree with the apply; plus the conflict audit computed in
   the browser from the mapped rows. A test requires the audit over the staged rows to equal the audit over the saved
   rows after apply (lesson 77: a preview is a twin, held by a test that reaches every outcome).
6. **Confirm**: "Games arrive Published" (default on, decision 4), and an explicit list of everything that will be
   created (team shells, divisions, venues and fields) with its count.
7. `apply_game_import_job(job, false)` in one transaction (4.7); a result screen with the counts, the flagged
   conflicts and the rows skipped; **Roll back** stays offered while no imported game has been changed.

### 4.3 The file: one documented CSV

| Column                                 | Required       | Accepted                                                                                            | Stored as                             |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Date`                                 | yes            | `YYYY-MM-DD` or `M/D/YYYY` (US); anything else is `bad-date`, never guessed                         | `game_slots.slot_date`                |
| `Start Time`                           | yes            | `HH:mm` or `h:mm AM/PM`                                                                             | `start_time`, and the instant `start` |
| `End Time` or `Length`                 | one of the two | A time as above, or minutes                                                                         | `end_time`, and the instant `"end"`   |
| `Venue`, `Field`                       | yes            | Names, mapped to `locations` and `fields` (4.5)                                                     | `game_slots.field_id`                 |
| `Home Team`,`Away Team`                | yes            | Labels, mapped to teams (4.5, 4.6)                                                                  | `home_team_id`, `away_team_id`        |
| `Division`                             | yes            | A name, mapped to a division                                                                        | `game_assignments.division`           |
| `Game ID`                              | no             | Text up to 40 characters                                                                            | `game_assignments.external_ref`       |
| `Week`                                 | no             | Positive integer; else derived (4.8)                                                                | `week_index`                          |
| anything else (`Format`, `Notes`, ...) | no             | **Dropped before staging and never stored** (the allowlist; data minimisation, AGENTS.md section 2) | nowhere                               |

The owner's workbook has two shapes that both fit: its `Import` sheet (`Date`, `Start Time`, `End Time`, `Venue`,
`Field`, `Home Team`, `Away Team`, `Division`, `Format`; 574 rows in the example, _executed_) and its `Schedule` sheet
(a game id first, then date, start, length in minutes, venue, field, division, format, home, away, notes). The format
and notes columns are dropped. A coach, an email, a phone or a free-text note is never read from a games file.

### 4.4 What is refused, what is accepted and flagged

Owner's rule: conflicts in the imported schedule are **accepted and flagged, not rejected**; AGENTS.md: never silently
drop an unplaceable fixture. So the closed lists are:

- **File refused** (nothing staged): missing a required column (`missing-column`, naming it); more than 2,400 rows
  (`too-many-rows`, the workbook's own limit; the Edge cap is 5,000).
- **Row listed with its reason and not written** (the rest of the file imports): `bad-date`, `bad-time`,
  `end-not-after-start`, `same-team`, `time-in-dst-gap` (the wall time does not exist that day), `outside-season-window`,
  `unknown-division`, `unknown-team`, `unknown-venue`, `unknown-field` (until the mapping resolves or creates them),
  `label-is-own-team` (an outside label equal to an own team's name in that division), `duplicate-row` (the same key
  twice: the first wins, the repeat is listed), `game-id-reused` (one Game ID on two different games).
- **Accepted and flagged** (stored; shown in the preview and, because the run's `results.warnings` carries them, in the
  Games page's existing `GameConflictBanner`): `field-overlap`, `coach-conflict` (per coach), `team-double-booked`,
  `home-away-imbalance` (all four are `evaluateGameSchedule`'s own warnings), `time-ambiguous` (a fall-back hour: the
  first occurrence, as `resolveZonedInstant` does), `week-differs` (4.8).
- **A row whose time or field is blank** (a malformed time is `bad-time`) becomes a TIME TBD game (`schedule_tbd`, `kind = 'game'`) with a new reason on the
  closed list, `imported-without-time` (the RPC's list, `scheduleTbd.js` and the master export's reason column each
  gain it; PR 5 task), so it appears on both teams' rows and is never dropped.
- **Coverage is stated, never implied** ("declared is not enforced", AGENTS.md section 3): the preview prints "Checked:
  team overlap, coach overlap, same-field overlap, hosting balance. Not checked: shared space, travel time between
  fields (finding 8). Coach overlap was judged only for the teams that have a coach assigned" (with the count). A schedule with no
  coaches assigned must not read as "0 coach clashes".

### 4.5 Teams, divisions, venues and fields must exist first: the mapping step

Finding 6 is the hard part. A game needs two teams (`NOT NULL`), a team needs a division (`NOT NULL`, `UNIQUE (division_id,
name)`), a slot needs a field. An organization that arrives with a schedule has none of them yet. The mapping step
offers, per distinct label, and only after the admin confirms the list:

| Label is...                            | Options                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Equal (normalised) to exactly one team | Mapped automatically; the admin can change it                                                                                                                                                                         |
| Equal to more than one, or none        | Pick an existing team; **create a team shell** (needs a division); **outside opponent** (4.6); skip its rows                                                                                                          |
| A division name that matches none      | Pick one; **create by name** through the existing `upsert_division_for_import`, with no age band, flagged "teaming cannot place players here until a band is set" (unknown is never read as in band, lesson 47); skip |
| A venue or field that matches none     | Pick one; **create by name** (a location and a field, no availability windows, flagged); skip                                                                                                                         |

A **team shell** is a `teams` row with a division and a name and no players or coach. They are created by calling the
existing audited writer, `persist_team_schedule`, **inside the apply's transaction**, once per import, so the shells
are recorded in a team run's `results.teams` and a later generation preserves them (finding 6: incremental teaming
reads the run, not the table; a shell inserted any other way would be invisible to it and a later generated team of
the same name would hit `UNIQUE (division_id, name)`). PR 5 starts by checking two things the Edge schema suggests
and nothing proves: that the RPC accepts a payload with teams and no `team_players`, and that a division holding only
empty shells re-runs into them (placement fills the shell under `preserve-existing`). If either fails, stop and report
the smallest input: one division, two empty shells, twenty players. Coaches are not in the file; the audit says how many
teams have none (4.4), and assignment stays on the Coaches page.

### 4.6 Outside-club opponents (F7)

| Option                          | How                                                                                                              | For                                                                                                                                                                                                                     | Against                                                                                                                                                                                                                      | Verdict          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **A. A flagged team row**       | `teams.is_external boolean NOT NULL DEFAULT false`; one row per (own team's division, label), named by the label | Both team ids stay `NOT NULL`; the 52 readers of a game's sides resolve a name as they do now; the evaluator knows the team (no `unknown-team` warning for expected visitors); the Published pin keeps their field time | Every list of teams must exclude them. 11 files read `teams` directly (_executed_, plus the team RPC reads); teaming lists, division and coach counts, per-team files, standings each need a decision. Needs a reader census | **Recommended**  |
| B. A nullable side plus a label | `away_team_id` nullable and `opponent_label text`                                                                | Teams lists untouched                                                                                                                                                                                                   | 52 files, `games_team_difference`, the unique index (nulls compare unequal), and every evaluator assume two teams. The widest blast radius                                                                                   | Not recommended  |
| C. A hold on the field only     | A field blackout for the window; no game                                                                         | Keeps the time free; `field_blackouts` exists                                                                                                                                                                           | The own team's schedule loses the fixture; no clash checks for it                                                                                                                                                            | Not enough alone |

The census (a PR 5 test, `tests/externalTeamReaders.test.js`) enumerates readers of `teams` **from the code**, never from
this plan, and requires each to be classified include or exclude; a new reader fails it until classified (the shape of
`practiceReaderCensus.test.js`). An external team never appears in a team run, so teaming never sees one. The visiting
labels' appearance in the example (31 labels, 39 games, all on the away side, one venue, six divisions; _executed_)
is why the flag is per (division, label): an outside club that plays several divisions is several rows.

**What the census must show (owner, 2026-11-06, decision 5).** Each reader is classified, and both sides are pinned by
tests. The number of readers is whatever the census finds; the 11 and 52 above are counts of 2026-11-03.

- **Exclude** (an `is_external` row never appears): team generation and empty-shell filling; the game generator's
  round-robin pairing; roster and balance counts; coach compliance and unassigned-coach warnings; practice demand in the
  PR 13 capacity panel; the practice solver, the readiness panel and the TIME TBD list (an external team in a 2-a-week
  division would read as "short of its count"); `view_org_metrics.total_teams` (latest definition `20261108010000:2118`);
  the Teams page, Team Builder, team exports and coach assignment; and `view_league_standings` (below).
- **Include, with a positive test each:** the Games page, the Day Sheet, the coach schedule, exports, field and slot
  occupancy, and own-team clash checks show the outside opponent's games.
- **Not applicable:** team-in-two-places checks do not apply to an external row. One row per division and club label
  merges several real teams, so two simultaneous games on it are legal.

**Standings, in two parts (decision 5).** (i) _Structural, needs no policy:_ an outside club never gets a standings
row. `view_league_standings` (latest definition `20261023010000:65`, statically reviewed) selects `FROM public.teams t`
with `LEFT JOIN game_results gr ON gr.team_id = t.id`, so an `is_external` row would appear there with 0 games played.
PR 5's census classifies the view, and a test requires that it excludes `is_external` rows. (ii) _Policy, deferred to
the F11 plan:_ whether an own team's result against an outside club counts toward its record is the owner's call. The
recommendation is **accepted**: excluded by default, optional, set at organization, program and division level (the most
specific wins; unset inherits; 6.2), and a per-fixture override later. It is implemented in the F11 plan, not in this
wave, because standings read the legacy `games` table, which no schedule save fills (finding 5). PR 5's census records
(ii) as "deferred to the F11 plan" and pins that no path feeds external-team results into standings today.

### 4.7 Apply, idempotency, Published arrival and rollback

`apply_game_import_job(job, dry_run)` runs in one transaction, in this order, and any failure undoes all of it:

1. Team shells (through `persist_team_schedule`, as 4.5 says), external teams (inserted by this function with
   `is_external` set, in **no** team run, audited with the import), then divisions, locations and fields as confirmed.
2. A game slot for each distinct `(field, date, start)` by find-or-create (new `ensure_game_slot`, modelled on the
   field import's lookup, `20261029010000:1008-1100`; the field import is **not** refactored, rule 2). Capacity 1; two
   games on one field and start share one slot, which is exactly a double-booking, stored and flagged.
3. A new `scheduler_runs` row (`run_type` game, `parameters.source = 'import'`, the job id, `results.warnings` and
   `results.unscheduled`), then the imported assignments upserted with `published` as chosen, `import_job_id` and
   `external_ref` set, **and every assignment of the previous latest completed game run of the season re-pointed to the
   new run** (`UPDATE run_id`, allowed by the guard), so the new run is the whole visible schedule (finding 3: the page
   shows one run). Without this, importing would hide every existing game.
4. One `import_application_records` row per insert or update (before and after images), and the audit rows:
   `import.completed` with `import_type = 'games'` and the counts, `game.published_set` with scope `import` when games
   arrive Published.

Idempotency: re-importing the same file inserts nothing and creates **no run** ("nothing to apply"). A changed row with
a `Game ID` updates in place; a changed row without one is a new game and the old one is listed as "in the schedule, not
in this file". The import never deletes: cancel is the only delete, and a Published game cannot be cancelled without
allowing changes.

`rollback_game_import_job(job)`: reverses the application records; refuses, naming up to 50 games, if any imported
game has been changed, cancelled or had changes allowed since (compared with the stored applied image); sets a
transaction-local `squadlogic.import_rollback = <job id>` that the Published guard honours **only** for rows whose
`import_job_id` is that job and which are unchanged; re-points carried rows to their previous run; removes created slots,
shells and external teams only when nothing else references them; audited `import.rolled_back` (existing action).

### 4.8 Time zone, week index, size

- **Clock.** File times are wall times on the **season's** clock (`season_settings.timezone`); with none, the import
  refuses with the Games page's existing "no clock" explanation (`describeUnplaceableSlots`). The Edge function converts
  with the Deno mirror of `timing/seasonClock.js` (`_shared/timing/seasonClock.ts`, held to the core by
  `seasonClock.vectors.json`, where the new named-date cases go): a fall-back hour resolves to its first occurrence
  (`time-ambiguous`), a spring-forward gap is `time-in-dst-gap`. The ISO instants are carried in `normalized_payload`
  and **SQL never recomputes them** (one implementation of the conversion, lesson 77); `game_slots` gets the wall
  reading and `start`/`"end"` the instants, as the Games page's `anchorToSeasonClock` composition expects. The new
  functions are pinned `SET timezone = 'UTC'` (`20261021040000`). Tests name zones and dates, as `seasonClock.test.js`
  does: a US spring-forward Sunday, a fall-back, a southern-hemisphere zone, a half-hour offset.
- **Week index.** Slots need a positive `week_index` (`indexSlots`, `gameScheduling.js:466`). From the `Week` column if
  given; else one plus the whole weeks since the Monday of the week the season starts, a pure function of the date, so a
  re-import agrees with itself; a date before the season window is `outside-season-window`; an existing slot on that date keeps
  its own week, and a difference is flagged `week-differs`, never renumbered. If the season has no start date the
  `Week` column is required (`missing-week`). Decision 17.
- **Size.** At most 2,400 rows per file. The browser sends chunks of at most 500 to the Edge function (a request gets 2 s
  of CPU, lesson 42); a PR 6 test times a 500-row chunk **with coverage on** (lesson 59). The 574-game example is far
  below every limit.

### 4.9 The placeholder fixture

`fixtures/schedule-2026/` (same family as `fixtures/demo-2026/`; PR 4), generated, never hand-written:

| File                      | Contents                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`               | The shape table below, how to regenerate, that the only inputs taken from the owner's workbook are the **counts** in that table |
| `schedule.csv`            | The documented format of 4.3, with a Game ID and a Week                                                                         |
| `teams.csv`, `venues.csv` | The league the schedule is over: own teams with division and placeholder coaches; venues and fields                             |
| `schedule-invalid.csv`    | About twenty rows, one per refusal reason of 4.4, so every reason is reached                                                    |

Shape targets (counts only, recomputed from the owner's example, section 11; every value in the fixture is invented):
about 574 games on 9 Saturdays, 7 venues, 26 fields, 20 divisions, 132 own teams (82 with a second coach, 1 with a
third, none with an email), 43 outside fixtures against 31 outside labels, and deliberate clashes. The exact numbers
are whatever the script produces; the README and the test pin the **produced** numbers and hold them near the targets.
Names: venues `Venue A` to `Venue G`, fields `Field 1`..., outside clubs `Visiting Club A`..., coaches
`CoachFirstN CoachLastN`, any email, if one appears, at `example.com` (the conventions `tests/demoFixture.test.js` and the real-name guard
already hold).

`scripts/build-schedule-fixture.mjs` (like `scripts/build-demo-seed.mjs`: pure, a seeded PRNG written in the script,
`--check` exits 1 when a checked-in file differs): builds the league; builds a 9-week slot grid; runs the product's own
`buildDivisionRoundRobins` and `scheduleGames`, so the file is what the generator produces; adds the outside fixtures;
then applies **named plants** to a copy, each a small function with a count: same-field overlaps, coach clashes (one
coach on two teams in overlapping games), a hosting imbalance, one row without a time. `tests/scheduleFixture.test.js`
pins: the counts above; every cell placeholder-shaped; the planted clashes **as reported by `evaluateGameSchedule`**
(not by the workbook, finding 9); a control that the same audit over the pre-plant schedule reports none (the check can
fail); that `--check` is clean; and that `schedule-invalid.csv` reaches every reason. The real-name guard scans it.

### 4.10 The lists to walk when a new import type joins the pipeline (lesson 73)

PR 5's first test enumerates these from the catalogue and the code, and fails until each has `games`: the
`import_jobs.job_type` CHECK; `staging_import_rows.import_type` CHECK; `import_application_records.import_type` and
`target_table` CHECKs (the `target_table` list already holds `locations`, `fields`, `field_subunits`, `practice_slots`
and `game_slots`, `20260522120000:19-24`; it gains `game_assignments`, `teams` and `divisions`, and the `import_type`
list, today `coaches`, `fields`, `field_availability`, gains `games`; amended 2026-11-06); `create_import_job`'s type list; the deferred-apply status pair; the allowlist's copies (`importAllowlist.js`,
`_shared/import-allowlist.ts`, `import_allowed_keys`, `ALLOWLIST_ENTITY_TYPES`); the Edge `import_type` enum,
`REQUIRED_FIELDS` and the sensitive-type list; the demo fence's census of writers; `fail_stale_import_jobs`; the Import
panel's tab list and telemetry; the mock finalizer; and the harness plants (re-aimed at any body the migration
replaces, lesson 70).

### 4.11 A second import kind: the practice schedule (F13, with F17's mapping; added 2026-11-06)

An organization that already has a practice schedule should be able to bring it in, as one that has a game schedule
can (this section's parent, section 4). This is a **second import kind on the same machinery** (job lifecycle,
staging, application records, rollback, the mapping step, team shells, the placeholder-fixture approach: PR 4 to 6),
not a second pipeline. Read 2.1 first. The practice side differs from games in four ways that shape everything below:
readers are keyed on the season, so no run needs re-pointing (finding 12); the writer's lock is by default, so there is
no new Published concept (finding 2); the stored rows are weekdays and wall times, so there is no instant to convert
(4.11.6); and the supply side, practice slots, is already importable by the fields CSV.

#### 4.11.1 What the owner's practice workbook is (counts only; _executed_ 2026-11-06, R12 to R16)

A weekly grid: field halves and sides down the side, Monday to Friday across the top (each weekday one header merged
over three columns), a team in each used cell. Two blocks: a 45-minute block (16 labelled field rows; starts 16:00,
16:45, 17:30; time headers on two of the five weekdays only) and a 60-minute block (42 labelled rows; starts 16:00,
17:00, 18:00 on all five weekdays). 726 timed cells hold 236 non-empty ones: 235 team placements (37 and 198) and one
non-team activity. 132 distinct teams: 103 with two practices a week and 29 with one. Of the 103, 98 are on two
different weekdays (Tue+Thu 49, Mon+Wed 38, Wed+Fri 8, Mon+Thu 3) and 5 hold both placements at one weekday and start
(a team in two places at once); 83 of the 98 use the same field and start on both days. No cell is used twice. 49 of the
58 labelled field rows are used, over about 8 venues (a prefix reading of free-text labels: an estimate); 217 of the 235
placements are on a half or side; 20 are merged over two rows of one field. There is no division column. 14 tabs, 3
visible and 11 hidden, among them a field alias table (21 rows), a per-division planning summary, older versions, a
holiday-week copy, and a by-team list with the coaches (219 named coaches, 19 on two or more teams, one of those on two
teams at the same start; all 132 grid teams are on it). A coach-choice legend, a "do not change, published" note and
equipment tracking were reported by the coordinator's scripted read and **were not re-run**.

#### 4.11.2 The file: one flat CSV (decision 21)

| Column                      | Required           | Accepted                                                                                    | Stored as                                |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Team`                      | no                 | A label; blank is an **open slot** (supply, no team). Normalised as in 4.5, no word dropped | `team_id`, mapped (4.11.5)               |
| `Division`                  | when `Team` is set | A division name of the season; never derived from a team name                               | The team's division; the count rule      |
| `Day`                       | yes                | `Mon` to `Sun` or the full name, any case                                                   | `practice_slots.day_of_week`             |
| `Start`                     | yes                | `HH:mm` or `h:mm AM/PM`                                                                     | `start_time` (a wall time, no zone)      |
| `End` or `Length`           | one of the two     | A time, or minutes                                                                          | `end_time`                               |
| `Location`, `Field`         | yes                | Names (`Venue` accepted for `Location`), mapped (4.11.5)                                    | `locations`, `fields`                    |
| `Subunit`                   | no                 | A half or side label (`Half`, `Side` accepted); blank is the whole field                    | `field_subunits`                         |
| `Valid From`, `Valid Until` | no                 | `YYYY-MM-DD` or `M/D/YYYY`; else the confirm step's two dates (4.11.6)                      | Slot validity and the assignment's range |
| `Capacity`                  | no                 | An integer from 1; default 1                                                                | `practice_slots.capacity`                |
| `Use`                       | no                 | Blank, or `hold`: a cell held for a non-team activity (a closed value, never free text)     | Nothing: counted and listed (4.11.3)     |
| anything else               | no                 | **Dropped before staging and never stored** (the allowlist; data minimisation)              | nowhere                                  |

The names are the fields CSV's own (`Location`, `Field`, `Subunit`, `Day`, `Start`, `End`, `Capacity`, `Valid From`,
`Valid Until`; the header of `fixtures/demo-2026/fields.csv`), so one vocabulary serves both files; PR 9 checks that the
Edge function's header alias map takes the aliases above. A coach, an email, a phone or a free-text note is never read.
One word means two things: `Division` in the fields CSV **reserves a slot** for a division (`20261029010000`, section
5), and here it names **the team's division**. This import never writes a reservation (an admin sets those on Field
Management), and its template and README say so beside the column.

**Why a flat file, not the grid** (the measured reasons are finding 14): the grid is a parser of one layout. Its
weekday lives in a merged header, its time header differs by block, 20 of 235 team cells span two rows, marker and
blank rows are data, and stray whitespace is in the names; a reader that takes each merged range's top-left cell loses
the second half of 20 placements without a word, and it breaks silently when the owner rearranges the sheet. A flat row
is one fact in its own columns and fails with its own reason. The cost is a conversion step (one row per timed cell, 726
in the example, under the 2,400 cap of 4.8): a pivot or a formula in the owner's own spreadsheet. **Unknown:** whether
the owner's spreadsheet can emit it in one step (not tried; what resolves it: the owner tries the fixture's shape).
Reading the grid itself needs `.xlsx` (a new dependency, decision 8) and a layout parser; not recommended now.

#### 4.11.3 How rows become slots and assignments

- **A slot** is found by the fields import's own key, `(location, field, subunit or the whole field, weekday, start,
valid from)` (the lookup, insert and update at `20261029010000:892-1009`, copied into `ensure_practice_slot`, not
  extracted: rule 2), or made, only on the confirm list (decision 22). **A slot that exists is found, never modified**
  (its capacity, dates and reservation stay). One that exists with other dates for the same surface, weekday and time is
  a clash by the supply rule below: the row is listed `slot-overlaps-another` naming it, and the admin sets the confirm
  step's dates to match or fixes the slot on Field Management. **Unknown:** how often a league's existing slots carry
  dates other than its season's; what resolves it: the owner's fields file.
- **Every timed row is a slot, used or not**: the example has 726 timed cells for 235 placements. The 491 open ones are
  the capacity the next run fills; without them the 29 one-practice teams have nowhere to go and the run answers
  `no-slot-available`. A row with a blank `Team` makes a slot and no assignment.
- **A new slot is judged by the supply rule the fields CSV already enforces**, `practice_slot_conflicts`: same surface,
  same weekday, overlapping dates and times, a whole field against each of its halves, back-to-back allowed (turnover
  0). A clash is **not written** and the row is listed `slot-overlaps-another`; it is not accept-and-flag, because it
  is two slots claiming one ground, not a judgement about a team.
- **A team on both halves of one field at one time** is two rows, two half slots and one team in two places: flagged
  `team-on-both-halves` with the hint "leave Subunit blank for the whole field". Nothing is merged on the admin's behalf
  (nothing guessed); the owner's 20 merged cells become 20 whole-field rows in the converted file.
- **A non-team cell** (`Use = hold`): no slot, no assignment; counted and listed (F15, 5.8, decision 28). If an open slot
  already exists at that cell it is flagged `hold-over-open-slot`.
- **An assignment** is `(team, slot, range)`, the table's unique key
  (`practice_assignments_team_practice_slot_range_unique`, `20260503010000:5`).

#### 4.11.4 Writing it: an additive writer, accept and flag (decisions 20, 23, 24)

Owner's rule, as for games (4.4): conflicts in the imported schedule are **accepted and flagged, not rejected**, and an
unplaceable row is never silently dropped (AGENTS.md section 3). The existing writer cannot do that (finding 12), and
changing it would mean replacing `persist_practice_schedule` whole (a migration; lesson 70 moves its plants) for a
mode only an import wants. So the import has an **additive writer of its own** and the existing writer and its gate are
not touched. The migration adds the new functions and the lists of 4.11.8; it does not change a column of
`practice_assignments`.

`apply_practice_import_job(job, dry_run)` (SECURITY DEFINER, `SET search_path = public`, `SET timezone = 'UTC'`, revoked
from `PUBLIC` and `anon`). Gates, in order, each a test: a signed-in caller (the audit needs an actor); `is_org_admin`;
the job's season is the organization's active season (draft or completed refuses 22023; the completed-season trigger,
`20261111010000:641`, is the backstop); the mapping is stored and complete. Then it takes the **writer's own season
lock**, `pg_advisory_xact_lock(hashtextextended('persist_practice_schedule:' || org || ':' || season, 0))`
(`20261108020000:722-724`; the TIME TBD refresh uses the same key, `:380-383`), so an import and a save cannot interleave
(lesson 72), and in one transaction:

1. team shells (through `persist_team_schedule`, as 4.5), divisions, locations, fields and subunits, as confirmed;
2. slots, by `ensure_practice_slot` (internal; no client role may execute it, as `practice_slot_conflicts`);
3. assignments: `INSERT ... ON CONFLICT (team_id, practice_slot_id, effective_date_range) DO NOTHING` with
   `source = 'manual'`, `assigned_via = 'manual'` and `run_id` NULL. It **never updates or deletes a saved row**, so
   the writer's lock-by-default cannot be bypassed by it. No `scheduler_runs` row is made: the readiness panel and the
   dashboard read the latest practice run (`usePracticeSummary.js` through `useSchedulerRun('practice', ...)`), and an
   import's row would replace a solver run's results there;
4. one `import_application_records` row per insert (the before and after images), for rollback;
5. the **flags**, read by SQL from the rows the file names (inserted now or already there, so a re-import reports the
   same flags): the five gate rules by calling `practice_new_auto_row_refusals(org, ids)` read-only (it judges rows of
   any source, 2.1); plus the checks the gate does not have: `coach-conflict` (a coach of two teams in overlapping slots
   on one weekday on shared dates, through `team_coach_assignments`, per coach), `team-on-both-halves` and
   `hold-over-open-slot`;
6. `refresh_schedule_tbd_practices(season)` (finding 15): teams short of their division's count join the TIME TBD list;
7. the audit: `import.completed` (existing action) with `import_type = 'practice_schedule'`, the counts and the flags
   by rule; `schedule_tbd.refreshed` comes from the refresh; no new audit action.

**The preview is the dry run**: steps 1 to 7 run in a sub-block that ends in a sentinel exception after the counts and
the flag list are copied into variables, so every write rolls back and the function returns them. The preview, the
apply and the gate therefore cannot disagree. This is lesson 74's aim in a different form (the flags read the rows an
apply inserts, which a single "writes off" statement cannot), and it needs no browser twin (lesson 77) for the
SQL-checkable rules. PR 10's first test reads every table back to the last column after a dry run and requires them
byte-equal, and requires dry-run counts equal to apply counts over one file that reaches every outcome (each count
non-zero first). If the sentinel form cannot carry the flag list, stop and report with the smallest input (one team,
two slots, both `manual`). Cost: the dry run takes the season lock and does the writes (at most 2,400 rows); PR 10 times
it with coverage on (lesson 59).

**Closed lists.**

- **File refused** (nothing staged): a missing required column (`missing-column`, naming it); more than 2,400 rows
  (`too-many-rows`).
- **Row listed with its reason and not written** (the rest imports): `bad-day`, `bad-time`, `bad-length`,
  `end-not-after-start`, `bad-date`, `valid-until-before-from`, `outside-season-window`, `missing-dates` (no dates in
  the row and none on the season), `capacity-not-positive`, `unknown-division`, `unknown-team`, `unknown-location`,
  `unknown-field`, `unknown-subunit` (until the mapping resolves or creates them), `team-in-two-divisions` (one label,
  two divisions in the file), `slot-overlaps-another`, `duplicate-row` (the first wins, the repeat is listed).
- **Accepted and flagged** (written, shown in the preview and the result, audited): `capacity` (more teams in a cell than
  its capacity), `reservation` (the slot is reserved to another division), `length` (the division's practice length is
  not the slot's), `weekday` (a team twice on one weekday on shared dates: the example's 5 double-placed teams are this),
  `count` (more practices in a scheduling week than the division's count), `coach-conflict`, `team-on-both-halves`,
  `hold-over-open-slot`, and, once PR 12 exists, `pairing-differs`.
- **Not a flag but a list**: a team holding fewer rows than its division's count is on the TIME TBD list
  (`missing_count`): the example's 29. The next run fills them (finding 15).
- **Also a list, on a re-import: probable moves** (owner, 2026-11-06, decision 24). A team's rows "in the schedule, not
  in this file" are paired with its rows "new in this file" and shown as a probable move; the rule is in 4.11.6.
- **Coverage is stated, never implied**: "Checked: slot capacity, division reservation, division practice length, one
  practice per weekday, practices per week, coach overlap at the same weekday and time. Not checked: coach preference
  rules (the Preferences page, Conflicts tab), daylight and sunset (the Practice daylight page; venues this import
  creates have no coordinates, finding 18), field closures and permits, travel or turnover between fields. Coach overlap
  was judged only for the N teams that have a coach assigned."

**After the import, a normal save.** Imported rows are `manual`: a team absent from a later save's payload keeps them
(`retained_manual`, `20261108020000:1306-1322`); for a team in the payload, a key the payload omits needs `unlock` and a
reason, like any saved row. The import changes `practice_schedule_fingerprint` (it hashes every row's id, team, slot,
range, `source` and `assigned_via`, `20260929000000:179-205`), so a plan read before the import gets 40001
`PRACTICE_SCHEDULE_STALE` and reloads
(`PracticeSchedulingPage.jsx:1511`). PR 10 proves "a save after an import moves nothing" (K2).

#### 4.11.5 Mapping and what the import may create (decisions 22, 26, 30)

The same mapping step as 4.5, for teams, divisions, locations, fields, and subunits. A label equal (normalised) to
exactly one existing thing maps automatically; otherwise the admin picks one, **creates** it (on the confirm list
only), or skips its rows. A team shell needs the `Division` of its rows. A division that matches none can be created by
name through `upsert_division_for_import` with no age band, flagged. A location or field is created without
coordinates and with unknown lighting, which reads unlit: every practice there reads sunset-unknown until the admin
enters coordinates (finding 18); the confirm list says so. For a created subunit PR 10 copies what
`finalize_field_import_job` does for a subunit row (the `Supports Halves` flag), and reads it first.

**Proposals, in this order, none applied without the admin (F17):** (1) the exact normalised label; (2) an optional
**alias file** (columns `Alias`, `Location`, `Field`, `Subunit` (the last optional); read in the browser and never
uploaded or stored); (3) the mapping stored on the **previous completed import of this kind** (it is on the job, so no
new table). Where two proposals disagree both are shown and none is chosen. A stored mapping entry carries `source`
(`exact`, `alias`, `previous`, `admin`) so the audit can say how each label was resolved. The alias module is pure core
(PR 9) and the games import (PR 6) can call it; it is a different thing from the Edge function's `HEADER_ALIASES`,
which aliases column headers. The owner's own alias tab could not be tied to the grid (finding 17); the file format
above is a proposal until the owner says what its columns mean.

**Division practice settings from the file (decision 26).** For each division in the file the mapping step proposes
`practices_per_week` (the most common count of rows per team; a tie proposes nothing) and `practice_minutes` (the slot
length when every placement of the division has one length, else "any"), beside the stored values. A proposal is applied
only for a ticked division, through the existing audited `admin_upsert_division_settings` (the 13-argument form,
`20261105010000:1459`), never silently. A division at one a week with no length is the column default and cannot be told
from "unset" (`20261105010000`, section 2), so the screen shows the stored value and asks. If the settings are left
alone, a team holding more rows than its division's count is reported `overTarget` and kept (finding 15).

#### 4.11.6 Locked on arrival, a re-import, rollback, dates and time (decisions 23 to 25)

- **Locked.** Every saved practice is locked by default (finding 2, 2.1), so "arrive locked" is not a switch and needs no
  new concept; a practice moves only through the writer's `unlock` prompt, with a reason and an audit row. The real
  choice is provenance: `manual` (recommended: the admin's own schedule; kept for a team absent from a save) or `auto`
  (a later save could prune it for an absent team, with an unlock).
- **A re-import** is additive: the unique key makes an unchanged row a no-op (`unchanged` counted, no new run, nothing
  audited beyond `import.completed` with zero inserts). A team the new file puts in another cell gets a new row; the old
  one is listed "in the schedule, not in this file" and **never deleted by an import**: it is removed on the Practices
  page with the unlock prompt, as today (decision 24). Existing saved rows, whoever wrote them, are never changed.
  **Probable moves (owner, 2026-11-06).** The preview pairs the rows "in the schedule, not in this file" with the rows
  "new in this file" **at team level**, not row to row: "team X: N rows leaving, N arriving", so a swap of two days never
  produces an ambiguous 1:1 pairing. The new rows of a probable move arrive **unticked** by default (the admin ticks to
  add), so a move does not silently leave a team over its count; the leaving rows stay, because an import never
  deletes. The pairing is a **pure function in PR 9's core** over the two lists the dry run returns (task J2,
  `tests/practiceImportProbableMoves.test.js`, with the swap case and the unticked default). How an unticked row reaches
  `apply_practice_import_job` is **PR 10's first design task**; this plan fixes the behaviour and no signature.
  Over-counts are still flagged under decision 20.
- **Rollback**, `rollback_practice_import_job(job)`: reverses the application records; refuses, naming up to 50 rows, if
  any imported assignment was changed since (its slot, range, source or `assigned_via` differs from the applied image), has an
  exception row (`practice_exceptions` restricts the delete), or the season has completed; removes the slots,
  fields, subunits, locations and shells it created only when nothing else references them; audited `import.rolled_back`
  (existing); refreshes the TIME TBD list. It is a writer, so it joins the census (4.11.8).
- **Dates.** A row's `Valid From`/`Valid Until` else the confirm step's two dates, defaulting to the season's
  (`season_settings.season_start` and `season_end`, both nullable); when neither exists the dates are required
  (`missing-dates`). A date outside the season is `outside-season-window`. The range is stored as the writer stores it:
  PR 10's first test writes one row through the writer and one through the import for the same dates and requires the
  same canonical `daterange` text, so no inclusive-or-exclusive guess is made here.
- **Time and weekday.** A practice row holds a weekday and `time` columns (no zone) and a date range; the import converts
  no instant, so there is no season-clock conversion, no daylight-saving case, and nothing SQL recomputes (lesson 77).
  PR 11's parse test runs under two other host zones (`TZ`) to prove the host zone is not read. Sunset is judged
  afterwards, on the season's clock, by the existing daylight code, and is a coverage line above, not a check here.

#### 4.11.7 The placeholder fixture (PR 9)

`fixtures/practice-schedule-2026/` (the family of `fixtures/demo-2026/`), generated by
`scripts/build-practice-fixture.mjs` (pure; a seeded PRNG written in the script; `--check` exits 1 when a checked-in
file differs; like `scripts/build-demo-seed.mjs`). It builds a **grid-shaped** file, not a solver output (the product's
solver has no pairing yet, 5.7, so it could not produce the example's same-slot pattern): `README.md` (the shape table,
how to regenerate, that the only inputs taken from the owner's workbook are **counts**), `practice-schedule.csv` (the
format of 4.11.2), `aliases.csv` and `practice-invalid.csv` (about twenty rows, one per refusal reason).

Shape targets (counts only, from 4.11.1; every value invented): about 235 placements (about 37 at 45 minutes and 198 at
60), about 726 timed rows including the open ones, 132 teams (103 with two practices a week and 29 with one), about 58
field rows of which about 49 used, over 8 venues, about 20 whole-field placements, day patterns Tue+Thu about 49,
Mon+Wed about 38, Wed+Fri about 8, Mon+Thu about 3, and about 83 teams on one field and start both days. Names are
placeholders in the demo fixture's conventions: venues `Venue A` to `Venue H`, fields `Field 1`..., subunits `A` and
`B`, team labels like `U10B-01`, coaches `CoachFirstN CoachLastN`, any email at `example.com`.

**Named plants**, each a small function with a count, applied to a copy: double-placed teams (5, the example's count), a
division set to two a week holding one-practice teams (29 by shape), a coach on two teams at one start (1), team labels
with trailing whitespace (2), a team on two halves at one time (1), two teams in a capacity-1 cell (1), a slot that
overlaps another (1), a non-team `hold` row (1). The exact numbers are whatever the script produces; the README and the
test pin the **produced** ones and hold them near the targets. `tests/practiceScheduleFixture.test.js` counts every
plant **independently from the CSV** (a group-by in the test, not the product), requires the pre-plant copy to count
none (the check can fail), requires `--check` clean, and requires `practice-invalid.csv` to reach every reason. PR 10's
pgTAP then requires the product's flags for the same file to equal those counts. The real-name guard scans the files.

#### 4.11.8 The lists to walk (lesson 73), for `practice_schedule`

4.10's list, with the practice type: the `import_jobs.job_type` and `staging_import_rows.import_type` CHECKs;
`import_application_records.import_type` (gains `practice_schedule`) and `target_table` (gains `practice_assignments`,
and `teams` and `divisions` if PR 5 has not added them); `create_import_job`'s type list; the deferred-apply status
pair; the allowlist's copies; the Edge `import_type` enum (`import-validation/index.ts:524-531`), `REQUIRED_FIELDS`
(`:56`) and the sensitive-type list; the demo fence's census of writers; `fail_stale_import_jobs`; the Import panel's tab
list and telemetry; the mock finalizer; the harness plants. And the practice side's own: **`tests/practiceReaderCensus.test.js`**
(it enumerates every SQL function whose latest body names `practice_assignments`, so the apply and the rollback fail it
until classified `writer`); the completed-season case (a pgTAP case: a completed season refuses the import and its
rollback); the fingerprint case (above). PR 10's first test enumerates these from the catalogue and the code.

## 5. Design C: the smaller findings

### 5.1 F2 Day Sheet and F3 Coach schedule (PR 7; no schema; admin-only)

Both are read-only views and files over the saved schedule (`game_assignments`, the master export's own source), never
a team or coach page. **Day Sheet**: a date and an optional venue on the Exports page; columns date, kickoff, ends,
venue, field, division, home, away, status (the shape of the workbook's own sheet, header labels read, _executed_);
TIME TBD games listed apart; CSV. **Coach schedule**: one coach's games across all their teams (head and assistant,
`listTeamCoachIds`), one file, the columns of the team export plus the team and a coach-clash column from
`evaluateGameSchedule`'s per-coach warnings; the coach's name, never an email or phone (data minimisation; the master
export's `Coach Emails` column stays where it is). Tests: counts equal the master export's rows for the same filter;
a coach who coaches two teams in overlapping games is flagged; a game with a TIME TBD slot appears with its reason.

**Added 2026-11-06 (F17; task G2b, decision 31).** The coach schedule also lists the coach's **practices**: the rows of
`practice_assignments` for the coach's teams (through `team_coach_assignments`), day, time, field and date range. They
exist today for any league, whether or not it imports. A coach on **two or more teams is marked from the team list**,
not from the stored `can_coach_multiple_teams` flag that the Coaches page shows as `multi` (`CoachesPage.jsx:131, 570`);
in the second workbook 19 of 219 named coaches are on two or more teams and one of them is in two places at one start
(_executed_, R12). The clash column covers practices by the same rule as the import's `coach-conflict` flag (4.11.4):
two of one coach's practices on one weekday at overlapping times on shared dates. A practice is never compared with a
game (a weekly series against a dated event: stated, not checked). Admin only; names, never contacts. Tests: a coach on
two teams lists both teams' practices; the marker follows the number of distinct teams, not the stored flag (a coach
flagged `multi` with one team is not marked; an unflagged coach with two is); a same-weekday, same-time pair is flagged
and a different-weekday pair is not.

### 5.2 F1 Duty roster (build later)

The workbook lists, per field and day, a set-up duty (arrive by the first kickoff minus an offset) and a take-down duty
(after the last game), each with a responsible home team and an assisting away team. How it picks the teams was not
read. Recommendation: later, as a **derived list only** (field, day, first kickoff, offset, last end, the teams on the
field that day), with no assignment, because who sets up fields is a league's own custom and a wrong automatic
roster is worse than none. If the owner wants assignment (decision 9), the rule to build and test is **fairness first**:
every team within one duty of every other over the season, roles alternating between teams, a team never given a duty
on a field it is not playing on that day, ties broken by team id so the roster is deterministic. Admin export only.

### 5.3 F4 Early/Late preference (do not build in the solver)

Generation refuses a coach overlap (hard) and records an unplaceable game as TIME TBD with a reason; the preference's
job in the workbook is to steer a draft away from clashes it would otherwise create. A soft tie-break in `scheduleGames`
is a solver change (rule 14), a stored value (a column or a rules table), a UI and a re-tune of the goldens, for a
benefit generation already delivers harder. If the owner still wants it (decision 10), the cheaper form is **a flag**:
a per-team Early/Late tag shown on the Day Sheet and in the coach-clash column, so an admin sees the pairing. Practices
already have the richer mechanism (`practice/coachPreferences.js`) should the solver option ever be chosen.

### 5.4 F5 Platform-shaped exports: what is verifiable (current as of 2026-11-03)

Fetched 2026-11-03 from each platform's own help center. Anything not stated on the page is **unknown** and must not be
invented; neither platform's downloadable template file was read.

| Platform | Source and its date                                                                                                                                                                                  | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Unknown                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GotSport | `support.gotsport.com/how-to-import-a-schedule` (no page date; the footer says 2026). Imports a schedule into an **event**                                                                           | Named columns: `Match Number` (optional), `Round` (rounds must already exist in the event), `Date` (`MM/DD/YYYY` or `YYYY/MM/DD`), `Start Time`, `End Time`, `Venue` and `Pitch` (each must exactly match the organization's venue and field names), `Venue State`, `Home Club`, `Away Club`, `Home Team`, `Away Team`, `Age, Gender, Division` (marked required), `Bracket`, `Host`, `Home Club ID`, `Home Team ID` (optional, to register existing clubs and teams). File: CSV or "UTF-16 Unicode Text (.txt)". The template comes from "Export Master Schedule"                                                                                                                               | Time format; row or size limits; which other columns are mandatory; duplicate-match rules; how `Age, Gender, Division` is split from a name like "U10 Boys" |
| TeamSnap | `helpme.teamsnap.com/article/1292-import-schedules` (updated 2024-01-03); `.../1048-troubleshooting-schedule-imports` (updated 2025-05-27); `.../1839-importing-team-schedules` (updated 2026-03-09) | Organization-level and team-level imports use **different, non-interchangeable CSV templates**. Headings must match the template exactly; columns cannot be added. Optional columns: `End Time`, `Away Team` (games only), `Event Type`, `Location Details`, `Arrival Time`, `Short Label`; all others required. `Home Team`, `Away Team` and `Division` are named. Date `MM/DD/YYYY`; time `HH:MM AM/PM`; arrival time in minutes before the start. Names of teams, opponents and locations are case-sensitive and must already exist: an organization-level import **cannot create** teams, divisions, opponents or locations. Games and events go in separate files; no blank rows or columns | The template's exact header row (a downloadable file); row limits; the time zone applied                                                                    |

The owner's workbook `Import` sheet (nine columns, 12-hour times) is described by the owner as "copy into TeamSnap /
GotSport"; whether its header row equals either template is **unverified**. Recommendation (decision 7): build now
SquadLogic's own schedule CSV, the format of 4.3 (so a file exported here imports here: the round trip is also the
idempotency test of PR 6, task G3); build the TeamSnap shape later, when the owner supplies the downloaded current organization
template, as a mapper over the same rows (S, no schema); build the GotSport shape only if asked, because it needs
event rounds, a venue state and an age/gender/division split nothing here stores (M).

### 5.5 F6 Add one game by hand (PR 8)

A dialog from the Games page: division, home and away team (outside opponents allowed, 4.6), then an **open slot**
(the "Move to" list already offers only empty cells) or "a new time" (field, date, start, end). It stages a `manual`
assignment into the existing review, and **Apply** saves it through `persist_game_schedule` like a move, so the grid,
the conflict banner and the audit (`game.saved`) are unchanged. A new time needs a slot, and a slot is a database row
before the save can name it: on Apply the page first calls `ensure_game_slot` (PR 5 makes it an admin RPC, audited
`game.slot_created` when it really creates one; the import calls it internally without the per-slot audit), then
saves. If the save fails the slot stays, unused and harmless, and the result says so. The game starts unpublished. No
new column and no migration in PR 8. Tests: the staged game appears, a double booking is flagged not blocked, a
Published game cannot be added over, the keyboard path exists, a failed save names the slot it left.

### 5.6 F8 "Changes since publication" (PR 7; a view, not a store)

Originally = the chosen baseline's row for the game (immutable); now = the saved schedule; why = the audit rows of
`get_schedule_audit_log` for the game (`game.publish_overridden` with its reason, `game.saved`, `game.cancelled`).
Rows are enumerated from baseline rows **and** saved rows together, never from the changed ones, so a cancelled game
(which has no "now") is listed (the lesson `buildChangeNotices` states for teams). An import can optionally record
itself as baseline "as imported" so "since import" works from day one (decision 15; task G5, built in PR 6 beside the importer). `buildChangeNotices` stays
unwired: it writes to families, whom this product never contacts.

### 5.7 F14 Paired days, same slot (PR 12; the practice solver, rule 14; added 2026-11-06)

**The need, and what exists.** In the second workbook 98 teams practise on two different weekdays (Tue+Thu 49, Mon+Wed
38, Wed+Fri 8, Mon+Thu 3), and 83 of those 98 use the same field and the same start on both days (_executed_, R12).
SquadLogic enforces the floor under that: each of a team's practices on a different weekday, a hard rule beside
capacity and coaches (`supabase/functions/_shared/engines/practice-coaches.ts:277-345`, rule 4 of its list; the writer's
`weekday` rule, `20261105010000:192`). It has no convention for **which** weekdays or for repeating the slot (R20: no
match for pairing or same-slot in the solver, its engines or `practice/`; control: the weekday rule matches in the same
roots). A coach rule can ask for a weekday, a start or a venue, one team at a time (`coachPreferences.js`, `keepVenue` at
`:130`): a request, not a division's convention.

**The setting (optional, off by default; the division value first, scope below).** `divisions.practice_pairs text[] NOT NULL DEFAULT '{}'`,
elements from `mon-wed`, `tue-thu`, `wed-fri` (a CHECK), and
`CHECK (cardinality(practice_pairs) = 0 OR practices_per_week = 2)`. Empty is today's behaviour exactly.
`admin_upsert_division_settings` gains `p_practice_pairs` (NULL keeps, `'{}'` clears) by dropping the 13-argument
signature by its exact name and arguments and creating the 14-argument one, as `20261105010000:1457-1459` did (a
trailing defaulted argument, so a cached browser still resolves); changing `practices_per_week` away from 2 while pairs
are set is 23514 and names the setting. The control sits beside the practice settings on the Teams page. Mon+Thu (3 of
the example's 98) is not offered: it stays hand-placed or imported. A variant, "the same slot on any two weekdays", is
is one boolean and covers it; not recommended, because it allows back-to-back days.

**Scope (owner principle, 2026-11-06; 6.2).** The setting is optional at organization, program and division level: an
unset level inherits from the level above, and the most specific wins. What is built: the division value (above) now;
program and organization defaults through **one resolver, built with its first user and sized in PR 12's first task**.
`programs` exists (migration `20261101020000`: `divisions.program_id`, one program per division, a program spans
divisions) but has **no settings columns today**, so program-level storage is a migration. **This widens PR 12:** its
first task, M0, sizes the resolver and the program-level storage before M1 is written (section 7), and if the storage
cannot be carried by PR 12's one migration that is a change to this plan and goes to the owner (rule 14).

**What the solver does.** For a division with pairs set, a team's two practices are placed as one **twin pair**: a slot
S1 on weekday d1 and S2 on its partner d2 with identical location, field, subunit, start and end, both live over a
shared span and both admissible under every existing hard rule (reservation, length, capacity, coach overlap, a coach
`must`). Both rows are placed or neither. With no pair, both units are unplaced with the existing reason
`no-slot-available` and a run finding that says "no paired slot": no new reason, so no change to the TIME TBD reason
CHECK (`20261108020000:123-125`). A team that already holds one row (an import, an earlier run) has its second unit
restricted to that row's twin on a partner weekday, and is unplaced the same way if there is none; the held row is never
moved (maximum freeze), and a held row outside every allowed pair is reported, not changed.

**Interactions (each a test).**

| With                             | Behaviour                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `practices_per_week`             | Pairing needs exactly 2; the settings RPC and a CHECK refuse otherwise                                                                                                                                                                                                                                                                  |
| `practice_minutes`               | A twin has the same start and end, so the same length; the length rule still applies to the first slot                                                                                                                                                                                                                                  |
| Slot reservations (D2)           | Both slots must be open to the division: a division with reserved slots uses only those, so the twin of a reserved slot must be reserved to it too                                                                                                                                                                                      |
| Coach preference rules           | Each practice of the pair is judged by the existing judge; a `must` set of weekdays that no allowed pair satisfies leaves no candidate (`coach-preference`); the clash with pairing is a run finding beside `PRACTICE_COACH_PREFERENCE_CONFLICT`                                                                                        |
| Daylight and sunset              | Each occurrence is judged as today, flagged and never blocked (lesson 47); the same start on two weekdays needs no special case                                                                                                                                                                                                         |
| Repair (`practice/repair.js`)    | Re-homes one series at a time, unchanged; a re-home that breaks a pair is flagged `pairing-broken` on its row (a compromise finding, never a refusal)                                                                                                                                                                                   |
| The writer gate                  | A new rule `pairing` in `practice_new_auto_row_refusals`: a new auto row whose team holds another live row on shared dates must sit at the identical surface, start and end on a partner weekday; the first row of a pair is never refused. The function is replaced whole (lesson 70); manual, repair and override rows are not judged |
| The browser run check (`verify`) | Gains the rule `pairing`; `tests/practiceUnplacedReasons.test.js` (the three spellings) is extended in both directions                                                                                                                                                                                                                  |
| Imports                          | Accepted and flagged `pairing-differs` once this exists (4.11.4); never refused                                                                                                                                                                                                                                                         |
| TIME TBD                         | Unchanged: a team short of its count is listed as today                                                                                                                                                                                                                                                                                 |

**Rule 14, and the proof of "nothing changes".** The solver exists twice (core `schedulePractices` and the Edge solver),
and a test holds them equal (the shape of `tests/coachPreferenceDrift.test.js`); a pairing product extends it. With
`practice_pairs` empty, both solvers' output over the season fixture and the demo league is byte-identical to the base's:
a `sha256` taken before any change, as lesson 46 did for one a week. A new golden covers a paired division on PR 9's
fixture, which also shows the solver can reproduce the owner's pattern. Effort **L** (a migration, two solver twins, a
gate rule, a settings RPC, a Teams control, a drift test, goldens, plus the resolver and program-level storage that M0
sizes). Recommendation, accepted 2026-11-06: **later** (decision 27): the import
with gap-fill already brings the owner's real pattern in, and pairing only improves what a new season generates, at the
cost of a migration, two twins and a golden re-tune; waiting hurts no league.

### 5.8 F15 A labelled, recurring hold for a non-team activity (PR 14 HELD by the owner, 2026-11-06; added 2026-11-06)

The workbook has one cell holding a non-team activity (a clinic) in a weekly slot. **What exists, verified:**

| Candidate               | What it is                                                                                                                                         | Why it is not the answer                                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `field_blackouts`       | Admin closures by date range, for a location or one field, optional minutes past midnight, a reason that includes `event` (`20260906000100:48-90`) | No weekday: a weekly hold is one row per date. The practice solver never reads blackouts (R21; the Practices page only warns, `PracticeSchedulingPage.jsx:568`), so a team could still be placed there, and closing ground can start the repair flow (the enact RPC's blackout arm, `20261007000000`) |
| A division reservation  | `practice_slots.division_id`: a slot only one division's teams may use                                                                             | Needs a division to give it to. A zero-practice "Clinics" division with no teams would work and would then appear in teaming, the Teams page and the exports. Not recommended                                                                                                                         |
| `practice_slots.label`  | An optional text on a slot                                                                                                                         | Read by no solver path (no match in the solver files), and free text. A label alone holds nothing                                                                                                                                                                                                     |
| The `Clinic` field size | An `<option>` of the Size select (`FieldManagementPage.jsx:1009`)                                                                                  | A size of ground, not an activity                                                                                                                                                                                                                                                                     |
| Capacity 0              | A slot nothing may fit                                                                                                                             | Refuted (finding 16): the page raises it to 1 and the loader throws                                                                                                                                                                                                                                   |

**The smallest correct form.** _Now, with no schema (S, inside PR 10 and 11):_ a cell marked `Use = hold` makes no slot,
so nothing can be placed there (correct by construction for both solvers, the writer gate and the capacity panel); the
import counts and lists it, and flags `hold-over-open-slot` when an open slot already exists at that cell (4.11.3). Its
weakness: nothing records the hold, so a later fields CSV can add the slot back. _Later, if the owner wants it stored
(PR 14, M, rule 14):_ `practice_slots.hold_kind text NULL CHECK (hold_kind IN ('clinic', 'event', 'other'))`, a closed
list so no free text is stored. A slot with a hold kind is never offered by either solver twin, is refused by a new gate
rule `hold` for new auto rows (the gate is replaced whole, lesson 70), is left out of the capacity panel's supply and
shown as "held", and is labelled on the Field Management slot list; a manual row may still be placed there, as an
admin's locked and audited choice. The same proof as 5.7: with no holds set the output is byte-identical. PR 14's first
task is to re-read this section against the code of the day. Decision 28.

**Status (decision 28 = (a), 2026-11-06).** No stored hold, and PR 14 is HELD. A `Use = hold` row only lists: the import
makes no slot for it, counts it and lists it, and flags `hold-over-open-slot` when an open slot already exists there. The
consequence: nothing records the hold, so a later fields import or a Field Management save can create a slot at that
time, and a gap-fill run could then use it. The PR 14 paragraph above is the design as drawn, kept so it need not be
re-derived if the owner lifts the hold. Because nothing records a held time, PR 13 cannot know that a time is held (5.9).

### 5.9 F16 Capacity versus demand, before a run (PR 13; no schema; added 2026-11-06)

**What exists.** After a run only: the readiness panel shows the teams needing manual assignment and the reasons
(`PracticeReadinessPanel.jsx:134-139`); the run's `practices` block lists, per team that wants several, how many it
holds, was given and still lacks (`docs/architecture/practice-scheduling.md`, "What is missing, and why"); and
`get_schedule_tbd` lists the practices a team is short of after a save (`20261108020000:445`). `evaluatePracticeSchedule`
computes `slotUtilization` (`practiceMetrics.js:748`) and no component renders it (R24). Nothing shows, **before** a run,
whether the slots a division may use can hold what it needs; the workbook's summary tab does this by hand.

**The panel (read-only).** A section at the top of the Practices page, "Before you run: slots against what each
division needs", one row per division of the season:

| Column           | Counts                                                                                                                                                     | From                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Teams            | The roster's teams in the division                                                                                                                         | `teams` (the subject set is the roster, lessons 46 and 92) |
| Practices wanted | teams times `practices_per_week`                                                                                                                           | `divisions`                                                |
| Held             | Saved practice rows of those teams, counted as `planTeamsForRun` counts them                                                                               | `practice_assignments`                                     |
| Still needed     | The sum over teams of `max(target - held, 0)`                                                                                                              | The solver's own arithmetic                                |
| Length           | `practice_minutes`, or "any"                                                                                                                               | `divisions`                                                |
| Slots it may use | Distinct practice slots open to the division, live from today, of its length, with their capacity and the weekdays they cover                              | `practice_slots`, reservations                             |
| Verdict          | "short by N" when still needed exceeds capacity; "N to spare" otherwise; "fewer weekdays than practices a week" when it applies; "none wanted" at 0 a week | Derived                                                    |

**Basis, and times held outside the app (decisions 28 and 29, 2026-11-06).** The panel states on its face what its numbers
are based on: every open slot in `practice_slots` that the division may use, live from today and of its length. It counts
**every** open slot. With no stored hold (decision 28 = (a)) nothing in the app records a held time, so the panel cannot
know that a time is held outside it: it says "times held outside the app are unknown to this panel", and it labels its
verdict an **upper bound** (the capacity it sees can only be too high). It does not promise to leave held times out of
available capacity; excluding them for real is PR 14, which is held. PR 10 reports every code path that creates practice
slots (task K2), because a path that creates one from field availability could bring a held time back as open capacity.

A total row counts a slot once though it counts in every division that may use it, and says so (lesson 92: a count is a
number of a population; the rows can sum to more than the total). **Declared, not enforced** (AGENTS.md section 3): the
panel ignores coach overlap, coach `must` rules, daylight, closures, permits and travel, so the capacity it
shows is an upper bound: "N to spare" can be too high, and "short by N" can understate the shortage (a run cannot
place more than the capacity, and nothing here knows of times held outside the app). The panel says so on its face. Reads are
all-or-nothing, each failed read names its table and draws no row, and a view that renders before its inputs arrive
says "not checked yet" (lessons 90 and 93). The calculation is pure core, `packages/core/src/practice/capacityDemand.js`,
with a Zod schema. Tests: `still needed` equals the sum of `planTeamsForRun`'s `unitsNeeded` over one shared fixture (the
Deno solver is pinned to core the repository's usual way); a division wanting 60 minutes over 45-minute slots has none
open (`practice-length`); a reservation case; a fewer-weekdays case (`not-enough-days`); a held case; a 0-a-week
division is not "short"; the basis sentence, the "held outside the app" sentence and the upper-bound label are on its
face; axe in both themes. Effort **M**; no schema. Recommendation (accepted, 2026-11-06, with the basis wording above):
**build** (PR 13). It makes an import's result actionable and is useful with no import at all.

### 5.10 Recorded and not built (added 2026-11-06)

- **Coach shirt and bag tracking** (a tab of the second workbook). Handing out equipment is outside the product: AGENTS.md
  section 2 excludes merchandise and stores, and nothing here tracks per-person items. Recorded so it is not
  rediscovered as a gap.
- **The holiday-week makeups copy** (a hidden tab holding a second copy of the grid for one week). The need, moving one
  week's practices around closed ground, looks covered by a blackout plus the practice repair (`practice/repair.js`; the
  enact RPC's blackout arm, `20261007000000`). _Statically reviewed_ in `docs/architecture/practice-scheduling.md` and
  the migration's header; **not tested**, and whether it reproduces the owner's makeup grid is unknown. What resolves it:
  the owner walks one holiday week through the repair panel with a saved blackout.

## 6. Behaviour

- **Now.** Any game can be moved, cancelled, or silently dropped from view by a regeneration, with no flag, no refusal
  and no reason on record beyond `game.saved`. There is no schedule importer, no way to add one game, no day, coach or
  duty view, and the per-team files and feeds read a table no save fills.
- **After.** An admin can mark games **Published**, one at a time or by division, date or venue. While a game is
  Published nothing moves, cancels, omits or regenerates it; to change it the admin allows changes for that game (a
  reason, audited with the before-image), edits, and publishes again. An organization that arrives with a schedule
  imports it from a CSV: teams, divisions and fields are mapped or created on confirmation, every row is either written,
  flagged or listed with a reason, outside opponents are flagged teams, and the games arrive Published. An admin can add
  a game by hand, print a Day Sheet, send a coach their games, and see what changed since a publication and why.
- **Unchanged (each is a test; 7.1 names them).**

| Unchanged                                                                                 | Test                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A league that never publishes: every save, cancel, move and regeneration behaves as today | the existing `supabase/tests/game_persistence_rpc.sql`, `game_score_rpc.sql`, `admin_delete_team_exceptions.sql` pass unchanged; PR 1's "nothing published" control |
| `scheduleGames` with no `pinned`, byte for byte                                           | `tests/gameSchedulingPinned.test.js` (`sha256` of the output over the season fixture and the demo league equals the base's, taken first); the generation goldens    |
| `scheduleGames` still refuses a `freeze` argument                                         | the existing test, plus a sentence naming `pinned`                                                                                                                  |
| A completed season stays read-only, and wins over the flag                                | `supabase/tests/season_schedule_readonly.sql` unchanged, plus one case in `game_published.sql`                                                                      |
| `assignment_source` `locked` still maps to `manual`; `manual` is a badge only             | existing page and RPC cases                                                                                                                                         |
| Practices, their lock-by-default and `unlock`                                             | `supabase/tests/practice_*` and `tests/gridLockedOverrideMessage.test.jsx` unchanged                                                                                |
| Team generation, incremental teaming and the roster statuses                              | the nine teaming suites the play-down plan pinned, run once in PR 5 (the only PR that touches `persist_team_schedule`'s caller)                                     |
| Other imports (players, coaches, fields, preferences, evaluations)                        | their pgTAP and vitest suites unchanged; the PR 5 census fails if a list lost an entry                                                                              |
| Exports and baselines carry no Published column                                           | `tests/outputGeneration.test.js` header pin unchanged                                                                                                               |
| No coach, family or public surface                                                        | a consumer census for the new pages and exports (admin routes only), as `unwiredLayerImporters` pins importers                                                      |

### 6.1 Behaviour, the practice side (added 2026-11-06)

- **Now.** A league that arrives with a practice schedule has no way to bring it in: it re-enters every practice by
  hand or lets the solver make a different one. A division cannot ask for paired days. A non-team activity can be kept
  free only by never creating the slot. Nothing shows slots against need before a run, and the coach view lists no
  practices.
- **After.** The admin uploads a flat CSV of practices; maps teams, venues and fields (an alias file and the last
  mapping propose, never decide); confirms the list of everything that will be created; and previews what the file will
  do, including every rule it breaks and each team short of its count. The practices arrive locked, as the admin's own
  (`manual`), nothing already saved is changed, and a run then fills only the gaps. The import rolls back while nothing
  it wrote has changed. Optionally, a division's two practices share a slot on a paired weekday; a panel shows slots
  against need before a run; the coach schedule lists practices and marks coaches on several teams.
- **Unchanged (each is a test).**

| Unchanged                                          | Test                                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persist_practice_schedule`, its gate and `unlock` | `supabase/tests/practice_writer_v3.sql`, `practices_per_division.sql`, `practice_persistence_rpc.sql` and `tests/gridLockedOverrideMessage.test.jsx` pass unchanged in PR 9 to 11, 13 and 14; PR 12 extends them |
| A one-a-week league, and a league with pairing off | The `sha256` of both solvers' output over the season fixture and the demo league equals the base's, taken first (PR 12; PR 14 repeats it)                                                                        |
| The fields CSV import and its rollback             | `supabase/tests/field_import_apply_rollback.sql` and `field_import_rollback_booking_guard.sql` unchanged                                                                                                         |
| Saved practices are never changed by an import     | pgTAP: every row that existed before is byte-equal after an apply, a re-import and a rollback                                                                                                                    |
| A save after an import moves no imported row       | pgTAP, and a vitest case over the real classification (`planTeamsForRun`, through the Deno mirror tests)                                                                                                         |
| Practice readers                                   | `tests/practiceReaderCensus.test.js` classifies the apply and the rollback `writer`; no reader changes                                                                                                           |
| Completed seasons                                  | The import and its rollback are refused (pgTAP, beside `season_schedule_readonly.sql`)                                                                                                                           |
| Coach preference rules, daylight, repair           | `tests/coachPreferenceRules.test.js` and the daylight suites unchanged                                                                                                                                           |
| No coach, family or public surface                 | A consumer census for the new pages and exports (admin routes only)                                                                                                                                              |

PR 14 is held (decision 28): where this table names it, it applies only if the owner lifts the hold.

### 6.2 Settings scope (owner principle, 2026-11-06)

**The principle (message 2).** Optional behaviours are configurable at organization, program and division level ("most
things should be, at the org, program, and division levels"): an unset level inherits from the level above, and the most
specific wins. `programs` exists (migration `20261101020000`: `divisions.program_id`, one program per division, a program
spans divisions) but has no settings columns, so a cascade needs a place to store program-level settings (a migration)
and one resolver. It is recorded as a principle; PR 12 and the F11 plan carry the scope. Applied here:

- **Standings inclusion of results against outside clubs** (4.6, decision 5): excluded by default, optional at all three
  levels, a per-fixture override later. **Widens the F11 plan**, which must size its use of the storage and the resolver.
- **The pairing setting** (5.7, decision 27): a division value now; program and organization defaults through one
  resolver, built with its first user and sized in PR 12's first task. **Widens PR 12.**
- **Play-down** (the organization setting that exists today): organization-only. Program and division levels are a
  follow-up candidate, **not planned** here.
- **"Publish marks games Published" (decision 3) and "imports arrive Published" (decision 4):** stay per-action
  switches. An organization default is a follow-up candidate, **not planned** here.

Only PR 12 and the F11 plan widen; nothing else in this plan changes scope. The "not planned" items are recorded so they
are not rediscovered.

## 7. Tasks, pull requests, plants, stop conditions, risks, rollback

Sizes are S under 150 lines, M 150 to 500, L over 500, tests included (estimates). **Thirteen active pull requests
(PR 1 to 13; PR 14 is held by the owner), at most two in flight (AGENTS.md section 11).** There are no fixed waves; the
dependency table and the one priority rule below decide what starts next (restructured 2026-11-06, which the owner
delegated). Open pull requests were not checked for this plan; a PR opens only when fewer than two are in flight (check
with `gh pr list` then). The hold is lifted (section 10), and AGENTS.md section 3 still applies: an agent merges only when
the owner has said so for that PR. **Four migrations (PR 1, PR 5, PR 10, PR 12), one below `MAX_PENDING_MIGRATIONS`**
(default 5, `docs/operations/ci-cd.md:207`); a PR that depends on a migration waits until it is deployed, so none is
batched. Version numbers: the next free after `20261118010000` at the base `c3d190d`; take the next free when the PR
starts. Rule 14 applies to PR 1, 2, 5, 6, 8, 10, 11, 12 and 14 (persistence or the solver; PR 14 is held); **this plan is
the stop**, and the owner agreed it on 2026-11-06. PR 3, 4, 7, 9 and 13 add no persistence.

**Dependencies and order.** "Depends on" means merged and, for a PR with a migration, deployed; "approved" is the owner's.
The order column is the priority order.

| Order | PR  | Depends on                                        | Review | Migration     |
| ----- | --- | ------------------------------------------------- | ------ | ------------- |
| 1     | 1   | nothing                                           | (c)    | yes           |
| 2     | 4   | nothing                                           | (c)    | no            |
| 3     | 2   | PR 1                                              | (c)    | no            |
| 4     | 5   | PR 1 (deployed), PR 4, **the F11 plan approved**  | (c)    | yes           |
| 5     | 3   | PR 1 and PR 2                                     | (a)    | no            |
| 6     | 9   | PR 4                                              | (c)    | no            |
| 7     | 6   | PR 5 (deployed)                                   | (c)    | no            |
| 8     | 10  | PR 5 (deployed) and PR 9                          | (c)    | yes           |
| 9     | 7   | PR 1                                              | (a)    | no            |
| 10    | 13  | nothing                                           | (a)    | no            |
| 11    | 8   | PR 3 and PR 5                                     | (c)    | no            |
| 12    | 11  | PR 6 and PR 10                                    | (c)    | no            |
| 13    | 12  | PR 9 and PR 10                                    | (c)    | yes           |
| held  | 14  | (held by the owner; decision 28 = no stored hold) | n/a    | yes (a fifth) |

**The priority rule.** A free slot (at most two PRs in flight) takes the first PR, in the order above, whose dependencies
are merged and deployed. Nothing else decides, so there is nothing to re-plan when a PR finishes early or late. PR 13
needs nothing and so takes a free slot whenever no earlier PR is ready. The F11 plan's own PR list is added to this
table and order when the owner approves it.

**The F11 plan: a gate before PR 5 (decision 12).** It is a separate document, written by an agent, and the owner
approves it (rule 14). It is not small: scores surviving the regeneration of unpublished games is a persistence
question. It compares options against **four criteria**: (1) one source of truth; (2) scores survive regeneration of
unpublished games; (3) game identity stays stable, including PR 5's `external_ref`; (4) the standings policy of 4.6
(optional at organization, program and division level, default excluded; 6.2). It must not pick an approach in
advance. It runs before PR 5, not before PR 7, because PR 5's migration adds `game_assignments.external_ref` (the Game ID) and defines
re-import by it, and criterion 3 could reject that design after it deploys. Until it is approved, PR 5 does not start.

**Review (decision 16, final).** By content. A PR is **(c)** if it contains a migration, an Edge write path, solver
changes, or import matching, diff or flagging logic; every other PR is **(a)**. (a) is a labelled self-review against the
PR's plants and stop conditions, plus the Codex PR review. (c) opens the PR without `/code-review`; Codex reviews it; the
Codex findings are addressed; then one `/code-review high` runs on the result and its findings are fixed in the same push;
never a second `/code-review` on the same PR. Documentation and very minor PRs, and dependency PRs, get no
`/code-review`. The tag is in each PR header below; the one-line reasons are in decision 16. **(c): PRs 1, 2, 4, 5, 6, 8,
9, 10, 11, 12. (a): PRs 3, 7, 13.** PR 4 and PR 9 are on the (c) list although the rule-14 sentence above does not name
them: they persist nothing, so rule 14 does not apply, but they hold the label-matching, conflict-audit, alias and
probable-move logic that a review exists to check. Task A6 (PR 1) landed this policy in AGENTS.md section 3 and CLAUDE.md's
Review bullet (#707), so no agent brief needs to name an exception.

**Cost note for every PR (the owner's budget rules, 2026-11-03).** Run only the touched test files while iterating; one
`npm run test:coverage` at the end; run only the **new** E2E feature locally, after `bddgen`; pgTAP and the `dbharness`
plants run in CI (they need the local Supabase stack); **review as decision 16 says** (above; section 9 records the
departure from AGENTS.md section 3); docs stay short: one dated paragraph per doc in
each PR's "Docs" line, plus the fixture README. Each PR's description lists what it did **not** run. No PR adds a
dependency, and `check:unused`, `check:advisors` and `check:bundle` are part of CI as always; the new pages are built
lazy-loaded like the others, so the bundle budget is not expected to be the constraint. The same rules cover PR 9 to 13
(none adds a dependency; the owner-cost line of each says what the owner is asked for).

### PR 1: Published, database and Edge (L; migration; rule 14; Review: (c))

Depends on: nothing. Review (c) because it holds a migration, the guard trigger and the Published and override write
path. **Its first commits cherry-pick the plan commits `0cafa0e`, `0869b07` and the 2026-11-06 amendment commit (see
`git log`), so the plan is recorded in the same PR as the change it justifies (AGENTS.md operating rule 7).**

- [x] A1 (L) Migration: the three columns and partial index; the two `audit_actions`; the guard trigger;
      `admin_set_games_published`; `get_schedule_audit_log`; `persist_game_schedule` with the omission refusal;
      `admin_cancel_game_assignment` and `admin_delete_team` refusals. `docs/sql/<v>_revert.sql` (the previous bodies
      from production's text, lesson 87's method) and `_smoke.sql`; `supabase/catalog-snapshot.json` regenerated.
      **First, write `supabase/tests/game_published.sql` red against today's code**: one assertion per row of 3.3 and
      per gate of 3.4; each refusal paired with a control that the **unpublished** twin passes (a trigger that refuses
      everything fails the control); a signed-in caller and a no-user caller; cross-organization ids; a completed
      season; the audit rows' count and content, and the 2,400-id row's size measured; an unchanged value is a no-op.
- [x] A2 (S) Edge: `_shared/game-persistence-errors.ts` maps `game_published` and `game_published_omitted` to 409
      `GAME_PUBLISHED` with the ids, and **leaves every other error as it is**. Test `tests/gamePersistenceErrors.test.js`
      (the shape of `tests/practiceEnactEdge.test.js`): both codes map; an unrelated 22023 and a 500 are unchanged.
- [x] A3 (S) Core `packages/core/src/gamePublished.js` (pure, registered in the index): the closed reason list, a
      splitter, `publishedOmissions(saved, payload)`, the Zod schema of the set payload. Test `tests/gamePublished.test.js`,
      including that the four shared reason codes equal `GRID_OVERRIDE_REASONS`.
- [x] A4 (M) Mock client mirrors the RPCs and the guard. Test `tests/mockGamePublished.test.js`: **one input that reaches
      every outcome** goes through the mock and the pure helper and their answers must agree (lesson 77's twin).
- [x] A5 (S) Docs: `docs/architecture/game-scheduling.md` (the Locking paragraph and the "COMPLETE" note corrected),
      `docs/MODEL_GAPS.md` GAP-29 and GAP-35 (a dated note: the stored flag is Published), `docs/PUBLICATION_PARITY.md`
      (the relation in 3.1), `docs/LESSONS_LEARNED.md` (section 12).
- [x] A6 (S) **A separate commit.** AGENTS.md section 3's "Review every PR adversarially before opening it" bullet
      (Verification conventions) and CLAUDE.md's Review bullet get the exception wording: documentation and very minor
      PRs need no review; every other PR is reviewed by Codex first, then gets one `/code-review` after the Codex
      findings are addressed. The owner approved this edit in principle (message 1, section 10) and the hold on it is
      lifted. Before editing, `rg` the repository for the two bullets' text; a test or doc that quotes them is updated in
      the same commit. No code; labelled _statically reviewed_. It landed in #707, so no agent brief needs to name an
      exception. _(The "every other PR gets one `/code-review`" wording above was narrowed on 2026-11-09 to decision 16's
      class (c) only: AGENTS.md section 3 is the current text.)_

Plants (each turns the named test red, then is reverted; `scripts/dbharness/prove.sh` entries): the guard's column list
omits `home_team_id` (the "refuses a team swap on a Published game" case); the omission check removed (the "save that
omits a Published game is refused" case); `admin_set_games_published` stops requiring a reason when turning off.
Stop and report if: any existing pgTAP file turns red; the harness refuses a plant aimed at a replaced body; a second
migration is needed; the audit row for 2,400 ids is over 100 KB (then store a count and a digest, and say so).

### PR 2: the generator keeps Published games (M; no migration; solver, rule 14; Review: (c))

Depends on: PR 1. Review (c) because it changes the solver (`pinned`).

- [ ] B1 (M) `scheduleGames({ pinned })` and the `carried` output, as 3.5. Test `tests/gameSchedulingPinned.test.js`,
      the worked cases: no `pinned` equals the base (taken first); a pinned game on the only slot leaves the new
      matchup TIME TBD (`no-slot-available`) rather than double-booked; a matchup is consumed, preferring the same week; a
      pair outside the round robin occupies its slot and consumes none; a new game cannot clash with a pinned game's
      team or coach time; sides are kept; `freeze` still throws.
- [ ] B2 (M) The page passes the saved Published games as `pinned`, merges `carried` into the review and says "N Published
      games kept as they are". Test `tests/gameSchedulingPublishedRegenerate.test.jsx`: three Published, three
      unpublished; after regenerating, the three are byte-equal (id, slot, time) and the staged list satisfies
      `publishedOmissions` (PR 1's helper is the oracle); nothing Published moved.
- [ ] B3 (S) Docs: one line in AGENTS.md "Working conventions" ("regeneration never moves a Published game", beside the
      roster line), `docs/FREEZE_SCOPES.md` (a pointer to `pinned`).

Plants: `pinned` ignored (the "carried unchanged" case); a pinned slot's capacity not consumed (the double-booking
case); carried rows re-identified (the id-equality case). Stop and report if the season fixture suite or any generation
golden moves, or if output without `pinned` differs by a byte.

### PR 3: Published on the Games page (L; no migration; Review: (a))

Depends on: PR 1 and PR 2.

- [x] C1 (M) The switch and the card text. Test `tests/gameCardPublished.test.jsx`: role, name, state in words, axe
      clean, both themes' tokens only.
- [x] C2 (M) The bulk bar and the scope resolver. Test `tests/gamePublishedBulk.test.jsx`: a scope is enumerated from
      the **saved set**, not the filtered view (a filter active, the count still the saved count); the count is shown
      before the call; a refused call shows the database's words.
- [x] C3 (M) The "Allow changes" dialog. Its optional note field carries the helper text "Optional. Do not enter player
      names or other personal information." and a character counter (200) (decision 1). Audit rows have no per-row
      delete path and are pruned only by `prune_old_audit_logs` (180 days by default, set per organization), so a note
      persists up to that window, and the helper text is a soft control; one dated sentence in
      `docs/architecture/game-scheduling.md` (the doc A5 corrects) says so. Test
      `tests/gamePublishedOverrideDialog.test.jsx`: Confirm disabled with a visible reason until a reason and the tick
      are given; focus to the heading and back; a refusal is an alert; the helper text is rendered with the note field
      (as its description), the counter shows the count of 200, and a 201st character is not accepted.
- [x] C4 (S) Guards in `moveGameTo`, the cancel handler and the drag handle. Test `tests/gameGridPublishedGuards.test.jsx`:
      a drop and the keyboard "Move to" are both refused with the sentence; cancel asks for "Allow changes" first.
- [x] C5 (S) The Exports "Publish" checkbox (decision 3). Test: the bulk call carries exactly the exported ids.
- [x] C6 (M) One E2E feature `tests/e2e/features/published_games.feature`: publish a division; try to move one (refused);
      allow changes with a reason; move it; publish again; the history shows the reason; regenerate and see the
      Published games unmoved; axe in both themes. Run after `bddgen`; only this feature locally.

Plants: the guard removed from `moveGameTo` (the drop and keyboard cases); the scope resolved from the filtered view; the
dialog's Confirm enabled with no reason.

### PR 4: Import I, the fixture and the pure core (L; no migration; Review: (c))

Depends on: nothing. Review (c) because it holds the matching and conflict-audit logic in core (label matching, "not
judged" versus clear coverage); rule 14 does not name it because it persists nothing.

- [ ] D1 (M) `scripts/build-schedule-fixture.mjs`, `fixtures/schedule-2026/` and `tests/scheduleFixture.test.js`, as 4.9.
- [ ] D2 (L) `packages/core/src/scheduleImport/` (`parseRows`, `mapping`, `audit`, `reasonCodes`, `index`): dates and
      times, label normalisation (importing `normaliseExternalLabel` makes `externalImport` **wired for the first time**;
      the unwired-layer census is updated in the same PR and says so), mapping proposals, the week rule, the conflict
      audit with its coverage sentence. Tests: `tests/scheduleImportParse.test.js` (both date forms, 24-hour and 12-hour
      times including `12:00 AM`, `12:30 PM`, every refusal reason), `tests/scheduleImportMapping.test.js` (no word dropped:
      invented labels differing only by a word such as `Back` and `Front` stay two; an ambiguous label is never
      auto-mapped), `tests/scheduleImportAudit.test.js` (the fixture's planted counts; the pre-plant control reports none;
      a team with no coach is reported as "not judged", not as clear).

Plants: the date parser reads `13/04/2026` by swapping day and month; the normaliser drops a word; the audit checks the
home side only (the coach-clash plant sits on an away side).

### PR 5: Import II, the database (L; migration; rule 14; Review: (c))

Depends on: PR 1 merged and deployed; PR 4 merged; **the F11 plan approved by the owner** (decision 12: this PR's
migration adds `external_ref` and defines re-import by it, so game identity must be settled first). Review (c) because
it holds a migration, the re-import key, Published-row skipping and `is_external`. **Merged as #719 (`ad18861`); E1 to
E4 are ticked because each task's files are in that merge** (statically checked on 2026-11-10: the migration
`20261121010000_game_import.sql`, its revert and smoke, the catalogue snapshot, `prove.sh`,
`supabase/tests/game_import_apply_rollback.sql`, `tests/externalTeamReaders.test.js`, `tests/mockGameImport.test.js` and
the three docs; not re-run here). What was decided during its review is in section 10, the 2026-11-10 answers, entry 6.

- [x] E1 (L) Migration: `import_type` and `job_type` `games` through every list of 4.10; `game_assignments.import_job_id`
      and `external_ref`; `teams.is_external`; `ensure_game_slot` (an admin RPC, audited `game.slot_created`);
      `map_game_import_job`; `apply_game_import_job(job, dry_run)`; `rollback_game_import_job`; the
      `imported-without-time` reason; the guard's rollback exemption (3.3, 4.7). Revert and smoke; catalogue snapshot;
      harness plants re-aimed.
- [x] E2 (L) **First** `supabase/tests/game_import_apply_rollback.sql` and the two censuses (the lists of 4.10;
      `tests/externalTeamReaders.test.js`) red against today's code, then the migration. The reader census carries the
      classes of 4.6 (decision 5): the **exclude** list; the **include** list with a positive test per reader; the
      **not-applicable** list (team-in-two-places checks); `view_league_standings` excluded (standings (i)); and a pin
      that no path feeds external-team results into standings today, recording (ii) as "deferred to the F11 plan". The
      number of readers is whatever the census finds. Cases: a dry run writes nothing
      (read every table back); apply equals dry-run counts; a re-import inserts nothing and creates no run; the previous
      run's games are re-pointed (the new run is the whole schedule); a Published game is skipped, not changed; a
      conflicting file is stored and flagged; team shells land in a team run (`results.teams`) and the two checks of
      4.5 hold; rollback refuses after a change and succeeds before; a no-user job and a cross-organization job are
      refused; a completed season refuses.
- [x] E3 (S) The mock finalizer mirrors apply and rollback. Test `tests/mockGameImport.test.js`: the fixture through the
      mock equals the pgTAP's expected counts.
- [x] E4 (S) Docs: `docs/operations/ingestion-pipeline.md` (a games section), `docs/architecture/gotsport-import-contract.md`
      ("Schedule import: kept fields"), `docs/ARCHITECTURE.md` (the "no schedule importer" gap closed).

Plants: the dry run writes; the `ON CONFLICT` upsert removed (a re-import duplicates); rollback's "changed since"
refusal removed. Stop and report if the two checks of 4.5 fail (smallest input: one division, two empty shells, twenty
players), if the nine teaming suites move, or if a reader of `teams` cannot be classified.

### PR 6: Import III, validation, panel, E2E (L; Edge and UI; rule 14; Review: (c))

Depends on: PR 5 merged and deployed. Review (c) because it holds an Edge write path (`import-validation`) and the
preview and apply parity.

- [x] F1 (M) `import-validation` accepts `games`: the allowlist, Zod rows, the 2,400 cap, the season clock via
      `_shared/timing`. Tests: a Deno test and a vitest twin with named zones and dates (spring-forward gap refused,
      fall-back first occurrence flagged, a half-hour zone, a southern-hemisphere zone), run with `TZ` set to two other
      zones to prove the host zone is not read; a 500-row chunk timed with coverage on.
- [x] F2 (L) The Games tab of the Import panel: upload, mapping, preview, confirm, result, rollback; accessible, both
      themes, no color-only state. Tests: `tests/gameImportPanel.test.jsx` (the confirm lists everything that will be
      created; nothing is created without it; each unmapped row is listed with its reason).
- [x] F3 (S) The twin: `tests/gameImportPreviewTwin.test.js` requires the preview's counts, its conflict audit and the
      saved result to agree over one file that reaches every outcome.
- [x] F4 (M) E2E `tests/e2e/features/schedule_import.feature`: import the fixture, map the outside clubs, see the flagged
      conflicts, confirm, see the games Published, roll back. Only this feature locally.
- [x] G3 (S, moved from PR 7) The SquadLogic schedule CSV, whose test exports the fixture's imported schedule and
      re-imports it as a dry run: **zero changes**. It is here because the importer it tests is here.
- [x] G5 (S, moved from PR 7; built in PR 6b, 2026-11-13) Optional "record as baseline" at import (decision 15), ticked by default when the games
      arrive Published. **Deferred, 2026-11-10 (the coordinating agent, under the delegation of section 10): to PR 6b
      (baseline at import). It needs the Exports page's generation as a shared function.** Tests of G3 and G5: as they were in PR 7 (as 5.1 and 5.6, each with a case for a cancelled game
      and a TIME TBD game).

- [x] F5 (S, added 2026-11-10; section 10, the 2026-11-10 answers, entry 4) Core's parse turns a `bad-time` row into a
      dated TIME TBD game with a warning and derives the week of a `bad-week` row from its date with a warning;
      `outside-season-window` stays a refusal. Test `tests/scheduleImportParse.test.js`: one case per code, each beside a
      well-formed control, and a `bad-week` row whose date is outside the season still refused.
- [x] F6 (M, added 2026-11-10; entry 1) A TIME TBD game's date is shown with a blank time on the Games page list, in the
      master export, and under its date in the Day Sheet (data: `schedule_tbd.game_date`). Tests: a case in each of the
      three surfaces' existing test files for a dated TIME TBD game (the date present, the time blank) beside an undated
      one, which reads as today.
- [x] F7 (M, added 2026-11-10; entry 3) Preview-stale protection: the confirm step passes the previewed counts, and the
      apply is refused with `game_import_preview_stale` when its own differ. PR 6 has no migration, so the Edge function
      re-runs the dry run, compares, and refuses. Tests: a Deno test and its mock twin in which the schedule changes
      between preview and confirm (refused, nothing written), beside an unchanged control that applies.
- [x] F8 (S, added 2026-11-10; entry 4) The mapping screen defaults to "map to existing" when a match exists. Test: a
      case in `tests/gameImportPanel.test.jsx` (a label with a match opens on "map to existing"; one without does not).
- [x] F9 (S, added 2026-11-10) The Games page shows the import's warning list (`games-swapped`, `game-made-time-tbd`,
      `week-differs`). Test: a case in `tests/gameImportPanel.test.jsx`, or the Games page's own test file, that each of
      the three is listed in words and that no list is drawn when there is none.
- [x] F3b (S, added 2026-11-10) Align the reason code for an outside club whose custom name collides with an own team:
      core and the mock say `unknown-team`, the SQL says `label-is-own-team`; both refuse (reported from PR 5's review,
      not re-traced here). Test: one case in `tests/gameImportLabelParity.test.js` requiring the same code from all three.

Plants: the conversion reads the host zone; an unmatched label created without the confirm list; the preview's counts
computed apart from the dry run.

**As built (2026-11-10; the pull request has the detail).** Eleven of the twelve tasks are done; **G5 is deferred to
PR 6b** (a baseline is the master export's rows, and the import panel does not make that file: recording one from the
panel needs the Exports page's own generation as a shared function, a refactor that goes in its own pull request,
AGENTS.md section 3). What differs from the text above, each a decision of the build under the delegation of 2026-11-10 (section 10):

- F1/F5: `bad-time` and `bad-week` are warnings of the parse that are **not staged**. The apply's shape check takes two
  staged flags (`time-ambiguous`, `week-differs`) and this PR has no migration, so a third would refuse the whole apply.
  They are said at the upload and in the preview; the saved result does not carry them. The next replacement of
  `apply_game_import_job` can take them (and drop the two codes from `c_row_refusals`).
- F1: a Week past 255 is `bad-week` (derived), because `game_slots.week_index` holds 1 to 255 and a staged 256 would
  refuse the apply; core read 1 to 999 before.
- F3b: confirmed (core and the mock said `unknown-team`), and a second case found with it: an outside club named like a
  team shell of the same file was accepted by core and refused by the SQL (`shell_here`). Core now says
  `label-is-own-team` for both.
- F6: the master export keeps `TIME TBD` in the Start cell of a dated TIME TBD game (every reader of that file matches
  the cell exactly) and says the date in Notes; the Day Sheet lists a dated game under its date only; the Games page
  gains a "TIME TBD games" list. `get_schedule_tbd` does not return `game_date`: the client reads it from the table.
- F7: the comparison is every count the confirm screen shows (`scheduleImportConfirmCounts`); `games.repointed` and
  `reused.slots` are not shown and not compared. The re-run and the apply are two statements.
- Plan 4.4's preview audit (coach overlap, hosting balance, judged in the browser) is **not** in the preview: it states
  what it did not check, as the SQL result does (`not_judged`).
- Found while building: the mock resolved a single match with no stored decision; the database does not. Core takes
  `explicitOnly` and the mock passes it (lesson 107).
- Fix round 1 (2026-11-10, Codex and CI): the panel's workflow is keyed by organization and season, and a roll back is
  refused for a job of another scope; a blank Division or team, and a time and field with no Venue, are refused as a
  row at staging (`unknown-division`, `unknown-team`, `unknown-venue`) instead of failing the apply's shape check for
  the whole job; a value is read by the header as the file wrote it; the schedule CSV writes a game's own start and
  end on the season clock, not its slot's; the Edge handler reads the job's season through the shared module.

**For the next replacement of `apply_game_import_job` and `get_schedule_tbd` (noted 2026-11-10). Updated 2026-11-11:
F11-2 (`20261122010000_game_scores.sql`) did replace both, and took the second and third lines below (the staged
flags `bad-time` and `bad-week`; `game_date` and `external_ref` returned, with the client reading the table only
when the older body answers). `c_row_refusals` keeps the two codes, so a job staged before PR 6 still applies. The
FIRST line, the preview-stale check inside the function, is NOT done (a change of signature) and stays open:**

- `apply_game_import_job` is callable directly by an admin, without the preview-stale check the Edge function makes.
  Moving the comparison into the function (the confirmed counts as a parameter) closes that, and makes the re-run and
  the apply one statement.
- Its staged-flag list (`time-ambiguous`, `week-differs`) should take `bad-time` and `bad-week`, so the two warnings
  reach the saved result, and `c_row_refusals` should drop the two codes.
- `get_schedule_tbd` should return `game_date` and `external_ref`; the client's second read of `schedule_tbd` then
  goes.

**For the next migration, whichever it is (F11-2's or its own; noted 2026-11-11, fix round 3). Done in F11-2
(`20261122010000`): the function refuses such a job (22023, `import_not_ready_to_apply`), and the mock refuses again.**
`cancel_ready_import_job` must refuse a job that is not `ready_to_apply`. It is a deployed function (PR 5 added
`games` to it) with no check of the job's status: called for an applied job of any of its six types it marks the job
`failed` and audits `import.canceled`, while everything the apply wrote stays. PR 6 closes the games panel's way to
that call from the client (below); only the function can close the time between a client's read and its call, and
the other callers. The mock's copy has no status check either, on purpose, until the SQL has one.

**Review round (2026-11-11, the one adversarial review, ten findings, all taken).** The panel: a roll back is kept
per job (the next import's result is its own); "nothing to apply" says why from the counts; the "Games arrive
Published" box shows the STORED mapping and there is no confirm without a preview of it; a column the import reads
given twice refuses the file (the CSV reader renames a repeat, so the parse never saw it); the mapping controls are off
while a preview is made and the confirm lists the names of the mapping that was sent; the Import page's 10 MB guard;
a staged import that is left is discarded (`cancel_ready_import_job`: the job is marked failed, its staged rows stay
with it) and one left by a closed tab is named on the upload step with "Discard it". The reports: the coach schedule
shows a TIME TBD game's date; a TIME TBD game whose date changed is a change since publication; the Day Sheet says how
many TIME TBD games it left to another day. The template's header row is in a constants-only module, so the Import
page does not load the parser.

**Fix round 3 (2026-11-11, Codex on the review round's push, two findings, both taken).** (1) A confirm whose
answer was lost after the apply committed left the panel free to discard the job on leaving, and
`cancel_ready_import_job` marks an applied job `failed`: the games stayed, the job left the roll back, and a false
`import.canceled` was audited. The panel now settles a failed confirm from the job itself before anything else
(applied: the result screen with its roll back; still `ready_to_apply`: "The import was not applied", confirm again or
discard; unreadable: the outcome is said to be unknown, "Check again", nothing sent again and nothing discarded), and
`discardGameImport` reads the job and calls the cancel only for one read as `ready_to_apply`, for every caller (Cancel,
another tile, a switch of organization or season, the page closing, the unfinished list). Declared: the read and the
call are two statements; the function's own check (above) closes that. (2) The schedule CSV wrote an end in the hour
the clocks repeat as its wall time, which the import reads as the first time round: a game ending the second time
round came back an hour shorter. Such an end is now written as a `Length` with a blank End Time (the column joins the
file only then); a start the second time round cannot be written and is counted and said
(`omitted.repeatedHour`); a start the first time round round-trips. No stored instant reads as a time in the hour the
clocks skip, and the import refuses a file that names one, so the export has no such case
(`tests/scheduleCsvRepeatedHour.test.js`: Los Angeles, Sydney, and Phoenix as the control).

**Follow-ups found in PR 6's review (2026-11-11; recorded, not fixed here).**

1. `ImportContext` keeps `activeJob` and `imported*.importJobId` across a switch of organization or season, for the
   coach, field, field availability and evaluations imports (statically read, not reproduced): the same class as the
   schedule panel's Codex P1, in another component.
   **Closed by F11-3 (2026-11-13):** reproduced for a switch of organization (`tests/importContextScopeSwitch.test.jsx`),
   and the context now forgets that state then; a switch of season shows nothing of another scope (both reads are by
   organization, and a job carries its own season), so nothing is reset for it.
2. The calendar feed (`supabase/functions/_shared/calendar/teamFeed.ts`) and `useTeamPortal.js` read the SLOT's times,
   not the game's own `start` and `end`: an imported game whose end differs from its slot's shows the slot's end.
   **Closed by F11-3 (2026-11-13):** both read the saved game's own instants on the season clock (the feed's builder
   places them before the slot's); `tests/teamPageSavedSchedule.test.jsx` and the feed's cases in
   `tests/calendarFeed.test.js` (Vitest) and `_shared/tests/ics-feed_test.ts` (Deno, run in CI only).
3. At the next replacement of `apply_game_import_job` or `get_schedule_tbd` (the three lines above): the staged-flag
   list for `bad-time` and `bad-week`, `game_date` returned by the RPC, the preview-stale check inside the RPC.
   **Two of the three closed by F11-2 (2026-11-11); the preview-stale check inside the RPC stays open.**
4. A sweep in SQL for abandoned `ready_to_apply` games jobs, if the panel's client-side discard proves insufficient
   (a closed tab never runs it; the upload step lists what it left).
5. **Closed by F11-2 (2026-11-11; and, 2026-11-12, the Import page's shared cancel path settles from the job when the
   function refuses it: `cancelDeferredImportJob` reads the job on `import_not_ready_to_apply` and the page clears its
   state and says what happened, instead of failing until a reload. `discardGameImport`'s read-before-cancel may be
   dropped once `20261122010000` is deployed; it is the only check against the older body).** `cancel_ready_import_job` refuses a job that is not `ready_to_apply` (the note for the next migration, above; fix
   round 3). Until then the Import page's own deferred-apply flow can still reach it blind: `ImportContext`'s
   `cancelDeferredImport` (`importDeferredActions.js`, `cancelDeferredImportJob`) is offered again after
   `applyDeferredImport` throws, for the coach, field, field availability, practice preference and evaluation
   imports, and a finalize that committed and lost its answer throws (statically read, not reproduced; not changed
   in PR 6).

### PR 6b: baseline at import (S after its refactor; no migration; Review: (a) for G5a, (c) for G5 as the coordinator classed it (import flagging logic); added 2026-11-10)

Depends on: PR 6 merged. On no other pull request's dependency path; placed after F11-3 in the order.

- [x] G5a (M) Lift the Exports page's master-file generation (`buildExportPayload`, the directory read and
      `generateScheduleExports` as `OutputGenerationPanel` calls them) into one function both callers use. A refactor,
      in its own pull request first if it is more than a move. Test: the Exports page's existing tests unchanged, and
      the function's rows equal to the page's for one seeded league.
      **As built (2026-11-13), in its own pull request:** `generateMasterExport` in
      `frontend/src/utils/masterExport.js` (a frontend util: it needs the client for the TIME TBD and directory
      reads), with `buildExportPayload` and its normalisers moved unchanged; it returns a status
      (`tbd-failed`, `nothing-scheduled`, `directory-failed`, `nothing-writable`, `generated`) and the panel keeps
      every sentence. `onTbdRead` keeps the page's TIME TBD count updated before the directory read, as it was.
      Tests: `tests/exportMasterRowsCharacterization.test.jsx` (the page's whole output as JSON, committed before
      the move and unchanged by it) and `tests/masterExport.test.jsx` (the function's rows equal to the page's).
- [x] G5 (S) The import's result offers "record this import as the publication baseline", ticked by default when the
      games arrive Published, and records the shared function's rows through `admin_publish_schedule_baseline`. Tests
      as 5.1 and 5.6 (each with a case for a cancelled game and a TIME TBD game), and "Changes since publication"
      against that baseline shows no change right after the import.
      **As built (2026-11-13), no migration:** the option is on the confirm step ("Record this schedule as the baseline
      for Changes since publication"), its default the STORED mapping's "Games arrive Published", set again each time a
      mapping is stored. After a successful apply (or a lost answer settled from the job as applied) a lazy chunk
      (`frontend/src/components/import/ImportBaseline.jsx`) reads the saved schedule through `useDashboardData`, maps it
      with `masterExportInputs` (new in `utils/masterExport.js`; the Exports page now passes its panel the same mapping),
      makes the rows with `generateMasterExport` and records them through `usePublicationBaselines().publishBaseline`,
      channel `schedule import`, snapshot id `schedule-import-<job id>` (the table's unique snapshot id makes it one per
      import). Tests: `tests/gameImportBaseline.test.jsx` (the import's baseline equal row for row, columns and digest,
      to the Exports page's for the same schedule, over the characterization fixture's cases: own v own, an outside club,
      a TIME TBD game with a date and one without, a game cancelled before, the run's coach; the default; unticked; two
      failures; the roll back three ways; "Changes since publication" over the recorded baseline: no change, then a
      game moved by a second import is one no longer saved and one new), `tests/gameImportBaselineChunk.test.jsx` (a
      chunk that cannot load), cases in `tests/dashboardErrorConsumers.test.jsx` (a refused read, reads that never
      settle) and `tests/reportsChangesSincePublication.test.js`, and two steps of `schedule_import.feature`.
      **Decisions taken (under the delegation of section 10):**
      - **A roll back leaves the import's baseline and says so** (of the three the brief offered). A baseline is a
        record of what was published: re-recording from the rolled-back schedule would record a publication that never
        happened and make "Changes since publication" show no change where the families may already hold the imported
        games; clearing it needs a delete path the table does not have (`publication_baselines` has no write policy and
        `admin_publish_schedule_baseline` only inserts), so a migration this PR did not plan. The panel finds the
        baseline by its snapshot id after the roll back (from the result and from the upload step's "Roll back the last
        import") and says that version still describes the imported schedule and to choose another baseline in the
        report; a list that cannot be read says it could not be checked; an import that recorded none says nothing.
      - The result's buttons (roll back, import another, continue) wait while the baseline is recorded, so a roll back
        cannot race a recording. Reads that are still in flight after a minute (a team run still running is polled) and
        a chunk that cannot load are said as failed recordings, so the screen is never held.
      - Found by running the reader over the writer's output: "Changes since publication" could not read a game against
        an outside club (the club has no rows of its own, so the game is one row), for any baseline, the Exports page's
        included; every such game was "unreadable" and the comparison never a verdict. `buildChangesSincePublication`
        now reads a row with no partner whose opponent is exactly one outside club of its division as that game
        (lesson 110).
      **Review round (2026-11-13; Codex C1 and C2, one `/code-review high`), all taken:** the whole recording (the
      reads, the TIME TBD and directory reads, the rows, the write and the check after it) is bounded by one minute and
      always ends in an outcome; a recording given up before its write never writes. A write whose answer is refused or
      lost is followed by a read of the import's baseline by its snapshot id: found, it is said as recorded; the read
      failing, the outcome is said to be not known, with where to look ("Changes since publication" lists every
      baseline), never as "none"; only a clear miss says nothing was recorded. A failed or unknown recording offers
      "Record the baseline again", which asks for the snapshot first and writes only when it is absent. A chunk that
      cannot load is not kept (React.lazy keeps a rejected load for good, so the panel takes a new lazy part per
      attempt). Once the admin sets the box, a later stored mapping does not reset it. The recorder uses the app's
      client for every read and the write (`useDashboardData` and `usePublicationBaselines` read through it, as the
      Exports page's panel is handed it), so a baseline is never made from two clients. The roll back's look-up reads
      the one row by its snapshot id (`readBaselineBySnapshotId`, beside the hook); the recorder still mounts the list
      hook, because `publishBaseline` is only reachable through it without moving its body out of the hook. The
      sources a recording waits for, and their words, are the Exports page's (`MASTER_EXPORT_SOURCES`,
      `unreadableSources`, `describeSources` in `utils/masterExport.js`). The outside-club reading does not pair a row
      whose label also names one of the league's own teams in that division.
      **Known limit, left:** an outside club is matched by the club name and division the baseline row prints, so a
      club or division renamed after the baseline, or a game between divisions against a club, leaves that row
      unreadable, as every one-row game was before this PR. The real fix carries the opponent's id in the export,
      which changes the export's columns and is out of scope.

### PR 7: reports (M; no migration; Review: (a))

Depends on: PR 1 only (the audit rows and `get_schedule_audit_log`). G3 and G5 moved to PR 6, where the importer they
test and extend lives. Review (a): nothing here persists, writes through an Edge function, changes the solver or holds
import logic.

- [x] G1 (S) Day Sheet (5.1). [x] G2 (S) Coach schedule (5.1). [x] G4 (M) "Changes since publication" (5.6). Tests: as
      5.1 and 5.6, each with a case for a cancelled game and a TIME TBD game.
- [x] G2b (S, added 2026-11-06) Practices, and a multi-team marker derived from the team list, in the coach schedule
      (5.1, F17, decision 31). It reads `practice_assignments`, so it needs no import and no migration. Tests: as the
      last paragraph of 5.1.

Plants: the Day Sheet filters by a venue's display name, not its id; the coach schedule omits assistant coaches; the
Changes view enumerates from the changed rows only (a cancelled game vanishes).

### PR 8: add one game by hand (M; no migration; rule 14 for the write path it reuses; Review: (c))

Depends on: PR 3 and PR 5. Review (c) as a judgment call: it writes through `persist_game_schedule` and
`ensure_game_slot` over Published slots, which fits none of the four criteria strictly.

- [x] H1 (M) The dialog and the staged manual game (5.5). Test `tests/gameAddByHand.test.jsx`.

Plants: a game addable over a Published slot; a double booking blocked instead of flagged; a new game arriving Published.

**As built (2026-11-13; the pull request has the detail).** No migration, and no change to `persist_game_schedule` or
`ensure_game_slot`. The rules are in `frontend/src/utils/gameAddByHand.js`, the dialog is
`frontend/src/components/scheduling/AddGameDialog.jsx`, and the page stages the game into the review and, on Apply,
calls `ensure_game_slot` for a new time and then the existing save. Decisions taken here (within 5.5 and the owner's
answers; none adds scope):

- **One game per slot (review of #731, the coordinator's item 4; it replaces the first draft's "flagged" second game
  in a slot).** A slot that already holds a game, Published or not, is not offered as an open slot, and a new time
  that is such a slot is refused, naming the game in it and saying to move that game or choose another time. The grid
  draws one game per cell, and a schedule that hides a game is the worst failure here, so this is a necessary blocker in
  the owner's sense (2026-11-09, entry 2). A slot holding a Published or scored game says so in the hold's words
  (`holdReason`). The test is asked when the game is staged, against a second game staged at the same new time, and again
  on Apply against the slot id the database returns, since a new time can be an existing slot (`ensure_game_slot`
  finds one by field, date and start time). Two games of one pair at one place (pair, slot, week, the save's unique key)
  are refused before the save in the same words.
- **A new time that is an existing slot must be that slot as it is** (review item 2, as the practice import's
  slot-differs). If the field, date and start match a slot but the end differs, the new time is refused, naming the
  slot's end and saying to pick it as an open slot or choose another time; the slot's end is never taken silently. On
  Apply, a slot the database already had (`created: false`) is read back, because the RPC returns only `{id, created}`
  (`20261121010000_game_import.sql:736`). If its week, start or end differs from what the page worked out, Apply is
  refused in words and nothing is saved.
- **A double booking is flagged, never refused**: a team (not an outside club, which stands for several real teams, as
  the import rules) already playing, or the field already in use, at an overlapping time in another slot. Flagged in the
  dialog, in the conflict banner while staged, and in the saved run's `results.warnings`. After Apply on a generated
  review, the banner reads the generated snapshot with the flags added, which is what the run saved (review C3). A clash
  between two added games is said once. **A slot reserved for another division** is flagged the same way, not refused
  (owner: warnings, not blockers).
- **A new time's week** is `scheduleWeekOf(date, season_start)`, the import's rule. A date before the season starts (the
  date compared with the start itself first, as the import does: the week rounds back to the Monday, so an earlier day
  of the start's own week would otherwise be week 1; Codex C6), or a season with no start date, is refused (no week can
  be given). A daylight-saving gap is refused in the season
  clock's words. The form waits, with its reason, for two different teams and an end after the start.
- **Generating waits while an added game is staged** (review item 7): a new schedule replaces the review and would
  drop the game, so Generate is off with a visible reason until the review is applied or discarded. "Add a game" is off
  while the scheduler runs.
- **The list keeps the applied review until the saved schedule is read again** (review item 6). The slots an Apply
  made are read into the grid before the save, and the effect that copies the saved rows into the list does nothing
  while those rows are known to be stale (`savedIsStale`), so a slot read landing late cannot put the list back to the
  schedule before the save.
- **A new time is on the grid before Apply** (Codex re-review of #731, C4). In Manual Override, the review's pending
  new times are drawn as slots in the preview grid, under their own field and labelled "(new time, made on Apply)", so
  the added game has a card that can be seen and moved. They are shown, never offered: "Move to" and a drop still take
  only the season's real slots, and a pending time the game has left is no longer drawn.
- **Every flag of an added game is judged where the game is now** (C5): its slot's reserved division, its field and
  its times are read when the warnings are, never kept from when it was added, so a move into a reserved slot raises the
  flag, a move out clears it, and Apply records what holds at Apply. A drop that would put two games in one slot is
  refused for an added game, either way round (the move handler's existing rule).
- **The saved summary is the summary of the games saved** (Codex C7): on Apply after a generation it is worked out
  again from the final review with the page's own `summarizeGameResult` (the function the save falls back to), keeping
  the generator's byes and unscheduled games, so a game added by hand is counted; the readiness panel reads the same.
- **Every slot of an Apply the page has not read is read before the save** (Codex C8): the ones it made, and one the
  database already had that another admin made after the page loaded, so the saved game's card has its row in Manual
  Override without a reload.
- **Apply is one sequence over resolved state** (Codex re-review of #731, C9 and C10; the root cause of four rounds of
  Apply findings). (1) Resolve the new times through `ensure_game_slot` and the checks, on a local copy of the review;
  (2) read every resolved slot the page does not hold, and on a failed read stop with the review untouched (its new
  times still pending); (3) work out the final games, their flags and their summary from the resolved review and those
  slot rows, through the same `warningsOfAddedGames` the screen uses; (4) save, the save told only of slots in that
  catalog; (5) only after a successful save, commit the slots, the games and the cleared review to the page. A failure
  at any step changes nothing on the page, and Apply again redoes every step (`ensure_game_slot` finds what it made).
  Still read from before Apply, by design: the generator's byes, unscheduled games and own flags, the saved games for
  the "left behind" note and the rollback, and the run's `slotCount` parameter (metadata; it does not count a slot the
  Apply made).
- **A later Apply keeps an earlier added game's open flag** (Codex C11). Once saved, a game added by hand is a saved game
  with nothing to say it was added, so each Apply carries forward the saved run's own added-game warnings. Each warning
  records the places it names (`details.places`, the save's unique key: pair, slot, week; jsonb in `results.warnings`, no
  schema change), because a new game has no id until it is saved. Each place finds the saved game, its id finds it in
  the final schedule, and the added game is judged again there against the games the warning named only. The warning is
  kept only while one of the same kind, on the same team or field, still holds between the same games; a game it named
  that is gone takes it with it. No other game is flagged (moves record no warnings).
- **What a generated Apply saved is never appended to** (Codex C12). The generated result's warnings stay the
  generator's own; the page keeps beside them what its last Apply saved, as two sets: the generator's warnings, saved
  unchanged and only while the review applied is the generated one (a later Apply of a move saves none of them), and
  the added games' flags, replaced on every Apply by the recalculated set (C11's carry-forward included). The banner and
  the readiness panel show the two.
- **Nothing is staged while the saved schedule is read** (C12 follow-up). After an Apply or a rollback, until the saved
  schedule is read again, Apply, a move (a drop or "Move to"), "Add a game" and generating all wait, the reason said in
  words; a change staged from the rows before the save would carry them into the next one, and the next save carries
  its flags forward from the saved run. The schedule counts as read only once both reads of the re-read have settled:
  it is two reads (the latest run, then the games of the run on screen), and the games of the OLD run (what the save
  left in it) can answer first, which put the list briefly back to them, as `rekeyReview`'s marker already allows for.
- **Every save works out the added games' flags, in one place, with every partner** (Codex C13, C14). There is no
  durable mark that a saved game was added by hand: `game_assignments.assignment_source` is `auto` or `manual`, and a
  move writes `manual` too, so deriving the flags from it would flag every moved game. So the carry-forward stays, but
  the save itself (`persistReviewedAssignments`) works the flags out, from a context every caller must give (the slot
  rows, the replaced run's flags and its games): Apply gives the run on screen, and a rollback gives the run it
  restores, captured when the Apply it undoes was made, so a restored game keeps a flag that still holds. A clash names
  every partner, one warning each (each team's every overlapping game, the field's every overlapping game), so
  resolving one never clears another.
- **No field-overlap flag over a game the generator dropped** (examined, not a defect). A probe added a game on South
  Field over the hour of a saved, unpublished game and got only the team flag. The regenerated review no longer held
  that game (the generator re-solves unpublished games and placed none in that slot; it stays in the old run), so the
  field was free in the schedule being saved, and both flags read the games' own times, which the review carries (a
  generated game takes its slot's times in `buildDisplayAssignment`).
- **Divisions offered** are those that play games; their teams are the run's teams and the season's outside clubs.
- **A failed save after a slot was made** keeps the slot and names it in the error. When the outcome is unknown (a
  timeout, an unreadable answer) the error says instead that whether the game was saved into it is being checked. The
  review is left as staged, and a second Apply finds the slot rather than making it again.
- **Plant evidence** (executed, 2026-11-13, re-run in full after the review round): thirty-eight plants after the
  seventh Codex round, each but one turning its cases red against the 51 cases of `tests/gameAddByHand.test.jsx`, the
  restored code green. C13 and C14's four: the first team partner only (1 red), the first field partner only (1 red), a
  rollback with no carried flags (1 red), the save leaving the added games' flags out (10 red). The C12 follow-up's two:
  moves left enabled during the read (1 red), the old run's rows taken as the saved schedule (1 red). C12's five: the
  generator's warnings saved on every Apply (2 red), that with the manual flags appended to the generated result again,
  the old behaviour (2 red), the shown set appended to (1 red), Apply not off during the read (1 red); and the manual
  flags appended to the result alone stays green, because nothing reads the result's warnings after an Apply now
  (said, not hidden). Item 5's plant was re-aimed at the new code (the applied flags left out of what is shown, 3 red),
  and round 4's R1 (the flags judged on the slots from before resolution, 1 red). C11's four: no carry-forward on the
  page (2 red), the carried flags dropped in the pure rule (6 red), a carried flag kept as saved, not judged again (6
  red), one judged against the whole schedule rather than the games it named (1 red). The plan's three: a Published
  slot addable (4 red), a double booking blocked (11 red), a new game arriving Published (6 red). The E2E
  refusal scenario fails under the first. "Arriving Published" is caught on the staged game; once saved, the database
  cannot be told to publish it through this save, so the post-Apply assertions hold under that plant too (said, not
  hidden).

### PR 9: Practice import I, the fixture and the pure core (L; no migration; Review: (c); added 2026-11-06)

Depends on: PR 4 merged (it shares `scheduleImport/`'s helpers and the fixture conventions); decisions 19, 21 and 30.
Rule 14: no (pure code and fixtures; nothing is persisted). Owner cost: none open (decisions 19, 21 and 30 are answered); no file from the owner
(the fixture is invented). Review (c) because it holds the matching, alias and settings-proposal logic in core and the
probable-move pairing.

- [ ] J1 (M) `scripts/build-practice-fixture.mjs`, `fixtures/practice-schedule-2026/` and
      `tests/practiceScheduleFixture.test.js`, as 4.11.7: the shape counts; every name placeholder-shaped; every plant
      counted independently from the CSV; the pre-plant copy counts none; `--check` clean; `practice-invalid.csv`
      reaches every refusal reason.
- [ ] J2 (L) `packages/core/src/practiceImport/` (`parseRows`, `slotKey`, `mapping`, `aliases`, `probableMoves`, `reasonCodes`,
      `index`), registered in the core index: days, times (both forms, `12:00 AM`, `12:30 PM`), `End` versus `Length`, a blank
      `Team` as an open slot, `Use = hold`, the closed refusal reasons of 4.11.4, label normalisation through
      `normaliseExternalLabel` (shared with PR 4), mapping and alias proposals (4.11.5), the division-settings proposal, and the probable-move pairing (4.11.6): a pure
      function over the two lists a dry run returns.
      Tests: `tests/practiceImportParse.test.js` (every refusal reason; trailing whitespace folds to one team; a label
      that differs only by a word stays two; run under two other `TZ` values), `tests/practiceImportMapping.test.js` (an
      ambiguous label is never auto-mapped; an alias that disagrees with an exact match shows both and chooses neither;
      the previous job's mapping is a proposal only), `tests/practiceImportSettings.test.js` (the most common count per
      team; a tie proposes nothing; mixed lengths propose "any"), `tests/practiceImportProbableMoves.test.js` (pairing at team
      level, "team X: N rows leaving, N arriving"; **the swap case**: two days exchanged give one team-level pair and
      never an ambiguous 1:1 pairing; the new rows of a probable move are **unticked by default**; a team with rows on one
      side only is not paired).
- [ ] J3 (S) Docs: the fixture README, and one dated paragraph in `docs/operations/ingestion-pipeline.md` (the practice
      file's columns).

Plants: the parser reads a stray-space label as a second team; an alias proposal applied over an exact match; a team on
two halves silently merged into a whole-field row. Stop and report if: the real-name guard or the source-hygiene test
fails on a fixture file; the produced shape falls outside the targets of 4.11.7 and the script cannot bring it inside
(report the produced numbers); `normaliseExternalLabel` cannot be shared with PR 4's module without a cycle.

### PR 10: Practice import II, the database (L; migration; rule 14; Review: (c); added 2026-11-06)

Review (c) because it holds a migration, accept-and-flag past the gate and the additive re-import.

Depends on: PR 5 merged and deployed (the shared lists and the team-shell step) and PR 9 (the fixture); decisions 20, 22,
23, 24, 25 and 26. Owner cost: none open (those decisions are answered); one migration to deploy before PR 11 opens; CI minutes for pgTAP and the
harness plants (no local stack is asked of the owner).

- [x] K1 (L) Migration: `practice_schedule` through the lists of 4.11.8; `map_practice_import_job` (a sibling of PR 5's,
      not a generalisation: rule 2); `ensure_practice_slot` (internal); `apply_practice_import_job(job, dry_run)`;
      `rollback_practice_import_job(job)`. **No change to `persist_practice_schedule`, its gate, or any column of
      `practice_assignments`.** `docs/sql/<v>_revert.sql` (drops the functions and the CHECK entries; imported practices
      stay, losing their records, so roll an import back first) and `_smoke.sql`; `supabase/catalog-snapshot.json`
      regenerated; the harness plants re-aimed (lesson 70).
- [x] K2 (L) **Before the migration, report two things.** (1) EVERY code path that creates practice slots, with file
      and line, and for each whether it can bring a held time back as open capacity (decisions 28 and 29). The
      preliminary static review is **not complete**: `finalize_field_import_job` (latest definition in
      `20261101010000_one_active_season.sql`, around line 1464) inserts `practice_slots` rows from field-import rows
      that carry explicit day, time and capacity, and the Field Management save path was not traced. If any path
      creates slots from field availability, flag it to the owner in the PR description. (2) The input design for an
      unticked probable-move row (4.11.6): how it reaches `apply_practice_import_job`; this is the PR's first design
      task. **Then** `supabase/tests/practice_import_apply_rollback.sql` and the census updates (4.11.8), red against
      today's code; then the migration. Cases (the unticked-row input of (2) in both states, ticked and unticked,
      among them): a dry run changes nothing (every table read back byte-equal); apply counts
      equal dry-run counts over one file that reaches every outcome (each non-zero first); the five gate rules reported
      for `manual` rows and equal to the fixture's independent counts; the writer's own gap (finding 13) shown as a fact;
      `coach-conflict`; a re-import inserts nothing; every row that existed before is byte-equal after an apply, a
      re-import and a rollback; a save after an import prunes and moves nothing, and a team short of its count is on the
      TIME TBD list and gets units from `planTeamsForRun` while the others stay `locked`; the same canonical `daterange`
      text as the writer's; rollback refuses after a change, an exception or a completed season and succeeds before; a
      no-user job, a cross-organization job and a completed season are refused; shells land in a team run (PR 5's two
      checks of 4.5); `practice_slot_conflicts` refusals are listed.
- [x] K3 (S) The mock finalizer mirrors apply, dry run and rollback. Test `tests/mockPracticeImport.test.js`: the fixture
      through the mock equals the pgTAP's expected counts.
- [x] K4 (S) Docs: `docs/operations/ingestion-pipeline.md` (a practice schedule section; section 2.3's "15 minutes"
      corrected to the turnover of 0), `docs/architecture/practice-scheduling.md` (a dated paragraph),
      `docs/architecture/gotsport-import-contract.md` ("Practice schedule import: kept fields").

Plants: the dry run's sentinel removed (it writes); `ON CONFLICT ... DO NOTHING` removed (a re-import fails or
duplicates); the flag step calls the gate for `auto` rows only (the fixture's `manual` rows go unflagged). Stop and
report if: `practice_new_auto_row_refusals` cannot judge a `manual` row (smallest input: one team, one slot of capacity
1, two `manual` rows); `refresh_schedule_tbd_practices` cannot be called from the apply (smallest input: one season,
one team short); the sentinel dry run cannot return the flag list; any existing practice pgTAP file moves; a second
migration is needed.

**As built (2026-11-13, statically written from the branch; the gates and their numbers are in the pull request).** Migration
`20261123010000_practice_import.sql`; revert and smoke under `docs/sql/`; pgTAP `supabase/tests/practice_import_apply_rollback.sql`
over the shipped fixture (`_practice_import_fixture.sql`, generated from core by `tests/helpers/practiceImportPgtapFixture.js`);
the mock `frontend/src/lib/mockPracticeImport.js` and `tests/mockPracticeImport.test.js`; the staged row is core's
`toStagedPracticeRow` (`packages/core/src/practiceImport/staging.js`). K2's two reports:

1. **Every code path that creates practice slots** (latest definitions, read 2026-11-13): `finalize_field_import_job`
   (`20261101010000:1464`, an insert from a fields-CSV row that carries an explicit day, start, end and capacity; it also
   updates a slot it finds by key, from the same row); `start_demo_session` (`20261114010000:313`, the demo league's seed);
   and now `ensure_practice_slot` (this migration, from a practice-file row with an explicit day and times).
   `admin_set_practice_slot_division` and `rollback_field_import_job` update slots and create none; Field Management's RPCs
   (`admin_create_field`, `admin_update_field`, ...) and the field availability import create none; no Edge function or
   client code inserts one. **No path creates a slot from field availability**, so none can bring a held time back as open
   capacity (decisions 28 and 29).
2. **The input for an unticked probable-move row.** The database enforces the default: the apply lists the saved rows the
   file does not hold (`leaving`) and the file's new rows (`arriving`), and an arriving row of a team that also has one
   leaving is a probable move and is **not inserted unless its row key is in the job's stored mapping**
   (`map_practice_import_job`, `options.add_moved_rows`, the ticked rows). A client that sends nothing gets the safe
   default (unticked). Its slot is still made (supply). **Dates (review round, 2026-11-13):** a saved practice is
   `leaving` only when its range, cut to its slot's validity, meets the file's first-to-last date for that team (a team
   the file does not place has nothing leaving), and a new row is a probable move only when it meets the dates of one
   of its team's leaving rows. So a spring file for teams the solver placed in the fall inserts normally, and a move
   within the same dates is held back. Core's `pairProbableMoves` pairs at team level and sees no dates: PR 11's panel
   shows the database's `probable_move` and `added`, and does not pair again (`tests/mockPracticeImport.test.js` holds
   the two equal on the fixture's move, where the dates meet).
3. **Review round (2026-11-13), the rest.** The apply judges the job after its locks (a second caller replays a
   completed job), applies only a `ready_to_apply` job (the mapping can be stored while it imports, as the games
   mapping can), refuses a row whose found slot differs in End, Capacity or Valid Until (`slot-differs`, the slot never
   changed), and the parse refuses a blank Location, Field or (on a placement) Division as that row's reason.

### PR 11: Practice import III, validation, the Practices tab, E2E (L; Edge and UI; rule 14; Review: (c); added 2026-11-06)

Review (c) because it holds an Edge write path and the import panel.

Depends on: PR 6 (the shared Import panel) and PR 10 merged and deployed. Owner cost: one E2E feature in CI; after
merge the owner may try a real file in their own session (a dry run, then roll back); the plan never asks for the file.

- [x] L1 (M) `import-validation` accepts `practice_schedule`: the allowlist, Zod rows, the 2,400 cap, the header aliases
      of 4.11.2, no instant conversion. Tests: a Deno test and a vitest twin (days in every accepted form; `TZ` set to two
      other zones to prove the host zone is not read); a 500-row chunk timed with coverage on (lesson 59).
- [x] L2 (L) The Practices tab of the Import panel (a `kind` of PR 6's panel, not a copy): upload; mapping with its
      proposals and their sources; the division-settings proposals, one tick each; the confirm list (everything to be
      created, with counts, and "venues created here have no coordinates"); the preview from the dry run (flags by rule,
      the coverage sentence, teams short of their count, and the probable moves as team-level pairs, "team X: N rows
      leaving, N arriving", the arriving rows **unticked by default** and only a ticked row sent); the result; rollback. Accessible, both themes, no colour-only
      state. Tests: `tests/practiceImportPanel.test.jsx` (nothing is created without the confirm; each unmapped row is
      listed with its reason; only a ticked division setting is sent; the pairs are shown with their rows unticked by default
      and an unticked row is not sent).
- [x] L3 (S) `tests/practiceImportPreviewResult.test.js`: the preview's counts and flags equal the apply's over one file
      that reaches every outcome (each non-zero first).
- [x] L4 (M) E2E `tests/e2e/features/practice_import.feature`: import the fixture, map with an alias file, see the flags
      and the short teams, confirm, see the practices locked, roll back; axe in both themes. After `bddgen`; only this
      feature locally. Whether the mock client can run the practice solver in E2E was not checked; if it cannot, the "a
      run fills the gaps" case stays in K2.

Plants: a label created without the confirm list; the preview's counts computed apart from the dry run; a division
setting sent without its tick. Stop and report if: PR 6's panel cannot take a second kind without a rewrite (flag the
refactor first: rule 2); the mock cannot answer the dry run.

**As built (2026-11-13, written from the branch; the gates and their numbers are in the pull request).** No stop condition
held: PR 6's panel took the second kind (its `KINDS` entry `practices`; the shared flow reads the few games-only
expressions through the kind: the header check, the confirm counts, the last-import and roll-back sentences), and the
mock answers the dry run with every outcome. L1: `supabase/functions/_shared/practice-import.ts` (a mirror of core's parse
and staging, held to it by `tests/practiceImportEdgeParity.test.js` over a vector table built from core,
`_shared/tests/fixtures/practice-import.vectors.json`, and by `_shared/tests/practice-import_test.ts` under Deno) and
the `practice_schedule` arm of `import-validation` (stage only; no shared helper changed). L2: the panel's practices kind,
its steps in their own chunk (`PracticeImportSteps.jsx`), the client `frontend/src/utils/practiceImportClient.js` and
`practiceImportMapping.js`, the Practices tile and its template. L3 and L4 as written. The decisions, by the owner's
requirements of the PR 10 review and by this PR:

1. **The probable moves are the database's.** The preview shows the dry run's `probable_move` and `added` (the database
   scopes "leaving" by dates); the team-level line "team X: N rows leaving, N arriving" is grouped from the rows the
   database flagged (`practiceProbableMoves`), and core's `pairProbableMoves`, which sees no dates, is not called. A
   spring file over fall practices pairs nothing (tested in L3 and L2).
2. **Ticks.** A "Tick all probable moves" control and one tick per team (the plan's unit is the team-level pair, so no
   row-level tick); arriving rows open unticked; only ticked row keys, and only of rows the dry run flagged, go into
   `options.add_moved_rows`. A tick is stored only by making the preview again ("Update the preview with these ticks"),
   and the confirm waits for it, so the confirmed counts are always a dry run's. The case is named in words: "These teams
   already have saved practices in these dates; their new rows are held back until you tick them."
3. **The whole file is one request**, not 500-row chunks: the parse judges the file as a whole (`team-in-two-divisions`,
   `duplicate-row`) and the SQL requires a row key unique in the file; there is no clock, so the 2,400-row cap stages in
   about 90 ms with coverage on (500 rows: about 14 ms).
4. **The confirm step's two dates (decision 25) are asked on the upload step**, because the parse fills a blank Valid
   From or Valid Until when the file is staged; changing them means choosing the file again.
5. **The confirm is the Edge function's** (`import-validation`, `action: 'apply'`; review round): it runs the dry run
   again as the admin, compares its counts with the confirmed ones and applies only when they hold, else answers
   `practice_import_preview_stale` with the fresh preview and writes nothing (`applyPracticeImportConfirmed`, a sibling of
   the games one, which is not changed). A file is staged only into a job still `importing`, so a ready job is never
   emptied and staged again.
6. **Division settings are saved after the apply, for existing divisions only**, through `admin_upsert_division_settings`
   with the division's other rules sent back as stored (the RPC sets every rule it is given; a null clears it). The
   division is read again just before the write and the save is refused, in words, when its roster rules are no longer
   the ones the import read. Then the TIME TBD list is counted again and read back, and the result shows the teams short
   as counted with the saved settings (or says its list is from before them). A division the import creates is offered
   no setting (a setting would make the rollback keep it as changed): the screen says to set it on the Team Analysis page
   after the confirm. The confirm list and the rollback say that a rollback does not undo a saved setting. **Follow-up:**
   an RPC that sets a division's practice settings alone, without the roster rules, would end the read-then-write.
   **Resolved (2026-11-13, F11-4b of `docs/changes/2026-11-13-settings-scope.md`):** the import saves through
   `admin_set_division_practice_settings` (migration `20261124010000`), which changes only the two practice columns; the
   read before the write and its `division_rules_changed` refusal are gone.
7. **The confirm list** names every record to be created and counts the practice slots, and the confirm is refused until
   it is ticked; venues and fields created have no coordinates, said beside the list.
8. **Every reason in words**: the reason's sentence and the database's own message with record ids taken out
   (`slot-differs` names what differs; the blank-cell reasons; a hold's `ground_known`; `coach-conflict`), the flags by
   rule, the coverage sentence with the coach-judged teams, and the teams short of their count.
9. **Mechanical moves** (no behaviour change): `Notice` and `NamedList` moved from the panel into
   `components/import/importParts.jsx` so the steps chunk shows them too; the panel's games-only code is unchanged and
   its 45 tests are unchanged and pass on the base and the branch alike. **Lazy:** the practice steps, the practice
   client and the practice parser are chunks of their own, loaded when the Practices tab uses them; first paint is
   281.08 KB gz against 281.09 on the base, and the Games tab's own chunks grow by about 2 KB gz (the kind's words).
10. **Review round (#732: three Codex findings and one review).** A repeated column in the alias file refuses it; a
    ground only a hold names is stored as its exact existing ground (a hold creates nothing), so the database knows it
    and flags a hold over a slot; a `map` that leaves its label's scope goes back to undecided in the choices, the scope judged with the proposal
    made again under the updated choices at each level (Codex's C4: a location remapped to another with a field of the
    same name moves that field, and a half chosen under it goes); a file of more than 200 columns is refused
    (`too-many-columns`, by the parse in core and the mirror, and by the client before a job is made), never cut, so a
    Team past the cap cannot turn a placement into an open slot (C5; the games import cut its header row at 200 the
    same way, a follow-up: **resolved 2026-11-13**, #734: nothing cuts the games header row; the browser sends only the
    columns the import reads, found by name, so a wide file imports whole, and more than 200 headers sent is refused
    behind it, `too-many-columns` in core and the mirror and a 400 of the Edge request shape. Whether the practice
    import should read by name as well, rather than refuse a file of more than 200 columns, is open); every probable-move team has its own tick, the first 25 listed and "Show all N teams" for
    the rest (C6); a team the import creates is named on the TIME TBD list by the dry run's or the apply's own
    `arriving` rows (C8); every test of PR 11 that reads the date pins it (the world's `pinWorldClock`, the E2E's
    `page.clock.setFixedTime`; the TIME TBD rebuild counts only practices that end after today, so the E2E broke after
    the fixture's 2026-11-20 end, C7); the stage
    answers `bad-date` only for `PracticeImportDateError` and audits and rethrows anything else; the words helper catches
    nothing; the header-to-column map is made once per file in core and the mirror; the clients share
    `utils/importClientCommon.js`; the panel's kind checks are `KINDS` fields (`Steps`, `takesDates`,
    `recordsBaseline`, `uploadNote`), with only `data-kind` left reading `kind`.
11. **A defect of PR 10's mock, fixed**: a division the mock's apply created had no `program_id` (the SQL's trigger fills
    it), so the mock's read-time program backfill changed the row and the rollback kept the division as changed. The
    games mock creates divisions the same way and was not changed (follow-up). Lesson 112.

The "a run fills the gaps" case stays in K2, as the plan allowed: the E2E sees the practices saved and locked in the
result's words and does not open the Practices page.

### PR 12: Paired days, same slot (L; migration; the practice solver; rule 14; Review: (c); added 2026-11-06)

Review (c) because it holds a migration and both solver twins.

Depends on: PR 9 (the fixture, for the golden) and PR 10 (the import's flag list); decision 27 = (a): built last, optional,
off by default, scope as 6.2. Owner cost: none open (decision 27 is answered); one migration to deploy; a golden re-tune the owner reviews (the season fixture and the demo league must
not move with the setting off).

- [ ] M0 (S, the first task) **Size the scope** (5.7, 6.2): the setting is optional at organization, program and division
      level, an unset level inherits and the most specific wins. Read the code of the day and write down where
      program-level settings are stored (`programs` has no settings columns, so that is a migration), the one resolver
      (built here, this setting being its first user), and how the gate, both solver twins and the Teams control read it.
      M1 to M3 are built to that sizing: the division value first, then the program and organization defaults through
      the resolver. If the storage cannot be carried by this PR's one migration, stop and report: it is a change to the
      plan (rule 14).
- [ ] M1 (L) Migration: `divisions.practice_pairs` and its CHECKs; `admin_upsert_division_settings` (14 arguments, by
      exact drop and create); the gate rule `pairing` in `practice_new_auto_row_refusals`. Revert and smoke; catalogue
      snapshot; plants re-aimed. **First** `supabase/tests/practice_pairing.sql` red: each CHECK, the settings refusal,
      the rule with its control (an unpaired second row refused; the first row of a pair, and the same shape with pairs
      off, accepted), and `practices_per_division.sql` and `practice_writer_v3.sql` unchanged.
- [ ] M2 (L) Both solver twins place a twin pair or neither (5.7). **First** the base's `sha256` over the season fixture
      and the demo league with pairs empty; then `tests/practicePairing.test.js` (core), a Deno test (Edge),
      `tests/practicePairingDrift.test.js` (the twins equal over a product of cases) and each interaction of 5.7 as a
      case. `tests/practiceUnplacedReasons.test.js` extended in both directions for `pairing`.
- [ ] M3 (M) The Teams page control, the import's `pairing-differs` flag, the repair row's `pairing-broken` flag. Tests:
      component tests; the import case in PR 10's pgTAP extended.

Plants: the pair placed non-atomically (one row placed, its partner left unplaced); the gate omits the partner-weekday
check; the settings RPC accepts `practices_per_week` 3 with pairs set. Stop and report if: output with pairs empty
differs by a byte from the base's; the drift test shows the twins disagree and the cause is not in this change; the TIME
TBD reason CHECK would need a new value (it should not: 5.7).

### PR 13: Capacity versus demand panel (M; no migration; read-only; Review: (a); added 2026-11-06)

Depends on: nothing; decision 29 (answered). Owner cost: a look at the panel's wording. Review (a): read-only, no
migration, no Edge write path, no solver change, no import logic.

- [x] N1 (M) `packages/core/src/practice/capacityDemand.js` and its Zod schema; the hook; the section on the Practices
      page (5.9). **Basis (decisions 28 and 29):** the panel states what its numbers are based on, counts every open slot,
      says that times held outside the app are unknown to it, and labels its verdict an upper bound; it makes no promise
      to leave held times out. Tests: `tests/practiceCapacityDemand.test.js` (the cases of 5.9, including `still needed` equal to
      `planTeamsForRun`'s units), `tests/practiceCapacityDemandPanel.test.jsx` (every read failed in turn; "not checked
      yet" before the inputs arrive; a 0-a-week division is not "short"; the basis sentence, the "held outside the app" sentence and the upper-bound label
      are on its face; axe in both themes).

Plants: the panel counts teams from the solver's output rather than the roster (a team the run lost goes missing); a slot
open to two divisions counted twice in the total; the length rule dropped. Stop and report if: `planTeamsForRun`'s
arithmetic cannot be mirrored in core without copying it (flag the duplication before doing it: rule 2).

### PR 14: A stored slot hold (HELD (owner, 2026-11-06); M; migration; the solver; rule 14; Review: (c) if it is ever taken up; added 2026-11-06)

**HELD (owner, 2026-11-06): do not start.** Decision 28 = (a), no stored hold. The text below is the design as drawn, kept
so it need not be re-derived if the owner lifts the hold. Review (c) if it is ever taken up (a migration and solver
changes).

Depends on (if the hold is lifted): PR 10 and PR 11; decision 28 changed to stored. Owner cost: that decision; the fifth
migration, so the previous four are deployed first.

- [ ] P1 (M) Migration: `practice_slots.hold_kind` and its CHECK; the gate rule `hold`; the Field Management control;
      the import's `Use` accepts the kinds (`clinic`, `event`, `other`) and stores the hold instead of only listing it.
      Revert, smoke, snapshot, plants re-aimed. **First** pgTAP red: a held slot refuses a new auto row, accepts a manual
      one, and the same shape without a hold is accepted.
- [ ] P2 (M) Both solver twins skip held slots; the capacity panel leaves them out and says "held". Byte-identical with
      no hold (the `sha256` taken first); a case in the drift test.

Plants: a solver twin that ignores the hold; the gate rule omitted; the panel counting held slots as supply. Stop and
report if: either solver twin reads slots through a path that bypasses the filter; the gate cannot be replaced without
moving more than three plants.

### Risks (watch / if it happens)

- **The guard blocks a legitimate flow** (field import rollback, team delete, season rollover). Watch: PR 1's census of
  writers (section 2) and the existing pgTAP files. If it happens: the refusal names the game; add the flow to the table
  in 3.3 with its own friendly check, never an exemption by role.
- **A forgotten override.** Watch: the "M with changes allowed" line and filter. If it becomes common: decision 11's
  alternative (re-publish after a save) becomes a follow-up; it needs no migration.
- **The carry-forward assumption: every save sends the whole schedule.** Watch: the only product callers of
  `persist_game_schedule` are the `game-persistence` Edge function and the core handler that names it
  (`gamePersistenceHandler.js:49`), fed by `persistGameScheduleReview` with the whole reviewed list (_executed_ search,
  section 11, control: pgTAP files name it); the omission refusal makes a partial save loud instead of silent.
- **External teams leak into team lists, counts, files and standings.** Watch: the PR 5 census (which includes the
  standings view). If a reader is missed: it is a
  flag-per-reader fix, not a schema change.
- **Importing hides existing games** if the carry-forward is wrong. Watch: the pgTAP case "the new run is the whole
  schedule". If it happens: roll the import back (the previous run's rows are restored).
- **DST and week-index errors silently shift games.** Watch: the named-date tests and the preview's derived weeks. Never
  guess a time in a gap.
- **The `games` split makes imported games invisible on team pages and feeds.** Watch: decision 12. The Day Sheet and
  the master export show them.
- **Two meanings of "override".** The Edge function already has an `overrides` field: a count of pending manual
  overrides that answers a save with 409 `blocked` (`game-persistence/index.ts:381-393`); the page sends none. It is
  unrelated and left alone. In this plan "override" means "allow changes to a Published game", and the UI says "Allow
  changes".
- **Two meanings of "published".** The Exports panel's "Published Baselines" and the new switch share a word on purpose;
  the UI says "Published baseline v3" for the record and "Published" for the switch, and the dialog explains once.
- **Performance.** One import of 574 games is one SQL call plus two chunks of validation; lesson 59: time the page and
  Edge tests with `--coverage` on the base and the branch before merging.
- **A second writer of `practice_assignments` (PR 10; added 2026-11-06).** The practice lock lives in the writer's body,
  not in a trigger, so any other writer is a place it does not reach. The import only inserts, and its rollback only
  deletes rows it wrote and nobody changed. Watch: the practice reader census and the case "every row that existed
  before is byte-equal after an apply, a re-import and a rollback". If a path that updates a saved row is found, stop:
  it is a defect in this plan, not a tuning question.
- **The import's flags are SQL, so a wrong flag is wrong everywhere (PR 10).** Watch: pgTAP requires the product's flags
  to equal the fixture's independently counted plants. If a rule is missed it is a one-function fix, because nothing
  else computes it.
- **The dry run takes the season lock and does the writes (PR 10).** Watch: its time with coverage on (lesson 59) and a
  save waiting behind it. If slow, the preview says how long it took; the lock is never dropped to make it faster.
- **Defaults hide intent (PR 11).** A division at one a week with no length is the column default and cannot be told
  from a choice (4.11.5). If a two-a-week file is imported without ticking the division settings, the page reports the
  teams over target and a run fills nothing; harmless, and the result screen says so.
- **The flat file is the owner's conversion step.** Watch: whether the owner can produce it in one step from the grid.
  If not, a grid reader becomes the next decision (21), at the cost of `.xlsx` and a layout parser.
- **Words.** "Locked" here means the writer's default for every saved practice; the lock toggle on the Practices page
  shows provenance, not a lock (the component says so). The import's result says "saved practices are locked" and the
  panel keeps "manual choice" for the toggle.
- **Pairing could surprise a team that is short a practice (PR 12).** Watch: the held-row cases. Off by default.

### Rollback

PR 1: its `_revert.sql` drops the trigger, RPCs and columns and restores the previous function bodies (production's
text); the flags are lost, which the revert's header says; the two `audit_actions` rows stay (harmless; audit rows keep
pointing at them). PR 2, 3, 4, 7, 8: code only, each reverts alone. PR 5: its `_revert.sql` drops the columns, RPCs
and CHECK entries; imported games stay but lose their provenance, so roll an import back **before** reverting. PR 6:
code only. PR 9, 11, 13 (added 2026-11-06): code and fixtures only, each reverts alone. PR 10: its `_revert.sql` drops
the functions and the CHECK entries; imported practices stay but lose their records, so roll an import back **before**
reverting. PR 12: its `_revert.sql` drops `practice_pairs` and restores the gate and settings function bodies from
production's text (lesson 87's method); the pairing settings are lost, which the header says, and practices already
placed stay. PR 14 (held): its revert would drop `hold_kind` and restore the gate; held slots would become ordinary open slots, which the
header would say, so list them first. A revert never runs automatically (`ci-cd.md`).

## 8. What already exists, but stronger

Nothing the spreadsheet has is lost; this is where SquadLogic already does the job as well or better, with the caveat
the verification found (finding numbers in brackets).

| The spreadsheet's piece                | SquadLogic today                                                                                                                                                             | Caveat, verified                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Round robin in the next free slot      | Circle-method round robin with byes, hosting sides by rotation parity, saved sides kept across runs, odd team counts (`gameScheduling.js:37-136`)                            | Regeneration replaces the whole visible schedule until PR 2 [3]                                                    |
| Home/away balance                      | Sides by rotation, `home-away-imbalance` warning, saved sides kept                                                                                                           |                                                                                                                    |
| Coach clashes                          | Every coach of every team (head and assistants), refused outright in generation, flagged per coach on a manual move, unplaceable games become TIME TBD with a reason         | Raw time overlap: **no travel buffer** (the example has a 20-minute setting; `waivers/coachTravel.js` unwired) [8] |
| Shared / overlapping fields            | A facility model with subunits, containment and effective dating; enforced for **practice** slots on import and in the practice solver                                       | **Not consulted by game generation** (header of `scheduleGames`) [8]                                               |
| Field availability and blackouts       | Per-field blackouts, closures, permits, availability windows; the Games page shows blackout warnings (`toBlackoutWarnings`)                                                  |                                                                                                                    |
| Fixed games                            | Becomes imported, Published, external-team games (PR 4 to 6)                                                                                                                 | New, not present (F7)                                                                                              |
| Frozen schedule + Changes tab          | Immutable publication baselines with versions, a parity check naming moved and removed games, an audit trail with actor and time (the Changes tab has a reason and no actor) | Parity needs a baseline; the per-game view is PR 7 (F8)                                                            |
| Conflicts tab                          | `evaluateGameSchedule`: team double-booking, coach conflict, field overlap, hosting imbalance, unscheduled matchups, shared-slot imbalance, on the Games page banner         | Detection stops at the first conflict per id in each check (`ARCHITECTURE.md:1539`): counts are lower bounds       |
| Games with no free slot                | TIME TBD with a closed reason list, kept visible and printed in the master export for both teams                                                                             |                                                                                                                    |
| Team Lookup                            | The team page with its schedule, per-team CSV/XLSX and `.ics`                                                                                                                | **Reads the legacy `games` table**, which no save fills [5, F11]                                                   |
| Master list / "Import" sheet           | Master export CSV/XLSX over the saved schedule; storage upload; coach welcome drafts                                                                                         | Built and sound; its source is `game_assignments`                                                                  |
| Multiple orgs, seasons, undo, security | Multi-tenant RLS, one active season, completed seasons read-only, rollback for coach and field imports, an audit row in the same transaction as every save                   |                                                                                                                    |
| Played games struck through            | Not present; scores live on `games` (Scores, standings), behind a setting                                                                                                    | Same split [5]                                                                                                     |

### 8.1 The practice side: what already exists, but stronger (added 2026-11-06)

Only what was read in the code (_statically reviewed_); the references are the ones in 2.1, 4.11 and 5.7 to 5.9.

| The spreadsheet's piece           | SquadLogic today                                                                                                                                                                        | Caveat, verified                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Fields and halves or sides        | A facility model with subunits; a whole field clashes with each of its halves, two halves never with each other, effective dating (`practice_slot_conflicts`, `20261029010000:140-196`) | The import creates slots through the same rule, so a clash is refused, not flagged (4.11.3)                                      |
| Daylight and sunset               | An unlit practice ends before sunset on the season's clock, one lit field may run past; past sunset is flagged and kept, unknown sunset is flagged (`practice-scheduling.md`, Daylight) | Flagged, never blocked (owner, 2026-10-27); a venue without coordinates reads "unknown", which a created venue does (finding 18) |
| Lighting overrides                | Per-field lighting overrides, with their own page (`PracticeLightingPage.jsx`, `practice-lighting-overrides.ts`)                                                                        | Not read by the import                                                                                                           |
| Practices a week and how long     | `divisions.practices_per_week` (0 to 7) and `practice_minutes` (15 to 240), read by the solver and enforced by the writer's gate for new auto rows (`20261105010000`)                   | Default 1 and any length, indistinguishable from "unset"; no pairing (F14)                                                       |
| Different days for one team       | A hard rule in the solver and, for new auto rows, in the writer's gate                                                                                                                  | It does not choose which weekdays (F14)                                                                                          |
| Coaches on two teams              | A coach's practices never overlap in the solver (`practice-coaches.ts:311-316`); the import flags an overlap it is handed                                                               | The import judges only teams with a coach assigned; the Coaches page's `multi` badge is a stored flag (F17)                      |
| Coach choices                     | Coach preference rules, `prefer` or `must`, one rule per team, imported by file and judged per practice (`coachPreferences.js`); an accepted must is a hard rule                        | Priority is shown, never weighed. The workbook's 1st/2nd/3rd-choice legend has no verified equivalent; not read                  |
| "DO NOT CHANGE - PUBLISHED"       | Every saved practice is locked by default; it moves only through `unlock` with a reason and an audit row (`practice.unlock_accepted`)                                                   | No Published switch is needed for practices; the lock toggle on the Practices page is provenance (2.1)                           |
| Makeups after a closure           | Blackouts plus the practice repair and its enact RPC (5.10)                                                                                                                             | Not tested; whether it reproduces the owner's makeup grid is unknown                                                             |
| Conflicts at a glance             | The writer's five-rule gate, the solver's hard rules, and the run's per-team shortfalls; `get_schedule_tbd` lists short teams                                                           | The gate judges only new `auto` rows; no grid view of assignments exists (2.1)                                                   |
| The per-division planning summary | Not present before a run                                                                                                                                                                | F16 / PR 13                                                                                                                      |

## 9. Against the rules (checked)

- **AGENTS.md rule 14:** applies to PR 1, 2, 5, 6, 8, 10, 11, 12 and 14 (held); this document is the stop, and the owner
  agreed it on 2026-11-06 (section 10). The F11 plan is a second stop, before PR 5 (decision 12).
  **Global re-optimisation** is not introduced: regeneration re-solves the unpublished games exactly as it does today,
  and `reoptimiseWholeSeason` stays unwired; the pairing setting (PR 12) changes how the practice solver places new
  units for a division that opts in, and re-solves no saved practice.
- **Rule 2, minimal diffs:** no refactor is proposed. Costs flagged, not done: `persist_game_schedule` and
  `admin_delete_team` are replaced whole (a migration cannot patch a function), which moves their harness plants
  (lesson 70); the field import's find-or-create slot lookup is **copied into `ensure_game_slot` and
  `ensure_practice_slot`, not extracted**, leaving the duplication as a possible later refactor; `map_practice_import_job`
  is a sibling of PR 5's, not a generalisation; the practice import gets an additive writer rather than a new mode in
  `persist_practice_schedule`, which would replace that function whole (added 2026-11-06). The writer's gap in finding
  13 is reported, not fixed.
- **Rule 4, honest labels:** this plan labels every claim; the numbers about the owner's workbooks are _executed_ counts
  and say where they could not be reproduced (finding 9); the second workbook's brief figures that were not re-run say so.
- **Rule 5, trust boundaries:** every id is validated against the organization; the file is validated in the Edge
  function and again in SQL; no time is recomputed in SQL; no error is swallowed (the guard names the game); the
  practice file computes no instant at all and the alias file is read only in the browser.
- **Rule 6 and the Verification conventions:** each task names its test; each PR has at most three plants; subject sets
  are enumerated from the saved set, the roster or the code, never from the thing a break would corrupt (scope
  resolution, the audit's teams, the Changes view); "declared is not enforced" is answered by the coverage sentence;
  nothing is parsed and left unread (the `Format` and `Notes` columns are dropped, not stored); the adopted contracts
  are the siblings' (`unlock` and `GRID_OVERRIDE_REASONS`, the completed-season exemptions, `normaliseExternalLabel`,
  the evaluators' warning names). For PR 9 to 13: the import's flag counts are enumerated from the CSV independently of
  the product, and the product's flags must equal them (a check that can fail, with a pre-plant control); the capacity
  panel enumerates from the roster and the division counts, never from a run (lessons 46 and 92); the writer's five rules
  are reused by calling the gate, not copied; "declared is not enforced" is answered by the coverage sentence and the
  panel's face; `Use` is a closed value, so no free text is parsed and kept.
- **Core principles:** all persistence through RPCs; every payload validated by a Zod schema (A3, F1); every state change
  audited in its transaction; WCAG 2.2 AA with a non-drag path (section 3.6); backward compatible by default (the flag
  defaults off, `pinned` is optional, `is_external` defaults false).
- **Section 2 scope and privacy:** nothing is excluded by section 2. Admin-only throughout: the Day Sheet, coach schedule
  and duty list are admin pages and exports, never coach-facing views. Data minimisation: a games file keeps no
  coach, email, phone or free text; a coach schedule shows names, not contacts; the audit stores actor ids and reason
  codes. The practice file keeps no coach, email, phone or free text either, and the alias file holds names of places
  only. No real data in the repository: the fixtures are invented and the owner's workbooks stay outside. The Windows
  desktop version is not in scope.
- **Installs and dependencies:** none added; reading `.xlsx` would add one and is deferred past the dependency-update
  wave (decisions 8 and 21).
- **A departure from AGENTS.md section 3, now the owner's decision 16 (2026-11-06).** Section 3 asked for an adversarial
  review (`/code-review`) before every PR. The owner decided a content-based policy instead (section 7, "Review", and
  decision 16): a (c) PR opens without `/code-review`, gets the Codex review, then one `/code-review high`; an (a) PR
  gets a labelled self-review plus the Codex review; documentation, very minor and dependency PRs get no `/code-review`.
  This plan records it. PR 1's task A6 edited AGENTS.md section 3's review bullet and CLAUDE.md's Review bullet (a
  separate commit, landed in #707) so agents stop seeing a contradiction; no agent brief needs to name an exception now.
- **No ADR folder exists**, so the decisions are recorded here and, once settled, in `docs/LESSONS_LEARNED.md`.

## 10. Owner decisions

Each decision below keeps its options and the recommendation as offered; the owner's answer is in the block that
follows and in the "Answer (2026-11-06)" line under the decisions that carry one. **The hold is lifted (change 9
below).** No decision blocks a PR now. What still gates work: PR 14 is held (decision 28); the F11 plan before PR 5
(decision 12) was approved on 2026-11-07 and its F11-1 is merged.

### Owner answers (2026-11-06)

Two owner messages, the nine changes the review that followed agreed, and the answer table. The messages are quoted as
sent; only list markers and line breaks were normalised. Message 1 also had a "Hold" paragraph; message 2 supersedes it
and it is not repeated.

**Message 1 (the owner's answers).**

> Owner answers. All recommendations are accepted except where noted below.
>
> - 1: (a). Add helper text to the optional note field telling admins not to enter player names or other player PII.
> - 5: (A), one `is_external` team row per division + club label. PR 5's reader census and tests must show
>   `is_external` rows are excluded from:
>   1. team generation and empty-shell filling
>   2. game-generator round-robin pairing
>   3. roster and balance counts
>   4. coach compliance and unassigned-coach warnings
>   5. practice demand in the PR 13 capacity panel
>
>   Whether outside-club games count in LeagueStandings is an open policy item for me. Don't assume an answer in code or tests.
>
> - 12: (a), a separate small F11 plan before PR 7. Don't pick an approach in advance. The F11 plan must compare options against three criteria: one source of truth, scores survive regeneration of unpublished games, and game identity stays stable.
> - 16: (c) for every PR that contains any of these:
>   - a migration
>   - an Edge write path
>   - solver changes
>   - import diff, matching, or flagging logic (re-import keys, Published-row skipping, accept-and-flag, probable-move pairing)
>
>   I expect that to be PRs 1, 2, 5, 6, 8, 10, 11, 12. Check plan section 7 and add PR 4 and/or PR 9 if that import logic lives there. Give me the final list, with a one-line reason per PR, before PR 1 launches. All other PRs use (a): labelled self-review against plants and stop conditions, plus the Codex PR review. The one-line AGENTS.md section 3 PR is approved in principle but held under the hold below.
>
> - 21: (a) flat CSV. I'll flatten the grid outside the browser and outside the repo.
> - 24: (a), purely additive: no in-place updates and no deletes. The import preview must pair "in the schedule, not in this file" rows with "new in this file" rows for the same team and show them as probable moves. Over-counts still get flagged under Decision 20.
> - 28: (a). No stored hold, and PR 14 is skipped for now.
> - 29: (a). PR 13 must state what its capacity numbers are based on and leave held times out of available capacity. PR 10 must check and state whether any code path creates practice slots from field availability. If one does, that path could bring held times back as open capacity, so flag it.
> - B5.10: Not answering yet. Do a read-only review first: report where the current import stores years played, waitlist/registration state, and buddy requests. For each of `registration_status`, `experience_years`, and `buddy_request_name`, say whether it duplicates an existing mapping, is unused leftover, or has no equivalent. Label your findings as static review. Don't plan any work for them yet.
> - B6: (a), GitHub + transcript. This overrides your recommendation of (b). Record these answers in the commit described below.

**Message 2 (the reply to the review that followed).**

> Let's proceed with your changes and recommendations. If you have any thoughts on restructuring this to fit better into fewer PRs or sequenced in a more optimal order, you may do so without further approval from me. Code reviews aren't needed on documentation and very minor PRs, a single review AFTER addressing any Codex findings on a PR is allowed for relevant PRs. I accept your standings recommendation, and it should also be optional (most things should be, at the org, program, and division levels.)
>
> I'll do the manual testing after all of this, so you're also clear for any dependency updates at this point as originally planned for 11/5

**The nine changes the review agreed** (the owner accepted them as "your changes and recommendations"). The detail is
where each applies; this list is the index.

1. **Decision 5, outside clubs.** The standings question splits in two: (i) an outside club never gets a standings row
   (structural, no policy needed); (ii) whether an own team's result against an outside club counts toward its record is
   the owner's policy, and the recommendation is now ACCEPTED: excluded by default, optional, set at organization,
   program and division level (most specific wins; unset inherits), with a per-fixture override later. (ii) is
   implemented in the F11 plan, not in this wave. The exclusion list gains the practice solver, readiness panel and TIME
   TBD list, `view_org_metrics.total_teams`, and the Teams page, Team Builder, team exports and coach assignment; the
   census also needs the include side with positive tests; team-in-two-places checks do not apply to an external row.
   Detail: 4.6.
2. **Decision 12, F11.** The criteria are the owner's three plus a fourth: the standings policy of change 1. The F11 plan
   runs BEFORE PR 5, not before PR 7, because PR 5's migration adds `game_assignments.external_ref` (the Game ID) and
   defines re-import by it, and "game identity stays stable" could reject that design after it deploys. It is a separate
   document, needs the owner's approval (rule 14), is not "small" (scores surviving regeneration is a persistence
   question), and does not pick an approach in advance.
3. **Decision 16, final.** Review is by content: (c) for PRs 1, 2, 4, 5, 6, 8, 9, 10, 11, 12 (PR 14 held); PRs 3, 7 and 13
   use (a). The list, the one-line reasons and the process are in decision 16; the tags are in the PR headers of
   section 7. AGENTS.md section 3 and CLAUDE.md's Review bullet are edited in PR 1 (task A6).
4. **Decision 24, re-import of practices.** Purely additive. A probable move is paired at team level, not row to row; its
   new rows arrive UNTICKED by default; the pairing is a pure function in PR 9's core. Detail: 4.11.6.
5. **Decisions 28 and 29, reconciled.** With no stored hold nothing records a held time, so PR 13 cannot know a time is
   held: it counts every open slot, states that times held outside the app are unknown to it, and labels its verdict an
   upper bound; it does not promise to leave held times out (5.9). Excluding held times for real is PR 14, which is held.
   PR 10 must report every code path that creates practice slots (task K2). Preliminary static review, not complete:
   `finalize_field_import_job` (latest definition in `20261101010000_one_active_season.sql`, around line 1464) inserts
   `practice_slots` rows from field-import rows that carry explicit day, time and capacity; the Field Management save path
   was not traced.
6. **Settings scope principle.** Optional behaviours are configurable at organization, program and division level; unset
   inherits from the level above; the most specific wins. Applied to standings inclusion (the F11 plan) and the pairing
   setting (PR 12); play-down and the two "Published" switches are recorded as follow-up candidates, not planned. Detail:
   6.2.
7. **Decision 1, helper text.** The optional note in the "Allow changes" dialog (PR 3, C3) carries the helper text
   "Optional. Do not enter player names or other personal information." and a character counter (200). Audit rows have no
   per-row delete path and are pruned only by `prune_old_audit_logs` (180 days by default, set per organization), so a
   note persists up to that window; the helper text is a soft control, and the docs line says so.
8. **Restructure (delegated by message 2).** PR 14 is held: thirteen active PRs, four migrations, one below the limit of
   five. G3 (own schedule CSV) and G5 (record the import as a baseline) move from PR 7 to PR 6, where the importer they
   test lives, so PR 7 keeps G1, G2, G2b and G4 and needs only PR 1. PR 4 and PR 9 stay separate (merging them would make
   one XL PR with weaker review; considered and rejected). The fixed waves are replaced by a dependency table and one
   priority rule (section 7): a free slot takes the first PR, in the order PR 1; PR 4; PR 2; PR 5 (also needs the F11 plan
   approved); PR 3; PR 9; PR 6; PR 10; PR 7; PR 13; PR 8; PR 11; PR 12, whose dependencies are merged and deployed.
9. **The hold is lifted** (message 2: "Let's proceed"; manual testing moves to after the build; dependency updates are
   cleared). Restructuring inside the plan is delegated; new scope, a new dependency or anything outside the plan is not.

**The answer table.** Rows B1 to B7 are the owner's other items from the same review, kept as given; they are not numbered
decisions of this plan (B2 and B7 are reflected in the order of work at the top; B5.10 is pending a read-only review the
owner asked for, and no work for it is planned here).

| #   | Answer                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | (a); helper text on the note (change 7)                                                                                                   |
| 2   | (a) both per game and bulk                                                                                                                |
| 3   | (a) checkbox on by default                                                                                                                |
| 4   | (a) arrive Published, switch on the confirm step                                                                                          |
| 5   | (A) `is_external`, one per division and club label; census per change 1; standings per change 1                                           |
| 6   | (a)                                                                                                                                       |
| 7   | (a) own CSV now; TeamSnap shape after the owner supplies the template; GotSport only if asked                                             |
| 8   | (a) CSV now                                                                                                                               |
| 9   | (a) later, list only                                                                                                                      |
| 10  | (a) not in the solver                                                                                                                     |
| 11  | (a) no auto-expiry                                                                                                                        |
| 12  | (a) the F11 plan, moved before PR 5, criteria per change 2                                                                                |
| 13  | (a)                                                                                                                                       |
| 14  | (a)                                                                                                                                       |
| 15  | (a)                                                                                                                                       |
| 16  | (c), content-based, final list and process per change 3                                                                                   |
| 17  | (a)                                                                                                                                       |
| 18  | confirm as written                                                                                                                        |
| 19  | (a), the practice side after the games import; order restructured per change 8                                                            |
| 20  | (a) accept and flag                                                                                                                       |
| 21  | (a) flat CSV; the owner flattens the grid outside the repo                                                                                |
| 22  | (a)                                                                                                                                       |
| 23  | (a)                                                                                                                                       |
| 24  | (a) additive, with probable moves per change 4                                                                                            |
| 25  | (a)                                                                                                                                       |
| 26  | (a)                                                                                                                                       |
| 27  | (a) later (PR 12), optional, off by default, scope per change 6                                                                           |
| 28  | (a) no stored hold; PR 14 held                                                                                                            |
| 29  | (a), reworded per change 5                                                                                                                |
| 30  | (a)                                                                                                                                       |
| 31  | (a)                                                                                                                                       |
| B1  | no cap now                                                                                                                                |
| B2  | the order changed: dependency updates cleared now; schedule expansion; then the owner's manual testing; then the test audit; then desktop |
| B3  | as recommended (step 1 read-only), after the owner's manual testing                                                                       |
| B4  | (a) after the SquadLogic audit; a PR in another repo, ask again then                                                                      |
| B5  | items 1 to 9 as recommended; item 10 pending the read-only review (message 1)                                                             |
| B6  | (a) GitHub and the transcript (overrides the recommendation of (b))                                                                       |
| B7  | the owner's checks; manual testing moves to the end                                                                                       |

### Owner answers (2026-11-09)

The owner's answers of 2026-11-09, one dated entry each. Words in quotation marks are the owner's, as sent (only
whitespace is normalised: entry 2 had two spaces after "etc."); a line labelled "Consequence" is the agent's reading, not
the owner's. Nothing here adds a pull request, a decision number or scope; where an answer opens something unplanned, the
entry says so and plans nothing.

1. **2026-11-09, merging #712 (F11-1) without a completed Codex review.** "A - as recommended." Context (the
   coordinator's account, not re-run here): Codex failed six times on that PR; CI was green; one `/code-review high` pass
   and one independent read-only review of the fix round found no shipped-behaviour defect; #712 was merged on the owner's
   explicit word as `e5ce8b8`. Consequence: F11-1 is merged; PR 5 and F11-2 to F11-5 are next (section 14).
2. **2026-11-09, B5.10: what `registration_status`, `experience_years` and `buddy_request_name` are for** (the buddy
   request was answered earlier and is not restated). "Registration status allows players to be in the system, but not
   teamed, if they are currently on a waitlist or haven't yet paid. This gives better visibility into how many more
   players can be accepted anyways within the divisions teaming limits on team size/etc. The years of experience are a
   stand-in for skill level for many rec programs that do not establish skill ratings for players."
   **Follow-up, 2026-11-09 (later), on my recommendation to plan the registration-state and experience work after PR 5.**
   The owner: "As for the plan; your recommendation suffices here." And: "The registration_status should be almost
   unanimously "FALSE" in the Waitlist column for the initial import. In the real example, there's 36 "TRUE" waitlisted
   players and 1427 "FALSE" players that are not waitlisted and safe to team. No need for the payment guardrail, and this
   should be mappable upon import like other columns where a user can use a drop down to identify the correct mapping from
   their data to the program's value (with best effort matching that lists current recommendations where possible, which
   I think also already exists.) If info isn't present in the import data, relevant features like teaming with a balance
   of coaching leads or years of experience for players (as listed by registrants during registration, not held by this
   program) should be defaulted to off (or on, if available.)" The consequences below are the agent's reading, revised
   after the follow-up; they are **UNPLANNED and not decided** (no work is planned for them here). File references are as
   of `e5ce8b8`, read statically; nothing was executed.
   - (a) The signal is the platform's Waitlist column: TRUE is not yet teamed, FALSE is safe to team (counts from the real
     example, no names: 36 and 1427). That closes the earlier ask for the distinct values. A per-division "how many more
     players can be accepted" view, or any new stored registration state, would still be a domain-model and persistence
     change (AGENTS.md rule 14: a plan first). What the repository already says: the import maps `waitlist` and
     `waitlisted` to `status` (`docs/architecture/gotsport-import-contract.md`: "the waitlist status stays the teaming
     gate"); the finalizer stores `waitlist` for the values `true`, `t`, `yes`, `y` and `1` and `active` for anything
     else, blank included, while the organization's Waitlist setting is on, which is its default
     (`supabase/migrations/20261101010000_one_active_season.sql:475-476` and `:528-529`); generation seats nobody on the
     waitlist (`packages/core/src/playUp.js:74`); and `years_played` is stored as `players.years_played` (the contract:
     teaming reads it when the Years Played option is on). Whether `registration_status` and `experience_years` duplicate
     these is not decided here; `docs/changes/2026-11-03-drop-placement-eligible.md` ("Owner notes") records that the two
     columns are named only by `20260530000000`, its smoke and its revert, and that their production state was not read.
   - (b) My earlier payment-guardrail consequence is withdrawn: the owner says no payment guardrail is needed, because the
     column is Waitlist, not payment. Nothing here asks for payment data, and AGENTS.md section 2's scope rule is
     unchanged.
   - (c) Mapping at import (the owner wrote "I think also already exists"). Found, statically:
     - Auto-matching exists: `matchHeaders` (`frontend/src/utils/telemetryUtils.js:345`) matches a header by system key, a
       GotSport profile bias, the alias table `HEADER_ALIASES` (`waitlist` and `waitlisted` map to `waitlist` at
       `:171-172`; the server's own alias map does the same, `supabase/functions/import-validation/index.ts:217-218`), and a
       fuzzy match (similarity above 0.85) to the organization's declared custom fields; a match under 0.95 is listed as
       needing confirmation.
     - A dropdown mapper with "(suggested)" hints exists: `frontend/src/components/ColumnMapper.jsx` has a `<select>` per
       field over the file's columns with the matcher's pick marked "(suggested)" (`:350-367`), remembered per import type
       in localStorage (`:89`, `:217`).
     - It does not reach the Waitlist column as the owner describes. The mapper opens by itself only when a required column
       is missing (`frontend/src/components/ImportPanel.jsx:367-373`, `findMissingRequiredHeaders` in
       `frontend/src/utils/importHeaders.js`; a player file requires first name, last name and date of birth), or by
       "Adjust mapping" after the preview (`ImportPanel.jsx:1045-1057`); and its player fields are first name, last name,
       date of birth and skill tier only (`ColumnMapper.jsx:15-22`; the evaluations import adds years played and rating,
       `:32-44`). There is no Waitlist field to map to. So today a column counts as the waitlist only when its header
       reads as `waitlist` or `waitlisted`; a differently named column is not offered a dropdown for it.
     - NOT confirmed: that the real file's header is `Waitlist` (the file was not seen); that the setting "Fuzzy Data
       Alignment (AI)" (`fuzzy_import_mapping`, `frontend/src/components/settings/FeatureFlagSettings.jsx:41-44`,
       `frontend/src/constants/featureFlags.js:40`) does anything, since `git grep` finds no reader of it outside those two
       files; and any behaviour in a browser.
   - (d) Features that depend on optional import data (the owner: off when the data is absent, on when it is present).
     Found, statically:
     - They are organization settings: `years_played` on, `player_rating` off, `teaming_spread_coaching_leads` on,
       `coaching_interest` on and `waitlist` on by default (`frontend/src/constants/featureFlags.js:136-145`), and
       `skill_tier` off unless turned on (`:45-50`). An admin sets them; whether the file carried the column does not
       switch them, so "on if available" is not automatic.
     - Absent data is inert in what I read: the Teams page gives a generator player `years_played`, `skillRating`,
       `isCoachingLead` or `status: 'waitlist'` only when its row carries one
       (`frontend/src/pages/TeamAnalysisPage.jsx:897-902`); the coaching-lead deal does not apply in a division with no
       lead (`resolveLeadPolicy` returns null, "placement exactly as it was before B6",
       `packages/core/src/teamGeneration.js:1386-1396`; `countLeads`, `packages/core/src/coachingLeads.js:85`); and with
       the years signal on but no player carrying it, the lead compensation is 0
       (`packages/core/src/balanceSignals.js:55-62` and `:85-87`; `teamGeneration.js:72`).
     - The registered evaluators are `BuddyEvaluator` and `WeightedAttributeEvaluator`
       (`packages/core/src/evaluators/index.js`). The weighted one defaults to weights `{ skill_rating: 1.0 }` when none
       are given (`WeightedAttributeEvaluator.js:29-37`), reads an absent attribute as the league mean and treats equal
       values as neutral (`:43-60`); it has no switch for the data's presence. There is no evaluator for coaching leads or
       years played by name: those are the lead deal in `teamGeneration.js` and `balanceSignals.js`.
     - NOT confirmed: whether the Teams page feeds the Years Played setting into the evaluator's weights (in
       `packages/core/src` only `balanceSignals.js` reads `years_played`, and I did not trace the page's other uses);
       whether any screen tells an admin that a feature is idle because the column is missing; and any behaviour in a
       browser. `experience_years` as a stand-in for skill level stays a candidate evaluator input (the
       `squadlogic-evaluator-designer` skill; plan first).
   - (e) Still UNPLANNED. The owner agreed to plan it after PR 5 ("your recommendation suffices here"): it needs a
     plan-change (AGENTS.md rule 14), listed in section 14 as "plan: registration state and optional-data features (after
     PR 5)" with no PR number. The data-minimisation rule (AGENTS.md section 2) and the import allowlist
     (`docs/architecture/gotsport-import-contract.md`) still apply to any new stored field.
3. **2026-11-09, the upstream Tailwind report is filed** (reported, not a quotation):
   https://github.com/tailwindlabs/tailwindcss/issues/20685. Consequence: a Dependabot ignore for `tailwindcss` and
   `@tailwindcss/vite` 4.3.4 and 4.3.5, citing it (AGENTS.md rule 16), is a separate config-only pull request; the
   repository stays on 4.3.3.
4. **2026-11-09, B7 (the 2026-11-09 numbering, not the "B7" row of the 2026-11-06 table above): the official domain shows
   "Try the demo".** "Yes". Follow-up, 2026-11-09 (later), from the owner: "The vercel key VITE_DEMO_ENABLED was already
   set to true." Consequence: `VITE_DEMO_ENABLED` is set to true on the official Vercel project (owner, 2026-11-09), so
   nothing is left to set for it. The other steps of `docs/operations/release-prep.md` (3 to 5: Turnstile, the Vercel
   variables, Supabase anonymous sign-ins and CAPTCHA) are also needed for the demo: not verified by the agent.
5. **2026-11-09, manual testing of `main`.** "I'll do this a little later, I'd prefer we shore up more of the open work
   first." Consequence: no start date for the owner's manual testing; the open work comes first.
6. **2026-11-09, F11 unknown U2 (does a scheduling platform reuse Game IDs across seasons).** "Game IDs should be
   specific to each game, not reused, as to remain clear on what game is being affected during changes (such as venue or
   time change.)" Consequence: PR 5 keeps `external_ref` unique on `(season_settings_id, external_ref)`, which is safe
   either way; nothing else changes.
7. **2026-11-09, the non-blocking decisions.** "Agree" to the coordinator's recommendations:
   - The capacity panel leaves TIME TBD teams out of its reading, as declared on its face (no change).
   - The practice solver's `practice-length` reason for a right-length slot reserved elsewhere is left alone (the panel is
     more precise and a test pins the solver); fix it only if it confuses in testing.
   - `fetchAllPages` stops on a short page, and that assumption stays (`config.toml` `max_rows = 1000` equals the page
     size); revisit only if the cap is lowered.
   - The reports do not name a cancel or a save from the audit log now (revisit with F11-3).
   - The Changes note stays out of the CSV.
   - No XLSX for the coach schedule now.
   - No Published column on the Day Sheet.
   - The one-line refetch after a 409 `GAME_IDENTITY` on the Games page is folded into F11-3 (task C6 of
     `docs/changes/2026-11-06-games-table-source-of-truth.md`).
   - `publishedOmissions` and `changesPublishedPlacement` (no shipped caller since F11-1) are removed in F11-3 if still
     unused (task C7 there).

### Owner answers (2026-11-09 evening and 2026-11-10)

The owner's answers of the evening of 2026-11-09 and of 2026-11-10, in the same form as the block above: words in
quotation marks are the owner's, as sent; the rest of an entry is the agent's reading. Entry 6 is not an owner answer: it
lists what the coordinating agent decided under entry 5 while PR 5 was in review. Nothing here adds a pull request, a
decision number or scope; the tasks that follow from entries 1 to 4 are in section 7, under PR 6.

1. **2026-11-09 (evening), a TIME TBD game's date.** "Time TBD should hold a date only and no time on the game schedule."
   Consequence: implemented in PR 5 as `schedule_tbd.game_date` (migration `20261121010000_game_import.sql`); showing it
   is PR 6 (task F6).
2. **2026-11-09 (evening), swaps.** "For swaps - warnings, not blockers. We try not to introduce blockers unless
   necessary." Consequence, a standing principle: prefer a warning to a refusal. A blocker stays only where it is
   necessary: the Published, held or scored guard; a completed season; tenancy and auth; a malformed row that cannot be
   stored; a unique constraint that cannot be satisfied; a rollback that would destroy a later writer's work.
3. **2026-11-09 (evening), the remaining recommendations.** "Otherwise agree as recommended". That accepted:
   - An imported TIME TBD game stays listed until the next game save that carries an `unscheduled` list (PR 6 fixes it if
     the Games page shows it).
   - The team shells an import creates land in one team run.
   - `persist_practice_schedule`'s outside-club count is accepted until that function's next replacement.
   - The preview-stale protection is PR 6's (task F7).
4. **2026-11-10, `bad-time` and `bad-week`.** "agree with the recommendations on bad-time and bad-week". Consequence
   (PR 6, in core's parse; task F5): the parse turns a `bad-time` row into a dated TIME TBD game with a warning, and
   derives the week of a `bad-week` row from its date with a warning. Kept as row-level refusals:
   `outside-season-window` (no week can be derived); a `create` over a name that exists (the PR 6 mapping screen defaults
   to "map to existing" when a match exists; task F8); a TIME TBD swap or chain between the same teams (rare);
   `label-is-own-team`.
5. **2026-11-10, delegation** (reported, not a quotation). The owner gave the coordinating agent the call on questions
   that come up, in line with the recommendation it states. That includes merging a PR Codex cannot review (after an
   independent read-only review), F11-5 and PR 14: each is decided on its merits when its turn comes and recorded here.
   Not started until everything else is complete, and then in this order: the test-suite audit, then the desktop build.
   The repository's rules are unchanged: the hard exclusions (AGENTS.md section 2), CI the only writer of migrations,
   and the required checks green.
6. **2026-11-10, decisions taken under the delegation during PR 5** (the coordinating agent's, not the owner's):
   - The rollback refuses when a later change touched a TIME TBD row the import wrote (a necessary blocker, entry 2).
   - A record the import created that was edited since is kept and reported.
   - A run the rollback keeps is retired from current-run selection.
   - Two source rows that resolve to one saved game refuse the tuple-matched row as `duplicate-row`.
   - A stored Game ID is never erased by a row that omits it.
   - Accepted and documented edges: re-inserting a game the apply took out, where its place or Game ID was taken since,
     raises a raw unique violation (atomic, nothing lost); a game a later writer saved into the import's own run is
     hidden once that run is kept and retired, until the next save or import.

### The thirty-one decisions (as offered, with the answer under those that carry one)

1. **Who may override, and what it needs.** Recommended: any `is_org_admin` (admin, tenant admin, staff, as every
   schedule write), signed in (no service role), a reason from the closed list (`field-change`, `coach-request`,
   `conflict-fix`, `published-in-error`, `other`), and an optional note of at most 200 characters. Alternatives: (b)
   admin and tenant admin only, not staff; (c) the picklist alone, no note (the practice grid's choice, and the safest
   for data minimisation, since a note can carry a name). Turning the flag **on** needs nothing.
   **Answer (2026-11-06):** (a), with helper text on the optional note ("Optional. Do not enter player names or other
   personal information.") and a counter of 200 characters (PR 3, C3; change 7 in the block above).
2. **Per game, or in bulk.** Recommended: both, with bulk scopes of all unpublished, one division, one date, one venue,
   resolved from the saved set and capped at 2,400 games a call. Alternative: per game only (smaller; a league of 574
   games would click 574 times).
3. **Should the Exports panel's "Publish" also mark the games Published?** Recommended: yes, a checkbox, on by default.
   The baseline stays the evidence; the flag is the guard. Alternative: independent acts (more clicks; a published
   export whose games are still movable).
4. **Do imported games arrive Published?** Recommended: yes, on by default, with a switch on the confirm step. This is
   the owner's "already generated schedule" case: a regeneration must not disturb it. Alternative: arrive unpublished and
   publish after review.
5. **How an outside-club opponent is represented.** Recommended: a flagged team row (`teams.is_external`), one per
   division and label (4.6). Alternatives: a nullable side with a label (widest blast radius); a field hold only (loses the
   own team's fixture).
   **Answer (2026-11-06):** (A), one `is_external` row per division and club label. PR 5's census and tests must show the
   exclusions and the include side of 4.6; standings are split (change 1): an outside club never gets a standings row,
   and whether an own team's result against an outside club counts is the owner's policy, accepted as excluded by
   default and optional at organization, program and division level, implemented in the F11 plan.
6. **May the import create team shells, divisions and fields from the file?** Recommended: yes, only on the confirm
   step's explicit list; shells through the existing team writer so a later generation sees them; divisions by name with
   no age band and a visible flag; fields by name with no availability and a flag. Alternative: refuse unless
   everything exists (safest, but defeats "orgs may come to this to manage an already generated schedule").
7. **Which export formats.** Recommended: SquadLogic's own schedule CSV now (PR 6, task G3, the import format, so it round-trips);
   the TeamSnap organization shape later, after the owner supplies the downloaded current template (its header row is
   not public on the help pages); the GotSport event shape only if asked. Alternative: build both platform shapes now
   from the help pages (not recommended: the TeamSnap header row would be guessed).
8. **CSV or `.xlsx` for the import.** Recommended: CSV (the workbook's `Import` sheet saves straight to it). Reading
   `.xlsx` is a new dependency in the browser (the repository only writes it, with `write-excel-file`), best taken
   after the dependency-update wave and flagged in its own PR. Alternative: read the workbook's `Schedule` sheet now.
9. **Duty roster: list only, or assign?** Recommended: later, list only (field, day, set-up and take-down times, the
   teams on the field), no automatic assignment. If the owner wants assignment: fairness first (5.2).
10. **Early/Late.** Recommended: do not put it in the solver; generation already refuses a coach overlap. Alternative: a
    per-team tag shown as a flag on the Day Sheet. Not recommended: a soft preference in `scheduleGames` (rule 14, a
    stored value, a golden re-tune).
11. **Does an override end by itself?** Recommended: no. Changes stay allowed until someone publishes again; the page
    shows a count and a filter. Alternative (the practice writer's behaviour): the games are Published again after the
    next save, which cannot be forgotten but surprises an admin who saves twice.
12. **The legacy `games` table versus `game_assignments`** (F11, finding 5). Recommended: a separate plan, run **before
    PR 5** (changed 2026-11-06 from "before PR 7 if possible"; see the answer), to point the team page, the per-team files, the feed, Scores and standings at the saved schedule
    (or to materialise `games` from it). Not folded in here because it is a choice between three designs. Alternative:
    leave it, and tell the owner that team pages and feeds do not show a scheduled league's games.
    **Answer (2026-11-06):** (a), the F11 plan: a separate document, written by an agent, which the owner approves (rule 14).
    It runs BEFORE PR 5. It compares options against **four criteria**: (1) one source of truth; (2) scores survive
    regeneration of unpublished games; (3) game identity stays stable, including PR 5's `external_ref`; (4) the standings
    policy of change 1 (optional at organization, program and division level, default excluded). It does not pick an
    approach in advance, and it is not small: scores surviving regeneration is a persistence question. Why before PR 5:
    PR 5's migration adds `game_assignments.external_ref` (the Game ID) and defines re-import by it, and criterion (3)
    could reject that design after it deploys (section 7, "The F11 plan").
13. **What a re-import does.** Recommended: update by `Game ID`, add the rest, **never delete**, list "in the schedule, not
    in this file", skip Published rows that would change. Alternative: replace the visible schedule (a re-import then
    behaves like a regeneration and would hide games; not recommended).
14. **Regeneration over unpublished games.** Recommended: unchanged (re-solve them, as today), with Published games
    pinned. Alternative: fill gaps only (the minimal-diff reading of AGENTS.md section 3); a bigger solver change, its own plan.
15. **Should an import record itself as a publication baseline?** Recommended: yes, a box that is ticked by default when
    the games arrive Published, so "changes since import" works from day one (PR 6, task G5). Alternative: no.
16. **Review under the owner's budget rule.** AGENTS.md section 3 asks for an adversarial `/code-review` before every PR;
    the owner's rule for this work said no `/code-review` rounds. As offered: the owner confirms the budget rule as an
    explicit exception for this plan's PRs, each PR keeping one labelled self-review against its plants and stop
    conditions. No default.
    **Answer (2026-11-06): (c), content-based, final.** A PR is (c) if it contains any of: a migration; an Edge write
    path; solver changes; import diff, matching or flagging logic (re-import keys, Published-row skipping,
    accept-and-flag, probable-move pairing). Every other PR is (a): a labelled self-review against plants and stop
    conditions, plus the Codex PR review. This is the final list, with a reason per PR, that the owner asked for before
    PR 1 launches. (c):
    - PR 1: migration, guard trigger, Published and override write path.
    - PR 2: solver (`pinned` input).
    - PR 4: matching and conflict-audit logic in core (label matching, "not judged" versus clear coverage). Rule 14 does
      not list it because it persists nothing.
    - PR 5: migration, re-import key, Published-row skip, `is_external`.
    - PR 6: Edge write path (`import-validation`), preview and apply parity.
    - PR 8: writes through `persist_game_schedule` and `ensure_game_slot` over Published slots (a judgment call; it fits
      none of the four criteria strictly).
    - PR 9: matching, alias and settings-proposal logic in core, plus probable-move pairing. Rule 14 does not list it
      because it persists nothing.
    - PR 10: migration, accept-and-flag past the gate, additive re-import.
    - PR 11: Edge write path and import panel.
    - PR 12: migration and both solver twins.

    (a): PR 3, PR 7 and PR 13 (no migration, Edge write path, solver change or import logic). PR 14 is held.
    **Process** (message 2): documentation and very minor PRs get no `/code-review`; dependency PRs get none. A (c) PR
    opens WITHOUT `/code-review`; Codex reviews it; the Codex findings are addressed; then ONE `/code-review high` runs on
    the result and its findings are fixed in the same push. Never a second `/code-review` on the same PR. AGENTS.md
    section 3 and CLAUDE.md's Review bullet are edited in PR 1 (task A6, a separate commit) so agents stop seeing a
    contradiction; A6 landed in #707, so no agent brief needs to name an exception.

17. **Week numbers for imported games.** Recommended: the `Week` column if present, else derived from the season's start
    date (4.8), required when the season has no start date. Alternative: always require `Week`.
18. **Confirm the build list.** Recommended: build F2, F3, F5 (own CSV), F6, F7, F8, F9, F10; build F1 later; do not build
    F4 or F12 now; F11 separately (decision 12). F13 to F17 are decisions 19 to 31.

_Added 2026-11-06 (the practice side)._

19. **Do the practice side in this wave, and in what order.** Recommended: yes, after the games import it shares
    machinery with (as offered: PR 9 with PR 6, PR 10 with PR 7, PR 11 with PR 8, then PR 12 and PR 13; superseded by
    the dependency table of section 7). Alternatives: (b)
    the practice import before the games import (PR 4 to 6 would then be built around the practice side first; sensible
    only if the owner's practice schedule is the more urgent of the two); (c) hold the practice side until PR 1 to 8 have
    merged (nothing is lost; the owner waits longer).
    **Answer (2026-11-06):** (a), the practice side after the games import; the order is restructured (change 8; section 7).
20. **Rows the writer's gate would refuse** (the example has 5 teams in two places at once and 29 teams below their
    count). Recommended: **accept and flag, never reject**: the rows are written as the admin's own, every broken rule is
    listed in the preview and the result, short teams go to the TIME TBD list, and the existing writer and gate are not
    touched. Alternatives: (b) refuse the rows (the owner's "accept and flag" for games would then not hold for practices,
    and a team double-placed in the file could not be imported at all); (c) write only the rows that break no rule and
    list the rest (imports less of a real schedule than it is).
21. **File format.** Recommended: a flat CSV, one row per timed cell (4.11.2). Alternatives: (b) read the grid itself
    from `.xlsx` (a new dependency, decision 8, plus a layout parser; the grid's measured traps are finding 14); (c) the
    flat CSV now and a grid reader later.
22. **What the practice import may create from the file.** Recommended: only on the confirm step's explicit list: team
    shells (through the existing team writer), divisions (by name, no age band, flagged), locations and fields (no
    coordinates, unknown lighting, flagged), subunits, and practice slots including open ones (a blank `Team`).
    Alternatives: (b) create nothing, the fields CSV first (safest; two files and two conversions of the grid); (c)
    create slots and shells but never locations or fields.
23. **Provenance of imported practices, and "locked on arrival".** Every saved practice is locked by default, so "arrive
    locked" holds under any answer (2.1). Recommended: `source = 'manual'` and `assigned_via = 'manual'`. Alternatives:
    (b) `auto` (a later save could prune an imported practice for a team it omits, with an unlock); (c) "unlocked on
    arrival": not possible without a new concept in the writer (a migration replacing `persist_practice_schedule`);
    not recommended.
24. **What a re-import does to saved practices.** Recommended: additive: change nothing, delete nothing, count unchanged
    rows, list "in the schedule, not in this file". Alternative: replace the season's imported rows (a re-import would
    then need an unlock for every moved row; not recommended).
    **Answer (2026-11-06):** (a), purely additive: no in-place updates and no deletes. The preview pairs the rows "in the
    schedule, not in this file" with the rows "new in this file" for the same team and shows them as probable moves,
    paired at team level, with the new rows unticked by default (change 4; 4.11.6). Over-counts are still flagged under
    decision 20.
25. **The dates imported practices run.** Recommended: the file's `Valid From` and `Valid Until` per row, else two dates
    on the confirm step defaulting to the season's start and end, required when the season has none (4.11.6).
    Alternative: always require dates in the file.
26. **Division practice settings from the file.** Recommended: propose `practices_per_week` and `practice_minutes` per
    division from the file and apply a proposal only when ticked, through the existing audited RPC. Alternatives: (b)
    never touch them (the page then reports two-a-week teams as over target until the admin sets them); (c) apply them
    automatically (not recommended: the default of 1 cannot be told from "unset", and a silent change is the decision
    nobody made, lesson 86).
27. **The paired-days pattern: now, later or never.** Recommended: **later** (PR 12), as an optional per-division
    setting, off by default. Alternatives: (b) now, before the import (it also changes what the fixture's golden
    shows); (c) never (the import and gap-fill already cover what a league has); (d) the cheaper "same slot on any two
    weekdays" boolean (covers Mon+Thu, allows back-to-back days).
    **Answer (2026-11-06):** (a), later (PR 12), optional, off by default; its scope is organization, program and division
    level (change 6; 5.7, 6.2).
28. **The non-team slot hold.** Recommended: **now, no stored hold**: a `Use = hold` cell makes no slot and is listed;
    build the stored `hold_kind` (PR 14) only if the owner has holds beyond the occasional one or wants them visible.
    Alternatives: (b) the stored hold with the import (PR 14 early); (c) a zero-practice "Clinics" division reserving the
    slot (not recommended: it appears in teaming and the exports); (d) field blackouts (not recommended: date-based, and
    the practice solver does not read them).
    **Answer (2026-11-06):** (a): no stored hold, and PR 14 is held. A `Use = hold` row only lists (5.8). A later fields
    import or a Field Management save can create a slot at that time (5.8).
29. **The capacity-versus-demand panel.** Recommended: build (PR 13), a read-only section at the top of the Practices
    page, labelled an upper bound. Alternatives: skip it; or show it on the import result only (smaller, but of no use
    without an import).
    **Answer (2026-11-06):** (a), reworded (change 5): PR 13 states what its capacity numbers are based on; with no stored
    hold it counts every open slot, says that times held outside the app are unknown to it, and labels its verdict an upper
    bound (5.9). PR 10 checks and states every code path that creates practice slots, and flags any that could bring a
    held time back as open capacity (task K2).
30. **Alias file and reuse of the last mapping (F17).** Recommended: yes: the mapping step takes an optional alias CSV,
    read in the browser, and the previous import's stored mapping as proposals, never applied without the admin; no
    table. Alternative: a stored per-organization alias list (more convenient; a table, RLS and a migration, and one
    more place for a label to go stale).
31. **Practices, and a multi-team marker derived from the team list, in the coach schedule (F3 and F17).** Recommended:
    yes (task G2b of PR 7). Alternative: games only for now.

## 11. Receipts: searches, runs, and what was not run

Base: `origin/main` `c3d190d` (the brief named `a3395eb`; #703, a teaming setting, landed between). Searches, web fetches
and workbook counts were run on 2026-11-03; the file checks at the end on 2026-11-04 (the session crossed midnight).
`rg` is ripgrep. Each absence has its positive control.

| Id  | Claim                                                                                                                                 | Command or source                                                                                                                                                                                                       | Result and control                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Nothing writes `games` from a saved schedule                                                                                          | `rg -n -i "insert\s+into\s+(public\.)?games\b" -g '!supabase/tests/**' -g '!docs/**' -g '!tests/**' .`                                                                                                                  | 3 hits: `scripts/dbharness/scenarios.py:178`, `supabase/migrations/20251208000001_seed_data.sql:684`, `supabase/seed.sql:662`. Control: the same pattern including `supabase/tests` matches 8 files          |
| R2  | The latest `persist_game_schedule` never names `games`                                                                                | `awk 'NR>=1763 && NR<=2330' supabase/migrations/20261108020000_schedule_tbd.sql`, then `rg -c "public\.games\b"` and `rg -c "game_assignments"` on the slice                                                            | `public.games`: 0 lines. Control: `game_assignments`: 1 line (the insert)                                                                                                                                    |
| R3  | `freeze`, `resolve`, `externalImport`, `waivers`, `ruleEngine`, `changelog` have no importer in `frontend/src`, `supabase`, `scripts` | `rg -l -e "core/(src/)?<m>/" -e "from '\.\./<m>/" frontend/src supabase scripts`, for each `<m>`                                                                                                                        | 0 for each. Controls: `publication` has 2 importers in `frontend/src`; 5 test files import `externalImport`                                                                                                  |
| R4  | The Import panel takes `.csv` only; the repository only writes `.xlsx`                                                                | `rg -n "accept=" frontend/src/components/ImportPanel.jsx frontend/src/components/preferences/PreferenceImportPanel.jsx`; `rg -n '"(papaparse\|write-excel-file\|read-excel-file\|xlsx\|exceljs)"' package.json`         | `accept=".csv"` and `accept=".csv,text/csv"`; `papaparse` and `write-excel-file` present, no reader. Control: 8 `xlsx` lines in `scheduleDownloads.js`                                                       |
| R5  | The writers of `game_assignments` are `persist_game_schedule` and `admin_cancel_game_assignment` (plus cascades)                      | `rg -n -i "(insert into\|update\|delete from)\s+(public\.)?game_assignments" supabase/migrations`, by file                                                                                                              | `20260503030000`, `20260613000003`, `20261018070000`, `20261108020000`: one hit each (three definitions of the save, one of the cancel). The policy list gives members `SELECT` only (`20261104010000:1488`) |
| R6  | F1, F2, F4 are absent                                                                                                                 | `rg -l -i "take[- ]?down\|(set[- ]?up\|setup) (duty\|duties\|crew\|roster)\|field duties"`, `"day sheet\|daysheet"`, `"early/late\|earlylate\|time.of.day (pref\|slot)"` over `frontend/src packages/core/src supabase` | 0, 0, 1 (the third is `practiceSlotExpansion.js`, season boundaries, not a preference). Control: `blackout` matches 27 files in `frontend/src`                                                               |
| R7  | The only product callers of `persist_game_schedule`                                                                                   | `rg -n "persist_game_schedule" frontend/src supabase/functions packages scripts` (tests and mocks excluded)                                                                                                             | The Edge function (`game-persistence/index.ts:163`) and the core handler (`gamePersistenceHandler.js:49`); the rest are comments and the harness. Control: three pgTAP files name it                         |
| R8  | A team row is inserted only by team generation and the seed copies                                                                    | `rg -n -i "insert\s+into\s+(public\.)?teams\b" supabase/migrations`                                                                                                                                                     | `persist_team_schedule` (four definitions: `20260503040000:431`, `20260610000000:486`, `20260923000000:1130`, `20261018070000:544`) and the demo and seed copies. No create-team RPC                         |
| R9  | Who reads `teams` directly; who reads a game's sides                                                                                  | `rg -l "from\('teams'\)" frontend/src supabase/functions packages/core/src` (tests, mocks excluded); `rg -l "awayTeamId\|away_team_id" ...` same roots                                                                  | 11 files; 52 files                                                                                                                                                                                           |
| R10 | Real-name guard and source hygiene still pass with this file present                                                                  | `vitest run tests/realNameDenylist.test.js`; `vitest run tests/sourceHygiene.test.js` (the main checkout's `node_modules`, linked into the worktree and removed after)                                                  | 11 passed; 23 passed. The first scans `docs/` (`tests/helpers/repoScanFiles.js`); its own planted-name control is in the file (read, not re-run)                                                             |
| R11 | Formatting and hygiene                                                                                                                | `prettier --write` on this file only (3.7.4, the repository's `.prettierrc`); the placeholder grep of `prompts/plan-change.md`; `git diff --check`; a search of the file for model names and the club's initials        | Formatted; the placeholder grep printed nothing after two bracketed finding tags were reworded; `git diff --check` clean; none of the strings present                                                        |

**The owner's example workbook, counts only** (a scratch script kept outside the repository; it prints no name, venue,
team, coach or free text). "Brief" is the figure in the owner's request; "Same?" says whether the count matches it.

| Figure                                                                                         | Recomputed                                                                                              | Brief                         | Same?                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| Games on the `Schedule` sheet, distinct game ids                                               | 574, 574                                                                                                | 574                           | yes                                                                |
| Game dates; weekdays                                                                           | 9; all Saturdays; 59 to 67 games a date                                                                 | 9 Sat                         | yes (the spread is new)                                            |
| Venues; distinct (venue, field) pairs used; rows on `Fields`                                   | 7; 26; 26                                                                                               | 7; 26                         | yes                                                                |
| Divisions on the schedule; rows on `Divisions`                                                 | 20; 20                                                                                                  | 20                            | yes                                                                |
| Teams rows; with a second coach; a third; a head-coach email                                   | 132; 82; 1; 0                                                                                           | same                          | yes                                                                |
| Fields with shared space                                                                       | 6                                                                                                       | 6                             | yes                                                                |
| `Fixed Games` rows; their venues; their divisions                                              | 43; 1; 6                                                                                                | 43; 1                         | yes (divisions new)                                                |
| Team labels on the schedule; not on `Teams`; games naming one                                  | 163; 31; 39 (all away side, one venue, six divisions)                                                   | n/a                           | new                                                                |
| `Changes` rows                                                                                 | 3, one of each kind                                                                                     | 3                             | yes                                                                |
| Distinct game lengths (minutes)                                                                | 35, 45, 55, 65, 80, 90, 105                                                                             | five formats                  | two more than the format defaults                                  |
| Format defaults (`Formats`, template)                                                          | 4v4 35+20, 5v5 45+20, 7v7 55+20, 9v9 65+20, 11v11 80+20                                                 | same                          | yes                                                                |
| Rows the template provisions                                                                   | Schedule 2,400; Teams 250; Fields 40; Fixed Games 150; Changes 300; Divisions 25                        | same                          | yes; "12 game days" and "16 teams per division" **not recomputed** |
| `Settings` numeric cells                                                                       | 10 and 20 (their labels were not read)                                                                  | turnover 10, travel buffer 20 | consistent, labels unverified                                      |
| `Import` sheet header; rows                                                                    | `Date`, `Start Time`, `End Time`, `Venue`, `Field`, `Home Team`, `Away Team`, `Division`, `Format`; 574 | same                          | yes                                                                |
| Workbook's own cached summary: games in field double-bookings; in coach clashes; teams flagged | 4; 20; 8 (labels say "games", "games", "flagged")                                                       | 4; 20; 8                      | yes, but see below                                                 |
| A plain overlap check by (date, venue, field) on the `Schedule` sheet                          | **0** pairs                                                                                             | n/a                           | the 4 are the workbook's own rule                                  |

**Web pages fetched on 2026-11-03** (section 5.4): `support.gotsport.com/how-to-import-a-schedule`;
`helpme.teamsnap.com/article/1292-import-schedules`, `/1048-troubleshooting-schedule-imports`,
`/1839-importing-team-schedules`, `/731-import-games-in-scheduler` (a tournaments page, not used). No template file
was downloaded; every header not named on a page is unknown.

**Not run.** The test suite, the coverage run, the E2E suite, the build, lint, typecheck, pgTAP, the `dbharness`
plants, any migration, `/code-review`; `gh pr list` (the number of open pull requests is unknown); the production
database; a page-level reproduction of finding 5 (it is shown from the migrations, the reads and the repository's
own earlier plan); that `persist_team_schedule` accepts a payload with teams and no `team_players` (the Edge schema
does; the RPC body was not exercised); that incremental teaming fills empty shells; what the workbook's formulas do
for duties and Early/Late (labels and headers read, formulas not); the TeamSnap and GotSport template files.

### 11.1 Receipts added 2026-11-06 (the practice side)

Base unchanged: `origin/main` `c3d190d`, checked on 2026-11-06 (`git fetch`: still `c3d190d`, so no merge was needed
before editing). The upload and the three scratch scripts of the coordinator's read were present, so every figure
below was re-run rather than copied; scratch scripts (`openpyxl`, run with `python3 -I`, printing no name, venue, team,
coach or value) are kept in the session's scratchpad, outside the repository. Each absence has its positive control.

| Id  | Claim                                                                 | Command or source                                                                                                                                                                                                                                                                                                    | Result and control                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R12 | The grid's counts reproduce the coordinator's figures                 | `python3 -I grid_stats.py <upload>`                                                                                                                                                                                                                                                                                  | 235 placements (37 and 198), 1 non-team cell, 0 cells without a time header; 726 timed cells (96 and 630); 132 teams (103 with two, 29 with one); day patterns as in 4.11.1; 83 same-slot; 0 cells used twice; 5 teams in two places; 49 field rows used; 217 on a half or side; 31 merged ranges; 219 coaches, 19 on two or more, 1 same-start clash; 132 of 132 grid teams on the coach list. Control: each figure equals the coordinator's |
| R13 | The alias tab cannot be tied to the grid                              | `alias_stats2.py` and `alias_where.py`                                                                                                                                                                                                                                                                               | 21 rows, 20 distinct targets; 0 of the 21 names occur on any other tab (exact, or whitespace- and case-normalised); 4 of the 20 targets occur as row labels on the main grid. Control: the script reads the grid's 58 labelled rows                                                                                                                                                                                                           |
| R14 | 20 team cells are merged over two field rows                          | `merged_stats.py`                                                                                                                                                                                                                                                                                                    | 21 merged ranges span two or more rows in the data: 20 hold a team (2 rows by 1 column, the row labels sharing a stem) and 1 is a 6 by 3 block; 0 adjacent unmerged duplicates. Control: R12's 31 merged ranges include them                                                                                                                                                                                                                  |
| R15 | Two blocks, partial time headers, marker rows, stray whitespace       | `blocks_stats.py` and `alias_stats.py`                                                                                                                                                                                                                                                                               | Block 1: 16 labelled rows, times on 2 of 5 weekdays (6 time cells); block 2: 42 rows, 15 time cells; no label in both; 2 rows labelled `.`; 236 team-shaped cells, 2 with stray whitespace. Control: 16 + 42 = 58 labelled rows                                                                                                                                                                                                               |
| R16 | The tabs' shapes                                                      | `inspect.py`                                                                                                                                                                                                                                                                                                         | 14 tabs, 3 visible and 11 hidden; the by-team tab has 322 rows; no title or value is copied here                                                                                                                                                                                                                                                                                                                                              |
| R17 | The import types and required fields                                  | `rg -n "practice_preferences" supabase/functions/import-validation/*.ts`, then read `index.ts:524-531` and `:56`                                                                                                                                                                                                     | The enum has six values (`players`, `coaches`, `fields`, `field_availability`, `practice_preferences`, `evaluations`); `REQUIRED_FIELDS` has no entry for a practice schedule. Control: the same read shows the `fields` branch at `:403`                                                                                                                                                                                                     |
| R18 | No practice-schedule importer exists                                  | `rg -n -i "practice_schedule\|practice_assignments_import\|import_practice_\|apply_practice_import\|practice.?schedule.?import" supabase/functions supabase/migrations frontend/src packages/core/src --glob '!**/*.test.*'`                                                                                         | 8 hits, all unrelated (a resource name, an error code, the fingerprint RPC's name, comments). Control: `finalize_field_import_job` matches 10 times in one migration                                                                                                                                                                                                                                                                          |
| R19 | The latest bodies of the functions this plan copies                   | `rg -n "FUNCTION public\.(persist_game_schedule\|admin_delete_team\|admin_cancel_game_assignment\|persist_practice_schedule)" supabase/migrations`                                                                                                                                                                   | `persist_game_schedule` `20261108020000:1763`; `persist_practice_schedule` `20261108020000:515`; `admin_cancel_game_assignment` `20260613000003:68`; **`admin_delete_team` `20261112010000:1413`** (the plan had `20261108020000`: corrected). Control: the older definitions are listed too                                                                                                                                                  |
| R20 | No pairing or same-slot rule in the practice solver                   | `rg -n -i -e "pairing" -e "paired (day\|weekday\|slot\|practice)" -e "same[- ]slot" -e "twin slot"` over `practiceScheduling.js`, `practice/`, `practiceMetrics.js`, `supabase/functions/auto-scheduler`, `_shared/engines`, the Practices page                                                                      | 0 files. Control: `WEEKDAY` matches 2 lines in `practice-coaches.ts` (the different-weekday rule)                                                                                                                                                                                                                                                                                                                                             |
| R21 | The practice solver never reads blackouts or closures                 | `rg -l -i -e blackout -e closure supabase/functions/auto-scheduler supabase/functions/_shared/engines packages/core/src/practiceScheduling.js`                                                                                                                                                                       | 0 files. Control: `PracticeSchedulingPage.jsx:13, :568` import and use `useFieldClosures` (the page warns)                                                                                                                                                                                                                                                                                                                                    |
| R22 | `Clinic` is only a field size                                         | `rg -n -i "clinic" frontend/src packages/core/src supabase/functions supabase/migrations --glob '!**/*.test.*'`                                                                                                                                                                                                      | 1 hit, `FieldManagementPage.jsx:1009`. Control: the adjacent lines are the other size options (`11v11`, `9v9`, `7v7`, `5v5`)                                                                                                                                                                                                                                                                                                                  |
| R23 | Capacity 0 is not a hold                                              | Read `PracticeSchedulingPage.jsx:209`, `practiceSupabase.js:98-102`, `import-validation/index.ts:436-446`; no search                                                                                                                                                                                                 | The page raises 0 to 1; the loader throws; the fields CSV refuses `Capacity` below 1. Statically reviewed only                                                                                                                                                                                                                                                                                                                                |
| R24 | No before-a-run supply-and-demand view; `slotUtilization` unshown     | `rg -n -i -e "slots needed" -e "slots available" -e "capacity.*demand" -e "demand.*capacity" frontend/src/pages frontend/src/components packages/core/src/practice*`; `rg -l "slotUtilization" frontend/src`                                                                                                         | 2 unrelated hits (an unplaced-reason string, a Games grid empty message); `slotUtilization` has one frontend file, `PracticeReadinessPanel.jsx`, where it is named in a docblock. Control: `unassignedTeams` matches 14 lines in the panel                                                                                                                                                                                                    |
| R25 | No alias store in the mapping module                                  | `rg -n -i alias packages/core/src/externalImport/*.js`                                                                                                                                                                                                                                                               | 0 hits. Control: `normaliseExternalLabel` at `mapping.js:160`                                                                                                                                                                                                                                                                                                                                                                                 |
| R26 | The Practices page lists assignments as a table; no field-by-day grid | `rg -n "PracticeAssignmentList\|PracticeReadinessPanel\|GameScheduleGrid\|DataGrid" frontend/src/pages/PracticeSchedulingPage.jsx`; `rg -ln "DataGrid\|GameScheduleGrid" frontend/src`                                                                                                                               | The page uses the list and the panel only; `DataGrid` serves Players, Coaches, Blackouts and Scores; `GameScheduleGrid` (with `FieldColumn`) is used by the Games page. Control: the list component is read in full                                                                                                                                                                                                                           |
| R27 | The writers of `practice_assignments`                                 | `rg -n -i "(insert into\|update\|delete from)\s+(public\.)?practice_assignments" supabase/migrations`, by file, then the latest bodies                                                                                                                                                                               | 17 files; the latest writing bodies are in 2.1. Control: the pattern finds the writer's insert (`20261108020000:1425`)                                                                                                                                                                                                                                                                                                                        |
| R28 | The TIME TBD sync refuses any caller but the writer and the refresh   | Read `20261108020000:221-262` and `:347-440`                                                                                                                                                                                                                                                                         | A `PG_CONTEXT` check at `:236-240`; the refresh takes the writer's season lock and audits a change. Statically reviewed only                                                                                                                                                                                                                                                                                                                  |
| R29 | The real-name guard and the source-hygiene test still pass            | `npm ci --ignore-scripts --no-audit --no-fund` in the worktree (`node_modules` removed afterwards), then `./node_modules/.bin/vitest run tests/realNameDenylist.test.js tests/sourceHygiene.test.js`                                                                                                                 | 2 files, 34 tests passed (the guard scans `docs/`, so this file). The install warned that the repository wants Node `^24.15.0` and this machine has 22.23.4; no file was changed by it. The guard's planted-name control is in its own file (read, not re-run)                                                                                                                                                                                |
| R30 | Formatting and hygiene                                                | `prettier --write` on this file only (3.7.4, the repository's `.prettierrc`); the placeholder grep of `prompts/plan-change.md`; `git diff --check`; searches of the file for every string read from the owner's workbook (venue and team-family names, the club's initials, tab titles, any `@`) and for model names | Formatted; the placeholder grep printed nothing; `git diff --check` clean; 0 hits for each string searched. Prettier left the original tables alone: the only original lines the diff removes are the 59 edited on purpose (listed in the Amendments)                                                                                                                                                                                         |
| R31 | The two views' latest definitions (the 2026-11-06 amendment)          | `rg -n -i 'create (or replace )?view (public\.)?view_league_standings' supabase/migrations`; `rg -n 'CREATE OR REPLACE VIEW public.view_org_metrics' supabase/migrations/20261108010000_season_enrollment.sql`; read both bodies                                                                                     | _Executed_ and _statically reviewed_ 2026-11-06 on a worktree of `0869b07`: 3 matches for the first; the latest is `20261023010000:65`, `FROM public.teams t` with `LEFT JOIN game_results gr ON gr.team_id = t.id`, so an external row would appear with 0 games played; `view_org_metrics` is redefined at `20261108010000:2118` and still counts `total_teams` from `teams`. Control: both searches matched.                               |
| R32 | The audit retention behind the note's helper text (decision 1)        | Read `supabase/migrations/20260409000000_audit_log_retention_180.sql`; `rg -n 'prune_old_audit_logs' supabase/migrations`                                                                                                                                                                                            | _Statically reviewed_: `prune_old_audit_logs` deletes an organization's `audit_log` rows older than its `settings->>'retention_days'`, default 180. Not re-searched: that no per-row delete path exists (that is from the owner's review). Control: the search matched.                                                                                                                                                                       |
| R33 | Formatting and hygiene of the 2026-11-06 amendment                    | `prettier --check` on this file only (3.7.4, installed outside the repository; the repository's `.prettierrc`); `git diff --check`; a non-ASCII search; a search for model names; a search for every string read from the owner's workbooks                                                                          | _Executed_ 2026-11-06: formatted; `git diff --check` clean; 0 non-ASCII characters; the only hits for model names are the file name `CLAUDE.md`; 0 hits for the workbook strings. Controls: the stale-text searches listed in the amendment were re-run after the edits and their remaining hits read.                                                                                                                                        |

**The second workbook, counts only** (_executed_ 2026-11-06, R12 to R16). The brief's figures all matched; the ones that
were new are marked.

| Figure                                                                       | Recomputed                                                                                                 | Brief                       | Same?                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------ |
| Placements; by block                                                         | 235; 37 (45-minute block) and 198 (60-minute block)                                                        | 235; 37 and 198             | yes                                  |
| Distinct teams; with two practices; with one                                 | 132; 103; 29                                                                                               | same                        | yes                                  |
| Two-weekday teams by pattern                                                 | Tue+Thu 49, Mon+Wed 38, Wed+Fri 8, Mon+Thu 3 (98); both placements at one weekday and start 5 (103 in all) | same pattern counts         | yes; the 5 and the 98 are new splits |
| Teams holding one field and start on both days                               | 83 (of the 98)                                                                                             | 83                          | yes                                  |
| Cells used twice; teams in two places at once                                | 0; 5                                                                                                       | 0; 5                        | yes                                  |
| Field rows used; labelled rows; placements on a half or side                 | 49; 58; 217                                                                                                | 49; n/a; 217                | yes; 58 is new                       |
| Venues (a prefix reading of free-text labels)                                | about 8                                                                                                    | 8                           | an estimate, as the brief            |
| Timed cells; non-empty cells                                                 | 726 (96 and 630); 236                                                                                      | 726                         | yes; the split and 236 are new       |
| Team cells merged over two field rows                                        | 20                                                                                                         | not in the brief            | **new** (finding 14)                 |
| Marker rows; names with stray whitespace                                     | 2; 2                                                                                                       | not in the brief            | **new**                              |
| Coaches named; on two or more teams; same-start clash                        | 219; 19; 1                                                                                                 | 219; 19; 1                  | yes                                  |
| Tabs; alias rows; distinct alias targets                                     | 14 (3 visible, 11 hidden); 21; 20                                                                          | alias table only            | the rest new                         |
| A coach-choice legend, a "do not change, published" note, equipment tracking | not looked for                                                                                             | reported by the coordinator | **not re-run**                       |

**Not run, added 2026-11-06.** Everything in "Not run" above, for the new PRs too: no migration, test, pgTAP case,
harness plant, build, `/code-review` or `gh pr list`. Also not run: any dry run of the practice import (it does not
exist); the sentinel-rollback dry run of 4.11.4 (a design, not a measurement: PR 10's first task proves it);
`practice_new_auto_row_refusals` over a `manual` row (read, not executed; PR 10's stop condition names it); the writer's
gap of finding 13 (read, not executed); whether the owner's spreadsheet can emit the flat file in one step; whether the
mock client can run the practice solver in E2E; the field import's subunit handling beyond reading the lines cited
(PR 10 re-reads it); whether a cached browser still resolves the 13-argument settings RPC after PR 12 (the
trailing-default argument is the method `20261105010000` used; not re-tested).

**Not run, second amendment of 2026-11-06.** Docs only: no test, build, lint, typecheck, coverage, E2E, pgTAP, CI or
`gh pr list` was run, and no dependency was installed in the repository. The searches of R31 and R32 were run and the
cited lines read; the retention default was read, not exercised; the owner's statement that audit rows have no per-row
delete path was not re-searched.

## 12. What the planning taught (for `docs/LESSONS_LEARNED.md`, written in PR 1)

- **A "present and stronger" table is one claim per row, and each row has a reader.** The per-team export and feed looked
  built; their source table is one nothing fills. Name the table each reader reads before calling it a strength.
- **A brief's premises are claims about the code.** "The Import panel accepts `.xlsx`" and "locked games" were both
  false in the code (`accept=".csv"`; `locked` rewritten to `manual`); check them before designing to them.
- **One word, three meanings.** "Published" was an export baseline, a roster status in core, and now a per-game guard;
  name each in the screen, and say which table stores which.
- **An import's work is what the file does not carry.** The games file names teams, divisions and fields; the plan is
  mostly about who may create them and which writer leaves them visible to the next run (incremental teaming reads a
  run's payload, not the table).
- **"Same as teaming" meant "preserve what a run recorded", not "accept what arrives".** Teaming never built the arrival
  half (the unread `team name` columns); say so when a new feature is promised to match it.
- **Copy a function from the migration that defines it last, found by search, not from the last one you read** (added
  2026-11-06). The plan named `20261108020000` for `admin_delete_team`; a later migration (`20261112010000`) replaced it.
  Before any "replace whole", `rg` the function name over `supabase/migrations` and take the highest version (R19). A
  second pass over a plan's own file references is part of the review (lessons 70 and 87).
- **A writer built for one job is the wrong door for another.** The practice writer replaces a season and gates only the
  rows it is told are the solver's; an import that must accept what the gate refuses is an additive writer of its own,
  not a mode bolted on, and it reuses the gate **read-only** to say what it accepted (the gate takes any ids).
- **Measure the trap before choosing the format.** The grid looked readable; counting its merged cells showed that a
  plain reader loses 20 of 235 placements without a word. The format decision rests on that count, not on taste.
- **Read the guard before promising to call a helper.** `sync_schedule_tbd_practices` allows two callers by its stack;
  the public refresh is the import's door. A promise to "reuse the writer's step" is a claim about who may call it.
- **Refute the cheap trick on the page, not in the table.** Capacity 0 looked like a hold in the SQL; the Practices page
  turns it into 1 and the loader throws. A shortcut through a column is checked at every reader of the column.
- **A default hides intent.** A division at one practice a week is the column default and a choice at once; an import
  that reads a file must propose the setting and ask, never infer it.

## 13. Output of the planning (prompts/plan-change.md)

1. Size verdict: planned, not small (above). No test is named for a small change because none is small.
2. Departures from AGENTS.md: one, the owner's review policy (decision 16), recorded in section 9 and edited into
   AGENTS.md and CLAUDE.md by PR 1's task A6 (landed in #707). No ADR is drafted (the repository has no ADR folder). Open
   questions: none; all thirty-one decisions were answered on 2026-11-06 (section 10; 1 to 18 as drawn up on 2026-11-03,
   19 to 31 added 2026-11-06). The hold is lifted. The one gate that remained, the F11 plan before PR 5 (decision 12), was
   approved on 2026-11-07 and its F11-1 is merged (#712); PR 14 is held.
3. The first tasks: PR 1's A1, starting with `supabase/tests/game_published.sql`, red against today's code, and, in the
   second slot, PR 4's D1 (the fixture and its test).
4. What the planning taught: section 12.

## 14. Resume here (for an agent with no memory of this conversation)

**Read, in this order.** (1) This plan: the Amendments, the owner's answers at the top of section 10, sections 2 and 2.1, 3,
4 (with 4.6 and 4.11), 5.7 to 5.9, 6.2, 7, 10. (2) `AGENTS.md` sections 2 and 3 (operating rules 1 to 16,
the Verification conventions, the Definition of Done) and `docs/LESSONS_LEARNED.md` 5, 37, 42, 46, 47, 56, 59, 64, 65, 66, 70,
72, 73, 74, 77, 86, 87, 90, 92, 93 to 100. (3) The precedents to copy: `supabase/migrations/20260929000000_practice_writer_v3_lock_by_default.sql`
(header and `unlock`), `20261111010000_season_rollover.sql:520-655` (the read-only triggers and their exemptions),
`20261108020000_schedule_tbd.sql:1763-2440` (`persist_game_schedule` as it stands), `20260613000003:68`
(`admin_cancel_game_assignment`), `20261029010000:1008-1100` (find-or-create game slot), `20260503060000` (staging and
application records). For the practice side (PR 9 onward): `20261108020000_schedule_tbd.sql:515-1752`
(`persist_practice_schedule`), `:221-440` (the TIME TBD sync and refresh), `20261105010000_practices_per_division.sql:115-215`
(the gate), `20261029010000:140-196` and `:892-1009` (`practice_slot_conflicts`; the practice slot find-or-create),
`supabase/functions/_shared/engines/practice-lock.ts:232` (`planTeamsForRun`), `practice-coaches.ts:277-345` (the hard
rules), `fixtures/demo-2026/fields.csv` with `scripts/build-demo-seed.mjs` (the fixture's shape),
`tests/practiceReaderCensus.test.js` and `tests/practiceUnplacedReasons.test.js` (two lists a new writer and a new rule
must join). (4) The pgTAP shapes: `supabase/tests/season_schedule_readonly.sql` and `practice_writer_v3.sql`
(clear the JWT claims before seeding, lesson 56), and `scripts/dbharness/prove.sh` (the plant entries, e.g. `M15`).
(5) The page: `frontend/src/pages/GameSchedulingPage.jsx` (`handleAutoGenerate:918`, `handleApplySchedule:1099`,
`moveGameTo:1203`, `handleCancelGameAssignment:1374`), `GameCard.jsx`, `GridOverrideDialog.jsx`, `gridOverridePrompt.js`.
(6) Core: `gameScheduling.js` (`scheduleGames:307`, `savedSides:84`), `gameMetrics.js` (`evaluateGameSchedule:93`),
`timing/seasonClock.js`, `externalImport/mapping.js` (`normaliseExternalLabel`). Line numbers in (3), (5) and (6) are as of
`c3d190d` and have moved: search by name.

**Re-verify before relying on anything here (main moves).** `git log -1` and the highest file in `supabase/migrations`
(it was `20261118010000` at `c3d190d` and `20261120010000` at `e5ce8b8`); then re-run the searches of section 11 (R1 to R5
and the absence counts) and read the numbers against it; confirm `scheduleGames` takes `pinned` (PR 2) and still refuses
`freeze`; confirm no other
writer of `game_assignments` has appeared (R5). For the practice side re-run R17 to R28 and confirm that
`persist_practice_schedule`, `practice_new_auto_row_refusals` and `refresh_schedule_tbd_practices` are still the bodies
read here, and that `admin_delete_team`'s latest body is still `20261112010000:1413` (R19). The owner's two workbooks
are **outside the repository** (the second, a practice grid, was recomputed on 2026-11-06); if a figure from them is
needed again, ask the owner for the files and recompute counts only. Never copy a name or value.

**Where this stands (updated 2026-11-10; first written 2026-11-06).** The owner answered all thirty-one decisions and
lifted the hold. The verbatim messages, the nine agreed changes and the answer table are at the top of section 10, and the
owner's answers of 2026-11-09 and of 2026-11-09 evening and 2026-11-10 follow them: read them first. **Merged on `main`**
(statically read from `git log` at `ad18861`; whether each migration is deployed was not checked): PR 4 (#706), PR 1
(#707), PR 9 (#708), PR 2 (#709), PR 3 (#710), PR 13 (#711), PR 7 (#713), the F11 plan's F11-1 (#712), and PR 5 (#719,
`ad18861`). **Updated 2026-11-11:** PR 6 is merged (#722, `53c79cc`; task G5 not built, see "As built" under PR 6 in
section 7). **Updated 2026-11-13:** F11-2 is merged (#725, `dcb54ff`) and its migration `20261122010000` is deployed
(verified by the coordinator on 2026-11-12; it closed follow-ups 3 (two of its three lines) and 5 of PR 6's review).
**Updated 2026-11-13 (later):** F11-3 is merged (#726, `5151f6c`; its task C3 was the blocker for turning score entry
on: **once F11-3's client is deployed, `score_entry` may be turned on**), and so are PR 6b's refactor G5a (#728,
`70f443a`) and its G5 (#729, `be268be`; the import recorded as the publication baseline; no migration; see "As built"
under PR 6b in section 7). **Updated 2026-11-13 (PR 11):** PR 10 is merged (#730, `f5110be`) and its migration deployed (the owner, 08:20 UTC).
**In review:** PR 8 (2026-11-13; see "As built" under PR 8 in section 7) and PR 11 (the Edge validation, the
Practices tab and its E2E; no migration; see "As built" under PR 11 in section 7). **Not merged:** PR 8, 11 and
12, F11-4 and F11-5. PR 14 stays held.

- **Order and the dependency rule.** Section 7 ("Dependencies and order") has the dependency table and the one priority
  rule: at most two PRs in flight; a free slot takes the first PR, in the order PR 1; PR 4; PR 2; PR 5; PR 3; PR 9;
  PR 6; PR 10; PR 7; PR 13; PR 8; PR 11; PR 12, whose dependencies are merged and deployed. There are no waves. PR 14 is
  held (decision 28). Left, with the F11 plan's pull requests in their places (2026-11-13, PR 11): PR 11 (in review),
  and the follow-ups of PR 6's review still open, listed under PR 6 in section 7 (the preview-stale check inside the
  RPC at the next replacement; a SQL sweep for abandoned games jobs), none with a pull request number yet,
  PR 8, F11-4, PR 12 (PR 10 and PR 11 are its dependencies), and the games mock's division `program_id` (PR 11's
  decision 10). F11-5 and PR 14 are the coordinating agent's call when their turn comes (section 10, the 2026-11-10
  answers, entry 5). Later, with no PR number: the B5.10 discovery pass and its plan-change (registration state and
  optional-data features), which the owner agreed to on 2026-11-09 (section 10, the 2026-11-09 answers, entry 2). Outside
  this plan: Dependabot #716 to #718, to be batched into one dependency pull request.
- **Gate cleared.** The F11 plan (decision 12; `docs/changes/2026-11-06-games-table-source-of-truth.md`) was approved by
  the owner on 2026-11-07 and its F11-1 (identity) is merged (#712). PR 5 is specified with that plan's amendments ("What
  PR 5, and the other pull requests, must do or avoid"); the owner answered on 2026-11-09 that Game IDs are not reused, so
  its `external_ref` index stays unique on `(season_settings_id, external_ref)`. PR 5 is merged (#719). Nothing else gates a
  start; an agent still merges only when the owner has said so for that PR (AGENTS.md section 3; the delegation of 2026-11-10 is in
  section 10, the 2026-11-10 answers, entry 5), and new scope, a new dependency or anything outside this plan still needs
  the owner.
- **Review.** By content (decision 16; section 7, "Review"): (c) for PRs 1, 2, 4, 5, 6, 8, 9, 10, 11, 12; (a) for PRs 3, 7, 13. A (c) PR opens without `/code-review`; Codex reviews it; its findings are addressed; then one `/code-review high`
  runs and its findings are fixed in the same push; never a second. An (a) PR gets a labelled self-review and the Codex
  review, no `/code-review`. Documentation, very minor and dependency PRs get no `/code-review`. AGENTS.md section 3 and
  CLAUDE.md's Review bullet say exactly this (task A6 of PR 1 first edited them; a later docs pull request made them match
  the (c) and (a) split), so no agent brief needs to name an exception.
- **Cost rules** (section 7, cost note): only the touched test files while iterating; one `npm run test:coverage` at the
  end; only the new E2E feature locally, after `bddgen`; pgTAP and the `dbharness` plants run in CI; docs stay short; each
  PR description says what it did not run; no dependency is added.
- **PR 1 and PR 4 started together and are merged.** The dependency updates are a separate wave and are not in this plan;
  the owner's manual testing (2026-11-09: "I'll do this a little later, I'd prefer we shore up more of the open work
  first."), the test-suite audit and the desktop build come after this expansion (header); the audit and then the
  build start only when everything else is complete (owner, 2026-11-10).
- **Decisions.** None open (section 10). B5.10 was answered on 2026-11-09 (section 10, entry 2): the signal is the
  platform's Waitlist column. What the owner described is still UNPLANNED and not decided; it needs a plan-change
  (AGENTS.md rule 14) after PR 5, which the owner agreed to ("your recommendation suffices here"), and no work is
  planned for it in this plan.

**How PR 1 was started (merged as #707; kept as a record, not a to-do).**

1. `git fetch origin main`; branch `feat/game-published-db`; check that fewer than two pull requests are open;
   cherry-pick the plan commits `0cafa0e`, `0869b07` and the 2026-11-06 amendment commit (see `git log`) as the branch's
   first commits.
2. Write `supabase/tests/game_published.sql` first, from `season_schedule_readonly.sql`'s skeleton: one assertion per row
   of 3.3 and per gate of 3.4, each refusal beside an unpublished control. Run it (CI, or the local stack) and get it red.
3. Write the migration: copy `persist_game_schedule` whole from `20261108020000:1763`, `admin_delete_team` whole from
   `20261112010000:1413` (its latest body: **not** `20261108020000`), and `admin_cancel_game_assignment` from
   `20260613000003`; add the columns, the two `audit_actions` rows, the guard
   trigger (exemptions copied from `20261111010000`), `admin_set_games_published` and `get_schedule_audit_log`; pin each
   new function `SET timezone = 'UTC'` and `SET search_path = public`; `REVOKE` from `PUBLIC` and `anon`, `GRANT` to
   `authenticated`. Then `docs/sql/<v>_revert.sql` and `_smoke.sql`, the plants in `prove.sh`, and the regenerated
   `supabase/catalog-snapshot.json`.
4. Then A2 to A5 of section 7 in that order, then A6 as its own commit, running only the touched test files, one
   coverage run at the end.
5. Do **not**: wire `freeze/` or `resolve/`; read or write `games`; add an `.xlsx` dependency; change
   `assignment_source` or its `locked` mapping; edit `prompts/` or the template skills; copy any value from the owner's
   workbooks; use the word "override" for anything but "allow changes" (finding on the Edge `overrides` field).

**How PR 4 was started** (merged as #706; kept as a record, not a to-do; it needed nothing from PR 1).

1. `git fetch origin main`; branch `feat/schedule-import-core`; check that fewer than two pull requests are open.
2. Write `tests/scheduleFixture.test.js` first (4.9), get it red, then `scripts/build-schedule-fixture.mjs` and the files.
   Never take a name, venue or value from the owner's workbook.
3. Then D2's tests before the code (`scheduleImportParse`, `scheduleImportMapping`, `scheduleImportAudit`).

**How PR 9 was started** (merged as #708; kept as a record, not a to-do; it waited for PR 4; decisions 19, 21 and 30 were answered).

1. `git fetch origin main`; branch `feat/practice-import-core`; check that fewer than two pull requests are open.
2. Write `tests/practiceScheduleFixture.test.js` first, counting the plants **from the CSV** (not from the product) and
   asserting the pre-plant copy counts none; get it red; then `scripts/build-practice-fixture.mjs` and the files
   (4.11.7). Never take a name, venue or value from the owner's workbook; the only inputs are the counts of 4.11.1.
3. Then J2's tests before the code (`practiceImportParse`, `practiceImportMapping`, `practiceImportSettings`,
   `practiceImportProbableMoves`), sharing `normaliseExternalLabel` with PR 4's module.
4. Do **not** touch `persist_practice_schedule`, `practice_new_auto_row_refusals` or any column of
   `practice_assignments` in any practice-import PR; do not give an import a `scheduler_runs` row (4.11.4); do not call
   `sync_schedule_tbd_practices` from anywhere but the writer and the refresh (R28).
