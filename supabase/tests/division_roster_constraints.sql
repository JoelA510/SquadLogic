-- Division roster constraints are durable admin-owned settings.
--
-- Exercises:
--   - Nullable min/target/team-count constraint columns on public.divisions.
--   - RLS split: org members can read divisions; only org admins can mutate.
--   - Check constraints reject impossible roster/team bounds.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(10);

SET LOCAL role = 'authenticated';

-- Alice is admin of Org A and can update roster/team bounds.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT lives_ok(
    $$
        UPDATE public.divisions
           SET min_roster_size = 9,
               max_roster_size = 14,
               target_team_size = 12,
               team_count_override = 3,
               min_teams = 2,
               max_teams = 4
         WHERE id = 'a1111111-1111-1111-1111-11111111abcd'
    $$,
    'Org A admin can update division roster/team constraints'
);

SELECT results_eq(
    $$
        SELECT min_roster_size, max_roster_size, target_team_size,
               team_count_override, min_teams, max_teams
          FROM public.divisions
         WHERE id = 'a1111111-1111-1111-1111-11111111abcd'
    $$,
    $$ VALUES (9, 14, 12, 3, 2, 4) $$,
    'updated division constraints persist on the row'
);

SELECT lives_ok(
    $$
        INSERT INTO public.divisions (
            organization_id,
            season_settings_id,
            name,
            min_roster_size,
            max_roster_size,
            target_team_size,
            min_teams,
            max_teams
        )
        VALUES (
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-111111111aaa',
            'Org A U12',
            10,
            16,
            12,
            2,
            5
        )
    $$,
    'Org A admin can insert a division with roster/team constraints'
);

SELECT ok(
    EXISTS (
        SELECT 1
          FROM public.divisions
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
           AND name = 'Org A U12'
    ),
    'inserted admin-owned division constraint row is visible to the org admin'
);

SELECT throws_ok(
    $$
        UPDATE public.divisions
           SET min_roster_size = 15,
               max_roster_size = 10
         WHERE id = 'a1111111-1111-1111-1111-11111111abcd'
    $$,
    '23514',
    NULL,
    'database rejects min roster greater than max roster'
);

SELECT throws_ok(
    $$
        INSERT INTO public.divisions (
            organization_id,
            season_settings_id,
            name,
            max_roster_size
        )
        VALUES (
            'a1111111-1111-1111-1111-111111111111',
            'b2222222-2222-2222-2222-222222222bbb',
            'Mismatched Season Org',
            12
        )
    $$,
    '23514',
    NULL,
    'database rejects division organization/season organization mismatch'
);

-- Charlie is signed in with no membership (a coach in Org A until 20261104010000). He can neither
-- read nor update/insert settings.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT ok(
    NOT EXISTS (
        SELECT 1
          FROM public.divisions
         WHERE id = 'a1111111-1111-1111-1111-11111111abcd'
    ),
    'a signed-in non-member cannot read Org A''s division'
);

SELECT lives_ok(
    $$
        UPDATE public.divisions
           SET max_roster_size = 99
         WHERE id = 'a1111111-1111-1111-1111-11111111abcd'
    $$,
    'a non-member cannot update division constraints'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT results_eq(
    $$
        SELECT max_roster_size
          FROM public.divisions
         WHERE id = 'a1111111-1111-1111-1111-11111111abcd'
    $$,
    $$ VALUES (14) $$,
    'a non-member''s update is filtered by RLS and leaves admin-owned constraints unchanged (read by an admin)'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$
        INSERT INTO public.divisions (
            organization_id,
            season_settings_id,
            name,
            max_roster_size
        )
        VALUES (
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-111111111aaa',
            'Coach Created Division',
            12
        )
    $$,
    '42501',
    NULL,
    'a non-member cannot insert division constraints'
);

SELECT * FROM finish();
ROLLBACK;
