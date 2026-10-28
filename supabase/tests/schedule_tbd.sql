-- pgTAP: the TIME TBD list (Phase D, E; migration 20261108020000; plan
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
--
-- Every date here is relative to CURRENT_DATE: the sync counts a series as held only while it is live,
-- so a fixed range would turn this test red on the day it ended.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(74);

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
    ('a1111111-1111-1111-1111-1111111500a1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100f1', 'mon', '17:00', '18:00', CURRENT_DATE - 60, CURRENT_DATE + 90, 1),
    ('a1111111-1111-1111-1111-1111111500a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100f1', 'wed', '17:00', '18:00', CURRENT_DATE - 60, CURRENT_DATE + 90, 1),
    ('a1111111-1111-1111-1111-1111111500a3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100f1', 'fri', '17:00', '18:00', CURRENT_DATE - 60, CURRENT_DATE + 90, 1);
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
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')))) $$,
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
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
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
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2020-01-01,2020-02-01)', 'source', 'manual'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']'), 'source', 'manual'))) $$,
    'a save that gives A2 one of its two practices succeeds'
);
SELECT results_eq(
    $$ SELECT missing_count::int, (detail->>'held')::int FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2' $$,
    $$ VALUES (1, 1) $$,
    'the list is rebuilt: A2 is now missing 1, holding 1 of 2'
);


-- ---- refresh_schedule_tbd_practices: the export's way to bring the practice list up to date ---------
-- (A run that placed nothing never reaches the practice writer, so the list is also rebuilt here.)

SELECT is(
    (public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa') ->> 'changed')::boolean,
    false,
    'a refresh of a list that is already current reports no change'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
    0,
    'a refresh that changed nothing writes no audit row'
);

-- A run gives A2 a label; a refresh has no labels of its own, so it must keep this one and its run.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
               'results', jsonb_build_object('unassigned', jsonb_build_array(
                   jsonb_build_object('teamId', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'reason', 'no-slot-available', 'target', 2)))),
           jsonb_build_array(
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a3', 'effective_date_range', '[2020-01-01,2020-02-01)', 'source', 'manual'),
               jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a2', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']'), 'source', 'manual'))) $$,
    'a save whose run labels A2 no-slot-available succeeds'
);
CREATE TEMP TABLE tbd_snap AS
    SELECT team_id, reason, run_id FROM public.schedule_tbd WHERE kind = 'practice';
SELECT results_eq(
    $$ SELECT reason, run_id IS NOT NULL FROM tbd_snap $$,
    $$ VALUES ('no-slot-available', true) $$,
    'the run''s label and the run are on the row'
);
SELECT is(
    (public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa') ->> 'changed')::boolean,
    false,
    'a second sync of the same roster reports no change'
);
SELECT results_eq(
    $$ SELECT team_id, reason, run_id FROM public.schedule_tbd WHERE kind = 'practice' $$,
    $$ SELECT team_id, reason, run_id FROM tbd_snap $$,
    'and it kept the label and the run'
);

-- The division now wants 3 a week: A1 is newly short, A2 now misses 2. The refresh lists both, keeps A2''s label.
RESET role;
UPDATE public.divisions SET practices_per_week = 3 WHERE id = 'a1111111-1111-1111-1111-1111111d0008';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa') ->> 'changed')::boolean,
    true,
    'a refresh after the roster''s needs changed reports the change'
);
SELECT results_eq(
    $$ SELECT t.name, s.missing_count::int, s.reason FROM public.schedule_tbd s JOIN public.teams t ON t.id = s.team_id
        WHERE s.kind = 'practice' ORDER BY t.name $$,
    $$ VALUES ('TBD A1', 1, 'not-scheduled-yet'), ('TBD A2', 2, 'no-slot-available') $$,
    'A1 is newly listed as not-scheduled-yet; A2 keeps its label with its new count'
);
SELECT results_eq(
    $$ SELECT run_id FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2' $$,
    $$ SELECT run_id FROM tbd_snap WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2' $$,
    'A2 keeps the run that labelled it'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
    1,
    'the refresh that changed the list wrote one audit row'
);
SELECT results_eq(
    $$ SELECT (metadata->>'before_rows')::int, (metadata->>'after_rows')::int, (metadata->>'added')::int,
              (metadata->>'removed')::int, (metadata->>'changed')::int, resource_type
         FROM public.audit_log WHERE action = 'schedule_tbd.refreshed' $$,
    $$ VALUES (1, 2, 1, 0, 1, 'season_settings') $$,
    'the audit row carries the before and after counts: one row added, one changed'
);
SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa');
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
    1,
    'refreshing again with nothing new adds no audit row'
);

-- Back to 2 a week: A1 drops off, A2 is missing 1 again with its label.
RESET role;
UPDATE public.divisions SET practices_per_week = 2 WHERE id = 'a1111111-1111-1111-1111-1111111d0008';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa');
SELECT results_eq(
    $$ SELECT team_id, reason, run_id FROM public.schedule_tbd WHERE kind = 'practice' $$,
    $$ SELECT team_id, reason, run_id FROM tbd_snap $$,
    'a team that is no longer short drops off, and the other is back as it was, label and run kept'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
    2,
    'the second change wrote its own audit row'
);

-- The labels-taking sync is not a client entry point: a direct call would replace the saved labels
-- (and the run) with no audit row.
SELECT throws_ok(
    $$ SELECT public.sync_schedule_tbd_practices('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', NULL, '[]') $$,
    '42501', NULL, 'a direct call to the practice sync is refused, even for the season''s own admin'
);
SELECT results_eq(
    $$ SELECT team_id, reason, run_id FROM public.schedule_tbd WHERE kind = 'practice' $$,
    $$ SELECT team_id, reason, run_id FROM tbd_snap $$,
    'and the refused call left the saved labels as they were'
);
SELECT throws_ok(
    $$ SELECT public.sync_schedule_tbd_practices('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', NULL, NULL) $$,
    '42501', NULL, 'nor with no labels at all (which would reset them): refresh_schedule_tbd_practices is the way to that'
);

-- Who may refresh
SELECT throws_ok(
    $$ SELECT public.refresh_schedule_tbd_practices(gen_random_uuid()) $$,
    '42501', NULL, 'a season that does not exist is refused like one that is not yours'
);
SELECT throws_ok(
    $$ SELECT public.refresh_schedule_tbd_practices(NULL) $$,
    '23502', NULL, 'a missing season is refused'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$ SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa') $$,
    '42501', NULL, 'another organization''s admin cannot refresh this season'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$ SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa') $$,
    '42501', NULL, 'a member of no organization cannot refresh it'
);
RESET role;
SELECT ok(
    NOT has_function_privilege('anon', 'public.refresh_schedule_tbd_practices(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb)', 'EXECUTE'),
    'anon can run neither function'
);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

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

-- ---- no client writes the table; the rows it holds belong to one organization and season ------------

RESET role;
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-1111111d0008', 'aaaaaaaa-0000-0000-0000-0000000000a1', 1, 'no-slot-available'),
              ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-1111111d0008', 'aaaaaaaa-0000-0000-0000-0000000000a1', 2, 'no-slot-available') $$,
    '23505', NULL, 'a team has one practice row (the unique index), whatever its count'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- The first draft let an admin insert through RLS: a row of their own organization naming another
-- organization's team. There is no INSERT policy or grant now.
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-11111111abcd', 'bbbbbbbb-0000-0000-0000-0000000000b8', 1, 'no-slot-available') $$,
    '42501', NULL, 'an admin cannot insert a row directly, whatever team it names'
);
SELECT throws_ok(
    $$ DELETE FROM public.schedule_tbd $$,
    '42501', NULL, 'an admin cannot delete a row directly'
);

-- The practice writer with another organization's team: refused, and nothing is listed for it.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           jsonb_build_array(jsonb_build_object('team_id', 'bbbbbbbb-0000-0000-0000-0000000000b8',
               'practice_slot_id', 'a1111111-1111-1111-1111-1111111500a1', 'effective_date_range', ('[' || (CURRENT_DATE - 30) || ',' || (CURRENT_DATE + 60) || ']')))) $$,
    '23503', NULL, 'the practice writer refuses another organization''s team (an admin cannot see it: it does not exist to them)'
);
-- The internal sync is not a client entry point (the guard speaks first; its own organization checks are
-- there for the practice save, which runs as the admin).
SELECT throws_ok(
    $$ SELECT public.sync_schedule_tbd_practices('a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222bbb', NULL, '[]') $$,
    '42501', NULL, 'a direct call to the practice sync for another organization''s season is refused'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$ SELECT public.sync_schedule_tbd_practices('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', NULL, '[]') $$,
    '42501', NULL, 'a direct call to the practice sync by another organization''s admin is refused'
);
RESET role;

-- Whoever writes it, a row that names another organization's team, division or season is refused.
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'a1111111-1111-1111-1111-11111111abcd', 'bbbbbbbb-0000-0000-0000-0000000000b8', 1, 'no-slot-available') $$,
    '23514', NULL, 'the tenancy trigger refuses another organization''s team'
);
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
               'b2222222-2222-2222-2222-22222222bcde', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'no-slot-available') $$,
    '23514', NULL, 'the tenancy trigger refuses another organization''s division'
);
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222bbb', 'practice',
               'a1111111-1111-1111-1111-11111111abcd', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'no-slot-available') $$,
    '23514', NULL, 'the tenancy trigger refuses another organization''s season'
);
SELECT throws_ok(
    $$ INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index, reason)
       VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'game',
               'a1111111-1111-1111-1111-11111111abcd', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b8', 1, 'no-slot-available') $$,
    '23514', NULL, 'the tenancy trigger refuses another organization''s away team'
);

-- The read does not lean on the trigger: with it off, a row naming another organization's team still
-- comes back without that team's name.
ALTER TABLE public.schedule_tbd DISABLE TRIGGER schedule_tbd_enforce_tenancy;
INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'practice',
        'a1111111-1111-1111-1111-11111111abcd', 'bbbbbbbb-0000-0000-0000-0000000000b8', 1, 'no-slot-available');
ALTER TABLE public.schedule_tbd ENABLE TRIGGER schedule_tbd_enforce_tenancy;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT ok(
    position('TBD Org B team' IN public.get_schedule_tbd('a1111111-1111-1111-1111-111111111aaa')::text) = 0,
    'get_schedule_tbd never returns another organization''s team name'
);
SELECT is(
    (SELECT e->>'team_name' FROM jsonb_array_elements(public.get_schedule_tbd('a1111111-1111-1111-1111-111111111aaa')) e
      WHERE e->>'team_id' = 'bbbbbbbb-0000-0000-0000-0000000000b8'),
    NULL,
    'a row that names another organization''s team comes back with a NULL team name'
);
RESET role;

-- ---- a season with no assignments at all: a run that placed nothing never reaches the practice save ----
-- (The poisoned row above is Org B's team under Org A, and a team has one practice row: clear it first.)
DELETE FROM public.schedule_tbd WHERE team_id = 'bbbbbbbb-0000-0000-0000-0000000000b8';
-- Org B's U8 wants 2 a week and nothing has been scheduled for it. The refresh lists the team in full.
UPDATE public.divisions SET practices_per_week = 2 WHERE id = 'b2222222-2222-2222-2222-2222222d0008';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(
    (public.refresh_schedule_tbd_practices('b2222222-2222-2222-2222-222222222bbb') ->> 'changed')::boolean,
    true,
    'a refresh on a season with no assignments reports the change'
);
SELECT results_eq(
    $$ SELECT t.name, s.missing_count::int, s.reason, (s.detail->>'held')::int
         FROM public.schedule_tbd s JOIN public.teams t ON t.id = s.team_id
        WHERE s.kind = 'practice' AND s.season_settings_id = 'b2222222-2222-2222-2222-222222222bbb'
          AND s.team_id = 'bbbbbbbb-0000-0000-0000-0000000000b8' $$,
    $$ VALUES ('TBD Org B team', 2, 'not-scheduled-yet', 0) $$,
    'every practice the roster needs is listed: both of the team''s, not scheduled yet'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
    1,
    'the change wrote one audit row, in this organization'
);
SELECT is(
    (public.refresh_schedule_tbd_practices('b2222222-2222-2222-2222-222222222bbb') ->> 'changed')::boolean,
    false,
    'a second refresh finds nothing new'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
    1,
    'and writes no second audit row'
);
RESET role;

-- ---- a team's held practices: concurrent coverage, not a count of rows ---------------------------------
-- The repair adapter splits a series in two (the old one closed, its successor from the retirement date).
-- The fragments never overlap; counting every unexpired row said two practices where the team has one.
-- U8 wants 2 a week. All dates are relative to today; the rows are written as the table owner, as the
-- repair does.
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD Split'),
    ('aaaaaaaa-0000-0000-0000-0000000000c2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD Concurrent'),
    ('aaaaaaaa-0000-0000-0000-0000000000c3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD Future'),
    ('aaaaaaaa-0000-0000-0000-0000000000c4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD Split Pair');
INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source) VALUES
    -- Split: one practice, closed ten days from now and continued from then.
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'a1111111-1111-1111-1111-1111111500a1',
        daterange(CURRENT_DATE - 30, CURRENT_DATE + 10, '[)'), 'auto'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'a1111111-1111-1111-1111-1111111500a1',
        daterange(CURRENT_DATE + 10, CURRENT_DATE + 60, '[]'), 'auto'),
    -- Two genuinely concurrent series: two practices.
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'a1111111-1111-1111-1111-1111111500a1',
        daterange(CURRENT_DATE - 30, CURRENT_DATE + 60, '[]'), 'auto'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'a1111111-1111-1111-1111-1111111500a2',
        daterange(CURRENT_DATE - 30, CURRENT_DATE + 60, '[]'), 'auto'),
    -- A series that has not started yet: it counts (one of two).
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c3', 'a1111111-1111-1111-1111-1111111500a1',
        daterange(CURRENT_DATE + 5, CURRENT_DATE + 60, '[]'), 'auto'),
    -- Two practices, one of them split: still two, so none missing.
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c4', 'a1111111-1111-1111-1111-1111111500a1',
        daterange(CURRENT_DATE - 30, CURRENT_DATE + 10, '[)'), 'auto'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c4', 'a1111111-1111-1111-1111-1111111500a1',
        daterange(CURRENT_DATE + 10, CURRENT_DATE + 60, '[]'), 'auto'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c4', 'a1111111-1111-1111-1111-1111111500a2',
        daterange(CURRENT_DATE - 30, CURRENT_DATE + 60, '[]'), 'auto');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa');
SELECT results_eq(
    $$ SELECT t.name, s.missing_count::int, (s.detail->>'held')::int
         FROM public.schedule_tbd s JOIN public.teams t ON t.id = s.team_id
        WHERE s.kind = 'practice' AND t.name LIKE 'TBD %' AND t.name IN ('TBD Split', 'TBD Concurrent', 'TBD Future', 'TBD Split Pair')
        ORDER BY t.name $$,
    $$ VALUES ('TBD Future', 1, 1), ('TBD Split', 1, 1) $$,
    'a split series at 2 a week lists one missing practice; a series not started yet counts; two concurrent series and a split pair list none'
);
SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd WHERE team_id IN
        ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-0000000000c4')),
    0,
    'two concurrent series (and a pair with one half split) hold their two practices: not listed'
);

-- ---- a caller with no user cannot refresh -----------------------------------------------------------
-- The refresh audits a change and an audit row needs an actor. A new team with nothing scheduled is what a
-- refresh WOULD list, so a refused call that left it unlisted is a call that wrote nothing.
RESET role;
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000c5', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0008', 'TBD Unlisted');
CREATE TEMP TABLE svc_before AS SELECT count(*)::int AS rows,
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed') AS audits FROM public.schedule_tbd;
SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';
SELECT throws_ok(
    $$ SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa') $$,
    '42501', 'refresh_schedule_tbd_practices needs a signed-in caller to audit a change',
    'a service-role call with no user is refused for want of a user to audit, before anything changes'
);
RESET role;
SELECT results_eq(
    $$ SELECT (SELECT count(*)::int FROM public.schedule_tbd),
              (SELECT count(*)::int FROM public.audit_log WHERE action = 'schedule_tbd.refreshed'),
              (SELECT count(*)::int FROM public.schedule_tbd WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000c5') $$,
    $$ SELECT rows, audits, 0 FROM svc_before $$,
    'and the refused call listed nothing and wrote no audit row'
);

SELECT * FROM finish();
ROLLBACK;
