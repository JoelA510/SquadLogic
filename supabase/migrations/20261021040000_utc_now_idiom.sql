-- `timezone('utc', now())` stored a time shifted by the caller's session zone
-- (plan docs/changes/2026-10-20-utc-now-idiom.md, option 1, approved 2026-10-21).
--
-- `timezone('utc', now())` is a `timestamp` WITHOUT time zone: the UTC wall
-- clock. Written into a `timestamptz`, PostgreSQL reads that wall clock in the
-- SESSION's TimeZone, so a PostgREST caller sending `Prefer: timezone=...`
-- stored every such timestamp shifted by its zone's offset (up to 14 hours
-- early or 12 late; executed on PostgreSQL 16, 2026-10-20). Nothing changes for
-- a session at UTC, which every caller uses today.
--
-- Option 1, generated from the catalogue of a migration-built database
-- (2026-10-21; production matched it: the same 42 functions and 79 column
-- defaults) and listed explicitly:
--   * the 42 public functions whose body uses the idiom as a timestamp are
--     pinned `SET timezone = 'UTC'`, so it means what it says inside them. No
--     body is rewritten. `team_local_today` is not pinned: its one use is the
--     deliberate UTC calendar date, `(now() AT TIME ZONE 'UTC')::date`;
--   * the 79 column defaults become `now()`;
--   * `fail_stale_import_jobs`' argument default becomes `now() - 5 minutes`.
--     An omitted argument's default is evaluated in the CALLER's query, before
--     the function's own `SET` applies, so pinning alone would not fix it. Its
--     body is production's text (pg_get_functiondef, read 2026-10-21) with only
--     that default changed.
--
-- What pinning also changes inside those 42 functions, inventoried in the plan:
-- `current_date`, a timestamptz cast to `date`, and a text timestamp parsed
-- without an offset now use UTC, not the session's zone. Every caller runs at
-- UTC today, so their behaviour is unchanged; moving a calendar check to the
-- season's zone is a body rewrite and belongs to its own plan.
--
-- Guards: tests/utcNowIdiom.test.js fails on any later migration that uses the
-- idiom as a timestamp; the migration harness fails on any public function
-- using it without the pin, and on any column or argument default using it.
--
-- Revert: docs/sql/20261021040000_revert.sql. Smoke: docs/sql/20261021040000_smoke.sql.
-- pgTAP: supabase/tests/utc_now_idiom.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. fail_stale_import_jobs: the argument default, evaluated by the caller.
--    First: CREATE OR REPLACE resets a function's SET clauses, so the pin
--    below must come after it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fail_stale_import_jobs(p_organization_id uuid, p_stale_before timestamp with time zone DEFAULT (now() - '00:05:00'::interval))
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_now timestamptz := timezone('utc', now());
    v_failed_count integer := 0;
    v_failed_job_ids uuid[] := ARRAY[]::uuid[];
    v_result jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_id is required'
            USING ERRCODE = '22023';
    END IF;

    IF p_stale_before IS NULL THEN
        RAISE EXCEPTION 'stale_before is required'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Only organization admins can fail stale import jobs'
            USING ERRCODE = '42501';
    END IF;

    WITH stale_jobs AS (
        SELECT
            id,
            status AS previous_status,
            COALESCE(last_heartbeat_at, started_at, created_at) AS heartbeat_at
        FROM public.import_jobs
        WHERE organization_id = p_organization_id
          AND status IN ('queued', 'processing', 'importing')
          AND COALESCE(last_heartbeat_at, started_at, created_at) < p_stale_before
        FOR UPDATE
    ),
    updated_jobs AS (
        UPDATE public.import_jobs job
        SET
            status = 'failed',
            completed_at = v_now,
            error_summary = jsonb_set(
                COALESCE(job.error_summary, '{}'::jsonb),
                '{stale_cleanup}',
                jsonb_build_object(
                    'status', 'failed',
                    'previous_status', stale_jobs.previous_status,
                    'last_heartbeat_at', stale_jobs.heartbeat_at,
                    'stale_before', p_stale_before,
                    'failed_at', v_now,
                    'message', 'Import job stopped sending progress heartbeats and was failed for retry'
                ),
                true
            )
        FROM stale_jobs
        WHERE job.id = stale_jobs.id
        RETURNING job.id
    )
    SELECT
        count(*)::integer,
        COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[])
    INTO v_failed_count, v_failed_job_ids
    FROM updated_jobs;

    v_result := jsonb_build_object(
        'status', 'completed',
        'failed_jobs', v_failed_count,
        'job_ids', to_jsonb(v_failed_job_ids),
        'stale_before', p_stale_before,
        'cleaned_at', v_now
    );

    IF v_failed_count > 0 THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'import.failed',
            'import_job',
            NULL,
            jsonb_build_object(
                'stage', 'stale_cleanup',
                'failed_jobs', v_failed_count,
                'job_ids', to_jsonb(v_failed_job_ids),
                'stale_before', p_stale_before,
                'cleaned_at', v_now
            )
        );
    END IF;

    RETURN v_result;
END;
$function$
;

-- ---------------------------------------------------------------------------
-- 2. Functions: the idiom means UTC inside them.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.admin_cancel_practice_assignment(uuid) SET timezone = 'UTC';
ALTER FUNCTION public.admin_retire_field(uuid,uuid,date,boolean) SET timezone = 'UTC';
ALTER FUNCTION public.admin_retire_field_subunit(uuid,uuid,date,boolean) SET timezone = 'UTC';
ALTER FUNCTION public.admin_retire_location(uuid,uuid,date,boolean) SET timezone = 'UTC';
ALTER FUNCTION public.admin_select_field_availability_scenario(uuid,text,text,uuid) SET timezone = 'UTC';
ALTER FUNCTION public.admin_set_location_coordinates(uuid,numeric,numeric) SET timezone = 'UTC';
ALTER FUNCTION public.admin_set_org_heat_settings(uuid,integer,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.admin_unretire_field(uuid,uuid) SET timezone = 'UTC';
ALTER FUNCTION public.admin_unretire_field_subunit(uuid,uuid) SET timezone = 'UTC';
ALTER FUNCTION public.admin_unretire_location(uuid,uuid) SET timezone = 'UTC';
ALTER FUNCTION public.admin_update_coach_status(uuid,uuid,text) SET timezone = 'UTC';
ALTER FUNCTION public.admin_update_field(uuid,uuid,uuid,text,text,text,boolean,integer,boolean) SET timezone = 'UTC';
ALTER FUNCTION public.admin_update_registration_form(uuid,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.admin_update_registration_medical_status(uuid,uuid,boolean,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.admin_upsert_division_settings(uuid,uuid,uuid,text,integer,integer,integer,integer,integer,integer) SET timezone = 'UTC';
ALTER FUNCTION public.admin_upsert_organization_schema(uuid,text,jsonb,text) SET timezone = 'UTC';
ALTER FUNCTION public.apply_player_patch(uuid,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.cancel_ready_import_job(uuid,text) SET timezone = 'UTC';
ALTER FUNCTION public.create_import_job(uuid,text,text) SET timezone = 'UTC';
ALTER FUNCTION public.fail_import_job(uuid,text,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.fail_stale_import_jobs(uuid,timestamp with time zone) SET timezone = 'UTC';
ALTER FUNCTION public.finalize_coach_import_job(uuid,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.finalize_field_availability_import_job(uuid,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.finalize_field_import_job(uuid,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.finalize_import_job(uuid,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.mark_import_job_ready_to_apply(uuid,text,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.materialize_import_buddy_pairs(uuid) SET timezone = 'UTC';
ALTER FUNCTION public.persist_game_schedule(jsonb,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.persist_practice_schedule(jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb,text) SET timezone = 'UTC';
ALTER FUNCTION public.persist_team_schedule(jsonb,jsonb,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.rollback_coach_import_job(uuid) SET timezone = 'UTC';
ALTER FUNCTION public.rollback_field_availability_import_job(uuid) SET timezone = 'UTC';
ALTER FUNCTION public.rollback_field_import_job(uuid) SET timezone = 'UTC';
ALTER FUNCTION public.set_team_coaches(uuid,uuid,uuid[],date,text) SET timezone = 'UTC';
ALTER FUNCTION public.submit_registration(uuid,uuid,uuid,jsonb,uuid,text,text) SET timezone = 'UTC';
ALTER FUNCTION public.sync_player_team_id() SET timezone = 'UTC';
ALTER FUNCTION public.trigger_set_timestamp() SET timezone = 'UTC';
ALTER FUNCTION public.update_game_score(uuid,uuid,smallint,smallint,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.update_import_job_progress(uuid,integer,integer,integer,jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.upsert_coach_leads(jsonb) SET timezone = 'UTC';
ALTER FUNCTION public.upsert_division_for_import(uuid,uuid,text,text,integer,integer,date,date) SET timezone = 'UTC';
ALTER FUNCTION public.upsert_team_event_rsvp(uuid,uuid,uuid,text,date,text) SET timezone = 'UTC';

-- ---------------------------------------------------------------------------
-- 3. Column defaults: now(), an instant, whatever the session's zone.
-- ---------------------------------------------------------------------------

ALTER TABLE public.audit_actions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.coach_interested_programs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.coach_team_requests ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.coach_team_requests ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.coaches ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.coaches ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.divisions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.divisions ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.email_log ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.evaluation_findings ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.evaluation_metrics ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.evaluation_run_events ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.evaluation_runs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.evaluation_runs ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.event_rsvps ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.event_rsvps ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.export_jobs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.export_jobs ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.field_availability_profile_formats ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_availability_profiles ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_availability_profiles ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.field_availability_scenario_members ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_availability_scenarios ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_blackout_windows ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_blackouts ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_blackouts ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.field_equipment_requirements ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_subunits ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.field_subunits ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.fields ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.fields ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.game_assignments ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.game_assignments ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.game_slots ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.game_slots ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.games ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.games ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.import_application_records ALTER COLUMN applied_at SET DEFAULT now();
ALTER TABLE public.import_application_records ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.import_jobs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.import_jobs ALTER COLUMN started_at SET DEFAULT now();
ALTER TABLE public.imports ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.locations ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.locations ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.organization_heat_settings ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.organization_members ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.organization_schema_history ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.organization_schemas ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.organization_schemas ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.organizations ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.organizations ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.player_buddies ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.players ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.players ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.practice_assignments ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.practice_assignments ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.practice_exceptions ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.practice_slots ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.practice_slots ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.profile_players ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.profiles ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.profiles ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.publication_baselines ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE public.registration_forms ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.registration_forms ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.registrations ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.registrations ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.schedule_evaluations ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.scheduler_runs ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.scheduler_runs ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.season_settings ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.season_settings ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.staging_import_rows ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.staging_players ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.team_coach_assignments ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.team_messages ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.team_players ALTER COLUMN added_at SET DEFAULT now();
ALTER TABLE public.teams ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.teams ALTER COLUMN updated_at SET DEFAULT now();


COMMIT;
