-- pgTAP: a session's TimeZone no longer shifts stored timestamps (migration
-- 20261021040000; plan docs/changes/2026-10-20-utc-now-idiom.md).
--
-- `timezone('utc', now())` is the UTC wall clock with no zone; written into a
-- timestamptz it was read in the SESSION's zone. Under a session at UTC+14 or
-- UTC-12 every value below was off by that many hours before this migration,
-- and each writer here is checked against now(), an instant: within a minute.
-- The catalogue checks fail if a function using the idiom as a timestamp is
-- not pinned, or a column or argument default still uses it.
--
-- now() is the transaction's start in every statement here, so "within a
-- minute" is exact up to the statements' own run time.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(12);

INSERT INTO public.locations (id, organization_id, name)
VALUES ('e7000000-0000-4000-8000-00000000f001', 'a1111111-1111-1111-1111-111111111111', 'UTC Complex');
INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES ('e7000000-0000-4000-8000-00000000fa01', 'a1111111-1111-1111-1111-111111111111',
        'e7000000-0000-4000-8000-00000000f001', 'UTC Field');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
VALUES ('e7000000-0000-4000-8000-00000000aa01', 'a1111111-1111-1111-1111-111111111111',
        'e7000000-0000-4000-8000-00000000fa01', 'mon', '17:00', '18:00', '2026-03-01', '2026-06-01');
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES ('e7000000-0000-4000-8000-0000000000b1', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd', 'UTC Team');
INSERT INTO public.coaches (id, organization_id, full_name, email, status) VALUES
    ('e7000000-0000-4000-8000-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'UTC One', 'utc-one@test.local', 'active'),
    ('e7000000-0000-4000-8000-0000000000c2', 'a1111111-1111-1111-1111-111111111111', 'UTC Two', 'utc-two@test.local', 'active');
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, last_heartbeat_at) VALUES
    ('e7000000-0000-4000-8000-00000000ab01', 'a1111111-1111-1111-1111-111111111111', 'registration', 'utc/fresh.csv',
     'processing', '11111111-1111-1111-1111-111111111111', now() - interval '3 minutes'),
    ('e7000000-0000-4000-8000-00000000ab02', 'a1111111-1111-1111-1111-111111111111', 'registration', 'utc/stale.csv',
     'processing', '11111111-1111-1111-1111-111111111111', now() - interval '10 minutes');

CREATE FUNCTION pg_temp.close(t timestamptz) RETURNS boolean
LANGUAGE sql AS $$ SELECT abs(extract(epoch FROM t - now())) < 60 $$;

-- ---- writers under a session at UTC+14 -------------------------------------
SET LOCAL timezone = 'Pacific/Kiritimati';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

INSERT INTO public.organizations (id, name, slug)
VALUES ('e7000000-0000-4000-8000-0000000000aa', 'UTC Org', 'utc-org');
SELECT ok(pg_temp.close((SELECT created_at FROM public.organizations WHERE id = 'e7000000-0000-4000-8000-0000000000aa')),
          'a column default stores now(), not a shifted wall clock');

UPDATE public.organizations SET updated_at = '2000-01-01' WHERE id = 'e7000000-0000-4000-8000-0000000000aa';
UPDATE public.organizations SET name = 'UTC Org 2' WHERE id = 'e7000000-0000-4000-8000-0000000000aa';
SELECT ok(pg_temp.close((SELECT updated_at FROM public.organizations WHERE id = 'e7000000-0000-4000-8000-0000000000aa')),
          'trigger_set_timestamp stamps updated_at with the instant');

SELECT lives_ok($$SELECT public.set_team_coaches('e7000000-0000-4000-8000-0000000000b1',
                  'e7000000-0000-4000-8000-0000000000c1', ARRAY[]::uuid[],
                  (now() AT TIME ZONE 'UTC')::date - 10, 'pgtap')$$, 'set_team_coaches starts a coach');
SELECT lives_ok($$SELECT public.set_team_coaches('e7000000-0000-4000-8000-0000000000b1',
                  'e7000000-0000-4000-8000-0000000000c2', ARRAY[]::uuid[],
                  (now() AT TIME ZONE 'UTC')::date, 'pgtap')$$, 'set_team_coaches replaces them today (UTC)');
SELECT ok(pg_temp.close((SELECT ended_at FROM public.team_coach_assignments
                          WHERE team_id = 'e7000000-0000-4000-8000-0000000000b1'
                            AND coach_id = 'e7000000-0000-4000-8000-0000000000c1')),
          'set_team_coaches stamps ended_at with the instant');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok($$SELECT public.persist_practice_schedule(
        jsonb_build_object('id', 'e7000000-0000-4000-8000-00000000d001',
                           'organization_id', 'a1111111-1111-1111-1111-111111111111',
                           'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                           'run_type', 'practice', 'status', 'completed'),
        jsonb_build_array(jsonb_build_object(
            'team_id', 'e7000000-0000-4000-8000-0000000000b1',
            'practice_slot_id', 'e7000000-0000-4000-8000-00000000aa01',
            'effective_date_range', '[2026-03-01,2026-06-01)',
            'source', 'manual')))$$, 'a practice save at UTC+14');
RESET ROLE;
SELECT ok(pg_temp.close((SELECT started_at FROM public.scheduler_runs WHERE id = 'e7000000-0000-4000-8000-00000000d001')),
          'persist_practice_schedule stamps the run with the instant');

-- ---- the stale-job cutoff, default argument, at both extremes ---------------
-- The default is evaluated in this (the caller's) session, so pinning the
-- function alone would not fix it: at UTC-12 it failed the fresh job too, at
-- UTC+14 neither.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SET LOCAL timezone = 'Etc/GMT+12';
SELECT is((public.fail_stale_import_jobs('a1111111-1111-1111-1111-111111111111')->'job_ids'),
          '["e7000000-0000-4000-8000-00000000ab02"]'::jsonb,
          'at UTC-12 the default cutoff fails the 10-minute-old job and not the 3-minute-old one');
RESET ROLE;
UPDATE public.import_jobs SET status = 'processing', completed_at = NULL
 WHERE id = 'e7000000-0000-4000-8000-00000000ab02';
SET LOCAL role = 'authenticated';
SET LOCAL timezone = 'Pacific/Kiritimati';
SELECT is((public.fail_stale_import_jobs('a1111111-1111-1111-1111-111111111111')->'job_ids'),
          '["e7000000-0000-4000-8000-00000000ab02"]'::jsonb,
          'at UTC+14 the same: the cutoff is five minutes before now');
RESET ROLE;
RESET timezone;

-- ---- the catalogue: nothing uses the idiom unpinned ------------------------
SELECT is((SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.prosrc ~* '(timezone\s*\(\s*''(etc/)?utc''(\s*::\s*text)?\s*,\s*(now\s*\(\s*\)|clock_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\)|current_timestamp)\s*\)|(now\s*\(\s*\)|clock_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\)|current_timestamp)\s+at\s+time\s+zone\s+''(etc/)?utc'')(?!\)?\s*::\s*date)'
              AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c
                               WHERE lower(c) = 'timezone=utc')),
          NULL, 'every public function using the idiom as a timestamp is pinned to UTC');
SELECT is((SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname)
             FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
             JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            WHERE c.relnamespace = 'public'::regnamespace
              AND pg_get_expr(d.adbin, d.adrelid) ~* 'timezone\(''(etc/)?utc''|at time zone ''(etc/)?utc'''),
          NULL, 'no column default uses the idiom');
SELECT is((SELECT array_agg(p.oid::regprocedure::text) FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND pg_get_function_arguments(p.oid) ~* 'timezone\(''(etc/)?utc''|at time zone ''(etc/)?utc'''),
          NULL, 'no argument default uses the idiom');

SELECT * FROM finish();
ROLLBACK;
