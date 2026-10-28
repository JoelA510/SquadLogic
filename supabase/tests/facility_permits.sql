-- pgTAP: field and venue permits (migration 20261102010000; plan
-- docs/changes/2026-10-22-phase-c-permits.md, C1, with the owner's rules of 2026-10-26; the
-- coach read was removed by 20261104010000: only league admins sign in).
--
-- Every caller against every surface, both directions. Org A unless noted:
--   Alice   admin (fixture)            Bob    admin of Org B only (fixture)
--   Charlie signed in, a member of no organization (fixture)
--   Sid     staff                      Cora, Finn, Otto, Quin  signed in, members of no organization
--           (they were coaches whose teams play or practise at the fields below; the games and the
--           practice stay, as the bookings that make a field delete ask first)
--   anon
-- Fields: Pitch 1 and Pitch 2 at Permit Park, Pitch 3 at Far Park, Pitch 4 at Bare Park, Pitch 5
-- (no game or practice; the boundary permits sit on it).
-- Permits: P1 Pitch 1; P2 Permit Park; P3 Pitch 3; P4 Pitch 1 and Pitch 3; P5 Pitch 2.
-- So an admin or staff member reads all five, and nobody else reads any.
--
-- Fixtures state every column they rely on: real Supabase differs from the harness in defaults.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(98);

-- ── Fixtures, as the owner ─────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
    ('e1000000-0000-4000-8000-000000000001', 'sid@test.local',  '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000002', 'cora@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000003', 'finn@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000004', 'otto@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000005', 'quin@test.local', '{"password_length": 12}', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name) VALUES
    ('e1000000-0000-4000-8000-000000000001', 'sid@test.local', 'Sid'),
    ('e1000000-0000-4000-8000-000000000002', 'cora@test.local', 'Cora'),
    ('e1000000-0000-4000-8000-000000000003', 'finn@test.local', 'Finn'),
    ('e1000000-0000-4000-8000-000000000004', 'otto@test.local', 'Otto'),
    ('e1000000-0000-4000-8000-000000000005', 'quin@test.local', 'Quin')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'e1000000-0000-4000-8000-000000000001', 'staff')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

-- Org A's season keeps a calendar day that differs from the UTC date at this very moment: UTC+14
-- when it is already 10:00 UTC or later (a day ahead), UTC-12 before (a day behind).
UPDATE public.season_settings
   SET timezone = CASE WHEN extract(hour FROM now() AT TIME ZONE 'UTC') >= 10
                       THEN 'Pacific/Kiritimati' ELSE 'Etc/GMT+12' END
 WHERE id = 'a1111111-1111-1111-1111-111111111aaa';

INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A2'),
    ('aaaaaaaa-0000-0000-0000-0000000000a3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A3'),
    ('aaaaaaaa-0000-0000-0000-0000000000a4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A4');

INSERT INTO public.locations (id, organization_id, name, lighting_available) VALUES
    ('f1000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Permit Park', false),
    ('f1000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'Far Park', false),
    ('f1000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'Bare Park', false),
    ('f1000000-0000-4000-8000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'B Park', false);
INSERT INTO public.fields (id, organization_id, location_id, name, active) VALUES
    ('f1000000-0000-4000-8000-000000000011', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000001', 'Pitch 1', true),
    ('f1000000-0000-4000-8000-000000000012', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000001', 'Pitch 2', true),
    ('f1000000-0000-4000-8000-000000000013', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000002', 'Pitch 3', true),
    ('f1000000-0000-4000-8000-000000000014', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000003', 'Pitch 4', true),
    ('f1000000-0000-4000-8000-000000000015', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000003', 'Pitch 5', true),
    ('f1000000-0000-4000-8000-00000000001b', 'b2222222-2222-2222-2222-222222222222', 'f1000000-0000-4000-8000-00000000000b', 'B Pitch', true);

-- A-Team plays A3 at Pitch 1; A4 plays A3 at Pitch 4; A2 practises at Pitch 3 (bookings).
INSERT INTO public.game_slots (id, organization_id, field_id, slot_date, week_index) VALUES
    ('f2000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000011', current_date + 7, 1),
    ('f2000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000014', current_date + 7, 1);
INSERT INTO public.games (id, organization_id, game_slot_id, home_team_id, away_team_id) VALUES
    ('f3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'f2000000-0000-4000-8000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a3'),
    ('f3000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'f2000000-0000-4000-8000-000000000004',
     'aaaaaaaa-0000-0000-0000-0000000000a4', 'aaaaaaaa-0000-0000-0000-0000000000a3');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time) VALUES
    ('f4000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000013', 'mon', '18:00', '19:00');
INSERT INTO public.practice_assignments (id, organization_id, team_id, practice_slot_id, slot_id, effective_date_range) VALUES
    ('f5000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a2',
     'f4000000-0000-4000-8000-000000000003', 'f4000000-0000-4000-8000-000000000003', daterange(current_date, current_date + 60, '[]'));

-- Org A's day, and the ids this file collects as it creates things.
CREATE TEMP TABLE t_day (d date) ON COMMIT DROP;
INSERT INTO t_day SELECT public.org_local_today('a1111111-1111-1111-1111-111111111111');
CREATE TEMP TABLE t_ids (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
CREATE TEMP TABLE t_out (name text PRIMARY KEY, body jsonb) ON COMMIT DROP;
GRANT ALL ON t_day, t_ids, t_out TO authenticated;

SELECT isnt((SELECT d FROM t_day), (now() AT TIME ZONE 'UTC')::date,
            'control: Org A''s calendar day differs from the UTC date, so a UTC-based status would be wrong');

-- ── 1. The admin writes five permits ───────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

INSERT INTO t_out SELECT 'P1', public.admin_create_facility_permit(
    'a1111111-1111-1111-1111-111111111111', '  Parks Dept One ', ' 0042 ', (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day),
    'Pitch 1 on weekends', ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[]);
INSERT INTO t_out SELECT 'P2', public.admin_create_facility_permit(
    'a1111111-1111-1111-1111-111111111111', 'Parks Dept Two', NULL, (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day),
    NULL, ARRAY['f1000000-0000-4000-8000-000000000001']::uuid[], ARRAY[]::uuid[]);
INSERT INTO t_out SELECT 'P3', public.admin_create_facility_permit(
    'a1111111-1111-1111-1111-111111111111', 'Far Parks', 'FP-3', (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day),
    NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000013']::uuid[]);
INSERT INTO t_out SELECT 'P4', public.admin_create_facility_permit(
    'a1111111-1111-1111-1111-111111111111', 'Both Parks', 'BP-4', (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day),
    NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011', 'f1000000-0000-4000-8000-000000000013',
                                  'f1000000-0000-4000-8000-000000000011']::uuid[]);
INSERT INTO t_out SELECT 'P5', public.admin_create_facility_permit(
    'a1111111-1111-1111-1111-111111111111', 'Pitch Two Only', NULL, (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day),
    NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000012']::uuid[]);
INSERT INTO t_ids SELECT name, (body ->> 'id')::uuid FROM t_out;

SELECT is((SELECT body ->> 'issuer' FROM t_out WHERE name = 'P1'), 'Parks Dept One', 'the issuer is stored trimmed');
SELECT is((SELECT body ->> 'permit_number' FROM t_out WHERE name = 'P1'), '0042', 'a permit number keeps its leading zeros: it is text');
SELECT is((SELECT body ->> 'permit_number' FROM t_out WHERE name = 'P2'), NULL, 'a permit may have no number');
SELECT is((SELECT jsonb_array_length(body -> 'scopes') FROM t_out WHERE name = 'P4'), 2, 'a field named twice is one scope');
SELECT is((SELECT body ->> 'status' FROM t_out WHERE name = 'P1'), 'valid', 'a permit valid for a year is valid');
SELECT is((SELECT body -> 'scopes' -> 0 ->> 'location_name' FROM t_out WHERE name = 'P1'), 'Permit Park', 'a field scope names its venue');

-- ── 2. Refusals write nothing ──────────────────────────────────────────────
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date - 1, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '22023', NULL, 'a permit that ends before it begins is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY[]::uuid[])$$,
    '22023', NULL, 'a permit with no venue or field is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-00000000001b']::uuid[])$$,
    '22023', NULL, 'a field of another organization is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY['f1000000-0000-4000-8000-00000000000b']::uuid[], ARRAY[]::uuid[])$$,
    '22023', NULL, 'a venue of another organization is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-0000000000ff']::uuid[])$$,
    '22023', NULL, 'an id that exists nowhere is refused with the same error');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', '   ', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '22023', NULL, 'a blank issuer is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', repeat('9', 101), current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '22023', NULL, 'a permit number over 100 characters is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, NULL, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '23502', NULL, 'a permit with no start date is refused');
SELECT throws_ok($$SELECT public.admin_create_facility_permit(NULL, 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '23502', NULL, 'a missing organization is refused');

-- Each writer refuses a caller who is not an admin of the organization, with 42501.
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '42501', NULL, 'a signed-in non-member (Cora) cannot create a permit');
SELECT throws_ok(format($$SELECT public.admin_update_facility_permit('a1111111-1111-1111-1111-111111111111', %L, 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$, (SELECT id FROM t_ids WHERE name = 'P1')),
    '42501', NULL, 'nor update a permit');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, 'x', 'x.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1')),
    '42501', NULL, 'nor attach a file');
SELECT throws_ok(format($$SELECT public.admin_delete_facility_permit('a1111111-1111-1111-1111-111111111111', %L)$$, (SELECT id FROM t_ids WHERE name = 'P1')),
    '42501', NULL, 'nor delete a permit');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '42501', NULL, 'a second non-member (Charlie) cannot create a permit');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '42501', NULL, 'another organization''s admin cannot create a permit here');
SELECT throws_ok(format($$SELECT public.admin_delete_facility_permit('b2222222-2222-2222-2222-222222222222', %L)$$, (SELECT id FROM t_ids WHERE name = 'P1')),
    'P0002', NULL, 'another organization''s admin, naming their own organization, finds no such permit to delete');
SELECT throws_ok(format($$SELECT public.admin_update_facility_permit('b2222222-2222-2222-2222-222222222222', %L, 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-00000000001b']::uuid[])$$, (SELECT id FROM t_ids WHERE name = 'P1')),
    'P0002', NULL, 'nor update it');

SET LOCAL role = 'anon';
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'anon cannot read permits');
SELECT throws_ok($$SELECT public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'X', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[])$$,
    '42501', NULL, 'anon cannot create a permit');

RESET role;
SELECT is((SELECT count(*)::int FROM public.facility_permits), 5, 'the refusals created nothing: exactly the five permits stand');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE metadata ->> 'setting' = 'facility.permit'), 5,
          'and wrote nothing: exactly one audit row per permit created');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE resource_type = 'facility_permit' AND action = 'settings.updated'
            AND metadata ->> 'operation' = 'created' AND resource_id IN (SELECT id FROM t_ids)), 5,
          'each is settings.updated on a facility_permit, operation created');

-- ── 3. Direct writes are closed ────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok($$INSERT INTO public.facility_permits (organization_id, issuer, valid_from, valid_to) VALUES ('a1111111-1111-1111-1111-111111111111', 'Direct', current_date, current_date)$$,
    '42501', NULL, 'an admin cannot insert a permit directly');
SELECT throws_ok($$UPDATE public.facility_permits SET issuer = 'Direct'$$, '42501', NULL, 'an admin cannot update a permit directly');
SELECT throws_ok($$DELETE FROM public.facility_permits$$, '42501', NULL, 'an admin cannot delete a permit directly');
SELECT throws_ok(format($$INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id) VALUES (%L, 'a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000012')$$, (SELECT id FROM t_ids WHERE name = 'P1')),
    '42501', NULL, 'an admin cannot insert a scope directly');
SELECT throws_ok($$DELETE FROM public.facility_permit_scopes$$, '42501', NULL, 'an admin cannot delete a scope directly');

-- ── 4. Who reads what: the tables ──────────────────────────────────────────
CREATE TEMP TABLE t_who (name text PRIMARY KEY, sub text) ON COMMIT DROP;
INSERT INTO t_who VALUES ('Alice', '11111111-1111-1111-1111-111111111111'), ('Sid', 'e1000000-0000-4000-8000-000000000001');
GRANT ALL ON t_who TO authenticated;

SELECT is((SELECT count(*)::int FROM public.facility_permits), 5, 'an admin reads every permit of the organization');
SELECT is((SELECT count(*)::int FROM public.facility_permit_scopes), 6, 'and every scope');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000001"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 5, 'staff read every permit, as an admin does');

SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 0,
          'Cora, signed in with no membership (once a coach of a team at a field a permit names), reads no permit');
SELECT is((SELECT count(*)::int FROM public.facility_permit_scopes), 0, 'and no scope');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 0,
          'Otto, signed in with no membership (once a coach of a team at a field a permit names), reads no permit');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000005"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 0,
          'Quin, signed in with no membership (once a coach of a team at a field a permit names), reads no permit');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 0,
          'Finn, signed in with no membership (once a coach of a team at a field a permit names), reads no permit');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 0, 'Charlie, a member of no organization, reads none');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is((SELECT count(*)::int FROM public.facility_permits), 0, 'another organization''s admin reads none');
SELECT is((SELECT count(*)::int FROM public.facility_permit_scopes), 0, 'nor any scope');
SET LOCAL role = 'anon';
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';
SELECT throws_ok($$SELECT count(*) FROM public.facility_permits$$, '42501', NULL, 'anon has no read on permits');
SELECT throws_ok($$SELECT count(*) FROM public.facility_permit_scopes$$, '42501', NULL, 'nor on scopes');

-- ── 5. Who reads what: get_facility_permits ────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(jsonb_array_length(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits'), 5, 'an admin reads all five through the RPC');
SELECT is(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') ->> 'today', (SELECT d::text FROM t_day),
          'the RPC judges on the organization''s own day, not the UTC date');
SELECT is((public.get_facility_permits('a1111111-1111-1111-1111-111111111111') ->> 'lead_days')::int, 30, 'the warning lead time is 30 days');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'Cora, a non-member, is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'Otto, a non-member, is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000005"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'Quin, a non-member, is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'Finn, a non-member, is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'Charlie, a non-member, is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$, '42501', NULL, 'another organization''s admin is refused');
SELECT throws_ok($$SELECT public.get_facility_permits(NULL)$$, '23502', NULL, 'a missing organization is refused');

-- ── 6. Status, on the organization's own day ───────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO t_out SELECT 'B0', public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'Boundary 0', NULL, (SELECT d - 100 FROM t_day), (SELECT d FROM t_day), NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000015']::uuid[]);
INSERT INTO t_out SELECT 'B30', public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'Boundary 30', NULL, (SELECT d - 100 FROM t_day), (SELECT d + 30 FROM t_day), NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000015']::uuid[]);
INSERT INTO t_out SELECT 'B31', public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'Boundary 31', NULL, (SELECT d - 100 FROM t_day), (SELECT d + 31 FROM t_day), NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000015']::uuid[]);
INSERT INTO t_out SELECT 'BX', public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'Boundary Expired', NULL, (SELECT d - 100 FROM t_day), (SELECT d - 1 FROM t_day), NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000015']::uuid[]);
INSERT INTO t_out SELECT 'BN', public.admin_create_facility_permit('a1111111-1111-1111-1111-111111111111', 'Boundary Not Yet', NULL, (SELECT d + 1 FROM t_day), (SELECT d + 100 FROM t_day), NULL, ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000015']::uuid[]);
INSERT INTO t_ids SELECT name, (body ->> 'id')::uuid FROM t_out WHERE name LIKE 'B%';

SELECT is((SELECT p ->> 'status' || ':' || (p ->> 'days_left') FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Boundary 0'),
          'expiring:0', 'valid_to today is the last valid day: expiring, 0 days left');
SELECT is((SELECT p ->> 'status' || ':' || (p ->> 'days_left') FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Boundary 30'),
          'expiring:30', 'valid_to in 30 days is still expiring');
SELECT is((SELECT p ->> 'status' || ':' || (p ->> 'days_left') FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Boundary 31'),
          'valid:31', 'valid_to in 31 days is valid');
SELECT is((SELECT p ->> 'status' || ':' || (p ->> 'days_left') FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Boundary Expired'),
          'expired:-1', 'valid_to yesterday is expired');
SELECT is((SELECT p ->> 'status' FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Boundary Not Yet'),
          'not_yet_valid', 'a permit that starts tomorrow is not yet valid');

-- ── 7. Files: attach, replace, and what is refused ─────────────────────────
RESET role;
INSERT INTO storage.objects (bucket_id, name, metadata) VALUES
    ('facility-permits', (SELECT 'a1111111-1111-1111-1111-111111111111/' || id || '/c0000000-0000-4000-8000-000000000001.pdf' FROM t_ids WHERE name = 'P1'),
        '{"size": 52000, "mimetype": "application/pdf"}'),
    ('facility-permits', (SELECT 'a1111111-1111-1111-1111-111111111111/' || id || '/c0000000-0000-4000-8000-000000000002.png' FROM t_ids WHERE name = 'P1'),
        '{"size": 90000, "mimetype": "image/png"}'),
    ('facility-permits', (SELECT 'a1111111-1111-1111-1111-111111111111/' || id || '/c0000000-0000-4000-8000-000000000003.pdf' FROM t_ids WHERE name = 'P1'),
        '{"size": 52000, "mimetype": "text/html"}'),
    ('facility-permits', (SELECT 'a1111111-1111-1111-1111-111111111111/' || id || '/c0000000-0000-4000-8000-000000000004.pdf' FROM t_ids WHERE name = 'P1'),
        '{"size": 11534336, "mimetype": "application/pdf"}'),
    ('facility-permits', (SELECT 'a1111111-1111-1111-1111-111111111111/' || id || '/c0000000-0000-4000-8000-000000000005.pdf' FROM t_ids WHERE name = 'P2'),
        '{"size": 52000, "mimetype": "application/pdf"}'),
    ('facility-permits', (SELECT upper('a1111111-1111-1111-1111-111111111111') || '/' || id || '/c0000000-0000-4000-8000-000000000006.pdf' FROM t_ids WHERE name = 'P1'),
        '{"size": 52000, "mimetype": "application/pdf"}');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'permit.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1'), 'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-0000000000ee.pdf'),
    '22023', NULL, 'a file that was never uploaded is refused');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'permit.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1'), 'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000003.pdf'),
    '22023', NULL, 'an object whose type is text/html is refused');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'permit.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1'), 'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000004.pdf'),
    '22023', NULL, 'an object of 11 MiB is refused');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'permit.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1'), 'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P2') || '/c0000000-0000-4000-8000-000000000005.pdf'),
    '22023', NULL, 'an object in another permit''s folder is refused, though it exists');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'permit.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1'), upper('a1111111-1111-1111-1111-111111111111') || '/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000006.pdf'),
    '22023', NULL, 'an object whose organization folder is spelled in capitals is refused: the folders are the permit''s own ids, exactly');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'permit.exe')$$, (SELECT id FROM t_ids WHERE name = 'P1'), 'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000001.exe'),
    '22023', NULL, 'an extension outside pdf, jpg, jpeg and png is refused');

SELECT is(public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', (SELECT id FROM t_ids WHERE name = 'P1'),
              'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000001.pdf', 'Permit 0042.pdf') ->> 'previous_path',
          NULL, 'attaching a first file has no previous path');
SELECT is((SELECT file_name || '|' || file_mime || '|' || file_size FROM public.facility_permits WHERE id = (SELECT id FROM t_ids WHERE name = 'P1')),
          'Permit 0042.pdf|application/pdf|52000', 'the type and size are those the bucket recorded, not the caller''s');
SELECT throws_ok(format($$SELECT public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', %L, %L, 'again.pdf')$$, (SELECT id FROM t_ids WHERE name = 'P1'), 'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000001.pdf'),
    '22023', NULL, 'attaching the object that is already the file is refused: the caller would delete it');
SELECT is(public.admin_set_facility_permit_file('a1111111-1111-1111-1111-111111111111', (SELECT id FROM t_ids WHERE name = 'P1'),
              'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000002.png', 'Scan.png') ->> 'previous_path',
          'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000001.pdf',
          'replacing returns the previous path for the caller to remove');
SELECT is((SELECT array_agg(metadata ->> 'operation' ORDER BY created_at, metadata ->> 'operation')
             FROM public.audit_log WHERE resource_id = (SELECT id FROM t_ids WHERE name = 'P1') AND metadata ->> 'operation' LIKE 'file_%'),
          ARRAY['file_attached', 'file_replaced'], 'the attach and the replace are each audited');

-- ── 8. Update replaces the scope set ───────────────────────────────────────
SELECT is(jsonb_array_length(public.admin_update_facility_permit('a1111111-1111-1111-1111-111111111111', (SELECT id FROM t_ids WHERE name = 'P4'),
              'Both Parks', 'BP-4', (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day), NULL,
              ARRAY['f1000000-0000-4000-8000-000000000002']::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011']::uuid[]) -> 'scopes'),
          2, 'an update replaces the scope set: Pitch 3 is out, Far Park is in, Pitch 1 stays');
SELECT is((SELECT count(*)::int FROM public.facility_permit_scopes WHERE permit_id = (SELECT id FROM t_ids WHERE name = 'P4') AND field_id = 'f1000000-0000-4000-8000-000000000013'),
          0, 'the dropped scope is gone');
SELECT throws_ok(format($$SELECT public.admin_update_facility_permit('a1111111-1111-1111-1111-111111111111', %L, 'Both Parks', NULL, current_date, current_date, NULL, ARRAY[]::uuid[], ARRAY[]::uuid[])$$, (SELECT id FROM t_ids WHERE name = 'P4')),
    '22023', NULL, 'an update that leaves no scope is refused');
SELECT is((SELECT file_name FROM public.facility_permits WHERE id = (SELECT id FROM t_ids WHERE name = 'P1')), 'Scan.png', 'an update leaves the file alone');
SELECT is((SELECT (metadata -> 'previous' -> 'scopes' -> 0 ->> 'kind') || '>' || jsonb_array_length(metadata -> 'current' -> 'scopes')
             FROM public.audit_log WHERE resource_id = (SELECT id FROM t_ids WHERE name = 'P4') AND metadata ->> 'operation' = 'updated'),
          'field>2', 'the update''s audit row carries the previous and the current permit');

-- Put P4 back for the checks that follow.
SELECT is(jsonb_array_length(public.admin_update_facility_permit('a1111111-1111-1111-1111-111111111111', (SELECT id FROM t_ids WHERE name = 'P4'),
              'Both Parks', 'BP-4', (SELECT d - 30 FROM t_day), (SELECT d + 365 FROM t_day), NULL,
              ARRAY[]::uuid[], ARRAY['f1000000-0000-4000-8000-000000000011', 'f1000000-0000-4000-8000-000000000013']::uuid[]) -> 'scopes'),
          2, 'P4 covers Pitch 1 and Pitch 3 again');

-- ── 9. The admin reads the file's name and path ────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT p -> 'file' ->> 'name' FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Parks Dept One'),
          'Scan.png', 'an admin is given the live file''s name and path');

-- ── 10. A retired field reads as retired ───────────────────────────────────
RESET role;
UPDATE public.fields SET effective_to = (SELECT d - 1 FROM t_day), active = false WHERE id = 'f1000000-0000-4000-8000-000000000012';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT p -> 'scopes' -> 0 ->> 'retired' FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Pitch Two Only'),
          'true', 'a permit''s scope on a retired field says so; the permit is untouched');
SELECT is((SELECT p -> 'scopes' -> 0 ->> 'retired' FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Far Parks'),
          'false', 'and a live field''s does not');

-- ── 11. Deleting a field lists the permits it unlinks ──────────────────────
-- Pitch 5 holds the five boundary permits and no booking; Pitch 2 holds P5 and no booking.
SELECT is(public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000012') ->> 'reason',
          'permits_linked', 'a field with only a permit on it is refused with its own reason');
SELECT is((public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000012') -> 'affected' -> 0 ->> 'kind')
          || ':' || (public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000012') -> 'affected' -> 0 ->> 'disposition'),
          'permit:unlinked', 'the refusal lists the permit as unlinked');
SELECT is((public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000015') ->> 'affected_count')::int, 5,
          'Pitch 5 lists its five permits');
SELECT is(public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000011') ->> 'reason',
          'bookings_exist', 'a field with a game and a permit is refused as booked');
SELECT is((SELECT count(*)::int FROM jsonb_array_elements(public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000011') -> 'affected') x WHERE x ->> 'kind' = 'permit'),
          2, 'and lists the two permits that name Pitch 1 (not Permit Park''s, which covers the venue)');
SELECT is(public.admin_delete_field('a1111111-1111-1111-1111-111111111111', 'f1000000-0000-4000-8000-000000000012', true) ->> 'deleted', 'true',
          'confirmed, the delete proceeds');
RESET role;
SELECT is((SELECT count(*)::int FROM public.facility_permits WHERE id = (SELECT id FROM t_ids WHERE name = 'P5')), 1, 'the permit stays');
SELECT is((SELECT count(*)::int FROM public.facility_permit_scopes WHERE permit_id = (SELECT id FROM t_ids WHERE name = 'P5')), 0, 'with no scope left');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(jsonb_array_length((SELECT p -> 'scopes' FROM jsonb_array_elements(public.get_facility_permits('a1111111-1111-1111-1111-111111111111') -> 'permits') p WHERE p ->> 'issuer' = 'Pitch Two Only')),
          0, 'the admin reads it with an empty scope list');

-- ── 12. Delete a permit ────────────────────────────────────────────────────
SELECT is(public.admin_delete_facility_permit('a1111111-1111-1111-1111-111111111111', (SELECT id FROM t_ids WHERE name = 'P1')) ->> 'file_path',
          'a1111111-1111-1111-1111-111111111111/' || (SELECT id FROM t_ids WHERE name = 'P1') || '/c0000000-0000-4000-8000-000000000002.png',
          'deleting returns the file path for the caller to remove');
RESET role;
SELECT is((SELECT count(*)::int FROM public.facility_permits WHERE id = (SELECT id FROM t_ids WHERE name = 'P1'))
        + (SELECT count(*)::int FROM public.facility_permit_scopes WHERE permit_id = (SELECT id FROM t_ids WHERE name = 'P1')), 0,
          'the permit and its scopes are gone');
SELECT is((SELECT metadata -> 'previous' ->> 'issuer' FROM public.audit_log WHERE resource_id = (SELECT id FROM t_ids WHERE name = 'P1') AND metadata ->> 'operation' = 'deleted'),
          'Parks Dept One', 'and the audit row keeps the whole permit');

-- ── 13. The shape of the catalogue ─────────────────────────────────────────
SELECT is((SELECT array_agg(tablename || ':' || cmd || ':' || array_to_string(roles, ',') ORDER BY tablename)
             FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('facility_permits', 'facility_permit_scopes')),
          ARRAY['facility_permit_scopes:SELECT:authenticated', 'facility_permits:SELECT:authenticated'],
          'each table has exactly one policy: a SELECT for authenticated, no write policy');
SELECT ok(NOT has_function_privilege('authenticated', 'public.org_local_today(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.facility_permit_json(uuid,date)', 'EXECUTE'),
          'the internal helpers are no client''s to call');
SELECT ok(NOT has_function_privilege('anon', 'public.get_facility_permits(uuid)', 'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                           AND (proname LIKE 'coach\_%permit%' ESCAPE '\' OR proname = 'coach_field_ids_of'
                                OR (proname = 'facility_permit_json' AND pronargs <> 2))),
          'anon executes not the read, and no coach policy helper or three-argument permit view exists (20261104010000)');

-- A permit blocks nothing (owner, 2026-10-26): no import, scheduling, publish or export function reads
-- a permit table. The only functions whose bodies name one are the permit RPCs and their helpers, and
-- admin_delete_field, which lists the permits it unlinks. A function in this list that is not meant to
-- be fails here until someone argues it in.
SELECT is(
    (SELECT array_agg(p.proname::text ORDER BY p.proname)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        AND p.prosrc ~ 'facility_permit(s|_scopes)'),
    ARRAY['admin_create_facility_permit', 'admin_delete_facility_permit', 'admin_delete_field',
          'admin_set_facility_permit_file', 'admin_update_facility_permit', 'facility_permit_json',
          'get_facility_permits'],
    'the only functions that read a permit table are the permit RPCs, their helpers and admin_delete_field'
);

SELECT * FROM finish();
ROLLBACK;
