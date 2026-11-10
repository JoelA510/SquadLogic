-- pgTAP: the games import rollback judges EVERY record it undoes against what stands now (PR 5, fix round 3).
-- Migration 20261121010000; the other files of the import's tests are game_import_apply_rollback.sql and game_import_round2.sql.
--
-- Codex reviewed 305137b and left one finding: `rollback_game_import_job` compared only the PLACED games with the images the
-- apply stored. A TIME TBD row was deleted, restored or put back with no comparison at all, so rolling back import A deleted
-- the correction import B had made to a TIME TBD game A inserted (and would have overwritten a later correction of a row A
-- had changed). It was the second rollback-safety finding of this PR (the first was a permit scope on a field the import
-- made), so this file is the class, not the patch: the subject set is DERIVED, never listed by hand.
--
--   R  the finding as reported: a season with no placed games; import A inserts a TIME TBD game; import B corrects its date
--      and week in place (by Game ID); rolling A back is refused and B's correction is intact; once B is rolled back A is.
--   Q  the class. (1) The (table, operation) pairs the apply can write are read out of the apply's own source (the
--      `import_application_records` inserts), checked against the table's CHECK constraints, and compared with what ONE real
--      apply wrote (every pair, nothing else). (2) The tables the rollback writes are read out of ITS source; each must have
--      a scenario (the job's own bookkeeping tables are the only exception, named below). (3) For every pair a later writer
--      changes the record (a direct UPDATE or DELETE, a game saved into a later run, a row that stands again, something
--      attached to a record that was created) and the rollback must either REFUSE (22023 game_import_changed, naming the
--      record) or KEEP it and say so in `kept`, and in every case what the later writer did is still there afterwards.
--      A pair with no scenario fails the file; so does a scenario for a pair the apply cannot write. No pair is exempt:
--      a combination that is safe to roll back over a later change would be a row of an `exempt` list with its reason, and
--      there is none.
--
-- The scenario table (its names and expected outcomes) is held equal to tests/fixtures/rollbackClassScenarios.json by
-- tests/gameImportRollbackClass.test.js, which runs the same scenarios through the mock (lesson 77: a twin is held by a
-- test that runs both over one input).
--
-- The seed runs with no signed-in user (the Published guard and the completed-season trigger let that through).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(26);

-- ── Helpers ────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
    SELECT ('a1111111-1111-1111-1111-0000000c' || lpad(to_hex(n), 4, '0'))::uuid
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
           'QD', p_week, gs.start, gs."end", 'auto', p_ref
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

SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '0',
    'control: the fixture has no saved game in Org A, so everything below is this file''s');

-- ═══ R. The finding as reported ═════════════════════════════════════════════
-- A season with no placed games. Import A inserts a TIME TBD game (Game ID R-G1, 2027-03-06, week 1). Import B corrects its
-- date and week (2027-03-13, week 2), found by its Game ID and changed in place. Rolling A back would delete B's row.
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    (pg_temp.u(901), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'RR');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(911), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(901), 'R1'),
    (pg_temp.u(912), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(901), 'R2');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'ra', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'tbd-a.csv')).id;
INSERT INTO jobs SELECT 'rb', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'tbd-b.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('ra'), 1, 'tbd', 'R-G1', 'RR', '', '', 'R1', 'R2', '2027-03-06', NULL, NULL, 1);
SELECT pg_temp.stage(pg_temp.j('rb'), 1, 'tbd', 'R-G1', 'RR', '', '', 'R1', 'R2', '2027-03-13', NULL, NULL, 2);
CREATE FUNCTION pg_temp.mapping_r() RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object(
        'options', jsonb_build_object('arrive_published', false),
        'divisions', jsonb_build_object('rr', jsonb_build_object('action', 'map', 'id', pg_temp.u(901))),
        'teams', jsonb_build_object(pg_temp.k2('RR', 'R1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(911)),
                                    pg_temp.k2('RR', 'R2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(912))))
$f$;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_ra', (public.map_game_import_job(pg_temp.j('ra'), pg_temp.mapping_r()))::text),
                         ('map_rb', (public.map_game_import_job(pg_temp.j('rb'), pg_temp.mapping_r()))::text);
INSERT INTO marks VALUES ('apply_ra', (public.apply_game_import_job(pg_temp.j('ra'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_ra'), 'time_tbd,inserted') || ' '
          || pg_temp.val($$SELECT game_date::text || ' w' || week_index FROM public.schedule_tbd WHERE external_ref = 'R-G1'$$),
    '1 2027-03-06 w1', 'R.1 control: import A inserted the TIME TBD game R-G1 (2027-03-06, week 1) and no placed game was written');
INSERT INTO marks VALUES ('apply_rb', (public.apply_game_import_job(pg_temp.j('rb'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_rb'), 'time_tbd,updated') || ' '
          || pg_temp.val($$SELECT count(*)::text || ' ' || min(game_date)::text || ' w' || min(week_index) FROM public.schedule_tbd WHERE external_ref = 'R-G1'$$),
    '1 1 2027-03-13 w2', 'R.2 control: import B corrected it IN PLACE by its Game ID (one row, 2027-03-13, week 2)');
-- THE FINDING: refused, and B's correction is still there. (Not undone: if the rollback goes through, the next lines see it.)
SELECT is(pg_temp.err($$SELECT public.rollback_game_import_job(pg_temp.j('ra'))$$),
    '22023:game_import_changed count=1 ids= tbd_ids=' || COALESCE((SELECT id::text FROM public.schedule_tbd WHERE external_ref = 'R-G1'), 'GONE'),
    'R.3 rolling import A back is refused (22023, game_import_changed) and names the TIME TBD game import B changed');
SELECT is(pg_temp.val($$SELECT game_date::text || ' w' || week_index FROM public.schedule_tbd WHERE external_ref = 'R-G1'$$), '2027-03-13 w2',
    'R.4 and import B''s correction is intact (the rollback of A did not delete or overwrite it)');
SELECT is(pg_temp.rnum($$SELECT public.rollback_game_import_job(pg_temp.j('rb'))::text$$, 'time_tbd_restored') || ' '
          || pg_temp.val($$SELECT game_date::text || ' w' || week_index FROM public.schedule_tbd WHERE external_ref = 'R-G1'$$),
    '1 2027-03-06 w1', 'R.5 import B can be rolled back first: the row is put back as A wrote it');
SELECT is(pg_temp.rnum($$SELECT public.rollback_game_import_job(pg_temp.j('ra'))::text$$, 'time_tbd_deleted') || ' '
          || pg_temp.val($$SELECT count(*) FROM public.schedule_tbd WHERE external_ref = 'R-G1'$$),
    '1 0', 'R.6 and then import A can: the TIME TBD game it inserted is deleted');

-- ═══ Q. The class ═════════════════════════════════════════════════════════
-- One league with every kind of record in it, and ONE real apply that writes every (table, operation) pair:
--   a division QD with six own teams; a venue Class Park with a field; a previous game run holding two placed games
--   (Q-PL-1, which the file will give no time: converted; Q-PL-2, which the file does not name: carried into the new run) and
--   two TIME TBD rows (Q-TB-1, which the file changes in place; Q-TB-2, which the file now places).
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (pg_temp.u(1), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'QD');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(11), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Q1'), (pg_temp.u(12), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Q2'),
    (pg_temp.u(13), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Q3'), (pg_temp.u(14), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Q4'),
    (pg_temp.u(15), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Q5'), (pg_temp.u(16), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Q6');
INSERT INTO public.locations (id, organization_id, name) VALUES (pg_temp.u(20), 'a1111111-1111-1111-1111-111111111111', 'Class Park');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (pg_temp.u(21), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(20), 'Class 1');
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
    (pg_temp.u(40), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-04-03T00:00:00Z'),
    (pg_temp.u(41), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-03-03T00:00:00Z');
SELECT pg_temp.mkslot(pg_temp.u(30), pg_temp.u(21), '2027-05-01', '09:00', 1::smallint);
SELECT pg_temp.mkslot(pg_temp.u(31), pg_temp.u(21), '2027-05-01', '10:00', 1::smallint);
SELECT pg_temp.mkgame(pg_temp.u(50), pg_temp.u(40), pg_temp.u(30), pg_temp.u(11), pg_temp.u(12), 1::smallint, 'Q-PL-1');
SELECT pg_temp.mkgame(pg_temp.u(51), pg_temp.u(40), pg_temp.u(31), pg_temp.u(13), pg_temp.u(14), 1::smallint, 'Q-PL-2');
INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason, run_id, external_ref, game_date) VALUES
    (pg_temp.u(60), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(1), pg_temp.u(15), pg_temp.u(16), 2, 'imported-without-time', pg_temp.u(40), 'Q-TB-1', '2027-05-08'),
    (pg_temp.u(61), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game', pg_temp.u(1), pg_temp.u(12), pg_temp.u(14), 6, 'imported-without-time', pg_temp.u(40), 'Q-TB-2', '2027-06-12');
INSERT INTO marks VALUES ('q_seed_fp', pg_temp.fps());

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jq', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'class.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('jq'), 1, 'tbd', 'Q-TB-1',  'QD',   '', '', 'Q5', 'Q6', '2027-05-22', NULL, NULL, 4);                                       -- a TIME TBD game changed in place: schedule_tbd updated
SELECT pg_temp.stage(pg_temp.j('jq'), 2, 'tbd', 'Q-PL-1',  'QD',   '', '', 'Q1', 'Q2', '2027-05-01', NULL, NULL, 1);                                       -- a placed game given no time: game_assignments deleted, schedule_tbd inserted
SELECT pg_temp.stage(pg_temp.j('jq'), 3, 'ok',  'Q-TB-2',  'QD',   'New Park', 'New 1', 'Q2', 'Q4', '2027-06-12', '09:00', '10:00', 6);                 -- the file places it: schedule_tbd deleted; a venue, a field, a slot and a game are made
SELECT pg_temp.stage(pg_temp.j('jq'), 4, 'ok',  'Q-NEW-2', 'QNEW', 'New Park', 'New 1', 'Shell A', 'Outside FC', '2027-06-12', '10:00', '11:00', 6);   -- a division, a team shell, an outside club and a second slot
SELECT pg_temp.stage(pg_temp.j('jq'), 5, 'tbd', 'Q-NEW-1', 'QD',   '', '', 'Q2', 'Q3', '2027-05-29', NULL, NULL, 5);                                       -- a new TIME TBD game
SELECT pg_temp.stage(pg_temp.j('jq'), 6, 'ok',  'Q-NEW-3', 'QNEW', 'New Park', 'New 1', 'Shell B', 'Outside FC', '2027-06-12', '11:00', '12:00', 6);   -- a second team shell (one can be kept while the other goes)
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE FUNCTION pg_temp.mapping_q() RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object(
        'options', jsonb_build_object('arrive_published', false),
        'divisions', jsonb_build_object('qd', jsonb_build_object('action', 'map', 'id', pg_temp.u(1)),
                                        'qnew', jsonb_build_object('action', 'create', 'name', 'QNEW')),
        'venues', jsonb_build_object('class park', jsonb_build_object('action', 'map', 'id', pg_temp.u(20)),
                                     'new park', jsonb_build_object('action', 'create', 'name', 'New Park')),
        'fields', jsonb_build_object(pg_temp.k2('Class Park', 'Class 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(21)),
                                     pg_temp.k2('New Park', 'New 1'), jsonb_build_object('action', 'create', 'name', 'New 1')),
        'teams', jsonb_build_object(
            pg_temp.k2('QD', 'Q1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(11)), pg_temp.k2('QD', 'Q2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(12)),
            pg_temp.k2('QD', 'Q3'), jsonb_build_object('action', 'map', 'id', pg_temp.u(13)), pg_temp.k2('QD', 'Q4'), jsonb_build_object('action', 'map', 'id', pg_temp.u(14)),
            pg_temp.k2('QD', 'Q5'), jsonb_build_object('action', 'map', 'id', pg_temp.u(15)), pg_temp.k2('QD', 'Q6'), jsonb_build_object('action', 'map', 'id', pg_temp.u(16)),
            pg_temp.k2('QNEW', 'Shell A'), jsonb_build_object('action', 'create', 'name', 'Shell A'),
            pg_temp.k2('QNEW', 'Shell B'), jsonb_build_object('action', 'create', 'name', 'Shell B'),
            pg_temp.k2('QNEW', 'Outside FC'), jsonb_build_object('action', 'outside')))
$f$;
SELECT is(pg_temp.val($$SELECT (public.map_game_import_job(pg_temp.j('jq'), pg_temp.mapping_q())) ->> 'job_id'$$), pg_temp.j('jq')::text, 'control: the class file is mapped');
INSERT INTO marks VALUES ('apply_jq', (public.apply_game_import_job(pg_temp.j('jq'), false))::text);

-- ── The universe, derived. ──────────────────────────────────────────────────
-- universe(src): the (table, operation) pairs the apply's SOURCE writes into import_application_records, as 'table:operation'
-- sorted. It reads the text of the inserts, never what the fixture happened to produce.
CREATE FUNCTION pg_temp.universe(p_src text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(string_agg(DISTINCT m[1] || ':' || m[2], ',' ORDER BY m[1] || ':' || m[2]), '')
      FROM regexp_matches(p_src, 'INSERT INTO public\.import_application_records[^;]*?SELECT v_org, p_import_job_id, ''games'', ''([a-z_]+)'', [a-z_]+\.id, ''(inserted|updated|deleted)''', 'g') AS m
$f$;
-- written(src): the tables a function's source deletes from, updates or inserts into.
CREATE FUNCTION pg_temp.written(p_src text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(string_agg(DISTINCT m[1], ',' ORDER BY m[1]), '')
      FROM regexp_matches(p_src, '(?:DELETE FROM|UPDATE|INSERT INTO) public\.([a-z_]+)', 'g') AS m
$f$;
CREATE FUNCTION pg_temp.apply_src() RETURNS text LANGUAGE sql AS $f$
    SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.apply_game_import_job(uuid, boolean)'::regprocedure
$f$;
CREATE FUNCTION pg_temp.rollback_src() RETURNS text LANGUAGE sql AS $f$
    SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.rollback_game_import_job(uuid)'::regprocedure
$f$;
-- readback: the pairs ONE real apply wrote (the job's own application records).
CREATE FUNCTION pg_temp.readback(p_job uuid) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(string_agg(DISTINCT target_table || ':' || operation, ',' ORDER BY target_table || ':' || operation), '')
      FROM public.import_application_records WHERE import_job_id = p_job
$f$;

-- The scenarios. Per pair: what a later writer does to the record, what the rollback must then do (refuse, or keep the record
-- and say so), and a check that what the later writer did is still there afterwards. %T% is the pair's records of the
-- job (their target ids), %JOB% the job. `tsql` names the targets of a table the apply records nothing for.
CREATE TEMP TABLE scen (ord int PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, name text NOT NULL, expect text NOT NULL,
                        tsql text, mutation text NOT NULL, witness text NOT NULL) ON COMMIT DROP;
INSERT INTO scen VALUES
 (1,  'divisions', 'inserted', 'edit', 'keep', NULL,
  $m$UPDATE public.divisions SET name = name || ' renamed' WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.divisions WHERE id IN (%T%) AND name LIKE '% renamed') = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (2,  'divisions', 'inserted', 'attach', 'keep', NULL,
  $m$INSERT INTO public.teams (organization_id, division_id, name) SELECT organization_id, id, 'later team' FROM public.divisions WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.divisions WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND (SELECT count(*) FROM public.teams WHERE name = 'later team' AND division_id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (3,  'locations', 'inserted', 'edit', 'keep', NULL,
  $m$UPDATE public.locations SET address = 'Edited Way 1' WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.locations WHERE id IN (%T%) AND address = 'Edited Way 1') = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (4,  'locations', 'inserted', 'attach', 'keep', NULL,
  $m$INSERT INTO public.fields (organization_id, location_id, name) SELECT organization_id, id, 'later field' FROM public.locations WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.locations WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND (SELECT count(*) FROM public.fields WHERE name = 'later field' AND location_id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (5,  'fields', 'inserted', 'edit', 'keep', NULL,
  $m$UPDATE public.fields SET name = name || ' renamed' WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.fields WHERE id IN (%T%) AND name LIKE '% renamed') = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (6,  'fields', 'inserted', 'attach', 'keep', NULL,
  $m$INSERT INTO public.field_blackouts (organization_id, field_id, blackout_from, blackout_until) SELECT organization_id, id, '2027-07-04', '2027-07-04' FROM public.fields WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.fields WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND (SELECT count(*) FROM public.field_blackouts WHERE field_id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (7,  'teams', 'inserted', 'edit', 'keep', NULL,
  $m$UPDATE public.teams SET notes = 'edited later' WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.teams WHERE id IN (%T%) AND notes = 'edited later') = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (8,  'teams', 'inserted', 'attach', 'keep', NULL,
  $m$INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, results, completed_at)
     SELECT gen_random_uuid(), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'team', 'completed', '{}'::jsonb,
            jsonb_build_object('teams', (SELECT jsonb_agg(jsonb_build_object('id', t.id)) FROM public.teams t WHERE t.id IN (%T%))), now()$m$,
  $m$SELECT (SELECT count(*) FROM public.teams WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (9,  'game_slots', 'inserted', 'edit', 'keep', NULL,
  $m$UPDATE public.game_slots SET capacity = 2 WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.game_slots WHERE id IN (%T%) AND capacity = 2) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (10, 'game_slots', 'inserted', 'attach', 'keep', NULL,
  $m$INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source)
     SELECT gen_random_uuid(), gs.organization_id, 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(40), gs.id, gs.id, gs.field_id, pg_temp.u(11), pg_temp.u(13), 'QD', 9, gs.start, gs."end", 'auto'
       FROM public.game_slots gs WHERE gs.id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.game_slots WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND (SELECT count(*) FROM public.game_assignments WHERE week_index = 9 AND game_slot_id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (11, 'game_assignments', 'inserted', 'edit', 'refuse', NULL,
  $m$UPDATE public.game_assignments SET division = division || ' x' WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.game_assignments WHERE id IN (%T%) AND division LIKE '% x') = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (12, 'game_assignments', 'inserted', 'remove', 'refuse', NULL,
  $m$DELETE FROM public.game_assignments WHERE id IN (%T%)$m$,
  $m$SELECT NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id IN (%T%)) AND EXISTS (%T%)$m$),
 (13, 'game_assignments', 'updated', 'edit', 'refuse', NULL,
  $m$UPDATE public.game_assignments SET division = division || ' x' WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.game_assignments WHERE id IN (%T%) AND division LIKE '% x') = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (14, 'game_assignments', 'updated', 'remove', 'refuse', NULL,
  $m$DELETE FROM public.game_assignments WHERE id IN (%T%)$m$,
  $m$SELECT NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id IN (%T%)) AND EXISTS (%T%)$m$),
 (15, 'game_assignments', 'updated', 'later-run', 'refuse', NULL,
  $m$UPDATE public.game_assignments SET run_id = pg_temp.u(41) WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.game_assignments WHERE id IN (%T%) AND run_id = pg_temp.u(41)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (16, 'game_assignments', 'deleted', 'stands-again', 'refuse', NULL,
  $m$INSERT INTO public.game_assignments SELECT (jsonb_populate_record(NULL::public.game_assignments, r.previous_payload)).*
       FROM public.import_application_records r WHERE r.import_job_id = %JOB% AND r.target_table = 'game_assignments' AND r.operation = 'deleted'$m$,
  $m$SELECT (SELECT count(*) FROM public.game_assignments WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (17, 'schedule_tbd', 'inserted', 'edit', 'refuse', NULL,
  $m$UPDATE public.schedule_tbd SET game_date = game_date + 1 WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.schedule_tbd s WHERE id IN (%T%) AND s.game_date IS NOT NULL) = (SELECT count(*) FROM (%T%) q) AND (SELECT count(*) FROM public.import_application_records r JOIN public.schedule_tbd s ON s.id = r.target_id WHERE r.import_job_id = %JOB% AND r.target_table = 'schedule_tbd' AND r.operation = 'inserted' AND s.game_date = (r.applied_payload ->> 'game_date')::date + 1) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (18, 'schedule_tbd', 'inserted', 'remove', 'refuse', NULL,
  $m$DELETE FROM public.schedule_tbd WHERE id IN (%T%)$m$,
  $m$SELECT NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE id IN (%T%)) AND EXISTS (%T%)$m$),
 (19, 'schedule_tbd', 'updated', 'edit', 'refuse', NULL,
  $m$UPDATE public.schedule_tbd SET game_date = game_date + 1 WHERE id IN (%T%)$m$,
  $m$SELECT (SELECT count(*) FROM public.import_application_records r JOIN public.schedule_tbd s ON s.id = r.target_id WHERE r.import_job_id = %JOB% AND r.target_table = 'schedule_tbd' AND r.operation = 'updated' AND s.game_date = (r.applied_payload ->> 'game_date')::date + 1) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (20, 'schedule_tbd', 'updated', 'remove', 'refuse', NULL,
  $m$DELETE FROM public.schedule_tbd WHERE id IN (%T%)$m$,
  $m$SELECT NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE id IN (%T%)) AND EXISTS (%T%)$m$),
 (21, 'schedule_tbd', 'deleted', 'stands-again', 'refuse', NULL,
  $m$INSERT INTO public.schedule_tbd SELECT (jsonb_populate_record(NULL::public.schedule_tbd, r.previous_payload)).*
       FROM public.import_application_records r WHERE r.import_job_id = %JOB% AND r.target_table = 'schedule_tbd' AND r.operation = 'deleted'$m$,
  $m$SELECT (SELECT count(*) FROM public.schedule_tbd WHERE id IN (%T%)) = (SELECT count(*) FROM (%T%) q) AND EXISTS (%T%)$m$),
 (22, 'scheduler_runs', 'unrecorded', 'game-saved-into-the-run', 'keep',
  $m$SELECT sr.id FROM public.scheduler_runs sr WHERE sr.run_type = 'game' AND sr.parameters ->> 'import_job_id' = %JOB%::text$m$,
  $m$INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source)
     SELECT gen_random_uuid(), sr.organization_id, sr.season_settings_id, sr.id, pg_temp.u(21), pg_temp.u(12), pg_temp.u(14), 'QD', 8, '2027-07-01T09:00:00Z', '2027-07-01T10:00:00Z', 'auto'
       FROM public.scheduler_runs sr WHERE sr.id IN (%T%)$m$,
  $m$SELECT EXISTS (SELECT 1 FROM public.game_assignments g WHERE g.division = 'QD' AND g.week_index = 8 AND g.run_id IN (%T%)) AND EXISTS (%T%)$m$),
 (23, 'scheduler_runs', 'unrecorded', 'evaluation-names-the-run', 'keep',
  $m$SELECT sr.id FROM public.scheduler_runs sr WHERE sr.run_type = 'game' AND sr.parameters ->> 'import_job_id' = %JOB%::text$m$,
  $m$INSERT INTO public.evaluation_runs (organization_id, scheduler_run_id, scheduler_run_type, status)
     SELECT sr.organization_id, sr.id, 'game', 'completed' FROM public.scheduler_runs sr WHERE sr.id IN (%T%)$m$,
  $m$SELECT EXISTS (SELECT 1 FROM public.evaluation_runs e WHERE e.scheduler_run_id IN (%T%)) AND EXISTS (%T%)$m$);

-- readers: what the pages and the exports read as the CURRENT schedule after a rollback that went through, by their own
-- rule (fix round 4, Codex on e699b1f: a run the rollback keeps must never be the current one). The game readers
-- (useSchedulerRun, readCurrentSavedGameIds) take the latest COMPLETED game run by completed_at and its games; the team
-- reader (useTeamSummary) takes the latest team run that is completed or running. 'ok', or what is wrong:
--   the current game run must be the run before the import, holding the two games it held;
--   no team run of the import lists a team that does not exist; a shell that was kept is listed by a run a reader takes.
CREATE FUNCTION pg_temp.readers(p_job uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_run uuid; v_out text := ''; v_n int;
BEGIN
    SELECT sr.id INTO v_run FROM public.scheduler_runs sr
     WHERE sr.organization_id = 'a1111111-1111-1111-1111-111111111111' AND sr.run_type = 'game' AND sr.status = 'completed'
       AND (sr.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' OR sr.season_id = 'a1111111-1111-1111-1111-111111111aaa')
     ORDER BY sr.completed_at DESC LIMIT 1;
    IF v_run IS DISTINCT FROM pg_temp.u(40) THEN v_out := v_out || 'the current game run is not the run before the import; '; END IF;
    SELECT count(*) INTO v_n FROM public.game_assignments ga WHERE ga.run_id = v_run AND ga.id IN (pg_temp.u(50), pg_temp.u(51));
    IF v_n <> 2 THEN v_out := v_out || 'the current game run shows ' || v_n || ' of the 2 restored games; '; END IF;
    SELECT count(*) INTO v_n
      FROM public.scheduler_runs sr,
           LATERAL (SELECT x ->> 'id' AS id FROM jsonb_each(CASE WHEN jsonb_typeof(sr.results -> 'teamsByDivision') = 'object' THEN sr.results -> 'teamsByDivision' ELSE '{}'::jsonb END) e,
                           LATERAL jsonb_array_elements(e.value) x
                    UNION ALL
                    SELECT x ->> 'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sr.results -> 'teams') = 'array' THEN sr.results -> 'teams' ELSE '[]'::jsonb END) x) l
     WHERE sr.organization_id = 'a1111111-1111-1111-1111-111111111111' AND sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = p_job::text
       AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = l.id);
    IF v_n > 0 THEN v_out := v_out || 'a team run of the import lists ' || v_n || ' team(s) that do not exist; '; END IF;
    SELECT count(*) INTO v_n FROM public.import_application_records r JOIN public.teams t ON t.id = r.target_id AND NOT t.is_external
     WHERE r.import_job_id = p_job AND r.target_table = 'teams'
       AND NOT EXISTS (SELECT 1 FROM public.scheduler_runs sr WHERE sr.run_type = 'team' AND sr.status IN ('completed', 'running')
                          AND position(t.id::text IN sr.results::text) > 0);
    IF v_n > 0 THEN v_out := v_out || v_n || ' kept shell(s) are in no team run a reader takes; '; END IF;
    RETURN COALESCE(NULLIF(v_out, ''), 'ok');
END
$f$;
-- trial: apply the later writer's change, call the rollback as the admin, read what is left, and UNDO ALL OF IT (the
-- sentinel), so every scenario starts from the same applied import. The outcome comes back as jsonb.
CREATE FUNCTION pg_temp.trial(p_job uuid, p_mutation text, p_witness text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
    v_res jsonb; v_err text; v_det text; v_wit text; v_state text; v_readers text;
BEGIN
    BEGIN
        PERFORM set_config('request.jwt.claims', '{}', true);
        EXECUTE p_mutation;
        PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
        BEGIN
            v_res := public.rollback_game_import_job(p_job);
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_det = PG_EXCEPTION_DETAIL;
            v_err := SQLSTATE || ':' || COALESCE(v_det, '');
        END;
        EXECUTE p_witness INTO v_wit;
        IF v_err IS NULL THEN v_readers := pg_temp.readers(p_job); END IF;
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1123',
            DETAIL = jsonb_build_object('refused', v_err, 'result', v_res, 'witness', v_wit, 'readers', v_readers)::text;
    EXCEPTION WHEN SQLSTATE 'P1123' THEN
        GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_DETAIL;
        RETURN v_state::jsonb;
    END;
END
$f$;
CREATE TEMP TABLE scen_out (ord int PRIMARY KEY, tbl text, op text, name text, expect text, targets uuid[], outcome jsonb) ON COMMIT DROP;
CREATE FUNCTION pg_temp.run_scenarios(p_job uuid) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
    s record; v_t text; v_targets uuid[]; v_n integer := 0;
BEGIN
    FOR s IN SELECT * FROM scen ORDER BY ord LOOP
        v_t := COALESCE(replace(s.tsql, '%JOB%', quote_literal(p_job::text)),
                        'SELECT target_id FROM public.import_application_records WHERE import_job_id = ' || quote_literal(p_job::text)
                        || ' AND target_table = ' || quote_literal(s.tbl) || ' AND operation = ' || quote_literal(s.op));
        EXECUTE 'SELECT COALESCE(array_agg(x), ARRAY[]::uuid[]) FROM (' || v_t || ') q(x)' INTO v_targets;
        INSERT INTO scen_out VALUES (s.ord, s.tbl, s.op, s.name, s.expect, v_targets,
            pg_temp.trial(p_job, replace(replace(s.mutation, '%T%', v_t), '%JOB%', quote_literal(p_job::text)),
                                 replace(replace(s.witness, '%T%', v_t), '%JOB%', quote_literal(p_job::text))));
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END
$f$;

SELECT ok(pg_temp.universe(pg_temp.apply_src()) <> '' AND array_length(string_to_array(pg_temp.universe(pg_temp.apply_src()), ','), 1) >= 11,
    'Q.1 meta: the apply''s source writes at least eleven (table, operation) pairs into the application records (a census over nothing would pass)');
-- bad_pairs(src): the pairs read out of a source that the record CHECK constraints would refuse (a table or an operation they
-- do not list), so a scan that read garbage is caught.
CREATE FUNCTION pg_temp.bad_pairs(p_src text) RETURNS text LANGUAGE sql AS $f$
    SELECT string_agg(p, ',' ORDER BY p) FROM unnest(string_to_array(pg_temp.universe(p_src), ',')) p
     WHERE position('''' || split_part(p, ':', 1) || '''::text' IN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = 'import_application_records_target_table_check')) = 0
        OR position('''' || split_part(p, ':', 2) || '''::text' IN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = 'import_application_records_operation_check')) = 0
$f$;
SELECT is(pg_temp.bad_pairs(pg_temp.apply_src()), NULL::text,
    'Q.2 every pair read out of the source names a table the record check accepts and an operation it accepts (the scan found real pairs)');
SELECT is(pg_temp.bad_pairs(replace(pg_temp.apply_src(), '''games'', ''divisions'', dv.id', '''games'', ''zz_unknown'', dv.id')), 'zz_unknown:inserted',
    'Q.2b PLANT: a pair whose table the record check does not list is reported');
SELECT is(pg_temp.readback(pg_temp.j('jq')), pg_temp.universe(pg_temp.apply_src()),
    'Q.3 ONE real apply wrote every pair the source can write, and no other (' || pg_temp.universe(pg_temp.apply_src()) || ')');
SELECT is((SELECT string_agg(p, ',' ORDER BY p) FROM (
              SELECT p FROM unnest(string_to_array(pg_temp.universe(pg_temp.apply_src()), ',')) p
               WHERE NOT EXISTS (SELECT 1 FROM scen WHERE scen.tbl || ':' || scen.op = p)
              UNION ALL
              SELECT scen.tbl || ':' || scen.op FROM scen
               WHERE scen.op <> 'unrecorded' AND scen.tbl || ':' || scen.op <> ALL (string_to_array(pg_temp.universe(pg_temp.apply_src()), ','))) q), NULL::text,
    'Q.4 every pair has a scenario, and every scenario is for a pair the apply can write');
SELECT is((SELECT string_agg(t, ',' ORDER BY t) FROM unnest(string_to_array(pg_temp.written(pg_temp.rollback_src()), ',')) t
            WHERE t NOT IN (SELECT tbl FROM scen) AND t NOT IN ('import_application_records', 'import_jobs')), NULL::text,
    'Q.5 every table the rollback deletes from, updates or inserts into has a scenario (only the job''s own bookkeeping, import_jobs and import_application_records, has none)');
SELECT is((SELECT string_agg(p, ',' ORDER BY p) FROM unnest(string_to_array(pg_temp.universe(
            replace(pg_temp.apply_src(), 'SELECT v_org, p_import_job_id, ''games'', ''divisions'', dv.id, ''inserted''',
                    'SELECT v_org, p_import_job_id, ''games'', ''fields'', dv.id, ''updated''')), ',')) p
            WHERE NOT EXISTS (SELECT 1 FROM scen WHERE scen.tbl || ':' || scen.op = p)), 'fields:updated',
    'Q.6 PLANT: a record of a pair no scenario covers (fields, updated) added to the apply''s source is reported as uncovered');
SELECT is((SELECT string_agg(t, ',' ORDER BY t) FROM unnest(string_to_array(pg_temp.written(pg_temp.rollback_src() || ' DELETE FROM public.zz_plant WHERE true;'), ',')) t
            WHERE t NOT IN (SELECT tbl FROM scen) AND t NOT IN ('import_application_records', 'import_jobs')), 'zz_plant',
    'Q.7 PLANT: a DELETE from a table no scenario names, added to the rollback''s source, is reported');

-- The control: the same rollback with NO later change takes the whole import back (nothing refused, nothing kept, every
-- row as it was before the apply), so a refusal or a kept record below is the later change's doing and not the fixture's.
SELECT is((SELECT (pg_temp.trial(pg_temp.j('jq'), 'SELECT 1', 'SELECT ' || quote_literal('true')))::text),
    (SELECT (pg_temp.trial(pg_temp.j('jq'), 'SELECT 1', 'SELECT ' || quote_literal('true')))::text),
    'Q.8a control: the trial is repeatable (an undone call leaves the applied import as it was)');
CREATE FUNCTION pg_temp.control() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_res jsonb; v_same boolean;
BEGIN
    BEGIN
        PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
        v_res := public.rollback_game_import_job(pg_temp.j('jq'));
        v_same := pg_temp.fps() = (SELECT v FROM marks WHERE name = 'q_seed_fp');
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1123', DETAIL = jsonb_build_object('kept', v_res -> 'kept', 'same', v_same)::text;
    EXCEPTION WHEN SQLSTATE 'P1123' THEN
        GET STACKED DIAGNOSTICS v_res = PG_EXCEPTION_DETAIL;
    END;
    RETURN (v_res ->> 'kept') || ' ' || (v_res ->> 'same');
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE || ' ' || SQLERRM;
END
$f$;
SELECT is(pg_temp.control(), '[] true',
    'Q.8 control: with no later change the rollback keeps nothing and every table is as it was before the apply');

SELECT is(pg_temp.run_scenarios(pg_temp.j('jq')), 23, 'Q.9 meta: all 23 scenarios ran, each from the same applied import');
SELECT is((SELECT string_agg(o.tbl || ':' || o.op || '/' || o.name || ' -> ' || COALESCE(o.outcome ->> 'refused', 'rolled back'), '; ' ORDER BY o.ord)
             FROM scen_out o
            WHERE o.expect = 'refuse'
              AND NOT (COALESCE(o.outcome ->> 'refused', '') ~ '^22023:game_import_changed count=[0-9]+ ids=[0-9a-f,-]*( tbd_ids=[0-9a-f,-]+)?$'
                       AND NOT EXISTS (SELECT 1 FROM unnest(o.targets) t
                                        WHERE position(t::text IN o.outcome ->> 'refused') = 0))), NULL::text,
    'Q.10 every scenario that must refuse does: 22023 game_import_changed, naming every record the later writer touched');
SELECT is((SELECT string_agg(o.tbl || ':' || o.op || '/' || o.name || ' -> ' || COALESCE(o.outcome ->> 'refused', 'kept ' || (o.outcome #>> '{result,kept}')), '; ' ORDER BY o.ord)
             FROM scen_out o
            WHERE o.expect = 'keep'
              AND NOT (o.outcome ->> 'refused' IS NULL
                       AND NOT EXISTS (SELECT 1 FROM unnest(o.targets) t
                                        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.outcome #> '{result,kept}') k
                                                           WHERE k ->> 'table' = o.tbl AND (k ->> 'id')::uuid = t)))), NULL::text,
    'Q.11 every scenario that must keep does: the rollback goes through and names every record the later writer touched in kept');
SELECT is((SELECT string_agg(o.tbl || ':' || o.op || '/' || o.name, '; ' ORDER BY o.ord) FROM scen_out o WHERE o.outcome ->> 'witness' IS DISTINCT FROM 'true'), NULL::text,
    'Q.12 and in every scenario what the later writer did is still there afterwards (an edit, a row, a game in the run): nothing it did was deleted, overwritten or set null');
SELECT is((SELECT count(*) FROM scen_out WHERE expect IN ('refuse', 'keep'))::int, 23, 'Q.13 meta: the outcomes table holds the 23 scenarios the file declares');
SELECT is((SELECT string_agg(o.tbl || ':' || o.op || '/' || o.name || ' -> ' || COALESCE(o.outcome ->> 'readers', 'not read'), '; ' ORDER BY o.ord)
             FROM scen_out o WHERE o.outcome ->> 'refused' IS NULL AND o.outcome ->> 'readers' IS DISTINCT FROM 'ok'), NULL::text,
    'Q.14 after every rollback that went through, the readers of the CURRENT schedule see the restored one: the run before the import is the latest completed game run and holds its games (a run the rollback kept is retired, never current), and no team run lists a team that is gone');
SELECT ok((SELECT count(*) FROM scen_out o WHERE o.outcome ->> 'refused' IS NULL) >= 12, 'Q.14b meta: at least twelve scenarios went through and were read (a reader check over nothing would pass)');
-- One shell kept, one gone: the team run stays (it is the only run that lists the kept shell), is still one a reader takes,
-- and lists the kept shell and not the one that is gone.
SELECT is((pg_temp.trial(pg_temp.j('jq'), $m$UPDATE public.teams SET notes = 'kept' WHERE name = 'Shell A'$m$,
        $m$SELECT (SELECT count(*) FROM public.teams WHERE name IN ('Shell A', 'Shell B'))::text || ' ' || (SELECT string_agg(sr.status || ':' || (SELECT string_agg(x ->> 'name', ',' ORDER BY x ->> 'name') FROM jsonb_array_elements(sr.results -> 'teams') x WHERE x ->> 'name' LIKE 'Shell%'), ';')
              FROM public.scheduler_runs sr WHERE sr.run_type = 'team' AND sr.parameters ? 'import_job_id')$m$)) ->> 'witness'
          || ' | ' || (pg_temp.trial(pg_temp.j('jq'), $m$UPDATE public.teams SET notes = 'kept' WHERE name = 'Shell A'$m$, 'SELECT true') ->> 'readers'),
    '1 completed:Shell A | ok',
    'Q.15 a team run kept for a shell that stays is not retired (retiring it would hide a team that exists): it lists the kept shell and no longer the shell that is gone');

SELECT * FROM finish();
ROLLBACK;
