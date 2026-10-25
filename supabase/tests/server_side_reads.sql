-- pgTAP: the server-side reads (migration 20261021010000; plan
-- docs/changes/2026-10-20-phase-a-privacy.md, A3 and "A3 as built").
--
-- Every row of the access table for every caller, both directions: the caller
-- the table admits gets the data, the caller it refuses gets 42501. Run as
-- `authenticated` with a JWT sub; flags and fixtures are set as the owner.
--
-- Callers (Org A unless noted), all with confirmed emails:
--   Alice  admin (fixture)              Bob   admin of Org B only (fixture)
--   Sid    staff                        Cora  current lead coach of A-Team
--   Finn   A-Team assistant until yesterday
--   Otto   current lead coach of A2 (another Org A team)
--   Mo     a coach-role member who coaches no team
-- Players on A-Team: Pia, Rex. On A2: Quinn.
--
-- **Since 20261024010000 (plan docs/changes/2026-10-22-admin-focus.md, R3)**
-- there is no guardian and no `parent` role: the guardian callers (Gwen, Hal),
-- the guardian link, the teammate-sharing setting and the guardian contact
-- card went with them, and a current coach reads names only.
-- supabase/tests/guardian_view_removed.sql checks the removal.
--
-- **Since 20261025010000 (R4)** there are no contact surfaces: guardian
-- contacts, the contact card and the coach directory are gone, and the staff
-- read returns no phone or email. Their cases went with them;
-- supabase/tests/contact_surfaces_removed.sql checks the removal and that no
-- read a coach can call returns a contact column.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(17);

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
    ('e1000000-0000-4000-8000-000000000001', 'sid@test.local',  '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000002', 'cora@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000003', 'finn@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000004', 'otto@test.local', '{"password_length": 12}', now()),
    ('e1000000-0000-4000-8000-000000000007', 'mo@test.local',   '{"password_length": 12}', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name) VALUES
    ('e1000000-0000-4000-8000-000000000001', 'sid@test.local', 'Sid'),
    ('e1000000-0000-4000-8000-000000000002', 'cora@test.local', 'Cora'),
    ('e1000000-0000-4000-8000-000000000003', 'finn@test.local', 'Finn'),
    ('e1000000-0000-4000-8000-000000000004', 'otto@test.local', 'Otto'),
    ('e1000000-0000-4000-8000-000000000007', 'mo@test.local', 'Mo')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'e1000000-0000-4000-8000-000000000001', 'staff'),
    ('a1111111-1111-1111-1111-111111111111', 'e1000000-0000-4000-8000-000000000002', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', 'e1000000-0000-4000-8000-000000000003', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', 'e1000000-0000-4000-8000-000000000004', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', 'e1000000-0000-4000-8000-000000000007', 'coach')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'A2');

INSERT INTO public.coaches (id, organization_id, user_id, full_name, email, status) VALUES
    ('e2000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111',
     'e1000000-0000-4000-8000-000000000002', 'Cora', 'cora@test.local', 'active'),
    ('e2000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111',
     'e1000000-0000-4000-8000-000000000003', 'Finn', 'finn@test.local', 'active'),
    ('e2000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111',
     'e1000000-0000-4000-8000-000000000004', 'Otto', 'otto@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
     'e2000000-0000-4000-8000-000000000002', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 30, NULL, 'pgtap', NULL),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
     'e2000000-0000-4000-8000-000000000003', 'assistant',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 30,
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 1, 'pgtap', 'pgtap'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a2',
     'e2000000-0000-4000-8000-000000000004', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-0000000000a2') - 30, NULL, 'pgtap', NULL);

INSERT INTO public.players (id, organization_id, first_name, last_name, rating) VALUES
    ('e3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Pia', 'Able', 3),
    ('e3000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'Rex', 'Baker', 4),
    ('e3000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'Quinn', 'Cole', 2);
INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111'),
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'e3000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111');

SET LOCAL role = 'authenticated';

-- ── get_team_roster: admitted ─────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT array_agg(r.first_name || ':' || coalesce(r.rating::text, '-') ORDER BY r.first_name)
             FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r),
          ARRAY['Pia:3', 'Rex:4'], 'an admin reads the roster with ratings');

SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000001"}';
SELECT is((SELECT array_agg(r.first_name || ':' || coalesce(r.rating::text, '-') ORDER BY r.first_name)
             FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r),
          ARRAY['Pia:3', 'Rex:4'], 'staff read the roster as an admin does');

SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT is((SELECT array_agg(r.first_name || ':' || coalesce(r.rating::text, '-') ORDER BY r.first_name)
             FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r),
          ARRAY['Pia:-', 'Rex:-'],
          'the current coach reads names only: no rating');

-- ── get_team_roster: refused ──────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a coach whose assignment ended yesterday is refused the roster');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'the coach of another team is refused the roster');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000007"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a member with no tie to the team is refused the roster');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'another organization''s admin is refused the roster');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_roster('00000000-0000-4000-8000-00000000dead') $$,
                 '42501', NULL, 'an unknown team is refused like a forbidden one');

-- ── get_team_staff ────────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT is((SELECT array_agg(s.full_name || ':' || s.role || ':' || coalesce(s.status, '-'))
             FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') s),
          ARRAY['Cora:lead:-'],
          'the current coach reads the current coach, not the former one, and no status');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000007"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a member with no tie to the team is refused the staff');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a former coach is refused the staff');

-- ── identity ──────────────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT is((SELECT array_agg(t) FROM public.get_my_coached_team_ids('a1111111-1111-1111-1111-111111111111') t),
          ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid], 'the current coach coaches A-Team');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT is((SELECT count(*)::int FROM public.get_my_coached_team_ids('a1111111-1111-1111-1111-111111111111')),
          0, 'a coach whose assignment ended coaches nothing');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT array_agg(t) FROM public.admin_get_coached_team_ids('a1111111-1111-1111-1111-111111111111',
                                                                     'e1000000-0000-4000-8000-000000000004') t),
          ARRAY['aaaaaaaa-0000-0000-0000-0000000000a2'::uuid],
          'an admin''s role preview reads the coach''s current teams');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT throws_ok($$ SELECT * FROM public.admin_get_coached_team_ids('a1111111-1111-1111-1111-111111111111',
                                                                   'e1000000-0000-4000-8000-000000000002') $$,
                 '42501', NULL, 'a coach is refused another member''s coached teams');

RESET role;
UPDATE public.season_settings SET timezone = 'Pacific/Kiritimati'
 WHERE id = 'a1111111-1111-1111-1111-111111111aaa';
SELECT is(public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001'),
          (now() AT TIME ZONE 'Pacific/Kiritimati')::date,
          'today is judged in the team''s season timezone');

SELECT ok(NOT has_function_privilege('anon', 'public.get_team_roster(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.org_flag(uuid,text,boolean)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.team_local_today(uuid)', 'EXECUTE'),
          'anon cannot read a roster, and no client role can call the settings or date helpers');

SELECT * FROM finish();
ROLLBACK;
