-- Smoke checks for 20261005000000_rsvp_applied_practice_calendar.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` requires each witness NOTICE to print.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so every read of `practice_exceptions` goes through
-- the real select policy.
--
-- docs/PHASE_8_6_PR12_READERS_PLAN.md §6:
--   W14, Q4  RSVP followed the applied calendar, and stored RSVPs were left
--        alone. **Since 20261022030000 (plan
--        docs/changes/2026-10-22-admin-focus.md, R2)** dropped
--        `upsert_team_event_rsvp` and `event_rsvps`, the head build this runs
--        on has no RSVP to make or keep: both are reduced to checking that the
--        function and the table stay gone. The case table went with them
--        (tests/fixtures/rsvpAppliedCalendarCases.json and its Vitest arm);
--        docs/sql/20261005000000_revert.sql is still checked on a build up to
--        this migration.
--   W15  a member who is not an admin reads the same practice_exceptions rows as
--        an admin; a non-member reads none. The member was a parent until
--        20261024010000 (R3) removed that role; it is now a coach who coaches
--        no team.
-- Every subject set is enumerated from the rows this file SEEDS, never from
-- what a call or a read returned. Every name and id is synthetic.

\set ON_ERROR_STOP on

DO $$
DECLARE
    c_admin  constant uuid := 'd1200000-0000-4000-8000-0000000000a1';
    c_member constant uuid := 'd1200000-0000-4000-8000-0000000000d1';
    c_outsider constant uuid := 'd1200000-0000-4000-8000-0000000000e1';
    v_org uuid; v_loc uuid; v_field uuid; v_season uuid; v_div uuid;
    v_team uuid[] := ARRAY[]::uuid[];
    v_player uuid[] := ARRAY[]::uuid[];
    v_tue uuid; v_thu uuid; v_mon uuid; v_wed uuid;
    v_a uuid; v_b uuid; v_c uuid;
    v_seeded uuid[] := ARRAY[]::uuid[];
    v_id uuid;
    v_live_relocated int; v_live_tbd int; v_withdrawn int; v_open int; v_unreadable int;
    r record;
    v_member_ids uuid[]; v_admin_ids uuid[]; v_outsider_n int;
    i int;
BEGIN
    -- ---- the fixture (as the table owner) -----------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (c_admin, 'd12-admin@example.test', jsonb_build_object('password_length', 16)),
      (c_member, 'd12-member@example.test', jsonb_build_object('password_length', 16)),
      (c_outsider, 'd12-outsider@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES
      (c_admin, 'd12-admin@example.test'), (c_member, 'd12-member@example.test'),
      (c_outsider, 'd12-outsider@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org D12', 'smoke-org-d12') RETURNING id INTO v_org;
    -- The outsider is a member of no organisation at all.
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
      (v_org, c_admin, 'admin'), (v_org, c_member, 'coach');
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
        RAISE EXCEPTION 'the exception fixture does not exercise every window kind: % live relocated, % live time_tbd, % withdrawn, % open, % unreadable',
            v_live_relocated, v_live_tbd, v_withdrawn, v_open, v_unreadable;
    END IF;
    RAISE NOTICE 'exception fixture: % exceptions seeded -- % live relocated, % live time_tbd, % withdrawn, % open-upper, % unreadable-lower',
        cardinality(v_seeded), v_live_relocated, v_live_tbd, v_withdrawn, v_open, v_unreadable;

    -- ---- W15: who reads practice_exceptions --------------------------------
    PERFORM set_config('request.jwt.claim.sub', c_member::text, true);
    SET LOCAL ROLE authenticated;
    SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_member_ids
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
       OR v_member_ids IS DISTINCT FROM v_admin_ids
       OR v_outsider_n <> 0 THEN
        RAISE EXCEPTION 'practice_exceptions reads wrong: the admin read % of % seeded, the member % (same set: %), the non-member %',
            cardinality(v_admin_ids), cardinality(v_seeded), cardinality(v_member_ids),
            v_member_ids IS NOT DISTINCT FROM v_admin_ids, v_outsider_n;
    END IF;
    RAISE NOTICE 'exception reads: a member who coaches no team read % of % seeded rows, the same set as the admin; a non-member read %',
        cardinality(v_member_ids), cardinality(v_seeded), v_outsider_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- W14 and Q4 at head: since 20261022030000 there is no RSVP function or table.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regprocedure('public.upsert_team_event_rsvp(uuid, uuid, uuid, text, date, text)') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                                         AND proname = 'upsert_team_event_rsvp')
       OR to_regclass('public.event_rsvps') IS NOT NULL THEN
        RAISE EXCEPTION 'upsert_team_event_rsvp or event_rsvps is back after 20261022030000 dropped them';
    END IF;
    RAISE NOTICE 'rsvp: upsert_team_event_rsvp and event_rsvps stay dropped (20261022030000)';
END;
$$;
