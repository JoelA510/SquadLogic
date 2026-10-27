-- pgTAP: the coach practice preference RPCs (20260927000000; 8.6 PR 3b PR 1).
--
-- The boundary under the real `authenticated` role and real RLS: only an org admin decides a
-- requested preference or sets one; a later admin write supersedes the approved row; only an
-- admin of the organization reads the rows; a signed-in user with no membership (a coach,
-- before 20261104010000) and another organisation's admin read none.
-- Since 20261104010000 no coach signs in and `request_coach_practice_preference` is dropped:
-- the 'requested' row below is inserted as the owner (the admins import requests later).
-- `docs/sql/20260927000000_smoke.sql` covers the same ground in the local harness, plus the
-- audit rows, the one-approved index and the value CHECKs.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(7);

-- Two coaches of Org A (data: neither signs in).
INSERT INTO public.coaches (id, organization_id, full_name, email, status) VALUES
    ('c0000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
     'Charlie Coach-A', 'charlie@test.local', 'active'),
    ('c0000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111',
     'Other Coach-A', 'other-coach@test.local', 'active');
INSERT INTO public.coach_practice_preferences (id, organization_id, coach_id, dimension, level, value, requested_by)
VALUES ('c0000000-0000-4000-8000-0000000000a1', 'a1111111-1111-1111-1111-111111111111', 'c0000000-0000-4000-8000-000000000001',
        'weekday', 'must_keep', '"TUE"', '11111111-1111-1111-1111-111111111111');

SELECT ok(EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admin_decide_coach_practice_preference'), 'the decide RPC exists');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'request_coach_practice_preference'), 'no request RPC: no coach requests a practice preference');

SET LOCAL role = 'authenticated';

-- Charlie, signed in with no membership.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$SELECT public.admin_decide_coach_practice_preference(
        'c0000000-0000-4000-8000-0000000000a1', 'approve')$$,
    '42501', NULL,
    'a signed-in non-member cannot approve'
);

SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences),
    0,
    'a signed-in non-member reads no coach practice preferences'
);

-- Alice, an admin of Org A. The requested row is hers to read: the select below runs under RLS.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT lives_ok(
    $$SELECT public.admin_decide_coach_practice_preference(
        'c0000000-0000-4000-8000-0000000000a1', 'approve')$$,
    'an org admin approves a requested preference'
);

SELECT public.admin_set_coach_practice_preference(
    'c0000000-0000-4000-8000-000000000001', 'weekday', 'prefer_keep', '"THU"');
SELECT public.admin_set_coach_practice_preference(
    'c0000000-0000-4000-8000-000000000002', 'start_time', 'must_keep', '1020');

SELECT is(
    (SELECT array_agg(status ORDER BY status) FROM public.coach_practice_preferences
      WHERE coach_id = 'c0000000-0000-4000-8000-000000000001'),
    ARRAY['approved', 'superseded']::text[],
    'a later admin write supersedes the approved row: one approved, one superseded'
);

-- Bob, an admin of Org B.
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences),
    0,
    'another organisation''s admin reads no coach practice preferences'
);

SELECT * FROM finish();
ROLLBACK;
