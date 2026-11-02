-- Smoke checks for 20261115010000_demo_fall_window.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. Posture: the rule (`demo_seed.season_window`) is a STABLE function with an empty search path that no
--      client role can run, and the choosing function still names it.
--   2. The rule on explicit dates: a date in each window, between them, the fall's last day and the day after,
--      a fall whose anchor is a Monday, a season that ends on a Sunday and one that ends on a Tuesday, and a
--      choice that is neither fall nor spring (refused).
--   3. The rule over every day of 2026 to 2062, against an independent reading of the owner's words (the
--      Monday on or after 17 August, to 31 October): the fall starts on a Monday from 17 to 23 August, ends on
--      31 October of that year, has not ended on the day asked, and is the earliest instance that has not; the
--      spring is still twelve weeks from the Monday on or after 22 March.
--   4. A fall demo and a spring demo for two visitors: the season row, every division and every seeded
--      practice carry the rule's dates; the fall's season does not end on a Sunday and its practices still run
--      from each weekday's first date to its last day, U4's Saturday sessions included.
--
-- Dates are relative to today in the league's zone wherever a demo is started. Every id is generated and every
-- name is the fixture's placeholder; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_fall_visitor   uuid := gen_random_uuid();
    v_spring_visitor uuid := gen_random_uuid();
    v_fall   jsonb;
    v_spring jsonb;
    v_fall_org uuid;
    v_spring_org uuid;
    v_today  date;
    v_expect_start date;
    v_expect_end   date;
    v_n      bigint;
    v_detail text;
    v_total  bigint;
    w        record;
BEGIN
    -- ---- 1. posture ------------------------------------------------------------------
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure('demo_seed.season_window(text, date)')
                      AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=""']) THEN
        RAISE EXCEPTION 'demo_seed.season_window is not a STABLE function with a pinned empty search path';
    END IF;
    IF has_function_privilege('authenticated', 'demo_seed.season_window(text, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'demo_seed.season_window(text, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the season rule is executable by a client role';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.start_demo_session(text)')) !~ 'demo_seed\.season_window' THEN
        RAISE EXCEPTION 'start_demo_session(text) does not name the season rule';
    END IF;
    RAISE NOTICE 'the season rule is a STABLE function with an empty search path, reachable by neither client role, and the choosing function names it';

    -- ---- 2. the rule on explicit dates ---------------------------------------------------
    SELECT count(*) INTO v_n FROM (VALUES
        ('spring', DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        ('fall',   DATE '2026-11-01', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        ('fall',   DATE '2027-05-10', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2027-06-14', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2027-10-31', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2027-11-01', 'spring', DATE '2028-03-27', DATE '2028-06-18'),
        ('fall',   DATE '2027-11-01', 'fall',   DATE '2028-08-21', DATE '2028-10-31'),
        ('fall',   DATE '2026-08-02', 'fall',   DATE '2026-08-17', DATE '2026-10-31'),
        ('fall',   DATE '2026-10-31', 'fall',   DATE '2026-08-17', DATE '2026-10-31'),
        ('fall',   DATE '2029-01-01', 'fall',   DATE '2029-08-20', DATE '2029-10-31'),
        ('spring', DATE '2026-03-22', 'spring', DATE '2026-03-23', DATE '2026-06-14')
    ) v(choice, today, season, season_start, season_end)
    CROSS JOIN LATERAL demo_seed.season_window(v.choice, v.today) x
    WHERE (x.season, x.season_start, x.season_end) IS NOT DISTINCT FROM (v.season, v.season_start, v.season_end);
    IF v_n <> 12 THEN RAISE EXCEPTION 'the season rule is wrong for % of 12 dates', 12 - v_n; END IF;
    BEGIN
        PERFORM demo_seed.season_window('summer', DATE '2027-05-10');
        RAISE EXCEPTION 'a choice that is neither fall nor spring was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'demo_season_unknown' THEN
            RAISE EXCEPTION 'the choice was refused for the wrong reason: %', v_detail;
        END IF;
    END;
    RAISE NOTICE 'the rule gives the right window on 12 dates (in a window, between, the fall''s last day and the day after, a Monday anchor, a Sunday end and a Tuesday end) and refuses a choice that is neither';

    -- ---- 3. the rule over every day of 2026 to 2062 ---------------------------------------
    -- The expected window is read from the owner's words, not from the rule: the Monday on or after 17 August
    -- is the one Monday among 17 to 23 August, and the fall ends on 31 October of that year.
    SELECT count(*) INTO v_total FROM generate_series(DATE '2026-01-01', DATE '2062-12-31', interval '1 day') d;
    IF v_total < 13000 THEN RAISE EXCEPTION 'the walk examines only % days', v_total; END IF;
    SELECT count(*) INTO v_n
      FROM generate_series(DATE '2026-01-01', DATE '2062-12-31', interval '1 day') d
      CROSS JOIN LATERAL demo_seed.season_window('fall', d::date) x
      WHERE NOT (
            extract(isodow FROM x.season_start) = 1
        AND x.season_start BETWEEN make_date(extract(year FROM x.season_start)::integer, 8, 17)
                               AND make_date(extract(year FROM x.season_start)::integer, 8, 23)
        AND x.season_end = make_date(extract(year FROM x.season_start)::integer, 10, 31)
        AND x.season_end >= d::date
        -- the earliest instance that has not ended: last year's ended before the day asked
        AND make_date(extract(year FROM x.season_start)::integer - 1, 10, 31) < d::date);
    IF v_n <> 0 THEN RAISE EXCEPTION 'the fall is wrong on % of % days', v_n, v_total; END IF;
    SELECT count(*) INTO v_n
      FROM generate_series(DATE '2026-01-01', DATE '2062-12-31', interval '1 day') d
      CROSS JOIN LATERAL demo_seed.season_window('spring', d::date) x
      WHERE NOT (
            extract(isodow FROM x.season_start) = 1
        AND x.season_start BETWEEN make_date(extract(year FROM x.season_start)::integer, 3, 22)
                               AND make_date(extract(year FROM x.season_start)::integer, 3, 28)
        AND x.season_end - x.season_start + 1 = (SELECT l.season_weeks * 7 FROM demo_seed.league l)
        AND x.season_end >= d::date);
    IF v_n <> 0 THEN RAISE EXCEPTION 'the spring is wrong on % of % days', v_n, v_total; END IF;
    -- No choice is whichever of the two ends first.
    SELECT count(*) INTO v_n
      FROM generate_series(DATE '2026-01-01', DATE '2062-12-31', interval '1 day') d
      CROSS JOIN LATERAL demo_seed.season_window(NULL, d::date) x
      CROSS JOIN LATERAL demo_seed.season_window('fall', d::date) f
      CROSS JOIN LATERAL demo_seed.season_window('spring', d::date) s
      WHERE (x.season, x.season_end) IS DISTINCT FROM
            (CASE WHEN f.season_end < s.season_end THEN 'fall' ELSE 'spring' END, least(f.season_end, s.season_end));
    IF v_n <> 0 THEN RAISE EXCEPTION 'no choice is not the window that ends first on % days', v_n; END IF;
    RAISE NOTICE 'over % days (2026 to 2062) the fall is the Monday on or after 17 August to 31 October, the spring twelve weeks, and no choice the one that ends first', v_total;

    -- ---- 4. a fall demo and a spring demo -------------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
    VALUES (v_fall_visitor, NULL, '{"password_length": 12}', true),
           (v_spring_visitor, NULL, '{"password_length": 12}', true);
    SELECT (now() AT TIME ZONE (SELECT timezone FROM demo_seed.league))::date INTO v_today;
    -- Today's fall, read independently of the rule: this year's instance, else next year's.
    SELECT (SELECT d::date FROM generate_series(make_date(y, 8, 17), make_date(y, 8, 23), interval '1 day') d
             WHERE extract(isodow FROM d) = 1), make_date(y, 10, 31)
      INTO v_expect_start, v_expect_end
      FROM generate_series(extract(year FROM v_today)::integer, extract(year FROM v_today)::integer + 1) y
     WHERE make_date(y, 10, 31) >= v_today ORDER BY y LIMIT 1;

    PERFORM set_config('request.jwt.claim.sub', v_fall_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_fall_visitor, 'is_anonymous', true)::text, true);
    v_fall := public.start_demo_session('fall');
    PERFORM set_config('request.jwt.claim.sub', v_spring_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_spring_visitor, 'is_anonymous', true)::text, true);
    v_spring := public.start_demo_session('spring');
    v_fall_org := (v_fall ->> 'organization_id')::uuid;
    v_spring_org := (v_spring ->> 'organization_id')::uuid;
    IF v_fall ->> 'season' <> 'fall' OR v_spring ->> 'season' <> 'spring'
       OR v_fall ->> 'season_start' <> v_expect_start::text OR v_fall ->> 'season_end' <> v_expect_end::text THEN
        RAISE EXCEPTION 'the fall demo is not dated % to % (the Monday on or after 17 August to 31 October): % / %',
            v_expect_start, v_expect_end, v_fall, v_spring;
    END IF;

    FOR w IN SELECT * FROM (VALUES (v_fall_org, 'Fall'), (v_spring_org, 'Spring')) x(org, label) LOOP
        SELECT count(*) INTO v_n FROM public.season_settings s
         WHERE s.organization_id = w.org AND s.season_label = w.label
           AND s.name = w.label || ' ' || extract(year FROM s.season_start)::integer
           AND extract(isodow FROM s.season_start) = 1
           AND s.season_end >= v_today;
        IF v_n <> 1 THEN RAISE EXCEPTION 'the % demo has % season row(s) in a window that has not ended, not 1', w.label, v_n; END IF;
        SELECT count(*) INTO v_n FROM public.divisions d JOIN public.season_settings s ON s.id = d.season_settings_id
         WHERE d.organization_id = w.org AND (d.season_start, d.season_end) IS DISTINCT FROM (s.season_start, s.season_end);
        IF v_n <> 0 THEN RAISE EXCEPTION '% division(s) of the % demo do not carry its season''s dates', v_n, w.label; END IF;
        -- Each seeded practice runs from its weekday's first date to the season's last day, inclusive, whatever
        -- weekday that is (the fall ends on 31 October, not on a Sunday).
        SELECT count(*) INTO v_n FROM public.practice_assignments pa
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          JOIN public.season_settings s ON s.organization_id = pa.organization_id
         WHERE pa.organization_id = w.org
           AND (lower(pa.effective_date_range) <> s.season_start + (array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'], ps.day_of_week::text) - 1)
                OR upper(pa.effective_date_range) <> s.season_end + 1
                OR isempty(pa.effective_date_range));
        IF v_n <> 0 THEN RAISE EXCEPTION '% practice(s) of the % demo are not live from their weekday''s first date to its season''s end', v_n, w.label; END IF;
        SELECT count(*) INTO v_n FROM public.practice_assignments WHERE organization_id = w.org;
        IF v_n <> 132 THEN RAISE EXCEPTION 'the % demo holds % seeded practices, not 132', w.label, v_n; END IF;
    END LOOP;
    -- The Saturday sessions (U4) are the latest weekday of the week: they must fall inside the season.
    SELECT count(*) INTO v_n FROM public.practice_assignments pa
      JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
     WHERE pa.organization_id = v_fall_org AND ps.day_of_week::text = 'sat' AND NOT isempty(pa.effective_date_range);
    IF v_n <> 4 THEN RAISE EXCEPTION 'the fall demo holds % live Saturday sessions, not 4', v_n; END IF;
    RAISE NOTICE 'a fall demo (% to %, ending on a %) and a spring demo (% to %): the season, its divisions and 132 seeded practices carry the rule''s dates, the Saturday sessions included',
        v_fall ->> 'season_start', v_fall ->> 'season_end', to_char(v_expect_end, 'FMDay'), v_spring ->> 'season_start', v_spring ->> 'season_end';
END;
$$;

ROLLBACK;
