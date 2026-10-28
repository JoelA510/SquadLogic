-- Shared pgTAP fixtures.
--
-- Included by `\ir _fixtures.sql` from every RLS test after setting
-- `squadlogic_fixture_include`. Seeds
-- two organizations, three users, one team per org, one audit-log row per
-- org, and one telemetry/import pair per org so cross-org isolation tests
-- have something to measure.
--
-- IMPORTANT: every test wraps its body in BEGIN ... ROLLBACK, so the rows
-- seeded here never escape the test transaction — no cleanup required.
--
-- Run under the default test role (superuser/postgres) BEFORE any
-- `SET LOCAL role = '…'` call, so that RLS is bypassed for the seed.
--
-- Canonical identities:
--
--   Alice    11111111-1111-1111-1111-111111111111   admin of Org A
--   Bob      22222222-2222-2222-2222-222222222222   admin of Org B
--   Charlie  33333333-3333-3333-3333-333333333333   signed in, a member of no organization
--                                                    (a coach of Org A until 20261104010000 removed that role)
--
--   Org A    a1111111-1111-1111-1111-111111111111
--   Org B    b2222222-2222-2222-2222-222222222222
--
--   A-Team   aaaaaaaa-0000-0000-0000-000000000001   (Org A)
--   B-Team   bbbbbbbb-0000-0000-0000-000000000002   (Org B)

\if :{?squadlogic_fixture_include}
\else
BEGIN;
SELECT plan(1);
SELECT pass('fixture helper is available; include it with \ir _fixtures.sql from tests');
SELECT * FROM finish();
ROLLBACK;
\quit
\endif

-- ──────────────────────────────────────────────────────────────
-- 1. auth.users — seed three fixture users.
--    The auth.users → profiles trigger (handle_new_user) fires on INSERT
--    and creates matching profile rows automatically.
-- ──────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice@test.local',
     jsonb_build_object('full_name', 'Alice Admin-A', 'password_length', 12),   'authenticated', 'authenticated'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.local',
     jsonb_build_object('full_name', 'Bob Admin-B', 'password_length', 12),     'authenticated', 'authenticated'),
    ('33333333-3333-3333-3333-333333333333', 'charlie@test.local',
     jsonb_build_object('full_name', 'Charlie Coach-A', 'password_length', 12), 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

-- Safety net: if the handle_new_user trigger is disabled for any reason,
-- make sure profiles rows exist. Idempotent — the trigger-created row wins.
INSERT INTO public.profiles (id, email, full_name)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice@test.local',   'Alice Admin-A'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.local',     'Bob Admin-B'),
    ('33333333-3333-3333-3333-333333333333', 'charlie@test.local', 'Charlie Coach-A')
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 2. Organizations
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.organizations (id, name, slug)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'Org A', 'org-a-pgtap'),
    ('b2222222-2222-2222-2222-222222222222', 'Org B', 'org-b-pgtap')
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 3. Organization members
--    Alice   -> admin @ Org A
--    Bob     -> admin @ Org B
--    Charlie -> no membership (no coach role exists since 20261104010000: only league
--               admins sign in, so the fixtures' "not an admin" persona is a stranger)
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES
    ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'admin'),
    ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'admin')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 4. Season settings + divisions (teams require a division_id FK)
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.season_settings (id, organization_id, name, status, season_year)
VALUES
    ('a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111111',
     'Org A Spring 2026', 'active', 2026),
    ('b2222222-2222-2222-2222-222222222bbb', 'b2222222-2222-2222-2222-222222222222',
     'Org B Spring 2026', 'active', 2026)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
VALUES
    ('a1111111-1111-1111-1111-11111111abcd', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111aaa', 'Org A U10'),
    ('b2222222-2222-2222-2222-22222222bcde', 'b2222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222bbb', 'Org B U10')
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 5. Teams — one per org.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001',
     'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd',
     'A-Team'),
    ('bbbbbbbb-0000-0000-0000-000000000002',
     'b2222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-22222222bcde',
     'B-Team')
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 6. Audit log — one row per org, authored by each org's admin.
--    Used by rls_admin_vs_coach.sql to assert SELECT visibility.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.audit_log (id, user_id, organization_id, action, resource_type, resource_id)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
     '11111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'team.saved', 'team', 'aaaaaaaa-0000-0000-0000-000000000001'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-000000000002',
     '22222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     'team.saved', 'team', 'bbbbbbbb-0000-0000-0000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 7. Imports + import_jobs + telemetry_log (test e wires these)
--    Each org gets a single import + job + telemetry row so that the
--    `import_efficiency_metrics` view yields exactly one row per org.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.imports (id, organization_id, user_id, file_name, import_type, data)
VALUES
    ('11111111-aaaa-1111-aaaa-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     '11111111-1111-1111-1111-111111111111',
     'orga_players.csv', 'players', '[]'::jsonb),
    ('22222222-bbbb-2222-bbbb-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     '22222222-2222-2222-2222-222222222222',
     'orgb_players.csv', 'players', '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.import_jobs (
    id, organization_id, job_type, storage_path, status, created_by
)
VALUES
    ('aaaabbbb-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'registration', 'orga/players.csv', 'completed',
     '11111111-1111-1111-1111-111111111111'),
    ('aaaabbbb-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     'registration', 'orgb/players.csv', 'completed',
     '22222222-2222-2222-2222-222222222222')
ON CONFLICT (id) DO NOTHING;

-- Seed deterministic suggestion_received/suggestion_applied ratios per org.
INSERT INTO public.telemetry_log (id, org_id, session_id, event_type, payload, created_by)
VALUES
    ('cafefade-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111111',
     'session-a', 'import.suggestion_received',
     jsonb_build_object('import_job_id', 'aaaabbbb-1111-1111-1111-111111111111'),
     '11111111-1111-1111-1111-111111111111'),
    ('cafefade-1111-1111-1111-111111111112',
     'a1111111-1111-1111-1111-111111111111',
     'session-a', 'import.suggestion_received',
     jsonb_build_object('import_job_id', 'aaaabbbb-1111-1111-1111-111111111111'),
     '11111111-1111-1111-1111-111111111111'),
    ('cafefade-1111-1111-1111-111111111113',
     'a1111111-1111-1111-1111-111111111111',
     'session-a', 'import.suggestion_applied',
     jsonb_build_object('import_job_id', 'aaaabbbb-1111-1111-1111-111111111111'),
     '11111111-1111-1111-1111-111111111111'),
    ('cafefade-2222-2222-2222-222222222221',
     'b2222222-2222-2222-2222-222222222222',
     'session-b', 'import.suggestion_received',
     jsonb_build_object('import_job_id', 'aaaabbbb-2222-2222-2222-222222222222'),
     '22222222-2222-2222-2222-222222222222'),
    ('cafefade-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222222',
     'session-b', 'import.suggestion_applied',
     jsonb_build_object('import_job_id', 'aaaabbbb-2222-2222-2222-222222222222'),
     '22222222-2222-2222-2222-222222222222')
ON CONFLICT (id) DO NOTHING;
