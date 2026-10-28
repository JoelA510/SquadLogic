-- pgTAP: only league admins sign in (migrations 20261104010000 and 20261104020000; plan
-- docs/changes/2026-10-27-admin-only.md, S1 and S3).
--
--   * the role checks refuse `coach` on a member and on an invite, `create_org_invite` and
--     `admin_change_member_role` refuse it, and every role the member check admits is one
--     `is_org_admin` admits (so `is_org_member` is an admin test by construction);
--   * the coach-only functions are gone, and the permit view has one signature;
--   * the reads that had a coach arm admit an admin and refuse a signed-in non-member (Charlie)
--     and another organization's admin (Bob): coaches, assignments, calendar tokens, permits, the
--     permit RPC and the permit file in storage, and each narrowed policy is exactly the admin
--     expression in the catalogue;
--   * `reconcile_prod_rls_drift()` still runs on the head chain;
--   * `coaches` has no `user_id` or `profile_id`, and no foreign key from it reaches `auth.users`.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(24);

-- ── 1. The roles ──────────────────────────────────────────────────────────
SELECT throws_ok(
    $$INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES ('a1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'coach')$$,
    '23514', NULL, 'a member cannot be given the coach role, even written past the RPCs');
SELECT throws_ok(
    $$INSERT INTO public.organization_invites (code, organization_id, role, created_by)
      VALUES ('ADMINONLY1', 'a1111111-1111-1111-1111-111111111111', 'coach', '11111111-1111-1111-1111-111111111111')$$,
    '23514', NULL, 'an invite cannot carry the coach role, even written past the RPCs');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    $$SELECT * FROM public.create_org_invite('a1111111-1111-1111-1111-111111111111', 'coach')$$,
    '22023', NULL, 'create_org_invite refuses the coach role');
SELECT throws_ok(
    $$SELECT public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '11111111-1111-1111-1111-111111111111', 'coach')$$,
    '22023', NULL, 'admin_change_member_role refuses the coach role');
RESET role;

-- The roles the member check admits, from the catalogue, are exactly the roles that are admins.
SELECT is(
    (SELECT array_agg(m[1] ORDER BY m[1])
       FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
      WHERE c.conname = 'organization_members_role_check'),
    ARRAY['admin', 'staff', 'tenant_admin'],
    'organization_members_role_check admits admin, staff and tenant_admin and nothing else');
SELECT is(
    (SELECT array_agg(m[1] ORDER BY m[1])
       FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
      WHERE c.conname = 'organization_invites_role_check'),
    ARRAY['admin', 'staff'],
    'organization_invites_role_check admits admin and staff and nothing else');

-- For each admitted role, a member of that role is a member and an admin: is_org_member stays an
-- admin test. One user per role, each a member of Org A, probed as that user.
INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role)
VALUES ('44444444-4444-4444-4444-444444444444', 'tara@test.local', '{"password_length": 12}', 'authenticated', 'authenticated'),
       ('88888888-8888-8888-8888-888888888888', 'sam@test.local',  '{"password_length": 12}', 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name) VALUES
    ('44444444-4444-4444-4444-444444444444', 'tara@test.local', 'Tara'),
    ('88888888-8888-8888-8888-888888888888', 'sam@test.local', 'Sam')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('a1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'tenant_admin'),
    ('a1111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888', 'staff');
CREATE TEMP TABLE role_probe (uid uuid, is_member boolean, is_admin boolean);
GRANT ALL ON role_probe TO authenticated;
DO $probe$
DECLARE u uuid;
BEGIN
    FOREACH u IN ARRAY ARRAY['11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444',
                             '88888888-8888-8888-8888-888888888888', '33333333-3333-3333-3333-333333333333']::uuid[] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
        SET LOCAL ROLE authenticated;
        INSERT INTO role_probe VALUES (u, public.is_org_member('a1111111-1111-1111-1111-111111111111'),
                                          public.is_org_admin('a1111111-1111-1111-1111-111111111111'));
        RESET ROLE;
    END LOOP;
END
$probe$;
SELECT is(
    (SELECT array_agg(uid::text || ':' || is_member || ':' || is_admin ORDER BY uid::text) FROM role_probe),
    ARRAY['11111111-1111-1111-1111-111111111111:true:true',
          '33333333-3333-3333-3333-333333333333:false:false',
          '44444444-4444-4444-4444-444444444444:true:true',
          '88888888-8888-8888-8888-888888888888:true:true'],
    'an admin, a tenant_admin and a staff member are members and admins; a signed-in non-member is neither');

-- ── 2. The dropped functions ──────────────────────────────────────────────
SELECT is(
    (SELECT array_agg(proname::text ORDER BY proname::text) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('link_my_coach_record', 'get_my_division_teams', 'admin_get_division_teams', 'division_teams_of',
                        'get_my_coached_team_ids', 'admin_get_coached_team_ids', 'request_coach_practice_preference',
                        'caller_coaches_practice_slot', 'coach_reads_facility_permit_file', 'coach_reads_facility_permit',
                        'coach_covers_permit_scope', 'coach_field_ids_of', 'coached_team_ids_of', 'is_current_team_coach')),
    NULL, 'none of the 14 coach-only functions remains');
SELECT is(
    (SELECT array_agg(p.oid::regprocedure::text) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'facility_permit_json'),
    ARRAY['facility_permit_json(uuid,date)'],
    'the permit view has one signature, without the coach parameter');
-- Not vacuous: the survivors the scan above must not have swept are there.
SELECT ok(to_regprocedure('public.get_team_roster(uuid)') IS NOT NULL
          AND to_regprocedure('public.get_facility_permits(uuid)') IS NOT NULL
          AND to_regprocedure('public.finalize_coach_import_job(uuid,jsonb)') IS NOT NULL,
          'control: the replaced functions are still there');

-- ── 3. The reads: an admin, and nobody else ───────────────────────────────
INSERT INTO public.coaches (id, organization_id, full_name, email, status)
VALUES ('f0000000-0000-4000-8000-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'Coach One', 'one@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'f0000000-0000-4000-8000-0000000000c1', 'lead',
        public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 3, NULL, 'pgtap', NULL);
INSERT INTO public.locations (id, organization_id, name)
VALUES ('f0000000-0000-4000-8000-0000000000d1', 'a1111111-1111-1111-1111-111111111111', 'Admin Park');
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('f0000000-0000-4000-8000-0000000000d2', 'a1111111-1111-1111-1111-111111111111',
        'f0000000-0000-4000-8000-0000000000d1', 'Admin Pitch', true);
INSERT INTO public.facility_permits (id, organization_id, issuer, valid_from, valid_to, file_path, file_name, file_mime, file_size)
VALUES ('f0000000-0000-4000-8000-0000000000e1', 'a1111111-1111-1111-1111-111111111111', 'Admin Permit',
        current_date - 5, current_date + 50,
        'a1111111-1111-1111-1111-111111111111/f0000000-0000-4000-8000-0000000000e1/c0000000-0000-4000-8000-0000000000f1.pdf',
        'p.pdf', 'application/pdf', 1000);
INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id)
VALUES ('f0000000-0000-4000-8000-0000000000e1', 'a1111111-1111-1111-1111-111111111111', 'f0000000-0000-4000-8000-0000000000d2');
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('facility-permits',
        'a1111111-1111-1111-1111-111111111111/f0000000-0000-4000-8000-0000000000e1/c0000000-0000-4000-8000-0000000000f1.pdf',
        '{"size": 1000, "mimetype": "application/pdf"}');

CREATE FUNCTION pg_temp.reads() RETURNS text LANGUAGE sql AS $f$
    SELECT (SELECT count(*) FROM public.coaches)::text || '/'
        || (SELECT count(*) FROM public.team_coach_assignments)::text || '/'
        || (SELECT count(*) FROM public.team_calendar_tokens
             WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001')::text || '/'
        || (SELECT count(*) FROM public.facility_permits)::text || '/'
        || (SELECT count(*) FROM public.facility_permit_scopes)::text || '/'
        || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'facility-permits')::text
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.reads() TO authenticated;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.reads(), '1/1/1/1/1/1',
          'an admin reads the coach, the assignment, the team''s calendar token, the permit, its scope and its file');
SET LOCAL "request.jwt.claims" TO '{"sub":"88888888-8888-8888-8888-888888888888"}';
SELECT is(pg_temp.reads(), '1/1/1/1/1/1', 'a staff member reads the same');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.reads(), '0/0/0/0/0/0', 'a signed-in non-member (Charlie) reads none of them');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.reads(), '0/0/0/0/0/0', 'another organization''s admin reads none of them');

-- The permit RPC.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(jsonb_array_length(public.get_facility_permits('a1111111-1111-1111-1111-111111111111')->'permits'), 1,
          'get_facility_permits returns the permit to an admin');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$,
                 '42501', NULL, 'and refuses a signed-in non-member');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok($$SELECT public.get_facility_permits('a1111111-1111-1111-1111-111111111111')$$,
                 '42501', NULL, 'and another organization''s admin');
RESET role;

-- Each narrowed policy is exactly the admin expression, in the catalogue.
SELECT is(
    (SELECT array_agg(tablename || ': ' || policyname ORDER BY tablename)
       FROM pg_policies
      WHERE schemaname = 'public' AND cmd = 'SELECT' AND qual = 'is_org_admin(organization_id)'
        AND ((tablename, policyname) IN (('coaches', 'coaches_select_admin'),
                                         ('team_coach_assignments', 'team_coach_assignments_select_admin'),
                                         ('coach_practice_preferences', 'Coach practice preferences: admins read'),
                                         ('practice_lighting_overrides', 'Practice lighting overrides: admins read'),
                                         ('facility_permits', 'Facility permits: admins select'),
                                         ('facility_permit_scopes', 'Facility permit scopes: admins select')))),
    ARRAY['coach_practice_preferences: Coach practice preferences: admins read',
          'coaches: coaches_select_admin',
          'facility_permit_scopes: Facility permit scopes: admins select',
          'facility_permits: Facility permits: admins select',
          'practice_lighting_overrides: Practice lighting overrides: admins read',
          'team_coach_assignments: team_coach_assignments_select_admin'],
    'the six narrowed read policies are exactly is_org_admin(organization_id)');
SELECT is(
    (SELECT count(*)::int FROM pg_policies
      WHERE (schemaname = 'public' AND tablename IN ('coaches', 'team_coach_assignments', 'team_calendar_tokens',
                                                     'coach_practice_preferences', 'practice_lighting_overrides',
                                                     'facility_permits', 'facility_permit_scopes')
             OR schemaname = 'storage' AND tablename = 'objects' AND policyname = 'facility-permits select')
        AND (coalesce(qual, '') || coalesce(with_check, '')) ~* '(coach|user_id)'),
    0, 'no policy on those tables or on the permit objects names a coach or user_id');

-- ── 4. The reconcile function ─────────────────────────────────────────────
SELECT is(
    (SELECT jsonb_array_length(r->'created') || '/' || jsonb_array_length(r->'dropped')
       FROM (SELECT public.reconcile_prod_rls_drift() AS r) s),
    '0/0', 'reconcile_prod_rls_drift runs at head, creating and dropping nothing');

-- ── 5. The coach record has no account link (20261104020000) ───────────────
SELECT is(
    (SELECT array_agg(attname::text) FROM pg_attribute
      WHERE attrelid = 'public.coaches'::regclass AND attnum > 0 AND NOT attisdropped
        AND attname IN ('user_id', 'profile_id')),
    NULL, 'coaches has no user_id and no profile_id');
SELECT is(
    (SELECT count(*)::int FROM pg_constraint
      WHERE conrelid = 'public.coaches'::regclass AND contype = 'f'
        AND confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)),
    0, 'and no foreign key from coaches reaches auth.users or profiles');
-- Not vacuous: the other foreign keys of coaches are still there.
SELECT cmp_ok(
    (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.coaches'::regclass AND contype = 'f'),
    '>=', 1, 'control: coaches still has its organization foreign key');
-- 20261108010000 made the per-organization key a per-season one (a unique index on
-- (organization_id, season_settings_id, lower(email))); the normalising check stays.
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM (
        SELECT conname::text AS k FROM pg_constraint
         WHERE conrelid = 'public.coaches'::regclass AND contype IN ('u', 'c')
           AND conname IN ('coaches_organization_id_email_key', 'coaches_email_key', 'coaches_email_normalised')
        UNION ALL
        SELECT c.relname::text FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'public.coaches'::regclass AND i.indisunique
           AND c.relname = 'coaches_organization_season_email_key') x),
    ARRAY['coaches_email_normalised', 'coaches_organization_season_email_key'],
    'the coach email is unique per organization and season and stored normalised; the global and per-organization keys are gone');

SELECT * FROM finish();
ROLLBACK;
