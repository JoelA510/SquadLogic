# The games table as the source of truth (F11): what identifies a game, where its score lives, and which pages read the saved schedule

Kind: REFACTOR with a persistence change (a score store, game identity, one read of the saved schedule).
Drawn up: 2026-11-06 against `origin/main` `c3d190d`. Owner: the repository owner.
Status: **APPROVED by the owner, 2026-11-07 (see "Owner answers (2026-11-07)" under "Owner decisions"); this change itself is plan only: no code, migration, test or fixture is written by it.** This is the F11 plan that
decision 12 of the schedule-expansion plan requires the owner to approve before PR 5 starts. AGENTS.md rule 14 applies
(persistence and the domain model), so nothing here is built until the owner agrees. The expansion plan is
`docs/changes/2026-11-03-schedule-expansion.md` (on `main` since PR 1, #707; when this was drawn up it was on the branch
`claude/vibrant-allen-hr7y7s-schedule-expansion-plan`); "expansion section N" below means that file.

## Labels and method

Every claim about the code is _statically reviewed_ (read) unless marked _executed_. _Executed_ means a search was run in
a clean worktree of `c3d190d` on 2026-11-06, or a read-only `SELECT` was run against the production project (counts and
catalogue reads only: nothing was written and no migration was applied). Nothing in this plan comes from a test run, a
build or a migration, and nothing is _fully validated_. The "Receipts" section lists every search and query with its
count, and what was not run. A claim of absence was made only after a search that matches something; the positive control
is named beside it. This plan did not have the owner's workbooks and uses nothing from them.

## Why

`docs/product.md`: administrators send schedules to coaches and families themselves, by export (CSV, XLSX, ICS) or a
team's calendar link; nobody else signs in. An administrator who scheduled a league on the Games page can open a team
page, download a team's file or subscribe to its calendar and, by the code, get no games: those readers read the older
`games` table and no schedule save fills it. Scores and standings read and write the same table. Every new feature in the
expansion (Published, the schedule import, the Day Sheet, the changes log) is built on the saved schedule
(`game_assignments`), so the gap widens with each pull request unless one record is chosen as the truth and the others
follow it.

## Size verdict (prompts/plan-change.md, Step 0)

Planned, not small. It meets: spans more than one pull request (five are proposed); changes a data model and a migration
(a score store, a season on a saved game, one view); changes behaviour other code and people rely on (what a save does to
a moved game, which pages show a schedule, how standings are computed); touches persistence and the domain model, which
is AGENTS.md rule 14. It does not meet: no dependency, no service, no environment variable, no new authorization model
(every write stays an admin RPC that checks `is_org_admin`).

## Findings that change the question (re-verified at `c3d190d`)

The earlier static review said five things about `games`. All five were re-checked; four hold as written and one is wider.
Ten findings follow; each says what was re-run. The numbers are in "Receipts" (F-R1 to F-R14).

1. **Nothing writes `games` from a saved schedule, and the only product code that writes it is the score function.**
   There are three `INSERT INTO games` outside tests and docs: two 2024 demo seeds and one harness scenario (_executed_,
   F-R2). `update_game_score` is the only live function that updates the table (_executed_ against the production
   catalogue, F-R4); the latest `persist_game_schedule` (`20261108020000:1763`) never names `games` (_executed_, F-R3) and
   neither does `admin_cancel_game_assignment` (`20260613000003:68`). The six product files that query the table only
   select from it (_executed_, no write call in any, F-R5). The expansion's claim holds.
2. **The readers of `games` are two more than the expansion lists.** The expansion names the team page and the per-team
   CSV/XLSX export (`fetchTeamEvents`, `useTeamPortal.js:195`, shared with `ScheduleExports.jsx`), the calendar feed
   (`teamFeed.ts:154`, read with the service role), Scores (`ScoresPage.jsx:56`) and Standings (`LeagueStandings.jsx:69`).
   Two more read it: the Dashboard's "Games scheduled" count and "Upcoming games" list (`DashboardPage.jsx:107`, `:287`,
   `:409`) and the Player record's next games with scores (`PlayerRecordPage.jsx:95`). The mock client keeps its own
   `games` table (`mockSupabaseClient.js:441`, `:1817`, `:4485`). In SQL the live catalogue names `games` in four
   functions (`update_game_score`, `admin_delete_team`, `field_bookings`, `rollback_field_import_job`) and one view
   (`view_league_standings`); no policy and no foreign key points at it (_executed_, F-R4). The migration files name the
   table in 20 files, which overstates the live set: `coach_field_ids_of` (`20261102010000:238`) read only `games` and was
   dropped by `20261104010000:829`. A census by file finds stale bodies; read the live definition (lesson 87's method).
3. **`view_league_standings` is `teams` left-joined to a CTE over `games`, and it is `security_invoker`.** The live
   definition (_executed_, F-R7) equals `20261023010000:65`. The CTE is named `game_results` but there is no results table.
   There is no filter on the team side, so an outside club's team row would get a standings row (expansion 4.6 (i)).
4. **A score is keyed by `games.id` and by nothing else.** `update_game_score` (arguments: organization, game id, the two
   scores, metadata; latest body `20261028010000:108`) selects the `games` row by id and organization, checks both teams
   belong to the organization, requires `is_org_admin` and the `score_entry` setting (55000 while off), writes the two
   columns and one `competition.score_updated` audit row with the previous values. Scores and Standings pass the `games.id`
   of their own `games` query. There is no key from a score to a saved game, a team pair or a week.
5. **`games` cannot hold what the saved schedule can.** `games.game_slot_id` is UNIQUE (`games_game_slot_id_key`, live
   index, F-R6), so a slot holds one `games` row. The generator accepts a slot capacity above one (`gameScheduling.js:484`,
   `remainingCapacity: slot.capacity`) and the import plans to store two games on one field and start as two assignments on
   one slot (expansion 4.7, step 2). `docs/ARCHITECTURE.md:366-369` already calls the pair a contradiction.
   `game_assignments` allows both. Any design that fills `games` must relax the index or drop a game from the team page.
6. **A saved game has no stable identity: a move or a flip inserts a new row with a new id and leaves the old row
   behind.** The save upserts on `(home_team_id, away_team_id, game_slot_id, week_index)` (`20261108020000:2289`) and its
   `DO UPDATE` leaves `id` alone, so an unmoved game keeps its id and takes the new run. A move changes the slot and,
   through the target slot, the week (`moveGameTo` sets `weekIndex` from the slot, `GameSchedulingPage.jsx:1261`), so the
   tuple is new: a new row is inserted and the old row stays in its earlier run, invisible. A regeneration does the same
   for every game that lands elsewhere. The payload's own `id` is never read (the RPC reads only `run_data->>'id'`; the
   Edge schema already passes an optional `id` through, `game-persistence/index.ts:46`). The Phase D plan records the flip
   as intended (`docs/changes/2026-10-22-phase-d-home-away.md:29-34`). **Consequence for the expansion:** every per-game
   promise keyed to a row id breaks at the first move: the per-game audit history (`get_schedule_audit_log`, expansion
   3.4), Published (3.2), the Game ID (4.7) and a score. PR 2's carried games are safe only because their tuple does not
   change.
7. **A saved game does not know its season.** `game_assignments` has no season column (live column list, F-R6). The season
   is reached through the run (`run_id`, `ON DELETE SET NULL`) or through the team's division (what the completed-season
   trigger does). The Game ID of expansion 4.3 needs a scope, and an organization-wide unique `external_ref` would refuse a
   platform that reuses its numbers from one season to the next.
8. **Production holds nothing to migrate, and runs with scores and standings off.** `games` 0 rows, 0 with a score;
   `game_assignments` 0; `game_slots` 0; game runs 0; teams 0; players 0; `competition.score_updated` audit rows 0. One
   organization, one season, one program, 32 divisions. The organization's `feature_flags` hold four keys, none of them
   `score_entry` or `standings`, so both are off (_executed_, F-R8). The migration ledger is at `20261118010000`, the same
   as the repository. The question is the shape of the next leagues, not the repair of one.
9. **The Games page and the master export see one run.** `useGameAssignments` reads `game_assignments` with
   `.eq('run_id', runId)` and `useSchedulerRun` picks the latest completed game run of the active season. "Which rows are
   the schedule" is a rule that exists once, in JavaScript. A new reader (team page, feed) must copy it or get it from one
   place.
10. **The completed-season read-only rule already covers the score table's place.** `games_readonly_when_completed` runs
    `season_schedule_readonly_when_completed`, which reads a season from `team_id`, `home_team_id` or `away_team_id` (lesson
    66: the table that holds the results is on the read-only list too). A new score table with the two team columns joins
    that rule with one `CREATE TRIGGER` and no change to the function.

## Behavior

- **Now.** The Games page, the master export and the Exports panel read the saved schedule. The team page, per-team CSV
  and XLSX, the calendar feed, the Dashboard's game count and list, the Player record, Scores and Standings read `games`,
  which no save fills. Score entry writes `games`. A move or a regeneration saves a moved game as a new row with a new id.
  In production there is no league yet to show any of this (F-R8), and score entry and standings are off.
- **After (recommended option A, with the identity layer of the next section).** After any save, the team page, the
  per-team files, the feed, the Dashboard and the Player record show the saved schedule. A score is stored against the
  game's stable id, survives a move or a regeneration that the rules allow, and a scored game is held like a Published one
  (it is not moved, cancelled or dropped by a save, a regeneration or an import until its score is cleared). Standings are
  computed from scores. An outside club never has a standings row; an own team's result against an outside club is not
  counted unless the organization (later: the program or division) says so.
- **Unchanged (each is a test; the task list names it).**
  - The Games page, the master export and the Exports panel give the same output for the same saved schedule; the baseline
    header pin in `tests/outputGeneration.test.js` is unchanged. Exports carry no score and no Published column.
  - `scheduleGames` with the same input gives the same output, byte for byte; `freeze` is still refused. This plan does not
    touch the solver.
  - `update_game_score` keeps its name, argument list, result keys, authorization (`is_org_admin`, the `score_entry`
    setting, 55000 while off, 22023 for a completed season) and audit action. Call sites do not change.
  - `view_league_standings` keeps its columns and their order. Any column added is appended last.
  - A completed season stays read-only for scores.
  - A league that never enters a score: the games a sequence of saves leaves visible are the same set (teams, sides, slot,
    week, field, time) as today; only the row ids of moved games differ, and that is the point.
  - Deleting a team that has no Published game removes its games and scores as it does today, and says how many.
  - The practice side, the roster statuses and the readers of teams that expansion 4.6 classifies are not touched.

## Out of scope

- A coach, family or public page (none exists). The practice side. Wiring `freeze/` or `resolve/`. Forfeit, void or
  postponed result kinds, tie-break rules, or any change to how a record is ranked. Who may enter scores.
- Building the program- and division-level settings cascade (it is sized here and left to its own plan: see "The settings
  cascade"). A per-fixture override of the standings policy (named, not built).
- Dropping the legacy `games` table (a last, optional pull request; decision D9).

## Against the rules

- **Rule 14 (stop and agree a plan first):** this plan is the stop. It touches persistence and the domain model (game
  identity). It does not touch the solver: `scheduleGames` is unchanged; the page hands `pinned` (expansion 3.5) more
  entries. No global re-optimisation is introduced.
- **Rule 2 (minimal diffs):** retiring the readers of one table is a refactor beyond any single request, and this plan is
  the flag for it, with the cost of the status quo (no schedule on the team page) and the risk of the change (section
  "Risks"). Functions replaced whole: `persist_game_schedule` (once, inside PR 1), `update_game_score`,
  `view_league_standings`; `admin_delete_team` and `admin_cancel_game_assignment` are already replaced by PR 1 and take a
  small addition. Every replacement moves harness plants (lesson 70). `field_bookings` and `rollback_field_import_job`
  keep a `games` arm that reads an empty table; they are left alone.
- **RPC enforcement, Zod, audit immutability, RLS (AGENTS.md section 3):** the new table has no write policy; its only
  writer is `update_game_score`, which keeps its audit row in the same transaction; the page's call keeps its existing
  Zod/`parseScoreInput` validation; members read, admins write through the RPC.
- **Verification conventions:** subject sets are enumerated from the saved games and from the code, never from the data a
  break would corrupt (the carry test lists saved games, the reader census lists readers from the code); no test proves a
  reader of the saved schedule by inserting into `games` (that forges state the product cannot reach); "declared is not
  enforced" is answered by one function the settings seam goes through, pinned by a test.
- **Data rule:** a Game ID is text and is compared exactly (after trimming); it is never a number (leading zeros).
- **No accepted ADR departs.** The repository has no ADR folder; the decision is recorded here and, once settled, as a
  lesson in `docs/LESSONS_LEARNED.md`.

## Two questions, not one

The four criteria look like four questions. They are two.

- **I. Identity: what is "the same game" after a save, a move, a regeneration, a re-import and a republish, and what
  stops a played game from being displaced?** Criteria 2 and 3 are decided here, and the answer is the same whatever
  table holds the score.
- **II. Placement of the record: where does the score live, and how do readers get the saved schedule?** Criteria 1 and 4
  are decided here, and this is where the options differ.

**The identity layer (I), common to every option except where noted.**

- **I1. Saves update a game in place.** `persist_game_schedule` accepts an optional `id` on an assignment row (the Edge
  schema already passes it through). A row whose `id` names a game of this organization is updated in place (slot, field,
  start, end, week, source, run); a row without an `id` is upserted on the tuple exactly as today. A game keeps its id for
  its whole life; only deleting it ends the id. A held game is refused as the guard (expansion 3.3) already says.
- **I2. Regeneration continuity is a pure matcher in core,** next to `savedSides`: `carryGameIds(saved, generated)` gives
  a regenerated assignment the id of the saved game it continues, by the same unordered pair, preferring the same week and
  then the nearest unclaimed week, one saved game to one regenerated game. The server only validates (the id exists in the
  organization, appears once in the payload, and the change is allowed); a client's answer is a proposal (lesson 53).
- **I3. One held predicate.** A game is held when it is Published (expansion 3.2) or has a score (this plan). PR 1's
  trigger, the cancel, the omission check, `pinned` (the page's pin set), PR 5's apply and PR 5's rollback all ask the same
  `game_is_held` function; adding scores later changes one body (lesson 64: a lock only some writers take is not a lock).
  A held game is carried unchanged by a regeneration, skipped by an import update, refused by a move, a cancel and a save
  that omits it.
- **I4. The season is stored on the game.** `game_assignments.season_settings_id`, set by the save and by the import's
  apply, so the Game ID is unique per season, "every published game of the season" is a direct filter, and `ScoresPage`
  needs no division lookup.

**Definition of "survives" (criterion 2), so it can be tested.** After any sequence of regenerations, moves and re-imports
that the held rule permits, a score is still on the same game id, the game is still in the visible schedule, the score is
shown on the Scores page and counted once in standings; and a sequence the held rule refuses writes nothing.

## The options

Five designs, compared on what changes, migrations, rule 14, the production rows, backward compatibility and the proof.
"Option 0", expansion decision 12's alternative (leave it and tell the owner that team pages and feeds show nothing for a
scheduled league), is the baseline and is not recommended: the gap widens with PR 5 and PR 7.

### A. Repoint every reader to the saved schedule; scores in their own table keyed by the game's id

- **What changes.** A table `game_scores` (`game_id` primary key; the organization; the two team ids as scored; the two
  scores, both required; timestamps and `updated_by`), with a composite foreign key from `(game_id, organization_id,
home_team_id, away_team_id)` to the saved game, so a game's sides cannot change under a score (the database says so, for
  every writer). `update_game_score(p_game_id)` keeps its signature and now names a saved game: it inserts, updates or (for
  a clear) deletes the score row and audits as before. `view_league_standings` is rebuilt over `game_scores` and `teams`.
  One view, `current_game_runs` (organization, season, the latest completed game run), is the single SQL definition of "the
  schedule"; the team page, per-team files, feed, Dashboard, Player record and Scores read `game_assignments` for that run.
  The identity layer (I1 to I4). `games` stays, unread, until the optional drop.
- **Migrations.** One (F11-2), plus the identity layer: zero extra if it rides PR 1's migration (PR 1 has not started at
  this writing), one extra if PR 1 has merged first.
- **Rule 14.** Persistence and the domain model: yes. Solver: no.
- **Production rows.** None to move (0 rows, F-R8). A fresh build holds the two 2024 seed rows and a harness build holds
  more; the migration copies a legacy score only where exactly one saved game matches its home, away and slot, and
  **refuses** (nothing applied) if a scored legacy row has no match. In production both counts are 0, so it does nothing
  there (lesson 87); the harness plants a scored legacy row first (lesson 67: a migration over an empty table proves only
  that it parses).
- **Backward compatibility.** `update_game_score`, the standings columns and the call sites keep their shape. Each reader
  file changes. The mock client gains `game_scores` and `current_game_runs`. The four live SQL readers of `games` keep
  working on an empty table.
- **Proof.** pgTAP `supabase/tests/game_scores.sql` through the real save (a move, a regeneration, a clear, a cancel, a
  rollback, a completed season); a reader census from the code; each reader's test through `persist_game_schedule`, not
  through an insert into `games`.

### B. Fill `games` from each saved schedule (a projection kept in step)

- **What changes.** Every writer of the saved schedule also writes `games`: `persist_game_schedule`,
  `admin_cancel_game_assignment`, `admin_delete_team` (the cascade), the slot cascades, the import's apply and rollback,
  add-by-hand (rides the save), the demo purge and retention. Done inside each function that is eight places; done as an
  `AFTER` trigger on `game_assignments` it is one place, but "visible" is a property of the run table, not of a row, so a
  second trigger on `scheduler_runs` would have to reconcile the whole season on every save without deleting a scored row.
  `games.game_slot_id` UNIQUE has to go (finding 5) or shared-slot games vanish from the team page. `games.id` is a
  second id for a game that already has an assignment id and a Game ID.
- **Migrations.** One (the projection and the index change), plus the identity layer, which it needs because a move
  re-keys the projected row and its score exactly as it re-keys the saved game.
- **Rule 14.** Persistence widely: at least six functions replaced whole, six sets of plants moved (lesson 70).
- **Production rows.** None in production; the projection must adopt or delete the seed rows on a fresh build.
- **Backward compatibility.** Best for readers (none change); worst for writers (every new writer must remember `games`).
- **Proof.** A parity test that `games` equals the visible schedule after each of save, move, regenerate, cancel, import,
  rollback and team delete. Its subject set must come from `game_assignments`, not from `games`, or it compares a set
  against itself.

### C. Keep reading `games`, but make `games` a view over the saved schedule joined to a scores table

- **What changes.** Rename the legacy table (`games_legacy`), create a view named `games` with the old column names
  (`id` = the saved game's id, `start_time` = its start, the score columns from `game_scores`, `season_id` from I4), over
  the current runs. `game_scores`, `update_game_score`, standings and the identity layer are exactly option A's. No
  reader file changes.
- **Migrations.** One, plus the identity layer.
- **Rule 14.** As A, plus the view in the middle of every reader.
- **Production rows.** As A (the renamed table is empty).
- **Backward compatibility.** Best of the one-source options for readers. Costs and unknowns: PostgREST has to embed
  `teams` and `game_slots` through the view (`home_team:home_team_id (...)`) and the feed's
  `teams!games_home_team_id_fkey` hint style has to resolve against a view, neither verified here (U1); `admin_delete_team`
  locks `games` rows with `FOR UPDATE`; the three `INSERT INTO games` outside tests (two seeds, one harness scenario) and
  eight pgTAP files that insert into `games` must change; and the name `games` then means a derived thing.
- **Proof.** As A, plus an embed test per reader against the local stack.

### D. Scores on `game_assignments` (the single record)

- **What changes.** Two nullable columns on `game_assignments` (and who/when); `update_game_score` updates the saved game;
  standings read `game_assignments`; the readers repoint as in A. The held trigger must treat the score columns as not
  placement. The identity layer (I1 to I4).
- **Migrations.** One (could ride PR 5's migration, which already adds columns to `game_assignments`, but PR 5 is large
  and is gated on this plan), plus the identity layer.
- **Rule 14.** As A.
- **Production rows.** As A.
- **Backward compatibility.** As A.
- **Proof.** As A.
- **Why it is not the recommendation.** It is the smallest schema, and with the identity layer it survives as well as A.
  But (i) `update_game_score` becomes a writer of the schedule table, widening the census every guard has to cover; (ii) a
  score on a hidden earlier-run row is invisible to the Games page and countable by a standings query that forgot the run
  filter, so two readers can disagree about one number (lesson 92); (iii) the per-fixture override the owner accepted
  ("later") and any future result kind go on the placement row, which is the row that churns; (iv) deleting the row deletes
  the score, and the only thing between a cancel and a lost score is a check each deleter must remember, where in A the
  foreign key refuses it for every deleter.

### E. Make `games` the stable game record and `game_assignments` its placement

- **What changes.** `game_assignments.game_id` references `games(id)`; `games` stops holding placement (its slot, venue and
  start columns are dropped or ignored) and holds the identity, the Game ID and the score; the save find-or-creates a
  `games` row for each placement it writes; readers join placement to game.
- **Migrations.** Two (a backfill phase and a `NOT NULL` phase), plus matching still has to decide which existing game a
  new placement continues.
- **Rule 14.** Persistence and the domain model, deepest: it amends PR 1's data model (Published and the audit history
  are keyed by the placement row; the score and the Game ID by the game) and PR 5's `external_ref`.
- **Production rows.** None.
- **Backward compatibility.** Score readers could keep reading `games`; every placement reader still moves.
- **Proof.** As A, plus the backfill.
- **Why it is not the recommendation.** It is the cleanest model and the largest diff, and it gives one game two ids across
  the expansion (the placement id in PR 1, 3, 7 and the game id in the score and the Game ID). A is the same model with
  the placement row's id promoted to the game's id.

## The four criteria, per option

| Criterion                         | A                   | B                                                              | C    | D                                                 | E                                      |
| --------------------------------- | ------------------- | -------------------------------------------------------------- | ---- | ------------------------------------------------- | -------------------------------------- |
| 1. One source of truth            | Yes                 | **No**: two copies of where and when                           | Yes  | Yes                                               | Partly: two tables per game            |
| 2. Scores survive regeneration    | Yes, with I1 to I3  | Only with I1 to I3 and a projection that never deletes a score | As A | Only with I1 to I3; hidden rows keep stale scores | Yes, with matching and I3              |
| 3. Identity stable, incl. Game ID | Yes, with I1 and I4 | **No**: three ids (`games`, assignment, Game ID)               | As A | As A                                              | Yes by construction; amends PR 1 and 5 |
| 4. Standings policy               | Same cost           | Same cost                                                      | Same | Same                                              | Same                                   |

**Evidence, per criterion.**

- **1.** B fails by construction: where and when would live in two tables kept in step by every writer (lesson 64), and the
  unique index on `games.game_slot_id` cannot hold a shared slot (finding 5). C, A and D have one table for placement. E
  keeps two entities per game, with the legacy placement columns either dropped (a larger migration) or left as a second
  copy.
- **2.** The score survives when the game keeps its id (I1, I2) and a played game cannot be displaced (I3). No option gets
  this from where the score is stored: under D and under today's `games` a moved game gets a new row and the score stays on
  the old one (finding 6). The only difference between the options is what refuses the loss: in A and C the foreign key
  (`NO ACTION`) refuses any deleter that did not deal with the score; in D and B it is a check each writer remembers.
- **3.** Finding 6 is the whole of it. A game's id changes today at the first move. Under A, C and D the answer is I1
  (update in place) with the Game ID on `game_assignments` as PR 5 plans, unique per season (I4). Under B the projected
  `games.id` would re-key on every move. Under E the game id is stable but PR 5's `external_ref` and PR 1's per-game audit
  history would be keyed differently.
- **4.** None of the options differs. The policy needs: the two team ids on the score record (A, C, D and E have them; B has
  them on `games`), `is_external` on teams (PR 5), and a resolver for "does this division count results against outside
  clubs" (the settings cascade). Where a later per-fixture override would live differs: on the score row in A and C (the
  natural place), on the placement row in D.

## Migration fit

The CI guard refuses a deploy when more than `MAX_PENDING_MIGRATIONS` (default 5) are waiting to be applied
(`scripts/ci/migrationGuard.mjs`, `docs/operations/ci-cd.md:207`). It counts what is pending at one deploy, not the plan's
total, and the expansion's rule that a migration pull request waits for its predecessor's deploy keeps the pending count
at one. The expansion counts cumulatively as a conservative bound (four: PR 1, 5, 10, 12); this table reports both.

| Option | New migrations          | Cumulative with the four | Fits five?               |
| ------ | ----------------------- | ------------------------ | ------------------------ |
| A      | 1 (identity rides PR 1) | 5                        | Yes                      |
| A      | 2 (identity separate)   | 6                        | Only by the waiting rule |
| B      | 1 (identity rides PR 1) | 5                        | Yes                      |
| C      | 1                       | 5                        | Yes                      |
| D      | 1 (may ride PR 5)       | 5 (or 4)                 | Yes                      |
| E      | 2                       | 6                        | Only by the waiting rule |

The settings cascade (below) is one more migration for any option unless it rides PR 12's. Dropping the legacy table is one
more, later, and deploys alone. Recommended path: five in total (PR 1 with the identity layer, PR 5, F11-2, PR 10, PR 12
with the settings storage).

## Recommendation

**Option A, with the identity layer I1 to I4, with C available as a variant at the readers' pull request.** The reasons,
each from the evidence above:

- It satisfies criteria 1 to 3 with three named amendments to PR 1 and PR 5 (the season column, in-place saves, one held
  predicate), as C and D do and as B and E do not (B fails criterion 1; E re-keys PR 1's history and PR 5's Game ID). The
  expansion already treats the saved game's id as the game (PR 2's plant "carried rows re-identified", PR 1's per-game
  history, PR 5's update in place), and A makes that true.
- Against its closest rivals: D has the same identity layer and a smaller schema but puts the score on the row that churns
  and leaves the guarantee to each writer; C has the same backend and saves the reader edits, at the price of an unverified
  PostgREST behaviour and a table that changes meaning (hence "available as a variant", not the lead).
- The structure that protects a score is in the database, not in each writer: a foreign key with `NO ACTION` from the score
  to the saved game, a composite key that freezes the sides, and one trigger.
- F11-1 and F11-2 are identical under A and C, so the owner can approve now and choose between "repoint the readers" (A)
  and "keep the name `games` as a view" (C) at F11-3, after a one-day spike (U1). If the spike shows PostgREST embeds through
  the view cleanly, C saves one pull request's worth of reader edits; if not, A costs nothing extra.
- B is not offered as a choice unless the owner insists on zero reader changes: it fails criterion 1.

**What would change this recommendation:** a finding that in-place saves break an existing pgTAP or page test in a way that
cannot be named and fixed (then D2 below, a lineage key, is the alternative); or the owner preferring the game and its
placement as two entities (E).

## Design of the recommended option

### Identity (F11-1)

- **Season on the game.** `game_assignments.season_settings_id uuid` (foreign key to `season_settings`), set by the save from
  `run_data.season_settings_id` and by the import's apply from the job's season; nullable only for rows that exist before
  the migration (none in production). PR 5's index becomes a unique index on `(season_settings_id, external_ref)` for rows
  that have an `external_ref`, and `external_ref` is text with a length check (40, as 4.3), compared exactly after trimming.
- **In-place save (I1).** A payload row with an `id` is validated: the id exists, belongs to the organization, appears once,
  is not in a completed season (the existing trigger), and, if the game is held, differs from the stored row in nothing the
  guard protects. It is then updated by id. A row without an id is upserted on the tuple as today. If an in-place update's
  new tuple equals another row's tuple (an older hidden row of the same pair at the same place), the save is refused with a
  named error (22023, `game_identity_conflict`, both ids in the detail): production has no such row, and the case exists
  only for rows saved before this change. Nothing is deleted by a save, as today.
- **The omission check** (PR 1) counts a game as present if its id is in the payload or its tuple is.
- **The matcher (I2).** `packages/core/src/gameIdentity.js`, pure, registered in the index: `carryGameIds(saved, generated)`
  and `isHeld(game, scored)`. The page runs the matcher after `scheduleGames`, before the review, and sends the ids.
- **One predicate (I3).** `game_is_held(p_game_id uuid)` and a set form, STABLE, `SET search_path = public`; in PR 1 it
  answers "Published"; F11-2 replaces one body to add "has a score".

### The score record (F11-2)

- **Table.** `game_scores`: `game_id` primary key; `organization_id`; `home_team_id`, `away_team_id`; `score_home`,
  `score_away` smallint, both `NOT NULL` and `>= 0` (a row exists exactly when the game is scored; clearing deletes the
  row); `updated_at`, `updated_by`. One foreign key from `(game_id, organization_id, home_team_id, away_team_id)` to
  `game_assignments(id, organization_id, home_team_id, away_team_id)` (a new unique index on those four columns), with
  `ON DELETE NO ACTION`. `NO ACTION`, not `RESTRICT`, so an organization's cascade still passes (`RESTRICT` is checked
  immediately and its outcome can depend on the order of the cascade; U5 settles it with a test). RLS: members `SELECT`;
  no insert, update or delete policy (lesson 49). Trigger `game_scores_readonly_when_completed` using the existing function.
- **Today's one-sided entries.** `update_game_score` accepts one score and stores it; the standings view ignores it
  (statically reviewed). The table requires both scores or none: a one-sided call is refused (decision D10).
- **`update_game_score`** replaced from its latest body (`20261028010000:108`, md5-checked against the deployed body
  first, lesson 87's method, as every replacement here would be). It resolves the saved game, checks both teams belong to the organization as today, then
  upserts or deletes the score row, and records `competition.score_updated` with the previous values. Everything before
  that point is unchanged.
- **The held rule.** `game_is_held` becomes "Published or scored". The guard trigger, `admin_cancel_game_assignment` and the
  omission check ask it. `admin_delete_team` deletes the team's scores itself before its cascade (the foreign key would
  otherwise refuse) and counts them in the audit metadata (decision D5); two new codes, `game_scored` and
  `game_scored_omitted`, map to the same 409 as PR 1's pair; the page's `pinned` set gains scored games.
- **Standings.** `view_league_standings` rebuilt over `teams` and `game_scores`, same columns in the same order. A team row
  exists for every own team (`NOT is_external`); a score counts for a team when its opponent is an own team, or the
  opponent is an outside club and `standings_counts_outside(division_id)` is true. The division is the own team's (an
  outside team row is created per own team's division and club label, expansion 4.6). A fixture of two outside clubs counts
  for nobody. `standings_counts_outside` is the seam the settings cascade extends (below); in F11-2 it reads the
  organization's setting and defaults to false.
- **`current_game_runs`** (security invoker): per organization and season, the latest completed game run. A parity test
  holds it equal to `useSchedulerRun` over a fixture with two seasons and an older run (lesson 74: a second implementation
  drifts).
- **Legacy rows.** As option A above: copy where one saved game matches, refuse otherwise, do nothing in production.

### Readers (F11-3)

The team page and the per-team files (`fetchTeamEvents`, so the coach-less exports follow), the feed (`teamFeed.ts`, with the
service role: it asks `current_game_runs` for the team's season, then reads `game_assignments`), the Dashboard's count and
list, the Player record, Scores and Standings. `game_assignments` has two foreign keys to `game_slots` (`game_slot_id` and
`slot_id`), so an embed needs a hint (`game_slots!game_slot_id`); the existing reads of `games` had one. The Games page's
`useGameAssignments` adds a to-one embed of the score (statically reviewed; U1's spike covers it too). The Scores page lists
games from the visible run whose start has passed, with their score; results that are not in the visible run (old data only,
because a scored game is held) are counted in a sentence, not hidden. The mock client mirrors `game_scores` and
`current_game_runs`, held to the SQL by a twin test (lesson 77). Pages keep their present markup; every state is words (no
games yet, loading, error), both themes.

### The legacy table

Kept, unread, with a `COMMENT ON TABLE` saying so; the four SQL functions that name it keep an arm that reads nothing. A
census test (`tests/gamesTableReaders.test.js`) enumerates every `from('games')` and `public.games` in `frontend/src`,
`supabase/functions` and the live catalogue from the code and fails on any reader not classified `repointed` or
`legacy-kept` with a reason. F11-5 (optional) removes the table, the four arms and the census entries together.

## Acts and states in one table

"Held" means Published or scored (I3). "Clear" is `update_game_score` with both scores empty; "Allow changes" is PR 1's
override and lifts only the Published hold.

| Act                                  | Published, no score                               | Published and scored             | Scored, not Published                 | Neither                     |
| ------------------------------------ | ------------------------------------------------- | -------------------------------- | ------------------------------------- | --------------------------- |
| Move (drag, "Move to")               | Refused; Allow changes first                      | Refused; Allow changes and clear | Refused; clear the score first        | Staged, then Apply          |
| Cancel                               | Refused; Allow changes first                      | Refused; Allow changes and clear | Refused; clear the score first        | Allowed (audited)           |
| Regenerate                           | Carried unchanged (`pinned`)                      | Carried unchanged                | Carried unchanged                     | Re-solved; id carried by I2 |
| Save that omits it                   | Refused (`game_published_omitted`)                | Refused                          | Refused (`game_scored_omitted`)       | Allowed; row stays hidden   |
| Re-import, same row                  | Unchanged (idempotent)                            | Unchanged                        | Unchanged                             | Unchanged                   |
| Re-import, changed row, same Game ID | `skipped-published`                               | `skipped-published`              | `skipped-scored` (new reason)         | Updated in place; run set   |
| Import rollback                      | Refused if changed since apply                    | Refused (names up to 50 games)   | Refused (names up to 50 games)        | Allowed                     |
| Delete the team                      | Refused with the count (PR 1)                     | Refused with the count           | Deleted with its scores, counted (D5) | Deleted, counted            |
| Delete the field or slot             | `field_bookings` refuses while booked (unchanged) | Same                             | Same; the foreign key is the backstop | Same                        |
| Enter, edit or clear the score       | Allowed (admin, `score_entry` on, season active)  | Same                             | Same                                  | Same                        |

- **A Published game that is allowed to change and published again.** Allow changes turns the flag off with a reason (PR 1).
  The edit is an in-place update by the game's id (I1), so the game's history, Game ID and (if scored, after the score is
  cleared) score stay on one id; Publish turns the flag on again. Without I1 the edit would insert a second row and the
  history would split.
- **Moving a Published game that has a score.** The score is not moved or dropped silently. The move is refused until the
  score is cleared (the audit row for clearing carries the previous score) and Allow changes is given; the admin re-enters the
  score afterwards. This is the strictest reading and the cheapest to build; decision D3 offers the friendlier one.
- **A cancelled game's score.** A scored game cannot be cancelled until its score is cleared; the foreign key refuses it if a
  deleter forgets. A game that was never played has no score, so the usual rain-out is unaffected. A forfeit is a result the
  admin enters.
- **The rollback of an import.** Imported games arrive Published, so a rollback already refuses once one has changed. A
  score entered after the import is a change: the rollback refuses and names up to 50 games. It never deletes a score.
- **Re-import "update by Game ID".** The apply finds a game by `(season, external_ref)` whether its row is in the visible run
  or hidden in an older one, updates it in place, and sets its run to the new run so a hidden row becomes visible (expansion
  4.7 re-points only the previous latest run's rows). It never inserts a second row for an existing Game ID; the unique
  index is the backstop. A regeneration keeps the Game ID of an unpublished imported game because an in-place update does
  not touch columns it does not name.

## The settings cascade: what it needs, and where it belongs

The owner's principle (expansion 6.2): optional behaviours are configurable at organization, program and division level;
unset inherits; the most specific wins. For standings: results against outside clubs excluded by default.

**What exists (executed, F-R10).** Organization: `organizations.feature_flags` (jsonb: booleans and two strings), written by
an audited RPC through the flag registry (the `squadlogic-feature-guardians` skill), as play-down was (#703). Program:
`programs` has `id`, `organization_id`, `season_settings_id`, `name`, `is_default`, `copied_from_program_id` and timestamps;
no settings column. Programs belong to a season, and every season has one default program ("No program") made by a trigger.
Division: typed columns (`plays_games`, `practices_per_week`, ...), copied at rollover through `rollover_division_columns()`,
which a test requires to classify every column.

**What it needs.**

1. **A place for program- and division-level values** (one migration). Either typed nullable columns per setting (NULL means
   inherit) or one `settings jsonb` on `programs` and on `divisions` with a closed key list. With three known users
   (standings, the pairing setting of PR 12, later play-down) and two more recorded, a `settings jsonb` and a closed key
   registry cost one migration once; typed columns cost one per setting and a rollover classification each.
2. **Rollover must copy it.** Programs are copied by an `INSERT` of the name and its links only
   (`20261111010000:750-754`), and the default program is made by a trigger and linked afterwards (`:755-759`); a
   program-level value would reset to unset at the next season unless that function copies it. Divisions: the new column joins `rollover_division_columns()` or its skipped list.
3. **One resolver, in SQL and in core.** `resolve_scope_setting(division_id, key)`: division, else program, else
   organization, else the caller's default; absent is distinguished from an explicit `false`. A pure twin in core with a
   parity test over one input that reaches every level (lesson 77).
4. **One audited setter** with a closed key list, reusing `settings.updated` and the settings audit trail.
5. **A control** with a scope ("Applies to: organization / program / division") and a line saying which level a value is
   inherited from, in the settings page, the program page and the division overview.

**Where it belongs: its own small plan, not this one.** It touches rollover, three screens and the audit trail, and it has
its own questions (jsonb or columns; where a program-level value is edited). F11 needs none of it to be correct: the default
(excluded) is the owner's accepted behaviour. F11-2 ships the default, the organization-level toggle through the existing
flag mechanism (no migration), and the seam `standings_counts_outside(division_id)`, which today reads the flag; the
cascade's plan replaces that one body. PR 12's pairing setting is the other user; PR 12 is last in the order, so the small
plan lands before PR 12 and PR 12 consumes it (F11-4). A per-fixture override is named in the plan and not built.

**The standings page says what it did not count.** When the toggle is off and results against outside clubs exist, the page
states "N results against outside clubs are not counted" (lesson 92: say what a number is a count of).

## Order of work

- **Must precede PR 5.** (1) The owner approves this plan. (2) The identity layer (I1 to I4) is in PR 1, or is its own
  pull request merged and deployed. (3) PR 5's specification takes the amendments in the next section. Nothing else: no
  score, standings or reader work gates PR 5.
- **Can follow PR 7.** F11-2, F11-3, F11-4 and F11-5. PR 7 (reports) reads `game_assignments` and needs only PR 1; PR 13 needs
  nothing.
- **Recommended placement.** F11-2 and F11-3 right after PR 6, ahead of PR 10, so the schedule side is finished before the
  practice side starts and the owner's manual testing does not meet an empty team page again. F11-4 before PR 12. F11-5 last,
  optional (decision D8 offers "after PR 7").

Sizes: S under 150 lines, M 150 to 500, L over 500, tests included (estimates). Review tags follow expansion decision 16:
(c) if a migration, an Edge write path, the solver or import logic is in it, else (a). At most two pull requests in flight.

| PR    | Title                                       | Size | Migration      | Rule 14 | Review | Depends on                    |
| ----- | ------------------------------------------- | ---- | -------------- | ------- | ------ | ----------------------------- |
| F11-0 | This plan                                   | S    | no             | stop    | none   | the owner's approval          |
| F11-1 | Identity: in-place saves, season, held      | L    | in PR 1, or 1  | yes     | (c)    | PR 1 (or inside it)           |
| F11-2 | Scores, the held rule, standings, runs view | L    | 1              | yes     | (c)    | F11-1 and PR 5, both deployed |
| F11-3 | Readers: team page, files, feed, pages      | L    | no             | no      | (a)    | F11-2 deployed                |
| F11-4 | Settings scope (its own plan first)         | M    | 1, or in PR 12 | yes     | (c)    | its plan approved             |
| F11-5 | Retire the legacy `games` table (optional)  | S    | 1              | yes     | (c)    | F11-3 and the owner's word    |

## Pull requests and tasks

Each task names its test. A plant is a defect put in to prove the test can fail; at most three per pull request.

### F11-1: Identity (L; migration inside PR 1, or its own; rule 14; Review: (c))

Depends on: PR 1, or lands inside it as separate commits. If PR 1 has merged, F11-1 replaces `persist_game_schedule` again
and re-aims PR 1's plants (lesson 70) as the fifth migration. **Merged as #712 (`e5ce8b8`); A1 to A5 are ticked
because each task's files are in that merge** (statically checked on 2026-11-09: the migration, `supabase/tests/game_identity.sql`,
its revert and smoke, `packages/core/src/gameIdentity.js`, the three test files, the mock and the docs; not re-run here).

- [x] A1 (L) Migration: `season_settings_id` on `game_assignments` and the four-column unique index; `persist_game_schedule`
      updates a row in place when its payload row names an existing game; the omission check counts ids and tuples;
      `game_is_held` (Published only) and its set form; the guard, cancel and omission check call it. Revert and smoke;
      catalogue snapshot regenerated. **First** `supabase/tests/game_identity.sql`, red against today's code: a move keeps
      the id (and leaves no hidden row); a flip keeps the id; a row without an id behaves as today (the existing
      `game_persistence_rpc.sql`, 27 assertions, passes unchanged); an unknown id, an id of another organization, a
      repeated id and a completed season are refused with nothing written; the tuple-collision case refuses with
      `game_identity_conflict`; a Published game still cannot be moved by id; each refusal paired with a control that the
      allowed twin passes.
- [x] A2 (M) Core `gameIdentity.js`: `carryGameIds` and `isHeld`, registered in the index. Tests
      `tests/gameIdentityCarry.test.js`: the saved set is the subject (enumerated from the saved games); a pair moved across
      weeks keeps its id; a double round robin matches each of the two meetings once; an odd division with byes; a flipped
      pair; a team removed; no saved game is claimed twice (made to fail by a planted double claim).
- [x] A3 (S) The page sends ids and applies the matcher before the review; Edge schema unchanged (the optional `id` exists).
      Test `tests/gameSchedulingIdentity.test.jsx`: regenerate and Apply twice; the visible set equals today's, the ids of
      unmoved and moved games are unchanged.
- [x] A4 (S) Mock client mirrors the in-place save. Test `tests/mockGameIdentity.test.js`: one input that reaches every
      outcome gives the same answers through the mock and the pure helper (lesson 77).
- [x] A5 (S) Docs: `docs/ARCHITECTURE.md` (the `games` and `game_assignments` paragraph), `docs/architecture/game-scheduling.md`
      (identity), one lesson (section "What the planning taught").

Plants: the save inserts instead of updating in place (the "move keeps the id" case); the matcher ignores the week
preference (the double round robin case); the collision check removed. Stop and report if any existing pgTAP file turns red,
if `game_persistence_rpc.sql` needs more than the named cases changed, or if a payload id from one organization reaches a
row of another.

### F11-2: Scores, the held rule, standings and the runs view (L; migration; rule 14; Review: (c))

Depends on: F11-1 and PR 5, deployed (PR 5 adds `teams.is_external` and `apply_game_import_job`).

- [x] B1 (L) Migration: `game_scores` with the composite key, RLS and the completed-season trigger; `update_game_score`
      replaced; `game_is_held` gains scores; `game_scored` and `game_scored_omitted`; `admin_cancel_game_assignment` and
      `admin_delete_team` (deletes the team's scores first and counts them, `scores_deleted` in the audit metadata); `rollback_game_import_job` names scored
      games; `apply_game_import_job` skips them (`skipped-scored`); `view_league_standings` rebuilt (excludes outside clubs;
      `standings_counts_outside`); `current_game_runs`; the legacy copy-or-refuse step. **First**
      `supabase/tests/game_scores.sql`, red against today's code, through the real save: a score survives a regeneration
      that moves the unscored games around it; a scored game cannot be moved, cancelled or omitted, and its unscored twin
      can; clearing lifts the hold; the foreign key refuses a delete that skipped the check; deleting an organization with
      a scored game succeeds (U5); a team swap under a score is refused by the key even with the trigger disabled; a
      completed season refuses entry; the standings of a fixture with an outside club exclude it, the organization toggle
      includes it, and an outside club has no row (each paired with its control); the legacy copy matches, refuses, and does
      nothing on an empty table. Rewritten existing files: `game_score_rpc.sql` (seeded through the save),
      `season_schedule_readonly.sql` (adds the score table).
- [x] B2 (S) Mock client mirrors `game_scores`, the hold and the standings. Test `tests/mockGameScores.test.js`: the pgTAP's
      expected rows through the mock equal the SQL's (lesson 77).
- [x] B3 (S) Page: `moveGameTo`, the cancel handler and the pin set refuse and carry scored games, with the sentence. Test
      `tests/gameGridScoredGuards.test.jsx` beside PR 3's published guards.
- [x] B4 (S) The organization toggle in the flag registry (`standings_count_outside_results`, off unless turned on) and the
      page's "N results against outside clubs are not counted" sentence. Test `tests/standingsOutsideClubs.test.jsx`.
- [x] B5 (S) Docs: `docs/security/rls-policies.md`, `docs/architecture/persistence-rpc-layer.md`, `CHANGELOG.md`, the lesson.

**As built (2026-11-11; migration `20261122010000_game_scores.sql`; the pull request has the detail).** B1 to B5 are
done. What differs from the text above, each a decision of the build:

- The audit key of a deleted team's scores is `game_scores_deleted`, not `scores_deleted`: the repository's census
  (`supabase/tests/admin_delete_team_exceptions.sql`) requires every `*_deleted` counter to name a table.
- `game_hold_code(uuid)` is added (internal). It asks the one predicate and then says why a game is held, so each
  refusal can say `game_scored` without a second place deciding "held". A held game that is Published is always
  refused as Published first, whether or not it also has a score.
- Ten functions are replaced whole, not three: `game_held_ids`, the guard, `persist_game_schedule` (the omission
  check's `game_scored_omitted`), `admin_cancel_game_assignment`, `admin_delete_team`, `update_game_score`,
  `apply_game_import_job`, `rollback_game_import_job`, and with them `cancel_ready_import_job` and
  `get_schedule_tbd` (the expansion plan's notes for the next migration). 37 harness plants were re-aimed.
- `view_league_standings` gains one column, last: `results_not_counted`, which the Standings page sums for its
  sentence. `anon` can no longer read the view at all (it reads `game_scores`, which `anon` has no grant on).
- `copy_legacy_game_scores()` stays in the catalogue as an internal function (no client role may call it), so the
  legacy copy can be tested after the migration has run; F11-5 drops it with the legacy table.
- `update_game_score` takes the organization's `game_published` advisory lock, so a save that leaves a game out and
  a score entered on it cannot both succeed.
- The mock keeps a declared legacy arm (`mockGameScores.js`): an id that names only a row of the legacy `games`
  table is scored as before, and a stored standings row stands for a team with no result in `game_scores`, because
  the Scores and Standings pages read the legacy table until F11-3. **On a real database the Scores page can score
  nothing between F11-2 and F11-3** (it lists legacy rows, and it saves one cell at a time, which D10 refuses):
  F11-3's C3 must make it list saved games and send both scores together.
- **F11-3's C3 is BLOCKING for turning score entry on (2026-11-12).** No league may be told to turn `score_entry`
  on until F11-3 has made the Scores page list saved games and send both scores together. Until then the page says so
  itself: a save the database refuses for either reason shows an alert in words ("The score was not saved. Scores are
  now kept against the saved schedule ... it cannot save a score yet. Nothing was changed."), `tests/scoresPage.test.jsx`.
- **To remove after this migration is deployed (noted 2026-11-12):** the fallback in `readScheduleTbd`
  (`frontend/src/utils/scheduleTbdClient.js`), which reads `game_date` from the table when `get_schedule_tbd` answers
  rows without that key (the body before `20261122010000`). Once production runs the new body it is dead code.
- **Fix round 1 (2026-11-12, Codex on #725, two findings, both taken).** (1) `useGameAssignments` paged `game_scores`
  with the helper's default order, `id`, a column the table does not have: PostgREST refuses it, so a saved schedule
  would not have loaded on a real database. It orders by `game_id`; the mock's score rows no longer carry an `id` of
  their own; and `tests/pagedReadOrderColumns.test.js` holds every paged read's order column, every read of the three
  score relations, and the mock's row keys for them, to the columns the migrations and the catalogue snapshot give.
  (2) The mock rolled an import back over a scored game and left its score behind; it refuses as the SQL does. Its
  siblings were run against a scored game (`tests/mockScoredGameDeleters.test.js`): cancel, a direct delete or move,
  delete team and the game save already matched; a confirmed `admin_delete_field` did not (it took a held game, a
  Published one too) and now asks the guard first; the field-import rollback and slot removal stay unmirrored, said in
  `mockGamePublished.js`.
- The plan's parity test for `current_game_runs` against `useSchedulerRun` stays C5 of F11-3; F11-2 holds the view
  and the mock's copy to the same cases (`supabase/tests/game_scores.sql`, `tests/mockGameScores.test.js`).

Plants: the carry removed from the save (the "score survives" case); `game_is_held` ignoring scores (the "scored game cannot
be moved" case); the standings view counting an outside opponent (the "excluded by default" case). Stop and report if
`view_league_standings`' columns change order, if the key refuses an organization cascade, or if a scored game can be
removed by any path the table in "Acts and states" lists.

### F11-3: Readers (L; no migration; Edge and UI; Review: (a))

Depends on: F11-2 deployed. If the spike (U1) shows a view embeds cleanly and the owner prefers C, this pull request
becomes "create the `games` view" and is smaller.

- [ ] C1 (M) `fetchTeamEvents` reads the saved schedule through `current_game_runs`; the per-team CSV and XLSX follow. Test
      `tests/teamPageSavedSchedule.test.jsx`: a league saved through the real save shows its games on the team page and in
      the file, a team in two games sees two, a moved game appears once at its new time.
- [ ] C2 (M) The feed (`teamFeed.ts`) reads the same. Test: the existing `ics-feed_test.ts` suite plus a case from a saved
      schedule; a failed read is still reported, not swallowed.
- [ ] C3 (M) **BLOCKING for turning score entry on (2026-11-12; see "As built" under F11-2):** the Scores page lists
      saved games and sends both scores of a game together (it saves one cell at a time today, which the database
      refuses), and the mock's legacy score arm and stored standings rows go. Dashboard, Player record, Scores and Standings read the saved schedule and scores. Tests: the existing
      `tests/scoresPage.test.jsx`, `tests/leagueStandingsSeason.test.jsx` (re-seeded through the save), plus a Dashboard case
      (count and list from a saved schedule).
- [ ] C4 (S) The census `tests/gamesTableReaders.test.js` (from the code); it is red while any reader names `games`.
- [ ] C5 (S) The parity test `tests/currentGameRunsParity.test.js`: the SQL view and `useSchedulerRun` pick the same run
      over two seasons, a run with no season and an older run.
- [ ] C6 (S) (owner, 2026-11-09) The Games page reads the saved schedule once more after a 409 `GAME_IDENTITY`. Test: a page
      test that answers the save with that 409 and asserts the extra read (the file is named when it is written).
- [ ] C7 (S) (owner, 2026-11-09) Remove `publishedOmissions` and `changesPublishedPlacement` (`packages/core/src/gamePublished.js`)
      if still without a shipped caller (today only tests call them, statically searched 2026-11-09; two page tests use
      `publishedOmissions` as an oracle and move or go with it). Test: `npm run check:unused` green and their own tests gone.

Plants: a reader still on `games` (the census); the team page reading every run instead of the current one (a moved game
appears twice); the feed swallowing a failed read. Stop and report if any reader's markup changes, or if an embed needs a
hint beyond `game_slots!game_slot_id`.

### F11-4: Settings scope (M; migration, or inside PR 12; rule 14; Review: (c))

Depends on: its own small plan, approved. Scope here: the resolver, the storage on programs and divisions, rollover, one
setter, and the standings policy as its first user; PR 12 consumes it. Tests named by that plan; the ones this plan needs:
a precedence test over all eight set/unset combinations of the three levels (explicit `false` overrides an inherited `true`);
rollover keeps program and division values; `standings_counts_outside` follows the cascade.

### F11-5: Retire `games` (S; migration; optional, last; Review: (c))

Depends on: F11-3 and the owner's word. Drops the table, removes the four SQL arms and the census entries, re-points the
eight pgTAP files that insert into `games`. Proved by the census going green with the table gone and by `field_bookings` and
`rollback_field_import_job` keeping their pgTAP.

## What PR 5, and the other pull requests, must do or avoid because of this plan

**PR 5 is merged as #719 (`ad18861`)**, specified with the amendments below (statically checked on 2026-11-10 in
`20261121010000_game_import.sql`: the unique index on `(season_settings_id, external_ref)` and the guard's call of
`game_is_held`; the rest not re-read, and nothing re-run here).

**PR 5 must:**

1. Make `external_ref` unique per season, `(season_settings_id, external_ref)`, not per organization; `season_settings_id`
   comes from PR 1 (recommended) or PR 5's own migration. Text, up to 40 characters, exact comparison after trimming.
2. Make the apply update a game found by `(season, external_ref)` in place by its id, whether its row is in the visible run
   or hidden, and set its run to the new run; never insert a second row for an existing Game ID.
3. Ask `game_is_held` before changing a game (PR 1 defines it; F11-2 changes its body to add scores), and keep the
   preview's skip reasons a closed list that can grow by one: `skipped-scored`, added by F11-2 with its test.
4. Leave `view_league_standings` alone. It still reads the empty `games`; PR 5's census pin "no path feeds external-team
   results into standings today" remains true until F11-2, which owns the exclusion of `is_external` rows.
5. Not read, write or reference `games`, and not rely on a row id surviving a save unless the save carried the id (I1).

**PR 5 must avoid:** a Game ID unique across seasons; an upsert on the tuple for a row that has a Game ID; re-pointing only
the previous latest run's rows (a hidden row found by Game ID must be re-pointed too); a second place that decides "held".

**PR 1 should:** carry I1, I3 and I4 (or say it does not and let F11-1 follow); define `game_is_held` and call it from the
trigger, the cancel, the omission check and `admin_delete_team`; key its omission check on ids and tuples; and note that the
guard's "payload moves a published row" case (expansion 3.3) is the same-slot case, because a move changes the tuple.
**PR 2:** unchanged; the pin set gains scored games in F11-2. **PR 3:** unchanged; F11-2 extends the guards. **PR 7:** needs
no F11 work; its per-game history is better for stable ids.

## Risks and rollback

- **Risk:** the matcher attaches a regenerated game to the wrong saved game (a double round robin, a pair meeting twice) -
  **watch:** the carry test over the double-round-robin case; a played game cannot be mis-matched because held games are
  carried by id, not matched - **if it happens:** drop the matcher call from the page (ids then come only from moves), keep
  I1.
- **Risk:** in-place saves change behaviour a test or a person relied on (a flip used to show as a new row) - **watch:**
  `game_persistence_rpc.sql` (27 assertions) and `game_score_rpc.sql` (15) run unchanged except the named cases - **if it
  happens:** decision D2's lineage key keeps "a save inserts" and carries a key instead.
- **Risk:** two implementations of "the current run" drift (lesson 74) - **watch:** the parity test C5 - **if it happens:**
  make the Games page read `current_game_runs` too (a small, separate change).
- **Risk:** `view_league_standings` is rebuilt and a column moves or changes type - **watch:** the catalogue snapshot and
  `reporting_views_present.sql` - **if it happens:** columns are append-only; fix the view, not the page.
- **Risk:** the migration passes on an empty table and fails on a real one (lesson 67) - **watch:** the harness plants a
  scored legacy row, an unmatched one and an unscored one before applying - **if it happens:** the migration refuses and
  nothing is applied.
- **Risk:** a volunteer cannot fix a wrong date on a scored game without clearing its score - **watch:** the owner's manual
  testing - **if it happens:** decision D3 (b), a friendlier flow, is a separate change.
- **Risk:** F11-2 is large and its migration holds a table, a view, a trigger, three function replacements and a view
  rebuild - **watch:** the diff size at the first review - **if it happens:** split the readers' view
  (`current_game_runs`) into F11-3 and accept one more migration.
- **Rollback.** F11-1: `docs/sql/<v>_revert.sql` restores the previous bodies from production's text and drops
  `game_is_held`; the season column may stay (nullable); rows already updated in place keep working under the old save
  (it upserts on the tuple). F11-2: the revert drops `game_scores`, restores `update_game_score` and the standings view
  over `games`; it copies nothing back and **refuses while `game_scores` holds rows**, so a revert never silently discards a
  recorded score (production holds none today). F11-3: revert the commit (no data). F11-4 and F11-5: their own reverts; the
  drop's revert recreates an empty table.

## Owner decisions

Each decision names its options and the recommendation. D1 and D2 are the ones that block approval; the rest can be
answered with them or one by one.

1. **D1. Which option.** (a) A, repoint the readers, scores in `game_scores` [recommended]. (b) C, keep the name `games` as
   a view; choose at F11-3 after the spike. (c) D, scores on `game_assignments`. (d) E, the game and its placement as two
   tables. (e) B, a projection into `games` (fails criterion 1; offered only if zero reader changes matters most).
2. **D2. Identity.** (a) The saved game's row id is the game; saves update in place [recommended]. (b) A lineage key
   carried on each new row, keeping "a save inserts a new row for a move" and the hidden rows; scores, the Game ID and the
   history are keyed by the key, which has no parent row (no foreign key to protect a score).
3. **D3. A scored game.** (a) Held like Published: not moved, cancelled or dropped by a save, a regeneration or an import
   until the score is cleared [recommended]. (b) Held only against regeneration and import; a manual move is allowed, audited,
   and the score follows the game. (c) Not held; the score follows by id. (a) is the strictest and the cheapest to build and
   to prove; (b) is friendlier and needs a confirmation flow.
4. **D4. Cancelling a scored game.** (a) Refused until the score is cleared [recommended]. (b) Allowed; the score is deleted
   with the game and audited. (c) Not possible without a score that has no game.
5. **D5. Deleting a team that has scored games.** (a) As today: the games and scores go with the team, counted in the audit
   and in the confirmation [recommended: minimal diff]. (b) Refuse, as PR 1 does for Published games, until scores are
   cleared.
6. **D6. Where the season lives.** (a) `game_assignments.season_settings_id` in PR 1's migration [recommended]. (b) In PR 5's
   migration. (c) Nowhere: scope the Game ID by organization (refuses a platform that reuses numbers; U2).
7. **D7. The settings cascade.** (a) Its own small plan, before PR 12; F11 ships the default, the organization toggle and the
   seam [recommended]. (b) Fold the program and division levels into F11-2 (adds a migration and the rollover work to an L
   pull request). (c) Organization only (contradicts the owner's principle).
8. **D8. Order.** (a) F11-1 inside PR 1; F11-2 and F11-3 after PR 6; F11-4 before PR 12; F11-5 last [recommended]. (b) F11-2
   and F11-3 after PR 7. (c) F11-2 before PR 5 (writes PR 5's apply and rollback once with scores in mind, delays the import).
9. **D9. The legacy `games` table.** (a) Keep, unread and commented; drop in F11-5 only on the owner's word [recommended].
   (b) Drop in F11-2. (c) Never.
10. **D10. The shape of a score.** (a) Both scores or none; a one-sided call is refused [recommended]. (b) Keep today's
    behaviour: accept one score and store it, ignored by standings.

### Owner answers (2026-11-07)

The owner's words, verbatim: "I'll just accept your recommendations on all open decisions for now". Read as: D1 to D10 are
answered as recommended, that is **D1 (a), D2 (a), D3 (a), D4 (a), D5 (a), D6 (a), D7 (a), D8 (a), D9 (a), D10 (a)**. Two
consequences are recorded here so no agent has to infer them:

- **D8 and U3.** Expansion PR 1 merged (#707, `4750b2d`) without the identity layer, so F11-1 is **its own migration pull
  request, merged and deployed before PR 5 starts** (the "or its own" branch of the F11-1 header). It replaces
  `persist_game_schedule` again, defines `game_is_held`, and re-aims PR 1's guard, cancel and omission-check at it.
  This plan file reaches `main` in F11-1's first commit (the branch it lives on has no pull request of its own).
- **D6.** The season column (`game_assignments.season_settings_id`) is in F11-1's migration; PR 5's `external_ref` index is
  unique on `(season_settings_id, external_ref)`.

Order after this: F11-1, then PR 5 (with the amendments in "What PR 5 ... must do or avoid"), then PR 6; F11-2 and F11-3
after PR 6, ahead of PR 10; F11-4 before PR 12; F11-5 last and only on the owner's word. U1 (the PostgREST view spike),
U2 (do platforms repeat Game IDs across seasons: ask the owner) and U5 stay open as written.

### Owner answers (2026-11-09)

- **F11-1 is merged.** The owner answered "A - as recommended." to whether #712 (F11-1) could merge without a completed Codex
  review (Codex failed six times on it; the coordinator's account, not re-run here: CI was green, and one
  `/code-review high` pass and one independent read-only review of the fix round found no shipped-behaviour defect).
  Merge commit `e5ce8b8`. Consequence: PR 5 is next on the schedule side, then PR 6; F11-2 to F11-5 follow the order above.
- **U2 is answered.** The owner: "Game IDs should be specific to each game, not reused, as to remain clear on what game is
  being affected during changes (such as venue or time change.)" Consequence: PR 5's `external_ref` stays unique on
  `(season_settings_id, external_ref)`, which is safe either way; nothing else changes.
- **Agreed, non-blocking (owner: "Agree").** Two of the agreed items are tasks of F11-3 below (C6 and C7): the one-line
  refetch after a 409 `GAME_IDENTITY` on the Games page, and removing `publishedOmissions` and `changesPublishedPlacement`
  if still unused. The others are in the expansion plan, section 10, "Owner answers (2026-11-09)".

## Unknowns, and what would resolve them

- **U1. Whether PostgREST embeds `teams` and `game_slots` through a view named `games`, and resolves the feed's
  `teams!games_home_team_id_fkey` hint against it.** Not verified. One spike against the local stack (a view over one
  assignment, the three embed shapes) decides C versus A at F11-3. It also covers the to-one embed of a score on the Games
  page's read.
- **U2. Whether a platform's Game IDs repeat from one season to the next.** Ask the owner; the per-season scope is safe
  either way. **Answered 2026-11-09:** not reused (see "Owner answers (2026-11-09)").
- **U3. Whether PR 1 has started or merged.** `git log` and `gh pr list` when this plan is read; it decides whether F11-1 rides
  PR 1 or is a fifth migration.
- **U4. Whether any pgTAP or vitest file other than the named ones relies on a hidden row after a move.** A search of
  `game_persistence_rpc.sql` for "orphan", "older run", "ghost" and "flip" matches nothing (F-R12); F11-1's first red run
  finds the rest.
- **U5. Whether `ON DELETE NO ACTION` lets an organization's cascade through a scored game.** From the Postgres
  documentation it should; F11-2's pgTAP case settles it, and `RESTRICT` is the fallback to rule out.
- **U6. How `scopeSchedulerRunsToActiveSeason` treats a run with no season.** Read when `current_game_runs` is written; the
  parity test covers it.

## Tasks, in order, with the first one

1. This plan, committed first (docs only).
2. On approval: F11-1's A1, starting with `supabase/tests/game_identity.sql`, red against today's code.
3. PR 5 is specified with the amendments above before it starts.

## Done when

- [ ] Every task's test passes, and each "Unchanged" item has a test.
- [ ] The repository's full gate passes, and every new check was shown failing first (the plants above).
- [ ] The census shows no reader of `games` outside the classified list; the team page, files, feed, Dashboard, Player
      record, Scores and Standings show a league saved through the Games page.
- [ ] `docs/ARCHITECTURE.md`, `docs/architecture/game-scheduling.md`, `docs/security/rls-policies.md` and
      `docs/architecture/persistence-rpc-layer.md` say where a game's identity and score live.

## Receipts: searches, queries and what was not run

Base: `origin/main` `c3d190d` (fetched 2026-11-06; the expansion plan was written against the same commit). `rg` is
ripgrep. "Production" is the project named in the brief, read with `SELECT` only. Nothing was written to it and no
migration was applied.

| Id    | Claim                                              | Command or query                                                                                                                                                                                                                                                      | Result and control                                                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-R1  | Base and ledger                                    | `git rev-parse origin/main`; `ls supabase/migrations`; `SELECT max(version), count(*) FROM supabase_migrations.schema_migrations`                                                                                                                                     | `c3d190d`; 174 files, newest `20261118010000`; production 174 rows, newest `20261118010000`                                                                                                                                                                         |
| F-R2  | Nothing inserts into `games` from a saved schedule | `rg -n -i "insert\s+into\s+(public\.)?games\b" -g '!supabase/tests/**' -g '!docs/**' -g '!tests/**' .`; the same with tests and docs                                                                                                                                  | 3 hits (`scripts/dbharness/scenarios.py:178`, `supabase/migrations/20251208000001_seed_data.sql:684`, `supabase/seed.sql:662`); 19 files with tests and docs. Updates and deletes: 5 hits, of which one live body (`update_game_score`)                             |
| F-R3  | The latest save and the cancel never name `games`  | `awk 'NR>=1763 && NR<=2440' supabase/migrations/20261108020000_schedule_tbd.sql` then `rg -c "public\.games\b"` and `rg -c "game_assignments"`; the cancel's file                                                                                                     | `public.games`: 0; `game_assignments`: 1 line (the insert). The cancel file: 0                                                                                                                                                                                      |
| F-R4  | Live SQL readers of `games`                        | `SELECT proname FROM pg_proc ... WHERE prosrc ~* '(from\|join\|update\|into)\s+(public\.)?games\M'`; `pg_depend` views; `pg_policy`; `pg_constraint` on `games`                                                                                                       | 4 functions (`admin_delete_team`, `field_bookings`, `rollback_field_import_job`, `update_game_score`); 1 view; 0 policies; 0 foreign keys to `games`. Control: three of the four also name `game_assignments` in the same query, so the pattern matched real bodies |
| F-R5  | Product readers of `games` and whether they write  | `rg -n "from\(['\"]games['\"]\)" frontend/src supabase/functions packages scripts` (tests and mocks left out), then a write-call search 12 lines after each                                                                                                           | 6 product files (`LeagueStandings.jsx`, `PlayerRecordPage.jsx`, `teamFeed.ts`, `DashboardPage.jsx`, `ScoresPage.jsx`, `useTeamPortal.js`) plus the mock; 0 write calls. 21 test files name the table in a seed or mock; 8 pgTAP files insert into it                |
| F-R6  | Table shape                                        | `information_schema.columns`, `pg_constraint`, `pg_indexes`, `pg_trigger`, `pg_policies` for `games`, `game_assignments`, `game_slots`                                                                                                                                | `games_game_slot_id_key` UNIQUE; the tuple unique index on `game_assignments`; two foreign keys to `game_slots`; no season column on `game_assignments`; `games_readonly_when_completed` present                                                                    |
| F-R7  | The standings view                                 | `pg_get_viewdef('public.view_league_standings')` and `reloptions`                                                                                                                                                                                                     | Matches `20261023010000:65`; `security_invoker=true`; no filter on teams                                                                                                                                                                                            |
| F-R8  | Production holds no schedule and no scores         | `SELECT count(*)` over `games` (all, scored), `game_assignments`, `game_slots`, game `scheduler_runs`, `teams`, `players`, `divisions`, `programs`, `organizations`, `season_settings`, `audit_log` (`competition.score_updated`); `jsonb_object_keys(feature_flags)` | 0, 0, 0, 0, 0, 0, 0; 32, 1, 1, 1; 0; flag keys: four, none `score_entry` or `standings`                                                                                                                                                                             |
| F-R9  | A move is a new row                                | Read `moveGameTo` (`GameSchedulingPage.jsx:1195-1290`) and the upsert (`20261108020000:2240-2310`)                                                                                                                                                                    | The week follows the target slot; the conflict key is the tuple; `DO UPDATE` does not set `id`                                                                                                                                                                      |
| F-R10 | Settings storage                                   | Columns of `programs`, `divisions`, `organizations`, `season_settings`; `20261111010000:745-780`; `supabase/tests/season_rollover.sql:70-78`                                                                                                                          | `programs` has no settings column and is per season; rollover copies a program's name only; divisions go through `rollover_division_columns()`                                                                                                                      |
| F-R11 | `is_external` does not exist yet                   | `rg -l "is_external" . -g '!node_modules' -g '!docs/**'`                                                                                                                                                                                                              | 0 files (PR 5 adds it)                                                                                                                                                                                                                                              |
| F-R12 | No existing pgTAP file asserts a hidden row        | `rg -n -i "orphan\|older run\|previous run\|new row\|ghost\|flip" supabase/tests/game_persistence_rpc.sql`                                                                                                                                                            | 0 matches. Control: the file has 27 lines with a pgTAP assertion call (`rg -c`)                                                                                                                                                                                     |
| F-R13 | `coach_field_ids_of` is gone                       | `rg -n "coach_field_ids_of" supabase/migrations`                                                                                                                                                                                                                      | defined in `20261102010000`, dropped at `20261104010000:829`                                                                                                                                                                                                        |
| F-R14 | The Edge schema carries an optional row `id`       | Read `supabase/functions/game-persistence/index.ts:42-60` and the RPC's payload reads                                                                                                                                                                                 | `gameRows: z.array(z.object({ id: z.string().optional() }).passthrough())`; the RPC reads `run_data->>'id'` only                                                                                                                                                    |

**Hygiene.** `prettier --write` (3.7.4, the repository's `.prettierrc`, installed outside the repository and removed); a check that the file is plain ASCII and names no model (the only match for a model family is the branch name quoted in the header); the placeholder grep of `prompts/plan-change.md`; `git diff
--check`; the name guard's digests applied to this file by a scratch script (the test itself was not run).

**Not run.** The test suite, coverage, E2E, the build, lint, typecheck, pgTAP, the `dbharness` plants, any migration, any
code path; the spike of U1; `gh pr list` (the number of open pull requests, and whether PR 1 has started, are unknown); the
owner's workbooks (not available); a page-level reproduction of the empty team page (it is shown from the reads, not run);
the Supabase advisors; whether the demo league seeds any game (not searched).

## What the planning taught (for `docs/LESSONS_LEARNED.md`, written in F11-1 and F11-2)

- **A row id is an identity only if the writer keeps it.** The save inserted a new row for a moved game, so every promise
  keyed to the id (a history, a flag, an external number, a score) broke at the first move. Before keying anything to a
  row, read what the writer does to a row that moves.
- **Count readers from the live catalogue.** Twenty migration files name `games`; the live catalogue has four functions and
  one view. A census by file finds stale bodies and dropped functions.
- **Four criteria, two questions.** Three of the four were one question (identity); the fourth was about a setting, not
  storage. Separating them made the options comparable.
- **A unique column on the legacy table was the evidence.** `UNIQUE (game_slot_id)` against a slot capacity above one showed
  that "keep it in step" could not hold what the new table holds.
- **Ship the default and a seam before the cascade.** The owner's three-level setting needs storage, a resolver and a
  rollover rule; the default and one function that the cascade later extends are correct without them.

## Output of the planning (prompts/plan-change.md)

1. Size verdict: planned, not small (above).
2. The plan is this file. Departures from AGENTS.md: none; rule 14 is the stop. No ADR is drafted (the repository has no ADR
   folder). Open questions: ten owner decisions (D1 to D10); D1 and D2 block approval, the rest have recommendations.
3. The first task and its test: F11-1's A1, starting with `supabase/tests/game_identity.sql`, red against today's code.
4. What the planning taught: the last section above.
