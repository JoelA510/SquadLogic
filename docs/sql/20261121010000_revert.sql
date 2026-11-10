-- Revert for 20261121010000_game_import.sql
--
-- Takes the games import out: drops the four client RPCs and the two internal helpers (the image helper and the label
-- comparison), gives the five replaced functions and the view back the bodies they had, drops the five columns (the three
-- of the games and teams, and a TIME TBD game's Game ID and date), the Game ID indexes and checks, and puts the six lists
-- back to what they were (the application record's operation list among them). **Those texts are the repository's, not read from production** (lesson 87 reads
-- production where it can; this change did not): the end of this file checks each restored function body against the
-- md5 of the body a build of the migrations up to 20261120010000 holds (carriage returns removed), so a typo here fails
-- the revert instead of shipping.
--
-- **It refuses, and says why, while an import is applied.** Dropping `teams.is_external` would turn every outside club
-- into one of the organization's teams (every list would show it); dropping a list entry the rows still carry would
-- fail the CHECK; and an application record not yet rolled back is the only way to take an import's games back. So it
-- stops, naming the counts, if any games import record is not rolled back, any outside club exists, or any TIME TBD
-- game carries the import's reason. Roll the import(s) back first (`rollback_game_import_job`; a club or shell that is
-- referenced stays and is reported, so a club that survived a rollback has to go through the teams page first).
--
-- **What it deletes:** the games import's own bookkeeping (its jobs, staged rows and rolled-back application records:
-- the CHECKs that name `games` cannot be put back while one stands). **What it keeps:** every game, slot, division,
-- venue, field and team the imports made and left (they are ordinary rows now), and the `game.slot_created` and `import.mapped` audit actions and the
-- audit rows that cite them (an audit trail a revert can edit is not an audit trail: `audit_log` rows cite the action,
-- so the `audit_actions` rows stay too). **What it loses:** the Game ID of every game that carries one (the NOTICE
-- counts them) and which import wrote a game.
--
-- Order matters: the guard trigger goes before its function is replaced and the helper the new guard calls goes after;
-- the view and the sync function stop naming `is_external` before the column goes (PL/pgSQL is not checked when a column
-- is dropped, a view is); the bookkeeping rows go before the CHECKs that cannot hold them come back.
--
-- Verified: the harness applies this on a database built up to the migration, once with an applied import (it must
-- refuse, and change nothing) and once with the import rolled back, and reads the catalogue afterwards.

BEGIN;

DO $revert$
DECLARE
    v_live integer;
    v_clubs integer;
    v_tbd integer;
BEGIN
    SELECT count(*) INTO v_live FROM public.import_application_records
     WHERE import_type = 'games' AND rolled_back_at IS NULL;
    SELECT count(*) INTO v_clubs FROM public.teams WHERE is_external;
    SELECT count(*) INTO v_tbd FROM public.schedule_tbd WHERE reason = 'imported-without-time';
    IF v_live > 0 OR v_clubs > 0 OR v_tbd > 0 THEN
        RAISE EXCEPTION 'a games import is still applied: % record(s) not rolled back, % outside club(s), % TIME TBD game(s) from a file. Roll the import(s) back first (rollback_game_import_job); this revert changes nothing.',
            v_live, v_clubs, v_tbd USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'this revert drops game_assignments.external_ref (% game(s) carry a Game ID, which is lost), game_assignments.import_job_id and teams.is_external; it deletes % games import job(s), % staged row(s) and % rolled-back record(s); every game, slot, division, venue, field and team stays; the game.slot_created and import.mapped audit actions stay',
        (SELECT count(*) FROM public.game_assignments WHERE external_ref IS NOT NULL),
        (SELECT count(*) FROM public.import_jobs WHERE job_type = 'games'),
        (SELECT count(*) FROM public.staging_import_rows WHERE import_type = 'games'),
        (SELECT count(*) FROM public.import_application_records WHERE import_type = 'games');
END;
$revert$;

-- ---------------------------------------------------------------------------
-- 1. The guard goes back to 20261120010000's body, without the rollback exemption; then its helper can go.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS game_assignments_published_guard ON public.game_assignments;

-- The guard, as 20261120010000 defined it.
CREATE OR REPLACE FUNCTION public.game_assignments_published_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
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

COMMENT ON FUNCTION public.game_assignments_published_guard() IS
    'Trigger function on game_assignments: a signed-in caller cannot delete a held game (game_is_held) or change its slot, field, teams, week, start or end (22023, game_published). Callers with no signed-in user and the cascade of a deleted organization pass. 20261119010000, asks game_is_held since 20261120010000.';

CREATE TRIGGER game_assignments_published_guard
    BEFORE UPDATE OR DELETE ON public.game_assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.game_assignments_published_guard();

DROP FUNCTION IF EXISTS public.apply_game_import_job(uuid, boolean);
DROP FUNCTION IF EXISTS public.rollback_game_import_job(uuid);
DROP FUNCTION IF EXISTS public.map_game_import_job(uuid, jsonb);
DROP FUNCTION IF EXISTS public.ensure_game_slot(uuid, uuid, date, time, time, smallint, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.game_import_image(jsonb);
DROP FUNCTION IF EXISTS public.game_import_row_unchanged(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.normalise_external_label(text);

-- ---------------------------------------------------------------------------
-- 2. The import pipeline's four functions, as 20261113010000 defined them.
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
-- 3. The view and the practice sync stop naming the column: as 20261108010000 and 20261108020000 defined them.
-- ---------------------------------------------------------------------------

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
      WHERE t.organization_id = o.id AND d.season_settings_id IS NOT DISTINCT FROM s.id) AS total_teams,
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
       AND d.practices_per_week > held.n;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$function$;

COMMENT ON FUNCTION public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb) IS
    'Internal: rebuilds a season''s practice rows in schedule_tbd from the roster. Refuses any call not made by persist_practice_schedule or refresh_schedule_tbd_practices. 20261108020000.';

-- ---------------------------------------------------------------------------
-- 4. The games import's bookkeeping goes, then the lists come back, then the columns go.
-- ---------------------------------------------------------------------------

DELETE FROM public.staging_import_rows WHERE import_type = 'games';
DELETE FROM public.import_application_records WHERE import_type = 'games';
DELETE FROM public.import_jobs WHERE job_type = 'games';

ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_job_type_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_job_type_check
    CHECK (job_type IN ('registration', 'fields', 'field_availability', 'manual', 'evaluations'));

ALTER TABLE public.staging_import_rows DROP CONSTRAINT IF EXISTS staging_import_rows_import_type_check;
ALTER TABLE public.staging_import_rows ADD CONSTRAINT staging_import_rows_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'practice_preferences', 'evaluations'));

ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_import_type_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability'));

-- The records that said `deleted` went with the rest of the games import's records above.
ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_operation_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_operation_check
    CHECK (operation IN ('inserted', 'updated'));

ALTER TABLE public.import_application_records DROP CONSTRAINT IF EXISTS import_application_records_target_table_check;
ALTER TABLE public.import_application_records ADD CONSTRAINT import_application_records_target_table_check
    CHECK (target_table IN (
        'coaches', 'fields', 'field_subunits', 'locations', 'practice_slots', 'game_slots',
        'field_availability_profiles', 'field_availability_profile_formats', 'field_blackout_windows',
        'field_equipment_requirements', 'field_availability_scenarios', 'field_availability_scenario_members'));

ALTER TABLE public.schedule_tbd DROP CONSTRAINT IF EXISTS schedule_tbd_reason_check;
ALTER TABLE public.schedule_tbd ADD CONSTRAINT schedule_tbd_reason_check CHECK (
    (kind = 'practice' AND reason IN ('no-slot-available', 'no-live-date', 'coach-preference', 'practice-length', 'not-enough-days', 'not-scheduled-yet'))
    OR (kind = 'game' AND reason IN ('unknown-team', 'division-mismatch', 'duplicate-matchup', 'coach-coaches-both-teams', 'coach-scheduling-conflict', 'no-slot-available')));

-- A TIME TBD game's Game ID and date (the rows an import wrote were refused above, so none of them is lost here).
DROP INDEX IF EXISTS public.schedule_tbd_season_external_ref_key;
ALTER TABLE public.schedule_tbd DROP CONSTRAINT IF EXISTS schedule_tbd_import_fields;
ALTER TABLE public.schedule_tbd DROP COLUMN IF EXISTS external_ref;
ALTER TABLE public.schedule_tbd DROP COLUMN IF EXISTS game_date;

DROP INDEX IF EXISTS public.game_assignments_season_external_ref_key;
DROP INDEX IF EXISTS public.idx_game_assignments_import_job_id;
ALTER TABLE public.game_assignments DROP CONSTRAINT IF EXISTS game_assignments_external_ref_shape;
ALTER TABLE public.game_assignments DROP COLUMN IF EXISTS external_ref;
ALTER TABLE public.game_assignments DROP COLUMN IF EXISTS import_job_id;
ALTER TABLE public.teams DROP COLUMN IF EXISTS is_external;

-- ---------------------------------------------------------------------------
-- 5. The end state, or the revert does not commit.
-- ---------------------------------------------------------------------------

DO $revert$
DECLARE
    v_spec record;
    v_md5 text;
    v_bad text;
BEGIN
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
            RAISE EXCEPTION 'a restored function body is not the one it had before 20261121010000: % (md5 %)', v_spec.signature, v_md5;
        END IF;
    END LOOP;

    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('apply_game_import_job(uuid,boolean)'), ('rollback_game_import_job(uuid)'), ('map_game_import_job(uuid,jsonb)'),
                   ('ensure_game_slot(uuid,uuid,date,time without time zone,time without time zone,smallint,timestamp with time zone,timestamp with time zone)'),
                   ('game_import_image(jsonb)'), ('game_import_row_unchanged(jsonb,jsonb)'), ('normalise_external_label(text)')) AS f(sig)
     WHERE to_regprocedure('public.' || f.sig) IS NOT NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'function(s) of the migration are still there: %', v_bad;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.teams'::regclass AND a.attname = 'is_external' AND NOT a.attisdropped)
       OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass
                   AND a.attname IN ('external_ref', 'import_job_id') AND NOT a.attisdropped)
       OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.schedule_tbd'::regclass
                   AND a.attname IN ('external_ref', 'game_date') AND NOT a.attisdropped) THEN
        RAISE EXCEPTION 'a column of the migration is still there';
    END IF;
    IF to_regclass('public.game_assignments_season_external_ref_key') IS NOT NULL OR to_regclass('public.idx_game_assignments_import_job_id') IS NOT NULL
       OR to_regclass('public.schedule_tbd_season_external_ref_key') IS NOT NULL THEN
        RAISE EXCEPTION 'an index of the migration is still there';
    END IF;
    IF pg_get_viewdef('public.view_org_metrics'::regclass) ~ 'is_external' THEN
        RAISE EXCEPTION 'view_org_metrics still names is_external';
    END IF;
    IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = 'public.view_org_metrics'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM ARRAY['organization_id', 'organization_name', 'total_players', 'total_teams',
                              'total_users', 'season_settings_id'] THEN
        RAISE EXCEPTION 'view_org_metrics has the wrong columns';
    END IF;
    -- No list the migration widened still holds its word.
    SELECT string_agg(c.conname, ', ') INTO v_bad
      FROM pg_constraint c
     WHERE c.conname IN ('import_jobs_job_type_check', 'staging_import_rows_import_type_check',
                         'import_application_records_import_type_check', 'import_application_records_target_table_check',
                         'schedule_tbd_reason_check')
       AND pg_get_constraintdef(c.oid) ~ $re$'(games|game_assignments|imported-without-time)'$re$;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a list still names the games import: %', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O') THEN
        RAISE EXCEPTION 'the Published guard is not an enabled trigger';
    END IF;
    IF pg_get_constraintdef((SELECT c.oid FROM pg_constraint c WHERE c.conname = 'import_application_records_operation_check')) ~ 'deleted' THEN
        RAISE EXCEPTION 'the application record still admits the operation deleted';
    END IF;
    RAISE NOTICE 'revert verified: the six restored function bodies are the ones before 20261121010000 (by md5), the view and the six lists are back, and the five columns, the indexes and checks, and the six functions are gone';
END;
$revert$;

COMMIT;
