-- Smoke checks for 20260924000000_practice_writer_prunes_superseded.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so the round trip runs the REAL RPC as a real
-- organisation admin, with RLS on (the RPC is SECURITY INVOKER).
--
-- Sections:
--   1. the catalogue: one overload, returning jsonb, no anon EXECUTE
--   2. the #64 five-team re-run, replayed: moved, re-ranged, unlocked-and-
--      moved, dropped, unchanged -- plus a sixth team whose manual row the
--      re-run does not mention, which must be KEPT and reported
--   3. the controls: an identical re-save supersedes nothing; another season
--      and another organisation are untouched; an empty payload and a missing
--      season are refused; a non-admin member is refused and deletes nothing;
--      `allow_empty` does what it says; the service-role path prunes, records
--      its before-images on the run, and says it was not audited
--
-- Per-team checks enumerate teams from the SEEDED ROSTER, never from the
-- assignment rows: a team whose rows were all wrongly deleted must be
-- reported, not silently absent.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_n int;
    v_ret text;
BEGIN
    SELECT count(*), max(pg_get_function_result(p.oid))
      INTO v_n, v_ret
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'persist_practice_schedule';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'expected exactly one persist_practice_schedule overload, found %', v_n;
    END IF;
    IF v_ret <> 'jsonb' THEN
        RAISE EXCEPTION 'persist_practice_schedule returns %, expected jsonb', v_ret;
    END IF;
    IF has_function_privilege('anon', 'public.persist_practice_schedule(jsonb, jsonb, boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon can EXECUTE persist_practice_schedule (LESSONS_LEARNED #5)';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.persist_practice_schedule(jsonb, jsonb, boolean)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.persist_practice_schedule(jsonb, jsonb, boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated or service_role lost EXECUTE on persist_practice_schedule';
    END IF;
    RAISE NOTICE 'catalogue: 1 persist_practice_schedule overload, returns jsonb, anon cannot EXECUTE, authenticated and service_role can';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 and 3. The re-run and its controls
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin  uuid := '64640000-0000-4000-8000-0000000000a1';
    v_member uuid := '64640000-0000-4000-8000-0000000000a2';
    v_admb   uuid := '64640000-0000-4000-8000-0000000000b1';
    v_org  uuid; v_orgb uuid; v_loc uuid; v_locb uuid; v_field uuid; v_fieldb uuid;
    v_s1 uuid; v_s2 uuid; v_sb uuid; v_d1 uuid; v_d2 uuid; v_db uuid;
    v_sa uuid; v_sbl uuid; v_sx uuid;
    v_t uuid[] := ARRAY[]::uuid[];
    v_t7 uuid; v_tb uuid; v_id uuid;
    v_r1 uuid := '64640000-0000-4000-8000-00000000f001';
    v_r2 uuid := '64640000-0000-4000-8000-00000000f002';
    v_r3 uuid := '64640000-0000-4000-8000-00000000f003';
    v_r4 uuid := '64640000-0000-4000-8000-00000000f004';
    c_r  text := '[2026-09-01,2026-11-30]';
    c_r2 text := '[2026-10-01,2026-11-30]';
    v_run2 jsonb;
    v_res jsonb;
    v_payload2 jsonb;
    v_n int; v_m int; v_before int; v_audit_before int;
    v_slot uuid; v_range daterange; v_src text; v_run uuid;
    v_refused boolean;
    v_examined int := 0;
    i int;
BEGIN
    -- ---- seed, as the table owner -------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (v_admin,  'p64-admin@example.test',  jsonb_build_object('password_length', 16)),
      (v_member, 'p64-member@example.test', jsonb_build_object('password_length', 16)),
      (v_admb,   'p64-adminb@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES
      (v_admin, 'p64-admin@example.test'), (v_member, 'p64-member@example.test'),
      (v_admb, 'p64-adminb@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 64', 'smoke-org-64')
      RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 64 B', 'smoke-org-64-b')
      RETURNING id INTO v_orgb;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
      (v_org, v_admin, 'admin'), (v_org, v_member, 'coach'), (v_orgb, v_admb, 'admin');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'P64 Park') RETURNING id INTO v_loc;
    INSERT INTO public.locations (organization_id, name) VALUES (v_orgb, 'P64 B Park') RETURNING id INTO v_locb;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'P64 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_orgb, v_locb, 'P64 B Pitch', true) RETURNING id INTO v_fieldb;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P64 Fall') RETURNING id INTO v_s1;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P64 Spring') RETURNING id INTO v_s2;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_orgb, 'P64 B Fall') RETURNING id INTO v_sb;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s1, 'P64 U10') RETURNING id INTO v_d1;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s2, 'P64 U12') RETURNING id INTO v_d2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_orgb, v_sb, 'P64 B U10') RETURNING id INTO v_db;
    FOR i IN 1..6 LOOP
        INSERT INTO public.teams (organization_id, division_id, name)
          VALUES (v_org, v_d1, 'P64 Team ' || i) RETURNING id INTO v_id;
        v_t := v_t || v_id;
    END LOOP;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d2, 'P64 Team 7 (other season)') RETURNING id INTO v_t7;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_orgb, v_db, 'P64 Team B (other org)') RETURNING id INTO v_tb;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_sa;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'wed', '17:00', '18:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_sbl;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_orgb, v_fieldb, 'mon', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_sx;
    -- The controls' rows: an auto row in ANOTHER season of the same org, and
    -- an auto row in ANOTHER org. Neither may be touched by a season-1 save.
    INSERT INTO public.practice_assignments (organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t7, v_sa, v_sa, c_r::daterange, 'auto'),
             (v_orgb, v_tb, v_sx, v_sx, c_r::daterange, 'auto');

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    -- ---- run 1: all six teams on slot A; Teams 3 and 6 locked ---------------
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', v_r1, 'season_settings_id', v_s1),
        jsonb_build_array(
            jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sa, 'effective_date_range', c_r, 'source', 'auto'),
            jsonb_build_object('team_id', v_t[2], 'practice_slot_id', v_sa, 'effective_date_range', c_r, 'source', 'auto'),
            jsonb_build_object('team_id', v_t[3], 'practice_slot_id', v_sa, 'effective_date_range', c_r, 'source', 'locked'),
            jsonb_build_object('team_id', v_t[4], 'practice_slot_id', v_sa, 'effective_date_range', c_r, 'source', 'auto'),
            jsonb_build_object('team_id', v_t[5], 'practice_slot_id', v_sa, 'effective_date_range', c_r, 'source', 'auto'),
            jsonb_build_object('team_id', v_t[6], 'practice_slot_id', v_sa, 'effective_date_range', c_r, 'source', 'manual')));
    IF (v_res->>'run_id')::uuid IS DISTINCT FROM v_r1 OR (v_res->>'superseded_count')::int <> 0 THEN
        RAISE EXCEPTION 'run 1 on an empty season superseded something or lost its run id: %', v_res;
    END IF;

    -- ---- run 2: T1 moved to B; T2 same slot, new range; T3 unlocked and moved
    -- to B as auto; T4 dropped; T5 unchanged; T6 (manual) not mentioned --------
    v_payload2 := jsonb_build_array(
        jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sbl, 'effective_date_range', c_r,  'source', 'auto'),
        jsonb_build_object('team_id', v_t[2], 'practice_slot_id', v_sa,  'effective_date_range', c_r2, 'source', 'auto'),
        jsonb_build_object('team_id', v_t[3], 'practice_slot_id', v_sbl, 'effective_date_range', c_r,  'source', 'auto'),
        jsonb_build_object('team_id', v_t[5], 'practice_slot_id', v_sa,  'effective_date_range', c_r,  'source', 'auto'));
    v_run2 := public.persist_practice_schedule(
        jsonb_build_object('id', v_r2, 'season_settings_id', v_s1), v_payload2);

    -- Per team, from the roster.
    FOR i IN 1..6 LOOP
        SELECT count(*), max(practice_slot_id::text)::uuid, max(effective_date_range::text)::daterange,
               max(source::text), max(run_id::text)::uuid
          INTO v_n, v_slot, v_range, v_src, v_run
          FROM public.practice_assignments WHERE team_id = v_t[i];
        v_examined := v_examined + 1;
        IF i = 4 THEN
            IF v_n <> 0 THEN
                RAISE EXCEPTION 'Team 4 was dropped by run 2 and still holds % practice row(s)', v_n;
            END IF;
            CONTINUE;
        END IF;
        IF v_n <> 1 THEN
            RAISE EXCEPTION 'Team % holds % practice row(s) after run 2, expected exactly 1', i, v_n;
        END IF;
        IF (i = 1 AND v_slot <> v_sbl) OR (i = 3 AND (v_slot <> v_sbl OR v_src <> 'auto'))
           OR (i = 2 AND v_range <> c_r2::daterange) OR (i = 5 AND (v_slot <> v_sa OR v_run <> v_r2))
           OR (i = 6 AND (v_slot <> v_sa OR v_src <> 'manual' OR v_run <> v_r1)) THEN
            RAISE EXCEPTION 'Team % holds the wrong row after run 2: slot %, range %, source %, run %', i, v_slot, v_range, v_src, v_run;
        END IF;
    END LOOP;
    IF v_examined <> 6 THEN
        RAISE EXCEPTION 'the per-team check examined % team(s), expected 6', v_examined;
    END IF;

    IF (v_run2->>'superseded_count')::int <> 4
       OR (SELECT count(*) FROM jsonb_array_elements(v_run2->'superseded') e WHERE e->>'superseded_reason' = 'replaced') <> 3
       OR (SELECT count(*) FROM jsonb_array_elements(v_run2->'superseded') e WHERE e->>'superseded_reason' = 'team_not_in_schedule') <> 1 THEN
        RAISE EXCEPTION 'run 2 should report 4 superseded rows (3 replaced, 1 team_not_in_schedule): %', v_run2->'superseded';
    END IF;
    IF (v_run2->>'retained_manual_count')::int <> 1
       OR (v_run2->'retained_manual'->0->>'team_id')::uuid <> v_t[6] THEN
        RAISE EXCEPTION 'run 2 should report Team 6''s manual row as retained: %', v_run2->'retained_manual';
    END IF;
    IF NOT (v_run2->>'audited')::boolean THEN
        RAISE EXCEPTION 'an admin save with a uid was not audited: %', v_run2;
    END IF;
    -- Every superseded row: gone from the table, audited once with its full row.
    SELECT count(*) INTO v_n
      FROM jsonb_array_elements(v_run2->'superseded') e
     WHERE NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.id = (e->>'id')::uuid)
       AND (SELECT count(*) FROM public.audit_log a
             WHERE a.action = 'practice.superseded'
               AND a.resource_id = (e->>'id')::uuid
               AND a.user_id = v_admin
               AND a.metadata->>'run_id' = v_r2::text
               AND a.metadata->'row' = (e - 'superseded_reason')) = 1;
    IF v_n <> 4 THEN
        RAISE EXCEPTION 'expected 4 superseded rows each gone and audited once with its full row, found %', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log WHERE organization_id = v_org AND action = 'practice.saved';
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'expected 2 practice.saved audit rows (one per run), found %', v_n;
    END IF;
    RESET ROLE;
    SELECT jsonb_array_length(results->'superseded_rows') INTO v_n FROM public.scheduler_runs WHERE id = v_r2;
    IF v_n IS DISTINCT FROM 4 THEN
        RAISE EXCEPTION 'run 2''s scheduler_runs.results should carry 4 superseded before-images, found %', v_n;
    END IF;
    RAISE NOTICE 're-run: 6 of 6 roster teams examined -- moved, re-ranged, unlocked-and-moved each left with 1 row, dropped left with 0, unchanged upserted onto run 2, unmentioned manual kept and reported; 4 superseded (3 replaced, 1 not in schedule), each deleted and audited once with its full row; 2 practice.saved rows; 4 before-images on the run';

    -- ---- control: an identical re-save supersedes nothing --------------------
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_before FROM public.practice_assignments WHERE organization_id = v_org;
    SELECT count(*) INTO v_audit_before FROM public.audit_log WHERE organization_id = v_org AND action = 'practice.superseded';
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', v_r3, 'season_settings_id', v_s1), v_payload2);
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = v_org;
    SELECT count(*) INTO v_m FROM public.audit_log WHERE organization_id = v_org AND action = 'practice.superseded';
    IF (v_res->>'superseded_count')::int <> 0 OR v_n <> v_before OR v_m <> v_audit_before THEN
        RAISE EXCEPTION 'an identical re-save superseded % row(s): rows % -> %, superseded audits % -> %',
            v_res->>'superseded_count', v_before, v_n, v_audit_before, v_m;
    END IF;

    -- ---- control: another season and another organisation are untouched -----
    RESET ROLE;
    IF (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_t7) <> 1
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_tb) <> 1 THEN
        RAISE EXCEPTION 'a season-1 save removed a row belonging to another season or another organisation';
    END IF;
    SET LOCAL ROLE authenticated;

    -- ---- control: refusals change nothing ------------------------------------
    SELECT count(*) INTO v_before FROM public.practice_assignments WHERE organization_id = v_org;
    v_refused := false;
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('id', v_r4, 'season_settings_id', v_s1), '[]'::jsonb);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'an empty payload was accepted without allow_empty'; END IF;
    v_refused := false;
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('id', v_r4, 'organization_id', v_org), v_payload2);
    EXCEPTION WHEN not_null_violation THEN v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a save with no season_settings_id was accepted'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    v_refused := false;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', v_r4, 'season_settings_id', v_s1),
            jsonb_build_array(jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sa, 'effective_date_range', c_r)));
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a non-admin member was allowed to save a practice schedule'; END IF;
    -- The case only the RPC's own admin check refuses: with no row to insert,
    -- the write policy is never consulted, RLS turns the member's prune into
    -- a silent zero-row DELETE, and the save would report success.
    v_refused := false;
    BEGIN
        PERFORM public.persist_practice_schedule(
            jsonb_build_object('id', v_r4, 'season_settings_id', v_s1), '[]'::jsonb, allow_empty => true);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a non-admin member''s empty save was accepted: its prune was silently a no-op'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = v_org;
    IF v_n <> v_before THEN
        RAISE EXCEPTION 'a refused save changed the practice rows: % -> %', v_before, v_n;
    END IF;

    -- ---- control: a season-1 save that names a season-2 team upserts its row
    -- and prunes nothing of it -- another season is never in scope ------------
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', gen_random_uuid(), 'season_settings_id', v_s1),
        v_payload2 || jsonb_build_array(jsonb_build_object(
            'team_id', v_t7, 'practice_slot_id', v_sbl, 'effective_date_range', c_r, 'source', 'auto')));
    IF (v_res->>'superseded_count')::int <> 0
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_t7) <> 2 THEN
        RAISE EXCEPTION 'a season-1 save naming a season-2 team pruned that team''s season-2 row: %', v_res;
    END IF;

    -- ---- control: allow_empty means it (season 2, Team 7's two auto rows) ----
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', v_r4, 'season_settings_id', v_s2), '[]'::jsonb, allow_empty => true);
    RESET ROLE;
    IF (v_res->>'superseded_count')::int <> 2
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_t7) <> 0
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_t[1]) <> 1 THEN
        RAISE EXCEPTION 'allow_empty on season 2 should supersede Team 7''s two auto rows and nothing in season 1: %', v_res;
    END IF;

    -- ---- the service-role path: prunes, records before-images, says so -------
    -- Re-saved under run 2's id: the before-images run 2 already recorded must
    -- survive the upsert that replaces `results`, and this save's be appended.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    SELECT count(*) INTO v_audit_before FROM public.audit_log WHERE organization_id = v_org;
    v_res := public.persist_practice_schedule(
        jsonb_build_object('id', v_r2, 'season_settings_id', v_s1, 'created_by', v_admin),
        jsonb_build_array(
            jsonb_build_object('team_id', v_t[1], 'practice_slot_id', v_sbl, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t[2], 'practice_slot_id', v_sa,  'effective_date_range', c_r2),
            jsonb_build_object('team_id', v_t[3], 'practice_slot_id', v_sbl, 'effective_date_range', c_r),
            jsonb_build_object('team_id', v_t[5], 'practice_slot_id', v_sbl, 'effective_date_range', c_r)));
    RESET ROLE;
    IF (v_res->>'superseded_count')::int <> 1 OR (v_res->>'audited')::boolean
       OR v_res->>'audit_gap' IS NULL THEN
        RAISE EXCEPTION 'the service-role save should supersede Team 5''s slot-A row and report audited=false with a reason: %', v_res;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org) <> v_audit_before THEN
        RAISE EXCEPTION 'the service-role save wrote audit rows it reported it could not write';
    END IF;
    SELECT jsonb_array_length(results->'superseded_rows') INTO v_n
      FROM public.scheduler_runs WHERE id = v_r2;
    IF v_n IS DISTINCT FROM 5 THEN
        RAISE EXCEPTION 'run 2 re-saved should carry its 4 earlier before-images plus this save''s 1, found %', v_n;
    END IF;
    RAISE NOTICE 'controls: identical re-save superseded 0; other season and other org untouched, and a season-1 save naming a season-2 team pruned none of its rows; empty payload, missing season and non-admin member each refused with rows unchanged; allow_empty superseded exactly season 2''s 2 auto rows; service-role re-save of run 2 superseded 1, appended it to the run''s 4 earlier before-images (5), wrote 0 audit rows and said audited=false';

    -- ---- clean up ------------------------------------------------------------
    DELETE FROM public.organizations WHERE id IN (v_org, v_orgb);
    DELETE FROM public.profiles WHERE id IN (v_admin, v_member, v_admb);
    DELETE FROM auth.users WHERE id IN (v_admin, v_member, v_admb);
END;
$$;
