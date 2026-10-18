-- Smoke checks for 20261018060000_audit_in_save_transaction.sql
--
-- What it proves (plan section 4), with prelude.sql stubbing `auth.uid()` from
-- `request.jwt.claim.sub` and `auth.role()` from `request.jwt.claim.role`:
--   1. an admin's team save returns its run id and leaves exactly one
--      `team.saved` row on that run (`resource_type` scheduler_run,
--      `resource_id` the run, `user_id` the admin, the counts in metadata);
--      the same for a game save and `game.saved`;
--   2. atomicity: with `team.saved` and `game.saved` unregistered from
--      `audit_actions` inside a rolled-back block, each save raises SLA01 with
--      the audit's own SQLSTATE (23503) in DETAIL, and leaves no
--      `scheduler_runs` row, no team, no roster row and no game assignment;
--   3. a caller with no user (the service role) is refused 42501 by the
--      no-actor guard on both RPCs, and a coach of the organization -- a
--      member, not an admin -- is refused 42501 by the admin check on both;
--      none of them writes a run, a team or a game (plan section 1.1, inverted);
--   4. both functions are still SECURITY DEFINER with search_path=public,
--      executable by authenticated and service_role and not by anon.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_org uuid := gen_random_uuid();
    v_season uuid := gen_random_uuid();
    v_div uuid := gen_random_uuid();
    v_loc uuid := gen_random_uuid();
    v_field uuid := gen_random_uuid();
    v_slot uuid := gen_random_uuid();
    v_home uuid := gen_random_uuid();
    v_away uuid := gen_random_uuid();
    v_player uuid := gen_random_uuid();
    v_new_team uuid := gen_random_uuid();
    v_run uuid;
    v_code text;
    v_msg text;
    v_detail text;
    v_rows integer;
    v_row public.audit_log%ROWTYPE;
    v_team_code text; v_team_detail text; v_team_runs integer; v_team_teams integer; v_team_roster integer;
    v_game_code text; v_game_detail text; v_game_runs integer; v_game_rows integer;
    v_runs_before integer;
    v_games_before integer;
    v_teams_before integer;
    v_refusals integer := 0;
    v_team_run_data jsonb;
    v_game_run_data jsonb;
    v_game_assignments jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'save-admin@example.test', '{"password_length": 16}'),
        (v_coach, 'save-coach@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'save-admin@example.test'),
        (v_coach, 'save-coach@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Smoke Org Save', 'smoke-org-save');
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'),
        (v_org, v_coach, 'coach');
    INSERT INTO public.season_settings (id, organization_id, name) VALUES (v_season, v_org, 'Smoke Save Season');
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
        VALUES (v_div, v_org, v_season, 'Smoke Save U10');
    INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
        (v_home, v_org, v_div, 'Smoke Home'),
        (v_away, v_org, v_div, 'Smoke Away');
    INSERT INTO public.players (id, organization_id, division_id, first_name, last_name)
        VALUES (v_player, v_org, v_div, 'Pat', 'Example');
    INSERT INTO public.locations (id, organization_id, name) VALUES (v_loc, v_org, 'Smoke Save Park');
    INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (v_field, v_org, v_loc, 'Smoke Pitch');
    INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end",
                                   slot_date, start_time, end_time, week_index, capacity)
        VALUES (v_slot, v_org, v_field, v_div, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z',
                '2026-04-04', '08:00', '09:00', 1, 1);

    v_team_run_data := jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season,
                                          'run_type', 'team', 'status', 'completed');
    v_game_run_data := jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season,
                                          'run_type', 'game', 'status', 'completed');
    v_game_assignments := jsonb_build_array(jsonb_build_object(
        'home_team_id', v_home, 'away_team_id', v_away, 'game_slot_id', v_slot,
        'field_id', v_field, 'week_index', 1,
        'start', '2026-04-04T08:00:00Z', 'end', '2026-04-04T09:00:00Z', 'source', 'auto'));

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- (2) Atomicity, first, while no audit row names either action (the
    --     registry rows cannot be removed once one does). The block ends in a
    --     sentinel raise, so the registry comes back; what it saw is kept in
    --     variables.
    BEGIN
        DELETE FROM public.audit_actions WHERE action IN ('team.saved', 'game.saved');
        BEGIN
            PERFORM public.persist_team_schedule(
                v_team_run_data || jsonb_build_object('id', gen_random_uuid()),
                jsonb_build_array(jsonb_build_object('id', v_new_team, 'division_id', v_div, 'name', 'Smoke New Team')),
                jsonb_build_array(jsonb_build_object('team_id', v_new_team, 'player_id', v_player, 'source', 'auto')));
            v_team_code := 'success';
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_team_code = RETURNED_SQLSTATE, v_team_detail = PG_EXCEPTION_DETAIL;
        END;
        SELECT count(*) INTO v_team_runs FROM public.scheduler_runs WHERE organization_id = v_org;
        SELECT count(*) INTO v_team_teams FROM public.teams WHERE id = v_new_team;
        SELECT count(*) INTO v_team_roster FROM public.team_players WHERE player_id = v_player;
        BEGIN
            PERFORM public.persist_game_schedule(v_game_run_data, v_game_assignments);
            v_game_code := 'success';
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_game_code = RETURNED_SQLSTATE, v_game_detail = PG_EXCEPTION_DETAIL;
        END;
        SELECT count(*) INTO v_game_runs FROM public.scheduler_runs WHERE organization_id = v_org;
        SELECT count(*) INTO v_game_rows FROM public.game_assignments WHERE organization_id = v_org;
        RAISE EXCEPTION 'smoke-restore-audit-actions';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'smoke-restore-audit-actions' THEN RAISE; END IF;
    END;
    IF v_team_code IS DISTINCT FROM 'SLA01' OR v_team_detail IS DISTINCT FROM '23503' THEN
        RAISE EXCEPTION 'a team save whose audit write failed raised % (detail %), not SLA01 with 23503', v_team_code, v_team_detail;
    END IF;
    IF v_team_runs <> 0 OR v_team_teams <> 0 OR v_team_roster <> 0 THEN
        RAISE EXCEPTION 'a team save whose audit write failed left % run(s), % team(s), % roster row(s)',
            v_team_runs, v_team_teams, v_team_roster;
    END IF;
    IF v_game_code IS DISTINCT FROM 'SLA01' OR v_game_detail IS DISTINCT FROM '23503' THEN
        RAISE EXCEPTION 'a game save whose audit write failed raised % (detail %), not SLA01 with 23503', v_game_code, v_game_detail;
    END IF;
    IF v_game_runs <> 0 OR v_game_rows <> 0 THEN
        RAISE EXCEPTION 'a game save whose audit write failed left % run(s) and % game assignment(s)', v_game_runs, v_game_rows;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'team.saved')
       OR NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'game.saved') THEN
        RAISE EXCEPTION 'the atomicity block did not restore the audit_actions registry';
    END IF;
    RAISE NOTICE 'audit atomicity: with its audit write failing, the team save and the game save each raised SLA01 (detail 23503) and left 0 runs, 0 teams, 0 roster rows and 0 game assignments';

    -- (1) The admin's saves, each audited once on its run.
    v_run := public.persist_team_schedule(
        v_team_run_data,
        jsonb_build_array(jsonb_build_object('id', v_new_team, 'division_id', v_div, 'name', 'Smoke New Team')),
        jsonb_build_array(jsonb_build_object('team_id', v_new_team, 'player_id', v_player, 'source', 'auto')));
    SELECT count(*) INTO v_rows FROM public.audit_log WHERE action = 'team.saved' AND organization_id = v_org;
    SELECT * INTO v_row FROM public.audit_log WHERE action = 'team.saved' AND organization_id = v_org;
    IF v_run IS NULL OR v_rows <> 1 OR v_row.resource_type IS DISTINCT FROM 'scheduler_run'
       OR v_row.resource_id IS DISTINCT FROM v_run OR v_row.user_id IS DISTINCT FROM v_admin
       OR v_row.metadata IS DISTINCT FROM jsonb_build_object(
              'season_settings_id', v_season, 'team_count', 1, 'team_player_count', 1) THEN
        RAISE EXCEPTION 'the team save left % team.saved row(s); expected one on run % by the admin: %', v_rows, v_run, row_to_json(v_row);
    END IF;
    IF (SELECT created_by FROM public.scheduler_runs WHERE id = v_run) IS DISTINCT FROM v_admin THEN
        RAISE EXCEPTION 'the team run''s created_by is not the caller';
    END IF;

    v_run := public.persist_game_schedule(v_game_run_data, v_game_assignments);
    SELECT count(*) INTO v_rows FROM public.audit_log WHERE action = 'game.saved' AND organization_id = v_org;
    SELECT * INTO v_row FROM public.audit_log WHERE action = 'game.saved' AND organization_id = v_org;
    IF v_run IS NULL OR v_rows <> 1 OR v_row.resource_type IS DISTINCT FROM 'scheduler_run'
       OR v_row.resource_id IS DISTINCT FROM v_run OR v_row.user_id IS DISTINCT FROM v_admin
       OR v_row.metadata IS DISTINCT FROM jsonb_build_object('season_settings_id', v_season, 'game_count', 1) THEN
        RAISE EXCEPTION 'the game save left % game.saved row(s); expected one on run % by the admin: %', v_rows, v_run, row_to_json(v_row);
    END IF;
    RAISE NOTICE 'an admin''s team save and game save each leave exactly 1 audit row on their run (scheduler_run), attributed to the admin, with the season and counts';

    -- (3) The refusals: no user, then a coach. Each must be 42501 with its own
    --     message, and none may write.
    SELECT count(*) INTO v_runs_before FROM public.scheduler_runs WHERE organization_id = v_org;
    SELECT count(*) INTO v_games_before FROM public.game_assignments WHERE organization_id = v_org;
    SELECT count(*) INTO v_teams_before FROM public.teams WHERE organization_id = v_org;

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    BEGIN
        PERFORM public.persist_team_schedule(v_team_run_data,
            jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'division_id', v_div, 'name', 'Service Team')),
            '[]'::jsonb);
        v_code := 'success';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_code IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'persist_team_schedule needs a signed-in caller%' THEN
        RAISE EXCEPTION 'a service-role team save was not refused by the no-actor guard: % %', v_code, v_msg;
    END IF;
    v_refusals := v_refusals + 1;
    BEGIN
        PERFORM public.persist_game_schedule(v_game_run_data, v_game_assignments);
        v_code := 'success';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_code IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'persist_game_schedule needs a signed-in caller%' THEN
        RAISE EXCEPTION 'a service-role game save was not refused by the no-actor guard: % %', v_code, v_msg;
    END IF;
    v_refusals := v_refusals + 1;

    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    BEGIN
        PERFORM public.persist_game_schedule(v_game_run_data, v_game_assignments);
        v_code := 'success';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_code IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'caller is not an admin of organization%' THEN
        RAISE EXCEPTION 'a coach''s game save was not refused as a non-admin: % %', v_code, v_msg;
    END IF;
    v_refusals := v_refusals + 1;
    -- The game save's later check, reached when only the season names the
    -- organization.
    BEGIN
        PERFORM public.persist_game_schedule(v_game_run_data - 'organization_id', v_game_assignments);
        v_code := 'success';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_code IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'caller is not an admin of organization%' THEN
        RAISE EXCEPTION 'a coach''s game save naming only the season was not refused as a non-admin: % %', v_code, v_msg;
    END IF;
    v_refusals := v_refusals + 1;
    BEGIN
        PERFORM public.persist_team_schedule(v_team_run_data,
            jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'division_id', v_div, 'name', 'Coach Team')),
            '[]'::jsonb);
        v_code := 'success';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_code IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'caller is not an admin of organization%' THEN
        RAISE EXCEPTION 'a coach''s team save was not refused as a non-admin: % %', v_code, v_msg;
    END IF;
    v_refusals := v_refusals + 1;

    IF (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = v_org) <> v_runs_before
       OR (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org) <> v_games_before
       OR (SELECT count(*) FROM public.teams WHERE organization_id = v_org) <> v_teams_before THEN
        RAISE EXCEPTION 'a refused save still wrote a run, a game assignment or a team';
    END IF;
    RAISE NOTICE 'the service role (no user) is refused 42501 by both saves, and a coach by both admin checks: % of 5 refusals, nothing written', v_refusals;

    -- (4) The posture is unchanged.
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.oid IN ('public.persist_team_schedule(jsonb, jsonb, jsonb)'::regprocedure,
                         'public.persist_game_schedule(jsonb, jsonb)'::regprocedure)
           AND p.prosecdef AND p.proconfig = ARRAY['search_path=public']) <> 2 THEN
        RAISE EXCEPTION 'a save RPC lost SECURITY DEFINER or search_path=public';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.persist_team_schedule(jsonb, jsonb, jsonb)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.persist_game_schedule(jsonb, jsonb)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.persist_team_schedule(jsonb, jsonb, jsonb)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.persist_game_schedule(jsonb, jsonb)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.persist_team_schedule(jsonb, jsonb, jsonb)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.persist_game_schedule(jsonb, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the save RPCs'' grants changed';
    END IF;
    RAISE NOTICE 'both save RPCs are SECURITY DEFINER with search_path=public; authenticated and service_role execute them, anon does not';
END;
$$;

ROLLBACK;
