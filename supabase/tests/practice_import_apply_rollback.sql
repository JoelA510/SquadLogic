-- pgTAP: a practice schedule import stages, maps, previews (a dry run), applies, re-imports and rolls back through RPCs
-- (migration 20261123010000; plan docs/changes/2026-11-03-schedule-expansion.md section 4.11 and PR 10, task K2).
--
-- Written first, and red against the code before the migration (every RPC below is missing there). Two worlds:
--
--   F  the shipped placeholder fixture (fixtures/practice-schedule-2026/, 710 rows, the league in
--      _practice_import_fixture.sql, generated from core): J1 previewed and applied, J2 the same file again (a
--      re-import), J3 the file with one team moved (a probable move, unticked then ticked), then J1 rolled back;
--   W  a small league of new labels: J5 creates a division, a location, a field, a half, a team shell and slots, and
--      is used for the rollback class (a later change to every (table, operation) pair the apply writes).
--
-- What is held, each with the control that lets the allowed twin pass:
--   * the lists of 4.11.8 (the CHECKs, create_import_job, the deferred pair, the allowlist's SQL copy) and the K1 promise
--     that persist_practice_schedule, its gate and the TIME TBD refresh are the bodies they were (md5);
--   * the writer's own gap (finding 13) as a fact, and the canonical daterange text of the writer and of the import;
--   * a dry run writes nothing (every table of the public schema read back, before and after) and its result is the
--     apply's; the apply writes manual rows with no run, finds or makes 705 slots, refuses the slot that overlaps, and
--     reports the gate's five rules and the import's own checks equal to the fixture's independent counts
--     (tests/mockPracticeImport.test.js holds these numbers to tests/helpers/practiceSweep.js and to the mock);
--   * a re-import inserts nothing and reports the same flags; a save after an import prunes and moves nothing; the
--     teams short of their count are on the TIME TBD list; a probable move is held back until ticked;
--   * the refusals: no signed-in user, another organization's admin, the wrong job type, a draft and a completed season;
--   * the rollback refuses after a change or an exception and, before one, restores every row that existed before;
--   * shells land in one team run carrying the division's other teams; the rollback class (section 7);
--   * everything the migration grants to a signed-in user, used AS the role `authenticated` (section 8).
--
-- The seed runs with no signed-in user (lesson 56).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql
\set squadlogic_practice_fixture_include 1
\ir _practice_import_fixture.sql

SELECT plan(99);

-- ── Helpers ────────────────────────────────────────────────────────────────
SET client_min_messages = warning;
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
    SELECT ('a1111111-1111-1111-1111-0000000e' || lpad(to_hex(n), 4, '0'))::uuid
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
-- errm: the same with the message, and what the statement did is undone.
CREATE FUNCTION pg_temp.errm(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE s text; d text; m text;
BEGIN
    BEGIN
        EXECUTE p_sql;
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1123';
    EXCEPTION WHEN SQLSTATE 'P1123' THEN
        RETURN 'no error';
    END;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL, m = MESSAGE_TEXT;
    RETURN s || ':' || COALESCE(d, '') || ':' || m;
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
-- fp: a fingerprint of EVERY table of the public schema (a dry run must write nothing, anywhere).
CREATE FUNCTION pg_temp.fp() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record; acc text := ''; h text;
BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY c.relname LOOP
        EXECUTE format('SELECT md5(COALESCE(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM public.%I t', r.relname) INTO h;
        acc := acc || r.relname || ':' || h || ';';
    END LOOP;
    RETURN md5(acc);
END
$f$;
-- before: the rows that existed before the imports, to the last column (a rollback must leave each byte-equal).
CREATE FUNCTION pg_temp.before_rows() RETURNS text LANGUAGE sql AS $f$
    SELECT md5(string_agg(x, E'\n' ORDER BY x)) FROM (
        SELECT 'pa:' || t::text AS x FROM public.practice_assignments t WHERE t.id = pg_temp.u(900)
        UNION ALL SELECT 'ps:' || t::text FROM public.practice_slots t WHERE t.id IN (pg_temp.u(901), pg_temp.u(902))
        UNION ALL SELECT 'tm:' || t::text FROM public.teams t WHERE t.organization_id = 'a1111111-1111-1111-1111-111111111111'
                                                             AND t.id NOT IN (SELECT r.target_id FROM public.import_application_records r WHERE r.target_table = 'teams')
        UNION ALL SELECT 'dv:' || t::text FROM public.divisions t WHERE t.organization_id = 'a1111111-1111-1111-1111-111111111111'
                                                             AND t.id NOT IN (SELECT r.target_id FROM public.import_application_records r WHERE r.target_table = 'divisions')
        UNION ALL SELECT 'fs:' || t::text FROM public.field_subunits t WHERE t.organization_id = 'a1111111-1111-1111-1111-111111111111'
                                                             AND t.id NOT IN (SELECT r.target_id FROM public.import_application_records r WHERE r.target_table = 'field_subunits')) q
$f$;
-- k: core's practiceLabelKey for the plain labels of these files; k2, k3: the JSON tuples core keys a field, a half and
-- a team by (JSON.stringify of the keys).
CREATE FUNCTION pg_temp.k(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT lower(btrim(p)) $f$;
CREATE FUNCTION pg_temp.k2(a text, b text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
    SELECT '[' || to_json(lower(btrim(a)))::text || ',' || to_json(lower(btrim(b)))::text || ']'
$f$;
CREATE FUNCTION pg_temp.k3(a text, b text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
    SELECT '[' || to_json(lower(btrim(a)))::text || ',' || to_json(lower(btrim(b)))::text || ',' || to_json(lower(btrim(c)))::text || ']'
$f$;
-- stage: one staged row of a practice job, as core's toStagedPracticeRow builds it.
CREATE FUNCTION pg_temp.stage(p_job uuid, p_row int, p_status text, p_team text, p_division text, p_day text, p_start text, p_end text,
                              p_loc text, p_field text, p_sub text, p_from text, p_until text, p_cap int DEFAULT 1)
RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES ('a1111111-1111-1111-1111-111111111111', p_job, 'practice_schedule', p_row, '{}'::jsonb,
            jsonb_build_object('row_key', 'row-' || p_row, 'status', p_status, 'day', p_day, 'start_time', p_start, 'end_time', p_end,
                'valid_from', p_from, 'valid_until', p_until, 'capacity', p_cap, 'flags', '[]'::jsonb,
                'division', COALESCE(p_division, ''), 'division_key', CASE WHEN p_status = 'placement' THEN pg_temp.k(p_division) ELSE '' END,
                'location', p_loc, 'location_key', pg_temp.k(p_loc), 'field', p_field, 'field_key', pg_temp.k2(p_loc, p_field),
                'subunit', COALESCE(p_sub, ''), 'subunit_key', CASE WHEN COALESCE(p_sub, '') = '' THEN '' ELSE pg_temp.k3(p_loc, p_field, p_sub) END,
                'team', COALESCE(p_team, ''), 'team_key', CASE WHEN p_status = 'placement' THEN pg_temp.k2(p_division, p_team) ELSE '' END),
            '[]'::jsonb)
$f$;
-- n: a number (or any value) out of a result by path ('counts,inserted').
CREATE FUNCTION pg_temp.n(p_res jsonb, p_path text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(p_res #>> string_to_array(p_path, ','), 'NULL')
$f$;
-- same: a result without what differs between a dry run and an apply.
CREATE FUNCTION pg_temp.same(p_res jsonb) RETURNS jsonb LANGUAGE sql AS $f$ SELECT p_res - 'dry_run' - 'ids' - 'replayed' $f$;
-- job: a practice schedule job made as Org A's admin.
CREATE FUNCTION pg_temp.job(p_name text) RETURNS uuid LANGUAGE sql AS $f$
    SELECT (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'practice_schedule', p_name)).id
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.u(int), pg_temp.err(text), pg_temp.errm(text), pg_temp.val(text), pg_temp.fp(), pg_temp.before_rows(),
    pg_temp.k(text), pg_temp.k2(text, text), pg_temp.k3(text, text, text),
    pg_temp.stage(uuid, int, text, text, text, text, text, text, text, text, text, text, text, int),
    pg_temp.n(jsonb, text), pg_temp.same(jsonb), pg_temp.job(text) TO PUBLIC;
CREATE TEMP TABLE t_res (k text PRIMARY KEY, r jsonb) ON COMMIT DROP;
CREATE TEMP TABLE t_job (k text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT ALL ON t_res, t_job TO PUBLIC;

-- ── Seed (no signed-in user) ───────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';
-- A saved practice that existed before any import (the fixture's own A-Team, Org A U10), on a saved slot of its own, and
-- a second saved slot the W file will overlap. Both must come out of every import and rollback byte-equal.
INSERT INTO public.locations (id, organization_id, name) VALUES (pg_temp.u(910), 'a1111111-1111-1111-1111-111111111111', 'Before Park');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (pg_temp.u(911), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(910), 'Before Field');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until) VALUES
    (pg_temp.u(901), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(911), 'sat', '09:00', '10:00', 1, '2026-09-07', '2026-11-20'),
    (pg_temp.u(902), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(911), 'sun', '09:00', '10:00', 1, '2026-09-07', '2026-11-20');
INSERT INTO public.practice_assignments (id, organization_id, team_id, slot_id, practice_slot_id, day_of_week, start_time, end_time, field_id,
                                         effective_date_range, source, assigned_via)
VALUES (pg_temp.u(900), 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', pg_temp.u(901), pg_temp.u(901),
        'sat', '09:00:00', '10:00:00', pg_temp.u(911), '[2026-09-07,2026-11-20]', 'manual', 'manual');
-- A completed season and a draft one of Org A, each with a job made before it was closed (the trigger lets no-user writes through).
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    (pg_temp.u(960), 'a1111111-1111-1111-1111-111111111111', 'Org A Old', 'draft', 2025),
    (pg_temp.u(961), 'a1111111-1111-1111-1111-111111111111', 'Org A Next', 'draft', 2027);
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, season_settings_id, warning_summary) VALUES
    (pg_temp.u(970), 'a1111111-1111-1111-1111-111111111111', 'practice_schedule', 'x', 'ready_to_apply', pg_temp.u(960), '{"practice_mapping": {}}'),
    (pg_temp.u(971), 'a1111111-1111-1111-1111-111111111111', 'practice_schedule', 'x', 'ready_to_apply', pg_temp.u(961), '{"practice_mapping": {}}'),
    (pg_temp.u(972), 'a1111111-1111-1111-1111-111111111111', 'games', 'x', 'ready_to_apply', 'a1111111-1111-1111-1111-111111111aaa', '{}');
UPDATE public.season_settings SET status = 'completed' WHERE id = pg_temp.u(960);

-- ── 0. The lists, and what K1 promises not to touch ─────────────────────────
SELECT is(pg_temp.val($$SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
                        WHERE conname IN ('import_jobs_job_type_check', 'staging_import_rows_import_type_check', 'import_application_records_import_type_check')
                          AND pg_get_constraintdef(oid) ~ '''practice_schedule'''$$),
    'import_application_records_import_type_check,import_jobs_job_type_check,staging_import_rows_import_type_check',
    'the job type, the staged type and the application record type admit practice_schedule');
SELECT ok(pg_temp.val($$SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'import_application_records_target_table_check'$$) ~ '''practice_assignments''',
    'an application record may name practice_assignments');
SELECT is(pg_temp.val($$SELECT cardinality(public.import_allowed_keys('practice_schedule'))$$), '19', 'import_allowed_keys has the 19 staged keys');
SELECT is(pg_temp.val($$SELECT string_agg(p.proname || '=' || md5(replace(p.prosrc, E'\r', '')), ',' ORDER BY p.proname) FROM pg_proc p
                        WHERE p.oid IN (to_regprocedure('public.persist_practice_schedule(jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb,text)'),
                                        to_regprocedure('public.practice_new_auto_row_refusals(uuid,uuid[])'),
                                        to_regprocedure('public.refresh_schedule_tbd_practices(uuid)'),
                                        to_regprocedure('public.sync_schedule_tbd_practices(uuid,uuid,uuid,jsonb)'))$$),
    'persist_practice_schedule=f33e164711af7a1412ab9596608f9531,practice_new_auto_row_refusals=5a6658441b95a7444bfcb99fef293042,refresh_schedule_tbd_practices=cd22827ffadb16a363deb06c5b3ef8b7,sync_schedule_tbd_practices=210bd955a160a980ba12e1bec62ca58c',
    'K1: the writer, its gate, the TIME TBD refresh and its sync are the bodies they were');
SELECT is(pg_temp.val($$SELECT string_agg(p.proname || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname)
                        FROM pg_proc p WHERE p.proname IN ('ensure_practice_slot', 'practice_import_referenced')$$),
    'ensure_practice_slot:false,practice_import_referenced:false', 'the two helpers are internal: no client role may execute them');

-- ── 1. The writer's own gap (finding 13) and the canonical range ────────────
-- One team, two slots on one weekday at one time, both manual, in ONE payload: the writer accepts both (its double-booking
-- check compares a payload's keys with rows already stored, and its gate skips manual rows). Reported, not fixed (rule 2).
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (pg_temp.u(1), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Gap Div');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES (pg_temp.u(2), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Gap Team'),
    (pg_temp.u(3), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(1), 'Range Team');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until) VALUES
    (pg_temp.u(4), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(911), 'mon', '07:00', '08:00', 1, '2026-09-07', '2026-11-20'),
    (pg_temp.u(5), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(911), 'mon', '07:00', '08:00', 1, '2026-09-07', '2026-11-20');
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.persist_practice_schedule(jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
        jsonb_build_array(jsonb_build_object('team_id', %L, 'practice_slot_id', %L, 'effective_date_range', '[2026-09-07,2026-11-20]', 'source', 'manual'),
                          jsonb_build_object('team_id', %L, 'practice_slot_id', %L, 'effective_date_range', '[2026-09-07,2026-11-20]', 'source', 'manual')))$$,
        pg_temp.u(2), pg_temp.u(4), pg_temp.u(2), pg_temp.u(5))), 'no error',
    'FINDING 13 (a fact): one payload with two manual rows of one team on one weekday at one time is accepted by the writer');
SELECT is(pg_temp.val(format($$SELECT count(*) FROM public.practice_assignments WHERE team_id = %L$$, pg_temp.u(2))), '2',
    'and both rows are stored: the gap the import''s weekday flag reports for its own rows');
RESET ROLE;
SET LOCAL "request.jwt.claims" TO '{}';
DELETE FROM public.practice_assignments WHERE team_id = pg_temp.u(2);
DELETE FROM public.practice_slots WHERE id IN (pg_temp.u(4), pg_temp.u(5));
SELECT pg_temp.before_rows() AS before_rows \gset
SELECT pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE run_type = 'practice'$$) AS practice_runs0 \gset

-- ── 2. The fixture: stage, map, preview ────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO t_job VALUES ('J1', pg_temp.job('practice-schedule.csv'));
SELECT is(pg_temp.val($$SELECT job_type || '/' || (season_settings_id = 'a1111111-1111-1111-1111-111111111aaa')::text FROM public.import_jobs WHERE id = (SELECT id FROM t_job WHERE k = 'J1')$$),
    'practice_schedule/true', 'create_import_job makes a practice_schedule job in the active season');
SELECT is(pg_temp.err(format($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'practice_schedule', 'x.csv', %L)$$, pg_temp.u(961))),
    '22023:season_not_active', 'and refuses a draft season for it (only the active season takes one)');
SELECT is(pg_temp.stage_fixture((SELECT id FROM t_job WHERE k = 'J1')), 710, 'the 710 rows of the fixture are staged');
SELECT is(pg_temp.n(public.mark_import_job_ready_to_apply((SELECT id FROM t_job WHERE k = 'J1'), 'practice_schedule'), 'staged_rows'), '710',
    'the deferred pair takes a practice_schedule job');
SELECT is(pg_temp.err($$SELECT public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'), true)$$), '22023:mapping_required',
    'an apply before the mapping is refused');
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.n(public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'), pg_temp.fixture_mapping()), 'teams'), '132',
    'the mapping is stored (as the role): 132 teams, every label decided');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = (SELECT id FROM t_job WHERE k = 'J1')
                         AND metadata ->> 'import_type' = 'practice_schedule'$$), '1', 'storing the mapping is audited import.mapped');
SELECT is(pg_temp.errm(format($$SELECT public.map_practice_import_job(%L, '{"teams": {"x": {"action": "map", "id": "aaaaaaaa-0000-0000-0000-000000000099"}}}')$$,
        (SELECT id FROM t_job WHERE k = 'J1'))) ~ '^22023', true, 'a map onto a team that is not the organization''s is refused');
RESET ROLE;
SELECT pg_temp.fp() AS fp0 \gset
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('dry', public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'), true));
RESET ROLE;
SELECT is(pg_temp.fp(), :'fp0', 'a dry run changes nothing: every table of the public schema reads back the same');
SELECT is(pg_temp.n(r, 'dry_run'), 'true', 'the preview says it is one') FROM t_res WHERE k = 'dry';
-- The outcomes of the file, each non-zero first (a count that examined nothing is no count).
SELECT is(pg_temp.n(r, 'counts,placements') || ' ' || pg_temp.n(r, 'counts,open') || ' ' || pg_temp.n(r, 'counts,holds') || ' ' || pg_temp.n(r, 'counts,refused'),
    '236 473 1 1', 'placements, open slots, holds and refused rows of the fixture') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'counts,inserted') || ' ' || pg_temp.n(r, 'counts,slots_created') || ' ' || pg_temp.n(r, 'counts,unchanged') || ' ' || pg_temp.n(r, 'counts,slots_found'),
    '236 705 0 0', 'the first import inserts 236 practices and makes 705 slots (every timed row is a slot, used or not)') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'refused_by_reason'), '{"slot-overlaps-another": 1}', 'the one refusal is the slot that overlaps another (practice_slot_conflicts)') FROM t_res WHERE k = 'dry';
SELECT ok(pg_temp.n(r, 'refused,0,message') ~ 'overlaps the slot of row 552', 'and it names the row whose slot it overlaps') FROM t_res WHERE k = 'dry';
-- The flags by rule, equal to the fixture's independent counts (tests/mockPracticeImport.test.js binds them to the sweep):
-- 5 double-placed teams and the half-pair team on one weekday twice (weekday: 6 teams, 12 rows); the half-pair team over its
-- count (count: 1 team, its 3 rows); the over-capacity cell (capacity: 2 teams in it); the coach on two teams at one start
-- (coach-conflict: both teams' rows); the team on both halves (2 rows). No slot is reserved, and every length is right.
SELECT is(pg_temp.n(r, 'flags,weekday,teams') || '/' || pg_temp.n(r, 'flags,weekday,rows'), '6/12', 'weekday: 6 teams, 12 rows') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'flags,count,teams') || '/' || pg_temp.n(r, 'flags,count,rows'), '1/3', 'count: 1 team, 3 rows') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'flags,capacity,teams') || '/' || pg_temp.n(r, 'flags,capacity,rows'), '2/2', 'capacity: one cell, 2 rows') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'flags,coach-conflict,teams') || '/' || pg_temp.n(r, 'flags,coach-conflict,rows'), '2/2', 'coach-conflict: one coach, two teams') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'flags,team-on-both-halves,teams') || '/' || pg_temp.n(r, 'flags,team-on-both-halves,rows'), '1/2', 'team-on-both-halves: one team, two rows') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'flags,reservation') || ' ' || pg_temp.n(r, 'flags,length') || ' ' || pg_temp.n(r, 'flags,hold-over-open-slot'), 'NULL NULL NULL',
    'no reservation, no wrong length and no hold over a slot in the fixture (the controls)') FROM t_res WHERE k = 'dry';
SELECT is((SELECT count(*) FROM jsonb_array_elements(r -> 'time_tbd' -> 'teams') e WHERE (e ->> 'in_file')::boolean)::text, '29',
    'TIME TBD: the 29 one-practice teams of the file (the row refused for its overlapping slot is an open one: core keeps the slot a team is in)') FROM t_res WHERE k = 'dry';
SELECT is(pg_temp.n(r, 'coverage,coach_judged_teams') || '/' || pg_temp.n(r, 'coverage,file_teams'), '132/132', 'coverage says how many teams coach overlap was judged for') FROM t_res WHERE k = 'dry';

-- ── 3. The apply ───────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('apply', public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'), false));
RESET ROLE;
SELECT is((SELECT pg_temp.same(a.r) FROM t_res a WHERE a.k = 'apply'), (SELECT pg_temp.same(d.r) FROM t_res d WHERE d.k = 'dry'),
    'the preview is the apply: the dry run''s result equals the apply''s, every count, list and flag');
SELECT is(pg_temp.val($$SELECT count(*) || ' ' || count(*) FILTER (WHERE source = 'manual' AND assigned_via = 'manual' AND run_id IS NULL)
                         FROM public.practice_assignments WHERE id IN (SELECT target_id FROM public.import_application_records
                          WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments')$$),
    '236 236', 'every imported practice is manual, assigned manual, in no run');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE run_type = 'practice'$$), :'practice_runs0',
    'no practice run is made (the readiness panel reads the latest solver run)');
SELECT is(pg_temp.val($$SELECT string_agg(target_table || '=' || n, ',' ORDER BY target_table) FROM (SELECT target_table, count(*) n FROM public.import_application_records
                         WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') GROUP BY 1) x$$),
    'practice_assignments=236,practice_slots=705', 'one application record per row written');
SELECT is(pg_temp.val($$SELECT status FROM public.import_jobs WHERE id = (SELECT id FROM t_job WHERE k = 'J1')$$), 'completed_with_warnings', 'the job is completed, with warnings');
SELECT is(pg_temp.val($$SELECT metadata ->> 'inserted' FROM public.audit_log WHERE action = 'import.completed' AND resource_id = (SELECT id FROM t_job WHERE k = 'J1')$$), '236',
    'audited import.completed with the counts');
SELECT is(pg_temp.before_rows(), :'before_rows', 'every row that existed before is byte-equal after the apply');
SELECT is(pg_temp.val($$SELECT count(*) || '/' || sum(missing_count) FROM public.schedule_tbd s JOIN public.teams t ON t.id = s.team_id
                         WHERE s.kind = 'practice' AND t.name ~ '^U\d\d[BG]-'$$), '29/29',
    'the TIME TBD list holds the 29 short teams of the file, each short by one');
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.n(public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'), false), 'replayed'), 'true', 'a second apply of the job replays its result and writes nothing');
RESET ROLE;
-- The same canonical daterange text as the writer's: one row through persist_practice_schedule, one through the import.
SELECT is(pg_temp.val($$SELECT DISTINCT effective_date_range::text FROM public.practice_assignments WHERE id IN (SELECT target_id FROM public.import_application_records
                         WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments')$$),
    '[2026-09-07,2026-11-21)', 'the import stores [from, until] as the writer canonicalises it');
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.err(format($$SELECT public.persist_practice_schedule(jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
        jsonb_build_array(jsonb_build_object('team_id', %L, 'practice_slot_id', %L, 'effective_date_range', '[2026-09-07,2026-11-20]', 'source', 'manual')))$$,
        pg_temp.u(3), pg_temp.u(902))), 'no error', 'the writer saves a row for the same dates');
SELECT is(pg_temp.val(format($$SELECT effective_date_range::text FROM public.practice_assignments WHERE team_id = %L$$, pg_temp.u(3))), '[2026-09-07,2026-11-21)',
    'and stores the same text');
RESET ROLE;
SET LOCAL "request.jwt.claims" TO '{}';
DELETE FROM public.practice_assignments WHERE team_id = pg_temp.u(3);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- A save after the import prunes and moves nothing: an empty save (allow_empty) and a save that names one imported row.
SELECT pg_temp.val($$SELECT md5(string_agg((to_jsonb(pa) - 'updated_at' - 'run_id')::text, ',' ORDER BY pa.id)) FROM public.practice_assignments pa$$) AS asg0 \gset
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.err($$SELECT public.persist_practice_schedule(jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'), '[]'::jsonb, allow_empty => true)$$),
    'no error', 'an empty save after the import is accepted');
RESET ROLE;
SELECT is(pg_temp.val($$SELECT md5(string_agg((to_jsonb(pa) - 'updated_at' - 'run_id')::text, ',' ORDER BY pa.id)) FROM public.practice_assignments pa$$), :'asg0',
    'and prunes and moves nothing: every practice reads back the same (the imported rows are manual, kept for a team absent from a save)');

-- ── 4. A re-import, and the probable moves ─────────────────────────────────
INSERT INTO t_job VALUES ('J2', pg_temp.job('practice-schedule-again.csv'));
SELECT pg_temp.stage_fixture((SELECT id FROM t_job WHERE k = 'J2')) IS NOT NULL AS quiet \gset
SELECT public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J2'), pg_temp.fixture_mapping()) IS NOT NULL AS quiet \gset
SELECT pg_temp.val($$SELECT count(*) FROM public.scheduler_runs$$) AS runs0 \gset
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('re', public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J2'), false));
RESET ROLE;
SELECT is(pg_temp.n(r, 'counts,inserted') || ' ' || pg_temp.n(r, 'counts,unchanged') || ' ' || pg_temp.n(r, 'counts,slots_created') || ' ' || pg_temp.n(r, 'counts,slots_found'),
    '0 236 0 705', 'a re-import inserts nothing: 236 unchanged, 705 slots found') FROM t_res WHERE k = 're';
SELECT is((SELECT r -> 'flags' FROM t_res WHERE k = 're'), (SELECT r -> 'flags' FROM t_res WHERE k = 'apply'), 'and reports the same flags (read from the rows the file names)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs$$), :'runs0', 'and makes no run');
SELECT is(pg_temp.n(r, 'counts,leaving') || ' ' || pg_temp.n(r, 'leaving,0,assignment_id'), '1 ' || pg_temp.u(900)::text,
    'the one saved practice the file does not hold (A-Team''s) is listed leaving, not deleted') FROM t_res WHERE k = 're';
SELECT is(pg_temp.before_rows(), :'before_rows', 'every row that existed before is byte-equal after the re-import');

-- J3: the file again, with one team moved to another cell (row 3 of the file, a placement, onto the open cell of row 2's half
-- an hour later is not a slot: instead it takes the first open row's slot). Its old row leaves, its new row arrives: a
-- probable move, held back until ticked.
INSERT INTO t_job VALUES ('J3', pg_temp.job('practice-schedule-moved.csv'));
SELECT pg_temp.stage_fixture((SELECT id FROM t_job WHERE k = 'J3')) IS NOT NULL AS quiet \gset
CREATE TEMP TABLE t_move ON COMMIT DROP AS
SELECT (SELECT s.source_row_number FROM public.staging_import_rows s WHERE s.import_job_id = (SELECT id FROM t_job WHERE k = 'J3')
          AND s.normalized_payload ->> 'status' = 'placement' ORDER BY s.source_row_number LIMIT 1) AS moved,
       (SELECT s.source_row_number FROM public.staging_import_rows s WHERE s.import_job_id = (SELECT id FROM t_job WHERE k = 'J3')
          AND s.normalized_payload ->> 'status' = 'open' ORDER BY s.source_row_number LIMIT 1) AS open_row;
UPDATE public.staging_import_rows s
   SET normalized_payload = o.normalized_payload || jsonb_build_object('row_key', m.normalized_payload ->> 'row_key', 'status', 'placement',
          'division', m.normalized_payload ->> 'division', 'division_key', m.normalized_payload ->> 'division_key',
          'team', m.normalized_payload ->> 'team', 'team_key', m.normalized_payload ->> 'team_key')
  FROM public.staging_import_rows m, public.staging_import_rows o
 WHERE s.id = m.id AND m.import_job_id = (SELECT id FROM t_job WHERE k = 'J3') AND m.source_row_number = (SELECT moved FROM t_move)
   AND o.import_job_id = m.import_job_id AND o.source_row_number = (SELECT open_row FROM t_move);
DELETE FROM public.staging_import_rows WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J3') AND source_row_number = (SELECT open_row FROM t_move);
SELECT public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), pg_temp.fixture_mapping()) IS NOT NULL AS quiet \gset
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('mv', public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), true));
RESET ROLE;
SELECT is(pg_temp.n(r, 'counts,arriving') || ' ' || pg_temp.n(r, 'counts,probable_move_teams') || ' ' || pg_temp.n(r, 'counts,held_back') || ' ' || pg_temp.n(r, 'counts,inserted'),
    '1 1 1 0', 'UNTICKED: the moved row arrives as a probable move of one team, held back, and nothing is inserted') FROM t_res WHERE k = 'mv';
SELECT is(pg_temp.n(r, 'arriving,0,probable_move') || ' ' || pg_temp.n(r, 'arriving,0,added'), 'true false', 'the arriving row says so') FROM t_res WHERE k = 'mv';
SELECT ok((SELECT r -> 'leaving' FROM t_res WHERE k = 'mv') @> jsonb_build_array(jsonb_build_object('team_id', (SELECT r #>> '{arriving,0,team_id}' FROM t_res WHERE k = 'mv'))),
    'and the team''s old row is listed leaving');
SELECT public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'),
    pg_temp.fixture_mapping() || jsonb_build_object('options', jsonb_build_object('add_moved_rows', jsonb_build_array('row-' || (SELECT moved FROM t_move))))) IS NOT NULL AS quiet \gset
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('mv2', public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), true));
RESET ROLE;
SELECT is(pg_temp.n(r, 'counts,held_back') || ' ' || pg_temp.n(r, 'counts,inserted') || ' ' || pg_temp.n(r, 'arriving,0,added'), '0 1 true',
    'TICKED: the same row is inserted (and the old row stays: an import never deletes)') FROM t_res WHERE k = 'mv2';
SELECT is(pg_temp.val($$SELECT string_agg(metadata ->> 'add_moved_rows', ',' ORDER BY metadata ->> 'add_moved_rows') FROM public.audit_log
                         WHERE action = 'import.mapped' AND resource_id = (SELECT id FROM t_job WHERE k = 'J3')$$), '0,1', 'the tick is in the mapping''s audit');

-- ── 5. The refusals ────────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.err($$SELECT public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), true)$$), '42501:', 'a no-user apply is refused');
SELECT is(pg_temp.err($$SELECT public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'))$$), '42501:', 'and a no-user rollback');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.err($$SELECT public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), true)$$), '42501:', 'another organization''s admin is refused the apply');
SELECT is(pg_temp.err($$SELECT public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), '{}'::jsonb)$$), '42501:', 'the mapping');
SELECT is(pg_temp.err($$SELECT public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'))$$), '42501:', 'and the rollback');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.err($$SELECT public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J3'), true)$$), '42501:', 'a signed-in non-member is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.apply_practice_import_job(%L, true)$$, pg_temp.u(970))), '22023:season_completed', 'a completed season refuses the apply');
SELECT is(pg_temp.err(format($$SELECT public.rollback_practice_import_job(%L)$$, pg_temp.u(970))), '22023:season_completed', 'and the rollback');
SELECT is(pg_temp.err(format($$SELECT public.apply_practice_import_job(%L, true)$$, pg_temp.u(971))), '22023:season_not_active', 'a draft season refuses the apply');
SELECT is(pg_temp.errm(format($$SELECT public.apply_practice_import_job(%L, true)$$, pg_temp.u(972))) ~ '^22023::Import job .* is games, not practice_schedule', true,
    'a job of another type is refused');
-- A malformed staged row refuses the whole apply (a defect of the Edge function, never a row to guess at).
INSERT INTO t_job VALUES ('J4', pg_temp.job('bad.csv'));
SELECT pg_temp.stage((SELECT id FROM t_job WHERE k = 'J4'), 1, 'open', NULL, NULL, 'mon', '18:00', '17:00', 'Before Park', 'Before Field', NULL, '2026-09-07', '2026-11-20');
SELECT public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J4'), '{}'::jsonb) IS NOT NULL AS quiet \gset
SELECT is(pg_temp.err($$SELECT public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J4'), true)$$), '22023:practice_import_staged_invalid',
    'a staged row whose end is not after its start refuses the whole apply');

-- ── 6. The rollback of J1 ──────────────────────────────────────────────────
-- J3's ticked apply was a dry run; J2 inserted nothing. A change since refuses, naming the row; so does an exception.
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.practice_assignments SET source = 'auto' WHERE id = (SELECT min(target_id::text)::uuid FROM public.import_application_records
    WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.errm($$SELECT public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'))$$),
    '22023:practice_import_changed:practice_import_changed count=1 ids=' || (SELECT min(target_id::text) FROM public.import_application_records
        WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments'),
    'a practice changed since (its source) refuses the rollback, naming it');
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.practice_assignments SET source = 'manual' WHERE id = (SELECT min(target_id::text)::uuid FROM public.import_application_records
    WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments');
INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
SELECT pa.organization_id, 'a1111111-1111-1111-1111-111111111aaa', pa.team_id, pa.id, '[2026-10-05,2026-10-06)', 'time_tbd', 'declined'
  FROM public.practice_assignments pa WHERE pa.id = (SELECT max(target_id::text)::uuid FROM public.import_application_records
    WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'))$$), '22023:practice_import_changed',
    'a practice with an exception refuses it too');
SET LOCAL "request.jwt.claims" TO '{}';
DELETE FROM public.practice_exceptions WHERE assignment_id = (SELECT max(target_id::text)::uuid FROM public.import_application_records
    WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments');
-- A practice a later writer removed is gone already: counted, not a refusal.
DELETE FROM public.practice_assignments WHERE id = (SELECT max(target_id::text)::uuid FROM public.import_application_records
    WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J1') AND target_table = 'practice_assignments');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('rb', public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J1')));
RESET ROLE;
SELECT is(pg_temp.n(r, 'assignments_deleted') || ' ' || pg_temp.n(r, 'assignments_already_gone') || ' ' || pg_temp.n(r, 'deleted,practice_slots'),
    '235 1 705', 'before a change the rollback deletes the practices and the slots it made; the one removed since is counted') FROM t_res WHERE k = 'rb';
SELECT is(pg_temp.before_rows(), :'before_rows', 'every row that existed before is byte-equal after the rollback');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.practice_assignments$$), '1', 'only the practice saved before the import is left');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE action = 'import.rolled_back' AND resource_id = (SELECT id FROM t_job WHERE k = 'J1')
                         AND metadata ->> 'import_type' = 'practice_schedule'$$), '1', 'audited import.rolled_back');
SELECT is(pg_temp.err($$SELECT public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J1'))$$), '22023:nothing_to_roll_back', 'a second rollback has nothing to do');

-- ── 7. W: what the import creates, the team shell's run, and the rollback class ─
-- One new division, location, field (two halves) and team shell; an existing team (A-Team) placed too; and a row whose
-- slot overlaps the saved Saturday slot (refused, naming it).
INSERT INTO t_job VALUES ('J5', pg_temp.job('w.csv'));
SELECT pg_temp.stage((SELECT id FROM t_job WHERE k = 'J5'), 1, 'placement', 'W Shell', 'W Div', 'tue', '17:00', '18:00', 'W Park', 'W Field', 'A', '2026-09-07', '2026-11-20');
SELECT pg_temp.stage((SELECT id FROM t_job WHERE k = 'J5'), 2, 'open', NULL, NULL, 'tue', '17:00', '18:00', 'W Park', 'W Field', 'B', '2026-09-07', '2026-11-20');
SELECT pg_temp.stage((SELECT id FROM t_job WHERE k = 'J5'), 3, 'placement', 'A-Team', 'Org A U10', 'wed', '17:00', '18:00', 'W Park', 'W Field', 'B', '2026-09-07', '2026-11-20');
SELECT pg_temp.stage((SELECT id FROM t_job WHERE k = 'J5'), 4, 'placement', 'A-Team', 'Org A U10', 'sat', '09:30', '10:30', 'Before Park', 'Before Field', NULL, '2026-09-07', '2026-11-20');
SELECT pg_temp.stage((SELECT id FROM t_job WHERE k = 'J5'), 5, 'hold', NULL, NULL, 'tue', '17:00', '18:00', 'W Park', 'W Field', 'B', '2026-09-07', '2026-11-20');
SELECT public.map_practice_import_job((SELECT id FROM t_job WHERE k = 'J5'), jsonb_build_object(
    'divisions', jsonb_build_object(pg_temp.k('W Div'), jsonb_build_object('action', 'create'), pg_temp.k('Org A U10'), jsonb_build_object('action', 'map', 'id', 'a1111111-1111-1111-1111-11111111abcd')),
    'locations', jsonb_build_object(pg_temp.k('W Park'), jsonb_build_object('action', 'create'), pg_temp.k('Before Park'), jsonb_build_object('action', 'map', 'id', pg_temp.u(910))),
    'fields', jsonb_build_object(pg_temp.k2('W Park', 'W Field'), jsonb_build_object('action', 'create'), pg_temp.k2('Before Park', 'Before Field'), jsonb_build_object('action', 'map', 'id', pg_temp.u(911))),
    'subunits', jsonb_build_object(pg_temp.k3('W Park', 'W Field', 'A'), jsonb_build_object('action', 'create'), pg_temp.k3('W Park', 'W Field', 'B'), jsonb_build_object('action', 'create')),
    'teams', jsonb_build_object(pg_temp.k2('W Div', 'W Shell'), jsonb_build_object('action', 'create'), pg_temp.k2('Org A U10', 'A-Team'), jsonb_build_object('action', 'map', 'id', 'aaaaaaaa-0000-0000-0000-000000000001')))) IS NOT NULL AS quiet \gset
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('w', public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J5'), false));
RESET ROLE;
SELECT is(pg_temp.n(r, 'counts,divisions_created') || pg_temp.n(r, 'counts,locations_created') || pg_temp.n(r, 'counts,fields_created')
          || pg_temp.n(r, 'counts,subunits_created') || pg_temp.n(r, 'counts,team_shells_created') || ' ' || pg_temp.n(r, 'counts,slots_created')
          || ' ' || pg_temp.n(r, 'counts,inserted') || ' ' || pg_temp.n(r, 'counts,held_back'),
    '11121 3 1 1', 'W creates a division, a location, a field, two halves and a shell, three slots and one practice; A-Team''s new row is a probable move (its saved row leaves) and is held back') FROM t_res WHERE k = 'w';
SELECT ok(pg_temp.n(r, 'refused,0,message') ~ ('overlaps the saved slot ' || pg_temp.u(901)::text), 'the row overlapping the saved Saturday slot is refused, naming that slot') FROM t_res WHERE k = 'w';
SELECT is(pg_temp.n(r, 'flags,hold-over-open-slot,rows'), '1', 'the hold over the open slot of the same cell is flagged') FROM t_res WHERE k = 'w';
SELECT is(pg_temp.val($$SELECT f.supports_halves::text FROM public.fields f WHERE f.name = 'W Field'$$), 'true', 'a field the import creates with halves supports halves');
-- PR 5's two checks of 4.5 for the shell: the team writer took a payload with teams and no team_players, and the shell is in
-- the run's results the pages read, beside the division's other teams.
SELECT is(pg_temp.val($$SELECT (sr.results -> 'teams') @> jsonb_build_array(jsonb_build_object('name', 'W Shell'))
                         AND jsonb_typeof(sr.results -> 'teamsByDivision' -> 'W Div') = 'array'
                         AND sr.parameters ->> 'import_type' = 'practice_schedule'
                        FROM public.scheduler_runs sr WHERE sr.parameters ->> 'import_job_id' = (SELECT id FROM t_job WHERE k = 'J5')::text$$), 'true',
    'the shell lands in ONE team run, in results.teams and teamsByDivision');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE name = 'W Shell' AND NOT is_external$$), '1', 'and is a team of the organization');

-- The rollback class: every (table, operation) pair the apply records is `inserted`, and each gets a later change. A
-- scenario runs the change and the rollback in a sub-transaction and is undone, so each starts from the applied state.
CREATE FUNCTION pg_temp.scenario(p_change text, p_witness text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_res jsonb; v_out text; s text; d text;
BEGIN
    BEGIN
        PERFORM set_config('request.jwt.claims', '{}', true);
        EXECUTE p_change;
        PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
        v_res := public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J5'));
        EXECUTE p_witness INTO v_out;
        v_out := 'kept=' || COALESCE((SELECT string_agg(DISTINCT e ->> 'table', ',' ORDER BY e ->> 'table') FROM jsonb_array_elements(v_res -> 'kept') e), '')
                 || ' witness=' || COALESCE(v_out, 'NULL');
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1124';
    EXCEPTION WHEN SQLSTATE 'P1124' THEN
        PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
        RETURN v_out;
    END;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
    RETURN 'refused ' || s || ':' || COALESCE(d, '');
END
$f$;
SELECT is(pg_temp.val($$SELECT string_agg(DISTINCT target_table || ':' || operation, ',' ORDER BY target_table || ':' || operation) FROM public.import_application_records
                         WHERE import_job_id = (SELECT id FROM t_job WHERE k = 'J5')$$),
    'divisions:inserted,field_subunits:inserted,fields:inserted,locations:inserted,practice_assignments:inserted,practice_slots:inserted,teams:inserted',
    'ONE real apply writes all seven pairs the apply''s text can write (tests/practiceImportRollbackClass.test.js reads them from the text)');
SELECT is(pg_temp.scenario('SELECT 1', $$SELECT count(*)::text FROM public.teams WHERE name = 'W Shell'$$), 'kept= witness=0',
    'control: with no change since, the rollback deletes everything W created and keeps nothing');
SELECT is(pg_temp.scenario($$UPDATE public.practice_assignments SET effective_date_range = '[2026-09-14,2026-11-21)' WHERE team_id = (SELECT id FROM public.teams WHERE name = 'W Shell')$$, 'SELECT 1'),
    'refused 22023:practice_import_changed', 'practice_assignments, edited (its range): refused');
SELECT is(pg_temp.scenario($$DELETE FROM public.practice_assignments WHERE team_id = (SELECT id FROM public.teams WHERE name = 'W Shell')$$,
                           $$SELECT count(*)::text FROM public.practice_slots ps JOIN public.fields f ON f.id = ps.field_id WHERE f.name = 'W Field'$$),
    'kept= witness=0', 'practice_assignments, removed by a later writer: counted as gone, the rest rolled back');
SELECT is(pg_temp.scenario($$UPDATE public.practice_slots SET capacity = 5 WHERE id IN (SELECT ps.id FROM public.practice_slots ps JOIN public.field_subunits s ON s.id = ps.field_subunit_id WHERE s.label = 'B' AND ps.day_of_week = 'tue' AND ps.field_id = (SELECT id FROM public.fields WHERE name = 'W Field'))$$,
                           $$SELECT capacity::text FROM public.practice_slots ps JOIN public.field_subunits s ON s.id = ps.field_subunit_id WHERE s.label = 'B' AND ps.day_of_week = 'tue'$$),
    'kept=field_subunits,fields,locations,practice_slots witness=5', 'practice_slots, edited: kept with its parents, and the edit survives');
SELECT is(pg_temp.scenario(format($$INSERT INTO public.practice_assignments (organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
        SELECT 'a1111111-1111-1111-1111-111111111111', %L, ps.id, ps.id, '[2026-09-07,2026-11-21)', 'manual' FROM public.practice_slots ps
          JOIN public.field_subunits s ON s.id = ps.field_subunit_id WHERE s.label = 'B' AND ps.day_of_week = 'tue' AND ps.field_id = (SELECT id FROM public.fields WHERE name = 'W Field')$$, pg_temp.u(3)),
        format($$SELECT count(*)::text FROM public.practice_assignments WHERE team_id = %L$$, pg_temp.u(3))),
    'kept=field_subunits,fields,locations,practice_slots witness=1', 'practice_slots, used by a later save: kept, and that practice survives');
SELECT is(pg_temp.scenario($$UPDATE public.field_subunits SET label = 'Bee' WHERE label = 'B' AND field_id = (SELECT id FROM public.fields WHERE name = 'W Field')$$,
                           $$SELECT label FROM public.field_subunits WHERE label = 'Bee'$$),
    'kept=field_subunits,fields,locations witness=Bee', 'field_subunits, renamed: kept');
SELECT is(pg_temp.scenario($$INSERT INTO public.field_blackouts (organization_id, field_id, blackout_from, blackout_until, reason) SELECT organization_id, id, '2026-10-01', '2026-10-02', 'maintenance' FROM public.fields WHERE name = 'W Field'$$,
                           $$SELECT count(*)::text FROM public.field_blackouts fb JOIN public.fields f ON f.id = fb.field_id WHERE f.name = 'W Field'$$),
    'kept=fields,locations witness=1', 'fields, given a blackout since: kept (the cascade would have taken the blackout)');
SELECT is(pg_temp.scenario($$UPDATE public.locations SET latitude = 45.5, longitude = -122.6 WHERE name = 'W Park'$$, $$SELECT latitude::text FROM public.locations WHERE name = 'W Park'$$),
    'kept=locations witness=45.5000', 'locations, given coordinates since: kept');
SELECT is(pg_temp.scenario($$UPDATE public.teams SET notes = 'a coach called' WHERE name = 'W Shell'$$, $$SELECT notes FROM public.teams WHERE name = 'W Shell'$$),
    'kept=divisions,teams witness=a coach called', 'teams (a shell), edited: kept with its division');
SELECT is(pg_temp.scenario($$UPDATE public.divisions SET practices_per_week = 2 WHERE name = 'W Div'$$, $$SELECT practices_per_week::text FROM public.divisions WHERE name = 'W Div'$$),
    'kept=divisions witness=2', 'divisions, its settings ticked since: kept');
SELECT is(pg_temp.scenario($$INSERT INTO public.teams (organization_id, division_id, name) SELECT organization_id, id, 'W Later' FROM public.divisions WHERE name = 'W Div'$$,
                           $$SELECT count(*)::text FROM public.teams WHERE name = 'W Later'$$),
    'kept=divisions witness=1', 'divisions, holding a team made since: kept, and that team survives');
SET LOCAL ROLE authenticated;
INSERT INTO t_res VALUES ('wrb', public.rollback_practice_import_job((SELECT id FROM t_job WHERE k = 'J5')));
RESET ROLE;
SELECT is(pg_temp.n(r, 'deleted') || ' ' || pg_temp.n(r, 'team_runs_deleted'),
    '{"teams": 1, "fields": 1, "divisions": 1, "locations": 1, "field_subunits": 2, "practice_slots": 3} 1', 'the W rollback deletes everything it created, and its team run') FROM t_res WHERE k = 'wrb';
SELECT is(pg_temp.before_rows(), :'before_rows', 'and every row that existed before is byte-equal');

-- The catalogue census of what the rollback deletes from: every foreign key onto those tables is either read by
-- practice_import_referenced (all of them, by construction) or on its two-entry list with a reason; a new table joins
-- without an edit. PLANT: a table made here with a key onto fields makes a W field "referenced".
SELECT is(pg_temp.val($$SELECT (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f'
                         AND c.confrelid IN ('public.practice_slots'::regclass, 'public.field_subunits'::regclass, 'public.fields'::regclass,
                                             'public.locations'::regclass, 'public.teams'::regclass, 'public.divisions'::regclass)) >= 25$$), 'true',
    'the census finds the keys onto the six tables (a census over nothing would pass)');
CREATE TABLE public.zz_planted_ref (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), field_id uuid REFERENCES public.fields(id) ON DELETE CASCADE);
INSERT INTO public.zz_planted_ref (field_id) VALUES (pg_temp.u(911));
SELECT is(public.practice_import_referenced('public.fields'::regclass, pg_temp.u(911)), true, 'PLANT: a new table with a cascading key onto fields is read as a reference');
DROP TABLE public.zz_planted_ref;
SELECT is(public.practice_import_referenced('public.teams'::regclass, 'aaaaaaaa-0000-0000-0000-000000000002'), false,
    'control: a team nothing names (its calendar token aside) is not referenced');

-- ── 8. Everything this migration grants to a signed-in user, used AS one ───
SELECT is(pg_temp.val($$SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p
                         WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                           AND COALESCE(obj_description(p.oid), '') LIKE '%20261123010000%'$$),
    'apply_practice_import_job,create_import_job,map_practice_import_job,rollback_practice_import_job',
    'what this migration grants to authenticated, from the catalogue (the deferred pair has no comment and is used in section 2)');
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT ok(pg_temp.job('as-role.csv') IS NOT NULL, 'create_import_job: an admin makes a practice job as the role');
SELECT is(pg_temp.err($$SELECT public.cancel_ready_import_job((SELECT id FROM t_job WHERE k = 'J1'), 'practice_schedule')$$), '22023:import_not_ready_to_apply',
    'cancel_ready_import_job answers by its own rule for a practice job (an applied job is not cancelled)');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.val($$SELECT count(*) FROM public.staging_import_rows WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$)
          || ' ' || pg_temp.val($$SELECT count(*) FROM public.import_application_records WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$)
          || ' ' || pg_temp.val($$SELECT count(*) FROM public.import_jobs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$),
    '0 0 0', 'a member of another organization sees none of Org A''s staged rows, application records or jobs');
SELECT is(pg_temp.err($$SELECT public.apply_practice_import_job((SELECT id FROM t_job WHERE k = 'J5'), true)$$), '42501:', 'and is refused Org A''s apply as the role');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
