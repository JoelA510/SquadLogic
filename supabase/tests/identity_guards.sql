-- pgTAP: who the caller is (migration 20261020040000; plan
-- docs/changes/2026-10-20-phase-a-privacy.md, A2 items 1 and 2).
--
-- link_my_coach_record as each caller it must link or refuse, run as
-- `authenticated` with a JWT sub; and the profiles column guard, each refused
-- column written through the table as a signed-in user updating their own row.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(15);

-- Callers, all members of Org A except Ian (Org B only):
--   Lee  verified;   coach row in Org A, in another case
--   Una  unverified; coach row in Org A
--   Ian  verified;   member of Org B; his coach row is in Org A
--   Tom  verified;   coach row in Org A already linked to Lee's twin (Max)
--   Eve  verified;   member of Org A; her coach row is an 'interested' lead
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
    ('d1000000-0000-4000-8000-000000000001', 'Lee@Test.local',  '{"password_length": 12}', now()),
    ('d1000000-0000-4000-8000-000000000002', 'una@test.local',  '{"password_length": 12}', NULL),
    ('d1000000-0000-4000-8000-000000000003', 'ian@test.local',  '{"password_length": 12}', now()),
    ('d1000000-0000-4000-8000-000000000004', 'tom@test.local',  '{"password_length": 12}', now()),
    ('d1000000-0000-4000-8000-000000000005', 'max@test.local',  '{"password_length": 12}', now()),
    ('d1000000-0000-4000-8000-000000000006', 'eve@test.local',  '{"password_length": 12}', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name, role) VALUES
    ('d1000000-0000-4000-8000-000000000001', 'lee@test.local', 'Lee', 'user'),
    ('d1000000-0000-4000-8000-000000000002', 'una@test.local', 'Una', 'user'),
    ('d1000000-0000-4000-8000-000000000003', 'ian@test.local', 'Ian', 'user'),
    ('d1000000-0000-4000-8000-000000000004', 'tom@test.local', 'Tom', 'user'),
    ('d1000000-0000-4000-8000-000000000005', 'max@test.local', 'Max', 'user'),
    ('d1000000-0000-4000-8000-000000000006', 'eve@test.local', 'Eve', 'user')
ON CONFLICT (id) DO UPDATE SET role = 'user';
INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'd1000000-0000-4000-8000-000000000001', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', 'd1000000-0000-4000-8000-000000000002', 'coach'),
    ('b2222222-2222-2222-2222-222222222222', 'd1000000-0000-4000-8000-000000000003', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', 'd1000000-0000-4000-8000-000000000004', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', 'd1000000-0000-4000-8000-000000000006', 'coach')
ON CONFLICT (organization_id, profile_id) DO NOTHING;
INSERT INTO public.coaches (id, organization_id, full_name, email, user_id) VALUES
    ('d2000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Lee', 'LEE@test.LOCAL', NULL),
    ('d2000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'Una', 'una@test.local', NULL),
    ('d2000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'Ian', 'ian@test.local', NULL),
    ('d2000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'Tom', 'tom@test.local',
     'd1000000-0000-4000-8000-000000000005');
INSERT INTO public.coaches (id, organization_id, full_name, email, status) VALUES
    ('d2000000-0000-4000-8000-000000000006', 'a1111111-1111-1111-1111-111111111111', 'Eve', 'eve@test.local', 'interested');

SET LOCAL role = 'authenticated';

-- ── link_my_coach_record ──────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-4000-8000-000000000001"}';
SELECT is(public.link_my_coach_record()->>'status', 'linked',
          'a verified member is linked to the coach row with their email, case ignored');
SELECT is(public.link_my_coach_record()->>'status', 'already_linked',
          'a second call is already_linked');

SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-4000-8000-000000000002"}';
SELECT is(public.link_my_coach_record()->>'status', 'email_not_verified',
          'an unverified email links nothing');

SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-4000-8000-000000000003"}';
SELECT is(public.link_my_coach_record()->>'status', 'no_match',
          'a coach row in an organization the caller does not belong to is not matched');

SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-4000-8000-000000000004"}';
SELECT is(public.link_my_coach_record()->>'status', 'linked_to_another',
          'a coach row linked to another account is refused');

SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-4000-8000-000000000006"}';
SELECT is(public.link_my_coach_record()->>'status', 'no_match',
          'an interested lead (a parent willing to coach) is not linked as a coach');

RESET role;
SELECT is(
    (SELECT array_agg(c.full_name || '=' || coalesce(c.user_id::text, 'null') ORDER BY c.full_name)
       FROM public.coaches c WHERE c.id::text LIKE 'd2000000-%'),
    ARRAY['Eve=null', 'Ian=null', 'Lee=d1000000-0000-4000-8000-000000000001', 'Tom=d1000000-0000-4000-8000-000000000005', 'Una=null'],
    'only Lee''s row was linked; every refusal left its row as it was'
);
SELECT is(
    (SELECT count(*) FROM public.audit_log
      WHERE action = 'coach.linked' AND resource_id = 'd2000000-0000-4000-8000-000000000001'
        AND user_id = 'd1000000-0000-4000-8000-000000000001'),
    1::bigint,
    'the link wrote one coach.linked audit row, as the caller'
);
SELECT ok(NOT has_function_privilege('anon', 'public.link_my_coach_record()', 'EXECUTE'),
          'anon cannot call link_my_coach_record');

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
