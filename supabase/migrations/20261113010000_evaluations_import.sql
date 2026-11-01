-- The evaluations import: years played and skill level for the players of a season (Phase E3, PR
-- E3c; plan docs/changes/2026-10-27-season-enrollment.md, C2, settled by the owner).
--
-- **Why.** A player's years of experience and skill level are separate, optional fields. The
-- registration import can carry them, but a club often rates its players after registration, from
-- its own evaluations. E3a made a player belong to one season and nothing carry over, so this is
-- how a season's experience and skill get added: a file of registration ids with `years_played`,
-- a skill tier and/or a 1-5 rating, that only UPDATES the players of the season.
--
-- **The change.**
--   1. A new import type, `evaluations`, with its own job type (`import_jobs.job_type`) so no other
--      finalizer can be run on its job, and its own staged rows in `staging_import_rows`
--      (`import_type = 'evaluations'`); both CHECKs gain the value. The existing names are kept,
--      the staged-row list with `practice_preferences`, which 20261112010000 added.
--   2. `finalize_evaluation_import_job(job, validation_errors, dry_run)`, a finalizer of its own
--      rather than an extension of `finalize_import_job`: that one inserts and rewrites identity,
--      division and age, and is stamped with the season's age rule; this one never creates a
--      player and never touches an age field, so the stamp does not apply to it. What it does:
--        * a season, as the other finalizers resolve it (the job's own, else the active one); none
--          is `season_missing`, a completed season is refused (22023, `season_completed`) before
--          anything is read or written, so the read-only trigger on `players` is never the first
--          to answer. The active season and a draft take it.
--        * a row names a player by registration id, matched as text within the season only (leading
--          zeros are kept; another season's player with the same id is another row and is never
--          read or written). A row that names no player is UNMATCHED: counted, listed (at most 200)
--          and never created.
--        * a blank cell leaves the stored value alone (it is not a zero); a value is applied only
--          when it differs from the stored one, so a re-import changes nothing and bumps no
--          `updated_at`. Each value is judged by the same rule as `import-validation`
--          (`_shared/import-evaluations.ts`): `years_played` a whole number 0 to 30, a tier
--          `novice`, `developing` or `advanced`, a `rating` a whole number 1 to 5. A row with a bad
--          cell, or no registration id, is INVALID: not applied at all, counted, listed with the
--          field and a message that quotes no value, and its staged row keeps the errors.
--        * a registration id repeated in the file: the first row (by row number) is used, the rest
--          are counted and listed as duplicates, as the player import does.
--        * `p_dry_run` runs the same statement and writes nothing (no player, no staged row, no
--          job, no audit row), so the counts an admin confirms are the ones the apply produces.
--        * an apply takes the organization's season lock the season writers take, marks every
--          processed staged row, finishes the job (`warning_summary.evaluation_finalize`) and is
--          audited as `import.completed` with the counts and `import_type = 'evaluations'`
--          (no registration ids). A finished job answers a second call with its stored result.
--        * `authenticated` only, and only an admin of the job's organization (42501).
--   3. `create_import_job`, `mark_import_job_ready_to_apply` and `cancel_ready_import_job` accept
--      the new type (the draft season guard of 20261111010000 applies to it as to the registration
--      jobs); `import_allowed_keys('evaluations')` is the SQL copy of the new allowlist, which
--      `tests/importAllowlistParity.test.js` holds equal to the two code copies and to the keys the
--      finalizer reads. Each replaced function is the body 20261112010000 (practice preferences)
--      left, with the one new type added, and is behind the md5 of that text.
--   4. A daily job deletes a finished evaluations job's staged rows after 30 days, as the coach
--      rows are (`cleanup-staging-evaluation-rows`; `cleanup-staging-import-rows`, which holds the
--      coach and practice preference rows, is not touched).
--
-- No data is read or changed by the migration. Revert: docs/sql/20261113010000_revert.sql.

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
            ('public.create_import_job(uuid, text, text, uuid)',        '7c70406b6d4322b2ac378e809f3f7eaf'),
            ('public.import_allowed_keys(text)',                        '271208c50d2bbfae692fd1ea1da51774'),
            ('public.mark_import_job_ready_to_apply(uuid, text, jsonb)', '3788e5f14ec691f07db6a033cf9157d4'),
            ('public.cancel_ready_import_job(uuid, text)',              'c971f2091d9ce686f1e7229c96ab9560')
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
-- 1. The new job type and staged-row type.
-- ---------------------------------------------------------------------------

ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_job_type_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_job_type_check
    CHECK (job_type IN ('registration', 'fields', 'field_availability', 'manual', 'evaluations'));

ALTER TABLE public.staging_import_rows DROP CONSTRAINT IF EXISTS staging_import_rows_import_type_check;
ALTER TABLE public.staging_import_rows ADD CONSTRAINT staging_import_rows_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations'));

-- ---------------------------------------------------------------------------
-- 2. The import types the pipeline accepts.
-- ---------------------------------------------------------------------------
--
-- The four functions are the bodies 20261112010000 left (the md5 guards above), each with the one change
-- of knowing the new type; nothing else in them moves. The two deferred-apply functions keep the `now()`
-- idiom 20261112010000 gave them (tests/utcNowIdiom.test.js).

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
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' WHEN v_import_type = 'evaluations' THEN 'evaluations' ELSE 'registration' END;

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
    'Admin-only: start an import job for the named season (none named: the organization''s active season), fixed now. A player, coach, practice preference or evaluations import may name the active season or a draft; a field import only the active season; a completed season is refused (22023, season_completed). 20261113010000 (evaluations; 20261112010000 before it added practice_preferences, 20261111010000 before that the draft season).';

CREATE OR REPLACE FUNCTION public.mark_import_job_ready_to_apply(p_import_job_id uuid, p_import_type text, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations') THEN RAISE EXCEPTION 'Deferred apply is only available for coach, field, field_availability, practice_preferences, and evaluations imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
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
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations') THEN RAISE EXCEPTION 'Deferred apply cancellation is only available for coach, field, field_availability, practice_preferences, and evaluations imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
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
        ELSE ARRAY[]::text[]
    END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The finalizer.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.finalize_evaluation_import_job(
    p_import_job_id uuid,
    p_validation_errors jsonb DEFAULT '[]'::jsonb,
    p_dry_run boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_now timestamptz := now();
    v_dry boolean := COALESCE(p_dry_run, false);
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_season_settings_id uuid;
    v_season_status text;
    v_summary jsonb;
    v_result jsonb;
    v_status text;
    v_planned bigint;
    v_expected bigint;
    v_written bigint;
    v_processed bigint;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
    END IF;

    -- An apply holds the job row; a dry run only reads it.
    IF v_dry THEN
        SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    ELSE
        SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job.job_type <> 'evaluations' THEN
        RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    -- A finished job answers with the result it stored (a retry after a lost response).
    IF v_job.status IN ('completed', 'completed_with_warnings') THEN
        IF v_job.warning_summary ? 'evaluation_finalize' THEN
            RETURN (v_job.warning_summary -> 'evaluation_finalize') || jsonb_build_object('replayed', true);
        END IF;
        RAISE EXCEPTION 'Import job % is already %', p_import_job_id, v_job.status
            USING ERRCODE = '22023';
    END IF;
    IF v_job.status IN ('failed', 'needs_fix') THEN
        RAISE EXCEPTION '% import job % cannot be finalized', initcap(v_job.status), p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- The season the job adds to, as the other finalizers resolve it: its own, else the active one.
    -- An apply takes the lock the season writers take first, so a season completed in another
    -- session is seen as completed here rather than refused by the trigger half way.
    IF NOT v_dry THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_job.organization_id::text, 0));
    END IF;
    SELECT s.id, s.status
    INTO v_season_settings_id, v_season_status
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);
    IF v_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no season to import into', v_job.organization_id
            USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    -- One statement for the plan and, unless it is a dry run, its writes: what is counted is what
    -- is done. Each staged row is judged whole (a bad cell makes the row invalid, none of it is
    -- applied); the first row of a repeated registration id is used; a row names a player of THIS
    -- season by registration id, as text, or it is unmatched and nothing is created; a blank cell
    -- is NULL here and leaves the stored value alone; a value is written only when it differs.
    WITH staged AS MATERIALIZED (
        SELECT
            sr.id AS staging_id,
            sr.source_row_number,
            public.import_payload_text(
                sr.normalized_payload,
                'external_registration_id', 'gotsport_id', 'registration_id', 'player_id'
            ) AS registration_id,
            public.import_payload_text(sr.normalized_payload, 'years_played') AS years_text,
            lower(public.import_payload_text(sr.normalized_payload, 'skill_tier', 'skill_level')) AS tier_text,
            public.import_payload_text(sr.normalized_payload, 'rating') AS rating_text
        FROM public.staging_import_rows sr
        WHERE sr.import_job_id = p_import_job_id
          AND sr.organization_id = v_job.organization_id
          AND sr.import_type = 'evaluations'
          AND sr.applied_at IS NULL
          AND sr.normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(sr.validation_errors), 0) = 0
    ),
    parsed AS MATERIALIZED (
        SELECT
            s.*,
            -- The cast is reached only for two digits, and the range is checked inside it.
            CASE WHEN s.years_text ~ '^[0-9]{1,2}$'
                 THEN (CASE WHEN s.years_text::int <= 30 THEN s.years_text::smallint END)
            END AS years_value,
            CASE WHEN s.tier_text IN ('novice', 'developing', 'advanced') THEN s.tier_text END AS tier_value,
            CASE WHEN s.rating_text ~ '^[1-5]$' THEN s.rating_text::smallint END AS rating_value
        FROM staged s
    ),
    judged AS MATERIALIZED (
        SELECT
            p.*,
            (p.registration_id IS NULL) AS missing_id,
            (p.years_text IS NOT NULL AND p.years_value IS NULL) AS bad_years,
            (p.tier_text IS NOT NULL AND p.tier_value IS NULL) AS bad_tier,
            (p.rating_text IS NOT NULL AND p.rating_value IS NULL) AS bad_rating
        FROM parsed p
    ),
    invalid_cells AS MATERIALIZED (
        SELECT j.staging_id, j.source_row_number, 'external_registration_id'::text AS field,
               'Missing required field: external_registration_id'::text AS message
          FROM judged j WHERE j.missing_id
        UNION ALL
        SELECT j.staging_id, j.source_row_number, 'years_played',
               'Years played must be a whole number from 0 to 30'
          FROM judged j WHERE j.bad_years
        UNION ALL
        SELECT j.staging_id, j.source_row_number, 'skill_tier',
               'Skill tier must be novice, developing or advanced (a number from 1 to 5 belongs in a Rating column)'
          FROM judged j WHERE j.bad_tier
        UNION ALL
        SELECT j.staging_id, j.source_row_number, 'rating',
               'Rating must be a whole number from 1 to 5'
          FROM judged j WHERE j.bad_rating
    ),
    ranked AS MATERIALIZED (
        SELECT
            j.*,
            row_number() OVER (
                PARTITION BY j.registration_id
                ORDER BY j.source_row_number NULLS LAST, j.staging_id
            ) AS occurrence
        FROM judged j
        WHERE NOT (j.missing_id OR j.bad_years OR j.bad_tier OR j.bad_rating)
    ),
    matched AS MATERIALIZED (
        SELECT
            r.staging_id,
            r.source_row_number,
            r.registration_id,
            r.years_value,
            r.tier_value,
            r.rating_value,
            pl.id AS player_id,
            pl.years_played AS old_years,
            pl.skill_tier AS old_tier,
            pl.rating AS old_rating
        FROM ranked r
        LEFT JOIN public.players pl
               ON pl.organization_id = v_job.organization_id
              AND pl.season_settings_id = v_season_settings_id
              AND pl.external_registration_id = r.registration_id
        WHERE r.occurrence = 1
    ),
    changes AS MATERIALIZED (
        SELECT
            m.*,
            (m.years_value IS NOT NULL AND m.years_value IS DISTINCT FROM m.old_years) AS years_changes,
            (m.tier_value IS NOT NULL AND m.tier_value IS DISTINCT FROM m.old_tier) AS tier_changes,
            (m.rating_value IS NOT NULL AND m.rating_value IS DISTINCT FROM m.old_rating) AS rating_changes
        FROM matched m
        WHERE m.player_id IS NOT NULL
    ),
    to_update AS MATERIALIZED (
        SELECT c.* FROM changes c WHERE c.years_changes OR c.tier_changes OR c.rating_changes
    ),
    updated AS (
        UPDATE public.players pl
        SET
            years_played = COALESCE(u.years_value, pl.years_played),
            skill_tier = COALESCE(u.tier_value, pl.skill_tier),
            rating = COALESCE(u.rating_value, pl.rating),
            updated_at = v_now
        FROM to_update u
        WHERE pl.id = u.player_id
          AND NOT v_dry
        RETURNING pl.id
    ),
    processed AS (
        UPDATE public.staging_import_rows sr
        SET applied_at = v_now,
            applied_by = auth.uid()
        WHERE NOT v_dry
          AND sr.id IN (SELECT r.staging_id FROM ranked r)
        RETURNING sr.id
    ),
    refused AS (
        UPDATE public.staging_import_rows sr
        SET validation_errors = e.errors
        FROM (
            SELECT c.staging_id,
                   jsonb_agg(jsonb_build_object(
                       'field', c.field,
                       'message', c.message,
                       'source_row_number', c.source_row_number
                   ) ORDER BY c.field) AS errors
              FROM invalid_cells c
             GROUP BY c.staging_id
        ) e
        WHERE NOT v_dry
          AND sr.id = e.staging_id
        RETURNING sr.id
    )
    SELECT
        jsonb_build_object(
            'staged_rows', (SELECT count(*) FROM public.staging_import_rows x
                             WHERE x.import_job_id = p_import_job_id AND x.import_type = 'evaluations'),
            'matched_rows', (SELECT count(*) FROM changes),
            'updated_players', (SELECT count(*) FROM to_update),
            'unchanged_players', (SELECT count(*) FROM changes) - (SELECT count(*) FROM to_update),
            'years_updated', (SELECT count(*) FROM to_update WHERE years_changes),
            'tier_updated', (SELECT count(*) FROM to_update WHERE tier_changes),
            'rating_updated', (SELECT count(*) FROM to_update WHERE rating_changes),
            'unmatched_rows', (SELECT count(*) FROM matched WHERE player_id IS NULL),
            'unmatched', (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                           'source_row_number', u.source_row_number,
                           'registration_id', left(u.registration_id, 100)
                       ) ORDER BY u.source_row_number NULLS LAST, u.staging_id), '[]'::jsonb)
                  FROM (SELECT m.* FROM matched m WHERE m.player_id IS NULL
                         ORDER BY m.source_row_number NULLS LAST, m.staging_id LIMIT 200) u),
            'invalid_rows', (SELECT count(DISTINCT staging_id) FROM invalid_cells),
            'invalid', (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                           'source_row_number', i.source_row_number,
                           'field', i.field,
                           'message', i.message
                       ) ORDER BY i.source_row_number NULLS LAST, i.staging_id, i.field), '[]'::jsonb)
                  FROM (SELECT c.* FROM invalid_cells c
                         ORDER BY c.source_row_number NULLS LAST, c.staging_id, c.field LIMIT 200) i),
            'duplicate_rows', (SELECT count(*) FROM ranked WHERE occurrence > 1),
            'duplicates', (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                           'source_row_number', d.source_row_number,
                           'registration_id', left(d.registration_id, 100)
                       ) ORDER BY d.source_row_number NULLS LAST, d.staging_id), '[]'::jsonb)
                  FROM (SELECT r.* FROM ranked r WHERE r.occurrence > 1
                         ORDER BY r.source_row_number NULLS LAST, r.staging_id LIMIT 200) d),
            'validation_error_rows', jsonb_array_length(v_validation_errors),
            'season_settings_id', v_season_settings_id,
            'dry_run', v_dry
        ),
        (SELECT count(*) FROM to_update),
        (SELECT count(*) FROM updated),
        (SELECT count(*) FROM ranked)
    INTO v_summary, v_planned, v_written, v_processed;

    -- A dry run writes nothing; an apply writes exactly the updates it planned.
    v_expected := CASE WHEN v_dry THEN 0 ELSE v_planned END;
    IF v_written <> v_expected THEN
        RAISE EXCEPTION 'The evaluations import planned % player update(s) and wrote %', v_expected, v_written
            USING ERRCODE = 'XX000';
    END IF;

    v_status := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR (v_summary ->> 'invalid_rows')::int > 0
          OR (v_summary ->> 'unmatched_rows')::int > 0
          OR (v_summary ->> 'duplicate_rows')::int > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    IF v_dry THEN
        RETURN v_summary || jsonb_build_object('status', 'preview');
    END IF;

    v_result := v_summary || jsonb_build_object('status', v_status);

    UPDATE public.import_jobs
    SET
        status = v_status,
        processed_rows = v_processed,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{evaluation_finalize}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    -- The counts and the season, not the registration ids the lists name.
    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        (v_result - 'unmatched' - 'invalid' - 'duplicates')
            || jsonb_build_object('import_type', 'evaluations')
    );

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_evaluation_import_job(uuid, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_evaluation_import_job(uuid, jsonb, boolean) TO authenticated;

COMMENT ON FUNCTION public.finalize_evaluation_import_job(uuid, jsonb, boolean) IS
    'Admin-only: apply an evaluations import (years played, skill tier, 1-5 rating by registration id) to the players of the job''s season: it only updates (an unmatched row is listed, never created), a blank cell leaves the stored value alone, a bad cell makes its row invalid and unapplied, a repeated id uses its first row; the active season or a draft takes it, a completed one is refused (22023, season_completed). p_dry_run returns the same counts and lists and writes nothing. Audited as import.completed. 20261113010000.';

-- ---------------------------------------------------------------------------
-- 4. Retention: a finished evaluations job's staged rows, at 30 days.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
    'cleanup-staging-evaluation-rows',
    '5 3 * * *',
    $$ DELETE FROM public.staging_import_rows s USING public.import_jobs j WHERE j.id = s.import_job_id AND s.import_type = 'evaluations' AND j.status IN ('completed', 'completed_with_warnings', 'failed') AND s.created_at < now() - interval '30 days' $$
);

-- ---------------------------------------------------------------------------
-- 5. End state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_bad text;
BEGIN
    IF to_regprocedure('public.finalize_evaluation_import_job(uuid,jsonb,boolean)') IS NULL
       OR NOT has_function_privilege('authenticated', 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'finalize_evaluation_import_job is missing or wrongly granted';
    END IF;

    -- Each constraint admits the new value, and the staged-row one keeps what 20261112010000 gave it.
    SELECT string_agg(c.conname, ', ') INTO v_bad
      FROM pg_constraint c
     WHERE c.conrelid IN ('public.import_jobs'::regclass, 'public.staging_import_rows'::regclass)
       AND c.conname IN ('import_jobs_job_type_check', 'staging_import_rows_import_type_check')
       AND pg_get_constraintdef(c.oid) NOT LIKE '%evaluations%';
    IF v_bad IS NOT NULL OR (SELECT count(*) FROM pg_constraint
                              WHERE conname IN ('import_jobs_job_type_check', 'staging_import_rows_import_type_check')) <> 2 THEN
        RAISE EXCEPTION 'the job and staged-row type constraints do not admit evaluations (%)', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'staging_import_rows_import_type_check'
                      AND conrelid = 'public.staging_import_rows'::regclass
                      AND pg_get_constraintdef(oid) LIKE '%practice_preferences%'
                      AND pg_get_constraintdef(oid) LIKE '%coaches%'
                      AND pg_get_constraintdef(oid) LIKE '%field_availability%') THEN
        RAISE EXCEPTION 'the staged-row type constraint lost a type it had';
    END IF;

    IF public.import_allowed_keys('evaluations') IS DISTINCT FROM ARRAY[
           'external_registration_id', 'gotsport_id', 'registration_id', 'player_id',
           'years_played', 'skill_tier', 'skill_level', 'rating']::text[]
       OR cardinality(public.import_allowed_keys('players')) <> 43
       OR cardinality(public.import_allowed_keys('coaches')) <> 12
       OR cardinality(public.import_allowed_keys('practice_preferences')) <> 18 THEN
        RAISE EXCEPTION 'import_allowed_keys does not hold the four lists';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-staging-evaluation-rows'
                    AND command LIKE '%import_type = ''evaluations''%'
                    AND command LIKE '%j.status IN (''completed'', ''completed_with_warnings'', ''failed'')%'
                    AND command LIKE '%30 days%') THEN
        RAISE EXCEPTION 'the evaluations retention job is missing or not scoped to finished jobs';
    END IF;
    -- The coach and preference rows' job is as 20261112010000 left it.
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-staging-import-rows'
                    AND command LIKE '%practice_preferences%' AND command LIKE '%import_type = ''coaches''%'
                    AND command NOT LIKE '%evaluations%') THEN
        RAISE EXCEPTION 'the coach and preference retention job is not as 20261112010000 left it';
    END IF;

    -- The replaced functions kept their pinned settings (CREATE OR REPLACE resets them).
    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('create_import_job(uuid,text,text,uuid)'), ('mark_import_job_ready_to_apply(uuid,text,jsonb)'),
                   ('cancel_ready_import_job(uuid,text)'), ('finalize_evaluation_import_job(uuid,jsonb,boolean)')) AS f(sig)
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                        WHERE p.oid = to_regprocedure('public.' || f.sig)
                          AND p.prosecdef
                          AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'definer function(s) without search_path and UTC pinned: %', v_bad;
    END IF;
END;
$$;

COMMIT;
