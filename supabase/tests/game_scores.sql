-- pgTAP: a game's score lives in `game_scores`, a scored game is held, and standings are computed from scores
-- (migration 20261122010000; plan docs/changes/2026-11-06-games-table-source-of-truth.md, "The score record (F11-2)",
-- task B1).
--
-- Written first, and red against the code before the migration. Every refusal is paired with a control that the allowed
-- twin passes (the file's `errx` undoes what a statement did, so a probe can be repeated):
--
--   * the shape: the table, its composite foreign key to the saved game (NO ACTION both ways), RLS with one SELECT policy
--     and no write policy or grant, the completed-season trigger, and the two views;
--   * `update_game_score` names a SAVED game: both scores or none (a one-sided call is refused, D10), an edit, a clear
--     (the row goes), the audit row with the previous values, the same refusals as before (no admin, the setting off, a
--     completed season, another organization's game), and a legacy `games` id names nothing;
--   * the held rule, through the ONE predicate: a scored game cannot be moved, flipped, cancelled, deleted or left out of
--     a save (`game_scored`, `game_scored_omitted`), its unscored twin can, clearing the score lifts the hold, and a
--     Published game keeps its own words; a score survives a save that moves the unscored games around it;
--   * the database is the backstop: with no signed-in user (the guard lets that through) a delete of a scored game meets
--     the foreign key, and so does a team swap with the guard trigger disabled;
--   * delete team takes the scores of its games that are not Published with it and counts them (D5); deleting an
--     organization with a scored game succeeds (U5);
--   * standings: the same columns in the same order with one appended, an outside club has no row, a result against an
--     outside club is not counted unless the organization says so, a fixture of two outside clubs counts for nobody;
--   * `current_game_runs`: per organization and season the latest completed game run, as `useSchedulerRun` picks it;
--   * the legacy copy: nothing on an empty table, a match copied once, an unmatched scored row refused.
--
-- The seed is game_identity.sql's (no signed-in user, lesson 56), with two outside clubs and two games against them.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(113);

-- ── Helpers ────────────────────────────────────────────────────────────────
-- err: SQLSTATE:DETAIL of the first error, or 'no error' (the statement's effect stays).
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
-- errx: the same, and what the statement did is undone, so a probe can be repeated.
CREATE FUNCTION pg_temp.errx(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE s text; d text;
BEGIN
    BEGIN
        EXECUTE p_sql;
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1120';
    EXCEPTION WHEN SQLSTATE 'P1120' THEN
        RETURN 'no error';
    END;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;
-- msg: the first error's message, or 'no error' (and what the statement did is undone, as errx does).
CREATE FUNCTION pg_temp.msg(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
    BEGIN
        EXECUTE p_sql;
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1120';
    EXCEPTION WHEN SQLSTATE 'P1120' THEN
        RETURN 'no error';
    END;
EXCEPTION WHEN OTHERS THEN
    RETURN SQLERRM;
END
$f$;
-- val: the first column of the first row as text, or 'ERROR <sqlstate>' (a read today's code cannot do).
CREATE FUNCTION pg_temp.val(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE p_sql INTO r;
    RETURN COALESCE(r, 'NULL');
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE;
END
$f$;
-- gi: a saved game as a payload item WITH its id; g: the same without one (what the save was sent before).
CREATE FUNCTION pg_temp.gi(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object('id', id, 'home_team_id', home_team_id, 'away_team_id', away_team_id,
                              'game_slot_id', game_slot_id, 'field_id', field_id, 'week_index', week_index,
                              'start', start, 'end', "end", 'source', assignment_source)
      FROM public.game_assignments WHERE id = p_id
$f$;
CREATE FUNCTION pg_temp.g(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT pg_temp.gi(p_id) - 'id'
$f$;
-- mv: a saved game as a payload item, with its id, moved to another slot (its field, week, start and end follow).
CREATE FUNCTION pg_temp.mv(p_id uuid, p_slot uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT pg_temp.gi(p_id) || jsonb_build_object('game_slot_id', s.id, 'field_id', s.field_id,
                                                  'week_index', s.week_index, 'start', s.start, 'end', s."end")
      FROM public.game_slots s WHERE s.id = p_slot
$f$;
-- flip: the same game with its sides swapped.
CREATE FUNCTION pg_temp.flip(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT pg_temp.gi(p_id) || jsonb_build_object('home_team_id', away_team_id, 'away_team_id', home_team_id)
      FROM public.game_assignments WHERE id = p_id
$f$;
-- at: a payload item with NO id for a pair at a slot.
CREATE FUNCTION pg_temp.at(p_home uuid, p_away uuid, p_slot uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object('home_team_id', p_home, 'away_team_id', p_away, 'game_slot_id', s.id, 'field_id', s.field_id,
                              'week_index', s.week_index, 'start', s.start, 'end', s."end", 'source', 'auto',
                              'division', 'Org A U10')
      FROM public.game_slots s WHERE s.id = p_slot
$f$;
-- set7: the whole of season A's schedule as the page holds it (seven games, by id, as they are now), with per-id
-- replacements (a map id -> item), ids left out, and extra items.
CREATE FUNCTION pg_temp.set7(p_ovr jsonb DEFAULT '{}', p_skip uuid[] DEFAULT '{}', p_extra jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $f$
    SELECT COALESCE(jsonb_agg(COALESCE(p_ovr -> i::text, pg_temp.gi(i)) ORDER BY i), '[]'::jsonb) || p_extra
      FROM unnest(ARRAY['a1111111-1111-1111-1111-0000000d0e01', 'a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-0000000d0e03',
                        'a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-0000000d0e06',
                        'a1111111-1111-1111-1111-0000000d0e07']::uuid[]) AS i
     WHERE i <> ALL (p_skip)
$f$;
-- save: persist_game_schedule for Org A, season A (or, with a NULL season, for the organization alone).
CREATE FUNCTION pg_temp.save(p_items jsonb, p_season text DEFAULT 'a1111111-1111-1111-1111-111111111aaa') RETURNS text
LANGUAGE sql AS $f$
    SELECT public.persist_game_schedule(
        jsonb_strip_nulls(jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111',
                                             'season_settings_id', p_season, 'run_type', 'game', 'status', 'completed',
                                             'completed_at', clock_timestamp())),
        p_items)::text
$f$;
-- latest_run: the game run the page shows (the latest completed one of season A); visible: its games' ids.
CREATE FUNCTION pg_temp.latest_run() RETURNS uuid LANGUAGE sql AS $f$
    SELECT id FROM public.scheduler_runs
     WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
       AND run_type = 'game' AND status = 'completed'
     ORDER BY completed_at DESC, created_at DESC LIMIT 1
$f$;
CREATE FUNCTION pg_temp.visible() RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(string_agg(right(id::text, 4), ',' ORDER BY id), '') FROM public.game_assignments WHERE run_id = pg_temp.latest_run()
$f$;
-- pair_rows: how many rows the pair (either side) has, in any run.
CREATE FUNCTION pg_temp.pair_rows(p_a uuid, p_b uuid) RETURNS integer LANGUAGE sql AS $f$
    SELECT count(*)::int FROM public.game_assignments
     WHERE (home_team_id = p_a AND away_team_id = p_b) OR (home_team_id = p_b AND away_team_id = p_a)
$f$;
-- placed: where a game is now, as 'home>away@slot/week' with the last four characters of each id.
CREATE FUNCTION pg_temp.placed(p_id uuid) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE((SELECT right(home_team_id::text, 4) || '>' || right(away_team_id::text, 4) || '@' || right(game_slot_id::text, 4) || '/' || week_index
                       FROM public.game_assignments WHERE id = p_id), 'gone')
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text), pg_temp.errx(text), pg_temp.msg(text), pg_temp.val(text), pg_temp.gi(uuid), pg_temp.g(uuid),
    pg_temp.mv(uuid, uuid), pg_temp.flip(uuid), pg_temp.at(uuid, uuid, uuid), pg_temp.set7(jsonb, uuid[], jsonb), pg_temp.save(jsonb, text),
    pg_temp.latest_run(), pg_temp.visible(), pg_temp.pair_rows(uuid, uuid), pg_temp.placed(uuid) TO PUBLIC;

-- ── Seed (no signed-in user) ───────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';

-- Org A: season A (the fixture's, active) with teams T1 to T6; a draft season C that is completed below (T7, T8).
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111100c1', 'a1111111-1111-1111-1111-111111111111', 'Org A Season C', 'draft', 2025);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111d00c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100c1', 'C U10');
-- Season D: another season of Org A that is NOT completed (the season a game of "another season" is stored in).
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111100d1', 'a1111111-1111-1111-1111-111111111111', 'Org A Season D', 'draft', 2027);
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000d0001', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Id One'),
    ('a1111111-1111-1111-1111-0000000d0002', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Id Two'),
    ('a1111111-1111-1111-1111-0000000d0003', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Id Three'),
    ('a1111111-1111-1111-1111-0000000d0004', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Id Four'),
    ('a1111111-1111-1111-1111-0000000d0005', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Id Five'),
    ('a1111111-1111-1111-1111-0000000d0006', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Id Six'),
    ('a1111111-1111-1111-1111-0000000d0007', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00c1', 'Id Seven'),
    ('a1111111-1111-1111-1111-0000000d0008', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00c1', 'Id Eight');
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000d00a0', 'a1111111-1111-1111-1111-111111111111', 'Id Park'),
    ('b2222222-2222-2222-2222-0000000d00a0', 'b2222222-2222-2222-2222-222222222222', 'Id Park B');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00a0', 'Id Field 1'),
    ('a1111111-1111-1111-1111-0000000d00f2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00a0', 'Id Field 2'),
    ('b2222222-2222-2222-2222-0000000d00f1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-0000000d00a0', 'Id Field B');
-- Eleven slots of season A (d1 to d9, da) and one of season C (db); one of Org B.
INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
    ('a1111111-1111-1111-1111-0000000d00d1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000d00d2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', '2026-04-04', '10:00', '11:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000d00d3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f2', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000d00d4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f2', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', '2026-04-04', '10:00', '11:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000d00d5', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-11T08:00:00Z', '2026-04-11T09:00:00Z', '2026-04-11', '08:00', '09:00', 2, 1),
    ('a1111111-1111-1111-1111-0000000d00d6', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', '2026-04-11', '10:00', '11:00', 2, 1),
    ('a1111111-1111-1111-1111-0000000d00d7', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f2', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-11T08:00:00Z', '2026-04-11T09:00:00Z', '2026-04-11', '08:00', '09:00', 2, 1),
    ('a1111111-1111-1111-1111-0000000d00d8', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f2', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', '2026-04-11', '10:00', '11:00', 2, 1),
    ('a1111111-1111-1111-1111-0000000d00d9', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-18T08:00:00Z', '2026-04-18T09:00:00Z', '2026-04-18', '08:00', '09:00', 3, 1),
    ('a1111111-1111-1111-1111-0000000d00da', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-25T08:00:00Z', '2026-04-25T09:00:00Z', '2026-04-25', '08:00', '09:00', 4, 1),
    ('a1111111-1111-1111-1111-0000000d00db', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d00f1', 'a1111111-1111-1111-1111-1111111d00c1', '2026-03-07T08:00:00Z', '2026-03-07T09:00:00Z', '2026-03-07', '08:00', '09:00', 1, 1),
    ('b2222222-2222-2222-2222-0000000d00d1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-0000000d00f1', 'b2222222-2222-2222-2222-22222222bcde', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1);
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('b2222222-2222-2222-2222-0000000d0002', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-22222222bcde', 'Id B Two');
-- Two saved runs of season A: R0 older, R1 the one the page shows.
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
    ('a1111111-1111-1111-1111-0000000d0a00', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-03-01T00:00:00Z'),
    ('a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-03-02T00:00:00Z');
-- The games, as the page would have loaded them (run R1), seeded the way every saved game was before this migration:
-- no season on the row.
--   e01 T1>T2 d1/1  PUBLISHED      e02 T3>T4 d2/1      e03 T1>T3 d5/2      e04 T2>T4 d6/2
--   e05 T5>T6 d3/1  and e07 T5>T6 d4/1 (one pair, one week, two slots: the pair that swaps)   e06 T6>T5 d7/2
--   eh1 T2>T4 d8/2  an OLDER, hidden row (run R0) where e04 will be told to go
--   ec1 T7>T8 db/1  season C, completed below      gb1 Org B's game
INSERT INTO public.game_assignments (id, organization_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source) VALUES
    ('a1111111-1111-1111-1111-0000000d0e01', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d1', 'a1111111-1111-1111-1111-0000000d00d1', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d0001', 'a1111111-1111-1111-1111-0000000d0002', 'Org A U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d2', 'a1111111-1111-1111-1111-0000000d00d2', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d0003', 'a1111111-1111-1111-1111-0000000d0004', 'Org A U10', 1, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e03', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d5', 'a1111111-1111-1111-1111-0000000d00d5', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d0001', 'a1111111-1111-1111-1111-0000000d0003', 'Org A U10', 2, '2026-04-11T08:00:00Z', '2026-04-11T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d6', 'a1111111-1111-1111-1111-0000000d00d6', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d0002', 'a1111111-1111-1111-1111-0000000d0004', 'Org A U10', 2, '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d3', 'a1111111-1111-1111-1111-0000000d00d3', 'a1111111-1111-1111-1111-0000000d00f2',
     'a1111111-1111-1111-1111-0000000d0005', 'a1111111-1111-1111-1111-0000000d0006', 'Org A U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e06', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d7', 'a1111111-1111-1111-1111-0000000d00d7', 'a1111111-1111-1111-1111-0000000d00f2',
     'a1111111-1111-1111-1111-0000000d0006', 'a1111111-1111-1111-1111-0000000d0005', 'Org A U10', 2, '2026-04-11T08:00:00Z', '2026-04-11T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e07', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d4', 'a1111111-1111-1111-1111-0000000d00d4', 'a1111111-1111-1111-1111-0000000d00f2',
     'a1111111-1111-1111-1111-0000000d0005', 'a1111111-1111-1111-1111-0000000d0006', 'Org A U10', 1, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e08', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a00', 'a1111111-1111-1111-1111-0000000d00d8', 'a1111111-1111-1111-1111-0000000d00d8', 'a1111111-1111-1111-1111-0000000d00f2',
     'a1111111-1111-1111-1111-0000000d0002', 'a1111111-1111-1111-1111-0000000d0004', 'Org A U10', 2, '2026-04-11T10:00:00Z', '2026-04-11T11:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e09', 'a1111111-1111-1111-1111-111111111111', NULL, 'a1111111-1111-1111-1111-0000000d00db', 'a1111111-1111-1111-1111-0000000d00db', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d0007', 'a1111111-1111-1111-1111-0000000d0008', 'C U10', 1, '2026-03-07T08:00:00Z', '2026-03-07T09:00:00Z', 'auto'),
    ('b2222222-2222-2222-2222-0000000d0e01', 'b2222222-2222-2222-2222-222222222222', NULL, 'b2222222-2222-2222-2222-0000000d00d1', 'b2222222-2222-2222-2222-0000000d00d1', 'b2222222-2222-2222-2222-0000000d00f1',
     'bbbbbbbb-0000-0000-0000-000000000002', 'b2222222-2222-2222-2222-0000000d0002', 'Org B U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto');
UPDATE public.game_assignments SET published = true WHERE id = 'a1111111-1111-1111-1111-0000000d0e01';
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-1111111100c1';
-- Org A's game count and Org B's game, as they stand before anything below runs.
CREATE TEMP TABLE idbase ON COMMIT DROP AS
    SELECT (SELECT count(*)::int FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111') AS org_a_games,
           (SELECT count(*)::int FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND run_type = 'game') AS org_a_runs,
           (SELECT to_jsonb(ga.*)::text FROM public.game_assignments ga WHERE ga.id = 'b2222222-2222-2222-2222-0000000d0e01') AS gb1,
           (SELECT to_jsonb(ga.*)::text FROM public.game_assignments ga WHERE ga.id = 'a1111111-1111-1111-1111-0000000d0e09') AS ec1;
GRANT SELECT ON idbase TO PUBLIC;

-- ── This file's additions to the seed (still no signed-in user) ────────────
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.organizations SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"score_entry": true}'::jsonb
 WHERE id IN ('a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222');
-- Two outside clubs of the division (never one of the organization's teams), a game of T1 against one (e0a, week 3)
-- and a fixture of the two clubs (e0b, week 4), both in the run the page shows.
INSERT INTO public.teams (id, organization_id, division_id, name, is_external) VALUES
    ('a1111111-1111-1111-1111-0000000d00e1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Outside One', true),
    ('a1111111-1111-1111-1111-0000000d00e2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Outside Two', true);
INSERT INTO public.game_assignments (id, organization_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source) VALUES
    ('a1111111-1111-1111-1111-0000000d0e0a', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00d9', 'a1111111-1111-1111-1111-0000000d00d9', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d0001', 'a1111111-1111-1111-1111-0000000d00e1', 'Org A U10', 3, '2026-04-18T08:00:00Z', '2026-04-18T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000d0e0b', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000d0a01', 'a1111111-1111-1111-1111-0000000d00da', 'a1111111-1111-1111-1111-0000000d00da', 'a1111111-1111-1111-1111-0000000d00f1',
     'a1111111-1111-1111-1111-0000000d00e1', 'a1111111-1111-1111-1111-0000000d00e2', 'Org A U10', 4, '2026-04-25T08:00:00Z', '2026-04-25T09:00:00Z', 'auto');

-- e: a game's id by its last two characters; t: a team's; d: a slot's.
CREATE FUNCTION pg_temp.e(p text) RETURNS uuid LANGUAGE sql AS $f$ SELECT ('a1111111-1111-1111-1111-0000000d0e' || p)::uuid $f$;
CREATE FUNCTION pg_temp.t(p text) RETURNS uuid LANGUAGE sql AS $f$ SELECT ('a1111111-1111-1111-1111-0000000d00' || p)::uuid $f$;
-- sched: the schedule the page holds (every game of the run it shows, by id, as it is), with per-id replacements and ids
-- left out.
CREATE FUNCTION pg_temp.sched(p_ovr jsonb DEFAULT '{}', p_skip uuid[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $f$
    SELECT COALESCE(jsonb_agg(COALESCE(p_ovr -> ga.id::text, pg_temp.gi(ga.id)) ORDER BY ga.id), '[]'::jsonb)
      FROM public.game_assignments ga WHERE ga.run_id = pg_temp.latest_run() AND ga.id <> ALL (p_skip)
$f$;
-- score: update_game_score for Org A, as text ('home-away changed' or the error as SQLSTATE:DETAIL); the write stays.
CREATE FUNCTION pg_temp.score(p_game uuid, p_home integer, p_away integer, p_org uuid DEFAULT 'a1111111-1111-1111-1111-111111111111') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE r jsonb; s text; d text;
BEGIN
    r := public.update_game_score(p_org, p_game, p_home::smallint, p_away::smallint);
    RETURN COALESCE(r ->> 'score_home', '-') || '-' || COALESCE(r ->> 'score_away', '-') || ' changed=' || (r ->> 'changed')
           || ' was=' || COALESCE(r ->> 'previous_score_home', '-') || '-' || COALESCE(r ->> 'previous_score_away', '-');
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;
-- stored: a game's stored score as 'home-away by <last 4 of updated_by>', or 'none'.
CREATE FUNCTION pg_temp.stored(p_game uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE $q$SELECT score_home || '-' || score_away || ' by ' || COALESCE(right(updated_by::text, 4), 'nobody') FROM public.game_scores WHERE game_id = $1$q$ INTO r USING p_game;
    RETURN COALESCE(r, 'none');
EXCEPTION WHEN undefined_table THEN
    RETURN 'ERROR no table';
END
$f$;
-- standing: a team's standings row as 'played W-L-D gf:ga pts not_counted', or 'no row'.
CREATE FUNCTION pg_temp.standing(p_team uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE $q$SELECT games_played || ' ' || wins || '-' || losses || '-' || draws || ' ' || goals_for || ':' || goals_against || ' ' || points || ' nc=' || results_not_counted
                 FROM public.view_league_standings WHERE team_id = $1$q$ INTO r USING p_team;
    RETURN COALESCE(r, 'no row');
EXCEPTION WHEN undefined_column THEN
    RETURN 'ERROR no column';
END
$f$;
-- audits: how many competition.score_updated rows a game has.
CREATE FUNCTION pg_temp.audits(p_game uuid) RETURNS integer LANGUAGE sql AS $f$
    SELECT count(*)::int FROM public.audit_log WHERE action = 'competition.score_updated' AND resource_id = p_game
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.e(text), pg_temp.t(text), pg_temp.sched(jsonb, uuid[]), pg_temp.score(uuid, integer, integer, uuid),
    pg_temp.stored(uuid), pg_temp.standing(uuid), pg_temp.audits(uuid) TO PUBLIC;

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 1. The shape ───────────────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable, '; ' ORDER BY ordinal_position)
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'game_scores'$$),
    'game_id uuid NO; organization_id uuid NO; home_team_id uuid NO; away_team_id uuid NO; score_home smallint NO; score_away smallint NO; created_at timestamp with time zone NO; updated_at timestamp with time zone NO; updated_by uuid YES',
    'game_scores: the game, the organization, the two sides as scored, both scores required, when and who');
SELECT is(pg_temp.val($$SELECT c.confdeltype || c.confupdtype || ' ' || pg_get_constraintdef(c.oid) FROM pg_constraint c
    WHERE c.conrelid = 'public.game_scores'::regclass AND c.contype = 'f' AND c.confrelid = 'public.game_assignments'::regclass$$),
    'aa FOREIGN KEY (game_id, organization_id, home_team_id, away_team_id) REFERENCES game_assignments(id, organization_id, home_team_id, away_team_id)',
    'one foreign key from the score to the saved game AND its sides, NO ACTION on delete and on update');
SELECT is(pg_temp.val($$SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.game_scores'::regclass AND c.contype = 'p'$$),
    'PRIMARY KEY (game_id)', 'a game has at most one score row');
SELECT is(pg_temp.val($$SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.game_scores'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ~ '>= 0'$$), '2', 'neither score is negative (two checks)');
SELECT is(pg_temp.val($$SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.game_scores'::regclass$$), 'true',
    'row level security is on');
SELECT is(pg_temp.val($$SELECT string_agg(polcmd::text || ':' || pg_get_expr(polqual, polrelid), ',') FROM pg_policy WHERE polrelid = 'public.game_scores'::regclass$$),
    'r:is_org_member(organization_id)', 'one policy: members read; no insert, update or delete policy (the RPC is the only writer)');
SELECT is(pg_temp.val($$SELECT COALESCE(string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type), 'none')
    FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'game_scores' AND grantee IN ('anon', 'authenticated', 'PUBLIC')$$),
    'authenticated:SELECT', 'a signed-in user is granted SELECT and nothing else; anon nothing');
SELECT is(pg_temp.val($$SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.game_scores'::regclass AND tgname = 'game_scores_readonly_when_completed'$$),
    'CREATE TRIGGER game_scores_readonly_when_completed BEFORE INSERT OR DELETE OR UPDATE ON public.game_scores FOR EACH ROW EXECUTE FUNCTION season_schedule_readonly_when_completed()',
    'the completed-season rule covers the score table (lesson 66), by the existing function');
SELECT is(pg_temp.val($$SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.view_league_standings'::regclass AND attnum > 0$$),
    'team_id,organization_id,team_name,division_id,games_played,wins,losses,draws,goals_for,goals_against,goal_differential,points,division,season_settings_id,results_not_counted',
    'view_league_standings keeps its columns in their order; the one added column is last');
SELECT is(pg_temp.val($$SELECT string_agg(c.relname || ':' || c.reloptions::text, ',' ORDER BY c.relname) FROM pg_class c
    WHERE c.oid IN (to_regclass('public.view_league_standings'), to_regclass('public.current_game_runs'))$$),
    'current_game_runs:{security_invoker=true},view_league_standings:{security_invoker=true}',
    'both views run with the reader''s rights');
SELECT is(pg_temp.val($$SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.current_game_runs'::regclass AND attnum > 0$$),
    'organization_id,season_settings_id,run_id,completed_at', 'current_game_runs: the organization, the season, its run');
SELECT is(pg_temp.val($$SELECT count(*) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
    WHERE r.ev_class = 'public.view_league_standings'::regclass AND d.refobjid = 'public.games'::regclass$$), '0',
    'the standings view no longer reads the legacy games table');

-- ── 2. update_game_score names a saved game ────────────────────────────────
SELECT is(pg_temp.stored(pg_temp.e('02')), 'none', 'control: e02 has no score');
SELECT is(pg_temp.score(pg_temp.e('02'), 3, 1), '3-1 changed=true was=---', 'a score is entered on a saved game (its id is the game_assignments id)');
SELECT is(pg_temp.stored(pg_temp.e('02')), '3-1 by 1111', 'it is stored in game_scores, with who entered it');
SELECT is(pg_temp.val($$SELECT (metadata ->> 'game_id') || ' ' || (metadata ->> 'score_home') || '-' || (metadata ->> 'score_away') || ' was ' || COALESCE(metadata ->> 'previous_score_home', 'null')
    || ' ' || right(metadata ->> 'home_team_id', 4) || '>' || right(metadata ->> 'away_team_id', 4)
    FROM public.audit_log WHERE action = 'competition.score_updated' AND resource_id = pg_temp.e('02')$$),
    'a1111111-1111-1111-1111-0000000d0e02 3-1 was null 0003>0004', 'and audited as before, with the previous values and the sides');
SELECT is(pg_temp.score(pg_temp.e('02'), 3, 1), '3-1 changed=false was=3-1', 'the same score again changes nothing');
SELECT is(pg_temp.audits(pg_temp.e('02')), 1, 'and writes no second audit row');
SELECT is(pg_temp.score(pg_temp.e('02'), 2, 2), '2-2 changed=true was=3-1', 'an edit replaces the score');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_scores WHERE game_id = pg_temp.e('02')$$), '1', 'in the one row');
SELECT is(pg_temp.score(pg_temp.e('02'), 2, NULL), '22023:score_one_sided', 'D10: one score without the other is refused');
SELECT is(pg_temp.score(pg_temp.e('02'), NULL, 0), '22023:score_one_sided', 'either way round');
SELECT is(pg_temp.stored(pg_temp.e('02')), '2-2 by 1111', 'and nothing was written by the refusal');
SELECT is(pg_temp.score(pg_temp.e('02'), -1, 0), '23514:', 'a negative score is refused as before');
SELECT is(pg_temp.score(pg_temp.e('02'), NULL, NULL), '--- changed=true was=2-2', 'clearing takes both scores away');
SELECT is(pg_temp.stored(pg_temp.e('02')), 'none', 'the row is gone: a row exists exactly when the game is scored');
SELECT is(pg_temp.audits(pg_temp.e('02')), 3, 'entering, editing and clearing are three audit rows');
SELECT is(pg_temp.score(pg_temp.e('02'), NULL, NULL), '--- changed=false was=---', 'clearing a game with no score changes nothing');
SELECT is(pg_temp.score('b2222222-2222-2222-2222-0000000d0e01', 1, 0), '42501:', 'another organization''s game is not found');
SELECT is(pg_temp.score(gen_random_uuid(), 1, 0), '42501:', 'nor is an id that names no game');
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.games (id, organization_id, season_id, home_team_id, away_team_id, start_time)
VALUES ('a1111111-1111-1111-1111-0000000d0f01', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.t('01'), pg_temp.t('02'), '2026-04-04T08:00:00Z');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.score('a1111111-1111-1111-1111-0000000d0f01', 1, 0), '42501:', 'nor is the id of a row of the legacy games table: a score names a saved game');
SELECT is(pg_temp.val($$SELECT COALESCE(score_home::text, 'null') FROM public.games WHERE id = 'a1111111-1111-1111-1111-0000000d0f01'$$), 'null',
    'and the legacy row is not written');
SELECT is(pg_temp.score(pg_temp.e('09'), 1, 0), '22023:season_completed', 'a completed season refuses a score');
SELECT is(pg_temp.stored(pg_temp.e('09')), 'none', 'with nothing written');
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.organizations SET feature_flags = feature_flags - 'score_entry' WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.score(pg_temp.e('02'), 1, 0), '55000:', 'score entry off refuses as before (55000)');
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.organizations SET feature_flags = feature_flags || '{"score_entry": true}'::jsonb WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.score(pg_temp.e('02'), 1, 0), '42501:', 'someone who is no member of the organization is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.score(pg_temp.e('02'), 1, 0), '42501:', 'and so is another organization''s admin');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.stored(pg_temp.e('02')), 'none', 'none of the refusals wrote');

-- ── 3. The held rule: one predicate ────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT public.game_is_held(pg_temp.e('02'))::text || public.game_is_held(pg_temp.e('01'))::text$$), 'falsetrue',
    'control: an unscored, unpublished game is not held; the Published one is');
SELECT is(pg_temp.score(pg_temp.e('02'), 3, 1), '3-1 changed=true was=---', 'e02 is scored');
SELECT is(pg_temp.val($$SELECT public.game_is_held(pg_temp.e('02'))::text$$), 'true', 'a scored game is held');
SELECT is(pg_temp.val($$SELECT string_agg(right(h::text, 4), ',' ORDER BY h) FROM public.game_held_ids(ARRAY[pg_temp.e('01'), pg_temp.e('02'), pg_temp.e('03')]) h$$),
    '0e01,0e02', 'the set form says the same: Published or scored');
SELECT is(pg_temp.val($$SELECT COALESCE(public.game_hold_code(pg_temp.e('01')), 'null') || ' ' || COALESCE(public.game_hold_code(pg_temp.e('02')), 'null') || ' ' || COALESCE(public.game_hold_code(pg_temp.e('03')), 'null')$$),
    'game_published game_scored null', 'and the words for why: Published, scored, not held');
-- Moved, flipped, cancelled, deleted, left out: each refused for the scored game and allowed for its unscored twin (e03).
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched(jsonb_build_object(%L, pg_temp.mv(%L, 'a1111111-1111-1111-1111-0000000d00d8'))))$$, pg_temp.e('02'), pg_temp.e('02'))),
    '22023:game_scored', 'a scored game cannot be moved by a save');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched(jsonb_build_object(%L, pg_temp.mv(%L, 'a1111111-1111-1111-1111-0000000d00d8'))))$$, pg_temp.e('03'), pg_temp.e('03'))),
    'no error', 'control: its unscored twin can');
SELECT is(pg_temp.msg(format($$SELECT pg_temp.save(pg_temp.sched(jsonb_build_object(%L, pg_temp.mv(%L, 'a1111111-1111-1111-1111-0000000d00d8'))))$$, pg_temp.e('02'), pg_temp.e('02'))),
    'Game a1111111-1111-1111-1111-0000000d0e02 has a score and cannot be moved: clear its score first', 'and the refusal says what to do');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched(jsonb_build_object(%L, pg_temp.flip(%L))))$$, pg_temp.e('02'), pg_temp.e('02'))),
    '22023:game_scored', 'nor have its sides swapped');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched(jsonb_build_object(%L, pg_temp.flip(%L))))$$, pg_temp.e('03'), pg_temp.e('03'))),
    'no error', 'control: the twin flips');
SELECT is(pg_temp.errx(format($$SELECT public.admin_cancel_game_assignment(%L)$$, pg_temp.e('02'))), '22023:game_scored', 'a scored game cannot be cancelled');
SELECT is(pg_temp.msg(format($$SELECT public.admin_cancel_game_assignment(%L)$$, pg_temp.e('02'))),
    'game a1111111-1111-1111-1111-0000000d0e02 has a score and cannot be cancelled: clear its score first', 'in its own words');
SELECT is(pg_temp.errx(format($$SELECT public.admin_cancel_game_assignment(%L)$$, pg_temp.e('03'))), 'no error', 'control: the twin is cancelled');
SELECT is(pg_temp.errx(format($$DELETE FROM public.game_assignments WHERE id = %L$$, pg_temp.e('02'))), '22023:game_scored', 'the guard refuses a signed-in delete of a scored game');
SELECT is(pg_temp.errx(format($$DELETE FROM public.game_assignments WHERE id = %L$$, pg_temp.e('03'))), 'no error', 'control: and lets the twin go');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched('{}', ARRAY[%L]::uuid[]))$$, pg_temp.e('02'))),
    '22023:game_scored_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e02', 'a save that leaves a scored game out is refused, naming it');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched('{}', ARRAY[%L]::uuid[]))$$, pg_temp.e('03'))), 'no error', 'control: the twin may be left out');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched('{}', ARRAY[%L]::uuid[]))$$, pg_temp.e('01'))),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e01', 'a Published game left out keeps its own code');
SELECT is(pg_temp.errx(format($$SELECT pg_temp.save(pg_temp.sched('{}', ARRAY[%L, %L]::uuid[]))$$, pg_temp.e('01'), pg_temp.e('02'))),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e01', 'with both left out the Published ones are named first');
SELECT is(pg_temp.errx(format($$SELECT public.admin_cancel_game_assignment(%L)$$, pg_temp.e('01'))), '22023:game_published', 'a Published game still refuses a cancel as Published');
-- A Published game that is also scored: Published is said first; after changes are allowed, the score still holds it.
SELECT is(pg_temp.score(pg_temp.e('01'), 1, 1), '1-1 changed=true was=---', 'a Published game can be scored');
SELECT is(pg_temp.errx(format($$SELECT public.admin_cancel_game_assignment(%L)$$, pg_temp.e('01'))), '22023:game_published', 'Published and scored: refused as Published');
SELECT is(pg_temp.errx(format($$SELECT public.admin_set_games_published(%L, ARRAY[%L]::uuid[], false, 'a wrong date'); SELECT public.admin_cancel_game_assignment(%L)$$,
    'a1111111-1111-1111-1111-111111111111', pg_temp.e('01'), pg_temp.e('01'))), '22023:game_scored', 'after changes are allowed the score still holds it');
SELECT is(pg_temp.score(pg_temp.e('01'), NULL, NULL), '--- changed=true was=1-1', '(its score is cleared again)');
-- Clearing lifts the hold.
SELECT is(pg_temp.errx(format($$SELECT public.update_game_score('a1111111-1111-1111-1111-111111111111', %L, NULL, NULL); SELECT public.admin_cancel_game_assignment(%L)$$, pg_temp.e('02'), pg_temp.e('02'))),
    'no error', 'clearing the score lifts the hold: the game can then be cancelled');
-- The score survives a save that moves the unscored games around it.
SELECT is(pg_temp.err(format($$SELECT pg_temp.save(pg_temp.sched(jsonb_build_object(%L, pg_temp.mv(%L, 'a1111111-1111-1111-1111-0000000d00d8'))))$$, pg_temp.e('03'), pg_temp.e('03'))),
    'no error', 'a save that moves an unscored game and carries the scored one is accepted');
SELECT is(pg_temp.stored(pg_temp.e('02')), '3-1 by 1111', 'the score is still on the same game id');
SELECT is(pg_temp.val($$SELECT (run_id = pg_temp.latest_run())::text || ' ' || pg_temp.placed(id) FROM public.game_assignments WHERE id = pg_temp.e('02')$$),
    'true 0003>0004@00d2/1', 'the game is in the run the page shows, where it was');
SELECT is(pg_temp.placed(pg_temp.e('03')), '0001>0003@00d8/2', 'and the unscored game moved');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_scores$$), '1', 'one score, counted once');

-- ── 4. The database is the backstop ────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx(format($$DELETE FROM public.game_assignments WHERE id = %L$$, pg_temp.e('02'))), '23503:',
    'with no signed-in user the guard passes and the foreign key refuses a delete that skipped the check');
SELECT is(pg_temp.errx(format($$DELETE FROM public.game_assignments WHERE id = %L$$, pg_temp.e('04'))), 'no error', 'control: an unscored game is deleted');
SELECT is(pg_temp.errx(format($$ALTER TABLE public.game_assignments DISABLE TRIGGER game_assignments_published_guard;
    UPDATE public.game_assignments SET home_team_id = %L WHERE id = %L$$, pg_temp.t('05'), pg_temp.e('02'))), '23503:',
    'a team swap under a score is refused by the key even with the guard trigger disabled');
SELECT is(pg_temp.errx(format($$ALTER TABLE public.game_assignments DISABLE TRIGGER game_assignments_published_guard;
    UPDATE public.game_assignments SET home_team_id = %L WHERE id = %L$$, pg_temp.t('01'), pg_temp.e('04'))), 'no error', 'control: the same swap on an unscored game goes through');
SELECT is(pg_temp.errx(format($$UPDATE public.game_scores SET home_team_id = %L WHERE game_id = %L$$, pg_temp.t('05'), pg_temp.e('02'))), '23503:',
    'and the score''s own sides cannot drift from the game''s');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.errx(format($$INSERT INTO public.game_scores (game_id, organization_id, home_team_id, away_team_id, score_home, score_away)
    SELECT id, organization_id, home_team_id, away_team_id, 1, 0 FROM public.game_assignments WHERE id = %L$$, pg_temp.e('05'))), '42501:',
    'an admin cannot insert a score directly: the RPC is the only writer');
SELECT is(pg_temp.errx(format($$DELETE FROM public.game_scores WHERE game_id = %L$$, pg_temp.e('02'))), '42501:', 'nor delete one');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_scores$$), '1', 'an admin of the organization reads its scores');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_scores$$), '0', 'another organization''s admin reads none of them');
RESET ROLE;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 5. Standings ───────────────────────────────────────────────────────────
-- e02 T3 3-1 T4 stands. e0a: T1 2-0 Outside One. e0b: Outside One 5-0 Outside Two. e05: T5 1-1 T6.
SELECT is(pg_temp.score(pg_temp.e('0a'), 2, 0), '2-0 changed=true was=---', 'a game against an outside club is scored');
SELECT is(pg_temp.score(pg_temp.e('0b'), 5, 0), '5-0 changed=true was=---', 'and so is a fixture of two outside clubs');
SELECT is(pg_temp.score(pg_temp.e('05'), 1, 1), '1-1 changed=true was=---', 'and a draw');
SELECT is(pg_temp.standing(pg_temp.t('03')), '1 1-0-0 3:1 3 nc=0', 'the winner: one played, one win, three points');
SELECT is(pg_temp.standing(pg_temp.t('04')), '1 0-1-0 1:3 0 nc=0', 'the loser');
SELECT is(pg_temp.standing(pg_temp.t('05')) || ' / ' || pg_temp.standing(pg_temp.t('06')), '1 0-0-1 1:1 1 nc=0 / 1 0-0-1 1:1 1 nc=0', 'a draw is a point each');
SELECT is(pg_temp.standing(pg_temp.t('02')), '0 0-0-0 0:0 0 nc=0', 'an own team with no result has a row of zeros');
SELECT is(pg_temp.standing(pg_temp.t('e1')) || ' / ' || pg_temp.standing(pg_temp.t('e2')), 'no row / no row', 'an outside club never has a standings row');
SELECT is(pg_temp.val($$SELECT public.standings_counts_outside('a1111111-1111-1111-1111-11111111abcd')::text$$), 'false', 'control: results against outside clubs are not counted unless the organization says so');
SELECT is(pg_temp.standing(pg_temp.t('01')), '0 0-0-0 0:0 0 nc=1', 'by default an own team''s result against an outside club is not counted, and the row says one was left out');
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.organizations SET feature_flags = feature_flags || '{"standings_count_outside_results": true}'::jsonb WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT public.standings_counts_outside('a1111111-1111-1111-1111-11111111abcd')::text$$), 'true', 'the organization turns it on');
SELECT is(pg_temp.standing(pg_temp.t('01')), '1 1-0-0 2:0 3 nc=0', 'and the result against the outside club counts for the own team');
SELECT is(pg_temp.standing(pg_temp.t('e1')), 'no row', 'the outside club still has no row');
SELECT is(pg_temp.standing(pg_temp.t('03')), '1 1-0-0 3:1 3 nc=0', 'control: a result between two own teams is the same either way');
SELECT is(pg_temp.val($$SELECT sum(games_played) || ' ' || sum(results_not_counted) FROM public.view_league_standings WHERE division_id = 'a1111111-1111-1111-1111-11111111abcd'$$),
    '5 0', 'the fixture of two outside clubs counts for nobody (five sides played: e02 and e05 twice each, e0a once)');
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.organizations SET feature_flags = feature_flags - 'standings_count_outside_results' WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT count(*) || ' ' || count(*) FILTER (WHERE team_id IN (SELECT id FROM public.teams WHERE is_external)) FROM public.view_league_standings
    WHERE division_id = 'a1111111-1111-1111-1111-11111111abcd'$$),
    (SELECT count(*) || ' 0' FROM public.teams WHERE division_id = 'a1111111-1111-1111-1111-11111111abcd' AND NOT is_external),
    'the division''s rows are its own teams, every one of them (counted from teams), and no outside club');

-- ── 6. current_game_runs ───────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT run_id::text FROM public.current_game_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    pg_temp.latest_run()::text, 'the season''s current run is the latest completed game run, as the page picks it');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.current_game_runs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$), '1', 'one row for the season, however many runs it has');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.current_game_runs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111100d1'$$), '0', 'a season with no game run has no row');
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
    ('a1111111-1111-1111-1111-0000000d0a71', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'failed', '2099-01-01T00:00:00Z'),
    ('a1111111-1111-1111-1111-0000000d0a72', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'practice', 'completed', '2099-01-02T00:00:00Z'),
    ('a1111111-1111-1111-1111-0000000d0a73', 'a1111111-1111-1111-1111-111111111111', NULL, NULL, 'game', 'completed', '2099-01-03T00:00:00Z'),
    ('a1111111-1111-1111-1111-0000000d0a74', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100d1', NULL, 'game', 'completed', '2026-01-01T00:00:00Z');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT run_id::text FROM public.current_game_runs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    pg_temp.latest_run()::text, 'a later run that failed, a later practice run and a later run with no season do not take its place');
SELECT is(pg_temp.val($$SELECT run_id::text FROM public.current_game_runs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111100d1'$$),
    'a1111111-1111-1111-1111-0000000d0a74', 'a run that names its season only in the older season_id column is found, as the page finds it');
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.val($$SELECT count(*) FROM public.current_game_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '0',
    'another organization''s admin reads none of Org A''s runs through the view');
RESET ROLE;

-- ── 7. Delete team (D5) and the organization cascade (U5) ──────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.errx(format($$SELECT public.admin_delete_team(%L)$$, pg_temp.t('01'))), '22023:game_published', 'a team with a Published game is still refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_delete_team(%L)$$, pg_temp.t('06'))), 'no error', 'a team whose scored games are not Published is deleted');
SELECT is(pg_temp.stored(pg_temp.e('05')) || ' ' || pg_temp.placed(pg_temp.e('05')), 'none gone', 'its games and their scores go with it');
SELECT is(pg_temp.val($$SELECT metadata ->> 'scores_deleted' FROM public.audit_log WHERE action = 'team.deleted' AND resource_id = pg_temp.t('06')$$), '1',
    'and the audit row counts the scores it took');
SELECT is(pg_temp.stored(pg_temp.e('02')), '3-1 by 1111', 'control: another team''s score is untouched');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.score('b2222222-2222-2222-2222-0000000d0e01', 4, 4, 'b2222222-2222-2222-2222-222222222222'), '4-4 changed=true was=---', 'Org B scores its game');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.err($$DELETE FROM public.organizations WHERE id = 'b2222222-2222-2222-2222-222222222222'$$), 'no error',
    'U5: deleting an organization with a scored game succeeds (NO ACTION is checked after the cascade)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_scores WHERE organization_id = 'b2222222-2222-2222-2222-222222222222'$$), '0', 'and its scores are gone with it');

-- ── 8. The legacy copy ─────────────────────────────────────────────────────
-- The legacy row f01 (T1 against T2, no slot) has no score: nothing to copy.
SELECT is(pg_temp.val($$SELECT public.copy_legacy_game_scores()::text$$), '{"copied": 0, "scored": 0, "already": 0}', 'with no scored legacy row the copy does nothing');
UPDATE public.games SET score_home = 9, score_away = 8 WHERE id = 'a1111111-1111-1111-1111-0000000d0f01';
SELECT is(pg_temp.errx($$SELECT public.copy_legacy_game_scores()$$), '55000:legacy_score_unmatched count=1 ids=a1111111-1111-1111-1111-0000000d0f01',
    'a scored legacy row that matches no saved game refuses the copy, naming it');
UPDATE public.games SET home_team_id = pg_temp.t('01'), away_team_id = pg_temp.t('03'), game_slot_id = 'a1111111-1111-1111-1111-0000000d00d8'
 WHERE id = 'a1111111-1111-1111-1111-0000000d0f01';
SELECT is(pg_temp.val($$SELECT public.copy_legacy_game_scores()::text$$), '{"copied": 1, "scored": 1, "already": 0}', 'one that matches exactly one saved game (home, away, slot) is copied');
SELECT is(pg_temp.stored(pg_temp.e('03')), '9-8 by nobody', 'onto that game');
SELECT is(pg_temp.val($$SELECT public.copy_legacy_game_scores()::text$$), '{"copied": 0, "scored": 1, "already": 1}', 'and a second run copies nothing twice');
UPDATE public.games SET score_away = NULL WHERE id = 'a1111111-1111-1111-1111-0000000d0f01';
SELECT is(pg_temp.val($$SELECT public.copy_legacy_game_scores()::text$$), '{"copied": 0, "scored": 0, "already": 0}', 'a one-sided legacy entry was never a result (the old view ignored it) and is not one now');

SELECT * FROM finish();
ROLLBACK;
