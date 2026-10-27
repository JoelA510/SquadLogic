-- pgTAP: the restricted reads the persona matrix does not cover (migration
-- 20261021020000; plan docs/changes/2026-10-20-phase-a-privacy.md, A3):
-- coaches, team_coach_assignments, team_calendar_tokens, staging_import_rows
-- and rotate_calendar_token, each in both directions. Run as `authenticated`
-- with a JWT sub.
--
-- Callers: Alice (admin, Org A), Bob (admin, Org B only), and Charlie, Dee and Gail, signed in with
-- no membership. Charlie and Dee were coaches of Org A (Charlie the current lead of A-Team) and Gail
-- a coach-role member with no coach row, until 20261104010000 removed the coach role and the
-- sign-in link on coach records: since then these reads are an admin's, and a coach record is data.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(12);

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
    ('f1000000-0000-4000-8000-000000000001', 'dee@test.local',  '{"password_length": 12}', now()),
    ('f1000000-0000-4000-8000-000000000002', 'gail@test.local', '{"password_length": 12}', now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name) VALUES
    ('f1000000-0000-4000-8000-000000000001', 'dee@test.local', 'Dee'),
    ('f1000000-0000-4000-8000-000000000002', 'gail@test.local', 'Gail')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.coaches (id, organization_id, full_name, email, status) VALUES
    ('f2000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
     'Charlie', 'charlie@test.local', 'active'),
    ('f2000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111',
     'Dee', 'dee@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'f2000000-0000-4000-8000-000000000001', 'lead',
        public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 5, NULL, 'pgtap', NULL);
INSERT INTO public.players (id, organization_id, first_name, last_name) VALUES
    ('f3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Gus', 'Kid');
INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111');

SET LOCAL role = 'authenticated';

-- ── coaches, team_coach_assignments ───────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM public.coaches) + (SELECT count(*)::int FROM public.team_coach_assignments), 0,
          'Charlie, whose name a coach record carries, reads no coach row and no assignment');
SET LOCAL "request.jwt.claims" TO '{"sub":"f1000000-0000-4000-8000-000000000002"}';
SELECT is((SELECT count(*)::int FROM public.coaches) + (SELECT count(*)::int FROM public.team_coach_assignments), 0,
          'a signed-in user with no coach record and no membership reads none either');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT count(*)::int FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'), 2,
          'an admin reads every coach row');
SELECT is((SELECT count(*)::int FROM public.team_coach_assignments), 1, 'and every assignment');

-- ── team_calendar_tokens ──────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM public.team_calendar_tokens), 0, 'Charlie, once the current lead of A-Team, reads no token');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT array_agg(team_id) FROM public.team_calendar_tokens),
          ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid], 'an admin reads their own organization''s tokens');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is((SELECT array_agg(team_id) FROM public.team_calendar_tokens),
          ARRAY['bbbbbbbb-0000-0000-0000-000000000002'::uuid], 'and only their own organization''s');

-- ── rotate_calendar_token ─────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(public.rotate_calendar_token('aaaaaaaa-0000-0000-0000-000000000001')->>'status', 'error',
          'Charlie cannot rotate the team''s token');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(public.rotate_calendar_token('aaaaaaaa-0000-0000-0000-000000000001')->>'status', 'error',
          'another organization''s admin cannot rotate it');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(public.rotate_calendar_token('aaaaaaaa-0000-0000-0000-000000000001')->>'status', 'success',
          'the organization''s admin rotates it');

-- ── staging_import_rows ───────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM public.staging_import_rows), 0, 'a non-member reads no staged import row');

RESET ROLE;
SELECT ok(NOT has_table_privilege('authenticated', 'public.team_calendar_tokens', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.team_calendar_tokens', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.team_calendar_tokens', 'SELECT'),
          'no client writes a calendar token, and anon reads none');

SELECT * FROM finish();
ROLLBACK;
