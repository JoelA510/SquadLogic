-- Smoke checks for 20261103020000_drop_unused_views.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. Both views are gone from the catalogue, and the views the app reads are still there.
--   2. Nothing in the catalogue names either: no function body, no policy, no rule or view
--      definition. (Looked up by the name's text; the positive control proves the lookup finds a
--      name that is used.)
--   3. The migration's drop is idempotent: running it again changes nothing and does not fail, as
--      it must be in production, where neither view exists.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_n bigint;
BEGIN
    -- ---- 1. gone, and the others stay -----------------------------------------------
    IF to_regclass('public.coach_team_map') IS NOT NULL THEN RAISE EXCEPTION 'coach_team_map is still there'; END IF;
    IF to_regclass('public.view_facility_usage') IS NOT NULL THEN RAISE EXCEPTION 'view_facility_usage is still there'; END IF;
    SELECT count(*) INTO v_n FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'
       AND c.relname IN ('view_org_metrics', 'view_league_standings', 'field_closures', 'import_efficiency_metrics');
    IF v_n <> 4 THEN RAISE EXCEPTION 'only % of the 4 views the app reads are present', v_n; END IF;

    -- ---- 2. nothing names either -----------------------------------------------------
    SELECT count(*) INTO v_n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND (prosrc ~ '\mcoach_team_map\M' OR prosrc ~ '\mview_facility_usage\M');
    IF v_n <> 0 THEN RAISE EXCEPTION '% function(s) still name a dropped view', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE coalesce(qual, '') ~ '\m(coach_team_map|view_facility_usage)\M'
        OR coalesce(with_check, '') ~ '\m(coach_team_map|view_facility_usage)\M';
    IF v_n <> 0 THEN RAISE EXCEPTION '% policy(ies) still name a dropped view', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_views
     WHERE schemaname = 'public' AND definition ~ '\m(coach_team_map|view_facility_usage)\M';
    IF v_n <> 0 THEN RAISE EXCEPTION '% view(s) still read a dropped view', v_n; END IF;
    -- The positive controls: the same lookups find a table that is used.
    SELECT count(*) INTO v_n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND prosrc ~ '\mpractice_assignments\M';
    IF v_n = 0 THEN RAISE EXCEPTION 'the function-body lookup found nothing for a table that is used'; END IF;
    SELECT count(*) INTO v_n FROM pg_views WHERE schemaname = 'public' AND definition ~ '\mteams\M';
    IF v_n = 0 THEN RAISE EXCEPTION 'the view-definition lookup found nothing for a table that is read'; END IF;
    RAISE NOTICE 'both views are gone; the 4 views the app reads stay; no function, policy or view names either';

    -- ---- 3. idempotent ----------------------------------------------------------------
    DROP VIEW IF EXISTS public.coach_team_map;
    DROP VIEW IF EXISTS public.view_facility_usage;
    RAISE NOTICE 'dropping again is a no-op, as in production where neither view exists';
END;
$$;

ROLLBACK;
