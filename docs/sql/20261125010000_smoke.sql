-- Exercise confirmation on an isolated synthetic job. pgTAP also compares rollback with and without a division setting.
\set ON_ERROR_STOP on
BEGIN;
DO $smoke$
DECLARE
    v_org uuid := gen_random_uuid();
    v_admin uuid := gen_random_uuid();
    v_job uuid;
    v_detail text;
    v_preview jsonb;
    v_counts jsonb;
    v_response jsonb;
BEGIN
    IF to_regprocedure('public.apply_game_import_job(uuid,boolean)') IS NOT NULL
       OR NOT has_function_privilege('authenticated', 'public.apply_game_import_job(uuid,boolean,jsonb)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.apply_game_import_job(uuid,boolean,jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.game_import_confirm_counts(jsonb)', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.game_import_confirm_counts(jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'unexpected signature or grants on the guarded apply';
    END IF;
    -- An independent expected shape covers hidden counts, absent zeros, reasons, Booleans and repeated warnings.
    v_counts := public.game_import_confirm_counts('{"arrive_published":false,"nothing_to_apply":true,"rows":{"staged":7},
        "refused_by_reason":{"bad-date":2,"bad-week":0},"games":{"skipped":{"skipped-scored":1},"repointed":8},
        "not_in_file":{"count":3},"warnings":[{"type":"field-overlap"},{"type":"field-overlap"}]}'::jsonb);
    IF v_counts IS DISTINCT FROM '{"arrive_published":false,"nothing_to_apply":true,
        "rows.staged":7,"rows.refused":0,"rows.skipped":0,"rows.games":0,"rows.time_tbd":0,
        "games.inserted":0,"games.updated":0,"games.unchanged":0,"time_tbd.inserted":0,"time_tbd.updated":0,
        "time_tbd.unchanged":0,"time_tbd.removed":0,"time_tbd.converted":0,"created.divisions":0,"created.venues":0,
        "created.fields":0,"created.teams":0,"created.outside_teams":0,"created.slots":0,"not_in_file":3,
        "refused_by_reason.bad-date":2,"games.skipped.skipped-scored":1,"warnings.field-overlap":2}'::jsonb THEN
        RAISE EXCEPTION 'the confirmed counts differ from the displayed counts';
    END IF;

    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'game-guards@example.test', '{"password_length":12,"full_name":"Smoke Admin"}');
    INSERT INTO public.profiles (id,email,full_name) VALUES (v_admin,'game-guards@example.test','Smoke Admin')
        ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id,name,slug) VALUES (v_org,'Guards Smoke','guards-' || v_org::text);
    INSERT INTO public.organization_members (organization_id,profile_id,role) VALUES (v_org,v_admin,'admin');
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.season_settings (organization_id,name,status,season_year) VALUES (v_org,'Smoke season','active',2026);
    PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
    v_job := (public.create_import_job(v_org,'games','guards.csv')).id;
    BEGIN
        PERFORM public.apply_game_import_job(v_job,true);
        RAISE EXCEPTION 'preview accepted an incomplete file';
    EXCEPTION WHEN invalid_parameter_value THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'import_not_ready_to_apply' THEN RAISE; END IF;
    END;
    INSERT INTO public.staging_import_rows
        (organization_id,import_job_id,import_type,source_row_number,raw_payload,normalized_payload,validation_errors)
        VALUES (v_org,v_job,'games',1,'{}',NULL,'[{"code":"bad-date","message":"Invalid date"}]');
    PERFORM public.mark_import_job_ready_to_apply(v_job,'games','[]'::jsonb);
    PERFORM public.map_game_import_job(v_job,'{}'::jsonb);
    v_preview := public.apply_game_import_job(v_job,true);
    v_counts := public.game_import_confirm_counts(v_preview);
    BEGIN
        PERFORM public.apply_game_import_job(v_job,false,v_counts || '{"rows.staged":7}'::jsonb);
        RAISE EXCEPTION 'a stale confirm applied';
    EXCEPTION WHEN invalid_parameter_value THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_import_preview_stale' THEN RAISE; END IF;
    END;
    IF (SELECT status FROM public.import_jobs WHERE id=v_job) IS DISTINCT FROM 'ready_to_apply' THEN
        RAISE EXCEPTION 'the stale write changed the job';
    END IF;
    v_response := public.apply_game_import_job(v_job,false,v_counts);
    IF v_response -> 'dry_run' IS DISTINCT FROM 'false'::jsonb
       OR (public.apply_game_import_job(v_job,false) -> 'replayed') IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION 'matching counts did not apply once and replay';
    END IF;
END
$smoke$;
ROLLBACK;
