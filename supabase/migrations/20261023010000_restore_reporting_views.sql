-- Restore the two reporting views production lacks: `view_org_metrics` and
-- `view_league_standings` (owner approval 2026-10-23).
--
-- **The drift.** A fresh build creates both in 20251220000000_reporting_views
-- and again in 20260331000000_definitive_schema, but production's `public`
-- schema has neither: read-only, 2026-10-23, it has two views,
-- `field_closures` and `import_efficiency_metrics`
-- (docs/operations/schema-drift-2026-10.md, section 7). Production's schema
-- was never built by replaying these migrations, and the catalogue snapshot
-- covers functions, triggers and policies, not views, so nothing saw it. Two
-- pages read them:
--   * `view_org_metrics`, the Reports page (frontend/src/pages/EnterpriseDashboard.jsx):
--     its read fails, so Active Teams stays 0;
--   * `view_league_standings`, the Standings page (frontend/src/pages/LeagueStandings.jsx):
--     its reads fail.
-- `view_compliance_stats` went in 20261022020000 (R1); `view_facility_usage`
-- is read by nothing and is left as it is.
--
-- **The change.** Both views, CREATE OR REPLACE, exactly as their latest
-- definitions (20260331000000_definitive_schema.sql): the same SELECT, the
-- same columns in the same order, `security_invoker = true`, so a reader sees
-- only the rows RLS gives it on the tables beneath. Then their grants, as a
-- fresh build has them (read off a harness build at 20261022020000, not from
-- the migrations' text): the migrations grant SELECT to authenticated, and
-- Supabase's default privileges for objects `postgres` creates in `public`
-- give anon, authenticated and service_role every table privilege. The GRANT
-- restates that, so production's views carry the fresh build's ACL even if its
-- default privileges differ. Neither view is updatable (aggregates), and with
-- security_invoker anon reads no rows of either (the pgTAP suite checks it).
--
-- **Known gap, not fixed here.** LeagueStandings.jsx orders by, and groups on,
-- a `division` column that no definition of `view_league_standings` has ever
-- had (it has `division_id`), so once the view exists that page's read is
-- expected to fail on the missing column instead (statically reviewed; not
-- run against PostgREST). Changing the view's shape or the page is a
-- follow-up; this migration restores the definition as it is.
--
-- On a fresh build this is a no-op: the definitions and the ACL are what the
-- build already has (the harness compares a fingerprint of both). In
-- production it creates the two views.
--
-- Reversible: docs/sql/20261023010000_revert.sql restates the views as they
-- stood at 20261022020000 (production lacked them before this migration; see
-- its header). Smoke checks: docs/sql/20261023010000_smoke.sql.
-- pgTAP: supabase/tests/reporting_views_present.sql.

BEGIN;

CREATE OR REPLACE VIEW public.view_org_metrics
WITH (security_invoker = true)
AS
SELECT
    o.id AS organization_id,
    o.name AS organization_name,
    (SELECT COUNT(p.id) FROM public.players p WHERE p.organization_id = o.id) AS total_players,
    (SELECT COUNT(t.id) FROM public.teams t WHERE t.organization_id = o.id) AS total_teams,
    (SELECT COUNT(om.profile_id) FROM public.organization_members om WHERE om.organization_id = o.id) AS total_users
FROM public.organizations o;

CREATE OR REPLACE VIEW public.view_league_standings
WITH (security_invoker = true)
AS
WITH game_results AS (
    SELECT
        id AS game_id,
        season_id,
        home_team_id AS team_id,
        score_home AS goals_for,
        score_away AS goals_against,
        CASE WHEN score_home > score_away THEN 1 ELSE 0 END AS win,
        CASE WHEN score_home < score_away THEN 1 ELSE 0 END AS loss,
        CASE WHEN score_home = score_away THEN 1 ELSE 0 END AS draw
    FROM public.games
    WHERE score_home IS NOT NULL AND score_away IS NOT NULL

    UNION ALL

    SELECT
        id AS game_id,
        season_id,
        away_team_id AS team_id,
        score_away AS goals_for,
        score_home AS goals_against,
        CASE WHEN score_away > score_home THEN 1 ELSE 0 END AS win,
        CASE WHEN score_away < score_home THEN 1 ELSE 0 END AS loss,
        CASE WHEN score_away = score_home THEN 1 ELSE 0 END AS draw
    FROM public.games
    WHERE score_home IS NOT NULL AND score_away IS NOT NULL
)
SELECT
    t.id AS team_id,
    t.organization_id,
    t.name AS team_name,
    t.division_id,
    COUNT(gr.game_id) AS games_played,
    COALESCE(SUM(gr.win), 0) AS wins,
    COALESCE(SUM(gr.loss), 0) AS losses,
    COALESCE(SUM(gr.draw), 0) AS draws,
    COALESCE(SUM(gr.goals_for), 0) AS goals_for,
    COALESCE(SUM(gr.goals_against), 0) AS goals_against,
    COALESCE(SUM(gr.goals_for), 0) - COALESCE(SUM(gr.goals_against), 0) AS goal_differential,
    (COALESCE(SUM(gr.win), 0) * 3) + COALESCE(SUM(gr.draw), 0) AS points
FROM public.teams t
LEFT JOIN game_results gr ON gr.team_id = t.id
GROUP BY t.id, t.organization_id, t.name, t.division_id;

GRANT ALL ON public.view_org_metrics, public.view_league_standings
    TO anon, authenticated, service_role;

COMMIT;
