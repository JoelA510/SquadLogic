-- Behavioral verification for 20260726000000_drop_stale_broad_write_policies.sql
--
-- Charlie was a coach (non-admin) member of Org A; since 20261104010000 removed
-- the coach role he is a signed-in non-member. Before 20260726000000, the stale
-- "Unified org access on teams/coaches/locations" policy let any org member
-- write to these tables directly. After it, only the narrow SELECT policies
-- remain for `authenticated`; and a non-member reads nothing either.
--
-- Note the two different RLS failure modes:
--   * UPDATE/DELETE affect zero rows silently -- the surviving SELECT
--     policy's USING clause filters the target row out of the statement's
--     visibility, so there is simply nothing to modify.
--   * INSERT RAISES 42501 -- there is no existing row to filter, so the
--     absent INSERT policy fails the WITH CHECK outright. This matches the
--     established expectation in supabase/tests/facility_admin_rpcs.sql:204.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(6);

-- Seed one location in Org A (not part of the shared fixture).
INSERT INTO public.locations (id, organization_id, name)
VALUES ('c0c0c0c0-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Org A Field House')
ON CONFLICT (id) DO NOTHING;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

-- 1. Charlie (non-member) cannot rename A-Team directly.
UPDATE public.teams SET name = 'Hijacked Team Name'
WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
RESET role;
SELECT is(
  (SELECT name FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'A-Team',
  'a non-member cannot rename a team via direct UPDATE'
);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

-- 2. Charlie cannot delete A-Team directly.
DELETE FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
RESET role;
SELECT is(
  (SELECT count(*)::int FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1,
  'a non-member cannot delete a team via direct DELETE'
);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

-- 3. Charlie cannot insert a new coach row directly. INSERT raises rather
--    than no-opping (see the failure-mode note in the header).
SELECT throws_ok(
  $$
    INSERT INTO public.coaches (organization_id, full_name, email)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'Fabricated Coach', 'fabricated@test.local')
  $$,
  '42501',
  NULL,
  'a non-member cannot insert a new coach row via direct INSERT'
);

-- 4. Charlie cannot rename the Org A location directly.
UPDATE public.locations SET name = 'Hijacked Location'
WHERE id = 'c0c0c0c0-0000-0000-0000-000000000001';
RESET role;
SELECT is(
  (SELECT name FROM public.locations WHERE id = 'c0c0c0c0-0000-0000-0000-000000000001'),
  'Org A Field House',
  'a non-member cannot rename a location via direct UPDATE'
);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

-- 5. A non-member reads neither the team nor the location: the narrow read
--    policies are member-only, and every member is an admin.
SELECT is(
  (SELECT count(*)::int FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0,
  'a non-member reads no team of the organization'
);

-- 6.
SELECT is(
  (SELECT count(*)::int FROM public.locations WHERE id = 'c0c0c0c0-0000-0000-0000-000000000001'),
  0,
  'a non-member reads no location of the organization'
);

SELECT * FROM finish();
ROLLBACK;
