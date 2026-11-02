-- Smoke checks for 20261114010000_demo_season_choice.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. Posture: both `start_demo_session` functions are definers closed to `anon` and open to signed-in
--      callers; the rule (`demo_seed.season_window`) is reachable by neither client role; the zero-argument
--      function delegates to the one with the choice.
--   2. The rule, on explicit dates: a date in each window, between them, a window's last day and the day
--      after, an anchor that falls on a Sunday; a choice that is neither fall nor spring is refused.
--   3. A fall demo and a spring demo for two visitors: the season row (name, label, year, dates), every
--      division, and every seeded practice carry the chosen window's dates; each season starts on a Monday,
--      the fall is six weeks and the spring the league's twelve; the two demos hold the same people, teams
--      and seeded practices (only the dates differ).
--   4. No choice is the window the date falls in or the next to begin; asking again returns the visitor's
--      own demo in the season it was started in, also once the admin has started a next season in it (named
--      to sort before the first, the case a read without an order gets wrong); the `demo.started` row names
--      the season.
--   5. A choice that is neither is refused for a visitor, before the lock, and leaves no demo behind.
--
-- Dates are relative to today in the league's zone wherever a demo is started; the rule is also run on fixed
-- dates, which it is given as arguments. Every id is generated and every name is the fixture's placeholder;
-- there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_fall_visitor   uuid := gen_random_uuid();
    v_spring_visitor uuid := gen_random_uuid();
    v_default_visitor uuid := gen_random_uuid();
    v_bad_visitor    uuid := gen_random_uuid();
    v_fall   jsonb;
    v_spring jsonb;
    v_default jsonb;
    v_again  jsonb;
    v_next   jsonb;
    v_fall_org uuid;
    v_spring_org uuid;
    v_default_org uuid;
    v_today  date;
    v_n      bigint;
    v_left   text;
    v_detail text;
    v_before bigint;
    w        record;
BEGIN
    -- ---- 1. posture ------------------------------------------------------------------
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'start_demo_session'
       AND NOT (p.prosecdef AND 'search_path=public' = ANY (p.proconfig)
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'not a pinned definer closed to anon and open to signed-in callers: %', v_left;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'start_demo_session';
    IF v_n <> 2 THEN RAISE EXCEPTION 'start_demo_session has % signatures, not 2 (none and the choice)', v_n; END IF;
    IF has_function_privilege('authenticated', 'demo_seed.season_window(text, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'demo_seed.season_window(text, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the season rule is executable by a client role';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.start_demo_session()'::regprocedure) !~ 'start_demo_session\(NULL' THEN
        RAISE EXCEPTION 'start_demo_session() does not delegate to the season choice';
    END IF;
    RAISE NOTICE 'both start_demo_session functions are pinned definers open to signed-in callers only; the rule is reachable by neither client role; the zero-argument one delegates';

    -- ---- 2. the rule ------------------------------------------------------------------
    SELECT count(*) INTO v_n FROM (VALUES
        ('spring', DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        ('fall',   DATE '2026-11-01', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        ('fall',   DATE '2027-05-10', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2027-06-14', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2027-09-12', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2027-09-13', 'spring', DATE '2028-03-27', DATE '2028-06-18'),
        ('fall',   DATE '2027-09-13', 'fall',   DATE '2028-08-07', DATE '2028-09-17'),
        ('fall',   DATE '2026-08-02', 'fall',   DATE '2026-08-03', DATE '2026-09-13'),
        ('spring', DATE '2026-03-22', 'spring', DATE '2026-03-23', DATE '2026-06-14')
    ) v(choice, today, season, season_start, season_end)
    CROSS JOIN LATERAL demo_seed.season_window(v.choice, v.today) x
    WHERE (x.season, x.season_start, x.season_end) IS NOT DISTINCT FROM (v.season, v.season_start, v.season_end);
    IF v_n <> 10 THEN RAISE EXCEPTION 'the season rule is wrong for % of 10 dates', 10 - v_n; END IF;
    BEGIN
        PERFORM demo_seed.season_window('summer', DATE '2027-05-10');
        RAISE EXCEPTION 'a choice that is neither fall nor spring was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'demo_season_unknown' THEN
            RAISE EXCEPTION 'the choice was refused for the wrong reason: %', v_detail;
        END IF;
    END;
    RAISE NOTICE 'the rule gives the right window on 10 dates (in a window, between, the last day, the day after, an anchor on a Sunday) and refuses a choice that is neither';

    -- ---- 3. a fall demo and a spring demo ----------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
    VALUES (v_fall_visitor, NULL, '{"password_length": 12}', true),
           (v_spring_visitor, NULL, '{"password_length": 12}', true),
           (v_default_visitor, NULL, '{"password_length": 12}', true),
           (v_bad_visitor, NULL, '{"password_length": 12}', true);
    SELECT (now() AT TIME ZONE (SELECT timezone FROM demo_seed.league))::date INTO v_today;

    PERFORM set_config('request.jwt.claim.sub', v_fall_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_fall_visitor, 'is_anonymous', true)::text, true);
    v_fall := public.start_demo_session('fall');
    PERFORM set_config('request.jwt.claim.sub', v_spring_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_spring_visitor, 'is_anonymous', true)::text, true);
    v_spring := public.start_demo_session('spring');
    v_fall_org := (v_fall ->> 'organization_id')::uuid;
    v_spring_org := (v_spring ->> 'organization_id')::uuid;
    IF v_fall ->> 'season' <> 'fall' OR v_spring ->> 'season' <> 'spring'
       OR (v_fall ->> 'existing')::boolean OR (v_spring ->> 'existing')::boolean THEN
        RAISE EXCEPTION 'the calls did not return a new fall and a new spring demo: % and %', v_fall, v_spring;
    END IF;

    FOR w IN SELECT * FROM (VALUES (v_fall_org, v_fall, 'Fall', 42), (v_spring_org, v_spring, 'Spring', 84)) x(org, res, label, days) LOOP
        SELECT count(*) INTO v_n FROM public.season_settings s
         WHERE s.organization_id = w.org AND s.season_label = w.label
           AND s.name = w.label || ' ' || extract(year FROM s.season_start)::integer
           AND s.season_year = extract(year FROM s.season_start)::integer
           AND s.season_start::text = w.res ->> 'season_start' AND s.season_end::text = w.res ->> 'season_end'
           AND extract(isodow FROM s.season_start) = 1 AND s.season_end - s.season_start + 1 = w.days
           AND s.season_end >= v_today AND s.season_end <= v_today + 380;
        IF v_n <> 1 THEN RAISE EXCEPTION 'the % demo''s season row is not the chosen window as returned (%)', w.label, w.res; END IF;
        SELECT count(*) INTO v_n FROM public.divisions d JOIN public.season_settings s ON s.id = d.season_settings_id
         WHERE d.organization_id = w.org AND (d.season_start, d.season_end) IS DISTINCT FROM (s.season_start, s.season_end);
        IF v_n <> 0 THEN RAISE EXCEPTION '% division(s) of the % demo do not carry its season''s dates', v_n, w.label; END IF;
        SELECT count(*) INTO v_n FROM public.divisions WHERE organization_id = w.org;
        IF v_n <> 21 THEN RAISE EXCEPTION 'the % demo has % divisions, not 21', w.label, v_n; END IF;
        SELECT count(*) INTO v_n FROM public.practice_assignments pa
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          JOIN public.season_settings s ON s.organization_id = pa.organization_id
         WHERE pa.organization_id = w.org
           AND (lower(pa.effective_date_range) <> s.season_start + (array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'], ps.day_of_week::text) - 1)
                OR upper(pa.effective_date_range) <> s.season_end + 1);
        IF v_n <> 0 THEN RAISE EXCEPTION '% practice(s) of the % demo are not live from their weekday''s first date to its season''s end', v_n, w.label; END IF;
        SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = w.org;
        IF v_n <> 132 THEN RAISE EXCEPTION 'the % demo holds % seeded practices, not 132', w.label, v_n; END IF;
    END LOOP;
    IF (SELECT count(*) FROM public.teams WHERE organization_id = v_fall_org)
           <> (SELECT count(*) FROM public.teams WHERE organization_id = v_spring_org)
       OR (SELECT count(*) FROM public.players WHERE organization_id = v_fall_org)
           <> (SELECT count(*) FROM public.players WHERE organization_id = v_spring_org)
       OR (SELECT count(*) FROM public.coaches WHERE organization_id = v_fall_org)
           <> (SELECT count(*) FROM public.coaches WHERE organization_id = v_spring_org)
       OR (SELECT count(*) FROM public.teams WHERE organization_id = v_fall_org) <> 128 THEN
        RAISE EXCEPTION 'the fall and the spring demo are not the same 128-team league';
    END IF;
    RAISE NOTICE 'a fall demo (%) and a spring demo (%): the season, its 21 divisions and 132 seeded practices carry the window, each starts on a Monday, six weeks and twelve; the same 128 teams and people',
        v_fall ->> 'season_start', v_spring ->> 'season_start';

    -- ---- 4. no choice, asking again, the audit row ---------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_default_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_default_visitor, 'is_anonymous', true)::text, true);
    v_default := public.start_demo_session();
    v_default_org := (v_default ->> 'organization_id')::uuid;
    SELECT * INTO w FROM demo_seed.season_window(NULL, v_today);
    IF v_default ->> 'season' IS DISTINCT FROM w.season OR v_default ->> 'season_start' IS DISTINCT FROM w.season_start::text
       OR v_default ->> 'season_end' IS DISTINCT FROM w.season_end::text
       OR NOT EXISTS (SELECT 1 FROM public.season_settings s WHERE s.organization_id = v_default_org
                         AND s.season_start = w.season_start AND s.season_end = w.season_end) THEN
        RAISE EXCEPTION 'a demo started with no choice is not in the window the date falls in or the next to begin: % (wanted %)', v_default, w;
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_fall_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_fall_visitor, 'is_anonymous', true)::text, true);
    v_again := public.start_demo_session('spring');
    IF NOT (v_again ->> 'existing')::boolean OR (v_again ->> 'organization_id')::uuid <> v_fall_org
       OR v_again ->> 'season' <> 'fall' OR v_again ->> 'season_start' <> v_fall ->> 'season_start' THEN
        RAISE EXCEPTION 'asking again for the other season did not return the visitor''s own fall demo: %', v_again;
    END IF;
    -- The demo's admin starts a next season from it, named to sort before the first by (organization, name), the
    -- index the planner reads; it is made later than the first by hand (one transaction shares one now()).
    v_next := public.admin_create_season_from(
        (SELECT id FROM public.season_settings WHERE organization_id = v_fall_org),
        'Autumn ' || (extract(year FROM (v_fall ->> 'season_end')::date + 120))::integer,
        (extract(year FROM (v_fall ->> 'season_end')::date + 120))::integer,
        (v_fall ->> 'season_end')::date + 120, (v_fall ->> 'season_end')::date + 200);
    UPDATE public.season_settings SET created_at = created_at + interval '1 minute' WHERE id = (v_next ->> 'id')::uuid;
    IF (SELECT count(*) FROM public.season_settings WHERE organization_id = v_fall_org) <> 2 THEN
        RAISE EXCEPTION 'the fall demo does not hold the second season the admin started';
    END IF;
    v_again := public.start_demo_session('spring');
    IF NOT (v_again ->> 'existing')::boolean OR v_again ->> 'season' IS DISTINCT FROM 'fall'
       OR v_again ->> 'season_start' IS DISTINCT FROM v_fall ->> 'season_start'
       OR v_again ->> 'season_end' IS DISTINCT FROM v_fall ->> 'season_end' THEN
        RAISE EXCEPTION 'asking again in a demo with a second season did not return the season it was started in: %', v_again;
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_fall_org AND action = 'demo.started' AND metadata ->> 'season' = 'fall';
    IF v_n <> 1 THEN RAISE EXCEPTION 'the fall demo has % demo.started rows naming the fall, not 1', v_n; END IF;
    RAISE NOTICE 'no choice is the % window (% to %); asking again for the other season returns the visitor''s own demo, in its own season, also with a second season started in it; demo.started names the season',
        w.season, w.season_start, w.season_end;

    -- ---- 5. a choice that is neither is refused ---------------------------------------------
    SELECT count(*) INTO v_before FROM public.organizations WHERE demo_owner IS NOT NULL;
    PERFORM set_config('request.jwt.claim.sub', v_bad_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_bad_visitor, 'is_anonymous', true)::text, true);
    BEGIN
        PERFORM public.start_demo_session('Fall');
        RAISE EXCEPTION 'a demo started for a choice that is neither fall nor spring' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'demo_season_unknown' THEN
            RAISE EXCEPTION 'the choice was refused for the wrong reason: %', v_detail;
        END IF;
    END;
    IF (SELECT count(*) FROM public.organizations WHERE demo_owner IS NOT NULL) <> v_before
       OR EXISTS (SELECT 1 FROM public.organizations WHERE demo_owner = v_bad_visitor) THEN
        RAISE EXCEPTION 'the refused choice left a demo organization behind';
    END IF;
    RAISE NOTICE 'a choice that is neither fall nor spring (case-folded included) is refused with demo_season_unknown and leaves no demo behind';
END;
$$;

ROLLBACK;
