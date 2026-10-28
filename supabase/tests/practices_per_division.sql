-- pgTAP: practices per division (Phase D, PR B; migration 20261105010000; plan
-- docs/changes/2026-10-27-phase-d-scheduling.md, B1).
--
-- A division says how many practices a week its teams get (0 to 7, 1 until set) and how long each
-- is (15 to 240 minutes, NULL: any slot length). The columns refuse a value out of range; the
-- division settings writer saves both, NULL keeps a stored value, 0 minutes clears the length, both
-- are audited before and after, a non-admin is refused, and the writer's old eleven-argument call
-- by name (an app that does not send them yet) still works and keeps them.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(18);

-- ---- the columns -----------------------------------------------------------

SELECT results_eq(
    $$ SELECT practices_per_week::int, practice_minutes::int
         FROM public.divisions WHERE id = 'a1111111-1111-1111-1111-11111111abcd' $$,
    $$ VALUES (1, NULL::int) $$,
    'a division that existed before the migration takes 1 practice a week and any slot length'
);

SELECT throws_ok(
    $$ UPDATE public.divisions SET practices_per_week = 8 WHERE id = 'a1111111-1111-1111-1111-11111111abcd' $$,
    '23514', NULL, 'the column refuses 8 practices a week'
);
SELECT throws_ok(
    $$ UPDATE public.divisions SET practices_per_week = -1 WHERE id = 'a1111111-1111-1111-1111-11111111abcd' $$,
    '23514', NULL, 'the column refuses -1 practices a week'
);
SELECT throws_ok(
    $$ UPDATE public.divisions SET practice_minutes = 14 WHERE id = 'a1111111-1111-1111-1111-11111111abcd' $$,
    '23514', NULL, 'the column refuses a 14-minute practice'
);
SELECT throws_ok(
    $$ UPDATE public.divisions SET practice_minutes = 241 WHERE id = 'a1111111-1111-1111-1111-11111111abcd' $$,
    '23514', NULL, 'the column refuses a 241-minute practice'
);
SELECT lives_ok(
    $$ UPDATE public.divisions SET practices_per_week = 0, practice_minutes = 15 WHERE id = 'a1111111-1111-1111-1111-11111111abcd';
       UPDATE public.divisions SET practices_per_week = 7, practice_minutes = 240 WHERE id = 'a1111111-1111-1111-1111-11111111abcd';
       UPDATE public.divisions SET practices_per_week = 1, practice_minutes = NULL WHERE id = 'a1111111-1111-1111-1111-11111111abcd' $$,
    'the bounds themselves (0, 7, 15, 240) are accepted'
);

-- ---- the writer, as an admin ---------------------------------------------------

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT results_eq(
    $$ SELECT (r->>'practices_per_week')::int, (r->>'practice_minutes')::int, (r->>'changed')::boolean
         FROM public.admin_upsert_division_settings(
             'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
             NULL, 'Org A U8', 12, 8, 10, 2, 1, 3, true, 2, 60) AS r $$,
    $$ VALUES (2, 60, true) $$,
    'a new division is created with 2 practices a week of 60 minutes'
);

SELECT results_eq(
    $$ SELECT (r->>'practices_per_week')::int, (r->>'practice_minutes')::int
         FROM public.admin_upsert_division_settings(
             'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
             NULL, 'Org A U9', 12, 8, 10, 2, 1, 3) AS r $$,
    $$ VALUES (1, NULL::int) $$,
    'a new division that sends neither takes 1 a week and any slot length'
);

SELECT results_eq(
    $$ SELECT (r->>'practices_per_week')::int, (r->>'practice_minutes')::int, (r->>'changed')::boolean
         FROM public.admin_upsert_division_settings(
             'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
             (SELECT id FROM public.divisions WHERE name = 'Org A U8' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
             'Org A U8', 12, 8, 10, 2, 1, 3, NULL) AS r $$,
    $$ VALUES (2, 60, false) $$,
    'a save that sends neither setting keeps both and changes nothing'
);

SELECT results_eq(
    $$ SELECT (r->>'practices_per_week')::int, (r->>'practice_minutes')::int, (r->>'changed')::boolean
         FROM public.admin_upsert_division_settings(
             'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
             (SELECT id FROM public.divisions WHERE name = 'Org A U8' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
             'Org A U8', 12, 8, 10, 2, 1, 3, NULL, 3, NULL) AS r $$,
    $$ VALUES (3, 60, true) $$,
    'sending only the count changes it and keeps the length'
);

SELECT results_eq(
    $$ SELECT (r->>'practices_per_week')::int, (r->>'practice_minutes')::int, (r->>'changed')::boolean
         FROM public.admin_upsert_division_settings(
             'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
             (SELECT id FROM public.divisions WHERE name = 'Org A U8' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
             'Org A U8', 12, 8, 10, 2, 1, 3, NULL, NULL, 0) AS r $$,
    $$ VALUES (3, NULL::int, true) $$,
    '0 minutes clears the length to any slot length'
);

SELECT throws_ok(
    $$ SELECT public.admin_upsert_division_settings(
           'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
           NULL, 'Org A U8', 12, 8, 10, 2, 1, 3, NULL, 8, NULL) $$,
    '23514', NULL, 'the writer refuses 8 practices a week'
);
SELECT throws_ok(
    $$ SELECT public.admin_upsert_division_settings(
           'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
           NULL, 'Org A U8', 12, 8, 10, 2, 1, 3, NULL, NULL, 14) $$,
    '23514', NULL, 'the writer refuses a 14-minute practice'
);
SELECT results_eq(
    $$ SELECT practices_per_week::int, practice_minutes::int FROM public.divisions
        WHERE name = 'Org A U8' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' $$,
    $$ VALUES (3, NULL::int) $$,
    'a refused save changes nothing'
);

-- The audit row of the count change carries both settings, before and after.
SELECT results_eq(
    $$ SELECT (metadata->'previous'->>'practices_per_week')::int,
              (metadata->'previous'->>'practice_minutes')::int,
              (metadata->'current'->>'practices_per_week')::int,
              (metadata->'current'->>'practice_minutes')::int
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND action = 'settings.updated' AND resource_type = 'division'
          AND metadata->>'name' = 'Org A U8'
          AND (metadata->'current'->>'practices_per_week')::int = 3
          AND (metadata->'previous'->>'practices_per_week')::int = 2
          AND (metadata->'current'->>'practice_minutes') IS NOT NULL $$,
    $$ VALUES (2, 60, 3, 60) $$,
    'the settings.updated row carries the count and the length before and after'
);

-- The old eleven-argument call by name (an app that does not send them) works and keeps them.
SELECT results_eq(
    $$ SELECT (r->>'practices_per_week')::int, (r->>'changed')::boolean
         FROM public.admin_upsert_division_settings(
             p_organization_id => 'a1111111-1111-1111-1111-111111111111',
             p_season_settings_id => 'a1111111-1111-1111-1111-111111111aaa',
             p_division_id => (SELECT id FROM public.divisions WHERE name = 'Org A U8' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'),
             p_name => 'Org A U8', p_max_roster_size => 12, p_min_roster_size => 8, p_target_team_size => 10,
             p_team_count_override => 2, p_min_teams => 1, p_max_teams => 3, p_plays_games => true) AS r $$,
    $$ VALUES (3, false) $$,
    'a call that names none of the new arguments still works and keeps the count'
);

SELECT is(
    (SELECT count(*)::int FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = 'admin_upsert_division_settings'),
    1,
    'there is one admin_upsert_division_settings, not an overload beside the old signature'
);

-- ---- a coach is refused ----------------------------------------------------

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$ SELECT public.admin_upsert_division_settings(
           'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
           NULL, 'Org A U8', 12, 8, 10, 2, 1, 3, NULL, 2, 60) $$,
    '42501', NULL, 'a coach cannot set the practice settings'
);

SELECT * FROM finish();
ROLLBACK;
