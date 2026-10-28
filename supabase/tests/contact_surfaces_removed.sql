-- pgTAP: no contact surfaces (migration 20261025010000; plan
-- docs/changes/2026-10-22-admin-focus.md, R4).
--
--   * the coach directory, the contact card (its writer and its `profiles`
--     columns), `players.contact_info` and `guardian_contacts`, and the coach
--     leads (`upsert_coach_leads`, `set_import_job_coach_lead_summary`,
--     `coach_interested_programs` and its trigger function) are absent; no
--     public function (comments and string literals aside), view or policy
--     names one; `profile.contact_card_updated` keeps its `audit_actions` row;
--   * **no read a coach can call returns an email or phone**: the catalogue of
--     every function `authenticated` may execute, by its result columns and
--     the columns of a table it returns rows of, holds exactly the two
--     admin-only reads, and a signed-in user with no membership is refused both;
--   * the staff read gives the team's current coach names and roles; an admin
--     still reads every member's sign-in email; a patch naming
--     `guardian_contacts` is refused 22023.
-- Run as `authenticated` with a JWT sub where a caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(19);

-- ── 1. What the migration dropped ──────────────────────────────────────────
SELECT ok(to_regprocedure('public.get_coach_directory(uuid)') IS NULL, 'get_coach_directory is gone');
SELECT ok(to_regprocedure('public.set_my_contact_card(text, text, boolean)') IS NULL, 'set_my_contact_card is gone');
SELECT ok(to_regprocedure('public.upsert_coach_leads(jsonb)') IS NULL, 'upsert_coach_leads is gone');
SELECT ok(to_regprocedure('public.set_import_job_coach_lead_summary(uuid, jsonb, text)') IS NULL,
    'set_import_job_coach_lead_summary is gone');
SELECT ok(to_regclass('public.coach_interested_programs') IS NULL
          AND to_regprocedure('public.enforce_coach_interested_programs_org_scope()') IS NULL,
    'coach_interested_programs and its trigger function are gone');
SELECT is(
    (SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname)
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.oid IN ('public.players'::regclass, 'public.profiles'::regclass)
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('contact_info', 'guardian_contacts', 'contact_phone', 'contact_email', 'share_contact')),
    NULL,
    'players has no contact_info or guardian_contacts, profiles no contact card column'
);
SELECT is(
    (SELECT array_agg(o ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
               ~ '\m(guardian_contacts|share_contact|contact_phone|contact_email|set_my_contact_card|get_coach_directory|upsert_coach_leads|set_import_job_coach_lead_summary|coach_interested_programs|enforce_coach_interested_programs_org_scope)\M'
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_get_viewdef(c.oid) ~ '\m(guardian_contacts|share_contact|contact_phone|contact_email|coach_interested_programs)\M'
        UNION ALL
        SELECT 'policy ' || tablename || '.' || policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
               ~ '\m(guardian_contacts|share_contact|contact_phone|contact_email|coach_interested_programs)\M'
    ) s),
    NULL,
    'no public function, view or policy names a dropped contact or lead object'
);
-- Positive control for the scan above: the same stripping keeps a real
-- identifier in a real body, so its silence is not an empty read.
SELECT ok(
    EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = 'public.get_team_staff(uuid)'::regprocedure
               AND regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
                   ~ '\mis_org_admin\M'),
    'control: the scan reads real bodies (get_team_staff calls is_org_admin)'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_actions WHERE action = 'profile.contact_card_updated'),
    1,
    'profile.contact_card_updated keeps its audit_actions row'
);

-- ── 2. No read a coach can call returns an email or phone ──────────────────
-- The catalogue, enumerated from the grants (not from the functions this
-- migration touched): every public function `authenticated` may execute
-- whose result columns, or the columns of the table whose rows it returns,
-- are named like an email, a phone, a contact or a guardian. A function
-- returning `jsonb` or a bare `record` is not seen (declared blind spot).
SELECT is(
    (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
       JOIN pg_type rt ON rt.oid = p.prorettype
      WHERE p.pronamespace = 'public'::regnamespace
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND (EXISTS (SELECT 1 FROM unnest(p.proargnames, p.proargmodes) AS a(n, m)
                      WHERE a.m IN ('o', 'b', 't') AND a.n ~* '(mail|phone|contact|guardian)')
             OR EXISTS (SELECT 1 FROM pg_attribute ra
                         WHERE ra.attrelid = rt.typrelid AND rt.typrelid <> 0
                           AND ra.attnum > 0 AND NOT ra.attisdropped
                           AND ra.attname ~* '(mail|phone|contact|guardian)'))),
    ARRAY['get_organization_members(uuid)', 'get_settings_audit_log(uuid)'],
    'the only functions a signed-in caller may execute that return a contact column are the two admin reads'
);

-- Charlie, signed in with no membership (a coach of Org A before 20261104010000), is refused the
-- admin reads below. R4 Coach is the current lead coach of A-Team (data: no coach signs in).
INSERT INTO public.coaches (id, organization_id, full_name, email, status)
VALUES ('a1111111-0000-4000-8000-0000000004c1', 'a1111111-1111-1111-1111-111111111111',
        'R4 Coach', 'r4-coach@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'a1111111-0000-4000-8000-0000000004c1', 'lead', '2020-01-01', NULL, 'pgtap');
INSERT INTO public.players (id, organization_id, first_name, last_name) VALUES
    ('a1111111-0000-4000-8000-0000000004a1', 'a1111111-1111-1111-1111-111111111111', 'Pia', 'Four');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$SELECT * FROM public.get_organization_members('a1111111-1111-1111-1111-111111111111')$$,
    '42501', NULL, 'a non-member is refused the member list and its emails'
);
SELECT throws_ok(
    $$SELECT * FROM public.get_settings_audit_log('a1111111-1111-1111-1111-111111111111')$$,
    'P0001', 'Access denied. Organization admin role required.',
    'a non-member is refused the settings audit log and its actor emails'
);
SELECT throws_ok(
    $$SELECT * FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001')$$,
    '42501', NULL, 'a non-member is refused the staff read'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
                 WHERE p.oid IN ('public.get_team_staff(uuid)'::regprocedure, 'public.get_team_roster(uuid)'::regprocedure)
                   AND a ~* '(mail|phone|contact|guardian)')
    AND EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
                 WHERE p.oid = 'public.get_team_staff(uuid)'::regprocedure AND a = 'full_name'),
    'get_team_staff and get_team_roster return no contact column'
);

-- ── 3. What admins keep ────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (SELECT m.email FROM public.get_organization_members('a1111111-1111-1111-1111-111111111111') m
      WHERE m.profile_id = '11111111-1111-1111-1111-111111111111'),
    'alice@test.local',
    'an admin reads a member''s sign-in email in the member list'
);
SELECT is(
    (SELECT c.email FROM public.coaches c WHERE c.id = 'a1111111-0000-4000-8000-0000000004c1'),
    'r4-coach@test.local',
    'an admin reads a coach''s email on the coach row (the Coaches page)'
);
SELECT is(
    (SELECT array_agg(s.full_name || ':' || s.role || ':' || s.status)
       FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001') s),
    ARRAY['R4 Coach:lead:active'],
    'an admin reads the staff''s name, role and status'
);
SELECT throws_ok(
    $$SELECT public.admin_update_player('a1111111-0000-4000-8000-0000000004a1',
                                         '{"guardian_contacts": [{"name": "G"}]}')$$,
    '22023', NULL, 'a patch naming guardian_contacts is refused'
);
SELECT lives_ok(
    $$SELECT public.admin_update_player('a1111111-0000-4000-8000-0000000004a1', '{"jersey_number": 4}')$$,
    'an admin still patches a player'
);
RESET role;

SELECT * FROM finish();
ROLLBACK;
