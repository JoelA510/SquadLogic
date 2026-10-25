-- pgTAP: deployed import lifecycle RPC signatures and status prerequisites exist.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(9);

-- The coach-lead RPCs (upsert_coach_leads, set_import_job_coach_lead_summary)
-- were dropped by 20261025010000 (R4); contact_surfaces_removed.sql checks
-- they stay gone.

SELECT ok(
    to_regprocedure('public.fail_stale_import_jobs(uuid,timestamptz)') IS NOT NULL,
    'fail_stale_import_jobs(uuid, timestamptz) exists'
);

SELECT ok(
    to_regprocedure('public.create_import_job(uuid,text,text)') IS NOT NULL,
    'create_import_job(uuid, text, text) exists'
);

SELECT ok(
    to_regprocedure('public.update_import_job_progress(uuid,integer,integer,integer,jsonb)') IS NOT NULL,
    'update_import_job_progress(uuid, integer, integer, integer, jsonb) exists'
);

SELECT ok(
    to_regprocedure('public.mark_import_job_ready_to_apply(uuid,text,jsonb)') IS NOT NULL,
    'mark_import_job_ready_to_apply(uuid, text, jsonb) exists'
);

SELECT ok(
    to_regprocedure('public.cancel_ready_import_job(uuid,text)') IS NOT NULL,
    'cancel_ready_import_job(uuid, text) exists'
);

SELECT ok(
    to_regprocedure('public.fail_import_job(uuid,text,jsonb)') IS NOT NULL,
    'fail_import_job(uuid, text, jsonb) exists'
);

SELECT ok(
    to_regprocedure('public.finalize_import_job(uuid,jsonb)') IS NOT NULL,
    'finalize_import_job(uuid, jsonb) exists'
);

SELECT ok(
    to_regprocedure('public.materialize_import_buddy_pairs(uuid)') IS NOT NULL,
    'materialize_import_buddy_pairs(uuid) exists'
);

WITH status_constraint AS (
    SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'import_jobs'
      AND c.conname = 'import_jobs_status_check'
),
required_statuses(status) AS (
    VALUES ('importing'), ('ready_to_apply'), ('failed')
)
SELECT ok(
    COALESCE(
        (
            SELECT bool_and(
                status_constraint.definition ~ (
                    '(^|[^[:alnum:]_])'
                    || quote_literal(required_statuses.status)
                    || '([^[:alnum:]_]|$)'
                )
            )
            FROM status_constraint
            CROSS JOIN required_statuses
        ),
        false
    ),
    'import_jobs status constraint allows importing, ready_to_apply, and failed'
);

SELECT * FROM finish();
ROLLBACK;
