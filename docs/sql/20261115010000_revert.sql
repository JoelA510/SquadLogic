-- Revert for 20261115010000_demo_fall_window.sql
--
-- Restores `demo_seed.season_window(text, date)` to the body 20261114010000 created (checked by md5 at the
-- end, carriage returns removed) and its comment: the fall is again the Monday on or after 2 August, six
-- weeks. Nothing else was changed by the migration, so nothing else is restored.
--
-- **What it cannot undo.** A demo started while the migration was in place keeps the dates it was started
-- with (a fall that ran to 31 October) until it expires and is purged (a demo lives 30 minutes). The NOTICE
-- counts the live demos whose fall season ends on 31 October.
--
-- **Revert the frontend with it.** The entry page of the app deployed with the migration describes the fall as
-- mid-August to 31 October (`frontend/src/lib/demoSeasons.js`) and says its evening practices are flagged;
-- after this revert the server dates a fall demo in the early fall instead (the page shows the server's own
-- dates once the demo starts). Redeploy the previous frontend with it.

BEGIN;

DO $revert$
BEGIN
    RAISE NOTICE 'this revert leaves % live demo organization(s) dated in a fall that runs to 31 October to expire in the dates they were started with',
        (SELECT count(*) FROM public.organizations o
          WHERE o.demo_expires_at > now()
            AND EXISTS (SELECT 1 FROM public.season_settings s
                         WHERE s.organization_id = o.id AND s.season_label = 'Fall'
                           AND extract(month FROM s.season_end) = 10 AND extract(day FROM s.season_end) = 31));
END;
$revert$;

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
            v_month := 8; v_day := 2; v_weeks := 6;
        ELSE
            v_month := 3; v_day := 22;
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
            v_end := v_start + v_weeks * 7 - 1;
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
    'The demo''s season window: fall (the Monday on or after 2 August, 6 weeks) or spring (the Monday on or after 22 March, season_weeks weeks), the earliest instance not ended on p_today; no choice is the one that ends first. Refuses any other choice (22023, demo_season_unknown).';

DO $revert$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = 'demo_seed.season_window(text, date)'::regprocedure;
    IF v_md5 IS DISTINCT FROM 'f295e02cdf5917c7ccbf012e356a8a8a' THEN
        RAISE EXCEPTION 'demo_seed.season_window was not restored to its 20261114010000 body (md5 %)', v_md5;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = 'demo_seed.season_window(text, date)'::regprocedure
                      AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=""']) THEN
        RAISE EXCEPTION 'the restored season rule is not a STABLE function with a pinned empty search path';
    END IF;
    IF has_function_privilege('authenticated', 'demo_seed.season_window(text, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'demo_seed.season_window(text, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the restored season rule is executable by a client role';
    END IF;
    IF (SELECT w.season_start || ' ' || w.season_end FROM demo_seed.season_window('fall', DATE '2027-01-01') w)
       IS DISTINCT FROM '2027-08-02 2027-09-12' THEN
        RAISE EXCEPTION 'the restored season rule does not date the fall as the early fall';
    END IF;
    RAISE NOTICE 'revert verified: the season rule is back as at 20261114010000 (the fall is the Monday on or after 2 August, six weeks)';
END;
$revert$;

COMMIT;
