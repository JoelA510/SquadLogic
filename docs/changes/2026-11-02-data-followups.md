# Data follow-ups: codify the production-only GIN index; leave the not-eligible out of the team advice

Status: **owner decision 2026-11-02, "Address smaller items as recommended"**, for two items that follow
`docs/changes/2026-11-01-followups-f1.md` and the read-only production drift check recorded in this
plan. AGENTS.md rule 14 applies to both (item 1 adds a migration, so it touches persistence; item 2
changes what the Teams page counts), so this plan is written before the code. Drawn up against
`origin/main` `228980a`.

Every claim about the code is _statically reviewed_ unless marked _executed_. Production was read only,
through the Supabase MCP `execute_sql` on the production project, with `SELECT`s on the system
catalogues; nothing was written to it and no repository migration was applied to it by hand.

**Scope.** Two items, one pull request. Item 1 is a migration, its revert and smoke, and the harness
entries for them. Item 2 is the Teams page's advice and its two display components. No change to team
generation, the solver, core, a table, a column or a CHECK; the season fixture is untouched.

## Item 1. Codify `players_custom_attributes_gin_idx`

### What production holds (_executed_, 2026-11-02)

| Fact                                                                                   | Value                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pg_indexes.indexdef`                                                                  | `CREATE INDEX players_custom_attributes_gin_idx ON public.players USING gin (custom_attributes)` |
| Valid, ready, live                                                                     | yes, yes, yes                                                                                    |
| Access method, operator class, key columns                                             | `gin`, `jsonb_ops` (the default; not spelled in the definition), 1 key column, a `jsonb` column  |
| Unique, partial, expression, storage parameters                                        | no, no, no, none (`reloptions` null)                                                             |
| Size, scans since the statistics were last reset                                       | 5200 kB, 1 scan that read 0 tuples; `players` holds 0 rows today                                 |
| In any repository migration, doc or test, in any branch's history (`git log --all -S`) | no: it was applied by hand                                                                       |

### Other drift (_executed_, reported and not fixed, as asked)

A scratch PostgreSQL 16 cluster was built from all 171 migrations at `228980a` and compared with
production, for schema `public`:

- **Indexes.** Per table, an md5 of every `indexname|indexdef` in a fixed order: 57 tables on each
  side, 55 equal, 2 different: `players` (7 indexes in production, 6 built) and `teams` (4 and 3).
  Taking `players_custom_attributes_gin_idx` and `teams_custom_attributes_gin_idx` out of the
  production side makes both hashes equal the build's. So the only index drift is **two** GIN indexes.
- **`teams_custom_attributes_gin_idx`** is the same shape on `teams.custom_attributes`
  (`gin`, `jsonb_ops`, valid, 24 kB, 1 scan that read 0 tuples). It is not in this change: the brief
  names the players index and says to report anything else without fixing it. **Owner decision:**
  codify it the same way (a one-line sibling migration), drop it, or leave it.
- **Columns, constraints, row security.** Per table, an md5 of every column (name, type, nullability,
  default) and every constraint (name, definition), with the two row-security flags, for all 57 tables
  and the one sequence: 58 relations, all equal.
- **Functions, triggers, policies, views.** The operator query in `docs/operations/ci-cd.md`
  ("Catalogue drift check"), generated from `supabase/catalog-snapshot.json` at `228980a` and run
  read-only against production: only the four `count` rows (196 functions, 112 policies, 69 triggers,
  4 views), so no `only_in_database` and no `only_in_snapshot`.

### What reads rely on it: none (_statically reviewed_, and _executed_ on the head catalogue)

- A GIN `jsonb_ops` index serves `@>`, `?`, `?|`, `?&`, `@?` and `@@` on the column. A search of the
  head build (scratch cluster) for a function, policy, view or constraint that uses one of them on
  `custom_attributes` finds **none**: five functions mention the column (`finalize_import_job`,
  `finalize_coach_import_job`, `rollback_coach_import_job`, `minimise_import_people_data`, and the
  `validate_custom_attributes` trigger) and every use is a whole-document merge, replace or
  `jsonb_each`; no policy or view mentions it. The search matched: it lists those five.
- The application never filters by it: `custom_attributes` is a selected column
  (`EnterpriseDashboard.jsx`, `analyticsUtils.js`) and an object the finalizers and the import
  allowlist build; there is no `.contains(...)` or `->>` filter on it in `frontend/src`,
  `packages/core/src` or the Edge Functions. The only `?` uses are in a pgTAP file
  (`supabase/tests/play_up_requested.sql:74`) and two smokes, on a handful of rows.
- Production agrees: 1 scan since the last statistics reset, 0 tuples read.

So the index is **dead weight today**: it costs on every write and serves no read. Measured
(_executed_, one run each, scratch PostgreSQL 16, 20,000 `players` rows of eight custom attributes,
inside a rolled-back transaction, with the table's real triggers): an insert takes 0.98 s without it and
1.53 s with it (+56%), an update of `custom_attributes` over all rows 1.00 s and 1.48 s (+47%), and the
index is 8.4 MB beside 22 MB of heap. A league's season import is a few thousand rows, so this is a
fraction of a second per import. That is **not harmful**, so the owner's recommendation stands and it is
codified; the owner may still prefer to drop it (decision below).

### Options

1. **Codify it with `CREATE INDEX IF NOT EXISTS`, matching production exactly (chosen; the owner's
   recommendation).** Fresh deployments get it; production is untouched.
2. Drop it from production, by a migration. Removes a measured write cost for a read nothing makes, but it
   is a production change to an object the owner did not ask to remove, and the first query that
   filters on a custom attribute would need it back. Not done; a later migration if the owner decides.
3. Leave it. Fresh builds keep lacking an index production has, which is the drift.

### Design

`supabase/migrations/20261117010000_players_custom_attributes_gin_index.sql`:

- `CREATE INDEX IF NOT EXISTS players_custom_attributes_gin_idx ON public.players USING gin (custom_attributes);`
  with the default operator class and no storage parameters, as production has it.
- **`IF NOT EXISTS` compares the name only.** An index of this name with another shape (a btree on the
  column, a `jsonb_path_ops` GIN, a partial one) would be skipped and the migration would call itself
  done: a declared guarantee nothing enforces. So a `DO` block after the statement reads the catalogue and
  refuses (`RAISE EXCEPTION`, which rolls the migration back) unless the index is on `public.players`,
  `gin`, `jsonb_ops`, one key column `custom_attributes`, not unique, not partial, not an expression, no
  storage parameters, valid and ready. In production every one of those holds (the table above), so it
  passes there and changes nothing.
- **In production this is a no-op**: the index exists, `IF NOT EXISTS` skips it (a NOTICE), it is not
  rebuilt and `players` is not locked. On a populated database that lacks it, the build takes a `SHARE`
  lock on `players` (writes wait, reads do not) for as long as it runs, and a migration cannot use
  `CONCURRENTLY` (it runs in a transaction): the comment in the file says to build it first by hand with
  `CREATE INDEX CONCURRENTLY` under the same name, after which the migration skips it.
- Nothing else: no table, column, CHECK, policy, function or grant. The catalogue snapshot
  (`supabase/catalog-snapshot.json`) covers functions, triggers, policies and views and not indexes, so
  it does not change; the harness's snapshot stage proves it (`PASS catalog snapshot`).
- **Version.** `20261117010000`: the next free after the highest in `origin/main` (`20261115010000`) and
  after `20261116010000`, which the preference follow-ups take (their worktree holds it untracked; it is
  not on `origin`). `scripts/ci/migrationVersions.mjs` needs an added migration to be newer than the base
  branch's latest, and the deploy guard refuses a pending version older than the highest applied. **So
  this pull request must merge after the preference one:** merged first, `20261116010000` would be
  older than an applied version and would have to be renamed.

`docs/sql/20261117010000_revert.sql` is a **documented no-op**. The migration cannot tell, when it
skips, whether the index was made by it (a fresh build) or by someone else (production), so no revert
can drop it safely: in production a `DROP INDEX` would remove an object that exists independently of
this migration. The revert prints a NOTICE saying so (and whether the index is present) and changes
nothing; removing the index is a separate, deliberate migration (option 2). The harness applies it like
every revert (`REVERT_CHECKS`) and checks it left the index alone.

`docs/sql/20261117010000_smoke.sql` (at head, one rolled-back transaction): the index exists with the
shape above; and, with sequential scans switched off, a `@>` and a `?` query on `players.custom_attributes`
plan through it (so it is the index the operators use, not an index that exists and is never chosen).

### Harness

`scripts/dbharness/run.sh`: the id joins `REVERT_CHECKS`. Before the revert, on the database built up to
the migration (so the index exists, as in production): the migration is applied again and must succeed and
leave the index _not rebuilt_ (its `relfilenode` is unchanged); the index is then replaced by a btree of the
same name and the migration must refuse it, naming the index; the GIN is put back. After the revert: the
index is still there, GIN, valid, with the filenode it had. `scripts/dbharness/prove.sh`: `M66` and `R66`
(the next free numbers: `M65`/`R65` are the preference follow-ups' in their worktree) with four plants,
each of which must turn a named check red (listed in Tests).

### Tests (item 1)

| Check                                                                                   | Plant that makes it red (each shown red, then reverted)                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Re-applying onto a database that holds the index leaves it alone (run.sh, revert stage) | `M66 the index is dropped and rebuilt on every apply` (a `DROP INDEX IF EXISTS` ahead of the `CREATE`) |
| A same-named index of another shape is refused (run.sh, revert stage)                   | `M66 the guard reports instead of refusing` (`RAISE EXCEPTION` become a `RAISE NOTICE`)                |
| The revert leaves the index (run.sh, revert stage)                                      | `R66 the revert drops the index`                                                                       |
| The smoke reads the right index (smoke `20261117010000`)                                | `S66 the smoke looks for another index` (a planted smoke, as `S5` is)                                  |

`PLANT_ANCHORS_ONLY=1` resolves every anchor exactly once. The full `prove.sh` sweep is 5.4 hours and is
not run; the four plants are run on their own, and the pull request says so.

## Item 2. Leave the not-eligible out of the team advice

F1 (item 3) held the waitlisted out of the recommended team count and left the not-eligible in, because
who they are "takes each player's age placed against the division rules (a different computation)". The
owner now asks for the same treatment, "from the same place, with the same contract".

### What "not eligible" means (_statically reviewed_; searches shown)

- **It is derived, by one function.** `applyPlayUpEligibility` (`packages/core/src/playUp.js`) places each
  player from their natural age, the division they registered in (its age band and gender) and the
  league's divisions; a player whose age is outside the registered division's band, who did not request
  to play up, and whom no division of a compatible gender holds, gets `placement: 'no_division'`.
  `isEligibilityBlocked(player)` is the only predicate for it, and `cannotBePlaced` (blocked or
  waitlisted) is the predicate generation seats by. Every consumer calls them: `teamGeneration.js`
  (`separateEligibilityBlocked`, `cannotBePlaced`), `waitlistException.js`, `placementReview.js`,
  `PlacementReviewList.jsx`, `BuddyRequestsList.jsx`, and the Teams page's messages
  (`rg -l "isEligibilityBlocked|NO_DIVISION|eligibility-blocked"` lists exactly those).
- **It is not stored.** `rg -i "eligib" supabase/migrations supabase/functions docs/sql` finds no flag,
  status or RPC that decides it. `players.status` is `active`, `inactive`, `pending` or `waitlist`.
  There is one stored column of the name, **`players.placement_eligible boolean NOT NULL DEFAULT true`**
  (`20260530000000`): `rg placement_eligible` finds it in that migration and its revert and smoke, in
  the demo's list of editable columns (`frontend/src/lib/demo.js`, `20261030010000`) and its test, and
  nowhere else. **Nothing writes it** (not the import allowlist, a finalizer or an RPC) **and nothing
  reads it**, so every row holds `true`. It is not a second source of truth, because nothing consults
  it; it is a field declared and never honoured. **Owner decision:** drop it (a migration), or give it
  a meaning; this change does neither, and the advice does not read it.
- So there is **one** source of truth for "not eligible", and the Teams page already calls it twice
  (`destinationPrograms`, and generation). None of the stop conditions in the brief holds: no schema,
  CHECK or column change; nothing in core changes, so team generation and the season fixture cannot
  move (the fixture suite and the generation goldens are run to show it); and the definition is the one
  above.

### Every reader that counts players for advice

`derivePrograms` (one count per program, from the import rows) feeds: `deriveProgramStats` (estimated
teams, the settings panel's recommendation `assessTeamCount`, average roster, capacity);
`ProgramOverview` (the Players cell and the status badge); `TeamingConfiguration` (the recommendation
sentence); and `destinationPrograms` (the players an empty division's rules take from other programs).
`useTeamAnalysis.js` counts a different thing (stored rosters) and is not an advice reader.
`teamsCount` in the page's generation call is passed to core and read by nothing there (`rg teamsCount`),
so the advice cannot reach generation.

### The sibling's contract (F1, item 3), and what is adopted

`derivePrograms(rows, waitlistedRows)` takes the set of row positions the decision names, counts those
apart (`waitlistedCount`), counts the rest as `playerCount` (the players generation can seat), and keeps
`totalPlayers` as everyone registered. A program with nobody to seat advises no team. The overview and
the panel say how many were left out when there are some and read byte for byte as before when there are
none. The set is decided where generation decides it: record over file (`withDurableIdentity`), by one
predicate. A read that fails is logged and the file is used meanwhile.

Adopted for the not-eligible:

- `derivePrograms(rows, waitlistedRows, notEligibleRows)`: a row in the third set is counted in
  `notEligibleCount`, not in `playerCount`; `totalPlayers` is the three together. **A row both
  not eligible and waitlisted is counted once, as not eligible**: the holds list, the overflow and the
  review totals already report it that way ("listed once, as blocked", F1 item 2; `placementReview.js`
  counts the blocked first), so the three counts partition the registrants.
- **The set** is `notEligibleRowIndexes(rows, durablePlayers, divisionDescriptors, season)`: every row is
  turned into the generator player generation would build (`toGeneratorPlayer` over
  `withDurableIdentity`, with the stored natural age and play-up request, which are the record's to
  change), placed with `applyPlayUpEligibility` against the same descriptors
  (`buildDivisionDescriptors`) and the season's year and cutoff, and the rows for which
  `isEligibilityBlocked` holds are the set. No second rule: it is the function generation runs. Row ids are
  made unique first (`row-<position>`), because the function keys its players by id and two rows can
  share one.
- **The stored read** (`fetchDurablePlayers`) is now made for every league, not only with the Waitlist
  option on: the record wins over the file for the natural age and the play-up request just as for the
  waitlist (a coach or an admin who sets a play-up request on the player record makes a too-young player
  eligible; the file does not know). It is made once per import, chunked and at most eight requests at a
  time, as generation's own read is. **This is the new cost:** F1 made no request for a league with the
  option off; this one makes the page's read for everyone. A read that fails is logged, and the file's
  own columns are used meanwhile; generation still re-reads and still stops on a refused read.
- Until a read of the season's divisions has worked (`divisionsRead`, set only by a successful read:
  not while they load, not when the read failed, not with no season), nobody is counted as not
  eligible, so the advice is what it was; once they arrive it narrows. A read that worked and returned
  no divisions is still judged, by the band each division's name gives, as generation judges it. (The
  first build keyed this on `divisionRows` alone, which the page sets to `[]` after a failed read to keep
  rendering: a failed read then looked like a season with no divisions, lost the saved age bands, and
  called a U10 held to ages 9 to 10 an age-10-only division. Review of #696; fixed in its own commit.)

### Options considered

1. File only (the rows' ages and the file's play-up column): no stored read, wrong after the record is
   edited, in the same way F1 showed for the waitlist (rejected for that reason).
2. The record over the file, read once, the same function as generation (chosen).
3. Count the blocked from a run's result: loses the advice before generating (rejected, as in F1).

### Not covered (stated, not fixed)

- **The advice counts a player in the program they registered in; generation seats them in the one
  they play in.** A play-down, or a play-up nobody requested, plays in their own age division, so a
  program's advised count and what generation seats there differ by them (and `destinationPrograms`
  adds only to divisions the file has no registrant in). That predates this change and is not the
  not-eligible, who are seated nowhere. **Owner decision** whether the advice should count by the
  division played in. **Resolved 2026-11-03** (owner: "As recommended on all of them, start PR 1"; PR 1
  of `docs/changes/2026-11-03-play-down-default-and-flags.md`): the advice counts by the division
  played, through one placement and one count of the seats (`placeImportRows`, `summarizeSeats`), and
  the Players cell says who moved.
- A player the record places in another division than the file's (`division_id` differs) is read as
  generation reads the "others"; the selected program's narrower match (a stored player in a different
  division is refused) is a generation error, not an advice count.
- A waitlisted coach's-child's buddy who generation takes off the waitlist (`applyWaitlistException`) is
  still counted as waitlisted until the page's save makes them active, as in F1.

### Display

`ProgramOverview`: under the Players count, `N not eligible` beneath (or beside) `N on the waitlist`;
the status reads `All on the waitlist` (nobody but the waitlisted), `None eligible` (nobody but the
not-eligible) or `Nobody to seat` (both kinds, none seatable). `TeamingConfiguration`: the
recommendation's parenthesis names whichever applies: `(2 not eligible for the division are not
counted)`, `(1 on the waitlist and 2 not eligible for the division are not counted)`; the waitlist-only
sentence is byte for byte F1's.

### Tests (item 2; each shown failing first; at the default 5 s timeout)

`tests/teamingConfigurationAdvice.test.jsx` (the page, the overview, the panel and the real generator;
every expected figure worked out from the import and the limits, never read back from the page):

- 30 rows registered in a division whose band is 9 to 10, 6 of them aged 14: advised for 24 (2 teams),
  not 30 (3 teams), and the row says `6 not eligible`; the Generate button then makes the advised 2.
- The record over the file, both ways: a too-young player the record marks as a requested play-up is
  counted (30 seated, 3 teams, where the file alone says 2); a player whose record age is outside every
  band, though the file's is inside, is not counted.
- A row both waitlisted and not eligible is counted once, as not eligible; the three counts add up.
- A program whose registrants are all not eligible advises no team and reads `None eligible`.
- The divisions not yet read, or refused: nobody is left out, and the advice is what it was; a read that
  worked with no divisions is judged by the names; a refused `players` read falls back to the file and
  logs.
- An option-off league now reads the stored players once (the F1 test that pinned "reads nothing new"
  is changed to say so, and still counts everyone when nobody is waitlisted or ineligible).
- The sentence and the badge for each combination.

`tests/e2e/features/Pillar1_Engine.feature`: one mock scenario (100 imported, 20 of them older than the
division allows: the overview recommends the count for 80 and says 20 are not eligible), which runs
against the mock client's own `players` table rather than the unit tests' stand-in.

Plants (three; each must turn a named test red, then is reverted): the exclusion removed (the not-eligible
counted in `playerCount` again); the stored record ignored (the file's age and play-up column only); the
overlap counted as waitlisted as well as not eligible (the partition broken).

## Gates and what is not run here

The branch is built and gated locally and committed, and **not pushed** until the owner says so (two
pull requests are already in flight; the repository allows two). The gates: typecheck, lint with zero
warnings, `check:unused`, `check:advisors`, the full `test:coverage` at the default timeout, the full mock
E2E (`--workers=1`), the frontend build and `check:bundle` as CI makes them, the migration harness
(`run.sh`) and the four plants of `prove.sh`, pgTAP files touched (none expected), the season fixture
and the generation goldens unchanged, and `git diff --check`. **Not run here:** the full `prove.sh`
sweep (5.4 hours), the real-backend E2E and the CI pgTAP job on the project's PostgreSQL 17 (the guard
reads catalogue columns present from 12 to 17), and Deno (no Edge or shared code changes).

## Build notes (what was run, and what changed from the plan)

_Executed_ unless marked otherwise; the head the numbers are for is the commit that carries this section.

| Gate                                                                                                                                        | Result                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`, `npm run lint` (`--max-warnings=1`, none printed), `npm run check:unused`                                              | clean                                                                                                                                                                     |
| `npm run check:advisors`                                                                                                                    | PASS, 172 migration files                                                                                                                                                 |
| `npm run test:coverage` at the default 5 s timeout                                                                                          | 488 files, 7803 tests passed, thresholds met; includes the season fixture suite (`season2026Fixture`, `naturalAgeSeasonFixture`) and the generation goldens, none changed |
| Mock E2E, `CI=true --workers=1 --trace off`, its own dev server (port 5173 checked free)                                                    | 215 passed, 0 failed; the new scenario and F1's waitlist scenario both ran in this tree                                                                                   |
| `VITE_*` stand-ins as CI sets them, `npm run build`, `npm run check:bundle`                                                                 | built; `PASS — all chunks within budget`                                                                                                                                  |
| `bash scripts/dbharness/run.sh` on a scratch PostgreSQL 16 cluster                                                                          | `HARNESS OK`, 172 migrations applied, `PASS catalog snapshot` (unchanged), `PASS smoke 20261117010000`, `PASS revert 20261117010000` and its three checks                 |
| `PLANT_ANCHORS_ONLY=1 bash scripts/dbharness/prove.sh`                                                                                      | all 439 anchors resolve exactly once (the four new ones included); the claim census passes                                                                                |
| The four plants of item 1, run on their own (a copy of the tree, so the real files were never mutated; the green baseline is the run above) | `M66` rebuild, `M66` report-not-refuse, `R66`, `S66`: each CAUGHT at the check named for it                                                                               |
| Item 2's three plants (page), then each reverted byte for byte                                                                              | the exclusion removed: 7 tests red; the record ignored: 2 red; the overlap counted as waitlisted: 1 red                                                                   |

**Changed from the plan.**

- The test double for `admin_upsert_division_settings` in `tests/teamingConfigurationAdvice.test.jsx`
  returned a division row with no age band, which the real RPC (it returns the whole `divisions` row as
  jsonb) does not; with it the generator took the band from the program's name and called every player not
  eligible. It now returns the band the saved row holds. The F1 test that pinned "the option off reads
  nothing new" now says the stored players are read once and their status is not looked at, and its log
  pattern follows the new message.
- `tests/teamSyncKeepsStatus.test.jsx` handed the page a new `importedData` object on every render. The
  real context memoizes it (`maskedImportedData`), and the page now reads the import's stored players in an
  effect keyed on it, so the stand-in looped until the 5 s timeout. It now hands out one object, as the
  context does. (The page keys the read on the rows' identity, as F1's did; a context that returned a new
  object per render would re-read per render, which the real one does not.)
- The pgTAP suite is untouched: no `supabase/tests` file changed, so none was run. No Edge or shared code
  changed, so Deno was not run.

**Not run.** The full `prove.sh` sweep (5.4 hours: only the four new plants, on their own); the real-backend
E2E; the CI pgTAP job on the project's PostgreSQL 17 (the migration's check reads `pg_index`, `pg_class`,
`pg_am`, `pg_attribute` and `pg_opclass` columns present from PostgreSQL 12 to 17; statically reviewed);
the production deploy; and any run against production beyond the read-only `SELECT`s listed above.

### Review round 1 (the divisions read)

A review of #696 found that the exclusion still ran after a failed read of the season's divisions:
`fetchDivisionRows` sets `divisionRows` to `[]` on an error (so the page renders and `divisionSettingsError`
blocks Generate and Save Rules), and the first guard only skipped `null`. Verified by a test that failed
first: with the read refused, 30 nine-year-olds in a U10 saved as ages 9 to 10 were called not eligible (the
name "U10" gives the band 10 alone) and the division read `None eligible` instead of 3 teams. Every consumer
of `divisionRows` was searched: generation and the rules save cannot run in that state (the validation error
disables both), the program grouping and `destinationPrograms` treat `[]` as nothing to group, and only the
new exclusion read `[]` as the season's divisions. The fix is at the read: `divisionsRead` is set by a
successful read only. Two tests (the refused read leaves the advice as it was; a read that worked with no
divisions is still judged by the names) and two plants (the old guard, and an over-guard that skips an empty
successful read), each red at its own test and restored. `tests/teamingConfigurationAdvice.test.jsx`'s
overview helper now reads the overview table's own headers, because the validation banner carries a table
of its own.
