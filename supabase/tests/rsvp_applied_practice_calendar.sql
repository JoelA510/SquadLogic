-- pgTAP: RSVP follows the applied practice calendar (8.6 3b PR 12d).
--
-- docs/PHASE_8_6_PR12_READERS_PLAN.md §6 W14-W15, §10 Q4:
--   W14  upsert_team_event_rsvp accepts a relocated date, refuses an original
--        date inside a relocated window and a TIME TBD date (22023), leaves
--        dates outside every window as they were, and ignores a withdrawn
--        exception. The case table is tests/fixtures/rsvpAppliedCalendarCases.json,
--        restated between the case-table markers below; tests/rsvpAppliedCalendar.test.js
--        pins the two equal, and docs/sql/20261005000000_smoke.sql runs the same
--        table in the local harness.
--   Q4   stored RSVPs on dates that became TIME TBD or moved are untouched.
--   W15  a parent member reads the same practice_exceptions rows as an admin;
--        a non-member reads none.
-- Every subject set is enumerated from the rows this file seeds. All ids and
-- names are synthetic.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(21);

-- ---- the fixture (as the test superuser, RLS bypassed) ---------------------
INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role)
VALUES
    ('d1200000-0000-4000-8000-0000000000d1', 'd12-parent@test.local',
     jsonb_build_object('full_name', 'Sample Parent', 'password_length', 12), 'authenticated', 'authenticated'),
    ('d1200000-0000-4000-8000-0000000000e1', 'd12-outsider@test.local',
     jsonb_build_object('full_name', 'Sample Outsider', 'password_length', 12), 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name)
VALUES
    ('d1200000-0000-4000-8000-0000000000d1', 'd12-parent@test.local', 'Sample Parent'),
    ('d1200000-0000-4000-8000-0000000000e1', 'd12-outsider@test.local', 'Sample Outsider')
ON CONFLICT (id) DO NOTHING;

-- The outsider is a member of no organisation.
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', 'd1200000-0000-4000-8000-0000000000d1', 'parent')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    ('d1200000-0000-4000-8000-0000000000b2', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'D12 Team B'),
    ('d1200000-0000-4000-8000-0000000000c3', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'D12 Team C')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.players (id, organization_id, division_id, first_name, last_name)
VALUES
    ('d1200000-0000-4000-8000-00000000aa01', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'SampleA', 'Player'),
    ('d1200000-0000-4000-8000-00000000aa02', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'SampleB', 'Player'),
    ('d1200000-0000-4000-8000-00000000aa03', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'SampleC', 'Player')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.team_players (team_id, player_id, organization_id)
VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-00000000aa01', 'a1111111-1111-1111-1111-111111111111'),
    ('d1200000-0000-4000-8000-0000000000b2', 'd1200000-0000-4000-8000-00000000aa02', 'a1111111-1111-1111-1111-111111111111'),
    ('d1200000-0000-4000-8000-0000000000c3', 'd1200000-0000-4000-8000-00000000aa03', 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT (team_id, player_id) DO NOTHING;

INSERT INTO public.profile_players (profile_id, player_id, organization_id)
VALUES
    ('d1200000-0000-4000-8000-0000000000d1', 'd1200000-0000-4000-8000-00000000aa01', 'a1111111-1111-1111-1111-111111111111'),
    ('d1200000-0000-4000-8000-0000000000d1', 'd1200000-0000-4000-8000-00000000aa02', 'a1111111-1111-1111-1111-111111111111'),
    ('d1200000-0000-4000-8000-0000000000d1', 'd1200000-0000-4000-8000-00000000aa03', 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT (profile_id, player_id) DO NOTHING;

INSERT INTO public.locations (id, organization_id, name)
VALUES ('d1200000-0000-4000-8000-0000000000f0', 'a1111111-1111-1111-1111-111111111111', 'D12 Park')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('d1200000-0000-4000-8000-0000000000f1', 'a1111111-1111-1111-1111-111111111111',
        'd1200000-0000-4000-8000-0000000000f0', 'D12 Pitch', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
VALUES
    ('d1200000-0000-4000-8000-0000000005a2', 'a1111111-1111-1111-1111-111111111111', 'd1200000-0000-4000-8000-0000000000f1',
     'tue', '17:00'::time, '18:30'::time, 2, '2026-09-01'::date, '2026-12-31'::date),
    ('d1200000-0000-4000-8000-0000000005a4', 'a1111111-1111-1111-1111-111111111111', 'd1200000-0000-4000-8000-0000000000f1',
     'thu', '18:15'::time, '19:15'::time, 2, '2026-09-01'::date, '2026-12-31'::date),
    ('d1200000-0000-4000-8000-0000000005a1', 'a1111111-1111-1111-1111-111111111111', 'd1200000-0000-4000-8000-0000000000f1',
     'mon', '17:00'::time, '18:30'::time, 2, '2026-09-01'::date, '2026-12-31'::date),
    ('d1200000-0000-4000-8000-0000000005a3', 'a1111111-1111-1111-1111-111111111111', 'd1200000-0000-4000-8000-0000000000f1',
     'wed', '17:00'::time, '18:30'::time, 2, '2026-09-01'::date, '2026-12-31'::date)
ON CONFLICT (id) DO NOTHING;

-- Rows A, B, C of the case table.
INSERT INTO public.practice_assignments (id, organization_id, team_id, practice_slot_id, effective_date_range)
VALUES
    ('d1200000-0000-4000-8000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-0000000005a2', '[2026-09-01,2026-12-01)'::daterange),
    ('d1200000-0000-4000-8000-00000000000b', 'a1111111-1111-1111-1111-111111111111',
     'd1200000-0000-4000-8000-0000000000b2', 'd1200000-0000-4000-8000-0000000005a1', '[2026-09-01,2026-10-01)'::daterange),
    ('d1200000-0000-4000-8000-00000000000c', 'a1111111-1111-1111-1111-111111111111',
     'd1200000-0000-4000-8000-0000000000c3', 'd1200000-0000-4000-8000-0000000005a3', '[2026-09-01,2026-10-01)'::daterange)
ON CONFLICT (id) DO NOTHING;

-- E1-E7 of the case table's seed.
INSERT INTO public.practice_exceptions (
    id, organization_id, season_settings_id, team_id, assignment_id, "window", kind,
    practice_slot_id, tbd_reason, cause_kind, withdrawn_at)
VALUES
    ('d1200000-0000-4000-8000-0000000000e1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-00000000000a', '[2026-09-14,2026-09-28)', 'relocated',
     'd1200000-0000-4000-8000-0000000005a4', NULL, 'retirement', NULL),
    ('d1200000-0000-4000-8000-0000000000e2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-00000000000a', '[2026-10-05,2026-10-19)', 'time_tbd',
     NULL, 'contended', 'blackout', NULL),
    ('d1200000-0000-4000-8000-0000000000e3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-00000000000a', '[2026-11-01,2026-11-15)', 'relocated',
     'd1200000-0000-4000-8000-0000000005a4', NULL, 'retirement', timezone('utc', now())),
    ('d1200000-0000-4000-8000-0000000000e4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-00000000000a', '[2026-11-20,)', 'relocated',
     'd1200000-0000-4000-8000-0000000005a4', NULL, 'retirement', NULL),
    ('d1200000-0000-4000-8000-0000000000e5', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'd1200000-0000-4000-8000-0000000000b2', 'd1200000-0000-4000-8000-00000000000b', '[2026-09-21,2026-10-12)', 'relocated',
     'd1200000-0000-4000-8000-0000000005a3', NULL, 'retirement', NULL),
    ('d1200000-0000-4000-8000-0000000000e6', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'd1200000-0000-4000-8000-0000000000b2', 'd1200000-0000-4000-8000-00000000000b', '[2026-10-12,2026-10-26)', 'time_tbd',
     NULL, 'past-sunset', NULL, NULL),
    ('d1200000-0000-4000-8000-0000000000e7', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
     'd1200000-0000-4000-8000-0000000000c3', 'd1200000-0000-4000-8000-00000000000c', '(,2026-09-06)', 'time_tbd',
     NULL, 'contended', 'blackout', NULL);

-- Q4: two RSVPs stored before 12d on dates now TIME TBD (A 10-13) and moved
-- away (A 09-22).
INSERT INTO public.event_rsvps (id, organization_id, team_id, player_id, reference_id, event_type, occurrence_date, status, updated_at)
VALUES
    ('d1200000-0000-4000-8000-0000000000f8', 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
     'd1200000-0000-4000-8000-00000000aa01', 'd1200000-0000-4000-8000-00000000000a', 'practice', '2026-10-13', 'attending', '2026-09-01T00:00:00Z'),
    ('d1200000-0000-4000-8000-0000000000f9', 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
     'd1200000-0000-4000-8000-00000000aa01', 'd1200000-0000-4000-8000-00000000000a', 'practice', '2026-09-22', 'maybe', '2026-09-01T00:00:00Z');

-- Meta-assertion (1): the fixture holds at least one live exception of each
-- kind, plus a withdrawn one, an open-upper one and an unreadable-lower one.
SELECT ok(
    (SELECT count(*) FILTER (WHERE kind = 'relocated' AND withdrawn_at IS NULL) >= 1
        AND count(*) FILTER (WHERE kind = 'time_tbd' AND withdrawn_at IS NULL) >= 1
        AND count(*) FILTER (WHERE withdrawn_at IS NOT NULL) >= 1
        AND count(*) FILTER (WHERE withdrawn_at IS NULL AND upper_inf("window")) >= 1
        AND count(*) FILTER (WHERE withdrawn_at IS NULL AND lower_inf("window")) >= 1
       FROM public.practice_exceptions
      WHERE id::text LIKE 'd1200000-0000-4000-8000-0000000000e_'),
    'the fixture exercises a live relocated, a live time_tbd, a withdrawn, an open and an unreadable window'
);

-- The call prefix per case-table row key. A session may always use its own
-- temporary schema, and the parent's role is granted the read.
CREATE TEMP TABLE d12_rows (row_key text PRIMARY KEY, call text NOT NULL) ON COMMIT DROP;
INSERT INTO d12_rows (row_key, call)
SELECT k, format(
           'SELECT public.upsert_team_event_rsvp(%L::uuid, %L::uuid, %L::uuid, ''practice'', ',
           team, player, ref)
  FROM (VALUES
    ('A', 'aaaaaaaa-0000-0000-0000-000000000001', 'd1200000-0000-4000-8000-00000000aa01', 'd1200000-0000-4000-8000-00000000000a'),
    ('B', 'd1200000-0000-4000-8000-0000000000b2', 'd1200000-0000-4000-8000-00000000aa02', 'd1200000-0000-4000-8000-00000000000b'),
    ('C', 'd1200000-0000-4000-8000-0000000000c3', 'd1200000-0000-4000-8000-00000000aa03', 'd1200000-0000-4000-8000-00000000000c')
  ) AS v(k, team, player, ref);
GRANT SELECT ON d12_rows TO authenticated;

-- ---- W14: the case table (16), as the linked parent ------------------------
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"d1200000-0000-4000-8000-0000000000d1","app_metadata":{"role":"parent"}}';

-- One statement per case, so tests/pgtapPlanCounts.test.js counts each. The
-- call prefix for each row key comes from d12_rows (created above, as the
-- superuser); every statement names its row key, date and outcome once, and
-- tests/rsvpAppliedCalendar.test.js reads all three back from it.
-- case-table:begin
SELECT lives_ok(r.call || '''2026-09-08''::date, ''attending'')', 'case A 2026-09-08 accept') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-09-09''::date, ''attending'')', '42501', NULL, 'case A 2026-09-09 42501') FROM d12_rows r WHERE r.row_key = 'A';
SELECT lives_ok(r.call || '''2026-09-17''::date, ''attending'')', 'case A 2026-09-17 accept') FROM d12_rows r WHERE r.row_key = 'A';
SELECT lives_ok(r.call || '''2026-09-24''::date, ''attending'')', 'case A 2026-09-24 accept') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-09-15''::date, ''attending'')', '22023', NULL, 'case A 2026-09-15 22023') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-09-16''::date, ''attending'')', '22023', NULL, 'case A 2026-09-16 22023') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-10-06''::date, ''attending'')', '22023', NULL, 'case A 2026-10-06 22023') FROM d12_rows r WHERE r.row_key = 'A';
SELECT lives_ok(r.call || '''2026-11-03''::date, ''attending'')', 'case A 2026-11-03 accept') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-11-05''::date, ''attending'')', '42501', NULL, 'case A 2026-11-05 42501') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-11-24''::date, ''attending'')', '22023', NULL, 'case A 2026-11-24 22023') FROM d12_rows r WHERE r.row_key = 'A';
SELECT throws_ok(r.call || '''2026-11-26''::date, ''attending'')', '22023', NULL, 'case A 2026-11-26 22023') FROM d12_rows r WHERE r.row_key = 'A';
SELECT lives_ok(r.call || '''2026-09-14''::date, ''attending'')', 'case B 2026-09-14 accept') FROM d12_rows r WHERE r.row_key = 'B';
SELECT lives_ok(r.call || '''2026-09-23''::date, ''attending'')', 'case B 2026-09-23 accept') FROM d12_rows r WHERE r.row_key = 'B';
SELECT throws_ok(r.call || '''2026-10-07''::date, ''attending'')', '22023', NULL, 'case B 2026-10-07 22023') FROM d12_rows r WHERE r.row_key = 'B';
SELECT throws_ok(r.call || '''2026-10-12''::date, ''attending'')', '22023', NULL, 'case B 2026-10-12 22023') FROM d12_rows r WHERE r.row_key = 'B';
SELECT throws_ok(r.call || '''2026-09-16''::date, ''attending'')', '22023', NULL, 'case C 2026-09-16 22023') FROM d12_rows r WHERE r.row_key = 'C';
-- case-table:end

RESET ROLE;

-- ---- Q4 (1): nothing stored was deleted or rewritten ------------------------
SELECT is(
    (SELECT string_agg(id::text || ':' || status || ':' || updated_at::text, ',' ORDER BY occurrence_date)
       FROM public.event_rsvps
      WHERE reference_id = 'd1200000-0000-4000-8000-00000000000a'
        AND occurrence_date IN ('2026-10-13', '2026-09-22')),
    'd1200000-0000-4000-8000-0000000000f9:maybe:' || '2026-09-01T00:00:00Z'::timestamptz::text
        || ',d1200000-0000-4000-8000-0000000000f8:attending:' || '2026-09-01T00:00:00Z'::timestamptz::text,
    'the two RSVPs stored on dates now TIME TBD or moved are neither deleted nor rewritten'
);

-- ---- W15 (3): who reads practice_exceptions ---------------------------------
-- Each reader is compared with the SEEDED id list, not with another read, so
-- "the parent reads what the admin reads" cannot pass on two empty reads.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';
SELECT set_eq(
    $$SELECT id FROM public.practice_exceptions WHERE id::text LIKE 'd1200000-0000-4000-8000-0000000000e_'$$,
    ARRAY['d1200000-0000-4000-8000-0000000000e1', 'd1200000-0000-4000-8000-0000000000e2',
          'd1200000-0000-4000-8000-0000000000e3', 'd1200000-0000-4000-8000-0000000000e4',
          'd1200000-0000-4000-8000-0000000000e5', 'd1200000-0000-4000-8000-0000000000e6',
          'd1200000-0000-4000-8000-0000000000e7']::uuid[],
    'the admin reads all 7 seeded practice exceptions, withdrawn included'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"d1200000-0000-4000-8000-0000000000d1","app_metadata":{"role":"parent"}}';
SELECT set_eq(
    $$SELECT id FROM public.practice_exceptions WHERE id::text LIKE 'd1200000-0000-4000-8000-0000000000e_'$$,
    ARRAY['d1200000-0000-4000-8000-0000000000e1', 'd1200000-0000-4000-8000-0000000000e2',
          'd1200000-0000-4000-8000-0000000000e3', 'd1200000-0000-4000-8000-0000000000e4',
          'd1200000-0000-4000-8000-0000000000e5', 'd1200000-0000-4000-8000-0000000000e6',
          'd1200000-0000-4000-8000-0000000000e7']::uuid[],
    'a parent member reads the same 7 practice exceptions as the admin'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"d1200000-0000-4000-8000-0000000000e1","app_metadata":{"role":"parent"}}';
SELECT is(
    (SELECT count(*)::int FROM public.practice_exceptions WHERE id::text LIKE 'd1200000-0000-4000-8000-0000000000e_'),
    0,
    'a non-member reads no practice exception'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
