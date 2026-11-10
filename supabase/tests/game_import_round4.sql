-- pgTAP: the games import, fix round 4 of PR 5 (Codex's three findings on e699b1f). Migration 20261121010000.
-- F3 (a run the rollback keeps is never the current one) is in game_import_rollback_class.sql; this file is F1 and F2.
--
--   F1  an identifier a matched record already carries is never erased by a row that omits it. A TIME TBD game with a Game
--       ID that a row with NO Game ID places (found by its teams and week) becomes a placed game WITH that Game ID, so a
--       later row carrying the Game ID finds the game and does not write a second one. The siblings: a placed game found
--       by its place by a blank row keeps its Game ID; a TIME TBD game changed in place by a blank row keeps its own.
--       (A blank row cannot convert a placed game to TIME TBD: that needs the Game ID, there being no slot to find it by.)
--   F2  two rows of one file that resolve to ONE saved record (one by Game ID, one by teams, place and week) are a plan
--       the apply cannot execute: the row found by Game ID is kept, the other is refused `duplicate-row` in words that
--       say so, in the preview and the apply alike, for a placed game, a TIME TBD game, and a placed game one row changes
--       and another takes out. The preview's result is the apply's for every file here.
--
-- Written first, red against e699b1f (the PR body names each red result). The mock runs the same files
-- (tests/gameImportRound4Parity.test.js, held to this file's numbers).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(13);

-- ── Helpers ────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
    SELECT ('a1111111-1111-1111-1111-0000000b' || lpad(to_hex(n), 4, '0'))::uuid
$f$;
-- err: SQLSTATE:DETAIL of the first error, or 'no error' (the statement's effect stays).
CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE s text; d text;
BEGIN
    EXECUTE p_sql;
    RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;
-- val: the first column of the first row as text, or 'ERROR <sqlstate>'.
CREATE FUNCTION pg_temp.val(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE p_sql INTO r;
    RETURN COALESCE(r, 'NULL');
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE;
END
$f$;
CREATE FUNCTION pg_temp.k(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT lower(btrim(p)) $f$;
CREATE FUNCTION pg_temp.k2(a text, b text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
    SELECT '[' || to_json(lower(btrim(a)))::text || ',' || to_json(lower(btrim(b)))::text || ']'
$f$;
CREATE FUNCTION pg_temp.stage(p_job uuid, p_row int, p_status text, p_game_id text, p_division text, p_venue text, p_field text,
                              p_home text, p_away text, p_date text, p_start text, p_end text, p_week int, p_flags text[] DEFAULT '{}')
RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES ('a1111111-1111-1111-1111-111111111111', p_job, 'games', p_row, '{}'::jsonb,
            jsonb_build_object(
                'row_key', 'row-' || p_row, 'game_id', p_game_id, 'status', p_status,
                'tbd_reason', CASE WHEN p_status = 'tbd' THEN 'imported-without-time' END,
                'date', p_date, 'start_time', p_start, 'end_time', p_end,
                'start', CASE WHEN p_start IS NULL THEN NULL ELSE p_date || 'T' || p_start || ':00-07:00' END,
                'end', CASE WHEN p_end IS NULL THEN NULL ELSE p_date || 'T' || p_end || ':00-07:00' END,
                'week_index', p_week, 'flags', to_jsonb(p_flags),
                'division', p_division, 'division_key', pg_temp.k(p_division),
                'venue', p_venue, 'venue_key', pg_temp.k(p_venue),
                'field', p_field, 'field_key', pg_temp.k2(p_venue, p_field),
                'home_team', p_home, 'home_key', pg_temp.k2(p_division, p_home),
                'away_team', p_away, 'away_key', pg_temp.k2(p_division, p_away)),
            '[]'::jsonb)
$f$;
CREATE FUNCTION pg_temp.num(p_res jsonb, p_path text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(p_res #>> string_to_array(p_path, ','), 'NULL')
$f$;
-- rnum: a number out of the jsonb a statement returns, or the error text when the statement failed (a failing
-- statement is an assertion that differs, never an abort of the whole file).
CREATE FUNCTION pg_temp.rnum(p_sql text, p_path text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    r := pg_temp.val(p_sql);
    IF r LIKE '{%' THEN RETURN COALESCE(r::jsonb #>> string_to_array(p_path, ','), 'NULL'); END IF;
    RETURN r;
END
$f$;
CREATE FUNCTION pg_temp.mkslot(p_id uuid, p_field uuid, p_date date, p_start time, p_week smallint) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity)
    VALUES (p_id, 'a1111111-1111-1111-1111-111111111111', p_field,
            format('%sT%s-07:00', p_date, p_start)::timestamptz, format('%sT%s-07:00', p_date, p_start + interval '1 hour')::timestamptz,
            p_date, p_start, p_start + interval '1 hour', p_week, 1)
$f$;
CREATE FUNCTION pg_temp.mkgame(p_id uuid, p_run uuid, p_slot uuid, p_home uuid, p_away uuid, p_week smallint, p_ref text) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id,
                                         division, week_index, start, "end", assignment_source, external_ref)
    SELECT p_id, 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', p_run, gs.id, gs.id, gs.field_id, p_home, p_away,
           'FD', p_week, gs.start, gs."end", 'auto', p_ref
      FROM public.game_slots gs WHERE gs.id = p_slot
$f$;
-- fps: the schedule's own tables as one fingerprint, without the instant a row was last touched (a rollback restores
-- content, not a clock) and without the token a trigger makes for every team.
CREATE FUNCTION pg_temp.fps() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record; acc text := ''; h text;
BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                AND c.relname IN ('game_assignments', 'game_slots', 'teams', 'divisions', 'locations', 'fields', 'schedule_tbd', 'scheduler_runs', 'field_blackouts')
              ORDER BY c.relname LOOP
        EXECUTE format('SELECT md5(COALESCE(string_agg(((to_jsonb(t) - ''updated_at'') - ''calendar_token'')::text, E''\n'' ORDER BY ((to_jsonb(t) - ''updated_at'') - ''calendar_token'')::text), '''')) FROM public.%I t', r.relname) INTO h;
        acc := acc || r.relname || ':' || h || ';';
    END LOOP;
    RETURN md5(acc);
END
$f$;
CREATE TEMP TABLE jobs (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
CREATE TEMP TABLE marks (name text PRIMARY KEY, v text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.j(p text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM jobs WHERE name = p $f$;

-- same: the apply's result without what differs between a dry run and an apply.
CREATE FUNCTION pg_temp.same(p_res jsonb) RETURNS jsonb LANGUAGE sql AS $f$ SELECT (p_res - 'dry_run' - 'ids' - 'replayed') $f$;
-- ref: the Game ID of the one placed game of a pair in a week ('none' or 'N games' otherwise).
CREATE FUNCTION pg_temp.gref(p_home uuid, p_away uuid, p_week int) RETURNS text LANGUAGE sql AS $f$
    SELECT CASE count(*) WHEN 0 THEN 'none' WHEN 1 THEN COALESCE(min(external_ref), 'NULL') ELSE count(*) || ' games' END
      FROM public.game_assignments WHERE home_team_id = p_home AND away_team_id = p_away AND week_index = p_week
$f$;
CREATE FUNCTION pg_temp.mapping_f() RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object(
        'options', jsonb_build_object('arrive_published', false),
        'divisions', jsonb_build_object('fd', jsonb_build_object('action', 'map', 'id', pg_temp.u(1))),
        'venues', jsonb_build_object('four park', jsonb_build_object('action', 'map', 'id', pg_temp.u(20))),
        'fields', jsonb_build_object(pg_temp.k2('Four Park', 'Four 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(21))),
        'teams', (SELECT jsonb_object_agg(pg_temp.k2('FD', 'F' || n), jsonb_build_object('action', 'map', 'id', pg_temp.u(10 + n))) FROM generate_series(1, 6) n))
$f$;
-- job: a new games job named p_name (signed in as the admin).
CREATE FUNCTION pg_temp.newjob(p_name text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
    INSERT INTO jobs SELECT p_name, (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', p_name || '.csv')).id;
    PERFORM set_config('request.jwt.claims', '{}', true);
END
$f$;
-- go: map the job, preview it and apply it; marks 'dry_<name>' and 'apply_<name>' hold the two results (or the error).
CREATE FUNCTION pg_temp.go(p_name text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
    PERFORM public.map_game_import_job(pg_temp.j(p_name), pg_temp.mapping_f());
    INSERT INTO marks VALUES ('dry_' || p_name, pg_temp.val(format('SELECT public.apply_game_import_job(%L, true)::text', pg_temp.j(p_name))));
    INSERT INTO marks VALUES ('apply_' || p_name, pg_temp.val(format('SELECT public.apply_game_import_job(%L, false)::text', pg_temp.j(p_name))));
    PERFORM set_config('request.jwt.claims', '{}', true);
END
$f$;
-- res: a value out of a stored result by path, or the stored error text.
CREATE FUNCTION pg_temp.res(p_mark text, p_path text) RETURNS text LANGUAGE sql AS $f$
    SELECT CASE WHEN v LIKE '{%' THEN COALESCE(v::jsonb #>> string_to_array(p_path, ','), 'NULL') ELSE v END FROM marks WHERE name = p_mark
$f$;
CREATE FUNCTION pg_temp.preview_is_apply(p_name text) RETURNS text LANGUAGE sql AS $f$
    SELECT CASE WHEN a.v NOT LIKE '{%' OR d.v NOT LIKE '{%' THEN 'dry: ' || left(d.v, 40) || ' apply: ' || left(a.v, 40)
                WHEN pg_temp.same(a.v::jsonb) = pg_temp.same(d.v::jsonb) THEN 'same' ELSE 'differs' END
      FROM marks a, marks d WHERE a.name = 'apply_' || p_name AND d.name = 'dry_' || p_name
$f$;

SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (pg_temp.u(1), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'FD');
INSERT INTO public.teams (id, organization_id, division_id, name) SELECT pg_temp.u(10 + n), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'F' || n FROM generate_series(1, 6) n;
INSERT INTO public.locations (id, organization_id, name) VALUES (pg_temp.u(20), 'a1111111-1111-1111-1111-111111111111', 'Four Park');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (pg_temp.u(21), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(20), 'Four 1');
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
    (pg_temp.u(40), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-04-03T00:00:00Z');
SELECT pg_temp.mkslot(pg_temp.u(30), pg_temp.u(21), '2027-05-01', '09:00', 1::smallint);
SELECT pg_temp.mkslot(pg_temp.u(31), pg_temp.u(21), '2027-06-05', '09:00', 5::smallint);
SELECT pg_temp.mkslot(pg_temp.u(32), pg_temp.u(21), '2027-06-26', '09:00', 8::smallint);

-- ═══ F1. A Game ID a matched record carries is never erased by a row that omits it ═══
-- Saved: a TIME TBD game G-1 (F1 v F2, week 3); a placed game F-P (F3 v F4, week 1); a TIME TBD game F-T (F5 v F6, week 4).
SELECT pg_temp.mkgame(pg_temp.u(50), pg_temp.u(40), pg_temp.u(30), pg_temp.u(13), pg_temp.u(14), 1::smallint, 'F-P');
INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason, run_id, external_ref, game_date) VALUES
    (pg_temp.u(60), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(1), pg_temp.u(11), pg_temp.u(12), 3, 'imported-without-time', pg_temp.u(40), 'G-1', '2027-05-15'),
    (pg_temp.u(61), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(1), pg_temp.u(15), pg_temp.u(16), 4, 'imported-without-time', pg_temp.u(40), 'F-T', '2027-05-22');
INSERT INTO marks VALUES ('f1_seed', pg_temp.fps());
SELECT pg_temp.newjob('jf1');
SELECT pg_temp.stage(pg_temp.j('jf1'), 1, 'ok',  NULL, 'FD', 'Four Park', 'Four 1', 'F1', 'F2', '2027-05-15', '09:00', '10:00', 3);   -- places the TIME TBD game G-1, with no Game ID
SELECT pg_temp.stage(pg_temp.j('jf1'), 2, 'ok',  NULL, 'FD', 'Four Park', 'Four 1', 'F1', 'F2', '2027-05-15', '11:00', '12:00', 3);   -- a second game of the pair that week: a new game, not G-1
SELECT pg_temp.stage(pg_temp.j('jf1'), 3, 'ok',  NULL, 'FD', 'Four Park', 'Four 1', 'F3', 'F4', '2027-05-01', '09:00', '10:30', 1);   -- the placed game F-P, found by its place, its end changed
SELECT pg_temp.stage(pg_temp.j('jf1'), 4, 'tbd', NULL, 'FD', '', '', 'F5', 'F6', '2027-05-29', NULL, NULL, 4);                          -- the TIME TBD game F-T, found by its tuple, its date changed
SELECT pg_temp.go('jf1');
SELECT is(pg_temp.res('apply_jf1', 'games,inserted') || ' ' || pg_temp.res('apply_jf1', 'games,updated') || ' ' || pg_temp.res('apply_jf1', 'time_tbd,removed') || ' ' || pg_temp.res('apply_jf1', 'time_tbd,updated'),
    '2 1 1 1', 'F1.0 control: two games inserted, one updated in place, one TIME TBD game placed (removed from the list) and one changed in place');
SELECT is((SELECT string_agg(COALESCE(external_ref, 'NULL'), ',' ORDER BY start) FROM public.game_assignments WHERE home_team_id = pg_temp.u(11) AND away_team_id = pg_temp.u(12) AND week_index = 3),
    'G-1,NULL', 'F1.1 the TIME TBD game G-1 that a row with no Game ID places becomes a placed game that KEEPS the Game ID G-1 (the first row of the file that names it; the pair''s second game that week is a new game with none)');
SELECT is((SELECT external_ref || ' ' || to_char("end" AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') FROM public.game_assignments WHERE id = pg_temp.u(50)), 'F-P 10:30',
    'F1.2 a placed game found by its place by a row with no Game ID is changed in place and keeps its Game ID');
SELECT is((SELECT external_ref || ' ' || game_date FROM public.schedule_tbd WHERE id = pg_temp.u(61)), 'F-T 2027-05-29',
    'F1.3 a TIME TBD game found by its teams and week by a row with no Game ID is changed in place and keeps its Game ID');
SELECT is(pg_temp.preview_is_apply('jf1'), 'same', 'F1.4 the preview said the same as the apply');
-- The later correction that carries the Game ID finds the game.
SELECT pg_temp.newjob('jf1b');
SELECT pg_temp.stage(pg_temp.j('jf1b'), 1, 'ok', 'G-1', 'FD', 'Four Park', 'Four 1', 'F1', 'F2', '2027-05-15', '13:00', '14:00', 3);
SELECT pg_temp.go('jf1b');
SELECT is(pg_temp.res('apply_jf1b', 'games,inserted') || ' ' || pg_temp.res('apply_jf1b', 'games,updated') || ' '
          || (SELECT count(*) FROM public.game_assignments WHERE home_team_id = pg_temp.u(11) AND away_team_id = pg_temp.u(12) AND week_index = 3)::text
          || ' ' || (SELECT count(*) FROM public.game_assignments WHERE external_ref = 'G-1')::text,
    '0 1 2 1', 'F1.5 a later row carrying G-1 finds that game and moves it: nothing is inserted, the pair still has its two games that week, one of them G-1');
SELECT is(pg_temp.preview_is_apply('jf1b'), 'same', 'F1.6 the preview said the same as the apply');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (public.rollback_game_import_job(pg_temp.j('jf1b')) -> 'games' ->> 'restored')$$) || ' '
          || pg_temp.val($$SELECT (public.rollback_game_import_job(pg_temp.j('jf1')) ->> 'time_tbd_reinserted')$$) || ' ' || (pg_temp.fps() = (SELECT v FROM marks WHERE name = 'f1_seed'))::text
          || ' ' || pg_temp.val($$SELECT external_ref FROM public.schedule_tbd WHERE id = pg_temp.u(60)$$),
    '3 1 true G-1', 'F1.7 both imports roll back, in order, to exactly the schedule before them: the TIME TBD game G-1 is back with its Game ID');
SET LOCAL "request.jwt.claims" TO '{}';

-- ═══ F2. Two rows that resolve to one saved record ═══════════════════════════
-- Saved: a placed game D-1 (F1 v F3, week 5); a TIME TBD game D-T (F2 v F4, week 6); a placed game D-Y (F5 v F6, week 8).
SELECT pg_temp.mkgame(pg_temp.u(51), pg_temp.u(40), pg_temp.u(31), pg_temp.u(11), pg_temp.u(13), 5::smallint, 'D-1');
SELECT pg_temp.mkgame(pg_temp.u(52), pg_temp.u(40), pg_temp.u(32), pg_temp.u(15), pg_temp.u(16), 8::smallint, 'D-Y');
INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason, run_id, external_ref, game_date) VALUES
    (pg_temp.u(62), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(1), pg_temp.u(12), pg_temp.u(14), 6, 'imported-without-time', pg_temp.u(40), 'D-T', '2027-06-12');
SELECT pg_temp.newjob('jf2');
SELECT pg_temp.stage(pg_temp.j('jf2'), 1, 'ok',  NULL,  'FD', 'Four Park', 'Four 1', 'F1', 'F3', '2027-06-05', '09:00', '10:30', 5);   -- D-1 by its place (its end changed)
SELECT pg_temp.stage(pg_temp.j('jf2'), 2, 'ok',  'D-1', 'FD', 'Four Park', 'Four 1', 'F1', 'F3', '2027-06-05', '11:00', '12:00', 5);   -- D-1 by its Game ID (moved)
SELECT pg_temp.stage(pg_temp.j('jf2'), 3, 'tbd', NULL,  'FD', '', '', 'F2', 'F4', '2027-06-13', NULL, NULL, 6);                          -- D-T by its teams and week
SELECT pg_temp.stage(pg_temp.j('jf2'), 4, 'tbd', 'D-T', 'FD', '', '', 'F2', 'F4', '2027-06-20', NULL, NULL, 7);                          -- D-T by its Game ID (another week)
SELECT pg_temp.stage(pg_temp.j('jf2'), 5, 'ok',  NULL,  'FD', 'Four Park', 'Four 1', 'F5', 'F6', '2027-06-26', '09:00', '10:30', 8);   -- D-Y by its place (its end changed)
SELECT pg_temp.stage(pg_temp.j('jf2'), 6, 'tbd', 'D-Y', 'FD', '', '', 'F5', 'F6', '2027-06-26', NULL, NULL, 8);                          -- D-Y by its Game ID: the file gives it no time
SELECT pg_temp.go('jf2');
SELECT is(left(pg_temp.res('dry_jf2', 'refused_by_reason'), 40), '{"duplicate-row": 3}',
    'F2.1 the PREVIEW refuses the three rows that name a saved record another row names by its Game ID (duplicate-row)');
SELECT is(left(pg_temp.res('apply_jf2', 'refused_by_reason'), 40) || ' ' || pg_temp.res('apply_jf2', 'games,updated') || ' ' || pg_temp.res('apply_jf2', 'time_tbd,updated') || ' ' || pg_temp.res('apply_jf2', 'time_tbd,converted'),
    '{"duplicate-row": 3} 1 1 1', 'F2.2 the APPLY goes through (it used to abort the whole import on its own row count): one game moved, one TIME TBD game changed, one game made TIME TBD, three rows refused');
SELECT is(pg_temp.preview_is_apply('jf2'), 'same', 'F2.3 the preview said the same as the apply');
SELECT is((SELECT string_agg(e ->> 'row_number', ',' ORDER BY (e ->> 'row_number')::int) FROM jsonb_array_elements(CASE WHEN pg_temp.res('apply_jf2', 'listed,refused') LIKE '[%' THEN pg_temp.res('apply_jf2', 'listed,refused')::jsonb ELSE '[]'::jsonb END) e
            WHERE e ->> 'message' LIKE '%names the same saved game%'), '1,3,5',
    'F2.4 the row found by its Game ID is kept and the other is refused, in words that say two rows name one saved game');
SELECT is((SELECT to_char(start AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') FROM public.game_assignments WHERE id = pg_temp.u(51)) || ' '
          || (SELECT week_index || ' ' || game_date FROM public.schedule_tbd WHERE id = pg_temp.u(62)) || ' '
          || (SELECT count(*) FROM public.game_assignments WHERE id = pg_temp.u(52))::text || ' ' || (SELECT count(*) FROM public.schedule_tbd WHERE external_ref = 'D-Y')::text,
    '11:00 7 2027-06-20 0 1', 'F2.5 each saved record is as the row that carries its Game ID says: D-1 at 11:00, D-T in week 7, D-Y a TIME TBD game');

SELECT * FROM finish();
ROLLBACK;
