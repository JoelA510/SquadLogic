-- pgTAP: people imports keep only allowlisted data, and the purge removes what
-- was kept before (migration 20261022010000; plan
-- docs/changes/2026-10-22-admin-focus.md, R0).
--
-- The staged rows below are written straight into the staging tables, as a
-- caller that bypasses import-validation could, and carry every column the
-- Edge Function would have dropped: a phone, guardian names, emails, phones
-- and addresses, a child's name and birth date, the coach's own birth date
-- and a payment status. Each carries a unique placeholder marker, and the
-- check is a catalogue scan: every text, varchar, json and jsonb column of
-- every table in `public` is searched for every marker, so a value stored in
-- a table nobody thought to look at is still found.
--
-- After finalizing, only the staging tables (the finalizers' input) may hold
-- a marker; after `minimise_import_people_data()`, which deletes a finished
-- job's staged rows, no table may.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(21);

-- Every public column that can hold text, and which of them contain any
-- needle. Tables in p_skip are not searched.
CREATE FUNCTION pg_temp.r0_hits(p_needles text[], p_skip text[] DEFAULT '{}')
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
    r record;
    v_hit boolean;
    v_hits text[] := '{}';
BEGIN
    FOR r IN
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb')
               OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
          AND NOT c.table_name = ANY (p_skip)
    LOOP
        EXECUTE format(
            'SELECT EXISTS (SELECT 1 FROM public.%I x, unnest($1) n WHERE x.%I::text LIKE ''%%'' || n || ''%%'')',
            r.table_name, r.column_name)
          INTO v_hit
          USING p_needles;
        IF v_hit THEN
            v_hits := v_hits || (r.table_name || '.' || r.column_name);
        END IF;
    END LOOP;
    RETURN v_hits;
END;
$$;

-- How many columns the scan reads: a scan that examined nothing is a failure.
CREATE FUNCTION pg_temp.r0_scanned()
RETURNS integer
LANGUAGE sql
AS $$
    SELECT count(*)::integer
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('text', 'character varying', 'json', 'jsonb');
$$;

-- The markers: placeholders, unique to this file.
CREATE TEMP TABLE r0_needles AS
SELECT ARRAY[
    '555-0191', '555-0192', '555-0193',
    'r0-guardian-one@example.test', 'r0-guardian-two@example.test',
    '191 R0 Placeholder Way', 'R0Childfirst', '2017-03-19', '1979-09-19',
    'R0GuardianName', 'R0-PAID-MARKER', 'R0Undeclared'
]::text[] AS needles;

SELECT ok(pg_temp.r0_scanned() > 100, 'the catalogue scan reads over a hundred text and jsonb columns');

-- POSITIVE CONTROL: the scan finds a marker where one is planted.
INSERT INTO public.audit_log (user_id, organization_id, action, resource_type, metadata)
VALUES ('11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
        'settings.updated', 'r0_probe', '{"probe": "R0Undeclared"}'::jsonb);
SELECT ok('audit_log.metadata' = ANY (pg_temp.r0_hits((SELECT needles FROM r0_needles))),
          'POSITIVE CONTROL: the scan finds a planted marker in audit_log.metadata');
DELETE FROM public.audit_log WHERE resource_type = 'r0_probe';

-- Org A declares one field per entity.
INSERT INTO public.organization_schemas (organization_id, entity_type, schema_definition)
VALUES
    ('a1111111-1111-1111-1111-111111111111', 'coach',
     '{"shirt_size": "string", "years_coached": "number", "cert_date": "date"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'player',
     '{"shirt_size": "string", "joined_on": "date"}'::jsonb)
ON CONFLICT (organization_id, entity_type) DO UPDATE SET schema_definition = EXCLUDED.schema_definition;

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by)
VALUES
    ('a1111111-0000-4000-8000-0000000000c1', 'a1111111-1111-1111-1111-111111111111',
     'registration', 'orga/r0-coaches.csv', 'processing', '11111111-1111-1111-1111-111111111111'),
    ('a1111111-0000-4000-8000-0000000000b1', 'a1111111-1111-1111-1111-111111111111',
     'registration', 'orga/r0-players.csv', 'processing', '11111111-1111-1111-1111-111111111111'),
    ('a1111111-0000-4000-8000-0000000000b2', 'a1111111-1111-1111-1111-111111111111',
     'registration', 'orga/r0-players-2.csv', 'processing', '11111111-1111-1111-1111-111111111111');

INSERT INTO public.staging_import_rows (
    organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload
)
SELECT
    'a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000000c1', 'coaches', 1,
    p, p
FROM (SELECT jsonb_build_object(
    'full_name', 'Coach R0', 'email', 'coach-r0@example.test',
    'phone', '555-0191', 'contact_phone', '555-0191',
    'guardian 1 first name', 'R0GuardianName',
    'guardian 1 address', '191 R0 Placeholder Way',
    'guardian 1 mobile phone number', '555-0192',
    'guardian 1 email address', 'r0-guardian-one@example.test',
    'guardian 2 email address', 'r0-guardian-two@example.test',
    'player first name', 'R0Childfirst',
    'what is your player''s birth date?', '2017-03-19',
    'date_of_birth', '1979-09-19',
    'payment status', 'R0-PAID-MARKER',
    'notes', 'R0Undeclared',
    'shirt size', 'YM', 'years coached', '6', 'cert date', '2024-05-06') AS p) s;

INSERT INTO public.staging_players (
    organization_id, import_job_id, source_row_number, raw_payload, normalized_payload
)
SELECT
    'a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000000b1', 1, p, p
FROM (SELECT jsonb_build_object(
    'first_name', 'PlayerR0', 'last_name', 'Allowlist', 'date_of_birth', '2016-05-01',
    'external_registration_id', 'R0-EXT-1', 'gender', 'F', 'age group', '9',
    'email', 'r0-guardian-one@example.test', 'contact_email', 'r0-guardian-two@example.test',
    'phone', '555-0191', 'contact_phone', '555-0193',
    'guardian_name', 'R0GuardianName', 'guardian_email', 'r0-guardian-one@example.test',
    'guardian_phone', '555-0192',
    'guardian_1_first_name', 'R0GuardianName', 'guardian_1_email', 'r0-guardian-one@example.test',
    'guardian_2_email', 'r0-guardian-two@example.test',
    'guardian 1 address', '191 R0 Placeholder Way',
    'payment_status', 'R0-PAID-MARKER', 'payment status', 'R0-PAID-MARKER',
    'team name', 'R0 Team', 'team age', 'U10', 'team gender', 'Girls',
    'play_up', 'yes', 'shirt size', 'YS', 'joined on', '2024-01-02',
    'undeclared column', 'R0Undeclared') AS p) s;

-- The same player again, for the re-import below.
INSERT INTO public.staging_players (
    organization_id, import_job_id, source_row_number, raw_payload, normalized_payload
)
SELECT 'a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000000b2', 1,
       '{}'::jsonb, normalized_payload
FROM public.staging_players WHERE import_job_id = 'a1111111-0000-4000-8000-0000000000b1';

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (public.finalize_coach_import_job('a1111111-0000-4000-8000-0000000000c1')->>'inserted_coaches')::int,
    1,
    'the coach import inserts its coach'
);
SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000000b1')->>'inserted_players')::int,
    1,
    'the player import inserts its player'
);

RESET role;

SELECT is(
    (SELECT jsonb_build_object('custom_attributes', custom_attributes, 'phone', phone,
                               'contact_info', contact_info)
       FROM public.coaches WHERE email = 'coach-r0@example.test'),
    '{"custom_attributes": {"shirt_size": "YM", "years_coached": 6, "cert_date": "2024-05-06"},
      "phone": null,
      "contact_info": {"email": "coach-r0@example.test"}}'::jsonb,
    'the coach keeps its declared fields, typed as declared, its sign-in email, and no phone'
);

SELECT is(
    (SELECT jsonb_build_object('custom_attributes', custom_attributes,
                               'contact_info', contact_info,
                               'guardian_contacts', guardian_contacts)
       FROM public.players WHERE external_registration_id = 'R0-EXT-1'),
    -- No `paid` since 20261022020000 dropped the column; the payment value is
    -- in the catalogue scan's needles below.
    '{"custom_attributes": {"shirt_size": "YS", "joined_on": "2024-01-02", "team_name": "R0 Team",
                            "team_age": "U10", "team_gender": "Girls", "play_up": "yes"},
      "contact_info": {}, "guardian_contacts": []}'::jsonb,
    'the player keeps its declared field, team placement and play-up, and no contact, guardian or payment'
);

SELECT is(
    pg_temp.r0_hits((SELECT needles FROM r0_needles),
                    ARRAY['staging_import_rows', 'staging_players']),
    '{}'::text[],
    'after both imports, no table but the staging input holds a phone, guardian, address, child, birth date, payment or undeclared value'
);

-- A re-import drops an undeclared key the player already held.
UPDATE public.players
   SET custom_attributes = custom_attributes || '{"legacy column": "R0Undeclared"}'::jsonb
 WHERE external_registration_id = 'R0-EXT-1';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT public.finalize_import_job('a1111111-0000-4000-8000-0000000000b2');
RESET role;
SELECT is(
    (SELECT custom_attributes FROM public.players WHERE external_registration_id = 'R0-EXT-1'),
    '{"shirt_size": "YS", "joined_on": "2024-01-02", "team_name": "R0 Team", "team_age": "U10",
      "team_gender": "Girls", "play_up": "yes"}'::jsonb,
    'a re-import drops an undeclared key the player held and keeps the declared and the import''s own'
);

-- A declared date passes the custom-attributes trigger, and a non-date is refused.
SELECT lives_ok(
    $$ UPDATE public.players SET custom_attributes = custom_attributes || '{"joined_on": "2025-02-03"}'::jsonb
        WHERE external_registration_id = 'R0-EXT-1' $$,
    'the trigger accepts a declared date stored as YYYY-MM-DD'
);
SELECT throws_ok(
    $$ UPDATE public.players SET custom_attributes = custom_attributes || '{"joined_on": "soon"}'::jsonb
        WHERE external_registration_id = 'R0-EXT-1' $$,
    'P0001',
    NULL,
    'the trigger refuses a declared date that is not one'
);

-- A coach as production holds them today: a phone, and the export's columns
-- in custom_attributes (Org B declares nothing), and an import snapshot that
-- carries both.
INSERT INTO public.coaches (id, organization_id, full_name, email, phone, status, contact_info,
                            custom_attributes, import_source)
VALUES ('b2222222-0000-4000-8000-0000000000c9', 'b2222222-2222-2222-2222-222222222222',
        'Legacy R0', 'legacy-r0@example.test', '555-0193', 'active',
        '{"email": "legacy-r0@example.test", "phone": "555-0193"}'::jsonb,
        jsonb_build_object('guardian 1 address', '191 R0 Placeholder Way',
                           'what is your player''s birth date?', '2017-03-19',
                           'payment status', 'R0-PAID-MARKER'),
        'coach_csv');
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by)
VALUES ('b2222222-0000-4000-8000-0000000000c9', 'b2222222-2222-2222-2222-222222222222',
        'registration', 'orgb/r0-legacy.csv', 'completed', '22222222-2222-2222-2222-222222222222'),
       ('b2222222-0000-4000-8000-0000000000ca', 'b2222222-2222-2222-2222-222222222222',
        'registration', 'orgb/r0-ready.csv', 'ready_to_apply', '22222222-2222-2222-2222-222222222222');
INSERT INTO public.import_application_records (organization_id, import_job_id, import_type,
    target_table, target_id, operation, previous_payload, applied_payload)
SELECT 'b2222222-2222-2222-2222-222222222222', 'b2222222-0000-4000-8000-0000000000c9', 'coaches',
       'coaches', c.id, 'updated', to_jsonb(c), to_jsonb(c)
FROM public.coaches c WHERE c.id = 'b2222222-0000-4000-8000-0000000000c9';
-- A ready job's coach row with the export's columns, a finished field job's
-- row, a player with contacts, guardians and an undeclared key, and a row
-- error that quoted its value.
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type,
    source_row_number, raw_payload, normalized_payload)
SELECT 'b2222222-2222-2222-2222-222222222222', 'b2222222-0000-4000-8000-0000000000ca', 'coaches', 1,
       p, p
FROM (SELECT jsonb_build_object('full_name', 'Pending R0', 'email', 'pending-r0@example.test',
        'Guardian 1 Address', '191 R0 Placeholder Way',
        'guardian 1 email address', 'r0-guardian-one@example.test') AS p) s;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by,
                                error_summary)
VALUES ('b2222222-0000-4000-8000-0000000000cb', 'b2222222-2222-2222-2222-222222222222',
        'fields', 'orgb/r0-fields.csv', 'completed', '22222222-2222-2222-2222-222222222222', NULL),
       ('b2222222-0000-4000-8000-0000000000cc', 'b2222222-2222-2222-2222-222222222222',
        'registration', 'orgb/r0-failed.csv', 'failed', '22222222-2222-2222-2222-222222222222',
        '{"rowErrors": [{"row": 3, "field": "email",
                         "message": "Invalid email format: r0-guardian-two@example.test"}]}'::jsonb);
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type,
    source_row_number, raw_payload, normalized_payload)
VALUES ('b2222222-2222-2222-2222-222222222222', 'b2222222-0000-4000-8000-0000000000cb', 'fields', 1,
        '{"name": "Field R0"}'::jsonb, '{"name": "Field R0"}'::jsonb);
INSERT INTO public.players (id, organization_id, first_name, last_name, contact_info,
                            guardian_contacts, custom_attributes)
VALUES ('b2222222-0000-4000-8000-0000000000d1', 'b2222222-2222-2222-2222-222222222222',
        'LegacyR0', 'Player', '{"phone": "555-0193"}'::jsonb,
        '[{"name": "R0GuardianName", "email": "r0-guardian-one@example.test"}]'::jsonb,
        '{"play_up": "yes", "guardian 1 address": "191 R0 Placeholder Way"}'::jsonb);

UPDATE public.import_jobs SET status = 'completed'
 WHERE id IN ('a1111111-0000-4000-8000-0000000000c1', 'a1111111-0000-4000-8000-0000000000b1');

SELECT ok(
    (public.minimise_import_people_data()->>'coaches')::int >= 1,
    'the purge reports the coaches it reduced'
);

SELECT is(
    (SELECT count(*)::int
       FROM public.coaches c
       CROSS JOIN LATERAL jsonb_object_keys(COALESCE(c.custom_attributes, '{}'::jsonb)) k
      WHERE NOT EXISTS (
            SELECT 1 FROM public.organization_schemas s
             WHERE s.organization_id = c.organization_id AND s.entity_type = 'coach'
               AND s.schema_definition ? k)),
    0,
    'after the purge, no coach holds a custom_attributes key its organization did not declare'
);

SELECT is(
    (SELECT count(*)::int FROM public.coaches
      WHERE phone IS NOT NULL OR COALESCE(contact_info, '{}'::jsonb) ? 'phone'),
    0,
    'after the purge, no coach holds a phone'
);

SELECT is(
    pg_temp.r0_hits((SELECT needles FROM r0_needles)),
    '{}'::text[],
    'after the purge, no table at all holds a marker: finished jobs'' staged rows and the coach snapshots included'
);

SELECT is(
    (SELECT count(*)::int FROM public.staging_import_rows
      WHERE import_job_id = 'b2222222-0000-4000-8000-0000000000ca'),
    1,
    'the purge keeps the staged rows of a job still ready to apply'
);

SELECT is(
    (SELECT normalized_payload FROM public.staging_import_rows
      WHERE import_job_id = 'b2222222-0000-4000-8000-0000000000ca'),
    '{"full_name": "Pending R0", "email": "pending-r0@example.test"}'::jsonb,
    'the ready job''s staged row is reduced to the allowlist'
);

SELECT is(
    (SELECT count(*)::int FROM public.staging_import_rows
      WHERE import_job_id = 'b2222222-0000-4000-8000-0000000000cb'),
    1,
    'the purge keeps a finished field job''s staged rows (they are not people, and refused rows wait for replay)'
);

SELECT is(
    (SELECT count(*)::int FROM public.players
      WHERE contact_info IS DISTINCT FROM '{}'::jsonb
         OR guardian_contacts IS DISTINCT FROM '[]'::jsonb),
    0,
    'after the purge, no player holds contact details or guardian contacts'
);

SELECT is(
    (SELECT custom_attributes FROM public.players WHERE id = 'b2222222-0000-4000-8000-0000000000d1'),
    '{"play_up": "yes"}'::jsonb,
    'after the purge, a player keeps only its declared fields and the import''s own keys'
);

SELECT is(
    (SELECT count(*)::int FROM cron.job
      WHERE jobname IN ('cleanup-staging-import-rows', 'cleanup-staging-players')
        AND command LIKE '%j.status IN (''completed'', ''completed_with_warnings'', ''failed'')%'
        AND command LIKE '%30 days%'),
    2,
    'both staging retention jobs delete only a finished job''s rows'
);

-- The purge is not callable by a client role.
SET LOCAL role = 'authenticated';
SELECT throws_ok(
    $$ SELECT public.minimise_import_people_data() $$,
    '42501',
    NULL,
    'an authenticated caller cannot run the purge'
);
RESET role;

SELECT * FROM finish();
ROLLBACK;
