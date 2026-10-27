-- pgTAP: the two views nothing reads are gone from the build (migration 20261103020000), and the views
-- the app reads are not. `coach_team_map` and `view_facility_usage` were never created in production.

BEGIN;

SELECT plan(7);

SELECT is(to_regclass('public.coach_team_map')::text, NULL, 'coach_team_map is not built');
SELECT is(to_regclass('public.view_facility_usage')::text, NULL, 'view_facility_usage is not built');
SELECT has_view('public', 'view_org_metrics', 'view_org_metrics (the Reports page) stays');
SELECT has_view('public', 'view_league_standings', 'view_league_standings (the Standings page) stays');
SELECT is(
    (SELECT count(*)::int FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND (prosrc ~ '\mcoach_team_map\M' OR prosrc ~ '\mview_facility_usage\M')),
    0,
    'no function body names either view');
SELECT is(
    (SELECT count(*)::int FROM pg_policies
      WHERE coalesce(qual, '') ~ '\m(coach_team_map|view_facility_usage)\M'
         OR coalesce(with_check, '') ~ '\m(coach_team_map|view_facility_usage)\M'),
    0,
    'no policy names either view');
SELECT cmp_ok(
    (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~ '\mpractice_assignments\M'),
    '>', 0,
    'the function-body lookup finds a table that is used (it can match)');

SELECT * FROM finish();
ROLLBACK;
