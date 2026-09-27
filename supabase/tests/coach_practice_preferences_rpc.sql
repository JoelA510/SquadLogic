-- pgTAP: the coach practice preference RPCs (20260927000000; 8.6 PR 3b PR 1).
--
-- The coach/admin boundary of plan §4 under the real `authenticated` role and
-- real RLS: a coach requests for themself only and never decides; an admin
-- approves, and a later admin write supersedes the approved row; a coach reads
-- only their own rows; another organisation's admin reads none.
-- `docs/sql/20260927000000_smoke.sql` covers the same ground in the local
-- harness, plus the audit rows, the one-approved index and the value CHECKs.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(8);

-- Two coaches of Org A: Charlie's own record, and one with no login.
INSERT INTO public.coaches (id, organization_id, user_id, full_name, email, status) VALUES
    ('c0000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
     '33333333-3333-3333-3333-333333333333', 'Charlie Coach-A', 'charlie@test.local', 'active'),
    ('c0000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111',
     NULL, 'Other Coach-A', 'other-coach@test.local', 'active');

SET LOCAL role = 'authenticated';

-- Charlie, a coach of Org A.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT lives_ok(
    $$SELECT public.request_coach_practice_preference(
        'c0000000-0000-4000-8000-000000000001', 'weekday', 'must_keep', '"TUE"')$$,
    'a coach requests a practice preference for themself'
);

SELECT throws_ok(
    $$SELECT public.request_coach_practice_preference(
        'c0000000-0000-4000-8000-000000000002', 'weekday', 'must_keep', '"WED"')$$,
    '42501', NULL,
    'a coach cannot request a practice preference for another coach'
);

SELECT throws_ok(
    $$SELECT public.admin_decide_coach_practice_preference(
        (SELECT id FROM public.coach_practice_preferences
          WHERE coach_id = 'c0000000-0000-4000-8000-000000000001' AND status = 'requested'),
        'approve')$$,
    '42501', NULL,
    'a coach cannot approve, their own request included'
);

-- Alice, an admin of Org A.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT lives_ok(
    $$SELECT public.admin_decide_coach_practice_preference(
        (SELECT id FROM public.coach_practice_preferences
          WHERE coach_id = 'c0000000-0000-4000-8000-000000000001' AND status = 'requested'),
        'approve')$$,
    'an org admin approves a coach''s request'
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

-- Charlie again: his own two rows, none of the other coach's.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences
      WHERE coach_id = 'c0000000-0000-4000-8000-000000000001'),
    2,
    'a coach reads their own rows'
);

SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences
      WHERE coach_id <> 'c0000000-0000-4000-8000-000000000001'),
    0,
    'a coach reads none of another coach''s rows'
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
