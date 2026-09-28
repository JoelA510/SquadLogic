-- pgTAP: persist_practice_schedule v3 (8.6 PR 3b PR 6, lock-by-default).
-- The plan §6 witnesses for PR 6, under a real Supabase JWT. The harness
-- smoke docs/sql/20260929000000_smoke.sql carries the same witnesses with
-- their plants; this file runs them against the Supabase auth stack in CI.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(15);

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
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
VALUES
    ('a1111111-1111-1111-1111-0000000066a1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30'),
    ('a1111111-1111-1111-1111-0000000066a2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000066f1', 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30');
INSERT INTO public.practice_assignments (id, organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
VALUES ('a1111111-1111-1111-1111-000000006609', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000066e9', 'a1111111-1111-1111-1111-0000000066a1',
        'a1111111-1111-1111-1111-0000000066a1', '[2026-09-01,2026-11-30]', 'auto');

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

-- 2. A new row overlapping one its team still holds.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p FROM v3_payload) || jsonb_build_array(jsonb_build_object(
               'team_id', 'a1111111-1111-1111-1111-0000000066e1',
               'practice_slot_id', 'a1111111-1111-1111-1111-0000000066a2',
               'effective_date_range', '[2026-10-01,2026-11-30]'))) $$,
    '22023', NULL,
    'a new row overlapping an existing row of the same team is refused as locked');

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

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p FROM v3_payload),
           unlock => jsonb_build_array(jsonb_build_object(
               'assignment_id', 'a1111111-1111-1111-1111-000000006609', 'reason', 'coach'))) $$,
    '42501', NULL,
    'a coach''s unlock is refused 42501');
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
           (SELECT p FROM v3_payload)) $$,
    '42501', NULL,
    'a non-admin ordinary save is refused 42501');

SELECT * FROM finish();
ROLLBACK;
