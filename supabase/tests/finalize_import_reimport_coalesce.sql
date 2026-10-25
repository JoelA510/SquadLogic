-- Behavioral verification for 20260726000300_finalize_import_reimport_coalesce.sql
--
-- Simulates the exact scenario the audit finding described: a first import
-- carries guardian contacts and a positive coaching-interest answer; a
-- second, narrower re-import for the same player (same
-- external_registration_id) carries neither column at all. Before the fix,
-- the second finalize call would silently reset guardian_contacts to []
-- and willing_to_coach to false. After the fix, both are preserved.
--
-- Since 20261022010000 (the import allowlist) an import stores no guardian
-- contact at all, and since 20261025010000 (R4) there is no guardian_contacts
-- column: the first import stores the guardian columns nowhere on the player,
-- and the re-import must leave a field an admin entered by hand (the
-- preferred name, which the same fix coalesces) untouched.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(4);

-- ── First import: full payload, including guardian + coaching-interest. ──
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by)
VALUES (
    'd0d0d0d0-1111-1111-1111-000000000001',
    'a1111111-1111-1111-1111-111111111111',
    'registration', 'orga/reimport-test-1.csv', 'processing',
    '11111111-1111-1111-1111-111111111111'
);

INSERT INTO public.staging_players (
    id, organization_id, import_job_id, source_row_number, raw_payload, normalized_payload
)
VALUES (
    'e0e0e0e0-1111-1111-1111-000000000001',
    'a1111111-1111-1111-1111-111111111111',
    'd0d0d0d0-1111-1111-1111-000000000001',
    1,
    '{}'::jsonb,
    jsonb_build_object(
        'first_name', 'Dana',
        'last_name', 'Reimport-Test',
        'date_of_birth', '2015-05-01',
        'external_registration_id', 'REIMPORT-EXT-100',
        'guardian_1_first_name', 'Pat',
        'guardian_1_last_name', 'Guardian',
        'guardian_1_email', 'pat.guardian@test.local',
        'willing_to_coach', 'yes'
    )
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT public.finalize_import_job('d0d0d0d0-1111-1111-1111-000000000001');
RESET role;

SELECT is(
    (
        SELECT strpos(to_jsonb(p)::text, 'pat.guardian@test.local') + strpos(to_jsonb(p)::text, 'Guardian')
        FROM public.players p
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND external_registration_id = 'REIMPORT-EXT-100'
    ),
    0,
    'first import: the CSV''s guardian columns are stored nowhere on the player'
);

SELECT is(
    (
        SELECT willing_to_coach
        FROM public.players
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND external_registration_id = 'REIMPORT-EXT-100'
    ),
    true,
    'first import: willing_to_coach is set true from the CSV'
);

-- An admin records a preferred name by hand between the two imports.
UPDATE public.players
SET preferred_name = 'Dee'
WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
  AND external_registration_id = 'REIMPORT-EXT-100';

-- ── Second import: same player, narrower payload (no guardian or ──
-- coaching-interest columns at all -- simulates a corrected export from a
-- report template that omits those columns). ──
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by)
VALUES (
    'd0d0d0d0-1111-1111-1111-000000000002',
    'a1111111-1111-1111-1111-111111111111',
    'registration', 'orga/reimport-test-2.csv', 'processing',
    '11111111-1111-1111-1111-111111111111'
);

INSERT INTO public.staging_players (
    id, organization_id, import_job_id, source_row_number, raw_payload, normalized_payload
)
VALUES (
    'e0e0e0e0-1111-1111-1111-000000000002',
    'a1111111-1111-1111-1111-111111111111',
    'd0d0d0d0-1111-1111-1111-000000000002',
    1,
    '{}'::jsonb,
    jsonb_build_object(
        'first_name', 'Dana',
        'last_name', 'Reimport-Test',
        'date_of_birth', '2015-05-01',
        'external_registration_id', 'REIMPORT-EXT-100'
    )
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT public.finalize_import_job('d0d0d0d0-1111-1111-1111-000000000002');
RESET role;

SELECT is(
    (
        SELECT preferred_name
        FROM public.players
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND external_registration_id = 'REIMPORT-EXT-100'
    ),
    'Dee',
    'narrower re-import: the admin-entered preferred name is PRESERVED, not wiped'
);

SELECT is(
    (
        SELECT willing_to_coach
        FROM public.players
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND external_registration_id = 'REIMPORT-EXT-100'
    ),
    true,
    'narrower re-import: willing_to_coach is PRESERVED as true, not reset to false'
);

SELECT * FROM finish();
ROLLBACK;
