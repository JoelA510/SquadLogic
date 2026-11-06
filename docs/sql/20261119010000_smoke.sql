-- Smoke checks for 20261119010000_game_published.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK. Synthetic organization, users, teams
-- and games; no real data.
--
--   1. Shape: the three columns, the partial index, the enabled guard trigger WHEN (OLD.published), the two audit
--      actions, and the five functions the migration touched (definer, pinned, closed to anon and PUBLIC).
--   2. The guard, for a signed-in caller: a Published game cannot have its home team, field or start changed or be
--      deleted (22023, game_published), each beside an unpublished twin that can; the flag alone can be cleared; a job
--      with no signed-in user passes.
--   3. persist_game_schedule: a save that carries the Published game unchanged is accepted; one that moves it is
--      refused by the guard; one that OMITS it is refused `game_published_omitted count=1 ids=<it>` and writes
--      nothing; one that omits the unpublished twin is accepted.
--   4. admin_cancel_game_assignment and admin_delete_team refuse a Published game.
--   5. admin_set_games_published: no user and a non-admin are refused 42501; turning off without a reason (or with an
--      unknown one) is refused 22023; turning on writes one game.published_set row; turning off writes one call row
--      and one game.publish_overridden row carrying the reason, the note and the before-image; the same call again is
--      unchanged and audited nowhere; after changes are allowed the game can be moved, and a completed season's game
--      is refused by the read-only trigger.
--
-- The pgTAP file (supabase/tests/game_published.sql) holds the full table; this is the part the migration harness can
-- run without pgTAP, and the part its three plants are shown to turn red (scripts/dbharness/prove.sh).

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_org     uuid := gen_random_uuid();
    v_admin   uuid := gen_random_uuid();
    v_other   uuid := gen_random_uuid();
    v_season  uuid := gen_random_uuid();
    v_done    uuid := gen_random_uuid();   -- a season completed below
    v_div     uuid := gen_random_uuid();
    v_div_c   uuid := gen_random_uuid();
    v_t1      uuid := gen_random_uuid();
    v_t2      uuid := gen_random_uuid();
    v_t3      uuid := gen_random_uuid();
    v_t4      uuid := gen_random_uuid();
    v_t5      uuid := gen_random_uuid();
    v_t6      uuid := gen_random_uuid();
    v_loc     uuid := gen_random_uuid();
    v_f1      uuid := gen_random_uuid();
    v_f2      uuid := gen_random_uuid();
    v_s1      uuid := gen_random_uuid();
    v_s2      uuid := gen_random_uuid();
    v_s3      uuid := gen_random_uuid();
    v_pub     uuid := gen_random_uuid();   -- the Published game
    v_twin    uuid := gen_random_uuid();   -- its unpublished twin
    v_done_g  uuid := gen_random_uuid();   -- a game of the completed season
    v_n       integer;
    v_checks  integer := 0;
    v_detail  text;
    v_msg     text;
    v_state   text;
    v_run     uuid;
    v_res     jsonb;
    v_pub_item  jsonb;
    v_twin_item jsonb;
BEGIN
    -- ---- 1. shape ------------------------------------------------------------------------------------
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = 'public.game_assignments'::regclass AND NOT a.attisdropped
           AND a.attname IN ('published', 'published_at', 'published_by')) <> 3 THEN
        RAISE EXCEPTION 'game_assignments does not hold the three published columns';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND pg_get_triggerdef(t.oid) ~ 'WHEN \(old\.published\)') THEN
        RAISE EXCEPTION 'the guard is not an enabled trigger WHEN (OLD.published)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                    AND indexdef ~ '\(organization_id\) WHERE published') THEN
        RAISE EXCEPTION 'the partial index is missing';
    END IF;
    IF (SELECT count(*) FROM public.audit_actions WHERE action IN ('game.published_set', 'game.publish_overridden')) <> 2 THEN
        RAISE EXCEPTION 'an audit action is not registered';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.game_assignments_published_guard()'::regprocedure,
                     'public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb)'::regprocedure,
                     'public.get_schedule_audit_log(uuid, uuid, integer)'::regprocedure,
                     'public.persist_game_schedule(jsonb, jsonb)'::regprocedure,
                     'public.admin_cancel_game_assignment(uuid)'::regprocedure,
                     'public.admin_delete_team(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
    IF v_n <> 6 THEN
        RAISE EXCEPTION '% of the 6 functions are definer functions with a pinned search path closed to anon and PUBLIC', v_n;
    END IF;
    IF has_function_privilege('authenticated', 'public.game_assignments_published_guard()', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.get_schedule_audit_log(uuid, uuid, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the grants to authenticated are wrong';
    END IF;
    RAISE NOTICE 'shape: 3 columns, the partial index, the guard trigger WHEN (OLD.published), 2 audit actions, 6 functions pinned and closed to anon and PUBLIC';

    -- ---- seed (no signed-in user) --------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'published-smoke-admin@example.test', '{"password_length": 12, "full_name": "Smoke Admin"}'),
        (v_other, 'published-smoke-other@example.test', '{"password_length": 12, "full_name": "Smoke Other"}');
    INSERT INTO public.profiles (id, email, full_name) VALUES
        (v_admin, 'published-smoke-admin@example.test', 'Smoke Admin'),
        (v_other, 'published-smoke-other@example.test', 'Smoke Other')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Published Smoke Org', 'published-smoke-' || replace(v_org::text, '-', ''));
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin')
    ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'admin';
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
        (v_season, v_org, 'Smoke Season', 'active', 2026),
        (v_done, v_org, 'Smoke Old Season', 'draft', 2025);
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
        (v_div, v_org, v_season, 'Smoke U10'),
        (v_div_c, v_org, v_done, 'Smoke Old U10');
    INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
        (v_t1, v_org, v_div, 'Smoke One'), (v_t2, v_org, v_div, 'Smoke Two'),
        (v_t3, v_org, v_div, 'Smoke Three'), (v_t4, v_org, v_div, 'Smoke Four'),
        (v_t5, v_org, v_div_c, 'Smoke Five'), (v_t6, v_org, v_div_c, 'Smoke Six');
    INSERT INTO public.locations (id, organization_id, name) VALUES (v_loc, v_org, 'Smoke Park');
    INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
        (v_f1, v_org, v_loc, 'Smoke Field 1'), (v_f2, v_org, v_loc, 'Smoke Field 2');
    INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
        (v_s1, v_org, v_f1, v_div, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
        (v_s2, v_org, v_f1, v_div, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', '2026-04-04', '10:00', '11:00', 1, 1),
        (v_s3, v_org, v_f1, v_div_c, '2026-03-07T08:00:00Z', '2026-03-07T09:00:00Z', '2026-03-07', '08:00', '09:00', 1, 1);
    INSERT INTO public.game_assignments (id, organization_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source) VALUES
        (v_pub, v_org, v_s1, v_s1, v_f1, v_t1, v_t2, 'Smoke U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto'),
        (v_twin, v_org, v_s2, v_s2, v_f1, v_t3, v_t4, 'Smoke U10', 1, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', 'auto'),
        (v_done_g, v_org, v_s3, v_s3, v_f1, v_t5, v_t6, 'Smoke Old U10', 1, '2026-03-07T08:00:00Z', '2026-03-07T09:00:00Z', 'auto');
    UPDATE public.game_assignments SET published = true WHERE id = v_pub;
    IF (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org AND published) <> 1 THEN
        RAISE EXCEPTION 'the seed Published one game';
    END IF;

    -- ---- 2. the guard, for a signed-in caller --------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    BEGIN
        UPDATE public.game_assignments SET home_team_id = v_t3 WHERE id = v_pub;
        RAISE EXCEPTION 'the guard let a team swap on a Published game through' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the team swap was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        UPDATE public.game_assignments SET field_id = v_f2 WHERE id = v_pub;
        RAISE EXCEPTION 'the guard let a field change on a Published game through' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the field change was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        UPDATE public.game_assignments SET start = '2026-04-04T08:30:00Z' WHERE id = v_pub;
        RAISE EXCEPTION 'the guard let a start change on a Published game through' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the start change was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        DELETE FROM public.game_assignments WHERE id = v_pub;
        RAISE EXCEPTION 'the guard let a Published game be deleted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the delete was refused for the wrong reason (%)', v_detail; END IF;
    END;
    -- Controls: the unpublished twin takes the same changes (a guard that refuses everything fails here).
    UPDATE public.game_assignments SET home_team_id = v_t4, away_team_id = v_t3 WHERE id = v_twin;
    UPDATE public.game_assignments SET field_id = v_f2 WHERE id = v_twin;
    UPDATE public.game_assignments SET start = '2026-04-04T10:30:00Z' WHERE id = v_twin;
    UPDATE public.game_assignments SET field_id = v_f1, start = '2026-04-04T10:00:00Z', home_team_id = v_t3, away_team_id = v_t4 WHERE id = v_twin;
    -- What is not a placement passes on the Published game, and so does an unchanged value.
    UPDATE public.game_assignments SET assignment_source = 'manual', division = 'Smoke U10 (renamed)' WHERE id = v_pub;
    UPDATE public.game_assignments SET field_id = field_id, start = start, "end" = "end" WHERE id = v_pub;
    UPDATE public.game_assignments SET assignment_source = 'auto', division = 'Smoke U10' WHERE id = v_pub;
    v_checks := v_checks + 4;
    RAISE NOTICE 'guard: a signed-in caller''s team swap, field change, start change and delete of a Published game were each refused 22023 game_published; the unpublished twin took the same changes; a source or division-label change and an unchanged value passed';

    -- A job with no signed-in user passes.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.game_assignments SET field_id = v_f2 WHERE id = v_pub;
    UPDATE public.game_assignments SET field_id = v_f1 WHERE id = v_pub;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_checks := v_checks + 1;
    RAISE NOTICE 'guard: with no signed-in user (a job) a Published game was moved and moved back';

    -- ---- 3. persist_game_schedule --------------------------------------------------------------------
    v_pub_item := jsonb_build_object('home_team_id', v_t1, 'away_team_id', v_t2, 'game_slot_id', v_s1, 'field_id', v_f1,
                                     'week_index', 1, 'start', '2026-04-04T08:00:00Z', 'end', '2026-04-04T09:00:00Z', 'source', 'auto');
    v_twin_item := jsonb_build_object('home_team_id', v_t3, 'away_team_id', v_t4, 'game_slot_id', v_s2, 'field_id', v_f1,
                                      'week_index', 1, 'start', '2026-04-04T10:00:00Z', 'end', '2026-04-04T11:00:00Z', 'source', 'auto');
    v_run := public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_pub_item, v_twin_item));
    IF (SELECT run_id FROM public.game_assignments WHERE id = v_pub) IS DISTINCT FROM v_run THEN
        RAISE EXCEPTION 'a save that carries the Published game forward unchanged did not reach it';
    END IF;
    SELECT count(*) INTO v_n FROM public.scheduler_runs WHERE organization_id = v_org;

    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_pub_item || '{"start": "2026-04-04T08:30:00Z"}', v_twin_item));
        RAISE EXCEPTION 'a save that moves a Published game was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the moving save was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_twin_item));
        RAISE EXCEPTION 'a save that omits a Published game was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM format('game_published_omitted count=1 ids=%s', v_pub) THEN
            RAISE EXCEPTION 'the omitting save was refused with the wrong detail (%)', v_detail;
        END IF;
    END;
    IF (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = v_org) <> v_n THEN
        RAISE EXCEPTION 'a refused save left a scheduler run behind';
    END IF;
    -- Control: leaving out the unpublished twin is accepted.
    PERFORM public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_pub_item));
    v_checks := v_checks + 3;
    RAISE NOTICE 'persist_game_schedule: a save carrying the Published game forward was accepted and reached it; one that moves it was refused game_published; one that omits it was refused game_published_omitted count=1 ids=<it> and left no run; one that omits the unpublished twin was accepted';

    -- ---- 4. cancel and delete team -------------------------------------------------------------------
    BEGIN
        PERFORM public.admin_cancel_game_assignment(v_pub);
        RAISE EXCEPTION 'cancelling a Published game was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the cancel was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        PERFORM public.admin_delete_team(v_t2);
        RAISE EXCEPTION 'deleting a team with a Published game was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_msg = MESSAGE_TEXT;
        IF v_detail IS DISTINCT FROM 'game_published' OR v_msg !~ '1 Published' THEN
            RAISE EXCEPTION 'the team delete was refused for the wrong reason (% / %)', v_detail, v_msg;
        END IF;
    END;
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = v_t2) THEN RAISE EXCEPTION 'the refused team delete deleted the team'; END IF;
    v_checks := v_checks + 2;
    RAISE NOTICE 'cancel and delete team: both refused a Published game (22023 game_published), the team was kept';

    -- ---- 5. the switch -------------------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN
        PERFORM public.admin_set_games_published(v_org, ARRAY[v_twin], true);
        RAISE EXCEPTION 'the switch accepted a call with no signed-in user' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    BEGIN
        PERFORM public.admin_set_games_published(v_org, ARRAY[v_twin], true);
        RAISE EXCEPTION 'the switch accepted a user who is not an admin of the organization' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    -- Turning off needs a reason from the list.
    BEGIN
        PERFORM public.admin_set_games_published(v_org, ARRAY[v_pub], false);
        RAISE EXCEPTION 'allowing changes without a reason was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'reason_required' THEN RAISE EXCEPTION 'refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        PERFORM public.admin_set_games_published(v_org, ARRAY[v_pub], false, 'because');
        RAISE EXCEPTION 'allowing changes with an unknown reason was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'reason_unknown' THEN RAISE EXCEPTION 'refused for the wrong reason (%)', v_detail; END IF;
    END;
    IF NOT (SELECT published FROM public.game_assignments WHERE id = v_pub) THEN
        RAISE EXCEPTION 'a refused call changed the game';
    END IF;

    -- Turning on: one call row, no override row, the time and the actor recorded.
    v_res := public.admin_set_games_published(v_org, ARRAY[v_twin], true, NULL, NULL, '{"kind": "selection"}');
    IF v_res <> jsonb_build_object('changed', 1, 'unchanged', 0, 'ids', jsonb_build_array(v_twin)) THEN
        RAISE EXCEPTION 'turning on returned %', v_res;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_twin AND published AND published_at IS NOT NULL AND published_by = v_admin) THEN
        RAISE EXCEPTION 'turning on did not record the time and the actor';
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action = 'game.published_set') <> 1
       OR (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action = 'game.publish_overridden') <> 0 THEN
        RAISE EXCEPTION 'turning on did not write exactly one game.published_set row and no override row';
    END IF;
    -- The same call again is unchanged and audited nowhere.
    v_res := public.admin_set_games_published(v_org, ARRAY[v_twin], true);
    IF v_res <> jsonb_build_object('changed', 0, 'unchanged', 1, 'ids', jsonb_build_array()) THEN
        RAISE EXCEPTION 'the repeated call returned %', v_res;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action IN ('game.published_set', 'game.publish_overridden')) <> 1 THEN
        RAISE EXCEPTION 'a no-op was audited';
    END IF;

    -- Allowing changes: one call row and one override row with the reason, the note and the before-image.
    v_res := public.admin_set_games_published(v_org, ARRAY[v_pub], false, 'field-change', 'Smoke note', '{"kind": "venue", "value": "Smoke Park"}');
    IF (v_res ->> 'changed') <> '1' THEN RAISE EXCEPTION 'allowing changes returned %', v_res; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_pub AND NOT published) THEN
        RAISE EXCEPTION 'allowing changes did not turn the flag off';
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_org AND action = 'game.publish_overridden' AND resource_id = v_pub
       AND metadata ->> 'reason_code' = 'field-change' AND metadata ->> 'note' = 'Smoke note'
       AND metadata -> 'scope' = '{"kind": "venue", "value": "Smoke Park"}'
       AND metadata #>> '{before,field_id}' = v_f1::text AND metadata #>> '{before,home_team_id}' = v_t1::text
       AND metadata #>> '{before,game_slot_id}' = v_s1::text AND (metadata #>> '{before,week_index}') = '1';
    IF v_n <> 1 THEN RAISE EXCEPTION 'the override row (reason, note, scope, before-image) was not written exactly once (%)', v_n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = v_org AND action = 'game.published_set'
                    AND NOT (metadata ->> 'published')::boolean AND metadata ->> 'reason_code' = 'field-change' AND (metadata ->> 'count') = '1') THEN
        RAISE EXCEPTION 'the call row for allowing changes is missing';
    END IF;

    -- With changes allowed the game moves and can be cancelled; turning back on is the reversal.
    UPDATE public.game_assignments SET field_id = v_f2 WHERE id = v_pub;
    UPDATE public.game_assignments SET field_id = v_f1 WHERE id = v_pub;
    v_res := public.admin_set_games_published(v_org, ARRAY[v_pub], true);
    IF (v_res ->> 'changed') <> '1' OR NOT (SELECT published FROM public.game_assignments WHERE id = v_pub) THEN
        RAISE EXCEPTION 'turning back on did not publish the game again';
    END IF;
    v_checks := v_checks + 4;
    RAISE NOTICE 'switch: refused with no user and for a non-admin (42501), without a reason or with an unknown one (22023); turned on (one call row, time and actor recorded); the repeat was unchanged and not audited; allowing changes wrote a call row and one override row with the reason, note, scope and before-image, let the game move, and turning back on published it again';

    -- A completed season's game is refused by the read-only trigger, which wins over the flag.
    UPDATE public.season_settings SET status = 'completed' WHERE id = v_done;
    BEGIN
        PERFORM public.admin_set_games_published(v_org, ARRAY[v_done_g], true);
        RAISE EXCEPTION 'the switch changed a completed season''s game' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'season_completed' THEN RAISE EXCEPTION 'refused for the wrong reason (%)', v_detail; END IF;
    END;
    v_checks := v_checks + 1;
    RAISE NOTICE 'completed season: the switch was refused 22023 season_completed';

    RAISE NOTICE 'game published smoke: % groups of checks passed', v_checks;
END;
$$;

ROLLBACK;
