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
-- Players on A-Team: Pia, Rex (two guardian contacts each). On A2: Quinn.
--
-- **Since 20261024010000 (plan docs/changes/2026-10-22-admin-focus.md, R3)**
-- there is no guardian and no `parent` role: the guardian callers (Gwen, Hal),
-- the guardian link, the teammate-sharing setting and the guardian contact
-- card went with them, and a current coach reads names only.
-- supabase/tests/guardian_view_removed.sql checks the removal.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(28);

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

INSERT INTO public.coaches (id, organization_id, user_id, full_name, email, phone, status) VALUES
    ('e2000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111',
     'e1000000-0000-4000-8000-000000000002', 'Cora', 'cora@test.local', '555-0102', 'active'),
    ('e2000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111',
     'e1000000-0000-4000-8000-000000000003', 'Finn', 'finn@test.local', '555-0103', 'active'),
    ('e2000000-0000-4000-8000-000000000004', 'a1111111-1111-1111-1111-111111111111',
     'e1000000-0000-4000-8000-000000000004', 'Otto', 'otto@test.local', '555-0104', 'active');
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

INSERT INTO public.players (id, organization_id, first_name, last_name, rating, guardian_contacts) VALUES
    ('e3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Pia', 'Able', 3,
     '[{"name": "Gwen", "email": "gwen@test.local", "phone": "555-0201"},
       {"name": "Gus", "email": "gus@test.local"}]'),
    ('e3000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'Rex', 'Baker', 4,
     '[{"name": "Rhea", "email": "rhea@test.local", "alternate_email": "rhea2@test.local", "phone": "555-0202"},
       {"name": "Ron", "email": "ron@test.local"}]'),
    ('e3000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'Quinn', 'Cole', 2,
     '[{"name": "Hal", "email": "hal@test.local"}]');
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
SELECT is((SELECT array_agg(r.first_name || ':' || coalesce(r.rating::text, '-') || ':'
                            || jsonb_array_length(r.guardian_contacts) ORDER BY r.first_name)
             FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r),
          ARRAY['Pia:-:0', 'Rex:-:0'],
          'the current coach reads names only: no guardian contact and no rating');

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT ok((SELECT r.guardian_contacts -> 0 ? 'alternate_email'
             FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r
            WHERE r.first_name = 'Rex'),
          'an admin sees a guardian''s alternate email');

-- A stored guardian_contact_sharing (the setting R3 retired) narrows nothing.
RESET role;
UPDATE public.organizations SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"guardian_contact_sharing": false}'
 WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT sum(jsonb_array_length(r.guardian_contacts))::int
             FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001') r),
          4, 'a stored guardian_contact_sharing changes nothing an admin reads');
RESET role;
UPDATE public.organizations SET feature_flags = feature_flags - 'guardian_contact_sharing'
 WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL role = 'authenticated';

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
SELECT is((SELECT array_agg(s.full_name || ':' || s.role || ':' || coalesce(s.phone, '-') || ':'
                            || coalesce(s.status, '-'))
             FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') s),
          ARRAY['Cora:lead:555-0102:-'],
          'the current coach reads the current coach''s contact details, not the former one, and no status');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000007"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a member with no tie to the team is refused the staff');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000003"}';
SELECT throws_ok($$ SELECT * FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a former coach is refused the staff');

-- ── contact card ──────────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT throws_ok($$ SELECT public.set_my_contact_card('call me', NULL, true) $$,
                 '22023', NULL, 'a card phone that is not a phone number is refused');
SELECT lives_ok($$ SELECT public.set_my_contact_card('+1 555 0999', 'cora.card@test.local', true) $$,
                'a coach saves a shared card');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT s.phone || ' ' || s.email FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') s),
          '+1 555 0999 cora.card@test.local', 'a shared card replaces the coach''s imported details');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000002"}';
SELECT lives_ok($$ SELECT public.set_my_contact_card('+1 555 0999', 'cora.card@test.local', false) $$,
                'a coach unshares the card');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT coalesce(s.phone, '-') || ' ' || coalesce(s.email, '-')
             FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') s),
          '- -', 'an unshared card shows no phone or email, imported or saved');

-- ── get_coach_directory ───────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT is((SELECT array_agg(d.full_name ORDER BY d.full_name)
             FROM public.get_coach_directory('a1111111-1111-1111-1111-111111111111') d),
          ARRAY['Cora', 'Otto'], 'a current coach reads every current coach, and not the former one');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000007"}';
SELECT throws_ok($$ SELECT * FROM public.get_coach_directory('a1111111-1111-1111-1111-111111111111') $$,
                 '42501', NULL, 'a member who coaches no team is refused the coach directory');
RESET role;
UPDATE public.organizations SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"coach_directory": false}'
 WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000004"}';
SELECT throws_ok($$ SELECT * FROM public.get_coach_directory('a1111111-1111-1111-1111-111111111111') $$,
                 '42501', NULL, 'with the directory off, a coach is refused it');
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-4000-8000-000000000001"}';
SELECT is((SELECT count(*)::int FROM public.get_coach_directory('a1111111-1111-1111-1111-111111111111')),
          2, 'with the directory off, staff still read it');

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
          'anon cannot read a roster, and no client role can call the contact or date helpers');

SELECT * FROM finish();
ROLLBACK;
