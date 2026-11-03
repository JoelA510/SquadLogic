# Drop the dead column `players.placement_eligible`

Status: **owner decision 2026-11-03, "As recommended for the teams.custom_attributes and
players.placement_eligible"**; the recommendation for this column was to drop it by a small migration, plan
first. AGENTS.md rule 14 applies (it changes persistence), so this plan is written and committed before the
code. Drawn up against `origin/main` `2ae6333`.

Every claim about the code is _statically reviewed_ unless marked _executed_. Production was read only,
through the Supabase MCP `execute_sql` on the production project (`SquadLogic`, the only project of that
name), with `SELECT`s on the system catalogues and one `count(*)` over `players`; nothing was written to it
and nothing was applied to it by hand or through `apply_migration`. CI is the only writer of migrations.

**Scope.** One column. A migration that drops it and removes its name from the one function that lists it, its
revert, its smoke, the harness stage and plants that prove them, the demo library's copy of that function's
list, one old smoke that counts the column, and the docs. **Not in scope:** the prod-only
`teams_custom_attributes_gin_idx` (the owner's decision is to leave it alone), any other column, anything in
team generation, the solver or the season fixture, and the Windows desktop version (not started).

## 1. What the column is (_executed_ 2026-11-03)

| Fact                                                                                                                              | Production                                                                                                                                                                                                                                                     | A build of the 173 migrations at `2ae6333`                  |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `public.players.placement_eligible`                                                                                               | `boolean NOT NULL DEFAULT true`, not generated, no column ACL                                                                                                                                                                                                  | the same                                                    |
| Columns of `players` (name, type, nullability, default)                                                                           | 37, md5 `0984ec57acdf45b7d20a29ffc3ced1b6` over `name\|type\|notnull\|default`, sorted                                                                                                                                                                         | 37, the same md5                                            |
| Rows in `players`                                                                                                                 | **0** (0 true, 0 false)                                                                                                                                                                                                                                        | 0                                                           |
| Any other column of the name, in any schema                                                                                       | none                                                                                                                                                                                                                                                           | none                                                        |
| `pg_depend` rows on the column                                                                                                    | one: its own default (`pg_attrdef`)                                                                                                                                                                                                                            | the same                                                    |
| Views, rules, policies, triggers (incl. `WHEN`), indexes, constraints, statistics objects, publications naming or depending on it | none of each (scanned: 9 views and matviews, 122 policies, 81 triggers, 458 indexes; no publication lists `players`: the build's `supabase_realtime` lists three other tables; rules and any other dependent would show in `pg_depend`, which is the next row) | none (4 views, 120 policies, 71 triggers, 307 indexes)      |
| `cron.job` commands naming it                                                                                                     | 0 of 6                                                                                                                                                                                                                                                         | (stub)                                                      |
| Functions whose body names it                                                                                                     | **1 of 1,570** (all non-system schemas): `public.demo_fence_player_write()`                                                                                                                                                                                    | 1 of 430: the same function                                 |
| Deployed body of that function                                                                                                    | md5 `fb4c627e18ebaf5309750e6a177eac6c` (with and without carriage returns: equal), 1269 bytes, `SECURITY DEFINER`, `search_path=public`, owner `postgres`, execute for `postgres` and `service_role` only, no comment                                          | md5 `fb4c627e18ebaf5309750e6a177eac6c`, the same attributes |
| Trigger on `players` that calls it                                                                                                | `demo_fence_players`, `BEFORE INSERT OR UPDATE OR DELETE`, enabled                                                                                                                                                                                             | the same                                                    |
| Migration ledger head                                                                                                             | `20261117010000`                                                                                                                                                                                                                                               | `20261117010000` is the last file                           |

The column was added by `20260530000000_age_cutoff_division_bands_canonical_fields.sql` with four siblings.
The production `players` column fingerprint equals the build's, so the build is a faithful stand-in for
production's `players`, and the one function that names the column has the same body in both.

## 2. Every reader and writer, and what each needs

### The searches (_executed_ in the worktree at `2ae6333`)

| Search                                                                                                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git grep -nIi -e placement_eligible -e placementEligible -e placement-eligible -e "placement eligible"` over all 2,167 tracked files                                                                                                                                                       | 10 lines in 9 files (the first table below). No other tracked file, including every `.csv`, `.tsv` and `.json` (58) and every other spelling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Positive control for that search                                                                                                                                                                                                                                                            | the same shape of search for the sibling `willing_to_coach` / `willingToCoach` matches 92 files, so it can find a column name in this tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The column name by area (files naming `players` / files naming the column)                                                                                                                                                                                                                  | `supabase/functions` 7 / 0, `packages/core` 27 / 0, `frontend/src` 71 / 1, `scripts` 6 / 0, `fixtures` 2 / 0, `tests` 170 / 1, `supabase/tests` 30 / 0, `supabase/seed.sql` 1 / 0, `docs/sql` 74 / 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Function bodies in a build at head, every non-system schema (scratch PostgreSQL 16, `prosrc ~* 'placement[_ ]?elig'`)                                                                                                                                                                       | 1 of 430: `public.demo_fence_player_write()`. Positive control: the search lists it, so it matches a body that names the column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The same regex over production                                                                                                                                                                                                                                                              | 1 of 1,570 (_executed_ read-only): the same function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Policies, views, rules, triggers, indexes, constraints, comments, column ACLs, statistics, publications in the build and in production                                                                                                                                                      | none (the table in section 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pg_depend` on the column                                                                                                                                                                                                                                                                   | only its default, in both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Generic readers** (a body that handles a whole `players` row and so could carry the column without naming it): `to_jsonb(`, `row_to_json`, `populate_record`, `%ROWTYPE`, `alias.*`, `SELECT *`, `jsonb_each`, `information_schema`, `pg_attribute`, over bodies that also name `players` | 15 functions, each read. Those that hold a whole `players` row: `admin_create_player` and `admin_update_player` (`v_player public.players%ROWTYPE`, read back after the write and **returned whole**, so their JSON loses one key), and `demo_fence_player_write` (`to_jsonb(NEW) - c_allowed`). The `p.*` of `finalize_import_job` (`valid_candidates`) and of `finalize_evaluation_import_job` (`judged`) is a CTE over the **staged, parsed rows**, not `players` (corrected in review: the first draft of this plan called it a CTE of the current players, which was not read). The rest are other tables (`import_jobs`, `coaches`, `teams`, `divisions`, `season_settings`, `practice_exceptions`, `practice_assignments`) or lists of ids. **None writes a column by name that the drop removes**, and the row-valued ones return keys the callers never read (below). |
| Every `INSERT INTO players` and `UPDATE players` in a function body (_executed_, build at head)                                                                                                                                                                                             | 3 inserts (`finalize_import_job`, `admin_create_player`, `start_demo_session(text)`) and 9 updates, **each with a named column list that omits the column**; none inserts a whole row. So nothing writes it and every row holds the default `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The keys a client can write through `sanitize_player_patch` (the one gate of `admin_update_player`, `admin_bulk_update_players`, `admin_create_player`)                                                                                                                                     | the column is not among them (`sanitize_player_patch`'s body does not name it; the mock's twin, `PLAYER_PATCH_FIELDS`, does not either). A direct table write by an admin is the only way to set it, and nothing in the app makes one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `select('*')` on `players` in the app                                                                                                                                                                                                                                                       | one: `PlayerRecordPage.jsx` (reads named fields from the row; it enumerates no keys). `Object.keys/entries` over a variable named `player`, `row` or `p` in `frontend/src`, `packages/core/src` and `supabase/functions`: 5 hits (the mock's export-document check, the import allowlist over a file row, a practice-CSV parser, a publication schema), _statically reviewed_: none enumerates a `players` table row.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Every hit, and what each needs

| #   | Where                                                      | What it is                                                                                                                                                                                                                                             | What the change does                                                                                                                                                 |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `supabase/migrations/20260530000000_...sql:50`             | creates the column. Applied; immutable (`scripts/ci/migrationVersions.mjs` refuses an edit).                                                                                                                                                           | nothing; the new migration drops it.                                                                                                                                 |
| 2   | `supabase/migrations/20261030010000_demo_sessions.sql:323` | **the only code that names it**: the `c_allowed` list of `demo_fence_player_write()`, the columns a demo visitor may still change. It reads no value; it keeps the name editable. Applied; immutable.                                                  | the new migration replaces the function on its deployed body (md5 guarded) with the name removed.                                                                    |
| 3   | `docs/sql/20260530000000_revert.sql:15`                    | `DROP COLUMN IF EXISTS placement_eligible`. Idempotent: still correct when the column is already gone.                                                                                                                                                 | left as it is.                                                                                                                                                       |
| 4   | `docs/sql/20260530000000_smoke.sql:16`                     | counts five `players` columns of the migration, `= 5`. **At head it would read `ok = false`** (a reporting `SELECT`; it does not stop the harness, and would print a false result).                                                                    | edited: four columns, and a check that the dropped one is absent (older smokes are edited when a later migration changes what they read, as `20260927000000`'s was). |
| 5   | `frontend/src/lib/demo.js:65`                              | `DEMO_EDITABLE_PLAYER_FIELDS`, the browser's copy of the server fence list (`canEditPlayerField`). No caller asks about this column (`PlayersPage`, `PlayerRecordPage` ask `first_name`, `last_name`, `gender`, `buddy_request`, `play_up_requested`). | the name is removed.                                                                                                                                                 |
| 6   | `tests/demoLib.test.js:85`                                 | lists it among the fields a demo may edit.                                                                                                                                                                                                             | removed; a new case says it is no longer editable; a new case holds the JS list to the SQL fence list.                                                               |
| 7   | `docs/changes/2026-10-22-demo-mode.md:939`                 | history of the fence's list.                                                                                                                                                                                                                           | a dated pointer, the text left.                                                                                                                                      |
| 8   | `docs/changes/2026-11-02-data-followups.md:163-164`        | the plan that found the column dead and asked the owner.                                                                                                                                                                                               | a dated pointer to this plan, the text left.                                                                                                                         |
| 9   | `docs/LESSONS_LEARNED.md:284` (lesson 87)                  | records the same finding.                                                                                                                                                                                                                              | left; the outcome is lesson 91.                                                                                                                                      |

The mock client (`mockSupabaseClient.js`, `mockDemo.js`, `mockServerSideReads.js`) never modelled the column:
none names it, and each does name `willing_to_coach`, so the same search would have found it. Nothing in
`supabase/functions`, `packages/core`, `fixtures/`, a CSV or an export names it. The demo seed
(`scripts/build-demo-seed.mjs` and `start_demo_session`) inserts `players` with a named column list that omits
it, so a demo's players take the default today and will have no such column after.

### Who reads it through the API

PostgREST would answer an explicit `select=placement_eligible` or a write of it with an error once the column
is gone. The app has no such call (the searches above); an outside script that does is unknown to this repo and
is named in the risks. A `select('*')`, and the whole row `admin_create_player` and `admin_update_player` return, simply carry one key fewer; nothing in the app reads that key (the searches above).

## 3. Stop conditions, checked

| Stop condition                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A reader or writer that is not the demo seed, the mock/demo library, a test or docs (real product logic) | None. Hit 2 is the demo's own server fence (`demo_sessions`): a text list of names a visitor may change, read by no product path, and the owner listed that migration among the expected hits. Nothing in core, an Edge function, an RPC, a policy or a page reads or writes the value. (Sections 1 and 2.)                                                                                                               |
| A dependent object `DROP COLUMN` would fail on                                                           | None: `pg_depend` has only the default, in the build and in production; no view, policy, trigger, index, constraint, statistics object or publication names it. `view_org_metrics` reads `players` but not this column. The migration uses no `CASCADE` and refuses if a dependent other than the default appears (so an index or a constraint, which a plain `DROP COLUMN` would remove without a word, is refused too). |
| An md5-guarded body whose deployed md5 cannot be reproduced                                              | Reproduced: `demo_fence_player_write()` is `fb4c627e18ebaf5309750e6a177eac6c` in the build and, read from production, in production (with and without carriage returns).                                                                                                                                                                                                                                                  |
| Anything needing a schema decision beyond dropping this one column                                       | None. The three siblings of the same migration are not touched (owner notes, below).                                                                                                                                                                                                                                                                                                                                      |

## 4. Design

### The migration: `supabase/migrations/20261118010000_drop_players_placement_eligible.sql`

`20261118010000` sorts after the latest on `main` (`20261117010000`), which `migrationVersions.mjs --base`
requires. One transaction (`BEGIN` to `COMMIT`, as `20261001000000` and `20261115010000` do), in this order:

1. `LOCK TABLE public.players IN ACCESS EXCLUSIVE MODE;` Held from the checks to the drop, so a value written in
   between cannot be destroyed after the guard counted none (`20261001000000`'s idea; this takes the mode the drop
   needs, so there is no lock upgrade to deadlock on).
2. A `DO` block of refusals, each rolling the whole migration back:
   - the starting body: `md5(replace(prosrc, E'\r', ''))` of `public.demo_fence_player_write()` must be
     `fb4c627e18ebaf5309750e6a177eac6c` (`to_regprocedure`, so a missing function refuses too);
   - the value: if the column exists, no player may hold `false` (`55000`, "refusing to drop
     players.placement_eligible: N player(s) hold false", with a hint). `NOT NULL DEFAULT true` means `false` is the
     one value anyone must have chosen; production holds no players, so this is `0` there and is checked again
     here, not trusted (`20261001000000` does the same for the coach columns);
   - dependents: any `pg_depend` row on the column other than its own default refuses, listing each by
     `pg_describe_object`.
3. `CREATE OR REPLACE FUNCTION public.demo_fence_player_write()` with the deployed body and one change: the
   allowlist reads `'willing_to_coach', 'updated_at'` where it read `'willing_to_coach', 'placement_eligible',
'updated_at'`. `RETURNS trigger`, `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public` restated
   (a replace resets `SET` clauses). Owner and grants are kept by `CREATE OR REPLACE`; the end-state check requires
   neither client role to be able to run it.
4. `ALTER TABLE public.players DROP COLUMN IF EXISTS placement_eligible;` **no `CASCADE`.**
5. An end-state `DO` block, or the migration does not commit: the column is gone; **no function in any
   non-system schema names it** (`prosrc ~* '\mplacement_eligible\M'`, listing the offenders); the fence function is
   still a pinned definer, executable by neither `anon` nor `authenticated`; the trigger `demo_fence_players` is
   still attached to `players`, calls it, and is enabled; the body still lists each of the other eight names
   (`team_id`, `division_id`, `status`, `rating`, `years_played`, `jersey_number`, `willing_to_coach`,
   `updated_at`), so the list was not emptied by the edit.

Locking: with `players` empty the drop is a catalogue change. The `ACCESS EXCLUSIVE` request queues behind any
transaction that has touched `players` and blocks later ones until it is granted; in production that is a demo
request or an import, so milliseconds to seconds. No `lock_timeout` is set (no migration here sets one); a
deploy that waits is a deploy that can be run again.

### The revert: `docs/sql/20261118010000_revert.sql`

One transaction. A `NOTICE` first: "this revert re-adds players.placement_eligible at its default: N player
row(s) come back true; whatever the column held before the forward migration is not restored (production held no
players when it was dropped), and nothing reads it". Then `ALTER TABLE public.players ADD COLUMN IF NOT EXISTS
placement_eligible boolean NOT NULL DEFAULT true` (a constant default, so no table rewrite), then the deployed
fence body (the `20261030010000` text, allowlist with the name), then a `DO` block that requires: the body's md5 is
`fb4c627e18ebaf5309750e6a177eac6c`, the column is `boolean`, `NOT NULL`, default `true`, the function is a pinned
definer closed to the client roles, and the trigger is attached. **The data is not restored; production holds none.**

### The smoke: `docs/sql/20261118010000_smoke.sql`

At head, one transaction that is rolled back. (1) The column is absent and its four siblings
(`registration_status`, `experience_years`, `play_up_requested`, `buddy_request_name`) are present: exactly one
column went. (2) No function body in a non-system schema names it. (3) The demo still starts with it gone: an
anonymous visitor (an `auth.users` row and claims, as `20261114010000`'s smoke does) calls
`start_demo_session('fall')`, a new demo comes back with its players, equal in number to the seed's
(`demo_seed`'s own count). (4) The fence still lets through each remaining editable column it names (rating,
years played, jersey number, willing to coach, status: one write each, on one demo player, by the table's owner,
which the fence also governs) and still refuses a column it does not name (first name, last name, notes,
`play_up_requested`, `custom_attributes`).

### pgTAP: `supabase/tests/demo_sessions.sql` (plan 117 to 123)

Six assertions in the people-fence section: the column is absent from `pg_attribute` (an `ok(NOT EXISTS ...)`: `hasnt_column` is not on
`tests/pgtapPlanCounts.test.js`'s list of assertion functions, so a plan over it would count one short); no
function names it (`prosrc` count `0`); a demo player's `years_played`, `jersey_number` and `willing_to_coach` each
still change through `admin_update_player` (the three allowed columns the file did not yet exercise); and
`play_up_requested`, a sibling column that is not on the list, is still refused (`42501`).

### The harness

`scripts/dbharness/run.sh`:

- **A stage before the emergency-rollback stage**, in the manner of the preference backfill's (lesson 67): build
  to `20261117010000`, plant an organization, a season, a division and three players (two `true`, one `false`),
  apply the migration and require it **to refuse**, naming the one player and leaving everything as it was (the
  column still there, the fence body still the deployed md5, every planted row unchanged); then set the row to
  `true` and apply it for real and require: the column gone, the three players present and every other column of
  every one of them unchanged, the fence body no longer naming it and no longer the old md5. A smoke runs after a
  migration and cannot run it again, so this is the only place the refusal and the population are seen.
- **The revert check.** `20261118010000` joins `REVERT_CHECKS`. On the database built to the migration, two
  players are planted (so the revert has rows to give the column) and the revert is applied; the verdict reads the
  catalogue: the column back as `boolean NOT NULL DEFAULT true`, both rows `true`, the fence body the deployed md5
  and naming the column, and the revert's `NOTICE` said "2 player row(s) come back true".
- No new `(checked)` claim line (each would need a `CLAIM_PROVER` entry); the stage prints `PASS` and `FAIL` lines,
  as the GIN index stage does.

`scripts/dbharness/prove.sh`: `M67`, `R67` (the next free numbers) and **three plants**, each of which must turn a
named check red and no other (anchors are checked to resolve exactly once with `PLANT_ANCHORS_ONLY=1`):

| Plant                                                                                                                 | Turns red                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `M67 the guard counts the players that hold true` (`WHERE NOT placement_eligible` becomes `WHERE placement_eligible`) | the drop stage: it planted two `true` and one `false`, and the refusal must name 1                         |
| `M67 the fence keeps the dropped column in its allowlist` (the list gets the name back)                               | `applying 20261118010000_drop_players_placement_eligible.sql`: the migration's own end-state check refuses |
| `R67 the revert re-adds the column without its default`                                                               | `revert 20261118010000`                                                                                    |

Not planted in `prove.sh` (the sweep is 5.4 hours and the budget is three): the smoke's checks and the pgTAP
assertions are each shown failing by hand, against a database that has a function naming the column, one that
still has the column, and a fence list that grew, and the results are recorded in the build notes.

### The catalogue snapshot

`supabase/catalog-snapshot.json` lists function signatures (not bodies), triggers, policy digests and view column
lists. No signature, trigger, policy or view changes and `view_org_metrics` does not carry the column, so the file
is **not** expected to change; the harness's snapshot stage proves it (`PASS catalog snapshot`).

### The app and the docs

`frontend/src/lib/demo.js` and `tests/demoLib.test.js` as in section 2, plus a CHANGELOG `Removed` entry
(Unreleased), lesson 91 in `docs/LESSONS_LEARNED.md` (after re-reading `main` for the next free number), and the
two dated pointers. No change to `frontend/src` beyond `demo.js`, `packages/core`, `supabase/functions` (so no
Deno run), the mock, the E2E features, or any generated spec.

## 5. Risks and rollback

| Risk                                                   | Mitigation / what is left                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production's fence body is not the one reproduced here | The migration refuses on the md5 and rolls back; the deploy fails and nothing changes. Read 2026-11-03 it is equal.                                 |
| A player holds `false` by merge time                   | The migration refuses (`55000`) and rolls back, naming the count. Nothing is lost in silence. Read 2026-11-03: 0 rows.                              |
| A dependent appears (a hand-applied index, a view)     | Refused by the dependents check; a plain `DROP COLUMN` would have removed an index in silence.                                                      |
| An outside client names the column                     | It gets an error from PostgREST after the deploy. None in this repo; unknown elsewhere, and the column held `true` in every row it could have read. |
| A demo is mid-start when the lock is requested         | It waits for the commit (the migration is milliseconds) or the migration waits for it; both are short, and a deploy that waits can be run again.    |
| The catalogue drift check at the next operator run     | No signature, trigger, policy or view changes; production and the snapshot stay equal.                                                              |
| A later migration re-adds a column of this name        | The fence no longer lists it, so a demo visitor could not edit it: the safe default.                                                                |
| `players` locked or rewritten                          | The drop rewrites nothing (a catalogue change); the revert's `ADD COLUMN ... DEFAULT true` is a constant default, so no rewrite either.             |

**Rollback.** `docs/sql/20261118010000_revert.sql` (harness-applied on a database built to the migration). It
restores the column at its default and the deployed fence body and **does not restore data**; production holds
none, and nothing ever read or wrote the column. Revert the frontend with it (`demo.js` lists the name again);
the order does not matter, since nothing in the app calls `canEditPlayerField` for this column.

## 6. Tasks, each with its test

| #   | Task                                                                                                                 | Test that holds it (and the plant or run that shows it red)                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | This plan, committed first                                                                                           | review                                                                                                                                      |
| 2   | The migration, with its refusals and end-state check                                                                 | the harness build applies it (`applying 20261118010000_...`); `M67 the fence keeps the dropped column in its allowlist`                     |
| 3   | The value guard                                                                                                      | the drop stage plants a `false` row and requires the refusal; `M67 the guard counts the players that hold true`                             |
| 4   | The dependents guard and the md5 guard                                                                               | run by hand against a planted index on the column and a changed fence body: each refuses, naming it (recorded in the build notes); no plant |
| 5   | The revert                                                                                                           | `revert 20261118010000` and its verdict; `R67 the revert re-adds the column without its default`                                            |
| 6   | The smoke: the demo still starts, the fence still passes and refuses the right columns, no function names the column | `smoke 20261118010000`; by hand against a database with a function naming the column, one with the column back, and a fence list that grew  |
| 7   | pgTAP: the column is gone, no function names it, the allowed columns still change, a sibling is still refused        | `demo_sessions.sql` 123 assertions on a scratch cluster with real pgTAP; the same file against the same three defects                       |
| 8   | `demo.js` and `tests/demoLib.test.js`, with the parity test against the SQL list                                     | `tests/demoLib.test.js`; red with the name put back in `demo.js`, and red with a column added to only one side                              |
| 9   | The old smoke's count                                                                                                | `smoke 20260530000000` prints `ok = t` on every row at head (it printed `f` for that row before the edit)                                   |
| 10  | CHANGELOG, lesson 91, the two pointers                                                                               | review; `git diff --check`; the repo's doc and line-ending tests in `npm run test:coverage`                                                 |

## 7. Gates, and what is not run here

The branch is gated locally one heavy command at a time under `flock /home/user/.heavy-gates.lock`: `typecheck`,
ESLint (zero warnings), `check:unused`, `check:advisors`, the full `test:coverage` at the default 5 s timeout, the
full mock E2E (`CI=true --workers=1 --trace off`, no feature changed so no `bddgen`), the frontend build made as CI
makes it and `check:bundle`, the migration harness (`run.sh`), `PLANT_ANCHORS_ONLY=1` over `prove.sh`, the three
plants on their own (in a copy of the tree), the pgTAP file on a scratch PostgreSQL 16 with real pgTAP, and
`git diff --check`. **Not run here:** the full `prove.sh` sweep; `supabase test db` and the CI pgTAP job on the
project's PostgreSQL 17 (the migration reads `pg_attribute`, `pg_depend`, `pg_proc`, `pg_trigger` columns present
from 12 to 17); the real-backend E2E; Deno (nothing under `supabase/functions` changes); the migration against
production (CI applies it on merge).

## Owner notes

- Three siblings from the same migration look dead in the same way: `players.registration_status`,
  `players.experience_years` and `players.buddy_request_name` are named only by `20260530000000`, its smoke and its
  revert (`git grep` over the 2,167 tracked files, _statically reviewed_; their production state, rows and
  dependents were **not** read). They are not touched here; a decision for the same treatment would be its own
  small plan.
- The prod-only `teams_custom_attributes_gin_idx` is left alone, as decided.
- Two Dependabot pull requests (#692, #693) are open; this would be a third open pull request.
