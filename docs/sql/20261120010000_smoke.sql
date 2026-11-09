-- Smoke checks for 20261120010000_game_identity.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK. Synthetic organization, users, teams
-- and games; no real data.
--
--   1. Shape: the season column and its foreign key, the two indexes, the two predicate functions (STABLE invoker,
--      internal), the guard trigger without a WHEN clause, and the four functions the migration replaced.
--   2. The predicate: a Published game is held, its twin is not, an unknown or NULL id is not.
--   3. persist_game_schedule updates in place: a game moved to another slot and week by its id keeps its id and
--      leaves no row behind; a flip keeps the id; two games of one pair swap places in one save; the season is on
--      every game the save wrote; an assignment WITHOUT an id that moves is a new row, as it always was.
--   4. The refusals, each leaving no run behind: an unknown id (23503 game_not_found), a repeated id (22023
--      game_identity_repeated), a Published game moved by its id (22023 game_published), a game moved onto the place
--      of an older hidden row (22023 game_identity_conflict, both ids in the DETAIL).
--
-- The pgTAP file (supabase/tests/game_identity.sql) holds the full table; this is the part the migration harness can
-- run without pgTAP, and the part its plants are shown to turn red (scripts/dbharness/prove.sh).

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
    v_t5      uuid := gen_random_uuid();
    v_t6      uuid := gen_random_uuid();
    v_loc     uuid := gen_random_uuid();
    v_f1      uuid := gen_random_uuid();
    v_s1      uuid := gen_random_uuid();   -- week 1, 08:00
    v_s2      uuid := gen_random_uuid();   -- week 1, 10:00
    v_s3      uuid := gen_random_uuid();   -- week 1, 12:00
    v_s4      uuid := gen_random_uuid();   -- week 1, 14:00
    v_s5      uuid := gen_random_uuid();   -- week 2, 08:00
    v_s6      uuid := gen_random_uuid();   -- week 2, 10:00
    v_season2 uuid := gen_random_uuid();   -- another season of the same organization (a draft: one season is active at a time)
    v_run0    uuid := gen_random_uuid();
    v_pub     uuid := gen_random_uuid();   -- T1>T2, s1: Published
    v_mover   uuid := gen_random_uuid();   -- T3>T4, s2: moved by id
    v_x       uuid := gen_random_uuid();   -- T5>T6, s3
    v_y       uuid := gen_random_uuid();   -- T5>T6, s4: x and y swap places
    v_hidden  uuid := gen_random_uuid();   -- T3>T4, s6, an older run: where the mover is later told to go
    v_n       integer;
    v_rows    integer;
    v_checks  integer := 0;
    v_detail  text;
    v_run     uuid;
    v_run0_n  integer;
    v_pub_i   jsonb;
    v_mover_i jsonb;
    v_x_i     jsonb;
    v_y_i     jsonb;
BEGIN
    -- ---- 1. shape ------------------------------------------------------------------------------------
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'season_settings_id'
                    AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = 'uuid' AND NOT a.attnotnull) THEN
        RAISE EXCEPTION 'game_assignments does not hold season_settings_id (uuid, nullable)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.game_assignments'::regclass AND c.contype = 'f'
                    AND c.confrelid = 'public.season_settings'::regclass AND c.confdeltype = 'n'
                    AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'season_settings_id')]) THEN
        RAISE EXCEPTION 'season_settings_id is not a foreign key to season_settings ON DELETE SET NULL';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                    AND indexname = 'idx_game_assignments_season_settings_id')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                       AND indexname = 'game_assignments_id_org_teams_key' AND indexdef ~ 'UNIQUE.*\(id, organization_id, home_team_id, away_team_id\)') THEN
        RAISE EXCEPTION 'an index of the migration is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND pg_get_triggerdef(t.oid) !~ 'WHEN') THEN
        RAISE EXCEPTION 'the guard is not an enabled trigger without a WHEN clause';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.game_held_ids(uuid[])'::regprocedure, 'public.game_is_held(uuid)'::regprocedure)
       AND p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
    IF v_n <> 2 THEN RAISE EXCEPTION '% of the 2 predicate functions are STABLE invoker functions pinned to search_path and closed to every client role', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.game_assignments_published_guard()'::regprocedure, 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure,
                     'public.admin_cancel_game_assignment(uuid)'::regprocedure, 'public.admin_delete_team(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
    IF v_n <> 4 THEN RAISE EXCEPTION '% of the 4 replaced functions are definer functions with a pinned search path closed to anon and PUBLIC', v_n; END IF;
    RAISE NOTICE 'shape: the season column and its key, 2 indexes, 2 internal predicate functions, the guard without a WHEN clause, 4 replaced functions pinned and closed to anon and PUBLIC';

    -- ---- seed (no signed-in user) --------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'identity-smoke-admin@example.test', '{"password_length": 12, "full_name": "Identity Admin"}');
    INSERT INTO public.profiles (id, email, full_name) VALUES (v_admin, 'identity-smoke-admin@example.test', 'Identity Admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Identity Smoke Org', 'identity-smoke-' || replace(v_org::text, '-', ''));
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin')
    ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'admin';
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES (v_season, v_org, 'Identity Season', 'active', 2026);
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, 'Identity U10');
    INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
        (v_t1, v_org, v_div, 'Id One'), (v_t2, v_org, v_div, 'Id Two'), (v_t3, v_org, v_div, 'Id Three'),
        (v_t4, v_org, v_div, 'Id Four'), (v_t5, v_org, v_div, 'Id Five'), (v_t6, v_org, v_div, 'Id Six');
    INSERT INTO public.locations (id, organization_id, name) VALUES (v_loc, v_org, 'Identity Park');
    INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (v_f1, v_org, v_loc, 'Identity Field');
    INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
        (v_s1, v_org, v_f1, v_div, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
        (v_s2, v_org, v_f1, v_div, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', '2026-04-04', '10:00', '11:00', 1, 1),
        (v_s3, v_org, v_f1, v_div, '2026-04-04T12:00:00Z', '2026-04-04T13:00:00Z', '2026-04-04', '12:00', '13:00', 1, 1),
        (v_s4, v_org, v_f1, v_div, '2026-04-04T14:00:00Z', '2026-04-04T15:00:00Z', '2026-04-04', '14:00', '15:00', 1, 1),
        (v_s5, v_org, v_f1, v_div, '2026-04-11T08:00:00Z', '2026-04-11T09:00:00Z', '2026-04-11', '08:00', '09:00', 2, 1),
        (v_s6, v_org, v_f1, v_div, '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', '2026-04-11', '10:00', '11:00', 2, 1);
    INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
        (v_run0, v_org, v_season, v_season, 'game', 'completed', '2026-03-01T00:00:00Z');
    INSERT INTO public.game_assignments (id, organization_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source) VALUES
        (v_pub,    v_org, v_run0, v_s1, v_s1, v_f1, v_t1, v_t2, 'Identity U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto'),
        (v_mover,  v_org, v_run0, v_s2, v_s2, v_f1, v_t3, v_t4, 'Identity U10', 1, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', 'auto'),
        (v_x,      v_org, v_run0, v_s3, v_s3, v_f1, v_t5, v_t6, 'Identity U10', 1, '2026-04-04T12:00:00Z', '2026-04-04T13:00:00Z', 'auto'),
        (v_y,      v_org, v_run0, v_s4, v_s4, v_f1, v_t5, v_t6, 'Identity U10', 1, '2026-04-04T14:00:00Z', '2026-04-04T15:00:00Z', 'auto'),
        (v_hidden, v_org, NULL,   v_s6, v_s6, v_f1, v_t3, v_t4, 'Identity U10', 2, '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', 'auto');
    UPDATE public.game_assignments SET published = true WHERE id = v_pub;

    -- ---- 2. the predicate ----------------------------------------------------------------------------
    IF public.game_is_held(v_pub) IS NOT TRUE OR public.game_is_held(v_mover) IS NOT FALSE
       OR public.game_is_held(gen_random_uuid()) IS NOT FALSE OR public.game_is_held(NULL) IS NOT FALSE THEN
        RAISE EXCEPTION 'game_is_held does not answer true for a Published game and false for its twin, an unknown id and NULL';
    END IF;
    IF (SELECT array_agg(h ORDER BY h) FROM public.game_held_ids(ARRAY[v_pub, v_mover]) h) IS DISTINCT FROM ARRAY[v_pub] THEN
        RAISE EXCEPTION 'game_held_ids does not return exactly the held game among those given';
    END IF;
    v_checks := v_checks + 2;
    RAISE NOTICE 'predicate: a Published game is held; its twin, an unknown id and NULL are not; the set form returns the held ones';

    -- ---- 3. a save updates a game in place -----------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_pub_i   := jsonb_build_object('id', v_pub,   'home_team_id', v_t1, 'away_team_id', v_t2, 'game_slot_id', v_s1, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T08:00:00Z', 'end', '2026-04-04T09:00:00Z', 'source', 'auto');
    v_mover_i := jsonb_build_object('id', v_mover, 'home_team_id', v_t3, 'away_team_id', v_t4, 'game_slot_id', v_s2, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T10:00:00Z', 'end', '2026-04-04T11:00:00Z', 'source', 'auto');
    v_x_i     := jsonb_build_object('id', v_x,     'home_team_id', v_t5, 'away_team_id', v_t6, 'game_slot_id', v_s3, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T12:00:00Z', 'end', '2026-04-04T13:00:00Z', 'source', 'auto');
    v_y_i     := jsonb_build_object('id', v_y,     'home_team_id', v_t5, 'away_team_id', v_t6, 'game_slot_id', v_s4, 'field_id', v_f1, 'week_index', 1, 'start', '2026-04-04T14:00:00Z', 'end', '2026-04-04T15:00:00Z', 'source', 'auto');

    SELECT count(*) INTO v_rows FROM public.game_assignments WHERE organization_id = v_org;
    -- The mover goes to week 2, slot s5, by its id (the hidden row sits at s6, the other place the pair could be).
    v_run := public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_pub_i,
            v_mover_i || jsonb_build_object('game_slot_id', v_s5, 'week_index', 2, 'start', '2026-04-11T08:00:00Z', 'end', '2026-04-11T09:00:00Z'),
            v_x_i, v_y_i));
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_mover AND game_slot_id = v_s5 AND week_index = 2 AND run_id = v_run) THEN
        RAISE EXCEPTION 'a game moved by its id did not keep its id at its new place in the new run';
    END IF;
    IF (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org) <> v_rows THEN
        RAISE EXCEPTION 'a save that names its games by id added a row';
    END IF;
    IF (SELECT count(*) FROM public.game_assignments WHERE home_team_id = v_t3 AND away_team_id = v_t4 AND id <> v_hidden) <> 1 THEN
        RAISE EXCEPTION 'the move left a second row of the pair behind';
    END IF;
    IF (SELECT count(*) FROM public.game_assignments WHERE season_settings_id = v_season AND run_id = v_run) <> 4 THEN
        RAISE EXCEPTION 'the save did not put the run''s season on each game it wrote';
    END IF;
    IF (SELECT season_settings_id FROM public.game_assignments WHERE id = v_hidden) IS NOT NULL THEN
        RAISE EXCEPTION 'a game the save did not write has a season';
    END IF;
    -- A flip keeps the id.
    v_run := public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_pub_i,
            v_mover_i || jsonb_build_object('game_slot_id', v_s5, 'week_index', 2, 'start', '2026-04-11T08:00:00Z', 'end', '2026-04-11T09:00:00Z',
                                            'home_team_id', v_t4, 'away_team_id', v_t3),
            v_x_i, v_y_i));
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_mover AND home_team_id = v_t4 AND away_team_id = v_t3) THEN
        RAISE EXCEPTION 'a game flipped by its id did not keep its id';
    END IF;
    -- Two games of one pair swap places in one save.
    v_run := public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_pub_i,
            v_mover_i || jsonb_build_object('game_slot_id', v_s5, 'week_index', 2, 'start', '2026-04-11T08:00:00Z', 'end', '2026-04-11T09:00:00Z',
                                            'home_team_id', v_t4, 'away_team_id', v_t3),
            v_x_i || jsonb_build_object('game_slot_id', v_s4, 'start', '2026-04-04T14:00:00Z', 'end', '2026-04-04T15:00:00Z'),
            v_y_i || jsonb_build_object('game_slot_id', v_s3, 'start', '2026-04-04T12:00:00Z', 'end', '2026-04-04T13:00:00Z')));
    IF (SELECT game_slot_id FROM public.game_assignments WHERE id = v_x) IS DISTINCT FROM v_s4
       OR (SELECT game_slot_id FROM public.game_assignments WHERE id = v_y) IS DISTINCT FROM v_s3 THEN
        RAISE EXCEPTION 'two games that swap places in one save did not each keep its id at the other''s place';
    END IF;
    -- An assignment WITHOUT an id that moves is a new row, as it always was: the old row stays where it was.
    SELECT count(*) INTO v_rows FROM public.game_assignments WHERE organization_id = v_org;
    v_run := public.persist_game_schedule(
        jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(v_pub_i, v_x_i, v_y_i,
            (v_mover_i - 'id') || jsonb_build_object('game_slot_id', v_s2, 'week_index', 1, 'start', '2026-04-04T10:00:00Z', 'end', '2026-04-04T11:00:00Z')));
    IF (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org) <> v_rows + 1 THEN
        RAISE EXCEPTION 'an assignment without an id that moved was not saved as a new row';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_mover AND game_slot_id = v_s5) THEN
        RAISE EXCEPTION 'the old row of a game saved without its id did not stay where it was';
    END IF;
    v_checks := v_checks + 5;
    RAISE NOTICE 'persist_game_schedule: a game moved by its id kept its id and left no row behind, a flip kept the id, two games of one pair swapped places in one save, the season was put on every game written; an assignment without an id that moved was a new row';

    -- ---- 4. the refusals, each leaving no run behind ---------------------------------------------------
    SELECT count(*) INTO v_run0_n FROM public.scheduler_runs WHERE organization_id = v_org;
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_pub_i, v_mover_i || jsonb_build_object('id', gen_random_uuid())));
        RAISE EXCEPTION 'a save naming a game that does not exist was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '23503' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_not_found' THEN RAISE EXCEPTION 'the unknown id was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_pub_i, v_mover_i, v_mover_i));
        RAISE EXCEPTION 'a save naming one game twice was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_identity_repeated' THEN RAISE EXCEPTION 'the repeated id was refused for the wrong reason (%)', v_detail; END IF;
    END;
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_pub_i || jsonb_build_object('game_slot_id', v_s5, 'week_index', 2, 'start', '2026-04-11T08:00:00Z', 'end', '2026-04-11T09:00:00Z')));
        RAISE EXCEPTION 'a save that moves a Published game by its id was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'game_published' THEN RAISE EXCEPTION 'the move of a Published game by id was refused for the wrong reason (%)', v_detail; END IF;
    END;
    -- The mover (now at s5/week 2, sides T4>T3) is told to go where the older hidden row (T3>T4, s6/week 2) is: not a clash,
    -- the sides differ. Flip it back to T3>T4 and send it to s6: the same tuple as the hidden row.
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_pub_i, v_x_i, v_y_i,
                v_mover_i || jsonb_build_object('game_slot_id', v_s6, 'week_index', 2, 'start', '2026-04-11T10:00:00Z', 'end', '2026-04-11T11:00:00Z')));
        RAISE EXCEPTION 'a game moved onto the place of an older hidden row was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM format('game_identity_conflict ids=%s,%s', v_mover, v_hidden) THEN
            RAISE EXCEPTION 'the clash was refused with the wrong detail (%)', v_detail;
        END IF;
    END;
    -- A game stored in ANOTHER season of the organization, named by its id under this season: refused, the game named.
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES (v_season2, v_org, 'Identity Season Two', 'draft', 2027);
    UPDATE public.game_assignments SET season_settings_id = v_season2 WHERE id = v_y;
    BEGIN
        PERFORM public.persist_game_schedule(
            jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'game', 'status', 'completed'),
            jsonb_build_array(v_pub_i, v_x_i, v_y_i));
        RAISE EXCEPTION 'a save naming a game of another season was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM format('game_identity_season ids=%s', v_y) THEN
            RAISE EXCEPTION 'the game of another season was refused with the wrong detail (%)', v_detail;
        END IF;
    END;
    IF (SELECT season_settings_id FROM public.game_assignments WHERE id = v_y) IS DISTINCT FROM v_season2 THEN
        RAISE EXCEPTION 'the refused save rewrote the season of a game';
    END IF;
    IF (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = v_org) <> v_run0_n THEN
        RAISE EXCEPTION 'a refused save left a scheduler run behind';
    END IF;
    v_checks := v_checks + 5;
    RAISE NOTICE 'refusals: an unknown id (23503 game_not_found), a repeated id (22023 game_identity_repeated), a Published game moved by its id (22023 game_published), a game stored in another season (22023 game_identity_season, the game named) and a game moved onto an older hidden row (22023 game_identity_conflict, both ids) were each refused and left no run behind';

    RAISE NOTICE 'game_identity smoke: % checks', v_checks;
END
$$;

ROLLBACK;
