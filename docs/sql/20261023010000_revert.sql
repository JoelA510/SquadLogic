-- Revert for 20261023010000_restore_reporting_views.sql
--
-- **Production lacked both views before this migration**
-- (docs/operations/schema-drift-2026-10.md, section 7): the migration created
-- them there. A fresh build had both before it, from
-- 20260331000000_definitive_schema.sql, exactly as the migration restates them.
--
-- This revert returns a database to the state the migration set leaves at
-- 20261022020000, which is the fresh build's: both views present, as the
-- definitive schema defines them, with that build's grants. `view_org_metrics`
-- is restated unchanged. `view_league_standings` is dropped and recreated
-- without the `division` column the migration appended (CREATE OR REPLACE
-- cannot drop a column), then both views' grants are restated. It does NOT
-- leave the views dropped: that would leave a fresh build without two views
-- its own history creates. Production's literal earlier state (no views) is
-- the drift this migration repairs, not a state to return to.
--
-- Verified: the harness compares a fingerprint of both views (owner, ACL,
-- options, definition and columns) after this revert with the one read off a
-- build at 20261022020000.

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

DROP VIEW public.view_league_standings;

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
