[← Back to Documentation Index](../README.md)

---

> [!NOTE]
> **Implementation Status: PARTIAL** — team import promotion remains v1.1 scope.
> The June 2026 redesign expanded the player finalize mapping (migration
> `20260611000200`): years played, tri-state payment status, waitlist (gated by
> the org's `waitlist` feature flag), Guardian 1/2 → `guardian_contacts` (no
> longer: R0 stopped storing guardians and R4, `20261025010000`, dropped the
> column), and gendered `U{n}B`/`U{n}G` division derivation honoring the org `gender_model`,
> with season-scoped division auto-creation.
>
> The validation and player-promotion slice of the ingestion pipeline has been
> implemented. Key implementation differences from the original design:
>
> - CSV parsing uses **PapaParse** (not `@fast-csv/parse`)
> - Client-side validation is in `ImportContext.jsx`; server-side validation is in the `import-validation` Edge Function
> - Valid player rows are staged in `staging_players` with source row numbers and promoted by `finalize_import_job(uuid, jsonb)` into `players`
> - Player-import coach volunteer rows no longer create interested coach leads (R0 stopped the capture; R4, `20261025010000`, dropped its RPCs and table); reciprocal player-import buddy requests are materialized into `player_buddies`; coach CSV and field-slot CSV imports now have durable validate-only, apply, cancel, and rollback RPC-backed flows, while team promotion remains pending v1.1 follow-up work
> - Header matching uses a strict alias map (not fuzzy `.includes()`)
> - Testing uses **Vitest** (not Jest)
> - File size enforcement (10 MB) is implemented both client-side and via Supabase Storage policy

# Data Ingestion Pipeline Specification

This document expands on the roadmap tasks for importing GotSport registrations and facility availability spreadsheets. It provides a step-by-step plan for implementing resilient ingestion tooling that writes normalized records into Supabase while giving the league administrator quick feedback when files contain issues.

## 1. Registration Import Flow

### 1.1 Upload Interface

- **Entry point**: Admin UI page labelled "Data Import" with an upload drop zone for GotSport CSV exports.
- **Accepted formats**: `.csv` files encoded as UTF-8 with headers; reject Excel files and provide guidance to export as CSV first.
- **Validation prior to upload**:
  - Ensure the file size is below 10 MB (covers ~15k rows comfortably).
  - Confirm the header row contains required columns (`First Name`, `Last Name`, `Division`, `Buddy`, `Coach Volunteer`, etc.).
  - Display a summary of detected divisions and player counts before submission.

### 1.2 Serverless Processing

1. Upload the raw CSV to Supabase Storage under `imports/registrations/<uuid>.csv` with metadata referencing the user id.
2. Invoke the `import-validation` Edge Function with parsed rows and a generated `import_job_id`.
3. Inside the function:
   - Validate and sanitize chunked rows received from the browser.
   - Normalize guardian contacts into a JSON array (`[{ name, email, phone, primary }]`).
   - Build a map of `mutual_buddy_code → [playerIds]` to quickly detect reciprocal pairs.
   - For each row, stage inserts into a staging table `staging_players` that includes the `import_job_id` to handle concurrent jobs, with raw values and validation flags.

### 1.3 Validation Rules

- **Division mapping**: Use the `divisions` table to resolve `division_id`; record a validation error when the division name is unknown.
- **Duplicate detection**: Flag rows where `external_registration_id` already exists for the season.
- **Buddy reciprocity**: Mark buddy codes that appear only once so the admin can review them later.
- **Contact quality**: Require at least one guardian email or phone number.
- **Coach volunteer linkage**: When `Coach Volunteer = yes`, resolve guardian/parent contact fields and create or reuse a `coaches` row with status `interested`; link the lead to the org-scoped division/player when those ids can be resolved.

### 1.4 Commit Phase

1. If rows fail validation, keep row errors in `import_jobs.error_summary` and finish as `completed_with_warnings` when at least one valid player row is promoted.
2. When validation completes:
   - Call `finalize_import_job(import_job_id, validation_errors)` to promote staged player rows into `players` in one transaction.
   - An import goes to the organization's active season (`import_jobs.season_settings_id`, fixed when the job is made; `create_import_job` and the finalizers refuse a draft or completed season, 22023, because a player belongs to the organization and an import elsewhere would move a live-season player; per-season enrolment is Phase E3).
   - Use GotSport/external registration id as the preferred player match key. Rows without an external id are still promoted once per import job.
   - Mark promoted staging rows with `promoted_at` / `promoted_by` so re-running finalization for the same job does not duplicate players.
   - Store promotion counts in `import_jobs.warning_summary.finalize` and mark the import job `completed` or `completed_with_warnings`.
3. For player imports, call `materialize_import_buddy_pairs` after finalization. The RPC creates mutual directional `player_buddies` rows only when imported players reciprocally reference each other by external registration id or share an exactly two-player mutual buddy code; unmatched, self, non-reciprocal, and cross-division requests are preserved as warning metadata.
4. (Removed.) Player imports no longer capture coach leads: `upsert_coach_leads` and its table were dropped by `20261025010000`; the player's `willing_to_coach` flag is the coaching lead.
5. Coach CSV and field-slot imports use dedicated validate-only, apply, cancel, and rollback RPCs backed by `staging_import_rows`, `import_jobs.warning_summary.deferred_apply`, and `import_application_records`.
6. Chunked validation writes `last_heartbeat_at`, `processed_rows`, and `progress_percent`; `/import` calls `fail_stale_import_jobs` before rehydrating active work so interrupted browser-driven imports fail cleanly for retry.
7. Pending follow-up: team creation.

### 1.4.1 Production RPC Readiness Check

Browser-driven imports depend on PostgREST exposing the import lifecycle RPCs.
If production shows errors such as `Could not find the function
public.create_import_job(...)`, verify that these migrations have been applied
in order:

```text
supabase/migrations/20260502000000_import_finalize_pipeline.sql
supabase/migrations/20260503000000_secure_coach_lead_scoping.sql
supabase/migrations/20260503080000_player_import_buddy_materialization.sql
supabase/migrations/20260503090000_import_deferred_apply_status.sql
supabase/migrations/20260503100000_import_stale_job_cleanup.sql
supabase/migrations/20260504080000_import_job_lifecycle_rpcs.sql
```

The migrations above must be applied in chronological order. The deferred-apply
status migration (`20260503090000`) must precede the lifecycle RPC migration
(`20260504080000`) because `create_import_job`, `update_import_job_progress`,
`fail_import_job`, `mark_import_job_ready_to_apply`, and `cancel_ready_import_job`
insert or update `import_jobs.status` values including `importing`,
`ready_to_apply`, and `failed`. Finalization (`finalize_import_job`) and buddy
materialization (`materialize_import_buddy_pairs`) come from the earlier
`20260502000000` and `20260503080000` migrations and must also be present before
a player import can finish. (The coach-lead RPCs from `20260503000000` were
dropped by `20261025010000`.)

Run this SQL against the target Supabase database to confirm every import
lifecycle RPC signature is present (each row should report `present = true`):

```sql
select fn, to_regprocedure('public.' || fn) is not null as present
from unnest(array[
  'fail_stale_import_jobs(uuid,timestamptz)',
  'create_import_job(uuid,text,text,uuid)',
  'update_import_job_progress(uuid,integer,integer,integer,jsonb)',
  'mark_import_job_ready_to_apply(uuid,text,jsonb)',
  'cancel_ready_import_job(uuid,text)',
  'fail_import_job(uuid,text,jsonb)',
  'finalize_import_job(uuid,jsonb)',
  'materialize_import_buddy_pairs(uuid)'
]) as fn
order by fn;
```

After applying missing migrations, reload the PostgREST schema cache so RPC
discovery sees the new functions:

```sql
notify pgrst, 'reload schema';
```

**Deployment order (prevents recurrence).** Apply the import lifecycle
migrations _before_ deploying any frontend bundle that calls these RPCs —
otherwise the browser issues `POST /rest/v1/rpc/create_import_job` against a
database that has not yet defined it and PostgREST returns
`404 Could not find public.create_import_job(...) in the schema cache`.

- **Preferred:** run `supabase db push --linked` against the production project
  before the Vercel frontend deploy, then confirm with the readiness query above.
- **Emergency (SQL Editor):** paste the full migration files listed above in
  chronological order, then run `notify pgrst, 'reload schema';`.
- **Migration history:** if you applied SQL by hand, only run
  `supabase migration repair --status applied <version>` _after_ the readiness
  query confirms the functions actually exist — repairing history first records
  migrations as applied when they are not.

### 1.5 Notifications & Audit

- Emit Supabase channel events so the UI can display progress (`uploading → processing → completed`).
- Record heartbeat timestamps while validating chunks so ghost imports older than the stale cutoff can be failed and retried.
- Store a summary JSON payload per job with metrics: number of players inserted, duplicates skipped, buddy pairs confirmed, and orphan requests.
- Retain the raw CSV for 30 days; schedule a cleanup edge function to purge older files.

## 2. Field Availability Import Flow

### 2.1 Template Expectations

- Provide a downloadable CSV template with columns: `Location`, `Field`, `Subunit`, `Day`, `Start`, `End`, `Type`, `Capacity`, `Valid From`, `Valid Until`, and an optional `Division` (D2, migration `20261029010000`): a practice slot whose row names a division of the season is reserved to it (an unknown name fails the row); blank leaves it open, and a re-import with it blank keeps a reservation already set.
- Accept multiple rows per field to represent early/late season durations or split fields.
- Validate that `Type` is either `practice` or `game`; other values trigger a friendly error.

### 2.2 Processing Steps

1. Store the uploaded CSV under `imports/fields/<uuid>.csv` and create an `import_job` record.
2. Parse each row, normalizing times into ISO strings and converting `Capacity` to integers.
3. Upsert `locations` and `fields` using case-insensitive matching to avoid duplicates caused by inconsistent capitalization.
4. For rows with subunits, ensure a `field_subunits` entry exists (`field_id`, `label`).
5. Insert or update `practice_slots` or `game_slots` depending on the `Type` column. For practice slots, split rows when `Valid Until` is earlier than the season end to support daylight adjustments automatically.
6. Wrap inserts in a transaction so partially failing files roll back cleanly.

### 2.3 Validation Rules

- Reject a practice slot that overlaps, or starts less than 15 minutes from, another on the same bookable surface (the same subunit; a whole field clashes with each of its subunits, two subunits never with each other), on the same weekday, whose effective windows share that weekday (`finalize_field_import_job` through `practice_slot_conflicts`, migration `20261029010000`). The row fails with `reason: practice_slot_conflict` before anything it names is written. Game slots are not judged.
- Ensure `Capacity` is at least 1; default to 1 if blank.
- Verify that `Valid From` and `Valid Until` fall within the active season defined in `season_settings`.
- Provide warnings (not failures) when a field lacks lighting but the slot ends after sunset—use seasonal sunset heuristics from configuration.

### 2.4 Reporting & Feedback

- Summarize the number of practice vs. game slots inserted, updated, and skipped.
- Highlight fields missing subunits even though related divisions expect them.
- Update the `import_jobs` record with status (`ready_to_apply`, `completed`, `completed_with_warnings`, `needs_fix`, or `failed` for canceled staged imports) plus downloadable CSVs for warnings and errors.

### 2.5 Practice Schedule Import (pure core only; 2026-11-06)

An organization that already has a practice schedule will be able to bring it in as one flat CSV, one row per timed cell, open slots included (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11, which PR 1 adds). PR 9 adds only the pure core (`packages/core/src/practiceImport/`) and a placeholder fixture (`fixtures/practice-schedule-2026/`); nothing is imported yet: the database writer is PR 10, the Edge validation and the Practices tab are PR 11. The columns: `Team` (blank is an open slot), `Division` (the team's division, required when `Team` is set; unlike the fields CSV's `Division` it reserves nothing), `Day` (`Mon` to `Sun` or the full name), `Start`, `End` or `Length`, `Location` (`Venue`), `Field`, `Subunit` (`Half`, `Side`; blank is the whole field), `Valid From` and `Valid Until` (else the confirm step's two dates, else the season's), `Capacity` (default 1) and `Use` (blank or `hold`: a held cell makes no slot and is only listed). Any other column is dropped before staging and never stored. A row that cannot be read or stored is listed with its reason and the rest imports, and that includes a slot that overlaps another slot of the same file (the one a team is placed in is kept); conflicts with the schedule's rules (a team in two places, a full cell, a team over its count) are accepted and flagged, never refused (PR 10). An optional alias CSV (`Alias`, `Location`, `Field`, `Subunit`) and the previous import's mapping only propose, and nothing is applied without the admin. The Edge function's header alias map takes the names shared with the fields CSV (and `Division` as `division_name`) but not `Half`, `Side`, `Length`, `Team` or `Use`: PR 11 adds what it needs.

### 2.6 Games Import (the database, 2026-11-09; the Edge function and the panel, 2026-11-10)

An organization that already has a game schedule brings it in as a file (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.5 to 4.7 and the F11 plan `docs/changes/2026-11-06-games-table-source-of-truth.md`; migration `20261121010000_game_import.sql`). PR 5 is the database and the mock: the Edge validation (`import-validation`, which stages the rows) and the Games page that drives it are PR 6, so nothing in the product stages a games job yet. The type is `games`, through every list the pipeline keeps (the job-type and staged-row CHECKs, `create_import_job`, the deferred-apply pair, `import_allowed_keys`, the application records' type and target tables), found from the catalogue by `tests/gameImportPipelineLists.test.js`.

1. **Stage.** Each staged row is the parse's row on the season's clock (`toStagedGameRow`, `packages/core/src/scheduleImport/staging.js`); a row the parse refused is staged with no payload and its reason.
2. **Map.** `map_game_import_job(job, mapping)` stores the admin's decisions (map to a record, create, skip, or, for a team, an outside club) on the job; it refuses a decision naming another organization's or another season's record. The mapping is the sole input of the apply, so storing it is audited: one `import.mapped` row carrying the number of decisions per group and action and the Published default (no label of the file).
3. **Preview.** `apply_game_import_job(job, true)` is the apply with its writes off: the same plan code, so on the same state its counts are the apply's (lesson 74); it writes nothing, anywhere. **The apply plans again against the state it finds.** Another admin can publish, cancel or move a game between the preview and the apply, so the apply's counts can differ from the preview's, and its result reports what was done, not what was previewed. (Having the apply refuse when its counts differ from the ones the admin confirmed is a change to the RPC's signature, proposed for PR 6.)
4. **Apply.** One transaction. A game found by (season, Game ID) is **updated in place by its id**, whether its row is in the visible run or hidden in an older one; a row with a Game ID is never matched by its tuple and never inserted a second time; a row with no Game ID matches on (home, away, slot, week). A game that `game_is_held` says is held (Published) and whose row changed is **skipped** and reported `skipped-published`, never written. New games arrive Published when the job says so. When anything is written ONE new game run is made and holds the whole schedule (the previous run's games, and the hidden games the file found, are carried into it); when nothing would change, no run is made. Team shells go through the team writer in ONE team run, in the shape the pages read: the latest completed team run's results are carried forward whole (every key, every division it names) and each division's shells are added to its group of `teamsByDivision`, with `teams` and `team_players` beside it (`TEAM_RUN_RESULT_KEYS`, `packages/core/src/utils/teamRunResults.js`; the Teams, Practices and Games pages read the LATEST team run, so a run of only the new shells, or one run per division, would list no other team); outside clubs are inserted by the apply in no run. **A TIME TBD game holds a date and no time** (`schedule_tbd.game_date`) **and its Game ID** (`schedule_tbd.external_ref`, unique per season): a row is found by (season, Game ID) first, then by (home, away, week) among the rows with no Game ID of their own, and changed in place; a game the file now places is written and its TIME TBD row removed; a placed game the file now gives no time is converted (removed, a dated TIME TBD row written, warning `game-made-time-tbd`) unless it is held, in which case the row is skipped as `skipped-published`; another TIME TBD game on the same (home, away, week) is a different game and the row is refused. **Swaps are warnings**: a game moved onto a place another game of the same file moves away from is written, with the warning `games-swapped`, after the apply takes the leaving games out of the unique place (as `persist_game_schedule` does); a place held by a game the file does not move still refuses the row. Names are compared as core compares them (`normalise_external_label`: trim, collapse whitespace, lower-case). A file that conflicts with itself or the schedule is stored and flagged (a field or a team in two games at once, plus the file's own flags); the coach overlap and the hosting balance are the preview's audit, and the result says so in `not_judged`.
   **One saved record, one row of the file.** A Game ID a matched record already carries is never erased by a row that omits it: a TIME TBD game with a Game ID that a row with no Game ID places (found by its teams and week) becomes a placed game with that Game ID; a placed game or a TIME TBD game changed in place by such a row keeps its own. Two rows of one file that resolve to one saved record (one by its Game ID, one by its teams, place and week; or one that changes a game and one that gives it no time) are a plan the apply cannot execute: the row that carries the Game ID is kept (then the earlier row), the other is refused `duplicate-row` in words that say two rows name one saved game, in the preview and the apply alike, and the plan ends with a check that no saved record is named twice. Two rows that would both place one TIME TBD game are not a refusal: one becomes that game and the other is a new game.
5. **Roll back.** `rollback_game_import_job(job)` compares EVERY record it undoes with what stands now, before it writes anything (the apply's own writes are not the only ones: another import, a save or an admin may have touched the row since). **It refuses** (22023, `game_import_changed`) if a placed game the import wrote has been changed, cancelled, had changes allowed or been saved into a later run, or if a TIME TBD game it wrote is gone or no longer equal to what the apply left (an inserted or changed one) or is back (a removed one), compared with the stored application record. The DETAIL is `game_import_changed count=<n> ids=<placed game ids> [tbd_ids=<TIME TBD game ids>]`: `count` is both kinds, `ids` lists up to 50 placed games (it is present and may be empty), `tbd_ids` lists up to 50 TIME TBD games and is present only when one is named, so a reader of the first two keys is unchanged. It is a refusal and not a warning because it is the one place a rollback would destroy another import's or an admin's work (the owner's rule is warnings over blockers except where necessary); the way forward is to roll the later change back first (a TIME TBD game a later import corrected is put back as the first import wrote it, and then the first can be rolled back). A TIME TBD game a later row of the table now holds the place of (the same home, away and week, or the same Game ID) is not a refusal: that row is someone else's, and the rollback counts the row it cannot put back (`time_tbd_not_reinserted`). **Otherwise** it deletes what the import inserted, puts back what it updated (a swapped pair is taken out of the unique place first; through the Published guard's rollback exemption, which is a comparison with that record and not a role), stands up again the games the apply took out and the TIME TBD rows it removed, puts back the TIME TBD rows it changed, and removes the slots, clubs, shells, fields, venues and divisions it created **when nothing else references them and nobody has changed them since** (a rename, an address, a coach: the row no longer equals what the apply stored). What an admin attached afterwards keeps its record: a field or venue with a permit scope, a blackout or a subunit, a division with a TIME TBD row, a shell a later team run names, and any of those rows an admin edited are kept and reported in `kept`; so is a run of the import that something else still names (a game saved into it, an evaluation of it), as `{table: 'scheduler_runs', id}`. The pgTAP file `game_import_rollback_class.sql` derives the (table, operation) pairs the apply can write from the apply's source, requires one real apply to write them all, and fails unless, for every pair, a later writer's change makes the rollback refuse or keep the record without losing what that writer did; `game_import_apply_rollback.sql` derives from the catalogue every foreign key that cascades or sets null onto the eight tables the rollback deletes from and fails unless every DELETE of each guards it or it is on a short, argued list. **A run that stays is history, never the current schedule:** it is retired (`status = 'failed'`, `parameters.rolled_back = true`), because the game readers take the latest `completed` game run and the team reader the latest `completed` or `running` team run, and the games are back in the runs they were in; a game a later writer saved into the import's own run therefore stays in a retired run (hidden, as a game of any older run is, until a save or an import by its Game ID brings it into the current one). A team run that stays because it carries a kept shell is not retired (it is the only run that lists that shell), and every kept team run has the shells that are gone taken out of what it lists. The class file runs the readers' own selection after every scenario. One edge is not judged and stays a database error that undoes the whole call (nothing is lost): putting back a game the apply took out when a game of the same two teams, week and slot, or the same Game ID, now stands in its place.

**Not in the SQL, by design.** The preview does not go stale-proof in the database: the apply plans again against the state it finds. The confirm is made stale-proof in the Edge function (below, PR 6).

**The Edge function and the panel (PR 6; no migration).**

- **The file is read by `import-validation`, `import_type: 'games'`.** Its own request shape: the header row travels with every chunk (the allowlist is by header name; a games file has no alias map), a chunk is at most 500 rows, a file at most 2,400, counted from `row_offset`. Only the columns of the template are read (`Game ID`, `Date`, `Start Time`, `End Time` or `Length`, `Venue`, `Field`, `Division`, `Home Team`, `Away Team`, `Week`); every other column is dropped before a value is read from it and is neither staged nor returned. The season, and so the clock and the window, is the JOB's (`season_settings.timezone`, `season_start`, `season_end`), never the request's. The function cannot import `packages/core`, so it runs a mirror, `supabase/functions/_shared/schedule-import.ts`, held to core by one table of vectors (`_shared/tests/fixtures/schedule-import.vectors.json`, generated by `scripts/generate-schedule-import-vectors.mjs`) that both a Deno test and `tests/gameImportEdgeParity.test.js` run, the second under three other host zones. The first chunk (`row_offset` 0) replaces everything the job had staged. A repeat that straddles two chunks is refused by the apply, which judges every staged row together.
- **A time or a week the import cannot read keeps the row (owner, 2026-11-10).** A malformed time (`25:00`, `noon`, a Length of `60 min`, an End Time and a Length that disagree, a game that would pass midnight) makes the game a dated TIME TBD game with the warning `bad-time`; a Week that cannot be stored (`three`, `0`, past 255) is derived from the date with the warning `bad-week`. Both warnings are said at the upload and in the preview and are NOT staged (the apply's staged-flag list is closed: `time-ambiguous`, `week-differs`), so the saved result does not carry them. Still refused: a date outside the season, a bad date, an end not after its start, a time the clocks skip, and a bad Week with no season start date to derive from (`missing-week`).
- **Mapping.** The panel reads back the rows the function staged and shows THOSE (never its own reading of the file). A label that matches exactly one record opens on "use existing"; a label with no match opens undecided, and its rows are listed as not imported until the admin says what it is. Only the decisions stored on the job are in effect: the database guesses nothing, so a match the admin turned down is unknown, not matched for them.
- **The confirm cannot apply a stale preview.** The confirm sends the counts the admin saw (`scheduleImportConfirmCounts`, the one list: the rows, the games and TIME TBD games added, changed and unchanged, the skips by reason, everything created, the games not in the file, the warnings by type, and the two flags). `import-validation` (`action: 'apply'`) runs the dry run again as the caller and, when any count differs, answers 409 `game_import_preview_stale` with both sets of counts and the fresh preview, and writes nothing. Declared: the re-run and the apply are two statements, so a change in the milliseconds between them is not seen; the apply then plans against what it finds and says what it did. `apply_game_import_job` itself is still callable directly by an admin; the panel never does.
- **Nothing is created without the confirm list.** The preview lists every division, venue, field, team and outside club the import will create, by name and count, and the confirm is held until that list is ticked.
- **Not checked by the import (declared on the preview):** coach overlap, hosting balance, shared space, travel time between fields. Checked: a field with two games at once, a team with two games at once.
- **A TIME TBD game's date is shown with no time** on the Games page (a "TIME TBD games" list, read from `schedule_tbd`), in the master export's Notes (`Game not scheduled (week N, on DATE): ...`; the Start cell stays `TIME TBD`, the token every reader of that file keys on) and under its date in the Day Sheet. `get_schedule_tbd` does not return `game_date`, so the client reads the column from the table (admins may select it) and joins it on by row id.
- **The schedule CSV.** The panel downloads the saved schedule in the template's columns; a file exported here imports here with no change (`tests/gameImportRoundTrip.test.jsx`).
- **A row that cannot be a game is refused as a row, at staging.** A blank Division, Home Team or Away Team, and a time and a field with no Venue, are `unknown-division`, `unknown-team` and `unknown-venue` (the words the mapping step uses for the same blank). Staged as accepted rows they failed the apply's shape check, which refuses the whole job (`game_import_staged_invalid`). `tests/gameImportStaging.test.js` blanks every column the shape check reads, every way a cell can be blank, and requires that every row either staging accepts passes a twin of that check.
- **A value is read by the header as the file wrote it.** `Start Time ` (a trailing space), a no-break space, another case and a byte order mark all name their column; two headers that clean to one name refuse the file (`duplicate-column`).
- **One organization and season.** The panel's workflow is keyed by the header's organization and season: switching either discards the staged file, the preview, the pending confirm and the result with its roll back, and the roll back call refuses a job of a scope that is not on screen.
- **The schedule CSV writes a game's own start and end** (`game_assignments.start`, `"end"`) on the season's clock. A game keeps its own end when an import reuses a slot by its start, so the slot's end is not the game's.
- **A staged import that is left does not wait forever.** A staged games job is `ready_to_apply`, which the stale-job sweep does not fail and the Import page's own job screen leaves alone. The panel discards it (`cancel_ready_import_job`: the job is marked `failed`, audited `import.canceled`; its staged rows stay with the failed job) when the admin cancels, picks another import tile or switches organization or season; a job left by a closed tab is listed on the upload step under "Unfinished imports" with "Discard it". There is no resume.
- **The file:** at most 10 MB (the Import page's one limit); a column the import reads that appears twice refuses the file, also when the CSV reader renamed the repeat.
- **Not built here:** recording an import as a publication baseline (task G5, deferred to PR 6b of the plan): a baseline is the master export's rows, and the import panel does not make that file. The Exports page still records one.

**Retention.** Staged games rows are not on a retention job. The jobs that delete a finished job's staged rows after 30 days (`cleanup-staging-import-rows` for coaches and practice preferences, `cleanup-staging-evaluation-rows`) exist because those rows hold a person's data (an email, a registration id); a staged games row holds venue, field, division and team labels, Game IDs, dates and times, and the allowlist keeps no name of a person, email or contact, as the staged rows of the fields types do not. `tests/gameImportPipelineLists.test.js` reads the latest body of every retention job and fails for an import type that is neither covered nor exempt with a reason.

`ensure_game_slot` creates the slot a game needs at a field, date and time, or finds it, audited `game.slot_created` on creation only. The reasons a row is skipped are a closed list (`SCHEDULE_IMPORT_SKIP_REASONS`, with words; a test fails when a reason has no words). Every game an import writes carries its season (`game_assignments.season_settings_id`), and `view_league_standings` is left alone (F11-2).

## 3. Error Handling & Observability

- Centralize error codes so the UI can translate them into actionable tips (e.g., `UNKNOWN_DIVISION`, `OVERLAPPING_SLOT`).
- Send structured logs to Supabase Logflare (if enabled) with correlation ids derived from `import_job_id`.
- Track processing latency and row throughput metrics; alert when ingestion takes longer than a configured threshold (e.g., 2 minutes).

## 4. Security & Access Control

- Require admin authentication before allowing uploads.
- Scope Supabase Storage buckets with RLS policies so only admin users can read imported files.
- Ensure Edge Functions validate JWTs and confirm the requesting user is an admin or tenant admin for the target organization before starting work.

## 5. Next Implementation Tasks

- Add a team CSV promotion path.
- Add duplicate and unknown-division operator review surfaces beyond the current warning metadata.
