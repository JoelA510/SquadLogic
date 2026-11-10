-- The games import, database half: a schedule already made is staged, mapped, previewed, applied and rolled back (PR 5).
--
-- Plan of record: docs/changes/2026-11-03-schedule-expansion.md, 4.5 to 4.7 and task E1 of PR 5, and the F11 plan
-- docs/changes/2026-11-06-games-table-source-of-truth.md, "What PR 5, and the other pull requests, must do or avoid"
-- (the owner approved both; the hold was lifted on 2026-11-06). AGENTS.md rule 14 applies (persistence and the domain
-- model): this change is the plan's migration for it. Nothing in the solver changes; the Edge function `import-validation`
-- and the Import panel are PR 6.
--
-- ## What this adds
--
--   * (fix round 2) `schedule_tbd.external_ref` and `schedule_tbd.game_date` (a TIME TBD game's Game ID and DATE, with a shape
--     check and a per-season unique index), `normalise_external_label(text)` (core's label comparison, internal), and the
--     application record's `operation` gains `deleted`;
--   * (fix round 3) `game_import_row_unchanged(jsonb, jsonb)` (internal): the rollback's comparison of a row with the image the
--     apply stored, for the TIME TBD games and for everything the import created; see section 8.
--   * `game_assignments.external_ref` (the Game ID: text, at most 40 characters, no space at either end, never empty) and
--     `game_assignments.import_job_id` (the job that wrote the row; ON DELETE SET NULL). A unique index on
--     (season_settings_id, external_ref) for the rows that have a Game ID: PER SEASON (F11 decision D6 and the owner's
--     answer of 2026-11-09), never per organization and never across seasons. `season_settings_id` is F11-1's column and
--     is set on every row the import writes.
--   * `teams.is_external boolean NOT NULL DEFAULT false`: an outside club, one row per (division, club label), a legal
--     side of a game and nothing else. Every reader of `teams` is classified by tests/externalTeamReaders.test.js; the two
--     SQL readers that list teams (`view_org_metrics.total_teams` and `sync_schedule_tbd_practices`) exclude it here.
--   * The import type `games` through every list the pipeline keeps (plan 4.10; tests/gameImportPipelineLists.test.js
--     enumerates them from the catalogue): `import_jobs.job_type`, `staging_import_rows.import_type`,
--     `import_application_records.import_type` and `.target_table` (gains `game_assignments`, `teams`, `divisions` and
--     `schedule_tbd`), `create_import_job`, the deferred-apply pair and `import_allowed_keys`.
--   * `schedule_tbd` accepts the game reason `imported-without-time` (a file row with no time or no field is a TIME TBD
--     game, never dropped).
--   * `ensure_game_slot` (admin RPC, audited `game.slot_created` on creation only), `map_game_import_job`,
--     `apply_game_import_job(job, dry_run)` and `rollback_game_import_job`.
--   * The Published guard honours a rollback (3.3, 4.7): see the guard's own comment.
--
-- ## The apply, in one paragraph
--
-- It reads the staged rows (each a row of the file, already put on the season's clock by the Edge function: this SQL never
-- recomputes an instant), resolves every label through the decisions the admin confirmed (`map_game_import_job`), and
-- plans EVERYTHING in temporary tables before it writes anything: a dry run is the same code path with the writes off,
-- so on the same state the preview's counts are the apply's (lesson 74), and an apply that writes a different number than
-- it planned raises. **The apply plans again, against the state it finds**: another admin can publish, cancel or move a
-- game between the preview and the apply, so its counts can differ from the preview's, and its result reports what was
-- done, not what was previewed. (Making the apply refuse when its counts differ from the confirmed ones is a change to
-- the RPC's signature, proposed for PR 6 and not made here.) A game found by (season, Game ID) is updated IN PLACE by its id whether its row is in the visible
-- run or hidden in an older one; a row with a Game ID is never matched by its tuple and never inserted a second time; a
-- held game (`game_is_held`, F11-1's one predicate) whose row changed is `skipped-published`, not written; a row with no
-- Game ID matches on (home, away, slot, week), as the save does. New games arrive Published when the job says so
-- (decision 4). When anything is written, ONE new game run is made and holds the whole schedule: every game of the
-- previous latest run is carried into it (a run change, which the guard allows), and so is every hidden game the file
-- found. When nothing would change (a re-import) no run is made and nothing is written. Team shells go through the
-- existing audited team writer in ONE team run, in the shape the pages read (the latest completed run's results carried
-- forward whole, `teamsByDivision`, `teams` and `team_players` among them, with the shells added to their divisions: the
-- pages read the latest team run, so a run of only the new shells would make every other team look absent);
-- outside clubs are inserted here, in no team run. The conflict flags are two checks the SQL can judge from the stored
-- games (a field and a team in two games at once) plus the flags the file carried; the coach overlap and the hosting
-- balance are the preview's audit (the result says so in `not_judged`).
--
-- **Swaps are warnings, not blockers** (the owner, 2026-11-09). A game moved onto a place another game of THE SAME FILE
-- moves away from (two games of one pair in one week that swap times, a chain of moves, a new game on a place a game
-- leaves) is written, with the warning `games-swapped` in the preview and the result. The place is unique and not
-- deferrable, so the apply takes a game that leaves a place another row is about to take out of the unique place first (its
-- slot set null, as `persist_game_schedule` does since 20261120010000) and gives it its place in the same transaction; the
-- rollback does the same. A place is judged only against the games the file does NOT move: a row whose place is held by one
-- of those is refused (`duplicate-row`: a genuine clash), a held game is never moved, and a game moving onto its place is
-- refused too. A row that cannot be written is not counted among the movers, and the rows that depended on it are judged
-- again until none changes.
--
-- **A TIME TBD game holds a date and no time, and is found by its Game ID** (the owner, 2026-11-09, and Codex). `schedule_tbd`
-- gains `external_ref` (the Game ID, unique per season) and `game_date`. A row is found by (season, Game ID) first, then, for a
-- row with no Game ID or a Game ID no TIME TBD game carries yet, by (home, away, week) among the rows with no Game ID of their
-- own; it is changed in place (the date and week it now holds, the reason `imported-without-time`), or inserted when none is
-- found. A game the file places that stood on the TIME TBD list is written and the list's row removed; a placed game the file
-- now gives no time is converted (the game removed, a dated TIME TBD row written, the warning `game-made-time-tbd`) unless it
-- is held, in which case the row is skipped as `skipped-published`. Another TIME TBD game that already holds the tuple a
-- row would stand on is a different game: the row is refused (`duplicate-row`), because the table is unique on it. Every
-- change has an application record with the image it had (`operation` gains `deleted`), and the rollback puts it all back.
--
-- **Labels are compared as core compares them**: `normalise_external_label` (trim, collapse every run of whitespace,
-- lower-case) is core's `normaliseExternalLabel` in SQL, and every comparison of a name the apply would create with a name that
-- exists, and every coalescing of two labels that create one record, goes through it.
--
-- ## The rollback
--
-- It refuses, naming up to 50 games, if any game the import wrote has been changed, cancelled, had changes allowed or
-- been saved into a later run since (compared with the stored application record), or a game it took out stands again.
-- Otherwise it deletes what the import inserted and puts back what it updated (a swapped pair is taken out of the unique
-- place first, as the apply took it), through the guard's rollback exemption, stands up again the games the apply took out
-- and the TIME TBD rows it removed, puts back the TIME TBD rows it changed, removes the slots, clubs, shells, fields, venues
-- and divisions it created when nothing else references them, and removes its runs.
--
-- ## Cost, said plainly
--
-- Six functions and a view are replaced WHOLE (a migration cannot patch a function), each copied from the migration that
-- defines it last and behind the md5 of that text, so a body this migration has not seen refuses to be replaced
-- (lesson 87). The plants that aimed at the guard's old body in 20261120010000 (two) and at the evaluations
-- migration's lifecycle bodies (one) are re-aimed in scripts/dbharness/prove.sh (lesson 70).
-- `persist_practice_schedule` is NOT replaced although it reads `teams`: its result lists "teams without a practice"
-- from the season's roster, which would name an outside club of a division that gives practices. The census classes it
-- `pending` and the PR reports it (a 1,200-line replacement and twenty-one plants for a display count).
-- `persist_game_schedule` is NOT replaced either: an imported TIME TBD game stays listed until the next save that carries
-- an `unscheduled` list, which replaces the game list as it always has (reported).
--
-- Reversible: docs/sql/20261121010000_revert.sql. Smoke: docs/sql/20261121010000_smoke.sql. pgTAP:
-- supabase/tests/game_import_apply_rollback.sql (CI's). No data is read or changed by the migration itself.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration replaces are the ones it was written against.
-- ---------------------------------------------------------------------------

DO $guard$
DECLARE
    v_spec record;
    v_md5 text;
BEGIN
    -- Carriage returns stripped, as the other guards do: the text is what matters.
    FOR v_spec IN
        SELECT * FROM (VALUES
            ('public.create_import_job(uuid, text, text, uuid)',           '20db2a04e3e56b5a862e917375d0454c'),
            ('public.import_allowed_keys(text)',                           'a1106199ce396e8dbf30cd580a7e3366'),
            ('public.mark_import_job_ready_to_apply(uuid, text, jsonb)',   'b3f92d86ad67daf8986eb135c785615c'),
            ('public.cancel_ready_import_job(uuid, text)',                 'e9b189212ddbe0e0a7778b7669e9afe5'),
            ('public.game_assignments_published_guard()',                  '2ffcfb1f9651757594b63d273cd65206'),
            ('public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb)', 'c6211cf83fda00b75d53e799379f0312')
        ) AS s(signature, expected_md5)
    LOOP
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure(v_spec.signature);
        IF v_md5 IS DISTINCT FROM v_spec.expected_md5 THEN
            RAISE EXCEPTION '% has a body this migration has not seen (md5 %): not replacing it',
                v_spec.signature, v_md5 USING ERRCODE = '55000';
        END IF;
    END LOOP;
END;
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Columns, keys and lists.
-- ---------------------------------------------------------------------------

-- An outside club: a team row of an opponent that is not the organization's own.
ALTER TABLE public.teams
    ADD COLUMN IF NOT EXISTS is_external boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.teams.is_external IS
    'An outside club (20261121010000): a side of imported games, one row per division and club label. It has no players, no coach and no practice and is in no team run; every list of teams excludes it (tests/externalTeamReaders.test.js classifies each reader). false for every team the organization formed.';

-- The Game ID and the job that wrote a game.
ALTER TABLE public.game_assignments
    ADD COLUMN IF NOT EXISTS external_ref text,
    ADD COLUMN IF NOT EXISTS import_job_id uuid REFERENCES public.import_jobs(id) ON DELETE SET NULL;

-- The Game ID is text of at most 40 characters with no space at either end and never empty: the apply trims what the
-- file gave and compares exactly, so the column holds what was compared. NOT VALID is not used: the column is new.
ALTER TABLE public.game_assignments
    ADD CONSTRAINT game_assignments_external_ref_shape
    CHECK (external_ref IS NULL OR (char_length(external_ref) BETWEEN 1 AND 40 AND external_ref = btrim(external_ref)));

-- Unique PER SEASON, for the rows that have one. A platform's Game IDs are specific to each game and not reused (the
-- owner, 2026-11-09), and the index is safe either way: a Game ID may stand in two seasons.
CREATE UNIQUE INDEX IF NOT EXISTS game_assignments_season_external_ref_key
    ON public.game_assignments (season_settings_id, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_game_assignments_import_job_id
    ON public.game_assignments (import_job_id)
    WHERE import_job_id IS NOT NULL;

COMMENT ON COLUMN public.game_assignments.external_ref IS
    'The Game ID a schedule import carried (20261121010000): at most 40 characters, exact after trimming, unique per season (season_settings_id), NULL for a game generated here or imported without one. A re-import updates the game found by it in place.';
COMMENT ON COLUMN public.game_assignments.import_job_id IS
    'The games import job that last wrote this row (inserted it, or changed it in place); NULL for a game no import wrote. The Published guard''s rollback exemption is for the rows of the job it names.';

-- The import type and job type, and what an application record may name.
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_job_type_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_job_type_check
    CHECK (job_type IN ('registration', 'fields', 'field_availability', 'manual', 'evaluations', 'games'));

ALTER TABLE public.staging_import_rows DROP CONSTRAINT IF EXISTS staging_import_rows_import_type_check;
ALTER TABLE public.staging_import_rows ADD CONSTRAINT staging_import_rows_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations', 'games'));

ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_import_type_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'games'));

ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_target_table_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_target_table_check
    CHECK (target_table IN (
        'coaches', 'fields', 'field_subunits', 'locations', 'practice_slots', 'game_slots',
        'field_availability_profiles', 'field_availability_profile_formats', 'field_blackout_windows',
        'field_equipment_requirements', 'field_availability_scenarios', 'field_availability_scenario_members',
        'game_assignments', 'teams', 'divisions', 'schedule_tbd'));

-- A TIME TBD game may carry the import's reason. The practice arm and the other game reasons are as 20261108020000 left them.
ALTER TABLE public.schedule_tbd DROP CONSTRAINT IF EXISTS schedule_tbd_reason_check;
ALTER TABLE public.schedule_tbd ADD CONSTRAINT schedule_tbd_reason_check CHECK (
    (kind = 'practice' AND reason IN ('no-slot-available', 'no-live-date', 'coach-preference', 'practice-length', 'not-enough-days', 'not-scheduled-yet'))
    OR (kind = 'game' AND reason IN ('unknown-team', 'division-mismatch', 'duplicate-matchup', 'coach-coaches-both-teams', 'coach-scheduling-conflict', 'no-slot-available', 'imported-without-time')));

-- A TIME TBD game keeps what the file gave: its Game ID (so a re-import finds the game by it, as it finds a placed game)
-- and its DATE (a game with no time still has a day). NULL for every row the solver or the practice sync wrote and for a
-- row the file gave no Game ID. The Game ID is unique per season, for the rows that have one, as a placed game's is.
ALTER TABLE public.schedule_tbd
    ADD COLUMN IF NOT EXISTS external_ref text,
    ADD COLUMN IF NOT EXISTS game_date date;
ALTER TABLE public.schedule_tbd
    ADD CONSTRAINT schedule_tbd_import_fields
    CHECK ((external_ref IS NULL OR (kind = 'game' AND char_length(external_ref) BETWEEN 1 AND 40 AND external_ref = btrim(external_ref)))
           AND (game_date IS NULL OR kind = 'game'));
CREATE UNIQUE INDEX IF NOT EXISTS schedule_tbd_season_external_ref_key
    ON public.schedule_tbd (season_settings_id, external_ref)
    WHERE external_ref IS NOT NULL;
COMMENT ON COLUMN public.schedule_tbd.external_ref IS
    'The Game ID a schedule import carried for this TIME TBD game (20261121010000): at most 40 characters, exact after trimming, unique per season, NULL for a game the solver listed or a file gave no Game ID. A re-import finds the game by it.';
COMMENT ON COLUMN public.schedule_tbd.game_date IS
    'The DATE a schedule import gave this TIME TBD game (20261121010000): a game with no time still has a day. NULL for a game the solver could not place and for a practice. The week_index is the file''s week (a week that is not the date''s is a week-differs warning, never renumbered).';

-- An application record can say a row was deleted (a placed game the file now gives no time; a TIME TBD game the file now
-- places): the image it had is the previous payload, and the rollback puts it back.
ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_operation_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_operation_check
    CHECK (operation IN ('inserted', 'updated', 'deleted'));

INSERT INTO public.audit_actions (action) VALUES ('game.slot_created')
    ON CONFLICT (action) DO NOTHING;
INSERT INTO public.audit_actions (action) VALUES ('import.mapped')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The import types the pipeline accepts.
-- ---------------------------------------------------------------------------
--
-- The four functions are the bodies 20261113010000 left (the md5 guards above), each with the one change of knowing the
-- new type; nothing else in them moves. The two deferred-apply functions keep the `now()` idiom
-- (tests/utcNowIdiom.test.js). `import_allowed_keys('games')` is the SQL copy of the new allowlist, which
-- tests/importAllowlistParity.test.js holds equal to the two code copies and to the keys the apply reads.

CREATE OR REPLACE FUNCTION public.create_import_job(p_organization_id uuid, p_import_type text, p_file_name text, p_season_settings_id uuid DEFAULT NULL::uuid)
 RETURNS import_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_import_type text := lower(NULLIF(btrim(COALESCE(p_import_type, '')), ''));
    v_file_name text := btrim(COALESCE(p_file_name, ''));
    v_job_type text;
    v_now timestamptz := now();
    v_job public.import_jobs%ROWTYPE;
    v_season_id uuid;
    v_season_status text;
BEGIN
    IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
      RAISE EXCEPTION 'Only organization admins can create import jobs' USING ERRCODE='42501';
    END IF;
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations', 'games') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' WHEN v_import_type = 'evaluations' THEN 'evaluations' WHEN v_import_type = 'games' THEN 'games' ELSE 'registration' END;

    -- 20261101010000: the season the import adds to is fixed now, not when it is
    -- finalized. A named season must be this organization's and not completed;
    -- none named is the organization's active season (none at all leaves the job
    -- without one, as a job made before this migration is). Divisions and field
    -- practice reservations land in it.
    IF p_season_settings_id IS NULL THEN
      SELECT s.id INTO v_season_id
        FROM public.season_settings s
       WHERE s.organization_id = p_organization_id AND s.status = 'active';
    ELSE
      SELECT s.id, s.status INTO v_season_id, v_season_status
        FROM public.season_settings s
       WHERE s.id = p_season_settings_id AND s.organization_id = p_organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'season % does not belong to organization %', p_season_settings_id, p_organization_id
          USING ERRCODE='42501';
      END IF;
      IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'season % is completed and takes no import', p_season_settings_id
          USING ERRCODE='22023', DETAIL='season_completed';
      END IF;
      -- 20261111010000: the active season or a draft takes a registration or coach import (a
      -- club prepares next season from its own registration data); a field import stays with the
      -- active season, as finalize_field_import_job still requires. 20261113010000: an evaluations
      -- import updates the players of a draft season as it does the active one's.
      IF v_season_status <> 'active' AND (v_season_status <> 'draft' OR v_job_type NOT IN ('registration', 'evaluations')) THEN
        RAISE EXCEPTION 'season % is % and takes no % import: only the active season does', p_season_settings_id, v_season_status, v_import_type
          USING ERRCODE='22023', DETAIL='season_not_active';
      END IF;
    END IF;

    INSERT INTO public.import_jobs (organization_id,job_type,storage_path,status,total_rows,processed_rows,progress_percent,last_heartbeat_at,created_by,started_at,season_settings_id)
    VALUES (p_organization_id,v_job_type,format('imports/%s/%s', auth.uid(), v_file_name),'importing',0,0,0,v_now,auth.uid(),v_now,v_season_id)
    RETURNING * INTO v_job;

    PERFORM public.record_audit_event(p_organization_id,'import.started','import_job',v_job.id,jsonb_build_object('import_type',v_import_type,'job_type',v_job_type,'status','importing'));
    RETURN v_job;
END;
$function$;

COMMENT ON FUNCTION public.create_import_job(uuid, text, text, uuid) IS
    'Admin-only: start an import job for the named season (none named: the organization''s active season), fixed now. A player, coach, practice preference or evaluations import may name the active season or a draft; a field import and a games import only the active season; a completed season is refused (22023, season_completed). 20261121010000 (games; 20261113010000 before it added evaluations, 20261112010000 practice_preferences, 20261111010000 the draft season).';

CREATE OR REPLACE FUNCTION public.mark_import_job_ready_to_apply(p_import_job_id uuid, p_import_type text, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations','games') THEN RAISE EXCEPTION 'Deferred apply is only available for coach, field, field_availability, practice_preferences, evaluations, and games imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='games' AND v_job.job_type<>'games' THEN RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','ready_to_apply','import_type',v_import_type,'staged_rows',v_staged_rows,'validation_error_rows',jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)),'ready_at',now());
  UPDATE public.import_jobs SET status='ready_to_apply', processed_rows=v_staged_rows, progress_percent=100, completed_at=NULL, error_summary=jsonb_build_object('rowErrors',COALESCE(p_validation_errors,'[]'::jsonb)), warning_summary=jsonb_set(COALESCE(warning_summary,'{}'::jsonb),'{deferred_apply}',v_result,true) WHERE id=p_import_job_id;
  PERFORM public.record_audit_event(v_job.organization_id,'import.validated','import_job',p_import_job_id,v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_ready_import_job(p_import_job_id uuid, p_import_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations','games') THEN RAISE EXCEPTION 'Deferred apply cancellation is only available for coach, field, field_availability, practice_preferences, evaluations, and games imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='games' AND v_job.job_type<>'games' THEN RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','canceled','import_type',v_import_type,'staged_rows',v_staged_rows,'canceled_at',now());
  UPDATE public.import_jobs SET status='failed',completed_at=now(),error_summary=jsonb_set(COALESCE(error_summary,'{}'::jsonb),'{deferred_apply}',v_result,true),warning_summary=jsonb_set(COALESCE(warning_summary,'{}'::jsonb),'{deferred_apply}',v_result,true) WHERE id=p_import_job_id;
  PERFORM public.record_audit_event(v_job.organization_id,'import.canceled','import_job',p_import_job_id,v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.import_allowed_keys(p_import_type text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
    SELECT CASE p_import_type
        WHEN 'players' THEN ARRAY[
            'first_name', 'last_name', 'preferred_name', 'nickname', 'external_registration_id',
            'gotsport_id', 'registration_id', 'player_id', 'natural_age',
            'age group', 'age_group', 'age', 'gender', 'grade', 'division_id', 'division_name',
            'division', 'group', 'program', 'skill_tier', 'skill_level', 'years_played',
            'years played',
            'how many years has your player played in an organized soccer program?', 'waitlist',
            'waitlisted', 'play_up', 'play up',
            'are you coaching so this player can play up a division?', 'willing_to_coach',
            'coach_volunteer', 'can you coach for this player''s team?', 'buddy_request',
            'buddy_id', 'buddy_external_registration_id', 'buddy_registration_id',
            'friend_request', 'mutual_buddy_code', 'buddy_code', 'friend_code', 'team name',
            'team age', 'team gender'
        ]::text[]
        WHEN 'coaches' THEN ARRAY[
            'full_name', 'email', 'status', 'coach_status', 'can_coach_multiple_teams',
            'multiple_teams', 'multi_team', 'certifications', 'certification',
            'child_registration_id', 'first_name', 'last_name'
        ]::text[]
        WHEN 'practice_preferences' THEN ARRAY[
            'email', 'team_name', 'team name', 'team', 'request_level', 'weekdays', 'days', 'day',
            'start_times', 'start_time', 'start', 'venues', 'location', 'effective_from',
            'valid_from', 'effective_to', 'valid_until', 'coach_priority'
        ]::text[]
        WHEN 'evaluations' THEN ARRAY[
            'external_registration_id', 'gotsport_id', 'registration_id', 'player_id',
            'years_played', 'skill_tier', 'skill_level', 'rating'
        ]::text[]
        -- 20261121010000: the staged payload keys a games import reads (the apply is the one reader). The file's own
        -- columns are filtered by the core parser (scheduleImport/parseRows.js), which keeps only the columns of plan
        -- 4.3; these are what the Edge function stages from them.
        WHEN 'games' THEN ARRAY[
            'row_key', 'game_id', 'status', 'tbd_reason', 'date', 'start_time', 'end_time', 'start', 'end', 'week_index', 'flags',
            'division', 'division_key', 'venue', 'venue_key', 'field', 'field_key', 'home_team', 'home_key', 'away_team', 'away_key'
        ]::text[]
        ELSE ARRAY[]::text[]
    END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The Published guard honours a rollback.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261120010000 (its latest body, found by search: no later migration replaces it). Added: the
-- rollback exemption, and the one internal helper it compares with. The helper picks the columns a game is held by out
-- of a row's jsonb (`to_jsonb(row)` or a stored application image), so the guard, the rollback's pre-check and the
-- stored images are compared by one definition.

CREATE FUNCTION public.game_import_image(p_row jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'game_slot_id', p_row -> 'game_slot_id', 'slot_id', p_row -> 'slot_id', 'field_id', p_row -> 'field_id',
        'home_team_id', p_row -> 'home_team_id', 'away_team_id', p_row -> 'away_team_id',
        'week_index', p_row -> 'week_index', 'start', p_row -> 'start', 'end', p_row -> 'end',
        'published', p_row -> 'published', 'division', p_row -> 'division', 'external_ref', p_row -> 'external_ref')
$$;

REVOKE ALL ON FUNCTION public.game_import_image(jsonb) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.game_import_image(jsonb) IS
    'Internal: the columns of a game_assignments row (as jsonb) that decide whether a games import changed it since it was applied: where, when, who plays, whether it is Published, its division label and its Game ID. Used by the Published guard''s rollback exemption and by rollback_game_import_job. 20261121010000.';

-- The rollback's comparison for every other row it undoes (a TIME TBD game, a division, a venue, a field, a team, a slot): the
-- row as it stands now against the row as the apply stored it. Every column the apply recorded must still hold the recorded
-- value, except the two instants a write moves without changing the row's meaning. It reads the keys of the STORED image, so a
-- column added to a table later does not make every old job's rows look changed, and an empty or missing image (a 'deleted'
-- record stores `{}`), or a missing row, matches nothing, never NULL: a check that examined no column is not a pass.

CREATE FUNCTION public.game_import_row_unchanged(p_now jsonb, p_applied jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT COALESCE(p_now IS NOT NULL AND jsonb_typeof(p_applied) = 'object' AND p_applied <> '{}'::jsonb
                    AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_applied) e
                                     WHERE e.key NOT IN ('created_at', 'updated_at') AND (p_now -> e.key) IS DISTINCT FROM e.value),
                    false)
$$;

REVOKE ALL ON FUNCTION public.game_import_row_unchanged(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.game_import_row_unchanged(jsonb, jsonb) IS
    'Internal: true when every column a games import stored for a row (its application record''s applied image, created_at and updated_at aside) still holds that value in the row as it stands (as jsonb). An empty image matches nothing. Used by rollback_game_import_job for TIME TBD games and for the divisions, venues, fields, teams and slots the import created. 20261121010000.';


CREATE OR REPLACE FUNCTION public.game_assignments_published_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job text;
BEGIN
    -- A job with no signed-in user: the retention job, the demo purge, the service role.
    IF auth.uid() IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    -- 20261120010000: THE ONE PREDICATE. A row is guarded when `game_is_held` says it is, asked of the row as the
    -- statement found it (so clearing the flag and moving in one statement is still refused). The trigger used to
    -- fire only for rows already flagged Published, which a second reason to hold a game (a score, F11-2) could not
    -- change.
    IF NOT public.game_is_held(OLD.id) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    -- 20261121010000: THE ROLLBACK OF A GAMES IMPORT (plan 3.3 and 4.7). Imported games arrive Published, so taking an
    -- import back deletes held rows, and an updated one back is a move of a held row. `rollback_game_import_job` names its
    -- job in a transaction-local setting; the guard honours it ONLY for a row that job wrote, and only for exactly what
    -- the rollback does: delete a row the job inserted while it is as the apply left it, or put an updated row back to the
    -- image it had before the apply (while it is as the apply left it). Naming another job lifts nothing; neither does a
    -- row that has changed since (its refusal is the rollback's "changed since", which names the games), and neither does
    -- any other statement on the row: the exemption is a comparison with the stored application record, not a role.
    v_job := NULLIF(current_setting('squadlogic.import_rollback', true), '');
    IF v_job IS NOT NULL AND OLD.import_job_id IS NOT NULL AND OLD.import_job_id::text = v_job THEN
        IF TG_OP = 'DELETE' THEN
            IF EXISTS (SELECT 1 FROM public.import_application_records r
                        WHERE r.import_job_id = OLD.import_job_id AND r.import_type = 'games'
                          AND r.target_table = 'game_assignments' AND r.target_id = OLD.id
                          AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
                          AND public.game_import_image(to_jsonb(OLD)) = public.game_import_image(r.applied_payload)) THEN
                RETURN OLD;
            END IF;
        ELSIF EXISTS (SELECT 1 FROM public.import_application_records r
                       WHERE r.import_job_id = OLD.import_job_id AND r.import_type = 'games'
                         AND r.target_table = 'game_assignments' AND r.target_id = OLD.id
                         AND r.operation = 'updated' AND r.rolled_back_at IS NULL
                         AND public.game_import_image(to_jsonb(OLD)) = public.game_import_image(r.applied_payload)
                         AND public.game_import_image(to_jsonb(NEW)) = public.game_import_image(r.previous_payload)) THEN
            RETURN NEW;
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- The cascade of a deleted organization: the organization is already gone, so its games go with it.
        IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = OLD.organization_id) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Game % is Published and cannot be deleted: allow changes to it first', OLD.id
            USING ERRCODE = '22023', DETAIL = 'game_published';
    END IF;
    -- An UPDATE of a Published row: only a change to where, when or who plays is refused.
    IF (NEW.game_slot_id, NEW.slot_id, NEW.field_id, NEW.home_team_id, NEW.away_team_id, NEW.week_index, NEW.start, NEW."end")
       IS NOT DISTINCT FROM
       (OLD.game_slot_id, OLD.slot_id, OLD.field_id, OLD.home_team_id, OLD.away_team_id, OLD.week_index, OLD.start, OLD."end") THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Game % is Published and cannot be moved: allow changes to it first', OLD.id
        USING ERRCODE = '22023', DETAIL = 'game_published';
END;
$$;

DROP TRIGGER IF EXISTS game_assignments_published_guard ON public.game_assignments;
CREATE TRIGGER game_assignments_published_guard
    BEFORE UPDATE OR DELETE ON public.game_assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.game_assignments_published_guard();

COMMENT ON FUNCTION public.game_assignments_published_guard() IS
    'Trigger function on game_assignments: a signed-in caller cannot delete a held game (game_is_held) or change its slot, field, teams, week, start or end (22023, game_published). Callers with no signed-in user and the cascade of a deleted organization pass; so does the rollback of a games import, for exactly the rows that job wrote and only as the apply left them. 20261119010000, asks game_is_held since 20261120010000, rollback exemption since 20261121010000.';

-- ---------------------------------------------------------------------------
-- 4. The two SQL readers that list teams leave an outside club out.
-- ---------------------------------------------------------------------------
--
-- view_org_metrics is the 20261108010000 definition with one condition added (the same columns in the same order, so
-- CREATE OR REPLACE stays valid; security_invoker and the grants are unchanged). sync_schedule_tbd_practices is copied
-- whole from 20261108020000 with one condition added: an outside club in a two-a-week division would otherwise read as
-- a team short of its practices, and the TIME TBD list would name it. Every other reader of `teams` is classified by
-- tests/externalTeamReaders.test.js; `persist_practice_schedule` and `view_league_standings` are named there as pending.

CREATE OR REPLACE VIEW public.view_org_metrics
WITH (security_invoker = true)
AS
SELECT
    o.id AS organization_id,
    o.name AS organization_name,
    (SELECT COUNT(p.id) FROM public.players p
      WHERE p.organization_id = o.id AND p.season_settings_id IS NOT DISTINCT FROM s.id) AS total_players,
    (SELECT COUNT(t.id) FROM public.teams t
       JOIN public.divisions d ON d.id = t.division_id
      WHERE t.organization_id = o.id AND d.season_settings_id IS NOT DISTINCT FROM s.id
        -- 20261121010000: an outside club is not one of the organization's teams.
        AND NOT t.is_external) AS total_teams,
    (SELECT COUNT(om.profile_id) FROM public.organization_members om WHERE om.organization_id = o.id) AS total_users,
    s.id AS season_settings_id
FROM public.organizations o
LEFT JOIN public.season_settings s ON s.organization_id = o.id;


CREATE OR REPLACE FUNCTION public.sync_schedule_tbd_practices(p_organization_id uuid, p_season_settings_id uuid, p_run_id uuid, p_unassigned jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_org_id uuid := p_organization_id;
    v_season_id uuid := p_season_settings_id;
    v_persisted_run_id uuid;
    v_tbd_reasons jsonb;
    v_prev jsonb;
    v_keep boolean;
    v_ctx text;
    v_rows integer;
BEGIN
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    IF v_ctx !~ 'PL/pgSQL function (persist_practice_schedule|refresh_schedule_tbd_practices)\(' THEN
        RAISE EXCEPTION 'sync_schedule_tbd_practices is called by the practice save and by refresh_schedule_tbd_practices only'
            USING ERRCODE = '42501';
    END IF;
    IF p_organization_id IS NULL OR p_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'organization and season are required'
            USING ERRCODE = '23502';
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.season_settings ss
                    WHERE ss.id = p_season_settings_id AND ss.organization_id = p_organization_id) THEN
        RAISE EXCEPTION 'season % is not a season of organization %', p_season_settings_id, p_organization_id
            USING ERRCODE = '42501';
    END IF;
    -- The run labels the rows; it is kept only if it is this organization's.
    SELECT sr.id INTO v_persisted_run_id
      FROM public.scheduler_runs sr
     WHERE sr.id = p_run_id AND sr.organization_id = p_organization_id;
    v_tbd_reasons := CASE WHEN jsonb_typeof(p_unassigned) = 'array' THEN p_unassigned ELSE '[]'::jsonb END;
    -- A call with no label list at all (refresh_schedule_tbd_practices) keeps what each team's row said before:
    -- its reason and its run. A call with a list (the practice save) is a run's own word and replaces them.
    v_keep := p_unassigned IS NULL;
    SELECT COALESCE(jsonb_object_agg(s.team_id::text, jsonb_build_object('reason', s.reason, 'run_id', s.run_id)), '{}'::jsonb)
      INTO v_prev
      FROM public.schedule_tbd s
     WHERE s.organization_id = v_org_id
       AND s.season_settings_id = v_season_id
       AND s.kind = 'practice';
    DELETE FROM public.schedule_tbd s
     WHERE s.organization_id = v_org_id
       AND s.season_settings_id = v_season_id
       AND s.kind = 'practice';
    INSERT INTO public.schedule_tbd (
        organization_id, season_settings_id, kind, division_id, team_id,
        missing_count, reason, detail, run_id
    )
    SELECT v_org_id, v_season_id, 'practice', d.id, t.id,
           (d.practices_per_week - held.n)::smallint,
           COALESCE(why.reason, CASE WHEN v_keep THEN v_prev -> t.id::text ->> 'reason' END, 'not-scheduled-yet'),
           jsonb_build_object('target', d.practices_per_week, 'held', held.n),
           CASE WHEN v_keep AND why.reason IS NULL AND v_prev ? t.id::text
                THEN NULLIF(v_prev -> t.id::text ->> 'run_id', '')::uuid
                ELSE v_persisted_run_id END
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
      CROSS JOIN LATERAL (
            -- A team's held practices: the most fragments of its live series that are in force on one
            -- day, taken over the days its fragments start (no earlier than today). The repair adapter
            -- splits a series in two (the old one closed, its successor from the retirement date): the
            -- two never overlap and are one practice, where counting every unexpired row said two. An
            -- ended series is not live. A series that has not started yet counts from its start.
            WITH live AS (
                SELECT pa.effective_date_range AS r
                  FROM public.practice_assignments pa
                 WHERE pa.team_id = t.id
                   AND pa.organization_id = v_org_id
                   AND (pa.effective_date_range IS NULL
                        OR (NOT isempty(pa.effective_date_range)
                            AND (upper_inf(pa.effective_date_range)
                                 OR upper(pa.effective_date_range) > CURRENT_DATE)))
            ), starts AS (
                SELECT DISTINCT GREATEST(COALESCE(lower(l.r), CURRENT_DATE), CURRENT_DATE) AS d FROM live l
            )
            SELECT COALESCE(max(x.n), 0)::integer AS n
              FROM (SELECT (SELECT count(*) FROM live l WHERE l.r IS NULL OR l.r @> s.d) AS n
                      FROM starts s) x
           ) held
      LEFT JOIN LATERAL (
            SELECT e.value->>'reason' AS reason
              FROM jsonb_array_elements(v_tbd_reasons) e
             WHERE jsonb_typeof(e.value) = 'object'
               AND lower(e.value->>'teamId') = lower(t.id::text)
               AND e.value->>'reason' IN ('no-slot-available', 'no-live-date', 'coach-preference',
                                          'practice-length', 'not-enough-days')
             ORDER BY e.value->>'reason'
             LIMIT 1
           ) why ON true
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id
       -- 20261121010000: an outside club is a side of a game and nothing else: it has no practice to be short of.
       AND NOT t.is_external
       AND d.practices_per_week > held.n;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. ensure_game_slot: find or create the slot a game is placed in.
-- ---------------------------------------------------------------------------
--
-- Modelled on the field import's lookup (20261029010000:1008-1100): a slot is a field on a date at a start time, found by
-- (organization, field, date, start time), the earliest first; capacity 1. The field import is NOT refactored (AGENTS.md
-- rule 2). PR 8 (add one game by hand) shares this RPC. The import's apply plans its slots in one statement and does not
-- call it per slot (574 games would audit 574 slots); both use the same lookup, held equal by the pgTAP file.

CREATE FUNCTION public.ensure_game_slot(
    p_organization_id uuid,
    p_field_id uuid,
    p_slot_date date,
    p_start_time time,
    p_end_time time,
    p_week_index smallint,
    p_start timestamptz DEFAULT NULL,
    p_end timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_slot public.game_slots%ROWTYPE;
BEGIN
    -- A creation is audited, and an audit row needs an actor: a caller with no signed-in user (the service role) is
    -- refused before anything is read or written.
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'ensure_game_slot needs a signed-in caller to audit the slot' USING ERRCODE = '42501';
    END IF;
    IF p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an administrator of the organization makes a game slot' USING ERRCODE = '42501';
    END IF;
    IF p_field_id IS NULL OR p_slot_date IS NULL OR p_start_time IS NULL OR p_end_time IS NULL OR p_week_index IS NULL THEN
        RAISE EXCEPTION 'a field, a date, a start and an end time and a week are required' USING ERRCODE = '23502';
    END IF;
    IF p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'a slot ends after it starts' USING ERRCODE = '22023';
    END IF;
    IF p_week_index < 1 OR p_week_index > 255 THEN
        RAISE EXCEPTION 'the week is from 1 to 255' USING ERRCODE = '22023';
    END IF;
    IF (p_start IS NULL) <> (p_end IS NULL) OR (p_start IS NOT NULL AND p_end <= p_start) THEN
        RAISE EXCEPTION 'give both instants of the slot, the end after the start, or neither' USING ERRCODE = '22023';
    END IF;
    -- The organization's lock, shared with the game writers, so a slot is made once whoever asks.
    PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || p_organization_id::text, 0));
    -- A field of another organization reads exactly as one that does not exist.
    IF NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.id = p_field_id AND f.organization_id = p_organization_id) THEN
        RAISE EXCEPTION 'field % does not exist in this organization', p_field_id USING ERRCODE = '23503';
    END IF;

    SELECT * INTO v_slot
      FROM public.game_slots gs
     WHERE gs.organization_id = p_organization_id
       AND gs.field_id = p_field_id
       AND gs.slot_date = p_slot_date
       AND gs.start_time = p_start_time
     ORDER BY gs.created_at, gs.id
     LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('id', v_slot.id, 'created', false);
    END IF;

    INSERT INTO public.game_slots (organization_id, field_id, slot_date, start_time, end_time, week_index, capacity, start, "end")
    VALUES (p_organization_id, p_field_id, p_slot_date, p_start_time, p_end_time, p_week_index, 1, p_start, p_end)
    RETURNING * INTO v_slot;

    -- The audit row, in this transaction. A failed write rolls the slot back; SLA01 tells the caller it was the audit.
    BEGIN
        PERFORM public.record_audit_event(
            p_organization_id, 'game.slot_created', 'game_slot', v_slot.id,
            jsonb_build_object('field_id', p_field_id, 'slot_date', p_slot_date, 'start_time', p_start_time,
                               'end_time', p_end_time, 'week_index', p_week_index));
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;
    RETURN jsonb_build_object('id', v_slot.id, 'created', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_game_slot(uuid, uuid, date, time, time, smallint, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_game_slot(uuid, uuid, date, time, time, smallint, timestamptz, timestamptz) TO authenticated;
COMMENT ON FUNCTION public.ensure_game_slot(uuid, uuid, date, time, time, smallint, timestamptz, timestamptz) IS
    'Admin-only, signed in: the game slot of a field on a date at a start time, found (the earliest) or made with capacity 1. A creation is audited as game.slot_created, a find writes nothing. Returns {id, created}. 20261121010000.';

-- ---------------------------------------------------------------------------
-- 6. map_game_import_job: store what the admin decided for each label.
-- ---------------------------------------------------------------------------
--
-- The mapping is `core scheduleImport/mapping.js`'s decisions, the EFFECTIVE ones (an exact single match is stored as a
-- `map`, as core proposes it): { options: { arrive_published }, divisions, venues, fields, teams }, each group an object
-- keyed by the decision key the staged row carries (`division_key`, `venue_key`, `field_key`, `home_key` or `away_key`;
-- the Edge function computes them with the one normaliser, so this SQL never does) and each decision
-- { action, id?, name? }. Nothing is guessed: a label with no decision is an unknown row at apply. Every id is validated
-- against the organization (and the job's season for a division) here, and again as each row resolves.

CREATE FUNCTION public.map_game_import_job(p_import_job_id uuid, p_mapping jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_groups constant text[] := ARRAY['divisions', 'venues', 'fields', 'teams'];
    c_max_entries constant integer := 5000;
    c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_uid uuid := auth.uid();
    v_job public.import_jobs%ROWTYPE;
    v_season_status text;
    v_group text;
    v_kind text;
    v_entry record;
    v_clean jsonb := '{}'::jsonb;
    v_group_clean jsonb;
    v_decision jsonb;
    v_action text;
    v_name text;
    v_id uuid;
    v_arrive boolean := true;
    v_counts jsonb := '{}'::jsonb;
    v_decisions jsonb := '{}'::jsonb;
    v_actions text[];
    v_known boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'map_game_import_job needs a signed-in caller to audit the mapping' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'games' THEN
        RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;
    IF v_job.status NOT IN ('importing', 'ready_to_apply') THEN
        RAISE EXCEPTION 'Import job % is %: its mapping can no longer be changed', p_import_job_id, v_job.status USING ERRCODE = '22023';
    END IF;
    SELECT s.status INTO v_season_status FROM public.season_settings s
     WHERE s.id = v_job.season_settings_id AND s.organization_id = v_job.organization_id;
    IF v_season_status IS NULL THEN
        RAISE EXCEPTION 'Import job % has no season to import into', p_import_job_id USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_job.season_settings_id USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    IF p_mapping IS NULL OR jsonb_typeof(p_mapping) <> 'object' THEN
        RAISE EXCEPTION 'the mapping must be an object' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_mapping) k WHERE k <> ALL (c_groups || ARRAY['options'])) THEN
        RAISE EXCEPTION 'the mapping holds options, divisions, venues, fields and teams and nothing else' USING ERRCODE = '22023';
    END IF;
    IF p_mapping ? 'options' THEN
        IF jsonb_typeof(p_mapping -> 'options') <> 'object'
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_mapping -> 'options') k WHERE k <> 'arrive_published')
           OR (p_mapping -> 'options' ? 'arrive_published' AND jsonb_typeof(p_mapping -> 'options' -> 'arrive_published') <> 'boolean') THEN
            RAISE EXCEPTION 'the options are { arrive_published: true or false }' USING ERRCODE = '22023';
        END IF;
        v_arrive := COALESCE((p_mapping -> 'options' ->> 'arrive_published')::boolean, true);
    END IF;

    FOREACH v_group IN ARRAY c_groups LOOP
        v_kind := CASE v_group WHEN 'divisions' THEN 'division' WHEN 'venues' THEN 'venue' WHEN 'fields' THEN 'field' ELSE 'team' END;
        v_actions := CASE WHEN v_kind = 'team' THEN ARRAY['map', 'create', 'outside', 'skip'] ELSE ARRAY['map', 'create', 'skip'] END;
        v_group_clean := '{}'::jsonb;
        IF p_mapping ? v_group THEN
            IF jsonb_typeof(p_mapping -> v_group) <> 'object' THEN
                RAISE EXCEPTION 'the % of the mapping must be an object', v_group USING ERRCODE = '22023';
            END IF;
            IF (SELECT count(*) FROM jsonb_object_keys(p_mapping -> v_group)) > c_max_entries THEN
                RAISE EXCEPTION 'at most % % can be mapped in one job', c_max_entries, v_group USING ERRCODE = '22023';
            END IF;
            FOR v_entry IN SELECT e.key, e.value FROM jsonb_each(p_mapping -> v_group) e ORDER BY e.key LOOP
                IF char_length(v_entry.key) = 0 OR char_length(v_entry.key) > 500 THEN
                    RAISE EXCEPTION 'a decision key of % is empty or over 500 characters', v_group USING ERRCODE = '22023';
                END IF;
                v_decision := v_entry.value;
                IF jsonb_typeof(v_decision) <> 'object' THEN
                    RAISE EXCEPTION 'a decision of % must be an object', v_group USING ERRCODE = '22023';
                END IF;
                v_action := v_decision ->> 'action';
                IF v_action IS NULL OR NOT (v_action = ANY (v_actions)) THEN
                    RAISE EXCEPTION 'a decision of % is not one of its actions (%)', v_group, array_to_string(v_actions, ', ')
                        USING ERRCODE = '22023';
                END IF;
                v_name := NULLIF(btrim(v_decision ->> 'name', E' \t\r\n'), '');
                IF v_name IS NOT NULL AND (jsonb_typeof(v_decision -> 'name') <> 'string' OR char_length(v_name) > 200) THEN
                    RAISE EXCEPTION 'a name of a created % is text of at most 200 characters', v_kind USING ERRCODE = '22023';
                END IF;
                IF v_action = 'map' THEN
                    IF jsonb_typeof(v_decision -> 'id') <> 'string' OR (v_decision ->> 'id') !~* c_uuid THEN
                        RAISE EXCEPTION 'a map decision of % names a record by its id', v_group USING ERRCODE = '22023';
                    END IF;
                    v_id := (v_decision ->> 'id')::uuid;
                    v_known := CASE v_kind
                        WHEN 'division' THEN EXISTS (SELECT 1 FROM public.divisions d WHERE d.id = v_id
                                                      AND d.organization_id = v_job.organization_id AND d.season_settings_id = v_job.season_settings_id)
                        WHEN 'venue' THEN EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v_id AND l.organization_id = v_job.organization_id)
                        WHEN 'field' THEN EXISTS (SELECT 1 FROM public.fields f WHERE f.id = v_id AND f.organization_id = v_job.organization_id)
                        ELSE EXISTS (SELECT 1 FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
                                      WHERE t.id = v_id AND t.organization_id = v_job.organization_id AND d.season_settings_id = v_job.season_settings_id)
                    END;
                    IF NOT v_known THEN
                        RAISE EXCEPTION 'the % % is not a record of this organization and season', v_kind, v_id USING ERRCODE = '22023';
                    END IF;
                    v_group_clean := v_group_clean || jsonb_build_object(v_entry.key, jsonb_build_object('action', 'map', 'id', v_id));
                ELSE
                    v_group_clean := v_group_clean || jsonb_build_object(v_entry.key,
                        jsonb_build_object('action', v_action) || CASE WHEN v_name IS NULL OR v_action NOT IN ('create', 'outside')
                                                                       THEN '{}'::jsonb ELSE jsonb_build_object('name', v_name) END);
                END IF;
            END LOOP;
        END IF;
        v_clean := v_clean || jsonb_build_object(v_group, v_group_clean);
        v_counts := v_counts || jsonb_build_object(v_group, (SELECT count(*) FROM jsonb_object_keys(v_group_clean)));
        v_decisions := v_decisions || jsonb_build_object(v_group, (SELECT COALESCE(jsonb_object_agg(x.action, x.n), '{}'::jsonb)
                                                                    FROM (SELECT e.value ->> 'action' AS action, count(*) AS n
                                                                            FROM jsonb_each(v_group_clean) e GROUP BY 1) x));
    END LOOP;
    v_clean := v_clean || jsonb_build_object('options', jsonb_build_object('arrive_published', v_arrive));

    UPDATE public.import_jobs
       SET warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{game_mapping}', v_clean, true)
     WHERE id = p_import_job_id;

    -- The mapping is the sole input of the apply, so storing it is an administrative action and is audited (AGENTS.md
    -- section 3): the number of decisions per group and action and the Published default, never a label of the file. The
    -- audit write is in this transaction; a failure rolls the mapping back and SLA01 says it was the audit.
    BEGIN
        PERFORM public.record_audit_event(v_job.organization_id, 'import.mapped', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'games', 'arrive_published', v_arrive, 'decisions', v_decisions));
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN jsonb_build_object('job_id', p_import_job_id, 'arrive_published', v_arrive) || v_counts;
END;
$function$;

REVOKE ALL ON FUNCTION public.map_game_import_job(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.map_game_import_job(uuid, jsonb) TO authenticated;
COMMENT ON FUNCTION public.map_game_import_job(uuid, jsonb) IS
    'Admin-only, signed in: store on a games import job the decisions the admin confirmed for its divisions, venues, fields and teams (map, create, outside, skip) and whether the new games arrive Published. Every id is validated against the organization (a division against the job''s season). Nothing is guessed: a label with no decision stays unknown at apply. Returns the job and the count of decisions per group. 20261121010000.';


-- ---------------------------------------------------------------------------
-- 6b. normalise_external_label: the one way the SQL compares two labels.
-- ---------------------------------------------------------------------------
--
-- The apply compares a name it would create with the names the season already has (a division, a venue, a field, a team,
-- an outside club) and coalesces two labels that would create one record. Core does that by `normaliseExternalLabel`
-- (packages/core/src/externalImport/mapping.js): trim, collapse every run of whitespace to one space, lower-case. The SQL
-- compared `lower(btrim(name))`, which trims spaces only and collapses nothing, so "Blue  Jays", "Blue<tab>Jays" and "Blue
-- <no-break space>Jays" were three names to the apply and one to the preview: the preview refused (or coalesced) what the
-- apply then wrote, a near-duplicate record beside the one the admin meant. This function is core's, in SQL, and every
-- label comparison of the apply goes through it (tests/gameImportLabelParity.test.js holds the apply's text to that, and
-- runs one table of label cases through core and through this function in the pgTAP file).
--
-- Whitespace is JavaScript's: `\s`, which is also what `trim` strips (tab, line feed, vertical tab, form feed, carriage
-- return, space, no-break space, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, and the byte order mark),
-- written out because the database's own `[[:space:]]` is its locale's idea of it (no-break space is not in it).
-- **Not mirrored:** the two letters whose lower case JavaScript takes by a special rule (a capital I with a dot above, and
-- a capital sigma at the end of a word); `lower` here takes the simple mapping. A label that differs from a stored name
-- only in one of them reads as two names here and one in the preview, which is the safe side (a record is created, never
-- one merged), and nothing in the program's labels is spelled that way.
-- IMMUTABLE and strict, no table read; closed to every role (the SECURITY DEFINER functions call it as their owner).

CREATE FUNCTION public.normalise_external_label(p_label text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public
AS $function$
    SELECT lower(btrim(regexp_replace(p_label,
        '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' '))
$function$;

REVOKE ALL ON FUNCTION public.normalise_external_label(text) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.normalise_external_label(text) IS
    'The games import''s one comparison of two labels: core''s normaliseExternalLabel in SQL (trim, collapse every run of whitespace, JavaScript''s whitespace, to one space, lower-case). IMMUTABLE, closed to every role; the import functions call it as their owner. 20261121010000.';

-- ---------------------------------------------------------------------------
-- 7. apply_game_import_job: preview (dry run) and apply, one plan.
-- ---------------------------------------------------------------------------
--
-- The plan is built in temporary tables (`_gi_*`, all schema-qualified `pg_temp.` below and dropped at commit) before a
-- single row is written; `p_dry_run` stops after it. Every row the apply writes is counted against ITS OWN plan and a
-- difference raises (lesson 74). The apply does not receive the preview's plan: it plans again against the state it finds,
-- so if another admin changed a game between the two its counts can differ from the preview's, and the result it returns
-- is what was done.

CREATE FUNCTION public.apply_game_import_job(p_import_job_id uuid, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    -- The closed list of reasons a row is refused and listed (packages/core/src/scheduleImport/reasonCodes.js,
    -- SCHEDULE_IMPORT_ROW_REFUSALS; tests/gameImportReasonParity.test.js holds this text to it). A staged row refused by
    -- the file check carries one of them in its validation_errors; the apply adds the ones it can only know once labels
    -- are mapped.
    c_row_refusals constant text[] := ARRAY[
        'bad-game-id', 'bad-date', 'bad-time', 'end-not-after-start', 'same-team', 'bad-week', 'missing-week',
        'outside-season-window', 'time-in-dst-gap', 'unknown-division', 'unknown-team', 'unknown-venue', 'unknown-field',
        'label-is-own-team', 'duplicate-row', 'game-id-reused'];
    -- The closed list of reasons a game the file names is NOT written. It can grow by one (F11-2: skipped-scored);
    -- packages/core/src/scheduleImport/reasonCodes.js holds the words for each (SCHEDULE_IMPORT_SKIP_REASONS).
    c_skip_published constant text := 'skipped-published';
    c_listed constant integer := 200;
    c_listed_ids constant integer := 50;
    v_uid uuid := auth.uid();
    v_dry boolean := COALESCE(p_dry_run, false);
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season uuid;
    v_season_status text;
    v_map jsonb;
    v_arrive boolean;
    v_now timestamptz := now();
    v_prev_run uuid;
    v_run_id uuid := gen_random_uuid();
    v_bad_row integer;
    v_bad_code text;
    v_held uuid[];
    v_rc bigint;
    v_planned bigint;
    n_staged integer; n_refused integer; n_skipped integer; n_ok integer; n_tbd integer;
    n_ins integer; n_upd integer; n_unch integer; n_skip_pub integer; n_repoint integer; n_hidden integer;
    n_tbd_ins integer; n_tbd_unch integer; n_tbd_upd integer; n_tbd_rem integer; n_tbd_conflict integer; n_tbd_held integer; n_conv integer;
    n_div integer; n_ven integer; n_fld integer; n_shell integer; n_out integer; n_slot_new integer; n_slot_reused integer;
    n_not_in_file integer; v_not_in_file jsonb;
    v_work integer;
    v_nothing boolean;
    v_warnings jsonb;
    v_refused_by_reason jsonb;
    v_listed_refused jsonb; v_listed_skipped jsonb; v_listed_games jsonb;
    v_skipped_obj jsonb;
    v_result jsonb;
    v_ids jsonb := jsonb_build_object('run_id', NULL, 'team_run_ids', '[]'::jsonb);
    v_team_runs jsonb := '[]'::jsonb;
    v_status text;
    v_published_ids uuid[];
    v_div record;
    v_base jsonb; v_grouped jsonb; v_results jsonb; v_key text; v_label text; v_shell_arr uuid[]; v_team_run uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'apply_game_import_job needs a signed-in caller' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'games' THEN
        RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;

    -- An apply takes the game writers' lock and then the season writers' (every other path takes at most one of the two,
    -- so no order can deadlock), and holds the job row; a dry run only reads.
    IF NOT v_dry THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org::text, 0));
        PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
        SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    END IF;

    -- A finished job answers with the result it stored (a retry after a lost response writes nothing).
    IF v_job.status IN ('completed', 'completed_with_warnings') THEN
        IF v_job.warning_summary ? 'game_import' THEN
            RETURN (v_job.warning_summary -> 'game_import') || jsonb_build_object('replayed', true);
        END IF;
        RAISE EXCEPTION 'Import job % is already %', p_import_job_id, v_job.status USING ERRCODE = '22023';
    END IF;
    IF v_job.status IN ('failed', 'needs_fix') THEN
        RAISE EXCEPTION '% import job % cannot be applied: a new file is a new job', initcap(v_job.status), p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    v_season := v_job.season_settings_id;
    SELECT s.status INTO v_season_status FROM public.season_settings s
     WHERE s.id = v_season AND s.organization_id = v_org;
    IF v_season_status IS NULL THEN
        RAISE EXCEPTION 'Import job % has no season to import into', p_import_job_id USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no games import: only the active season does', v_season, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;
    v_map := v_job.warning_summary -> 'game_mapping';
    IF v_map IS NULL THEN
        RAISE EXCEPTION 'Import job % has no mapping: confirm what each label of the file is first', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'mapping_required';
    END IF;
    v_arrive := COALESCE((v_map -> 'options' ->> 'arrive_published')::boolean, true);

    -- ------------------------------------------------------------------ 1. The staged rows, read once.
    DROP TABLE IF EXISTS pg_temp._gi_tbefore, pg_temp._gi_rows, pg_temp._gi_dec, pg_temp._gi_div, pg_temp._gi_venue, pg_temp._gi_field,
        pg_temp._gi_team, pg_temp._gi_res, pg_temp._gi_work, pg_temp._gi_g, pg_temp._gi_slotnew, pg_temp._gi_t,
        pg_temp._gi_carry, pg_temp._gi_final, pg_temp._gi_before, pg_temp._gi_newgames;

    CREATE TEMP TABLE _gi_rows ON COMMIT DROP AS
    SELECT sr.id AS staging_id,
           sr.source_row_number AS rowno,
           (sr.normalized_payload IS NULL OR COALESCE(jsonb_array_length(sr.validation_errors), 0) > 0) AS parse_refused,
           sr.validation_errors -> 0 ->> 'code' AS parse_reason,
           sr.validation_errors -> 0 ->> 'message' AS parse_message,
           sr.normalized_payload ->> 'row_key' AS row_key,
           NULLIF(btrim(sr.normalized_payload ->> 'game_id', E' \t\r\n'), '') AS game_id,
           sr.normalized_payload ->> 'status' AS status,
           sr.normalized_payload ->> 'tbd_reason' AS tbd_reason,
           CASE WHEN sr.normalized_payload ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (sr.normalized_payload ->> 'date')::date END AS gdate,
           CASE WHEN sr.normalized_payload ->> 'start_time' ~ '^\d{2}:\d{2}$' THEN (sr.normalized_payload ->> 'start_time')::time END AS start_time,
           CASE WHEN sr.normalized_payload ->> 'end_time' ~ '^\d{2}:\d{2}$' THEN (sr.normalized_payload ->> 'end_time')::time END AS end_time,
           CASE WHEN sr.normalized_payload ->> 'start' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
                THEN (sr.normalized_payload ->> 'start')::timestamptz END AS start_ts,
           CASE WHEN sr.normalized_payload ->> 'end' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
                THEN (sr.normalized_payload ->> 'end')::timestamptz END AS end_ts,
           CASE WHEN sr.normalized_payload ->> 'week_index' ~ '^\d{1,3}$' THEN (sr.normalized_payload ->> 'week_index')::integer END AS week_index,
           CASE WHEN jsonb_typeof(sr.normalized_payload -> 'flags') = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(sr.normalized_payload -> 'flags')) ELSE ARRAY[]::text[] END AS flags,
           btrim(sr.normalized_payload ->> 'division', E' \t\r\n') AS division_label,
           sr.normalized_payload ->> 'division_key' AS division_key,
           btrim(sr.normalized_payload ->> 'venue', E' \t\r\n') AS venue_label,
           sr.normalized_payload ->> 'venue_key' AS venue_key,
           btrim(sr.normalized_payload ->> 'field', E' \t\r\n') AS field_label,
           sr.normalized_payload ->> 'field_key' AS field_key,
           btrim(sr.normalized_payload ->> 'home_team', E' \t\r\n') AS home_label,
           sr.normalized_payload ->> 'home_key' AS home_key,
           btrim(sr.normalized_payload ->> 'away_team', E' \t\r\n') AS away_label,
           sr.normalized_payload ->> 'away_key' AS away_key
      FROM public.staging_import_rows sr
     WHERE sr.import_job_id = p_import_job_id
       AND sr.organization_id = v_org
       AND sr.import_type = 'games';

    SELECT count(*) INTO n_staged FROM _gi_rows;
    IF n_staged = 0 THEN
        RAISE EXCEPTION 'Import job % has no staged games rows', p_import_job_id USING ERRCODE = '22023', DETAIL = 'no_rows';
    END IF;

    -- A staged row is the Edge function's work, and a malformed one is a defect there, not a row to guess at: the whole
    -- apply refuses, naming the first.
    SELECT r.rowno, r.parse_reason INTO v_bad_row, v_bad_code
      FROM _gi_rows r
     WHERE r.parse_refused AND NOT (COALESCE(r.parse_reason, '') = ANY (c_row_refusals))
     ORDER BY r.rowno LIMIT 1;
    IF v_bad_row IS NOT NULL THEN
        RAISE EXCEPTION 'staged row % is refused for a reason this import does not know', v_bad_row
            USING ERRCODE = '22023', DETAIL = 'game_import_staged_invalid';
    END IF;
    SELECT r.rowno INTO v_bad_row
      FROM _gi_rows r
     WHERE NOT r.parse_refused
       AND NOT (r.status IN ('ok', 'tbd') AND r.gdate IS NOT NULL AND r.week_index BETWEEN 1 AND 255
                AND COALESCE(r.row_key, '') <> '' AND COALESCE(char_length(r.game_id), 0) <= 40
                AND COALESCE(r.division_key, '') <> '' AND COALESCE(r.home_key, '') <> '' AND COALESCE(r.away_key, '') <> ''
                AND COALESCE(r.division_label, '') <> '' AND COALESCE(r.home_label, '') <> '' AND COALESCE(r.away_label, '') <> ''
                AND (CASE WHEN r.status = 'ok'
                          THEN r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.start_ts IS NOT NULL AND r.end_ts IS NOT NULL
                               AND r.end_ts > r.start_ts AND COALESCE(r.venue_key, '') <> '' AND COALESCE(r.field_key, '') <> ''
                               AND COALESCE(r.venue_label, '') <> '' AND COALESCE(r.field_label, '') <> ''
                          ELSE r.start_ts IS NULL AND r.end_ts IS NULL END)
                AND r.flags <@ ARRAY['time-ambiguous', 'week-differs'])
     ORDER BY r.rowno LIMIT 1;
    IF v_bad_row IS NOT NULL THEN
        RAISE EXCEPTION 'staged row % is not a games row', v_bad_row
            USING ERRCODE = '22023', DETAIL = 'game_import_staged_invalid';
    END IF;

    -- ------------------------------------------------------------------ 2. What the admin decided, and what each label is.
    CREATE TEMP TABLE _gi_dec ON COMMIT DROP AS
    SELECT g.kind, e.key AS dkey, e.value ->> 'action' AS action,
           CASE WHEN e.value ->> 'action' = 'map'
                 AND e.value ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (e.value ->> 'id')::uuid END AS ref_id,
           NULLIF(btrim(e.value ->> 'name', E' \t\r\n'), '') AS dname
      FROM (VALUES ('division', 'divisions'), ('venue', 'venues'), ('field', 'fields'), ('team', 'teams')) AS g(kind, grp)
      CROSS JOIN LATERAL jsonb_each(COALESCE(v_map -> g.grp, '{}'::jsonb)) AS e(key, value)
     WHERE e.value ->> 'action' = ANY (CASE WHEN g.kind = 'team' THEN ARRAY['map', 'create', 'outside', 'skip']
                                            ELSE ARRAY['map', 'create', 'skip'] END);

    -- Divisions: of this season. A `create` over a name the season already has would meet UNIQUE (season, name), and so
    -- would two labels that create one name: those are ONE creation (the first label by key makes it, the others share its
    -- id), as core's resolveScheduleRows coalesces them. `creator` marks the label whose row writes the record.
    CREATE TEMP TABLE _gi_div ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.division_key AS dkey, (array_agg(r.division_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused GROUP BY r.division_key
    ), j AS (
        SELECT k.dkey, k.label, d.action,
               CASE WHEN d.action = 'map' THEN
                   (SELECT dv.id FROM public.divisions dv
                     WHERE dv.id = d.ref_id AND dv.organization_id = v_org AND dv.season_settings_id = v_season) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k LEFT JOIN _gi_dec d ON d.kind = 'division' AND d.dkey = k.dkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.divisions dv
                    WHERE dv.organization_id = v_org AND dv.season_settings_id = v_season
                      AND public.normalise_external_label(dv.name) = public.normalise_external_label(j.cname))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.dkey, k3.label, k3.action, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref,
           COALESCE((SELECT dv.name FROM public.divisions dv WHERE dv.id = k3.existing_id), CASE WHEN k3.can_create THEN k3.final_cname END) AS final_name
      FROM k3;

    -- Venues (locations of the organization).
    CREATE TEMP TABLE _gi_venue ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.venue_key AS vkey, (array_agg(r.venue_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused AND r.status = 'ok' GROUP BY r.venue_key
    ), j AS (
        SELECT k.vkey, k.label, d.action,
               CASE WHEN d.action = 'map' THEN
                   (SELECT l.id FROM public.locations l WHERE l.id = d.ref_id AND l.organization_id = v_org) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k LEFT JOIN _gi_dec d ON d.kind = 'venue' AND d.dkey = k.vkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.locations l
                    WHERE l.organization_id = v_org AND public.normalise_external_label(l.name) = public.normalise_external_label(j.cname))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.vkey, k3.label, k3.action, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref
      FROM k3;

    -- Fields, judged inside their venue.
    CREATE TEMP TABLE _gi_field ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.field_key AS fkey, (array_agg(r.venue_key ORDER BY r.rowno))[1] AS vkey,
               (array_agg(r.field_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused AND r.status = 'ok' GROUP BY r.field_key
    ), j AS (
        SELECT k.fkey, k.vkey, k.label, d.action, v.ref AS venue_ref, v.existing_id AS venue_existing,
               CASE WHEN d.action = 'map' AND v.existing_id IS NOT NULL THEN
                   (SELECT f.id FROM public.fields f
                     WHERE f.id = d.ref_id AND f.organization_id = v_org AND f.location_id = v.existing_id) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k
          LEFT JOIN _gi_dec d ON d.kind = 'field' AND d.dkey = k.fkey
          LEFT JOIN _gi_venue v ON v.vkey = k.vkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND j.venue_ref IS NOT NULL
                AND NOT (j.venue_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.fields f
                    WHERE f.location_id = j.venue_existing AND public.normalise_external_label(f.name) = public.normalise_external_label(j.cname)))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.fkey, k3.vkey, k3.label, k3.action, k3.venue_ref, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref
      FROM k3;

    -- Teams, judged inside their division. kind: skip | existing | shell | ext-existing | ext-new | own-name | bad. Two labels
    -- that resolve to one new team (the same final name in the same resolved division) are ONE creation, shell or outside
    -- club, as core coalesces them; and an outside club whose name a shell created here already takes is the same refusal as
    -- one named like an own team (`own-name`), for UNIQUE (division_id, name) holds for both.
    CREATE TEMP TABLE _gi_team ON COMMIT DROP AS
    WITH keys AS (
        SELECT t.tkey, t.dkey, (array_agg(t.label ORDER BY t.rowno, t.side))[1] AS label
          FROM (SELECT r.home_key AS tkey, r.division_key AS dkey, r.home_label AS label, r.rowno, 1 AS side
                  FROM _gi_rows r WHERE NOT r.parse_refused
                UNION ALL
                SELECT r.away_key, r.division_key, r.away_label, r.rowno, 2
                  FROM _gi_rows r WHERE NOT r.parse_refused) t
         GROUP BY t.tkey, t.dkey
    ), j AS (
        SELECT k.tkey, k.dkey, k.label, d.action, d.ref_id, COALESCE(d.dname, k.label) AS cname,
               dv.ref AS division_ref, dv.existing_id AS division_existing
          FROM keys k
          LEFT JOIN _gi_dec d ON d.kind = 'team' AND d.dkey = k.tkey
          LEFT JOIN _gi_div dv ON dv.dkey = k.dkey
    ), k2 AS (
        SELECT j.*,
               CASE WHEN j.action = 'map' AND j.division_existing IS NOT NULL THEN
                   (SELECT t.id FROM public.teams t
                     WHERE t.id = j.ref_id AND t.organization_id = v_org AND t.division_id = j.division_existing) END AS map_id,
               (j.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                    WHERE t.division_id = j.division_existing AND NOT t.is_external
                      AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS own_named,
               (SELECT t.id FROM public.teams t
                 WHERE j.division_existing IS NOT NULL AND t.division_id = j.division_existing AND t.is_external
                   AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname) ORDER BY t.id LIMIT 1) AS ext_id,
               (j.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                    WHERE t.division_id = j.division_existing AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS name_taken,
               (j.action = 'outside' AND j.division_ref IS NOT NULL AND EXISTS (SELECT 1 FROM j j2
                    WHERE j2.action = 'create' AND j2.division_ref = j.division_ref AND public.normalise_external_label(j2.cname) = public.normalise_external_label(j.cname)
                      AND NOT (j2.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                                WHERE t.division_id = j2.division_existing AND public.normalise_external_label(t.name) = public.normalise_external_label(j2.cname))))) AS shell_here,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               CASE
                   WHEN k2.action = 'skip' THEN 'skip'
                   WHEN k2.action = 'map' AND k2.map_id IS NOT NULL THEN 'existing'
                   WHEN k2.action = 'create' AND k2.division_ref IS NOT NULL AND NOT k2.name_taken THEN 'shell'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL AND (k2.own_named OR k2.shell_here) THEN 'own-name'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL AND k2.ext_id IS NOT NULL THEN 'ext-existing'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL THEN 'ext-new'
                   ELSE 'bad'
               END AS kind
          FROM k2
    ), k4 AS (
        SELECT k3.*,
               first_value(k3.own_id) OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) AS new_id,
               first_value(k3.cname) OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) AS final_cname,
               (row_number() OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) = 1) AS creator
          FROM k3
    )
    SELECT k4.tkey, k4.dkey, k4.label, k4.action, k4.kind,
           CASE WHEN k4.kind IN ('shell', 'ext-new') THEN k4.final_cname ELSE k4.cname END AS cname, k4.division_ref, k4.new_id,
           (k4.kind IN ('shell', 'ext-new') AND k4.creator) AS creator,
           CASE k4.kind WHEN 'existing' THEN k4.map_id WHEN 'ext-existing' THEN k4.ext_id
                        WHEN 'shell' THEN k4.new_id WHEN 'ext-new' THEN k4.new_id END AS ref,
           (k4.kind IN ('ext-existing', 'ext-new')
            OR (k4.kind = 'existing' AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = k4.map_id AND t.is_external))) AS is_outside
      FROM k4;

    -- ------------------------------------------------------------------ 3. Each row, resolved, in the order core does it.
    CREATE TEMP TABLE _gi_res ON COMMIT DROP AS
    SELECT r.*,
           dv.ref AS division_ref, dv.final_name AS division_name, v.ref AS venue_ref, f.ref AS field_ref,
           th.ref AS home_ref, ta.ref AS away_ref, th.is_outside AS home_out, ta.is_outside AS away_out,
           CASE
               WHEN r.parse_refused THEN 'refused:' || r.parse_reason
               WHEN dv.action = 'skip' THEN 'skipped:division'
               WHEN dv.ref IS NULL THEN 'refused:unknown-division'
               WHEN r.status = 'ok' AND v.action = 'skip' THEN 'skipped:venue'
               WHEN r.status = 'ok' AND v.ref IS NULL THEN 'refused:unknown-venue'
               WHEN r.status = 'ok' AND f.action = 'skip' THEN 'skipped:field'
               WHEN r.status = 'ok' AND f.ref IS NULL THEN 'refused:unknown-field'
               WHEN th.kind = 'skip' THEN 'skipped:team'
               WHEN th.kind = 'own-name' THEN 'refused:label-is-own-team'
               WHEN th.ref IS NULL THEN 'refused:unknown-team'
               WHEN ta.kind = 'skip' THEN 'skipped:team'
               WHEN ta.kind = 'own-name' THEN 'refused:label-is-own-team'
               WHEN ta.ref IS NULL THEN 'refused:unknown-team'
               WHEN th.is_outside AND ta.is_outside THEN 'refused:unknown-team'
               WHEN th.ref = ta.ref THEN 'refused:same-team'
               ELSE 'ok'
           END AS outcome,
           CASE
               WHEN dv.action = 'skip' THEN r.division_label
               WHEN r.status = 'ok' AND v.action = 'skip' THEN r.venue_label
               WHEN r.status = 'ok' AND f.action = 'skip' THEN r.field_label
               WHEN th.kind = 'skip' THEN r.home_label
               WHEN ta.kind = 'skip' THEN r.away_label
           END AS skip_label
      FROM _gi_rows r
      LEFT JOIN _gi_div dv ON dv.dkey = r.division_key
      LEFT JOIN _gi_venue v ON v.vkey = r.venue_key AND r.status = 'ok'
      LEFT JOIN _gi_field f ON f.fkey = r.field_key AND r.status = 'ok'
      LEFT JOIN _gi_team th ON th.tkey = r.home_key AND th.dkey = r.division_key
      LEFT JOIN _gi_team ta ON ta.tkey = r.away_key AND ta.dkey = r.division_key;

    -- The same game twice by the admin's own mapping (two labels mapped onto one team): the first row wins. A TIME TBD
    -- game is one row per (home, away, week) in the table, so a second is refused as a duplicate too. Then one Game ID on
    -- two different games: the first wins.
    CREATE TEMP TABLE _gi_work ON COMMIT DROP AS
    SELECT x.*,
           CASE WHEN x.outcome = 'ok' AND x.dup_rank > 1 THEN 'refused:duplicate-row'
                WHEN x.outcome = 'ok' AND x.game_id IS NOT NULL AND x.gid_rank > 1 THEN 'refused:game-id-reused'
                ELSE x.outcome END AS final_outcome
      FROM (
        SELECT d.*,
               CASE WHEN d.outcome = 'ok' AND d.dup_rank = 1 AND d.game_id IS NOT NULL
                    THEN row_number() OVER (PARTITION BY d.game_id, (d.outcome = 'ok' AND d.dup_rank = 1) ORDER BY d.rowno) END AS gid_rank
          FROM (
            SELECT r.*,
                   CASE WHEN r.outcome = 'ok' THEN row_number() OVER (
                        PARTITION BY (r.outcome = 'ok'), CASE WHEN r.status = 'ok'
                                          THEN concat_ws('|', 'ok', r.home_ref, r.away_ref, r.field_ref, r.gdate, r.start_time)
                                          ELSE concat_ws('|', 'tbd', r.home_ref, r.away_ref, r.week_index) END
                        ORDER BY r.rowno) END AS dup_rank
              FROM _gi_res r) d) x;

    -- ------------------------------------------------------------------ 4. Placed games: the slot, the match, the verdict.
    CREATE TEMP TABLE _gi_g ON COMMIT DROP AS
    WITH base AS (
        SELECT w.rowno, w.row_key, w.game_id, w.home_ref, w.away_ref, w.field_ref, w.gdate, w.start_time, w.end_time,
               w.start_ts, w.end_ts, w.week_index, w.flags, w.division_ref, w.division_name,
               s.id AS slot_id, s.week_index AS slot_week,
               m.id AS match_id
          FROM _gi_work w
          LEFT JOIN LATERAL (SELECT gs.id, gs.week_index FROM public.game_slots gs
                              WHERE gs.organization_id = v_org AND gs.field_id = w.field_ref
                                AND gs.slot_date = w.gdate AND gs.start_time = w.start_time
                              ORDER BY gs.created_at, gs.id LIMIT 1) s ON true
          LEFT JOIN LATERAL (SELECT ga.id FROM public.game_assignments ga
                              WHERE ga.organization_id = v_org
                                AND CASE WHEN w.game_id IS NOT NULL
                                         THEN ga.season_settings_id = v_season AND ga.external_ref = w.game_id
                                         ELSE s.id IS NOT NULL AND ga.home_team_id = w.home_ref AND ga.away_team_id = w.away_ref
                                              AND ga.game_slot_id = s.id AND ga.week_index = w.week_index END
                              LIMIT 1) m ON true
         WHERE w.final_outcome = 'ok' AND w.status = 'ok'
    )
    SELECT b.*, ga.run_id AS m_run, ga.published AS m_published,
           (ga.id IS NOT NULL) AS matched,
           (ga.id IS NOT NULL
            AND ga.field_id IS NOT DISTINCT FROM b.field_ref AND ga.home_team_id = b.home_ref AND ga.away_team_id = b.away_ref
            AND ga.week_index IS NOT DISTINCT FROM b.week_index AND ga.start IS NOT DISTINCT FROM b.start_ts
            AND ga."end" IS NOT DISTINCT FROM b.end_ts AND ga.division IS NOT DISTINCT FROM b.division_name
            AND gsm.slot_date IS NOT DISTINCT FROM b.gdate AND gsm.start_time IS NOT DISTINCT FROM b.start_time) AS same,
           -- The game this row names stands on a place (home, away, slot, week) that is not the one the row puts it on: if the
           -- row is written, the game LEAVES its place. (A game that changes only its division label does not.)
           (ga.id IS NOT NULL
            AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
                IS DISTINCT FROM (b.home_ref, b.away_ref, b.slot_id, b.week_index)) AS leaves
      FROM base b
      LEFT JOIN public.game_assignments ga ON ga.id = b.match_id
      LEFT JOIN public.game_slots gsm ON gsm.id = ga.game_slot_id;

    -- TIME TBD games: a date and no time (the staged row has no instants, and a game with no field has no slot). A row is
    -- found by (season, Game ID) FIRST, in the table's own `external_ref`; a row with no Game ID, and a row whose Game ID
    -- no TIME TBD game carries yet but whose (home, away, week) one does that has no Game ID of its own, is found by the
    -- tuple, as the placed games are. `c_id` is another TIME TBD game that already holds the tuple this row would stand
    -- on (the table is unique on it): a different game, so the row is refused as a duplicate. `ga_id` is the placed game
    -- the row's Game ID names: the file now says it has no time.
    CREATE TEMP TABLE _gi_t ON COMMIT DROP AS
    SELECT w.rowno, w.row_key, w.game_id, w.home_ref, w.away_ref, w.week_index, w.division_ref, w.gdate, w.tbd_reason, w.flags,
           m.id AS m_id, m.external_ref AS m_ref, m.game_date AS m_date, m.week_index AS m_week, m.division_id AS m_div,
           m.home_team_id AS m_home, m.away_team_id AS m_away, m.reason AS m_reason,
           c.id AS c_id, a.id AS ga_id, gen_random_uuid() AS new_id
      FROM _gi_work w
      LEFT JOIN LATERAL (SELECT s.* FROM public.schedule_tbd s
                          WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'game'
                            AND ((w.game_id IS NOT NULL AND s.external_ref = w.game_id)
                                 OR (s.home_team_id = w.home_ref AND s.away_team_id = w.away_ref AND s.week_index = w.week_index
                                     AND (w.game_id IS NULL OR s.external_ref IS NULL)))
                          ORDER BY (s.external_ref IS NOT DISTINCT FROM w.game_id) DESC, s.id LIMIT 1) m ON true
      LEFT JOIN LATERAL (SELECT s.id FROM public.schedule_tbd s
                          WHERE s.season_settings_id = v_season AND s.kind = 'game'
                            AND s.home_team_id = w.home_ref AND s.away_team_id = w.away_ref AND s.week_index = w.week_index
                            AND s.id IS DISTINCT FROM m.id LIMIT 1) c ON true
      LEFT JOIN LATERAL (SELECT ga.id FROM public.game_assignments ga
                          WHERE w.game_id IS NOT NULL AND ga.organization_id = v_org AND ga.season_settings_id = v_season
                            AND ga.external_ref = w.game_id LIMIT 1) a ON true
     WHERE w.final_outcome = 'ok' AND w.status = 'tbd';

    -- The one predicate: a game is held where it is (F11-1's game_held_ids; F11-2 adds a score). The games a row names, a
    -- placed one or one a TIME TBD row would take out.
    SELECT COALESCE(array_agg(DISTINCT x.id), ARRAY[]::uuid[]) INTO v_held
      FROM (SELECT g.match_id AS id FROM _gi_g g UNION SELECT t.ga_id FROM _gi_t t) x WHERE x.id IS NOT NULL;
    v_held := ARRAY(SELECT public.game_held_ids(v_held));

    ALTER TABLE _gi_g ADD COLUMN verdict text, ADD COLUMN new_id uuid DEFAULT gen_random_uuid(), ADD COLUMN slot_final uuid, ADD COLUMN flagged text[],
                      ADD COLUMN tbd_id uuid, ADD COLUMN swapped_with uuid;
    UPDATE _gi_g g SET verdict = CASE
            WHEN NOT g.matched THEN 'insert'
            WHEN g.same THEN 'unchanged'
            WHEN g.match_id = ANY (v_held) THEN 'skip-held'
            ELSE 'update' END;

    -- The TIME TBD rows' verdicts. A placed game of the Game ID that is held (Published) is not taken out: the row is
    -- skipped, as a held game's row that changed is. Another game on the tuple refuses the row.
    ALTER TABLE _gi_t ADD COLUMN verdict text, ADD COLUMN conv boolean;
    UPDATE _gi_t t SET verdict = CASE
            WHEN t.ga_id IS NOT NULL AND t.ga_id = ANY (v_held) THEN 'skip-held'
            WHEN t.c_id IS NOT NULL THEN 'conflict'
            WHEN t.m_id IS NULL THEN 'insert'
            WHEN t.m_date IS NOT DISTINCT FROM t.gdate AND t.m_week = t.week_index AND t.m_div = t.division_ref
                 AND t.m_home = t.home_ref AND t.m_away = t.away_ref AND t.m_ref IS NOT DISTINCT FROM COALESCE(t.game_id, t.m_ref)
                 AND t.m_reason = 'imported-without-time' THEN 'unchanged'
            ELSE 'update' END;
    UPDATE _gi_t t SET conv = (t.ga_id IS NOT NULL AND t.verdict NOT IN ('skip-held', 'conflict'));

    -- Another game already stands on the place a row would put its game ((home, away, slot, week) is unique): that is a
    -- refusal of the row, the same word as a duplicate, UNLESS the game standing there is one the file itself moves away
    -- (a row that names it, and writes it, to another place): then the row is written after that game has left, and it is
    -- a warning, `games-swapped`. A game that moves is judged against the games the file does NOT move, so a row that
    -- cannot be written (its own place is taken) is not counted among the movers, and the rows that depended on it are
    -- judged again, until no row changes: collisions only ever grow, so this ends. A placed game the file now gives no time
    -- is taken out of the schedule, so it leaves its place too.
    LOOP
        UPDATE _gi_g g SET verdict = 'collision'
         WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.game_assignments g2
                        WHERE g2.home_team_id = g.home_ref AND g2.away_team_id = g.away_ref AND g2.game_slot_id = g.slot_id
                          AND g2.week_index = g.week_index AND g2.id IS DISTINCT FROM g.match_id
                          AND g2.id NOT IN (SELECT x.match_id FROM _gi_g x WHERE x.verdict = 'update' AND x.leaves)
                          AND g2.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        EXIT WHEN v_rc = 0;
    END LOOP;
    -- The rows that take the place of a game this file moves away, named for the warning.
    UPDATE _gi_g g SET swapped_with = (SELECT g2.id FROM public.game_assignments g2
                                        WHERE g2.home_team_id = g.home_ref AND g2.away_team_id = g.away_ref AND g2.game_slot_id = g.slot_id
                                          AND g2.week_index = g.week_index AND g2.id IS DISTINCT FROM g.match_id
                                          AND (g2.id IN (SELECT x.match_id FROM _gi_g x WHERE x.verdict = 'update' AND x.leaves)
                                               OR g2.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv))
                                        LIMIT 1)
     WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NOT NULL;

    -- A TIME TBD row the file now places: the game it names is written (a new or updated placed game) and the row goes.
    UPDATE _gi_g g SET tbd_id = (SELECT s.id FROM public.schedule_tbd s
                                  WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'game'
                                    AND ((g.game_id IS NOT NULL AND s.external_ref = g.game_id)
                                         OR (s.home_team_id = g.home_ref AND s.away_team_id = g.away_ref AND s.week_index = g.week_index
                                             AND (g.game_id IS NULL OR s.external_ref IS NULL)))
                                  ORDER BY (s.external_ref IS NOT DISTINCT FROM g.game_id) DESC, s.id LIMIT 1)
     WHERE g.verdict IN ('insert', 'update');

    -- New slots: one per place no slot stands on yet, among the rows that write (a skipped or unchanged game makes none).
    CREATE TEMP TABLE _gi_slotnew ON COMMIT DROP AS
    SELECT g.field_ref AS field_id, g.gdate, g.start_time,
           (array_agg(g.end_time ORDER BY g.rowno))[1] AS end_time,
           (array_agg(g.start_ts ORDER BY g.rowno))[1] AS start_ts,
           (array_agg(g.end_ts ORDER BY g.rowno))[1] AS end_ts,
           (array_agg(g.week_index ORDER BY g.rowno))[1] AS week_index,
           gen_random_uuid() AS new_id
      FROM _gi_g g
     WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NULL
     GROUP BY g.field_ref, g.gdate, g.start_time;
    UPDATE _gi_g g SET slot_final = COALESCE(g.slot_id, (SELECT s.new_id FROM _gi_slotnew s
                                                          WHERE s.field_id = g.field_ref AND s.gdate = g.gdate AND s.start_time = g.start_time))
     WHERE g.verdict IN ('insert', 'update');
    UPDATE _gi_g g SET flagged = g.flags
                         || CASE WHEN g.slot_id IS NOT NULL AND g.slot_week IS DISTINCT FROM g.week_index
                                  AND NOT ('week-differs' = ANY (g.flags)) THEN ARRAY['week-differs'] ELSE ARRAY[]::text[] END
     WHERE g.verdict IN ('insert', 'update');

    -- ------------------------------------------------------------------ 5. The schedule it makes, and what is carried.
    SELECT sr.id INTO v_prev_run
      FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'game' AND sr.status = 'completed'
       AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
     ORDER BY sr.completed_at DESC, sr.created_at DESC
     LIMIT 1;

    SELECT count(*) FILTER (WHERE verdict = 'insert'), count(*) FILTER (WHERE verdict = 'update'),
           count(*) FILTER (WHERE verdict = 'unchanged'), count(*) FILTER (WHERE verdict = 'skip-held')
      INTO n_ins, n_upd, n_unch, n_skip_pub
      FROM _gi_g;
    SELECT count(*) FILTER (WHERE verdict = 'insert'), count(*) FILTER (WHERE verdict = 'update'),
           count(*) FILTER (WHERE verdict = 'unchanged'), count(*) FILTER (WHERE verdict = 'conflict'),
           count(*) FILTER (WHERE verdict = 'skip-held'), count(*) FILTER (WHERE conv)
      INTO n_tbd_ins, n_tbd_upd, n_tbd_unch, n_tbd_conflict, n_tbd_held, n_conv
      FROM _gi_t;
    -- TIME TBD rows the file now places: one per row, however many placed rows name it.
    SELECT count(DISTINCT g.tbd_id) INTO n_tbd_rem FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.tbd_id IS NOT NULL
       AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged'));
    n_skip_pub := n_skip_pub + n_tbd_held;

    -- A matched game the file leaves as it is or skips, but that is not in the latest run, becomes visible again.
    SELECT count(*) INTO n_hidden FROM _gi_g g
     WHERE g.verdict IN ('unchanged', 'skip-held') AND g.m_run IS DISTINCT FROM v_prev_run;
    n_hidden := n_hidden + (SELECT count(*) FROM public.game_assignments ga
                             WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') AND ga.run_id IS DISTINCT FROM v_prev_run);
    v_work := n_ins + n_upd + n_tbd_ins + n_tbd_upd + n_tbd_rem + n_conv + n_hidden;
    v_nothing := (v_work = 0);

    -- Carried into the new run without a write to the game but its run: every game of the previous latest run that is
    -- not rewritten, and every hidden game the file found. Nothing is carried when there is nothing to apply.
    CREATE TEMP TABLE _gi_carry ON COMMIT DROP AS
    SELECT ga.id
      FROM public.game_assignments ga
     WHERE NOT v_nothing AND ga.organization_id = v_org
       AND ((v_prev_run IS NOT NULL AND ga.run_id = v_prev_run)
            OR ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict IN ('unchanged', 'skip-held'))
            OR ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held'))
       AND ga.id NOT IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update')
       AND ga.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
    SELECT count(*) INTO n_repoint FROM _gi_carry;

    -- The games the previous run held that no row of the file names (listed, never deleted).
    SELECT count(*), COALESCE(jsonb_agg(x.id ORDER BY x.id) FILTER (WHERE x.rn <= c_listed_ids), '[]'::jsonb)
      INTO n_not_in_file, v_not_in_file
      FROM (SELECT ga.id, row_number() OVER (ORDER BY ga.id) AS rn
              FROM public.game_assignments ga
             WHERE v_prev_run IS NOT NULL AND ga.organization_id = v_org AND ga.run_id = v_prev_run
               AND ga.id NOT IN (SELECT g.match_id FROM _gi_g g WHERE g.match_id IS NOT NULL AND g.verdict <> 'collision')
               AND ga.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.ga_id IS NOT NULL)) x;

    -- The schedule the new run holds, for the conflict flags: carried games as they are, rewritten ones as they will be,
    -- new ones as planned.
    CREATE TEMP TABLE _gi_final ON COMMIT DROP AS
    SELECT ga.id AS gid, NULL::text AS rkey, 'g:' || ga.id::text AS skey, ga.field_id, ga.start, ga."end" AS finish,
           ga.home_team_id AS home_id, ga.away_team_id AS away_id, ga.week_index, ga.division
      FROM public.game_assignments ga JOIN _gi_carry c ON c.id = ga.id
    UNION ALL
    SELECT g.match_id, g.row_key, 'g:' || g.match_id::text, g.field_ref, g.start_ts, g.end_ts, g.home_ref, g.away_ref, g.week_index, g.division_name
      FROM _gi_g g WHERE NOT v_nothing AND g.verdict = 'update'
    UNION ALL
    SELECT NULL::uuid, g.row_key, 'r:' || lpad(g.rowno::text, 8, '0'), g.field_ref, g.start_ts, g.end_ts, g.home_ref, g.away_ref, g.week_index, g.division_name
      FROM _gi_g g WHERE NOT v_nothing AND g.verdict = 'insert';

    -- ------------------------------------------------------------------ 6. What would be created, only what a written row uses.
    CREATE TEMP TABLE _gi_newgames ON COMMIT DROP AS
    SELECT g.division_ref, g.field_ref, g.home_ref, g.away_ref FROM _gi_g g WHERE g.verdict IN ('insert', 'update')
    UNION ALL
    SELECT t.division_ref, NULL, t.home_ref, t.away_ref FROM _gi_t t WHERE t.verdict IN ('insert', 'update');

    SELECT count(*) INTO n_div FROM _gi_div d WHERE d.creator AND d.new_id IN (SELECT division_ref FROM _gi_newgames);
    SELECT count(*) INTO n_fld FROM _gi_field f WHERE f.creator AND f.new_id IN (SELECT field_ref FROM _gi_newgames);
    SELECT count(*) INTO n_ven FROM _gi_venue v WHERE v.creator
       AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames));
    SELECT count(*) FILTER (WHERE t.kind = 'shell' AND t.creator), count(*) FILTER (WHERE t.kind = 'ext-new' AND t.creator) INTO n_shell, n_out
      FROM _gi_team t WHERE t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
    SELECT count(*) INTO n_slot_new FROM _gi_slotnew;
    SELECT count(DISTINCT g.slot_id) INTO n_slot_reused FROM _gi_g g
     WHERE g.verdict IN ('insert', 'update', 'unchanged') AND g.slot_id IS NOT NULL;

    -- ------------------------------------------------------------------ 7. The conflict flags the SQL can judge.
    -- The first overlap per field and per own team, as evaluateGameSchedule finds it: games sorted by start, each judged
    -- against the one before. An outside club merges several real teams, so it is never double-booked.
    v_warnings := '[]'::jsonb;
    IF NOT v_nothing THEN
        WITH seq AS (
            SELECT f.field_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division,
                   lag(f.gid) OVER w AS pgid, lag(f.rkey) OVER w AS prkey, lag(f.start) OVER w AS pstart,
                   lag(f.finish) OVER w AS pfinish, lag(f.week_index) OVER w AS pweek, lag(f.division) OVER w AS pdiv
              FROM _gi_final f
             WHERE f.field_id IS NOT NULL AND f.start IS NOT NULL AND f.finish IS NOT NULL
            WINDOW w AS (PARTITION BY f.field_id ORDER BY f.start, f.skey)
        ), first_overlap AS (
            SELECT DISTINCT ON (s.field_id) s.* FROM seq s WHERE s.pfinish IS NOT NULL AND s.start < s.pfinish
             ORDER BY s.field_id, s.start, s.skey
        ), sides AS (
            SELECT f.home_id AS team_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division FROM _gi_final f
            UNION ALL
            SELECT f.away_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division FROM _gi_final f
        ), tseq AS (
            SELECT s.team_id, s.gid, s.rkey, s.skey, s.start, s.finish, s.week_index, s.division,
                   lag(s.gid) OVER w AS pgid, lag(s.rkey) OVER w AS prkey, lag(s.start) OVER w AS pstart,
                   lag(s.finish) OVER w AS pfinish, lag(s.week_index) OVER w AS pweek, lag(s.division) OVER w AS pdiv
              FROM sides s
             WHERE s.start IS NOT NULL AND s.finish IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = s.team_id AND t.is_external)
               AND s.team_id NOT IN (SELECT t.ref FROM _gi_team t WHERE t.kind = 'ext-new')
            WINDOW w AS (PARTITION BY s.team_id ORDER BY s.start, s.skey)
        ), team_overlap AS (
            SELECT DISTINCT ON (t.team_id) t.* FROM tseq t WHERE t.pfinish IS NOT NULL AND t.start < t.pfinish
             ORDER BY t.team_id, t.start, t.skey
        ), flag_rows AS (
            SELECT g.rowno, g.row_key, g.game_id, g.gdate, fl AS flag
              FROM _gi_g g, LATERAL unnest(g.flagged) AS fl
             WHERE g.verdict IN ('insert', 'update')
            UNION ALL
            -- A TIME TBD game's week is judged against its date as a placed game's is: the file's week is kept, and said.
            SELECT t.rowno, t.row_key, t.game_id, t.gdate, fl
              FROM _gi_t t, LATERAL unnest(t.flags) AS fl
             WHERE t.verdict IN ('insert', 'update')
        )
        SELECT COALESCE(jsonb_agg(w.warning ORDER BY w.sort_type, w.sort_key), '[]'::jsonb) INTO v_warnings
          FROM (
            SELECT 1 AS sort_type, o.field_id::text AS sort_key,
                   jsonb_build_object('type', 'field-overlap', 'message', format('Field %s has overlapping games', o.field_id),
                       'details', jsonb_build_object('fieldId', o.field_id, 'conflicts', jsonb_build_array(
                           jsonb_build_object('gameId', o.pgid, 'rowKey', o.prkey, 'start', o.pstart, 'end', o.pfinish, 'weekIndex', o.pweek, 'division', o.pdiv),
                           jsonb_build_object('gameId', o.gid, 'rowKey', o.rkey, 'start', o.start, 'end', o.finish, 'weekIndex', o.week_index, 'division', o.division)))) AS warning
              FROM first_overlap o
            UNION ALL
            SELECT 2, o.team_id::text,
                   jsonb_build_object('type', 'team-double-booked', 'message', format('Team %s has overlapping games', o.team_id),
                       'details', jsonb_build_object('teamId', o.team_id, 'conflicts', jsonb_build_array(
                           jsonb_build_object('gameId', o.pgid, 'rowKey', o.prkey, 'start', o.pstart, 'end', o.pfinish, 'weekIndex', o.pweek, 'division', o.pdiv, 'teamId', o.team_id),
                           jsonb_build_object('gameId', o.gid, 'rowKey', o.rkey, 'start', o.start, 'end', o.finish, 'weekIndex', o.week_index, 'division', o.division, 'teamId', o.team_id))))
              FROM team_overlap o
            UNION ALL
            SELECT CASE fr.flag WHEN 'time-ambiguous' THEN 3 ELSE 4 END, lpad(fr.rowno::text, 8, '0'),
                   jsonb_build_object('type', fr.flag,
                       'message', CASE fr.flag WHEN 'time-ambiguous' THEN 'The clocks repeat this time on its date; the first occurrence was taken.'
                                               ELSE 'The week is not the week the date falls in.' END,
                       'details', jsonb_build_object('rowKey', fr.row_key, 'gameId', fr.game_id, 'date', fr.gdate))
              FROM flag_rows fr
            UNION ALL
            -- A game moved onto the place of a game this same file moves away (a swap, or a chain of moves): written, in an
            -- order the unique place allows, and said.
            SELECT 5, lpad(g.rowno::text, 8, '0'),
                   jsonb_build_object('type', 'games-swapped',
                       'message', 'This game takes the place of a game the file moves away: both are written.',
                       'details', jsonb_build_object('rowKey', g.row_key, 'gameId', g.game_id, 'takesPlaceOf', g.swapped_with))
              FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.swapped_with IS NOT NULL
            UNION ALL
            -- A placed game the file now says has no time: taken out, and a dated TIME TBD game stands for it.
            SELECT 6, lpad(t.rowno::text, 8, '0'),
                   jsonb_build_object('type', 'game-made-time-tbd',
                       'message', 'The file gives this game a date and no time: it is no longer placed, and stands on the TIME TBD list.',
                       'details', jsonb_build_object('rowKey', t.row_key, 'gameId', t.game_id, 'game', t.ga_id, 'date', t.gdate))
              FROM _gi_t t WHERE t.conv) w;
    END IF;

    -- ------------------------------------------------------------------ 8. The answer, from the plan.
    SELECT count(*) FILTER (WHERE final_outcome LIKE 'refused:%'), count(*) FILTER (WHERE final_outcome LIKE 'skipped:%'),
           count(*) FILTER (WHERE final_outcome = 'ok' AND status = 'ok'), count(*) FILTER (WHERE final_outcome = 'ok' AND status = 'tbd')
      INTO n_refused, n_skipped, n_ok, n_tbd
      FROM _gi_work;
    -- A placed row another game's place refuses is refused too (listed, counted, nothing written for it).
    n_refused := n_refused + (SELECT count(*) FROM _gi_g WHERE verdict = 'collision') + n_tbd_conflict;
    n_ok := n_ok - (SELECT count(*) FROM _gi_g WHERE verdict = 'collision');
    n_tbd := n_tbd - n_tbd_conflict;

    SELECT COALESCE(jsonb_object_agg(x.reason, x.n), '{}'::jsonb) INTO v_refused_by_reason
      FROM (SELECT z.reason, count(*) AS n FROM (
                SELECT substr(w.final_outcome, 9) AS reason FROM _gi_work w WHERE w.final_outcome LIKE 'refused:%'
                UNION ALL
                SELECT 'duplicate-row' FROM _gi_g g WHERE g.verdict = 'collision'
                UNION ALL
                SELECT 'duplicate-row' FROM _gi_t t WHERE t.verdict = 'conflict') z GROUP BY z.reason) x;

    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.rowno) FILTER (WHERE x.rn <= c_listed), '[]'::jsonb) INTO v_listed_refused
      FROM (SELECT z.rowno, z.item, row_number() OVER (ORDER BY z.rowno) AS rn FROM (
                SELECT w.rowno,
                       jsonb_build_object('row_number', w.rowno, 'row_key', w.row_key, 'reason', substr(w.final_outcome, 9),
                           'message', CASE substr(w.final_outcome, 9)
                               WHEN 'unknown-division' THEN 'The division ' || to_json(COALESCE(w.division_label, ''))::text || ' is not one of yours: map it to a division, create it, or skip its rows.'
                               WHEN 'unknown-venue' THEN 'The venue ' || to_json(COALESCE(w.venue_label, ''))::text || ' is not one of yours: map it to a venue, create it, or skip its rows.'
                               WHEN 'unknown-field' THEN 'The field ' || to_json(COALESCE(w.field_label, ''))::text || ' is not one of its venue''s: map it to a field, create it, or skip its rows.'
                               WHEN 'unknown-team' THEN CASE WHEN w.home_out AND w.away_out THEN 'Neither team is one of yours: both are outside clubs. A game needs at least one of your teams.'
                                                             ELSE 'A team of this row is not one of your teams in its division: map it to a team, create it, mark it an outside club, or skip its rows.' END
                               WHEN 'label-is-own-team' THEN 'A label was marked as an outside club, but the division has a team of that name: map it to that team instead.'
                               WHEN 'same-team' THEN 'The home and away teams were mapped to the same team.'
                               WHEN 'duplicate-row' THEN 'After mapping, this is the same game as an earlier row of the file; the earlier row is the one imported.'
                               WHEN 'game-id-reused' THEN 'The Game ID belongs to a different game earlier in the file.'
                               ELSE COALESCE(w.parse_message, 'The file check refused this row.') END) AS item
                  FROM _gi_work w WHERE w.final_outcome LIKE 'refused:%'
                UNION ALL
                SELECT g.rowno,
                       jsonb_build_object('row_number', g.rowno, 'row_key', g.row_key, 'reason', 'duplicate-row',
                           'message', 'A game this file does not move already stands on this place, and this row''s Game ID (or the lack of one) does not name it. Nothing is written for the row.')
                  FROM _gi_g g WHERE g.verdict = 'collision'
                UNION ALL
                SELECT t.rowno,
                       jsonb_build_object('row_number', t.rowno, 'row_key', t.row_key, 'reason', 'duplicate-row',
                           'message', 'Another TIME TBD game already holds this home team, away team and week, and this row''s Game ID (or the lack of one) does not name it. Nothing is written for the row.')
                  FROM _gi_t t WHERE t.verdict = 'conflict') z) x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('row_number', w.rowno, 'row_key', w.row_key,
                        'kind', substr(w.final_outcome, 9), 'label', w.skip_label) ORDER BY w.rowno)
                    FILTER (WHERE w.rn <= c_listed), '[]'::jsonb) INTO v_listed_skipped
      FROM (SELECT z.*, row_number() OVER (ORDER BY z.rowno) AS rn FROM _gi_work z WHERE z.final_outcome LIKE 'skipped:%') w;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('row_number', g.rowno, 'row_key', g.row_key, 'game_id', g.game_id,
                        'game', g.match_id, 'reason', c_skip_published) ORDER BY g.rowno) FILTER (WHERE g.rn <= c_listed), '[]'::jsonb)
      INTO v_listed_games
      FROM (SELECT z.rowno, z.row_key, z.game_id, z.match_id, row_number() OVER (ORDER BY z.rowno) AS rn
              FROM (SELECT g2.rowno, g2.row_key, g2.game_id, g2.match_id FROM _gi_g g2 WHERE g2.verdict = 'skip-held'
                    UNION ALL
                    SELECT t.rowno, t.row_key, t.game_id, t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') z) g;
    v_skipped_obj := CASE WHEN n_skip_pub > 0 THEN jsonb_build_object(c_skip_published, n_skip_pub) ELSE '{}'::jsonb END;

    v_result := jsonb_build_object(
        'dry_run', v_dry,
        'job_id', p_import_job_id,
        'season_settings_id', v_season,
        'arrive_published', v_arrive,
        'rows', jsonb_build_object('staged', n_staged, 'refused', n_refused, 'skipped', n_skipped, 'games', n_ok, 'time_tbd', n_tbd),
        'refused_by_reason', v_refused_by_reason,
        'games', jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'unchanged', n_unch, 'repointed', n_repoint,
                                    'skipped', v_skipped_obj),
        'time_tbd', jsonb_build_object('inserted', n_tbd_ins, 'updated', n_tbd_upd, 'unchanged', n_tbd_unch, 'removed', n_tbd_rem,
                                       'converted', n_conv),
        'created', jsonb_build_object('divisions', n_div, 'venues', n_ven, 'fields', n_fld, 'teams', n_shell,
                                      'outside_teams', n_out, 'slots', n_slot_new),
        'reused', jsonb_build_object('slots', n_slot_reused),
        'not_in_file', jsonb_build_object('count', n_not_in_file, 'ids', v_not_in_file),
        'nothing_to_apply', v_nothing,
        'warnings', v_warnings,
        'not_judged', jsonb_build_array('coach-conflict', 'home-away-imbalance'),
        'listed', jsonb_build_object('refused', v_listed_refused, 'skipped', v_listed_skipped, 'skipped_games', v_listed_games),
        'ids', v_ids);

    IF v_dry THEN
        RETURN v_result;
    END IF;

    -- ------------------------------------------------------------------ 9. The writes, in order, each counted against the plan.
    IF NOT v_nothing THEN
        -- The before-images of every game the run change or the rewrite touches (a rollback puts them back).
        CREATE TEMP TABLE _gi_before ON COMMIT DROP AS
        SELECT ga.id, to_jsonb(ga) AS img FROM public.game_assignments ga
         WHERE ga.id IN (SELECT id FROM _gi_carry) OR ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update');
        -- The before-images of the TIME TBD rows the file changes or removes (a rollback puts them back).
        CREATE TEMP TABLE _gi_tbefore ON COMMIT DROP AS
        SELECT s.id, to_jsonb(s) AS img, (s.id IN (SELECT t.m_id FROM _gi_t t WHERE t.verdict = 'update')) AS changed
          FROM public.schedule_tbd s
         WHERE s.id IN (SELECT t.m_id FROM _gi_t t WHERE t.verdict = 'update')
            OR s.id IN (SELECT g.tbd_id FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.tbd_id IS NOT NULL
                           AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged')));

        -- Divisions, venues, fields.
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
        SELECT d.new_id, v_org, v_season, d.cname FROM _gi_div d
         WHERE d.creator AND d.new_id IN (SELECT division_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_div THEN RAISE EXCEPTION 'game import planned % divisions and wrote %', n_div, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'divisions', dv.id, 'inserted', NULL, to_jsonb(dv), v_now, v_uid
          FROM public.divisions dv WHERE dv.id IN (SELECT d.new_id FROM _gi_div d WHERE d.can_create AND d.new_id IN (SELECT division_ref FROM _gi_newgames));

        INSERT INTO public.locations (id, organization_id, name)
        SELECT v.new_id, v_org, v.cname FROM _gi_venue v
         WHERE v.creator AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_ven THEN RAISE EXCEPTION 'game import planned % venues and wrote %', n_ven, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'locations', l.id, 'inserted', NULL, to_jsonb(l), v_now, v_uid
          FROM public.locations l WHERE l.id IN (SELECT v.new_id FROM _gi_venue v WHERE v.can_create
               AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames)));

        INSERT INTO public.fields (id, organization_id, location_id, name)
        SELECT f.new_id, v_org, f.venue_ref, f.cname FROM _gi_field f
         WHERE f.creator AND f.new_id IN (SELECT field_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_fld THEN RAISE EXCEPTION 'game import planned % fields and wrote %', n_fld, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'fields', f.id, 'inserted', NULL, to_jsonb(f), v_now, v_uid
          FROM public.fields f WHERE f.id IN (SELECT x.new_id FROM _gi_field x WHERE x.can_create AND x.new_id IN (SELECT field_ref FROM _gi_newgames));

        -- Team shells, through the audited team writer, in ONE team run for the whole apply. The Teams, Practices and Games
        -- pages read the LATEST team run (`mapSchedulerRunToSummary` reads `results.teamsByDivision`), so the run is the
        -- latest completed run's results carried forward whole (every key, every division it names) with each division's
        -- shells added to the division: a run of only the new shells, or of one division, would make every other team look
        -- absent, and one run in the keys `TEAM_RUN_RESULT_KEYS` (packages/core/src/utils/teamRunResults.js, which the mock
        -- uses; tests/gameImportTeamRunShape.test.js holds this text to that list) carries what the readers read. A division
        -- is grouped under the key the carried run already uses for it (its id, its name, or the key of a group whose teams
        -- carry its id), else under its name; a division no saved run names is seeded with its own teams as the table has
        -- them (an outside club is not one).
        SELECT COALESCE(array_agg(t.new_id ORDER BY t.new_id), ARRAY[]::uuid[]) INTO v_shell_arr
          FROM _gi_team t
         WHERE t.kind = 'shell' AND t.creator AND t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
        IF cardinality(v_shell_arr) > 0 THEN
            SELECT sr.results INTO v_base
              FROM public.scheduler_runs sr
             WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.status = 'completed'
               AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
             ORDER BY sr.created_at DESC, sr.id DESC
             LIMIT 1;
            IF jsonb_typeof(v_base) IS DISTINCT FROM 'object' THEN v_base := '{}'::jsonb; END IF;
            IF jsonb_typeof(v_base -> 'teamsByDivision') = 'object' THEN
                SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END), '{}'::jsonb)
                  INTO v_grouped FROM jsonb_each(v_base -> 'teamsByDivision') e;
            ELSIF jsonb_typeof(v_base -> 'teams') = 'array' THEN
                SELECT COALESCE(jsonb_object_agg(g.k, g.arr), '{}'::jsonb) INTO v_grouped
                  FROM (SELECT COALESCE(NULLIF(et ->> 'division', ''), NULLIF(et ->> 'division_id', ''), 'Unassigned') AS k,
                               jsonb_agg(et ORDER BY x.ord) AS arr
                          FROM jsonb_array_elements(v_base -> 'teams') WITH ORDINALITY AS x(et, ord) GROUP BY 1) g;
            ELSE
                v_grouped := '{}'::jsonb;
            END IF;
            FOR v_div IN
                SELECT t.division_ref,
                       (SELECT d.final_name FROM _gi_div d WHERE d.ref = t.division_ref ORDER BY d.dkey LIMIT 1) AS dname
                  FROM _gi_team t
                 WHERE t.kind = 'shell' AND t.creator AND t.new_id = ANY (v_shell_arr)
                 GROUP BY t.division_ref
                 ORDER BY t.division_ref
            LOOP
                SELECT e.key INTO v_key
                  FROM jsonb_each(v_grouped) e
                 WHERE lower(e.key) = lower(v_div.division_ref::text) OR e.key = v_div.dname
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.value) et
                                WHERE lower(COALESCE(et ->> 'division_id', et ->> 'divisionId', '')) = lower(v_div.division_ref::text))
                 ORDER BY e.key COLLATE "C"
                 LIMIT 1;
                IF v_key IS NULL THEN
                    v_key := v_div.dname;
                    v_grouped := v_grouped || jsonb_build_object(v_key, COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'division', v_key, 'division_id', v_div.division_ref,
                                   'coachId', t.coach_id, 'assistantCoachIds', to_jsonb(COALESCE(t.assistant_coach_ids, '{}'::uuid[])),
                                   'players', '[]'::jsonb) ORDER BY t.name, t.id)
                          FROM public.teams t
                         WHERE t.division_id = v_div.division_ref AND NOT t.is_external AND t.id <> ALL (v_shell_arr)), '[]'::jsonb));
                END IF;
                v_label := COALESCE(NULLIF(v_grouped -> v_key -> 0 ->> 'division', ''), v_key);
                v_grouped := jsonb_set(v_grouped, ARRAY[v_key], (v_grouped -> v_key) || COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', t.new_id, 'name', t.cname, 'division', v_label, 'division_id', v_div.division_ref,
                               'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb) ORDER BY t.cname, t.new_id)
                      FROM _gi_team t
                     WHERE t.kind = 'shell' AND t.creator AND t.division_ref = v_div.division_ref AND t.new_id = ANY (v_shell_arr)), '[]'::jsonb));
            END LOOP;
            v_results := v_base || jsonb_build_object(
                'teamsByDivision', v_grouped,
                'teams', COALESCE((SELECT jsonb_agg(x.team) FROM jsonb_each(v_grouped) e, jsonb_array_elements(e.value) AS x(team)), '[]'::jsonb),
                'team_players', CASE WHEN jsonb_typeof(v_base -> 'team_players') = 'array' THEN v_base -> 'team_players' ELSE '[]'::jsonb END);
            v_team_run := public.persist_team_schedule(
                jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'team', 'status', 'completed',
                    'completed_at', clock_timestamp(),
                    'parameters', jsonb_build_object('source', 'import', 'import_job_id', p_import_job_id, 'shell_ids', to_jsonb(v_shell_arr)),
                    'results', v_results),
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.new_id, 'division_id', t.division_ref, 'name', t.cname) ORDER BY t.new_id), '[]'::jsonb)
                   FROM _gi_team t WHERE t.kind = 'shell' AND t.creator AND t.new_id = ANY (v_shell_arr)),
                '[]'::jsonb);
            v_team_runs := v_team_runs || to_jsonb(v_team_run);
        END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'teams', t.id, 'inserted', NULL, to_jsonb(t), v_now, v_uid
          FROM public.teams t WHERE t.id IN (SELECT x.new_id FROM _gi_team x WHERE x.kind = 'shell'
               AND x.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_shell THEN RAISE EXCEPTION 'game import planned % team shells and wrote %', n_shell, v_rc USING ERRCODE = 'XX000'; END IF;

        -- Outside clubs: team rows flagged is_external, in NO team run.
        INSERT INTO public.teams (id, organization_id, division_id, name, is_external)
        SELECT t.new_id, v_org, t.division_ref, t.cname, true FROM _gi_team t
         WHERE t.kind = 'ext-new' AND t.creator AND t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_out THEN RAISE EXCEPTION 'game import planned % outside clubs and wrote %', n_out, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'teams', t.id, 'inserted', NULL, to_jsonb(t), v_now, v_uid
          FROM public.teams t WHERE t.is_external AND t.id IN (SELECT x.new_id FROM _gi_team x WHERE x.kind = 'ext-new'
               AND x.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames));

        -- Slots.
        INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity)
        SELECT s.new_id, v_org, s.field_id, s.start_ts, s.end_ts, s.gdate, s.start_time, s.end_time, s.week_index, 1 FROM _gi_slotnew s;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_slot_new THEN RAISE EXCEPTION 'game import planned % slots and wrote %', n_slot_new, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_slots', gs.id, 'inserted', NULL, to_jsonb(gs), v_now, v_uid
          FROM public.game_slots gs WHERE gs.id IN (SELECT new_id FROM _gi_slotnew);

        -- The run: made last of the structure, first of the games, so every game can name it.
        INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, metrics, results,
                                           created_by, started_at, completed_at, created_at)
        VALUES (v_run_id, v_org, v_season, v_season, 'game', 'completed',
                jsonb_build_object('source', 'import', 'import_job_id', p_import_job_id, 'arrive_published', v_arrive,
                                   'previous_run_id', v_prev_run),
                '{}'::jsonb,
                jsonb_build_object('summary', jsonb_build_object('totalAssignments', n_ins + n_upd + n_repoint, 'source', 'import'),
                                   'warnings', v_warnings, 'unscheduled', '[]'::jsonb, 'not_judged', jsonb_build_array('coach-conflict', 'home-away-imbalance'),
                                   'import_job_id', p_import_job_id),
                v_uid, clock_timestamp(), clock_timestamp(), clock_timestamp());

        -- Placed games the file now says have no time are taken out (a dated TIME TBD game stands for each, below). Only a
        -- game that is not held is here (a held one was skipped), and its image is kept so a rollback can put it back.
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', ga.id, 'deleted', to_jsonb(ga), '{}'::jsonb, v_now, v_uid
          FROM public.game_assignments ga WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
        DELETE FROM public.game_assignments ga WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_conv THEN RAISE EXCEPTION 'game import planned % games made TIME TBD and removed %', n_conv, v_rc USING ERRCODE = 'XX000'; END IF;

        -- Room is made first (as `persist_game_schedule` makes it, 20261120010000): the unique place (home, away, slot, week) is
        -- not deferrable, so a game that leaves a place another row of this file is about to take would meet that row in the
        -- index whichever is written first. A game that moves, and whose place a row of the file takes, is taken out of the
        -- index (its slot set null for the length of this apply) and given its final place by the update below, in this
        -- transaction. The clashes with games the file does NOT move were refused in the plan, so no game ends where another is.
        UPDATE public.game_assignments ga SET game_slot_id = NULL, slot_id = NULL
         WHERE ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update' AND g.leaves)
           AND EXISTS (SELECT 1 FROM _gi_g h
                        WHERE h.verdict IN ('insert', 'update') AND h.slot_final = ga.game_slot_id
                          AND h.home_ref = ga.home_team_id AND h.away_ref = ga.away_team_id AND h.week_index = ga.week_index);

        -- New games, Published when the job says so (decision 4).
        INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id,
                                             away_team_id, division, week_index, start, "end", external_ref, import_job_id,
                                             published, published_at, published_by)
        SELECT g.new_id, v_org, v_season, v_run_id, g.slot_final, g.slot_final, g.field_ref, g.home_ref, g.away_ref, g.division_name,
               g.week_index, g.start_ts, g.end_ts, g.game_id, p_import_job_id,
               v_arrive, CASE WHEN v_arrive THEN v_now END, CASE WHEN v_arrive THEN v_uid END
          FROM _gi_g g WHERE g.verdict = 'insert';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_ins THEN RAISE EXCEPTION 'game import planned % games and wrote %', n_ins, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', ga.id, 'inserted', NULL, to_jsonb(ga), v_now, v_uid
          FROM public.game_assignments ga WHERE ga.id IN (SELECT new_id FROM _gi_g WHERE verdict = 'insert');
        SELECT COALESCE(array_agg(g.new_id ORDER BY g.new_id), ARRAY[]::uuid[]) INTO v_published_ids FROM _gi_g g WHERE g.verdict = 'insert' AND v_arrive;

        -- Games changed in place, by id: a held game is never here (it was skipped).
        UPDATE public.game_assignments ga
           SET game_slot_id = g.slot_final, slot_id = g.slot_final, field_id = g.field_ref, home_team_id = g.home_ref, away_team_id = g.away_ref,
               division = g.division_name, week_index = g.week_index, start = g.start_ts, "end" = g.end_ts,
               run_id = v_run_id, import_job_id = p_import_job_id
          FROM _gi_g g
         WHERE g.verdict = 'update' AND ga.id = g.match_id;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_upd THEN RAISE EXCEPTION 'game import planned % game updates and wrote %', n_upd, v_rc USING ERRCODE = 'XX000'; END IF;

        -- The rest of the previous schedule, and the hidden games the file found, are carried into the new run.
        UPDATE public.game_assignments ga SET run_id = v_run_id WHERE ga.id IN (SELECT id FROM _gi_carry);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_repoint THEN RAISE EXCEPTION 'game import planned % carried games and moved %', n_repoint, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', b.id, 'updated', b.img, to_jsonb(ga), v_now, v_uid
          FROM _gi_before b JOIN public.game_assignments ga ON ga.id = b.id;

        -- TIME TBD games: a DATE and no time (`game_date`), the Game ID in `external_ref`. A row the file names is changed in
        -- place; one the file now places is removed (the placed game stands for it); a new one is inserted. Every one has an
        -- application record, with the image it had, so the rollback puts it back.
        UPDATE public.schedule_tbd s
           SET division_id = t.division_ref, home_team_id = t.home_ref, away_team_id = t.away_ref, week_index = t.week_index::smallint,
               external_ref = COALESCE(t.game_id, s.external_ref), game_date = t.gdate, reason = 'imported-without-time',
               detail = jsonb_strip_nulls(jsonb_build_object('game_id', COALESCE(t.game_id, s.external_ref), 'import_job_id', p_import_job_id)),
               run_id = v_run_id
          FROM _gi_t t WHERE t.verdict = 'update' AND s.id = t.m_id;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_upd THEN RAISE EXCEPTION 'game import planned % TIME TBD updates and wrote %', n_tbd_upd, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', s.id, 'updated', b.img, to_jsonb(s), v_now, v_uid
          FROM _gi_tbefore b JOIN public.schedule_tbd s ON s.id = b.id WHERE b.changed;
        DELETE FROM public.schedule_tbd s WHERE s.id IN (SELECT b.id FROM _gi_tbefore b WHERE NOT b.changed);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_rem THEN RAISE EXCEPTION 'game import planned % TIME TBD removals and made %', n_tbd_rem, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', b.id, 'deleted', b.img, '{}'::jsonb, v_now, v_uid
          FROM _gi_tbefore b WHERE NOT b.changed;
        INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index,
                                         reason, detail, run_id, external_ref, game_date)
        SELECT t.new_id, v_org, v_season, 'game', t.division_ref, t.home_ref, t.away_ref, t.week_index::smallint, 'imported-without-time',
               jsonb_strip_nulls(jsonb_build_object('game_id', t.game_id, 'import_job_id', p_import_job_id)), v_run_id, t.game_id, t.gdate
          FROM _gi_t t WHERE t.verdict = 'insert';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_ins THEN RAISE EXCEPTION 'game import planned % TIME TBD games and wrote %', n_tbd_ins, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', s.id, 'inserted', NULL, to_jsonb(s), v_now, v_uid
          FROM public.schedule_tbd s WHERE s.id IN (SELECT t.new_id FROM _gi_t t WHERE t.verdict = 'insert');

        v_ids := jsonb_build_object('run_id', v_run_id, 'team_run_ids', v_team_runs);
    END IF;

    v_result := v_result || jsonb_build_object('ids', v_ids);
    v_status := CASE WHEN n_refused > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- The audit rows, in this transaction. A failed write rolls the apply back; SLA01 tells the caller it was the audit.
    BEGIN
        PERFORM public.record_audit_event(v_org, 'import.completed', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'games', 'job_type', 'games', 'season_settings_id', v_season, 'status', v_status,
                               'rows', v_result -> 'rows', 'games', v_result -> 'games', 'time_tbd', v_result -> 'time_tbd',
                               'created', v_result -> 'created', 'reused', v_result -> 'reused',
                               'nothing_to_apply', v_nothing, 'arrive_published', v_arrive));
        IF cardinality(v_published_ids) > 0 THEN
            PERFORM public.record_audit_event(v_org, 'game.published_set', 'game_assignment', NULL,
                jsonb_build_object('published', true, 'scope', jsonb_build_object('kind', 'import', 'value', p_import_job_id::text),
                                   'count', cardinality(v_published_ids), 'unchanged', 0, 'ids', to_jsonb(v_published_ids)));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    UPDATE public.staging_import_rows SET applied_at = v_now, applied_by = v_uid
     WHERE import_job_id = p_import_job_id AND organization_id = v_org AND import_type = 'games';
    UPDATE public.import_jobs
       SET status = v_status, processed_rows = n_staged, progress_percent = 100, completed_at = v_now,
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{game_import}', v_result, true)
     WHERE id = p_import_job_id;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_game_import_job(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_game_import_job(uuid, boolean) TO authenticated;
COMMENT ON FUNCTION public.apply_game_import_job(uuid, boolean) IS
    'Admin-only, signed in: the preview (p_dry_run, writes nothing) and the apply of a games import. Resolves each staged row through the job''s mapping; updates a game found by (season, Game ID) in place by its id, hidden rows included; never matches a row that has a Game ID by its tuple; skips a held (Published) game whose row changed (skipped-published); stores a conflicting file and flags it; creates the divisions, venues, fields, team shells (through the team writer, in team runs) and outside clubs (is_external, in no run) a written game uses; makes one new game run holding the whole schedule when anything is written, and none when nothing would change. Writes a swap (a game moved onto the place another game of the file leaves) with the warning games-swapped, converts a placed game the file gives no time (game-made-time-tbd), and holds a TIME TBD game''s date and Game ID. Audited import.completed and game.published_set. A finished job answers with its stored result. The apply plans again against the state it finds, so its counts can differ from an earlier preview''s if a game changed in between: the result reports what was done. 20261121010000.';


-- ---------------------------------------------------------------------------
-- 8. rollback_game_import_job: take an import back, or say what stands in the way.
-- ---------------------------------------------------------------------------
--
-- Every record the rollback acts on is first compared with what stands now, because the apply's own writes are not the only
-- ones: another import, a save or an admin may have touched the row since (the class of defect Codex found twice in this PR:
-- a permit scope on a field the import made, then a correction to a TIME TBD game it inserted).
--
--   * A PLACED game (inserted, changed in place, or only carried into the run) must still be there, equal to the image the
--     apply stored (where, when, who plays, Published, the Game ID) and still in the import's run; a game the apply took out
--     must still be out. A TIME TBD game must still equal the image the apply stored (an inserted or changed one) or still be
--     absent (a removed one). Otherwise the rollback REFUSES, writing nothing, naming up to 50 of each (22023,
--     `game_import_changed count=<both> ids=<placed games> [tbd_ids=<TIME TBD games>]`). This is a refusal and not a
--     warning because it is the one place a rollback would destroy another import's or an admin's work (the owner's rule is
--     warnings over blockers EXCEPT where necessary; here it is necessary): the fix is to roll the later change back first.
--   * A division, venue, field, outside club, team shell or slot the import CREATED is deleted only when nothing references
--     it AND it is still the row the apply stored (a rename, an address, a coach: later work). Otherwise it is KEPT and
--     named in `kept`, never deleted silently, never a refusal.
--   * The import's runs are deleted only when nothing else names them (a game or TIME TBD game saved into one since, an
--     evaluation of it); a run that stays is named in `kept` too.
--
-- Otherwise it names the job in a transaction-local setting, which the Published guard honours only for these rows (see
-- the guard), deletes what the import inserted, puts back what it updated (its run included), puts back the games and TIME
-- TBD rows it took out, and removes what it created as above. Audited import.rolled_back. The legacy `games` table is not
-- read or written (a slot or team the import made has no row there). The pgTAP file game_import_rollback_class.sql derives
-- the (table, operation) pairs the apply writes from the apply's source and fails unless every one has a scenario in which a
-- later writer changes the record and the rollback refuses or keeps it without losing what that writer did.

CREATE FUNCTION public.rollback_game_import_job(p_import_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_listed constant integer := 50;
    v_uid uuid := auth.uid();
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season_status text;
    v_run uuid;
    v_pending integer;
    v_changed uuid[];
    v_changed_tbd uuid[];
    n_games_deleted bigint := 0; n_games_restored bigint := 0; n_games_reinserted bigint := 0; n_tbd bigint := 0; n_tbd_restored bigint := 0;
    n_tbd_reinserted bigint := 0; n_tbd_not_reinserted bigint := 0; n_slots bigint := 0;
    n_teams bigint := 0; n_fields bigint := 0; n_venues bigint := 0; n_divs bigint := 0; n_team_runs bigint := 0;
    v_kept jsonb := '[]'::jsonb;
    v_result jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'rollback_game_import_job needs a signed-in caller to audit the rollback' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'games' THEN
        RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;

    -- The game writers' lock, then the season writers' (as the apply takes them), before anything is read as it stands.
    PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    SELECT s.status INTO v_season_status FROM public.season_settings s
     WHERE s.id = v_job.season_settings_id AND s.organization_id = v_org;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed: its games are read-only', v_job.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    SELECT count(*) INTO v_pending FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.rolled_back_at IS NULL;
    IF v_pending = 0 THEN
        RAISE EXCEPTION 'Import job % has no games application records to roll back', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'nothing_to_roll_back';
    END IF;

    SELECT sr.id INTO v_run FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'game' AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
     LIMIT 1;

    -- What changed since: judged BEFORE anything is written. A game of the job that is gone, differs from the image the
    -- apply stored, or is in another run than the import's.
    SELECT COALESCE(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_changed
      FROM (SELECT r.target_id AS id
              FROM public.import_application_records r
              LEFT JOIN public.game_assignments ga ON ga.id = r.target_id
             WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'game_assignments'
               AND r.rolled_back_at IS NULL
               AND CASE WHEN r.operation = 'deleted'
                        -- A game the apply took out is still out: one that stands again would be put back twice.
                        THEN ga.id IS NOT NULL
                        ELSE ga.id IS NULL
                             OR public.game_import_image(to_jsonb(ga)) IS DISTINCT FROM public.game_import_image(r.applied_payload)
                             OR ga.run_id IS DISTINCT FROM v_run END) x;
    -- The same for the TIME TBD games of the job (Codex on 305137b: they were deleted, restored and put back with no
    -- comparison, so rolling import A back deleted the correction import B had made to a game A inserted). One that the
    -- apply inserted or changed must still be there and equal what the apply left (it is not the image from before the
    -- apply that counts: that is what the rollback puts back); one the apply removed must still be absent by its id. A
    -- removed row whose tuple or Game ID another row now holds is NOT a refusal: that row is someone else's, nothing of
    -- theirs is lost, and the rollback counts the row it cannot put back (time_tbd_not_reinserted) and says so.
    SELECT COALESCE(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_changed_tbd
      FROM (SELECT r.target_id AS id
              FROM public.import_application_records r
              LEFT JOIN public.schedule_tbd s ON s.id = r.target_id
             WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'schedule_tbd'
               AND r.rolled_back_at IS NULL
               AND CASE WHEN r.operation = 'deleted'
                        THEN s.id IS NOT NULL
                        ELSE s.id IS NULL OR NOT public.game_import_row_unchanged(to_jsonb(s), r.applied_payload) END) x;
    IF cardinality(v_changed) + cardinality(v_changed_tbd) > 0 THEN
        RAISE EXCEPTION 'The import cannot be rolled back: % game(s) (placed or TIME TBD) it wrote were changed, cancelled, had changes allowed or were saved into a later run since',
                        cardinality(v_changed) + cardinality(v_changed_tbd)
            USING ERRCODE = '22023',
                  DETAIL = format('game_import_changed count=%s ids=%s', cardinality(v_changed) + cardinality(v_changed_tbd),
                                  array_to_string((SELECT array_agg(c ORDER BY c) FROM (SELECT c FROM unnest(v_changed) c ORDER BY c LIMIT c_listed) q), ','))
                           || CASE WHEN cardinality(v_changed_tbd) = 0 THEN ''
                                   ELSE format(' tbd_ids=%s', array_to_string((SELECT array_agg(c ORDER BY c) FROM (SELECT c FROM unnest(v_changed_tbd) c ORDER BY c LIMIT c_listed) q), ','))
                              END;
    END IF;

    -- The guard's rollback exemption names this job, for the length of this transaction only.
    PERFORM set_config('squadlogic.import_rollback', p_import_job_id::text, true);

    -- Games: what the import inserted goes (frees the places), what it changed in place or only carried is put back.
    DELETE FROM public.game_assignments ga USING public.import_application_records r
     WHERE r.target_id = ga.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_assignments' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_games_deleted = ROW_COUNT;

    -- Games the apply moved are put back. Two games that swapped places meet in the unique place if each is put back in turn, so
    -- a game that is not where it was is first taken out of the index (its slot set null), as the apply took it, and then
    -- given its own place back; none of them is held (a held one has changed since, and the pre-check above refused).
    UPDATE public.game_assignments ga SET game_slot_id = NULL, slot_id = NULL
      FROM public.import_application_records r
     WHERE r.target_id = ga.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_assignments' AND r.operation = 'updated' AND r.rolled_back_at IS NULL
       AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
           IS DISTINCT FROM ((r.previous_payload ->> 'home_team_id')::uuid, (r.previous_payload ->> 'away_team_id')::uuid,
                             (r.previous_payload ->> 'game_slot_id')::uuid, (r.previous_payload ->> 'week_index')::smallint);
    UPDATE public.game_assignments ga
       SET game_slot_id = (r.previous_payload ->> 'game_slot_id')::uuid,
           slot_id = (r.previous_payload ->> 'slot_id')::uuid,
           field_id = (r.previous_payload ->> 'field_id')::uuid,
           home_team_id = (r.previous_payload ->> 'home_team_id')::uuid,
           away_team_id = (r.previous_payload ->> 'away_team_id')::uuid,
           division = r.previous_payload ->> 'division',
           week_index = (r.previous_payload ->> 'week_index')::smallint,
           start = (r.previous_payload ->> 'start')::timestamptz,
           "end" = (r.previous_payload ->> 'end')::timestamptz,
           run_id = (r.previous_payload ->> 'run_id')::uuid,
           import_job_id = (r.previous_payload ->> 'import_job_id')::uuid
      FROM public.import_application_records r
     WHERE r.target_id = ga.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_assignments' AND r.operation = 'updated' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_games_restored = ROW_COUNT;

    -- Games the apply took out (the file gave them no time) stand again, as they were: after the games the import inserted
    -- have gone and the moved ones are back, so the places are free, and before the slots are judged.
    INSERT INTO public.game_assignments
    SELECT (jsonb_populate_record(NULL::public.game_assignments, r.previous_payload)).*
      FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'game_assignments'
       AND r.operation = 'deleted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_games_reinserted = ROW_COUNT;

    -- TIME TBD games: what the import inserted goes, what it changed in place is put back, and what it removed (the file
    -- placed the game) is put back. A removed row whose place in the table has been taken (the table is unique on a Game ID
    -- and on the home team, away team and week) cannot be put back: it is counted and said, never skipped in silence.
    DELETE FROM public.schedule_tbd s USING public.import_application_records r
     WHERE r.target_id = s.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'schedule_tbd' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_tbd = ROW_COUNT;
    UPDATE public.schedule_tbd s
       SET division_id = (r.previous_payload ->> 'division_id')::uuid,
           home_team_id = (r.previous_payload ->> 'home_team_id')::uuid,
           away_team_id = (r.previous_payload ->> 'away_team_id')::uuid,
           week_index = (r.previous_payload ->> 'week_index')::smallint,
           reason = r.previous_payload ->> 'reason',
           detail = COALESCE(r.previous_payload -> 'detail', '{}'::jsonb),
           run_id = (r.previous_payload ->> 'run_id')::uuid,
           external_ref = r.previous_payload ->> 'external_ref',
           game_date = (r.previous_payload ->> 'game_date')::date
      FROM public.import_application_records r
     WHERE r.target_id = s.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'schedule_tbd' AND r.operation = 'updated' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_tbd_restored = ROW_COUNT;
    INSERT INTO public.schedule_tbd
    SELECT (jsonb_populate_record(NULL::public.schedule_tbd, r.previous_payload)).*
      FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'schedule_tbd'
       AND r.operation = 'deleted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd x
                        WHERE x.id = r.target_id
                           OR (x.kind = 'game' AND x.home_team_id = (r.previous_payload ->> 'home_team_id')::uuid
                               AND x.away_team_id = (r.previous_payload ->> 'away_team_id')::uuid
                               AND x.week_index = (r.previous_payload ->> 'week_index')::smallint)
                           OR (x.season_settings_id = (r.previous_payload ->> 'season_settings_id')::uuid
                               AND x.external_ref = r.previous_payload ->> 'external_ref'));
    GET DIAGNOSTICS n_tbd_reinserted = ROW_COUNT;
    SELECT count(*) INTO n_tbd_not_reinserted FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'schedule_tbd'
       AND r.operation = 'deleted' AND r.rolled_back_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd x WHERE x.id = r.target_id);

    -- Slots nothing stands in any more.
    DELETE FROM public.game_slots gs USING public.import_application_records r
     WHERE r.target_id = gs.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_slots' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.game_slot_id = gs.id OR ga.slot_id = gs.id)
       AND public.game_import_row_unchanged(to_jsonb(gs), r.applied_payload);
    GET DIAGNOSTICS n_slots = ROW_COUNT;

    -- The ids every OTHER team run of the organization names anywhere in its results, read ONCE. (The check used to cast
    -- each run's whole results to text for every team: 150 shells and ten megabytes of other runs took 7 seconds. An id
    -- found anywhere keeps its team, as before; the scan is for uuid-shaped text, which is what an id is.)
    DROP TABLE IF EXISTS pg_temp._gr_named;
    CREATE TEMP TABLE _gr_named ON COMMIT DROP AS
    SELECT DISTINCT lower(m[1]) AS id
      FROM public.scheduler_runs sr,
           LATERAL regexp_matches(sr.results::text, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
     WHERE sr.run_type = 'team' AND sr.organization_id = v_org
       AND sr.parameters ->> 'import_job_id' IS DISTINCT FROM p_import_job_id::text;
    CREATE UNIQUE INDEX ON _gr_named (id);

    -- Teams (shells and outside clubs) nothing references: no game, no TIME TBD game, no player, coach, practice,
    -- preference, assigned player (players.team_id has no foreign key) and no later team run that names it. A shell or
    -- club that is referenced stays, and is reported. The practice TIME TBD rows are derived and go with the cascade,
    -- and so does the feed token a trigger makes for every team.
    DELETE FROM public.teams t USING public.import_application_records r
     WHERE r.target_id = t.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'teams' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.home_team_id = t.id OR ga.away_team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.kind = 'game' AND (s.home_team_id = t.id OR s.away_team_id = t.id))
       AND NOT EXISTS (SELECT 1 FROM public.team_players tp WHERE tp.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.team_coach_assignments tc WHERE tc.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.coach_practice_preferences cp WHERE cp.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM _gr_named n WHERE n.id = t.id::text)
       AND public.game_import_row_unchanged(to_jsonb(t), r.applied_payload);
    GET DIAGNOSTICS n_teams = ROW_COUNT;

    -- The import's team runs whose shells are all gone (one that still carries a kept shell stays), and that nothing else
    -- names: every foreign key onto scheduler_runs sets null (the pgTAP file derives them from the catalogue and fails unless
    -- each is guarded here), and a null run is a game or an evaluation that lost the run it belongs to.
    DELETE FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                        WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid))
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.evaluation_runs er WHERE er.scheduler_run_id = sr.id);
    GET DIAGNOSTICS n_team_runs = ROW_COUNT;

    -- Fields, venues and divisions the import created and nothing else uses. Everything an admin attached afterwards keeps
    -- its record: a permit scope, a blackout or a subunit would be taken by the cascade, and a field that holds a booking
    -- (the shared producer) or a game or slot does not go either. The pgTAP file derives from the catalogue every
    -- foreign key that cascades or sets null onto the five tables this function deletes from and fails unless the
    -- DELETE guards it (or it is on that file's short, argued list).
    DELETE FROM public.fields f USING public.import_application_records r
     WHERE r.target_id = f.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'fields' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_slots gs WHERE gs.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes ps WHERE ps.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_blackouts fb WHERE fb.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_subunits su WHERE su.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_bookings(v_org, f.id, NULL) b)
       AND public.game_import_row_unchanged(to_jsonb(f), r.applied_payload);
    GET DIAGNOSTICS n_fields = ROW_COUNT;
    DELETE FROM public.locations l USING public.import_application_records r
     WHERE r.target_id = l.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'locations' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.location_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes ps WHERE ps.location_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_blackouts fb WHERE fb.location_id = l.id)
       AND public.game_import_row_unchanged(to_jsonb(l), r.applied_payload);
    GET DIAGNOSTICS n_venues = ROW_COUNT;
    DELETE FROM public.divisions d USING public.import_application_records r
     WHERE r.target_id = d.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'divisions' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.game_slots gs WHERE gs.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_slots ps WHERE ps.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.division_id = d.id)
       AND public.game_import_row_unchanged(to_jsonb(d), r.applied_payload);
    GET DIAGNOSTICS n_divs = ROW_COUNT;

    -- The import's own game run goes last: every game that named it has been deleted or put back into the run it was in. A run
    -- something else still names (a game saved into it since) stays, as above.
    IF v_run IS NOT NULL THEN
        DELETE FROM public.scheduler_runs sr WHERE sr.id = v_run
           AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.evaluation_runs er WHERE er.scheduler_run_id = sr.id);
    END IF;

    -- What was created and is still there (referenced by something that came after, or changed since), named, never
    -- deleted silently; and a run of the import that is still there for a reason of its own (not for a shell it carries).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('table', k.t, 'id', k.id) ORDER BY k.t, k.id), '[]'::jsonb)
      INTO v_kept
      FROM (SELECT r.target_table AS t, r.target_id AS id
              FROM public.import_application_records r
             WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
               AND r.target_table IN ('game_slots', 'teams', 'fields', 'locations', 'divisions')
               AND ((r.target_table = 'game_slots' AND EXISTS (SELECT 1 FROM public.game_slots x WHERE x.id = r.target_id))
                 OR (r.target_table = 'teams' AND EXISTS (SELECT 1 FROM public.teams x WHERE x.id = r.target_id))
                 OR (r.target_table = 'fields' AND EXISTS (SELECT 1 FROM public.fields x WHERE x.id = r.target_id))
                 OR (r.target_table = 'locations' AND EXISTS (SELECT 1 FROM public.locations x WHERE x.id = r.target_id))
                 OR (r.target_table = 'divisions' AND EXISTS (SELECT 1 FROM public.divisions x WHERE x.id = r.target_id)))
            UNION ALL
            SELECT 'scheduler_runs', sr.id
              FROM public.scheduler_runs sr
             WHERE sr.organization_id = v_org AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
               AND (sr.run_type = 'game'
                    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                                    WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid)))) k;

    UPDATE public.import_application_records r
       SET rolled_back_at = now(), rolled_back_by = v_uid, rollback_payload = jsonb_build_object('rolled_back', true)
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.rolled_back_at IS NULL;

    v_result := jsonb_build_object(
        'job_id', p_import_job_id,
        'games', jsonb_build_object('deleted', n_games_deleted, 'restored', n_games_restored, 'reinserted', n_games_reinserted),
        'time_tbd_deleted', n_tbd, 'time_tbd_restored', n_tbd_restored, 'time_tbd_reinserted', n_tbd_reinserted,
        'time_tbd_not_reinserted', n_tbd_not_reinserted, 'slots_deleted', n_slots, 'teams_deleted', n_teams, 'team_runs_deleted', n_team_runs,
        'fields_deleted', n_fields, 'venues_deleted', n_venues, 'divisions_deleted', n_divs,
        'kept', v_kept);

    BEGIN
        PERFORM public.record_audit_event(v_org, 'import.rolled_back', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'games') || v_result);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    UPDATE public.import_jobs
       SET status = 'needs_fix',
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{game_import_rollback}', v_result, true)
     WHERE id = p_import_job_id;

    -- The exemption was for this call only.
    PERFORM set_config('squadlogic.import_rollback', '', true);
    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.rollback_game_import_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rollback_game_import_job(uuid) TO authenticated;
COMMENT ON FUNCTION public.rollback_game_import_job(uuid) IS
    'Admin-only, signed in: take a games import back. Refused (22023, game_import_changed count= ids= [tbd_ids=], naming up to 50 placed games and up to 50 TIME TBD games) while a game or TIME TBD game it wrote has been changed, removed, cancelled, had changes allowed or been saved into a later run; otherwise deletes the games it inserted and puts back the ones it changed (through the Published guard''s rollback exemption), puts back the games it took out and the TIME TBD rows it changed or removed, removes the TIME TBD games, slots, outside clubs, shells, fields, venues and divisions it created when nothing else references them and nobody has changed them (what stays is named in kept), and its runs when nothing else names them. Audited import.rolled_back. 20261121010000.';

-- ---------------------------------------------------------------------------
-- 9. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------
--
-- It changes no existing row: the new columns are NULL or false and nothing is updated.

DO $$
DECLARE
    v_bad text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.teams'::regclass AND a.attname = 'is_external'
                    AND a.attnotnull AND NOT a.attisdropped) THEN
        RAISE EXCEPTION 'teams.is_external is missing or nullable';
    END IF;
    IF (SELECT count(*) FROM public.teams WHERE is_external) <> 0 THEN
        RAISE EXCEPTION 'a team became an outside club by the migration';
    END IF;
    IF to_regclass('public.game_assignments_season_external_ref_key') IS NULL THEN
        RAISE EXCEPTION 'the per-season Game ID index is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.game_assignments'::regclass
                    AND conname = 'game_assignments_external_ref_shape') THEN
        RAISE EXCEPTION 'the Game ID shape check is missing';
    END IF;

    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('apply_game_import_job(uuid,boolean)'), ('rollback_game_import_job(uuid)'), ('map_game_import_job(uuid,jsonb)'),
                   ('ensure_game_slot(uuid,uuid,date,time without time zone,time without time zone,smallint,timestamp with time zone,timestamp with time zone)'),
                   ('game_import_image(jsonb)'), ('game_import_row_unchanged(jsonb,jsonb)'), ('normalise_external_label(text)')) AS f(sig)
     WHERE to_regprocedure('public.' || f.sig) IS NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'function(s) missing: %', v_bad;
    END IF;
    -- The four client RPCs are open to authenticated and closed to anon and PUBLIC; the internal helper to all three.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('apply_game_import_job', 'rollback_game_import_job', 'map_game_import_job', 'ensure_game_slot')
       AND (NOT p.prosecdef OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'wrong grants on %', v_bad;
    END IF;
    IF has_function_privilege('authenticated', to_regprocedure('public.game_import_image(jsonb)'), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure('public.game_import_image(jsonb)'), 'EXECUTE') THEN
        RAISE EXCEPTION 'game_import_image is internal';
    END IF;
    IF has_function_privilege('authenticated', to_regprocedure('public.game_import_row_unchanged(jsonb,jsonb)'), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure('public.game_import_row_unchanged(jsonb,jsonb)'), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure('public.game_import_row_unchanged(jsonb,jsonb)') AND a.grantee = 0) THEN
        RAISE EXCEPTION 'game_import_row_unchanged is internal';
    END IF;
    IF has_function_privilege('authenticated', to_regprocedure('public.normalise_external_label(text)'), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure('public.normalise_external_label(text)'), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure('public.normalise_external_label(text)') AND a.grantee = 0) THEN
        RAISE EXCEPTION 'normalise_external_label is internal';
    END IF;

    -- Each replaced body says what it was replaced for.
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.game_assignments_published_guard()')) !~ 'squadlogic\.import_rollback'
       OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_import_job(uuid,text,text,uuid)')) !~ '''games'''
       OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.sync_schedule_tbd_practices(uuid,uuid,uuid,jsonb)')) !~ 'NOT t\.is_external'
       OR pg_get_viewdef('public.view_org_metrics'::regclass) !~ 'is_external' THEN
        RAISE EXCEPTION 'a replaced body does not carry its change';
    END IF;
    IF cardinality(public.import_allowed_keys('games')) <> 21 THEN
        RAISE EXCEPTION 'import_allowed_keys(games) has the wrong length';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.game_assignments'::regclass
                    AND g.tgname = 'game_assignments_published_guard' AND NOT g.tgisinternal AND g.tgenabled = 'O') THEN
        RAISE EXCEPTION 'the Published guard trigger is missing or off';
    END IF;
    IF (SELECT count(*) FROM public.audit_actions WHERE action IN ('game.slot_created', 'import.mapped')) <> 2 THEN
        RAISE EXCEPTION 'audit_actions lacks game.slot_created or import.mapped';
    END IF;
    IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = 'public.view_org_metrics'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM ARRAY['organization_id', 'organization_name', 'total_players', 'total_teams',
                              'total_users', 'season_settings_id'] THEN
        RAISE EXCEPTION 'view_org_metrics has the wrong columns';
    END IF;
END;
$$;

COMMIT;
