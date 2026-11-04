# Schedule expansion: a per-game "Published" switch, a schedule import, and the scheduling tools a spreadsheet scheduler has that this product lacks

Kind: FEATURE (eight pull requests, two migrations) · Drawn up: 2026-11-03 against `origin/main` `c3d190d` (the
owner's brief was written against `a3395eb`; #703 landed since, and nothing below depends on it) · Owner: the
repository owner · Status: **PROPOSED. Plan only: no code, migration, fixture or test is written by this change.** The
owner approved the scope on 2026-11-03; this plan is what AGENTS.md rule 14 asks to be shown and agreed before any
PR below starts. Order of work after this plan (owner, 2026-11-03): this expansion, then dependency updates, then a
test-suite audit, then the desktop build (the desktop build is **not** in this plan).

Every claim about the code is _statically reviewed_ (read) unless marked _executed_. _Executed_ means a search or a
script was run in a clean worktree of `c3d190d` (on 2026-11-03; the last file checks on 2026-11-04, the session crossed midnight), or a web page was fetched on 2026-11-03; nothing in this plan comes from
a test run (none was run; section 11 lists what was not). A claim of absence was made only after a search that matches
something; the positive control is named beside it. Figures about the owner's workbooks are counts and shapes only,
recomputed by scratch scripts kept outside the repository (section 11); **no name, venue, team, coach or value from
those files is in this plan, and none may enter a fixture, a test or a commit** (the real-name guard
`tests/realNameDenylist.test.js` scans `docs/` and fails on a hit). The workbooks are the owner's data and stay outside
the repository.

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

## Size verdict (prompts/plan-change.md, Step 0)

Planned, not small. It meets: spans more than one pull request (eight are proposed); changes a data model and
migrations (two migrations: a per-game flag and a guard, and a new import kind with its columns); changes what is
stored (games gain a flag, a provenance column and a reference; teams gain an external marker); changes behaviour
other code and people rely on (what a save, a cancel, a drag and a regeneration may do to a game); touches the solver
(`scheduleGames` gains an input; rule 14). It does not meet: no new dependency (reading `.xlsx` would add one and is
deferred, decision 8), no service, no environment variable, no new authorization model (every write is an admin RPC
that checks `is_org_admin` and a signed-in user, as the practice writer does).

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

## 1. The findings: what exists, what is absent, what to do

Effort is S under 150 lines, M 150 to 500, L over 500, tests included (estimates, not measurements). "Schema" says
whether the item needs a migration.

| #   | Finding                                       | Exists today (verified, with reference)                                                                                                                                                                                                                                                                                                                                  | Absent                                                                                | Recommendation                                                                                                                                                                                                           | Effort | Schema                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------- |
| F1  | Set-up / take-down duty roster per field-day  | Nothing (0 files match `take down`, `setup duty`, `field duties`; control: 27 files match `blackout`). Practice daylight code uses "teardown window" for sunset only (`practice/daylight.js:10`).                                                                                                                                                                        | The whole feature                                                                     | **Build later** (after PR 8), list-only, derived from the saved games, no automatic team assignment unless the owner chooses it (decision 9). Admin export, never a team view.                                           | M      | No                                                                          |
| F2  | Day Sheet (one date, optional venue)          | Nothing (0 files match `day sheet`; same control). The master export has every game with start, end, field (`outputGeneration.js:36-54`).                                                                                                                                                                                                                                | A one-date, one-venue view and file                                                   | **Build** (PR 7): a read-only section of the Exports page plus CSV, over `game_assignments`, TIME TBD listed. Admin only.                                                                                                | S      | No                                                                          |
| F3  | Coach Lookup (a coach's teams together)       | Partial. Coaches page lists each coach with their teams, divisions and status (`CoachesPage.jsx:97`, `buildCoachReviewRows`); `listTeamCoachIds` reads head and assistants; the master export has `Coaches` and `Coach Emails`. No games per coach.                                                                                                                      | Games per coach in one place, with the clash flag                                     | **Build** (PR 7): a "Schedule" action per coach (CSV/XLSX) over `game_assignments`, with a coach-clash column from `evaluateGameSchedule`. Admin only; not a coach view.                                                 | S      | No                                                                          |
| F4  | Per-team Early/Late preference                | Not for games (`early/late` matches one file, `practiceSlotExpansion.js`, which is about season boundaries). Games keep only "repeat the team's usual start" (`teamStartPreferences`, `gameScheduling.js:342`); practices have coach preference rules (`practice/coachPreferences.js`).                                                                                  | A stored preference and any use of it                                                 | **Do not build in the solver.** Generation already refuses a coach overlap outright (hard); an unplaceable game is TIME TBD with a reason. Revisit only as a flag (decision 10).                                         | M      | Yes, if ever stored                                                         |
| F5  | TeamSnap / GotSport-ready schedule export     | Only prose: "TeamSnap Integration Considerations" and "not implemented, out of scope for v1.0" (`output-generation.md:12`, `:52`; the note's "CSV only" is stale, XLSX exists). Master and per-team CSV/XLSX and `.ics` exist.                                                                                                                                           | Any platform-shaped file                                                              | **Build now** one file: SquadLogic's own schedule CSV, the import's format, so export and import round-trip (PR 7). **Build later** TeamSnap and GotSport shapes (section 5.5).                                          | S now  | No                                                                          |
| F6  | Add one game by hand                          | Cancel (`admin_cancel_game_assignment`, a hard `DELETE`, `20260613000003:68`) and move (drag and "Move to", `GameSchedulingPage.jsx:1203`). No create path in the UI; the only writer that inserts is the whole-schedule save.                                                                                                                                           | Create                                                                                | **Build** (PR 8), after Published and the import's slot helper: stage a manual game, Apply through the existing save. Starts unpublished.                                                                                | M      | One RPC (find-or-create a game slot), shared with the import; no new column |
| F7  | Fixed external fixtures that hold field time  | `packages/core/src/externalImport/` (mapping, resolution, impact, avoid windows) has no importer outside tests and says it persists nothing (`index.js:45-52`; R3). The unknown-team plan treats visiting clubs as _expected unknowns_ (`PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md` s2.2).                                                                                     | A way for an outside side to be a game participant; a way for those games to stay put | **Build, inside F10 and F9**: outside sides are flagged team rows (decision 5); imported fixtures arrive Published, so regeneration keeps their field time. Do not wire `externalImport` yet; reuse its name normaliser. | M      | Yes (`teams.is_external`), in PR 5                                          |
| F8  | A Changes log: originally versus now          | The pieces: baselines (`publication_baselines`, immutable, versioned, wired in the Exports panel), `checkBaselineParity` (named differing and removed rows), the audit trail (`game.saved`, `game.cancelled`); `buildChangeNotices` is exported (`publication/index.js:142`) and has no importer in `frontend/src` (_executed_; control: `checkBaselineParity` has one). | A per-game "originally, now, why" view                                                | **Build as a view** over baselines, the saved schedule and the new override audit rows (PR 7); no new store.                                                                                                             | M      | Read RPC only (in PR 1)                                                     |
| F9  | The Published toggle                          | Nothing enforces anything for games (finding 1). Practices have lock-by-default and `unlock`; completed seasons are read-only by trigger (`20261111010000:520-655`).                                                                                                                                                                                                     | Everything                                                                            | **Build** (PR 1 to 3), as section 3 designs it.                                                                                                                                                                          | L      | Yes (PR 1)                                                                  |
| F10 | Import an already generated schedule          | No schedule importer (`ARCHITECTURE.md:1547`). Machinery to reuse: job lifecycle, staging, application records and rollback (`20260503060000`), find-or-create game slot (`20261029010000:1008-1100`), dry-run finalizer (lesson 74).                                                                                                                                    | The import kind, mapping, preview, rollback, fixture                                  | **Build** (PR 4 to 6), as section 4 designs it; CSV, not `.xlsx`.                                                                                                                                                        | L      | Yes (PR 5)                                                                  |
| F11 | _Found:_ team page, feed, scores read `games` | See finding 5 and R1/R2.                                                                                                                                                                                                                                                                                                                                                 | Any writer of `games` from a saved schedule                                           | **Report; its own plan** (decision 12). Not fixed here; this plan does not read `games`.                                                                                                                                 | M      | Probably (a view, or readers moved)                                         |
| F12 | _Found:_ shared space and travel buffer       | Modelled and enforced for **practice** slots (`practice_slot_conflicts`, `20261029010000`; `ingestion-pipeline.md:164`); modelled but unwired for games (finding 8).                                                                                                                                                                                                     | Games honouring shared space or a travel buffer                                       | **Do not build now.** The import audit says what it did not check. Revisit with the date-indexed bridge (GAP-32).                                                                                                        | L      | No                                                                          |

## 2. Today: who writes and reads a game, and what already guards something

**Writers of `game_assignments`** (_statically reviewed_; the list is the census the Published guard has to cover,
lesson 64 "a lock that only some writers take is not a lock", lesson 73 "walk the pipeline's lists"). Members hold
`SELECT` only (`20261104010000:1488`), so every write is a `SECURITY DEFINER` function or a foreign-key cascade:

| Writer                                                      | What it does to a game                                                                                                     | Reference                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `persist_game_schedule(run_data, assignments)`              | Inserts a run, upserts every assignment on `(home, away, slot, week)`, replaces the TIME TBD list                          | `20261108020000:1763`, upsert `:2289`, TIME TBD `:2313`   |
| `admin_cancel_game_assignment(id)`                          | Hard `DELETE`, audited `game.cancelled`; the page asks with `window.confirm`                                               | `20260613000003:68`; `GameSchedulingPage.jsx:1374`        |
| Cascade from `teams` (`admin_delete_team`)                  | Deletes the team's assignments (home and away keys are `ON DELETE CASCADE`)                                                | `20261108020000` (delete team); `20260503030000:76`       |
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

`persist_game_schedule` and `admin_delete_team` are replaced whole (copied from `20261108020000`); that is a flagged
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
   takes an optional note of at most 200 characters (decision 1: whether to allow a note). Turning **on** needs none.
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
  picklist, the optional note, one tick, Confirm disabled with a visible reason until both are given; focus to the
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
`target_table` CHECKs (gain `game_assignments`, `teams`, `divisions`, `locations`, `fields` as needed);
`create_import_job`'s type list; the deferred-apply status pair; the allowlist's copies (`importAllowlist.js`,
`_shared/import-allowlist.ts`, `import_allowed_keys`, `ALLOWLIST_ENTITY_TYPES`); the Edge `import_type` enum,
`REQUIRED_FIELDS` and the sensitive-type list; the demo fence's census of writers; `fail_stale_import_jobs`; the Import
panel's tab list and telemetry; the mock finalizer; and the harness plants (re-aimed at any body the migration
replaces, lesson 70).

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
idempotency test of PR 7); build the TeamSnap shape later, when the owner supplies the downloaded current organization
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
itself as baseline "as imported" so "since import" works from day one (decision 15). `buildChangeNotices` stays
unwired: it writes to families, whom this product never contacts.

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

## 7. Tasks, pull requests, plants, stop conditions, risks, rollback

Sizes are S under 150 lines, M 150 to 500, L over 500, tests included (estimates). **Eight pull requests, at most two in
flight (AGENTS.md section 11), in waves:** PR 1; then PR 2 and PR 4; then PR 3 and PR 5; then PR 6; then PR 7 and PR 8.
Open pull requests were not checked for this plan; each PR opens only when fewer than two are in flight (check with
`gh pr list` then). Two migrations (PR 1, PR 5), within `MAX_PENDING_MIGRATIONS` (default 5,
`docs/operations/ci-cd.md`), each merged before the next. Version numbers: the next free after `20261118010000` at the
base `c3d190d`; take the next free when the PR starts. Rule 14 applies to PR 1, 2, 5, 6 and 8 (persistence or the
solver); **this plan is the stop**, and no PR starts before the owner agrees it. PR 3, PR 4 and PR 7 add no persistence.

```
PR1 Published (db, Edge) ──► PR2 pinned (solver) ──► PR3 Published (page)
   │                                                      │
   └──► PR5 import II (db) ◄── PR4 import I (fixture, core)    ├──► PR8 add a game (needs PR3, PR5)
              └──► PR6 import III (Edge, panel, E2E) ──► PR7 reports (needs PR1, PR6)
```

**Cost note for every PR (the owner's budget rules, 2026-11-03).** Run only the touched test files while iterating; one
`npm run test:coverage` at the end; run only the **new** E2E feature locally, after `bddgen`; pgTAP and the `dbharness`
plants run in CI (they need the local Supabase stack); **no `/code-review` rounds** (see section 9: this departs from
AGENTS.md section 3 and needs the owner's confirmation, decision 16); docs stay short: one dated paragraph per doc in
each PR's "Docs" line, plus the fixture README. Each PR's description lists what it did **not** run. No PR adds a
dependency, and `check:unused`, `check:advisors` and `check:bundle` are part of CI as always; the new pages are built
lazy-loaded like the others, so the bundle budget is not expected to be the constraint.

### PR 1: Published, database and Edge (L; migration; rule 14)

- [ ] A1 (L) Migration: the three columns and partial index; the two `audit_actions`; the guard trigger;
      `admin_set_games_published`; `get_schedule_audit_log`; `persist_game_schedule` with the omission refusal;
      `admin_cancel_game_assignment` and `admin_delete_team` refusals. `docs/sql/<v>_revert.sql` (the previous bodies
      from production's text, lesson 87's method) and `_smoke.sql`; `supabase/catalog-snapshot.json` regenerated.
      **First, write `supabase/tests/game_published.sql` red against today's code**: one assertion per row of 3.3 and
      per gate of 3.4; each refusal paired with a control that the **unpublished** twin passes (a trigger that refuses
      everything fails the control); a signed-in caller and a no-user caller; cross-organization ids; a completed
      season; the audit rows' count and content, and the 2,400-id row's size measured; an unchanged value is a no-op.
- [ ] A2 (S) Edge: `_shared/game-persistence-errors.ts` maps `game_published` and `game_published_omitted` to 409
      `GAME_PUBLISHED` with the ids, and **leaves every other error as it is**. Test `tests/gamePersistenceErrors.test.js`
      (the shape of `tests/practiceEnactEdge.test.js`): both codes map; an unrelated 22023 and a 500 are unchanged.
- [ ] A3 (S) Core `packages/core/src/gamePublished.js` (pure, registered in the index): the closed reason list, a
      splitter, `publishedOmissions(saved, payload)`, the Zod schema of the set payload. Test `tests/gamePublished.test.js`,
      including that the four shared reason codes equal `GRID_OVERRIDE_REASONS`.
- [ ] A4 (M) Mock client mirrors the RPCs and the guard. Test `tests/mockGamePublished.test.js`: **one input that reaches
      every outcome** goes through the mock and the pure helper and their answers must agree (lesson 77's twin).
- [ ] A5 (S) Docs: `docs/architecture/game-scheduling.md` (the Locking paragraph and the "COMPLETE" note corrected),
      `docs/MODEL_GAPS.md` GAP-29 and GAP-35 (a dated note: the stored flag is Published), `docs/PUBLICATION_PARITY.md`
      (the relation in 3.1), `docs/LESSONS_LEARNED.md` (section 12).

Plants (each turns the named test red, then is reverted; `scripts/dbharness/prove.sh` entries): the guard's column list
omits `home_team_id` (the "refuses a team swap on a Published game" case); the omission check removed (the "save that
omits a Published game is refused" case); `admin_set_games_published` stops requiring a reason when turning off.
Stop and report if: any existing pgTAP file turns red; the harness refuses a plant aimed at a replaced body; a second
migration is needed; the audit row for 2,400 ids is over 100 KB (then store a count and a digest, and say so).

### PR 2: the generator keeps Published games (M; no migration; solver, rule 14)

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

### PR 3: Published on the Games page (L; no migration)

- [ ] C1 (M) The switch and the card text. Test `tests/gameCardPublished.test.jsx`: role, name, state in words, axe
      clean, both themes' tokens only.
- [ ] C2 (M) The bulk bar and the scope resolver. Test `tests/gamePublishedBulk.test.jsx`: a scope is enumerated from
      the **saved set**, not the filtered view (a filter active, the count still the saved count); the count is shown
      before the call; a refused call shows the database's words.
- [ ] C3 (M) The "Allow changes" dialog. Test `tests/gamePublishedOverrideDialog.test.jsx`: Confirm disabled with a
      visible reason until a reason and the tick are given; focus to the heading and back; a refusal is an alert.
- [ ] C4 (S) Guards in `moveGameTo`, the cancel handler and the drag handle. Test `tests/gameGridPublishedGuards.test.jsx`:
      a drop and the keyboard "Move to" are both refused with the sentence; cancel asks for "Allow changes" first.
- [ ] C5 (S) The Exports "Publish" checkbox (decision 3). Test: the bulk call carries exactly the exported ids.
- [ ] C6 (M) One E2E feature `tests/e2e/features/published_games.feature`: publish a division; try to move one (refused);
      allow changes with a reason; move it; publish again; the history shows the reason; regenerate and see the
      Published games unmoved; axe in both themes. Run after `bddgen`; only this feature locally.

Plants: the guard removed from `moveGameTo` (the drop and keyboard cases); the scope resolved from the filtered view; the
dialog's Confirm enabled with no reason.

### PR 4: Import I, the fixture and the pure core (L; no migration)

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

### PR 5: Import II, the database (L; migration; rule 14)

- [ ] E1 (L) Migration: `import_type` and `job_type` `games` through every list of 4.10; `game_assignments.import_job_id`
      and `external_ref`; `teams.is_external`; `ensure_game_slot` (an admin RPC, audited `game.slot_created`);
      `map_game_import_job`; `apply_game_import_job(job, dry_run)`; `rollback_game_import_job`; the
      `imported-without-time` reason; the guard's rollback exemption (3.3, 4.7). Revert and smoke; catalogue snapshot;
      harness plants re-aimed.
- [ ] E2 (L) **First** `supabase/tests/game_import_apply_rollback.sql` and the two censuses (the lists of 4.10;
      `tests/externalTeamReaders.test.js`) red against today's code, then the migration. Cases: a dry run writes nothing
      (read every table back); apply equals dry-run counts; a re-import inserts nothing and creates no run; the previous
      run's games are re-pointed (the new run is the whole schedule); a Published game is skipped, not changed; a
      conflicting file is stored and flagged; team shells land in a team run (`results.teams`) and the two checks of
      4.5 hold; rollback refuses after a change and succeeds before; a no-user job and a cross-organization job are
      refused; a completed season refuses.
- [ ] E3 (S) The mock finalizer mirrors apply and rollback. Test `tests/mockGameImport.test.js`: the fixture through the
      mock equals the pgTAP's expected counts.
- [ ] E4 (S) Docs: `docs/operations/ingestion-pipeline.md` (a games section), `docs/architecture/gotsport-import-contract.md`
      ("Schedule import: kept fields"), `docs/ARCHITECTURE.md` (the "no schedule importer" gap closed).

Plants: the dry run writes; the `ON CONFLICT` upsert removed (a re-import duplicates); rollback's "changed since"
refusal removed. Stop and report if the two checks of 4.5 fail (smallest input: one division, two empty shells, twenty
players), if the nine teaming suites move, or if a reader of `teams` cannot be classified.

### PR 6: Import III, validation, panel, E2E (L; Edge and UI; rule 14)

- [ ] F1 (M) `import-validation` accepts `games`: the allowlist, Zod rows, the 2,400 cap, the season clock via
      `_shared/timing`. Tests: a Deno test and a vitest twin with named zones and dates (spring-forward gap refused,
      fall-back first occurrence flagged, a half-hour zone, a southern-hemisphere zone), run with `TZ` set to two other
      zones to prove the host zone is not read; a 500-row chunk timed with coverage on.
- [ ] F2 (L) The Games tab of the Import panel: upload, mapping, preview, confirm, result, rollback; accessible, both
      themes, no color-only state. Tests: `tests/gameImportPanel.test.jsx` (the confirm lists everything that will be
      created; nothing is created without it; each unmapped row is listed with its reason).
- [ ] F3 (S) The twin: `tests/gameImportPreviewTwin.test.js` requires the preview's counts, its conflict audit and the
      saved result to agree over one file that reaches every outcome.
- [ ] F4 (M) E2E `tests/e2e/features/schedule_import.feature`: import the fixture, map the outside clubs, see the flagged
      conflicts, confirm, see the games Published, roll back. Only this feature locally.

Plants: the conversion reads the host zone; an unmatched label created without the confirm list; the preview's counts
computed apart from the dry run.

### PR 7: reports (M; no migration)

- [ ] G1 (S) Day Sheet (5.1). [ ] G2 (S) Coach schedule (5.1). [ ] G3 (S) The SquadLogic schedule CSV, whose test
      exports the fixture's imported schedule and re-imports it as a dry run: **zero changes**. [ ] G4 (M) "Changes since
      publication" (5.6). [ ] G5 (S) Optional "record as baseline" at import (decision 15). Tests: as 5.1 and 5.6, each
      with a case for a cancelled game and a TIME TBD game.

Plants: the Day Sheet filters by a venue's display name, not its id; the coach schedule omits assistant coaches; the
Changes view enumerates from the changed rows only (a cancelled game vanishes).

### PR 8: add one game by hand (M; no migration; rule 14 for the write path it reuses)

- [ ] H1 (M) The dialog and the staged manual game (5.5). Test `tests/gameAddByHand.test.jsx`.

Plants: a game addable over a Published slot; a double booking blocked instead of flagged; a new game arriving Published.

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
- **External teams leak into team lists, counts and files.** Watch: the PR 5 census. If a reader is missed: it is a
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

### Rollback

PR 1: its `_revert.sql` drops the trigger, RPCs and columns and restores the previous function bodies (production's
text); the flags are lost, which the revert's header says; the two `audit_actions` rows stay (harmless; audit rows keep
pointing at them). PR 2, 3, 4, 7, 8: code only, each reverts alone. PR 5: its `_revert.sql` drops the columns, RPCs
and CHECK entries; imported games stay but lose their provenance, so roll an import back **before** reverting. PR 6:
code only. A revert never runs automatically (`ci-cd.md`).

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

## 9. Against the rules (checked)

- **AGENTS.md rule 14:** applies to PR 1, 2, 5, 6 and 8; this document is the stop. No PR starts before the owner agrees
  it. **Global re-optimisation** is not introduced: regeneration re-solves the unpublished games exactly as it does
  today, and `reoptimiseWholeSeason` stays unwired.
- **Rule 2, minimal diffs:** no refactor is proposed. Two things are flagged as costs, not done: `persist_game_schedule`
  and `admin_delete_team` are replaced whole (a migration cannot patch a function), which moves their harness plants
  (lesson 70); and the field import's find-or-create slot lookup is **copied into `ensure_game_slot`, not extracted**,
  leaving the duplication as a possible later refactor.
- **Rule 4, honest labels:** this plan labels every claim; the numbers about the owner's workbooks are _executed_ counts
  and say where they could not be reproduced (finding 9).
- **Rule 5, trust boundaries:** every id is validated against the organization; the file is validated in the Edge
  function and again in SQL; no time is recomputed in SQL; no error is swallowed (the guard names the game).
- **Rule 6 and the Verification conventions:** each task names its test; each PR has at most three plants; subject sets
  are enumerated from the saved set, the roster or the code, never from the thing a break would corrupt (scope
  resolution, the audit's teams, the Changes view); "declared is not enforced" is answered by the coverage sentence;
  nothing is parsed and left unread (the `Format` and `Notes` columns are dropped, not stored); the adopted contracts
  are the siblings' (`unlock` and `GRID_OVERRIDE_REASONS`, the completed-season exemptions, `normaliseExternalLabel`,
  the evaluators' warning names).
- **Core principles:** all persistence through RPCs; every payload validated by a Zod schema (A3, F1); every state change
  audited in its transaction; WCAG 2.2 AA with a non-drag path (section 3.6); backward compatible by default (the flag
  defaults off, `pinned` is optional, `is_external` defaults false).
- **Section 2 scope and privacy:** nothing is excluded by section 2. Admin-only throughout: the Day Sheet, coach schedule
  and duty list are admin pages and exports, never coach-facing views. Data minimisation: a games file keeps no
  coach, email, phone or free text; a coach schedule shows names, not contacts; the audit stores actor ids and reason
  codes. No real data in the repository: the fixture is invented and the owner's workbooks stay outside.
- **Installs and dependencies:** none added; reading `.xlsx` would add one and is deferred past the dependency-update
  wave (decision 8).
- **A conflict with AGENTS.md, named:** section 3 asks for an adversarial review (`/code-review`) before every PR; the
  owner's budget rule for this work says no `/code-review` rounds. Both cannot hold. This plan follows the owner's
  rule only if the owner confirms it (decision 16); until then each PR keeps one self-review against its plants and
  stop conditions, labelled _statically reviewed_.
- **No ADR folder exists**, so the decisions are recorded here and, once settled, in `docs/LESSONS_LEARNED.md`.

## 10. Owner decisions

Each has options and a recommendation. **If the owner is silent, the recommendation applies, except decision 16, which
has no default and blocks the first PR.** Decisions 1, 2, 11 and 16 block PR 1; 14 blocks PR 2; 4, 5, 6, 13 and 17 block
PR 5; 8 blocks PR 6; the rest block nothing in this wave.

1. **Who may override, and what it needs.** Recommended: any `is_org_admin` (admin, tenant admin, staff, as every
   schedule write), signed in (no service role), a reason from the closed list (`field-change`, `coach-request`,
   `conflict-fix`, `published-in-error`, `other`), and an optional note of at most 200 characters. Alternatives: (b)
   admin and tenant admin only, not staff; (c) the picklist alone, no note (the practice grid's choice, and the safest
   for data minimisation, since a note can carry a name). Turning the flag **on** needs nothing.
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
6. **May the import create team shells, divisions and fields from the file?** Recommended: yes, only on the confirm
   step's explicit list; shells through the existing team writer so a later generation sees them; divisions by name with
   no age band and a visible flag; fields by name with no availability and a flag. Alternative: refuse unless
   everything exists (safest, but defeats "orgs may come to this to manage an already generated schedule").
7. **Which export formats.** Recommended: SquadLogic's own schedule CSV now (PR 7, the import format, so it round-trips);
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
12. **The legacy `games` table versus `game_assignments`** (F11, finding 5). Recommended: a separate small plan, before
    PR 7 if possible, to point the team page, the per-team files, the feed, Scores and standings at the saved schedule
    (or to materialise `games` from it). Not folded in here because it is a choice between three designs. Alternative:
    leave it, and tell the owner that team pages and feeds do not show a scheduled league's games.
13. **What a re-import does.** Recommended: update by `Game ID`, add the rest, **never delete**, list "in the schedule, not
    in this file", skip Published rows that would change. Alternative: replace the visible schedule (a re-import then
    behaves like a regeneration and would hide games; not recommended).
14. **Regeneration over unpublished games.** Recommended: unchanged (re-solve them, as today), with Published games
    pinned. Alternative: fill gaps only (the minimal-diff reading of AGENTS.md section 3); a bigger solver change, its own plan.
15. **Should an import record itself as a publication baseline?** Recommended: yes, a box that is ticked by default when
    the games arrive Published, so "changes since import" works from day one (PR 7). Alternative: no.
16. **Review under the owner's budget rule.** AGENTS.md section 3 asks for an adversarial `/code-review` before every PR;
    the owner's rule for this work says no `/code-review` rounds. Recommended: the owner confirms the budget rule as an
    explicit exception for this plan's PRs, each PR keeping one labelled self-review against its plants and stop
    conditions. No default.
17. **Week numbers for imported games.** Recommended: the `Week` column if present, else derived from the season's start
    date (4.8), required when the season has no start date. Alternative: always require `Week`.
18. **Confirm the build list.** Recommended: build F2, F3, F5 (own CSV), F6, F7, F8, F9, F10; build F1 later; do not build
    F4 or F12 now; F11 separately (decision 12).

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

## 13. Output of the planning (prompts/plan-change.md)

1. Size verdict: planned, not small (above). No test is named for a small change because none is small.
2. Departures from AGENTS.md: one, named in section 9 (the adversarial review versus the owner's budget rule), decision 16. No ADR is drafted (the repository has no ADR folder). Open questions: eighteen, each with a recommendation;
   decisions 1, 2, 11 and 16 block the first PR.
3. The first task: PR 1's A1, starting with `supabase/tests/game_published.sql`, red against today's code.
4. What the planning taught: section 12.

## 14. Resume here (for an agent with no memory of this conversation)

**Read, in this order.** (1) This plan: sections 2, 3, 4, 7, 10. (2) `AGENTS.md` sections 2 and 3 (operating rules 1 to 16,
the Verification conventions, the Definition of Done) and `docs/LESSONS_LEARNED.md` 5, 37, 42, 47, 56, 59, 64, 65, 66, 70,
73, 74, 77, 86, 87, 94. (3) The precedents to copy: `supabase/migrations/20260929000000_practice_writer_v3_lock_by_default.sql`
(header and `unlock`), `20261111010000_season_rollover.sql:520-655` (the read-only triggers and their exemptions),
`20261108020000_schedule_tbd.sql:1763-2440` (`persist_game_schedule` as it stands), `20260613000003:68`
(`admin_cancel_game_assignment`), `20261029010000:1008-1100` (find-or-create game slot), `20260503060000` (staging and
application records). (4) The pgTAP shapes: `supabase/tests/season_schedule_readonly.sql` and `practice_writer_v3.sql`
(clear the JWT claims before seeding, lesson 56), and `scripts/dbharness/prove.sh` (the plant entries, e.g. `M15`).
(5) The page: `frontend/src/pages/GameSchedulingPage.jsx` (`handleAutoGenerate:918`, `handleApplySchedule:1099`,
`moveGameTo:1203`, `handleCancelGameAssignment:1374`), `GameCard.jsx`, `GridOverrideDialog.jsx`, `gridOverridePrompt.js`.
(6) Core: `gameScheduling.js` (`scheduleGames:307`, `savedSides:84`), `gameMetrics.js` (`evaluateGameSchedule:93`),
`timing/seasonClock.js`, `externalImport/mapping.js` (`normaliseExternalLabel`).

**Re-verify before relying on anything here (main moves).** `git log -1` and the highest file in `supabase/migrations`
(it was `20261118010000` at `c3d190d`); then re-run the searches of section 11 (R1 to R5 and the absence counts) and read
the numbers against it; confirm `scheduleGames` still has no `pinned` and still refuses `freeze`; confirm no other
writer of `game_assignments` has appeared (R5). The owner's two workbooks are **outside the repository**; if a
figure from them is needed again, ask the owner for the files and recompute counts only. Never copy a name or value.

**Order of work.** PR 1; then PR 2 and PR 4; then PR 3 and PR 5; then PR 6; then PR 7 and PR 8 (section 7). Two in flight at
most. Nothing starts before the owner agrees this plan (rule 14) and answers decisions 1, 2, 11 and 16; record the answers
in the "Status" line at the top, as the earlier plans do.

**Open decisions.** Section 10. The ones with no safe default: 16. The ones that change the migration: 1, 2, 4, 5, 6, 11, 13, 17.

**How to start PR 1 without re-deriving anything.**

1. `git fetch origin main`; branch `feat/game-published-db`; check that fewer than two pull requests are open.
2. Write `supabase/tests/game_published.sql` first, from `season_schedule_readonly.sql`'s skeleton: one assertion per row
   of 3.3 and per gate of 3.4, each refusal beside an unpublished control. Run it (CI, or the local stack) and get it red.
3. Write the migration: copy `persist_game_schedule` and `admin_delete_team` whole from `20261108020000`, and
   `admin_cancel_game_assignment` from `20260613000003`; add the columns, the two `audit_actions` rows, the guard
   trigger (exemptions copied from `20261111010000`), `admin_set_games_published` and `get_schedule_audit_log`; pin each
   new function `SET timezone = 'UTC'` and `SET search_path = public`; `REVOKE` from `PUBLIC` and `anon`, `GRANT` to
   `authenticated`. Then `docs/sql/<v>_revert.sql` and `_smoke.sql`, the plants in `prove.sh`, and the regenerated
   `supabase/catalog-snapshot.json`.
4. Then A2 to A5 of section 7 in that order, running only the touched test files, one coverage run at the end.
5. Do **not**: wire `freeze/` or `resolve/`; read or write `games`; add an `.xlsx` dependency; change
   `assignment_source` or its `locked` mapping; edit `prompts/` or the template skills; copy any value from the owner's
   workbooks; use the word "override" for anything but "allow changes" (finding on the Edge `overrides` field).
