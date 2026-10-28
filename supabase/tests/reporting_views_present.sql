-- pgTAP: the two reporting views the app reads exist, keep their shape and
-- posture, and RLS still scopes their rows (migration 20261023010000;
-- docs/operations/schema-drift-2026-10.md, section 7: production lacked both).
--
--   * `view_org_metrics` (the Reports page, EnterpriseDashboard.jsx) and
--     `view_league_standings` (the Standings page, LeagueStandings.jsx) exist
--     as views with `security_invoker = true`;
--   * their columns, in order, are the definitive schema's, plus
--     `view_league_standings.division` and `season_settings_id` last: both
--     pages read them with `select('*')`, and the Standings page orders and
--     groups by `division` and filters on `season_settings_id`;
--     `view_org_metrics` also ends with `season_settings_id` (20261108010000:
--     one row per season; supabase/tests/season_enrollment.sql counts them);
--   * authenticated can SELECT from both;
--   * as Org A's admin: exactly one metrics row, Org A's, with its team and
--     member counts (the Reports page's Active Teams), only Org A's team in
--     the standings, carrying its division's name and season; as anon: no rows
--     from either.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(17);

-- ── 1. Shape and posture ───────────────────────────────────────────────────
SELECT has_view('public', 'view_org_metrics', 'view_org_metrics exists');
SELECT has_view('public', 'view_league_standings', 'view_league_standings exists');

SELECT ok(coalesce((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class
                     WHERE oid = to_regclass('public.view_org_metrics')), false),
    'view_org_metrics is security_invoker');
SELECT ok(coalesce((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class
                     WHERE oid = to_regclass('public.view_league_standings')), false),
    'view_league_standings is security_invoker');

SELECT is(
    (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
      WHERE attrelid = to_regclass('public.view_org_metrics') AND attnum > 0 AND NOT attisdropped),
    ARRAY['organization_id', 'organization_name', 'total_players', 'total_teams', 'total_users',
          'season_settings_id'],
    'view_org_metrics columns, in order, are what the Reports page reads, the season last (20261108010000)');
SELECT is(
    (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
      WHERE attrelid = to_regclass('public.view_league_standings') AND attnum > 0 AND NOT attisdropped),
    ARRAY['team_id', 'organization_id', 'team_name', 'division_id', 'games_played', 'wins', 'losses',
          'draws', 'goals_for', 'goals_against', 'goal_differential', 'points', 'division',
          'season_settings_id'],
    'view_league_standings columns, in order, are the definitive schema''s with division and season_settings_id last');

SELECT ok(to_regclass('public.view_org_metrics') IS NOT NULL
          AND has_table_privilege('authenticated', 'public.view_org_metrics', 'SELECT'),
    'authenticated can SELECT from view_org_metrics');
SELECT ok(to_regclass('public.view_league_standings') IS NOT NULL
          AND has_table_privilege('authenticated', 'public.view_league_standings', 'SELECT'),
    'authenticated can SELECT from view_league_standings');

-- ── 2. RLS scopes the rows: Alice, Org A's admin ───────────────────────────
-- A missing view makes each read below an error rather than a quiet zero:
-- the suite then fails on the error, as the posture tests above already have.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is((SELECT count(*)::int FROM public.view_org_metrics), 1,
    'Org A''s admin sees exactly one metrics row');
SELECT is((SELECT organization_id FROM public.view_org_metrics),
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'and it is Org A''s');
SELECT is((SELECT ARRAY[total_teams, total_users]::int[] FROM public.view_org_metrics
            WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    ARRAY[1, 1],
    'Org A''s row counts its one team (Active Teams) and its one member (Alice: Charlie is no member)');
SELECT is((SELECT count(*)::int FROM public.view_org_metrics
            WHERE organization_id = 'b2222222-2222-2222-2222-222222222222'), 0,
    'Org A''s admin cannot see Org B''s metrics row');
SELECT is((SELECT array_agg(team_id ORDER BY team_id) FROM public.view_league_standings),
    ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid],
    'Org A''s admin sees only Org A''s team in the standings');
SELECT is((SELECT division FROM public.view_league_standings
            WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    'Org A U10',
    'its division is the name of the team''s division, which the Standings page groups by');
SELECT ok(coalesce((SELECT s.season_settings_id IS NOT NULL AND s.season_settings_id = d.season_settings_id
                      FROM public.view_league_standings s
                      JOIN public.teams t ON t.id = s.team_id
                      JOIN public.divisions d ON d.id = t.division_id
                     WHERE s.team_id = 'aaaaaaaa-0000-0000-0000-000000000001'), false),
    'its season_settings_id is its division''s season, which the Standings page filters on');

-- ── 3. anon reads nothing ──────────────────────────────────────────────────
SET LOCAL role = 'anon';
SET LOCAL "request.jwt.claims" TO '';

SELECT is((SELECT count(*)::int FROM public.view_org_metrics), 0,
    'anon reads no metrics rows');
SELECT is((SELECT count(*)::int FROM public.view_league_standings), 0,
    'anon reads no standings rows');

SELECT * FROM finish();
ROLLBACK;
