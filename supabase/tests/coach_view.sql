-- pgTAP: the coach view (20261028010000; plan
-- docs/changes/2026-10-22-admin-focus.md, R6).
--
-- The plan's test: `get_my_division_teams` returns no contact column and
-- nothing outside the coach's divisions. Also: the preview read is an
-- admin's; a coach writes no score and requests no lighting; withdrawing is
-- an admin's.
--
-- Personas: Alice (admin of Org A), Bob (admin of Org B), Charlie (coach of
-- Org A, A-Team, U10) from _fixtures.sql; Dana coaches A-Team 2 (U10); Eve
-- coaches A-Team U12 (another division); Finn is a coach-role member who
-- coaches no team. Every email is `@test.local`; there is no PII.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(16);

INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role) VALUES
    ('44444444-4444-4444-4444-444444444444', 'dana@test.local', '{"password_length": 12}', 'authenticated', 'authenticated'),
    ('55555555-5555-5555-5555-555555555555', 'eve@test.local', '{"password_length": 12}', 'authenticated', 'authenticated'),
    ('66666666-6666-6666-6666-666666666666', 'finn@test.local', '{"password_length": 12}', 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email) VALUES
    ('44444444-4444-4444-4444-444444444444', 'dana@test.local'),
    ('55555555-5555-5555-5555-555555555555', 'eve@test.local'),
    ('66666666-6666-6666-6666-666666666666', 'finn@test.local')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('a1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'coach'),
    ('a1111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'coach')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
VALUES ('a1111111-1111-1111-1111-11111111abce', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa', 'Org A U12');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000003', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'A-Team 2'),
    ('aaaaaaaa-0000-0000-0000-000000000004', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abce', 'A-Team U12');
INSERT INTO public.coaches (id, organization_id, user_id, full_name, email, status) VALUES
    ('c3333333-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
     '33333333-3333-3333-3333-333333333333', 'Charlie Coach-A', 'charlie@test.local', 'active'),
    ('c4444444-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
     '44444444-4444-4444-4444-444444444444', 'Dana Coach-A', 'dana@test.local', 'active'),
    ('c5555555-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
     '55555555-5555-5555-5555-555555555555', 'Eve Coach-A', 'eve@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
     'c3333333-0000-4000-8000-000000000001', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 1, NULL, 'pgtap', NULL),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003',
     'c4444444-0000-4000-8000-000000000001', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000003') - 1, NULL, 'pgtap', NULL),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
     'c5555555-0000-4000-8000-000000000001', 'lead',
     public.team_local_today('aaaaaaaa-0000-0000-0000-000000000004') - 1, NULL, 'pgtap', NULL);
INSERT INTO public.games (id, organization_id, season_id, home_team_id, away_team_id, start_time)
VALUES ('a1111111-1111-1111-1111-00000000aa02', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000003', now() - interval '1 day');
UPDATE public.organizations SET feature_flags = '{"score_entry": true}'::jsonb
 WHERE id = 'a1111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- The shape: no contact column, no anon, the request RPC gone.
-- ---------------------------------------------------------------------------

SELECT is(
    (SELECT count(*)::int
       FROM pg_proc p
      CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
      WHERE p.oid = 'public.get_my_division_teams(uuid)'::regprocedure
        AND a.mode = 't'),
    6,
    'control: get_my_division_teams has its six result columns to judge'
);

SELECT is(
    (SELECT count(*)::int
       FROM pg_proc p
      CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
      WHERE p.oid IN ('public.get_my_division_teams(uuid)'::regprocedure,
                      'public.admin_get_division_teams(uuid, uuid)'::regprocedure)
        AND a.mode = 't'
        AND a.name ~* '(e_?mail|phone|contact|guardian)'),
    0,
    'no division read returns a column named like an email, a phone, a contact or a guardian'
);

SELECT ok(
    NOT has_function_privilege('anon', 'public.get_my_division_teams(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.division_teams_of(uuid, uuid)', 'EXECUTE'),
    'anon cannot call the division read, and no client role the internal one'
);

SELECT ok(
    to_regprocedure('public.request_practice_lighting_override(uuid, date, date)') IS NULL,
    'no coach lighting request RPC'
);

-- ---------------------------------------------------------------------------
-- The coach's divisions, and nothing else.
-- ---------------------------------------------------------------------------

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT results_eq(
    $$ SELECT team_name, coach_names, is_mine
         FROM public.get_my_division_teams('a1111111-1111-1111-1111-111111111111')
        ORDER BY team_name $$,
    $$ VALUES ('A-Team'::text, ARRAY['Charlie Coach-A']::text[], true),
              ('A-Team 2'::text, ARRAY['Dana Coach-A']::text[], false) $$,
    'a coach reads every team of their division, with its coaches'' names and theirs marked'
);

SELECT is(
    (SELECT count(*)::int FROM public.get_my_division_teams('a1111111-1111-1111-1111-111111111111')
      WHERE division_id <> 'a1111111-1111-1111-1111-11111111abcd'),
    0,
    'nothing outside the coach''s division (A-Team U12 is in U12)'
);

SELECT is(
    (SELECT count(*)::int FROM public.get_my_division_teams('b2222222-2222-2222-2222-222222222222')),
    0,
    'nothing of an organization the coach does not coach in'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"55555555-5555-5555-5555-555555555555"}';
SELECT results_eq(
    $$ SELECT team_name FROM public.get_my_division_teams('a1111111-1111-1111-1111-111111111111') $$,
    $$ VALUES ('A-Team U12'::text) $$,
    'a coach in another division reads that division only'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"66666666-6666-6666-6666-666666666666"}';
SELECT is(
    (SELECT count(*)::int FROM public.get_my_division_teams('a1111111-1111-1111-1111-111111111111')),
    0,
    'a member who coaches no team reads nothing'
);

-- ---------------------------------------------------------------------------
-- The preview read is an admin's.
-- ---------------------------------------------------------------------------

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT results_eq(
    $$ SELECT team_name FROM public.admin_get_division_teams(
           'a1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333')
        ORDER BY team_name $$,
    $$ VALUES ('A-Team'::text), ('A-Team 2'::text) $$,
    'an admin previews a coach''s division read'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$ SELECT * FROM public.admin_get_division_teams(
           'a1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444') $$,
    '42501', NULL,
    'a coach cannot preview another coach'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$ SELECT * FROM public.admin_get_division_teams(
           'a1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333') $$,
    '42501', NULL,
    'another organization''s admin cannot preview Org A''s coach'
);

-- ---------------------------------------------------------------------------
-- A coach writes no score and ends no lighting window.
-- ---------------------------------------------------------------------------

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$ SELECT public.update_game_score('a1111111-1111-1111-1111-111111111111',
           'a1111111-1111-1111-1111-00000000aa02', 1::smallint, 0::smallint) $$,
    '42501', NULL,
    'the home team''s coach cannot score its game, with score entry on'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok(
    $$ SELECT public.update_game_score('a1111111-1111-1111-1111-111111111111',
           'a1111111-1111-1111-1111-00000000aa02', 1::smallint, 0::smallint) $$,
    'an admin scores it'
);

RESET ROLE;
INSERT INTO public.locations (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-0000000010c0', 'a1111111-1111-1111-1111-111111111111', 'Org A Park');
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('a1111111-1111-1111-1111-0000000f1e1d', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000010c0', 'Org A Pitch', true);
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time)
VALUES ('a1111111-1111-1111-1111-00000000510f', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000f1e1d', 'mon', '17:00', '18:00');
INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'a1111111-1111-1111-1111-00000000510f', daterange(current_date - 7, current_date + 60, '[]'), 'auto');
INSERT INTO public.practice_lighting_overrides (id, organization_id, practice_slot_id, "window", status, requested_by)
VALUES ('a1111111-1111-1111-1111-0000000119b7', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-00000000510f', daterange(current_date + 7, current_date + 14, '[]'),
        'requested', '33333333-3333-3333-3333-333333333333');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$ SELECT public.withdraw_practice_lighting_override('a1111111-1111-1111-1111-0000000119b7') $$,
    '42501', NULL,
    'the coach who requested a lighting window before R6 cannot withdraw it'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    public.withdraw_practice_lighting_override('a1111111-1111-1111-1111-0000000119b7') ->> 'status',
    'withdrawn',
    'an admin withdraws it'
);

SELECT * FROM finish();
ROLLBACK;
