-- Smoke test for 20260502000000_import_finalize_pipeline.sql.
-- Run after migrations in a disposable/local Supabase database.
--
-- **ON_ERROR_STOP, or the RAISEs below cannot fail.** psql exits 0 after a
-- statement error unless it is set, so a DO block that raises prints red and
-- returns green -- a file that looks like a gate and reports success. This one
-- still has no caller but a person running psql by hand -- exactly the caller
-- that would have been fooled. `run.sh` enumerates `docs/sql/*_smoke.sql` and
-- this file is in `docs/sql/tests/`, for a migration from before the harness's
-- smoke-era baseline; the harness asserts that nothing in that directory is
-- for an in-era migration, so the exclusion cannot quietly widen. Same
-- defect and same fix as `docs/sql/20260602000000_smoke.sql`, found by
-- grepping every smoke for RAISE without the flag rather than by memory.
\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'staging_players'
          AND column_name = 'promoted_at'
    ) THEN
        RAISE EXCEPTION 'staging_players.promoted_at is missing';
    END IF;

    IF to_regprocedure('public.finalize_import_job(uuid,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'finalize_import_job(uuid,jsonb) is missing';
    END IF;
END;
$$;

ROLLBACK;
