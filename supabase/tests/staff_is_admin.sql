-- pgTAP: staff are admins (owner decision 2026-10-20; migration 20261020030000;
-- plan docs/changes/2026-10-20-phase-a-privacy.md, A2 item 3).
--
-- rls_policy_matrix.sql holds a staff persona's table access equal to an
-- admin's on the 26 advisor tables. This file covers what the matrix does not:
-- `is_org_admin` itself, the member RPCs' last-admin guards, and a catalogue
-- check that no policy or function in `public` names `'admin'` as a role
-- without `'staff'` beside it, so a new one that forgets staff fails here.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(9);

-- Sam: staff of Org A only. Org A also has Alice (admin) and Charlie (coach).
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('88888888-8888-8888-8888-888888888888', 'sam@test.local',
        jsonb_build_object('full_name', 'Sam Staff-A', 'password_length', 12))
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name)
VALUES ('88888888-8888-8888-8888-888888888888', 'sam@test.local', 'Sam Staff-A')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888', 'staff')
ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'staff';

-- ── The catalogue: no role test names 'admin' without 'staff' ─────────────
-- Not vacuous: the policies that name a role are counted first.
SELECT cmp_ok(
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%''admin''::text%'),
    '>=', 9::bigint,
    'at least the nine policies that test a role by name are found'
);
SELECT is(
    (SELECT array_agg(tablename || ': ' || policyname ORDER BY tablename, policyname)
       FROM pg_policies
      WHERE schemaname = 'public'
        AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%''admin''::text%'
        AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%''staff''::text%'),
    NULL,
    'no policy in public admits ''admin'' by name without ''staff'''
);
-- Two functions name 'admin' for another reason: initialize_new_tenant makes
-- the creator an admin, and reconcile_prod_rls_drift recognises admin-gated
-- policies by their text. Any other is a role test that forgot staff.
SELECT set_eq(
    $$SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc LIKE '%''admin''%' AND p.prosrc NOT LIKE '%''staff''%'$$,
    ARRAY['initialize_new_tenant', 'reconcile_prod_rls_drift'],
    'every function in public that names ''admin'' as a role also names ''staff'''
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"88888888-8888-8888-8888-888888888888"}';

SELECT is(
    public.is_org_admin('a1111111-1111-1111-1111-111111111111'), true,
    'a staff member is an admin of their own organization'
);
SELECT is(
    public.is_org_admin('b2222222-2222-2222-2222-222222222222'), false,
    'a staff member is not an admin of another organization'
);

-- The member RPCs: staff pass the admin gate.
SELECT lives_ok(
    $$SELECT public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '33333333-3333-3333-3333-333333333333', 'parent')$$,
    'a staff member changes another member''s role'
);

-- The last-admin guards count staff. Sam removes Alice, leaving Sam the only
-- admin-equivalent member of Org A; Sam may then not demote himself.
SELECT lives_ok(
    $$SELECT public.admin_remove_member('a1111111-1111-1111-1111-111111111111',
                                         '11111111-1111-1111-1111-111111111111')$$,
    'a staff member removes the admin while another admin-equivalent member (themself) remains'
);
SELECT throws_ok(
    $$SELECT public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '88888888-8888-8888-8888-888888888888', 'coach')$$,
    '22023', 'Cannot demote the last admin of the organization',
    'the last admin-equivalent member, a staff member, cannot be demoted'
);

RESET role;
SELECT is(
    (SELECT role FROM public.organization_members
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND profile_id = '88888888-8888-8888-8888-888888888888'),
    'staff',
    'the refused demotion left the staff member''s role as it was'
);

SELECT * FROM finish();
ROLLBACK;
