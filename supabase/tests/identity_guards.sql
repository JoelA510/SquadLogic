-- pgTAP: who the caller is (migration 20261020040000; plan
-- docs/changes/2026-10-20-phase-a-privacy.md, A2 items 1 and 2).
--
-- The profiles column guard, each refused column written through the table as a signed-in user
-- updating their own row. `link_my_coach_record` (A2 item 1) was dropped by 20261104010000, with
-- the sign-in link on coach records: no coach signs in, so it stays gone.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(7);

SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'link_my_coach_record'), 'no function links a sign-in to a coach record (20261104010000)');

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
    ('d1000000-0000-4000-8000-000000000001', 'Lee@Test.local',  '{"password_length": 12}', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role) VALUES
    ('d1000000-0000-4000-8000-000000000001', 'lee@test.local', 'Lee', 'user')
ON CONFLICT (id) DO UPDATE SET role = 'user';

-- ── profiles: the four account-page columns, and no other ──────────────────
-- Lee's role, organization and email as they stand, whatever set them.
CREATE TEMP TABLE lee_before AS
SELECT role || '|' || coalesce(organization_id::text, 'null') || '|' || email AS before_row
  FROM public.profiles WHERE id = 'd1000000-0000-4000-8000-000000000001';
GRANT SELECT ON lee_before TO authenticated;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-4000-8000-000000000001"}';
SELECT lives_ok(
    $$UPDATE public.profiles SET full_name = 'Lee L', first_name = 'Lee', last_name = 'L', avatar_url = NULL
       WHERE id = 'd1000000-0000-4000-8000-000000000001'$$,
    'a user updates their own name and avatar'
);
SELECT throws_ok(
    $$UPDATE public.profiles SET role = 'admin' WHERE id = 'd1000000-0000-4000-8000-000000000001'$$,
    '42501', NULL, 'a user cannot change their own profile role'
);
SELECT throws_ok(
    $$UPDATE public.profiles SET organization_id = 'b2222222-2222-2222-2222-222222222222'
       WHERE id = 'd1000000-0000-4000-8000-000000000001'$$,
    '42501', NULL, 'a user cannot change their own profile organization'
);
SELECT throws_ok(
    $$UPDATE public.profiles SET email = 'other@test.local' WHERE id = 'd1000000-0000-4000-8000-000000000001'$$,
    '42501', NULL, 'a user cannot change their own profile email'
);
RESET role;
SELECT is(
    (SELECT role || '|' || coalesce(organization_id::text, 'null') || '|' || email || '|' || full_name
       FROM public.profiles WHERE id = 'd1000000-0000-4000-8000-000000000001'),
    (SELECT before_row FROM pg_temp.lee_before) || '|Lee L',
    'the refused updates changed nothing, and the allowed one took'
);
SELECT ok(NOT has_table_privilege('anon', 'public.profiles', 'UPDATE')
          AND NOT has_column_privilege('anon', 'public.profiles', 'full_name', 'UPDATE'),
          'anon cannot update profiles at all');

SELECT * FROM finish();
ROLLBACK;
