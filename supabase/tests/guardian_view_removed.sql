-- pgTAP: the guardian view and the parent and player roles are gone
-- (migration 20261024010000; plan docs/changes/2026-10-22-admin-focus.md, R3).
--
--   * `profile_players`, `link_my_guardian_records`, `is_team_guardian` and
--     `guardian_contacts_view` are absent, no public function names one of
--     them (or the retired `guardian_contact_sharing` setting) in its code,
--     no policy names one, and `guardian.linked` keeps its `audit_actions`
--     row (old `audit_log` rows reference it);
--   * the people tables keep an admin read and nothing else: `players` and
--     `team_players` each have one SELECT policy, `is_org_admin`, and an admin
--     still reads both (the admin arm the old admin-or-guardian policies held
--     was not dropped with them);
--   * `get_team_roster` no longer returns `is_my_child`; the calendar token
--     and `get_team_staff` admit the team's current coach and no other member;
--   * the role checks admit admin, coach, staff (and tenant_admin for a
--     member) and nothing else; `admin_change_member_role` refuses `parent`
--     (22023).
-- Run as `authenticated` with a JWT sub where a caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(17);

-- ── 1. What the migration dropped ──────────────────────────────────────────
SELECT ok(to_regclass('public.profile_players') IS NULL, 'profile_players is gone');
SELECT ok(to_regprocedure('public.link_my_guardian_records()') IS NULL, 'link_my_guardian_records is gone');
SELECT ok(to_regprocedure('public.is_team_guardian(uuid)') IS NULL, 'is_team_guardian is gone');
SELECT ok(to_regprocedure('public.guardian_contacts_view(uuid, jsonb, boolean)') IS NULL,
    'guardian_contacts_view is gone');
SELECT is(
    (SELECT array_agg(o ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
               ~ '\m(profile_players|link_my_guardian_records|is_team_guardian|guardian_contacts_view|guardian_contact_sharing)\M'
        UNION ALL
        SELECT 'policy ' || tablename || '.' || policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\m(profile_players|is_team_guardian)\M'
    ) s),
    NULL,
    'no public function or policy names a dropped guardian object'
);
-- Positive control for the scan above: the same pattern finds a real body
-- that names the organization's flag reader, so it reads real bodies.
SELECT ok(
    EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = 'public.get_coach_directory(uuid)'::regprocedure
               AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ '\morg_flag\M'),
    'control: the scan reads real bodies (get_coach_directory calls org_flag)'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_actions WHERE action = 'guardian.linked'),
    1,
    'guardian.linked keeps its audit_actions row'
);

-- ── 2. The people tables: the admin read, alone ───────────────────────────
SELECT is(
    (SELECT array_agg(tablename || '.' || policyname || ' ' || qual ORDER BY tablename)
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('players', 'team_players') AND cmd IN ('SELECT', 'ALL')),
    ARRAY['players.players_select_admin is_org_admin(organization_id)',
          'team_players.team_players_select_admin is_org_admin(organization_id)'],
    'players and team_players each have one read policy, the admin one'
);

INSERT INTO public.players (id, organization_id, first_name, last_name) VALUES
    ('a1111111-0000-4000-8000-0000000003a1', 'a1111111-1111-1111-1111-111111111111', 'Rhea', 'Three');
INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-0000-4000-8000-0000000003a1',
     'a1111111-1111-1111-1111-111111111111');
INSERT INTO public.coaches (id, organization_id, user_id, full_name, email, status)
VALUES ('a1111111-0000-4000-8000-0000000003c1', 'a1111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'R3 Coach', 'r3-coach@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'a1111111-0000-4000-8000-0000000003c1', 'lead', '2020-01-01', NULL, 'pgtap');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (SELECT count(*)::int FROM public.players WHERE id = 'a1111111-0000-4000-8000-0000000003a1')
    + (SELECT count(*)::int FROM public.team_players WHERE player_id = 'a1111111-0000-4000-8000-0000000003a1'),
    2,
    'an admin still reads the player and their roster row directly'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(
    (SELECT count(*)::int FROM public.players WHERE organization_id = 'a1111111-1111-1111-1111-111111111111')
    + (SELECT count(*)::int FROM public.team_players WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    0,
    'the team''s current coach reads no player or roster row directly'
);

-- ── 3. The roster, staff and calendar token reads ─────────────────────────
SELECT is(
    (SELECT array_agg(r.first_name || ' ' || r.last_name) FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r),
    ARRAY['Rhea Three'],
    'the current coach reads the roster''s names'
);
SELECT is(
    (SELECT count(*)::int FROM public.team_calendar_tokens WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001')
    + (SELECT count(*)::int FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001')),
    2,
    'the current coach reads the team''s calendar token and staff'
);
RESET role;
SELECT ok(
    NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
                 WHERE p.oid = 'public.get_team_roster(uuid)'::regprocedure AND a = 'is_my_child')
    AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
                 WHERE p.oid = 'public.get_team_roster(uuid)'::regprocedure AND a = 'first_name'),
    'get_team_roster returns no is_my_child column'
);

-- ── 4. The roles ──────────────────────────────────────────────────────────
SELECT is(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.organization_members'::regclass AND conname = 'organization_members_role_check'),
    'CHECK ((role = ANY (ARRAY[''admin''::text, ''coach''::text, ''staff''::text, ''tenant_admin''::text])))',
    'a member is an admin, a coach, staff or a tenant_admin'
);
SELECT is(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.organization_invites'::regclass AND conname = 'organization_invites_role_check'),
    'CHECK ((role = ANY (ARRAY[''admin''::text, ''coach''::text, ''staff''::text])))',
    'an invite is for an admin, a coach or staff'
);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    $$SELECT public.admin_change_member_role('a1111111-1111-1111-1111-111111111111',
                                              '33333333-3333-3333-3333-333333333333', 'parent')$$,
    '22023', NULL, 'an admin cannot make a member a parent'
);
SELECT lives_ok(
    $$SELECT * FROM public.create_org_invite('a1111111-1111-1111-1111-111111111111', 'coach')$$,
    'an admin still invites a coach'
);
RESET role;

SELECT * FROM finish();
ROLLBACK;
