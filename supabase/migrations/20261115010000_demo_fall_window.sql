-- The demo's fall runs from mid-August to the end of October (owner decision 2026-11-02; plan
-- docs/changes/2026-11-02-demo-fall-window.md, amending docs/changes/2026-11-01-demo-season-selection.md).
--
-- **Why.** 20261114010000 dated the fall as an "early fall": the Monday on or after 2 August plus six weeks,
-- so that no unlit slot of the seeded grid could be near sunset on any day of it. The price was a fall that
-- ends in mid-September. The owner's answer: "Fall can go from mid-august, like August 17th 2026, through end
-- of October (10/31/26)", and the sunset flags that follow (a 19:00 end is past sunset from about 24
-- September) are wanted: "Flag them, as coaches or orgs may be comfortable with extra conditions determined
-- outside of the app ... A warning keeps room for that, refusal would break configs that users may otherwise
-- stick with." The fall demo therefore opens with sunset flags on its 19:00 unlit practices, by design.
--
-- **The change.** `demo_seed.season_window(p_choice, p_today)` is replaced, wholesale and on the deployed
-- body (lesson 70). A window is a Monday anchor and either a length in weeks or an end date:
--   - spring: the Monday on or after 22 March, `demo_seed.league.season_weeks` (12) weeks. Unchanged.
--   - fall: the Monday on or after 17 August, to 31 October of the same year. The end is a date, not a count
--     of weeks, so the length follows the calendar (2026: Monday 17 August to Saturday 31 October, 76 days;
--     2027: 23 August to Sunday 31 October, 70 days).
-- Everything else is the deployed body: the instance chosen is the earliest whose last day is on or after
-- `p_today` (so 31 October still belongs to the fall and 1 November takes next year's), no choice is the
-- instance that ends first (the window the date falls in, or else the next to begin), and a choice but
-- 'fall' or 'spring' is refused (22023, detail `demo_season_unknown`).
--
-- **Not touched.** `start_demo_session(text)` and `start_demo_session()` are not replaced: nothing in them
-- assumes a length (the dates are the rule's `season_start` and `season_end`, and a seeded practice runs from
-- its weekday's first date to `season_end`, which no longer has to be a Sunday). No table, column, policy,
-- grant, expiry (the demo still lives 30 minutes) or purge changes. A demo already started keeps the dates it
-- was started with.
--
-- `CREATE OR REPLACE` keeps the function's owner and privileges and resets its `SET` clauses (lesson 40),
-- so the pinned search path is stated again; the end-state check requires neither client role to be able to
-- run it.
--
-- Reversible: docs/sql/20261115010000_revert.sql restores the deployed body (md5 checked). Smoke:
-- docs/sql/20261115010000_smoke.sql. pgTAP: supabase/tests/demo_sessions.sql and demo_practice_schedule.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting body is checked: the one 20261114010000 created, as deployed.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_md5 text;
BEGIN
    -- Carriage returns stripped, as 20261114010000 does: a body stored with CRLF line ends is the same text.
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure('demo_seed.season_window(text, date)');
    IF v_md5 IS DISTINCT FROM 'f295e02cdf5917c7ccbf012e356a8a8a' THEN
        RAISE EXCEPTION 'demo_seed.season_window is not the body this migration replaces (md5 %, expected f295e02cdf5917c7ccbf012e356a8a8a)', v_md5;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The rule, from the deployed body (20261114010000).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION demo_seed.season_window(p_choice text, p_today date,
                                        OUT season text, OUT season_start date, OUT season_end date)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
    v_candidates text[];
    v_c      text;
    v_month  integer;
    v_day    integer;
    v_weeks  integer;
    v_end_month integer;
    v_end_day   integer;
    v_year   integer;
    v_first  date;
    v_start  date;
    v_end    date;
BEGIN
    IF p_today IS NULL THEN
        RAISE EXCEPTION 'A demo season is dated from a day' USING ERRCODE = '22004';
    END IF;
    IF p_choice IS NOT NULL AND p_choice NOT IN ('fall', 'spring') THEN
        RAISE EXCEPTION 'Unknown demo season: choose fall or spring'
            USING ERRCODE = '22023', DETAIL = 'demo_season_unknown';
    END IF;

    v_candidates := CASE WHEN p_choice IS NULL THEN ARRAY['fall', 'spring'] ELSE ARRAY[p_choice] END;
    FOREACH v_c IN ARRAY v_candidates LOOP
        IF v_c = 'fall' THEN
            -- Mid-August to the end of October (owner, 2026-11-02): the end is a date, not a number of weeks.
            v_month := 8; v_day := 17; v_weeks := NULL; v_end_month := 10; v_end_day := 31;
        ELSE
            v_month := 3; v_day := 22; v_end_month := NULL; v_end_day := NULL;
            SELECT l.season_weeks INTO v_weeks FROM demo_seed.league l;
            IF v_weeks IS NULL THEN
                RAISE EXCEPTION 'The demo league is not available' USING ERRCODE = 'P0001', DETAIL = 'demo_seed_empty';
            END IF;
        END IF;
        -- A window ends in the year it starts: this year's instance, else next year's.
        v_year := extract(year FROM p_today)::integer;
        LOOP
            v_first := make_date(v_year, v_month, v_day);
            v_start := v_first + ((8 - extract(isodow FROM v_first)::integer) % 7);   -- the Monday on or after
            v_end := CASE WHEN v_end_month IS NULL THEN v_start + v_weeks * 7 - 1
                          ELSE make_date(v_year, v_end_month, v_end_day) END;
            EXIT WHEN v_end >= p_today;
            v_year := v_year + 1;
        END LOOP;
        -- No choice: the instance that ends first (fall wins a tie, which two windows cannot make).
        IF season IS NULL OR v_end < season_end THEN
            season := v_c; season_start := v_start; season_end := v_end;
        END IF;
    END LOOP;
END;
$function$;

COMMENT ON FUNCTION demo_seed.season_window(text, date) IS
    'The demo''s season window: fall (the Monday on or after 17 August, to 31 October) or spring (the Monday on or after 22 March, season_weeks weeks), the earliest instance not ended on p_today; no choice is the one that ends first. Refuses any other choice (22023, demo_season_unknown).';

-- ---------------------------------------------------------------------------
-- 3. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_def text;
    v_n integer;
BEGIN
    -- The rule, on dates of its own: a date in each window, between them, the last day of the fall and the day
    -- after, a fall whose anchor falls on a Monday (2026), a season that ends on a Sunday (2027) and on a Tuesday
    -- (2028), and a choice made in the autumn. (tests/demoSeasons.test.js holds the full table, in JavaScript
    -- and in pgTAP, against this function.)
    SELECT count(*) INTO v_n FROM (VALUES
        ('spring', DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        ('fall',   DATE '2026-11-01', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        (NULL,     DATE '2027-06-14', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2027-10-31', 'fall',   DATE '2027-08-23', DATE '2027-10-31'),
        (NULL,     DATE '2027-11-01', 'spring', DATE '2028-03-27', DATE '2028-06-18'),
        ('fall',   DATE '2026-08-02', 'fall',   DATE '2026-08-17', DATE '2026-10-31'),
        ('fall',   DATE '2026-10-31', 'fall',   DATE '2026-08-17', DATE '2026-10-31'),
        ('fall',   DATE '2027-11-01', 'fall',   DATE '2028-08-21', DATE '2028-10-31'),
        ('spring', DATE '2026-03-22', 'spring', DATE '2026-03-23', DATE '2026-06-14')
    ) v(choice, today, season, season_start, season_end)
    CROSS JOIN LATERAL demo_seed.season_window(v.choice, v.today) w
    WHERE (w.season, w.season_start, w.season_end) IS NOT DISTINCT FROM (v.season, v.season_start, v.season_end);
    IF v_n <> 10 THEN
        RAISE EXCEPTION 'demo_seed.season_window gives the wrong window for % of 10 checked dates', 10 - v_n;
    END IF;

    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = to_regprocedure('demo_seed.season_window(text, date)');
    IF v_def !~ 'demo_season_unknown' OR v_def !~ 'demo_seed_empty' OR v_def !~ 'season_weeks' THEN
        RAISE EXCEPTION 'demo_seed.season_window lost its refusal or the league''s season length';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure('demo_seed.season_window(text, date)')
                      AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=""']) THEN
        RAISE EXCEPTION 'demo_seed.season_window is not a STABLE function with a pinned empty search path';
    END IF;
    IF has_function_privilege('authenticated', 'demo_seed.season_window(text, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'demo_seed.season_window(text, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the season rule is executable by a client role';
    END IF;
    -- The two functions that call it are the deployed ones: the choosing function still names the rule.
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.start_demo_session(text)')) !~ 'demo_seed\.season_window' THEN
        RAISE EXCEPTION 'start_demo_session(text) no longer names demo_seed.season_window';
    END IF;
END;
$check$;

COMMIT;
