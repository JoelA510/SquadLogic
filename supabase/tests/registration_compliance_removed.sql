-- pgTAP: the in-app registration flow, the Compliance page's data and the
-- payment flag are gone, and the kept functions that touched them still work
-- (migration 20261022020000; plan docs/changes/2026-10-22-admin-focus.md, R1).
--
--   * the seven functions, the view, both tables and the three `players`
--     columns are absent, and the retired actions keep their `audit_actions`
--     rows (old `audit_log` rows reference them);
--   * as Org A's admin: an ordinary player patch applies through
--     `admin_update_player`, `admin_bulk_update_players` and
--     `admin_create_player`, and a patch naming any of the dropped flags is
--     refused 22023 by each, leaving the player as it was;
--   * `finalize_import_job` promotes a staged player carrying a payment status;
--   * the replaced functions keep their grants: authenticated executes the
--     player writer and the finalizer, anon none of the four (that anon
--     executes no SECURITY DEFINER function at all is
--     definer_function_grants.sql's).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(21);

-- ── 1. What the migration dropped ──────────────────────────────────────────
SELECT ok(to_regprocedure('public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)') IS NULL,
    'submit_registration is gone');
SELECT ok(to_regprocedure('public.admin_create_registration_form(uuid, text, text, uuid, jsonb, text, text, jsonb)') IS NULL,
    'admin_create_registration_form is gone');
SELECT ok(to_regprocedure('public.admin_update_registration_form(uuid, jsonb)') IS NULL,
    'admin_update_registration_form is gone');
SELECT ok(to_regprocedure('public.admin_delete_registration_form(uuid)') IS NULL,
    'admin_delete_registration_form is gone');
SELECT ok(to_regprocedure('public.admin_update_registration_medical_status(uuid, uuid, boolean, jsonb)') IS NULL,
    'admin_update_registration_medical_status is gone');
SELECT ok(to_regprocedure('public.get_team_portal_medical_status(uuid)') IS NULL,
    'get_team_portal_medical_status is gone');
SELECT ok(to_regprocedure('public.coach_update_player_compliance(uuid, jsonb)') IS NULL,
    'coach_update_player_compliance is gone');
SELECT ok(to_regclass('public.view_compliance_stats') IS NULL, 'view_compliance_stats is gone');
SELECT ok(to_regclass('public.registration_forms') IS NULL, 'registration_forms is gone');
SELECT ok(to_regclass('public.registrations') IS NULL, 'registrations is gone');
SELECT is(
    ARRAY(SELECT attname::text FROM pg_attribute
           WHERE attrelid = 'public.players'::regclass AND NOT attisdropped
             AND attname IN ('paid', 'waiver_received', 'medical_form_received')),
    ARRAY[]::text[],
    'players has no paid, waiver_received or medical_form_received column'
);
-- Positive control for the check above: it reads real columns of players.
SELECT has_column('public', 'players', 'willing_to_coach', 'players still has willing_to_coach');

SELECT is(
    (SELECT count(*)::int FROM public.audit_actions
      WHERE action IN ('registration.form_created', 'registration.form_updated',
                       'registration.form_deleted', 'registration.submitted',
                       'compliance.medical_update', 'player.compliance_updated')),
    6,
    'the retired actions keep their audit_actions rows'
);

-- ── 2. The kept player writers, as Org A's admin ──────────────────────────
INSERT INTO public.players (id, organization_id, first_name, last_name, status)
VALUES ('a1111111-0000-4000-8000-0000000001a1', 'a1111111-1111-1111-1111-111111111111',
        'PlayerR1', 'Patch', 'pending');
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by)
VALUES ('a1111111-0000-4000-8000-0000000001b1', 'a1111111-1111-1111-1111-111111111111',
        'registration', 'orga/r1-players.csv', 'processing', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.staging_players (
    organization_id, import_job_id, source_row_number, raw_payload, normalized_payload
)
SELECT 'a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000001b1', 1, p, p
FROM (SELECT jsonb_build_object(
    'first_name', 'PlayerR1', 'last_name', 'Import', 'date_of_birth', '2016-05-01',
    'external_registration_id', 'R1-EXT-1', 'gender', 'F', 'age group', '9',
    'payment_status', 'R1-PAID-MARKER', 'payment status', 'R1-PAID-MARKER') AS p) s;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (SELECT status || '/' || willing_to_coach::text
       FROM public.admin_update_player('a1111111-0000-4000-8000-0000000001a1',
                                       '{"status": "waitlist", "willing_to_coach": true}')),
    'waitlist/true',
    'admin_update_player applies an ordinary patch'
);
SELECT throws_ok(
    $$SELECT public.admin_update_player('a1111111-0000-4000-8000-0000000001a1', '{"paid": true}')$$,
    '22023', 'field paid is not editable',
    'admin_update_player refuses paid'
);
SELECT throws_ok(
    $$SELECT public.admin_bulk_update_players(ARRAY['a1111111-0000-4000-8000-0000000001a1']::uuid[],
                                               '{"waiver_received": true}')$$,
    '22023', 'field waiver_received is not editable',
    'admin_bulk_update_players refuses waiver_received'
);
SELECT throws_ok(
    $$SELECT public.admin_create_player('a1111111-1111-1111-1111-111111111111',
                                         '{"first_name": "Other", "medical_form_received": true}')$$,
    '22023', 'field medical_form_received is not editable',
    'admin_create_player refuses medical_form_received'
);
SELECT is(
    (SELECT status || '/' || willing_to_coach::text FROM public.players
      WHERE id = 'a1111111-0000-4000-8000-0000000001a1'),
    'waitlist/true',
    'the refused patches left the player as the ordinary patch did'
);
SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000001b1')->>'inserted_players')::int,
    1,
    'finalize_import_job promotes a staged player carrying a payment status'
);

RESET role;

SELECT is(
    (SELECT strpos(to_jsonb(p)::text, 'R1-PAID-MARKER') FROM public.players p
      WHERE p.external_registration_id = 'R1-EXT-1'),
    0,
    'the imported player stores nothing of the payment status'
);

-- ── 3. Grants ─────────────────────────────────────────────────────────────
SELECT ok(
    has_function_privilege('authenticated', 'public.admin_update_player(uuid,jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.finalize_import_job(uuid,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.admin_update_player(uuid,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.finalize_import_job(uuid,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.apply_player_patch(uuid,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sanitize_player_patch(jsonb)', 'EXECUTE'),
    'the player writers and the finalizer keep their grants: authenticated, not anon'
);

SELECT * FROM finish();
ROLLBACK;
