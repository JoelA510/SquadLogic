-- pgTAP: availability marking (RSVP) and team chat are gone, and the team page
-- still reads everything it shows for an admin (migration 20261022030000; plan
-- docs/changes/2026-10-22-admin-focus.md, R2).
--
--   * the two functions and the two tables are absent, no public function
--     names them in code (its `--` comments aside: persist_team_schedule
--     narrates both in one; the strip is textual, so a `--` inside a string
--     literal would hide the rest of its line), and the retired actions keep their
--     `audit_actions` rows (old `audit_log` rows reference them);
--   * the reads the team page makes (useTeamPortal and TeamRecordPage), as an
--     admin of the team's organization: the team, its game, its practice series
--     and its saved practice change, the roster and the staff, each returning
--     the seeded row; and another organization's admin reads none of it;
--   * `reconcile_prod_rls_drift()` still runs on the head chain (its spec named
--     the chat table before R2), verifying its 19 policies;
--   * the replaced `admin_delete_team` keeps its grants: authenticated, not
--     anon (what it deletes is admin_delete_team_exceptions.sql's).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(18);

-- ── 1. What the migration dropped ──────────────────────────────────────────
SELECT ok(to_regprocedure('public.upsert_team_event_rsvp(uuid, uuid, uuid, text, date, text)') IS NULL,
    'upsert_team_event_rsvp is gone');
SELECT ok(to_regprocedure('public.create_team_message(uuid, text)') IS NULL,
    'create_team_message is gone');
SELECT ok(to_regclass('public.event_rsvps') IS NULL, 'event_rsvps is gone');
SELECT ok(to_regclass('public.team_messages') IS NULL, 'team_messages is gone');
SELECT is(
    (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
            ~ '\m(event_rsvps|team_messages|upsert_team_event_rsvp|create_team_message)\M'),
    NULL,
    'no public function names a dropped table or function in its code'
);
-- Positive control for the scan above: the same pattern finds the comment in
-- persist_team_schedule when comments are kept, so it reads real bodies.
SELECT ok(
    EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = 'public.persist_team_schedule(jsonb,jsonb,jsonb)'::regprocedure
               AND p.prosrc ~ '\m(event_rsvps|team_messages)\M'),
    'control: the scan pattern matches a real body (persist_team_schedule''s comment)'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_actions
      WHERE action IN ('team.rsvp_updated', 'team.message_created')),
    2,
    'the retired actions keep their audit_actions rows'
);

-- ── 2. The team page's reads, as an admin ─────────────────────────────────
-- A coach record becomes A-Team's current lead coach (data an admin manages
-- since 20261104010000: no coach signs in); the team gets a game, a practice
-- series with a live saved change, and a rostered player.
INSERT INTO public.coaches (id, organization_id, full_name, email, status)
VALUES ('a1111111-0000-4000-8000-0000000002c1', 'a1111111-1111-1111-1111-111111111111',
        'R2 Coach', 'r2-coach@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'a1111111-0000-4000-8000-0000000002c1', 'lead', '2020-01-01', NULL, 'pgtap');
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES ('a1111111-0000-4000-8000-0000000002b2', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd', 'R2 Opponent');
INSERT INTO public.games (id, organization_id, home_team_id, away_team_id)
VALUES ('a1111111-0000-4000-8000-0000000002a1', 'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-0000-4000-8000-0000000002b2');
INSERT INTO public.locations (id, organization_id, name)
VALUES ('a1111111-0000-4000-8000-0000000002f0', 'a1111111-1111-1111-1111-111111111111', 'R2 Park');
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('a1111111-0000-4000-8000-0000000002f1', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-0000-4000-8000-0000000002f0', 'R2 Pitch', true);
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
VALUES ('a1111111-0000-4000-8000-0000000002d1', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-0000-4000-8000-0000000002f1', 'tue', '17:00'::time, '18:30'::time, 3, '2026-09-01', '2026-12-31');
INSERT INTO public.practice_assignments (id, organization_id, team_id, practice_slot_id, effective_date_range)
VALUES ('a1111111-0000-4000-8000-0000000002e1', 'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-0000-4000-8000-0000000002d1', '[2026-09-01,2026-12-01)');
INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason, cause_kind)
VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
        'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-0000-4000-8000-0000000002e1',
        '[2026-09-08,2026-09-15)', 'time_tbd', 'contended', 'blackout');
INSERT INTO public.players (id, organization_id, division_id, first_name, last_name)
VALUES ('a1111111-0000-4000-8000-0000000002a2', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd', 'PlayerR2', 'Roster');
INSERT INTO public.team_players (team_id, player_id, organization_id)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-0000-4000-8000-0000000002a2',
        'a1111111-1111-1111-1111-111111111111');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is((SELECT count(*)::int FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    1, 'the admin reads the team');
SELECT is((SELECT count(*)::int FROM public.games
            WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
               OR away_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    1, 'the admin reads the team''s game');
SELECT is((SELECT count(*)::int FROM public.practice_assignments
            WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    1, 'the admin reads the team''s practice series');
SELECT is((SELECT count(*)::int FROM public.practice_exceptions
            WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND withdrawn_at IS NULL),
    1, 'the admin reads the team''s saved practice change');
SELECT is((SELECT array_agg(player_id::text) FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001')),
    ARRAY['a1111111-0000-4000-8000-0000000002a2'], 'the admin reads the roster');
SELECT is((SELECT array_agg(coach_id::text) FROM public.get_team_staff('aaaaaaaa-0000-0000-0000-000000000001')),
    ARRAY['a1111111-0000-4000-8000-0000000002c1'], 'the admin reads the staff');

-- The control: another organisation's admin reads none of it, so the counts
-- above are the admin's own access and not an open table.
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is((SELECT count(*)::int FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001')
          + (SELECT count(*)::int FROM public.games WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001')
          + (SELECT count(*)::int FROM public.practice_assignments WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001')
          + (SELECT count(*)::int FROM public.practice_exceptions WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    0, 'control: another organisation''s admin reads none of the team''s rows');
SELECT throws_ok($$SELECT * FROM public.get_team_roster('aaaaaaaa-0000-0000-0000-000000000001')$$,
    '42501', NULL, 'control: another organisation''s admin is refused the roster');

RESET role;

-- ── 3. The RLS drift reconcile, on the head chain ──────────────────────────
SELECT is(
    (SELECT jsonb_array_length(r->'verified') || '/' || jsonb_array_length(r->'created') || '/' || jsonb_array_length(r->'dropped')
       FROM (SELECT public.reconcile_prod_rls_drift() AS r) s),
    '19/0/0',
    'reconcile_prod_rls_drift runs at head: verifies 19, creates and drops nothing'
);

-- ── 4. Grants ─────────────────────────────────────────────────────────────
SELECT ok(
    has_function_privilege('authenticated', 'public.admin_delete_team(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.admin_delete_team(uuid)', 'EXECUTE'),
    'admin_delete_team keeps its grants: authenticated, not anon'
);
SELECT ok(
    has_function_privilege('service_role', 'public.reconcile_prod_rls_drift()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.reconcile_prod_rls_drift()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reconcile_prod_rls_drift()', 'EXECUTE'),
    'reconcile_prod_rls_drift keeps its grants: service_role only'
);

SELECT * FROM finish();
ROLLBACK;
