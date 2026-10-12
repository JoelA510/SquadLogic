-- pgTAP: enact_practice_recommendation's blackout arm (8.6 3b PR 11d-2,
-- migration 20261007000000; docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md
-- §2.4, §5 witnesses B8 and B9, the SQL arms), under a real Supabase JWT.
-- The harness smoke docs/sql/20261007000000_smoke.sql carries the same
-- witnesses with their plants, plus B10 and B11 (a second session); this file
-- runs the core of them against the Supabase auth stack in CI, and records
-- the premise of the FOR SHARE helper (an invoker FOR SHARE locks no row).
--
-- Synthetic ids and names only.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(14);

-- Org A: one park with two pitches, a Tuesday slot on pitch 1 (S's) and a
-- Thursday slot on pitch 2 (the relocation's), one series, one saved
-- partial-day blackout of pitch 1.
INSERT INTO public.locations (id, organization_id, name)
VALUES ('a1111111-1111-1111-1111-0000000d2f00', 'a1111111-1111-1111-1111-111111111111', 'BO Park');
INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES
    ('a1111111-1111-1111-1111-0000000d2f01', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000d2f00', 'BO Pitch 1'),
    ('a1111111-1111-1111-1111-0000000d2f02', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000d2f00', 'BO Pitch 2');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
VALUES
    ('a1111111-1111-1111-1111-0000000d2a01', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000d2f01', 'tue', '18:00', '19:30', '2026-09-01', '2026-11-30'),
    ('a1111111-1111-1111-1111-0000000d2a02', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-0000000d2f02', 'thu', '18:00', '19:30', '2026-09-01', '2026-11-30');
INSERT INTO public.practice_assignments (id, organization_id, team_id, slot_id, practice_slot_id, effective_date_range, source)
VALUES ('a1111111-1111-1111-1111-0000000d2e01', 'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-0000000d2a01',
        'a1111111-1111-1111-1111-0000000d2a01', '[2026-09-01,2026-11-30]', 'auto');
INSERT INTO public.field_blackouts (id, organization_id, field_id, blackout_from, blackout_until,
                                    start_minutes, end_minutes, reason)
VALUES ('a1111111-1111-1111-1111-0000000d2b01', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-0000000d2f01', '2026-10-20', '2026-10-26', 1050, 1170, 'maintenance');

-- The relocation of S as core buildEnactRecord would record it (plan §2.3),
-- and the one exception it sends. The key and fingerprint are set per call.
CREATE TEMP TABLE bo_case ON COMMIT DROP AS
SELECT jsonb_build_object(
    'schema_version', 1,
    'enact_key', NULL, 'run_id', NULL, 'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
    'cause', jsonb_build_object('kind', 'blackout', 'id', 'a1111111-1111-1111-1111-0000000d2b01',
        'loss', jsonb_build_object('from', '2026-10-20', 'until', '2026-10-26',
            'surface_ids', jsonb_build_array('a1111111-1111-1111-1111-0000000d2f01'),
            'start_minutes', 1050, 'end_minutes', 1170, 'reason', 'maintenance'),
        'stored', jsonb_build_object('field_id', 'a1111111-1111-1111-1111-0000000d2f01', 'location_id', NULL,
            'blackout_from', '2026-10-20', 'blackout_until', '2026-10-26',
            'start_minutes', 1050, 'end_minutes', 1170, 'reason', 'maintenance')),
    'series', jsonb_build_object('assignment_id', 'a1111111-1111-1111-1111-0000000d2e01',
        'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
        'from', jsonb_build_object('surface_id', 'a1111111-1111-1111-1111-0000000d2f01', 'weekday', 'TUE',
                                   'start_minutes', 1080, 'duration_minutes', 90),
        'window', jsonb_build_object('from', '2026-10-20', 'until', '2026-10-26')),
    'decision', jsonb_build_object('kind', 'relocate',
        'to', jsonb_build_object('surface_id', 'a1111111-1111-1111-1111-0000000d2f02', 'weekday', 'THU',
                                 'start_minutes', 1080, 'duration_minutes', 90),
        'tier', 'same-venue', 'origin', NULL, 'tbd_reason', NULL,
        'objective', jsonb_build_object('total', 1, 'counts', jsonb_build_object('changedWeekday', 1)),
        'coach_overlaps', '[]'::jsonb, 'coach_days_worsened', 0),
    'rejudge', jsonb_build_object('stands', true, 'shown_counts', jsonb_build_object('changedWeekday', 1)),
    'declined', '[]'::jsonb, 'chains', '[]'::jsonb, 'local', false, 'enacted_before', '[]'::jsonb,
    'prompt', jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
        'assignment_id', 'a1111111-1111-1111-1111-0000000d2e01', 'assigned_via', 'auto',
        'effect', 'temporarily moved', 'range_after', NULL, 'window', '[2026-10-20,2026-10-26]')),
        'published_practices_affected', 1, 'accepted', true),
    'unlock', '[]'::jsonb,
    'writes', jsonb_build_object('closes', '[]'::jsonb, 'new_rows', '[]'::jsonb, 'exceptions', 1),
    'base_fingerprint', NULL, 'result_fingerprint', NULL,
    'fingerprint_covers', 'practice_assignments+practice_exceptions',
    'solver', jsonb_build_object('strategy', 'exact', 'proven_optimal', true,
                                 'daylight_supplied', true, 'closures_supplied', true)) AS rec,
  jsonb_build_array(jsonb_build_object('assignment_id', 'a1111111-1111-1111-1111-0000000d2e01',
      'window', '[2026-10-20,2026-10-26]', 'kind', 'relocated',
      'practice_slot_id', 'a1111111-1111-1111-1111-0000000d2a02',
      'cause_kind', 'blackout', 'cause_id', 'a1111111-1111-1111-1111-0000000d2b01')) AS exc,
  jsonb_build_array(jsonb_build_object('team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
      'practice_slot_id', 'a1111111-1111-1111-1111-0000000d2a01',
      'effective_date_range', '[2026-09-01,2026-11-30]', 'source', 'auto')) AS assign;
GRANT SELECT ON bo_case TO authenticated;

-- One enact: the record and exceptions given, the run key given, the base
-- fingerprint read fresh, as the caller.
CREATE FUNCTION pg_temp.bo_enact(p_key uuid, p_rec jsonb, p_exc jsonb, p_assign jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_fp text := public.practice_schedule_fingerprint('a1111111-1111-1111-1111-111111111aaa');
BEGIN
    RETURN public.enact_practice_recommendation(
        jsonb_build_object('id', p_key, 'run_type', 'practice', 'status', 'completed',
                           'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa'),
        p_assign, '[]'::jsonb, '[]'::jsonb, p_exc, v_fp,
        p_rec || jsonb_build_object('enact_key', p_key, 'run_id', p_key, 'base_fingerprint', v_fp));
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.bo_enact(uuid, jsonb, jsonb, jsonb) TO authenticated;

-- Before any enact, the blackout row carries no lock (its xmax is 0).
SELECT is(
    (SELECT xmax::text FROM public.field_blackouts WHERE id = 'a1111111-1111-1111-1111-0000000d2b01'),
    '0',
    'control: before an enact the saved blackout row carries no lock');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- The premise of enact_lock_cause_row: the admin reads the row, but a
-- FOR SHARE read as the caller locks nothing (no UPDATE policy on the table).
SELECT is(
    (SELECT count(*)::int FROM public.field_blackouts WHERE id = 'a1111111-1111-1111-1111-0000000d2b01'),
    1,
    'premise: the admin reads the saved blackout');
SELECT is(
    (SELECT count(*)::int FROM (SELECT 1 FROM public.field_blackouts
                                 WHERE id = 'a1111111-1111-1111-1111-0000000d2b01' FOR SHARE) x),
    0,
    'premise: a FOR SHARE read as the admin locks no blackout row, so the wrapper locks through its definer helper');

-- B8: only a saved blackout, as saved.
SELECT throws_ok(
    $$ SELECT pg_temp.bo_enact('a1111111-1111-1111-1111-0000000d2c01',
           jsonb_set((SELECT rec FROM bo_case), '{cause,id}', '"a1111111-1111-1111-1111-0000000d2bff"'),
           (SELECT exc FROM bo_case), (SELECT assign FROM bo_case)) $$,
    '22023', NULL,
    'B8: a blackout id with no saved row is refused 22023');
SELECT throws_ok(
    $$ SELECT pg_temp.bo_enact('a1111111-1111-1111-1111-0000000d2c02',
           jsonb_set((SELECT rec FROM bo_case), '{cause,stored,reason}', '"weather"'),
           (SELECT exc FROM bo_case), (SELECT assign FROM bo_case)) $$,
    '22023', NULL,
    'B8: a record claiming another stored row is refused 22023');
SELECT throws_ok(
    $$ SELECT pg_temp.bo_enact('a1111111-1111-1111-1111-0000000d2c03',
           jsonb_set((SELECT rec FROM bo_case), '{cause,loss,surface_ids}',
                     '["a1111111-1111-1111-1111-0000000d2f02"]'),
           (SELECT exc FROM bo_case), (SELECT assign FROM bo_case)) $$,
    '22023', NULL,
    'B8: loss.surface_ids other than the blackout''s ground is refused 22023');

-- B9: one exception on S, and nothing else.
SELECT throws_ok(
    $$ SELECT pg_temp.bo_enact('a1111111-1111-1111-1111-0000000d2c04',
           jsonb_set((SELECT rec FROM bo_case), '{writes,exceptions}', '2'),
           (SELECT exc || jsonb_build_array(jsonb_build_object(
                'assignment_id', 'a1111111-1111-1111-1111-0000000d2e01', 'window', '[2026-11-03,2026-11-03]',
                'kind', 'time_tbd', 'tbd_reason', 'contended', 'cause_kind', 'blackout',
                'cause_id', 'a1111111-1111-1111-1111-0000000d2b01')) FROM bo_case),
           (SELECT assign FROM bo_case)) $$,
    '22023', NULL,
    'B9: a blackout enact recording two exceptions is refused 22023');
SELECT throws_ok(
    $$ SELECT pg_temp.bo_enact('a1111111-1111-1111-1111-0000000d2c05', (SELECT rec FROM bo_case),
           (SELECT exc FROM bo_case),
           (SELECT assign || jsonb_build_array(jsonb_build_object(
                'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'practice_slot_id', 'a1111111-1111-1111-1111-0000000d2a02',
                'effective_date_range', '[2026-10-20,2026-10-26]', 'source', 'auto',
                'assigned_via', 'recommendation')) FROM bo_case)) $$,
    '22023', NULL,
    'B9: a blackout enact creating a row is refused 22023');
SELECT is(
    (SELECT count(*)::int FROM public.practice_exceptions
      WHERE assignment_id = 'a1111111-1111-1111-1111-0000000d2e01'),
    0,
    'B8/B9: every refused enact wrote no exception');

-- The relocation, enacted.
SELECT lives_ok(
    $$ SELECT pg_temp.bo_enact('a1111111-1111-1111-1111-0000000d2c10', (SELECT rec FROM bo_case),
           (SELECT exc FROM bo_case), (SELECT assign FROM bo_case)) $$,
    'the saved blackout''s relocation of S is enacted');
SELECT is(
    (SELECT count(*)::int FROM public.practice_exceptions
      WHERE assignment_id = 'a1111111-1111-1111-1111-0000000d2e01' AND withdrawn_at IS NULL
        AND kind = 'relocated' AND practice_slot_id = 'a1111111-1111-1111-1111-0000000d2a02'
        AND cause_kind = 'blackout' AND cause_id = 'a1111111-1111-1111-1111-0000000d2b01'
        AND "window" = '[2026-10-20,2026-10-26]'::daterange),
    1,
    'B9: exactly one exception, on S, relocated to the Thursday slot over S''s window, cause the blackout');
SELECT is(
    (SELECT string_agg(practice_slot_id::text || ' ' || effective_date_range::text || ' ' || assigned_via, ',')
       FROM public.practice_assignments WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    'a1111111-1111-1111-1111-0000000d2a01 [2026-09-01,2026-12-01) auto',
    'B9: S keeps its row, slot, range and assigned_via, and no row is created');
SELECT is(
    (SELECT metadata->'cause'->'stored' FROM public.audit_log
      WHERE action = 'practice.recommendation_enacted' AND resource_id = 'a1111111-1111-1111-1111-0000000d2e01'),
    (SELECT rec->'cause'->'stored' FROM bo_case),
    'the enact audit row carries cause.stored as the gate read it');

RESET role;
-- Q10: the enact left the blackout row locked by this transaction.
SELECT isnt(
    (SELECT xmax::text FROM public.field_blackouts WHERE id = 'a1111111-1111-1111-1111-0000000d2b01'),
    '0',
    'Q10: after the enact the saved blackout row is locked (its xmax is set) until the transaction ends');

SELECT * FROM finish();

ROLLBACK;
