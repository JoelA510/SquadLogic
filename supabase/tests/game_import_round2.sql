-- pgTAP: the games import, fix round 2 of PR 5 (the four findings Codex made of 2bca942, and the owner's two answers of
-- 2026-11-09). Migration 20261121010000; the first file of the import's tests is game_import_apply_rollback.sql.
--
-- Written first, and red against 2bca942's migration (the PR body names each red result). Sections:
--
--   A  the team run the apply writes is in the shape the pages read (Codex P1): ONE run, the latest run's results carried
--      whole, each division's shells added to its group, a division no run names seeded with its own teams, the key set
--      held to core's TEAM_RUN_RESULT_KEYS by tests/gameImportTeamRunShape.test.js;
--   B  labels are compared the way core compares them (Codex P2): `normalise_external_label` over one table of cases
--      (tests/fixtures/labelNormalisationCases.json, held equal to this file's table by tests/gameImportLabelParity.test.js)
--      and the apply over the same pairs for every kind of record it creates or finds (division, venue, field, team,
--      outside club) and for two labels that create one record;
--   C  TIME TBD (Codex P2 and the owner's answer 1): a TIME TBD game is found by (season, Game ID) first, holds the DATE
--      and no time, is updated in place, becomes a placed game when the file places it, and a placed game the file now
--      says has no time is converted (with a warning) unless it is held; all of it undone by the rollback;
--   D  swaps (the owner's answer 2): a game moved onto a place another game of the same file leaves is applied, with a
--      warning, through a step-out of the unique index, and rolled back the same way; a place that a game the file does
--      NOT move holds still refuses.
--
-- The seed runs with no signed-in user (the Published guard and the completed-season trigger let that through).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(47);

-- ── Helpers ────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
    SELECT ('a1111111-1111-1111-1111-0000000e' || lpad(to_hex(n), 4, '0'))::uuid
$f$;
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
CREATE FUNCTION pg_temp.val(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE p_sql INTO r;
    RETURN COALESCE(r, 'NULL');
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE;
END
$f$;
-- The decision key of a plain (ASCII) label and the tuple keys, as core's scheduleLabelKey makes them.
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
-- num: a value out of the apply's result by path ('games,inserted').
CREATE FUNCTION pg_temp.num(p_res jsonb, p_path text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(p_res #>> string_to_array(p_path, ','), 'NULL')
$f$;
-- same: the apply's result without what differs between a dry run and an apply (the flag, the ids it made).
CREATE FUNCTION pg_temp.same(p_res jsonb) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT (p_res - 'dry_run' - 'ids' - 'replayed')
$f$;
-- gj: a saved game as one line, 'home>away@field/date/start w<week> pub=<f|t> ref=<ref>' (the last two characters of ids).
CREATE FUNCTION pg_temp.gj(p_id uuid) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE((SELECT right(ga.home_team_id::text, 2) || '>' || right(ga.away_team_id::text, 2) || '@' || right(ga.field_id::text, 2) || '/'
                            || COALESCE(gs.slot_date::text, 'noslot') || '/' || COALESCE(to_char(gs.start_time, 'HH24:MI'), '--') || ' w' || ga.week_index || ' pub=' || ga.published::text
                            || ' ref=' || COALESCE(ga.external_ref, '-')
                       FROM public.game_assignments ga LEFT JOIN public.game_slots gs ON gs.id = ga.game_slot_id WHERE ga.id = p_id), 'gone')
$f$;
-- The two tables the probes and the cases are loaded into.
CREATE TEMP TABLE jobs (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT SELECT, INSERT ON jobs TO PUBLIC;
CREATE TEMP TABLE marks (name text PRIMARY KEY, v text) ON COMMIT DROP;
GRANT SELECT, INSERT, UPDATE ON marks TO PUBLIC;
CREATE FUNCTION pg_temp.j(p text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM jobs WHERE name = p $f$;
CREATE TEMP SEQUENCE probe_seq;
GRANT USAGE ON SEQUENCE probe_seq TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.u(int), pg_temp.err(text), pg_temp.val(text), pg_temp.k(text), pg_temp.k2(text, text),
    pg_temp.stage(uuid, int, text, text, text, text, text, text, text, text, text, text, int, text[]),
    pg_temp.num(jsonb, text), pg_temp.gj(uuid), pg_temp.j(text), pg_temp.same(jsonb) TO PUBLIC;

SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '0',
    'control: the fixture has no saved game in Org A, so every count below is this file''s');

-- ═══ A. The team run the apply writes is in the shape the pages read ═══════
-- Two divisions. RD2 has a saved team run in the NORMAL shape (keyed by the division's name, with a roster balance and
-- players); RD1 has own teams in the table and no saved run at all. The file gives each a new shell and one outside club.
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    (pg_temp.u(1), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'RD1'),
    (pg_temp.u(2), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'RD2');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(11), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Ash'),
    (pg_temp.u(12), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Birch'),
    (pg_temp.u(21), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(2), 'Cedar'),
    (pg_temp.u(22), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(2), 'Dogwood');
INSERT INTO public.locations (id, organization_id, name) VALUES (pg_temp.u(30), 'a1111111-1111-1111-1111-111111111111', 'Round Park');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    (pg_temp.u(31), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(30), 'Pitch 1'),
    (pg_temp.u(32), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(30), 'Pitch 2');
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, results, created_at, completed_at) VALUES
    (pg_temp.u(60), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'team', 'completed',
     jsonb_build_object('selectedProgramId', 'RD2'),
     jsonb_build_object(
         'teamsByDivision', jsonb_build_object('RD2', jsonb_build_array(
             jsonb_build_object('id', pg_temp.u(21), 'name', 'Cedar', 'division', 'RD2', 'division_id', pg_temp.u(2), 'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb),
             jsonb_build_object('id', pg_temp.u(22), 'name', 'Dogwood', 'division', 'RD2', 'division_id', pg_temp.u(2), 'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb))),
         'rosterBalanceByDivision', jsonb_build_object('RD2', jsonb_build_object('summary', jsonb_build_object('totalPlayers', 7, 'totalCapacity', 24))),
         'teams', jsonb_build_array(
             jsonb_build_object('id', pg_temp.u(21), 'name', 'Cedar', 'division', 'RD2', 'division_id', pg_temp.u(2)),
             jsonb_build_object('id', pg_temp.u(22), 'name', 'Dogwood', 'division', 'RD2', 'division_id', pg_temp.u(2))),
         'team_players', jsonb_build_array(jsonb_build_object('team_id', pg_temp.u(21), 'player_id', pg_temp.u(900)))),
     '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'ja', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'shape.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('ja'), 1, 'ok', 'A-1', 'RD1', 'Round Park', 'Pitch 1', 'Ash',    'Elm',   '2027-03-06', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('ja'), 2, 'ok', 'A-2', 'RD2', 'Round Park', 'Pitch 2', 'Cedar',  'Fir',   '2027-03-06', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('ja'), 3, 'ok', 'A-3', 'RD1', 'Round Park', 'Pitch 1', 'Birch',  'Gulls', '2027-03-13', '09:00', '10:00', 2);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (public.map_game_import_job(pg_temp.j('ja'), jsonb_build_object(
    'divisions', jsonb_build_object('rd1', jsonb_build_object('action', 'map', 'id', pg_temp.u(1)), 'rd2', jsonb_build_object('action', 'map', 'id', pg_temp.u(2))),
    'venues', jsonb_build_object('round park', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
    'fields', jsonb_build_object(pg_temp.k2('Round Park', 'Pitch 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31)),
                                 pg_temp.k2('Round Park', 'Pitch 2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(32))),
    'teams', jsonb_build_object(
        pg_temp.k2('RD1', 'Ash'), jsonb_build_object('action', 'map', 'id', pg_temp.u(11)),
        pg_temp.k2('RD1', 'Birch'), jsonb_build_object('action', 'map', 'id', pg_temp.u(12)),
        pg_temp.k2('RD1', 'Elm'), jsonb_build_object('action', 'create'),
        pg_temp.k2('RD1', 'Gulls'), jsonb_build_object('action', 'outside'),
        pg_temp.k2('RD2', 'Cedar'), jsonb_build_object('action', 'map', 'id', pg_temp.u(21)),
        pg_temp.k2('RD2', 'Fir'), jsonb_build_object('action', 'create')))) ) ->> 'job_id'$$), pg_temp.j('ja')::text, 'control: the mapping is stored');
INSERT INTO marks VALUES ('apply_ja', (public.apply_game_import_job(pg_temp.j('ja'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_ja'), 'created,teams') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_ja'), 'created,outside_teams'), '2 1',
    'control: the apply created two shells (one per division) and one outside club');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE run_type = 'team' AND parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), '1',
    'A.1 the shells of two divisions are in ONE team run (the pages read the latest run: one run per division left the others out)');
SELECT is(pg_temp.val($$SELECT string_agg(k, ',' ORDER BY k) FROM public.scheduler_runs sr, jsonb_object_keys(sr.results) k
        WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), 'rosterBalanceByDivision,team_players,teams,teamsByDivision',
    'A.2 its results carry every key the carried run had (the roster balance too) and exactly the keys the readers read: teamsByDivision, teams, team_players');
SELECT is(pg_temp.val($$SELECT string_agg(e.key || '=' || (SELECT string_agg(t ->> 'name', '+' ORDER BY t ->> 'name') FROM jsonb_array_elements(e.value) t), '; ' ORDER BY e.key)
        FROM public.scheduler_runs sr, jsonb_each(sr.results -> 'teamsByDivision') e
        WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), 'RD1=Ash+Birch+Elm; RD2=Cedar+Dogwood+Fir',
    'A.3 teamsByDivision lists the carried teams AND the shells: RD2 under its name (the key the carried run used), RD1, which no run named, seeded with its own teams');
SELECT is(pg_temp.val($$SELECT string_agg(t ->> 'name' || '@' || (t ->> 'division'), ',' ORDER BY t ->> 'name') FROM public.scheduler_runs sr, jsonb_array_elements(sr.results -> 'teams') t
        WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), 'Ash@RD1,Birch@RD1,Cedar@RD2,Dogwood@RD2,Elm@RD1,Fir@RD2',
    'A.4 the flat list is every team, and a shell carries the division value its division''s carried teams carry');
SELECT is(pg_temp.val($$SELECT sr.results -> 'rosterBalanceByDivision' -> 'RD2' -> 'summary' ->> 'totalPlayers' || ' ' || jsonb_array_length(sr.results -> 'team_players')
        FROM public.scheduler_runs sr WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), '7 1',
    'A.5 what the carried run held beyond the teams is carried as it was (the roster balance, the players)');
SELECT is(pg_temp.val($$SELECT (sr.results::text LIKE '%' || (SELECT id::text FROM public.teams WHERE name = 'Gulls') || '%')::text
        FROM public.scheduler_runs sr WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), 'false',
    'A.6 the outside club is in no team run');
SELECT is(pg_temp.val($$SELECT (parameters -> 'shell_ids' @> to_jsonb((SELECT array_agg(id) FROM public.teams WHERE name IN ('Elm', 'Fir')))
        AND jsonb_array_length(parameters -> 'shell_ids') = 2)::text FROM public.scheduler_runs WHERE run_type = 'team' AND parameters ->> 'import_job_id' = pg_temp.j('ja')::text$$), 'true',
    'A.7 the run names its shells (the rollback finds them by it)');
INSERT INTO marks VALUES ('rb_ja', (public.rollback_game_import_job(pg_temp.j('ja')))::text);
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE run_type = 'team' AND organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '1',
    'A.8 the rollback removes the import''s team run: the carried run is the latest again');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE name IN ('Elm', 'Fir', 'Gulls')$$), '0', 'and the shells and the club are gone with it');

-- ═══ B. Labels are compared the way core compares them ═════════════════════
-- The table is tests/fixtures/labelNormalisationCases.json, written out (tests/gameImportLabelParity.test.js holds the two
-- equal and runs core's normaliseExternalLabel over each row). JSON text, so a no-break space or a tab is an escape in
-- the source and never a raw character.
CREATE TEMP TABLE label_cases (grp text, input_json text, expected_json text) ON COMMIT DROP;
GRANT SELECT ON label_cases TO PUBLIC;
-- LABEL-CASES-BEGIN
INSERT INTO label_cases VALUES
    ('plain', '"Lions"', '"lions"'),
    ('plain', '"LIONS"', '"lions"'),
    ('plain', '"  Lions  "', '"lions"'),
    ('space-run', '"Blue  Jays"', '"blue jays"'),
    ('space-run', '"blue     jays"', '"blue jays"'),
    ('space-run', '"Blue Jays"', '"blue jays"'),
    ('tab', '"Blue\tJays"', '"blue jays"'),
    ('line-feed', '"Blue\nJays"', '"blue jays"'),
    ('no-break-space', '"Blue\u00a0Jays"', '"blue jays"'),
    ('no-break-space', '"\u00a0Blue Jays\u00a0"', '"blue jays"'),
    ('other-unicode-space', '"Blue\u2003Jays"', '"blue jays"'),
    ('other-unicode-space', '"Blue\u3000Jays"', '"blue jays"'),
    ('other-unicode-space', '"\ufeffBlue Jays"', '"blue jays"'),
    ('diacritic-case', '"\u00c9toile"', '"\u00e9toile"'),
    ('diacritic-case', '"\u00e9toile"', '"\u00e9toile"'),
    ('diacritic-kept', '"Etoile"', '"etoile"'),
    ('trailing-punctuation-kept', '"Hawks."', '"hawks."'),
    ('trailing-punctuation-kept', '"Hawks. "', '"hawks."'),
    ('no-trailing-punctuation', '"Hawks"', '"hawks"'),
    ('zero-width-space-is-not-whitespace', '"Blue\u200bJays"', '"blue\u200bjays"'),
    ('next-line-is-not-whitespace', '"Blue\u0085Jays"', '"blue\u0085jays"');
-- LABEL-CASES-END
CREATE TEMP TABLE label_pairs (existing_json text, creating_json text, same boolean) ON COMMIT DROP;
GRANT SELECT ON label_pairs TO PUBLIC;
-- LABEL-PAIRS-BEGIN
INSERT INTO label_pairs VALUES
    ('"Blue Jays"', '"Blue  Jays"', true),
    ('"Blue Jays"', '"blue jays"', true),
    ('"Blue Jays"', '"Blue\tJays"', true),
    ('"Blue Jays"', '"Blue\u00a0Jays"', true),
    ('"Blue Jays"', '"\u00a0Blue Jays\u00a0"', true),
    ('"\u00c9toile"', '"\u00e9toile"', true),
    ('"Etoile"', '"\u00c9toile"', false),
    ('"Hawks"', '"Hawks."', false),
    ('"Blue Jays"', '"Blue\u200bJays"', false);
-- LABEL-PAIRS-END
SELECT is(pg_temp.val($$SELECT count(*) FROM label_cases$$) || ' ' || pg_temp.val($$SELECT count(*) FROM label_pairs$$), '21 9',
    'B.0 control: the table has every case and every pair (a table that lost its rows would pass what follows)');
SELECT is(COALESCE((SELECT string_agg(grp || ' ' || input_json, '; ') FROM label_cases
                     WHERE public.normalise_external_label(input_json::json #>> '{}') IS DISTINCT FROM (expected_json::json #>> '{}')), 'none'), 'none',
    'B.1 normalise_external_label gives, for every case, what core''s normaliseExternalLabel gives (trim, collapse every run of whitespace, JavaScript''s whitespace, lower-case)');
SELECT is((SELECT count(*) FROM label_cases WHERE public.normalise_external_label(input_json::json #>> '{}') IS DISTINCT FROM ('x' || (expected_json::json #>> '{}'))),
          (SELECT count(*) FROM label_cases), 'B.2 control: the comparison can fail (a wrong expected value is a mismatch in every row)');
SELECT is(has_function_privilege('authenticated', 'public.normalise_external_label(text)', 'EXECUTE')::text || has_function_privilege('anon', 'public.normalise_external_label(text)', 'EXECUTE')::text
          || (SELECT count(*) FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.proname = 'normalise_external_label' AND a.grantee = 0)::text,
    'falsefalse0', 'B.3 the helper is closed to PUBLIC, anon and authenticated (the import functions call it as their owner)');

-- probe: one dry-run of the apply over one name to create beside one that exists, for each kind of record the apply
-- creates or finds. The dry run is the apply's plan with the writes off, so what it counts created is what the apply writes.
CREATE FUNCTION pg_temp.probe(p_kind text, p_existing text, p_creating text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
    n int := nextval('probe_seq');
    b int := 2000 + n * 10;
    v_org constant uuid := 'a1111111-1111-1111-1111-111111111111';
    v_season constant uuid := 'a1111111-1111-1111-1111-111111111aaa';
    v_div uuid := pg_temp.u(b);
    v_ven uuid := pg_temp.u(b + 3);
    v_fld uuid := pg_temp.u(b + 4);
    v_dl text := 'PD' || n;
    v_job uuid;
    v_map jsonb;
    v_res jsonb;
    v_key text;
    v_home text;
BEGIN
  -- Everything the probe writes (the records it needs, the job, the staged row) is undone with its sub-transaction, so a
  -- name that stands in one probe is free for the next.
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
    v_job := (public.create_import_job(v_org, 'games', 'probe-' || n || '.csv')).id;
    PERFORM set_config('request.jwt.claims', '{}', true);
    IF p_kind = 'division' THEN
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, p_existing);
        PERFORM pg_temp.stage(v_job, 1, 'ok', 'P' || n, 'DL' || n, 'Round Park', 'Pitch 1', 'Home' || n, 'Away' || n, '2027-04-03', '09:00', '10:00', 20);
        v_map := jsonb_build_object(
            'divisions', jsonb_build_object(pg_temp.k('DL' || n), jsonb_build_object('action', 'create', 'name', p_creating)),
            'venues', jsonb_build_object('round park', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
            'fields', jsonb_build_object(pg_temp.k2('Round Park', 'Pitch 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31))),
            'teams', jsonb_build_object(pg_temp.k2('DL' || n, 'Home' || n), jsonb_build_object('action', 'create'),
                                        pg_temp.k2('DL' || n, 'Away' || n), jsonb_build_object('action', 'create')));
        v_key := 'divisions';
    ELSIF p_kind = 'venue' THEN
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, v_dl);
        INSERT INTO public.teams (id, organization_id, division_id, name) VALUES (pg_temp.u(b + 1), v_org, v_div, 'Anchor' || n), (pg_temp.u(b + 2), v_org, v_div, 'Other' || n);
        INSERT INTO public.locations (id, organization_id, name) VALUES (v_ven, v_org, p_existing);
        PERFORM pg_temp.stage(v_job, 1, 'ok', 'P' || n, v_dl, 'VL' || n, 'FL' || n, 'Anchor' || n, 'Other' || n, '2027-04-03', '09:00', '10:00', 20);
        v_map := jsonb_build_object(
            'divisions', jsonb_build_object(pg_temp.k(v_dl), jsonb_build_object('action', 'map', 'id', v_div)),
            'venues', jsonb_build_object(pg_temp.k('VL' || n), jsonb_build_object('action', 'create', 'name', p_creating)),
            'fields', jsonb_build_object(pg_temp.k2('VL' || n, 'FL' || n), jsonb_build_object('action', 'create', 'name', 'F' || n)),
            'teams', jsonb_build_object(pg_temp.k2(v_dl, 'Anchor' || n), jsonb_build_object('action', 'map', 'id', pg_temp.u(b + 1)),
                                        pg_temp.k2(v_dl, 'Other' || n), jsonb_build_object('action', 'map', 'id', pg_temp.u(b + 2))));
        v_key := 'venues';
    ELSIF p_kind = 'field' THEN
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, v_dl);
        INSERT INTO public.teams (id, organization_id, division_id, name) VALUES (pg_temp.u(b + 1), v_org, v_div, 'Anchor' || n), (pg_temp.u(b + 2), v_org, v_div, 'Other' || n);
        INSERT INTO public.locations (id, organization_id, name) VALUES (v_ven, v_org, 'PV' || n);
        INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (v_fld, v_org, v_ven, p_existing);
        PERFORM pg_temp.stage(v_job, 1, 'ok', 'P' || n, v_dl, 'PV' || n, 'FL' || n, 'Anchor' || n, 'Other' || n, '2027-04-03', '09:00', '10:00', 20);
        v_map := jsonb_build_object(
            'divisions', jsonb_build_object(pg_temp.k(v_dl), jsonb_build_object('action', 'map', 'id', v_div)),
            'venues', jsonb_build_object(pg_temp.k('PV' || n), jsonb_build_object('action', 'map', 'id', v_ven)),
            'fields', jsonb_build_object(pg_temp.k2('PV' || n, 'FL' || n), jsonb_build_object('action', 'create', 'name', p_creating)),
            'teams', jsonb_build_object(pg_temp.k2(v_dl, 'Anchor' || n), jsonb_build_object('action', 'map', 'id', pg_temp.u(b + 1)),
                                        pg_temp.k2(v_dl, 'Other' || n), jsonb_build_object('action', 'map', 'id', pg_temp.u(b + 2))));
        v_key := 'fields';
    ELSE
        -- team, outside and coalesce: a division of the season with an own team named p_existing (team, outside) or none (coalesce).
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, v_dl);
        INSERT INTO public.teams (id, organization_id, division_id, name) VALUES (pg_temp.u(b + 1), v_org, v_div, 'Anchor' || n);
        IF p_kind IN ('team', 'outside') THEN
            INSERT INTO public.teams (id, organization_id, division_id, name) VALUES (pg_temp.u(b + 2), v_org, v_div, p_existing);
        END IF;
        -- An outside club's name is its label: the file names it, and a label that reads as an own team's name is refused as that team.
        v_home := CASE WHEN p_kind = 'outside' THEN p_creating ELSE 'Home' || n END;
        PERFORM pg_temp.stage(v_job, 1, 'ok', 'P' || n, v_dl, 'Round Park', 'Pitch 1', v_home, 'Anchor' || n, '2027-04-03', '09:00', '10:00', 20);
        IF p_kind = 'coalesce' THEN
            PERFORM pg_temp.stage(v_job, 2, 'ok', 'Q' || n, v_dl, 'Round Park', 'Pitch 1', 'Away' || n, 'Anchor' || n, '2027-04-10', '09:00', '10:00', 21);
        END IF;
        v_map := jsonb_build_object(
            'divisions', jsonb_build_object(pg_temp.k(v_dl), jsonb_build_object('action', 'map', 'id', v_div)),
            'venues', jsonb_build_object('round park', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
            'fields', jsonb_build_object(pg_temp.k2('Round Park', 'Pitch 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31))),
            'teams', jsonb_build_object(
                pg_temp.k2(v_dl, v_home), CASE WHEN p_kind = 'outside' THEN jsonb_build_object('action', 'outside')
                                                     WHEN p_kind = 'coalesce' THEN jsonb_build_object('action', 'create', 'name', p_existing)
                                                     ELSE jsonb_build_object('action', 'create', 'name', p_creating) END,
                pg_temp.k2(v_dl, 'Away' || n), jsonb_build_object('action', 'create', 'name', p_creating),
                pg_temp.k2(v_dl, 'Anchor' || n), jsonb_build_object('action', 'map', 'id', pg_temp.u(b + 1))));
        v_key := CASE p_kind WHEN 'outside' THEN 'outside_teams' ELSE 'teams' END;
    END IF;
    PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
    PERFORM public.map_game_import_job(v_job, v_map);
    v_res := public.apply_game_import_job(v_job, true);
    PERFORM set_config('request.jwt.claims', '{}', true);
    RAISE EXCEPTION '%', (v_res -> 'created' ->> v_key) || ' ' || (v_res -> 'refused_by_reason')::text USING ERRCODE = 'P1122';
  EXCEPTION
    WHEN SQLSTATE 'P1122' THEN
        PERFORM set_config('request.jwt.claims', '{}', true);
        RETURN SQLERRM;
    WHEN OTHERS THEN
        PERFORM set_config('request.jwt.claims', '{}', true);
        RETURN 'ERROR ' || SQLSTATE || ' ' || SQLERRM;
  END;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.probe(text, text, text) TO PUBLIC;
-- probe_mismatches: every (kind, pair) whose dry run is not what core's resolution says: a name that reads the same as one
-- that exists is refused (never created beside it), and two labels that read as one name create one record.
CREATE FUNCTION pg_temp.probe_mismatches() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
    r record; k text; got text; want text; acc text := '';
BEGIN
    FOR r IN SELECT existing_json::json #>> '{}' AS ex, creating_json::json #>> '{}' AS cr, same FROM label_pairs ORDER BY 1, 2 LOOP
        FOREACH k IN ARRAY ARRAY['team', 'outside', 'division', 'venue', 'field', 'coalesce'] LOOP
            got := pg_temp.probe(k, r.ex, r.cr);
            want := CASE WHEN k = 'coalesce' THEN CASE WHEN r.same THEN '1 {}' ELSE '2 {}' END
                         WHEN r.same THEN '0 ' || CASE k WHEN 'team' THEN '{"unknown-team": 1}' WHEN 'outside' THEN '{"label-is-own-team": 1}'
                                                         WHEN 'division' THEN '{"unknown-division": 1}' WHEN 'venue' THEN '{"unknown-venue": 1}'
                                                         ELSE '{"unknown-field": 1}' END
                         ELSE '1 {}' END;
            IF got IS DISTINCT FROM want THEN
                acc := acc || k || '[' || quote_literal(r.ex) || '|' || quote_literal(r.cr) || '] got ' || got || ' want ' || want || '; ';
            END IF;
        END LOOP;
    END LOOP;
    RETURN COALESCE(NULLIF(acc, ''), 'none');
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.probe_mismatches() TO PUBLIC;
SELECT is(pg_temp.probe_mismatches(), 'none',
    'B.4 for every pair and every kind (division, venue, field, team, outside club, two labels that create one team) the apply reads two labels as one exactly when core does: a name that reads as one that exists is refused and never created beside it, and two such labels are one creation');

-- ═══ C. TIME TBD: a date and no time, found by Game ID, changed in place ═══
-- One division, six own teams, a venue with two fields, a saved game run holding two placed games (G1 not held, G2 Published)
-- and four TIME TBD rows (one the solver listed, three an earlier import left). The file below reaches every case.
SET LOCAL "request.jwt.claims" TO '{}';
CREATE FUNCTION pg_temp.mkslot(p_id uuid, p_field uuid, p_date date, p_start time, p_week smallint) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity)
    VALUES (p_id, 'a1111111-1111-1111-1111-111111111111', p_field,
            format('%sT%s-07:00', p_date, p_start)::timestamptz, format('%sT%s-07:00', p_date, p_start + interval '1 hour')::timestamptz,
            p_date, p_start, p_start + interval '1 hour', p_week, 1)
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.mkslot(uuid, uuid, date, time, smallint) TO PUBLIC;
CREATE FUNCTION pg_temp.mkgame(p_id uuid, p_run uuid, p_slot uuid, p_home uuid, p_away uuid, p_week smallint, p_ref text) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id,
                                         division, week_index, start, "end", assignment_source, external_ref)
    SELECT p_id, 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', p_run, gs.id, gs.id, gs.field_id, p_home, p_away,
           'TB', p_week, gs.start, gs."end", 'auto', p_ref
      FROM public.game_slots gs WHERE gs.id = p_slot
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.mkgame(uuid, uuid, uuid, uuid, uuid, smallint, text) TO PUBLIC;
-- tj: a TIME TBD row as one line, 'home>away w<week> <date|nodate> <ref|-> <reason>' (the last two characters of the team ids).
CREATE FUNCTION pg_temp.tj(p_ref text, p_home uuid, p_away uuid, p_week smallint) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE((SELECT right(s.home_team_id::text, 2) || '>' || right(s.away_team_id::text, 2) || ' w' || s.week_index || ' ' || COALESCE(s.game_date::text, 'nodate')
                            || ' ' || COALESCE(s.external_ref, '-') || ' ' || s.reason
                       FROM public.schedule_tbd s WHERE s.kind = 'game' AND ((p_ref IS NOT NULL AND s.external_ref = p_ref)
                            OR (p_ref IS NULL AND s.home_team_id = p_home AND s.away_team_id = p_away AND s.week_index = p_week)) LIMIT 1), 'none')
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.tj(text, uuid, uuid, smallint) TO PUBLIC;
-- fpg: the schedule's games and TIME TBD rows as one fingerprint, without what a rollback does not restore (the instant of a write).
CREATE FUNCTION pg_temp.fpg() RETURNS text LANGUAGE sql AS $f$
    SELECT md5(COALESCE((SELECT string_agg(((to_jsonb(t) - 'updated_at')::text), E'\n' ORDER BY t.id) FROM public.game_assignments t WHERE t.organization_id = 'a1111111-1111-1111-1111-111111111111'), '')
        || '|' || COALESCE((SELECT string_agg((to_jsonb(t)::text), E'\n' ORDER BY t.id) FROM public.schedule_tbd t WHERE t.organization_id = 'a1111111-1111-1111-1111-111111111111' AND t.kind = 'game'), ''))
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.fpg() TO PUBLIC;

INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (pg_temp.u(300), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'TB');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(301), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'T1'), (pg_temp.u(302), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'T2'),
    (pg_temp.u(303), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'T3'), (pg_temp.u(304), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'T4'),
    (pg_temp.u(305), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'T5'), (pg_temp.u(306), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'T6');
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
    (pg_temp.u(310), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-04-03T00:00:00Z');
SELECT pg_temp.mkslot(pg_temp.u(320), pg_temp.u(31), '2027-05-01', '09:00', 1::smallint);
SELECT pg_temp.mkslot(pg_temp.u(321), pg_temp.u(31), '2027-05-01', '10:00', 1::smallint);
SELECT pg_temp.mkgame(pg_temp.u(340), pg_temp.u(310), pg_temp.u(320), pg_temp.u(301), pg_temp.u(302), 1::smallint, 'C-PL-1');
SELECT pg_temp.mkgame(pg_temp.u(341), pg_temp.u(310), pg_temp.u(321), pg_temp.u(303), pg_temp.u(304), 1::smallint, 'C-PL-2');
UPDATE public.game_assignments SET published = true WHERE id = pg_temp.u(341);
INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason, run_id, external_ref, game_date) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(300), pg_temp.u(305), pg_temp.u(306), 2, 'imported-without-time', pg_temp.u(310), 'C-TB-1', '2027-05-08'),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(300), pg_temp.u(301), pg_temp.u(303), 3, 'no-slot-available', pg_temp.u(310), NULL, NULL),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(300), pg_temp.u(302), pg_temp.u(304), 6, 'imported-without-time', pg_temp.u(310), 'C-TB-2', '2027-06-12'),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(300), pg_temp.u(304), pg_temp.u(306), 7, 'imported-without-time', pg_temp.u(310), 'C-TB-3', '2027-06-19');
INSERT INTO marks VALUES ('c_seed_fp', pg_temp.fpg());

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jc', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'tbd-round2.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
-- 1 a TIME TBD game found by its Game ID that changes its date AND its week (the tuple no longer names it): ONE row, in place
SELECT pg_temp.stage(pg_temp.j('jc'), 1, 'tbd', 'C-TB-1', 'TB', '', '', 'T5', 'T6', '2027-05-22', NULL, NULL, 4);
-- 2 a new TIME TBD game with a Game ID
SELECT pg_temp.stage(pg_temp.j('jc'), 2, 'tbd', 'C-NEW-1', 'TB', '', '', 'T2', 'T3', '2027-05-29', NULL, NULL, 5);
-- 3 a TIME TBD game with no Game ID whose (home, away, week) the solver's row holds: found by the tuple, given its date
SELECT pg_temp.stage(pg_temp.j('jc'), 3, 'tbd', NULL, 'TB', '', '', 'T1', 'T3', '2027-05-15', NULL, NULL, 3);
-- 4 a placed game (not held) the file now says has no time: converted, with a warning
SELECT pg_temp.stage(pg_temp.j('jc'), 4, 'tbd', 'C-PL-1', 'TB', '', '', 'T1', 'T2', '2027-05-01', NULL, NULL, 1);
-- 5 a placed game that is held (Published): its row is skipped, the game stays
SELECT pg_temp.stage(pg_temp.j('jc'), 5, 'tbd', 'C-PL-2', 'TB', '', '', 'T3', 'T4', '2027-05-01', NULL, NULL, 1);
-- 6 a game the file now PLACES that stood on the TIME TBD list: the game is written and the row goes
SELECT pg_temp.stage(pg_temp.j('jc'), 6, 'ok', 'C-TB-2', 'TB', 'Round Park', 'Pitch 1', 'T2', 'T4', '2027-06-12', '09:00', '10:00', 6);
-- 7 a different Game ID for a (home, away, week) another TIME TBD game holds: refused, one game per tuple
SELECT pg_temp.stage(pg_temp.j('jc'), 7, 'tbd', 'C-Z', 'TB', '', '', 'T4', 'T6', '2027-06-19', NULL, NULL, 7);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE FUNCTION pg_temp.mapping_tb() RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object(
        'options', jsonb_build_object('arrive_published', false),
        'divisions', jsonb_build_object('tb', jsonb_build_object('action', 'map', 'id', pg_temp.u(300))),
        'venues', jsonb_build_object('round park', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
        'fields', jsonb_build_object(pg_temp.k2('Round Park', 'Pitch 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31)),
                                     pg_temp.k2('Round Park', 'Pitch 2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(32))),
        'teams', jsonb_build_object(
            pg_temp.k2('TB', 'T1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(301)), pg_temp.k2('TB', 'T2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(302)),
            pg_temp.k2('TB', 'T3'), jsonb_build_object('action', 'map', 'id', pg_temp.u(303)), pg_temp.k2('TB', 'T4'), jsonb_build_object('action', 'map', 'id', pg_temp.u(304)),
            pg_temp.k2('TB', 'T5'), jsonb_build_object('action', 'map', 'id', pg_temp.u(305)), pg_temp.k2('TB', 'T6'), jsonb_build_object('action', 'map', 'id', pg_temp.u(306))))
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.mapping_tb() TO PUBLIC;
SELECT is(pg_temp.val($$SELECT (public.map_game_import_job(pg_temp.j('jc'), pg_temp.mapping_tb())) ->> 'job_id'$$), pg_temp.j('jc')::text, 'control: the mapping is stored');
INSERT INTO marks VALUES ('dry_jc', (public.apply_game_import_job(pg_temp.j('jc'), true))::text);
SELECT is(pg_temp.fpg(), (SELECT v FROM marks WHERE name = 'c_seed_fp'), 'C.0 the dry run wrote nothing (the games and the TIME TBD rows are as seeded)');
INSERT INTO marks VALUES ('apply_jc', (public.apply_game_import_job(pg_temp.j('jc'), false))::text);
SELECT is((SELECT v::jsonb -> 'time_tbd' FROM marks WHERE name = 'apply_jc'), '{"inserted": 2, "updated": 2, "unchanged": 0, "removed": 1, "converted": 1}'::jsonb,
    'C.1 the TIME TBD counts: two inserted (a new one, and the converted game''s), two updated in place, one removed (the file placed it), one game converted');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jc'), 'games,inserted') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jc'), 'games,skipped,skipped-published')
          || ' ' || ((SELECT v::jsonb -> 'refused_by_reason' FROM marks WHERE name = 'apply_jc'))::text, '1 1 {"duplicate-row": 1}',
    'C.2 the placed game is inserted, the held game''s row is skipped-published, and the other Game ID on a held tuple is refused as a duplicate');
SELECT is(pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'apply_jc')), pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'dry_jc')),
    'C.3 the preview said the same: its counts, lists and warnings are the apply''s');
SELECT is(pg_temp.tj('C-TB-1', NULL, NULL, NULL) || ' | ' || (SELECT count(*) FROM public.schedule_tbd WHERE kind = 'game' AND home_team_id = pg_temp.u(305) AND away_team_id = pg_temp.u(306))::text,
    '31>32 w4 2027-05-22 C-TB-1 imported-without-time | 1',
    'C.4 a TIME TBD game is found by its Game ID FIRST: its date and week are changed in place and no second row is made beside it');
SELECT is(pg_temp.tj(NULL, pg_temp.u(301), pg_temp.u(303), 3::smallint), '2d>2f w3 2027-05-15 - imported-without-time',
    'C.5 a row with no Game ID is found by (home, away, week): the solver''s row takes the file''s date and reason, and has no Game ID');
SELECT is(pg_temp.tj('C-NEW-1', NULL, NULL, NULL), '2e>2f w5 2027-05-29 C-NEW-1 imported-without-time',
    'C.6 a new TIME TBD game holds its DATE and its Game ID, and no time (the table has no time column to hold one)');
SELECT is(pg_temp.tj('C-PL-1', NULL, NULL, NULL) || ' | ' || pg_temp.gj(pg_temp.u(340)), '2d>2e w1 2027-05-01 C-PL-1 imported-without-time | gone',
    'C.7 a placed game the file now gives no time is converted: the game is gone and a dated TIME TBD game stands for it (one outcome)');
SELECT is(pg_temp.tj('C-PL-2', NULL, NULL, NULL) || ' | ' || pg_temp.gj(pg_temp.u(341)), 'none | 2f>30@1f/2027-05-01/10:00 w1 pub=true ref=C-PL-2',
    'C.8 a held (Published) game is not converted: no TIME TBD row is written and the game stands as it was');
SELECT is(pg_temp.tj('C-TB-2', NULL, NULL, NULL) || ' | ' || (SELECT count(*) FROM public.game_assignments WHERE external_ref = 'C-TB-2' AND division = 'TB')::text, 'none | 1',
    'C.9 a TIME TBD game the file now places is a placed game and no longer listed');
SELECT is(pg_temp.tj('C-TB-3', NULL, NULL, NULL) || ' | ' || pg_temp.tj('C-Z', NULL, NULL, NULL), '30>32 w7 2027-06-19 C-TB-3 imported-without-time | none',
    'C.10 two Game IDs for one (home, away, week) are one row too many: the first holds it and the other is refused (the table is unique on it)');
SELECT is((SELECT count(*) FROM jsonb_array_elements((SELECT v::jsonb -> 'warnings' FROM marks WHERE name = 'apply_jc')) w WHERE w ->> 'type' = 'game-made-time-tbd')::text
          || ' ' || (SELECT string_agg(DISTINCT w -> 'details' ->> 'gameId', ',') FROM jsonb_array_elements((SELECT v::jsonb -> 'warnings' FROM marks WHERE name = 'apply_jc')) w WHERE w ->> 'type' = 'game-made-time-tbd'),
    '1 C-PL-1', 'C.11 the conversion is a WARNING (game-made-time-tbd, naming the Game ID), not a refusal');
SELECT is((SELECT string_agg(r.target_table || ':' || r.operation || '=' || n, ',' ORDER BY r.target_table, r.operation) FROM
            (SELECT target_table, operation, count(*) AS n FROM public.import_application_records WHERE import_job_id = pg_temp.j('jc') AND target_table IN ('schedule_tbd', 'game_assignments') GROUP BY 1, 2) r),
    'game_assignments:deleted=1,game_assignments:inserted=1,game_assignments:updated=1,schedule_tbd:deleted=1,schedule_tbd:inserted=2,schedule_tbd:updated=2',
    'C.12 every change has its application record with the image it had: the game taken out and the TIME TBD row removed (deleted), the two rows changed in place (updated), the new ones (inserted), and the game carried (updated, its run)');
-- The same file again: nothing to apply, nothing written, no new run.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jc2', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'tbd-round2-again.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    SELECT organization_id, pg_temp.j('jc2'), import_type, source_row_number, raw_payload, normalized_payload, validation_errors FROM public.staging_import_rows WHERE import_job_id = pg_temp.j('jc');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (public.map_game_import_job(pg_temp.j('jc2'), pg_temp.mapping_tb())) ->> 'job_id'$$), pg_temp.j('jc2')::text, 'control: the second job is mapped as the first');
INSERT INTO marks VALUES ('fp_before_jc2', pg_temp.fpg()), ('runs_before_jc2', (SELECT count(*)::text FROM public.scheduler_runs WHERE run_type = 'game'));
INSERT INTO marks VALUES ('apply_jc2', (public.apply_game_import_job(pg_temp.j('jc2'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jc2'), 'nothing_to_apply') || ' ' || ((SELECT v FROM marks WHERE name = 'fp_before_jc2') = pg_temp.fpg())::text
          || ' ' || ((SELECT v FROM marks WHERE name = 'runs_before_jc2') = (SELECT count(*)::text FROM public.scheduler_runs WHERE run_type = 'game'))::text, 'true true true',
    'C.13 the same file again is nothing to apply: nothing written, no new run (the TIME TBD rows are found by their Game IDs and are unchanged)');
SELECT is((SELECT v::jsonb -> 'time_tbd' FROM marks WHERE name = 'apply_jc2'), '{"inserted": 0, "updated": 0, "unchanged": 4, "removed": 0, "converted": 0}'::jsonb,
    'C.14 and it says so: four TIME TBD rows unchanged (the held game''s row is skipped, not counted a row of the list)') ;
-- The rollback of the first job puts every game and every TIME TBD row back as it was.
INSERT INTO marks VALUES ('rb_jc', (public.rollback_game_import_job(pg_temp.j('jc')))::text);
SELECT is(pg_temp.fpg(), (SELECT v FROM marks WHERE name = 'c_seed_fp'), 'C.15 the rollback restores the games and the TIME TBD rows exactly: the converted game stands again, the removed row is back, the changed rows are as they were');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_jc'), 'games,reinserted') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_jc'), 'time_tbd_restored') || ' '
          || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_jc'), 'time_tbd_reinserted') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_jc'), 'time_tbd_deleted'), '1 2 1 2',
    'C.16 and its result says what it did: one game put back, two TIME TBD rows restored, one put back, two removed');

-- ═══ D. Swaps are warnings, not blockers ═══════════════════════════════════
-- A game moved onto the place another game of the same file leaves is written, in an order the unique place allows, with
-- the warning games-swapped. A place a game the file does NOT move holds still refuses the row (a genuine clash), and a
-- held (Published) game is never moved: its row is skipped and nothing may take its place.
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.mkslot(pg_temp.u(350), pg_temp.u(31), '2027-06-05', '09:00', 10::smallint);  -- SA
SELECT pg_temp.mkslot(pg_temp.u(351), pg_temp.u(31), '2027-06-05', '10:00', 10::smallint);  -- SB
SELECT pg_temp.mkslot(pg_temp.u(352), pg_temp.u(32), '2027-06-05', '09:00', 10::smallint);  -- SC
SELECT pg_temp.mkslot(pg_temp.u(353), pg_temp.u(32), '2027-06-05', '10:00', 10::smallint);  -- SD
SELECT pg_temp.mkslot(pg_temp.u(354), pg_temp.u(31), '2027-06-05', '11:00', 10::smallint);  -- SE
SELECT pg_temp.mkslot(pg_temp.u(355), pg_temp.u(32), '2027-06-05', '11:00', 10::smallint);  -- SF
SELECT pg_temp.mkslot(pg_temp.u(356), pg_temp.u(31), '2027-06-12', '09:00', 11::smallint);  -- SG
SELECT pg_temp.mkslot(pg_temp.u(357), pg_temp.u(32), '2027-06-12', '09:00', 11::smallint);  -- SJ
SELECT pg_temp.mkslot(pg_temp.u(358), pg_temp.u(31), '2027-06-12', '10:00', 11::smallint);  -- SK
SELECT pg_temp.mkslot(pg_temp.u(359), pg_temp.u(32), '2027-06-12', '10:00', 11::smallint);  -- SL
SELECT pg_temp.mkgame(pg_temp.u(360), pg_temp.u(310), pg_temp.u(350), pg_temp.u(301), pg_temp.u(302), 10::smallint, 'D-1');
SELECT pg_temp.mkgame(pg_temp.u(361), pg_temp.u(310), pg_temp.u(351), pg_temp.u(301), pg_temp.u(302), 10::smallint, 'D-2');
SELECT pg_temp.mkgame(pg_temp.u(362), pg_temp.u(310), pg_temp.u(352), pg_temp.u(303), pg_temp.u(304), 10::smallint, 'D-3');
SELECT pg_temp.mkgame(pg_temp.u(363), pg_temp.u(310), pg_temp.u(354), pg_temp.u(305), pg_temp.u(306), 10::smallint, NULL);      -- stands where D-6 is moved: not in the file
SELECT pg_temp.mkgame(pg_temp.u(364), pg_temp.u(310), pg_temp.u(355), pg_temp.u(305), pg_temp.u(306), 10::smallint, 'D-6');
SELECT pg_temp.mkgame(pg_temp.u(365), pg_temp.u(310), pg_temp.u(356), pg_temp.u(302), pg_temp.u(303), 11::smallint, 'D-H');     -- held
SELECT pg_temp.mkgame(pg_temp.u(366), pg_temp.u(310), pg_temp.u(357), pg_temp.u(302), pg_temp.u(303), 11::smallint, 'D-8');
SELECT pg_temp.mkgame(pg_temp.u(367), pg_temp.u(310), pg_temp.u(359), pg_temp.u(301), pg_temp.u(303), 11::smallint, 'D-9');     -- the file gives it no time
UPDATE public.game_assignments SET published = true WHERE id = pg_temp.u(365);
INSERT INTO marks VALUES ('d_seed_fp', pg_temp.fpg());

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jd', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'swap-round2.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('jd'), 1, 'ok', 'D-1', 'TB', 'Round Park', 'Pitch 1', 'T1', 'T2', '2027-06-05', '10:00', '11:00', 10);   -- takes SB, which D-2 leaves
SELECT pg_temp.stage(pg_temp.j('jd'), 2, 'ok', 'D-2', 'TB', 'Round Park', 'Pitch 1', 'T1', 'T2', '2027-06-05', '09:00', '10:00', 10);   -- takes SA, which D-1 leaves
SELECT pg_temp.stage(pg_temp.j('jd'), 3, 'ok', 'D-3', 'TB', 'Round Park', 'Pitch 2', 'T3', 'T4', '2027-06-05', '10:00', '11:00', 10);   -- moves to a free place
SELECT pg_temp.stage(pg_temp.j('jd'), 4, 'ok', 'D-4', 'TB', 'Round Park', 'Pitch 2', 'T3', 'T4', '2027-06-05', '09:00', '10:00', 10);   -- NEW game on the place D-3 leaves
SELECT pg_temp.stage(pg_temp.j('jd'), 5, 'ok', 'D-6', 'TB', 'Round Park', 'Pitch 1', 'T5', 'T6', '2027-06-05', '11:00', '12:00', 10);   -- onto a place a game the file does not move holds
SELECT pg_temp.stage(pg_temp.j('jd'), 6, 'ok', 'D-H', 'TB', 'Round Park', 'Pitch 1', 'T2', 'T3', '2027-06-12', '10:00', '11:00', 11);   -- a held game asked to move
SELECT pg_temp.stage(pg_temp.j('jd'), 7, 'ok', 'D-8', 'TB', 'Round Park', 'Pitch 1', 'T2', 'T3', '2027-06-12', '09:00', '10:00', 11);   -- onto the place of the held game
SELECT pg_temp.stage(pg_temp.j('jd'), 8, 'tbd', 'D-9', 'TB', '', '', 'T1', 'T3', '2027-06-12', NULL, NULL, 11);                          -- a placed game given no time: taken out
SELECT pg_temp.stage(pg_temp.j('jd'), 9, 'ok', 'D-10', 'TB', 'Round Park', 'Pitch 2', 'T1', 'T3', '2027-06-12', '10:00', '11:00', 11);  -- a NEW game on the place that game leaves
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (public.map_game_import_job(pg_temp.j('jd'), pg_temp.mapping_tb())) ->> 'job_id'$$), pg_temp.j('jd')::text, 'control: the swap file is mapped');
INSERT INTO marks VALUES ('dry_jd', (public.apply_game_import_job(pg_temp.j('jd'), true))::text);
SELECT is(pg_temp.fpg(), (SELECT v FROM marks WHERE name = 'd_seed_fp'), 'D.0 the dry run wrote nothing');
INSERT INTO marks VALUES ('apply_jd', (public.apply_game_import_job(pg_temp.j('jd'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jd'), 'games,updated') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jd'), 'games,inserted')
          || ' ' || ((SELECT v::jsonb -> 'refused_by_reason' FROM marks WHERE name = 'apply_jd'))::text || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jd'), 'games,skipped,skipped-published'),
    '3 2 {"duplicate-row": 2} 1',
    'D.1 the swap, the move to a free place and the new games on a leaving place are all written (three updated, two inserted); the two clashes with a game the file does not move are refused, and the held game''s row is skipped');
SELECT is(pg_temp.gj(pg_temp.u(360)) || ' | ' || pg_temp.gj(pg_temp.u(361)), '2d>2e@1f/2027-06-05/10:00 w10 pub=false ref=D-1 | 2d>2e@1f/2027-06-05/09:00 w10 pub=false ref=D-2',
    'D.2 two games of one pair in one week swapped places by Game ID: each stands on the other''s old place');
SELECT is(pg_temp.gj(pg_temp.u(362)) || ' | ' || (SELECT pg_temp.gj(id) FROM public.game_assignments WHERE external_ref = 'D-4'),
    '2f>30@20/2027-06-05/10:00 w10 pub=false ref=D-3 | 2f>30@20/2027-06-05/09:00 w10 pub=false ref=D-4',
    'D.3 a game moved to a free place, and a new game of the same pair written on the place it left');
SELECT is(pg_temp.gj(pg_temp.u(364)) || ' | ' || pg_temp.gj(pg_temp.u(363)) || ' | ' || pg_temp.gj(pg_temp.u(365)) || ' | ' || pg_temp.gj(pg_temp.u(366)),
    '31>32@20/2027-06-05/11:00 w10 pub=false ref=D-6 | 31>32@1f/2027-06-05/11:00 w10 pub=false ref=- | 2e>2f@1f/2027-06-12/09:00 w11 pub=true ref=D-H | 2e>2f@20/2027-06-12/09:00 w11 pub=false ref=D-8',
    'D.4 the refused rows left their games where they were, the game the file does not move stands, and the held game did not move');
SELECT is((SELECT count(*) FROM jsonb_array_elements((SELECT v::jsonb -> 'warnings' FROM marks WHERE name = 'apply_jd')) w WHERE w ->> 'type' = 'games-swapped')::text || ' '
          || (SELECT string_agg(DISTINCT w -> 'details' ->> 'gameId', ',' ORDER BY w -> 'details' ->> 'gameId') FROM jsonb_array_elements((SELECT v::jsonb -> 'warnings' FROM marks WHERE name = 'apply_jd')) w WHERE w ->> 'type' = 'games-swapped'),
    '4 D-1,D-10,D-2,D-4', 'D.5 each game that took the place of a game the file moves away (or takes out) carries the non-blocking warning games-swapped, named by its Game ID (the move to a free place does not)');
SELECT is(pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'apply_jd')), pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'dry_jd')), 'D.6 the preview said the same: its counts, lists and warnings are the apply''s');
SELECT is(pg_temp.gj(pg_temp.u(367)) || ' | ' || (SELECT pg_temp.gj(id) FROM public.game_assignments WHERE external_ref = 'D-10')
          || ' | ' || (SELECT count(*) FROM jsonb_array_elements((SELECT v::jsonb -> 'warnings' FROM marks WHERE name = 'apply_jd')) w WHERE w ->> 'type' = 'game-made-time-tbd')::text,
    'gone | 2d>2f@20/2027-06-12/10:00 w11 pub=false ref=D-10 | 1',
    'D.6b a placed game the file gives no time is taken out and a NEW game is written on the place it leaves (it leaves, so the place is free), with the conversion warned');
SELECT is(((SELECT v::jsonb #>> '{listed,refused,0,message}' FROM marks WHERE name = 'apply_jd')) ~ 'does not move', 'true',
    'D.7 the words of the refusal that remains name its cause: a game this file does not move already stands on the place (the swap limitation is gone from them)');
INSERT INTO marks VALUES ('rb_jd', (public.rollback_game_import_job(pg_temp.j('jd')))::text);
SELECT is(pg_temp.fpg(), (SELECT v FROM marks WHERE name = 'd_seed_fp'), 'D.8 the rollback puts every game back where it was (it steps the swapped pair out of the unique place too) and removes the one the import wrote');

SELECT * FROM finish();
ROLLBACK;
