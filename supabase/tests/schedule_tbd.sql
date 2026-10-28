-- pgTAP: the TIME TBD list (Phase D, E; migration 20261107010000; plan
-- docs/changes/2026-10-27-phase-d-scheduling.md, section E, E1).
--
-- `schedule_tbd` holds the practices a team is still short of and the games the scheduler could not
-- place, so the master export can print each as a TIME TBD row. It is a table of its own, not rows
-- in the schedule tables, because a row there reads as a held practice to the lock loader, the
-- writer's prune, `teams_without_practice` and the metrics.
--
-- The practice writer rebuilds the practice list FROM THE ROSTER and each division's count, never
-- from the payload; the game writer records the run's `results.unscheduled`, each entry validated.
-- Only an organization's admins read the list; nobody updates a row.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(32);

-- ---- the roster this test schedules (as the table owner, before any role is set) ---------------
-- Org A, season aaa: U8 wants 2 a week, U6 wants none, U10 (the fixture's) wants 1.
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, practices_per_week) VALUES
    ('a1111111-1111-1111-1111-1111111d0008', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Org A U8', 2),
    ('a1111111-1111-1111-1111-1111111d0006', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Org A U6', 0);
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000a1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD A1'),
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD A2'),
    ('aaaaaaaa-0000-0000-0000-0000000000b1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0006', 'TBD B1');
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111100c1', 'a1111111-1111-1111-1111-111111111111', 'TBD Park');
INSERT INTO public.fields (id, organization_id, location_id, name, active) VALUES
    ('a1111111-1111-1111-1111-1111111100f1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100c1', 'TBD Pitch', true);
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity) VALUES
    ('a1111111-1111-1111-1111-1111111500a1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100f1', 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30', 1),
    ('a1111111-1111-1111-1111-1111111500a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100f1', 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30', 1),
    ('a1111111-1111-1111-1111-1111111500a3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100f1', 'fri', '17:00', '18:00', '2026-09-01', '2026-11-30', 1);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('b2222222-2222-2222-2222-2222222d0008', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222bbb', 'Org B U8');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000b8', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-2222222d0008', 'TBD Org B team');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ---- the practice list: from the roster ---------------------------------------------------------

-- A1 gets both of its practices; A-Team (U10, wants 1) gets its one; A2 gets nothing; B1 (0 a week)
-- nothing. The payload names A1 and A-Team only. The run says A2 found no slot.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unassigned', jsonb_build_array(
                   jsonb_build_object('teamId', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'reason', 'no-slot-available', 'target', 2)))),
           jsonb_build_array(
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    'a practice save with one team short of its two practices succeeds'
);

SELECT results_eq(
    $$ SELECT t.name, s.missing_count::int, s.reason, d.name
         FROM public.schedule_tbd s
         JOIN public.teams t ON t.id = s.team_id
         JOIN public.divisions d ON d.id = s.division_id
        WHERE s.kind = 'practice' AND s.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' $$,
    $$ VALUES ('TBD A2', 2, 'no-slot-available', 'Org A U8') $$,
    'only the team that is short is listed: A2, missing 2, with the run''s reason; A1 and A-Team hold their count, B1 (0 a week) is not listed'
);

-- Not from the payload: A2 was never in it, and is listed all the same. (Enumerated from the roster.)
SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2'),
    1,
    'a team the payload never named is listed because it is on the roster'
);

SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000b1'),
    0,
    'a division at 0 practices a week lists none of its teams'
);

-- No run reason for A2 now, and the only series it holds ended in 2020: it is not a held practice.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2020-01-01,2020-02-01)', 'source', 'manual'))) $$,
    'a second save, with no reasons and A2 holding only a series that ended in 2020, succeeds'
);
SELECT results_eq(
    $$ SELECT missing_count::int, (detail->>'held')::int, reason FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2' $$,
    $$ VALUES (2, 0, 'not-scheduled-yet') $$,
    'an ended series is not a held practice, and a team with no reason from the run is not-scheduled-yet'
);

-- A2 gets one live practice (Friday, beside the ended series, which stays).
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2020-01-01,2020-02-01)', 'source', 'manual'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'))) $$,
    'a save that gives A2 one of its two practices succeeds'
);
SELECT results_eq(
    $$ SELECT missing_count::int, (detail->>'held')::int FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2' $$,
    $$ VALUES (1, 1) $$,
    'the list is rebuilt: A2 is now missing 1, holding 1 of 2'
);

SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-1111111d0008', 'aaaaaaaa-0000-0000-0000-0000000000a2', 1, 'no-slot-available') $$,
    '23505', NULL, 'a team has one practice row (the unique index), whatever its count'
);

-- ---- the game list --------------------------------------------------------------------------------

SELECT lives_ok(
    $$ SELECT public.persist_game_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unscheduled', jsonb_build_array(
                   jsonb_build_object('weekIndex', 3, 'division', 'Org A U8', 'reason', 'no-slot-available',
                       'matchup', jsonb_build_object('homeTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'awayTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a2')),
                   jsonb_build_object('weekIndex', 5, 'division', 'Org A U8', 'reason', 'coach-scheduling-conflict',
                       'matchup', jsonb_build_object('homeTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'awayTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1'))))),
           '[]'::jsonb) $$,
    'a game save carrying two unscheduled games succeeds'
);
SELECT results_eq(
    $$ SELECT th.name, ta.name, s.week_index::int, s.reason, s.division_id
         FROM public.schedule_tbd s
         JOIN public.teams th ON th.id = s.home_team_id
         JOIN public.teams ta ON ta.id = s.away_team_id
        WHERE s.kind = 'game' ORDER BY s.week_index $$,
    $$ VALUES ('TBD A1', 'TBD A2', 3, 'no-slot-available', 'a1111111-1111-1111-1111-1111111d0008'::uuid),
              ('TBD A2', 'TBD A1', 5, 'coach-scheduling-conflict', 'a1111111-1111-1111-1111-1111111d0008'::uuid) $$,
    'both are recorded as sent: home, away, week, reason and the home team''s division'
);
SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd WHERE kind = 'practice'),
    1,
    'a game save left the practice list as it was'
);

SELECT throws_ok(
    $$ SELECT public.persist_game_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unscheduled', jsonb_build_array(
                   jsonb_build_object('weekIndex', 9, 'reason', 'because',
                       'matchup', jsonb_build_object('homeTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'awayTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a2'))))),
           '[]'::jsonb) $$,
    '22023', NULL, 'a reason off the closed list is refused'
);
SELECT throws_ok(
    $$ SELECT public.persist_game_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unscheduled', jsonb_build_array(
                   jsonb_build_object('weekIndex', 9, 'reason', 'no-slot-available',
                       'matchup', jsonb_build_object('homeTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'awayTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1'))))),
           '[]'::jsonb) $$,
    '22023', NULL, 'one team on both sides is refused'
);
SELECT throws_ok(
    $$ SELECT public.persist_game_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unscheduled', jsonb_build_array(
                   jsonb_build_object('weekIndex', 9, 'reason', 'no-slot-available',
                       'matchup', jsonb_build_object('homeTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'awayTeamId', 'bbbbbbbb-0000-0000-0000-0000000000b8'))))),
           '[]'::jsonb) $$,
    '42501', NULL, 'a team of another organization is refused'
);
SELECT throws_ok(
    $$ SELECT public.persist_game_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unscheduled', jsonb_build_array(
                   jsonb_build_object('weekIndex', 9, 'reason', 'no-slot-available',
                       'matchup', jsonb_build_object('homeTeamId', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'awayTeamId', gen_random_uuid()))))),
           '[]'::jsonb) $$,
    '23503', NULL, 'a team that does not exist is refused'
);
SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd WHERE kind = 'game'),
    2,
    'the refused saves changed nothing: the two games from before are still listed'
);

-- A save with no list leaves it; the run's audit row carries the count when there was one.
SELECT lives_ok(
    $$ SELECT public.persist_game_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa', 'results', jsonb_build_object('summary', '{}'::jsonb)),
           '[]'::jsonb) $$,
    'a game save with no unscheduled list succeeds'
);
SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd WHERE kind = 'game'),
    2,
    'a save that carries no list leaves the unscheduled games as they were'
);

-- ---- the reads --------------------------------------------------------------------------------------

SELECT is(
    jsonb_array_length(public.get_schedule_tbd('a1111111-1111-1111-1111-111111111aaa')),
    3,
    'an admin reads the season''s list through the RPC: one practice row and two games'
);
SELECT results_eq(
    $$ SELECT e->>'team_name', (e->>'missing_count')::int, e->>'division_name'
         FROM jsonb_array_elements(public.get_schedule_tbd('a1111111-1111-1111-1111-111111111aaa')) e
        WHERE e->>'kind' = 'practice' $$,
    $$ VALUES ('TBD A2', 1, 'Org A U8') $$,
    'the RPC carries the names'
);
SELECT throws_ok(
    $$ UPDATE public.schedule_tbd SET reason = 'no-slot-available' WHERE kind = 'practice' $$,
    '42501', NULL, 'nobody updates a row: there is no UPDATE grant'
);

-- Deleting a team counts the rows its cascade takes: A2's practice row and the two games it plays.
SELECT lives_ok(
    $$ SELECT public.admin_delete_team('aaaaaaaa-0000-0000-0000-0000000000a2') $$,
    'an admin deletes a team that has TIME TBD rows'
);
SELECT is(
    (SELECT (metadata->>'schedule_tbd_deleted')::int FROM public.audit_log
      WHERE action = 'team.deleted' AND resource_id = 'aaaaaaaa-0000-0000-0000-0000000000a2'),
    3,
    'team.deleted counts the three schedule_tbd rows the cascade took (one practice row, two games)'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is((SELECT count(*)::int FROM public.schedule_tbd), 0, 'another organization''s admin reads no row');
SELECT throws_ok(
    $$ SELECT public.get_schedule_tbd('a1111111-1111-1111-1111-111111111aaa') $$,
    '42501', NULL, 'another organization''s admin is refused by the RPC'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM public.schedule_tbd), 0, 'a member of no organization reads no row');
SELECT throws_ok(
    $$ SELECT public.get_schedule_tbd('a1111111-1111-1111-1111-111111111aaa') $$,
    '42501', NULL, 'a member of no organization is refused by the RPC'
);
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-11111111abcd', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'no-slot-available') $$,
    '42501', NULL, 'a member of no organization cannot write a row'
);

RESET role;
SET LOCAL role = 'anon';
SELECT throws_ok(
    $$ SELECT count(*) FROM public.schedule_tbd $$,
    '42501', NULL, 'anon cannot read the table'
);

RESET role;
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, home_team_id, away_team_id, week_index, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-11111111abcd', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a2', 2, 'no-slot-available') $$,
    '23514', NULL, 'a practice row that carries game columns breaks the shape CHECK'
);
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game',
               'a1111111-1111-1111-1111-11111111abcd', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000a2', 2, 'not-scheduled-yet') $$,
    '23514', NULL, 'a game row with a practice-only reason breaks the reason CHECK'
);

SELECT * FROM finish();
ROLLBACK;
