-- Seed for the real-backend E2E project (plan item M4.1).
--
-- Run once against a fresh `supabase start` stack, after the migrations, by
-- .github/workflows/e2e-real-backend.yml (`psql "$DB_URL" -f` this file). It is
-- not supabase/seed.sql: that file fails on its first statement against the
-- migrated schema (its own header records why), and `[db.seed]` is off in
-- supabase/config.toml, so the pgTAP job's stack starts empty either way.
--
-- Everything here is pseudonymous: example.test addresses (a reserved TLD),
-- invented names, and a password that only ever exists on a throwaway local
-- stack. The scenarios import their players through the UI; this file only
-- creates what a club has before its first import: an administrator who can
-- sign in, the organization (onboarded, so the app does not divert to the
-- setup wizard), the active season and one division.
--
-- Idempotent (ON CONFLICT DO NOTHING throughout), so applying it twice is
-- harmless. The scenarios are not: they import players and expect a first
-- import to insert them, so a second run needs a fresh database
-- (`supabase db reset`, then this file again).

BEGIN;

-- The administrator, as a confirmed email/password user GoTrue can sign in.
-- GoTrue scans the token columns into Go strings, so they are '' rather than
-- NULL (a NULL there fails the sign-in with "converting NULL to string").
-- `password_length` is what check_password_length_on_auth_users()
-- (20240405180000) reads to refuse a password under 12 characters; the
-- password below is 23.
INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'e2e0a000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'e2e-admin@example.test',
    extensions.crypt('e2e-local-only-password', extensions.gen_salt('bf')),
    timezone('utc', now()),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"full_name": "Robin Example (E2E admin)", "password_length": 23}'::jsonb,
    timezone('utc', now()), timezone('utc', now()),
    '', '', '', '', '', '', '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
VALUES (
    'e2e0a000-0000-4000-8000-000000000001',
    'e2e0a000-0000-4000-8000-000000000001',
    jsonb_build_object(
        'sub', 'e2e0a000-0000-4000-8000-000000000001',
        'email', 'e2e-admin@example.test',
        'email_verified', true
    ),
    'email',
    timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
)
ON CONFLICT (provider_id, provider) DO NOTHING;

-- handle_new_user() creates the profile from the auth.users row; this is the
-- same safety net supabase/tests/_fixtures.sql keeps, should the trigger ever
-- be disabled.
INSERT INTO public.profiles (id, email, full_name)
VALUES ('e2e0a000-0000-4000-8000-000000000001', 'e2e-admin@example.test', 'Robin Example (E2E admin)')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug, is_onboarded, feature_flags)
VALUES (
    'e2e0b000-0000-4000-8000-000000000001',
    'Example Valley Soccer (E2E)',
    'e2e-example-valley',
    true,
    '{"gender_model": "coed"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('e2e0b000-0000-4000-8000-000000000001', 'e2e0a000-0000-4000-8000-000000000001', 'admin')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

INSERT INTO public.season_settings (
    id, organization_id, name, status, season_label, season_year, season_start, season_end, timezone
)
VALUES (
    'e2e0c000-0000-4000-8000-000000000001',
    'e2e0b000-0000-4000-8000-000000000001',
    'E2E season', 'active', 'Fall',
    extract(year FROM current_date)::integer,
    current_date - 14, current_date + 84,
    'America/Los_Angeles'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.divisions (
    id, organization_id, season_settings_id, name, gender_policy, max_roster_size
)
VALUES (
    'e2e0d000-0000-4000-8000-000000000001',
    'e2e0b000-0000-4000-8000-000000000001',
    'e2e0c000-0000-4000-8000-000000000001',
    'U10', 'coed', 12
)
ON CONFLICT (id) DO NOTHING;

-- One lit venue with two fields, and a weekday evening practice slot on each
-- for Monday to Thursday. The season and the slots are dated from the day the
-- seed runs, so the scenarios never age out: the practice page refuses to
-- stage a placement in a slot whose dates have ended.
INSERT INTO public.locations (id, organization_id, name, address, lighting_available)
VALUES (
    'e2e0e000-0000-4000-8000-000000000001',
    'e2e0b000-0000-4000-8000-000000000001',
    'Example Park (E2E)', '1 Example Way', true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (id, organization_id, location_id, name, surface_type, size)
VALUES
    ('e2e0f000-0000-4000-8000-000000000001', 'e2e0b000-0000-4000-8000-000000000001',
     'e2e0e000-0000-4000-8000-000000000001', 'Field 1', 'grass', 'small'),
    ('e2e0f000-0000-4000-8000-000000000002', 'e2e0b000-0000-4000-8000-000000000001',
     'e2e0e000-0000-4000-8000-000000000001', 'Field 2', 'grass', 'small')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.practice_slots (
    organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until
)
SELECT
    'e2e0b000-0000-4000-8000-000000000001',
    f.field_id::uuid,
    d.day::day_of_week,
    TIME '17:30', TIME '19:00', 1,
    current_date - 14, current_date + 84
FROM (VALUES ('e2e0f000-0000-4000-8000-000000000001'), ('e2e0f000-0000-4000-8000-000000000002')) AS f (field_id)
CROSS JOIN (VALUES ('mon'), ('tue'), ('wed'), ('thu')) AS d (day)
WHERE NOT EXISTS (
    SELECT 1 FROM public.practice_slots s
    WHERE s.organization_id = 'e2e0b000-0000-4000-8000-000000000001'
);

-- ── The permit league (Phase C3, tests/e2e/real-backend/features/real_backend_permits.feature) ──
-- A second organization, so nothing above changes: the scenarios that import and schedule work in
-- the first. Three people who only belong here, all on the same throwaway password:
--   e2e-permits-admin   an administrator, who records a permit and uploads its file
--   e2e-permits-staff   a staff member, an admin too (20261020030000), who reads the permit
--   e2e-permits-member  an account with NO membership (what a coach's account is now: only league
--                       admins sign in, docs/changes/2026-10-27-admin-only.md), who may not read one
-- The Falcons' lead coach is a coach row, data an admin manages; nobody signs in as them. Permit
-- Pitch is where the Falcons play; Unused Pitch is where nobody does.
INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
SELECT
    '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email,
    extensions.crypt('e2e-local-only-password', extensions.gen_salt('bf')),
    timezone('utc', now()),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('full_name', u.full_name, 'password_length', 23),
    timezone('utc', now()), timezone('utc', now()),
    '', '', '', '', '', '', '', ''
FROM (VALUES
    ('e2e0a000-0000-4000-8000-000000000002', 'e2e-permits-admin@example.test',  'Pat Admin (E2E permit league)'),
    ('e2e0a000-0000-4000-8000-000000000003', 'e2e-permits-staff@example.test',  'Sam Staff (E2E permit league)'),
    ('e2e0a000-0000-4000-8000-000000000004', 'e2e-permits-member@example.test', 'Morgan Member (E2E permit league)')
) AS u (id, email, full_name)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
SELECT
    u.id, u.id::uuid,
    jsonb_build_object('sub', u.id, 'email', u.email, 'email_verified', true),
    'email', timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
FROM (VALUES
    ('e2e0a000-0000-4000-8000-000000000002', 'e2e-permits-admin@example.test'),
    ('e2e0a000-0000-4000-8000-000000000003', 'e2e-permits-staff@example.test'),
    ('e2e0a000-0000-4000-8000-000000000004', 'e2e-permits-member@example.test')
) AS u (id, email)
ON CONFLICT (provider_id, provider) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name) VALUES
    ('e2e0a000-0000-4000-8000-000000000002', 'e2e-permits-admin@example.test',  'Pat Admin (E2E permit league)'),
    ('e2e0a000-0000-4000-8000-000000000003', 'e2e-permits-staff@example.test',  'Sam Staff (E2E permit league)'),
    ('e2e0a000-0000-4000-8000-000000000004', 'e2e-permits-member@example.test', 'Morgan Member (E2E permit league)')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug, is_onboarded, feature_flags)
VALUES (
    'e2e0b000-0000-4000-8000-000000000002',
    'Example Permit League (E2E)',
    'e2e-example-permit-league',
    true,
    '{"gender_model": "coed"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('e2e0b000-0000-4000-8000-000000000002', 'e2e0a000-0000-4000-8000-000000000002', 'admin'),
    ('e2e0b000-0000-4000-8000-000000000002', 'e2e0a000-0000-4000-8000-000000000003', 'staff')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

INSERT INTO public.season_settings (
    id, organization_id, name, status, season_label, season_year, season_start, season_end, timezone
)
VALUES (
    'e2e0c000-0000-4000-8000-000000000002',
    'e2e0b000-0000-4000-8000-000000000002',
    'E2E permit season', 'active', 'Fall',
    extract(year FROM current_date)::integer,
    current_date - 14, current_date + 84,
    'America/Los_Angeles'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.divisions (
    id, organization_id, season_settings_id, name, gender_policy, max_roster_size
)
VALUES (
    'e2e0d000-0000-4000-8000-000000000002',
    'e2e0b000-0000-4000-8000-000000000002',
    'e2e0c000-0000-4000-8000-000000000002',
    'U12', 'coed', 12
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('e2e0d100-0000-4000-8000-000000000001', 'e2e0b000-0000-4000-8000-000000000002', 'e2e0d000-0000-4000-8000-000000000002', 'Falcons'),
    ('e2e0d100-0000-4000-8000-000000000002', 'e2e0b000-0000-4000-8000-000000000002', 'e2e0d000-0000-4000-8000-000000000002', 'Herons')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.coaches (id, organization_id, full_name, email, status) VALUES
    ('e2e0d200-0000-4000-8000-000000000001', 'e2e0b000-0000-4000-8000-000000000002',
     'Casey Coach', 'e2e-permits-coach@example.test', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.team_coach_assignments
    (id, organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES
    ('e2e0d500-0000-4000-8000-000000000001', 'e2e0b000-0000-4000-8000-000000000002',
     'e2e0d100-0000-4000-8000-000000000001', 'e2e0d200-0000-4000-8000-000000000001',
     'lead', current_date - 30, NULL, 'e2e-seed', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.locations (id, organization_id, name, address, lighting_available)
VALUES (
    'e2e0e000-0000-4000-8000-000000000002',
    'e2e0b000-0000-4000-8000-000000000002',
    'Example Permit Park (E2E)', '2 Example Way', false
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (id, organization_id, location_id, name, surface_type, size)
VALUES
    ('e2e0f000-0000-4000-8000-000000000003', 'e2e0b000-0000-4000-8000-000000000002',
     'e2e0e000-0000-4000-8000-000000000002', 'Permit Pitch', 'grass', 'small'),
    ('e2e0f000-0000-4000-8000-000000000004', 'e2e0b000-0000-4000-8000-000000000002',
     'e2e0e000-0000-4000-8000-000000000002', 'Unused Pitch', 'grass', 'small')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.game_slots (id, organization_id, field_id, slot_date, week_index)
VALUES (
    'e2e0d300-0000-4000-8000-000000000001', 'e2e0b000-0000-4000-8000-000000000002',
    'e2e0f000-0000-4000-8000-000000000003', current_date + 7, 1
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.games (id, organization_id, game_slot_id, home_team_id, away_team_id)
VALUES (
    'e2e0d400-0000-4000-8000-000000000001', 'e2e0b000-0000-4000-8000-000000000002',
    'e2e0d300-0000-4000-8000-000000000001',
    'e2e0d100-0000-4000-8000-000000000001', 'e2e0d100-0000-4000-8000-000000000002'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
