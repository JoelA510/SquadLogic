-- pgTAP: one active season per organization, no direct writes to seasons, and imports that
-- carry their season (migration 20261101010000; plan
-- docs/changes/2026-10-22-phase-e-seasons.md, E1, points 3, 4, 5 and 7).
--
--   * a second `active` season for one organization is refused (23505); two organizations
--     each hold one; a new season is a draft; a NULL status is refused;
--   * season names are unique per organization ignoring case and padding (23505), and the same
--     name in another organization is fine;
--   * no client writes `season_settings` directly (an admin's insert is refused, update and
--     delete reach no row) and members still read it;
--   * `create_import_job` fixes the job's season: none named is the active season, a named draft is
--     that draft, another organization's season is refused (42501) and a completed one (22023),
--     each refusal creating no job;
--   * `finalize_import_job` reads the job's season: a job for a draft finalizes its divisions and
--     players into the draft and not the active season (this fails on the old active-then-newest
--     rule), a legacy job with no season lands in the active season, a completed season is refused;
--   * `finalize_field_import_job` resolves a practice row's Division in the job's season;
--   * `upsert_division_for_import` and `admin_upsert_division_settings` refuse a completed season.
-- Run as `authenticated` with a JWT sub where a caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(30);

-- Org A has its active season (fixtures); a draft for next year and a completed one for last year.
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111111d1', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2027', 'draft', 2027),
    ('a1111111-1111-1111-1111-1111111111c1', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2025', 'completed', 2025);

-- The rows a statement touched, for the writes RLS is expected to turn into no-ops.
CREATE FUNCTION pg_temp.rows_of(p_sql text) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE n integer;
BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $f$;

-- ── 1. One active season, names, defaults ──────────────────────────────────
SELECT throws_ok(
    $$INSERT INTO public.season_settings (organization_id, name, status)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'Org A Second Active', 'active')$$,
    '23505', NULL,
    'a second active season for one organization is refused'
);
SELECT is(
    (SELECT array_agg(organization_id ORDER BY organization_id) FROM public.season_settings WHERE status = 'active'),
    ARRAY['a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222']::uuid[],
    'two organizations each hold their one active season'
);
SELECT throws_ok(
    $$INSERT INTO public.season_settings (organization_id, name)
      VALUES ('a1111111-1111-1111-1111-111111111111', '  org a FALL 2027 ')$$,
    '23505', NULL,
    'a season name that differs only in case and padding is refused'
);
SELECT lives_ok(
    $$INSERT INTO public.season_settings (organization_id, name)
      VALUES ('b2222222-2222-2222-2222-222222222222', 'Org A Fall 2027')$$,
    'the same name in another organization is fine'
);
SELECT is(
    (SELECT status FROM public.season_settings WHERE organization_id = 'b2222222-2222-2222-2222-222222222222' AND name = 'Org A Fall 2027'),
    'draft',
    'a season inserted with no status is a draft'
);
SELECT throws_ok(
    $$INSERT INTO public.season_settings (organization_id, name, status)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'Org A No Status', NULL)$$,
    '23502', NULL,
    'a NULL status is refused'
);

-- ── 2. No direct writes ────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (SELECT count(*)::int FROM public.season_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    3,
    'a member still reads the organization''s seasons'
);
SELECT throws_ok(
    $$INSERT INTO public.season_settings (organization_id, name, status)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'Org A Direct', 'draft')$$,
    '42501', NULL,
    'an admin''s direct insert into season_settings is refused'
);
SELECT is(
    pg_temp.rows_of($$UPDATE public.season_settings SET name = 'Renamed directly'
                       WHERE id = 'a1111111-1111-1111-1111-1111111111d1'$$),
    0,
    'an admin''s direct update reaches no season'
);
SELECT is(
    pg_temp.rows_of($$DELETE FROM public.season_settings
                       WHERE id = 'a1111111-1111-1111-1111-1111111111c1'$$),
    0,
    'an admin''s direct delete reaches no season'
);

-- ── 3. create_import_job fixes the season ──────────────────────────────────
SELECT is(
    (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'a.csv')).season_settings_id,
    'a1111111-1111-1111-1111-111111111aaa'::uuid,
    'no season named: the job is made for the active season'
);
SELECT is(
    (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'b.csv',
                              'a1111111-1111-1111-1111-1111111111d1')).season_settings_id,
    'a1111111-1111-1111-1111-1111111111d1'::uuid,
    'a named draft season is the job''s season'
);
SELECT is(
    (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'c.csv',
                              p_season_settings_id => NULL)).season_settings_id,
    'a1111111-1111-1111-1111-111111111aaa'::uuid,
    'an explicit NULL season is the active season too (the 3-argument call shape still resolves)'
);
SELECT throws_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'd.csv',
                                      'b2222222-2222-2222-2222-222222222bbb')$$,
    '42501', NULL,
    'another organization''s season is refused'
);
SELECT throws_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'e.csv',
                                      'a1111111-1111-1111-1111-1111111111c1')$$,
    '22023', NULL,
    'a completed season is refused'
);
SELECT is(
    (SELECT count(*)::int FROM public.import_jobs
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND storage_path IN ('imports/11111111-1111-1111-1111-111111111111/d.csv',
                             'imports/11111111-1111-1111-1111-111111111111/e.csv')),
    0,
    'a refused call creates no job'
);

-- ── 4. finalize_import_job reads the job's season ──────────────────────────
RESET role;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
    ('a1111111-0000-4000-8000-0000000e1001', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e1-draft.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111d1'),
    ('a1111111-0000-4000-8000-0000000e1002', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e1-legacy.csv', 'importing', '11111111-1111-1111-1111-111111111111', NULL),
    ('a1111111-0000-4000-8000-0000000e1003', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e1-completed.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111c1');
INSERT INTO public.staging_players
    (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e1001', 1, '{}'::jsonb,
     '{"first_name": "Dee", "last_name": "Eone", "external_registration_id": "E1-D", "age group": "9", "gender": "M"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e1002', 1, '{}'::jsonb,
     '{"first_name": "Lee", "last_name": "Eone", "external_registration_id": "E1-L", "age group": "11", "gender": "F"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e1003', 1, '{}'::jsonb,
     '{"first_name": "Cee", "last_name": "Eone", "external_registration_id": "E1-C", "age group": "7", "gender": "M"}'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000e1001') ->> 'promoted_rows')::int,
    1,
    'a job made for a draft season finalizes'
);
SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM public.divisions
      WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1'),
    ARRAY['U10B'],
    'the division it derives is created in the draft season'
);
SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM public.divisions
      WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
    ARRAY['Org A U10'],
    'and none is created in the active season'
);
SELECT is(
    (SELECT d.season_settings_id FROM public.players p JOIN public.divisions d ON d.id = p.division_id
      WHERE p.external_registration_id = 'E1-D'),
    'a1111111-1111-1111-1111-1111111111d1'::uuid,
    'the player is placed in the draft season''s division'
);
SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000e1002') ->> 'promoted_rows')::int,
    1,
    'a legacy job (no season) finalizes'
);
SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM public.divisions
      WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
    ARRAY['Org A U10', 'U12G'],
    'a legacy job lands in the active season'
);
SELECT throws_ok(
    $$SELECT public.finalize_import_job('a1111111-0000-4000-8000-0000000e1003')$$,
    '22023', NULL,
    'a job whose season has been completed is refused'
);
SELECT is(
    (SELECT count(*)::int FROM public.players WHERE external_registration_id = 'E1-C'),
    0,
    'the refused finalize promoted nobody'
);

-- ── 5. finalize_field_import_job resolves a practice Division in the job's season ──
RESET role;
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-11111111d101', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-1111111111d1', 'Draft Only U8');
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
    ('a1111111-0000-4000-8000-0000000e1011', 'a1111111-1111-1111-1111-111111111111', 'fields',
     'orga/e1-fields-draft.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111d1');
INSERT INTO public.staging_import_rows
    (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e1011', 'fields', 1, '{}'::jsonb,
     '{"location": "E1 Park", "name": "E1 Pitch", "type": "practice", "day": "Sat", "start": "09:00", "end": "09:30",
       "capacity": "1", "valid_from": "2027-09-04", "valid_until": "2027-11-27", "division_name": "draft only u8"}'::jsonb, '[]'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e1011', 'fields', 2, '{}'::jsonb,
     '{"location": "E1 Park", "name": "E1 Pitch", "type": "practice", "day": "Sat", "start": "10:00", "end": "10:30",
       "capacity": "1", "valid_from": "2027-09-04", "valid_until": "2027-11-27", "division_name": "Org A U10"}'::jsonb, '[]'::jsonb);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok(
    $$SELECT public.finalize_field_import_job('a1111111-0000-4000-8000-0000000e1011')$$,
    'a fields job for a draft season finalizes'
);
SELECT is(
    (SELECT array_agg(coalesce(ps.division_id::text, '-') ORDER BY ps.start_time) FROM public.practice_slots ps
      WHERE ps.organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND ps.valid_from = DATE '2027-09-04'),
    ARRAY['a1111111-1111-1111-1111-11111111d101']::text[],
    'a Division of the draft season reserves its slot; the active season''s division name finds nothing there'
);

-- ── 6. The two division writers refuse a completed season ──────────────────
SELECT throws_ok(
    $$SELECT public.upsert_division_for_import('a1111111-1111-1111-1111-111111111111',
          'a1111111-1111-1111-1111-1111111111c1', 'U9B')$$,
    '22023', NULL,
    'upsert_division_for_import refuses a completed season'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_division_settings('a1111111-1111-1111-1111-111111111111',
          'a1111111-1111-1111-1111-1111111111c1', NULL, 'U9B', 12, NULL, NULL, NULL, NULL, NULL, NULL)$$,
    '22023', NULL,
    'admin_upsert_division_settings refuses a completed season'
);
SELECT lives_ok(
    $$SELECT public.upsert_division_for_import('a1111111-1111-1111-1111-111111111111',
          'a1111111-1111-1111-1111-1111111111d1', 'U9B')$$,
    'upsert_division_for_import still writes a draft season'
);
SELECT lives_ok(
    $$SELECT public.admin_upsert_division_settings('a1111111-1111-1111-1111-111111111111',
          'a1111111-1111-1111-1111-1111111111d1', NULL, 'U9G', 12, NULL, NULL, NULL, NULL, NULL, NULL)$$,
    'admin_upsert_division_settings still writes a draft season'
);

SELECT * FROM finish();
ROLLBACK;
