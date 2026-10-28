-- pgTAP: persist_practice_schedule v3 (8.6 PR 3b PR 6, lock-by-default).
-- The plan §6 witnesses for PR 6, under a real Supabase JWT. The harness
-- smoke docs/sql/20260929000000_smoke.sql carries the same witnesses with
-- their plants; this file runs them against the Supabase auth stack in CI.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(28);

-- Org A: a season with two teams, a second season with one, three slots.
INSERT INTO public.season_settings (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-0000000066b2', 'a1111111-1111-1111-1111-111111111111', 'V3 Spring');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
VALUES
    ('a1111111-1111-1111-1111-0000000066d1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111aaa', 'V3 U10'),
    ('a1111111-1111-1111-1111-0000000066d2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066b2', 'V3 U12');
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('a1111111-1111-1111-1111-0000000066e1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066d1', 'V3 Team 1'),
    ('a1111111-1111-1111-1111-0000000066e2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066d1', 'V3 Team 2'),
    ('a1111111-1111-1111-1111-0000000066e9', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066d2', 'V3 Team 9');
INSERT INTO public.locations (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-0000000066f0', 'a1111111-1111-1111-1111-111111111111', 'V3 Park');
INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES ('a1111111-1111-1111-1111-0000000066f1', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000066f0', 'V3 Pitch');
-- Capacity 3: the first slot holds Team 9's row and the two Teams 1 and 2 are given below, and the
-- writer (20261105010000) refuses a new auto row that takes a slot past its capacity.
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity)
VALUES
    ('a1111111-1111-1111-1111-0000000066a1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30', 3),
    ('a1111111-1111-1111-1111-0000000066a2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30', 3),
    ('a1111111-1111-1111-1111-0000000066a3', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'mon', '17:30', '18:30', '2026-09-01', '2026-11-30', 3);
INSERT INTO public.practice_assignments (id, organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
VALUES ('a1111111-1111-1111-1111-000000006609', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000066e9', 'a1111111-1111-1111-1111-0000000066a1',
        'a1111111-1111-1111-1111-0000000066a1', '[2026-09-01,2026-11-30]', 'auto');

-- The writer gate (20261105010000): a season of its own, so the gate's saves do not meet the lock
-- tests' rows. Two divisions: U8 plays 2 practices a week of 60 minutes, U9 plays 1 (any length).
INSERT INTO public.season_settings (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-0000000066b3', 'a1111111-1111-1111-1111-111111111111', 'V3 Gate');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, practices_per_week, practice_minutes)
VALUES
    ('a1111111-1111-1111-1111-0000000066c1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066b3', 'V3 Gate U8', 2, 60),
    ('a1111111-1111-1111-1111-0000000066c2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066b3', 'V3 Gate U9', 1, NULL);
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('a1111111-1111-1111-1111-000000006601', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066c1', 'Gate U8 One'),
    ('a1111111-1111-1111-1111-000000006602', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066c1', 'Gate U8 Two'),
    ('a1111111-1111-1111-1111-000000006603', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066c2', 'Gate U9 Three'),
    ('a1111111-1111-1111-1111-000000006604', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066c2', 'Gate U9 Four');
-- Capacity 1 each. a4 Mon 17:00-18:00, a5 Wed 17:00-18:00, a6 Mon 18:15-19:15 (a second Monday slot),
-- a7 Tue 17:00-17:45 (45 minutes), a8 Thu 17:00-18:00 reserved to U9, a9 Fri 17:00-18:00.
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity, division_id)
VALUES
    ('a1111111-1111-1111-1111-0000000066a4', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066a5', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066a6', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'mon', '18:15', '19:15', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066a7', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'tue', '17:00', '17:45', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066a8', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'thu', '17:00', '18:00', '2026-09-01', '2026-11-30', 1,
     'a1111111-1111-1111-1111-0000000066c2'),
    ('a1111111-1111-1111-1111-0000000066a9', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'fri', '17:00', '18:00', '2026-09-01', '2026-11-30', 1, NULL);

-- Two more U9 teams (1 a week): Five holds a manual row with NO date range on a Saturday slot of
-- capacity 1 (a NULL range is the slot's whole validity, as the solver reads it); Six is the team the
-- week-count tests save for. 66aa Sat 10:00-11:00, 66ab Sun 12:00-13:00, 66ac Mon 12:00-13:00,
-- 66ad Wed 12:00-13:00: all capacity 1, valid 2026-09-01 to 2026-11-30.
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('a1111111-1111-1111-1111-000000006605', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066c2', 'Gate U9 Five'),
    ('a1111111-1111-1111-1111-000000006606', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066c2', 'Gate U9 Six');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity, division_id)
VALUES
    ('a1111111-1111-1111-1111-0000000066aa', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'sat', '10:00', '11:00', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066ab', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'sun', '12:00', '13:00', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066ac', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'mon', '12:00', '13:00', '2026-09-01', '2026-11-30', 1, NULL),
    ('a1111111-1111-1111-1111-0000000066ad', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'wed', '12:00', '13:00', '2026-09-01', '2026-11-30', 1, NULL);
INSERT INTO public.practice_assignments (id, organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
VALUES ('a1111111-1111-1111-1111-00000000660a', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-000000006605', 'a1111111-1111-1111-1111-0000000066aa',
        'a1111111-1111-1111-1111-0000000066aa', NULL, 'manual');

CREATE TEMP TABLE v3_payload ON COMMIT DROP AS
SELECT jsonb_build_array(
    jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000066e1',
                       'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a1',
                       'effective_date_range', '[2026-09-01,2026-11-30]'),
    jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000066e2',
                       'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a1',
                       'effective_date_range', '[2026-09-01,2026-11-30]')) AS p;
GRANT SELECT ON v3_payload TO authenticated;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT public.persist_practice_schedule(
    jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
    (SELECT p FROM v3_payload));

-- 1. The lock: Team 2 left out (its auto row would be pruned).
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p - 1 FROM v3_payload)) $$,
    '22023', NULL,
    'an ordinary save omitting an existing row is refused as locked');

-- 2. A new row that double-books its team (same weekday, overlapping minutes).
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p FROM v3_payload) || jsonb_build_array(jsonb_build_object(
               'team_id', 'a1111111-1111-1111-1111-0000000066e1',
               'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a3',
               'effective_date_range', '[2026-10-01,2026-11-30]'))) $$,
    '22023', NULL,
    'a new row clashing in time with an existing row of the same team is refused as locked');

-- 3. A stale fingerprint.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p FROM v3_payload), base_fingerprint => md5('stale')) $$,
    '40001', NULL,
    'a stale base_fingerprint is refused with 40001');

-- 4. A split keeps the id.
SELECT public.persist_practice_schedule(
    jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
    (SELECT (p - 0) || jsonb_build_array(jsonb_build_object(
        'team_id', 'a1111111-1111-1111-1111-0000000066e1',
        'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a2',
        'effective_date_range', '[2026-10-15,2026-11-30]')) FROM v3_payload),
    unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'retired'))
                 FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e1'),
    closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-14'))
                 FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e1'));
SELECT is(
    (SELECT effective_date_range::text FROM public.practice_assignments
      WHERE team_id = 'a1111111-1111-1111-1111-0000000066e1'
        AND practice_slot_id = 'a1111111-1111-1111-1111-0000000066a1'),
    '[2026-09-01,2026-10-15)',
    'closes shortens the row in place, keeping its (team, slot) and id');

-- 5. Unlock is per row: Team 1 left out, only its closed row unlocked.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p - 0 FROM v3_payload),
           unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'old half'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-0000000066e1'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000066a1')) $$,
    '22023', NULL,
    'unlocking one of a team''s two rows leaves the other locked');

-- 6. Unlock is audited with the before-image.
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE action = 'practice.unlock_accepted'
        AND organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND metadata->'before'->>'effective_date_range' = '[2026-09-01,2026-12-01)'),
    1,
    'the accepted unlock left one practice.unlock_accepted row with the before-image');

-- 7. An exception is its own row and survives a later ordinary save.
SELECT public.persist_practice_schedule(
    jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
    (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                         'effective_date_range', effective_date_range::text))
       FROM public.practice_assignments
      WHERE team_id IN ('a1111111-1111-1111-1111-0000000066e1', 'a1111111-1111-1111-1111-0000000066e2')),
    exceptions => (SELECT jsonb_build_array(jsonb_build_object(
        'assignment_id', id, 'window', '[2026-10-05,2026-10-11]', 'kind', 'time_tbd',
        'tbd_reason', 'contended', 'cause_kind', 'blackout'))
        FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e2'));
SELECT is(
    (public.persist_practice_schedule(
        jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
        (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                             'effective_date_range', effective_date_range::text))
           FROM public.practice_assignments
          WHERE team_id IN ('a1111111-1111-1111-1111-0000000066e1', 'a1111111-1111-1111-1111-0000000066e2')))
     ->'teams_time_tbd'->0->>'team_name'),
    'V3 Team 2',
    'teams_time_tbd names the roster team holding a live TIME TBD window');
SELECT is(
    (SELECT count(*)::int FROM public.practice_exceptions
      WHERE team_id = 'a1111111-1111-1111-1111-0000000066e2' AND withdrawn_at IS NULL),
    1,
    'the exception survives a later ordinary save, in practice_exceptions');
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments
      WHERE team_id = 'a1111111-1111-1111-1111-0000000066e2'),
    1,
    'the exception is not stored as a second assignment row');

-- 8. Deleting an overridden series is loud; cancelling withdraws, audited.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                                'effective_date_range', effective_date_range::text))
              FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e1'),
           unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'drop'))
                        FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e2')) $$,
    '23503', NULL,
    'the unlocked prune of a series holding a live exception is refused 23503');
SELECT lives_ok(
    $$ SELECT public.admin_cancel_practice_assignment(
           (SELECT id FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e2')) $$,
    'an admin cancels the overridden series');
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE action = 'practice.exception_withdrawn' AND metadata->>'reason' = 'assignment_cancelled'
        AND organization_id = 'a1111111-1111-1111-1111-111111111111'),
    1,
    'cancelling withdrew the exception in the same transaction, audited');

-- ---- the writer gate (20261105010000): a new auto row must keep what SQL can check -------------
-- Each refusal is its own save in the empty gate season, so each names its rule and none depends on
-- another's rows (a refused save rolls back to its subtransaction).
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006603',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006604',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    '%capacity%',
    'a save putting two new auto rows in a slot of capacity 1 is refused, naming capacity');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                                'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a8',
                                                'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    '%reservation%',
    'a new auto row in a slot reserved to another division is refused, naming the reservation');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                                'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a7',
                                                'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    '%length%',
    'a new auto row in a 45-minute slot for a 60-minute division is refused, naming the length');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a6',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    '%weekday%',
    'two new auto rows of one team on one weekday (at different times) are refused, naming the weekday');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a5',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a9',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    '%count%',
    'a third new auto row for a team whose division has 2 a week is refused, naming the count');

-- The saved manual row of Five has no date range: it holds the Saturday slot (capacity 1) for its whole
-- validity, so a new auto row there is over capacity.
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006606',
                                                'practice_slot_id', 'a1111111-1111-1111-1111-0000000066aa',
                                                'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    '%capacity%',
    'a new auto row in a slot a saved NULL-range manual row holds is refused, naming the capacity');
-- A division of 1 a week: a Monday and a Wednesday row that cover the same single week
-- ([2026-11-23,2026-11-30)) share no date, and are two practices in that week.
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006606',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066ac',
                                  'effective_date_range', '[2026-11-23,2026-11-30)'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006606',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066ad',
                                  'effective_date_range', '[2026-11-23,2026-11-30)'))) $$,
    '%count%',
    'a Monday and a Wednesday row of one week for a division of 1 a week are refused, naming the count');

-- A save that keeps every rule is accepted: U8 One on Monday and Wednesday (60 minutes each, two
-- weekdays), U9 Three on U9's reserved Thursday slot.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006601',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a5',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006603',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a8',
                                  'effective_date_range', '[2026-09-01,2026-11-30]'))) $$,
    'a save that keeps capacity, reservation, length, weekday and count is accepted');

-- The same breaking rows, sent as manual or as an override, keep today's checks and are accepted;
-- and the auto rows already saved, now over capacity beside them, are not judged again.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                                'effective_date_range', effective_date_range::text))
              FROM public.practice_assignments
             WHERE team_id IN ('a1111111-1111-1111-1111-000000006601', 'a1111111-1111-1111-1111-000000006603'))
           || jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006604',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006602',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a4',
                                  'effective_date_range', '[2026-09-01,2026-11-30]', 'assigned_via', 'override'))) $$,
    'the same capacity breach as a manual row and as an override row is accepted: they keep today''s checks');
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                                'effective_date_range', effective_date_range::text,
                                                'source', source::text, 'assigned_via', assigned_via))
              FROM public.practice_assignments
             WHERE team_id IN ('a1111111-1111-1111-1111-000000006601', 'a1111111-1111-1111-1111-000000006602',
                               'a1111111-1111-1111-1111-000000006603', 'a1111111-1111-1111-1111-000000006604'))) $$,
    'saving the schedule again, with an auto row now over capacity, is accepted: a row that exists is not judged');
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments
      WHERE team_id IN ('a1111111-1111-1111-1111-000000006601', 'a1111111-1111-1111-1111-000000006602',
                        'a1111111-1111-1111-1111-000000006603', 'a1111111-1111-1111-1111-000000006604')),
    5,
    'the gate season holds the 3 accepted auto rows and the 2 manual and override rows');
-- Short windows on either side of a week boundary: a Sunday (2026-11-22, the week of the 16th) and the
-- next Monday (2026-11-23, the week of the 23rd) are adjacent days in two scheduling weeks, so a
-- division of 1 a week accepts both.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-0000000066b3'),
           (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                                'effective_date_range', effective_date_range::text,
                                                'source', source::text, 'assigned_via', assigned_via))
              FROM public.practice_assignments
             WHERE team_id NOT IN ('a1111111-1111-1111-1111-000000006605',
                                   'a1111111-1111-1111-1111-000000006606')
               AND team_id IN (SELECT t.id FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
                                WHERE d.season_settings_id = 'a1111111-1111-1111-1111-0000000066b3'))
           || jsonb_build_array(
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006606',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066ab',
                                  'effective_date_range', '[2026-11-22,2026-11-23)'),
               jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000006606',
                                  'practice_slot_id', 'a1111111-1111-1111-1111-0000000066ac',
                                  'effective_date_range', '[2026-11-23,2026-11-24)'))) $$,
    'a Sunday and the next Monday, in two scheduling weeks, are accepted for a division of 1 a week');

-- 9. Scope and admin controls.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT jsonb_agg(jsonb_build_object('team_id', team_id, 'practice_slot_id', practice_slot_id,
                                                'effective_date_range', effective_date_range::text))
              FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000066e1'),
           closes => jsonb_build_array(jsonb_build_object(
               'assignment_id', 'a1111111-1111-1111-1111-000000006609', 'last_day', '2026-10-01'))) $$,
    '42501', NULL,
    'closes naming another season''s row is refused 42501');

-- No member is a non-admin any more (organization_members_role_check admits admin, staff and
-- tenant_admin, all admins, since 20261104010000), so the writer's refusals are the ones a user who
-- is not an admin of the season's organization can reach: Charlie, signed in with no membership,
-- and Bob, an admin of another organization.

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                              'organization_id', 'a1111111-1111-1111-1111-111111111111'),
           (SELECT p FROM v3_payload),
           unlock => jsonb_build_array(jsonb_build_object(
               'assignment_id', 'a1111111-1111-1111-1111-000000006609', 'reason', 'coach'))) $$,
    '42501', NULL,
    'a signed-in non-member''s unlock is refused 42501');
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                              'organization_id', 'a1111111-1111-1111-1111-111111111111'),
           (SELECT p FROM v3_payload)) $$,
    '42501', NULL,
    'a signed-in non-member''s ordinary save is refused 42501');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                              'organization_id', 'a1111111-1111-1111-1111-111111111111'),
           (SELECT p FROM v3_payload),
           unlock => jsonb_build_array(jsonb_build_object(
               'assignment_id', 'a1111111-1111-1111-1111-000000006609', 'reason', 'coach'))) $$,
    '42501', NULL,
    'another organization''s admin''s unlock is refused 42501');

SELECT * FROM finish();
ROLLBACK;
