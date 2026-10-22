-- Revert 20261021040000_utc_now_idiom.sql: unpin the 42 functions, restore the
-- 79 column defaults to `timezone('utc'::text, now())`, and restore
-- fail_stale_import_jobs as production ran it (md5
-- 3769fe4ed61e117129300d27ee9f5fe4, read 2026-10-21). Rows written meanwhile
-- keep the timestamps they were given.

BEGIN;

CREATE OR REPLACE FUNCTION public.fail_stale_import_jobs(p_organization_id uuid, p_stale_before timestamp with time zone DEFAULT (timezone('utc'::text, now()) - '00:05:00'::interval))
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

ALTER FUNCTION public.admin_cancel_practice_assignment(uuid) RESET timezone;
ALTER FUNCTION public.admin_retire_field(uuid,uuid,date,boolean) RESET timezone;
ALTER FUNCTION public.admin_retire_field_subunit(uuid,uuid,date,boolean) RESET timezone;
ALTER FUNCTION public.admin_retire_location(uuid,uuid,date,boolean) RESET timezone;
ALTER FUNCTION public.admin_select_field_availability_scenario(uuid,text,text,uuid) RESET timezone;
ALTER FUNCTION public.admin_set_location_coordinates(uuid,numeric,numeric) RESET timezone;
ALTER FUNCTION public.admin_set_org_heat_settings(uuid,integer,jsonb) RESET timezone;
ALTER FUNCTION public.admin_unretire_field(uuid,uuid) RESET timezone;
ALTER FUNCTION public.admin_unretire_field_subunit(uuid,uuid) RESET timezone;
ALTER FUNCTION public.admin_unretire_location(uuid,uuid) RESET timezone;
ALTER FUNCTION public.admin_update_coach_status(uuid,uuid,text) RESET timezone;
ALTER FUNCTION public.admin_update_field(uuid,uuid,uuid,text,text,text,boolean,integer,boolean) RESET timezone;
ALTER FUNCTION public.admin_update_registration_form(uuid,jsonb) RESET timezone;
ALTER FUNCTION public.admin_update_registration_medical_status(uuid,uuid,boolean,jsonb) RESET timezone;
ALTER FUNCTION public.admin_upsert_division_settings(uuid,uuid,uuid,text,integer,integer,integer,integer,integer,integer) RESET timezone;
ALTER FUNCTION public.admin_upsert_organization_schema(uuid,text,jsonb,text) RESET timezone;
ALTER FUNCTION public.apply_player_patch(uuid,jsonb) RESET timezone;
ALTER FUNCTION public.cancel_ready_import_job(uuid,text) RESET timezone;
ALTER FUNCTION public.create_import_job(uuid,text,text) RESET timezone;
ALTER FUNCTION public.fail_import_job(uuid,text,jsonb) RESET timezone;
ALTER FUNCTION public.fail_stale_import_jobs(uuid,timestamp with time zone) RESET timezone;
ALTER FUNCTION public.finalize_coach_import_job(uuid,jsonb) RESET timezone;
ALTER FUNCTION public.finalize_field_availability_import_job(uuid,jsonb) RESET timezone;
ALTER FUNCTION public.finalize_field_import_job(uuid,jsonb) RESET timezone;
ALTER FUNCTION public.finalize_import_job(uuid,jsonb) RESET timezone;
ALTER FUNCTION public.mark_import_job_ready_to_apply(uuid,text,jsonb) RESET timezone;
ALTER FUNCTION public.materialize_import_buddy_pairs(uuid) RESET timezone;
ALTER FUNCTION public.persist_game_schedule(jsonb,jsonb) RESET timezone;
ALTER FUNCTION public.persist_practice_schedule(jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb,text) RESET timezone;
ALTER FUNCTION public.persist_team_schedule(jsonb,jsonb,jsonb) RESET timezone;
ALTER FUNCTION public.rollback_coach_import_job(uuid) RESET timezone;
ALTER FUNCTION public.rollback_field_availability_import_job(uuid) RESET timezone;
ALTER FUNCTION public.rollback_field_import_job(uuid) RESET timezone;
ALTER FUNCTION public.set_team_coaches(uuid,uuid,uuid[],date,text) RESET timezone;
ALTER FUNCTION public.submit_registration(uuid,uuid,uuid,jsonb,uuid,text,text) RESET timezone;
ALTER FUNCTION public.sync_player_team_id() RESET timezone;
ALTER FUNCTION public.trigger_set_timestamp() RESET timezone;
ALTER FUNCTION public.update_game_score(uuid,uuid,smallint,smallint,jsonb) RESET timezone;
ALTER FUNCTION public.update_import_job_progress(uuid,integer,integer,integer,jsonb) RESET timezone;
ALTER FUNCTION public.upsert_coach_leads(jsonb) RESET timezone;
ALTER FUNCTION public.upsert_division_for_import(uuid,uuid,text,text,integer,integer,date,date) RESET timezone;
ALTER FUNCTION public.upsert_team_event_rsvp(uuid,uuid,uuid,text,date,text) RESET timezone;

ALTER TABLE public.audit_actions ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.coach_interested_programs ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.coach_team_requests ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.coach_team_requests ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.coaches ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.coaches ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.divisions ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.divisions ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.email_log ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.evaluation_findings ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.evaluation_metrics ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.evaluation_run_events ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.evaluation_runs ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.evaluation_runs ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.event_rsvps ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.event_rsvps ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.export_jobs ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.export_jobs ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_availability_profile_formats ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_availability_profiles ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_availability_profiles ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_availability_scenario_members ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_availability_scenarios ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_blackout_windows ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_blackouts ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_blackouts ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_equipment_requirements ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_subunits ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.field_subunits ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.fields ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.fields ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.game_assignments ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.game_assignments ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.game_slots ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.game_slots ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.games ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.games ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.import_application_records ALTER COLUMN applied_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.import_application_records ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.import_jobs ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.import_jobs ALTER COLUMN started_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.imports ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.locations ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.locations ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organization_heat_settings ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organization_members ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organization_schema_history ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organization_schemas ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organization_schemas ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organizations ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.organizations ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.player_buddies ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.players ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.players ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.practice_assignments ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.practice_assignments ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.practice_exceptions ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.practice_slots ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.practice_slots ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.profile_players ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.profiles ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.profiles ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.publication_baselines ALTER COLUMN recorded_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.registration_forms ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.registration_forms ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.registrations ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.registrations ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.schedule_evaluations ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.scheduler_runs ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.scheduler_runs ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.season_settings ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.season_settings ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.staging_import_rows ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.staging_players ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.team_coach_assignments ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.team_messages ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.team_players ALTER COLUMN added_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.teams ALTER COLUMN created_at SET DEFAULT timezone('utc'::text, now());
ALTER TABLE public.teams ALTER COLUMN updated_at SET DEFAULT timezone('utc'::text, now());


COMMIT;
