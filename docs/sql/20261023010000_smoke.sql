-- Smoke checks for 20261023010000_restore_reporting_views.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * `view_org_metrics` and `view_league_standings` exist, as views, with
--     `security_invoker = true` (without it a view reads its tables as its
--     owner, past RLS);
--   * their columns, in order, are the definitive schema's, plus
--     `view_league_standings.division` and `season_settings_id` last, which
--     the Reports page (`EnterpriseDashboard.jsx`) and the Standings page
--     (`LeagueStandings.jsx`, which orders and groups by `division` and filters
--     on `season_settings_id`) read with `select('*')`;
--   * authenticated and service_role can SELECT from both.
-- That RLS still scopes their rows (a member of one organization sees only
-- its own) is supabase/tests/reporting_views_present.sql's, under a real
-- authenticated session.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- It writes nothing and holds no personal data.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(v, ', ' ORDER BY v) INTO v_bad
      FROM unnest(ARRAY['public.view_org_metrics', 'public.view_league_standings']) v
     WHERE to_regclass(v) IS NULL
        OR (SELECT c.relkind <> 'v'
                OR NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)
              FROM pg_class c WHERE c.oid = to_regclass(v));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'reporting views missing, not views, or not security_invoker: %', v_bad;
    END IF;
    RAISE NOTICE 'view_org_metrics and view_league_standings exist, both security_invoker';
END;
$$;

DO $$
DECLARE
    v_org text;
    v_standings text;
BEGIN
    SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_org
      FROM pg_attribute
     WHERE attrelid = 'public.view_org_metrics'::regclass AND attnum > 0 AND NOT attisdropped;
    SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_standings
      FROM pg_attribute
     WHERE attrelid = 'public.view_league_standings'::regclass AND attnum > 0 AND NOT attisdropped;
    IF v_org IS DISTINCT FROM 'organization_id,organization_name,total_players,total_teams,total_users' THEN
        RAISE EXCEPTION 'view_org_metrics columns are %', v_org;
    END IF;
    IF v_standings IS DISTINCT FROM 'team_id,organization_id,team_name,division_id,games_played,wins,losses,draws,goals_for,goals_against,goal_differential,points,division,season_settings_id' THEN
        RAISE EXCEPTION 'view_league_standings columns are %', v_standings;
    END IF;
    RAISE NOTICE 'columns: view_org_metrics 5 and view_league_standings 14, in the definitive schema''s order with division and season_settings_id last';
END;
$$;

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(format('%s for %s', v, r), ', ' ORDER BY v, r) INTO v_bad
      FROM unnest(ARRAY['public.view_org_metrics', 'public.view_league_standings']) v,
           unnest(ARRAY['authenticated', 'service_role']) r
     WHERE NOT has_table_privilege(r, v, 'SELECT');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'SELECT missing on %', v_bad;
    END IF;
    RAISE NOTICE 'grants: authenticated and service_role can SELECT from both views';
END;
$$;

ROLLBACK;
