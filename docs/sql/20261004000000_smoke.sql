-- Smoke checks for 20261004000000_enact_practice_recommendation.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` requires each witness NOTICE to print.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so every enact runs the REAL wrapper and the REAL
-- writer as a real org admin with RLS on: both are SECURITY INVOKER.
--
-- docs/PHASE_8_6_PR11_ENACT_PLAN.md §6, the witnesses assigned to 11b:
--    8  admin-only: a coach, a parent and a caller with no uid (42501)
--   24  the commit gate (SQL arm): the cause field's effective_to NULL, and a
--       different stored date, each refused 22023 with nothing written
--    6  never blind: a NULL base_fingerprint (22023)
--   15  only S: closes naming another series (22023, rolled back)
--   11  a new row not marked `recommendation` (22023); after the enact, an
--       ordinary save omitting the enacted row is refused as locked
--    5  stale: a write between the fingerprint read and the enact gives
--       40001, with nothing written
--   14  the audit is atomic: with its action unregistered the enact fails at
--       the audit row and every write goes with it
--   10  only the enacted series changes, and it gets exactly one new row
--   13  the audit row: one, on S, with the stored date and the result
--       fingerprint the RPC filled
--    7  idempotent: the same key again returns `idempotent: true`, no write
-- plus a TIME TBD enact (one tail exception, no new row).
-- The revert (the wrapper gone, the writer untouched) is checked by run.sh's
-- revert stage on a database built up to this migration.
--
-- Every subject set is enumerated from the pre-enact snapshot this file
-- takes or from the payloads it SENT, never from what a call wrote back.
-- Every name and id is synthetic.

\set ON_ERROR_STOP on

DO $$
DECLARE
    c_admin  constant uuid := 'e1100000-0000-4000-8000-0000000000a1';
    c_coach  constant uuid := 'e1100000-0000-4000-8000-0000000000c1';
    c_parent constant uuid := 'e1100000-0000-4000-8000-0000000000d1';
    c_k0 constant uuid := 'e1100000-0000-4000-8000-00000000e000';
    c_k1 constant uuid := 'e1100000-0000-4000-8000-00000000e001';
    c_k2 constant uuid := 'e1100000-0000-4000-8000-00000000e002';
    c_d  constant date := '2026-10-15';
    v_org uuid; v_loc uuid; v_f1 uuid; v_f2 uuid; v_s uuid; v_div uuid;
    v_t1 uuid; v_t2 uuid; v_t3 uuid; v_s2 uuid; v_div2 uuid; v_t4 uuid;
    v_n2 int;
    v_tue uuid; v_wed uuid; v_mon2 uuid; v_thu2 uuid;
    v_sa uuid; v_o1 uuid; v_o2 uuid;
    v_fp text;
    v_rows jsonb;
    v_rec jsonb;
    v_run jsonb;
    v_unlock jsonb;
    v_closes jsonb;
    v_assign jsonb;
    v_res jsonb;
    v_state text; v_msg text;
    v_n int;
    v_digest text; v_after text;
    v_pre jsonb;
    v_new record;
    v_audit jsonb;
    v_leaked text;
BEGIN
    -- ---- the fixture (as the table owner) -----------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (c_admin, 'e11-admin@example.test', jsonb_build_object('password_length', 16)),
      (c_coach, 'e11-coach@example.test', jsonb_build_object('password_length', 16)),
      (c_parent, 'e11-parent@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES
      (c_admin, 'e11-admin@example.test'), (c_coach, 'e11-coach@example.test'),
      (c_parent, 'e11-parent@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org E11', 'smoke-org-e11') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
      (v_org, c_admin, 'admin'), (v_org, c_coach, 'coach'), (v_org, c_parent, 'parent');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'E11 Park') RETURNING id INTO v_loc;
    -- Field 1 retires from D; field 2, at the same park, stays.
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'E11 Pitch 1', true) RETURNING id INTO v_f1;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'E11 Pitch 2', true) RETURNING id INTO v_f2;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'E11 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'E11 U12') RETURNING id INTO v_div;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'E11 Team 1') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'E11 Team 2') RETURNING id INTO v_t2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'E11 Team 3') RETURNING id INTO v_t3;
    -- Another season of the same organisation, for the org-scoped new-row check.
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'E11 Spring') RETURNING id INTO v_s2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s2, 'E11 Spring U12') RETURNING id INTO v_div2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div2, 'E11 Team 4 (spring)') RETURNING id INTO v_t4;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f1, 'tue', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_tue;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f1, 'wed', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_wed;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f2, 'mon', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_mon2;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f2, 'thu', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_thu2;
    -- S (Team 1, Tuesday, field 1) is the series enacted; O1 (Team 2,
    -- Wednesday, field 1) is displaced too and must not move; O2 (Team 3,
    -- field 2) is not displaced at all.
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t1, v_tue, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_sa;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t2, v_wed, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_o1;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t3, v_mon2, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_o2;

    -- The re-home of S: S closed the day before D (kept by id, so its key is
    -- not re-sent), the other two re-sent, and S's new row from D on field 2.
    v_assign := jsonb_build_array(
        jsonb_build_object('team_id', v_t2, 'practice_slot_id', v_wed, 'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'auto'),
        jsonb_build_object('team_id', v_t3, 'practice_slot_id', v_mon2, 'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'auto'),
        jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_thu2, 'effective_date_range', '[2026-10-15,2026-11-30]',
                           'source', 'auto', 'assigned_via', 'recommendation'));
    v_closes := jsonb_build_array(jsonb_build_object('assignment_id', v_sa, 'last_day', '2026-10-14'));
    v_unlock := jsonb_build_array(jsonb_build_object('assignment_id', v_sa,
        'reason', 'enact ' || c_k0 || ': retirement of field ' || v_f1 || ' from 2026-10-15'));
    v_run := jsonb_build_object('id', c_k0, 'run_type', 'practice', 'status', 'completed',
                                'season_settings_id', v_s, 'parameters', '{}'::jsonb);
    -- The plan §5 record, as core buildEnactRecord emits it.
    v_rec := jsonb_build_object(
        'schema_version', 1,
        'enact_key', c_k0, 'run_id', c_k0, 'season_settings_id', v_s,
        'cause', jsonb_build_object('kind', 'retirement', 'id', v_f1,
            'loss', jsonb_build_object('from', '2026-10-15', 'until', NULL, 'surface_ids', jsonb_build_array(v_f1),
                                       'start_minutes', NULL, 'end_minutes', NULL, 'reason', 'retirement'),
            'stored_effective_to', '2026-10-14'),
        'series', jsonb_build_object('assignment_id', v_sa, 'team_id', v_t1,
            'from', jsonb_build_object('surface_id', v_f1, 'weekday', 'TUE', 'start_minutes', 1080, 'duration_minutes', 90),
            'window', jsonb_build_object('from', '2026-10-15', 'until', '2026-11-30')),
        'decision', jsonb_build_object('kind', 'rehome',
            'to', jsonb_build_object('surface_id', v_f2, 'weekday', 'THU', 'start_minutes', 1080, 'duration_minutes', 90),
            'tier', 'same-venue', 'origin', NULL, 'tbd_reason', NULL,
            'objective', jsonb_build_object('total', 1, 'counts', jsonb_build_object('changedWeekday', 1)),
            'coach_overlaps', '[]'::jsonb, 'coach_days_worsened', 0),
        'rejudge', jsonb_build_object('stands', true, 'shown_counts', jsonb_build_object('changedWeekday', 1)),
        'declined', '[]'::jsonb, 'chains', '[]'::jsonb, 'local', false, 'enacted_before', '[]'::jsonb,
        'prompt', jsonb_build_object(
            'rows', jsonb_build_array(jsonb_build_object('assignment_id', v_sa, 'assigned_via', 'auto',
                                                         'effect', 'closed', 'range_after', '[2026-09-01,2026-10-15)')),
            'published_practices_affected', 7, 'accepted', true),
        'unlock', v_unlock,
        'writes', jsonb_build_object('closes', v_closes,
            'new_rows', jsonb_build_array(jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_thu2,
                                                             'effective_date_range', '[2026-10-15,2026-11-30]')),
            'exceptions', 0),
        'base_fingerprint', NULL, 'result_fingerprint', NULL,
        'fingerprint_covers', 'practice_assignments+practice_exceptions',
        'solver', jsonb_build_object('strategy', 'exact', 'proven_optimal', true,
                                     'daylight_supplied', true, 'closures_supplied', true));

    -- What "nothing written" is measured against: the org's rows, exceptions
    -- and audit rows, as the owner sees them.
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_digest;

    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', c_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_fp := public.practice_schedule_fingerprint(v_s);
    RESET ROLE;
    IF v_fp !~ '^[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'the season fingerprint was not read: %', v_fp;
    END IF;
    v_rec := jsonb_set(v_rec, '{base_fingerprint}', to_jsonb(v_fp));

    -- ---- 8. admin-only -------------------------------------------------------
    -- The field is committed for these calls, so a refusal cannot be the
    -- commit gate's; the wrapper's own message is required, not the writer's.
    UPDATE public.fields SET effective_to = '2026-10-14' WHERE id = v_f1;
    v_n := 0;
    FOR v_state IN SELECT unnest(ARRAY[c_coach::text, c_parent::text, '']) LOOP
        PERFORM set_config('request.jwt.claim.sub', v_state, true);
        BEGIN
            SET LOCAL ROLE authenticated;
            PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
            v_msg := 'accepted';
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
            IF SQLSTATE = '42501' AND v_msg LIKE '%only an organization admin with a uid can enact%' THEN
                v_n := v_n + 1;
            END IF;
        END;
        RESET ROLE;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', c_admin::text, true);
    UPDATE public.fields SET effective_to = NULL WHERE id = v_f1;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_after;
    IF v_n <> 3 OR v_after <> v_digest THEN
        RAISE EXCEPTION 'expected a coach, a parent and a no-uid caller each refused 42501 by the wrapper, writing nothing; got % of 3 (last: %)', v_n, v_msg;
    END IF;
    RAISE NOTICE 'enact access: a coach, a parent and a caller with no uid were each refused 42501 by the wrapper, 3 of 3, and wrote nothing';

    -- ---- 24. the commit gate -------------------------------------------------
    v_n := 0;
    FOR v_state IN SELECT unnest(ARRAY['none', '2026-10-21']) LOOP
        UPDATE public.fields SET effective_to = NULLIF(v_state, 'none')::date WHERE id = v_f1;
        BEGIN
            SET LOCAL ROLE authenticated;
            PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
            v_msg := 'accepted';
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
            -- (A CASE inside the IF would end the IF at its own THEN.)
            v_after := '%committed with a different date: 2026-10-21 stored, 2026-10-14 expected%';
            IF v_state = 'none' THEN
                v_after := '%is not committed%';
            END IF;
            IF SQLSTATE = '22023' AND v_msg LIKE v_after THEN
                v_n := v_n + 1;
            END IF;
        END;
        RESET ROLE;
    END LOOP;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_after;
    IF v_n <> 2 OR v_after <> v_digest THEN
        RAISE EXCEPTION 'expected the uncommitted and the re-dated retirement each refused 22023, writing nothing; got % of 2 (last: %)', v_n, v_msg;
    END IF;
    RAISE NOTICE 'commit gate: with the cause field''s effective_to NULL and with 2026-10-21 stored, the enact was refused 22023, 2 of 2 (not committed, a different date); 0 rows and 0 audit rows changed';

    -- The retirement is committed from here on: the day before D.
    UPDATE public.fields SET effective_to = '2026-10-14' WHERE id = v_f1;

    -- ---- 6. never blind ------------------------------------------------------
    -- A blind client sends no base anywhere: the argument and the record both null.
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, NULL,
                                                     jsonb_set(v_rec, '{base_fingerprint}', 'null'::jsonb));
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%an enact is never blind%' THEN
        RAISE EXCEPTION 'a NULL base_fingerprint was not refused 22023 as blind: % %', v_state, v_msg;
    END IF;
    RAISE NOTICE 'never blind: an enact with no base_fingerprint was refused 22023';

    -- ---- 15. only S ----------------------------------------------------------
    -- closes and unlock also name O1, and the record declares exactly that,
    -- so neither the record check nor the writer's lock refuses first.
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run,
            jsonb_build_array(v_assign->1, v_assign->2),
            v_unlock || jsonb_build_array(jsonb_build_object('assignment_id', v_o1, 'reason', 'enact ' || c_k0 || ': stray')),
            v_closes || jsonb_build_array(jsonb_build_object('assignment_id', v_o1, 'last_day', '2026-10-14')),
            '[]'::jsonb, v_fp,
            jsonb_set(jsonb_set(v_rec, '{unlock}', v_unlock || jsonb_build_array(jsonb_build_object('assignment_id', v_o1, 'reason', 'enact ' || c_k0 || ': stray'))),
                      '{writes,closes}', v_closes || jsonb_build_array(jsonb_build_object('assignment_id', v_o1, 'last_day', '2026-10-14'))));
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_after;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%touched more than it: closed ' || v_o1 || '%' OR v_after <> v_digest THEN
        RAISE EXCEPTION 'a write that also closed another series was not refused 22023 and rolled back: % %', v_state, v_msg;
    END IF;
    v_n := 0;
    IF v_state = '22023' THEN v_n := 1; END IF;
    -- The upsert path: O2's key re-sent with its source flipped to manual.
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run,
            jsonb_set(v_assign, '{1,source}', '"manual"'::jsonb),
            v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_after;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%changed other rows: ' || v_o2 || '%' OR v_after <> v_digest THEN
        RAISE EXCEPTION 'a write that rewrote another series'' source was not refused 22023 and rolled back: % %', v_state, v_msg;
    END IF;
    v_n := v_n + 1;
    RAISE NOTICE 'only S: a payload whose closes and unlock also name another series, and one re-sending another series with its source changed, were each refused 22023, % of 2, and rolled back; 0 rows and 0 audit rows changed', v_n;

    -- ---- 11. the new row is marked -------------------------------------------
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run,
            jsonb_set(v_assign, '{2,assigned_via}', '"repair"'::jsonb),
            v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%not its team''s assigned_via = recommendation%' THEN
        RAISE EXCEPTION 'an enacted row marked repair was not refused 22023: % %', v_state, v_msg;
    END IF;
    -- An extra row for another season's team, undeclared: the writer's insert
    -- is scoped by organisation, so the wrapper must look org-wide.
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run,
            v_assign || jsonb_build_array(jsonb_build_object('team_id', v_t4, 'practice_slot_id', v_mon2,
                'effective_date_range', '[2026-10-15,2026-11-30]', 'source', 'auto', 'assigned_via', 'recommendation')),
            v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%not its team''s assigned_via = recommendation%' THEN
        RAISE EXCEPTION 'an extra row for another season''s team was not refused 22023: % %', v_state, v_msg;
    END IF;
    -- The record declares the new row on another slot than the one written.
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp,
            jsonb_set(v_rec, '{writes,new_rows,0,practice_slot_id}', to_jsonb(v_mon2::text)));
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%does not declare in writes.new_rows%' THEN
        RAISE EXCEPTION 'a new row the record does not declare was not refused 22023: % %', v_state, v_msg;
    END IF;
    -- An impossible date is a malformed record (22023), not a crash.
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp,
            jsonb_set(v_rec, '{cause,loss,from}', '"2026-02-30"'::jsonb));
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%impossible date%' THEN
        RAISE EXCEPTION 'an impossible loss date was not refused 22023: % %', v_state, v_msg;
    END IF;
    RAISE NOTICE 'marked: an enact whose new row is assigned_via repair, one adding a row for another season''s team, and one whose record declares another slot were each refused 22023, 3 of 3; an impossible date refused 22023';

    -- ---- 5. stale ------------------------------------------------------------
    -- v_fp was read; a write lands after it; the enact then carries v_fp.
    UPDATE public.practice_assignments SET source = 'manual' WHERE id = v_o2;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_digest;
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_after;
    IF v_state IS DISTINCT FROM '40001' OR v_after <> v_digest THEN
        RAISE EXCEPTION 'an enact on a stale base was not refused 40001 with nothing written: % %', v_state, v_msg;
    END IF;
    RAISE NOTICE 'stale: an enact whose base was read before another write was refused 40001; 0 rows and 0 audit rows changed';
    -- Back to the state v_fp describes.
    UPDATE public.practice_assignments SET source = 'auto' WHERE id = v_o2;
    SET LOCAL ROLE authenticated;
    IF public.practice_schedule_fingerprint(v_s) IS DISTINCT FROM v_fp THEN
        RAISE EXCEPTION 'the fixture did not return to the fingerprint it was read at';
    END IF;
    RESET ROLE;

    -- ---- 14. the audit is atomic ---------------------------------------------
    v_state := NULL; v_leaked := NULL;
    BEGIN
        DELETE FROM public.audit_actions WHERE action = 'practice.recommendation_enacted';
        SET LOCAL ROLE authenticated;
        PERFORM public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
        RESET ROLE;
        -- Reached only when the enact survived its own audit failure.
        v_leaked := (SELECT count(*) FROM public.practice_assignments pa
                      WHERE pa.organization_id = v_org AND pa.assigned_via = 'recommendation')::text;
        RAISE EXCEPTION 'smoke: the enact committed with its audit row missing';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '23503' OR v_leaked IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'practice.recommendation_enacted') THEN
        RAISE EXCEPTION 'with its audit action unregistered the enact did not fail at the audit row (% %; % recommendation row(s) written)', v_state, v_msg, v_leaked;
    END IF;
    RAISE NOTICE 'audit atomicity: with practice.recommendation_enacted unregistered the enact itself failed 23503 at its audit row, so its writes rolled back with it';

    -- ---- 10, 13. the enact ---------------------------------------------------
    v_run := jsonb_set(v_run, '{id}', to_jsonb(c_k1::text));
    v_unlock := jsonb_build_array(jsonb_build_object('assignment_id', v_sa,
        'reason', 'enact ' || c_k1 || ': retirement of field ' || v_f1 || ' from 2026-10-15'));
    v_rec := jsonb_set(jsonb_set(jsonb_set(v_rec, '{enact_key}', to_jsonb(c_k1::text)),
                                 '{run_id}', to_jsonb(c_k1::text)), '{unlock}', v_unlock);
    -- The pre-enact snapshot every row check below is enumerated from.
    SELECT jsonb_agg(jsonb_build_object('id', pa.id, 'team_id', pa.team_id, 'slot', pa.practice_slot_id,
                                        'range', pa.effective_date_range::text, 'via', pa.assigned_via) ORDER BY pa.id)
      INTO v_pre
      FROM public.practice_assignments pa WHERE pa.organization_id = v_org;
    IF jsonb_array_length(v_pre) <> 3 THEN
        RAISE EXCEPTION 'the pre-enact snapshot holds % rows, not the fixture''s 3', jsonb_array_length(v_pre);
    END IF;
    SET LOCAL ROLE authenticated;
    v_res := public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
    RESET ROLE;
    IF v_res->'enact_audited' IS DISTINCT FROM 'true'::jsonb OR v_res->'idempotent' IS DISTINCT FROM 'false'::jsonb
       OR (v_res->>'run_id')::uuid IS DISTINCT FROM c_k1 THEN
        RAISE EXCEPTION 'the enact did not report itself audited under run %: %', c_k1, v_res;
    END IF;
    -- Every pre-enact row other than S, unchanged; S closed at D-1.
    v_n := 0;
    FOR v_state IN SELECT e.value::text FROM jsonb_array_elements(v_pre) e LOOP
        IF (v_state::jsonb->>'id')::uuid = v_sa THEN
            IF NOT EXISTS (SELECT 1 FROM public.practice_assignments pa
                            WHERE pa.id = v_sa AND pa.practice_slot_id = v_tue AND pa.assigned_via = 'auto'
                              AND pa.effective_date_range = '[2026-09-01,2026-10-14]'::daterange) THEN
                RAISE EXCEPTION 'S % was not closed at 2026-10-14 in place', v_sa;
            END IF;
        ELSE
            IF NOT EXISTS (SELECT 1 FROM public.practice_assignments pa
                            WHERE pa.id = (v_state::jsonb->>'id')::uuid
                              AND pa.team_id = (v_state::jsonb->>'team_id')::uuid
                              AND pa.practice_slot_id = (v_state::jsonb->>'slot')::uuid
                              AND pa.effective_date_range::text = v_state::jsonb->>'range'
                              AND pa.assigned_via = v_state::jsonb->>'via') THEN
                RAISE EXCEPTION 'pre-enact row % changed although only S % was enacted', v_state, v_sa;
            END IF;
            v_n := v_n + 1;
        END IF;
    END LOOP;
    SELECT count(*) INTO v_msg FROM public.practice_assignments pa
     WHERE pa.organization_id = v_org AND NOT (pa.id IN (SELECT (e.value->>'id')::uuid FROM jsonb_array_elements(v_pre) e));
    SELECT pa.team_id, pa.practice_slot_id, pa.effective_date_range, pa.assigned_via INTO v_new
      FROM public.practice_assignments pa
     WHERE pa.organization_id = v_org AND NOT (pa.id IN (SELECT (e.value->>'id')::uuid FROM jsonb_array_elements(v_pre) e));
    IF v_n <> 2 OR v_msg <> '1' OR v_new.team_id <> v_t1 OR v_new.practice_slot_id <> v_thu2
       OR v_new.effective_date_range <> '[2026-10-15,2026-11-30]'::daterange OR v_new.assigned_via <> 'recommendation'
       OR EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.organization_id = v_org) THEN
        RAISE EXCEPTION 'expected 2 untouched rows and exactly 1 new row (Team 1, Thursday, from D, recommendation), no exception; got % untouched, % new', v_n, v_msg;
    END IF;
    RAISE NOTICE 'only S changed: of 3 pre-enact rows, the 2 other than S are unchanged in id, slot, range and assigned_via; S is closed at 2026-10-14; exactly 1 new row (Team 1, Thursday, from 2026-10-15), assigned_via recommendation';

    SELECT count(*) INTO v_n FROM public.audit_log al
     WHERE al.organization_id = v_org AND al.action = 'practice.recommendation_enacted';
    SELECT al.metadata INTO v_audit FROM public.audit_log al
     WHERE al.organization_id = v_org AND al.action = 'practice.recommendation_enacted'
       AND al.resource_type = 'practice_assignment' AND al.resource_id = v_sa AND al.user_id = c_admin;
    IF v_n <> 1 OR v_audit IS NULL
       OR (SELECT count(*) FROM jsonb_object_keys(v_audit)) <> 19
       OR v_audit->'cause'->>'stored_effective_to' IS DISTINCT FROM '2026-10-14'
       OR v_audit->>'result_fingerprint' IS DISTINCT FROM v_res->>'fingerprint'
       OR v_audit->>'base_fingerprint' IS DISTINCT FROM v_fp
       OR v_audit->>'run_id' IS DISTINCT FROM c_k1::text
       OR v_audit->'unlock' IS DISTINCT FROM v_unlock THEN
        RAISE EXCEPTION 'expected 1 practice.recommendation_enacted row on S by the admin with the RPC-filled fields; % row(s): %', v_n, v_audit;
    END IF;
    SET LOCAL ROLE authenticated;
    IF v_res->>'fingerprint' IS DISTINCT FROM public.practice_schedule_fingerprint(v_s) THEN
        RAISE EXCEPTION 'the audited result fingerprint is not the season''s current one';
    END IF;
    RESET ROLE;
    IF (SELECT count(*) FROM public.audit_log al
         WHERE al.organization_id = v_org AND al.action = 'practice.unlock_accepted'
           AND al.resource_id = v_sa AND al.metadata->>'reason' = v_unlock->0->>'reason'
           AND al.metadata->>'run_id' = c_k1::text) <> 1 THEN
        RAISE EXCEPTION 'the writer did not audit the unlock of S once with the generated reason';
    END IF;
    RAISE NOTICE 'enact audit: 1 practice.recommendation_enacted row on S by the admin, its 19 keys, cause.stored_effective_to 2026-10-14 as stored, result_fingerprint equal to the writer''s; 1 practice.unlock_accepted with the generated reason';

    -- ---- 7. idempotent -------------------------------------------------------
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_digest;
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        -- The double-click: the same key, the same (now stale) base.
        v_res := public.enact_practice_recommendation(v_run, v_assign, v_unlock, v_closes, '[]'::jsonb, v_fp, v_rec);
        v_state := 'ok';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    SELECT md5(COALESCE((SELECT string_agg(pa.id || '|' || pa.practice_slot_id || '|' || pa.effective_date_range::text
                                           || '|' || pa.assigned_via, ',' ORDER BY pa.id)
                           FROM public.practice_assignments pa WHERE pa.organization_id = v_org), '')
               || (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)::text
               || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = v_org)::text)
      INTO v_after;
    IF v_state IS DISTINCT FROM 'ok' OR v_res->'idempotent' IS DISTINCT FROM 'true'::jsonb
       OR (v_res->>'run_id')::uuid IS DISTINCT FROM c_k1 OR v_after <> v_digest
       OR (SELECT count(*) FROM public.audit_log al
            WHERE al.organization_id = v_org AND al.action = 'practice.recommendation_enacted') <> 1 THEN
        RAISE EXCEPTION 'a repeat of enact % was not idempotent with nothing written: % % %', c_k1, v_state, v_msg, v_res;
    END IF;
    RAISE NOTICE 'idempotency: a second call with the same enact key returned idempotent: true and wrote nothing; 1 enact audit row, 1 new row';

    -- ---- 11. locked afterwards (the writer's lock; no plant of this file's) --
    v_state := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_tue, 'effective_date_range', '[2026-09-01,2026-10-14]'),
                v_assign->0, v_assign->1));
        v_state := 'accepted';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM '22023' OR v_msg NOT LIKE '%is locked%'
       OR NOT EXISTS (SELECT 1 FROM public.practice_assignments pa
                       WHERE pa.team_id = v_t1 AND pa.practice_slot_id = v_thu2 AND pa.assigned_via = 'recommendation') THEN
        RAISE EXCEPTION 'an ordinary save omitting the enacted row was not refused as locked: % %', v_state, v_msg;
    END IF;
    RAISE NOTICE 'the enacted row is locked: an ordinary save omitting it was refused 22023 (is locked) and it survives, assigned_via recommendation';

    -- ---- a TIME TBD enact: O1 closed, one tail exception, no new row ---------
    SET LOCAL ROLE authenticated;
    v_fp := public.practice_schedule_fingerprint(v_s);
    RESET ROLE;
    v_closes := jsonb_build_array(jsonb_build_object('assignment_id', v_o1, 'last_day', '2026-10-14'));
    v_unlock := jsonb_build_array(jsonb_build_object('assignment_id', v_o1,
        'reason', 'enact ' || c_k2 || ': retirement of field ' || v_f1 || ' from 2026-10-15'));
    v_rows := jsonb_build_array(jsonb_build_object('assignment_id', v_o1, 'window', '[2026-10-15,2026-11-30]',
        'kind', 'time_tbd', 'tbd_reason', 'no-legal-slot-at-venue', 'cause_kind', 'retirement', 'cause_id', v_f1));
    v_rec := v_rec || jsonb_build_object('enact_key', c_k2, 'run_id', c_k2, 'base_fingerprint', v_fp,
        'unlock', v_unlock, 'enacted_before', jsonb_build_array(v_sa),
        'series', jsonb_build_object('assignment_id', v_o1, 'team_id', v_t2,
            'from', jsonb_build_object('surface_id', v_f1, 'weekday', 'WED', 'start_minutes', 1080, 'duration_minutes', 90),
            'window', jsonb_build_object('from', '2026-10-15', 'until', '2026-11-30')),
        'decision', jsonb_build_object('kind', 'time_tbd', 'to', NULL, 'tier', NULL, 'origin', NULL,
            'tbd_reason', 'no-legal-slot-at-venue',
            'objective', jsonb_build_object('total', 5, 'counts', jsonb_build_object('timeTbd', 1)),
            'coach_overlaps', '[]'::jsonb, 'coach_days_worsened', 0),
        'writes', jsonb_build_object('closes', v_closes, 'new_rows', '[]'::jsonb, 'exceptions', 1));
    v_rec := jsonb_set(v_rec, '{prompt,rows}', jsonb_build_array(jsonb_build_object('assignment_id', v_o1,
        'assigned_via', 'auto', 'effect', 'closed', 'range_after', '[2026-09-01,2026-10-15)')));
    SET LOCAL ROLE authenticated;
    v_res := public.enact_practice_recommendation(jsonb_set(v_run, '{id}', to_jsonb(c_k2::text)),
        jsonb_build_array(
            jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_tue, 'effective_date_range', '[2026-09-01,2026-10-14]'),
            v_assign->1, v_assign->2),
        v_unlock, v_closes, v_rows, v_fp, v_rec);
    RESET ROLE;
    IF jsonb_array_length(v_res->'exceptions_recorded') <> 1
       OR (SELECT count(*) FROM public.practice_exceptions pe
            WHERE pe.organization_id = v_org AND pe.assignment_id = v_o1 AND pe.kind = 'time_tbd'
              AND pe."window" = '[2026-10-15,2026-11-30]'::daterange) <> 1
       OR (SELECT count(*) FROM public.practice_assignments pa WHERE pa.organization_id = v_org) <> 4
       OR NOT EXISTS (SELECT 1 FROM public.practice_assignments pa
                       WHERE pa.id = v_o1 AND pa.effective_date_range = '[2026-09-01,2026-10-14]'::daterange)
       OR (SELECT count(*) FROM public.audit_log al
            WHERE al.organization_id = v_org AND al.action = 'practice.recommendation_enacted'
              AND al.resource_id = v_o1) <> 1 THEN
        RAISE EXCEPTION 'the TIME TBD enact of % did not close it with exactly one tail exception and no new row: %', v_o1, v_res;
    END IF;
    RAISE NOTICE 'time_tbd enact: series 2 closed at 2026-10-14 with 1 tail exception [2026-10-15,2026-11-30] and 0 new rows; audited once';
END;
$$;

-- ---------------------------------------------------------------------------
-- The grant posture matches the writer's: authenticated and service_role
-- execute; anon and PUBLIC do not.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c_sig constant text := 'public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb)';
    c_writer constant text := 'public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text)';
    v_role text;
    v_n int := 0;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role', 'anon'] LOOP
        IF has_function_privilege(v_role, c_sig, 'EXECUTE') IS DISTINCT FROM has_function_privilege(v_role, c_writer, 'EXECUTE') THEN
            RAISE EXCEPTION 'the wrapper''s EXECUTE for % differs from the writer''s', v_role;
        END IF;
        v_n := v_n + 1;
    END LOOP;
    IF has_function_privilege('anon', c_sig, 'EXECUTE') OR NOT has_function_privilege('authenticated', c_sig, 'EXECUTE')
       OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_sig::regprocedure) THEN
        RAISE EXCEPTION 'the wrapper must be SECURITY INVOKER, executable by authenticated and not by anon';
    END IF;
    RAISE NOTICE 'grants: the wrapper is SECURITY INVOKER and its EXECUTE matches the writer''s for % of 3 roles', v_n;
END;
$$;
