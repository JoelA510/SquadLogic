-- Revert for 20261123010000_practice_import.sql
--
-- Takes the practice schedule import out: drops the three client RPCs and the two internal helpers, gives the four
-- replaced functions back the bodies they had (create_import_job, mark_import_job_ready_to_apply and import_allowed_keys
-- as 20261121010000 left them, cancel_ready_import_job as 20261122010000 left it), and puts the four lists back.
-- **Those texts are the repository's, not read from production**: the end of this file checks each restored body
-- against the md5 a build of the migrations up to 20261122010000 holds (carriage returns removed), so a typo here fails
-- the revert instead of shipping.
--
-- **It refuses, and says why, while an import is applied.** An application record not yet rolled back is the only way
-- to take an import's practices back, and the CHECKs that name `practice_schedule` cannot come back while one stands. So
-- it stops, naming the count, if any practice schedule application record is not rolled back. Roll the import(s) back
-- first (`rollback_practice_import_job`; a record that something references since stays and is reported).
--
-- **What it deletes:** the practice import's own bookkeeping (its jobs, staged rows and rolled-back application records).
-- **What it keeps:** every practice, slot, division, location, field, half and team the imports made and a rollback left
-- (they are ordinary rows now), and the audit rows (`import.mapped`, `import.completed`, `import.rolled_back` were actions
-- before this migration).
--
-- Verified: the harness applies this on a database built up to the migration, once with an applied import (it must
-- refuse, and change nothing) and once with the import rolled back, and the public catalogue is then compared with a
-- build that stops before the migration.

BEGIN;

DO $revert$
DECLARE
    v_live integer;
BEGIN
    SELECT count(*) INTO v_live FROM public.import_application_records
     WHERE import_type = 'practice_schedule' AND rolled_back_at IS NULL;
    IF v_live > 0 THEN
        RAISE EXCEPTION 'a practice schedule import is still applied: % record(s) not rolled back. Roll the import(s) back first (rollback_practice_import_job); this revert changes nothing.',
            v_live USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'this revert deletes % practice schedule import job(s), % staged row(s) and % rolled-back record(s); every practice, slot, division, location, field, half and team stays',
        (SELECT count(*) FROM public.import_jobs WHERE job_type = 'practice_schedule'),
        (SELECT count(*) FROM public.staging_import_rows WHERE import_type = 'practice_schedule'),
        (SELECT count(*) FROM public.import_application_records WHERE import_type = 'practice_schedule');
END;
$revert$;

-- ---------------------------------------------------------------------------
-- 1. The functions this migration added.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.apply_practice_import_job(uuid, boolean);
DROP FUNCTION IF EXISTS public.rollback_practice_import_job(uuid);
DROP FUNCTION IF EXISTS public.map_practice_import_job(uuid, jsonb);
DROP FUNCTION IF EXISTS public.ensure_practice_slot(uuid, uuid, uuid, public.day_of_week, time, time, date, date, smallint);
DROP FUNCTION IF EXISTS public.practice_import_referenced_ids(regclass, uuid[]);

-- ---------------------------------------------------------------------------
-- 2. The bookkeeping, then the lists.
-- ---------------------------------------------------------------------------

DELETE FROM public.import_application_records WHERE import_type = 'practice_schedule';
DELETE FROM public.staging_import_rows WHERE import_type = 'practice_schedule';
DELETE FROM public.import_jobs WHERE job_type = 'practice_schedule';

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

-- ---------------------------------------------------------------------------
-- 3. The four replaced bodies, as they were.
-- ---------------------------------------------------------------------------

-- create_import_job, as 20261121010000 defined it.
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

-- mark_import_job_ready_to_apply, as 20261121010000 defined it.
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

-- cancel_ready_import_job, as 20261122010000 defined it.
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

-- import_allowed_keys, as 20261121010000 defined it.
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
-- 4. What was restored is what a build up to 20261122010000 holds.
-- ---------------------------------------------------------------------------

DO $check$
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
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(v_spec.signature);
        IF v_md5 IS DISTINCT FROM v_spec.expected_md5 THEN
            RAISE EXCEPTION 'the restored % is not the body 20261122010000 left (md5 %)', v_spec.signature, v_md5;
        END IF;
    END LOOP;
    IF to_regprocedure('public.apply_practice_import_job(uuid,boolean)') IS NOT NULL
       OR to_regprocedure('public.ensure_practice_slot(uuid,uuid,uuid,day_of_week,time without time zone,time without time zone,date,date,smallint)') IS NOT NULL THEN
        RAISE EXCEPTION 'a function of 20261123010000 is still there';
    END IF;
END;
$check$;

COMMIT;
