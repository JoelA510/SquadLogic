-- The practice schedule import, database half: a practice schedule already made is staged, mapped, previewed, applied
-- and rolled back (PR 10).
--
-- Plan of record: docs/changes/2026-11-03-schedule-expansion.md, section 4.11 (4.11.3 to 4.11.8) and tasks K1 and K2
-- of PR 10; decisions 20, 22, 23, 24, 25 and 26 (all answered by the owner on 2026-11-06). AGENTS.md rule 14 applies
-- (persistence): this is the plan's migration for it. Nothing in the solver changes; the Edge function and the Practices
-- tab of the Import panel are PR 11.
--
-- ## What this adds
--
--   * The import type `practice_schedule` through every list the pipeline keeps (plan 4.11.8;
--     tests/practiceImportPipelineLists.test.js enumerates them from the catalogue and the code): `import_jobs.job_type`,
--     `staging_import_rows.import_type`, `import_application_records.import_type` and `.target_table` (gains
--     `practice_assignments`; the other tables the import writes are already there), `create_import_job` (the active
--     season only, as a games import), the deferred-apply pair and `import_allowed_keys`.
--   * `ensure_practice_slot` (internal: no client role may execute it, as `practice_slot_conflicts`): a slot found by the
--     fields import's own key, `(field, subunit or the whole field, weekday, start, valid from)`, or made, unless the
--     supply rule (`practice_slot_conflicts`, turnover 0) finds a slot it would overlap. A slot that exists is found and
--     never modified.
--   * `practice_import_referenced_ids(regclass, uuid[])` (internal): which of the rows the rollback would delete are
--     named by any row of any table, read from the foreign keys in the catalogue (so a table added later is covered without a list).
--   * `map_practice_import_job`, `apply_practice_import_job(job, dry_run)` and `rollback_practice_import_job`: admin RPCs.
--
-- **No change to `persist_practice_schedule`, its gate, `refresh_schedule_tbd_practices`, or any column of
-- `practice_assignments`** (K1). The import is an additive writer of its own (plan 4.11.4, finding 12).
--
-- ## The apply, in one paragraph
--
-- It reads the staged rows (each a row of the file as core's `toStagedPracticeRow` made it; this SQL never normalises a
-- label: it matches the decision keys the row carries with the keys the admin's decisions are stored under), resolves
-- every label through the decisions the admin confirmed (`map_practice_import_job`; nothing is guessed), creates what
-- the admin chose to create, finds or makes a slot for every timed row (open ones too: the capacity the next run fills),
-- and inserts each team's practice as `source = 'manual'`, `assigned_via = 'manual'`, `run_id` NULL, with
-- `INSERT ... ON CONFLICT (team_id, practice_slot_id, effective_date_range) DO NOTHING`: it never updates or deletes a
-- saved row, so the writer's lock-by-default is never bypassed, and a re-import inserts nothing. Every rule the rows
-- break is reported, never refused (decision 20, accept and flag): the gate's five (`practice_new_auto_row_refusals`,
-- read-only, on every row the file names, inserted now or already there, so a re-import reports the same flags),
-- `coach-conflict`, `team-on-both-halves`, `hold-over-open-slot` and the parse's `division-not-reserved`. Teams short of
-- their division's count join the TIME TBD list through `refresh_schedule_tbd_practices`. It takes the practice writer's
-- own season lock, so an import and a save cannot interleave (lesson 72).
--
-- **The preview is the dry run** (plan 4.11.4): every step runs in a sub-block that ends, for a dry run, in a sentinel
-- exception after the result is copied into a variable, so every write rolls back and the function returns what an
-- apply would have done. The preview, the apply and the gate therefore cannot disagree on the same state. **The apply
-- plans again against the state it finds**: another admin's save between the two shows in its counts.
--
-- **A re-import, and the probable moves** (decision 24). A team's saved rows of the season that the file does not hold
-- are listed `leaving`; the file's rows that are not saved yet are `arriving`. An arriving row of a team that also has a
-- leaving row is part of a probable move (paired at team level, as core's `pairProbableMoves` pairs the two lists) and
-- is **not inserted unless the admin ticked it**: the ticks are stored with the mapping (`options.add_moved_rows`, the
-- row keys), so the safe default (unticked) holds at the database, whatever a client sends. Its slot is still made (it is
-- supply). The leaving rows stay: an import never deletes.
--
-- ## The rollback
--
-- It refuses (22023 `practice_import_changed`, naming up to 50 rows) if any assignment the import inserted has changed
-- since in its team, slot, range, `source` or `assigned_via`, or has an exception row; a completed season refuses. An
-- assignment a later writer removed is gone already and is counted, not a refusal. Otherwise it deletes the assignments,
-- then each record the import created (slots, halves, fields, locations, team shells, divisions) only when it is as the
-- apply left it and nothing references it (read from the catalogue's foreign keys, plus the two references that have no
-- key: `players.team_id` and a later team run that names a shell); the rest is kept and reported. It retires or trims the
-- import's team run as the games import does, refreshes the TIME TBD list, and is audited `import.rolled_back`.
--
-- ## Cost, said plainly
--
-- Four functions are replaced WHOLE, each copied from the migration that defines it last, behind the md5 of that text
-- (lesson 87), with the one change of knowing the new type. Their plants in scripts/dbharness/prove.sh are re-aimed
-- (lesson 70).
--
-- Reversible: docs/sql/20261123010000_revert.sql. Smoke: docs/sql/20261123010000_smoke.sql. pgTAP:
-- supabase/tests/practice_import_apply_rollback.sql (CI's). No data is read or changed by the migration itself.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration replaces are the ones it was written against.
-- ---------------------------------------------------------------------------

DO $guard$
DECLARE
    v_spec record;
    v_md5 text;
BEGIN
    FOR v_spec IN
        SELECT * FROM (VALUES
            ('public.create_import_job(uuid, text, text, uuid)',         'ff476be7f7ea5cea062effa464a0f461'),
            ('public.import_allowed_keys(text)',                         '403961e6253c43bb7cfb53700aef75d2'),
            ('public.mark_import_job_ready_to_apply(uuid, text, jsonb)', 'abb3279061575ad63e906afc1f9f0a82'),
            ('public.cancel_ready_import_job(uuid, text)',               'aba155cf20b2712e6e8dada175cf464e')
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
-- 1. The lists.
-- ---------------------------------------------------------------------------

ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_job_type_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_job_type_check
    CHECK (job_type IN ('registration', 'fields', 'field_availability', 'manual', 'evaluations', 'games', 'practice_schedule'));

ALTER TABLE public.staging_import_rows DROP CONSTRAINT IF EXISTS staging_import_rows_import_type_check;
ALTER TABLE public.staging_import_rows ADD CONSTRAINT staging_import_rows_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations', 'games', 'practice_schedule'));

ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_import_type_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'games', 'practice_schedule'));

ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_target_table_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_target_table_check
    CHECK (target_table IN (
        'coaches', 'fields', 'field_subunits', 'locations', 'practice_slots', 'game_slots',
        'field_availability_profiles', 'field_availability_profile_formats', 'field_blackout_windows',
        'field_equipment_requirements', 'field_availability_scenarios', 'field_availability_scenario_members',
        'game_assignments', 'teams', 'divisions', 'schedule_tbd', 'practice_assignments'));

-- ---------------------------------------------------------------------------
-- 2. The import types the pipeline accepts.
-- ---------------------------------------------------------------------------
--
-- The four bodies 20261121010000 and 20261122010000 left (the md5 guards above), each with the one change of knowing
-- `practice_schedule`; nothing else in them moves.

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
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations', 'games', 'practice_schedule') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' WHEN v_import_type = 'evaluations' THEN 'evaluations' WHEN v_import_type = 'games' THEN 'games' WHEN v_import_type = 'practice_schedule' THEN 'practice_schedule' ELSE 'registration' END;

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
    'Admin-only: start an import job for the named season (none named: the organization''s active season), fixed now. A player, coach, practice preference or evaluations import may name the active season or a draft; a field, games or practice schedule import only the active season; a completed season is refused (22023, season_completed). 20261123010000 (practice_schedule; 20261121010000 before it added games, 20261113010000 evaluations, 20261112010000 practice_preferences, 20261111010000 the draft season).';

CREATE OR REPLACE FUNCTION public.mark_import_job_ready_to_apply(p_import_job_id uuid, p_import_type text, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations','games','practice_schedule') THEN RAISE EXCEPTION 'Deferred apply is only available for coach, field, field_availability, practice_preferences, evaluations, games, and practice_schedule imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='games' AND v_job.job_type<>'games' THEN RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='practice_schedule' AND v_job.job_type<>'practice_schedule' THEN RAISE EXCEPTION 'Import job % is %, not practice_schedule', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
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
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations','games','practice_schedule') THEN RAISE EXCEPTION 'Deferred apply cancellation is only available for coach, field, field_availability, practice_preferences, evaluations, games, and practice_schedule imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='games' AND v_job.job_type<>'games' THEN RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='practice_schedule' AND v_job.job_type<>'practice_schedule' THEN RAISE EXCEPTION 'Import job % is %, not practice_schedule', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  -- 20261122010000: only a staged import that has not been applied is cancelled. Without this check an APPLIED job was
  -- marked failed and audited as canceled while everything it wrote stayed, and it left its roll back.
  IF v_job.status <> 'ready_to_apply' THEN RAISE EXCEPTION 'Import job % is %, not ready_to_apply: only a staged import that has not been applied can be cancelled', p_import_job_id, v_job.status USING ERRCODE='22023', DETAIL='import_not_ready_to_apply'; END IF;
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
        -- 20261123010000: the staged payload keys a practice schedule import reads (core's toStagedPracticeRow builds them;
        -- the apply is the one reader).
        WHEN 'practice_schedule' THEN ARRAY[
            'row_key', 'status', 'day', 'start_time', 'end_time', 'valid_from', 'valid_until', 'capacity', 'flags',
            'division', 'division_key', 'location', 'location_key', 'field', 'field_key', 'subunit', 'subunit_key', 'team', 'team_key'
        ]::text[]
        ELSE ARRAY[]::text[]
    END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. ensure_practice_slot: find or make the slot a practice row names.
-- ---------------------------------------------------------------------------
--
-- The key is the fields import's (`finalize_field_import_job`, 20261029010000:892-903, latest body 20261101010000): the
-- organization, the field, the subunit (NULL is the whole field and matches only a whole-field slot), the weekday, the
-- start and `valid_from`, the earliest slot first. Copied, not extracted (AGENTS.md rule 2). A slot that is found is NOT
-- modified (its end, capacity, dates and reservation stay: plan 4.11.3). A slot to make is judged by the supply rule
-- the fields CSV enforces (`practice_slot_conflicts`, turnover 0: same surface, weekday, overlapping dates and times, a
-- whole field against each of its halves, back to back allowed); a clash makes nothing and names the slot it would
-- overlap (the earliest by start). Internal: the apply calls it as its owner; no client role may execute it.

CREATE FUNCTION public.ensure_practice_slot(
    p_organization_id uuid,
    p_field_id uuid,
    p_field_subunit_id uuid,
    p_day_of_week public.day_of_week,
    p_start_time time,
    p_end_time time,
    p_valid_from date,
    p_valid_until date,
    p_capacity smallint
)
RETURNS TABLE (slot_id uuid, created boolean, conflict_slot_id uuid)
LANGUAGE plpgsql
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_id uuid;
BEGIN
    SELECT ps.id INTO v_id
      FROM public.practice_slots ps
     WHERE ps.organization_id = p_organization_id
       AND ps.field_id = p_field_id
       AND ((p_field_subunit_id IS NULL AND ps.field_subunit_id IS NULL) OR ps.field_subunit_id = p_field_subunit_id)
       AND ps.day_of_week = p_day_of_week
       AND ps.start_time = p_start_time
       AND ps.valid_from = p_valid_from
     ORDER BY ps.created_at, ps.id
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, false, NULL::uuid;
        RETURN;
    END IF;
    SELECT c.slot_id INTO v_id
      FROM public.practice_slot_conflicts(p_organization_id, p_field_id, p_field_subunit_id, p_day_of_week,
                                          p_start_time, p_end_time, p_valid_from, p_valid_until, NULL, 0) c
     ORDER BY c.start_time, c.slot_id
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT NULL::uuid, false, v_id;
        RETURN;
    END IF;
    INSERT INTO public.practice_slots (organization_id, field_id, field_subunit_id, day_of_week, start_time, end_time,
                                       capacity, valid_from, valid_until)
    VALUES (p_organization_id, p_field_id, p_field_subunit_id, p_day_of_week, p_start_time, p_end_time,
            p_capacity, p_valid_from, p_valid_until)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT v_id, true, NULL::uuid;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_practice_slot(uuid, uuid, uuid, public.day_of_week, time, time, date, date, smallint)
    FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.ensure_practice_slot(uuid, uuid, uuid, public.day_of_week, time, time, date, date, smallint) IS
    'Internal (the practice import calls it as its owner): find a practice slot by the fields import''s key (field, subunit or the whole field, weekday, start, valid_from), never modifying it, or make one unless practice_slot_conflicts (turnover 0) finds a slot it would overlap, which it names. 20261123010000.';

-- ---------------------------------------------------------------------------
-- 4. practice_import_referenced_ids: which of these rows does any row anywhere name.
-- ---------------------------------------------------------------------------
--
-- The rollback deletes a record the import created only when nothing references it (games lesson 103: a rollback
-- deletes what its children cascade onto). The references are read from the catalogue: every foreign key onto the table,
-- each column paired with the table's `id` (a composite key, such as practice_slots (organization_id, division_id), is
-- read by that one column). Two are not counted, each because the row is derived from the referenced one and goes with
-- it: a team's calendar token (a trigger makes one for every team) and a practice row of the TIME TBD list (rebuilt by
-- the refresh the rollback runs). A table added later is covered without an edit here.

CREATE FUNCTION public.practice_import_referenced_ids(p_table regclass, p_ids uuid[])
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
DECLARE
    v_fk record;
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN;
    END IF;
    -- One query per foreign key, over the whole set (a rollback of 705 slots asks each key once, not 705 times).
    FOR v_fk IN
        SELECT c.conrelid::regclass AS child, a.attname AS col
          FROM pg_constraint c
          CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child_col, parent_col)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child_col
          JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_col
         WHERE c.contype = 'f' AND c.confrelid = p_table AND pa.attname = 'id'
           AND NOT (c.conrelid = 'public.team_calendar_tokens'::regclass)
         ORDER BY 1, 2
    LOOP
        RETURN QUERY EXECUTE format('SELECT DISTINCT x.%I FROM %s x WHERE x.%I = ANY ($1)%s', v_fk.col, v_fk.child, v_fk.col,
                                    CASE WHEN v_fk.child = 'public.schedule_tbd'::regclass THEN ' AND x.kind <> ''practice''' ELSE '' END)
            USING p_ids;
    END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.practice_import_referenced_ids(regclass, uuid[]) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.practice_import_referenced_ids(regclass, uuid[]) IS
    'Internal (the practice import''s rollback): of the given ids of a table, those a row of any table names through a foreign key onto its id, read from the catalogue, one query per key; a team''s calendar token and a practice row of the TIME TBD list are derived and not counted. 20261123010000.';

-- ---------------------------------------------------------------------------
-- 5. map_practice_import_job: store what the admin decided for each label, and which moved rows to add.
-- ---------------------------------------------------------------------------
--
-- The mapping is core's practiceImport/mapping.js decisions, the EFFECTIVE ones (an exact single match is stored as a
-- `map` with source `exact`): { options: { add_moved_rows }, divisions, locations, fields, subunits, teams }, each group an
-- object keyed by the decision key a staged row carries (`division_key`, `location_key`, `field_key`, `subunit_key`,
-- `team_key`) and each decision { action: map | create | skip, id?, name?, source? }. `source` (exact, alias, previous,
-- admin) says how the label was resolved, for the audit. Nothing is guessed: a label with no decision is an unknown row
-- at apply. Every id is validated here (a division and a team against the job's season; a team never an outside club,
-- which has no practice), and again as each row resolves. `add_moved_rows` is the row keys of the arriving rows of a
-- probable move that the admin ticked; every other such row stays out (plan 4.11.6, the unticked default).

CREATE FUNCTION public.map_practice_import_job(p_import_job_id uuid, p_mapping jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_groups constant text[] := ARRAY['divisions', 'locations', 'fields', 'subunits', 'teams'];
    c_sources constant text[] := ARRAY['exact', 'alias', 'previous', 'admin'];
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
    v_source text;
    v_id uuid;
    v_known boolean;
    v_add jsonb := '[]'::jsonb;
    v_counts jsonb := '{}'::jsonb;
    v_decisions jsonb := '{}'::jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'map_practice_import_job needs a signed-in caller to audit the mapping' USING ERRCODE = '42501';
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
    IF v_job.job_type <> 'practice_schedule' THEN
        RAISE EXCEPTION 'Import job % is %, not practice_schedule', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
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
        RAISE EXCEPTION 'the mapping holds options, divisions, locations, fields, subunits and teams and nothing else' USING ERRCODE = '22023';
    END IF;
    IF p_mapping ? 'options' THEN
        IF jsonb_typeof(p_mapping -> 'options') <> 'object'
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_mapping -> 'options') k WHERE k <> 'add_moved_rows')
           OR (p_mapping -> 'options' ? 'add_moved_rows' AND (jsonb_typeof(p_mapping -> 'options' -> 'add_moved_rows') <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_mapping -> 'options' -> 'add_moved_rows') e
                           WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') NOT BETWEEN 1 AND 100)
               OR jsonb_array_length(p_mapping -> 'options' -> 'add_moved_rows') > 2400)) THEN
            RAISE EXCEPTION 'the options are { add_moved_rows: the row keys of the moved rows to add, at most 2400 }' USING ERRCODE = '22023';
        END IF;
        SELECT COALESCE(jsonb_agg(DISTINCT e ORDER BY e), '[]'::jsonb) INTO v_add
          FROM jsonb_array_elements(COALESCE(p_mapping -> 'options' -> 'add_moved_rows', '[]'::jsonb)) e;
    END IF;

    FOREACH v_group IN ARRAY c_groups LOOP
        v_kind := CASE v_group WHEN 'divisions' THEN 'division' WHEN 'locations' THEN 'location' WHEN 'fields' THEN 'field'
                               WHEN 'subunits' THEN 'subunit' ELSE 'team' END;
        v_group_clean := '{}'::jsonb;
        IF p_mapping ? v_group THEN
            IF jsonb_typeof(p_mapping -> v_group) <> 'object' THEN
                RAISE EXCEPTION 'the % of the mapping must be an object', v_group USING ERRCODE = '22023';
            END IF;
            IF (SELECT count(*) FROM jsonb_object_keys(p_mapping -> v_group)) > c_max_entries THEN
                RAISE EXCEPTION 'at most % % can be mapped in one job', c_max_entries, v_group USING ERRCODE = '22023';
            END IF;
            FOR v_entry IN SELECT e.key, e.value FROM jsonb_each(p_mapping -> v_group) e ORDER BY e.key LOOP
                IF char_length(v_entry.key) = 0 OR char_length(v_entry.key) > 1000 THEN
                    RAISE EXCEPTION 'a decision key of % is empty or over 1000 characters', v_group USING ERRCODE = '22023';
                END IF;
                v_decision := v_entry.value;
                IF jsonb_typeof(v_decision) <> 'object' THEN
                    RAISE EXCEPTION 'a decision of % must be an object', v_group USING ERRCODE = '22023';
                END IF;
                v_action := v_decision ->> 'action';
                IF v_action IS NULL OR v_action NOT IN ('map', 'create', 'skip') THEN
                    RAISE EXCEPTION 'a decision of % is not one of its actions (map, create, skip)', v_group USING ERRCODE = '22023';
                END IF;
                -- No source is the admin's own word (c_sources[4]; written by index so this body names no role list:
                -- supabase/tests/staff_is_admin.sql reads every parenthesised list that names that word as a role list).
                v_source := COALESCE(v_decision ->> 'source', c_sources[4]);
                IF (v_decision ? 'source' AND jsonb_typeof(v_decision -> 'source') <> 'string') OR NOT (v_source = ANY (c_sources)) THEN
                    RAISE EXCEPTION 'a decision''s source is one of exact, alias, previous, admin' USING ERRCODE = '22023';
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
                        WHEN 'location' THEN EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v_id AND l.organization_id = v_job.organization_id)
                        WHEN 'field' THEN EXISTS (SELECT 1 FROM public.fields f WHERE f.id = v_id AND f.organization_id = v_job.organization_id)
                        WHEN 'subunit' THEN EXISTS (SELECT 1 FROM public.field_subunits s WHERE s.id = v_id AND s.organization_id = v_job.organization_id)
                        ELSE EXISTS (SELECT 1 FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
                                      WHERE t.id = v_id AND t.organization_id = v_job.organization_id
                                        AND d.season_settings_id = v_job.season_settings_id AND NOT t.is_external)
                    END;
                    IF NOT v_known THEN
                        RAISE EXCEPTION 'the % % is not a record of this organization and season (an outside club has no practice)', v_kind, v_id USING ERRCODE = '22023';
                    END IF;
                    v_group_clean := v_group_clean || jsonb_build_object(v_entry.key, jsonb_build_object('action', 'map', 'id', v_id, 'source', v_source));
                ELSE
                    v_group_clean := v_group_clean || jsonb_build_object(v_entry.key,
                        jsonb_build_object('action', v_action, 'source', v_source)
                        || CASE WHEN v_name IS NULL OR v_action <> 'create' THEN '{}'::jsonb ELSE jsonb_build_object('name', v_name) END);
                END IF;
            END LOOP;
        END IF;
        v_clean := v_clean || jsonb_build_object(v_group, v_group_clean);
        v_counts := v_counts || jsonb_build_object(v_group, (SELECT count(*) FROM jsonb_object_keys(v_group_clean)));
        v_decisions := v_decisions || jsonb_build_object(v_group, (SELECT COALESCE(jsonb_object_agg(x.k, x.n), '{}'::jsonb)
                                                                    FROM (SELECT (e.value ->> 'action') || ':' || (e.value ->> 'source') AS k, count(*) AS n
                                                                            FROM jsonb_each(v_group_clean) e GROUP BY 1) x));
    END LOOP;
    v_clean := v_clean || jsonb_build_object('options', jsonb_build_object('add_moved_rows', v_add));

    UPDATE public.import_jobs
       SET warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{practice_mapping}', v_clean, true)
     WHERE id = p_import_job_id;

    -- The mapping is the sole input of the apply, so storing it is audited: the number of decisions per group, action and
    -- source, and how many moved rows were ticked, never a label of the file. In this transaction (SLA01, as the games
    -- import's).
    BEGIN
        PERFORM public.record_audit_event(v_job.organization_id, 'import.mapped', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'practice_schedule', 'add_moved_rows', jsonb_array_length(v_add), 'decisions', v_decisions));
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN jsonb_build_object('job_id', p_import_job_id, 'add_moved_rows', jsonb_array_length(v_add)) || v_counts;
END;
$function$;

REVOKE ALL ON FUNCTION public.map_practice_import_job(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.map_practice_import_job(uuid, jsonb) TO authenticated;
COMMENT ON FUNCTION public.map_practice_import_job(uuid, jsonb) IS
    'Admin-only, signed in: store on a practice schedule import job the decisions the admin confirmed for its divisions, locations, fields, subunits and teams (map, create, skip, with the source of each) and the arriving rows of probable moves the admin ticked (options.add_moved_rows). Every id is validated against the organization (a division and a team against the job''s season; a team never an outside club). Audited import.mapped. 20261123010000.';

-- ---------------------------------------------------------------------------
-- 6. apply_practice_import_job: preview (dry run) and apply, one code path.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.apply_practice_import_job(p_import_job_id uuid, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    -- The closed list of reasons a row is listed and not written (packages/core/src/practiceImport/reasonCodes.js,
    -- PRACTICE_IMPORT_ROW_REFUSALS). A staged row the parse refused carries one of them; the apply adds the ones it can
    -- only know once the labels are mapped and the slots are found.
    c_row_refusals constant text[] := ARRAY[
        'bad-use', 'bad-day', 'bad-time', 'bad-length', 'end-not-after-start', 'bad-capacity', 'capacity-not-positive',
        'bad-date', 'valid-until-before-from', 'outside-season-window', 'missing-dates', 'unknown-division', 'unknown-team',
        'unknown-location', 'unknown-field', 'unknown-subunit', 'team-in-two-divisions', 'slot-overlaps-another', 'duplicate-row'];
    -- The parse's flags a staged row may carry (core's PRACTICE_STAGED_FLAGS).
    c_staged_flags constant text[] := ARRAY['division-not-reserved'];
    c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_uid uuid := auth.uid();
    v_dry boolean := COALESCE(p_dry_run, false);
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season uuid;
    v_season_status text;
    v_season_start date;
    v_season_end date;
    v_map jsonb;
    v_add text[];
    v_now timestamptz := now();
    v_bad_row integer;
    v_rc bigint;
    v_planned bigint;
    v_grp record;
    v_slot record;
    v_ids uuid[];
    v_tbd jsonb;
    v_result jsonb;
    v_status text;
    v_team_run uuid;
    v_shell_arr uuid[];
    v_div record;
    v_base jsonb; v_grouped jsonb; v_results jsonb; v_key text; v_label text;
    n_staged integer;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'apply_practice_import_job needs a signed-in caller' USING ERRCODE = '42501';
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
    IF v_job.job_type <> 'practice_schedule' THEN
        RAISE EXCEPTION 'Import job % is %, not practice_schedule', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;
    -- The season writers' lock (completion and rollover take it), then the practice writer's own season lock (the save and
    -- the TIME TBD refresh take it), so an import and a save cannot interleave; THEN the job is read again, held, and
    -- judged as it stands (apply_game_import_job's order): a second caller that waited on the locks finds the first one's
    -- completed job and replays it, never applies it twice. A dry run takes them too: it writes.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('persist_practice_schedule:' || v_org::text || ':' || v_job.season_settings_id::text, 0));
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;

    -- A finished job answers with the result it stored (a retry after a lost response writes nothing).
    IF v_job.status IN ('completed', 'completed_with_warnings') THEN
        IF v_job.warning_summary ? 'practice_import' THEN
            RETURN (v_job.warning_summary -> 'practice_import') || jsonb_build_object('replayed', true);
        END IF;
        RAISE EXCEPTION 'Import job % is already %', p_import_job_id, v_job.status USING ERRCODE = '22023';
    END IF;
    IF v_job.status IN ('failed', 'needs_fix') THEN
        RAISE EXCEPTION '% import job % cannot be applied: a new file is a new job', initcap(v_job.status), p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'import_not_ready_to_apply';
    END IF;
    -- Only a job whose staging finished (mark_import_job_ready_to_apply) is applied: one still importing may be missing rows.
    IF v_job.status <> 'ready_to_apply' THEN
        RAISE EXCEPTION 'Import job % is %, not ready_to_apply: stage the whole file first', p_import_job_id, v_job.status
            USING ERRCODE = '22023', DETAIL = 'import_not_ready_to_apply';
    END IF;
    v_season := v_job.season_settings_id;
    SELECT s.status, s.season_start, s.season_end INTO v_season_status, v_season_start, v_season_end
      FROM public.season_settings s WHERE s.id = v_season AND s.organization_id = v_org;
    IF v_season_status IS NULL THEN
        RAISE EXCEPTION 'Import job % has no season to import into', p_import_job_id USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no practice schedule import: only the active season does', v_season, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;
    v_map := v_job.warning_summary -> 'practice_mapping';
    IF v_map IS NULL THEN
        RAISE EXCEPTION 'Import job % has no mapping: confirm what each label of the file is first', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'mapping_required';
    END IF;
    v_add := ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_map -> 'options' -> 'add_moved_rows', '[]'::jsonb)));

    -- Everything below is ONE code path for the preview and the apply. A dry run ends in a sentinel exception after the
    -- result is in v_result, so every write rolls back with the sub-block (plan 4.11.4).
    BEGIN
        -- A second apply in one transaction finds the first one's tables (they drop at commit); asked first, so a call
        -- prints no notice.
        IF to_regclass('pg_temp._pi_rows') IS NOT NULL THEN
            DROP TABLE IF EXISTS pg_temp._pi_rows, pg_temp._pi_dec, pg_temp._pi_div, pg_temp._pi_loc, pg_temp._pi_fld,
                pg_temp._pi_sub, pg_temp._pi_team, pg_temp._pi_grp, pg_temp._pi_asg, pg_temp._pi_leave, pg_temp._pi_flag;
        END IF;

        -- ------------------------------------------------------------ 1. The staged rows, read once.
        CREATE TEMP TABLE _pi_rows ON COMMIT DROP AS
        SELECT sr.source_row_number AS rowno,
               (sr.normalized_payload IS NULL OR COALESCE(jsonb_array_length(sr.validation_errors), 0) > 0) AS parse_refused,
               sr.validation_errors -> 0 ->> 'code' AS parse_reason,
               sr.validation_errors -> 0 ->> 'message' AS parse_message,
               sr.normalized_payload ->> 'row_key' AS row_key,
               sr.normalized_payload ->> 'status' AS status,
               CASE WHEN sr.normalized_payload ->> 'day' IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
                    THEN (sr.normalized_payload ->> 'day')::public.day_of_week END AS dow,
               CASE WHEN sr.normalized_payload ->> 'start_time' ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN (sr.normalized_payload ->> 'start_time')::time END AS start_time,
               CASE WHEN sr.normalized_payload ->> 'end_time' ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN (sr.normalized_payload ->> 'end_time')::time END AS end_time,
               CASE WHEN sr.normalized_payload ->> 'valid_from' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
                         AND to_char(to_date(sr.normalized_payload ->> 'valid_from', 'YYYY-MM-DD'), 'YYYY-MM-DD') = sr.normalized_payload ->> 'valid_from'
                    THEN (sr.normalized_payload ->> 'valid_from')::date END AS valid_from,
               CASE WHEN sr.normalized_payload ->> 'valid_until' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
                         AND to_char(to_date(sr.normalized_payload ->> 'valid_until', 'YYYY-MM-DD'), 'YYYY-MM-DD') = sr.normalized_payload ->> 'valid_until'
                    THEN (sr.normalized_payload ->> 'valid_until')::date END AS valid_until,
               CASE WHEN jsonb_typeof(sr.normalized_payload -> 'capacity') = 'number' AND (sr.normalized_payload ->> 'capacity') ~ '^\d{1,5}$'
                         AND (sr.normalized_payload ->> 'capacity')::integer BETWEEN 1 AND 32767
                    THEN (sr.normalized_payload ->> 'capacity')::smallint END AS capacity,
               CASE WHEN jsonb_typeof(sr.normalized_payload -> 'flags') = 'array'
                    THEN ARRAY(SELECT jsonb_array_elements_text(sr.normalized_payload -> 'flags')) END AS flags,
               btrim(COALESCE(sr.normalized_payload ->> 'division', ''), E' \t\r\n') AS division_label,
               COALESCE(sr.normalized_payload ->> 'division_key', '') AS division_key,
               btrim(COALESCE(sr.normalized_payload ->> 'location', ''), E' \t\r\n') AS location_label,
               COALESCE(sr.normalized_payload ->> 'location_key', '') AS location_key,
               btrim(COALESCE(sr.normalized_payload ->> 'field', ''), E' \t\r\n') AS field_label,
               COALESCE(sr.normalized_payload ->> 'field_key', '') AS field_key,
               btrim(COALESCE(sr.normalized_payload ->> 'subunit', ''), E' \t\r\n') AS subunit_label,
               COALESCE(sr.normalized_payload ->> 'subunit_key', '') AS subunit_key,
               btrim(COALESCE(sr.normalized_payload ->> 'team', ''), E' \t\r\n') AS team_label,
               COALESCE(sr.normalized_payload ->> 'team_key', '') AS team_key
          FROM public.staging_import_rows sr
         WHERE sr.import_job_id = p_import_job_id AND sr.organization_id = v_org AND sr.import_type = 'practice_schedule';

        SELECT count(*) INTO n_staged FROM _pi_rows;
        IF n_staged = 0 THEN
            RAISE EXCEPTION 'Import job % has no staged practice rows', p_import_job_id USING ERRCODE = '22023', DETAIL = 'no_rows';
        END IF;
        -- A staged row is the Edge function's work: a malformed one is a defect there, not a row to guess at. The whole
        -- apply refuses, naming the first.
        SELECT r.rowno INTO v_bad_row FROM _pi_rows r
         WHERE r.rowno IS NULL
            OR (r.parse_refused AND NOT (COALESCE(r.parse_reason, '') = ANY (c_row_refusals)))
            OR (NOT r.parse_refused AND NOT (
                    r.status IN ('placement', 'open', 'hold') AND COALESCE(r.row_key, '') <> '' AND char_length(r.row_key) <= 100
                    AND r.dow IS NOT NULL AND r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.end_time > r.start_time
                    AND r.valid_from IS NOT NULL AND r.valid_until IS NOT NULL AND r.valid_until >= r.valid_from
                    AND (r.status = 'hold' OR r.capacity IS NOT NULL)
                    AND r.location_label <> '' AND r.location_key <> '' AND r.field_label <> '' AND r.field_key <> ''
                    AND ((r.subunit_label = '') = (r.subunit_key = ''))
                    AND (CASE WHEN r.status = 'placement'
                              THEN r.division_label <> '' AND r.division_key <> '' AND r.team_label <> '' AND r.team_key <> ''
                              ELSE r.team_label = '' AND r.team_key = '' AND r.division_key = '' END)
                    AND r.flags IS NOT NULL AND r.flags <@ c_staged_flags))
         ORDER BY r.rowno NULLS FIRST LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'staged row % is not a practice row', v_bad_row USING ERRCODE = '22023', DETAIL = 'practice_import_staged_invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM _pi_rows WHERE NOT parse_refused GROUP BY row_key HAVING count(*) > 1)
           OR EXISTS (SELECT 1 FROM _pi_rows GROUP BY rowno HAVING count(*) > 1) THEN
            RAISE EXCEPTION 'two staged rows share a row key or a row number' USING ERRCODE = '22023', DETAIL = 'practice_import_staged_invalid';
        END IF;

        ALTER TABLE _pi_rows
            ADD COLUMN outcome text, ADD COLUMN reason text, ADD COLUMN message text, ADD COLUMN skip_kind text,
            ADD COLUMN skip_label text, ADD COLUMN div_ref uuid, ADD COLUMN loc_ref uuid, ADD COLUMN fld_ref uuid,
            ADD COLUMN sub_ref uuid, ADD COLUMN team_ref uuid;
        UPDATE _pi_rows SET outcome = 'refused', reason = parse_reason, message = parse_message WHERE parse_refused;
        UPDATE _pi_rows SET outcome = 'ok' WHERE NOT parse_refused;
        -- The season's window, judged again here (the parse judged it against what the browser read).
        UPDATE _pi_rows SET outcome = 'refused', reason = 'outside-season-window',
               message = format('The dates %s to %s are outside the season (%s to %s).', valid_from, valid_until,
                                COALESCE(v_season_start::text, 'open'), COALESCE(v_season_end::text, 'open'))
         WHERE outcome = 'ok' AND ((v_season_start IS NOT NULL AND valid_from < v_season_start)
                                   OR (v_season_end IS NOT NULL AND valid_until > v_season_end));

        -- ------------------------------------------------------------ 2. What the admin decided, and what each label is.
        CREATE TEMP TABLE _pi_dec ON COMMIT DROP AS
        SELECT g.kind, e.key AS dkey, e.value ->> 'action' AS action,
               CASE WHEN e.value ->> 'action' = 'map' AND e.value ->> 'id' ~* c_uuid THEN (e.value ->> 'id')::uuid END AS ref_id,
               NULLIF(btrim(e.value ->> 'name', E' \t\r\n'), '') AS dname
          FROM (VALUES ('division', 'divisions'), ('location', 'locations'), ('field', 'fields'), ('subunit', 'subunits'), ('team', 'teams')) AS g(kind, grp)
          CROSS JOIN LATERAL jsonb_each(COALESCE(v_map -> g.grp, '{}'::jsonb)) AS e(key, value)
         WHERE e.value ->> 'action' IN ('map', 'create', 'skip');

        -- Divisions of this season. One creation per normalised final name (core's resolvePracticeRows coalesces two labels
        -- that create one name, and UNIQUE (season, name) would refuse the second); a create over a name the season has is
        -- no division (`unknown-division`, core's name-exists).
        CREATE TEMP TABLE _pi_div ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.division_key AS dkey, (array_agg(r.division_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status = 'placement' GROUP BY r.division_key
        ), j AS (
            SELECT k.dkey, d.action,
                   CASE WHEN d.action = 'map' THEN (SELECT dv.id FROM public.divisions dv WHERE dv.id = d.ref_id
                                                      AND dv.organization_id = v_org AND dv.season_settings_id = v_season) END AS existing_id,
                   CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k LEFT JOIN _pi_dec d ON d.kind = 'division' AND d.dkey = k.dkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.divisions dv
                         WHERE dv.organization_id = v_org AND dv.season_settings_id = v_season
                           AND public.normalise_external_label(dv.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.dkey, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey);

        -- Locations of the organization.
        CREATE TEMP TABLE _pi_loc ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.location_key AS lkey, (array_agg(r.location_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' GROUP BY r.location_key
        ), j AS (
            SELECT k.lkey, d.action,
                   CASE WHEN d.action = 'map' THEN (SELECT l.id FROM public.locations l WHERE l.id = d.ref_id AND l.organization_id = v_org) END AS existing_id,
                   CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k LEFT JOIN _pi_dec d ON d.kind = 'location' AND d.dkey = k.lkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.organization_id = v_org
                           AND public.normalise_external_label(l.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.lkey, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.lkey);

        -- Fields: of the location the row's location resolved to. A map onto a field of another location is no field.
        CREATE TEMP TABLE _pi_fld ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.field_key AS fkey, (array_agg(r.location_key ORDER BY r.rowno))[1] AS lkey,
                   (array_agg(r.field_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' GROUP BY r.field_key
        ), j AS (
            SELECT k.fkey, l.ref AS loc_ref, d.action,
                   CASE WHEN d.action = 'map' AND l.ref IS NOT NULL
                        THEN (SELECT f.id FROM public.fields f WHERE f.id = d.ref_id AND f.organization_id = v_org AND f.location_id = l.ref) END AS existing_id,
                   CASE WHEN d.action = 'create' AND l.ref IS NOT NULL THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k
              LEFT JOIN _pi_loc l ON l.lkey = k.lkey AND l.action IN ('map', 'create')
              LEFT JOIN _pi_dec d ON d.kind = 'field' AND d.dkey = k.fkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND j.cname IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fields f
                           WHERE f.organization_id = v_org AND f.location_id = j.loc_ref
                             AND public.normalise_external_label(f.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.fkey, k2.loc_ref, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, k2.loc_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey);

        -- Halves and sides: of the field the row's field resolved to.
        CREATE TEMP TABLE _pi_sub ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.subunit_key AS skey, (array_agg(r.field_key ORDER BY r.rowno))[1] AS fkey,
                   (array_agg(r.subunit_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' AND r.subunit_key <> '' GROUP BY r.subunit_key
        ), j AS (
            SELECT k.skey, f.ref AS fld_ref, d.action,
                   CASE WHEN d.action = 'map' AND f.ref IS NOT NULL
                        THEN (SELECT s.id FROM public.field_subunits s WHERE s.id = d.ref_id AND s.organization_id = v_org AND s.field_id = f.ref) END AS existing_id,
                   CASE WHEN d.action = 'create' AND f.ref IS NOT NULL THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k
              LEFT JOIN _pi_fld f ON f.fkey = k.fkey AND f.action IN ('map', 'create')
              LEFT JOIN _pi_dec d ON d.kind = 'subunit' AND d.dkey = k.skey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND j.cname IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.field_subunits s
                           WHERE s.organization_id = v_org AND s.field_id = j.fld_ref
                             AND public.normalise_external_label(s.label) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.skey, k2.fld_ref, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, k2.fld_ref, public.normalise_external_label(k2.cname) ORDER BY k2.skey);

        -- Teams: of the division the row's division resolved to; never an outside club (it has no practice). A created team
        -- is a shell; its name must not be a name the division holds, an outside club's included (UNIQUE (division, name)).
        CREATE TEMP TABLE _pi_team ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.team_key AS tkey, (array_agg(r.division_key ORDER BY r.rowno))[1] AS dkey,
                   (array_agg(r.team_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status = 'placement' GROUP BY r.team_key
        ), j AS (
            SELECT k.tkey, dv.ref AS div_ref, d.action,
                   CASE WHEN d.action = 'map' AND dv.ref IS NOT NULL
                        THEN (SELECT t.id FROM public.teams t WHERE t.id = d.ref_id AND t.organization_id = v_org
                                AND t.division_id = dv.ref AND NOT t.is_external) END AS existing_id,
                   CASE WHEN d.action = 'create' AND dv.ref IS NOT NULL THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k
              LEFT JOIN _pi_div dv ON dv.dkey = k.dkey AND dv.action IN ('map', 'create')
              LEFT JOIN _pi_dec d ON d.kind = 'team' AND d.dkey = k.tkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND j.cname IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.teams t
                           WHERE t.organization_id = v_org AND t.division_id = j.div_ref
                             AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.tkey, k2.div_ref, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, k2.div_ref, public.normalise_external_label(k2.cname) ORDER BY k2.tkey);

        -- Each row resolves in core's order: division (a placement), location, field, subunit, team. The first to fail is
        -- the row's reason; a label the admin skipped makes the row skipped.
        UPDATE _pi_rows r
           SET outcome = x.outcome, reason = x.reason, message = x.message, skip_kind = x.skip_kind, skip_label = x.skip_label,
               div_ref = x.div_ref, loc_ref = x.loc_ref, fld_ref = x.fld_ref, sub_ref = x.sub_ref, team_ref = x.team_ref
          FROM (
            SELECT r2.rowno,
                   CASE WHEN step IS NULL THEN 'ok' WHEN step LIKE 'skip:%' THEN 'skipped' ELSE 'refused' END AS outcome,
                   CASE WHEN step LIKE 'unknown-%' THEN step END AS reason,
                   CASE step
                       WHEN 'unknown-division' THEN format('The division "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.division_label)
                       WHEN 'unknown-location' THEN format('The location "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.location_label)
                       WHEN 'unknown-field' THEN format('The field "%s" of "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.field_label, r2.location_label)
                       WHEN 'unknown-subunit' THEN format('The half or side "%s" of "%s" has no decision this import can use. Leave Subunit blank for the whole field.', r2.subunit_label, r2.field_label)
                       WHEN 'unknown-team' THEN format('The team "%s" of "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.team_label, r2.division_label)
                   END AS message,
                   CASE WHEN step LIKE 'skip:%' THEN substr(step, 6) END AS skip_kind,
                   CASE step WHEN 'skip:division' THEN r2.division_label WHEN 'skip:location' THEN r2.location_label
                             WHEN 'skip:field' THEN r2.field_label WHEN 'skip:subunit' THEN r2.subunit_label WHEN 'skip:team' THEN r2.team_label END AS skip_label,
                   CASE WHEN step IS NULL THEN dv.ref END AS div_ref, CASE WHEN step IS NULL THEN l.ref END AS loc_ref,
                   CASE WHEN step IS NULL THEN f.ref END AS fld_ref, CASE WHEN step IS NULL THEN s.ref END AS sub_ref,
                   CASE WHEN step IS NULL THEN t.ref END AS team_ref
              FROM _pi_rows r2
              LEFT JOIN _pi_div dv ON dv.dkey = r2.division_key AND r2.status = 'placement'
              LEFT JOIN _pi_loc l ON l.lkey = r2.location_key
              LEFT JOIN _pi_fld f ON f.fkey = r2.field_key
              LEFT JOIN _pi_sub s ON s.skey = r2.subunit_key AND r2.subunit_key <> ''
              LEFT JOIN _pi_team t ON t.tkey = r2.team_key AND r2.status = 'placement'
              CROSS JOIN LATERAL (SELECT CASE
                       WHEN r2.status = 'placement' AND dv.action = 'skip' THEN 'skip:division'
                       WHEN r2.status = 'placement' AND dv.ref IS NULL THEN 'unknown-division'
                       WHEN l.action = 'skip' THEN 'skip:location'
                       WHEN l.ref IS NULL THEN 'unknown-location'
                       WHEN f.action = 'skip' THEN 'skip:field'
                       WHEN f.ref IS NULL THEN 'unknown-field'
                       WHEN r2.subunit_key <> '' AND s.action = 'skip' THEN 'skip:subunit'
                       WHEN r2.subunit_key <> '' AND s.ref IS NULL THEN 'unknown-subunit'
                       WHEN r2.status = 'placement' AND t.action = 'skip' THEN 'skip:team'
                       WHEN r2.status = 'placement' AND t.ref IS NULL THEN 'unknown-team'
                   END AS step) st
             WHERE r2.outcome = 'ok' AND r2.status IN ('placement', 'open')
          ) x
         WHERE x.rowno = r.rowno;

        -- A hold makes no slot and asks for no mapping: it uses the ground the decisions give it (a map, or what a placement or
        -- open row creates), and has none when they give none (no flag is possible then).
        UPDATE _pi_rows r
           SET loc_ref = (SELECT l.ref FROM _pi_loc l WHERE l.lkey = r.location_key AND l.action IN ('map', 'create')),
               fld_ref = (SELECT f.ref FROM _pi_fld f WHERE f.fkey = r.field_key AND f.action IN ('map', 'create')),
               sub_ref = CASE WHEN r.subunit_key = '' THEN NULL
                              ELSE (SELECT s.ref FROM _pi_sub s WHERE s.skey = r.subunit_key AND s.action IN ('map', 'create')) END
         WHERE r.outcome = 'ok' AND r.status = 'hold';
        -- A hold on a half the decisions do not give has no ground (never the whole field instead).
        UPDATE _pi_rows SET fld_ref = NULL WHERE outcome = 'ok' AND status = 'hold' AND subunit_key <> '' AND sub_ref IS NULL;

        -- The same practice twice by the admin's own mapping: the first wins.
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'duplicate-row',
               message = 'After mapping, this is the same practice as an earlier row; the earlier row is the one imported.'
          FROM (SELECT x.rowno, row_number() OVER (PARTITION BY x.status, x.team_ref, x.fld_ref, x.sub_ref, x.dow, x.start_time,
                                                    x.end_time, x.valid_from, x.valid_until, x.capacity ORDER BY x.rowno) AS n
                  FROM _pi_rows x WHERE x.outcome = 'ok' AND x.status IN ('placement', 'open')) d
         WHERE d.rowno = r.rowno AND d.n > 1;

        -- ------------------------------------------------------------ 3. The grounds the admin chose to create.
        -- Made before the slots (a slot names its field); any that ends up used by no written row is taken out again below,
        -- so what is created is what core's resolvePracticeRows lists from the rows that survive.
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
        SELECT d.ref, v_org, v_season, d.cname FROM _pi_div d
         WHERE d.creator AND d.ref IN (SELECT div_ref FROM _pi_rows WHERE outcome = 'ok');
        INSERT INTO public.locations (id, organization_id, name)
        SELECT l.ref, v_org, l.cname FROM _pi_loc l
         WHERE l.creator AND l.ref IN (SELECT loc_ref FROM _pi_rows WHERE outcome = 'ok' AND status <> 'hold');
        -- A field the import creates supports halves when a row names a half of it (finalize_field_import_job's rule for a
        -- field it creates). A field that exists is never changed, even when the import creates a half on it.
        INSERT INTO public.fields (id, organization_id, location_id, name, supports_halves)
        SELECT f.ref, v_org, f.loc_ref, f.cname,
               EXISTS (SELECT 1 FROM _pi_rows r WHERE r.fld_ref = f.ref AND r.outcome = 'ok' AND r.subunit_key <> '')
          FROM _pi_fld f
         WHERE f.creator AND f.ref IN (SELECT fld_ref FROM _pi_rows WHERE outcome = 'ok' AND status <> 'hold');
        INSERT INTO public.field_subunits (id, organization_id, field_id, label)
        SELECT s.ref, v_org, s.fld_ref, s.cname FROM _pi_sub s
         WHERE s.creator AND s.ref IN (SELECT sub_ref FROM _pi_rows WHERE outcome = 'ok' AND status <> 'hold');

        -- ------------------------------------------------------------ 4. The slots, one per (field, half, weekday, start, from).
        CREATE TEMP TABLE _pi_grp ON COMMIT DROP AS
        SELECT DISTINCT ON (r.fld_ref, r.sub_ref, r.dow, r.start_time, r.valid_from)
               r.fld_ref, r.sub_ref, r.dow, r.start_time, r.valid_from, r.end_time, r.valid_until, r.capacity, r.rowno AS first_row,
               NULL::boolean AS holds_team, NULL::uuid AS slot_id, NULL::boolean AS created, NULL::uuid AS clash_id,
               NULL::uuid AS differs_id, NULL::text AS differs
          FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status IN ('placement', 'open')
         ORDER BY r.fld_ref, r.sub_ref, r.dow, r.start_time, r.valid_from, r.rowno;
        -- A slot is one End, Valid Until and Capacity: a later row that says otherwise is refused.
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'slot-overlaps-another',
               message = format('This is the same slot as row %s with a different End, Valid Until or Capacity. A slot is one of each: make the rows agree.', g.first_row)
          FROM _pi_grp g
         WHERE r.outcome = 'ok' AND r.status IN ('placement', 'open')
           AND r.fld_ref = g.fld_ref AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time
           AND r.valid_from = g.valid_from AND (r.end_time, r.valid_until, r.capacity) IS DISTINCT FROM (g.end_time, g.valid_until, g.capacity);
        UPDATE _pi_grp g SET holds_team = EXISTS (
            SELECT 1 FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status = 'placement' AND r.fld_ref = g.fld_ref
               AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time AND r.valid_from = g.valid_from);
        -- When two slots claim one ground, the one a team is placed in is kept over an empty one, else the earlier row
        -- (core's order): the groups that hold a team first, each in file order.
        FOR v_grp IN SELECT * FROM _pi_grp ORDER BY NOT holds_team, first_row LOOP
            SELECT * INTO v_slot FROM public.ensure_practice_slot(v_org, v_grp.fld_ref, v_grp.sub_ref, v_grp.dow, v_grp.start_time,
                                                                   v_grp.end_time, v_grp.valid_from, v_grp.valid_until, v_grp.capacity);
            UPDATE _pi_grp SET slot_id = v_slot.slot_id, created = v_slot.created, clash_id = v_slot.conflict_slot_id
             WHERE first_row = v_grp.first_row;
        END LOOP;
        -- A slot that is FOUND is never changed (plan 4.11.3), so a row that describes it otherwise (another End, Capacity or
        -- Valid Until) is refused, naming what differs: written against it, a practice could outlive its slot, or sit in a
        -- slot of another length or size than the file says.
        UPDATE _pi_grp g
           SET differs_id = g.slot_id, slot_id = NULL,
               differs = concat_ws('; ',
                   CASE WHEN ps.end_time <> g.end_time THEN format('its end is %s, the row''s %s', left(ps.end_time::text, 5), left(g.end_time::text, 5)) END,
                   CASE WHEN COALESCE(ps.capacity, 1) <> g.capacity THEN format('its capacity is %s, the row''s %s', COALESCE(ps.capacity, 1), g.capacity) END,
                   CASE WHEN ps.valid_until IS DISTINCT FROM g.valid_until
                        THEN format('its last date is %s, the row''s %s', COALESCE(ps.valid_until::text, 'open'), g.valid_until) END)
          FROM public.practice_slots ps
         WHERE ps.id = g.slot_id AND NOT g.created
           AND (ps.end_time <> g.end_time OR COALESCE(ps.capacity, 1) <> g.capacity OR ps.valid_until IS DISTINCT FROM g.valid_until);
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'slot-differs',
               message = format('The slot this row names is saved already (%s) and differs: %s. An import never changes a saved slot: change the slot on Field Management, or make the row match it.',
                                g.differs_id, g.differs)
          FROM _pi_grp g
         WHERE g.differs_id IS NOT NULL AND r.outcome = 'ok' AND r.status IN ('placement', 'open')
           AND r.fld_ref = g.fld_ref AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time
           AND r.valid_from = g.valid_from;
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'slot-overlaps-another',
               message = CASE WHEN o.first_row IS NOT NULL
                              THEN format('This slot overlaps the slot of row %s on the same ground at the same time. Two slots cannot claim one ground: the one a team is placed in is imported, else the earlier row.', o.first_row)
                              ELSE format('This slot overlaps the saved slot %s on the same ground at the same time (a slot that exists is never changed by an import). Fix the slot on Field Management, or set this row''s dates to the slot''s.', g.clash_id) END
          FROM _pi_grp g
          LEFT JOIN _pi_grp o ON o.slot_id = g.clash_id AND o.created
         WHERE g.clash_id IS NOT NULL AND r.outcome = 'ok' AND r.status IN ('placement', 'open')
           AND r.fld_ref = g.fld_ref AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time
           AND r.valid_from = g.valid_from;

        -- What was created and no written row uses (every row of a created half refused, say) is taken out again.
        DELETE FROM public.field_subunits s USING _pi_sub x
         WHERE x.creator AND s.id = x.ref AND NOT EXISTS (SELECT 1 FROM _pi_grp g WHERE g.sub_ref = s.id AND g.slot_id IS NOT NULL);
        -- (A field is deleted only after the shared producer of bookings says it holds none: docs/sql/20260909000000_smoke.sql
        -- holds every function that deletes a field to it. One made a moment ago holds none unless a slot of this file is on it.)
        DELETE FROM public.fields f USING _pi_fld x
         WHERE x.creator AND f.id = x.ref AND NOT EXISTS (SELECT 1 FROM _pi_grp g WHERE g.fld_ref = f.id AND g.slot_id IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM public.field_bookings(v_org, f.id, NULL) b);
        DELETE FROM public.locations l USING _pi_loc x
         WHERE x.creator AND l.id = x.ref AND NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.location_id = l.id);

        -- ------------------------------------------------------------ 5. The rows of the file as practices.
        CREATE TEMP TABLE _pi_asg ON COMMIT DROP AS
        SELECT r.rowno, r.row_key, r.team_ref, r.team_label, g.slot_id, daterange(r.valid_from, r.valid_until, '[]') AS rng,
               (SELECT pa.id FROM public.practice_assignments pa
                 WHERE pa.team_id = r.team_ref AND pa.practice_slot_id = g.slot_id
                   AND pa.effective_date_range = daterange(r.valid_from, r.valid_until, '[]')) AS existing_id,
               NULL::uuid AS new_id, false AS probable_move, false AS held_back
          FROM _pi_rows r
          JOIN _pi_grp g ON g.fld_ref = r.fld_ref AND g.sub_ref IS NOT DISTINCT FROM r.sub_ref AND g.dow = r.dow
                        AND g.start_time = r.start_time AND g.valid_from = r.valid_from
         WHERE r.outcome = 'ok' AND r.status = 'placement' AND g.slot_id IS NOT NULL;

        -- In the schedule, not in this file: a saved practice of a team the file places, the file does not hold, and live on
        -- a date of the file's span for that team (its range cut to its slot's validity, as the gate reads one, against the
        -- first to the last date of the team's rows). A fall practice is not "leaving" a spring file. An import never deletes;
        -- the admin removes one on the Practices page with the unlock prompt, as today.
        CREATE TEMP TABLE _pi_leave ON COMMIT DROP AS
        WITH span AS (
            SELECT a.team_ref, daterange(min(lower(a.rng)), max(upper(a.rng)), '[)') AS rng FROM _pi_asg a GROUP BY a.team_ref
        ), saved AS (
            SELECT pa.id, pa.team_id, t.name AS team, ps.day_of_week::text AS day, ps.start_time, ps.end_time, ps.field_id,
                   ps.field_subunit_id, pa.effective_date_range AS rng,
                   GREATEST(lower(pa.effective_date_range), ps.valid_from) AS lo,
                   LEAST(upper(pa.effective_date_range) - 1, ps.valid_until) AS hi
              FROM public.practice_assignments pa
              JOIN public.teams t ON t.id = pa.team_id AND NOT t.is_external
              JOIN public.divisions d ON d.id = t.division_id AND d.season_settings_id = v_season
              JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
             WHERE pa.organization_id = v_org
               AND (pa.effective_date_range IS NULL OR NOT isempty(pa.effective_date_range))
               AND pa.id NOT IN (SELECT a.existing_id FROM _pi_asg a WHERE a.existing_id IS NOT NULL)
        )
        SELECT sv.id, sv.team_id, sv.team, sv.day, sv.start_time, sv.end_time, sv.field_id, sv.field_subunit_id, sv.rng,
               daterange(sv.lo, sv.hi, '[]') AS live
          FROM saved sv
          JOIN span sp ON sp.team_ref = sv.team_id
         WHERE (sv.lo IS NULL OR sv.hi IS NULL OR sv.lo <= sv.hi)
           AND daterange(sv.lo, sv.hi, '[]') && sp.rng;
        -- New in this file, for a team with a row leaving on a date this row is live too: a probable move (the pair is the
        -- team, as core's pairProbableMoves pairs it, narrowed to rows whose dates meet), not added unless the admin ticked it.
        UPDATE _pi_asg a SET probable_move = true, held_back = NOT (a.row_key = ANY (v_add))
         WHERE a.existing_id IS NULL
           AND EXISTS (SELECT 1 FROM _pi_leave l WHERE l.team_id = a.team_ref AND l.live && a.rng);

        -- ------------------------------------------------------------ 6. Team shells, in ONE team run (as the games import's).
        DELETE FROM public.divisions dv USING _pi_div x
         WHERE x.creator AND dv.id = x.ref AND NOT EXISTS (SELECT 1 FROM _pi_asg a JOIN _pi_team t ON t.ref = a.team_ref WHERE t.div_ref = dv.id);
        SELECT COALESCE(array_agg(DISTINCT t.ref ORDER BY t.ref), ARRAY[]::uuid[]) INTO v_shell_arr
          FROM _pi_team t WHERE t.creator AND t.ref IN (SELECT team_ref FROM _pi_asg);
        IF cardinality(v_shell_arr) > 0 THEN
            -- The pages read the LATEST team run (`mapSchedulerRunToSummary` reads `results.teamsByDivision`), so the run is
            -- the latest completed run's results carried forward whole, with each division's shells added to it (lesson 104;
            -- copied from apply_game_import_job's latest body).
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
                SELECT t.div_ref, (SELECT dv.name FROM public.divisions dv WHERE dv.id = t.div_ref) AS dname
                  FROM _pi_team t WHERE t.creator AND t.ref = ANY (v_shell_arr)
                 GROUP BY t.div_ref ORDER BY t.div_ref
            LOOP
                v_key := NULL;
                SELECT e.key INTO v_key
                  FROM jsonb_each(v_grouped) e
                 WHERE lower(e.key) = lower(v_div.div_ref::text) OR e.key = v_div.dname
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.value) et
                                WHERE lower(COALESCE(et ->> 'division_id', et ->> 'divisionId', '')) = lower(v_div.div_ref::text))
                 ORDER BY e.key COLLATE "C"
                 LIMIT 1;
                IF v_key IS NULL THEN
                    v_key := v_div.dname;
                    v_grouped := v_grouped || jsonb_build_object(v_key, COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'division', v_key, 'division_id', v_div.div_ref,
                                   'coachId', t.coach_id, 'assistantCoachIds', to_jsonb(COALESCE(t.assistant_coach_ids, '{}'::uuid[])),
                                   'players', '[]'::jsonb) ORDER BY t.name, t.id)
                          FROM public.teams t
                         WHERE t.division_id = v_div.div_ref AND NOT t.is_external AND t.id <> ALL (v_shell_arr)), '[]'::jsonb));
                END IF;
                v_label := COALESCE(NULLIF(v_grouped -> v_key -> 0 ->> 'division', ''), v_key);
                v_grouped := jsonb_set(v_grouped, ARRAY[v_key], (v_grouped -> v_key) || COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', t.ref, 'name', t.cname, 'division', v_label, 'division_id', v_div.div_ref,
                               'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb) ORDER BY t.cname, t.ref)
                      FROM _pi_team t
                     WHERE t.creator AND t.div_ref = v_div.div_ref AND t.ref = ANY (v_shell_arr)), '[]'::jsonb));
            END LOOP;
            v_results := v_base || jsonb_build_object(
                'teamsByDivision', v_grouped,
                'teams', COALESCE((SELECT jsonb_agg(x.team) FROM jsonb_each(v_grouped) e, jsonb_array_elements(e.value) AS x(team)), '[]'::jsonb),
                'team_players', CASE WHEN jsonb_typeof(v_base -> 'team_players') = 'array' THEN v_base -> 'team_players' ELSE '[]'::jsonb END);
            v_team_run := public.persist_team_schedule(
                jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'team', 'status', 'completed',
                    'completed_at', clock_timestamp(),
                    'parameters', jsonb_build_object('source', 'import', 'import_type', 'practice_schedule', 'import_job_id', p_import_job_id,
                                                     'shell_ids', to_jsonb(v_shell_arr)),
                    'results', v_results),
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.ref, 'division_id', t.div_ref, 'name', t.cname) ORDER BY t.ref), '[]'::jsonb)
                   FROM _pi_team t WHERE t.creator AND t.ref = ANY (v_shell_arr)),
                '[]'::jsonb);
        END IF;

        -- ------------------------------------------------------------ 7. The practices: additive, manual, no run.
        SELECT count(*) INTO v_planned FROM _pi_asg WHERE existing_id IS NULL AND NOT held_back;
        WITH ins AS (
            INSERT INTO public.practice_assignments (organization_id, run_id, team_id, slot_id, practice_slot_id, day_of_week,
                                                     start_time, end_time, field_id, effective_date_range, source, assigned_via)
            SELECT v_org, NULL, a.team_ref, a.slot_id, a.slot_id, ps.day_of_week::text, ps.start_time::text, ps.end_time::text,
                   ps.field_id, a.rng, 'manual'::public.source_enum, 'manual'
              FROM _pi_asg a JOIN public.practice_slots ps ON ps.id = a.slot_id
             -- Every row of the file goes to the insert, the ones already saved too: the unique key (team, slot, range)
             -- turns a saved one into nothing (a re-import inserts nothing), and the count below holds the planned new ones.
             WHERE NOT a.held_back
             ORDER BY a.rowno
            ON CONFLICT (team_id, practice_slot_id, effective_date_range)
                WHERE practice_slot_id IS NOT NULL AND effective_date_range IS NOT NULL
            DO NOTHING
            RETURNING id, team_id, practice_slot_id, effective_date_range
        )
        UPDATE _pi_asg a SET new_id = ins.id
          FROM ins WHERE ins.team_id = a.team_ref AND ins.practice_slot_id = a.slot_id AND ins.effective_date_range = a.rng;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> v_planned THEN
            RAISE EXCEPTION 'practice import planned % practices and wrote %', v_planned, v_rc USING ERRCODE = 'XX000';
        END IF;

        -- The application records, one per row written, with the image it was written with (the rollback compares it).
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'practice_schedule', x.t, x.id, 'inserted', NULL, x.img, v_now, v_uid
          FROM (SELECT 'divisions' AS t, d.id, to_jsonb(d) AS img FROM public.divisions d WHERE d.id IN (SELECT ref FROM _pi_div WHERE creator)
                UNION ALL SELECT 'locations', l.id, to_jsonb(l) FROM public.locations l WHERE l.id IN (SELECT ref FROM _pi_loc WHERE creator)
                UNION ALL SELECT 'fields', f.id, to_jsonb(f) FROM public.fields f WHERE f.id IN (SELECT ref FROM _pi_fld WHERE creator)
                UNION ALL SELECT 'field_subunits', s.id, to_jsonb(s) FROM public.field_subunits s WHERE s.id IN (SELECT ref FROM _pi_sub WHERE creator)
                UNION ALL SELECT 'teams', t.id, to_jsonb(t) FROM public.teams t WHERE t.id = ANY (v_shell_arr)
                UNION ALL SELECT 'practice_slots', ps.id, to_jsonb(ps) FROM public.practice_slots ps WHERE ps.id IN (SELECT slot_id FROM _pi_grp WHERE created)
                UNION ALL SELECT 'practice_assignments', pa.id, to_jsonb(pa) FROM public.practice_assignments pa WHERE pa.id IN (SELECT new_id FROM _pi_asg)) x;

        -- ------------------------------------------------------------ 8. The flags, read from the rows the file names.
        CREATE TEMP TABLE _pi_flag (rowno integer, row_key text, team_id uuid, code text, detail text) ON COMMIT DROP;
        SELECT COALESCE(array_agg(COALESCE(a.existing_id, a.new_id)), ARRAY[]::uuid[]) INTO v_ids
          FROM _pi_asg a WHERE COALESCE(a.existing_id, a.new_id) IS NOT NULL;
        -- The gate's five rules, read-only: it judges whatever source the rows carry (20261105010000). Its words name
        -- assignment ids, which a dry run and an apply make anew; the result says the rule and words that name none.
        INSERT INTO _pi_flag
        SELECT a.rowno, a.row_key, a.team_ref, g.rule,
               CASE WHEN g.rule IN ('capacity', 'length', 'count') THEN g.detail
                    WHEN g.rule = 'weekday' THEN 'the team has another practice on this weekday on a shared date'
                    ELSE 'the slot is reserved to another division' END
          FROM public.practice_new_auto_row_refusals(v_org, v_ids) g
          JOIN _pi_asg a ON COALESCE(a.existing_id, a.new_id) = g.assignment_id;
        -- coach-conflict: a coach of this team coaches another team (in force on a shared date, team_coach_assignments) that
        -- practises at an overlapping time on the same weekday on a shared date: any saved row of the season, this file's too.
        INSERT INTO _pi_flag
        SELECT DISTINCT ON (a.rowno, ca.coach_id) a.rowno, a.row_key, a.team_ref, 'coach-conflict',
               format('a coach of this team (%s) also coaches %s at an overlapping time on this weekday', ca.coach_id, ot.name)
          FROM _pi_asg a
          JOIN public.practice_assignments pa ON pa.id = COALESCE(a.existing_id, a.new_id)
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          JOIN public.team_coach_assignments ca ON ca.team_id = a.team_ref
          JOIN public.team_coach_assignments cb ON cb.coach_id = ca.coach_id AND cb.team_id <> a.team_ref
          JOIN public.teams ot ON ot.id = cb.team_id AND NOT ot.is_external
          JOIN public.practice_assignments pb ON pb.team_id = cb.team_id AND pb.organization_id = v_org
          JOIN public.practice_slots pbs ON pbs.id = pb.practice_slot_id
          -- The shared dates: each practice's range cut to its OWN slot's validity (a NULL range, or a bound it lacks, is
          -- the slot's: practice_new_auto_row_refusals' rule and core's assignmentLiveSpan), and both coach assignments in
          -- force. GREATEST and LEAST skip a NULL, so an open bound is open.
          CROSS JOIN LATERAL (
              SELECT COALESCE(GREATEST(lower(pa.effective_date_range), ps.valid_from, lower(pb.effective_date_range), pbs.valid_from,
                                       ca.effective_from, cb.effective_from), '-infinity'::date) AS lo,
                     COALESCE(LEAST(upper(pa.effective_date_range) - 1, ps.valid_until, upper(pb.effective_date_range) - 1, pbs.valid_until,
                                    ca.effective_to, cb.effective_to), 'infinity'::date) AS hi) w
         WHERE pbs.day_of_week = ps.day_of_week AND pbs.start_time < ps.end_time AND ps.start_time < pbs.end_time
           AND (pb.effective_date_range IS NULL OR NOT isempty(pb.effective_date_range))
           AND isfinite(w.lo) AND w.lo <= w.hi
           AND w.lo + ((array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun']::public.day_of_week[], ps.day_of_week)
                        - extract(isodow FROM w.lo)::int + 7) % 7) <= w.hi
         ORDER BY a.rowno, ca.coach_id, ot.name;
        -- team-on-both-halves: a team on two halves of one field at one time (two rows, never merged on the admin's behalf).
        INSERT INTO _pi_flag
        SELECT a.rowno, a.row_key, a.team_ref, 'team-on-both-halves',
               format('the team is on both halves of this field at the same time (rows %s). That is the whole field: leave Subunit blank for the whole field.',
                      string_agg(b.rowno::text, ', ' ORDER BY b.rowno))
          FROM _pi_asg a
          JOIN _pi_rows ra ON ra.rowno = a.rowno
          JOIN _pi_asg b ON b.team_ref = a.team_ref AND b.rowno <> a.rowno
          JOIN _pi_rows rb ON rb.rowno = b.rowno
         WHERE ra.fld_ref = rb.fld_ref AND ra.sub_ref IS NOT NULL AND rb.sub_ref IS NOT NULL AND ra.sub_ref <> rb.sub_ref
           AND ra.dow = rb.dow AND ra.start_time < rb.end_time AND rb.start_time < ra.end_time
           AND GREATEST(ra.valid_from, rb.valid_from) + ((array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun']::public.day_of_week[], ra.dow)
                - extract(isodow FROM GREATEST(ra.valid_from, rb.valid_from))::int + 7) % 7) <= LEAST(ra.valid_until, rb.valid_until)
         GROUP BY a.rowno, a.row_key, a.team_ref;
        -- hold-over-open-slot: a cell held for a non-team activity where a slot is (the file's or a saved one).
        INSERT INTO _pi_flag
        SELECT r.rowno, r.row_key, NULL, 'hold-over-open-slot',
               format('This cell is held for a non-team activity, but %s slot(s) are there%s. The hold makes no slot, and removes or moves nothing.',
                      c.n, CASE WHEN c.used THEN ', with a team in one' ELSE '' END)
          FROM _pi_rows r
          CROSS JOIN LATERAL (
              SELECT count(*) AS n, bool_or(EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.practice_slot_id = x.slot_id)) AS used
                FROM public.practice_slot_conflicts(v_org, r.fld_ref, r.sub_ref, r.dow, r.start_time, r.end_time, r.valid_from, r.valid_until, NULL, 0) x) c
         WHERE r.outcome = 'ok' AND r.status = 'hold' AND r.fld_ref IS NOT NULL
           -- The ground must stand after the plan: a field or half a decision would create but no written row made, or one
           -- made and taken out again, is no ground.
           AND EXISTS (SELECT 1 FROM public.fields f WHERE f.id = r.fld_ref)
           AND (r.sub_ref IS NULL OR EXISTS (SELECT 1 FROM public.field_subunits su WHERE su.id = r.sub_ref)) AND c.n > 0;
        -- division-not-reserved: the parse's own flag (a Division on a row with no team reserves nothing here).
        INSERT INTO _pi_flag
        SELECT r.rowno, r.row_key, NULL, 'division-not-reserved',
               'A Division on a row with no team reserves nothing in this import (an admin sets reservations on Field Management).'
          FROM _pi_rows r WHERE r.outcome = 'ok' AND 'division-not-reserved' = ANY (r.flags);

        -- ------------------------------------------------------------ 9. Teams short of their count join the TIME TBD list.
        v_tbd := public.refresh_schedule_tbd_practices(v_season);

        -- ------------------------------------------------------------ 10. The result: what was (or would be) done.
        v_result := jsonb_build_object(
            'job_id', p_import_job_id,
            'counts', jsonb_build_object(
                'rows', n_staged,
                'placements', (SELECT count(*) FROM _pi_rows WHERE NOT parse_refused AND status = 'placement'),
                'open', (SELECT count(*) FROM _pi_rows WHERE NOT parse_refused AND status = 'open'),
                'holds', (SELECT count(*) FROM _pi_rows WHERE NOT parse_refused AND status = 'hold'),
                'refused', (SELECT count(*) FROM _pi_rows WHERE outcome = 'refused'),
                'skipped', (SELECT count(*) FROM _pi_rows WHERE outcome = 'skipped'),
                'inserted', (SELECT count(*) FROM _pi_asg WHERE new_id IS NOT NULL),
                'unchanged', (SELECT count(*) FROM _pi_asg WHERE existing_id IS NOT NULL),
                'held_back', (SELECT count(*) FROM _pi_asg WHERE held_back),
                'slots_created', (SELECT count(*) FROM _pi_grp WHERE created),
                'slots_found', (SELECT count(*) FROM _pi_grp WHERE slot_id IS NOT NULL AND NOT created),
                'divisions_created', (SELECT count(*) FROM _pi_div x WHERE x.creator AND EXISTS (SELECT 1 FROM public.divisions d WHERE d.id = x.ref)),
                'locations_created', (SELECT count(*) FROM _pi_loc x WHERE x.creator AND EXISTS (SELECT 1 FROM public.locations l WHERE l.id = x.ref)),
                'fields_created', (SELECT count(*) FROM _pi_fld x WHERE x.creator AND EXISTS (SELECT 1 FROM public.fields f WHERE f.id = x.ref)),
                'subunits_created', (SELECT count(*) FROM _pi_sub x WHERE x.creator AND EXISTS (SELECT 1 FROM public.field_subunits s WHERE s.id = x.ref)),
                'team_shells_created', cardinality(v_shell_arr),
                'leaving', (SELECT count(*) FROM _pi_leave),
                'arriving', (SELECT count(*) FROM _pi_asg WHERE existing_id IS NULL),
                'probable_move_teams', (SELECT count(DISTINCT team_ref) FROM _pi_asg WHERE probable_move)),
            'refused_by_reason', (SELECT COALESCE(jsonb_object_agg(reason, n), '{}'::jsonb)
                                    FROM (SELECT reason, count(*) AS n FROM _pi_rows WHERE outcome = 'refused' GROUP BY reason) x),
            'refused', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'reason', reason, 'message', message) ORDER BY rowno), '[]'::jsonb)
                          FROM _pi_rows WHERE outcome = 'refused'),
            'skipped', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'kind', skip_kind, 'label', skip_label) ORDER BY rowno), '[]'::jsonb)
                          FROM _pi_rows WHERE outcome = 'skipped'),
            'flags', (SELECT COALESCE(jsonb_object_agg(code, jsonb_build_object('rows', nr, 'teams', nt)), '{}'::jsonb)
                        FROM (SELECT code, count(DISTINCT rowno) AS nr, count(DISTINCT team_id) AS nt FROM _pi_flag GROUP BY code) x),
            'flagged', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'code', code, 'detail', detail) ORDER BY rowno, code, detail), '[]'::jsonb)
                          FROM _pi_flag),
            'arriving', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'team_id', team_ref, 'team', team_label,
                                                                    'probable_move', probable_move, 'added', NOT held_back) ORDER BY rowno), '[]'::jsonb)
                           FROM _pi_asg WHERE existing_id IS NULL),
            'leaving', (SELECT COALESCE(jsonb_agg(jsonb_build_object('assignment_id', id, 'team_id', team_id, 'team', team, 'day', day,
                                                                   'start_time', left(start_time::text, 5), 'end_time', left(end_time::text, 5),
                                                                   'field_id', field_id, 'field_subunit_id', field_subunit_id, 'range', rng::text)
                                                ORDER BY team, day, start_time, id), '[]'::jsonb)
                          FROM _pi_leave),
            'holds', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', h.rowno, 'row_key', h.row_key,
                                  'ground_known', EXISTS (SELECT 1 FROM public.fields f WHERE f.id = h.fld_ref)
                                                  AND (h.sub_ref IS NULL OR EXISTS (SELECT 1 FROM public.field_subunits su WHERE su.id = h.sub_ref)))
                                  ORDER BY h.rowno), '[]'::jsonb)
                        FROM _pi_rows h WHERE h.outcome = 'ok' AND h.status = 'hold'),
            'time_tbd', jsonb_build_object(
                'practice_rows', v_tbd -> 'practice_rows',
                'missing_practices', v_tbd -> 'missing_practices',
                'teams', (SELECT COALESCE(jsonb_agg(jsonb_build_object('team_id', s.team_id, 'missing_count', s.missing_count,
                                                                      'in_file', s.team_id IN (SELECT team_ref FROM _pi_rows WHERE team_ref IS NOT NULL))
                                                    ORDER BY s.team_id), '[]'::jsonb)
                            FROM public.schedule_tbd s
                           WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'practice')),
            'coverage', jsonb_build_object(
                'checked', jsonb_build_array('capacity', 'reservation', 'length', 'weekday', 'count', 'coach-conflict', 'team-on-both-halves', 'hold-over-open-slot'),
                'not_checked', jsonb_build_array('coach preference rules', 'daylight and sunset', 'field closures and permits', 'travel or turnover between fields'),
                'coach_judged_teams', (SELECT count(DISTINCT a.team_ref) FROM _pi_asg a
                                        WHERE EXISTS (SELECT 1 FROM public.team_coach_assignments c WHERE c.team_id = a.team_ref)),
                'file_teams', (SELECT count(DISTINCT team_ref) FROM _pi_asg)));
        v_status := CASE WHEN (v_result #>> '{counts,refused}')::int > 0 OR (v_result #>> '{counts,skipped}')::int > 0
                              OR v_result -> 'flags' <> '{}'::jsonb OR (v_result #>> '{counts,held_back}')::int > 0
                         THEN 'completed_with_warnings' ELSE 'completed' END;
        v_result := v_result || jsonb_build_object('status', v_status);

        IF v_dry THEN
            RAISE EXCEPTION 'practice import dry run: every write is undone' USING ERRCODE = 'SLD01';
        END IF;

        BEGIN
            PERFORM public.record_audit_event(v_org, 'import.completed', 'import_job', p_import_job_id,
                jsonb_build_object('import_type', 'practice_schedule', 'status', v_status) || (v_result -> 'counts')
                || jsonb_build_object('flags', v_result -> 'flags', 'refused_by_reason', v_result -> 'refused_by_reason'));
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
        END;
        UPDATE public.import_jobs
           SET status = v_status, processed_rows = n_staged, progress_percent = 100, completed_at = v_now,
               warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{practice_import}', v_result, true)
         WHERE id = p_import_job_id;
    EXCEPTION WHEN SQLSTATE 'SLD01' THEN
        -- The dry run's sentinel, and nothing else: every other error propagates.
        NULL;
    END;

    RETURN v_result || jsonb_build_object('dry_run', v_dry,
        'ids', jsonb_build_object('team_run_id', CASE WHEN v_dry THEN NULL ELSE v_team_run END));
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_practice_import_job(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_practice_import_job(uuid, boolean) TO authenticated;
COMMENT ON FUNCTION public.apply_practice_import_job(uuid, boolean) IS
    'Admin-only, signed in, the active season: preview (p_dry_run => true, every write undone by a sentinel) or apply a practice schedule import with the mapping stored on the job. Additive: manual practices inserted ON CONFLICT DO NOTHING, nothing saved is changed or deleted; slots found or made (ensure_practice_slot); the arriving rows of a probable move are not added unless ticked; every rule broken is flagged, never refused; teams short of their count join the TIME TBD list. 20261123010000.';

-- ---------------------------------------------------------------------------
-- 7. rollback_practice_import_job: take an import back, or say what stands in the way.
-- ---------------------------------------------------------------------------
--
-- Every (table, operation) pair the apply records is `inserted` (it never updates or deletes): practice_assignments,
-- practice_slots, field_subunits, fields, locations, teams, divisions (tests/practiceImportRollbackClass.test.js reads
-- them out of the apply's text and the mock's, and the pgTAP file makes a later change to each). For each:
--   * an assignment changed since in its team, slot, range, source or assigned_via, or with an exception row: REFUSED
--     (22023 practice_import_changed), the one necessary blocker (deleting it would destroy a later writer's work);
--   * an assignment a later writer removed: gone already, counted (`assignments_already_gone`);
--   * anything else created, changed since (any column the apply stored, game_import_row_unchanged) or referenced by any
--     row of any table (practice_import_referenced_ids, from the catalogue, one query per key; plus players.team_id and a later team run naming
--     a shell, which have no key): KEPT and reported, never deleted.

CREATE FUNCTION public.rollback_practice_import_job(p_import_job_id uuid)
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
    v_season uuid;
    v_season_status text;
    v_pending integer;
    v_changed uuid[];
    v_rec record;
    v_deleted jsonb := '{}'::jsonb;
    n_gone integer;
    n_asg integer;
    n integer;
    n_team_runs integer := 0;
    v_kept jsonb;
    v_tbd jsonb;
    v_result jsonb;
    v_refd uuid[];
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'rollback_practice_import_job needs a signed-in caller to audit the rollback' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    v_season := v_job.season_settings_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'practice_schedule' THEN
        RAISE EXCEPTION 'Import job % is %, not practice_schedule', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;

    -- The apply's locks, in its order, before anything is read as it stands.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('persist_practice_schedule:' || v_org::text || ':' || v_season::text, 0));
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    SELECT s.status INTO v_season_status FROM public.season_settings s WHERE s.id = v_season AND s.organization_id = v_org;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed: its practices are read-only', v_season USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    SELECT count(*) INTO v_pending FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule' AND r.rolled_back_at IS NULL;
    IF v_pending = 0 THEN
        RAISE EXCEPTION 'Import job % has no practice application records to roll back', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'nothing_to_roll_back';
    END IF;

    -- What changed since, judged BEFORE anything is written.
    SELECT COALESCE(array_agg(r.target_id ORDER BY r.target_id), ARRAY[]::uuid[]) INTO v_changed
      FROM public.import_application_records r
      JOIN public.practice_assignments pa ON pa.id = r.target_id
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule' AND r.target_table = 'practice_assignments'
       AND r.rolled_back_at IS NULL
       AND ((pa.team_id::text, pa.practice_slot_id::text, pa.effective_date_range::text, pa.source::text, pa.assigned_via)
               IS DISTINCT FROM (r.applied_payload ->> 'team_id', r.applied_payload ->> 'practice_slot_id',
                                 r.applied_payload ->> 'effective_date_range', r.applied_payload ->> 'source', r.applied_payload ->> 'assigned_via')
            OR EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.assignment_id = pa.id));
    IF cardinality(v_changed) > 0 THEN
        RAISE EXCEPTION 'practice_import_changed count=% ids=%', cardinality(v_changed), array_to_string(v_changed[1:c_listed], ',')
            USING ERRCODE = '22023', DETAIL = 'practice_import_changed',
                  HINT = 'A practice this import wrote has been changed or has an exception since; roll that change back first, or remove the practice on the Practices page.';
    END IF;

    SELECT count(*) INTO n_gone FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule' AND r.target_table = 'practice_assignments'
       AND r.rolled_back_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.id = r.target_id);
    DELETE FROM public.practice_assignments pa USING public.import_application_records r
     WHERE r.target_id = pa.id AND r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule'
       AND r.target_table = 'practice_assignments' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_asg = ROW_COUNT;

    -- The ids every OTHER team run of the organization names, read once (a shell a later run lists is kept).
    IF to_regclass('pg_temp._pr_named') IS NOT NULL THEN
        DROP TABLE pg_temp._pr_named;
    END IF;
    CREATE TEMP TABLE _pr_named ON COMMIT DROP AS
    SELECT DISTINCT lower(m[1]) AS id
      FROM public.scheduler_runs sr,
           LATERAL regexp_matches(sr.results::text, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
     WHERE sr.run_type = 'team' AND sr.organization_id = v_org
       AND sr.parameters ->> 'import_job_id' IS DISTINCT FROM p_import_job_id::text;

    -- The records the import created, children before parents, each deleted only when it is as the apply left it and
    -- nothing references it.
    FOR v_rec IN
        SELECT t.tbl, t.ord FROM (VALUES ('practice_slots', 1), ('field_subunits', 2), ('fields', 3), ('locations', 4),
                                         ('teams', 5), ('divisions', 6)) AS t(tbl, ord) ORDER BY t.ord
    LOOP
        -- The rows of this table something names, asked of the catalogue's keys ONCE per table, after the tables before it
        -- in this order have lost what the rollback deleted from them (a slot the import made no longer names its field).
        v_refd := ARRAY(SELECT public.practice_import_referenced_ids(('public.' || v_rec.tbl)::regclass, ARRAY(
                      SELECT r.target_id FROM public.import_application_records r
                       WHERE r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule'
                         AND r.target_table = v_rec.tbl AND r.operation = 'inserted' AND r.rolled_back_at IS NULL)));
        -- A field is deleted in its own statement, after the shared producer of bookings says it holds none (every function
        -- that deletes a field consults it: docs/sql/20260909000000_smoke.sql), as well as the catalogue's references.
        IF v_rec.tbl = 'fields' THEN
            WITH gone AS (
                DELETE FROM public.fields x USING public.import_application_records r
                 WHERE r.target_id = x.id AND r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule'
                   AND r.target_table = 'fields' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
                   AND public.game_import_row_unchanged(to_jsonb(x), r.applied_payload)
                   AND NOT (x.id = ANY (v_refd))
                   AND NOT EXISTS (SELECT 1 FROM public.field_bookings(v_org, x.id, NULL) b)
                RETURNING 1)
            SELECT count(*) INTO n FROM gone;
            v_deleted := v_deleted || jsonb_build_object('fields', n);
            CONTINUE;
        END IF;
        EXECUTE format($q$
            WITH gone AS (
                DELETE FROM public.%1$I x USING public.import_application_records r
                 WHERE r.target_id = x.id AND r.import_job_id = $1 AND r.import_type = 'practice_schedule'
                   AND r.target_table = %2$L AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
                   AND public.game_import_row_unchanged(to_jsonb(x), r.applied_payload)
                   AND NOT (x.id = ANY ($2))
                   AND (%2$L <> 'teams' OR (NOT EXISTS (SELECT 1 FROM public.players p WHERE p.team_id = x.id)
                                            AND NOT EXISTS (SELECT 1 FROM pg_temp._pr_named nm WHERE nm.id = x.id::text)))
                RETURNING 1)
            SELECT count(*) FROM gone$q$, v_rec.tbl, v_rec.tbl)
          INTO n USING p_import_job_id, v_refd;
        v_deleted := v_deleted || jsonb_build_object(v_rec.tbl, n);
    END LOOP;

    -- The import's team run: deleted when every shell it carries is gone and nothing names it; a run that stays is retired
    -- (status failed, rolled_back) only when it carries no kept shell, and trimmed of the shells that are gone (the games
    -- import's rule in rollback_game_import_job: a reader of a kept run is never shown a team that no longer exists).
    DELETE FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                        WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid))
       AND NOT (sr.id = ANY (ARRAY(SELECT public.practice_import_referenced_ids('public.scheduler_runs'::regclass, ARRAY(
                SELECT x.id FROM public.scheduler_runs x WHERE x.organization_id = v_org AND x.run_type = 'team'
                   AND x.parameters ->> 'import_job_id' = p_import_job_id::text)))));
    GET DIAGNOSTICS n_team_runs = ROW_COUNT;
    UPDATE public.scheduler_runs sr
       SET status = 'failed', parameters = sr.parameters || jsonb_build_object('rolled_back', true)
     WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                        WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid));
    UPDATE public.scheduler_runs sr
       SET parameters = jsonb_set(sr.parameters, '{shell_ids}',
               (SELECT COALESCE(jsonb_agg(sid), '[]'::jsonb) FROM jsonb_array_elements_text(sr.parameters -> 'shell_ids') sid
                 WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid))),
           results = sr.results
               || CASE WHEN jsonb_typeof(sr.results -> 'teamsByDivision') = 'object' THEN jsonb_build_object('teamsByDivision',
                       (SELECT COALESCE(jsonb_object_agg(d.key, d.kept), '{}'::jsonb)
                          FROM (SELECT e.key, (SELECT COALESCE(jsonb_agg(a.x ORDER BY a.ord), '[]'::jsonb)
                                                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END) WITH ORDINALITY a(x, ord)
                                                WHERE NOT ((a.x ->> 'id') = ANY (g.gone))) AS kept
                                  FROM jsonb_each(sr.results -> 'teamsByDivision') e) d
                         WHERE jsonb_array_length(d.kept) > 0)) ELSE '{}'::jsonb END
               || CASE WHEN jsonb_typeof(sr.results -> 'teams') = 'array' THEN jsonb_build_object('teams',
                       (SELECT COALESCE(jsonb_agg(a.x ORDER BY a.ord), '[]'::jsonb) FROM jsonb_array_elements(sr.results -> 'teams') WITH ORDINALITY a(x, ord)
                         WHERE NOT ((a.x ->> 'id') = ANY (g.gone)))) ELSE '{}'::jsonb END
      FROM (SELECT x.id, ARRAY(SELECT sid FROM jsonb_array_elements_text(COALESCE(x.parameters -> 'shell_ids', '[]'::jsonb)) sid
                                WHERE NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid)) AS gone
              FROM public.scheduler_runs x
             WHERE x.organization_id = v_org AND x.run_type = 'team' AND x.parameters ->> 'import_job_id' = p_import_job_id::text) g
     WHERE sr.id = g.id AND cardinality(g.gone) > 0;

    -- What was created and is still there, named, never deleted silently.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('table', r.target_table, 'id', r.target_id) ORDER BY r.target_table, r.target_id), '[]'::jsonb)
      INTO v_kept
      FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule' AND r.rolled_back_at IS NULL
       AND r.target_table <> 'practice_assignments'
       AND CASE r.target_table
               WHEN 'practice_slots' THEN EXISTS (SELECT 1 FROM public.practice_slots x WHERE x.id = r.target_id)
               WHEN 'field_subunits' THEN EXISTS (SELECT 1 FROM public.field_subunits x WHERE x.id = r.target_id)
               WHEN 'fields' THEN EXISTS (SELECT 1 FROM public.fields x WHERE x.id = r.target_id)
               WHEN 'locations' THEN EXISTS (SELECT 1 FROM public.locations x WHERE x.id = r.target_id)
               WHEN 'teams' THEN EXISTS (SELECT 1 FROM public.teams x WHERE x.id = r.target_id)
               WHEN 'divisions' THEN EXISTS (SELECT 1 FROM public.divisions x WHERE x.id = r.target_id)
               ELSE false END;

    UPDATE public.import_application_records r
       SET rolled_back_at = now(), rolled_back_by = v_uid, rollback_payload = jsonb_build_object('rolled_back', true)
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'practice_schedule' AND r.rolled_back_at IS NULL;

    -- The TIME TBD list again, now that the import's practices are gone.
    v_tbd := public.refresh_schedule_tbd_practices(v_season);

    v_result := jsonb_build_object(
        'job_id', p_import_job_id,
        'assignments_deleted', n_asg,
        'assignments_already_gone', n_gone,
        'deleted', v_deleted,
        'team_runs_deleted', n_team_runs,
        'kept', v_kept,
        'time_tbd', jsonb_build_object('practice_rows', v_tbd -> 'practice_rows', 'missing_practices', v_tbd -> 'missing_practices'));

    BEGIN
        PERFORM public.record_audit_event(v_org, 'import.rolled_back', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'practice_schedule') || v_result);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    UPDATE public.import_jobs
       SET status = 'needs_fix',
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{practice_import_rollback}', v_result, true)
     WHERE id = p_import_job_id;
    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.rollback_practice_import_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rollback_practice_import_job(uuid) TO authenticated;
COMMENT ON FUNCTION public.rollback_practice_import_job(uuid) IS
    'Admin-only, signed in: take a practice schedule import back. Refused (22023 practice_import_changed, naming up to 50) while a practice it wrote was changed since or has an exception, and for a completed season; otherwise deletes its practices and every record it created that is as it left it and referenced by nothing (the rest is kept and listed), retires or trims its team run, refreshes the TIME TBD list. Audited import.rolled_back. 20261123010000.';

-- ---------------------------------------------------------------------------
-- 8. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('apply_practice_import_job(uuid,boolean)'), ('rollback_practice_import_job(uuid)'), ('map_practice_import_job(uuid,jsonb)'),
                   ('ensure_practice_slot(uuid,uuid,uuid,day_of_week,time without time zone,time without time zone,date,date,smallint)'),
                   ('practice_import_referenced_ids(regclass,uuid[])')) AS f(sig)
     WHERE to_regprocedure('public.' || f.sig) IS NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'function(s) missing: %', v_bad;
    END IF;
    -- The three client RPCs are definers open to authenticated and closed to anon and PUBLIC; the two helpers to all three.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('apply_practice_import_job', 'rollback_practice_import_job', 'map_practice_import_job')
       AND (NOT p.prosecdef OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'wrong grants on %', v_bad;
    END IF;
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('ensure_practice_slot', 'practice_import_referenced_ids')
       AND (p.prosecdef OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION '% must be internal', v_bad;
    END IF;
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_import_job(uuid,text,text,uuid)')) !~ '''practice_schedule'''
       OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.mark_import_job_ready_to_apply(uuid,text,jsonb)')) !~ '''practice_schedule'''
       OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.cancel_ready_import_job(uuid,text)')) !~ '''practice_schedule''' THEN
        RAISE EXCEPTION 'a replaced body does not carry its change';
    END IF;
    IF cardinality(public.import_allowed_keys('practice_schedule')) <> 19 OR cardinality(public.import_allowed_keys('games')) <> 21 THEN
        RAISE EXCEPTION 'import_allowed_keys has the wrong length for practice_schedule or games';
    END IF;
END;
$$;

COMMIT;
