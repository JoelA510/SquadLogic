-- Smoke checks for 20261005000000_rsvp_applied_practice_calendar.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` requires each witness NOTICE to print.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so every RSVP runs the REAL function as a real
-- parent with RLS on, and every read of `practice_exceptions` goes through
-- the real select policy.
--
-- docs/PHASE_8_6_PR12_READERS_PLAN.md §6:
--   W14  RSVP follows the applied calendar: a relocated date accepted, an
--        original date in a relocated window refused, a TIME TBD date
--        refused, dates outside any window unchanged, a withdrawn exception
--        of no effect; plus the Q7 open and unreadable windows and the Q9
--        clip. The case table is tests/fixtures/rsvpAppliedCalendarCases.json,
--        restated between the case-table markers below, and
--        tests/rsvpAppliedCalendar.test.js pins the two equal.
--   Q4   stored RSVPs on dates that became TIME TBD or moved are untouched.
--   W15  a parent member reads the same practice_exceptions rows as an admin;
--        a non-member reads none.
-- Every subject set is enumerated from the rows this file SEEDS, never from
-- what a call or a read returned. Every name and id is synthetic.

\set ON_ERROR_STOP on

DO $$
DECLARE
    c_admin  constant uuid := 'd1200000-0000-4000-8000-0000000000a1';
    c_parent constant uuid := 'd1200000-0000-4000-8000-0000000000d1';
    c_outsider constant uuid := 'd1200000-0000-4000-8000-0000000000e1';
    v_org uuid; v_loc uuid; v_field uuid; v_season uuid; v_div uuid;
    v_team uuid[] := ARRAY[]::uuid[];
    v_player uuid[] := ARRAY[]::uuid[];
    v_tue uuid; v_thu uuid; v_mon uuid; v_wed uuid;
    v_a uuid; v_b uuid; v_c uuid;
    v_seeded uuid[] := ARRAY[]::uuid[];
    v_id uuid;
    v_live_relocated int; v_live_tbd int; v_withdrawn int; v_open int; v_unreadable int;
    v_stored_before text; v_stored_after text;
    r record;
    v_ref uuid; v_tm uuid; v_pl uuid;
    v_got text;
    v_bad text[] := ARRAY[]::text[];
    v_n int := 0; v_acc int := 0; v_win int := 0; v_ser int := 0;
    v_rsvps int;
    v_parent_ids uuid[]; v_admin_ids uuid[]; v_outsider_n int;
    i int;
BEGIN
    -- ---- the fixture (as the table owner) -----------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (c_admin, 'd12-admin@example.test', jsonb_build_object('password_length', 16)),
      (c_parent, 'd12-parent@example.test', jsonb_build_object('password_length', 16)),
      (c_outsider, 'd12-outsider@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES
      (c_admin, 'd12-admin@example.test'), (c_parent, 'd12-parent@example.test'),
      (c_outsider, 'd12-outsider@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org D12', 'smoke-org-d12') RETURNING id INTO v_org;
    -- The outsider is a member of no organisation at all.
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
      (v_org, c_admin, 'admin'), (v_org, c_parent, 'parent');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'D12 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'D12 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'D12 Fall') RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'D12 U12') RETURNING id INTO v_div;
    -- One team, one player and one row per case-table row key (A, B, C).
    FOR i IN 1..3 LOOP
        INSERT INTO public.teams (organization_id, division_id, name)
          VALUES (v_org, v_div, 'D12 Team ' || i) RETURNING id INTO v_id;
        v_team := v_team || v_id;
        INSERT INTO public.players (organization_id, division_id, first_name, last_name)
          VALUES (v_org, v_div, 'Sample' || i, 'Player') RETURNING id INTO v_id;
        v_player := v_player || v_id;
        INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_team[i], v_player[i], v_org);
        INSERT INTO public.profile_players (profile_id, player_id, organization_id) VALUES (c_parent, v_player[i], v_org);
    END LOOP;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'tue', '17:00', '18:30', '2026-09-01', '2026-12-31') RETURNING id INTO v_tue;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'thu', '18:15', '19:15', '2026-09-01', '2026-12-31') RETURNING id INTO v_thu;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '17:00', '18:30', '2026-09-01', '2026-12-31') RETURNING id INTO v_mon;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'wed', '17:00', '18:30', '2026-09-01', '2026-12-31') RETURNING id INTO v_wed;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_team[1], v_tue, '[2026-09-01,2026-12-01)', 'auto') RETURNING id INTO v_a;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_team[2], v_mon, '[2026-09-01,2026-10-01)', 'auto') RETURNING id INTO v_b;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_team[3], v_wed, '[2026-09-01,2026-10-01)', 'auto') RETURNING id INTO v_c;

    -- The exceptions, E1-E7 of the case table's seed, in its order.
    FOR r IN
        SELECT * FROM (VALUES
          (1, 'A', 'relocated', 'thu', NULL,          '[2026-09-14,2026-09-28)', false, 'retirement'),
          (2, 'A', 'time_tbd',  NULL,  'contended',   '[2026-10-05,2026-10-19)', false, 'blackout'),
          (3, 'A', 'relocated', 'thu', NULL,          '[2026-11-01,2026-11-15)', true,  'retirement'),
          (4, 'A', 'relocated', 'thu', NULL,          '[2026-11-20,)',           false, 'retirement'),
          (5, 'B', 'relocated', 'wed', NULL,          '[2026-09-21,2026-10-12)', false, 'retirement'),
          (6, 'B', 'time_tbd',  NULL,  'past-sunset', '[2026-10-12,2026-10-26)', false, NULL),
          (7, 'C', 'time_tbd',  NULL,  'contended',   '(,2026-09-06)',           false, 'blackout')
        ) AS e(n, row_key, kind, slot_day, tbd_reason, win, withdrawn, cause)
        ORDER BY n
    LOOP
        INSERT INTO public.practice_exceptions (
            organization_id, season_settings_id, team_id, assignment_id, "window", kind,
            practice_slot_id, tbd_reason, cause_kind, withdrawn_at)
        VALUES (
            v_org, v_season,
            CASE r.row_key WHEN 'A' THEN v_team[1] WHEN 'B' THEN v_team[2] ELSE v_team[3] END,
            CASE r.row_key WHEN 'A' THEN v_a WHEN 'B' THEN v_b ELSE v_c END,
            r.win::daterange, r.kind,
            CASE r.slot_day WHEN 'thu' THEN v_thu WHEN 'wed' THEN v_wed END,
            r.tbd_reason, r.cause,
            CASE WHEN r.withdrawn THEN timezone('utc', now()) END)
        RETURNING id INTO v_id;
        v_seeded := v_seeded || v_id;
    END LOOP;

    -- Meta-assertion: the fixture exercises every kind of window it claims
    -- to, read back from the table (not from the VALUES list above).
    SELECT count(*) FILTER (WHERE kind = 'relocated' AND withdrawn_at IS NULL),
           count(*) FILTER (WHERE kind = 'time_tbd' AND withdrawn_at IS NULL),
           count(*) FILTER (WHERE withdrawn_at IS NOT NULL),
           count(*) FILTER (WHERE withdrawn_at IS NULL AND upper_inf("window")),
           count(*) FILTER (WHERE withdrawn_at IS NULL AND lower_inf("window"))
      INTO v_live_relocated, v_live_tbd, v_withdrawn, v_open, v_unreadable
      FROM public.practice_exceptions
     WHERE id = ANY (v_seeded);
    IF v_live_relocated < 1 OR v_live_tbd < 1 OR v_withdrawn < 1 OR v_open < 1 OR v_unreadable < 1 THEN
        RAISE EXCEPTION 'the RSVP fixture does not exercise every window kind: % live relocated, % live time_tbd, % withdrawn, % open, % unreadable',
            v_live_relocated, v_live_tbd, v_withdrawn, v_open, v_unreadable;
    END IF;
    RAISE NOTICE 'rsvp fixture: % exceptions seeded -- % live relocated, % live time_tbd, % withdrawn, % open-upper, % unreadable-lower',
        cardinality(v_seeded), v_live_relocated, v_live_tbd, v_withdrawn, v_open, v_unreadable;

    -- Q4: two RSVPs already stored on dates that are now TIME TBD (A 10-13)
    -- and moved away (A 09-22). Written as the owner, as a pre-12d RSVP was.
    INSERT INTO public.event_rsvps (organization_id, team_id, player_id, reference_id, event_type, occurrence_date, status, updated_at)
      VALUES (v_org, v_team[1], v_player[1], v_a, 'practice', '2026-10-13', 'attending', '2026-09-01T00:00:00Z'),
             (v_org, v_team[1], v_player[1], v_a, 'practice', '2026-09-22', 'maybe', '2026-09-01T00:00:00Z');
    SELECT string_agg(id::text || ':' || status || ':' || updated_at::text || ':' || occurrence_date::text, ',' ORDER BY occurrence_date)
      INTO v_stored_before
      FROM public.event_rsvps WHERE reference_id = v_a AND occurrence_date IN ('2026-10-13', '2026-09-22');

    -- ---- W14: the case table, as the linked parent -------------------------
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', c_parent::text, true);
    FOR r IN
        SELECT * FROM (VALUES
          -- case-table:begin
          ('A', '2026-09-08', 'accept'),
          ('A', '2026-09-09', '42501'),
          ('A', '2026-09-17', 'accept'),
          ('A', '2026-09-24', 'accept'),
          ('A', '2026-09-15', '22023'),
          ('A', '2026-09-16', '22023'),
          ('A', '2026-10-06', '22023'),
          ('A', '2026-11-03', 'accept'),
          ('A', '2026-11-05', '42501'),
          ('A', '2026-11-24', '22023'),
          ('A', '2026-11-26', '22023'),
          ('B', '2026-09-14', 'accept'),
          ('B', '2026-09-23', 'accept'),
          ('B', '2026-10-07', '22023'),
          ('B', '2026-10-12', '22023'),
          ('C', '2026-09-16', '22023')
          -- case-table:end
        ) AS c(row_key, d, expect)
    LOOP
        v_n := v_n + 1;
        i := CASE r.row_key WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END;
        v_ref := CASE r.row_key WHEN 'A' THEN v_a WHEN 'B' THEN v_b ELSE v_c END;
        v_tm := v_team[i]; v_pl := v_player[i];
        BEGIN
            SET LOCAL ROLE authenticated;
            PERFORM public.upsert_team_event_rsvp(v_tm, v_pl, v_ref, 'practice', r.d::date, 'attending');
            v_got := 'accept';
            RESET ROLE;
        EXCEPTION WHEN OTHERS THEN
            v_got := SQLSTATE;
        END;
        RESET ROLE;
        IF v_got IS DISTINCT FROM r.expect THEN
            v_bad := v_bad || (r.row_key || ' ' || r.d || ': expected ' || r.expect || ', got ' || v_got);
        ELSIF r.expect = 'accept' THEN
            v_acc := v_acc + 1;
        ELSIF r.expect = '22023' THEN
            v_win := v_win + 1;
        ELSE
            v_ser := v_ser + 1;
        END IF;
    END LOOP;
    IF v_n <> 16 THEN
        RAISE EXCEPTION 'the RSVP case table ran % case(s), not 16', v_n;
    END IF;
    IF cardinality(v_bad) > 0 THEN
        RAISE EXCEPTION 'RSVP cases wrong, % of %: %', cardinality(v_bad), v_n, array_to_string(v_bad, '; ');
    END IF;
    RAISE NOTICE 'rsvp cases: % of 16 as expected -- % accepted (series outside every window, relocated dates, a withdrawn window), % refused 22023 (TIME TBD, original and off dates in a relocated window, open and unreadable windows, the Q9 clip), % refused 42501 by the unchanged series rule',
        v_acc + v_win + v_ser, v_acc, v_win, v_ser;

    -- ---- Q4: nothing stored was deleted or rewritten -----------------------
    SELECT string_agg(id::text || ':' || status || ':' || updated_at::text || ':' || occurrence_date::text, ',' ORDER BY occurrence_date)
      INTO v_stored_after
      FROM public.event_rsvps WHERE reference_id = v_a AND occurrence_date IN ('2026-10-13', '2026-09-22');
    SELECT count(*) INTO v_rsvps FROM public.event_rsvps WHERE organization_id = v_org;
    IF v_stored_after IS DISTINCT FROM v_stored_before OR v_rsvps <> 2 + v_acc THEN
        RAISE EXCEPTION 'stored RSVPs changed: before %, after %; % row(s) where 2 stored + % accepted were expected',
            v_stored_before, v_stored_after, v_rsvps, v_acc;
    END IF;
    RAISE NOTICE 'stored rsvps: 2 of 2 stored on dates now TIME TBD or moved are unchanged, and the organisation holds exactly 2 + % rows', v_acc;

    -- ---- W15: who reads practice_exceptions --------------------------------
    PERFORM set_config('request.jwt.claim.sub', c_parent::text, true);
    SET LOCAL ROLE authenticated;
    SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_parent_ids
      FROM public.practice_exceptions WHERE id = ANY (v_seeded);
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', c_admin::text, true);
    SET LOCAL ROLE authenticated;
    SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_admin_ids
      FROM public.practice_exceptions WHERE id = ANY (v_seeded);
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', c_outsider::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_outsider_n FROM public.practice_exceptions WHERE id = ANY (v_seeded);
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    IF v_admin_ids IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_seeded) AS x)
       OR v_parent_ids IS DISTINCT FROM v_admin_ids
       OR v_outsider_n <> 0 THEN
        RAISE EXCEPTION 'practice_exceptions reads wrong: the admin read % of % seeded, the parent % (same set: %), the non-member %',
            cardinality(v_admin_ids), cardinality(v_seeded), cardinality(v_parent_ids),
            v_parent_ids IS NOT DISTINCT FROM v_admin_ids, v_outsider_n;
    END IF;
    RAISE NOTICE 'exception reads: the parent read % of % seeded rows, the same set as the admin; a non-member read %',
        cardinality(v_parent_ids), cardinality(v_seeded), v_outsider_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- The function's posture is unchanged: SECURITY DEFINER, search_path=public,
-- executable by authenticated and not by PUBLIC.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c_sig constant text := 'public.upsert_team_event_rsvp(uuid, uuid, uuid, text, date, text)';
    v_p record;
BEGIN
    SELECT p.prosecdef, p.proconfig, p.prorettype::regtype::text AS ret,
           coalesce(p.proacl::text, '') AS acl
      INTO v_p FROM pg_proc p WHERE p.oid = c_sig::regprocedure;
    IF NOT v_p.prosecdef OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public'] OR v_p.ret <> 'jsonb' THEN
        RAISE EXCEPTION 'upsert_team_event_rsvp changed posture: definer %, config %, returns %', v_p.prosecdef, v_p.proconfig, v_p.ret;
    END IF;
    IF NOT has_function_privilege('authenticated', c_sig, 'EXECUTE') OR v_p.acl LIKE '%{=X/%' OR v_p.acl LIKE '%,=X/%' THEN
        RAISE EXCEPTION 'upsert_team_event_rsvp grants changed: %', v_p.acl;
    END IF;
    RAISE NOTICE 'posture: upsert_team_event_rsvp is SECURITY DEFINER with search_path=public, returns jsonb, executable by authenticated and not by PUBLIC';
END;
$$;
