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

-- Sam: staff of Org A only. Org A also has Alice (admin) and Tess (staff). Charlie is a
-- signed-in non-member (20261104010000 removed the coach role).
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
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('99999999-9999-9999-9999-999999999999', 'tess@test.local',
        jsonb_build_object('full_name', 'Tess Staff-A', 'password_length', 12))
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name)
VALUES ('99999999-9999-9999-9999-999999999999', 'tess@test.local', 'Tess Staff-A')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999', 'staff')
ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'staff';

-- ── The catalogue: no role test names 'admin' without 'staff' ─────────────
-- Not vacuous: the policies that name a role are counted first.
SELECT cmp_ok(
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%''admin''::text%'),
    -- Nine when 20261020030000 was written; 20261022020000 dropped the three
    -- registration_forms admin policies with the table, and 20261101010000 the three
    -- season_settings admin policies (the season RPCs are its writers).
    '>=', 3::bigint,
    'at least the three policies that test a role by name are found'
);
-- Each expression on its own (USING, then WITH CHECK): a USING that admits
-- staff must not hide a WITH CHECK that does not.
SELECT is(
    (SELECT array_agg(p.tablename || ': ' || p.policyname || ' (' || e.part || ')'
                      ORDER BY p.tablename, p.policyname, e.part)
       FROM pg_policies p,
            LATERAL (VALUES ('using', p.qual), ('with check', p.with_check)) e(part, expr)
      WHERE p.schemaname = 'public'
        AND e.expr LIKE '%''admin''::text%'
        AND e.expr NOT LIKE '%''staff''::text%'),
    NULL,
    'no policy expression in public admits ''admin'' by name without ''staff'''
);
-- Every role list in a function body that names 'admin' -- an `IN (...)` or a
-- parenthesised list -- names 'staff' too, list by list, so a function whose
-- other list already says 'staff' cannot hide one that does not; and no body
-- tests `= 'admin'` alone. Two functions name 'admin' for another reason and
-- are left out: initialize_new_tenant makes the creator an admin, and
-- reconcile_prod_rls_drift matches policy text.
SELECT is(
    (SELECT array_agg(DISTINCT p.proname::text ORDER BY p.proname::text)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname NOT IN ('initialize_new_tenant', 'reconcile_prod_rls_drift')
        AND (EXISTS (SELECT 1 FROM regexp_matches(p.prosrc, '\(([^()]*''admin''[^()]*)\)', 'g') m
                      WHERE m[1] NOT LIKE '%''staff''%')
             OR p.prosrc ~ '=\s*''admin''')),
    NULL,
    'every role list in a function body that names ''admin'' names ''staff'' too'
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
    -- Tess to admin and back to staff, so Sam and Tess are both staff again
    -- once Alice is removed below.
    $$SELECT public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '99999999-9999-9999-9999-999999999999', 'admin'),
             public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '99999999-9999-9999-9999-999999999999', 'staff')$$,
    'a staff member changes another member''s role'
);

-- admin_remove_member's last-admin guard counts staff. Sam removes Alice,
-- leaving Sam and Tess; the role given to a member is 'admin' or 'staff', both
-- admins, so a change of role has no last-admin guard to count them for.
SELECT lives_ok(
    $$SELECT public.admin_remove_member('a1111111-1111-1111-1111-111111111111',
                                         '11111111-1111-1111-1111-111111111111')$$,
    'a staff member removes the admin while other admin-equivalent members remain'
);
SELECT throws_ok(
    $$SELECT public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '88888888-8888-8888-8888-888888888888', 'coach')$$,
    '22023', 'invalid role: coach',
    'no member can be given the retired coach role'
);

RESET role;
SELECT is(
    (SELECT role FROM public.organization_members
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND profile_id = '88888888-8888-8888-8888-888888888888'),
    'staff',
    'the refused role change left the staff member''s role as it was'
);

SELECT * FROM finish();
ROLLBACK;
