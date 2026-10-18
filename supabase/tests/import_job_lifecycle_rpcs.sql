-- pgTAP: import job lifecycle writes are admin-only RPCs and direct writes are blocked.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(18);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

CREATE TEMP TABLE created_import_job AS
SELECT public.create_import_job(
    'a1111111-1111-1111-1111-111111111111',
    'players',
    '../spring:players.csv'
) AS job;

SELECT is(
    ((SELECT job FROM created_import_job)).job_type,
    'registration',
    'player import creates a registration import job'
);

SELECT is(
    ((SELECT job FROM created_import_job)).status,
    'importing',
    'created import job starts importing'
);

SELECT is(
    ((SELECT job FROM created_import_job)).created_by::text,
    '11111111-1111-1111-1111-111111111111',
    'created import job records the authenticated user'
);

SELECT isnt(
    ((SELECT job FROM created_import_job)).last_heartbeat_at,
    NULL,
    'created import job records an initial heartbeat'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.audit_log
        WHERE resource_id = ((SELECT job FROM created_import_job)).id
          AND action = 'import.started'
    )::int,
    1,
    'create_import_job writes import.started audit metadata'
);

-- The audit log keeps no upload file names (owner decision 2026-10-14;
-- 20261018050000). The metadata is compared whole, so a row that lost its
-- other keys fails here too, not only one that kept `file_name`.
SELECT is(
    (
        SELECT metadata
        FROM public.audit_log
        WHERE resource_id = ((SELECT job FROM created_import_job)).id
          AND action = 'import.started'
    ),
    '{"import_type": "players", "job_type": "registration", "status": "importing"}'::jsonb,
    'create_import_job''s import.started metadata is import_type, job_type and status, with no file_name'
);

CREATE TEMP TABLE updated_import_job AS
SELECT public.update_import_job_progress(
    ((SELECT job FROM created_import_job)).id,
    40,
    4,
    10,
    '{"efficiency":99.2,"needs_confirmation":[]}'::jsonb
) AS job;

SELECT is(
    ((SELECT job FROM updated_import_job)).processed_rows,
    4,
    'progress RPC stores processed row count'
);

SELECT is(
    ((SELECT job FROM updated_import_job)).progress_percent,
    40,
    'progress RPC stores progress percentage'
);

SELECT is(
    ((SELECT job FROM updated_import_job)).efficiency_metadata->>'efficiency',
    '99.2',
    'progress RPC stores efficiency metadata'
);

SELECT throws_ok(
    $$
        INSERT INTO public.import_jobs (
            organization_id,
            job_type,
            storage_path,
            status,
            created_by
        )
        VALUES (
            'a1111111-1111-1111-1111-111111111111',
            'registration',
            'orga/direct.csv',
            'importing',
            '11111111-1111-1111-1111-111111111111'
        )
    $$,
    '42501',
    NULL,
    'direct authenticated import_jobs inserts are blocked'
);

SELECT throws_ok(
    $$
        SELECT public.update_import_job_progress(
            ((SELECT job FROM created_import_job)).id,
            101,
            NULL,
            NULL,
            NULL
        )
    $$,
    '22023',
    NULL,
    'progress RPC rejects invalid percentages'
);

SELECT throws_ok(
    $$
        SELECT public.create_import_job(
            'a1111111-1111-1111-1111-111111111111',
            'teams',
            'teams.csv'
        )
    $$,
    '22023',
    NULL,
    'create_import_job rejects invalid import types'
);

CREATE TEMP TABLE failed_import_job AS
SELECT public.fail_import_job(
    ((SELECT job FROM created_import_job)).id,
    'Validation failed',
    '{"stage":"validation","rowErrors":[]}'::jsonb
) AS job;

SELECT is(
    ((SELECT job FROM failed_import_job)).status,
    'failed',
    'fail_import_job marks the job failed'
);

SELECT is(
    ((SELECT job FROM failed_import_job)).error_summary->>'message',
    'Validation failed',
    'fail_import_job stores the failure message'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.audit_log
        WHERE resource_id = ((SELECT job FROM created_import_job)).id
          AND action = 'import.failed'
          AND metadata->>'stage' = 'validation'
          AND metadata->>'previous_status' = 'importing'
    )::int,
    1,
    'fail_import_job writes import.failed audit metadata'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$
        SELECT public.create_import_job(
            'a1111111-1111-1111-1111-111111111111',
            'players',
            'coach-denied.csv'
        )
    $$,
    '42501',
    NULL,
    'non-admin org member cannot create import jobs'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.update_import_job_progress(
            ((SELECT job FROM created_import_job)).id,
            50,
            5,
            10,
            NULL
        )
    $$,
    '42501',
    NULL,
    'other-org admin cannot update Org A import job progress'
);

SELECT throws_ok(
    $$
        SELECT public.create_import_job(
            'a1111111-1111-1111-1111-111111111111',
            'players',
            'other-org-denied.csv'
        )
    $$,
    '42501',
    NULL,
    'other-org admin cannot create Org A import jobs'
);

SELECT * FROM finish();
ROLLBACK;
