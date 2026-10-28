-- Smoke checks for 20261105010000_practices_per_division.sql
--
-- Run on the database built to head, in DO blocks that clean up after themselves.
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the writers run as a real
-- organization admin.
--
--   1. Posture: the two columns as declared (NOT NULL DEFAULT 1 and nullable), both range checks,
--      every existing division at 1 and any slot length, one `admin_upsert_division_settings`
--      (13 arguments, a pinned definer for authenticated and not anon), the refusals helper an
--      invoker closed to anon, and the writer calling it.
--   2. The settings writer: a new division takes what it is sent; NULL keeps; 0 minutes clears;
--      8 practices and a 14-minute practice are refused 23514 and change nothing; the audit row
--      carries both settings before and after.
--   3. The writer gate, through the real `persist_practice_schedule`: a save putting a new auto row
--      past a slot's capacity, in another division's reserved slot, in a slot of the wrong length,
--      on a weekday the team already practises on, or past the division's count is refused P0001,
--      each naming its rule, and writes nothing; a save that keeps all five is accepted; the same
--      breaking rows sent as manual or as an override are accepted (they keep today's checks); and
--      re-saving rows already saved is not judged again.
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
    v_def text;
BEGIN
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'divisions'
       AND ((column_name = 'practices_per_week' AND data_type = 'smallint' AND is_nullable = 'NO' AND column_default = '1')
         OR (column_name = 'practice_minutes' AND data_type = 'smallint' AND is_nullable = 'YES' AND column_default IS NULL));
    IF v_n <> 2 THEN RAISE EXCEPTION 'divisions.practices_per_week / practice_minutes are not as declared'; END IF;
    SELECT count(*) INTO v_n FROM pg_constraint
     WHERE conrelid = 'public.divisions'::regclass AND contype = 'c'
       AND ((conname = 'divisions_practices_per_week_range' AND pg_get_constraintdef(oid) LIKE '%practices_per_week >= 0) AND (practices_per_week <= 7)%')
         OR (conname = 'divisions_practice_minutes_range' AND pg_get_constraintdef(oid) LIKE '%practice_minutes >= 15) AND (practice_minutes <= 240)%'));
    IF v_n <> 2 THEN RAISE EXCEPTION 'the two range checks are not as declared'; END IF;
    -- A division that existed before the migration (every one the earlier smokes and the seed left) is at 1 and any length.
    SELECT count(*) INTO v_n FROM public.divisions WHERE practices_per_week IS DISTINCT FROM 1 OR practice_minutes IS NOT NULL;
    RAISE NOTICE 'posture: % division(s) not at the defaults (smokes that ran earlier may have set some)', v_n;

    IF to_regprocedure('public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean)') IS NOT NULL THEN
        RAISE EXCEPTION 'the eleven-argument admin_upsert_division_settings is still callable';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = 'public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean, integer, integer)'::regprocedure
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'the settings writer is not a pinned definer for authenticated and not anon'; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = 'public.practice_new_auto_row_refusals(uuid, uuid[])'::regprocedure
       AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'practice_new_auto_row_refusals is not a pinned invoker closed to anon'; END IF;
    SELECT prosrc INTO v_def FROM pg_proc
     WHERE oid = 'public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text)'::regprocedure;
    IF v_def !~ 'practice_new_auto_row_refusals' THEN RAISE EXCEPTION 'persist_practice_schedule does not call the gate'; END IF;
    RAISE NOTICE 'posture: the two settings and their checks as declared; one 13-argument settings writer (a pinned definer, not anon); the refusals helper an invoker closed to anon; the writer calls it';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 and 3. The settings writer and the writer gate, as an organization admin.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid; v_season uuid; v_div uuid; v_div9 uuid; v_loc uuid; v_field uuid;
    v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid;
    v_mon uuid; v_wed uuid; v_mon2 uuid; v_tue45 uuid; v_thu_res uuid; v_fri uuid;
    c_r text := '[2026-09-01,2026-11-30]';
    v_res jsonb;
    v_state text; v_msg text;
    v_n integer;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (v_admin, 'ppw-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'ppw-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke PPW Org', 'smoke-ppw-org') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'PPW 2026', 'active', 2026) RETURNING id INTO v_season;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'PPW Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
        VALUES (v_org, v_loc, 'PPW Pitch', true) RETURNING id INTO v_field;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    -- ---- 2. the settings writer ---------------------------------------------
    v_res := public.admin_upsert_division_settings(v_org, v_season, NULL, 'PPW U8', 12, 8, 10, 2, 1, 3, true, 2, 60);
    v_div := (v_res->>'id')::uuid;
    IF (v_res->>'practices_per_week')::int <> 2 OR (v_res->>'practice_minutes')::int <> 60 THEN
        RAISE EXCEPTION 'a new division was not created with 2 a week of 60 minutes: %', v_res;
    END IF;
    v_res := public.admin_upsert_division_settings(v_org, v_season, NULL, 'PPW U9', 12, 8, 10, 2, 1, 3);
    v_div9 := (v_res->>'id')::uuid;
    IF (v_res->>'practices_per_week')::int <> 1 OR v_res->'practice_minutes' <> 'null'::jsonb THEN
        RAISE EXCEPTION 'a new division that sent neither did not take 1 a week and any length: %', v_res;
    END IF;
    v_res := public.admin_upsert_division_settings(v_org, v_season, v_div, 'PPW U8', 12, 8, 10, 2, 1, 3, NULL, NULL, NULL);
    IF (v_res->>'practices_per_week')::int <> 2 OR (v_res->>'practice_minutes')::int <> 60 OR (v_res->>'changed')::boolean THEN
        RAISE EXCEPTION 'NULL did not keep both settings and change nothing: %', v_res;
    END IF;
    v_res := public.admin_upsert_division_settings(v_org, v_season, v_div, 'PPW U8', 12, 8, 10, 2, 1, 3, NULL, 3, 0);
    IF (v_res->>'practices_per_week')::int <> 3 OR v_res->'practice_minutes' <> 'null'::jsonb OR NOT (v_res->>'changed')::boolean THEN
        RAISE EXCEPTION 'the count did not change to 3 and 0 minutes did not clear the length: %', v_res;
    END IF;
    FOR v_state, v_msg IN VALUES ('count', '8, NULL'), ('minutes', 'NULL, 14') LOOP
        BEGIN
            IF v_state = 'count' THEN
                PERFORM public.admin_upsert_division_settings(v_org, v_season, v_div, 'PPW U8', 12, 8, 10, 2, 1, 3, NULL, 8, NULL);
            ELSE
                PERFORM public.admin_upsert_division_settings(v_org, v_season, v_div, 'PPW U8', 12, 8, 10, 2, 1, 3, NULL, NULL, 14);
            END IF;
            RAISE EXCEPTION 'a % out of range was accepted', v_state;
        EXCEPTION WHEN check_violation THEN
            NULL;  -- the expected refusal, 23514
        END;
    END LOOP;
    IF (SELECT practices_per_week FROM public.divisions WHERE id = v_div) <> 3 THEN
        RAISE EXCEPTION 'a refused save changed the count';
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_org AND action = 'settings.updated' AND resource_type = 'division'
       AND resource_id = v_div
       AND (metadata->'previous'->>'practices_per_week')::int = 2
       AND (metadata->'current'->>'practices_per_week')::int = 3
       AND (metadata->'previous'->>'practice_minutes')::int = 60
       AND metadata->'current'->'practice_minutes' = 'null'::jsonb;
    IF v_n <> 1 THEN RAISE EXCEPTION 'the change left % settings.updated row(s) carrying both settings before and after, expected 1', v_n; END IF;
    -- U8 back to 2 a week of 60 minutes for the gate below.
    PERFORM public.admin_upsert_division_settings(v_org, v_season, v_div, 'PPW U8', 12, 8, 10, 2, 1, 3, NULL, 2, 60);
    RAISE NOTICE 'settings writer: created at 2 x 60, a division that sent neither at 1 x any, NULL kept, 0 cleared the length, 8 and 14 refused 23514 and changed nothing, one audit row with both settings before and after';

    -- ---- seed for the gate, as the table owner --------------------------------
    RESET ROLE;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'PPW T1') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'PPW T2') RETURNING id INTO v_t2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div9, 'PPW T3') RETURNING id INTO v_t3;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div9, 'PPW T4') RETURNING id INTO v_t4;
    -- Capacity 1 each: Mon 17:00-18:00, Wed 17:00-18:00, Mon 18:15-19:15, Tue 17:00-17:45, Thu 17:00-18:00
    -- reserved to U9, Fri 17:00-18:00.
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_mon;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_wed;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'mon', '18:15', '19:15', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_mon2;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'tue', '17:00', '17:45', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_tue45;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity, division_id)
        VALUES (v_org, v_field, 'thu', '17:00', '18:00', '2026-09-01', '2026-11-30', 1, v_div9) RETURNING id INTO v_thu_res;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
        VALUES (v_org, v_field, 'fri', '17:00', '18:00', '2026-09-01', '2026-11-30', 1) RETURNING id INTO v_fri;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;

    -- ---- 3. the gate: five refusals, each its own rule and each writing nothing --------
    FOR v_state, v_msg IN VALUES
        ('capacity', 'two new auto rows in a capacity-1 slot'),
        ('reservation', 'a U8 team in U9''s reserved slot'),
        ('length', 'a 45-minute slot for a 60-minute division'),
        ('weekday', 'two practices of one team on one weekday'),
        ('count', 'a third practice for a division at 2 a week')
    LOOP
        DECLARE
            v_rows jsonb;
            v_sqlstate text; v_text text;
        BEGIN
            v_rows := CASE v_state
              WHEN 'capacity' THEN jsonb_build_array(
                  jsonb_build_object('team_id', v_t3, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
                  jsonb_build_object('team_id', v_t4, 'practice_slot_id', v_mon, 'effective_date_range', c_r))
              WHEN 'reservation' THEN jsonb_build_array(
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_thu_res, 'effective_date_range', c_r))
              WHEN 'length' THEN jsonb_build_array(
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_tue45, 'effective_date_range', c_r))
              WHEN 'weekday' THEN jsonb_build_array(
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_mon2, 'effective_date_range', c_r))
              ELSE jsonb_build_array(
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_wed, 'effective_date_range', c_r),
                  jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_fri, 'effective_date_range', c_r))
            END;
            BEGIN
                PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_season), v_rows);
                RAISE EXCEPTION 'GATE-OPEN: the save (%) was accepted', v_msg;
            EXCEPTION WHEN OTHERS THEN
                GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_text = MESSAGE_TEXT;
                IF v_text LIKE 'GATE-OPEN:%' THEN RAISE EXCEPTION '%', v_text; END IF;
            END;
            IF v_sqlstate IS DISTINCT FROM 'P0001' OR v_text NOT LIKE '%break a rule the auto-scheduler keeps%'
               OR v_text NOT LIKE '%: ' || v_state || ', %' THEN
                RAISE EXCEPTION 'the % case (%) was not refused P0001 naming "%": % %', v_state, v_msg, v_state, v_sqlstate, v_text;
            END IF;
            SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = v_org;
            IF v_n <> 0 THEN RAISE EXCEPTION 'the refused % save left % row(s)', v_state, v_n; END IF;
        END;
    END LOOP;
    RAISE NOTICE 'writer gate: capacity, reservation, length, weekday and count each refused P0001 naming its rule, with no row written';

    -- A save that keeps all five rules is accepted: U8 T1 on Monday and Wednesday (60 minutes, two
    -- weekdays), U9 T3 on U9's reserved Thursday slot.
    PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_season),
        jsonb_build_array(
            jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_wed, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t3, 'practice_slot_id', v_thu_res, 'effective_date_range', c_r)));
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = v_org;
    IF v_n <> 3 THEN RAISE EXCEPTION 'the legal save wrote % row(s), expected 3', v_n; END IF;

    -- The same capacity breach as a manual row and as an override row keeps today's checks; and the
    -- auto rows now saved, over capacity beside them, are not judged again by a re-save.
    PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_season),
        jsonb_build_array(
            jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_mon, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_wed, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t3, 'practice_slot_id', v_thu_res, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t4, 'practice_slot_id', v_mon, 'effective_date_range', c_r, 'source', 'manual'),
            jsonb_build_object('team_id', v_t2, 'practice_slot_id', v_mon, 'effective_date_range', c_r, 'assigned_via', 'override')));
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = v_org;
    IF v_n <> 5 THEN RAISE EXCEPTION 'the manual and override rows were refused: % row(s), expected 5', v_n; END IF;
    PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_season),
        (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                             'effective_date_range', effective_date_range::text,
                                             'source', source::text, 'assigned_via', assigned_via))
           FROM public.practice_assignments WHERE organization_id = v_org));
    RAISE NOTICE 'writer gate: a legal save accepted (3 rows); the same breach as a manual row and as an override row accepted (5); a re-save of rows already saved, one over capacity, not judged again';

    -- ---- clean up ----------------------------------------------------------------
    RESET ROLE;
    DELETE FROM public.organizations WHERE id = v_org;
    DELETE FROM public.profiles WHERE id = v_admin;
    DELETE FROM auth.users WHERE id = v_admin;
END;
$$;

ROLLBACK;
