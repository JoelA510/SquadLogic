-- Smoke checks for 20261118010000_drop_players_placement_eligible.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. Exactly one column went: `players.placement_eligible` is absent, its four siblings from 20260530000000
--      (`registration_status`, `experience_years`, `play_up_requested`, `buddy_request_name`) are present, and a
--      write that names the dropped column is refused (42703).
--   2. No function body in a non-system schema names it. PL/pgSQL is not checked when a column goes, so a body
--      that did would fail on its first call, not when the migration ran.
--   3. The demo still starts with the column gone: an anonymous visitor starts one (the call and the claims as
--      20261114010000's smoke makes them) and the copy holds every player the seed does.
--   4. The fence, replaced by the migration, still passes each column on its list and still refuses the others:
--      one write each to a demo player, by the table's owner (the fence governs every writer). Five columns pass
--      (rating, years played, jersey number, willing to coach, status) and five are refused 42501 with the
--      `demo_read_only` detail (first name, last name, notes, `play_up_requested`, `custom_attributes`).
--
-- The migration's own refusals (a player holding `false`, a changed fence body, a dependent) and the population
-- it is applied onto are exercised by scripts/dbharness/run.sh, which applies it onto planted rows, because a
-- smoke runs after the migration and cannot run it again. There is no data and no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_visitor uuid := 'dd000000-0000-4000-8000-0000000000a1';
    v_res     jsonb;
    v_org     uuid;
    v_players integer;
    v_teams   integer;
    v_seeded  integer;
    v_player  uuid;
    v_names   text;
    v_n       integer;
    v_ok      boolean;
    v_detail  text;
    v_passed  integer := 0;
    v_refused integer := 0;
    w         record;
BEGIN
    -- ---- 1. exactly one column went ----------------------------------------------------
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = 'public.players'::regclass AND a.attname = 'placement_eligible' AND NOT a.attisdropped) THEN
        RAISE EXCEPTION 'players.placement_eligible is still there';
    END IF;
    SELECT count(*) INTO v_n FROM pg_attribute a
     WHERE a.attrelid = 'public.players'::regclass AND NOT a.attisdropped
       AND a.attname IN ('registration_status', 'experience_years', 'play_up_requested', 'buddy_request_name');
    IF v_n <> 4 THEN
        RAISE EXCEPTION 'players holds % of the 4 sibling columns of the dropped one (expected 4)', v_n;
    END IF;
    BEGIN
        EXECUTE 'UPDATE public.players SET placement_eligible = false WHERE false';
        RAISE EXCEPTION 'a write naming the dropped column was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '42703' THEN
        NULL;   -- undefined_column: the expected refusal
    END;
    RAISE NOTICE 'players.placement_eligible is gone, its 4 siblings remain, and a write naming it is refused (42703)';

    -- ---- 2. no function names it ---------------------------------------------------------
    SELECT string_agg(n.nspname || '.' || p.oid::regprocedure::text, ', ' ORDER BY n.nspname, p.oid::regprocedure::text), count(*)
      INTO v_names, v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosrc ~* '\mplacement_eligible\M';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'a function still names the dropped column players.placement_eligible: %', v_names;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema');
    IF v_n < 100 THEN
        RAISE EXCEPTION 'the search for a function naming the column examined only % function(s)', v_n;
    END IF;
    RAISE NOTICE 'none of % function bodies names players.placement_eligible', v_n;

    -- ---- 3. the demo starts with the column gone -----------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
    VALUES (v_visitor, NULL, '{"password_length": 12}', true);
    PERFORM set_config('request.jwt.claim.sub', v_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_visitor, 'is_anonymous', true)::text, true);
    v_res := public.start_demo_session('fall');
    v_org := (v_res ->> 'organization_id')::uuid;
    IF v_org IS NULL OR (v_res ->> 'existing')::boolean THEN
        RAISE EXCEPTION 'the call did not return a new demo: %', v_res;
    END IF;
    SELECT count(*), count(DISTINCT team_id) INTO v_players, v_teams FROM public.players WHERE organization_id = v_org;
    SELECT count(*) INTO v_seeded FROM demo_seed.players;
    IF v_seeded < 1 OR v_players <> v_seeded THEN
        RAISE EXCEPTION 'the demo holds % player(s) where the seed holds %', v_players, v_seeded;
    END IF;
    RAISE NOTICE 'a demo started with the column gone: % players on % teams, the % the seed holds', v_players, v_teams, v_seeded;

    -- ---- 4. the replaced fence passes its list and refuses the rest ----------------------
    SELECT p.id INTO v_player FROM public.players p WHERE p.organization_id = v_org ORDER BY p.external_registration_id LIMIT 1;
    FOR w IN SELECT * FROM (VALUES
        ('rating',           'rating = CASE WHEN rating = 3 THEN 4 ELSE 3 END',                            true),
        ('years_played',     'years_played = CASE WHEN years_played = 2 THEN 3 ELSE 2 END',                true),
        ('jersey_number',    'jersey_number = CASE WHEN jersey_number = 7 THEN 8 ELSE 7 END',              true),
        ('willing_to_coach', 'willing_to_coach = NOT COALESCE(willing_to_coach, false)',                   true),
        ('status',           'status = CASE WHEN status = ''inactive'' THEN ''active'' ELSE ''inactive'' END', true),
        ('first_name',       'first_name = ''Typed''',                                                     false),
        ('last_name',        'last_name = ''Typed''',                                                      false),
        ('notes',            'notes = ''a note''',                                                         false),
        ('play_up_requested','play_up_requested = NOT play_up_requested',                                  false),
        ('custom_attributes','custom_attributes = ''{"typed": true}''::jsonb',                             false)
    ) x(col, assign, allowed) LOOP
        v_detail := NULL;
        BEGIN
            EXECUTE format('UPDATE public.players SET %s WHERE id = %L', w.assign, v_player);
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_ok := v_n = 1;
        EXCEPTION WHEN SQLSTATE '42501' THEN
            GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
            v_ok := false;
        END;
        IF v_ok IS DISTINCT FROM w.allowed THEN
            RAISE EXCEPTION 'the fence % a write to % (it should %)',
                CASE WHEN v_ok THEN 'let through' ELSE 'refused' END, w.col,
                CASE WHEN w.allowed THEN 'let it through' ELSE 'refuse it' END;
        END IF;
        IF NOT w.allowed AND v_detail IS DISTINCT FROM 'demo_read_only' THEN
            RAISE EXCEPTION 'the write to % was refused for the wrong reason (detail %)', w.col, v_detail;
        END IF;
        IF w.allowed THEN v_passed := v_passed + 1; ELSE v_refused := v_refused + 1; END IF;
    END LOOP;
    IF v_passed <> 5 OR v_refused <> 5 THEN
        RAISE EXCEPTION 'the fence check examined % allowed and % refused columns (expected 5 and 5)', v_passed, v_refused;
    END IF;
    RAISE NOTICE 'the demo fence: % of 5 listed columns changed and % of 5 others were refused 42501 (demo_read_only)', v_passed, v_refused;
END;
$$;

ROLLBACK;
