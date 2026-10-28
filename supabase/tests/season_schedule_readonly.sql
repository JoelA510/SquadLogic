-- pgTAP: a completed season's schedules are read-only (migration 20261109010000, E3b; Codex's
-- finding on #680). Triggers on teams, team_players, team_coach_assignments, practice_assignments,
-- practice_exceptions and game_assignments refuse any write by a signed-in caller whose team (or
-- season) is completed (22023, season_completed), whichever writer: the three persistence RPCs and
-- the team RPCs are exercised on the completed season and, with the same shape, on the active one;
-- every table is also written directly. A call with no signed-in user (the retention job) and the
-- cascade of a deleted organization still reach the rows.
-- (schedule_tbd, the TIME TBD list of 20261108020000, is the seventh table.)
-- Season O is Org A's "old" season: it is seeded and scheduled while a draft, then completed.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(57);

CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE s text; d text;
BEGIN
    EXECUTE p_sql;
    RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;

-- ── Seed: season O (draft for now) beside the active fixture season ─────────
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-111111111111', 'Org A Old', 'draft', 2025);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111d0ff1', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-1111111100ff', 'Old U10');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000ff001', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0ff1', 'Old One'),
    ('a1111111-1111-1111-1111-0000000ff002', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0ff1', 'Old Two'),
    ('aaaaaaaa-0000-0000-0000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A-Team 2'),
    ('aaaaaaaa-0000-0000-0000-000000000004', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'A-Team 3');
INSERT INTO public.players (id, organization_id, division_id, first_name, last_name) VALUES
    ('a1111111-1111-1111-1111-0000000ff0a1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0ff1', 'Old', 'Player'),
    ('a1111111-1111-1111-1111-0000000ff0a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Live', 'Player');
INSERT INTO public.coaches (id, organization_id, season_settings_id, full_name, email) VALUES
    ('a1111111-1111-1111-1111-0000000ff0c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100ff', 'Old Coach', 'oldcoach@example.test'),
    ('a1111111-1111-1111-1111-0000000ff0c2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Live Coach', 'livecoach@example.test');
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000ff10c', 'a1111111-1111-1111-1111-111111111111', 'RO Complex');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000ff0f1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff10c', 'RO Field');
INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until, capacity) VALUES
    ('a1111111-1111-1111-1111-0000000ff0b1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff0f1', 'mon', '17:00', '18:00', '2026-03-01', '2026-06-01', 4),
    ('a1111111-1111-1111-1111-0000000ff0b2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff0f1', 'tue', '17:00', '18:00', '2026-03-01', '2026-06-01', 4);
INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
    ('a1111111-1111-1111-1111-0000000ff0d1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff0f1', 'a1111111-1111-1111-1111-1111111d0ff1', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000ff0d2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff0f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1);

-- Schedule both seasons while neither is completed (the writers work on a draft as on the active season).
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE FUNCTION pg_temp.team_run(p_run text, p_season text, p_team text, p_division text, p_player text, p_name text) RETURNS text
LANGUAGE sql AS $f$
    SELECT public.persist_team_schedule(
        jsonb_build_object('id', p_run, 'organization_id', 'a1111111-1111-1111-1111-111111111111',
                           'season_settings_id', p_season, 'run_type', 'team', 'status', 'completed'),
        jsonb_build_array(jsonb_build_object('id', p_team, 'organization_id', 'a1111111-1111-1111-1111-111111111111',
                                             'division_id', p_division, 'name', p_name)),
        jsonb_build_array(jsonb_build_object('team_id', p_team, 'player_id', p_player, 'role', 'player', 'source', 'auto'))
    )::text
$f$;
-- The writer keeps every existing auto row of the season's teams unless it is listed to unlock, so
-- a run names each (team, slot) pair as 'team,slot': the ones the season has and, to change
-- something, one more.
CREATE FUNCTION pg_temp.practice_run(p_run text, p_season text, VARIADIC p_pairs text[]) RETURNS text
LANGUAGE sql AS $f$
    SELECT public.persist_practice_schedule(
        jsonb_build_object('id', p_run, 'organization_id', 'a1111111-1111-1111-1111-111111111111',
                           'season_settings_id', p_season, 'run_type', 'practice', 'status', 'completed'),
        (SELECT jsonb_agg(jsonb_build_object('team_id', split_part(pair, ',', 1), 'practice_slot_id', split_part(pair, ',', 2),
                                             'effective_date_range', '[2026-03-01,2026-06-01)', 'source', 'auto'))
           FROM unnest(p_pairs) AS pair)
    )->>'run_id'
$f$;
CREATE FUNCTION pg_temp.game_run(p_run text, p_season text, p_home text, p_away text, p_slot text) RETURNS text
LANGUAGE sql AS $f$
    SELECT public.persist_game_schedule(
        jsonb_build_object('id', p_run, 'organization_id', 'a1111111-1111-1111-1111-111111111111',
                           'season_settings_id', p_season, 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(jsonb_build_object('home_team_id', p_home, 'away_team_id', p_away, 'game_slot_id', p_slot,
                                             'field_id', 'a1111111-1111-1111-1111-0000000ff0f1', 'week_index', 1,
                                             'start', '2026-04-04T08:00:00Z', 'end', '2026-04-04T09:00:00Z', 'source', 'auto'))
    )::text
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.team_run(text, text, text, text, text, text), pg_temp.practice_run(text, text, text[]), pg_temp.game_run(text, text, text, text, text) TO PUBLIC;

SELECT is(pg_temp.team_run('a1111111-1111-1111-1111-0000000ff0e1', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff001',
    'a1111111-1111-1111-1111-1111111d0ff1', 'a1111111-1111-1111-1111-0000000ff0a1', 'Old One'),
    'a1111111-1111-1111-1111-0000000ff0e1', 'control: the old season (not yet completed) saves its teams and roster');
SELECT is(pg_temp.practice_run('a1111111-1111-1111-1111-0000000ff0e2', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff001,a1111111-1111-1111-1111-0000000ff0b1'),
    'a1111111-1111-1111-1111-0000000ff0e2', 'and its practices');
SELECT is(pg_temp.game_run('a1111111-1111-1111-1111-0000000ff0e3', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff001', 'a1111111-1111-1111-1111-0000000ff002', 'a1111111-1111-1111-1111-0000000ff0d1'),
    'a1111111-1111-1111-1111-0000000ff0e3', 'and its games');
SELECT is(pg_temp.team_run('a1111111-1111-1111-1111-0000000ff1e1', 'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001',
    'a1111111-1111-1111-1111-11111111abcd', 'a1111111-1111-1111-1111-0000000ff0a2', 'A-Team'),
    'a1111111-1111-1111-1111-0000000ff1e1', 'the active season saves its teams and roster');
SELECT is(pg_temp.practice_run('a1111111-1111-1111-1111-0000000ff1e2', 'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001,a1111111-1111-1111-1111-0000000ff0b1'),
    'a1111111-1111-1111-1111-0000000ff1e2', 'and its practices');
SELECT is(pg_temp.game_run('a1111111-1111-1111-1111-0000000ff1e3', 'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'a1111111-1111-1111-1111-0000000ff0d2'),
    'a1111111-1111-1111-1111-0000000ff1e3', 'and its games');
RESET role;
INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff001', 'a1111111-1111-1111-1111-0000000ff0c1', 'lead', '2026-01-01', 'admin'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-0000000ff0c2', 'lead', '2026-01-01', 'admin');
INSERT INTO public.practice_exceptions (id, organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
SELECT 'a1111111-1111-1111-1111-0000000ff0e4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100ff',
       'a1111111-1111-1111-1111-0000000ff001', pa.id, '[2026-03-03,2026-03-10)', 'time_tbd', 'contended'
  FROM public.practice_assignments pa WHERE pa.team_id = 'a1111111-1111-1111-1111-0000000ff001' LIMIT 1;
INSERT INTO public.practice_exceptions (id, organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
SELECT 'a1111111-1111-1111-1111-0000000ff1e4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
       'aaaaaaaa-0000-0000-0000-000000000001', pa.id, '[2026-03-03,2026-03-10)', 'time_tbd', 'contended'
  FROM public.practice_assignments pa WHERE pa.team_id = 'aaaaaaaa-0000-0000-0000-000000000001' LIMIT 1;
SELECT is((SELECT count(*)::int FROM public.practice_exceptions WHERE id IN ('a1111111-1111-1111-1111-0000000ff0e4', 'a1111111-1111-1111-1111-0000000ff1e4')), 2,
    'control: a TIME TBD exception was seeded for each season');
SELECT cmp_ok((SELECT count(*)::int FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'), '>=', 2, 'and a game for each');
-- The practice saves rebuilt each season's TIME TBD list (20261108020000): a team with no practice has a row.
SELECT cmp_ok((SELECT count(*)::int FROM public.schedule_tbd WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111100ff'), '>=', 1, 'and a TIME TBD row for the old season');
SELECT cmp_ok((SELECT count(*)::int FROM public.schedule_tbd WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'), '>=', 1, 'and for the active one');
CREATE TEMP TABLE ids ON COMMIT DROP AS
    SELECT (SELECT id FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000ff001' LIMIT 1) AS old_pa,
           (SELECT id FROM public.practice_assignments WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001' LIMIT 1) AS live_pa,
           (SELECT id FROM public.game_assignments WHERE home_team_id = 'a1111111-1111-1111-1111-0000000ff001' LIMIT 1) AS old_ga,
           (SELECT id FROM public.game_assignments WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001' LIMIT 1) AS live_ga,
           (SELECT id FROM public.schedule_tbd WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111100ff' LIMIT 1) AS old_tbd,
           (SELECT id FROM public.schedule_tbd WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' LIMIT 1) AS live_tbd;
GRANT SELECT ON ids TO PUBLIC;

-- The old season is now history.
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-1111111100ff';

-- ── The writers: refused on the completed season, allowed on the active one ─
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT pg_temp.team_run('a1111111-1111-1111-1111-0000000ff2e1', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff001', 'a1111111-1111-1111-1111-1111111d0ff1', 'a1111111-1111-1111-1111-0000000ff0a1', 'Old One Renamed')$$),
    '22023:season_completed', 'persist_team_schedule is refused on the completed season');
SELECT is(pg_temp.err($$SELECT pg_temp.team_run('a1111111-1111-1111-1111-0000000ff2e2', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff00f', 'a1111111-1111-1111-1111-1111111d0ff1', 'a1111111-1111-1111-1111-0000000ff0a1', 'Brand New')$$),
    '22023:season_completed', 'including a new team');
SELECT is(pg_temp.err($$SELECT pg_temp.practice_run('a1111111-1111-1111-1111-0000000ff2e3', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff001,a1111111-1111-1111-1111-0000000ff0b1', 'a1111111-1111-1111-1111-0000000ff002,a1111111-1111-1111-1111-0000000ff0b2')$$),
    '22023:season_completed', 'persist_practice_schedule is refused on the completed season');
SELECT is(pg_temp.err($$SELECT pg_temp.game_run('a1111111-1111-1111-1111-0000000ff2e4', 'a1111111-1111-1111-1111-1111111100ff', 'a1111111-1111-1111-1111-0000000ff002', 'a1111111-1111-1111-1111-0000000ff001', 'a1111111-1111-1111-1111-0000000ff0d1')$$),
    '22023:season_completed', 'persist_game_schedule is refused on the completed season');
SELECT is(pg_temp.err($$SELECT public.admin_update_team('a1111111-1111-1111-1111-0000000ff001', '{"name": "Renamed late"}')$$),
    '22023:season_completed', 'admin_update_team is refused');
SELECT is(pg_temp.err($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000ff002')$$),
    '22023:season_completed', 'admin_delete_team is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_cancel_practice_assignment(%L)$$, (SELECT old_pa FROM ids))),
    '22023:season_completed', 'admin_cancel_practice_assignment is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_cancel_game_assignment(%L)$$, (SELECT old_ga FROM ids))),
    '22023:season_completed', 'admin_cancel_game_assignment is refused');
SELECT is(pg_temp.err($$SELECT public.admin_assign_team_coach('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff001', 'a1111111-1111-1111-1111-0000000ff0c1', '2026-02-01')$$),
    '22023:season_completed', 'and so is a change of the team''s coaches');

SELECT is(pg_temp.team_run('a1111111-1111-1111-1111-0000000ff3e1', 'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-11111111abcd', 'a1111111-1111-1111-1111-0000000ff0a2', 'A-Team Again'),
    'a1111111-1111-1111-1111-0000000ff3e1', 'persist_team_schedule is allowed on the active season');
SELECT is(pg_temp.practice_run('a1111111-1111-1111-1111-0000000ff3e2', 'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001,a1111111-1111-1111-1111-0000000ff0b1', 'aaaaaaaa-0000-0000-0000-000000000003,a1111111-1111-1111-1111-0000000ff0b2'),
    'a1111111-1111-1111-1111-0000000ff3e2', 'persist_practice_schedule is allowed on the active season');
SELECT is(pg_temp.game_run('a1111111-1111-1111-1111-0000000ff3e3', 'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-0000000ff0d2'),
    'a1111111-1111-1111-1111-0000000ff3e3', 'persist_game_schedule is allowed on the active season');
SELECT is(pg_temp.err($$SELECT public.admin_update_team('aaaaaaaa-0000-0000-0000-000000000001', '{"name": "A-Team Renamed"}')$$),
    'no error', 'admin_update_team is allowed');
SELECT is(pg_temp.err(format($$SELECT public.admin_cancel_practice_assignment(%L)$$, (SELECT live_pa FROM ids))),
    'no error', 'admin_cancel_practice_assignment is allowed');
SELECT is(pg_temp.err(format($$SELECT public.admin_cancel_game_assignment(%L)$$, (SELECT live_ga FROM ids))),
    'no error', 'admin_cancel_game_assignment is allowed');
SELECT is(pg_temp.err($$SELECT public.admin_assign_team_coach('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', NULL)$$),
    'no error', 'a change of the active team''s coaches (here, removing them) is allowed');
SELECT is(pg_temp.err($$SELECT public.admin_delete_team('aaaaaaaa-0000-0000-0000-000000000004')$$),
    'no error', 'admin_delete_team is allowed');
RESET role;

-- ── Every table, written directly by a signed-in caller ────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$INSERT INTO public.teams (organization_id, division_id, name) VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d0ff1', 'Late Team')$$),
    '22023:season_completed', 'teams: an insert into the completed season is refused');
SELECT is(pg_temp.err($$UPDATE public.teams SET notes = 'late' WHERE id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'an update');
SELECT is(pg_temp.err($$UPDATE public.teams SET division_id = 'a1111111-1111-1111-1111-11111111abcd' WHERE id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'a move out of the completed season');
SELECT is(pg_temp.err($$UPDATE public.teams SET division_id = 'a1111111-1111-1111-1111-1111111d0ff1' WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003'$$),
    '22023:season_completed', 'and a move into it');
SELECT is(pg_temp.err($$DELETE FROM public.teams WHERE id = 'a1111111-1111-1111-1111-0000000ff002'$$),
    '22023:season_completed', 'a delete');
SELECT is(pg_temp.err($$INSERT INTO public.team_players (organization_id, team_id, player_id) VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000ff002', 'a1111111-1111-1111-1111-0000000ff0a1')$$),
    '22023:season_completed', 'team_players: an insert is refused');
SELECT is(pg_temp.err($$DELETE FROM public.team_players WHERE team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'a delete');
SELECT is(pg_temp.err($$UPDATE public.team_coach_assignments SET role = 'assistant' WHERE team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'team_coach_assignments: an update is refused');
SELECT is(pg_temp.err($$DELETE FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'practice_assignments: a delete is refused');
SELECT is(pg_temp.err($$UPDATE public.practice_assignments SET assigned_via = 'manual' WHERE team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'an update');
SELECT is(pg_temp.err($$UPDATE public.practice_exceptions SET tbd_reason = 'late' WHERE id = 'a1111111-1111-1111-1111-0000000ff0e4'$$),
    '22023:season_completed', 'practice_exceptions (TIME TBD): an update is refused');
SELECT is(pg_temp.err($$DELETE FROM public.practice_exceptions WHERE id = 'a1111111-1111-1111-1111-0000000ff0e4'$$),
    '22023:season_completed', 'a delete');
SELECT is(pg_temp.err($$DELETE FROM public.game_assignments WHERE home_team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'game_assignments: a delete is refused');
SELECT is(pg_temp.err($$UPDATE public.game_assignments SET assignment_source = 'manual' WHERE home_team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    '22023:season_completed', 'an update');
SELECT is(pg_temp.err($$UPDATE public.teams SET notes = 'live' WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'$$),
    'no error', 'control: the same update on the active season''s team is allowed');
SELECT is(pg_temp.err($$UPDATE public.practice_exceptions SET tbd_reason = 'live' WHERE id = 'a1111111-1111-1111-1111-0000000ff1e4'$$),
    'no error', 'and its TIME TBD exception');

-- The TIME TBD list (schedule_tbd): rows of a completed season are history too.
SELECT is(pg_temp.err(format($$UPDATE public.schedule_tbd SET reason = 'coach-preference' WHERE id = %L$$, (SELECT old_tbd FROM ids))),
    '22023:season_completed', 'schedule_tbd: an update of a completed season''s row is refused');
SELECT is(pg_temp.err(format($$DELETE FROM public.schedule_tbd WHERE id = %L$$, (SELECT old_tbd FROM ids))),
    '22023:season_completed', 'a delete');
SELECT is(pg_temp.err($$INSERT INTO public.schedule_tbd (organization_id, season_settings_id, kind, division_id, team_id, missing_count, reason)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100ff', 'practice',
                'a1111111-1111-1111-1111-1111111d0ff1', 'a1111111-1111-1111-1111-0000000ff001', 1, 'not-scheduled-yet')$$),
    '22023:season_completed', 'an insert');
SELECT is(pg_temp.err(format($$UPDATE public.schedule_tbd SET reason = 'coach-preference' WHERE id = %L$$, (SELECT live_tbd FROM ids))),
    'no error', 'control: the active season''s row takes the same update');
-- The refresh rebuilds a season's practice rows (delete and insert): refused for a completed season that has rows,
-- allowed for the active one.
SET LOCAL role = 'authenticated';
SELECT is(pg_temp.err($$SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-1111111100ff')$$),
    '22023:season_completed', 'refresh_schedule_tbd_practices is refused for the completed season');
SELECT is(pg_temp.err($$SELECT public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa')$$),
    'no error', 'and allowed for the active one');
RESET role;

-- ── Who is exempt ─────────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.err($$UPDATE public.teams SET notes = 'retention' WHERE id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    'no error', 'with no signed-in user (a job) the completed season''s rows are still reachable');
SELECT is(pg_temp.err($$DELETE FROM public.practice_exceptions WHERE id = 'a1111111-1111-1111-1111-0000000ff0e4'$$),
    'no error', 'TIME TBD exceptions too');
SELECT is(pg_temp.err($$DELETE FROM public.practice_assignments WHERE team_id = 'a1111111-1111-1111-1111-0000000ff001'$$),
    'no error', 'and practice assignments');
SELECT is(pg_temp.err($$DELETE FROM public.schedule_tbd WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111100ff'$$),
    'no error', 'and its TIME TBD rows');

-- The cascade of a deleted organization is not blocked by a completed season.
INSERT INTO public.organizations (id, name, slug) VALUES ('d4444444-4444-4444-4444-444444444444', 'Org D', 'org-d-readonly');
DELETE FROM public.season_settings WHERE organization_id = 'd4444444-4444-4444-4444-444444444444';
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('d4444444-4444-4444-4444-4444444444d1', 'd4444444-4444-4444-4444-444444444444', 'Org D Old', 'draft', 2025);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('d4444444-4444-4444-4444-44444444d0d1', 'd4444444-4444-4444-4444-444444444444', 'd4444444-4444-4444-4444-4444444444d1', 'D U10');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('d4444444-4444-4444-4444-4444444d0001', 'd4444444-4444-4444-4444-444444444444', 'd4444444-4444-4444-4444-44444444d0d1', 'D One');
INSERT INTO public.players (id, organization_id, division_id, first_name, last_name) VALUES
    ('d4444444-4444-4444-4444-4444444d00a1', 'd4444444-4444-4444-4444-444444444444', 'd4444444-4444-4444-4444-44444444d0d1', 'D', 'Player');
INSERT INTO public.team_players (organization_id, team_id, player_id) VALUES ('d4444444-4444-4444-4444-444444444444', 'd4444444-4444-4444-4444-4444444d0001', 'd4444444-4444-4444-4444-4444444d00a1');
UPDATE public.season_settings SET status = 'completed' WHERE id = 'd4444444-4444-4444-4444-4444444444d1';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$DELETE FROM public.organizations WHERE id = 'd4444444-4444-4444-4444-444444444444'$$),
    'no error', 'a signed-in caller can still delete an organization whose season is completed');
SELECT is((SELECT count(*)::int FROM public.teams WHERE organization_id = 'd4444444-4444-4444-4444-444444444444')
        + (SELECT count(*)::int FROM public.team_players WHERE team_id = 'd4444444-4444-4444-4444-4444444d0001'), 0,
    'and its teams and rosters went with it');

-- ── Shape ─────────────────────────────────────────────────────────────────
SELECT is(
    (SELECT array_agg(c.relname::text ORDER BY c.relname::text) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      WHERE g.tgname LIKE '%\_readonly\_when\_completed' AND NOT g.tgisinternal AND g.tgenabled = 'O'
        AND g.tgfoid = 'public.season_schedule_readonly_when_completed()'::regprocedure),
    ARRAY['game_assignments', 'practice_assignments', 'practice_exceptions', 'schedule_tbd', 'team_coach_assignments', 'team_players', 'teams'],
    'the seven schedule tables carry the trigger, enabled');
SELECT is(has_function_privilege('authenticated', 'public.season_schedule_readonly_when_completed()', 'EXECUTE')
          OR has_function_privilege('anon', 'public.season_schedule_readonly_when_completed()', 'EXECUTE'), false,
    'and the trigger function is nobody''s to call');

SELECT * FROM finish();
ROLLBACK;
