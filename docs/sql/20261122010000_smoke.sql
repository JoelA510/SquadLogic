-- Smoke checks for 20261122010000_game_scores.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK. Synthetic organization, users, teams
-- and games; no real data.
--
--   1. Shape: the score table (RLS, one SELECT policy, no client write grant, the composite key, the completed-season
--      trigger), the two views (security invoker), the predicate reading game_scores.
--   2. update_game_score writes game_scores for a saved game: enter, a one-sided call refused, clear.
--   3. The held rule: a scored game is held (the one predicate), cannot be moved by a save or left out of one, and cannot
--      be cancelled, each in the words of a scored game; its unscored twin can; a score survives a save that moves the
--      games around it.
--   4. The key is the backstop: with no signed-in user a delete of a scored game meets the foreign key.
--   5. Standings: an outside club has no row and a result against one is not counted until the organization says so; a
--      signed-in member (the role authenticated) reads them; a score is cleared with score entry off.
--   6. current_game_runs is the latest completed game run of the season.
--   7. The riders: cancel_ready_import_job refuses a job that is not ready_to_apply; get_schedule_tbd returns game_date.
--
-- The pgTAP file (supabase/tests/game_scores.sql) holds the full table; this is the part the migration harness can run
-- without pgTAP, and the part its plants are shown to turn red (scripts/dbharness/prove.sh).

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_org     uuid := gen_random_uuid();
    v_admin   uuid := gen_random_uuid();
    v_season  uuid := gen_random_uuid();
    v_div     uuid := gen_random_uuid();
    v_t1      uuid := gen_random_uuid();
    v_t2      uuid := gen_random_uuid();
    v_t3      uuid := gen_random_uuid();
    v_t4      uuid := gen_random_uuid();
    v_club    uuid := gen_random_uuid();   -- an outside club of the division
    v_loc     uuid := gen_random_uuid();
    v_f1      uuid := gen_random_uuid();
    v_s1      uuid := gen_random_uuid();   -- week 1, 08:00
    v_s2      uuid := gen_random_uuid();   -- week 1, 10:00
    v_s3      uuid := gen_random_uuid();   -- week 1, 12:00
    v_s4      uuid := gen_random_uuid();   -- week 2, 08:00
    v_s5      uuid := gen_random_uuid();   -- week 2, 10:00
    v_run0    uuid := gen_random_uuid();
    v_scored  uuid := gen_random_uuid();   -- T1>T2, s1: the game that is scored
    v_twin    uuid := gen_random_uuid();   -- T3>T4, s2: its unscored twin
    v_away    uuid := gen_random_uuid();   -- T3>club, s3: a game against the outside club
    v_job     uuid;
    v_tbd     uuid := gen_random_uuid();
    v_i_scored jsonb; v_i_twin jsonb; v_i_away jsonb;
    v_res     jsonb;
    v_run     uuid;
    v_detail  text;
    v_checks  integer := 0;
BEGIN
    -- ---- 1. shape ------------------------------------------------------------------------------------
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.game_scores'::regclass)
       OR (SELECT string_agg(p.polcmd::text, ',') FROM pg_policy p WHERE p.polrelid = 'public.game_scores'::regclass) IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'game_scores does not have row level security with exactly one SELECT policy';
    END IF;
    IF has_table_privilege('authenticated', 'public.game_scores', 'INSERT') OR has_table_privilege('authenticated', 'public.game_scores', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.game_scores', 'DELETE') OR has_table_privilege('anon', 'public.game_scores', 'SELECT') THEN
        RAISE EXCEPTION 'a client role can write game_scores, or anon can read it';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.game_scores'::regclass AND c.contype = 'f'
                    AND c.confrelid = 'public.game_assignments'::regclass AND c.confdeltype = 'a' AND c.confupdtype = 'a' AND cardinality(c.conkey) = 4) THEN
        RAISE EXCEPTION 'game_scores is not keyed to the saved game and its sides with NO ACTION';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.game_scores'::regclass AND t.tgname = 'game_scores_readonly_when_completed') THEN
        RAISE EXCEPTION 'game_scores has no completed-season trigger';
    END IF;
    IF NOT (SELECT bool_and(c.reloptions @> ARRAY['security_invoker=true']) AND count(*) = 2 FROM pg_class c
             WHERE c.oid IN ('public.view_league_standings'::regclass, 'public.current_game_runs'::regclass)) THEN
        RAISE EXCEPTION 'view_league_standings and current_game_runs are not both security_invoker';
    END IF;
    v_checks := v_checks + 5;
    RAISE NOTICE 'shape: game_scores (RLS, one SELECT policy, no client write, keyed to the game and its sides NO ACTION, read-only when completed) and two invoker views';

    -- ---- seed ----------------------------------------------------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'scores-smoke-admin@example.test', '{"password_length": 12, "full_name": "Scores Admin"}');
    INSERT INTO public.profiles (id, email, full_name) VALUES (v_admin, 'scores-smoke-admin@example.test', 'Scores Admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug, feature_flags) VALUES (v_org, 'Scores Smoke Org', 'scores-smoke-' || replace(v_org::text, '-', ''), '{"score_entry": true}'::jsonb);
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin')
    ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'admin';
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES (v_season, v_org, 'Scores Season', 'active', 2026);
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, 'Scores U10');
    INSERT INTO public.teams (id, organization_id, division_id, name, is_external) VALUES
        (v_t1, v_org, v_div, 'Sc One', false), (v_t2, v_org, v_div, 'Sc Two', false), (v_t3, v_org, v_div, 'Sc Three', false),
        (v_t4, v_org, v_div, 'Sc Four', false), (v_club, v_org, v_div, 'Sc Outside Club', true);
    INSERT INTO public.locations (id, organization_id, name) VALUES (v_loc, v_org, 'Scores Park');
    INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (v_f1, v_org, v_loc, 'Scores Field');
    INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
        (v_s1, v_org, v_f1, v_div, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
        (v_s2, v_org, v_f1, v_div, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', '2026-04-04', '10:00', '11:00', 1, 1),
        (v_s3, v_org, v_f1, v_div, '2026-04-04T12:00:00Z', '2026-04-04T13:00:00Z', '2026-04-04', '12:00', '13:00', 1, 1),
        (v_s4, v_org, v_f1, v_div, '2026-04-11T08:00:00Z', '2026-04-11T09:00:00Z', '2026-04-11', '08:00', '09:00', 2, 1),
        (v_s5, v_org, v_f1, v_div, '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', '2026-04-11', '10:00', '11:00', 2, 1);
    INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
        (v_run0, v_org, v_season, v_season, 'game', 'completed', '2026-03-01T00:00:00Z');
    INSERT INTO public.game_assignments (id, organization_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source, season_settings_id) VALUES
        (v_scored, v_org, v_run0, v_s1, v_s1, v_f1, v_t1, v_t2,   'Scores U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto', v_season),
        (v_twin,   v_org, v_run0, v_s2, v_s2, v_f1, v_t3, v_t4,   'Scores U10', 1, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', 'auto', v_season),
        (v_away,   v_org, v_run0, v_s3, v_s3, v_f1, v_t3, v_club, 'Scores U10', 1, '2026-04-04T12:00:00Z', '2026-04-04T13:00:00Z', 'auto', v_season);
    v_i_scored := jsonb_build_object('id', v_scored, 'home_team_id', v_t1, 'away_team_id', v_t2,   'game_slot_id', v_s1, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T08:00:00Z', 'end', '2026-04-04T09:00:00Z', 'source', 'auto', 'division', 'Scores U10');
    v_i_twin   := jsonb_build_object('id', v_twin,   'home_team_id', v_t3, 'away_team_id', v_t4,   'game_slot_id', v_s2, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T10:00:00Z', 'end', '2026-04-04T11:00:00Z', 'source', 'auto', 'division', 'Scores U10');
    v_i_away   := jsonb_build_object('id', v_away,   'home_team_id', v_t3, 'away_team_id', v_club, 'game_slot_id', v_s3, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T12:00:00Z', 'end', '2026-04-04T13:00:00Z', 'source', 'auto', 'division', 'Scores U10');

    -- ---- 2. update_game_score writes game_scores -----------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    IF public.game_is_held(v_scored) IS NOT FALSE THEN
        RAISE EXCEPTION 'an unscored, unpublished game is held';
    END IF;
    v_res := public.update_game_score(v_org, v_scored, 3::smallint, 1::smallint, '{}'::jsonb);
    IF (v_res ->> 'changed') IS DISTINCT FROM 'true'
       OR (SELECT score_home || '-' || score_away || ' ' || updated_by FROM public.game_scores WHERE game_id = v_scored) IS DISTINCT FROM '3-1 ' || v_admin THEN
        RAISE EXCEPTION 'update_game_score did not store the score of a saved game in game_scores, with who entered it';
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE action = 'competition.score_updated' AND resource_id = v_scored) <> 1 THEN
        RAISE EXCEPTION 'the score was not audited once';
    END IF;
    BEGIN
        PERFORM public.update_game_score(v_org, v_scored, 5::smallint, NULL, '{}'::jsonb);
        RAISE EXCEPTION 'a one-sided score was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'score_one_sided' THEN RAISE EXCEPTION 'a one-sided score was refused with the wrong detail (%)', v_detail; END IF;
    END;
    v_checks := v_checks + 3;
    RAISE NOTICE 'score: entered on a saved game into game_scores with who entered it, audited once; one score without the other refused (22023 score_one_sided)';

    -- ---- 3. the held rule ----------------------------------------------------------------------------
    IF public.game_is_held(v_scored) IS NOT TRUE OR public.game_is_held(v_twin) IS NOT FALSE
       OR (SELECT array_agg(h ORDER BY h) FROM public.game_held_ids(ARRAY[v_scored, v_twin]) h) IS DISTINCT FROM ARRAY[v_scored] THEN
        RAISE EXCEPTION 'a scored game is not held by the one predicate, or its unscored twin is';
    END IF;
    -- Moved by a save: refused in the words of a scored game.
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_i_scored || jsonb_build_object('game_slot_id', v_s4, 'week_index', 2, 'start', '2026-04-11T08:00:00Z', 'end', '2026-04-11T09:00:00Z'), v_i_twin, v_i_away));
        RAISE EXCEPTION 'a save moved a scored game' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_scored' THEN RAISE EXCEPTION 'a scored game moved by a save was refused with the wrong detail (%)', v_detail; END IF;
    END;
    -- Left out of a save: refused, named.
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_i_twin, v_i_away));
        RAISE EXCEPTION 'a save left a scored game out' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM format('game_scored_omitted count=1 ids=%s', v_scored) THEN
            RAISE EXCEPTION 'a save that leaves a scored game out was refused with the wrong detail (%)', v_detail;
        END IF;
    END;
    -- Cancelled: refused.
    BEGIN
        PERFORM public.admin_cancel_game_assignment(v_scored);
        RAISE EXCEPTION 'a scored game was cancelled' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_scored' THEN RAISE EXCEPTION 'a scored game was refused a cancel with the wrong detail (%)', v_detail; END IF;
    END;
    -- The score survives a save that moves the unscored twin and carries the scored game.
    v_run := public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_i_scored, v_i_twin || jsonb_build_object('game_slot_id', v_s5, 'week_index', 2, 'start', '2026-04-11T10:00:00Z', 'end', '2026-04-11T11:00:00Z'), v_i_away));
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_scored AND game_slot_id = v_s1 AND run_id = v_run)
       OR NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_twin AND game_slot_id = v_s5 AND run_id = v_run)
       OR (SELECT score_home || '-' || score_away FROM public.game_scores WHERE game_id = v_scored) IS DISTINCT FROM '3-1'
       OR (SELECT count(*) FROM public.game_scores WHERE organization_id = v_org) <> 1 THEN
        RAISE EXCEPTION 'the score did not survive a save that moved the unscored game around it (same id, same place, in the new run, counted once)';
    END IF;
    v_checks := v_checks + 5;
    RAISE NOTICE 'held: a scored game is held by the one predicate; a save cannot move it (22023 game_scored) or leave it out (22023 game_scored_omitted, named); it cannot be cancelled (22023 game_scored); its score survives a save that moves the unscored game';

    -- ---- 4. the key is the backstop ------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN
        DELETE FROM public.game_assignments WHERE id = v_scored;
        RAISE EXCEPTION 'a scored game was deleted by a caller the guard lets through' USING ERRCODE = 'XX000';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    v_checks := v_checks + 1;
    RAISE NOTICE 'backstop: with no signed-in user the guard passes and the foreign key refuses the delete of a scored game (23503)';

    -- ---- 5. standings --------------------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.update_game_score(v_org, v_away, 2::smallint, 0::smallint, '{}'::jsonb);
    IF EXISTS (SELECT 1 FROM public.view_league_standings WHERE team_id = v_club) THEN
        RAISE EXCEPTION 'an outside club has a standings row';
    END IF;
    IF (SELECT games_played || ' ' || points || ' ' || results_not_counted FROM public.view_league_standings WHERE team_id = v_t3) IS DISTINCT FROM '0 0 1' THEN
        RAISE EXCEPTION 'a result against an outside club was counted by default (played, points, not counted: %)',
            (SELECT games_played || ' ' || points || ' ' || results_not_counted FROM public.view_league_standings WHERE team_id = v_t3);
    END IF;
    IF (SELECT games_played || ' ' || wins || ' ' || goals_for || ':' || goals_against || ' ' || points FROM public.view_league_standings WHERE team_id = v_t1) IS DISTINCT FROM '1 1 3:1 3' THEN
        RAISE EXCEPTION 'the winner of a scored game between two own teams does not have one win and three points';
    END IF;
    -- 20261124010000: the organization's value is a scoped setting, set through its one setter (feature_flags is no longer read).
    PERFORM public.admin_set_scoped_setting('standings_count_outside_results', 'organization', v_org, 'true');
    IF (SELECT games_played || ' ' || points || ' ' || results_not_counted FROM public.view_league_standings WHERE team_id = v_t3) IS DISTINCT FROM '1 3 0' THEN
        RAISE EXCEPTION 'with the organization''s setting on, the result against the outside club is still not counted';
    END IF;
    IF EXISTS (SELECT 1 FROM public.view_league_standings WHERE team_id = v_club) THEN
        RAISE EXCEPTION 'with the setting on, an outside club has a standings row';
    END IF;
    -- AS the role a signed-in reader is (the view is security_invoker, so its setting read runs as the reader; `org_flag`
    -- is closed to that role, and the helper has to be the definer that reads it for a member).
    SET LOCAL ROLE authenticated;
    IF (SELECT games_played || ' ' || points || ' ' || results_not_counted FROM public.view_league_standings WHERE team_id = v_t3) IS DISTINCT FROM '1 3 0' THEN
        RAISE EXCEPTION 'a signed-in member does not read the standings of a team with a result against an outside club';
    END IF;
    RESET ROLE;
    -- With score entry turned off a score is still cleared (a scored game must not stay held with no way to release it),
    -- and entering one is refused.
    UPDATE public.organizations SET feature_flags = feature_flags - 'score_entry' WHERE id = v_org;
    BEGIN
        PERFORM public.update_game_score(v_org, v_away, 4::smallint, 0::smallint, '{}'::jsonb);
        RAISE EXCEPTION 'a score was entered with score entry off' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    PERFORM public.update_game_score(v_org, v_away, NULL, NULL, '{}'::jsonb);
    IF EXISTS (SELECT 1 FROM public.game_scores WHERE game_id = v_away) OR public.game_is_held(v_away) THEN
        RAISE EXCEPTION 'a score could not be cleared with score entry off';
    END IF;
    UPDATE public.organizations SET feature_flags = feature_flags || '{"score_entry": true}'::jsonb WHERE id = v_org;
    v_checks := v_checks + 8;
    RAISE NOTICE 'as a signed-in reader (role authenticated) the standings of a team with a result against an outside club are read; with score entry off a score is refused (55000) and still cleared';
    RAISE NOTICE 'standings: an outside club has no row; a result against one is not counted by default (and the row says one was left out) and is counted once the organization turns it on; a win is three points';

    -- ---- 6. current_game_runs ------------------------------------------------------------------------
    IF (SELECT run_id FROM public.current_game_runs WHERE organization_id = v_org AND season_settings_id = v_season) IS DISTINCT FROM v_run THEN
        RAISE EXCEPTION 'current_game_runs does not name the latest completed game run of the season';
    END IF;
    v_checks := v_checks + 1;
    RAISE NOTICE 'current_game_runs: the season''s row is the latest completed game run';

    -- ---- 7. the riders -------------------------------------------------------------------------------
    v_job := (public.create_import_job(v_org, 'games', 'smoke.csv')).id;
    BEGIN
        PERFORM public.cancel_ready_import_job(v_job, 'games');
        RAISE EXCEPTION 'cancel_ready_import_job cancelled a job that is not ready_to_apply' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'import_not_ready_to_apply' THEN RAISE EXCEPTION 'the cancel was refused with the wrong detail (%)', v_detail; END IF;
    END;
    IF (SELECT status FROM public.import_jobs WHERE id = v_job) IS DISTINCT FROM 'importing' THEN
        RAISE EXCEPTION 'the refused cancel changed the job';
    END IF;
    PERFORM public.mark_import_job_ready_to_apply(v_job, 'games', '[]'::jsonb);
    IF (public.cancel_ready_import_job(v_job, 'games') ->> 'status') IS DISTINCT FROM 'canceled' THEN
        RAISE EXCEPTION 'a ready_to_apply job could not be cancelled';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason, game_date, external_ref)
    VALUES (v_tbd, v_org, v_season, 'game', v_div, v_t2, v_t4, 3, 'imported-without-time', '2026-04-18', 'SM-7');
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    IF (SELECT (t ->> 'game_date') || ' ' || (t ->> 'external_ref') FROM jsonb_array_elements(public.get_schedule_tbd(v_season)) t WHERE t ->> 'id' = v_tbd::text)
       IS DISTINCT FROM '2026-04-18 SM-7' THEN
        RAISE EXCEPTION 'get_schedule_tbd does not return a TIME TBD game''s date and Game ID';
    END IF;
    v_checks := v_checks + 3;
    RAISE NOTICE 'riders: cancel_ready_import_job refuses a job that is not ready_to_apply (22023 import_not_ready_to_apply) and cancels one that is; get_schedule_tbd returns game_date and external_ref';

    RAISE NOTICE 'game_scores smoke: % checks', v_checks;
END
$$;

ROLLBACK;
