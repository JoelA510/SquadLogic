-- Drop two views nothing reads: `coach_team_map` and `view_facility_usage` (owner approval 2026-10-27).
--
-- **The drift.** A fresh build creates both (`coach_team_map` in 20251208000000, `view_facility_usage`
-- in 20251220000000, both restated in 20260331000000), but production never had either: read-only,
-- 2026-10-23 and again at 20261023010000, its `public` schema holds no view of either name
-- (docs/operations/schema-drift-2026-10.md, section 7; docs/operations/ci-cd.md, "Catalogue drift").
-- The catalogue check has carried the pair as two expected `only_in_snapshot` rows since views joined
-- the snapshot (2026-10-24), and the owner chose to drop them from the build rather than create them in
-- production.
--
-- **Nothing reads them.** A search of `frontend/`, `packages/`, `supabase/functions/`, `scripts/` and
-- `tests/` for either name matches only the practice-reader census registry entry
-- `sql:view_facility_usage` in tests/practiceReaderCensus.test.js (a classification of the view's
-- own definition, removed with it). No function, policy or other view depends on either: on a fresh
-- build, `pg_depend` has no row with either as the referenced object, and no function body or policy
-- names them. The pgTAP and smoke checks below read the catalogue for the same.
--
-- **The change.** `DROP VIEW IF EXISTS` for each, with no CASCADE: a dependent object added since would
-- stop the drop rather than go with it. On a fresh build it removes both; **in production it is a
-- no-op** (the views are not there), which the NOTICE says in either case. The catalogue snapshot
-- (supabase/catalog-snapshot.json) loses the two view rows, so the operator drift check at this
-- version expects no `only_in_snapshot` rows for them.
--
-- Reversible: docs/sql/20261103020000_revert.sql recreates both from their last definitions
-- (20260331000000 with `security_invoker`, as a fresh build had them). A production revert would
-- CREATE views production never had; the revert's header says so.
-- Smoke: docs/sql/20261103020000_smoke.sql. pgTAP: supabase/tests/unused_views_dropped.sql.

BEGIN;

DO $$
BEGIN
    RAISE NOTICE 'coach_team_map: %; view_facility_usage: % (an absent view is dropped as a no-op)',
        CASE WHEN to_regclass('public.coach_team_map') IS NULL THEN 'absent' ELSE 'present, dropped' END,
        CASE WHEN to_regclass('public.view_facility_usage') IS NULL THEN 'absent' ELSE 'present, dropped' END;
END;
$$;

DROP VIEW IF EXISTS public.coach_team_map;
DROP VIEW IF EXISTS public.view_facility_usage;

DO $check$
BEGIN
    IF to_regclass('public.coach_team_map') IS NOT NULL OR to_regclass('public.view_facility_usage') IS NOT NULL THEN
        RAISE EXCEPTION 'an unused view survived its drop';
    END IF;
    -- The views that stay are the ones the app reads: a drop that took them too would be a different change.
    IF to_regclass('public.view_org_metrics') IS NULL OR to_regclass('public.view_league_standings') IS NULL THEN
        RAISE EXCEPTION 'a reporting view the app reads is missing';
    END IF;
END;
$check$;

COMMIT;
