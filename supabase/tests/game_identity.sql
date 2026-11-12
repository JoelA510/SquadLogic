-- pgTAP: a game keeps its id through a save (migration 20261120010000; plan
-- docs/changes/2026-11-06-games-table-source-of-truth.md, "Identity (F11-1)", task A1).
--
-- Written first, and red against the code before the migration. Every refusal below is paired with a control that the
-- allowed twin passes, so a check that refuses everything fails too (the file's `errx` undoes what a statement did,
-- so the same payload can be tried again):
--
--   * the shape: `game_assignments.season_settings_id` (a foreign key, indexed, nullable for rows that exist before the
--     migration), the four-column unique index the later score table will reference, and the two held-predicate
--     functions;
--   * I1, a save updates in place: a payload row that names a game of the organization by `id` moves, flips or carries
--     that game, and the game keeps its id, leaves no hidden row behind and is part of the new run; a row without an
--     id is upserted on the matchup tuple exactly as before (a move is then a new row); nothing is deleted by a save;
--   * the refusals, each with nothing written: an unknown id and another organization's id (the same words, so an
--     admin cannot tell them apart), a repeated id, an id that is not a uuid, a game of a completed season, a Published
--     game moved or flipped by id, and an in-place update whose new tuple is another row's tuple (an older hidden row,
--     a row of the same save, a new row of the same save), `game_identity_conflict`, both ids in the DETAIL;
--   * two games that swap places in one save succeed (the unique index is not deferrable, so the save has to take the
--     moving rows out of it first);
--   * the omission check counts a Published game as present if its id OR its tuple is in the payload;
--   * the season is stored on the game by the save, and a save that names a season refuses a game named by its id
--     whose STORED season is another one (`game_identity_season`), after the ids exist and before the collisions; a game
--     with no stored season, and a save with no season, are not refused;
--   * one predicate: the guard trigger, `admin_cancel_game_assignment`, `admin_delete_team`, the omission check and an
--     in-place move all ask `game_held_ids`/`game_is_held`, shown by replacing that one body inside the transaction.
--
-- The seed runs with no signed-in user (the guard and the completed-season trigger let that through), as lesson 56
-- asks. `supabase/tests/game_persistence_rpc.sql` (27 assertions) and `game_published.sql` stay as they are: a row
-- without an id behaves as before.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(100);

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

SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '9',
    'control: the seed is nine games of Org A (seven in the run the page shows, one older hidden row, one in the completed season)');
SELECT is(pg_temp.visible(), '0e01,0e02,0e03,0e04,0e05,0e06,0e07',
    'control: the page shows the seven games of the latest run, and not the older hidden one');

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 1. The shape ───────────────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '-'), '; ')
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'game_assignments' AND column_name = 'season_settings_id'$$),
    'season_settings_id uuid YES -',
    'game_assignments gains season_settings_id (uuid, nullable: a row saved before this migration has none)');
SELECT ok(COALESCE((SELECT c.confdeltype = 'n' AND c.confrelid = 'public.season_settings'::regclass FROM pg_constraint c
                     WHERE c.conrelid = 'public.game_assignments'::regclass AND c.contype = 'f'
                       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'season_settings_id')]), false),
    'it references season_settings and is set null when the season goes (a game is never deleted by the season pointer)');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments' AND indexdef ~ '\(season_settings_id\)'),
    'and is indexed (the foreign key is not a sequential scan on a season delete)');
SELECT ok(EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.game_assignments'::regclass AND i.indisunique AND i.indpred IS NULL
                   AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
                       = ARRAY['id', 'organization_id', 'home_team_id', 'away_team_id']),
    'a unique index on (id, organization_id, home_team_id, away_team_id), the key the score table will reference');
SELECT ok(COALESCE((SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
                      FROM pg_proc p WHERE p.oid = to_regprocedure('public.game_held_ids(uuid[])')), false)
          AND COALESCE((SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                      FROM pg_proc p WHERE p.oid = to_regprocedure('public.game_is_held(uuid)')), false),
    'game_is_held(uuid) and its set form game_held_ids(uuid[]) are STABLE invoker functions pinned to search_path=public');
SELECT ok(COALESCE(NOT has_function_privilege('authenticated', to_regprocedure('public.game_is_held(uuid)'), 'EXECUTE')
                   AND NOT has_function_privilege('anon', to_regprocedure('public.game_is_held(uuid)'), 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', to_regprocedure('public.game_held_ids(uuid[])'), 'EXECUTE')
                   AND NOT has_function_privilege('anon', to_regprocedure('public.game_held_ids(uuid[])'), 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE p.oid IN (to_regprocedure('public.game_is_held(uuid)'), to_regprocedure('public.game_held_ids(uuid[])')) AND a.grantee = 0), false),
    'both are internal: no client role and not PUBLIC may execute them (the definer functions and the trigger call them as their owner)');
SELECT ok(COALESCE((SELECT g.tgenabled = 'O' AND pg_get_triggerdef(g.oid) ~ 'BEFORE (DELETE OR UPDATE|UPDATE OR DELETE) ON public.game_assignments FOR EACH ROW EXECUTE FUNCTION'
                      FROM pg_trigger g WHERE g.tgrelid = 'public.game_assignments'::regclass AND g.tgname = 'game_assignments_published_guard' AND NOT g.tgisinternal), false),
    'the guard fires for every row and asks the predicate (it had WHEN (OLD.published), which a score could not change)');

-- ── 2. The held predicate ──────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT public.game_is_held('a1111111-1111-1111-1111-0000000d0e01')$$), 'true', 'a Published game is held');
SELECT is(pg_temp.val($$SELECT public.game_is_held('a1111111-1111-1111-1111-0000000d0e02')$$), 'false', 'control: its unpublished twin is not');
SELECT is(pg_temp.val($$SELECT public.game_is_held('a1111111-1111-1111-1111-0000000d0eee')$$), 'false', 'a game that does not exist is not held');
SELECT is(pg_temp.val($$SELECT public.game_is_held(NULL)$$), 'false', 'and neither is no game (never NULL: a caller cannot read "unknown" as "not held" by accident)');
SELECT is(pg_temp.val($$SELECT string_agg(right(h::text, 4), ',' ORDER BY h) FROM public.game_held_ids(ARRAY['a1111111-1111-1111-1111-0000000d0e01', 'a1111111-1111-1111-1111-0000000d0e02',
        'a1111111-1111-1111-1111-0000000d0eee']::uuid[]) h$$),
    '0e01', 'the set form returns exactly the held ones among the ids it is given (an unknown id is no row)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_held_ids(ARRAY[]::uuid[])$$), '0', 'an empty list holds nothing');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_held_ids(NULL)$$), '0', 'and so does none');

-- ── 3. The refusals, each with its control ─────────────────────────────────
-- Every probe is undone; the state below is the seed's.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7())$$), 'no error',
    'control: the page''s whole schedule, every game by its id and where it is, is saved');
-- An id that is not a game of the organization.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "a1111111-1111-1111-1111-0000000d0eee"}')))$$),
    '23503:game_not_found', 'an id that does not exist is refused');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "b2222222-2222-2222-2222-0000000d0e01"}')))$$),
    '23503:game_not_found', 'an id of another organization is refused, in the words of one that does not exist');
SELECT ok(pg_temp.msg($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "b2222222-2222-2222-2222-0000000d0e01"}')))$$) <> 'no error'
      AND pg_temp.msg($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "b2222222-2222-2222-2222-0000000d0e01"}')))$$)
        = replace(pg_temp.msg($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "a1111111-1111-1111-1111-0000000d0eee"}')))$$),
        'a1111111-1111-1111-1111-0000000d0eee', 'b2222222-2222-2222-2222-0000000d0e01'),
    'and the two messages are the same words, so an admin cannot test whether an id exists in a tenant they do not belong to');
SELECT is(pg_temp.val($$SELECT (to_jsonb(ga.*)::text = (SELECT gb1 FROM idbase))::text FROM public.game_assignments ga WHERE ga.id = 'b2222222-2222-2222-2222-0000000d0e01'$$), 'true',
    'and Org B''s game is exactly as it was: a payload id of one organization reaches no row of another');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.errx($$SELECT public.persist_game_schedule(
        jsonb_build_object('organization_id', 'b2222222-2222-2222-2222-222222222222', 'season_settings_id', 'b2222222-2222-2222-2222-222222222bbb', 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(pg_temp.gi('b2222222-2222-2222-2222-0000000d0e01')))$$),
    'no error', 'control: Org B''s admin saves Org B''s own game by its id');
SELECT is(pg_temp.errx($$SELECT public.persist_game_schedule(
        jsonb_build_object('organization_id', 'b2222222-2222-2222-2222-222222222222', 'season_settings_id', 'b2222222-2222-2222-2222-222222222bbb', 'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(pg_temp.gi('b2222222-2222-2222-2222-0000000d0e01') || '{"id": "a1111111-1111-1111-1111-0000000d0e02"}'))$$),
    '23503:game_not_found', 'and the same payload naming Org A''s game by its id is refused: the other way round too');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT pg_temp.placed('a1111111-1111-1111-1111-0000000d0e02')$$), '0003>0004@00d2/1',
    'and Org A''s game that was named from the other organization is where it was');
-- An id twice; an id that is not a uuid.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', '{}', jsonb_build_array(pg_temp.mv('a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_identity_repeated', 'an id that appears twice in a save is refused');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e02']::uuid[], jsonb_build_array(pg_temp.mv('a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    'no error', 'control: the same game named once is saved');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "review-9-abc"}')))$$),
    '22023:game_identity_invalid', 'an id that is not a uuid (the page''s staged-game placeholder, say) is refused by name, not by a cast error');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": 42}')))$$),
    '22023:game_identity_invalid', 'nor is a number an id');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02',
        pg_temp.g('a1111111-1111-1111-1111-0000000d0e02') || '{"id": null}')))$$),
    'no error', 'control: a null or missing id is a row without one, upserted on its tuple');
-- A completed season is read-only (the existing trigger).
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', '{}', jsonb_build_array(pg_temp.gi('a1111111-1111-1111-1111-0000000d0e09'))))$$),
    '22023:season_completed', 'a game of a completed season named by its id is refused');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', '{}', jsonb_build_array(pg_temp.mv('a1111111-1111-1111-1111-0000000d0e09', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:season_completed', 'and so is a move of it');
SELECT is(pg_temp.val($$SELECT (to_jsonb(ga.*)::text = (SELECT ec1 FROM idbase))::text FROM public.game_assignments ga WHERE ga.id = 'a1111111-1111-1111-1111-0000000d0e09'$$), 'true',
    'and nothing of it was written');
-- A Published game is held: moved or flipped by id it is refused; carried by id it passes.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e01', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e01', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_published', 'a Published game moved by its id is refused (the guard, not an omission: the id is in the save)');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    'no error', 'control: its unpublished twin moved by id is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e01', pg_temp.flip('a1111111-1111-1111-1111-0000000d0e01'))))$$),
    '22023:game_published', 'a Published game flipped by its id is refused');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e03', pg_temp.flip('a1111111-1111-1111-1111-0000000d0e03'))))$$),
    'no error', 'control: an unpublished game flipped by its id is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e01', pg_temp.gi('a1111111-1111-1111-1111-0000000d0e01') || '{"source": "manual"}')))$$),
    'no error', 'a Published game carried by its id, with only who placed it changed, is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e01']::uuid[]))$$),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e01', 'a save that names a Published game neither by its id nor by its tuple still omits it');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e01']::uuid[], jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000d0e01'))))$$),
    'no error', 'control: named by its tuple alone it is present, as before');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e01']::uuid[], jsonb_build_array(pg_temp.mv('a1111111-1111-1111-1111-0000000d0e01', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_published', 'named by its id at another place, it is present (the id counts) and the guard then refuses the move: it is not reported as omitted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e01']::uuid[], jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000d0e01') || '{"game_slot_id": "a1111111-1111-1111-1111-0000000d00d9", "week_index": 3}')))$$),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e01', 'but named without its id at another place it is another tuple, and the Published original is omitted, as before');
-- A collision: an in-place update whose new tuple is another row's tuple.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e04', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d00d8'))))$$),
    '22023:game_identity_conflict ids=a1111111-1111-1111-1111-0000000d0e04,a1111111-1111-1111-1111-0000000d0e08',
    'a game moved onto the place of an older hidden row of the same pair is refused, both ids in the DETAIL');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e04', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d00da'))))$$),
    'no error', 'control: the same move to a free place is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e05', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-0000000d00d9'),
                                                                'a1111111-1111-1111-1111-0000000d0e07', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e07', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_identity_conflict ids=a1111111-1111-1111-1111-0000000d0e05,a1111111-1111-1111-1111-0000000d0e07',
    'two games of one pair sent to one place in one save are refused, both ids named');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e05', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-0000000d00d9'),
                                                                'a1111111-1111-1111-1111-0000000d0e07', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e07', 'a1111111-1111-1111-1111-0000000d00da'))))$$),
    'no error', 'control: to two different places they are accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e04', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d00d9')),
        '{}', jsonb_build_array(pg_temp.at('a1111111-1111-1111-1111-0000000d0002', 'a1111111-1111-1111-1111-0000000d0004', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_identity_conflict ids=a1111111-1111-1111-1111-0000000d0e04',
    'a game moved by id onto the place a new game of the same save is sent to is refused, naming the one id there is');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', '{}', jsonb_build_array(pg_temp.at('a1111111-1111-1111-1111-0000000d0002', 'a1111111-1111-1111-1111-0000000d0004', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    'no error', 'control: that new game alone is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e04', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d00d8')),
        '{}', '[]'), NULL)$$),
    '22023:game_identity_conflict ids=a1111111-1111-1111-1111-0000000d0e04,a1111111-1111-1111-1111-0000000d0e08',
    'a save that names no season is judged the same way');
-- Which clash is named when there are two: a stored game (two ids) before a new game of the same save (one id), as
-- `ORDER BY first_id, second_id NULLS LAST` takes them.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e04', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d00d8')),
        '{}', jsonb_build_array(pg_temp.at('a1111111-1111-1111-1111-0000000d0002', 'a1111111-1111-1111-1111-0000000d0004', 'a1111111-1111-1111-1111-0000000d00d8'))))$$),
    '22023:game_identity_conflict ids=a1111111-1111-1111-1111-0000000d0e04,a1111111-1111-1111-1111-0000000d0e08',
    'a game moved onto an older row AND onto the place of a new game of the same save: the stored row is named, a clash with no second game comes last');
-- Nothing above wrote a thing.
SELECT is(pg_temp.val($$SELECT (SELECT org_a_games FROM idbase) = (SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111')$$), 'true',
    'every refusal and every probe above left Org A''s games as they were');
SELECT is(pg_temp.val($$SELECT (SELECT org_a_runs FROM idbase) = (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND run_type = 'game')$$), 'true',
    'and left no run behind');

-- ── 3b. The season of a game named by its id ───────────────────────────────
-- The id check is organization-wide, so an id of a game stored in ANOTHER season of the organization would be rewritten
-- into this save's season. A save that names a season refuses a game whose stored season is another one (22023
-- `game_identity_season`, DETAIL `game_identity_season ids=<the first by id>`); a game with no stored season (saved before
-- the column) is accepted, and so is any game when the save names no season. The guard, the omission check and the
-- completed-season trigger still find a game's season through its home team's division (F11-3 moves them to this column).
UPDATE public.game_assignments SET season_settings_id = 'a1111111-1111-1111-1111-1111111100d1' WHERE id = 'a1111111-1111-1111-1111-0000000d0e07';
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7())$$),
    '22023:game_identity_season ids=a1111111-1111-1111-1111-0000000d0e07',
    'a game stored in another season, named by its id, is refused and named');
SELECT ok(pg_temp.msg($$SELECT pg_temp.save(pg_temp.set7())$$) ~ 'a1111111-1111-1111-1111-0000000d0e07'
          AND pg_temp.msg($$SELECT pg_temp.save(pg_temp.set7())$$) ~ 'another season',
    'and the message names the game and says why');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e07', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e07', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_identity_season ids=a1111111-1111-1111-1111-0000000d0e07',
    'moving it in the same save does not get it past the check (it would be rewritten into this season)');
-- The season is judged BEFORE the first row is written. (That a refused save leaves nothing behind is PostgreSQL's
-- atomicity, not this function's, and no assertion could fail on it; the order can: the first write of a payload that
-- also moves a Published game is refused by the guard, so a season check that ran after the writes would lose to
-- `game_published`. The control for this payload, with no game in another season, is the Published-move assertion of
-- section 3, which is refused `game_published`.)
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e01', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e01', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    '22023:game_identity_season ids=a1111111-1111-1111-1111-0000000d0e07',
    'the season is judged before anything is written: a payload that also moves a Published game is refused for the season, not for the Published game');
UPDATE public.game_assignments SET season_settings_id = 'a1111111-1111-1111-1111-1111111100d1' WHERE id = 'a1111111-1111-1111-1111-0000000d0e03';
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7())$$),
    '22023:game_identity_season ids=a1111111-1111-1111-1111-0000000d0e03',
    'two games of another season: the first by id is named');
UPDATE public.game_assignments SET season_settings_id = NULL WHERE id = 'a1111111-1111-1111-1111-0000000d0e03';
-- Control (passes without the check too): it shows the check refuses only when the save names a season.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(), NULL)$$), 'no error',
    'a save that names no season skips the check: the same payload is accepted');
-- Control (passes without the check too): it pins the order, the existence of an id before its season.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02', pg_temp.gi('a1111111-1111-1111-1111-0000000d0e02') || '{"id": "a1111111-1111-1111-1111-0000000d0eee"}')))$$),
    '23503:game_not_found',
    'the season is checked after the id exists: an unknown id is refused as not found, ahead of a game of another season');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e04', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e04', 'a1111111-1111-1111-1111-0000000d00d8'))))$$),
    '22023:game_identity_season ids=a1111111-1111-1111-1111-0000000d0e07',
    'and before the collisions: a game of another season is named ahead of a game moved onto an older row');
UPDATE public.game_assignments SET season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' WHERE id = 'a1111111-1111-1111-1111-0000000d0e07';
-- Control (passes without the check too): a game stored in the save's own season must never be refused.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7())$$), 'no error',
    'control: the same game stored in the save''s OWN season is accepted');
UPDATE public.game_assignments SET season_settings_id = NULL WHERE id = 'a1111111-1111-1111-1111-0000000d0e07';
-- Control (passes without the check too): a game with no stored season must never be refused.
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7())$$), 'no error',
    'control: and with no stored season (saved before the column) it is accepted');

-- ── 4. A save updates in place ─────────────────────────────────────────────
-- The page''s whole schedule, carried: the same games, the same ids, a new run, the season on every row.
SELECT is(pg_temp.err($$SELECT pg_temp.save(pg_temp.set7())$$), 'no error', 'the page''s whole schedule is saved by id');
SELECT is(pg_temp.visible(), '0e01,0e02,0e03,0e04,0e05,0e06,0e07', 'the new run holds the same seven games, under the same ids');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '9',
    'and nothing was added: a save that carries games by id inserts none');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$), '7',
    'the save put the run''s season on each game it wrote');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE season_settings_id IS NULL AND organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '2',
    'and left the two it did not write (the older hidden row and the completed season''s game) as they were, with no season');
SELECT is(pg_temp.val($$SELECT published::text FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000d0e01'$$), 'true',
    'the Published game is still Published');
-- A move keeps the id and leaves no hidden row.
SELECT is(pg_temp.err($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-0000000d00d9'))))$$),
    'no error', 'a game moved to another slot and week, by its id, is saved');
SELECT is(pg_temp.placed('a1111111-1111-1111-1111-0000000d0e02'), '0003>0004@00d9/3', 'it is at its new place, under its own id');
SELECT is(pg_temp.pair_rows('a1111111-1111-1111-1111-0000000d0003', 'a1111111-1111-1111-1111-0000000d0004'), 1,
    'and the pair has one row: the move left no row behind in an older run');
SELECT is(pg_temp.visible(), '0e01,0e02,0e03,0e04,0e05,0e06,0e07', 'the new run holds the moved game under its id');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '9', 'and no row was added');
-- A flip keeps the id.
SELECT is(pg_temp.err($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e03', pg_temp.flip('a1111111-1111-1111-1111-0000000d0e03'))))$$),
    'no error', 'a game whose sides are swapped, by its id, is saved');
SELECT is(pg_temp.placed('a1111111-1111-1111-1111-0000000d0e03'), '0003>0001@00d5/2', 'it keeps its id with the sides swapped');
SELECT is(pg_temp.pair_rows('a1111111-1111-1111-1111-0000000d0001', 'a1111111-1111-1111-1111-0000000d0003'), 1, 'and the pair still has one row');
-- Two games of one pair swap places in one save.
SELECT is(left(pg_temp.errx($$UPDATE public.game_assignments a SET game_slot_id = b.game_slot_id, slot_id = b.slot_id
        FROM public.game_assignments b WHERE a.id <> b.id AND a.id IN ('a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-0000000d0e07')
         AND b.id IN ('a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-0000000d0e07')$$), 5),
    '23505', 'control: one UPDATE that swaps those two games'' places fails on the unique index (it is not deferrable), which is why the save takes moving rows out first');
SELECT is(pg_temp.err($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object(
        'a1111111-1111-1111-1111-0000000d0e05', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e05', 'a1111111-1111-1111-1111-0000000d00d4'),
        'a1111111-1111-1111-1111-0000000d0e07', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e07', 'a1111111-1111-1111-1111-0000000d00d3'))))$$),
    'no error', 'but the save swaps them');
SELECT is(pg_temp.placed('a1111111-1111-1111-1111-0000000d0e05') || ' ' || pg_temp.placed('a1111111-1111-1111-1111-0000000d0e07'),
    '0005>0006@00d4/1 0005>0006@00d3/1', 'each keeps its id at the other''s place');
-- A row without an id is upserted on the tuple, as before: a move is a new row.
SELECT is(pg_temp.err($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e06',
        pg_temp.g('a1111111-1111-1111-1111-0000000d0e06') || (SELECT jsonb_build_object('game_slot_id', s.id, 'week_index', s.week_index, 'start', s.start, 'end', s."end") FROM public.game_slots s WHERE s.id = 'a1111111-1111-1111-1111-0000000d00da'))))$$),
    'no error', 'a row WITHOUT an id that is moved to another slot is saved');
SELECT is(pg_temp.pair_rows('a1111111-1111-1111-1111-0000000d0005', 'a1111111-1111-1111-1111-0000000d0006'), 4,
    'and it is a new row, with the old one left behind in its older run: the pair has four rows now (the two that swapped, the old meeting and the new)');
SELECT is(pg_temp.placed('a1111111-1111-1111-1111-0000000d0e06'), '0006>0005@00d7/2', 'the old row is where it was, with its id');
SELECT is(pg_temp.val($$SELECT count(*) || ' ' || bool_or(id = 'a1111111-1111-1111-1111-0000000d0e06')::text FROM public.game_assignments WHERE run_id = pg_temp.latest_run()$$),
    '7 false', 'the page shows the new row and not the old one: seven games, and the old row is not among them');
-- A season-less save leaves the stored season.
SELECT is(pg_temp.err($$SELECT pg_temp.save(pg_temp.set7(), NULL)$$), 'no error', 'a save that names no season is accepted (it carries every Published game of the organization)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$), '8',
    'and does not erase the season a game was saved with (the seven carried by id and the new row, from the earlier saves)');
SELECT is(pg_temp.val($$SELECT (metadata ->> 'game_count') FROM public.audit_log WHERE action = 'game.saved' AND resource_id = pg_temp.latest_run()$$), '7', 'the save still writes its game.saved audit row, counting the games it carried');

-- ── 5. One predicate ───────────────────────────────────────────────────────
-- Adding scores later (F11-2) changes ONE body. Shown by changing it here, inside the transaction: a game that is not
-- Published but is held by the new rule (e02, standing in for a scored game) is then held by every path that asks.
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET week_index = 9 WHERE id = 'a1111111-1111-1111-1111-0000000d0e02'$$), 'no error',
    'control: before the rule changes, e02 can be moved by a direct write');
SELECT is(pg_temp.errx($$SELECT public.admin_cancel_game_assignment('a1111111-1111-1111-1111-0000000d0e02')$$), 'no error', 'cancelled');
SELECT is(pg_temp.errx($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000d0003')$$), 'no error', 'and its team deleted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e02']::uuid[]))$$), 'no error', 'and left out of a save');
CREATE OR REPLACE FUNCTION public.game_held_ids(p_game_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = public AS $f$
    SELECT ga.id FROM public.game_assignments ga
     WHERE ga.id = ANY (p_game_ids) AND (ga.published OR ga.id = 'a1111111-1111-1111-1111-0000000d0e02')
$f$;
SELECT is(pg_temp.val($$SELECT public.game_is_held('a1111111-1111-1111-1111-0000000d0e02')$$), 'true',
    'the single form follows the set form: after the one body changes, e02 is held');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET week_index = 9 WHERE id = 'a1111111-1111-1111-1111-0000000d0e02'$$), '22023:game_scored',
    'the guard trigger refuses to move it (since 20261122010000 a held game that is not Published is refused in the words of a scored one)');
SELECT is(pg_temp.errx($$DELETE FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000d0e02'$$), '22023:game_scored',
    'and to delete it');
SELECT is(pg_temp.errx($$SELECT public.admin_cancel_game_assignment('a1111111-1111-1111-1111-0000000d0e02')$$), '22023:game_scored', 'cancel refuses it');
-- 20261122010000 (F11 decision D5): delete team no longer refuses up front for a game that is held without being
-- Published (it takes that game's score away first and the game goes with the team: game_scores.sql). A game still held
-- when the cascade reaches it, as this one is by the replaced body, meets the guard: the backstop.
SELECT is(pg_temp.errx($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000d0003')$$), '22023:game_scored', 'delete team is refused for its team (by the guard, at the cascade)');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7('{}', ARRAY['a1111111-1111-1111-1111-0000000d0e02']::uuid[]))$$),
    '22023:game_scored_omitted count=1 ids=a1111111-1111-1111-1111-0000000d0e02', 'a save that leaves it out is refused as an omission');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7(jsonb_build_object('a1111111-1111-1111-1111-0000000d0e02', pg_temp.mv('a1111111-1111-1111-1111-0000000d0e02', 'a1111111-1111-1111-1111-0000000d00da'))))$$),
    '22023:game_scored', 'and a save that moves it by its id is refused by the guard');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(pg_temp.set7())$$), 'no error', 'control: a save that carries it where it is is accepted');

-- ── 6. Order, from the source ──────────────────────────────────────────────
SELECT ok(COALESCE((SELECT position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || v_org_id::text, 0))' IN p.prosrc) > 0
                       AND position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || v_org_id::text, 0))' IN p.prosrc) < position('game_identity_invalid' IN p.prosrc)
                       AND position('game_identity_invalid' IN p.prosrc) < position('game_identity_repeated' IN p.prosrc)
                       AND position('game_identity_repeated' IN p.prosrc) < position('game_not_found' IN p.prosrc)
                       AND position('game_not_found' IN p.prosrc) < position('game_identity_conflict' IN p.prosrc)
                       AND position('game_identity_conflict' IN p.prosrc) < position('game_published_omitted' IN p.prosrc)
                      FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb,jsonb)'::regprocedure), false),
    'the save takes the organization''s lock first, then validates the ids (shape, repeats, existence), then the collisions, then the omissions, and only then writes');
SELECT ok(COALESCE((SELECT p.prosrc ~ 'ORDER BY ga\.id\s+FOR UPDATE' FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb,jsonb)'::regprocedure), false),
    'the games it updates in place are locked FOR UPDATE in id order');
SELECT ok(COALESCE((SELECT position('game_not_found' IN p.prosrc) < position('a game was removed while this save was being checked' IN p.prosrc)
                       AND position('a game was removed while this save was being checked' IN p.prosrc) < position('game_identity_season' IN p.prosrc)
                       AND position('game_identity_season' IN p.prosrc) < position('game_identity_conflict' IN p.prosrc)
                      FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb,jsonb)'::regprocedure), false),
    'the season of a named game is read after the rows are locked (so it cannot change under the check), after the ids exist and before the collisions');

SELECT * FROM finish();
ROLLBACK;
