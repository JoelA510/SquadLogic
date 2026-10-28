-- pgTAP: admin_delete_team takes its practice exceptions and its players' team
-- ids with it, on the record (migration 20261021030000; plan
-- docs/changes/2026-10-20-admin-delete-team.md), and since 20261022030000
-- (plan docs/changes/2026-10-22-admin-focus.md, R2) does so without RSVPs or
-- team chat: both tables are dropped, and the delete neither touches nor
-- counts them.
--
-- Built from the migrations, the old body deleted a team whose series carried
-- exceptions without the v3 RESTRICT guard firing (the team_id cascade removes
-- them first), so this file pins what the new body adds: the withdrawal, the
-- archive, the audit rows, the unassigned players and a counter for every
-- table the cascade empties -- enumerated from the catalogue, so the cascade
-- set is whatever the head build has (seven tables since R2). Run against the
-- 20261021030000 body at head it fails: that body reads the dropped tables.
--
-- Fixture (Org A): team T (deleted) and opponent O. T has two series, the
-- first with a live relocation and a withdrawn TIME TBD row, both on run R;
-- a game G against O with a game assignment; a rostered player P1 and a player
-- P2 assigned only through players.team_id; an ended coach assignment and its
-- calendar token. O has an O-only game G2 (to survive). T2 carries a series
-- cancelled through the sibling RPC, for the parity checks. All ids and names
-- are synthetic.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(24);

INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('d8000000-0000-4000-8000-0000000000b1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Del T'),
    ('d8000000-0000-4000-8000-0000000000b2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Del O'),
    ('d8000000-0000-4000-8000-0000000000b3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Del T2');
INSERT INTO public.locations (id, organization_id, name)
VALUES ('d8000000-0000-4000-8000-0000000000f0', 'a1111111-1111-1111-1111-111111111111', 'Del Park');
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('d8000000-0000-4000-8000-0000000000f1', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000f0', 'Del Pitch', true);
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until) VALUES
    ('d8000000-0000-4000-8000-0000000005a1', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000f1',
     'tue', '17:00'::time, '18:30'::time, 3, '2026-09-01'::date, '2026-12-31'::date),
    ('d8000000-0000-4000-8000-0000000005a2', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000f1',
     'thu', '17:00'::time, '18:30'::time, 3, '2026-09-01'::date, '2026-12-31'::date);
INSERT INTO public.scheduler_runs (id, organization_id, run_type, status, results)
VALUES ('d8000000-0000-4000-8000-0000000000aa', 'a1111111-1111-1111-1111-111111111111', 'practice', 'completed', '{}'::jsonb);
INSERT INTO public.practice_assignments (id, organization_id, team_id, practice_slot_id, effective_date_range) VALUES
    ('d8000000-0000-4000-8000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b1',
     'd8000000-0000-4000-8000-0000000005a1', '[2026-09-01,2026-10-01)'::daterange),
    ('d8000000-0000-4000-8000-00000000000b', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b1',
     'd8000000-0000-4000-8000-0000000005a1', '[2026-10-01,2026-12-01)'::daterange),
    ('d8000000-0000-4000-8000-00000000000c', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b3',
     'd8000000-0000-4000-8000-0000000005a1', '[2026-09-01,2026-12-01)'::daterange);
INSERT INTO public.practice_exceptions (id, organization_id, season_settings_id, team_id, assignment_id, "window", kind,
    practice_slot_id, tbd_reason, cause_kind, run_id, withdrawn_at) VALUES
    ('d8000000-0000-4000-8000-0000000000e1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'd8000000-0000-4000-8000-0000000000b1', 'd8000000-0000-4000-8000-00000000000a', '[2026-09-08,2026-09-22)', 'relocated',
     'd8000000-0000-4000-8000-0000000005a2', NULL, 'retirement', 'd8000000-0000-4000-8000-0000000000aa', NULL),
    ('d8000000-0000-4000-8000-0000000000e2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'd8000000-0000-4000-8000-0000000000b1', 'd8000000-0000-4000-8000-00000000000a', '[2026-09-22,2026-09-29)', 'time_tbd',
     NULL, 'contended', 'blackout', 'd8000000-0000-4000-8000-0000000000aa', now() - interval '1 day'),
    ('d8000000-0000-4000-8000-0000000000e3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'd8000000-0000-4000-8000-0000000000b3', 'd8000000-0000-4000-8000-00000000000c', '[2026-09-08,2026-09-22)', 'relocated',
     'd8000000-0000-4000-8000-0000000005a2', NULL, 'retirement', 'd8000000-0000-4000-8000-0000000000aa', NULL);
INSERT INTO public.games (id, organization_id, home_team_id, away_team_id) VALUES
    ('d8000000-0000-4000-8000-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b1', 'd8000000-0000-4000-8000-0000000000b2'),
    ('d8000000-0000-4000-8000-0000000000c2', 'a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b2', 'aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.game_assignments (organization_id, home_team_id, away_team_id)
VALUES ('a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b1', 'd8000000-0000-4000-8000-0000000000b2');
INSERT INTO public.players (id, organization_id, division_id, first_name, last_name, team_id) VALUES
    ('d8000000-0000-4000-8000-00000000aa01', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'DelA', 'Player', NULL),
    ('d8000000-0000-4000-8000-00000000aa02', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'DelB', 'Player', 'd8000000-0000-4000-8000-0000000000b1'),
    ('d8000000-0000-4000-8000-00000000aa03', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'DelC', 'Player', NULL);
INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES
    ('d8000000-0000-4000-8000-0000000000b1', 'd8000000-0000-4000-8000-00000000aa01', 'a1111111-1111-1111-1111-111111111111'),
    ('d8000000-0000-4000-8000-0000000000b2', 'd8000000-0000-4000-8000-00000000aa03', 'a1111111-1111-1111-1111-111111111111');
UPDATE public.players SET team_id = 'd8000000-0000-4000-8000-0000000000b1' WHERE id = 'd8000000-0000-4000-8000-00000000aa01';
INSERT INTO public.coaches (id, organization_id, full_name, email, status)
VALUES ('d8000000-0000-4000-8000-0000000000c9', 'a1111111-1111-1111-1111-111111111111', 'Del Coach', 'del-coach@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'd8000000-0000-4000-8000-0000000000b1', 'd8000000-0000-4000-8000-0000000000c9',
        'lead', '2026-01-01', '2026-03-01', 'pgtap', 'pgtap');

SELECT ok(
    (SELECT count(*) FROM public.practice_exceptions WHERE team_id = 'd8000000-0000-4000-8000-0000000000b1' AND withdrawn_at IS NULL) = 1
    AND (SELECT count(*) FROM public.practice_exceptions WHERE team_id = 'd8000000-0000-4000-8000-0000000000b1' AND withdrawn_at IS NOT NULL) = 1
    AND (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id = 'd8000000-0000-4000-8000-0000000000b1') = 1
    AND (SELECT count(*) FROM public.team_coach_assignments WHERE team_id = 'd8000000-0000-4000-8000-0000000000b1') = 1,
    'the fixture: one live and one withdrawn exception on T, its token and an ended coach assignment');

-- ---- the control: a non-admin is refused and nothing changes ---------------
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok($$SELECT public.admin_delete_team('d8000000-0000-4000-8000-0000000000b1')$$, '42501', NULL,
                 'a signed-in non-member cannot delete a team');
RESET ROLE;
SELECT ok(EXISTS (SELECT 1 FROM public.teams WHERE id = 'd8000000-0000-4000-8000-0000000000b1')
          AND (SELECT count(*) FROM public.practice_exceptions WHERE team_id = 'd8000000-0000-4000-8000-0000000000b1') = 2
          AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions WHERE id = 'd8000000-0000-4000-8000-0000000000e1' AND withdrawn_at IS NOT NULL),
          'the refused delete changed nothing');

-- ---- the sibling, on T2, for the parity checks -----------------------------
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok($$SELECT public.admin_cancel_practice_assignment('d8000000-0000-4000-8000-00000000000c')$$,
                'the sibling cancels T2''s series');
SELECT lives_ok($$SELECT public.admin_delete_team('d8000000-0000-4000-8000-0000000000b1')$$,
                'an admin deletes T, exceptions and all');
RESET ROLE;

CREATE TEMP TABLE del_audit ON COMMIT DROP AS
SELECT metadata FROM public.audit_log
 WHERE action = 'team.deleted' AND resource_id = 'd8000000-0000-4000-8000-0000000000b1';

SELECT is((SELECT count(*)::int FROM del_audit), 1, 'one team.deleted row');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.teams WHERE id = 'd8000000-0000-4000-8000-0000000000b1')
          AND NOT EXISTS (SELECT 1 FROM public.practice_assignments WHERE team_id = 'd8000000-0000-4000-8000-0000000000b1')
          AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions WHERE id IN ('d8000000-0000-4000-8000-0000000000e1', 'd8000000-0000-4000-8000-0000000000e2')),
          'the team, both series and both exceptions are gone');

-- Withdrawal: the live exception only, audited with the reason.
SELECT is((SELECT array_agg(resource_id::text) FROM public.audit_log
            WHERE action = 'practice.exception_withdrawn' AND metadata->>'reason' = 'team_deleted'),
          ARRAY['d8000000-0000-4000-8000-0000000000e1'], 'the live exception is withdrawn and audited; the withdrawn one is not');
SELECT ok((SELECT (metadata->'row'->>'withdrawn_at') IS NOT NULL
             AND (metadata->'row'->>'withdrawn_by') = '11111111-1111-1111-1111-111111111111'
             FROM public.audit_log
            WHERE action = 'practice.exception_withdrawn' AND resource_id = 'd8000000-0000-4000-8000-0000000000e1'),
          'the withdrawal records when and by whom');

-- Each series cancelled on the record, as the sibling does.
SELECT is((SELECT array_agg(resource_id::text ORDER BY resource_id) FROM public.audit_log
            WHERE action = 'practice.cancelled' AND metadata->>'reason' = 'team_deleted'),
          ARRAY['d8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-00000000000b'],
          'each of T''s series has a practice.cancelled row');
SELECT ok((SELECT bool_and(metadata->'before'->>'id' = resource_id::text) FROM public.audit_log
            WHERE action = 'practice.cancelled' AND metadata->>'reason' = 'team_deleted'),
          'each practice.cancelled row carries the series as it was');
SELECT is((SELECT jsonb_array_length(metadata->'archived_exceptions') FROM public.audit_log
            WHERE action = 'practice.cancelled' AND resource_id = 'd8000000-0000-4000-8000-00000000000a'),
          2, 'the first series'' row archives both its exceptions');

-- Parity with admin_cancel_practice_assignment: every key the sibling writes.
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM (
        SELECT jsonb_object_keys(metadata) k FROM public.audit_log
         WHERE action = 'practice.cancelled' AND resource_id = 'd8000000-0000-4000-8000-00000000000c'
        EXCEPT
        SELECT jsonb_object_keys(metadata) FROM public.audit_log
         WHERE action = 'practice.cancelled' AND resource_id = 'd8000000-0000-4000-8000-00000000000a') s),
    NULL, 'practice.cancelled carries every key the sibling writes');
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM (
        SELECT jsonb_object_keys(e.value) k
          FROM public.scheduler_runs sr, jsonb_array_elements(sr.results->'archived_exceptions') e
         WHERE sr.id = 'd8000000-0000-4000-8000-0000000000aa' AND e.value->>'id' = 'd8000000-0000-4000-8000-0000000000e3'
        EXCEPT
        SELECT jsonb_object_keys(e.value)
          FROM public.scheduler_runs sr, jsonb_array_elements(sr.results->'archived_exceptions') e
         WHERE sr.id = 'd8000000-0000-4000-8000-0000000000aa' AND e.value->>'id' = 'd8000000-0000-4000-8000-0000000000e1') s),
    NULL, 'an archived row has the sibling''s shape (the raw exception row)');
SELECT is((SELECT array_agg(e.value->>'id' ORDER BY e.value->>'id')
             FROM public.scheduler_runs sr, jsonb_array_elements(sr.results->'archived_exceptions') e
            WHERE sr.id = 'd8000000-0000-4000-8000-0000000000aa'),
          ARRAY['d8000000-0000-4000-8000-0000000000e1', 'd8000000-0000-4000-8000-0000000000e2', 'd8000000-0000-4000-8000-0000000000e3'],
          'run R''s archive holds both of T''s exceptions beside the sibling''s');

-- Games: T's goes with the cascade, O's other game stays.
SELECT ok(EXISTS (SELECT 1 FROM public.games WHERE id = 'd8000000-0000-4000-8000-0000000000c2')
          AND NOT EXISTS (SELECT 1 FROM public.games WHERE id = 'd8000000-0000-4000-8000-0000000000c1'),
          'T''s game is gone, the other game stays');

-- Players.
SELECT ok((SELECT bool_and(team_id IS NULL) FROM public.players
            WHERE id IN ('d8000000-0000-4000-8000-00000000aa01', 'd8000000-0000-4000-8000-00000000aa02')),
          'both players, rostered or assigned through team_id alone, have no team');

-- team.deleted: every count, non-zero on this fixture, and what went.
SELECT is((SELECT jsonb_build_object(
              'practice_exceptions_deleted', metadata->'practice_exceptions_deleted',
              'practice_assignments_deleted', metadata->'practice_assignments_deleted',
              'games_deleted', metadata->'games_deleted',
              'game_assignments_deleted', metadata->'game_assignments_deleted',
              'team_players_deleted', metadata->'team_players_deleted',
              'team_coach_assignments_deleted', metadata->'team_coach_assignments_deleted',
              'team_calendar_tokens_deleted', metadata->'team_calendar_tokens_deleted') FROM del_audit),
          '{"practice_exceptions_deleted": 2, "practice_assignments_deleted": 2, "games_deleted": 1,
            "game_assignments_deleted": 1, "team_players_deleted": 1,
            "team_coach_assignments_deleted": 1, "team_calendar_tokens_deleted": 1}'::jsonb,
          'team.deleted counts what each table lost');
-- R2: no counter names a table that no longer exists (the catalogue walk below
-- only asks that every cascading table HAS one).
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM del_audit, jsonb_object_keys(metadata) k
      WHERE k LIKE '%\_deleted' AND to_regclass('public.' || regexp_replace(k, '_deleted$', '')) IS NULL),
    NULL, 'team.deleted has no counter for a table that does not exist (no RSVP or chat counter)');
SELECT is((SELECT metadata->'game_ids' FROM del_audit), '["d8000000-0000-4000-8000-0000000000c1"]'::jsonb,
          'team.deleted names the deleted game');
SELECT is((SELECT metadata->'player_ids_unassigned' FROM del_audit),
          '["d8000000-0000-4000-8000-00000000aa01", "d8000000-0000-4000-8000-00000000aa02"]'::jsonb,
          'team.deleted names both unassigned players');
SELECT ok((SELECT metadata->'withdrawn_exception_ids' = '["d8000000-0000-4000-8000-0000000000e1"]'::jsonb
                  AND jsonb_array_length(metadata->'archived_exceptions') = 2 FROM del_audit),
          'team.deleted names the withdrawn exception and archives both');

-- Every table the cascade from teams empties has a counter: enumerated from
-- the catalogue, not from the function, so a new cascading table fails here.
SELECT is(
    (SELECT array_agg(t ORDER BY t) FROM (
        SELECT DISTINCT c.conrelid::regclass::text AS t
          FROM pg_constraint c
         WHERE c.contype = 'f' AND c.confrelid = 'public.teams'::regclass AND c.confdeltype = 'c'
        EXCEPT
        SELECT regexp_replace(k, '_deleted$', '')
          FROM del_audit, jsonb_object_keys(metadata) k
         WHERE k LIKE '%\_deleted') s),
    NULL, 'every table that cascades from teams has a *_deleted counter');
SELECT ok((SELECT count(DISTINCT c.conrelid) FROM pg_constraint c
            WHERE c.contype = 'f' AND c.confrelid = 'public.teams'::regclass AND c.confdeltype = 'c') >= 7,
          'the catalogue walk found the cascading tables (it examined something)');

SELECT * FROM finish();
ROLLBACK;
