-- Smoke checks for 20261002000000_practice_exceptions_daylight.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` requires each witness NOTICE to print.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so every save runs the REAL RPC as a real org
-- admin with RLS on: the writer is SECURITY INVOKER.
--
-- 8.9 plan D13, one section each:
--   1. the CHECKs: both new tbd_reasons and `daylight` admitted; a misspelt
--      reason and an unknown cause refused (23514)
--   2. the writer: an exception naming a same-save NEW row by its (team, slot,
--      range) key is recorded and linked to exactly that row -- not the
--      team's other row on the same slot; a key the save does not carry, and
--      an entry naming its row twice, are refused (22023); a withdrawn team
--      (no row) stays in the roster-enumerated teams_without_practice
--   3. the readers: the truncated row plus its out-of-range exception yield
--      no occurrence on or after D, expanded exactly as calendar-feed reads
--      practice_assignments (it reads no exception)
-- The revert (old CHECKs and writer back) is checked by run.sh's revert
-- stage on a database built up to this migration, with daylight rows planted.
--
-- Expectations are enumerated from what each save SENT, never from what it
-- wrote back.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The CHECKs
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid; v_loc uuid; v_field uuid; v_s uuid; v_d uuid; v_t uuid; v_slot uuid; v_pa uuid;
    v_state text;
    v_admitted int := 0;
    v_refused int := 0;
    v_reason text;
    v_windows text[] := ARRAY['[2026-09-07,2026-09-07]', '[2026-09-14,2026-09-14]'];
    i int := 0;
BEGIN
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 6B1', 'smoke-org-6b1') RETURNING id INTO v_org;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'P6B1 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'P6B1 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P6B1 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'P6B1 U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'P6B1 Team') RETURNING id INTO v_t;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_slot;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t, v_slot, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_pa;

    -- Both new reasons, each on a repair's own cause (D13 c: the daylight
    -- part is only in the reason).
    FOREACH v_reason IN ARRAY ARRAY['past-sunset', 'sunset-unknown'] LOOP
        i := i + 1;
        INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason, cause_kind)
          VALUES (v_org, v_s, v_t, v_pa, v_windows[i]::daterange, 'time_tbd', v_reason, 'blackout');
        v_admitted := v_admitted + 1;
    END LOOP;
    IF v_admitted <> 2 THEN
        RAISE EXCEPTION 'expected both new tbd_reasons admitted, got %', v_admitted;
    END IF;
    BEGIN
        INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
          VALUES (v_org, v_s, v_t, v_pa, '[2026-09-21,2026-09-21]', 'time_tbd', 'past-sunet');
    EXCEPTION WHEN check_violation THEN
        v_refused := v_refused + 1;
    END;
    IF v_refused <> 1 THEN
        RAISE EXCEPTION 'the misspelt tbd_reason past-sunet was admitted';
    END IF;
    RAISE NOTICE 'tbd_reason CHECK: past-sunset and sunset-unknown admitted, 2 of 2; the misspelling past-sunet refused 23514';

    INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason, cause_kind)
      VALUES (v_org, v_s, v_t, v_pa, '[2026-10-19,2026-11-30]', 'time_tbd', 'past-sunset', 'daylight');
    v_state := NULL;
    BEGIN
        INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason, cause_kind)
          VALUES (v_org, v_s, v_t, v_pa, '[2026-09-28,2026-09-28]', 'time_tbd', 'past-sunset', 'dusk');
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
        RAISE EXCEPTION 'the unknown cause_kind dusk was admitted';
    END IF;
    RAISE NOTICE 'cause_kind CHECK: daylight admitted; the unknown cause dusk refused 23514';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The writer: a same-save new-row exception
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := '6b000000-0000-4000-8000-0000000000a1';
    v_org uuid; v_loc uuid; v_field uuid; v_s uuid; v_d uuid; v_ta uuid; v_tb uuid; v_mon uuid;
    -- Team A's earlier row on the Monday slot, from an earlier save.
    c_old text := '[2026-09-01,2026-09-30]';
    -- The Apply: Team A's new placement, truncated the day before D.
    c_new text := '[2026-10-01,2026-10-18]';
    c_d date := '2026-10-19';
    c_window text := '[2026-10-19,2026-11-30]';
    v_old_id uuid; v_new_id uuid;
    v_res jsonb;
    v_exc jsonb;
    v_sent jsonb;
    v_state text; v_msg text;
    v_refusals int := 0;
    v_roster_without text;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (v_admin, 'p6b-admin@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'p6b-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 6B2', 'smoke-org-6b2') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'P6B2 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'P6B2 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'P6B2 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'P6B2 U10') RETURNING id INTO v_d;
    -- The roster: A is truncated; B's placement was withdrawn whole (no row).
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'P6B Team A') RETURNING id INTO v_ta;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'P6B Team B') RETURNING id INTO v_tb;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_field, 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_mon;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    -- An earlier ordinary save, with the v2 argument set (#461).
    PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
        jsonb_build_array(jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_old)),
        false);

    -- Refused: a key this save's assignments do not carry.
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_old),
                jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_new)),
            exceptions => jsonb_build_array(jsonb_build_object(
                'new_assignment', jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon,
                                                     'effective_date_range', '[2026-10-01,2026-10-25]'),
                'window', c_window, 'kind', 'time_tbd', 'tbd_reason', 'past-sunset', 'cause_kind', 'daylight')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        IF v_state = '22023' AND v_msg LIKE '%not a (team, slot, range) key%' THEN v_refusals := v_refusals + 1; END IF;
    END;
    -- Refused: an entry naming its row both ways.
    BEGIN
        PERFORM public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
            jsonb_build_array(
                jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_old),
                jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_new)),
            exceptions => jsonb_build_array(jsonb_build_object(
                'assignment_id', (SELECT id FROM public.practice_assignments WHERE team_id = v_ta),
                'new_assignment', jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_new),
                'window', c_window, 'kind', 'time_tbd', 'tbd_reason', 'past-sunset', 'cause_kind', 'daylight')));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        IF v_state = '22023' AND v_msg LIKE '%names both assignment_id and new_assignment%' THEN v_refusals := v_refusals + 1; END IF;
    END;
    IF v_refusals <> 2
       OR (SELECT count(*) FROM public.practice_assignments WHERE team_id = v_ta) <> 1
       OR EXISTS (SELECT 1 FROM public.practice_exceptions WHERE organization_id = v_org) THEN
        RAISE EXCEPTION 'expected 2 refusals (22023) that wrote nothing, got % (last: % %)', v_refusals, v_state, v_msg;
    END IF;
    RAISE NOTICE 'new_assignment refusals: a key the save does not carry and an entry naming its row twice were each refused 22023, 2 of 2; nothing written';

    -- The Apply: the old row re-sent, the truncated placement added, and its
    -- remainder named by the NEW row's key.
    v_sent := jsonb_build_array(jsonb_build_object(
        'new_assignment', jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_new),
        'window', c_window, 'kind', 'time_tbd', 'tbd_reason', 'past-sunset', 'cause_kind', 'daylight'));
    v_res := public.persist_practice_schedule(jsonb_build_object('season_settings_id', v_s),
        jsonb_build_array(
            jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_old),
            jsonb_build_object('team_id', v_ta, 'practice_slot_id', v_mon, 'effective_date_range', c_new)),
        exceptions => v_sent);
    RESET ROLE;

    -- The two rows, found by the keys SENT.
    SELECT id INTO v_old_id FROM public.practice_assignments
     WHERE team_id = v_ta AND practice_slot_id = v_mon AND effective_date_range = c_old::daterange;
    SELECT id INTO v_new_id FROM public.practice_assignments
     WHERE team_id = v_ta AND practice_slot_id = v_mon AND effective_date_range = c_new::daterange;
    IF v_old_id IS NULL OR v_new_id IS NULL OR v_old_id = v_new_id THEN
        RAISE EXCEPTION 'expected Team A to hold two distinct rows on the Monday slot, got % and %', v_old_id, v_new_id;
    END IF;

    -- One recorded per entry SENT, each on the row its key names.
    IF jsonb_array_length(v_res->'exceptions_recorded') <> jsonb_array_length(v_sent) THEN
        RAISE EXCEPTION 'sent % exception(s), the save recorded %', jsonb_array_length(v_sent), jsonb_array_length(v_res->'exceptions_recorded');
    END IF;
    SELECT to_jsonb(pe.*) INTO v_exc FROM public.practice_exceptions pe
     WHERE pe.organization_id = v_org AND pe.team_id = v_ta;
    IF (SELECT count(*) FROM public.practice_exceptions WHERE organization_id = v_org) <> 1
       OR (v_exc->>'assignment_id')::uuid IS DISTINCT FROM v_new_id
       OR (v_exc->>'window')::daterange <> c_window::daterange
       OR v_exc->>'kind' <> 'time_tbd'
       OR v_exc->>'tbd_reason' <> 'past-sunset'
       OR v_exc->>'cause_kind' <> 'daylight'
       OR v_exc->>'cause_id' IS NOT NULL
       OR (v_exc->>'run_id')::uuid IS DISTINCT FROM (v_res->>'run_id')::uuid THEN
        RAISE EXCEPTION 'the daylight exception is not the one sent, on the new row % (not the old row %): %', v_new_id, v_old_id, v_exc;
    END IF;
    -- The window lies outside the row's range on purpose (the retirement contract).
    IF lower(c_window::daterange) < upper(c_new::daterange) OR lower(c_window::daterange) <> c_d THEN
        RAISE EXCEPTION 'the remainder window % should start at D % and lie after the row''s range %', c_window, c_d, c_new;
    END IF;
    IF (SELECT count(*) FROM public.audit_log
         WHERE organization_id = v_org AND action = 'practice.exception_recorded'
           AND resource_id = (v_exc->>'id')::uuid AND user_id = v_admin) <> 1 THEN
        RAISE EXCEPTION 'the daylight exception % was not audited once as practice.exception_recorded', v_exc->>'id';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'teams_time_tbd') t
                    WHERE (t.value->>'team_id')::uuid = v_ta AND t.value->>'tbd_reason' = 'past-sunset') THEN
        RAISE EXCEPTION 'teams_time_tbd does not name Team A''s daylight window: %', v_res->'teams_time_tbd';
    END IF;
    RAISE NOTICE 'new-row exception: 1 of 1 sent recorded on the save''s new row (Team A, Monday, [2026-10-01,2026-10-18]), not the team''s other row on that slot; window [2026-10-19,2026-11-30] past-sunset/daylight, cause_id NULL, audited once';

    -- (b) deferred: the withdrawn team has no row and no exception, and the
    -- writer's roster-enumerated list still names it.
    SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO v_roster_without
      FROM public.teams t
     WHERE t.division_id = v_d
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'teams_without_practice') w
                    WHERE (w.value->>'team_id')::uuid = t.id);
    IF v_roster_without IS DISTINCT FROM 'P6B Team B' OR (v_res->>'season_team_count')::int <> 2 THEN
        RAISE EXCEPTION 'teams_without_practice should name exactly the withdrawn P6B Team B of 2 roster teams, got % of %', v_roster_without, v_res->>'season_team_count';
    END IF;
    RAISE NOTICE 'withdrawn team: P6B Team B holds no row and no exception, and teams_without_practice names it, from 2 roster teams';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The readers never show the dark remainder
-- ---------------------------------------------------------------------------
-- calendar-feed (supabase/functions/calendar-feed/index.ts) reads
-- practice_assignments with its slot's weekday and expands each row's
-- effective_date_range -- canonically [lower, upper) -- weekly on that
-- weekday (_shared/calendar/icsFeed.ts dateRangeBounds). It reads no
-- practice_exceptions. The same expansion, over the rows section 2 saved:
DO $$
DECLARE
    v_ta uuid;
    c_d date := '2026-10-19';
    v_n int; v_last date; v_dark int;
BEGIN
    SELECT t.id INTO v_ta FROM public.teams t WHERE t.name = 'P6B Team A';
    WITH occurrences AS (
        SELECT day::date AS date
          FROM public.practice_assignments pa
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          CROSS JOIN LATERAL generate_series(lower(pa.effective_date_range),
                                             upper(pa.effective_date_range) - 1,
                                             interval '1 day') AS day
         WHERE pa.team_id = v_ta
           AND lower(to_char(day, 'dy')) = ps.day_of_week::text
    )
    SELECT count(*), max(date), count(*) FILTER (WHERE date >= c_d)
      INTO v_n, v_last, v_dark
      FROM occurrences;
    -- Mondays 09-07..09-28 (4) and 10-05, 10-12 (2); none from D 10-19 on.
    IF v_n <> 6 OR v_last <> '2026-10-12' OR v_dark <> 0 THEN
        RAISE EXCEPTION 'expanding Team A''s rows gave % occurrence(s), last %, % on or after D %', v_n, v_last, v_dark, c_d;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe
                    JOIN public.practice_assignments pa ON pa.id = pe.assignment_id
                   WHERE pe.team_id = v_ta AND pe.cause_kind = 'daylight'
                     AND lower(pe."window") >= upper(pa.effective_date_range)) THEN
        RAISE EXCEPTION 'expected Team A''s daylight exception to lie wholly after its row''s range';
    END IF;
    RAISE NOTICE 'reader: Team A''s rows expand to 6 Monday occurrences, the last 2026-10-12, 0 on or after D 2026-10-19; its daylight window lies wholly after the row''s range';
END;
$$;
