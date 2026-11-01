-- pgTAP: the evaluations import (migration 20261113010000; plan
-- docs/changes/2026-10-27-season-enrollment.md, C2, PR E3c): years played, a skill tier and a 1-5
-- rating, by registration id, onto the players of one season.
--
--   * it only UPDATES: a registration id that names no player of the season is counted and listed
--     and creates nothing; a blank cell leaves the stored value alone, a zero is a value; a value
--     already stored is not written again (a re-import changes nothing and moves no updated_at);
--   * identifiers are text: `007` is not `7`; another season's player, and another organization's,
--     with the same id are never read or written; a job for a draft season updates the draft's
--     players and nobody else's;
--   * a row is judged whole: a bad years, tier or rating, or no registration id, makes it invalid
--     (listed with its field, quoting no value, none of its cells applied); a repeated id uses the
--     first row by row number and lists the rest; a key the finalizer does not read changes nothing;
--   * the dry run answers with the counts and lists the apply then produces and writes nothing;
--   * a season completed since the job was made is refused 22023 `season_completed`, apply and dry
--     run alike, before anything is read or written; so is a stranger, another organization's
--     admin, a job of another type and a cancelled job; a finished job answers with its stored
--     result; an organization with no season is `season_missing`;
--   * audited as `import.completed` with the counts and no registration ids;
--   * the new type is accepted by the job lifecycle (create, ready to apply, cancel), its job type
--     is its own, and its allowlist, grants and retention job exist.
-- Org A's fixture season is active; a draft and (later) a completed season are added. Every id is
-- generated; there is no PII.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(88);

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- SQLSTATE and DETAIL of the error a statement raises, 'no error' for none.
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
-- A staged evaluations row for a job of Org A.
CREATE FUNCTION pg_temp.stage(p_job uuid, p_row integer, p_payload jsonb) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload)
    VALUES ('a1111111-1111-1111-1111-111111111111', p_job, 'evaluations', p_row, '{}'::jsonb, p_payload);
$f$;
-- A season-A player as "years/tier/rating", NULL as '-'.
CREATE FUNCTION pg_temp.vals(p_reg text, p_season uuid DEFAULT 'a1111111-1111-1111-1111-111111111aaa') RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(years_played::text, '-') || '/' || COALESCE(skill_tier, '-') || '/' || COALESCE(rating::text, '-')
      FROM public.players WHERE external_registration_id = p_reg AND season_settings_id = p_season
$f$;

-- ── Seeds (as the test's own role) ──────────────────────────────────────────
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('e3c00000-0000-4000-8000-0000000000d1', 'a1111111-1111-1111-1111-111111111111', 'E3C Draft 2027', 'draft', 2027),
    ('e3c00000-0000-4000-8000-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'E3C Past 2025', 'draft', 2025);

-- Season A (active): the players the file names. updated_at is old, so a write shows.
INSERT INTO public.players (id, organization_id, season_settings_id, first_name, last_name, external_registration_id, years_played, skill_tier, rating, updated_at) VALUES
    ('e3c00000-0000-4000-8000-000000000a01', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Zero', '007', NULL, NULL, NULL, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a02', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Seven', '7', NULL, NULL, NULL, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a03', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Replace', 'EV-2', 4, 'advanced', 5, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a04', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Same', 'EV-3', 2, 'novice', 1, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a05', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Blank', 'EV-4', 6, 'developing', 3, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a06', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Bad', 'EV-5', 8, 'novice', 2, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a07', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Twice', 'EV-6', NULL, NULL, NULL, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000a08', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Ev', 'Zeroyears', 'EV-7', 5, NULL, NULL, '2020-01-01');
-- The same registration ids in a draft season, a past one and another organization's season.
INSERT INTO public.players (id, organization_id, season_settings_id, first_name, last_name, external_registration_id, years_played, skill_tier, rating, updated_at) VALUES
    ('e3c00000-0000-4000-8000-000000000d01', 'a1111111-1111-1111-1111-111111111111', 'e3c00000-0000-4000-8000-0000000000d1', 'Draft', 'Zero', '007', 9, 'advanced', 4, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000d02', 'a1111111-1111-1111-1111-111111111111', 'e3c00000-0000-4000-8000-0000000000d1', 'Draft', 'Other', 'EV-2', NULL, NULL, NULL, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000b01', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222bbb', 'Org', 'Bee', '007', 3, 'novice', 2, '2020-01-01'),
    ('e3c00000-0000-4000-8000-000000000c01', 'a1111111-1111-1111-1111-111111111111', 'e3c00000-0000-4000-8000-0000000000c1', 'Past', 'One', 'EV-2', 7, 'developing', 3, '2020-01-01');

CREATE TEMP TABLE jobs (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT ALL ON jobs TO PUBLIC;

-- ── The job lifecycle accepts the type ──────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'main', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-main.csv')).id;
INSERT INTO jobs SELECT 'again', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-again.csv')).id;
INSERT INTO jobs SELECT 'dup', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-dup.csv')).id;
INSERT INTO jobs SELECT 'draft', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-draft.csv', 'e3c00000-0000-4000-8000-0000000000d1')).id;
INSERT INTO jobs SELECT 'past', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-past.csv', 'e3c00000-0000-4000-8000-0000000000c1')).id;
INSERT INTO jobs SELECT 'cancel', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-cancel.csv')).id;
INSERT INTO jobs SELECT 'denied', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'ev-denied.csv')).id;
INSERT INTO jobs SELECT 'reg', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'reg.csv')).id;
RESET role;

SELECT is((SELECT job_type FROM public.import_jobs WHERE id = (SELECT id FROM jobs WHERE name = 'main')), 'evaluations',
    'an evaluations import has its own job type');
SELECT is((SELECT season_settings_id FROM public.import_jobs WHERE id = (SELECT id FROM jobs WHERE name = 'main')),
    'a1111111-1111-1111-1111-111111111aaa'::uuid, 'in the active season when none is named');
SELECT is((SELECT season_settings_id FROM public.import_jobs WHERE id = (SELECT id FROM jobs WHERE name = 'draft')),
    'e3c00000-0000-4000-8000-0000000000d1'::uuid, 'or in the draft season that is named');
SELECT is((SELECT job_type FROM public.import_jobs WHERE id = (SELECT id FROM jobs WHERE name = 'reg')), 'registration',
    'a players import is still a registration job');
SELECT is((SELECT count(*)::int FROM public.audit_log
            WHERE action = 'import.started' AND resource_id IN (SELECT id FROM jobs WHERE name IN ('main', 'draft'))
              AND metadata ->> 'import_type' = 'evaluations' AND metadata ->> 'job_type' = 'evaluations'),
    2, 'creating one is audited as import.started');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'x.csv', 'b2222222-2222-2222-2222-222222222bbb')$$),
    '42501:', 'another organization''s season cannot be named');
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluation', 'x.csv')$$),
    '22023:', 'a misspelled type is refused');
RESET role;

-- ── The main file ───────────────────────────────────────────────────────────
-- 1 sets all three on '007'; 2 sets years only on EV-2 (tier and rating blank: kept); 3 repeats
-- EV-3's stored values (the tier in capitals); 4 is all blank for EV-4; 5 and 11 name nobody;
-- 6 has years 31, 7 tier 'gold' and rating 6, 8 no id; 9 reaches EV-6 by gotsport_id; 10 sets
-- years 0 on EV-7 (a zero is a value); 12 is '7' (not '007') with a key the finalizer does not read.
SELECT pg_temp.stage((SELECT id FROM jobs WHERE name = 'main'), v.n, v.payload) FROM (VALUES
    (1, '{"external_registration_id":"007","years_played":"3","skill_tier":"developing","rating":"4"}'::jsonb),
    (2, '{"external_registration_id":"EV-2","years_played":"6","skill_tier":"","rating":""}'::jsonb),
    (3, '{"external_registration_id":"EV-3","years_played":"2","skill_tier":"NOVICE","rating":"1"}'::jsonb),
    (4, '{"external_registration_id":"EV-4","years_played":"","skill_tier":"","rating":""}'::jsonb),
    (5, '{"external_registration_id":"NOBODY-1","years_played":"2","skill_tier":"","rating":""}'::jsonb),
    (6, '{"external_registration_id":"EV-5","years_played":"31","skill_tier":"advanced","rating":"4"}'::jsonb),
    (7, '{"external_registration_id":"EV-6","years_played":"","skill_tier":"gold","rating":"6"}'::jsonb),
    (8, '{"years_played":"2","skill_tier":"","rating":""}'::jsonb),
    (9, '{"gotsport_id":"EV-6","years_played":"1","skill_tier":"","rating":""}'::jsonb),
    (10, '{"external_registration_id":"EV-7","years_played":"0","skill_tier":"","rating":""}'::jsonb),
    (11, '{"external_registration_id":"0001","years_played":"1","skill_tier":"","rating":""}'::jsonb),
    (12, '{"external_registration_id":"7","first_name":"Hacked","years_played":"","skill_tier":"","rating":""}'::jsonb)
) AS v(n, payload);

CREATE TEMP TABLE before_dry ON COMMIT DROP AS SELECT to_jsonb(p) AS row FROM public.players p;
GRANT SELECT ON before_dry TO PUBLIC;
CREATE TEMP TABLE players_total ON COMMIT DROP AS SELECT count(*) AS n FROM public.players;

-- ── The dry run: the counts, and nothing written ────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE dry ON COMMIT DROP AS
    SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'main'),
        '[{"row":13,"field":"rating","message":"Rating must be a whole number from 1 to 5"}]'::jsonb, true) AS r;
GRANT SELECT ON dry TO PUBLIC;
RESET role;

SELECT is((SELECT r ->> 'status' FROM dry), 'preview', 'the dry run says it is a preview');
SELECT is((SELECT (r ->> 'dry_run')::boolean FROM dry), true, 'and that it is a dry run');
SELECT is((SELECT ARRAY[(r ->> 'staged_rows')::int, (r ->> 'matched_rows')::int, (r ->> 'updated_players')::int,
                        (r ->> 'unchanged_players')::int, (r ->> 'unmatched_rows')::int, (r ->> 'invalid_rows')::int,
                        (r ->> 'duplicate_rows')::int, (r ->> 'validation_error_rows')::int] FROM dry),
    ARRAY[12, 7, 4, 3, 2, 3, 0, 1],
    'it counts 12 rows: 7 name a player (4 to update, 3 already right), 2 name nobody, 3 are invalid, 1 refused upstream');
SELECT is((SELECT ARRAY[(r ->> 'years_updated')::int, (r ->> 'tier_updated')::int, (r ->> 'rating_updated')::int] FROM dry),
    ARRAY[4, 1, 1], 'and which values: 4 years, 1 tier, 1 rating');
SELECT is((SELECT count(*)::int FROM public.players p JOIN before_dry b ON b.row ->> 'id' = p.id::text
            WHERE to_jsonb(p) IS DISTINCT FROM b.row),
    0, 'the dry run changed no player, to the last column');
SELECT is((SELECT n FROM players_total), (SELECT count(*) FROM public.players), 'and created none');
SELECT is((SELECT count(*)::int FROM public.staging_import_rows
            WHERE import_job_id = (SELECT id FROM jobs WHERE name = 'main') AND (applied_at IS NOT NULL OR validation_errors <> '[]'::jsonb)),
    0, 'marked no staged row');
SELECT is((SELECT status FROM public.import_jobs WHERE id = (SELECT id FROM jobs WHERE name = 'main')), 'importing',
    'did not finish the job');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE resource_id = (SELECT id FROM jobs WHERE name = 'main') AND action = 'import.completed'),
    0, 'and wrote no audit row');

-- ── The apply ───────────────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE applied ON COMMIT DROP AS
    SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'main'),
        '[{"row":13,"field":"rating","message":"Rating must be a whole number from 1 to 5"}]'::jsonb) AS r;
GRANT SELECT ON applied TO PUBLIC;
RESET role;

SELECT is((SELECT r - 'status' - 'dry_run' FROM applied), (SELECT r - 'status' - 'dry_run' FROM dry),
    'the apply''s counts and lists are the dry run''s, to the last key');
SELECT is((SELECT r ->> 'status' FROM applied), 'completed_with_warnings', 'it finishes with warnings');
SELECT is((SELECT (r ->> 'dry_run')::boolean FROM applied), false, 'and is not a dry run');
SELECT is(pg_temp.vals('007'), '3/developing/4', 'a player named by registration id takes all three values');
SELECT is(pg_temp.vals('EV-2'), '6/advanced/5', 'a blank tier and rating leave the stored ones alone; the years change');
SELECT is(pg_temp.vals('EV-3'), '2/novice/1', 'values already stored stay (a tier in capitals reads as lower case)');
SELECT is(pg_temp.vals('EV-4'), '6/developing/3', 'a row of blank cells changes nothing');
SELECT is(pg_temp.vals('EV-5'), '8/novice/2', 'an invalid row applies none of its cells, the good ones included');
SELECT is(pg_temp.vals('EV-6'), '1/-/-', 'a registration id reached by gotsport_id; the invalid row for it applied nothing');
SELECT is(pg_temp.vals('EV-7'), '0/-/-', 'a zero is a value, not a blank');
SELECT is(pg_temp.vals('7'), '-/-/-', '7 is not 007: the other text id is untouched');
SELECT is((SELECT first_name FROM public.players WHERE id = 'e3c00000-0000-4000-8000-000000000a02'), 'Ev',
    'a key the finalizer does not read changes nothing (first_name)');
SELECT is((SELECT n FROM players_total), (SELECT count(*) FROM public.players), 'no player was created from the unmatched rows');
SELECT is((SELECT array_agg(p.external_registration_id ORDER BY p.external_registration_id) FROM public.players p
            WHERE p.updated_at > '2021-01-01' AND p.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
    ARRAY['007', 'EV-2', 'EV-6', 'EV-7'], 'only the four players whose values changed were written (updated_at)');
SELECT is(pg_temp.vals('007', 'e3c00000-0000-4000-8000-0000000000d1'), '9/advanced/4', 'the draft season''s 007 is untouched');
SELECT is(pg_temp.vals('EV-2', 'e3c00000-0000-4000-8000-0000000000c1'), '7/developing/3', 'so is the past season''s EV-2');
SELECT is(pg_temp.vals('007', 'b2222222-2222-2222-2222-222222222bbb'), '3/novice/2', 'and another organization''s 007');
SELECT is((SELECT r -> 'unmatched' FROM applied),
    '[{"source_row_number":5,"registration_id":"NOBODY-1"},{"source_row_number":11,"registration_id":"0001"}]'::jsonb,
    'the unmatched rows are listed with their row numbers and ids (leading zeros kept)');
SELECT is((SELECT r -> 'invalid' ->> 3 FROM applied)::jsonb,
    '{"source_row_number":8,"field":"external_registration_id","message":"Missing required field: external_registration_id"}'::jsonb,
    'an invalid row is listed with its field and a message');
SELECT is((SELECT array_agg((e ->> 'source_row_number') || ':' || (e ->> 'field') ORDER BY ord)
             FROM applied, jsonb_array_elements(r -> 'invalid') WITH ORDINALITY AS t(e, ord)),
    ARRAY['6:years_played', '7:rating', '7:skill_tier', '8:external_registration_id'],
    'one entry per bad cell, in row order');
SELECT is((SELECT count(*)::int FROM applied, jsonb_array_elements(r -> 'invalid') e
            WHERE e ->> 'message' ~ '(31|gold|[^0-9]6[^0-9])'), 0, 'no message quotes a value from the file');
SELECT is((SELECT count(*)::int FROM public.staging_import_rows
            WHERE import_job_id = (SELECT id FROM jobs WHERE name = 'main') AND applied_at IS NOT NULL),
    9, 'the nine valid rows are marked processed (matched or not)');
SELECT is((SELECT array_agg(source_row_number ORDER BY source_row_number) FROM public.staging_import_rows
            WHERE import_job_id = (SELECT id FROM jobs WHERE name = 'main') AND validation_errors <> '[]'::jsonb),
    ARRAY[6, 7, 8], 'the invalid rows keep their errors and are not marked processed');
SELECT is((SELECT status || '/' || processed_rows || '/' || (warning_summary -> 'evaluation_finalize' ->> 'updated_players')
             || '/' || jsonb_array_length(error_summary -> 'rowErrors')
             FROM public.import_jobs WHERE id = (SELECT id FROM jobs WHERE name = 'main')),
    'completed_with_warnings/9/4/1', 'the job is finished with its result and the upstream errors kept');

-- Audited: the counts, no registration ids.
SELECT is((SELECT count(*)::int FROM public.audit_log
            WHERE resource_id = (SELECT id FROM jobs WHERE name = 'main') AND action = 'import.completed'
              AND organization_id = 'a1111111-1111-1111-1111-111111111111'),
    1, 'the apply is audited once as import.completed');
SELECT is((SELECT metadata ->> 'import_type' || '/' || (metadata ->> 'updated_players') || '/' || (metadata ->> 'unmatched_rows')
             || '/' || (metadata ->> 'season_settings_id')
             FROM public.audit_log WHERE resource_id = (SELECT id FROM jobs WHERE name = 'main') AND action = 'import.completed'),
    'evaluations/4/2/a1111111-1111-1111-1111-111111111aaa', 'with the type, the counts and the season');
SELECT is((SELECT count(*)::int FROM public.audit_log
            WHERE resource_id = (SELECT id FROM jobs WHERE name = 'main') AND action = 'import.completed'
              AND (metadata ?| ARRAY['unmatched', 'invalid', 'duplicates'] OR metadata::text LIKE '%NOBODY%')),
    0, 'and no registration id');

-- A finished job answers a second call with the result it stored.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE replayed ON COMMIT DROP AS
    SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'main')) AS r;
GRANT SELECT ON replayed TO PUBLIC;
RESET role;
SELECT is((SELECT r -> 'updated_players' FROM replayed), '4'::jsonb, 'a second finalize of the job returns the stored result');
SELECT is((SELECT (r ->> 'replayed')::boolean FROM replayed), true, 'marked as replayed');
SELECT is((SELECT count(*)::int FROM public.audit_log
            WHERE resource_id = (SELECT id FROM jobs WHERE name = 'main') AND action = 'import.completed'),
    1, 'and writes no second audit row');

-- ── A re-import of the same file changes nothing ────────────────────────────
CREATE TEMP TABLE after_main ON COMMIT DROP AS SELECT to_jsonb(p) AS row FROM public.players p;
GRANT SELECT ON after_main TO PUBLIC;
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload)
    SELECT organization_id, (SELECT id FROM jobs WHERE name = 'again'), import_type, source_row_number, raw_payload, normalized_payload
      FROM public.staging_import_rows WHERE import_job_id = (SELECT id FROM jobs WHERE name = 'main');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE again ON COMMIT DROP AS
    SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'again')) AS r;
GRANT SELECT ON again TO PUBLIC;
RESET role;
SELECT is((SELECT ARRAY[(r ->> 'updated_players')::int, (r ->> 'unchanged_players')::int, (r ->> 'unmatched_rows')::int, (r ->> 'invalid_rows')::int] FROM again),
    ARRAY[0, 7, 2, 3], 'the same rows again: no player to update, 7 already right, 2 unmatched, the same 3 invalid');
SELECT is((SELECT count(*)::int FROM public.players p JOIN after_main b ON b.row ->> 'id' = p.id::text
            WHERE to_jsonb(p) IS DISTINCT FROM b.row),
    0, 'and every player is as it was, updated_at included');

-- ── A repeated registration id uses its first row ───────────────────────────
-- Inserted out of order: the first is the lowest row number, not the first inserted.
SELECT pg_temp.stage((SELECT id FROM jobs WHERE name = 'dup'), v.n, v.payload) FROM (VALUES
    (3, '{"external_registration_id":"EV-6","years_played":"3"}'::jsonb),
    (2, '{"external_registration_id":"EV-6","years_played":"2"}'::jsonb),
    (1, '{"external_registration_id":"EV-6","years_played":"9"}'::jsonb)
) AS v(n, payload);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE dup ON COMMIT DROP AS
    SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'dup')) AS r;
GRANT SELECT ON dup TO PUBLIC;
RESET role;
SELECT is(pg_temp.vals('EV-6'), '9/-/-', 'the first row by row number is used');
SELECT is((SELECT (r ->> 'duplicate_rows') || '/' || (r ->> 'updated_players') || '/' || (r ->> 'status') FROM dup),
    '2/1/completed_with_warnings', 'the other two are counted as duplicates');
SELECT is((SELECT r -> 'duplicates' FROM dup),
    '[{"source_row_number":2,"registration_id":"EV-6"},{"source_row_number":3,"registration_id":"EV-6"}]'::jsonb,
    'and listed');

-- ── A draft season's job updates the draft's players only ───────────────────
SELECT pg_temp.stage((SELECT id FROM jobs WHERE name = 'draft'), v.n, v.payload) FROM (VALUES
    (1, '{"external_registration_id":"007","years_played":"11","skill_tier":"novice","rating":"2"}'::jsonb),
    (2, '{"external_registration_id":"EV-2","years_played":"1","skill_tier":"","rating":""}'::jsonb)
) AS v(n, payload);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE draftrun ON COMMIT DROP AS
    SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'draft')) AS r;
GRANT SELECT ON draftrun TO PUBLIC;
RESET role;
SELECT is((SELECT (r ->> 'updated_players') || '/' || (r ->> 'status') || '/' || (r ->> 'season_settings_id') FROM draftrun),
    '2/completed/e3c00000-0000-4000-8000-0000000000d1', 'the draft takes the import: two players, no warnings');
SELECT is(pg_temp.vals('007', 'e3c00000-0000-4000-8000-0000000000d1') || ' ' || pg_temp.vals('EV-2', 'e3c00000-0000-4000-8000-0000000000d1'),
    '11/novice/2 1/-/-', 'the draft''s players have the values');
SELECT is(pg_temp.vals('007') || ' ' || pg_temp.vals('EV-2'), '3/developing/4 6/advanced/5',
    'and the active season''s are as the main file left them');
SELECT is(pg_temp.vals('007', 'b2222222-2222-2222-2222-222222222bbb') || ' ' || pg_temp.vals('EV-2', 'e3c00000-0000-4000-8000-0000000000c1'),
    '3/novice/2 7/developing/3', 'as are another organization''s and a past season''s');

-- ── A season completed after the job was made is refused ────────────────────
SELECT pg_temp.stage((SELECT id FROM jobs WHERE name = 'past'), 1, '{"external_registration_id":"EV-2","years_played":"20"}'::jsonb);
UPDATE public.season_settings SET status = 'completed' WHERE id = 'e3c00000-0000-4000-8000-0000000000c1';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'past'))$$),
    '22023:season_completed', 'the apply is refused cleanly: 22023, season_completed');
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'past'), '[]', true)$$),
    '22023:season_completed', 'so is the dry run');
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'evaluations', 'x.csv', 'e3c00000-0000-4000-8000-0000000000c1')$$),
    '22023:season_completed', 'and a new job for the completed season');
RESET role;
SELECT is(pg_temp.vals('EV-2', 'e3c00000-0000-4000-8000-0000000000c1'), '7/developing/3', 'the completed season''s player is unchanged');
SELECT is((SELECT status || '/' || (SELECT count(*) FROM public.staging_import_rows s WHERE s.import_job_id = j.id AND s.applied_at IS NOT NULL)
             FROM public.import_jobs j WHERE j.id = (SELECT id FROM jobs WHERE name = 'past')),
    'importing/0', 'and the job and its staged row are as they were');

-- ── Who may, and for which job ──────────────────────────────────────────────
SELECT pg_temp.stage((SELECT id FROM jobs WHERE name = 'denied'), 1, '{"external_registration_id":"EV-3","years_played":"15"}'::jsonb);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'denied'))$$),
    '42501:', 'a signed-in stranger is refused');
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'denied'), '[]', true)$$),
    '42501:', 'even for a dry run');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'denied'))$$),
    '42501:', 'another organization''s admin is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job('e3c00000-0000-4000-8000-00000000ffff')$$),
    'P0002:', 'a job that does not exist is not found');
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'reg'))$$),
    '22023:', 'a registration job is not an evaluations job');
SELECT is(pg_temp.err($$SELECT public.finalize_import_job((SELECT id FROM jobs WHERE name = 'denied'))$$),
    '22023:', 'and the player finalizer refuses an evaluations job');
SELECT is(pg_temp.err($$SELECT public.finalize_coach_import_job((SELECT id FROM jobs WHERE name = 'denied'))$$),
    '22023:', 'as does the coach finalizer');
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'denied'), '{}')$$),
    '22023:', 'validation errors must be an array');
RESET role;
SELECT is(pg_temp.vals('EV-3'), '2/novice/1', 'the refused calls changed nothing');
SELECT ok(NOT has_function_privilege('anon', 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)', 'EXECUTE'),
    'the finalizer is for signed-in callers only');

-- ── Ready to apply and cancel ───────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((public.mark_import_job_ready_to_apply((SELECT id FROM jobs WHERE name = 'cancel'), 'evaluations', '[]'::jsonb)) ->> 'status',
    'ready_to_apply', 'an evaluations job can be marked ready to apply');
SELECT is(pg_temp.err($$SELECT public.mark_import_job_ready_to_apply((SELECT id FROM jobs WHERE name = 'reg'), 'evaluations')$$),
    '22023:', 'a registration job cannot be marked as evaluations');
SELECT is(pg_temp.err($$SELECT public.mark_import_job_ready_to_apply((SELECT id FROM jobs WHERE name = 'denied'), 'coaches')$$),
    '22023:', 'nor an evaluations job as coaches');
SELECT is(pg_temp.err($$SELECT public.cancel_ready_import_job((SELECT id FROM jobs WHERE name = 'reg'), 'evaluations')$$),
    '22023:', 'nor cancelled as evaluations');
SELECT is((public.cancel_ready_import_job((SELECT id FROM jobs WHERE name = 'cancel'), 'evaluations')) ->> 'status',
    'canceled', 'a ready evaluations job can be cancelled');
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM jobs WHERE name = 'cancel'))$$),
    '22023:', 'and a cancelled job cannot be finalized');
SELECT is(pg_temp.err($$SELECT public.mark_import_job_ready_to_apply((SELECT id FROM jobs WHERE name = 'denied'), 'players')$$),
    '22023:', 'the other types'' lists are unchanged: players still cannot be deferred');
RESET role;

-- ── An organization with no active season ───────────────────────────────────
UPDATE public.season_settings SET status = 'draft' WHERE id = 'b2222222-2222-2222-2222-222222222bbb';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
CREATE TEMP TABLE bjob ON COMMIT DROP AS
    SELECT (public.create_import_job('b2222222-2222-2222-2222-222222222222', 'evaluations', 'ev-b.csv')).id AS id;
GRANT SELECT ON bjob TO PUBLIC;
SELECT is(pg_temp.err($$SELECT public.finalize_evaluation_import_job((SELECT id FROM bjob))$$),
    '22023:season_missing', 'an organization with no season to import into is season_missing');
RESET role;

-- ── The type''s allowlist, and its retention ────────────────────────────────
SELECT is(public.import_allowed_keys('evaluations'),
    ARRAY['external_registration_id', 'gotsport_id', 'registration_id', 'player_id', 'years_played', 'skill_tier', 'skill_level', 'rating'],
    'the SQL allowlist holds the registration id keys and the three values');
SELECT is(cardinality(public.import_allowed_keys('players')) || '/' || cardinality(public.import_allowed_keys('coaches')) || '/'
          || cardinality(public.import_allowed_keys('fields')) || '/' || cardinality(public.import_allowed_keys('practice_preferences')),
    '43/12/0/18', 'and the other lists, the preference import''s included, are as they were');
SELECT is((SELECT count(*)::int FROM cron.job
            WHERE jobname = 'cleanup-staging-evaluation-rows' AND command LIKE '%import_type = ''evaluations''%'
              AND command LIKE '%j.status IN (''completed'', ''completed_with_warnings'', ''failed'')%' AND command LIKE '%30 days%'),
    1, 'a finished evaluations job''s staged rows are deleted after 30 days');
SELECT is((SELECT command LIKE '%import_type = ''coaches''%' AND command LIKE '%import_type = ''practice_preferences''%'
                  AND command NOT LIKE '%evaluations%' FROM cron.job WHERE jobname = 'cleanup-staging-import-rows'), true,
    'and the coach and preference retention job is the one 20261112010000 left');
SELECT is((SELECT array_agg(conname::text ORDER BY conname::text) FROM pg_constraint
            WHERE conname IN ('import_jobs_job_type_check', 'staging_import_rows_import_type_check') AND pg_get_constraintdef(oid) LIKE '%evaluations%'),
    ARRAY['import_jobs_job_type_check', 'staging_import_rows_import_type_check'], 'the job type and staged-row type checks admit it');
SELECT is((SELECT proconfig @> ARRAY['search_path=public', 'TimeZone=UTC'] AND prosecdef FROM pg_proc
            WHERE oid = 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)'::regprocedure),
    true, 'the finalizer is a definer with search_path and UTC pinned');

-- ── What 20261112010000 gave the same functions is still there ──────────────
SELECT is((SELECT pg_get_constraintdef(oid) LIKE '%practice_preferences%' AND pg_get_constraintdef(oid) LIKE '%coaches%'
                  AND pg_get_constraintdef(oid) LIKE '%field_availability%' AND pg_get_constraintdef(oid) LIKE '%evaluations%'
             FROM pg_constraint WHERE conname = 'staging_import_rows_import_type_check'), true,
    'the staged-row type check holds the preference type and the older ones beside evaluations');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE ppjob ON COMMIT DROP AS
    SELECT (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'practice_preferences', 'pp.csv', 'e3c00000-0000-4000-8000-0000000000d1')).id AS id;
GRANT SELECT ON ppjob TO PUBLIC;
SELECT is((SELECT job_type FROM public.import_jobs WHERE id = (SELECT id FROM ppjob)), 'registration',
    'a preference job is a registration job, and a draft season takes it');
SELECT is((public.mark_import_job_ready_to_apply((SELECT id FROM ppjob), 'practice_preferences') ->> 'status') || '/'
          || (public.cancel_ready_import_job((SELECT id FROM ppjob), 'practice_preferences') ->> 'status'),
    'ready_to_apply/canceled', 'and it can be marked ready to apply and cancelled');
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'fields', 'f.csv', 'e3c00000-0000-4000-8000-0000000000d1')$$),
    '22023:season_not_active', 'a field import still takes only the active season');
RESET role;

SELECT * FROM finish();
ROLLBACK;
