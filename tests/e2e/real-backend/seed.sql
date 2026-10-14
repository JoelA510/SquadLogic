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
-- Idempotent (ON CONFLICT DO NOTHING throughout), so re-running it against a
-- local stack is harmless.

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

COMMIT;
