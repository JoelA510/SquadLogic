-- Smoke checks for 20261107010000_schedule_tbd.sql
--
-- Run on the database built to head, in DO blocks that clean up after themselves.
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the writers run as a real
-- organization admin.
--
--   1. Posture: the table as declared (RLS on, one SELECT policy for admins and no policy that writes,
--      closed to anon, no client INSERT, UPDATE or DELETE grant, the three CHECKs, the two unique
--      indexes, the tenancy trigger), `get_schedule_tbd` and `sync_schedule_tbd_practices` pinned
--      definers for authenticated and not anon, the tenancy trigger function closed to clients, and
--      both writers writing the list.
--   2. The practice list, through the real `persist_practice_schedule`: it is built from the
--      ROSTER -- a team with none of its practices is listed whatever the payload carried, a team
--      short by one is listed with missing_count 1, a division at 0 a week and a team that holds
--      its count are not, a row whose range has ended does not count as held; the reason is the
--      run's own for the team, else `not-scheduled-yet`; the next save rebuilds the list.
--   3. The game list, through the real `persist_game_schedule`: a save whose results carry
--      `unscheduled` replaces the season's list; each bad entry (a reason off the list, one team on
--      both sides, a team of another organization) is refused and changes nothing; a save with no
--      such list leaves it; an empty list clears it.
--   4. The reads: an admin reads the list (names included) through the RPC and the table; a user
--      who is a member of no organization is refused by the RPC and reads no row; nobody updates a row.
--   5. Tenancy: the trigger refuses another organization's season, division or team (23514), and the read
--      names no team of another organization even for a row that got past it.
--   6. Deleting a team: `team.deleted` counts the rows its cascade takes (`schedule_tbd_deleted`).
--
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Posture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_n integer;
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.schedule_tbd'::regclass) THEN
        RAISE EXCEPTION 'schedule_tbd has no row level security';
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'schedule_tbd' AND roles = '{authenticated}'
       AND policyname = 'Schedule TBD: admins select' AND cmd = 'SELECT';
    IF v_n <> 1 THEN RAISE EXCEPTION 'schedule_tbd does not have its admin select policy (% found)', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'schedule_tbd';
    IF v_n <> 1 THEN RAISE EXCEPTION 'schedule_tbd has % policies; only the select one may exist (no client writes)', v_n; END IF;
    IF has_table_privilege('anon', 'public.schedule_tbd', 'SELECT') THEN RAISE EXCEPTION 'anon can read schedule_tbd'; END IF;
    IF has_table_privilege('authenticated', 'public.schedule_tbd', 'INSERT')
       OR has_table_privilege('authenticated', 'public.schedule_tbd', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.schedule_tbd', 'DELETE') THEN
        RAISE EXCEPTION 'authenticated can write schedule_tbd';
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.schedule_tbd', 'SELECT') THEN
        RAISE EXCEPTION 'authenticated cannot read schedule_tbd';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.schedule_tbd'::regclass
                    AND tgname = 'schedule_tbd_enforce_tenancy' AND NOT tgisinternal AND tgenabled = 'O') THEN
        RAISE EXCEPTION 'schedule_tbd has no enabled tenancy trigger';
    END IF;
    IF has_function_privilege('authenticated', 'public.schedule_tbd_enforce_tenancy()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.schedule_tbd_enforce_tenancy()', 'EXECUTE') THEN
        RAISE EXCEPTION 'a client can execute the tenancy trigger function';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = 'public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb)'::regprocedure
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'sync_schedule_tbd_practices is not a pinned definer for authenticated and not anon'; END IF;
    SELECT count(*) INTO v_n FROM pg_constraint
     WHERE conrelid = 'public.schedule_tbd'::regclass AND contype = 'c'
       AND conname IN ('schedule_tbd_kind_check', 'schedule_tbd_shape', 'schedule_tbd_reason_check');
    IF v_n <> 3 THEN RAISE EXCEPTION 'the three CHECKs are not all there (% found)', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'schedule_tbd'
       AND indexname IN ('schedule_tbd_practice_team_key', 'schedule_tbd_game_key')
       AND indexdef LIKE 'CREATE UNIQUE INDEX%';
    IF v_n <> 2 THEN RAISE EXCEPTION 'the two unique indexes are not both there (% found)', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = 'public.get_schedule_tbd(uuid)'::regprocedure
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'get_schedule_tbd is not a pinned definer for authenticated and not anon'; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE ((p.oid = 'public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text)'::regprocedure
             AND p.prosrc LIKE '%sync_schedule_tbd_practices%')
         OR (p.oid = 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure
             AND p.prosrc LIKE '%public.schedule_tbd%'))
       AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 2 THEN RAISE EXCEPTION 'both writers must write the list, pinned, and be closed to anon (% do)', v_n; END IF;
    RAISE NOTICE 'posture: RLS on with one admin select policy and no policy or grant that writes; closed to anon; three CHECKs, two unique indexes and the tenancy trigger (its function closed to clients); get_schedule_tbd and the practice sync pinned definers (not anon); both writers write the list';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 to 4. The lists, as an organization admin.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_stranger uuid := gen_random_uuid();
    v_other_admin uuid := gen_random_uuid();
    v_org uuid; v_org2 uuid; v_season uuid; v_season2 uuid; v_div2 uuid; v_div0 uuid; v_div1 uuid; v_divx uuid;
    v_loc uuid; v_field uuid;
    v_a1 uuid; v_a2 uuid; v_b1 uuid; v_c1 uuid; v_c2 uuid; v_x1 uuid;
    v_mon uuid; v_wed uuid; v_tue uuid; v_thu uuid; v_fri uuid;
    c_r text := '[2026-09-01,2026-11-30]';
    c_old text := '[2020-01-01,2020-02-01)';
    v_res jsonb;
    v_n integer;
    v_state text; v_msg text;
    v_raised boolean;
    v_json jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'tbd-admin@example.test', '{"password_length": 16}'),
        (v_stranger, 'tbd-stranger@example.test', '{"password_length": 16}'),
        (v_other_admin, 'tbd-other@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'tbd-admin@example.test'), (v_stranger, 'tbd-stranger@example.test'),
        (v_other_admin, 'tbd-other@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke TBD Org', 'smoke-tbd-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke TBD Other', 'smoke-tbd-other') RETURNING id INTO v_org2;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin'), (v_org2, v_other_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'TBD 2026', 'active', 2026) RETURNING id INTO v_season;
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org2, 'TBD Other 2026', 'active', 2026) RETURNING id INTO v_season2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name, practices_per_week)
        VALUES (v_org, v_season, 'TBD U8', 2) RETURNING id INTO v_div2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name, practices_per_week)
        VALUES (v_org, v_season, 'TBD U6', 0) RETURNING id INTO v_div0;
    INSERT INTO public.divisions (organization_id, season_settings_id, name, practices_per_week)
        VALUES (v_org, v_season, 'TBD U10', 1) RETURNING id INTO v_div1;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org2, v_season2, 'TBD Other U8') RETURNING id INTO v_divx;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'TBD Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_org, v_loc, 'TBD Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div2, 'TBD A1') RETURNING id INTO v_a1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div2, 'TBD A2') RETURNING id INTO v_a2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div0, 'TBD B1') RETURNING id INTO v_b1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div1, 'TBD C1') RETURNING id INTO v_c1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div1, 'TBD C2') RETURNING id INTO v_c2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org2, v_divx, 'TBD X1') RETURNING id INTO v_x1;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_mon;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_wed;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'tue', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_tue;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'thu', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_thu;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'fri', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_fri;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    -- ---- 2. the practice list, built from the roster -------------------------------------
    -- Save 1: A1 holds both of its two (Monday, Wednesday), C1 its one (Friday), A2 only a series that
    -- ended in 2020 (a manual row), C2 nothing at all, B1 (a division at 0 a week) nothing. The run
    -- says A2 found no slot of the right length, and says nothing at all about C2.
    PERFORM public.persist_practice_schedule(
        jsonb_build_object('season_settings_id', v_season, 'results', jsonb_build_object('unassigned',
            jsonb_build_array(jsonb_build_object('teamId', v_a2, 'reason', 'practice-length', 'target', 2)))),
        jsonb_build_array(
            jsonb_build_object('team_id', v_a1, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_a1, 'practice_slot_id', v_wed, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_c1, 'practice_slot_id', v_fri, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_a2, 'practice_slot_id', v_tue, 'effective_date_range', c_old, 'source', 'manual')));
    SELECT count(*) INTO v_n FROM public.schedule_tbd WHERE season_settings_id = v_season AND kind = 'practice';
    IF v_n <> 2 THEN RAISE EXCEPTION 'save 1 listed % practice row(s), expected 2 (A2 and C2)', v_n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE team_id = v_a2 AND missing_count = 2 AND reason = 'practice-length'
                    AND (detail->>'target')::int = 2 AND (detail->>'held')::int = 0 AND division_id = v_div2) THEN
        RAISE EXCEPTION 'A2 (an ended series only) is not listed as missing 2 for practice-length: %',
            (SELECT jsonb_agg(to_jsonb(s)) FROM public.schedule_tbd s WHERE s.team_id = v_a2);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE team_id = v_c2 AND missing_count = 1 AND reason = 'not-scheduled-yet') THEN
        RAISE EXCEPTION 'C2 (a team the payload never named) is not listed as missing 1, not-scheduled-yet';
    END IF;
    IF EXISTS (SELECT 1 FROM public.schedule_tbd WHERE team_id IN (v_a1, v_b1, v_c1)) THEN
        RAISE EXCEPTION 'a team that holds its count, or a division at 0 a week, is listed';
    END IF;
    RAISE NOTICE 'practice list: built from the roster -- A2 (only an ended series) missing 2 with the run''s reason, C2 (never in the payload) missing 1 not-scheduled-yet; A1 and C1 hold their count and B1 (0 a week) is not listed';

    -- Save 2: A2 gets one live practice (Tuesday). A reason the list does not know is not stored.
    PERFORM public.persist_practice_schedule(
        jsonb_build_object('season_settings_id', v_season, 'results', jsonb_build_object('unassigned',
            jsonb_build_array(jsonb_build_object('teamId', v_a2, 'reason', 'made-up-reason')))),
        jsonb_build_array(
            jsonb_build_object('team_id', v_a1, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_a1, 'practice_slot_id', v_wed, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_c1, 'practice_slot_id', v_fri, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_a2, 'practice_slot_id', v_tue, 'effective_date_range', c_old, 'source', 'manual'),
            jsonb_build_object('team_id', v_a2, 'practice_slot_id', v_thu, 'effective_date_range', c_r)));
    IF NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE team_id = v_a2 AND missing_count = 1 AND reason = 'not-scheduled-yet'
                    AND (detail->>'held')::int = 1) THEN
        RAISE EXCEPTION 'A2 is not rebuilt as missing 1 (one live practice of two) with an unknown reason read as not-scheduled-yet';
    END IF;
    SELECT count(*) INTO v_n FROM public.schedule_tbd WHERE season_settings_id = v_season AND kind = 'practice';
    IF v_n <> 2 THEN RAISE EXCEPTION 'save 2 left % practice row(s), expected 2 (A2 and C2); a list is rebuilt, never added to', v_n; END IF;
    RAISE NOTICE 'practice list: the next save rebuilds it -- A2 now missing 1 (one live practice of two), an unknown reason read as not-scheduled-yet, still two rows';

    -- ---- 3. the game list --------------------------------------------------------------------
    PERFORM public.persist_game_schedule(
        jsonb_build_object('season_settings_id', v_season, 'results', jsonb_build_object('unscheduled', jsonb_build_array(
            jsonb_build_object('weekIndex', 3, 'division', 'TBD U8', 'reason', 'no-slot-available',
                               'matchup', jsonb_build_object('homeTeamId', v_a1, 'awayTeamId', v_a2)),
            jsonb_build_object('weekIndex', 4, 'division', 'TBD U10', 'reason', 'coach-coaches-both-teams',
                               'matchup', jsonb_build_object('homeTeamId', v_c2, 'awayTeamId', v_c1))))),
        '[]'::jsonb);
    SELECT count(*) INTO v_n FROM public.schedule_tbd WHERE season_settings_id = v_season AND kind = 'game';
    IF v_n <> 2 THEN RAISE EXCEPTION 'the game save listed % unscheduled game(s), expected 2', v_n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE kind = 'game' AND home_team_id = v_c2 AND away_team_id = v_c1
                    AND week_index = 4 AND reason = 'coach-coaches-both-teams' AND division_id = v_div1
                    AND detail->>'division' = 'TBD U10') THEN
        RAISE EXCEPTION 'the unscheduled game C2 v C1 week 4 is not recorded as sent (sides, week, reason, division)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = v_org AND action = 'game.saved'
                    AND (metadata->>'unscheduled_count')::int = 2) THEN
        RAISE EXCEPTION 'the game.saved audit row does not carry unscheduled_count 2';
    END IF;
    IF (SELECT count(*) FROM public.schedule_tbd WHERE kind = 'practice' AND season_settings_id = v_season) <> 2 THEN
        RAISE EXCEPTION 'a game save changed the practice list';
    END IF;
    RAISE NOTICE 'game list: two unscheduled games recorded as sent (home, away, week, reason, division), audited with their count; the practice list untouched';

    -- Each bad entry is refused and changes nothing.
    FOR v_state, v_msg IN VALUES
        ('22023', 'a reason off the list'),
        ('22023', 'one team on both sides'),
        ('22023', 'a week of 0'),
        ('23503', 'a team that does not exist'),
        ('42501', 'a team of another organization'),
        ('23502', 'no away team') LOOP
        v_raised := false;
        v_json := CASE v_msg
            WHEN 'a reason off the list' THEN jsonb_build_object('weekIndex', 5, 'reason', 'because', 'matchup', jsonb_build_object('homeTeamId', v_a1, 'awayTeamId', v_a2))
            WHEN 'one team on both sides' THEN jsonb_build_object('weekIndex', 5, 'reason', 'no-slot-available', 'matchup', jsonb_build_object('homeTeamId', v_a1, 'awayTeamId', v_a1))
            WHEN 'a week of 0' THEN jsonb_build_object('weekIndex', 0, 'reason', 'no-slot-available', 'matchup', jsonb_build_object('homeTeamId', v_a1, 'awayTeamId', v_a2))
            WHEN 'a team that does not exist' THEN jsonb_build_object('weekIndex', 5, 'reason', 'no-slot-available', 'matchup', jsonb_build_object('homeTeamId', gen_random_uuid(), 'awayTeamId', v_a2))
            WHEN 'a team of another organization' THEN jsonb_build_object('weekIndex', 5, 'reason', 'no-slot-available', 'matchup', jsonb_build_object('homeTeamId', v_x1, 'awayTeamId', v_a2))
            ELSE jsonb_build_object('weekIndex', 5, 'reason', 'no-slot-available', 'matchup', jsonb_build_object('homeTeamId', v_a1))
        END;
        BEGIN
            PERFORM public.persist_game_schedule(
                jsonb_build_object('season_settings_id', v_season, 'results', jsonb_build_object('unscheduled',
                    jsonb_build_array(jsonb_build_object('weekIndex', 7, 'reason', 'no-slot-available',
                                                         'matchup', jsonb_build_object('homeTeamId', v_a2, 'awayTeamId', v_a1)), v_json))),
                '[]'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            v_raised := true;
            IF SQLSTATE <> v_state THEN RAISE EXCEPTION '% was refused % (%), expected %', v_msg, SQLSTATE, SQLERRM, v_state; END IF;
        END;
        IF NOT v_raised THEN RAISE EXCEPTION '% was accepted', v_msg; END IF;
    END LOOP;
    SELECT count(*) INTO v_n FROM public.schedule_tbd WHERE season_settings_id = v_season AND kind = 'game';
    IF v_n <> 2 OR EXISTS (SELECT 1 FROM public.schedule_tbd WHERE kind = 'game' AND week_index = 7) THEN
        RAISE EXCEPTION 'a refused game save changed the list (% row(s), expected the 2 from before)', v_n;
    END IF;
    RAISE NOTICE 'game list: a reason off the list, one team on both sides, week 0, a missing team, another organization''s team and a missing side each refused with their code, and the valid entry sent beside them was not written';

    -- A save with no list (a manual move, a rollback) leaves it; an empty list clears it.
    PERFORM public.persist_game_schedule(jsonb_build_object('season_settings_id', v_season, 'results', jsonb_build_object('summary', '{}'::jsonb)), '[]'::jsonb);
    SELECT count(*) INTO v_n FROM public.schedule_tbd WHERE season_settings_id = v_season AND kind = 'game';
    IF v_n <> 2 THEN RAISE EXCEPTION 'a save that carries no unscheduled list changed the list (% row(s))', v_n; END IF;

    -- ---- 4. the reads --------------------------------------------------------------------------
    v_json := public.get_schedule_tbd(v_season);
    IF jsonb_array_length(v_json) <> 4 THEN RAISE EXCEPTION 'the admin read returned % row(s), expected 4', jsonb_array_length(v_json); END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e->>'kind' = 'game' AND e->>'home_team_name' = 'TBD C2'
                    AND e->>'away_team_name' = 'TBD C1' AND e->>'division_name' = 'TBD U10')
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e->>'kind' = 'practice' AND e->>'team_name' = 'TBD A2'
                    AND (e->>'missing_count')::int = 1) THEN
        RAISE EXCEPTION 'the admin read does not carry the names: %', v_json;
    END IF;
    SELECT count(*) INTO v_n FROM public.schedule_tbd;
    IF v_n <> 4 THEN RAISE EXCEPTION 'the admin reads % row(s) of the table, expected 4', v_n; END IF;
    -- Nobody writes the table directly: not an update, not a delete, and not an insert, whatever
    -- organization it names (the first draft let an admin insert a row of their own organization naming
    -- another organization's team).
    FOR v_state IN VALUES ('update'), ('delete'), ('insert') LOOP
        v_raised := false;
        BEGIN
            IF v_state = 'update' THEN
                UPDATE public.schedule_tbd SET reason = 'no-slot-available' WHERE kind = 'practice';
            ELSIF v_state = 'delete' THEN
                DELETE FROM public.schedule_tbd WHERE kind = 'practice';
            ELSE
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
                VALUES (v_org, v_season, 'practice', v_div1, v_x1, 1, 'no-slot-available');
            END IF;
        EXCEPTION WHEN insufficient_privilege THEN
            v_raised := true;
        END;
        IF NOT v_raised THEN RAISE EXCEPTION 'an admin could % the table directly', v_state; END IF;
    END LOOP;
    RAISE NOTICE 'direct writes: an admin''s update, delete and insert (of another organization''s team) are each refused 42501';

    -- A user who is a member of no organization, and another organization's admin.
    FOR v_state IN VALUES ('stranger'), ('other admin') LOOP
        PERFORM set_config('request.jwt.claim.sub', (CASE v_state WHEN 'stranger' THEN v_stranger ELSE v_other_admin END)::text, true);
        v_raised := false;
        BEGIN
            PERFORM public.get_schedule_tbd(v_season);
        EXCEPTION WHEN insufficient_privilege THEN
            v_raised := true;
        END;
        IF NOT v_raised THEN RAISE EXCEPTION 'the % read the list through the RPC', v_state; END IF;
        SELECT count(*) INTO v_n FROM public.schedule_tbd;
        IF v_n <> 0 THEN RAISE EXCEPTION 'the % reads % row(s) of the table', v_state, v_n; END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    RAISE NOTICE 'reads: an admin reads 4 rows with the names through the RPC and the table and cannot update one; a member of no organization and another organization''s admin are refused by the RPC and read no row';

    -- Deleting a team counts the TIME TBD rows its cascade takes (A2: its practice row and one game).
    PERFORM public.admin_delete_team(v_a2);
    IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = v_org AND action = 'team.deleted'
                    AND resource_id = v_a2 AND (metadata->>'schedule_tbd_deleted')::int = 2) THEN
        RAISE EXCEPTION 'team.deleted does not carry schedule_tbd_deleted = 2 for A2: %',
            (SELECT metadata FROM public.audit_log WHERE organization_id = v_org AND action = 'team.deleted' AND resource_id = v_a2);
    END IF;
    IF EXISTS (SELECT 1 FROM public.schedule_tbd WHERE team_id = v_a2 OR home_team_id = v_a2 OR away_team_id = v_a2) THEN
        RAISE EXCEPTION 'a deleted team still has TIME TBD rows';
    END IF;
    RAISE NOTICE 'team deletion: team.deleted carries schedule_tbd_deleted = 2 (the practice row and the game) and no row names the team afterwards';

    -- An empty list clears the games (as the owner).
    PERFORM public.persist_game_schedule(jsonb_build_object('season_settings_id', v_season, 'results', jsonb_build_object('unscheduled', '[]'::jsonb)), '[]'::jsonb);
    SELECT count(*) INTO v_n FROM public.schedule_tbd WHERE season_settings_id = v_season AND kind = 'game';
    IF v_n <> 0 THEN RAISE EXCEPTION 'an empty unscheduled list left % game row(s)', v_n; END IF;
    RAISE NOTICE 'game list: a save with no list left it as it was; an empty list cleared it';

    -- ---- the tenancy trigger, as the table owner (which is what the definer writers are) -----------
    RESET ROLE;
    FOR v_state, v_msg IN VALUES
        ('season', 'a season of another organization'),
        ('division', 'a division of another organization'),
        ('team', 'another organization''s team'),
        ('other-division', 'a team of another division'),
        ('home', 'another organization''s home team'),
        ('away', 'another organization''s away team') LOOP
        v_raised := false;
        BEGIN
            IF v_state = 'season' THEN
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
                VALUES (v_org, v_season2, 'practice', v_div1, v_c1, 1, 'no-slot-available');
            ELSIF v_state = 'division' THEN
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
                VALUES (v_org, v_season, 'practice', v_divx, v_c1, 1, 'no-slot-available');
            ELSIF v_state = 'team' THEN
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
                VALUES (v_org, v_season, 'practice', v_div1, v_x1, 1, 'no-slot-available');
            ELSIF v_state = 'other-division' THEN
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
                VALUES (v_org, v_season, 'practice', v_div1, v_a1, 1, 'no-slot-available');
            ELSIF v_state = 'home' THEN
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason)
                VALUES (v_org, v_season, 'game', v_div1, v_x1, v_c1, 9, 'no-slot-available');
            ELSE
                INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason)
                VALUES (v_org, v_season, 'game', v_div1, v_c1, v_x1, 9, 'no-slot-available');
            END IF;
        EXCEPTION WHEN check_violation THEN
            v_raised := true;
        END;
        IF NOT v_raised THEN RAISE EXCEPTION 'the tenancy trigger let in %', v_msg; END IF;
    END LOOP;
    -- The control: the same shapes, honest, go in.
    INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
    VALUES (v_org, v_season, 'practice', v_div1, v_c1, 1, 'no-slot-available');
    INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason)
    VALUES (v_org, v_season, 'game', v_div1, v_c1, v_a1, 9, 'division-mismatch');
    RAISE NOTICE 'tenancy trigger: another organization''s season, division, team, home team and away team, and a team of another division, are each refused 23514; honest rows go in';

    -- And the read does not lean on the trigger: a row that got past it (the trigger off, as the
    -- owner) still shows no other organization's name.
    ALTER TABLE public.schedule_tbd DISABLE TRIGGER schedule_tbd_enforce_tenancy;
    INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
    VALUES (v_org, v_season, 'practice', v_div1, v_x1, 1, 'no-slot-available');
    ALTER TABLE public.schedule_tbd ENABLE TRIGGER schedule_tbd_enforce_tenancy;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_json := public.get_schedule_tbd(v_season);
    RESET ROLE;
    IF v_json::text LIKE '%TBD X1%' THEN RAISE EXCEPTION 'get_schedule_tbd returned another organization''s team name: %', v_json; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e->>'team_id' = v_x1::text AND e->>'team_name' IS NULL) THEN
        RAISE EXCEPTION 'the poisoned row did not come back with a NULL team name (the join is not on the organization): %', v_json;
    END IF;
    RAISE NOTICE 'read: a row naming another organization''s team (the trigger off) comes back with no name';

    -- ---- clean up ----------------------------------------------------------------
    RESET ROLE;
    DELETE FROM public.organizations WHERE id IN (v_org, v_org2);
    DELETE FROM public.profiles WHERE id IN (v_admin, v_stranger, v_other_admin);
    DELETE FROM auth.users WHERE id IN (v_admin, v_stranger, v_other_admin);
END;
$$;

ROLLBACK;
