-- pgTAP: the Published switch on games (migration 20261119010000; plan
-- docs/changes/2026-11-03-schedule-expansion.md, sections 3.2 to 3.4, PR 1 task A1).
--
-- Written first, and red against the code before the migration (every refusal below is paired with a
-- control that the UNPUBLISHED twin passes, so a trigger that refuses everything fails too):
--
--   * the shape: three columns on game_assignments, the partial index, the guard trigger, the two audit
--     actions, the two RPCs' grants and pins;
--   * 3.3, the guard trigger: a signed-in UPDATE of a Published row that changes any of the eight placement
--     columns, and a DELETE of one (also by a team or slot cascade), are refused 22023 `game_published`,
--     judged on the OLD row; the columns that are not a placement, an unchanged value, a job with no
--     signed-in user and the cascade of a deleted organization pass;
--   * 3.3, persist_game_schedule: a payload that moves a Published row is refused by the trigger; a payload
--     that OMITS one is refused `game_published_omitted` (the first 50 ids and the count), per season, or
--     per organization when the run names no season; a payload that carries it forward unchanged is saved;
--   * 3.3, admin_cancel_game_assignment and admin_delete_team refuse a Published game;
--   * 3.4, admin_set_games_published, gate by gate (signed in, admin, 1 to 2,400 ids all in the
--     organization, a completed season, the reason and the note, an unchanged value is a no-op) and the
--     audit rows (one per call, one per game turned off, their content, and the 2,400-id row's size);
--   * get_schedule_audit_log: admin only, org-scoped, no contact column.
--
-- The seed runs with no signed-in user (the trigger lets that through), as lesson 56 asks. The probes use
-- `errx`, which undoes what the statement did, so the same Published row and its twin are tried again.
-- A two-session race is not reproducible in one pgTAP transaction; the rows are locked in id order
-- (asserted from the source) and that is what this file can say about it.
--
-- Identity: persist_game_schedule keys its upsert on the matchup tuple (home, away, slot, week) and writes no id, so
-- "moves a Published game" below is the SAME-tuple case (another field, start or end), and a move to another slot is
-- another tuple: a new row, and the Published original is then an omission. Nothing here says a game's id, its
-- Published flag or its audit rows follow it through a move; one assertion pins that they do not (today's behaviour of
-- the save, outside this PR's scope).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(150);

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
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1119';
    EXCEPTION WHEN SQLSTATE 'P1119' THEN
        RETURN 'no error';
    END;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;
-- msg: the first error's message, or 'no error'.
CREATE FUNCTION pg_temp.msg(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
    EXECUTE p_sql;
    RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLERRM;
END
$f$;
-- val: the first column of the first row as text, or 'ERROR <sqlstate>' (a seed or a read that today's code cannot do).
CREATE FUNCTION pg_temp.val(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE p_sql INTO r;
    RETURN COALESCE(r, 'NULL');
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE;
END
$f$;
-- lock_probe: Org B's game lock as THIS backend holds it before and after a statement, read from pg_locks (the key is
-- restated here, not read from the functions), and undone. A lock held already would make "after" prove nothing, so
-- the probe is only used on an organization nothing else in the transaction has called the writers for.
CREATE FUNCTION pg_temp.lock_probe(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
    k constant bigint := hashtextextended('game_published:b2222222-2222-2222-2222-222222222222', 0);
    n_before integer;
    n_after integer;
BEGIN
    SELECT count(*) INTO n_before FROM pg_locks l
     WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.mode = 'ExclusiveLock'
       AND l.objsubid = 1 AND l.classid::bigint = (k >> 32) & 4294967295 AND l.objid::bigint = k & 4294967295;
    BEGIN
        EXECUTE p_sql;
        SELECT count(*) INTO n_after FROM pg_locks l
         WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.mode = 'ExclusiveLock'
           AND l.objsubid = 1 AND l.classid::bigint = (k >> 32) & 4294967295 AND l.objid::bigint = k & 4294967295;
        RAISE EXCEPTION 'before=% after=%', n_before, n_after USING ERRCODE = 'P1119';
    EXCEPTION WHEN SQLSTATE 'P1119' THEN
        RETURN SQLERRM;
    END;
END
$f$;
-- g: a saved game as a persist_game_schedule payload item.
CREATE FUNCTION pg_temp.g(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object('home_team_id', home_team_id, 'away_team_id', away_team_id, 'game_slot_id', game_slot_id,
                              'field_id', field_id, 'week_index', week_index, 'start', start, 'end', "end",
                              'source', assignment_source)
      FROM public.game_assignments WHERE id = p_id
$f$;
-- save: persist_game_schedule for Org A, season A (or, with a NULL season, for the organization alone).
CREATE FUNCTION pg_temp.save(p_items jsonb, p_season text DEFAULT 'a1111111-1111-1111-1111-111111111aaa') RETURNS text
LANGUAGE sql AS $f$
    SELECT public.persist_game_schedule(
        jsonb_strip_nulls(jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111',
                                             'season_settings_id', p_season, 'run_type', 'game', 'status', 'completed')),
        p_items)::text
$f$;
-- probe_move: save an unpublished game under another slot, read what the save made of it, undo it all.
CREATE FUNCTION pg_temp.probe_move() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    BEGIN
        PERFORM pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01'),
            pg_temp.g('a1111111-1111-1111-1111-0000000c0e02') || '{"game_slot_id": "a1111111-1111-1111-1111-0000000c00d3"}'));
        SELECT 'rows=' || count(*) || ' old_id_kept=' || bool_or(id = 'a1111111-1111-1111-1111-0000000c0e02')
               || ' new_id_differs=' || bool_or(id <> 'a1111111-1111-1111-1111-0000000c0e02')
          INTO r
          FROM public.game_assignments
         WHERE home_team_id = 'a1111111-1111-1111-1111-0000000c0004' AND away_team_id = 'a1111111-1111-1111-1111-0000000c0005'
           AND week_index = 1;
        RAISE EXCEPTION '%', r USING ERRCODE = 'P1119';
    EXCEPTION WHEN SQLSTATE 'P1119' THEN
        RETURN SQLERRM;
    END;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text), pg_temp.errx(text), pg_temp.msg(text), pg_temp.val(text),
    pg_temp.g(uuid), pg_temp.save(jsonb, text), pg_temp.probe_move(), pg_temp.lock_probe(text) TO PUBLIC;

-- ── Seed (no signed-in user) ───────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';

-- Sam: staff of Org A (is_org_admin includes staff, owner decision 2026-10-20).
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('88888888-8888-8888-8888-888888888888', 'sam@test.local',
        jsonb_build_object('full_name', 'Sam Staff-A', 'password_length', 12))
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, email, full_name)
VALUES ('88888888-8888-8888-8888-888888888888', 'sam@test.local', 'Sam Staff-A')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888', 'staff')
ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'staff';

-- Org A: season A (the fixture's, active) with teams T2 to T5 beside the fixture's A-Team (T1); a draft season B
-- (T6, T7) and a draft season C (T8, T9) that is completed below.
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111100b1', 'a1111111-1111-1111-1111-111111111111', 'Org A Season B', 'draft', 2027),
    ('a1111111-1111-1111-1111-1111111100c1', 'a1111111-1111-1111-1111-111111111111', 'Org A Season C', 'draft', 2025);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111d00b1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100b1', 'B U10'),
    ('a1111111-1111-1111-1111-1111111d00c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100c1', 'C U10');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000c0002', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Pub Two'),
    ('a1111111-1111-1111-1111-0000000c0003', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Pub Three'),
    ('a1111111-1111-1111-1111-0000000c0004', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Pub Four'),
    ('a1111111-1111-1111-1111-0000000c0005', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Pub Five'),
    ('a1111111-1111-1111-1111-0000000c0006', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00b1', 'Pub Six'),
    ('a1111111-1111-1111-1111-0000000c0007', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00b1', 'Pub Seven'),
    ('a1111111-1111-1111-1111-0000000c0008', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00c1', 'Pub Eight'),
    ('a1111111-1111-1111-1111-0000000c0009', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00c1', 'Pub Nine');
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000c00a0', 'a1111111-1111-1111-1111-111111111111', 'Pub Park'),
    ('b2222222-2222-2222-2222-0000000c00a0', 'b2222222-2222-2222-2222-222222222222', 'Pub Park B');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000c00f1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00a0', 'Pub Field 1'),
    ('a1111111-1111-1111-1111-0000000c00f2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00a0', 'Pub Field 2'),
    ('b2222222-2222-2222-2222-0000000c00f1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-0000000c00a0', 'Pub Field B');
INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
    ('a1111111-1111-1111-1111-0000000c00d1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000c00d2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00f1', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', '2026-04-04', '10:00', '11:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000c00d3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00f2', 'a1111111-1111-1111-1111-11111111abcd', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000c00d4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00f1', 'a1111111-1111-1111-1111-1111111d00b1', '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', '2026-05-02', '08:00', '09:00', 1, 1),
    ('a1111111-1111-1111-1111-0000000c00d5', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00f1', 'a1111111-1111-1111-1111-1111111d00c1', '2026-03-07T08:00:00Z', '2026-03-07T09:00:00Z', '2026-03-07', '08:00', '09:00', 1, 1),
    ('b2222222-2222-2222-2222-0000000c00d1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-0000000c00f1', 'b2222222-2222-2222-2222-22222222bcde', '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1);
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('b2222222-2222-2222-2222-0000000c0002', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-22222222bcde', 'Pub B Two');

-- The games. P and Q are to be Published (P in season A, Q in season B), U is P's unpublished twin in season A,
-- C1 and C2 sit in season C (completed below), R is Org B's Published game.
INSERT INTO public.game_assignments (id, organization_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source) VALUES
    ('a1111111-1111-1111-1111-0000000c0e01', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00d1', 'a1111111-1111-1111-1111-0000000c00d1', 'a1111111-1111-1111-1111-0000000c00f1',
     'a1111111-1111-1111-1111-0000000c0002', 'a1111111-1111-1111-1111-0000000c0003', 'Org A U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000c0e02', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00d2', 'a1111111-1111-1111-1111-0000000c00d2', 'a1111111-1111-1111-1111-0000000c00f1',
     'a1111111-1111-1111-1111-0000000c0004', 'a1111111-1111-1111-1111-0000000c0005', 'Org A U10', 1, '2026-04-04T10:00:00Z', '2026-04-04T11:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000c0e03', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00d4', 'a1111111-1111-1111-1111-0000000c00d4', 'a1111111-1111-1111-1111-0000000c00f1',
     'a1111111-1111-1111-1111-0000000c0006', 'a1111111-1111-1111-1111-0000000c0007', 'B U10', 1, '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000c0e04', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00d5', 'a1111111-1111-1111-1111-0000000c00d5', 'a1111111-1111-1111-1111-0000000c00f1',
     'a1111111-1111-1111-1111-0000000c0008', 'a1111111-1111-1111-1111-0000000c0009', 'C U10', 1, '2026-03-07T08:00:00Z', '2026-03-07T09:00:00Z', 'auto'),
    ('a1111111-1111-1111-1111-0000000c0e05', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00d5', 'a1111111-1111-1111-1111-0000000c00d5', 'a1111111-1111-1111-1111-0000000c00f1',
     'a1111111-1111-1111-1111-0000000c0009', 'a1111111-1111-1111-1111-0000000c0008', 'C U10', 2, '2026-03-14T08:00:00Z', '2026-03-14T09:00:00Z', 'auto'),
    ('b2222222-2222-2222-2222-0000000c0e01', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-0000000c00d1', 'b2222222-2222-2222-2222-0000000c00d1', 'b2222222-2222-2222-2222-0000000c00f1',
     'bbbbbbbb-0000-0000-0000-000000000002', 'b2222222-2222-2222-2222-0000000c0002', 'Org B U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto');
-- 2,400 more in season A for the size of the biggest audit row: one pair of teams, one slot, 2,400 weeks.
INSERT INTO public.game_assignments (organization_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source)
SELECT 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c00d3', 'a1111111-1111-1111-1111-0000000c00d3', 'a1111111-1111-1111-1111-0000000c00f2',
       'a1111111-1111-1111-1111-0000000c0004', 'a1111111-1111-1111-1111-0000000c0005', 'Big', w,
       timestamptz '2026-04-04T08:00:00Z' + make_interval(days => w), timestamptz '2026-04-04T09:00:00Z' + make_interval(days => w), 'auto'
  FROM generate_series(101, 2500) AS w;
CREATE TEMP TABLE big ON COMMIT DROP AS
    SELECT id FROM public.game_assignments WHERE division = 'Big' ORDER BY id;
GRANT SELECT ON big TO PUBLIC;
CREATE FUNCTION pg_temp.set_big(p_published boolean, p_reason text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    -- Dynamic, so this file still loads (and fails by assertion) before the migration exists.
    EXECUTE 'SELECT public.admin_set_games_published($1, $2, $3, $4, NULL, $5)::text' INTO r
        USING 'a1111111-1111-1111-1111-111111111111'::uuid, (SELECT array_agg(id) FROM pg_temp.big), p_published, p_reason, '{"kind": "all"}'::jsonb;
    RETURN r;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.set_big(boolean, text) TO PUBLIC;

-- Org E: an organization with a Published game, deleted below (the cascade of a deleted organization).
INSERT INTO public.organizations (id, name, slug) VALUES ('e5555555-5555-5555-5555-555555555555', 'Org E', 'org-e-published');
DELETE FROM public.season_settings WHERE organization_id = 'e5555555-5555-5555-5555-555555555555';
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('e5555555-5555-5555-5555-5555555555e1', 'e5555555-5555-5555-5555-555555555555', 'Org E Season', 'draft', 2026);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('e5555555-5555-5555-5555-55555555d0e1', 'e5555555-5555-5555-5555-555555555555', 'e5555555-5555-5555-5555-5555555555e1', 'E U10');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('e5555555-5555-5555-5555-5555555d0001', 'e5555555-5555-5555-5555-555555555555', 'e5555555-5555-5555-5555-55555555d0e1', 'E One'),
    ('e5555555-5555-5555-5555-5555555d0002', 'e5555555-5555-5555-5555-555555555555', 'e5555555-5555-5555-5555-55555555d0e1', 'E Two');
INSERT INTO public.game_assignments (id, organization_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source) VALUES
    ('e5555555-5555-5555-5555-5555555e0e01', 'e5555555-5555-5555-5555-555555555555', 'e5555555-5555-5555-5555-5555555d0001', 'e5555555-5555-5555-5555-5555555d0002',
     'E U10', 1, '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', 'auto');

-- Nothing is Published until someone publishes: the migration changes no existing row.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE published$$), '0',
    'no game is Published by the migration: every existing row defaults to unpublished');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE published_at IS NOT NULL OR published_by IS NOT NULL$$), '0',
    'and none carries a published time or actor');

-- The Published rows P, Q, R and the Org E game, set with no signed-in user (the seed, not the switch under test).
-- A DO block and not a SELECT: a SELECT would print its result row ("ok") into the TAP stream, where pg_prove reads
-- it as an extra test (146 run of 145 planned, test 145 failed, in CI on the first push). The error is swallowed so
-- the file still loads before the migration, where the column is missing and the assertions fail one by one.
DO $seed$
BEGIN
    UPDATE public.game_assignments SET published = true
     WHERE id IN ('a1111111-1111-1111-1111-0000000c0e01', 'a1111111-1111-1111-1111-0000000c0e03', 'a1111111-1111-1111-1111-0000000c0e04',
                  'b2222222-2222-2222-2222-0000000c0e01', 'e5555555-5555-5555-5555-5555555e0e01');
EXCEPTION WHEN undefined_column THEN
    NULL;   -- before the migration there is no such column; the assertions below say so
END
$seed$;
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE published$$), '5',
    'control: the seed Published five games (P, Q, C1, R and the Org E game)');

-- ── 1. Shape ───────────────────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '-'), '; ' ORDER BY column_name)
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'game_assignments'
     AND column_name IN ('published', 'published_at', 'published_by')$$),
    'published boolean NO false; published_at timestamp with time zone YES -; published_by uuid YES -',
    'game_assignments gains published (NOT NULL, default false), published_at and published_by (nullable)');
SELECT ok(COALESCE((SELECT c.confdeltype = 'n' AND c.confrelid = 'auth.users'::regclass FROM pg_constraint c
                     WHERE c.conrelid = 'public.game_assignments'::regclass AND c.contype = 'f'
                       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'published_by')]), false),
    'published_by is an actor id that references auth.users and is set null when the user goes');
SELECT ok(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                   AND indexdef ~ '\(organization_id\) WHERE published'),
    'a partial index on (organization_id) WHERE published');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.game_assignments'::regclass AND g.tgname = 'game_assignments_published_guard'
                   AND NOT g.tgisinternal AND g.tgenabled = 'O'
                   AND pg_get_triggerdef(g.oid) ~ 'BEFORE (DELETE OR UPDATE|UPDATE OR DELETE) ON public.game_assignments FOR EACH ROW'),
    'the guard is an enabled BEFORE UPDATE OR DELETE row trigger on game_assignments');
SELECT ok(COALESCE(has_function_privilege('authenticated', to_regprocedure('public.game_assignments_published_guard()'), 'EXECUTE')
                   OR has_function_privilege('anon', to_regprocedure('public.game_assignments_published_guard()'), 'EXECUTE'), true) IS FALSE,
    'and the trigger function is nobody''s to call');
SELECT is((SELECT count(*)::int FROM public.audit_actions WHERE action IN ('game.published_set', 'game.publish_overridden')), 2,
    'both audit actions are registered (the audit_log foreign key fails at runtime otherwise)');
SELECT ok(COALESCE(has_function_privilege('authenticated', to_regprocedure('public.admin_set_games_published(uuid,uuid[],boolean,text,text,jsonb)'), 'EXECUTE')
                   AND NOT has_function_privilege('anon', to_regprocedure('public.admin_set_games_published(uuid,uuid[],boolean,text,text,jsonb)'), 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE p.oid = to_regprocedure('public.admin_set_games_published(uuid,uuid[],boolean,text,text,jsonb)') AND a.grantee = 0), false),
    'admin_set_games_published: authenticated executes it; anon and PUBLIC do not');
SELECT ok(COALESCE(has_function_privilege('authenticated', to_regprocedure('public.get_schedule_audit_log(uuid,uuid,integer)'), 'EXECUTE')
                   AND NOT has_function_privilege('anon', to_regprocedure('public.get_schedule_audit_log(uuid,uuid,integer)'), 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                    WHERE p.oid = to_regprocedure('public.get_schedule_audit_log(uuid,uuid,integer)') AND a.grantee = 0), false),
    'get_schedule_audit_log: authenticated executes it; anon and PUBLIC do not');
SELECT ok((SELECT count(*) FROM pg_proc p
            WHERE p.oid IN (to_regprocedure('public.admin_set_games_published(uuid,uuid[],boolean,text,text,jsonb)'),
                            to_regprocedure('public.get_schedule_audit_log(uuid,uuid,integer)'),
                            to_regprocedure('public.game_assignments_published_guard()'))
              AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']) = 3,
    'the two RPCs and the trigger function are definer functions pinned to search_path=public and timezone=UTC');
SELECT ok(COALESCE((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC'] FROM pg_proc p
                     WHERE p.oid = 'public.persist_game_schedule(jsonb,jsonb)'::regprocedure), false)
          AND COALESCE((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p
                         WHERE p.oid = 'public.admin_cancel_game_assignment(uuid)'::regprocedure), false)
          AND COALESCE((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p
                         WHERE p.oid = 'public.admin_delete_team(uuid)'::regprocedure), false)
          AND has_function_privilege('authenticated', 'public.persist_game_schedule(jsonb,jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.persist_game_schedule(jsonb,jsonb)', 'EXECUTE'),
    'the three replaced functions are still definer functions with the posture they had, and persist_game_schedule keeps its grants');

-- ── 2. 3.3, the guard trigger: a signed-in UPDATE or DELETE of a Published row ─
-- P (Published) and its twin U (not) are tried with the same statements. Alice is signed in; the statements run
-- as the table owner, as the completed-season file's direct writes do.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET game_slot_id = NULL WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'a Published game cannot lose its slot (game_slot_id)');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET game_slot_id = NULL WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control: its unpublished twin can');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET slot_id = NULL WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor its slot_id');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET slot_id = NULL WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET field_id = 'a1111111-1111-1111-1111-0000000c00f2' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor change its field');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET field_id = 'a1111111-1111-1111-1111-0000000c00f2' WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET home_team_id = 'a1111111-1111-1111-1111-0000000c0006' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor swap its home team');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET home_team_id = 'a1111111-1111-1111-1111-0000000c0006' WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET away_team_id = 'a1111111-1111-1111-1111-0000000c0006' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor its away team');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET away_team_id = 'a1111111-1111-1111-1111-0000000c0006' WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET week_index = 9 WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor its week');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET week_index = 9 WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET start = '2026-04-04T08:30:00Z' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor its start');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET start = '2026-04-04T08:30:00Z' WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET "end" = '2026-04-04T09:30:00Z' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'nor its end');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET "end" = '2026-04-04T09:30:00Z' WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET published = false, field_id = 'a1111111-1111-1111-1111-0000000c00f2' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'clearing the flag and moving in one statement is refused: the OLD row is judged');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET published = false WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'control: the flag alone can be cleared (the switch itself writes it)');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET assignment_source = 'manual' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'who placed a Published game (assignment_source) is not a placement');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET division = 'Org A U10 (renamed)' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'nor is its division label, which follows a division rename');
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET game_slot_id = game_slot_id, slot_id = slot_id, field_id = field_id, home_team_id = home_team_id,
        away_team_id = away_team_id, week_index = week_index, start = start, "end" = "end" WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'an unchanged value is not a change: carrying a Published row forward as it is passes');
SELECT is(pg_temp.errx($$DELETE FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    '22023:game_published', 'a Published game cannot be deleted');
SELECT is(pg_temp.errx($$DELETE FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$),
    'no error', 'control: its unpublished twin can');
SELECT is(pg_temp.errx($$DELETE FROM public.teams WHERE id = 'a1111111-1111-1111-1111-0000000c0002'$$),
    '22023:game_published', 'a team delete that would cascade onto a Published game is refused');
SELECT is(pg_temp.errx($$DELETE FROM public.teams WHERE id = 'a1111111-1111-1111-1111-0000000c0004'$$),
    'no error', 'control: a team whose games are all unpublished can go');
SELECT is(pg_temp.errx($$DELETE FROM public.game_slots WHERE id = 'a1111111-1111-1111-1111-0000000c00d1'$$),
    '22023:game_published', 'a slot delete that would cascade onto a Published game is refused');
SELECT is(pg_temp.errx($$DELETE FROM public.game_slots WHERE id = 'a1111111-1111-1111-1111-0000000c00d2'$$),
    'no error', 'control: a slot whose games are unpublished can go');

-- Who is exempt: a job with no signed-in user, and the cascade of a deleted organization.
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx($$UPDATE public.game_assignments SET field_id = 'a1111111-1111-1111-1111-0000000c00f2' WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'with no signed-in user (a job) a Published row can still be moved');
SELECT is(pg_temp.errx($$DELETE FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'and deleted');
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';
SELECT is(pg_temp.errx($$DELETE FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'$$),
    'no error', 'a service-role call carries no user either, and passes');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$DELETE FROM public.organizations WHERE id = 'e5555555-5555-5555-5555-555555555555'$$),
    'no error', 'a signed-in caller can still delete an organization that holds a Published game');
SELECT is((SELECT count(*)::int FROM public.game_assignments WHERE organization_id = 'e5555555-5555-5555-5555-555555555555'), 0,
    'and the Published game went with it');

-- ── 3. 3.3, persist_game_schedule: moved, omitted, carried forward ─────────
-- The whole season A save is [P, U]; Q (season B) and R (Org B) are Published too.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE runs_before ON COMMIT DROP AS SELECT count(*)::int AS n FROM public.scheduler_runs;
SELECT is(pg_temp.err($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01'), pg_temp.g('a1111111-1111-1111-1111-0000000c0e02')))$$),
    'no error', 'a save that carries the Published game forward unchanged is accepted (Q, in another season, and Org B''s R are not in it)');
SELECT is((SELECT (run_id IS NOT NULL)::text FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e01'), 'true',
    'and it reached the Published row (its run id moved to the new run)');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01') || '{"start": "2026-04-04T08:30:00Z"}', pg_temp.g('a1111111-1111-1111-1111-0000000c0e02')))$$),
    '22023:game_published', 'a save that moves a Published game (same matchup, slot and week, another start) is refused by the trigger');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01'), pg_temp.g('a1111111-1111-1111-1111-0000000c0e02') || '{"start": "2026-04-04T10:30:00Z"}'))$$),
    'no error', 'control: the same move of its unpublished twin is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01') || '{"field_id": "a1111111-1111-1111-1111-0000000c00f2"}', pg_temp.g('a1111111-1111-1111-1111-0000000c0e02')))$$),
    '22023:game_published', 'so is a move to another field');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e02')))$$),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000c0e01',
    'a save that omits a Published game is refused, naming it and counting it');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01')))$$),
    'no error', 'control: a save that omits the unpublished twin is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01') || '{"game_slot_id": "a1111111-1111-1111-1111-0000000c00d3"}', pg_temp.g('a1111111-1111-1111-1111-0000000c0e02')))$$),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000c0e01',
    'a move to another slot is another matchup key, so the Published original is omitted and the save is refused');
SELECT is(pg_temp.errx($$SELECT pg_temp.save('[]'::jsonb)$$),
    '22023:game_published_omitted count=1 ids=a1111111-1111-1111-1111-0000000c0e01',
    'an empty save is refused while a Published game of the season exists');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01'), pg_temp.g('a1111111-1111-1111-1111-0000000c0e02')), NULL)$$),
    '22023:game_published_omitted count=2 ids=a1111111-1111-1111-1111-0000000c0e03,a1111111-1111-1111-1111-0000000c0e04',
    'a run that names no season is judged against every season of the organization (Q, in season B, and C1, in season C, are missing)');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e01'), pg_temp.g('a1111111-1111-1111-1111-0000000c0e02'),
        pg_temp.g('a1111111-1111-1111-1111-0000000c0e03'), pg_temp.g('a1111111-1111-1111-1111-0000000c0e04')), NULL)$$),
    'no error', 'control: carrying all of them is accepted');
SELECT is(pg_temp.errx($$SELECT pg_temp.save(jsonb_build_array(pg_temp.g('a1111111-1111-1111-1111-0000000c0e03')), 'a1111111-1111-1111-1111-1111111100b1')$$),
    'no error', 'a save for season B carries Q and does not need season A''s P');
SELECT is(pg_temp.probe_move(), 'rows=2 old_id_kept=true new_id_differs=true',
    'identity is the matchup tuple: moving an unpublished game to another slot adds a row with a new id and leaves the old one behind (what a game''s id keys does not follow a move)');
SELECT is((SELECT count(*)::int FROM public.scheduler_runs) - (SELECT n FROM runs_before), 1,
    'the refusals wrote nothing: of all the saves above only the first, accepted one left a scheduler run');

-- ── 4. 3.3, cancel and delete team ─────────────────────────────────────────
SELECT is(pg_temp.errx($$SELECT public.admin_cancel_game_assignment('a1111111-1111-1111-1111-0000000c0e01')$$),
    '22023:game_published', 'cancelling a Published game is refused');
SELECT is(pg_temp.msg($$SELECT public.admin_cancel_game_assignment('a1111111-1111-1111-1111-0000000c0e01')$$) ~ 'allow changes', true,
    'and the message tells the admin to allow changes first');
SELECT is(pg_temp.errx($$SELECT public.admin_cancel_game_assignment('a1111111-1111-1111-1111-0000000c0e02')$$),
    'no error', 'control: its unpublished twin is cancelled');
SELECT is(pg_temp.errx($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000c0002')$$),
    '22023:game_published', 'deleting a team with a Published game is refused, before anything is deleted');
SELECT is(pg_temp.errx($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000c0003')$$),
    '22023:game_published', 'whichever side the team plays');
SELECT is(pg_temp.msg($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000c0002')$$) ~ '1 Published', true,
    'and the message counts the Published games');
SELECT is(pg_temp.errx($$SELECT public.admin_delete_team('a1111111-1111-1111-1111-0000000c0004')$$),
    'no error', 'control: a team whose games are unpublished is deleted');

-- ── 4b. The save and the switch take one lock per organization ─────────────
-- Codex's P2 on #707: the save's omission check reads `published`, the switch locks only the rows it changes, and the
-- save never touches a row it leaves out, so a publish and a save that omits that game could both commit. A race
-- needs two sessions and one pgTAP transaction has one; this holds what it can. The lock is read from pg_locks for an
-- organization (B) nothing above has called either writer for, with a control that a call which takes no lock leaves
-- it unheld; the two sources take it before they read or lock a game; that two sessions then wait on each other is the
-- documented behaviour of an exclusive advisory lock on one key (statically reviewed). The race itself was reproduced
-- and shown closed with two psql sessions on a scratch cluster (PR body), not in this file.
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.lock_probe($$SELECT count(*) FROM public.get_schedule_audit_log('b2222222-2222-2222-2222-222222222222')$$),
    'before=0 after=0', 'control: a call that takes no organization lock leaves it unheld (the probe can say 0)');
SELECT is(pg_temp.lock_probe($$SELECT public.persist_game_schedule(
        jsonb_build_object('organization_id', 'b2222222-2222-2222-2222-222222222222', 'season_settings_id', 'b2222222-2222-2222-2222-222222222bbb',
                           'run_type', 'game', 'status', 'completed'),
        jsonb_build_array(pg_temp.g('b2222222-2222-2222-2222-0000000c0e01')))$$),
    'before=0 after=1', 'the save takes the organization''s game lock, and holds it to the end of the transaction');
SELECT is(pg_temp.lock_probe($$SELECT public.admin_set_games_published('b2222222-2222-2222-2222-222222222222', ARRAY['b2222222-2222-2222-2222-0000000c0e01']::uuid[], true)$$),
    'before=0 after=1', 'the switch takes the organization''s game lock, and holds it to the end of the transaction');
SELECT ok(COALESCE((SELECT position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || v_org_id::text, 0))' IN p.prosrc) > 0
                       AND position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || v_org_id::text, 0))' IN p.prosrc) < position('INSERT INTO public.scheduler_runs' IN p.prosrc)
                       AND position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || v_org_id::text, 0))' IN p.prosrc) < position('WITH payload AS' IN p.prosrc)
                      FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb,jsonb)'::regprocedure), false),
    'the save takes the lock after its admin check and before it writes a run or reads the Published games');
SELECT ok(COALESCE((SELECT position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || p_organization_id::text, 0))' IN p.prosrc) > position('admin_required' IN p.prosrc)
                       AND position('admin_required' IN p.prosrc) > 0
                       AND position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || p_organization_id::text, 0))' IN p.prosrc) < position('FROM public.game_assignments ga WHERE ga.id = ANY' IN p.prosrc)
                       AND position('pg_advisory_xact_lock(hashtextextended(''game_published:'' || p_organization_id::text, 0))' IN p.prosrc) < position('FOR UPDATE' IN p.prosrc)
                      FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_games_published(uuid,uuid[],boolean,text,text,jsonb)')), false),
    'the switch takes it after its admin gate and before it reads or locks a game');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 5. 3.4, the gates of admin_set_games_published ─────────────────────────
-- Gate 1: a signed-in caller.
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    '42501:signed_in_required', 'gate 1: no signed-in user is refused');
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    '42501:signed_in_required', 'and neither is a service-role call, which has no user to audit');
-- Gate 2: an organization admin (admin, tenant admin or staff).
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    '42501:admin_required', 'gate 2: a signed-in user who is a member of nothing is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    '42501:admin_required', 'and so is the admin of another organization');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['00000000-0000-0000-0000-00000000dead']::uuid[], true)$$),
    '42501:admin_required', 'the admin check comes before the ids are looked at: a stranger learns nothing of them');
SET LOCAL "request.jwt.claims" TO '{"sub":"88888888-8888-8888-8888-888888888888"}';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    'no error', 'control: a staff member is an admin here, as everywhere');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
-- Gate 3: 1 to 2,400 ids, all existing, all in the organization.
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY[]::uuid[], true)$$),
    '22023:ids_required', 'gate 3: an empty list of ids is refused');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', NULL, true)$$),
    '22023:ids_required', 'and a missing one');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 2401)), true)$$),
    '22023:too_many_ids', 'more than 2,400 ids are refused');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['00000000-0000-0000-0000-00000000dead']::uuid[], true)$$),
    '23503:game_not_found', 'an id that does not exist is refused');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['b2222222-2222-2222-2222-0000000c0e01']::uuid[], true)$$),
    '42501:game_other_organization', 'an id of another organization is refused');
SELECT is(pg_temp.err($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02', 'b2222222-2222-2222-2222-0000000c0e01']::uuid[], true)$$),
    '42501:game_other_organization', 'one foreign id refuses the whole call');
SELECT is(pg_temp.val($$SELECT published::text FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$), 'false',
    'and the valid id beside it was not published: nothing is partly done');
-- Gate 4: a completed season refuses through the existing trigger; the read-only rule wins over the flag.
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-1111111100c1';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e05']::uuid[], true)$$),
    '22023:season_completed', 'gate 4: a completed season''s game cannot be published');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e04']::uuid[], false, 'other')$$),
    '22023:season_completed', 'nor can its Published game be allowed to change');
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e05']::uuid[], false, 'other')->>'unchanged'$$),
    '1', 'a game already at the value asked for is a no-op even there: nothing is written');
-- Gate 5: turning off needs a reason from the closed list; the note is optional and at most 200 characters.
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false)$$),
    '22023:reason_required', 'gate 5: turning off without a reason is refused');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, '   ')$$),
    '22023:reason_required', 'a blank reason is no reason');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'because')$$),
    '22023:reason_unknown', 'a reason outside the list is refused');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'field-change')$$),
    'no error', 'field-change is accepted');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'coach-request')$$),
    'no error', 'coach-request is accepted');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'conflict-fix')$$),
    'no error', 'conflict-fix is accepted');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'published-in-error')$$),
    'no error', 'published-in-error is accepted');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'other')$$),
    'no error', 'other is accepted');
SELECT is(pg_temp.errx(format($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'other', %L)$$, repeat('n', 201))),
    '22023:note_too_long', 'a note of 201 characters is refused');
SELECT is(pg_temp.errx(format($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], false, 'other', %L)$$, repeat('n', 200))),
    'no error', 'and one of exactly 200 is accepted');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true, 'other')$$),
    '22023:reason_only_when_off', 'turning on takes no reason (a reason is for allowing changes)');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true, '', '  ')$$),
    'no error', 'blank strings for the reason and the note are no reason and no note: turning on needs none');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], NULL)$$),
    '22023:published_required', 'the switch must say which way');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true, NULL, NULL, '{"kind": "nowhere"}')$$),
    '22023:scope_invalid', 'a scope outside {all, division, date, venue, selection} is refused');
-- The lock order, from the source (a two-session race does not fit one transaction).
SELECT ok(COALESCE((SELECT p.prosrc ~ 'ORDER BY ga\.id\s+FOR UPDATE' FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.admin_set_games_published(uuid,uuid[],boolean,text,text,jsonb)')), false),
    'the rows are locked FOR UPDATE in id order (lesson 64: lock order)');

-- A failed audit write rolls the change back (SLA01), as the save does. The action row is removed for the
-- statement: no audit_log row references it yet, so the delete is allowed, and it is put back.
DELETE FROM public.audit_actions WHERE action = 'game.published_set';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    'SLA01:23503', 'an audit row that cannot be written refuses the whole call, SLA01, with the original SQLSTATE');
INSERT INTO public.audit_actions (action) VALUES ('game.published_set') ON CONFLICT (action) DO NOTHING;

-- Gate 6 and the audit rows. Everything above was undone or refused: nothing is audited yet.
CREATE TEMP TABLE audit_before ON COMMIT DROP AS
    SELECT count(*) FILTER (WHERE action = 'game.published_set')::int AS sets,
           count(*) FILTER (WHERE action = 'game.publish_overridden')::int AS overrides
      FROM public.audit_log WHERE action IN ('game.published_set', 'game.publish_overridden');
SELECT is((SELECT sets + overrides FROM audit_before), 0, 'nothing above wrote an audit row: a refusal, an undo and a no-op audit nothing');
-- Turning on: U is published by Alice for one division.
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true, NULL, NULL,
        '{"kind": "division", "value": "Org A U10"}')::text$$),
    '{"ids": ["a1111111-1111-1111-1111-0000000c0e02"], "changed": 1, "unchanged": 0}',
    'turning on returns the count changed, the count unchanged and the ids changed');
SELECT is(pg_temp.val($$SELECT published::text || ' ' || (published_at IS NOT NULL)::text || ' ' || (published_by = '11111111-1111-1111-1111-111111111111')::text
             FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$), 'true true true',
    'the game is Published, with the time and the actor recorded');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'game.published_set'), 1,
    'one game.published_set row for the call');
SELECT is((SELECT metadata - 'ids' FROM public.audit_log WHERE action = 'game.published_set')::text,
    '{"count": 1, "scope": {"kind": "division", "value": "Org A U10"}, "published": true, "unchanged": 0}',
    'carrying the way, the scope, the count changed and the count unchanged');
SELECT is((SELECT metadata -> 'ids' FROM public.audit_log WHERE action = 'game.published_set')::text,
    '["a1111111-1111-1111-1111-0000000c0e02"]', 'and the ids changed');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'game.publish_overridden'), 0, 'turning on is no override: no per-game row');
-- Gate 6: the same call again is a no-op and writes nothing.
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)::text$$),
    '{"ids": [], "changed": 0, "unchanged": 1}', 'gate 6: a game already Published is unchanged');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action IN ('game.published_set', 'game.publish_overridden')), 1,
    'and it is not audited again');
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02', 'a1111111-1111-1111-1111-0000000c0e05']::uuid[], true)$$),
    '22023:season_completed', 'one completed-season game that would change refuses its whole call');
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02', 'a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)::text$$),
    '{"ids": [], "changed": 0, "unchanged": 1}', 'a repeated id counts once');
-- Turning off: P and U are allowed to change, with a reason and a note, for a selection.
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02', 'a1111111-1111-1111-1111-0000000c0e01']::uuid[],
        false, 'field-change', 'Field closed for repairs', '{"kind": "selection"}')::text$$),
    '{"ids": ["a1111111-1111-1111-1111-0000000c0e01", "a1111111-1111-1111-1111-0000000c0e02"], "changed": 2, "unchanged": 0}',
    'turning off reports the games changed, in id order');
SELECT is(pg_temp.val($$SELECT published::text || ' ' || (published_at IS NOT NULL)::text || ' ' || (published_by IS NOT NULL)::text
             FROM public.game_assignments WHERE id = 'a1111111-1111-1111-1111-0000000c0e02'$$), 'false true true',
    'the game is no longer Published and its published time and actor are kept: "changes allowed" is off after having been on');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'game.publish_overridden'), 2,
    'one game.publish_overridden row per game turned off');
SELECT is((SELECT metadata - 'before' FROM public.audit_log WHERE action = 'game.publish_overridden' AND resource_id = 'a1111111-1111-1111-1111-0000000c0e02')::text,
    '{"note": "Field closed for repairs", "scope": {"kind": "selection"}, "reason_code": "field-change"}',
    'each carries the reason, the note and the scope');
SELECT is((SELECT metadata -> 'before' FROM public.audit_log WHERE action = 'game.publish_overridden' AND resource_id = 'a1111111-1111-1111-1111-0000000c0e02')::text,
    '{"end": "2026-04-04T11:00:00+00:00", "start": "2026-04-04T10:00:00+00:00", "field_id": "a1111111-1111-1111-1111-0000000c00f1", "week_index": 1, "away_team_id": "a1111111-1111-1111-1111-0000000c0005", "game_slot_id": "a1111111-1111-1111-1111-0000000c00d2", "home_team_id": "a1111111-1111-1111-1111-0000000c0004"}',
    'and the game as it stood: slot, field, teams, week, start and end');
SELECT is((SELECT metadata - 'ids' FROM public.audit_log WHERE action = 'game.published_set' AND NOT (metadata->>'published')::boolean AND (metadata->>'count')::int = 2)::text,
    '{"count": 2, "scope": {"kind": "selection"}, "published": false, "unchanged": 0, "reason_code": "field-change"}',
    'the call''s own row says which way, the reason, the scope and the counts');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'game.published_set'), 2, 'one call row for each of the two calls');
-- Turning back on is the reversal: Published again, the time moves, no new override row.
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01']::uuid[], true)->>'changed'$$),
    '1', 'turning back on is audited as an ordinary publish');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'game.publish_overridden'), 2, 'and writes no override row');
-- Gate 6, mixed: one changes, one does not.
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e01', 'a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)::text$$),
    '{"ids": ["a1111111-1111-1111-1111-0000000c0e02"], "changed": 1, "unchanged": 1}', 'a call that changes one game and finds another already at the value reports both');
-- Turning off a game that is already off is a no-op too, with its reason checked first.
SELECT is(pg_temp.val($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e05']::uuid[], false, 'other')->>'changed'$$),
    '0', 'turning off a game that is already off changes nothing');

-- ── 6. The 2,400-id call, the audit row''s size ────────────────────────────
SELECT is(pg_temp.val($$SELECT (pg_temp.set_big(true)::jsonb)->>'changed'$$), '2400',
    '2,400 ids (the cap) are accepted in one call and all change');
SELECT cmp_ok((SELECT length(metadata::text) FROM public.audit_log WHERE action = 'game.published_set' AND (metadata->>'count')::int = 2400 AND (metadata->>'published')::boolean),
    '<', 100000, 'the call''s audit row for 2,400 ids is under 100 KB as text (plan stop condition)');
SELECT cmp_ok((SELECT pg_column_size(metadata) FROM public.audit_log WHERE action = 'game.published_set' AND (metadata->>'count')::int = 2400 AND (metadata->>'published')::boolean),
    '<', 100000, 'and as stored');
SELECT is(pg_temp.val($$SELECT (pg_temp.set_big(true)::jsonb)->>'unchanged'$$), '2400', 'the same 2,400 again are unchanged');
-- With the Published games now many, an empty save names the first 50 and counts all.
SELECT is(pg_temp.errx($$SELECT pg_temp.save('[]'::jsonb)$$),
    '22023:game_published_omitted count=2402 ids=' || COALESCE(pg_temp.val($$SELECT string_agg(id::text, ',' ORDER BY id) FROM (
        SELECT id FROM public.game_assignments WHERE published AND (division = 'Big' OR id IN ('a1111111-1111-1111-1111-0000000c0e01', 'a1111111-1111-1111-1111-0000000c0e02'))
         ORDER BY id LIMIT 50) f$$), ''),
    'an empty save counts every Published game of the season and lists the first 50 ids, in id order');
SELECT is(pg_temp.val($$SELECT (pg_temp.set_big(false, 'conflict-fix')::jsonb)->>'changed'$$), '2400', 'all 2,400 can be allowed to change in one call');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'game.publish_overridden'), 2402,
    'and each of them has its own override row (the two earlier ones, and 2,400)');
SELECT cmp_ok((SELECT length(metadata::text) FROM public.audit_log WHERE action = 'game.published_set' AND NOT (metadata->>'published')::boolean AND (metadata->>'count')::int = 2400),
    '<', 100000, 'the turn-off call''s row is under 100 KB as well');

-- ── 7. get_schedule_audit_log ──────────────────────────────────────────────
SELECT is(pg_temp.errx($$SELECT * FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111')$$), 'no error',
    'an admin reads the schedule audit log');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111', NULL, 500)$$),
    LEAST(500, (SELECT count(*)::int FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action IN ('game.published_set', 'game.publish_overridden')))::text,
    'it returns the two schedule actions of the organization, up to the limit (at most 500)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111', NULL, 100000)$$), '500',
    'and the limit is capped at 500 rows');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000c0e02', 500)$$),
    (SELECT count(*)::text FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND ((action = 'game.publish_overridden' AND resource_id = 'a1111111-1111-1111-1111-0000000c0e02')
             OR (action = 'game.published_set' AND metadata -> 'ids' @> to_jsonb('a1111111-1111-1111-1111-0000000c0e02'::text)))),
    'for one game: its override rows and the calls whose ids include it');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111', NULL, 1)$$), '1', 'the limit caps the rows');
SELECT ok(COALESCE((SELECT p.prosrc ~ 'ORDER BY a\.created_at DESC' FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_schedule_audit_log(uuid,uuid,integer)')), false),
    'newest first (every row of this transaction shares one now(), so the order is read from the source)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111', NULL, 500) WHERE action = 'game.published_set' AND metadata ? 'ids'$$), '0',
    'a call row comes back without its ids (up to 2,400 of them): the per-game rows and the audit table hold them');
SELECT is(pg_temp.val($$SELECT actor_name FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111', NULL, 1)$$), 'Alice Admin-A', 'it names the actor');
SELECT ok(COALESCE(pg_get_function_result(to_regprocedure('public.get_schedule_audit_log(uuid,uuid,integer)')) !~* '(mail|phone|contact|guardian)', false),
    'and returns no contact column (the contact catalogue of 20261025010000 holds)');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.errx($$SELECT * FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111')$$), '42501:admin_required',
    'a user who is a member of nothing is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.errx($$SELECT * FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111')$$), '42501:admin_required',
    'so is the admin of another organization');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.get_schedule_audit_log('b2222222-2222-2222-2222-222222222222', NULL, 500)$$), '0',
    'and the other organization''s own log holds none of Org A''s rows');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx($$SELECT * FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111')$$), '42501:admin_required',
    'a call with no signed-in user is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"88888888-8888-8888-8888-888888888888"}';
SELECT is(pg_temp.errx($$SELECT * FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111')$$), 'no error',
    'a staff member reads it');

-- ── 8. The grants bite ─────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SET LOCAL role = 'anon';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    '42501:', 'anon cannot call the switch');
SELECT is(pg_temp.errx($$SELECT * FROM public.get_schedule_audit_log('a1111111-1111-1111-1111-111111111111')$$),
    '42501:', 'nor read the log');
SET LOCAL role = 'authenticated';
SELECT is(pg_temp.errx($$SELECT public.admin_set_games_published('a1111111-1111-1111-1111-111111111111', ARRAY['a1111111-1111-1111-1111-0000000c0e02']::uuid[], true)$$),
    'no error', 'control: a signed-in admin calls it through the role the app uses');
RESET role;

SELECT * FROM finish();
ROLLBACK;
