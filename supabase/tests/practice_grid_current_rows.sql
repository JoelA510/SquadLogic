-- pgTAP: the scheduling grid's save, built from the season's CURRENT rows.
--
-- The #530 follow-up. The grid (`PracticeSchedulingPage`) used to stage a
-- manual override on top of the LATEST run's rows. Writer v3 keeps live rows
-- under older run ids, so that payload left them out. The grid now reads every
-- current row of the season (`loadSeasonPracticeRows`) and sends them back
-- unchanged, without `unlock` or `closes`. This file runs the real writer
-- (`persist_practice_schedule`, 20261002000000) on both shapes and proves:
--
--   * the new payload is ACCEPTED, changes no range, deletes, closes and
--     unlocks nothing, and only re-stamps run ids;
--   * after a re-home, the OLD payload (latest-run rows only) is refused 22023
--     "is locked". After a save that left teams out it is accepted, because
--     the writer keeps a missing team's manual rows. It re-stamps nothing
--     there, which is how the new payload is told apart.
--
-- Both shapes are built through the writer itself, never by direct INSERT.
-- Payload rows use the page's inclusive `[first,last]` range text
-- (`buildPracticeAssignmentRows`), not the stored `[)` form.
-- The JS twin of this witness is `tests/gridCurrentPracticeRows.test.jsx`.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(51);

-- Org A: two fresh seasons, one per shape, four teams each, five slots.
INSERT INTO public.season_settings (id, organization_id, name)
VALUES
    ('a1111111-1111-1111-1111-0000000077b1', 'a1111111-1111-1111-1111-111111111111', 'Grid Enact'),
    ('a1111111-1111-1111-1111-0000000077b2', 'a1111111-1111-1111-1111-111111111111', 'Grid Retained');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
VALUES
    ('a1111111-1111-1111-1111-0000000077d1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077b1', 'Grid U10'),
    ('a1111111-1111-1111-1111-0000000077d2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077b2', 'Grid U12');
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('a1111111-1111-1111-1111-0000000077e1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d1', 'Grid E Team A'),
    ('a1111111-1111-1111-1111-0000000077e2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d1', 'Grid E Team B'),
    ('a1111111-1111-1111-1111-0000000077e3', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d1', 'Grid E Team C'),
    ('a1111111-1111-1111-1111-0000000077e4', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d1', 'Grid E Team D'),
    ('a1111111-1111-1111-1111-0000000077f1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d2', 'Grid R Team A'),
    ('a1111111-1111-1111-1111-0000000077f2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d2', 'Grid R Team B'),
    ('a1111111-1111-1111-1111-0000000077f3', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d2', 'Grid R Team C'),
    ('a1111111-1111-1111-1111-0000000077f4', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d2', 'Grid R Team D');
INSERT INTO public.locations (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-000000007770', 'a1111111-1111-1111-1111-111111111111', 'Grid Park');
INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES ('a1111111-1111-1111-1111-000000007771', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-000000007770', 'Grid Pitch');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
VALUES
    ('a1111111-1111-1111-1111-0000000077a1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-000000007771', 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30'),
    ('a1111111-1111-1111-1111-0000000077a2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-000000007771', 'tue', '17:00', '18:00', '2026-09-01', '2026-11-30'),
    ('a1111111-1111-1111-1111-0000000077a3', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-000000007771', 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30'),
    ('a1111111-1111-1111-1111-0000000077a4', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-000000007771', 'thu', '17:00', '18:00', '2026-09-01', '2026-11-30'),
    ('a1111111-1111-1111-1111-0000000077a5', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-000000007771', 'fri', '17:00', '18:00', '2026-09-01', '2026-11-30');

-- Shape 3 (the override prompt, docs/PLAN_GRID_OVERRIDE_PROMPT.md W8): a third
-- season. Team G practises on two weekdays; Team H has a closed series and a
-- current one; Team I is never touched.
INSERT INTO public.season_settings (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-0000000077b3', 'a1111111-1111-1111-1111-111111111111', 'Grid Override');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
VALUES ('a1111111-1111-1111-1111-0000000077d3', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000077b3', 'Grid U14');
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('a1111111-1111-1111-1111-000000007781', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d3', 'Grid O Team G'),
    ('a1111111-1111-1111-1111-000000007782', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d3', 'Grid O Team H'),
    ('a1111111-1111-1111-1111-000000007783', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000077d3', 'Grid O Team I');

-- The grid's payload: the season's current rows as the page sends them,
-- `[first,last]` inclusive, with their source. `p_only_run` limits it to one
-- run's rows, which is the OLD, latest-run read.
CREATE FUNCTION pg_temp.grid_rows(p_season uuid, p_only_run uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'team_id', pa.team_id,
               'practice_slot_id', pa.practice_slot_id,
               'effective_date_range',
                   '[' || lower(pa.effective_date_range) || ',' || (upper(pa.effective_date_range) - 1) || ']',
               'source', pa.source) ORDER BY pa.id), '[]'::jsonb)
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE d.season_settings_id = p_season
       AND (p_only_run IS NULL OR pa.run_id = p_only_run)
$$;

-- The grid's payload for a manual override of `p_team` into `p_slot`: every
-- other team's current rows, the staged row, and -- with `p_keep_closed` --
-- the team's CLOSED series (ending before another of its series starts: the
-- rule `handleStageManualAssignment` applies). Without it this is the shape
-- the first-row replace sent: the team's every row dropped.
CREATE FUNCTION pg_temp.grid_override(p_season uuid, p_team uuid, p_slot uuid, p_keep_closed boolean)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'team_id', pa.team_id,
               'practice_slot_id', pa.practice_slot_id,
               'effective_date_range',
                   '[' || lower(pa.effective_date_range) || ',' || (upper(pa.effective_date_range) - 1) || ']',
               'source', pa.source) ORDER BY pa.id), '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object(
               'team_id', p_team, 'practice_slot_id', p_slot,
               'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'))
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE d.season_settings_id = p_season
       AND (pa.team_id <> p_team
            OR (p_keep_closed
                AND upper(pa.effective_date_range) <= (
                    SELECT max(lower(x.effective_date_range))
                      FROM public.practice_assignments x
                     WHERE x.team_id = p_team)))
$$;

-- The grid's override payload since #546 (operator decision): as
-- `grid_override`, but the staged row starts on `p_today` -- the page's
-- `newPlacementRange` -- because the replaced series is closed on yesterday
-- through `closes`, never deleted. The writer has no clock, so "today" is the
-- page's, passed in.
CREATE FUNCTION pg_temp.grid_override_today(p_season uuid, p_team uuid, p_slot uuid, p_today date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(r) FILTER (WHERE r->>'team_id' <> p_team::text
                                            OR r->>'practice_slot_id' <> p_slot::text), '[]'::jsonb)
           || jsonb_build_array(jsonb_build_object(
               'team_id', p_team, 'practice_slot_id', p_slot,
               'effective_date_range', '[' || p_today || ',2026-11-30]', 'source', 'manual'))
      FROM jsonb_array_elements(pg_temp.grid_override(p_season, p_team, p_slot, true)) r
$$;

-- What a save returned, and the rows as they stood before it.
CREATE TEMP TABLE grid_results (label text PRIMARY KEY, r jsonb) ON COMMIT DROP;
CREATE TEMP TABLE grid_before (label text, id uuid, practice_slot_id uuid, effective_date_range daterange)
    ON COMMIT DROP;
GRANT SELECT, INSERT ON grid_results TO authenticated;
GRANT SELECT, INSERT ON grid_before TO authenticated;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ===========================================================================
-- Shape 1: a re-home. Run c1 places A (mon), B (tue) and C (wed). Run c2 is
-- the re-home: A's Monday series is unlocked and closed the day before the
-- loss and is NOT re-sent, A gets a Thursday series, B and C are re-sent.
-- ===========================================================================
SELECT public.persist_practice_schedule(
    jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c1',
                       'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
    jsonb_build_array(
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077e1',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a1',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077e2',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a2',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077e3',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a3',
                           'effective_date_range', '[2026-09-01,2026-11-30]')));

SELECT public.persist_practice_schedule(
    jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c2',
                       'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
    jsonb_build_array(
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077e1',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a4',
                           'effective_date_range', '[2026-10-12,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077e2',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a2',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077e3',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a3',
                           'effective_date_range', '[2026-09-01,2026-11-30]')),
    unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'loss on 2026-10-12'))
                 FROM public.practice_assignments
                WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'),
    closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-11'))
                 FROM public.practice_assignments
                WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'));

-- 1-2. The shape is real: the closed series is live under the OLDER run, and
-- a latest-run read cannot see it (meta: without it nothing below bites).
SELECT is(
    (SELECT run_id::text || ' ' || effective_date_range::text FROM public.practice_assignments
      WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'
        AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a1'),
    'a1111111-1111-1111-1111-0000000077c1 [2026-09-01,2026-10-12)',
    'enact shape: the closed pre-loss series stays live, shortened, under the older run');
SELECT is(
    jsonb_array_length(pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b1', NULL))
      - jsonb_array_length(pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b1',
                                             'a1111111-1111-1111-1111-0000000077c2')),
    1,
    'enact shape: a latest-run read misses exactly one live row');

-- 3-4. The OLD payload (latest-run rows, plus a staged Team D) is refused.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c3',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b1',
                             'a1111111-1111-1111-1111-0000000077c2')
             || jsonb_build_array(jsonb_build_object(
                    'team_id', 'a1111111-1111-1111-1111-0000000077e4',
                    'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a5',
                    'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'))) $$,
    '22023', NULL,
    'enact shape: the old latest-run payload is refused 22023');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c3',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b1',
                             'a1111111-1111-1111-1111-0000000077c2')
             || jsonb_build_array(jsonb_build_object(
                    'team_id', 'a1111111-1111-1111-1111-0000000077e4',
                    'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a5',
                    'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'))) $$,
    '%is locked%',
    'enact shape: ... as "is locked", over the closed series it no longer carries');

-- 5. The NEW payload (every current row, plus the staged Team D) is accepted.
INSERT INTO grid_before
SELECT 'enact', pa.id, pa.practice_slot_id, pa.effective_date_range
  FROM public.practice_assignments pa
 WHERE pa.team_id IN ('a1111111-1111-1111-1111-0000000077e1', 'a1111111-1111-1111-1111-0000000077e2',
                      'a1111111-1111-1111-1111-0000000077e3', 'a1111111-1111-1111-1111-0000000077e4');
SELECT lives_ok(
    $$ INSERT INTO grid_results
       SELECT 'enact', public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c3',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b1', NULL)
             || jsonb_build_array(jsonb_build_object(
                    'team_id', 'a1111111-1111-1111-1111-0000000077e4',
                    'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a5',
                    'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'))) $$,
    'enact shape: the new current-rows payload is accepted with no unlock or closes');

-- 6-8. It removed, closed and unlocked nothing.
SELECT is((SELECT (r->>'superseded_count')::int FROM grid_results WHERE label = 'enact'), 0,
          'enact shape: nothing superseded');
SELECT is((SELECT jsonb_array_length(r->'closed') FROM grid_results WHERE label = 'enact'), 0,
          'enact shape: nothing closed');
SELECT is((SELECT jsonb_array_length(r->'unlocked') FROM grid_results WHERE label = 'enact'), 0,
          'enact shape: nothing unlocked');

-- 9. Every prior row survives by id with its slot and range unchanged.
SELECT is(
    (SELECT count(*)::int FROM grid_before b
       LEFT JOIN public.practice_assignments pa
         ON pa.id = b.id AND pa.practice_slot_id = b.practice_slot_id
        AND pa.effective_date_range = b.effective_date_range
      WHERE b.label = 'enact' AND pa.id IS NULL),
    0,
    'enact shape: every prior row keeps its id, slot and range');
-- 10. The prior set was what the meta says it was (meta: 9 is not vacuous).
SELECT is((SELECT count(*)::int FROM grid_before WHERE label = 'enact'), 4,
          'enact shape: four prior rows were checked (closed A, new A, B, C)');
-- 11. The only addition is Team D's staged row.
SELECT is(
    (SELECT string_agg(team_id::text, ',') FROM public.practice_assignments pa
      WHERE pa.team_id IN ('a1111111-1111-1111-1111-0000000077e1', 'a1111111-1111-1111-1111-0000000077e2',
                           'a1111111-1111-1111-1111-0000000077e3', 'a1111111-1111-1111-1111-0000000077e4')
        AND pa.id NOT IN (SELECT id FROM grid_before WHERE label = 'enact')),
    'a1111111-1111-1111-1111-0000000077e4',
    'enact shape: the only new row is the staged Team D');
-- 12. Run ids are re-stamped: every row of the season is now under c3.
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments pa
       JOIN public.teams t ON t.id = pa.team_id
      WHERE t.division_id = 'a1111111-1111-1111-1111-0000000077d1'
        AND pa.run_id IS DISTINCT FROM 'a1111111-1111-1111-1111-0000000077c3'),
    0,
    'enact shape: the save re-stamps every carried row with its run id');
-- 13. No unlock or supersede audit row names this save.
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE action IN ('practice.unlock_accepted', 'practice.superseded')
        AND metadata->>'run_id' = 'a1111111-1111-1111-1111-0000000077c3'),
    0,
    'enact shape: no unlock or supersede audit for the save');

-- 13a-13h. A manual override of the re-homed Team A (into Friday). It
-- replaces A's CURRENT series (Thursday) and keeps its CLOSED one (Monday).
-- Every assigned row is locked (ruling 2), so replacing Thursday needs that
-- row in `unlock`; the closed series must never need to be.
INSERT INTO grid_before
SELECT 'override', pa.id, pa.practice_slot_id, pa.effective_date_range
  FROM public.practice_assignments pa
 WHERE pa.team_id = 'a1111111-1111-1111-1111-0000000077e1'
   AND pa.practice_slot_id = 'a1111111-1111-1111-1111-0000000077a1';
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c4',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_override('a1111111-1111-1111-1111-0000000077b1',
                                 'a1111111-1111-1111-1111-0000000077e1',
                                 'a1111111-1111-1111-1111-0000000077a5', true)) $$,
    '22023', NULL,
    'override: with no unlock, replacing the locked current series is refused 22023');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c4',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_override('a1111111-1111-1111-1111-0000000077b1',
                                 'a1111111-1111-1111-1111-0000000077e1',
                                 'a1111111-1111-1111-1111-0000000077a5', true)) $$,
    '%assignment ' || (SELECT id::text FROM public.practice_assignments
                        WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'
                          AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a4')
        || ' is locked%',
    'override: ... and the refusal names the CURRENT series, not the closed one');
-- The first-row shape (closed series dropped) is refused over the CLOSED
-- series even with the current one unlocked: the defect, witnessed.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c4',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_override('a1111111-1111-1111-1111-0000000077b1',
                                 'a1111111-1111-1111-1111-0000000077e1',
                                 'a1111111-1111-1111-1111-0000000077a5', false),
           unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'override'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a4')) $$,
    '22023', NULL,
    'override, first-row shape: dropping the closed series is refused 22023');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c4',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_override('a1111111-1111-1111-1111-0000000077b1',
                                 'a1111111-1111-1111-1111-0000000077e1',
                                 'a1111111-1111-1111-1111-0000000077a5', false),
           unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'override'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a4')) $$,
    '%assignment ' || (SELECT id::text FROM grid_before WHERE label = 'override') || ' is locked%',
    'override, first-row shape: ... naming the closed series');
-- The fixed shape, with the current series unlocked, is accepted.
SELECT lives_ok(
    $$ INSERT INTO grid_results
       SELECT 'override', public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c4',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b1'),
           pg_temp.grid_override('a1111111-1111-1111-1111-0000000077b1',
                                 'a1111111-1111-1111-1111-0000000077e1',
                                 'a1111111-1111-1111-1111-0000000077a5', true),
           unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'override'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a4')) $$,
    'override: keeping the closed series and unlocking the current one is accepted');
SELECT is(
    (SELECT count(*)::int FROM grid_before b
       JOIN public.practice_assignments pa
         ON pa.id = b.id AND pa.practice_slot_id = b.practice_slot_id
        AND pa.effective_date_range = b.effective_date_range
        AND pa.source = 'auto'
      WHERE b.label = 'override'),
    1,
    'override: the closed series keeps its id, slot, range and source');
SELECT is(
    (SELECT jsonb_agg(s->>'practice_slot_id') FROM grid_results, jsonb_array_elements(r->'superseded') s
      WHERE label = 'override'),
    jsonb_build_array('a1111111-1111-1111-1111-0000000077a4'),
    'override: the only row removed is the replaced current (Thursday) series');
SELECT is(
    (SELECT string_agg(practice_slot_id::text, ',' ORDER BY practice_slot_id)
       FROM public.practice_assignments
      WHERE team_id = 'a1111111-1111-1111-1111-0000000077e1'),
    'a1111111-1111-1111-1111-0000000077a1,a1111111-1111-1111-1111-0000000077a5',
    'override: Team A now holds its closed Monday series and the Friday override');

-- ===========================================================================
-- Shape 2: a save that left teams out. Run c5 places A (auto), B and C
-- (manual). Run c6 names A only: B's and C's manual rows are retained under c5.
-- ===========================================================================
SELECT public.persist_practice_schedule(
    jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c5',
                       'season_settings_id', 'a1111111-1111-1111-1111-0000000077b2'),
    jsonb_build_array(
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077f1',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a1',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077f2',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a2',
                           'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077f3',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a3',
                           'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual')));
SELECT public.persist_practice_schedule(
    jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c6',
                       'season_settings_id', 'a1111111-1111-1111-1111-0000000077b2'),
    jsonb_build_array(
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-0000000077f1',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a1',
                           'effective_date_range', '[2026-09-01,2026-11-30]')));

-- 14. The shape is real (meta).
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments
      WHERE team_id IN ('a1111111-1111-1111-1111-0000000077f2', 'a1111111-1111-1111-1111-0000000077f3')
        AND source = 'manual' AND run_id = 'a1111111-1111-1111-1111-0000000077c5'),
    2,
    'retained shape: B''s and C''s manual rows stay live under the older run');

-- 15-16. The OLD payload is NOT refused here: the writer keeps an absent
-- team's manual rows. It leaves them un-stamped, under the older run.
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c7',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b2'),
           pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b2',
                             'a1111111-1111-1111-1111-0000000077c6')
             || jsonb_build_array(jsonb_build_object(
                    'team_id', 'a1111111-1111-1111-1111-0000000077f4',
                    'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a5',
                    'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'manual'))) $$,
    'retained shape: the old latest-run payload is accepted (manual rows are retained)');
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments
      WHERE team_id IN ('a1111111-1111-1111-1111-0000000077f2', 'a1111111-1111-1111-1111-0000000077f3')
        AND run_id = 'a1111111-1111-1111-1111-0000000077c5'),
    2,
    'retained shape: the old payload left B and C under the older run');

-- 17. The NEW payload (every current row) is accepted.
INSERT INTO grid_before
SELECT 'retained', pa.id, pa.practice_slot_id, pa.effective_date_range
  FROM public.practice_assignments pa
  JOIN public.teams t ON t.id = pa.team_id
 WHERE t.division_id = 'a1111111-1111-1111-1111-0000000077d2';
SELECT lives_ok(
    $$ INSERT INTO grid_results
       SELECT 'retained', public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c8',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b2'),
           pg_temp.grid_rows('a1111111-1111-1111-1111-0000000077b2', NULL)) $$,
    'retained shape: the new current-rows payload is accepted with no unlock or closes');

-- 18-21. It removed, closed and unlocked nothing, and retained nothing silently.
SELECT is((SELECT (r->>'superseded_count')::int FROM grid_results WHERE label = 'retained'), 0,
          'retained shape: nothing superseded');
SELECT is((SELECT jsonb_array_length(r->'closed') FROM grid_results WHERE label = 'retained'), 0,
          'retained shape: nothing closed');
SELECT is((SELECT jsonb_array_length(r->'unlocked') FROM grid_results WHERE label = 'retained'), 0,
          'retained shape: nothing unlocked');
SELECT is((SELECT (r->>'retained_manual_count')::int FROM grid_results WHERE label = 'retained'), 0,
          'retained shape: every team is in the payload, so nothing is merely retained');

-- 22-24. Rows unchanged; no addition; the prior set is not vacuous.
SELECT is(
    (SELECT count(*)::int FROM grid_before b
       LEFT JOIN public.practice_assignments pa
         ON pa.id = b.id AND pa.practice_slot_id = b.practice_slot_id
        AND pa.effective_date_range = b.effective_date_range
      WHERE b.label = 'retained' AND pa.id IS NULL),
    0,
    'retained shape: every prior row keeps its id, slot and range');
SELECT is((SELECT count(*)::int FROM grid_before WHERE label = 'retained'), 4,
          'retained shape: four prior rows were checked (A, B, C, D)');
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments pa
       JOIN public.teams t ON t.id = pa.team_id
      WHERE t.division_id = 'a1111111-1111-1111-1111-0000000077d2'),
    4,
    'retained shape: the save added no row');

-- 25-26. Re-stamped -- B and C included, unlike the old payload (16) -- and
-- the manual rows stay manual.
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments pa
       JOIN public.teams t ON t.id = pa.team_id
      WHERE t.division_id = 'a1111111-1111-1111-1111-0000000077d2'
        AND pa.run_id IS DISTINCT FROM 'a1111111-1111-1111-1111-0000000077c8'),
    0,
    'retained shape: the save re-stamps every row, B and C included');
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments
      WHERE team_id IN ('a1111111-1111-1111-1111-0000000077f2', 'a1111111-1111-1111-1111-0000000077f3',
                        'a1111111-1111-1111-1111-0000000077f4')
        AND source = 'manual'),
    3,
    'retained shape: B, C and D stay manual');

-- 27. No unlock or supersede audit row names this save.
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE action IN ('practice.unlock_accepted', 'practice.superseded')
        AND metadata->>'run_id' = 'a1111111-1111-1111-1111-0000000077c8'),
    0,
    'retained shape: no unlock or supersede audit for the save');

-- ===========================================================================
-- Shape 3: the override prompt (docs/PLAN_GRID_OVERRIDE_PROMPT.md W8). The
-- payloads are the grid's (`grid_override`, its JS twin is
-- tests/gridCurrentPracticeRows.test.jsx), and `unlock` carries exactly the
-- rows the prompt lists, each with the generated reason
-- `grid override <runId>: <code>` (Q3). Run c9 places G (mon, wed), H (thu)
-- and I (tue). Run ca re-homes H: its Thursday series is closed on
-- 2026-10-11 and a Friday series starts 2026-10-12.
-- ===========================================================================
SELECT public.persist_practice_schedule(
    jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077c9',
                       'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
    jsonb_build_array(
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007781',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a1',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007781',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a3',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007782',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a4',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007783',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a2',
                           'effective_date_range', '[2026-09-01,2026-11-30]')));
SELECT public.persist_practice_schedule(
    jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077ca',
                       'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
    jsonb_build_array(
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007781',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a1',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007781',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a3',
                           'effective_date_range', '[2026-09-01,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007782',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a5',
                           'effective_date_range', '[2026-10-12,2026-11-30]'),
        jsonb_build_object('team_id', 'a1111111-1111-1111-1111-000000007783',
                           'practice_slot_id', 'a1111111-1111-1111-1111-0000000077a2',
                           'effective_date_range', '[2026-09-01,2026-11-30]')),
    unlock => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'reason', 'loss on 2026-10-12'))
                 FROM public.practice_assignments
                WHERE team_id = 'a1111111-1111-1111-1111-000000007782'),
    closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-11'))
                 FROM public.practice_assignments
                WHERE team_id = 'a1111111-1111-1111-1111-000000007782'));

-- 28. The shape is real (meta): H holds a closed Thursday and a current
-- Friday series, G two current series, I one.
-- Ordered by the series' start date: `day_of_week` is an enum whose order is
-- the week's, not the text's, so it cannot order this string (CI #546).
SELECT is(
    (SELECT string_agg(ps.day_of_week::text || ':' || pa.effective_date_range::text, ','
                       ORDER BY lower(pa.effective_date_range), ps.day_of_week::text)
       FROM public.practice_assignments pa
       JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
      WHERE pa.team_id = 'a1111111-1111-1111-1111-000000007782'),
    'thu:[2026-09-01,2026-10-12),fri:[2026-10-12,2026-12-01)',
    'override shape: H holds a closed Thursday and a current Friday series');

-- The closed series ('prompt') and the current one the override replaces
-- ('prompt-current'), as they stood before it.
INSERT INTO grid_before
SELECT CASE WHEN pa.practice_slot_id = 'a1111111-1111-1111-1111-0000000077a4'
            THEN 'prompt' ELSE 'prompt-current' END,
       pa.id, pa.practice_slot_id, pa.effective_date_range
  FROM public.practice_assignments pa
 WHERE pa.team_id = 'a1111111-1111-1111-1111-000000007782';

-- From here the grid's "today" is 2026-10-20: H's current Friday series
-- (from 2026-10-12) is closed on 2026-10-19 and the Tuesday override starts
-- 2026-10-20 (#546).
-- 29-30. W8b: without `unlock`, closing H's current series is refused,
-- naming the current (Friday) series.
SELECT throws_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cb',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007782',
                                       'a1111111-1111-1111-1111-0000000077a2', '2026-10-20'),
           closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-19'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5')) $$,
    '22023', NULL,
    'prompt W8b: closing H''s current series without unlock is refused 22023');
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cb',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007782',
                                       'a1111111-1111-1111-1111-0000000077a2', '2026-10-20'),
           closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-19'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5')) $$,
    '%assignment ' || (SELECT id::text FROM public.practice_assignments
                        WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                          AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5')
        || ' is locked%',
    'prompt W8b: ... naming H''s current Friday series');

-- 31. W8f: a member who is not an org admin cannot unlock, even with a reason,
-- and it is the unlock gate (:280-284) that refuses: the writer's general
-- admin check raises 42501 too, with another message, so the message is what
-- tells the two apart.
-- A member who is not an admin cannot exist any more: organization_members_role_check admits only
-- admin, staff and tenant_admin since 20261104010000, and all three are admins. The unlock gate is
-- defence in depth for exactly that state (the membership check comes first), so Charlie is made a
-- 'coach' member by lifting the check for this transaction, which is rolled back.
RESET ROLE;
ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'coach')
ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'coach';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cb',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007782',
                                       'a1111111-1111-1111-1111-0000000077a2', '2026-10-20'),
           unlock => (SELECT jsonb_build_array(jsonb_build_object(
                          'assignment_id', id,
                          'reason', 'grid override a1111111-1111-1111-1111-0000000077cb: field-change'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5'),
           closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-19'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5')) $$,
    'unlock requires an org admin with a uid to audit%',
    'prompt W8f: a non-admin member''s unlock is refused by the unlock gate');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- 32. W8a: with `unlock` and `closes` naming exactly the replaced current
-- series, the admin's save is accepted.
SELECT lives_ok(
    $$ INSERT INTO grid_results
       SELECT 'prompt', public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cb',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007782',
                                       'a1111111-1111-1111-1111-0000000077a2', '2026-10-20'),
           unlock => (SELECT jsonb_build_array(jsonb_build_object(
                          'assignment_id', id,
                          'reason', 'grid override a1111111-1111-1111-1111-0000000077cb: field-change'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5'),
           closes => (SELECT jsonb_build_array(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-19'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a5')) $$,
    'prompt W8a: the override, with the replaced current series unlocked and closed, is accepted');

-- 33. W8c: the closed series is untouched: same id, slot, range and source.
SELECT is(
    (SELECT count(*)::int FROM grid_before b
       JOIN public.practice_assignments pa
         ON pa.id = b.id AND pa.practice_slot_id = b.practice_slot_id
        AND pa.effective_date_range = b.effective_date_range
        AND pa.source = 'auto'
      WHERE b.label = 'prompt'),
    1,
    'prompt W8c: H''s closed Thursday series keeps its id, slot, range and source');
-- 34. #546: the replaced Friday series keeps its id; its range now ends on
-- yesterday (2026-10-19, so `[...,2026-10-20)`), its past kept.
SELECT is(
    (SELECT pa.effective_date_range::text FROM public.practice_assignments pa
       JOIN grid_before b ON b.id = pa.id AND b.label = 'prompt-current'
      WHERE pa.practice_slot_id = b.practice_slot_id),
    '[2026-10-12,2026-10-20)',
    'prompt W8a: the replaced series keeps its id, ended on yesterday');
-- 35. ... and H's whole schedule: every date before today as it was, the
-- Tuesday override from today, nothing else.
SELECT is(
    (SELECT string_agg(ps.day_of_week::text || ':' || pa.effective_date_range::text, ','
                       ORDER BY lower(pa.effective_date_range), ps.day_of_week::text)
       FROM public.practice_assignments pa
       JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
      WHERE pa.team_id = 'a1111111-1111-1111-1111-000000007782'),
    'thu:[2026-09-01,2026-10-12),fri:[2026-10-12,2026-10-20),tue:[2026-10-20,2026-12-01)',
    'prompt W8a: H''s past dates are unchanged and the override starts today');

-- 36-37. W8d: exactly one practice.unlock_accepted row for the save, for the
-- unlocked row, carrying the sent reason; none for the closed series (P1).
-- Both are scoped to the override's own run (cb): the setup's re-home (ca)
-- legitimately unlocked the Thursday series when it closed it, and that audit
-- row is not the override's (CI #546 counted it).
SELECT is(
    (SELECT jsonb_agg(jsonb_build_object('id', resource_id, 'reason', metadata->>'reason'))
       FROM public.audit_log
      WHERE action = 'practice.unlock_accepted'
        AND metadata->>'run_id' = 'a1111111-1111-1111-1111-0000000077cb'),
    jsonb_build_array(jsonb_build_object(
        'id', (SELECT id FROM grid_before WHERE label = 'prompt-current'),
        'reason', 'grid override a1111111-1111-1111-1111-0000000077cb: field-change')),
    'prompt W8d: one unlock_accepted row, for the replaced series, with the sent reason');
SELECT is(
    (SELECT count(*)::int FROM public.audit_log a
       JOIN grid_before b ON b.id = a.resource_id AND b.label = 'prompt'
      WHERE a.action = 'practice.unlock_accepted'
        AND a.metadata->>'run_id' = 'a1111111-1111-1111-1111-0000000077cb'),
    0,
    'prompt W8d: the override wrote no unlock_accepted row for the closed series');

-- 38-41. W8e: G's two live weekdays, both closed on yesterday (Q2). Unlocking
-- only one is refused naming the other; unlocking both is accepted, both are
-- audited, and both keep their past.
SELECT throws_like(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cc',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007781',
                                       'a1111111-1111-1111-1111-0000000077a5', '2026-10-20'),
           unlock => (SELECT jsonb_build_array(jsonb_build_object(
                          'assignment_id', id,
                          'reason', 'grid override a1111111-1111-1111-1111-0000000077cc: conflict-fix'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007781'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a1'),
           closes => (SELECT jsonb_agg(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-19'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007781')) $$,
    '%assignment ' || (SELECT id::text FROM public.practice_assignments
                        WHERE team_id = 'a1111111-1111-1111-1111-000000007781'
                          AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a3')
        || ' is locked%',
    'prompt W8e: unlocking only Monday is refused, naming G''s Wednesday series');
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cc',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007781',
                                       'a1111111-1111-1111-1111-0000000077a5', '2026-10-20'),
           unlock => (SELECT jsonb_agg(jsonb_build_object(
                          'assignment_id', id,
                          'reason', 'grid override a1111111-1111-1111-1111-0000000077cc: conflict-fix'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007781'),
           closes => (SELECT jsonb_agg(jsonb_build_object('assignment_id', id, 'last_day', '2026-10-19'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007781')) $$,
    'prompt W8e: unlocking and closing both weekdays is accepted');
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE action = 'practice.unlock_accepted'
        AND metadata->>'run_id' = 'a1111111-1111-1111-1111-0000000077cc'
        AND metadata->>'reason' = 'grid override a1111111-1111-1111-1111-0000000077cc: conflict-fix'),
    2,
    'prompt W8e: both weekdays are audited, each with the sent reason');
SELECT is(
    (SELECT string_agg(ps.day_of_week::text || ':' || pa.effective_date_range::text, ','
                       ORDER BY lower(pa.effective_date_range), ps.day_of_week::text)
       FROM public.practice_assignments pa
       JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
      WHERE pa.team_id = 'a1111111-1111-1111-1111-000000007781'),
    'mon:[2026-09-01,2026-10-20),wed:[2026-09-01,2026-10-20),fri:[2026-10-20,2026-12-01)',
    'prompt W8e: both weekdays keep their past, ended on yesterday; Friday starts today');

-- 42-43. W8g: a series that starts today or later has no past, so the grid
-- replaces it whole: `unlock` only, no `closes`. H's Tuesday override starts
-- 2026-10-20 (today); overriding H again, to Wednesday, removes it and keeps
-- every earlier date. (The helper's kept-history rule, "ends before the
-- team's latest start", agrees here with the page's date rule: Thursday and
-- the closed Friday both end before today.)
SELECT lives_ok(
    $$ SELECT public.persist_practice_schedule(
           jsonb_build_object('id', 'a1111111-1111-1111-1111-0000000077cd',
                              'season_settings_id', 'a1111111-1111-1111-1111-0000000077b3'),
           pg_temp.grid_override_today('a1111111-1111-1111-1111-0000000077b3',
                                       'a1111111-1111-1111-1111-000000007782',
                                       'a1111111-1111-1111-1111-0000000077a3', '2026-10-20'),
           unlock => (SELECT jsonb_build_array(jsonb_build_object(
                          'assignment_id', id,
                          'reason', 'grid override a1111111-1111-1111-1111-0000000077cd: other'))
                        FROM public.practice_assignments
                       WHERE team_id = 'a1111111-1111-1111-1111-000000007782'
                         AND practice_slot_id = 'a1111111-1111-1111-1111-0000000077a2')) $$,
    'prompt W8g: a series starting today is replaced whole with unlock alone');
SELECT is(
    (SELECT string_agg(ps.day_of_week::text || ':' || pa.effective_date_range::text, ','
                       ORDER BY lower(pa.effective_date_range), ps.day_of_week::text)
       FROM public.practice_assignments pa
       JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
      WHERE pa.team_id = 'a1111111-1111-1111-1111-000000007782'),
    'thu:[2026-09-01,2026-10-12),fri:[2026-10-12,2026-10-20),wed:[2026-10-20,2026-12-01)',
    'prompt W8g: the not-started series is gone; every earlier date is unchanged');

SELECT * FROM finish();
ROLLBACK;
