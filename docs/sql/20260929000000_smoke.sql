-- Smoke checks for 20260929000000_practice_writer_v3_lock_by_default.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` requires each witness NOTICE to print.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so every save runs the REAL RPC as a real org
-- admin (or coach, or service role) with RLS on: the writer is SECURITY
-- INVOKER.
--
-- The plan §6 witnesses for PR 6, one section each:
--   1. catalogue: one 8-argument overload returning jsonb, no anon EXECUTE
--   2. the lock: omitting, moving, re-ranging, or double-booking against an
--      existing row is refused 22023 naming the row, and nothing changes
--  2b. a double-booking is a time clash: another weekday, or the same weekday
--      at non-overlapping minutes, is an addition and is accepted
--   3. a stale base_fingerprint is refused 40001
--   4. a retirement split (`closes`) keeps the row's id
--   5. unlock is per row
--   6. unlock is admin-only (its own gate) and audited with the before-image
--   7. an exception is its own row and survives a later ordinary save;
--      teams_time_tbd is enumerated from the roster
--   8. deleting an overridden series is loud (23503); cancelling it withdraws
--      the exception in the same transaction, audited
--   9. controls: a non-admin save is 42501; `closes` naming another season's
--      row is 42501
--
-- Per-team checks enumerate teams from the SEEDED ROSTER, never from the
-- assignment rows.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_n int;
    v_ret text;
    v_sig text := 'public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text)';
BEGIN
    SELECT count(*), max(pg_get_function_result(p.oid))
      INTO v_n, v_ret
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'persist_practice_schedule';
    IF v_n <> 1 OR v_ret <> 'jsonb' THEN
        RAISE EXCEPTION 'expected exactly one persist_practice_schedule overload returning jsonb, found % (returns %)', v_n, v_ret;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'anon can EXECUTE persist_practice_schedule (LESSONS_LEARNED #5)';
    END IF;
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated or service_role lost EXECUTE on persist_practice_schedule';
    END IF;
    IF has_table_privilege('anon', 'public.practice_exceptions', 'SELECT') THEN
        RAISE EXCEPTION 'anon can read practice_exceptions';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.practice_exceptions'::regclass) THEN
        RAISE EXCEPTION 'practice_exceptions has RLS disabled';
    END IF;
    RAISE NOTICE 'catalogue: 1 persist_practice_schedule overload (8 arguments), returns jsonb, anon cannot EXECUTE; practice_exceptions has RLS on and no anon read';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2b. The double-booking rule is a TIME clash, not a range overlap
-- ---------------------------------------------------------------------------
-- 176 of the 281 (sheet, team) pairs in fixtures/season-2026 practise on two
-- weekdays over one range, so a team holding its Monday slot must be able to
-- gain its Wednesday slot in a later save. It runs FIRST so no earlier
-- section can stop the run before all three cases are judged.
DO $$
DECLARE
    v_admin uuid := '66670000-0000-4000-8000-0000000000a1';
    v_org uuid; v_loc uuid; v_field uuid; v_s uuid; v_d uuid; v_t uuid;
    v_m1 uuid; v_w uuid; v_m2 uuid; v_m3 uuid; v_m4 uuid; v_row_m1 uuid; v_t2 uuid;
    c_r text := '[2026-09-01,2026-11-30]';
    v_state text; v_msg text; v_n int;
    -- Each case is judged on its own and every failure is reported together,
    -- so one run against a wrong rule shows all three cases' verdicts.
    v_fail text := '';
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (v_admin, 'p67-admin@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'p67-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 67', 'smoke-org-67') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'P67 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'P67 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P67 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'P67 U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'P67 Team') RETURNING id INTO v_t;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'P67 Team Two') RETURNING id INTO v_t2;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_m1;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_w;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '17:30', '18:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_m2;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '18:30', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_m3;
    -- Monday 18:00-19:00: TOUCHES Monday 17:00-18:00 at 18:00 and shares no minute with it.
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '18:00', '19:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_m4;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
        jsonb_build_array(jsonb_build_object('team_id', v_t, 'practice_slot_id', v_m1, 'effective_date_range', c_r)));
    SELECT id INTO v_row_m1 FROM public.practice_assignments WHERE team_id = v_t;

    -- (a) a later save adds the Wednesday slot over the same range: accepted.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_m1, 'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_w,  'effective_date_range', c_r)));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE team_id = v_t;
    IF v_state IS NOT NULL OR v_n <> 2 THEN
        v_fail := v_fail || format(E'\n  ' || replace('(a) adding a Wednesday slot to a Monday team over the same range should be accepted (2 rows): % % (% rows)', '%', '%s'), v_state, v_msg, v_n);
    ELSE
        RAISE NOTICE 'time clash (a): a team holding Monday 17:00-18:00 gained Wednesday 17:00-18:00 over the same range in a later save -- accepted, 2 rows';
    END IF;

    -- (b) a second Monday slot at overlapping minutes: refused, naming the Monday row.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_m1, 'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_w,  'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_m2, 'effective_date_range', c_r)));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE team_id = v_t;
    IF v_state IS DISTINCT FROM '22023'
       OR v_msg NOT LIKE 'assignment ' || v_row_m1 || ' is locked: a new row for its team overlaps it in time%'
       OR v_n <> 2 THEN
        v_fail := v_fail || format(E'\n  ' || replace('(b) a second Monday slot at overlapping minutes should be refused 22023 naming the Monday row: % % (% rows)', '%', '%s'), v_state, v_msg, v_n);
    ELSE
        RAISE NOTICE 'time clash (b): a second Monday slot at 17:30-18:30 against Monday 17:00-18:00 was refused 22023 naming the Monday row; 2 rows unchanged';
    END IF;

    -- (c) a Monday slot at non-overlapping minutes: accepted.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_m1, 'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_w,  'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t, 'practice_slot_id', v_m3, 'effective_date_range', c_r)));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE team_id = v_t;
    IF v_state IS NOT NULL OR v_n <> 3 THEN
        v_fail := v_fail || format(E'\n  ' || replace('(c) a Monday slot at 18:30-19:30 beside Monday 17:00-18:00 should be accepted (3 rows): % % (% rows)', '%', '%s'), v_state, v_msg, v_n);
    ELSE
        RAISE NOTICE 'time clash (c): a Monday slot at 18:30-19:30 beside Monday 17:00-18:00 was accepted -- 3 rows';
    END IF;

    -- (d) back to back: a second team holds Monday 17:00-18:00 and adds
    -- Monday 18:00-19:00 over the same range. The slots touch at 18:00 and
    -- share no minute, so it is accepted (the minute test is strict).
    PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
        jsonb_build_array(
            jsonb_build_object('team_id', v_t,  'practice_slot_id', v_m1, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t,  'practice_slot_id', v_w,  'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t,  'practice_slot_id', v_m3, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t2, 'practice_slot_id', v_m1, 'effective_date_range', c_r)));
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_t,  'practice_slot_id', v_m1, 'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t,  'practice_slot_id', v_w,  'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t,  'practice_slot_id', v_m3, 'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t2, 'practice_slot_id', v_m1, 'effective_date_range', c_r),
                jsonb_build_object('team_id', v_t2, 'practice_slot_id', v_m4, 'effective_date_range', c_r)));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE team_id = v_t2;
    IF v_state IS NOT NULL OR v_n <> 2 THEN
        v_fail := v_fail || format(E'\n  (d) Monday 18:00-19:00 right after Monday 17:00-18:00 should be accepted (2 rows): %s %s (%s rows)', v_state, v_msg, v_n);
    ELSE
        RAISE NOTICE 'time clash (d): back-to-back Monday 18:00-19:00 after Monday 17:00-18:00 was accepted -- 2 rows';
    END IF;

    IF v_fail <> '' THEN
        RAISE EXCEPTION 'double-booking rule:%', v_fail;
    END IF;

    RESET ROLE;
    DELETE FROM public.organizations WHERE id = v_org;
    DELETE FROM public.profiles WHERE id = v_admin;
    DELETE FROM auth.users WHERE id = v_admin;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2-9. One season, driven through the real RPC
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin  uuid := '66660000-0000-4000-8000-0000000000a1';
    v_coach  uuid := '66660000-0000-4000-8000-0000000000a2';
    v_org uuid; v_loc uuid; v_field uuid;
    v_s1 uuid; v_s2 uuid; v_d1 uuid; v_d2 uuid;
    v_sa uuid; v_sb uuid; v_sc uuid; v_sd uuid;
    v_t uuid[] := ARRAY[]::uuid[];
    v_t9 uuid; v_id uuid;
    v_row uuid[] := ARRAY[]::uuid[];  -- run-1 row per team 1..4
    v_r1b uuid; v_r9 uuid; v_exc2 uuid; v_exc3 uuid;
    c_r  text := '[2026-09-01,2026-11-30]';
    c_r2 text := '[2026-10-01,2026-11-30]';
    v_run1 uuid := '66660000-0000-4000-8000-00000000f001';
    v_base jsonb;          -- the current full payload
    v_res jsonb;
    v_fp text;
    v_state text; v_msg text;
    v_n int; v_m int; v_before int;
    v_all_unlocked jsonb := '[]'::jsonb;
    v_expected jsonb;
    v_examined int;
    i int;
BEGIN
    -- ---- seed, as the table owner -------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (v_admin, 'p66-admin@example.test', jsonb_build_object('password_length', 16)),
      (v_coach, 'p66-coach@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES
      (v_admin, 'p66-admin@example.test'), (v_coach, 'p66-coach@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 66', 'smoke-org-66')
      RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
      (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'P66 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'P66 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P66 Fall') RETURNING id INTO v_s1;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P66 Spring') RETURNING id INTO v_s2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s1, 'P66 U10') RETURNING id INTO v_d1;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s2, 'P66 U12') RETURNING id INTO v_d2;
    FOR i IN 1..5 LOOP
        INSERT INTO public.teams (organization_id, division_id, name)
          VALUES (v_org, v_d1, 'P66 Team ' || i) RETURNING id INTO v_id;
        v_t := v_t || v_id;
    END LOOP;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d2, 'P66 Team 9 (other season)') RETURNING id INTO v_t9;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_sa;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'wed', '17:00', '18:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_sb;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'fri', '17:00', '18:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_sc;
    -- Wednesday 18:00-19:00: clashes in time with slot B (Wednesday 17:00-18:30).
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'wed', '18:00', '19:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_sd;
    INSERT INTO public.practice_assignments (organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t9, v_sa, v_sa, c_r::daterange, 'auto') RETURNING id INTO v_r9;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    -- ---- run 1: Teams 1-3 on A, Team 4 on B; Team 5 never scheduled ---------
    v_base := jsonb_build_array(
        jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sa, 'effective_date_range', c_r),
        jsonb_build_object('team_id', v_t[2], 'practice_slot_id', v_sa, 'effective_date_range', c_r),
        jsonb_build_object('team_id', v_t[3], 'practice_slot_id', v_sa, 'effective_date_range', c_r),
        jsonb_build_object('team_id', v_t[4], 'practice_slot_id', v_sb, 'effective_date_range', c_r));
    v_res := public.persist_practice_schedule(jsonb_build_object('id', v_run1, 'season_settings_id', v_s1), v_base);
    FOR i IN 1..4 LOOP
        SELECT id INTO v_id FROM public.practice_assignments WHERE team_id = v_t[i];
        v_row := v_row || v_id;
    END LOOP;
    IF cardinality(v_row) <> 4 OR array_position(v_row, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'run 1 should leave one row for each of Teams 1-4: %', v_row;
    END IF;
    IF (v_res->>'superseded_count')::int <> 0 OR (SELECT assigned_via FROM public.practice_assignments WHERE id = v_row[1]) <> 'auto' THEN
        RAISE EXCEPTION 'run 1 superseded something or did not record assigned_via=auto: %', v_res;
    END IF;
    v_fp := v_res->>'fingerprint';

    -- ---- 2. THE LOCK ---------------------------------------------------------
    -- Four ordinary saves, each changing one existing row with no unlock.
    v_examined := 0;
    FOR i IN 1..4 LOOP
        v_state := NULL;
        BEGIN
            PERFORM public.persist_practice_schedule(
                jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1),
                CASE i
                  -- Team 1 absent: its auto row would be pruned
                  WHEN 1 THEN v_base - 0
                  -- Team 2 moved A -> C
                  WHEN 2 THEN jsonb_set(v_base, '{1,practice_slot_id}', to_jsonb(v_sc))
                  -- Team 3 re-ranged
                  WHEN 3 THEN jsonb_set(v_base, '{2,effective_date_range}', to_jsonb(c_r2))
                  -- Team 4 keeps B (Wed 17:00-18:30) and gains D (Wed 18:00-19:00)
                  ELSE v_base || jsonb_build_array(jsonb_build_object(
                         'team_id', v_t[4], 'practice_slot_id', v_sd, 'effective_date_range', c_r2))
                END);
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        END;
        IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE 'assignment ' || v_row[i] || ' is locked%' THEN
            RAISE EXCEPTION 'lock case % (Team %) was not refused as locked naming row %: % %', i, i, v_row[i], v_state, v_msg;
        END IF;
        v_examined := v_examined + 1;
    END LOOP;
    SELECT count(*) INTO v_n FROM public.practice_assignments
     WHERE id = ANY (v_row) AND effective_date_range = c_r::daterange;
    IF v_examined <> 4 OR v_n <> 4 THEN
        RAISE EXCEPTION 'after the lock cases % of 4 were examined and % of 4 run-1 rows are unchanged', v_examined, v_n;
    END IF;
    RAISE NOTICE 'lock: omitting, moving, re-ranging and overlapping an existing row were each refused 22023 naming that row, 4 of 4; all 4 run-1 rows unchanged';

    -- ---- 3. a stale base_fingerprint ----------------------------------------
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1),
            v_base || jsonb_build_array(jsonb_build_object(
                'team_id', v_t[5], 'practice_slot_id', v_sc, 'effective_date_range', c_r)),
            base_fingerprint => md5('stale'));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '40001'
       OR EXISTS (SELECT 1 FROM public.practice_assignments WHERE team_id = v_t[5]) THEN
        RAISE EXCEPTION 'a stale base_fingerprint was not refused 40001 with nothing written: % %', v_state, v_msg;
    END IF;
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base, base_fingerprint => v_fp);
    IF v_res->>'fingerprint' IS DISTINCT FROM v_fp THEN
        RAISE EXCEPTION 'an identical save under the current fingerprint changed it: % -> %', v_fp, v_res->>'fingerprint';
    END IF;
    RAISE NOTICE 'fingerprint: a save carrying a stale base_fingerprint was refused 40001 and wrote nothing; the current fingerprint was accepted';

    -- ---- 4. a retirement split keeps the id ---------------------------------
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1),
        -- Team 1's old key is NOT re-sent: `closes` keeps that row by id.
        (v_base - 0) || jsonb_build_array(jsonb_build_object(
            'team_id', v_t[1], 'practice_slot_id', v_sc, 'effective_date_range', '[2026-10-15,2026-11-30]',
            'assigned_via', 'repair')),
        base_fingerprint => v_fp,
        unlock => jsonb_build_array(jsonb_build_object('assignment_id', v_row[1], 'reason', 'field retired 2026-10-15')),
        closes => jsonb_build_array(jsonb_build_object('assignment_id', v_row[1], 'last_day', '2026-10-14')));
    v_all_unlocked := v_all_unlocked || (v_res->'unlocked');
    SELECT id INTO v_r1b FROM public.practice_assignments WHERE team_id = v_t[1] AND practice_slot_id = v_sc;
    IF (SELECT effective_date_range FROM public.practice_assignments WHERE id = v_row[1]) IS DISTINCT FROM '[2026-09-01,2026-10-15)'::daterange
       OR v_r1b IS NULL
       OR (SELECT assigned_via FROM public.practice_assignments WHERE id = v_r1b) <> 'repair'
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_t[1]) <> 2
       OR (v_res->>'superseded_count')::int <> 0
       OR jsonb_array_length(v_res->'closed') <> 1 THEN
        RAISE EXCEPTION 'the split should keep row % (now ending 2026-10-14) and add one repair row from 2026-10-15: %', v_row[1], v_res;
    END IF;
    RAISE NOTICE 'split: closes shortened Team 1''s row in place (same id, now [2026-09-01,2026-10-15)) and the new row starts 2026-10-15 as repair; nothing superseded';
    -- The current payload now carries Team 1's two rows.
    v_base := jsonb_build_array(
        jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sa, 'effective_date_range', '[2026-09-01,2026-10-15)'),
        jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sc, 'effective_date_range', '[2026-10-15,2026-11-30]'),
        v_base->1, v_base->2, v_base->3);

    -- ---- 5. unlock is per row -------------------------------------------------
    -- Team 1 left out entirely, with only its closed row unlocked: the other
    -- row is still locked, so the save refuses naming it and removes neither.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1),
            v_base - 0 - 0,
            unlock => jsonb_build_array(jsonb_build_object('assignment_id', v_row[1], 'reason', 'drop the old half')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE 'assignment ' || v_r1b || ' is locked%'
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_t[1]) <> 2 THEN
        RAISE EXCEPTION 'unlocking one of Team 1''s rows should leave the other (%) locked and both rows in place: % %', v_r1b, v_state, v_msg;
    END IF;
    RAISE NOTICE 'unlock is per row: unlocking one of Team 1''s two rows left the other locked (refused 22023 naming it) and both rows in place';

    -- ---- 6. unlock is admin-only, by its own gate ---------------------------
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
            unlock => jsonb_build_array(jsonb_build_object('assignment_id', v_row[2], 'reason', 'coach')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'unlock requires an org admin%' THEN
        RAISE EXCEPTION 'a coach''s unlock was not refused 42501 by the unlock gate: % %', v_state, v_msg;
    END IF;
    -- 9a. and an ordinary save by the coach is refused by the general check.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION 'a non-admin ordinary save was not refused 42501: % %', v_state, v_msg;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
            unlock => jsonb_build_array(jsonb_build_object('assignment_id', v_row[2], 'reason', 'service')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '42501' OR v_msg NOT LIKE 'unlock requires an org admin%' THEN
        RAISE EXCEPTION 'a service-role unlock (no uid to audit) was not refused 42501: % %', v_state, v_msg;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    RAISE NOTICE 'unlock gate: a coach and a service-role caller (no uid) were each refused 42501 by the unlock gate itself; a coach''s ordinary save was refused 42501';

    -- ---- 9b. closes naming another season's row -----------------------------
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
            closes => jsonb_build_array(jsonb_build_object('assignment_id', v_r9, 'last_day', '2026-10-01')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '42501'
       OR (SELECT effective_date_range FROM public.practice_assignments WHERE id = v_r9) IS DISTINCT FROM c_r::daterange THEN
        RAISE EXCEPTION 'closes naming season 2''s row was not refused 42501 with the row unchanged: % %', v_state, v_msg;
    END IF;
    RAISE NOTICE 'scope: closes naming another season''s row was refused 42501 and that row is unchanged';

    -- ---- 7. exceptions are their own rows and survive a later save ---------
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
        exceptions => jsonb_build_array(
            jsonb_build_object('assignment_id', v_row[2], 'window', '[2026-10-05,2026-10-11]',
                               'kind', 'relocated', 'practice_slot_id', v_sc, 'cause_kind', 'blackout'),
            jsonb_build_object('assignment_id', v_row[3], 'window', '[2026-10-05,2026-10-11]',
                               'kind', 'time_tbd', 'tbd_reason', 'contended', 'cause_kind', 'blackout')));
    SELECT id INTO v_exc2 FROM public.practice_exceptions WHERE assignment_id = v_row[2];
    SELECT id INTO v_exc3 FROM public.practice_exceptions WHERE assignment_id = v_row[3];
    -- A later ordinary save that says nothing about exceptions.
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base);
    v_examined := 0;
    FOR i IN 1..5 LOOP  -- the roster
        SELECT count(*) INTO v_n FROM public.practice_assignments WHERE team_id = v_t[i];
        SELECT count(*) INTO v_m FROM public.practice_exceptions WHERE team_id = v_t[i] AND withdrawn_at IS NULL;
        IF v_n <> (ARRAY[2, 1, 1, 1, 0])[i] OR v_m <> (ARRAY[0, 1, 1, 0, 0])[i] THEN
            RAISE EXCEPTION 'Team % holds % assignment row(s) and % live exception(s) after the later save', i, v_n, v_m;
        END IF;
        v_examined := v_examined + 1;
    END LOOP;
    IF v_examined <> 5 OR v_exc2 IS NULL OR v_exc3 IS NULL
       OR (SELECT withdrawn_at FROM public.practice_exceptions WHERE id = v_exc2) IS NOT NULL THEN
        RAISE EXCEPTION 'the exceptions were not stored in practice_exceptions or did not survive the later save (examined %)', v_examined;
    END IF;
    RAISE NOTICE 'exceptions: stored in practice_exceptions (not as assignment rows) and still live after a later ordinary save -- 5 of 5 roster teams hold exactly their expected rows and exceptions';
    -- A second live exception overlapping the first on the same series.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
            exceptions => jsonb_build_array(jsonb_build_object('assignment_id', v_row[2],
                'window', '[2026-10-10,2026-10-20]', 'kind', 'time_tbd', 'tbd_reason', 'contended')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '23P01' THEN
        RAISE EXCEPTION 'an overlapping live exception on one series was not refused 23P01: % %', v_state, v_msg;
    END IF;
    -- teams_time_tbd, from the roster: exactly Team 3.
    v_expected := jsonb_build_array(jsonb_build_object(
        'team_id', v_t[3], 'team_name', 'P66 Team 3', 'exception_id', v_exc3,
        'assignment_id', v_row[3], 'window', '[2026-10-05,2026-10-12)', 'tbd_reason', 'contended'));
    IF v_res->'teams_time_tbd' IS DISTINCT FROM v_expected
       OR v_res->'teams_without_practice' IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
            'team_id', v_t[5], 'team_name', 'P66 Team 5', 'had_prior_rows', false)) THEN
        RAISE EXCEPTION 'teams_time_tbd should be exactly Team 3 and teams_without_practice exactly Team 5: % / %',
            v_res->'teams_time_tbd', v_res->'teams_without_practice';
    END IF;
    RAISE NOTICE 'teams_time_tbd: exactly P66 Team 3 of 5 roster teams; teams_without_practice exactly P66 Team 5 (never placed)';

    -- A withdrawal is locked too: without its series unlocked it refuses.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
            withdraw_exceptions => jsonb_build_array(jsonb_build_object('exception_id', v_exc3)));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE 'assignment ' || v_row[3] || ' is locked%' THEN
        RAISE EXCEPTION 'withdrawing an exception without unlocking its series was not refused as locked: % %', v_state, v_msg;
    END IF;
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base,
        unlock => jsonb_build_array(jsonb_build_object('assignment_id', v_row[3], 'reason', 'blackout lifted')),
        withdraw_exceptions => jsonb_build_array(jsonb_build_object('exception_id', v_exc3)));
    v_all_unlocked := v_all_unlocked || (v_res->'unlocked');
    IF jsonb_array_length(v_res->'exceptions_withdrawn') <> 1 OR v_res->'teams_time_tbd' <> '[]'::jsonb THEN
        RAISE EXCEPTION 'the unlocked withdrawal did not withdraw Team 3''s TIME TBD: %', v_res;
    END IF;

    -- ---- 8. deleting an overridden series is loud ---------------------------
    -- Team 2's series carries a live relocation. The unlocked prune of it --
    -- Team 2 absent, its row unlocked, the exception NOT withdrawn -- refuses.
    v_state := NULL;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1), v_base - 2,
            unlock => jsonb_build_array(jsonb_build_object('assignment_id', v_row[2], 'reason', 'drop Team 2')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '23503'
       OR NOT EXISTS (SELECT 1 FROM public.practice_exceptions WHERE id = v_exc2) THEN
        RAISE EXCEPTION 'pruning a series with a live exception was not refused 23503 with the exception kept: % %', v_state, v_msg;
    END IF;
    RESET ROLE;
    v_state := NULL;
    BEGIN
        DELETE FROM public.practice_assignments WHERE id = v_row[2];
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23503' THEN
        RAISE EXCEPTION 'a raw DELETE of an overridden series was not refused 23503: %', v_state;
    END IF;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_before FROM public.audit_log WHERE organization_id = v_org AND action = 'practice.exception_withdrawn';
    PERFORM public.admin_cancel_practice_assignment(v_row[2]);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.practice_assignments WHERE id = v_row[2])
       OR EXISTS (SELECT 1 FROM public.practice_exceptions WHERE assignment_id = v_row[2])
       OR (SELECT count(*) FROM public.audit_log
            WHERE organization_id = v_org AND action = 'practice.exception_withdrawn'
              AND resource_id = v_exc2 AND metadata->>'reason' = 'assignment_cancelled') <> 1
       OR (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action = 'practice.exception_withdrawn') <> v_before + 1
       OR (SELECT jsonb_array_length(metadata->'withdrawn_exception_ids') FROM public.audit_log
            WHERE action = 'practice.cancelled' AND resource_id = v_row[2]) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.scheduler_runs sr, jsonb_array_elements(sr.results->'archived_exceptions') e
                       WHERE sr.organization_id = v_org AND (e.value->>'id')::uuid = v_exc2) THEN
        RAISE EXCEPTION 'cancelling Team 2''s overridden series should withdraw its exception in the same transaction, audit it once and archive it on its run';
    END IF;
    RAISE NOTICE 'overridden series: the unlocked prune and a raw DELETE were each refused 23503; admin_cancel_practice_assignment withdrew the exception in the same transaction, audited it once (assignment_cancelled) and archived it on its run';

    -- ---- 6 (cont). every unlock audited with its before-image -----------------
    SELECT count(*) INTO v_n
      FROM jsonb_array_elements(v_all_unlocked) u
     WHERE (SELECT count(*) FROM public.audit_log a
             WHERE a.action = 'practice.unlock_accepted'
               AND a.resource_id = (u.value->>'id')::uuid
               AND a.user_id = v_admin
               AND a.metadata->'before' = u.value
               AND length(a.metadata->>'reason') > 0) = 1;
    SELECT count(*) INTO v_m FROM public.audit_log WHERE organization_id = v_org AND action = 'practice.unlock_accepted';
    IF jsonb_array_length(v_all_unlocked) <> 2 OR v_n <> 2 OR v_m <> 2 THEN
        RAISE EXCEPTION 'expected the 2 accepted unlocks each audited once with its before-image and reason: % unlocked, % matched, % audit rows',
            jsonb_array_length(v_all_unlocked), v_n, v_m;
    END IF;
    RAISE NOTICE 'unlock audit: 2 of 2 accepted unlocks each left one practice.unlock_accepted row carrying its before-image and reason; refused saves left none';

    -- ---- clean up (exceptions first: their FK to assignments is RESTRICT) ----
    DELETE FROM public.practice_exceptions WHERE organization_id = v_org;
    DELETE FROM public.organizations WHERE id = v_org;
    DELETE FROM public.profiles WHERE id IN (v_admin, v_coach);
    DELETE FROM auth.users WHERE id IN (v_admin, v_coach);
END;
$$;
