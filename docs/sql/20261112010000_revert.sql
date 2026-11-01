-- Revert for 20261112010000_practice_preference_rules.sql (Phase D, C1).
--
-- **What it restores**: the scalar shape of `coach_practice_preferences` (one `dimension`, one `value`, per
-- coach; the one-approved index; the request/approve/supersede lifecycle), the two admin RPCs that read
-- it, and the previous bodies of `create_import_job`, `mark_import_job_ready_to_apply`,
-- `cancel_ready_import_job`, `import_allowed_keys` and `admin_delete_team`; it drops the five rule RPCs,
-- the preference import finalizer, the tenancy trigger, the completed-season read-only trigger and the CHECK helpers, takes `practice_preferences`
-- off `staging_import_rows`' type list, and puts the staged-row retention job back to coaches only.
--
-- **What it cannot restore, said before it runs.** A rule is richer than a scalar row, so the revert
-- REFUSES (55000) while it would have to guess:
--   * an in-force rule holds more than one value in a condition (an array of two weekdays is not a
--     scalar), or
--   * two in-force rules of one coach, both coming back approved (a pending request comes back a requested
--     row, which the index does not cover), disagree on a dimension (the one-approved index admits one).
-- Otherwise it writes each in-force rule back as one approved row per condition (keep-current becomes
-- a NULL value; a must an admin kept as a prefer stays a prefer, never a must) and a pending requested
-- must as a `requested` row, and it reports what is lost: the team a rule was for, priorities, date
-- windows, import provenance, and the removed and replaced history rows, which are dropped. The staged rows of preference files are deleted (the old type list refuses
-- them, and they hold coaches' emails).
--
-- Nothing here touches the auth or storage schemas. Applying it to a database that never took the
-- migration fails at its first statement.

BEGIN;

DO $$
DECLARE
    v_multi integer;
    v_disagree integer;
    v_in_force integer;
    v_pending integer;
    v_history integer;
    v_teams integer;
    v_windows integer;
    v_priorities integer;
BEGIN
    IF to_regprocedure('public.admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)') IS NULL THEN
        RAISE EXCEPTION '20261112010000 is not applied; there is nothing to revert';
    END IF;
    SELECT count(*) INTO v_multi FROM public.coach_practice_preferences
     WHERE status = 'in_force'
       AND (cardinality(weekdays) > 1 OR cardinality(start_minutes) > 1 OR cardinality(venue_ids) > 1);
    IF v_multi > 0 THEN
        RAISE EXCEPTION 'refusing to revert: % in-force rule(s) hold more than one value in a condition, which the scalar shape cannot hold', v_multi
            USING ERRCODE = '55000';
    END IF;
    -- Only rows written back as `approved` meet the one-approved index: a pending request comes back a
    -- `requested` row and never disagrees with anything. The level compared is the one written (a must kept
    -- as a prefer is a prefer), as in the conversion below.
    WITH flat AS (
        SELECT p.coach_id, d.dimension,
               (p.level = 'must') AS written_must, d.value
          FROM public.coach_practice_preferences p
          CROSS JOIN LATERAL (VALUES
              ('weekday', CASE WHEN p.weekdays IS NOT NULL THEN to_jsonb(p.weekdays[1]) END, p.weekdays IS NOT NULL OR p.keep_weekday),
              ('start_time', CASE WHEN p.start_minutes IS NOT NULL THEN to_jsonb(p.start_minutes[1]) END, p.start_minutes IS NOT NULL OR p.keep_start),
              ('venue', CASE WHEN p.venue_ids IS NOT NULL THEN to_jsonb(p.venue_ids[1]::text) END, p.venue_ids IS NOT NULL OR p.keep_venue)
          ) AS d(dimension, value, present)
         WHERE p.status = 'in_force' AND d.present AND p.must_decision IS DISTINCT FROM 'pending'
    )
    SELECT count(*) INTO v_disagree FROM (
        SELECT coach_id, dimension FROM flat
         GROUP BY coach_id, dimension
        HAVING count(DISTINCT (written_must, value::text)) > 1
    ) x;
    IF v_disagree > 0 THEN
        RAISE EXCEPTION 'refusing to revert: % coach/dimension pair(s) hold in-force rules that disagree on level or value, and the scalar shape admits one approved row each', v_disagree
            USING ERRCODE = '55000';
    END IF;
    SELECT count(*) FILTER (WHERE status = 'in_force'),
           count(*) FILTER (WHERE status = 'in_force' AND must_decision = 'pending'),
           count(*) FILTER (WHERE status <> 'in_force'),
           count(DISTINCT team_id) FILTER (WHERE status = 'in_force'),
           count(*) FILTER (WHERE status = 'in_force' AND (effective_from IS NOT NULL OR effective_to IS NOT NULL)),
           count(*) FILTER (WHERE status = 'in_force' AND coach_priority IS NOT NULL)
      INTO v_in_force, v_pending, v_history, v_teams, v_windows, v_priorities
      FROM public.coach_practice_preferences;
    RAISE NOTICE 'this revert writes % in-force rule(s) back as scalar rows (% pending must(s) as requested rows); it drops % removed/replaced history row(s) and loses the team of the rules (% team(s)), % date window(s) and % priority(ies)',
        v_in_force, v_pending, v_history, v_teams, v_windows, v_priorities;
END;
$$;

-- The scalar rows, computed before the table changes shape. `must_decision` is NULL for a rule nobody asked a
-- must for, so every test of it below is NULL-safe, and the rows are de-duplicated on the level and status
-- they are WRITTEN with (not on the columns they were computed from): an ordinary prefer and a must kept as
-- a prefer come back as the same approved `prefer_keep` row, and the one-approved index admits one.
CREATE TEMP TABLE _cpp_back ON COMMIT DROP AS
SELECT DISTINCT ON (w.coach_id, w.dimension, w.level, w.status, w.value::text)
       w.organization_id, w.coach_id, w.dimension, w.level, w.value, w.status,
       w.created_by, w.created_at, w.decided_by, w.decided_at
  FROM (
    SELECT p.organization_id, p.coach_id, d.dimension,
           -- The EFFECTIVE level of a decided rule; only a request still pending is written back as the must it
           -- asked for (a requested row). A must an admin kept as a prefer (kept_prefer) is a prefer: the old
           -- shape has no way to say "declined" other than not enforcing it.
           CASE WHEN p.level = 'must' OR COALESCE(p.must_decision = 'pending', false)
                THEN 'must_keep' ELSE 'prefer_keep' END AS level,
           d.value,
           CASE WHEN COALESCE(p.must_decision = 'pending', false) THEN 'requested' ELSE 'approved' END AS status,
           p.created_by, p.created_at, p.decided_by, p.decided_at
      FROM public.coach_practice_preferences p
      CROSS JOIN LATERAL (VALUES
          ('weekday', CASE WHEN p.weekdays IS NOT NULL THEN to_jsonb(p.weekdays[1]) END, p.weekdays IS NOT NULL OR p.keep_weekday),
          ('start_time', CASE WHEN p.start_minutes IS NOT NULL THEN to_jsonb(p.start_minutes[1]) END, p.start_minutes IS NOT NULL OR p.keep_start),
          ('venue', CASE WHEN p.venue_ids IS NOT NULL THEN to_jsonb(p.venue_ids[1]::text) END, p.venue_ids IS NOT NULL OR p.keep_venue)
      ) AS d(dimension, value, present)
     WHERE p.status = 'in_force' AND d.present
  ) w
 ORDER BY w.coach_id, w.dimension, w.level, w.status, w.value::text, w.created_at;

DROP TRIGGER coach_practice_preferences_readonly_when_completed ON public.coach_practice_preferences;
COMMENT ON FUNCTION public.season_schedule_readonly_when_completed() IS
  'Trigger function on teams, team_players, team_coach_assignments, practice_assignments, practice_exceptions, game_assignments, games (scores) and schedule_tbd: a signed-in caller cannot insert, update or delete a row of a completed season (22023, season_completed). Callers with no signed-in user and cascades from a deleted season, team or organization pass. 20261111010000.';
DELETE FROM public.coach_practice_preferences;

DROP TRIGGER coach_practice_preferences_enforce_tenancy ON public.coach_practice_preferences;
DROP INDEX public.coach_practice_preferences_org_team;
DROP INDEX public.coach_practice_preferences_import_job;
ALTER TABLE public.coach_practice_preferences
    DROP CONSTRAINT coach_practice_preferences_level_known,
    DROP CONSTRAINT coach_practice_preferences_requested_level_known,
    DROP CONSTRAINT coach_practice_preferences_must_decision_known,
    DROP CONSTRAINT coach_practice_preferences_must_asked_decided,
    DROP CONSTRAINT coach_practice_preferences_must_only_when_accepted,
    DROP CONSTRAINT coach_practice_preferences_status_known,
    DROP CONSTRAINT coach_practice_preferences_team_when_in_force,
    DROP CONSTRAINT coach_practice_preferences_weekdays_valid,
    DROP CONSTRAINT coach_practice_preferences_start_minutes_valid,
    DROP CONSTRAINT coach_practice_preferences_venue_ids_valid,
    DROP CONSTRAINT coach_practice_preferences_keep_or_values,
    DROP CONSTRAINT coach_practice_preferences_has_condition,
    DROP CONSTRAINT coach_practice_preferences_priority_known,
    DROP CONSTRAINT coach_practice_preferences_source_known,
    DROP CONSTRAINT coach_practice_preferences_import_job_is_import,
    DROP CONSTRAINT coach_practice_preferences_window_ordered;
ALTER TABLE public.coach_practice_preferences
    DROP COLUMN team_id, DROP COLUMN weekdays, DROP COLUMN start_minutes, DROP COLUMN venue_ids,
    DROP COLUMN keep_weekday, DROP COLUMN keep_start, DROP COLUMN keep_venue, DROP COLUMN coach_priority,
    DROP COLUMN requested_level, DROP COLUMN must_decision, DROP COLUMN source, DROP COLUMN import_job_id,
    DROP COLUMN updated_by, DROP COLUMN updated_at;
ALTER TABLE public.coach_practice_preferences RENAME COLUMN created_by TO requested_by;
ALTER TABLE public.coach_practice_preferences RENAME COLUMN created_at TO requested_at;
ALTER TABLE public.coach_practice_preferences
    ADD COLUMN dimension text,
    ADD COLUMN value jsonb,
    ALTER COLUMN status SET DEFAULT 'requested';

INSERT INTO public.coach_practice_preferences
    (organization_id, coach_id, dimension, level, value, status, requested_by, requested_at,
     decided_by, decided_at, effective_from)
SELECT organization_id, coach_id, dimension, level, value, status, created_by, created_at,
       CASE WHEN status = 'approved' THEN COALESCE(decided_by, created_by) END,
       CASE WHEN status = 'approved' THEN COALESCE(decided_at, created_at) END,
       CASE WHEN status = 'approved' THEN current_date END
  FROM _cpp_back;

ALTER TABLE public.coach_practice_preferences
    ALTER COLUMN dimension SET NOT NULL,
    ADD CONSTRAINT coach_practice_preferences_dimension_known
        CHECK (dimension IN ('weekday', 'start_time', 'venue')),
    ADD CONSTRAINT coach_practice_preferences_level_known
        CHECK (level IN ('must_keep', 'prefer_keep', 'dont_care')),
    ADD CONSTRAINT coach_practice_preferences_status_known
        CHECK (status IN ('requested', 'approved', 'rejected', 'superseded')),
    ADD CONSTRAINT coach_practice_preferences_value_valid CHECK (CASE
        WHEN value IS NULL THEN true
        WHEN dimension = 'weekday' THEN jsonb_typeof(value) = 'string'
             AND value #>> '{}' IN ('SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT')
        WHEN dimension = 'start_time' THEN CASE
             WHEN jsonb_typeof(value) = 'number' AND value #>> '{}' ~ '^[0-9]{1,4}$'
                 THEN (value #>> '{}')::integer <= 1439
             ELSE false END
        WHEN dimension = 'venue' THEN jsonb_typeof(value) = 'string'
             AND value #>> '{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ELSE false END),
    ADD CONSTRAINT coach_practice_preferences_decision_recorded
        CHECK ((status = 'requested') = (decided_at IS NULL)),
    ADD CONSTRAINT coach_practice_preferences_in_force_dated
        CHECK ((status IN ('approved', 'superseded')) = (effective_from IS NOT NULL)
               AND (status = 'superseded') = (effective_to IS NOT NULL)),
    ADD CONSTRAINT coach_practice_preferences_window_ordered
        CHECK (effective_to IS NULL OR effective_to >= effective_from - 1);
CREATE UNIQUE INDEX coach_practice_preferences_one_approved
    ON public.coach_practice_preferences (coach_id, dimension)
    WHERE status = 'approved';

COMMENT ON TABLE public.coach_practice_preferences IS
  'Per coach and dimension (weekday, start_time, venue): must_keep | prefer_keep | dont_care, optionally with the value kept. Coaches request; only org admins decide. Written only by request_coach_practice_preference, admin_decide_coach_practice_preference and admin_set_coach_practice_preference. No free text.';
COMMENT ON COLUMN public.coach_practice_preferences.value IS
  'weekday: a JSON string SUN..SAT; start_time: a JSON integer 0-1439 (minutes past local midnight); venue: a JSON string holding a locations.id. The reference is the team''s current series when that series is being moved, otherwise this value (plan §4); with neither, the preference does nothing.';
COMMENT ON COLUMN public.coach_practice_preferences.effective_from IS NULL;
COMMENT ON COLUMN public.coach_practice_preferences.effective_to IS NULL;
COMMENT ON COLUMN public.coach_practice_preferences.coach_id IS
  'A coaches.id, deliberately without a foreign key (the team_coach_assignments stance): deleting a coach erases their personal data and leaves this history holding an opaque id.';

-- ---------------------------------------------------------------------------
-- The previous bodies, as they were at 20261111010000 (md5 checked by the forward migration).
-- ---------------------------------------------------------------------------
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
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' ELSE 'registration' END;

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
      -- active season, as finalize_field_import_job still requires.
      IF v_season_status <> 'active' AND (v_season_status <> 'draft' OR v_job_type <> 'registration') THEN
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
  'Admin-only: start an import job for the named season (none named: the organization''s active season), fixed now. A player or coach import may name the active season or a draft; a field import only the active season; a completed season is refused (22023, season_completed). 20261111010000 (was active-only since 20261101010000).';

CREATE OR REPLACE FUNCTION public.mark_import_job_ready_to_apply(p_import_job_id uuid, p_import_type text, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability') THEN RAISE EXCEPTION 'Deferred apply is only available for coach, field, and field_availability imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type='coaches' AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','ready_to_apply','import_type',v_import_type,'staged_rows',v_staged_rows,'validation_error_rows',jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)),'ready_at',timezone('utc',now()));
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
  IF v_import_type NOT IN ('coaches','fields','field_availability') THEN RAISE EXCEPTION 'Deferred apply cancellation is only available for coach, field, and field_availability imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type='coaches' AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','canceled','import_type',v_import_type,'staged_rows',v_staged_rows,'canceled_at',timezone('utc',now()));
  UPDATE public.import_jobs SET status='failed',completed_at=timezone('utc',now()),error_summary=jsonb_set(COALESCE(error_summary,'{}'::jsonb),'{deferred_apply}',v_result,true),warning_summary=jsonb_set(COALESCE(warning_summary,'{}'::jsonb),'{deferred_apply}',v_result,true) WHERE id=p_import_job_id;
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
        ELSE ARRAY[]::text[]
    END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_team public.teams%ROWTYPE;
    v_uid uuid := auth.uid();
    v_pa record;
    v_row jsonb;
    v_withdrawn jsonb;
    v_archived jsonb;
    v_game_ids uuid[];
    v_player_ids uuid[];
    v_counts jsonb;
BEGIN
    SELECT * INTO v_team FROM public.teams WHERE id = p_team_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team % not found', p_team_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_team.organization_id) THEN
        -- Production's own text, which names no organisation to a caller
        -- outside it.
        RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    END IF;

    -- 2. The practice series, as admin_cancel_practice_assignment does each.
    --    An exception is the team's if it is on one of the team's series or
    --    names the team: the team_id cascade would remove either.
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = now(),
               withdrawn_by = v_uid
         WHERE (pe.team_id = p_team_id
                OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                         WHERE pa.team_id = p_team_id))
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.exception_withdrawn',
            'practice_exception',
            (v_row->>'id')::uuid,
            jsonb_build_object('reason', 'team_deleted', 'team_id', p_team_id,
                               'assignment_id', v_row->'assignment_id', 'row', v_row)
        );
    END LOOP;

    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.team_id = p_team_id
            OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                     WHERE pa.team_id = p_team_id)
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_archived
      FROM gone;
    UPDATE public.scheduler_runs sr
       SET results = COALESCE(sr.results, '{}'::jsonb) || jsonb_build_object(
               'archived_exceptions',
               COALESCE(sr.results->'archived_exceptions', '[]'::jsonb)
               || (SELECT jsonb_agg(e.value) FROM jsonb_array_elements(v_archived) e
                    WHERE (e.value->>'run_id')::uuid = sr.id))
     WHERE sr.id IN (SELECT (e.value->>'run_id')::uuid FROM jsonb_array_elements(v_archived) e
                      WHERE e.value->>'run_id' IS NOT NULL);

    v_counts := jsonb_build_object(
        'practice_exceptions_deleted', jsonb_array_length(v_archived),
        'practice_assignments_deleted',
            (SELECT count(*) FROM public.practice_assignments WHERE team_id = p_team_id)
    );
    FOR v_pa IN
        SELECT pa.id, to_jsonb(pa.*) AS before
          FROM public.practice_assignments pa
         WHERE pa.team_id = p_team_id
         ORDER BY pa.id
    LOOP
        DELETE FROM public.practice_assignments WHERE id = v_pa.id;
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.cancelled',
            'practice_assignments',
            v_pa.id,
            jsonb_build_object(
                'reason', 'team_deleted',
                'team_id', p_team_id,
                'assignment_id', v_pa.id,
                'before', v_pa.before,
                'withdrawn_exception_ids',
                    (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                       FROM jsonb_array_elements(v_withdrawn) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id),
                'archived_exceptions',
                    (SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb)
                       FROM jsonb_array_elements(v_archived) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id)
            )
        );
    END LOOP;

    -- 3. The team's games, held until commit, so the game ids and count
    --    team.deleted records are the rows the cascade removes (a concurrent
    --    write cannot move a game off the team in between). 20261022030000:
    --    their RSVPs are gone with the table.
    SELECT COALESCE(array_agg(g.id ORDER BY g.id), ARRAY[]::uuid[])
      INTO v_game_ids
      FROM (SELECT id FROM public.games
             WHERE home_team_id = p_team_id OR away_team_id = p_team_id
             ORDER BY id
               FOR UPDATE) g;

    -- 4. Players assigned through players.team_id (no foreign key), then the team.
    SELECT COALESCE(array_agg(p.id ORDER BY p.id), ARRAY[]::uuid[])
      INTO v_player_ids
      FROM public.players p
     WHERE p.team_id = p_team_id;

    -- 5. What the cascade takes, counted before it runs.
    v_counts := v_counts || jsonb_build_object(
        'games_deleted', cardinality(v_game_ids),
        'game_assignments_deleted',
            (SELECT count(*) FROM public.game_assignments
              WHERE home_team_id = p_team_id OR away_team_id = p_team_id),
        'team_players_deleted',
            (SELECT count(*) FROM public.team_players WHERE team_id = p_team_id),
        'team_coach_assignments_deleted',
            (SELECT count(*) FROM public.team_coach_assignments WHERE team_id = p_team_id),
        'team_calendar_tokens_deleted',
            (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id = p_team_id),
        -- 20261108020000: the TIME TBD rows the cascade takes (as practice team, or as either side of a game).
        'schedule_tbd_deleted',
            (SELECT count(*) FROM public.schedule_tbd
              WHERE team_id = p_team_id OR home_team_id = p_team_id OR away_team_id = p_team_id)
    );

    UPDATE public.players SET team_id = NULL WHERE id = ANY (v_player_ids);
    DELETE FROM public.teams WHERE id = p_team_id;

    PERFORM public.record_audit_event(
        v_team.organization_id,
        'team.deleted',
        'teams',
        p_team_id,
        jsonb_build_object('name', v_team.name, 'division_id', v_team.division_id)
            || v_counts
            || jsonb_build_object(
                   'game_ids', to_jsonb(v_game_ids),
                   'player_ids_unassigned', to_jsonb(v_player_ids),
                   'withdrawn_exception_ids',
                       (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                          FROM jsonb_array_elements(v_withdrawn) e),
                   'archived_exceptions', v_archived)
    );
END;
$function$;
COMMENT ON FUNCTION public.admin_delete_team(uuid) IS
  'Audited team deletion for org admins: withdraws, audits and archives the team''s practice exceptions and cancels its series as admin_cancel_practice_assignment does, clears players.team_id, and records what the cascade took. 20261021030000; RSVPs and team chat removed 20261022030000.';

CREATE OR REPLACE FUNCTION public.admin_decide_coach_practice_preference(p_preference_id uuid, p_decision text, p_level text DEFAULT NULL::text, p_value jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.coach_practice_preferences%ROWTYPE;
    v_status text;
    v_level text;
    v_value jsonb;
    v_superseded uuid;
BEGIN
    IF p_preference_id IS NULL OR p_decision IS NULL THEN
        RAISE EXCEPTION 'p_preference_id and p_decision are required'
            USING ERRCODE = '23502';
    END IF;
    IF p_decision NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'p_decision must be approve or reject, not %', p_decision
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row
      FROM public.coach_practice_preferences
     WHERE id = p_preference_id
       FOR UPDATE;

    -- Only an admin of the row's organisation decides. A coach -- the one who
    -- asked included -- is refused: that is the whole of ruling 3.
    IF NOT FOUND OR NOT public.is_org_admin(v_row.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin decides a coach practice preference'
            USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'requested' THEN
        RAISE EXCEPTION 'coach practice preference % is already %; only a requested row is decided',
            p_preference_id, v_row.status
            USING ERRCODE = '22023';
    END IF;

    IF p_decision = 'reject' THEN
        IF p_level IS NOT NULL OR p_value IS NOT NULL THEN
            RAISE EXCEPTION 'a rejection changes nothing; p_level and p_value belong to an approval'
                USING ERRCODE = '22023';
        END IF;
        v_status := 'rejected';
        UPDATE public.coach_practice_preferences
           SET status = v_status, decided_by = v_uid, decided_at = clock_timestamp()
         WHERE id = p_preference_id;
    ELSE
        v_status := 'approved';
        v_level := COALESCE(p_level, v_row.level);
        v_value := CASE WHEN p_value IS NULL THEN v_row.value
                        WHEN jsonb_typeof(p_value) = 'null' THEN NULL
                        ELSE p_value END;
        IF v_row.dimension = 'venue' AND jsonb_typeof(v_value) = 'string' AND NOT EXISTS (
            SELECT 1 FROM public.locations l
             WHERE l.organization_id = v_row.organization_id AND l.id::text = v_value #>> '{}'
        ) THEN
            RAISE EXCEPTION 'venue % is not a location of the coach''s organization', v_value #>> '{}'
                USING ERRCODE = '23503';
        END IF;

        -- One writer per (coach, dimension) at a time, so a concurrent approval
        -- waits here rather than losing to the one-approved index with a raw 23505.
        PERFORM pg_advisory_xact_lock(hashtext('coach_practice_preferences'), hashtext(v_row.coach_id::text || '/' || v_row.dimension));
        IF NOT EXISTS (SELECT 1 FROM public.coaches c
                        WHERE c.id = v_row.coach_id AND c.organization_id = v_row.organization_id) THEN
            RAISE EXCEPTION 'coach % no longer exists in the organization; the request cannot be approved', v_row.coach_id
                USING ERRCODE = '23503';
        END IF;
        -- A request older than the decision in force is stale: approving it
        -- would silently undo a newer decision. Reject it, or request again.
        IF EXISTS (SELECT 1 FROM public.coach_practice_preferences p
                    WHERE p.coach_id = v_row.coach_id AND p.dimension = v_row.dimension
                      AND p.status = 'approved' AND p.decided_at > v_row.requested_at) THEN
            RAISE EXCEPTION 'coach practice preference % is stale: a later decision on % is in force', p_preference_id, v_row.dimension
                USING ERRCODE = '22023';
        END IF;

        UPDATE public.coach_practice_preferences
           SET status = 'superseded', effective_to = current_date - 1
         WHERE coach_id = v_row.coach_id
           AND dimension = v_row.dimension
           AND status = 'approved'
        RETURNING id INTO v_superseded;

        UPDATE public.coach_practice_preferences
           SET status = v_status, level = v_level, value = v_value,
               decided_by = v_uid, decided_at = clock_timestamp(),
               effective_from = current_date
         WHERE id = p_preference_id;
    END IF;

    PERFORM public.record_audit_event(
        v_row.organization_id,
        'coach_preference.' || v_status,
        'coach_practice_preference',
        p_preference_id,
        jsonb_build_object(
            'coach_id', v_row.coach_id, 'dimension', v_row.dimension,
            'requested_level', v_row.level, 'requested_value', v_row.value,
            'level', v_level, 'value', v_value, 'superseded_id', v_superseded
        )
    );

    RETURN jsonb_build_object(
        'id', p_preference_id, 'status', v_status, 'coach_id', v_row.coach_id,
        'dimension', v_row.dimension, 'level', v_level, 'value', v_value,
        'superseded_id', v_superseded
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb) IS
  'Org admins only: approve (optionally changing level/value; supersedes the previous approved row) or reject a requested preference. Audited as coach_preference.approved / coach_preference.rejected.';

CREATE OR REPLACE FUNCTION public.admin_set_coach_practice_preference(p_coach_id uuid, p_dimension text, p_level text, p_value jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_value jsonb := NULLIF(p_value, 'null'::jsonb);
    v_org uuid;
    v_before public.coach_practice_preferences%ROWTYPE;
    v_id uuid;
BEGIN
    IF p_coach_id IS NULL OR p_dimension IS NULL OR p_level IS NULL THEN
        RAISE EXCEPTION 'p_coach_id, p_dimension and p_level are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT c.organization_id INTO v_org FROM public.coaches c WHERE c.id = p_coach_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin sets a coach practice preference'
            USING ERRCODE = '42501';
    END IF;

    IF p_dimension = 'venue' AND jsonb_typeof(v_value) = 'string' AND NOT EXISTS (
        SELECT 1 FROM public.locations l
         WHERE l.organization_id = v_org AND l.id::text = v_value #>> '{}'
    ) THEN
        RAISE EXCEPTION 'venue % is not a location of the coach''s organization', v_value #>> '{}'
            USING ERRCODE = '23503';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('coach_practice_preferences'), hashtext(p_coach_id::text || '/' || p_dimension));

    UPDATE public.coach_practice_preferences
       SET status = 'superseded', effective_to = current_date - 1
     WHERE coach_id = p_coach_id
       AND dimension = p_dimension
       AND status = 'approved'
    RETURNING * INTO v_before;

    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, dimension, level, value, status,
         requested_by, decided_by, decided_at, effective_from)
    VALUES (v_org, p_coach_id, p_dimension, p_level, v_value, 'approved',
            v_uid, v_uid, clock_timestamp(), current_date)
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'coach_preference.changed',
        'coach_practice_preference',
        v_id,
        jsonb_build_object(
            'coach_id', p_coach_id, 'dimension', p_dimension,
            'level', p_level, 'value', v_value,
            'superseded_id', v_before.id,
            'before_level', v_before.level, 'before_value', v_before.value
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'status', 'approved', 'coach_id', p_coach_id, 'dimension', p_dimension,
        'level', p_level, 'value', v_value, 'superseded_id', v_before.id
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb) IS
  'Org admins only: write a coach''s preference directly as approved, superseding the previous approved row. Audited as coach_preference.changed.';


-- ---------------------------------------------------------------------------
-- What the migration added.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.finalize_practice_preference_import_job(uuid, jsonb);
DROP FUNCTION public.admin_accept_all_musts(uuid, integer);
DROP FUNCTION public.admin_decide_must_preference(uuid, text);
DROP FUNCTION public.admin_remove_practice_preference(uuid);
DROP FUNCTION public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date);
DROP FUNCTION public.admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date);
DROP FUNCTION public.coach_practice_preferences_enforce_tenancy();
DROP FUNCTION public.practice_preference_minutes_ok(integer[]);
DROP FUNCTION public.practice_preference_set_ok(anyarray);

-- Staged preference rows are deleted: the old type list refuses them (and they hold coaches' emails).
DELETE FROM public.staging_import_rows WHERE import_type = 'practice_preferences';
ALTER TABLE public.staging_import_rows DROP CONSTRAINT staging_import_rows_import_type_check;
ALTER TABLE public.staging_import_rows ADD CONSTRAINT staging_import_rows_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability'));

SELECT cron.schedule(
    'cleanup-staging-import-rows',
    '0 3 * * *',
    $$ DELETE FROM public.staging_import_rows s USING public.import_jobs j WHERE j.id = s.import_job_id AND s.import_type = 'coaches' AND j.status IN ('completed', 'completed_with_warnings', 'failed') AND s.created_at < now() - interval '30 days' $$
);

-- ---------------------------------------------------------------------------
-- The end state.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'coach_practice_preferences' AND column_name IN ('team_id', 'weekdays', 'level_in_force')) THEN
        RAISE EXCEPTION 'the rule columns are still there';
    END IF;
    IF to_regprocedure('public.admin_decide_coach_practice_preference(uuid, text, text, jsonb)') IS NULL
       OR to_regprocedure('public.admin_set_coach_practice_preference(uuid, text, text, jsonb)') IS NULL THEN
        RAISE EXCEPTION 'the old preference RPCs are not back';
    END IF;
    IF to_regprocedure('public.admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)') IS NOT NULL
       OR to_regprocedure('public.finalize_practice_preference_import_job(uuid, jsonb)') IS NOT NULL THEN
        RAISE EXCEPTION 'a rule RPC survived the revert';
    END IF;
    IF (SELECT cardinality(public.import_allowed_keys('practice_preferences'))) <> 0 THEN
        RAISE EXCEPTION 'import_allowed_keys still knows practice_preferences';
    END IF;
    RAISE NOTICE 'practice preference rules reverted: % scalar row(s) restored', (SELECT count(*) FROM public.coach_practice_preferences);
END;
$$;

COMMIT;
