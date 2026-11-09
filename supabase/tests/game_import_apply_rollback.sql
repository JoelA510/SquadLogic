-- pgTAP: a games import (a schedule CSV already made) stages, maps, previews, applies and rolls back through RPCs
-- (migration 20261121010000; plan docs/changes/2026-11-03-schedule-expansion.md section 4.5 to 4.7, PR 5, task E2; and the
-- F11 plan docs/changes/2026-11-06-games-table-source-of-truth.md, "What PR 5 ... must do or avoid").
--
-- Written first, and red against the code before the migration. The file is one league and four jobs:
--
--   J1  the first import (21 staged rows reaching every outcome), previewed by a dry run, then applied;
--   J1b the same file again, staged as a new job: it inserts nothing and creates no run;
--   J3  two new games with a new shell, applied, refused a rollback after a change, then rolled back whole;
--   J4  a job of a completed season, and a registration job, which the apply refuses.
--
-- What is held, each with the control that lets the allowed twin pass:
--   * the shape: `import_type` and `job_type` `games` through every list of 4.10 (the CHECKs, create_import_job, the
--     deferred pair, the allowlist's SQL copy), `game_assignments.import_job_id` and `external_ref` (text, at most 40,
--     exact after trimming, unique PER SEASON, never across seasons), `teams.is_external`, the reason
--     `imported-without-time` on the TIME TBD table;
--   * a dry run writes nothing (a fingerprint of every table of the public schema before and after), and its counts
--     are the apply's;
--   * the apply: a game found by (season, Game ID) is updated IN PLACE by its id, hidden rows included, and its run is
--     the new run; a game with a Game ID is never matched by its tuple (and never inserted a second time); a Published
--     game is skipped, not changed; the previous run's games are carried into the new run (it is the whole schedule);
--     a conflicting file is stored and flagged; team shells land in a team run (`results.teams`), carrying the
--     division's earlier teams; an outside club is a team row flagged `is_external` in no team run; every written game
--     carries its season;
--   * a re-import inserts nothing and creates no run;
--   * the refusals: no signed-in user, another organization's admin, a stranger, a completed season, the wrong job type;
--   * the rollback refuses after a change (naming the games) and, before one, restores the schedule exactly;
--   * `ensure_game_slot` (admin, audited once, on creation only);
--   * the Published guard's rollback exemption (3.3, 4.7): honoured only for the job named, only for an unchanged row;
--   * the readers SQL owns exclude an outside club: `view_org_metrics.total_teams` and the practice TIME TBD sync.
--
-- The seed runs with no signed-in user (the guard and the completed-season trigger let that through), as lesson 56 asks.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(205);

-- ── Helpers ────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
    SELECT ('a1111111-1111-1111-1111-0000000f' || lpad(to_hex(n), 4, '0'))::uuid
$f$;
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
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P1121';
    EXCEPTION WHEN SQLSTATE 'P1121' THEN
        RETURN 'no error';
    END;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
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
-- fp: a fingerprint of EVERY table of the public schema (a dry run must write nothing, anywhere).
CREATE FUNCTION pg_temp.fp() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record; acc text := ''; h text;
BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY c.relname LOOP
        EXECUTE format('SELECT md5(COALESCE(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM public.%I t', r.relname) INTO h;
        acc := acc || r.relname || ':' || h || ';';
    END LOOP;
    RETURN md5(acc);
END
$f$;
-- fps: the schedule's own tables, without the instant a row was last touched (a rollback restores content, not a clock).
CREATE FUNCTION pg_temp.fps() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record; acc text := ''; h text;
BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                AND c.relname IN ('game_assignments', 'game_slots', 'teams', 'divisions', 'locations', 'fields', 'schedule_tbd', 'scheduler_runs')
              ORDER BY c.relname LOOP
        EXECUTE format('SELECT md5(COALESCE(string_agg(((to_jsonb(t) - ''updated_at'') - ''calendar_token'')::text, E''\n'' ORDER BY ((to_jsonb(t) - ''updated_at'') - ''calendar_token'')::text), '''')) FROM public.%I t', r.relname) INTO h;
        acc := acc || r.relname || ':' || h || ';';
    END LOOP;
    RETURN md5(acc);
END
$f$;
-- key: the decision key of a label (core's scheduleLabelKey for the plain labels of this file), and the tuple keys.
CREATE FUNCTION pg_temp.k(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT lower(btrim(p)) $f$;
CREATE FUNCTION pg_temp.k2(a text, b text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
    SELECT '[' || to_json(lower(btrim(a)))::text || ',' || to_json(lower(btrim(b)))::text || ']'
$f$;
-- stage: one staged row of a games job. status 'ok' has a time and a field; 'tbd' has neither.
CREATE FUNCTION pg_temp.stage(p_job uuid, p_row int, p_status text, p_game_id text, p_division text, p_venue text, p_field text,
                              p_home text, p_away text, p_date text, p_start text, p_end text, p_week int, p_flags text[] DEFAULT '{}')
RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES ('a1111111-1111-1111-1111-111111111111', p_job, 'games', p_row, '{}'::jsonb,
            jsonb_build_object(
                'row_key', 'row-' || p_row, 'game_id', p_game_id, 'status', p_status,
                'tbd_reason', CASE WHEN p_status = 'tbd' THEN 'imported-without-time' END,
                'date', p_date, 'start_time', p_start, 'end_time', p_end,
                'start', CASE WHEN p_start IS NULL THEN NULL ELSE p_date || 'T' || p_start || ':00-07:00' END,
                'end', CASE WHEN p_end IS NULL THEN NULL ELSE p_date || 'T' || p_end || ':00-07:00' END,
                'week_index', p_week, 'flags', to_jsonb(p_flags),
                'division', p_division, 'division_key', pg_temp.k(p_division),
                'venue', p_venue, 'venue_key', pg_temp.k(p_venue),
                'field', p_field, 'field_key', pg_temp.k2(p_venue, p_field),
                'home_team', p_home, 'home_key', pg_temp.k2(p_division, p_home),
                'away_team', p_away, 'away_key', pg_temp.k2(p_division, p_away)),
            '[]'::jsonb)
$f$;
-- stage_bad: a row the file check refused (nothing in its payload is trusted).
CREATE FUNCTION pg_temp.stage_bad(p_job uuid, p_row int, p_code text) RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES ('a1111111-1111-1111-1111-111111111111', p_job, 'games', p_row, '{}'::jsonb, NULL,
            jsonb_build_array(jsonb_build_object('code', p_code, 'message', 'planted')))
$f$;
-- num: a number out of the apply's result by path ('games,inserted').
CREATE FUNCTION pg_temp.num(p_res jsonb, p_path text) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE(p_res #>> string_to_array(p_path, ','), 'NULL')
$f$;
-- same: the apply's result without what differs between a dry run and an apply (the flag, the ids it made).
CREATE FUNCTION pg_temp.same(p_res jsonb) RETURNS jsonb LANGUAGE sql AS $f$
    SELECT (p_res - 'dry_run' - 'ids' - 'replayed')
$f$;
-- gj: a saved game as one line, 'home>away@field/date/start w<week> pub=<f|t> ref=<ref>' with the last two characters of ids.
CREATE FUNCTION pg_temp.gj(p_id uuid) RETURNS text LANGUAGE sql AS $f$
    SELECT COALESCE((SELECT right(ga.home_team_id::text, 2) || '>' || right(ga.away_team_id::text, 2) || '@' || right(ga.field_id::text, 2) || '/'
                            || gs.slot_date || '/' || to_char(gs.start_time, 'HH24:MI') || ' w' || ga.week_index || ' pub=' || ga.published::text
                            || ' ref=' || COALESCE(ga.external_ref, '-')
                       FROM public.game_assignments ga LEFT JOIN public.game_slots gs ON gs.id = ga.game_slot_id WHERE ga.id = p_id), 'gone')
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.u(int), pg_temp.err(text), pg_temp.errx(text), pg_temp.val(text), pg_temp.fp(), pg_temp.fps(), pg_temp.k(text), pg_temp.k2(text, text),
    pg_temp.stage(uuid, int, text, text, text, text, text, text, text, text, text, text, int, text[]), pg_temp.stage_bad(uuid, int, text),
    pg_temp.num(jsonb, text), pg_temp.same(jsonb), pg_temp.gj(uuid) TO PUBLIC;

-- ── Seed (no signed-in user) ───────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';

-- Org A's season A is the fixture's (active). Season C is a completed season of Org A; season D is another, draft one.
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111100c1', 'a1111111-1111-1111-1111-111111111111', 'Org A Season C', 'draft', 2025),
    ('a1111111-1111-1111-1111-1111111100d1', 'a1111111-1111-1111-1111-111111111111', 'Org A Season D', 'draft', 2027);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, practices_per_week) VALUES
    (pg_temp.u(20), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Org A U12', 1),
    ('a1111111-1111-1111-1111-1111111d00c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100c1', 'C U10', 1);
UPDATE public.divisions SET practices_per_week = 2 WHERE id = 'a1111111-1111-1111-1111-11111111abcd';
-- Own teams: four in Org A U10 (D1), two in Org A U12 (D2). The two of D2 are held by a saved team run.
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(1), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Lions'),
    (pg_temp.u(2), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Tigers'),
    (pg_temp.u(3), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Bears'),
    (pg_temp.u(4), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Wolves'),
    (pg_temp.u(5), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(20), 'Hawks'),
    (pg_temp.u(6), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(20), 'Eagles'),
    (pg_temp.u(7), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00c1', 'C One'),
    (pg_temp.u(8), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111d00c1', 'C Two');
INSERT INTO public.locations (id, organization_id, name) VALUES
    (pg_temp.u(30), 'a1111111-1111-1111-1111-111111111111', 'Park One');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    (pg_temp.u(31), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(30), 'Field 1'),
    (pg_temp.u(32), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(30), 'Field 2');
-- Seven slots of the saved schedule.
INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
    (pg_temp.u(41), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2026-05-16T09:00:00-07:00', '2026-05-16T10:00:00-07:00', '2026-05-16', '09:00', '10:00', 3, 1),
    (pg_temp.u(42), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(32), '2026-05-16T09:00:00-07:00', '2026-05-16T10:00:00-07:00', '2026-05-16', '09:00', '10:00', 3, 1),
    (pg_temp.u(43), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2026-05-23T09:00:00-07:00', '2026-05-23T10:00:00-07:00', '2026-05-23', '09:00', '10:00', 4, 1),
    (pg_temp.u(44), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2026-05-23T10:00:00-07:00', '2026-05-23T11:00:00-07:00', '2026-05-23', '10:00', '11:00', 4, 1),
    (pg_temp.u(45), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2026-05-16T11:00:00-07:00', '2026-05-16T12:00:00-07:00', '2026-05-16', '11:00', '12:00', 3, 1),
    (pg_temp.u(46), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2026-05-30T09:00:00-07:00', '2026-05-30T10:00:00-07:00', '2026-05-30', '09:00', '10:00', 5, 1),
    (pg_temp.u(47), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(32), '2026-05-30T09:00:00-07:00', '2026-05-30T10:00:00-07:00', '2026-05-30', '09:00', '10:00', 5, 1);
-- Two saved game runs (R0 older and hidden, R1 the one the page shows) and a saved team run holding D2's two teams.
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
    (pg_temp.u(60), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-04-01T00:00:00Z'),
    (pg_temp.u(61), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'game', 'completed', '2026-04-02T00:00:00Z');
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, results, completed_at) VALUES
    (pg_temp.u(62), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'team', 'completed',
     jsonb_build_object('selectedProgramId', pg_temp.u(20)::text),
     jsonb_build_object('teams', jsonb_build_array(
         jsonb_build_object('id', pg_temp.u(5), 'division', pg_temp.u(20)::text, 'division_id', pg_temp.u(20), 'name', 'Hawks', 'players', '[]'::jsonb),
         jsonb_build_object('id', pg_temp.u(6), 'division', pg_temp.u(20)::text, 'division_id', pg_temp.u(20), 'name', 'Eagles', 'players', '[]'::jsonb)),
         'team_players', '[]'::jsonb),
     '2026-03-01T00:00:00Z');
-- The seven games already saved (F11-1 set the season on a row a save writes; these carry it):
--   E1 G-900 Lions>Bears  S1  Published, in R1     E2 G-901 Tigers>Wolves S2  in R1      E3 G-902 Bears>Wolves S3 HIDDEN (R0)
--   E3b G-903 Lions>Wolves S4  HIDDEN (R0)         E4 (no id) Hawks>Eagles S5 in R1      E5 (no id) Lions>Wolves S6 in R1
--   E6 (no id) Bears>Tigers S7 in R1
INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id,
                                     division, week_index, start, "end", assignment_source, external_ref) VALUES
    (pg_temp.u(51), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(61), pg_temp.u(41), pg_temp.u(41), pg_temp.u(31), pg_temp.u(1), pg_temp.u(3), 'Org A U10', 3, '2026-05-16T09:00:00-07:00', '2026-05-16T10:00:00-07:00', 'auto', 'G-900'),
    (pg_temp.u(52), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(61), pg_temp.u(42), pg_temp.u(42), pg_temp.u(32), pg_temp.u(2), pg_temp.u(4), 'Org A U10', 3, '2026-05-16T09:00:00-07:00', '2026-05-16T10:00:00-07:00', 'auto', 'G-901'),
    (pg_temp.u(53), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(60), pg_temp.u(43), pg_temp.u(43), pg_temp.u(31), pg_temp.u(3), pg_temp.u(4), 'Org A U10', 4, '2026-05-23T09:00:00-07:00', '2026-05-23T10:00:00-07:00', 'auto', 'G-902'),
    (pg_temp.u(57), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(60), pg_temp.u(44), pg_temp.u(44), pg_temp.u(31), pg_temp.u(1), pg_temp.u(4), 'Org A U10', 4, '2026-05-23T10:00:00-07:00', '2026-05-23T11:00:00-07:00', 'auto', 'G-903'),
    (pg_temp.u(54), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(61), pg_temp.u(45), pg_temp.u(45), pg_temp.u(31), pg_temp.u(5), pg_temp.u(6), 'Org A U12', 3, '2026-05-16T11:00:00-07:00', '2026-05-16T12:00:00-07:00', 'auto', NULL),
    (pg_temp.u(55), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(61), pg_temp.u(46), pg_temp.u(46), pg_temp.u(31), pg_temp.u(1), pg_temp.u(4), 'Org A U10', 5, '2026-05-30T09:00:00-07:00', '2026-05-30T10:00:00-07:00', 'auto', NULL),
    (pg_temp.u(56), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(61), pg_temp.u(47), pg_temp.u(47), pg_temp.u(32), pg_temp.u(3), pg_temp.u(2), 'Org A U10', 5, '2026-05-30T09:00:00-07:00', '2026-05-30T10:00:00-07:00', 'auto', NULL);
UPDATE public.game_assignments SET published = true WHERE id = pg_temp.u(51);
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-1111111100c1';
-- Season D holds one game with Game ID 'G-900' too: the same Game ID in another season of the organization.
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    (pg_temp.u(21), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100d1', 'D U10');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(9), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(21), 'D One'),
    (pg_temp.u(10), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(21), 'D Two');
-- Org B: an admin of another organization (Bob), and a job of Org A that Bob must not touch.
INSERT INTO public.locations (id, organization_id, name) VALUES ('b2222222-2222-2222-2222-0000000f00a0', 'b2222222-2222-2222-2222-222222222222', 'Park B');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES ('b2222222-2222-2222-2222-0000000f00f1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-0000000f00a0', 'Field B');

CREATE TEMP TABLE jobs (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT SELECT ON jobs TO PUBLIC;
CREATE TEMP TABLE marks (name text PRIMARY KEY, v text) ON COMMIT DROP;
GRANT SELECT, INSERT, UPDATE ON marks TO PUBLIC;
CREATE FUNCTION pg_temp.j(p text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM jobs WHERE name = p $f$;
GRANT EXECUTE ON FUNCTION pg_temp.j(text) TO PUBLIC;
-- The saved state before any import: the schedule fingerprint, the games, the runs and the teams.
INSERT INTO marks VALUES
    ('games0', (SELECT count(*)::text FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111')),
    ('runs0', (SELECT count(*)::text FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111')),
    ('e1', pg_temp.gj(pg_temp.u(51))), ('e4', pg_temp.gj(pg_temp.u(54)));

SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '7',
    'control: the seed is seven saved games of season A (five in the run the page shows, two hidden in the older run)');

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 1. The shape ───────────────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '-'), '; ')
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'is_external'$$),
    'is_external boolean NO false', 'teams.is_external is a boolean, NOT NULL, false by default (every existing team is one of the organization''s own)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE is_external$$), '0', 'control: no seeded team is an outside club');
SELECT is(pg_temp.val($$SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable, '; ' ORDER BY column_name)
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'game_assignments' AND column_name IN ('external_ref', 'import_job_id')$$),
    'external_ref text YES; import_job_id uuid YES', 'game_assignments gains external_ref (text) and import_job_id (uuid), both nullable');
SELECT ok(COALESCE((SELECT c.confdeltype = 'n' AND c.confrelid = 'public.import_jobs'::regclass FROM pg_constraint c
                     WHERE c.conrelid = 'public.game_assignments'::regclass AND c.contype = 'f'
                       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'import_job_id')]), false),
    'import_job_id references import_jobs and is set null when the job goes (a game is never deleted by its provenance)');
SELECT ok(EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.game_assignments'::regclass AND i.indisunique AND i.indpred IS NOT NULL
                   AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ARRAY['season_settings_id', 'external_ref']),
    'the Game ID is unique on (season_settings_id, external_ref) for rows that have one: per season, never per organization');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.game_assignments'::regclass AND i.indisunique
                       AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) IN (ARRAY['external_ref'], ARRAY['organization_id', 'external_ref'])),
    'and there is no key on external_ref alone or per organization (a Game ID is never unique across seasons)');
SELECT is(pg_temp.errx($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(3), pg_temp.u(4), 'Org A U10', 9, 'G-900')$$), '23505:Key (season_settings_id, external_ref)=(a1111111-1111-1111-1111-111111111aaa, G-900) already exists.',
    'the same Game ID twice in one season is refused by the index (the backstop of the apply)');
SELECT is(pg_temp.errx($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100d1', pg_temp.u(9), pg_temp.u(10), 'D U10', 1, 'G-900')$$), 'no error',
    'control: the same Game ID in another season of the same organization is accepted');
SELECT is(pg_temp.errx($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(3), pg_temp.u(4), 'Org A U10', 9, 'g-900')$$), 'no error',
    'a Game ID is compared exactly: g-900 is not G-900');
SELECT is(pg_temp.err($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(3), pg_temp.u(4), 'Org A U10', 8, repeat('x', 41))$$) ~ '^23514:', 'true',
    'a Game ID of 41 characters is refused (at most 40)');
SELECT is(pg_temp.err($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(3), pg_temp.u(4), 'Org A U10', 7, repeat('x', 40))$$), 'no error',
    'control: a Game ID of 40 characters is accepted');
SELECT is(pg_temp.err($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(3), pg_temp.u(4), 'Org A U10', 6, ' padded ')$$) ~ '^23514:', 'true',
    'a Game ID with a space at either end is refused: the apply trims, the column holds what was compared');
SELECT is(pg_temp.err($$INSERT INTO public.game_assignments (organization_id, season_settings_id, home_team_id, away_team_id, division, week_index, external_ref)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(3), pg_temp.u(4), 'Org A U10', 5, '')$$) ~ '^23514:', 'true',
    'and an empty one is refused (a game with no Game ID has NULL, never an empty text)');
DELETE FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND week_index IN (1, 7, 9) AND division IN ('D U10', 'Org A U10')
   AND id NOT IN (SELECT pg_temp.u(n) FROM generate_series(51, 57) n);
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '7',
    'control: the probe rows are removed again (the shape checks left nothing behind)');
SELECT is(pg_temp.val($$SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.import_jobs'::regclass AND conname = 'import_jobs_job_type_check' AND pg_get_constraintdef(oid) LIKE '%''games''%'$$),
    'import_jobs_job_type_check', 'import_jobs.job_type admits games');
SELECT is(pg_temp.val($$SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.staging_import_rows'::regclass AND conname = 'staging_import_rows_import_type_check' AND pg_get_constraintdef(oid) LIKE '%''games''%'$$),
    'staging_import_rows_import_type_check', 'staging_import_rows.import_type admits games');
SELECT ok(COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%''games''%' FROM pg_constraint WHERE conrelid = 'public.import_application_records'::regclass AND conname = 'import_application_records_import_type_check'), false)
          AND COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%''game_assignments''%' AND pg_get_constraintdef(oid) LIKE '%''teams''%' AND pg_get_constraintdef(oid) LIKE '%''divisions''%'
                               AND pg_get_constraintdef(oid) LIKE '%''schedule_tbd''%' AND pg_get_constraintdef(oid) LIKE '%''game_slots''%' AND pg_get_constraintdef(oid) LIKE '%''locations''%'
                          FROM pg_constraint WHERE conrelid = 'public.import_application_records'::regclass AND conname = 'import_application_records_target_table_check'), false),
    'import_application_records admits games as an import type and game_assignments, teams, divisions and schedule_tbd as targets (game_slots, locations and fields were already)');
SELECT ok(COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%imported-without-time%' FROM pg_constraint WHERE conrelid = 'public.schedule_tbd'::regclass AND conname = 'schedule_tbd_reason_check'), false),
    'the TIME TBD table admits the reason imported-without-time (for a game)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_actions WHERE action = 'game.slot_created'$$), '1', 'audit_actions holds game.slot_created');
SELECT is(pg_temp.val($$SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ' | ' ORDER BY p.proname) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('apply_game_import_job', 'rollback_game_import_job', 'map_game_import_job', 'ensure_game_slot')$$),
    'apply_game_import_job(p_import_job_id uuid, p_dry_run boolean) | ensure_game_slot(p_organization_id uuid, p_field_id uuid, p_slot_date date, p_start_time time without time zone, p_end_time time without time zone, p_week_index smallint, p_start timestamp with time zone, p_end timestamp with time zone) | map_game_import_job(p_import_job_id uuid, p_mapping jsonb) | rollback_game_import_job(p_import_job_id uuid)',
    'the four functions exist with the signatures the plan names');
SELECT ok(COALESCE((SELECT bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proconfig @> ARRAY['TimeZone=UTC']
                           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                           AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
                      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                       AND p.proname IN ('apply_game_import_job', 'rollback_game_import_job', 'map_game_import_job', 'ensure_game_slot')), false),
    'each is SECURITY DEFINER, pinned to search_path=public and TimeZone=UTC, closed to PUBLIC and anon, open to authenticated');

-- ── 2. The lists a new import type joins (4.10): the lifecycle functions ───
INSERT INTO jobs
    SELECT 'j1', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'schedule.csv')).id;
SELECT is(pg_temp.val($$SELECT job_type || ' ' || status || ' ' || season_settings_id FROM public.import_jobs WHERE id = pg_temp.j('j1')$$),
    'games importing a1111111-1111-1111-1111-111111111aaa', 'create_import_job takes games: a games job of the active season, importing');
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'draft.csv', 'a1111111-1111-1111-1111-1111111100d1')$$) ~ '^22023:season_not_active', 'true',
    'a draft season takes no games import (only the active season does, as a field import)');
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'done.csv', 'a1111111-1111-1111-1111-1111111100c1')$$) ~ '^22023:', 'true',
    'and a season that is not active takes none (a completed one least of all)');
SELECT is(pg_temp.val($$SELECT (public.mark_import_job_ready_to_apply(pg_temp.j('j1'), 'games', '[]'::jsonb)) ->> 'status'$$), 'ready_to_apply',
    'mark_import_job_ready_to_apply takes games');
SELECT is(pg_temp.val($$SELECT (public.cancel_ready_import_job(pg_temp.j('j1'), 'games')) ->> 'status'$$), 'canceled',
    'cancel_ready_import_job takes games');
UPDATE public.import_jobs SET status = 'importing', error_summary = '{}'::jsonb, completed_at = NULL, warning_summary = '{}'::jsonb WHERE id = pg_temp.j('j1');
SELECT is(pg_temp.val($$SELECT cardinality(public.import_allowed_keys('games'))$$), '21', 'import_allowed_keys has an arm for games (the staged payload keys the apply reads)');

-- ── 3. Staging J1 and mapping it ───────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('j1'),  1, 'ok',  'G-100', 'Org A U10', 'Park One', 'Field 1', 'Lions',   'Tigers',          '2026-05-02', '09:00', '10:00', 1, ARRAY['time-ambiguous']);
SELECT pg_temp.stage(pg_temp.j('j1'),  2, 'ok',  'G-101', 'Org A U10', 'Park One', 'Field 2', 'Bears',   'Wolves',          '2026-05-02', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1'),  3, 'ok',  NULL,    'Org A U10', 'Park One', 'Field 1', 'Lions',   'Bears',           '2026-05-09', '09:00', '10:00', 2);
SELECT pg_temp.stage(pg_temp.j('j1'),  4, 'ok',  'G-102', 'Org A U10', 'Park One', 'Field 1', 'Tigers',  'Visiting Club A', '2026-05-09', '10:00', '11:00', 2);
SELECT pg_temp.stage(pg_temp.j('j1'),  5, 'ok',  'G-103', 'Org A U12', 'Park Two', 'Field A', 'Hawks',   'New Shell FC',    '2026-05-02', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1'),  6, 'ok',  'G-104', 'U14 Boys',  'Park Two', 'Field A', 'Sharks',  'Rays',            '2026-05-02', '11:00', '12:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1'),  7, 'ok',  'G-105', 'Org A U10', 'Park One', 'Field 1', 'Wolves',  'Tigers',          '2026-05-09', '09:00', '10:00', 2);
SELECT pg_temp.stage(pg_temp.j('j1'),  8, 'ok',  'G-106', 'Org A U10', 'Park One', 'Field 2', 'Lions',   'Wolves',          '2026-05-09', '09:30', '10:30', 2);
SELECT pg_temp.stage(pg_temp.j('j1'),  9, 'tbd', 'G-107', 'Org A U10', '',         '',        'Bears',   'Tigers',          '2026-05-09', NULL,    NULL,    2);
SELECT pg_temp.stage_bad(pg_temp.j('j1'), 10, 'bad-date');
SELECT pg_temp.stage(pg_temp.j('j1'), 11, 'ok',  'G-108', 'Org A U10', 'Park One', 'Field 1', 'Mystery',  'Lions',          '2026-06-06', '09:00', '10:00', 6);
SELECT pg_temp.stage(pg_temp.j('j1'), 12, 'ok',  'G-109', 'Org A U10', 'Park One', 'Field 1', 'SkipMe',   'Lions',          '2026-06-06', '10:00', '11:00', 6);
SELECT pg_temp.stage(pg_temp.j('j1'), 13, 'ok',  'G-110', 'Org A U10', 'Park One', 'Field 1', 'Visiting Club A', 'Visiting Club B', '2026-06-06', '11:00', '12:00', 6);
SELECT pg_temp.stage(pg_temp.j('j1'), 14, 'ok',  'G-111', 'Org A U10', 'Park One', 'Field 1', 'Lions',    'LIONS ',         '2026-06-13', '09:00', '10:00', 7);
SELECT pg_temp.stage(pg_temp.j('j1'), 15, 'ok',  NULL,    'Org A U10', 'Park One', 'Field 2', 'BEARS',    'WOLVES',         '2026-05-02', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1'), 16, 'ok',  'G-900', 'Org A U10', 'Park One', 'Field 1', 'Lions',    'Bears',          '2026-05-16', '10:00', '11:00', 3);
SELECT pg_temp.stage(pg_temp.j('j1'), 17, 'ok',  'G-901', 'Org A U10', 'Park One', 'Field 2', 'Tigers',   'Wolves',         '2026-05-16', '11:00', '12:00', 3);
SELECT pg_temp.stage(pg_temp.j('j1'), 18, 'ok',  'G-902', 'Org A U10', 'Park One', 'Field 1', 'Bears',    'Wolves',         '2026-05-23', '09:00', '10:00', 4);
SELECT pg_temp.stage(pg_temp.j('j1'), 19, 'ok',  'G-903', 'Org A U10', 'Park One', 'Field 1', 'Lions',    'Wolves',         '2026-05-23', '11:00', '12:00', 4);
SELECT pg_temp.stage(pg_temp.j('j1'), 20, 'ok',  NULL,    'Org A U10', 'Park One', 'Field 1', 'Lions',    'Wolves',         '2026-05-30', '09:00', '10:00', 5);
SELECT pg_temp.stage(pg_temp.j('j1'), 21, 'ok',  'G-NEW1', 'Org A U10', 'Park One', 'Field 2', 'Bears',   'Tigers',         '2026-05-30', '09:00', '10:00', 5);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- The decisions the admin confirmed (the effective ones: an exact single match is a `map`, as core proposes it).
CREATE FUNCTION pg_temp.mapping_j1() RETURNS jsonb LANGUAGE sql AS $f$
    SELECT jsonb_build_object(
        'options', jsonb_build_object('arrive_published', true),
        'divisions', jsonb_build_object(
            'org a u10', jsonb_build_object('action', 'map', 'id', 'a1111111-1111-1111-1111-11111111abcd'),
            'org a u12', jsonb_build_object('action', 'map', 'id', pg_temp.u(20)),
            'u14 boys',  jsonb_build_object('action', 'create', 'name', 'U14 Boys')),
        'venues', jsonb_build_object(
            'park one', jsonb_build_object('action', 'map', 'id', pg_temp.u(30)),
            'park two', jsonb_build_object('action', 'create', 'name', 'Park Two')),
        'fields', jsonb_build_object(
            pg_temp.k2('Park One', 'Field 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31)),
            pg_temp.k2('Park One', 'Field 2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(32)),
            pg_temp.k2('Park Two', 'Field A'), jsonb_build_object('action', 'create', 'name', 'Field A')),
        'teams', jsonb_build_object(
            pg_temp.k2('Org A U10', 'Lions'),   jsonb_build_object('action', 'map', 'id', pg_temp.u(1)),
            pg_temp.k2('Org A U10', 'Tigers'),  jsonb_build_object('action', 'map', 'id', pg_temp.u(2)),
            pg_temp.k2('Org A U10', 'Bears'),   jsonb_build_object('action', 'map', 'id', pg_temp.u(3)),
            pg_temp.k2('Org A U10', 'Wolves'),  jsonb_build_object('action', 'map', 'id', pg_temp.u(4)),
            pg_temp.k2('Org A U10', 'Visiting Club A'), jsonb_build_object('action', 'outside'),
            pg_temp.k2('Org A U10', 'Visiting Club B'), jsonb_build_object('action', 'outside'),
            pg_temp.k2('Org A U10', 'SkipMe'),  jsonb_build_object('action', 'skip'),
            pg_temp.k2('Org A U12', 'Hawks'),   jsonb_build_object('action', 'map', 'id', pg_temp.u(5)),
            pg_temp.k2('Org A U12', 'New Shell FC'), jsonb_build_object('action', 'create', 'name', 'New Shell FC'),
            pg_temp.k2('U14 Boys', 'Sharks'),   jsonb_build_object('action', 'create', 'name', 'Sharks'),
            pg_temp.k2('U14 Boys', 'Rays'),     jsonb_build_object('action', 'create', 'name', 'Rays')))
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.mapping_j1() TO PUBLIC;

SELECT is(pg_temp.err($$SELECT public.map_game_import_job(pg_temp.j('j1'), '{"divisions": []}'::jsonb)$$) ~ '^22023:', 'true',
    'a mapping whose group is not an object is refused');
SELECT is(pg_temp.err($$SELECT public.map_game_import_job(pg_temp.j('j1'), jsonb_build_object('divisions', jsonb_build_object('x', jsonb_build_object('action', 'explode'))))$$) ~ '^22023:', 'true',
    'a decision with an action the kind does not have is refused (nothing is guessed)');
SELECT is(pg_temp.err($$SELECT public.map_game_import_job(pg_temp.j('j1'), jsonb_build_object('teams', jsonb_build_object('x', jsonb_build_object('action', 'map', 'id', pg_temp.u(1))),
        'divisions', jsonb_build_object('y', jsonb_build_object('action', 'outside'))))$$) ~ '^22023:', 'true',
    'outside is a decision about a team only: on a division it is refused');
SELECT is(pg_temp.err($$SELECT public.map_game_import_job(pg_temp.j('j1'), jsonb_build_object('divisions', jsonb_build_object('x', jsonb_build_object('action', 'map', 'id', 'b2222222-2222-2222-2222-22222222bcde'))))$$) ~ '^(22023|42501):', 'true',
    'a map to another organization''s division is refused');
SELECT is(pg_temp.err($$SELECT public.map_game_import_job(pg_temp.j('j1'), jsonb_build_object('divisions', jsonb_build_object('x', jsonb_build_object('action', 'map', 'id', 'a1111111-1111-1111-1111-1111111d00c1'))))$$) ~ '^(22023|42501):', 'true',
    'and a map to a division of another season (the completed one) is refused too');
SELECT is(pg_temp.val($$SELECT (public.map_game_import_job(pg_temp.j('j1'), pg_temp.mapping_j1())) ->> 'job_id'$$), pg_temp.j('j1')::text,
    'control: the real mapping is stored on the job');

-- ── 4. The refusals of the apply, each beside its control ──────────────────
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('j1'), true)$$), '42501:', 'a caller with no signed-in user is refused (a dry run included)');
SELECT is(pg_temp.errx($$SELECT public.map_game_import_job(pg_temp.j('j1'), pg_temp.mapping_j1())$$), '42501:', 'and the mapping step refuses it');
SELECT is(pg_temp.errx($$SELECT public.rollback_game_import_job(pg_temp.j('j1'))$$), '42501:', 'and the rollback');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('j1'), true)$$), '42501:', 'an admin of another organization is refused');
SELECT is(pg_temp.errx($$SELECT public.map_game_import_job(pg_temp.j('j1'), pg_temp.mapping_j1())$$), '42501:', 'and so is the mapping step');
SELECT is(pg_temp.errx($$SELECT public.rollback_game_import_job(pg_temp.j('j1'))$$), '42501:', 'and the rollback');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('j1'), true)$$), '42501:', 'a stranger with no membership is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('j1'), true)$$), 'no error', 'control: the admin of the organization may preview the job');
-- A job of a completed season, and a registration job.
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
    (pg_temp.u(900), 'a1111111-1111-1111-1111-111111111111', 'games', 'imports/x/done.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111100c1'),
    (pg_temp.u(901), 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/x/players.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.u(900), false)$$), '22023:season_completed', 'a games job of a completed season is refused, naming the reason');
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.u(901), false)$$) ~ '^22023:', 'true', 'a registration job is not a games job');
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job('00000000-0000-4000-8000-000000000bad', false)$$), 'P0002:', 'a job that does not exist is not found');

-- ── 5. A dry run writes nothing, and says what the apply will do ───────────
INSERT INTO marks VALUES ('fp_before_dry', pg_temp.fp());
INSERT INTO marks VALUES ('dry', (public.apply_game_import_job(pg_temp.j('j1'), true))::text);
SELECT is(pg_temp.fp(), (SELECT v FROM marks WHERE name = 'fp_before_dry'),
    'a dry run writes nothing: the fingerprint of every table of the public schema is the same after it (jobs, staged rows, audit, runs, games, teams, slots)');
SELECT is((SELECT v::jsonb ->> 'dry_run' FROM marks WHERE name = 'dry'), 'true', 'and says it was a dry run');
SELECT is((SELECT (v::jsonb #>> '{ids,run_id}') FROM marks WHERE name = 'dry'), NULL, 'a dry run made no run');

-- ── 6. The apply ───────────────────────────────────────────────────────────
INSERT INTO marks VALUES ('apply', (public.apply_game_import_job(pg_temp.j('j1'), false))::text);
SELECT is(pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'apply')), pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'dry')),
    'the apply equals the dry run in every count, list and warning (the same plan; only the flag and the ids it made differ)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'dry_run'), 'false', 'the apply says it was not a dry run');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'rows,staged'), '21', 'it read 21 staged rows');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'games,inserted'), '8', 'eight new games');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'games,updated'), '2', 'two games updated in place (one by a Game ID in the visible run, one by a Game ID in a hidden row)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'games,unchanged'), '2', 'two matched games that the file leaves as they are (one by tuple, one by Game ID in a hidden row)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'games,repointed'), '5',
    'five saved games are carried into the new run without a change (the visible ones the file skips or leaves, and the hidden one it found by its Game ID)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'games,skipped,skipped-published'), '1',
    'a Published game whose row changed is skipped (skipped-published), not changed');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'time_tbd,inserted'), '1', 'a row with no time is a TIME TBD game, not a dropped row');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'rows,refused'), '6', 'six rows are refused and listed');
SELECT is((SELECT v::jsonb -> 'refused_by_reason' FROM marks WHERE name = 'apply'),
    '{"bad-date": 1, "same-team": 1, "unknown-team": 2, "duplicate-row": 2}'::jsonb,
    'by reason: a file-check refusal, a game against itself, two unknown teams (one unmapped label, one fixture of two outside clubs) and two duplicates (one after mapping, one on a place held by a game with no Game ID)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'rows,skipped'), '1', 'one row is skipped by the admin''s decision for its label');
SELECT is((SELECT v::jsonb -> 'created' FROM marks WHERE name = 'apply'),
    '{"divisions": 1, "venues": 1, "fields": 1, "teams": 3, "outside_teams": 1, "slots": 9}'::jsonb,
    'created, only what a written game uses: a division, a venue and a field, three team shells, one outside club (the second is on a refused fixture) and nine slots');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'reused,slots'), '2', 'two slots were already there and are reused');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply'), 'not_in_file,count'), '2', 'two games of the previous schedule are not in the file (listed, never deleted)');
SELECT is((SELECT v::jsonb ->> 'nothing_to_apply' FROM marks WHERE name = 'apply'), 'false', 'there was something to apply');
SELECT is((SELECT jsonb_agg(w ->> 'type' ORDER BY w ->> 'type') FROM jsonb_array_elements((SELECT v::jsonb -> 'warnings' FROM marks WHERE name = 'apply')) w),
    '["field-overlap", "team-double-booked", "team-double-booked", "time-ambiguous"]'::jsonb,
    'a conflicting file is stored and flagged: two games on one field and start, a team in two games at once (each side), and the file''s own ambiguous-time flag');
SELECT is((SELECT v::jsonb -> 'not_judged' FROM marks WHERE name = 'apply'), '["coach-conflict", "home-away-imbalance"]'::jsonb,
    'and the result says what it did NOT judge (a coach overlap and the hosting balance are the preview''s audit, not the database''s)');

-- What the apply did to the saved schedule.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '15',
    'the organization holds fifteen games: the seven it had and eight new');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE run_id = (SELECT (v::jsonb #>> '{ids,run_id}')::uuid FROM marks WHERE name = 'apply')$$), '15',
    'the new run holds all fifteen: it is the whole visible schedule (every game of the previous run, the hidden ones the file found, and the new ones)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND run_type = 'game'$$), '3',
    'exactly one new game run was made');
SELECT is(pg_temp.val($$SELECT sr.status || ' ' || (sr.parameters ->> 'source') || ' ' || (sr.parameters ->> 'import_job_id') || ' ' || sr.season_settings_id
        FROM public.scheduler_runs sr WHERE sr.id = (SELECT (v::jsonb #>> '{ids,run_id}')::uuid FROM marks WHERE name = 'apply')$$),
    'completed import ' || pg_temp.j('j1')::text || ' a1111111-1111-1111-1111-111111111aaa', 'it is a completed game run of the season, labelled as an import of this job');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs sr WHERE sr.id = (SELECT (v::jsonb #>> '{ids,run_id}')::uuid FROM marks WHERE name = 'apply')
        AND jsonb_typeof(sr.results -> 'warnings') = 'array' AND jsonb_array_length(sr.results -> 'warnings') = 4 AND sr.results -> 'summary' ? 'totalAssignments'$$), '1',
    'its results carry the warnings the Games page reads, and a summary');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND season_settings_id IS DISTINCT FROM 'a1111111-1111-1111-1111-111111111aaa'$$), '0',
    'every game of the organization carries its season (the apply set it on each row it wrote)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE import_job_id = pg_temp.j('j1')$$), '10',
    'the games the apply wrote or updated carry the job that did (eight new, two updated)');
-- F11: in place, by id.
SELECT is(pg_temp.gj(pg_temp.u(52)), '02>04@20/2026-05-16/11:00 w3 pub=false ref=G-901',
    'a game found by (season, Game ID) in the visible run is updated IN PLACE by its id: the same id now stands on the new slot and time');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE external_ref = 'G-901' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$), '1',
    'and there is still ONE game with that Game ID (a second row is never inserted for an existing Game ID)');
SELECT is(pg_temp.gj(pg_temp.u(57)), '01>04@1f/2026-05-23/11:00 w4 pub=false ref=G-903',
    'a Game ID found in a HIDDEN row (an older run) is updated in place too: the same id, the new place');
SELECT is(pg_temp.val($$SELECT run_id = (SELECT (v::jsonb #>> '{ids,run_id}')::uuid FROM marks WHERE name = 'apply') FROM public.game_assignments WHERE id = pg_temp.u(57)$$), 'true',
    'and its run is the new run: a hidden row found by Game ID is visible again');
SELECT is(pg_temp.val($$SELECT run_id = (SELECT (v::jsonb #>> '{ids,run_id}')::uuid FROM marks WHERE name = 'apply') FROM public.game_assignments WHERE id = pg_temp.u(53)$$), 'true',
    'a hidden row the file leaves as it is is re-pointed too, not only the previous latest run''s rows');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE external_ref = 'G-902'$$), '1', 'and no second row was made for it');
SELECT is(pg_temp.gj(pg_temp.u(51)), (SELECT v FROM marks WHERE name = 'e1'), 'a Published game is not changed by the apply (skipped, with a changed row in the file)');
SELECT is(pg_temp.val($$SELECT published || ' ' || (run_id = (SELECT (v::jsonb #>> '{ids,run_id}')::uuid FROM marks WHERE name = 'apply')) FROM public.game_assignments WHERE id = pg_temp.u(51)$$), 'true true',
    'it is still Published and is carried into the new run (the guard allows a run change)');
SELECT is(pg_temp.gj(pg_temp.u(54)), (SELECT v FROM marks WHERE name = 'e4'), 'a game of the previous run the file does not name is carried unchanged');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments ga WHERE ga.home_team_id = pg_temp.u(3) AND ga.away_team_id = pg_temp.u(2) AND ga.week_index = 5$$), '1',
    'a row WITH a Game ID is never matched by its tuple, and is not inserted over a place another game holds: the place''s one game stays the one it was');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE external_ref = 'G-NEW1'$$), '0', 'and its Game ID was not given to that game');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE import_job_id = pg_temp.j('j1') AND published AND published_at IS NOT NULL AND published_by = '11111111-1111-1111-1111-111111111111'$$), '8',
    'the eight new games arrived Published (decision 4), by the admin who applied');
SELECT is(pg_temp.val($$SELECT published FROM public.game_assignments WHERE id = pg_temp.u(52)$$), 'false', 'an updated game keeps the flag it had');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE import_job_id = pg_temp.j('j1') AND external_ref IS NOT NULL$$), '9',
    'the Game IDs of the file were stored on the games that have one (seven new games and the two updated; the one new game without an ID has none)');
-- Slots.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_slots WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '16', 'sixteen slots: the seven it had and nine new');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments ga JOIN public.game_assignments gb ON gb.game_slot_id = ga.game_slot_id AND gb.id < ga.id
        WHERE ga.organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '1',
    'two games on one field and start share ONE slot, which is exactly a double booking, stored (one pair)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_slots gs JOIN public.game_assignments ga ON ga.game_slot_id = gs.id
        WHERE ga.import_job_id = pg_temp.j('j1') AND gs.capacity = 1 AND gs.start IS NOT NULL AND gs."end" IS NOT NULL AND gs.slot_date IS NOT NULL AND gs.start_time IS NOT NULL AND gs.end_time IS NOT NULL AND gs.week_index IS NOT NULL$$), '10',
    'a slot has capacity 1 and both the wall reading and the instants the file carried (the apply never recomputes a time)');
-- Created records.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.divisions WHERE name = 'U14 Boys' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND min_age IS NULL AND max_age IS NULL$$), '1',
    'a division the file named was created in the season, with no age band (teaming cannot place players there until one is set)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.locations l JOIN public.fields f ON f.location_id = l.id WHERE l.name = 'Park Two' AND f.name = 'Field A'$$), '1', 'a venue and its field were created');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE name IN ('New Shell FC', 'Sharks', 'Rays') AND NOT is_external$$), '3', 'three own-team shells were created');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.team_players tp JOIN public.teams t ON t.id = tp.team_id WHERE t.name IN ('New Shell FC', 'Sharks', 'Rays')$$), '0',
    'a shell has no players and no coach (the audit says how many teams have none)');
-- Team shells land in a team run; the division's earlier teams are carried.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE run_type = 'team' AND parameters ->> 'import_job_id' = pg_temp.j('j1')::text$$), '2',
    'the shells are recorded in team runs of the import (one per division that gained shells), through the existing audited writer');
SELECT is(pg_temp.val($$SELECT string_agg(t ->> 'name', ',' ORDER BY t ->> 'name') FROM public.scheduler_runs sr, jsonb_array_elements(sr.results -> 'teams') t
        WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('j1')::text AND t ->> 'division' = pg_temp.u(20)::text$$), 'Eagles,Hawks,New Shell FC',
    'the run of a division that already had a saved team run carries that run''s teams with the new shell (a later run shadows an earlier one per division, so it must hold them all)');
SELECT is(pg_temp.val($$SELECT string_agg(t ->> 'name', ',' ORDER BY t ->> 'name') FROM public.scheduler_runs sr, jsonb_array_elements(sr.results -> 'teams') t
        WHERE sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = pg_temp.j('j1')::text AND t ->> 'division' <> pg_temp.u(20)::text$$), 'Rays,Sharks',
    'and the run of the division the import created holds its two shells');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs sr, jsonb_array_elements(sr.results -> 'teams') t WHERE sr.run_type = 'team'
        AND sr.organization_id = 'a1111111-1111-1111-1111-111111111111' AND (t ->> 'name' = 'Visiting Club A')$$), '0', 'an outside club is in NO team run: teaming never sees one');
-- The outside club.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE is_external$$), '1', 'one outside club row exists: the label of a written game');
SELECT is(pg_temp.val($$SELECT t.name || ' ' || (t.division_id = 'a1111111-1111-1111-1111-11111111abcd') FROM public.teams t WHERE t.is_external$$), 'Visiting Club A true',
    'it is named by the club label and lives in the own team''s division (one row per division and label)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.team_players tp JOIN public.teams t ON t.id = tp.team_id WHERE t.is_external$$), '0', 'it has no players');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments ga JOIN public.teams t ON t.id = ga.away_team_id WHERE t.is_external AND ga.import_job_id = pg_temp.j('j1')$$), '1',
    'and its game is stored with the outside club as the away side, both team ids still NOT NULL');
SELECT is(pg_temp.val($$SELECT total_teams FROM public.view_org_metrics WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    '10', 'view_org_metrics.total_teams excludes the outside club: ten own teams of the season (seven it had and three shells), not eleven');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams t JOIN public.divisions d ON d.id = t.division_id WHERE d.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$), '11',
    'control: eleven rows of `teams` are in the season, so the view really left one out');
-- TIME TBD.
SELECT is(pg_temp.val($$SELECT s.kind || ' ' || s.reason || ' ' || s.week_index || ' ' || (s.home_team_id = pg_temp.u(3)) || ' ' || (s.away_team_id = pg_temp.u(2)) FROM public.schedule_tbd s WHERE s.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    'game imported-without-time 2 true true', 'the TIME TBD game is on the list, for both teams, with the new reason');
-- The practice side's TIME TBD sync leaves an outside club out (a team of a 2-a-week division with no practice reads as short).
SELECT is(pg_temp.val($$SELECT (public.refresh_schedule_tbd_practices('a1111111-1111-1111-1111-111111111aaa')) IS NOT NULL$$), 'true', 'the practice TIME TBD list can be refreshed');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.schedule_tbd s WHERE s.kind = 'practice' AND s.team_id IN (SELECT id FROM public.teams WHERE is_external)$$), '0',
    'and it names no outside club as a team short of practices');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.schedule_tbd s WHERE s.kind = 'practice' AND s.team_id IN (pg_temp.u(1), pg_temp.u(2), pg_temp.u(3), pg_temp.u(4))$$), '4',
    'control: it does name the four own teams of the 2-a-week division');
-- Application records.
SELECT is(pg_temp.val($$SELECT string_agg(target_table || ':' || operation || ':' || n, ' ' ORDER BY target_table, operation) FROM (
        SELECT target_table, operation, count(*) AS n FROM public.import_application_records WHERE import_job_id = pg_temp.j('j1') AND import_type = 'games' GROUP BY 1, 2) x$$),
    'divisions:inserted:1 fields:inserted:1 game_assignments:inserted:8 game_assignments:updated:7 game_slots:inserted:9 locations:inserted:1 schedule_tbd:inserted:1 teams:inserted:4',
    'one application record per thing written: inserts and updates (a carried row is an update of its run), each with its before and after image');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.import_application_records WHERE import_job_id = pg_temp.j('j1') AND target_table = 'game_assignments' AND operation = 'updated'
        AND previous_payload ->> 'run_id' IS DISTINCT FROM applied_payload ->> 'run_id'$$), '7', 'each update record keeps the run the row was in before (a rollback puts it back there)');
-- The job and the audit.
SELECT is(pg_temp.val($$SELECT status || ' ' || (warning_summary -> 'game_import' ->> 'dry_run') FROM public.import_jobs WHERE id = pg_temp.j('j1')$$), 'completed_with_warnings false',
    'the job is finished with warnings (rows were refused) and stores its result');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.staging_import_rows WHERE import_job_id = pg_temp.j('j1') AND applied_at IS NOT NULL$$), '21', 'every staged row is marked processed');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE resource_id = pg_temp.j('j1') AND action = 'import.completed' AND metadata ->> 'import_type' = 'games' AND (metadata #>> '{games,inserted}') = '8'$$), '1',
    'import.completed is audited with import_type games and the counts');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'game.published_set' AND metadata ->> 'scope' IS NOT NULL
        AND metadata -> 'scope' ->> 'kind' = 'import' AND (metadata ->> 'count') = '8'$$), '1',
    'and game.published_set once, with scope import, for the eight games that arrived Published');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log a WHERE a.action = 'team.saved' AND a.resource_id IN
        (SELECT id FROM public.scheduler_runs WHERE run_type = 'team' AND parameters ->> 'import_job_id' = pg_temp.j('j1')::text)$$), '2',
    'the shells were audited by the team writer, once per run');
SELECT is((SELECT v::jsonb ->> 'replayed' FROM (SELECT (public.apply_game_import_job(pg_temp.j('j1'), false))::text AS v) x), 'true',
    'a finished job answers a second call with the result it stored (a retry after a lost response writes nothing)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '15', 'and the games are still fifteen');

-- ── 7. A re-import: the same file as a new job ─────────────────────────────
INSERT INTO jobs SELECT 'j1b', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'schedule.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('j1b'),  1, 'ok',  'G-100', 'Org A U10', 'Park One', 'Field 1', 'Lions',   'Tigers',          '2026-05-02', '09:00', '10:00', 1, ARRAY['time-ambiguous']);
SELECT pg_temp.stage(pg_temp.j('j1b'),  2, 'ok',  'G-101', 'Org A U10', 'Park One', 'Field 2', 'Bears',   'Wolves',          '2026-05-02', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1b'),  3, 'ok',  NULL,    'Org A U10', 'Park One', 'Field 1', 'Lions',   'Bears',           '2026-05-09', '09:00', '10:00', 2);
SELECT pg_temp.stage(pg_temp.j('j1b'),  4, 'ok',  'G-102', 'Org A U10', 'Park One', 'Field 1', 'Tigers',  'Visiting Club A', '2026-05-09', '10:00', '11:00', 2);
SELECT pg_temp.stage(pg_temp.j('j1b'),  5, 'ok',  'G-103', 'Org A U12', 'Park Two', 'Field A', 'Hawks',   'New Shell FC',    '2026-05-02', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1b'),  6, 'ok',  'G-104', 'U14 Boys',  'Park Two', 'Field A', 'Sharks',  'Rays',            '2026-05-02', '11:00', '12:00', 1);
SELECT pg_temp.stage(pg_temp.j('j1b'),  7, 'ok',  'G-105', 'Org A U10', 'Park One', 'Field 1', 'Wolves',  'Tigers',          '2026-05-09', '09:00', '10:00', 2);
SELECT pg_temp.stage(pg_temp.j('j1b'),  8, 'ok',  'G-106', 'Org A U10', 'Park One', 'Field 2', 'Lions',   'Wolves',          '2026-05-09', '09:30', '10:30', 2);
SELECT pg_temp.stage(pg_temp.j('j1b'),  9, 'tbd', 'G-107', 'Org A U10', '',         '',        'Bears',   'Tigers',          '2026-05-09', NULL,    NULL,    2);
SELECT pg_temp.stage(pg_temp.j('j1b'), 16, 'ok',  'G-900', 'Org A U10', 'Park One', 'Field 1', 'Lions',    'Bears',          '2026-05-16', '10:00', '11:00', 3);
SELECT pg_temp.stage(pg_temp.j('j1b'), 17, 'ok',  'G-901', 'Org A U10', 'Park One', 'Field 2', 'Tigers',   'Wolves',         '2026-05-16', '11:00', '12:00', 3);
SELECT pg_temp.stage(pg_temp.j('j1b'), 18, 'ok',  'G-902', 'Org A U10', 'Park One', 'Field 1', 'Bears',    'Wolves',         '2026-05-23', '09:00', '10:00', 4);
SELECT pg_temp.stage(pg_temp.j('j1b'), 19, 'ok',  'G-903', 'Org A U10', 'Park One', 'Field 1', 'Lions',    'Wolves',         '2026-05-23', '11:00', '12:00', 4);
SELECT pg_temp.stage(pg_temp.j('j1b'), 20, 'ok',  NULL,    'Org A U10', 'Park One', 'Field 1', 'Lions',    'Wolves',         '2026-05-30', '09:00', '10:00', 5);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
-- The same decisions, now that what was created exists: an exact match is a `map` (a `create` over an existing name would be refused).
INSERT INTO marks VALUES ('map_j1b', (public.map_game_import_job(pg_temp.j('j1b'), jsonb_build_object(
    'options', jsonb_build_object('arrive_published', true),
    'divisions', jsonb_build_object(
        'org a u10', jsonb_build_object('action', 'map', 'id', 'a1111111-1111-1111-1111-11111111abcd'),
        'org a u12', jsonb_build_object('action', 'map', 'id', pg_temp.u(20)),
        'u14 boys',  jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.divisions WHERE name = 'U14 Boys'))),
    'venues', jsonb_build_object(
        'park one', jsonb_build_object('action', 'map', 'id', pg_temp.u(30)),
        'park two', jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.locations WHERE name = 'Park Two'))),
    'fields', jsonb_build_object(
        pg_temp.k2('Park One', 'Field 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31)),
        pg_temp.k2('Park One', 'Field 2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(32)),
        pg_temp.k2('Park Two', 'Field A'), jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.fields WHERE name = 'Field A'))),
    'teams', jsonb_build_object(
        pg_temp.k2('Org A U10', 'Lions'),   jsonb_build_object('action', 'map', 'id', pg_temp.u(1)),
        pg_temp.k2('Org A U10', 'Tigers'),  jsonb_build_object('action', 'map', 'id', pg_temp.u(2)),
        pg_temp.k2('Org A U10', 'Bears'),   jsonb_build_object('action', 'map', 'id', pg_temp.u(3)),
        pg_temp.k2('Org A U10', 'Wolves'),  jsonb_build_object('action', 'map', 'id', pg_temp.u(4)),
        pg_temp.k2('Org A U10', 'Visiting Club A'), jsonb_build_object('action', 'outside'),
        pg_temp.k2('Org A U12', 'Hawks'),   jsonb_build_object('action', 'map', 'id', pg_temp.u(5)),
        pg_temp.k2('Org A U12', 'New Shell FC'), jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.teams WHERE name = 'New Shell FC')),
        pg_temp.k2('U14 Boys', 'Sharks'),   jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.teams WHERE name = 'Sharks')),
        pg_temp.k2('U14 Boys', 'Rays'),     jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.teams WHERE name = 'Rays'))))))::text);
INSERT INTO marks VALUES ('fp_before_reimport', pg_temp.fp()), ('runs1', (SELECT count(*)::text FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'));
INSERT INTO marks VALUES ('reimport', (public.apply_game_import_job(pg_temp.j('j1b'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'reimport'), 'games,inserted'), '0', 're-importing the same file inserts no game');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'reimport'), 'games,updated'), '0', 'updates none');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'reimport'), 'games,repointed'), '0', 'and moves none into a new run');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'reimport'), 'games,unchanged'), '12', 'every row that places a game finds it where the file says (a Game ID, or a tuple)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'reimport'), 'games,skipped,skipped-published'), '1', 'the Published game whose row differs is still skipped, as before');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'reimport'), 'time_tbd,unchanged'), '1', 'the TIME TBD game is there already: not a second row');
SELECT is((SELECT v::jsonb ->> 'nothing_to_apply' FROM marks WHERE name = 'reimport'), 'true', 'the result says there is nothing to apply');
SELECT is((SELECT v::jsonb #>> '{ids,run_id}' FROM marks WHERE name = 'reimport'), NULL, 'and no run was made for it');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), (SELECT v FROM marks WHERE name = 'runs1'),
    'the organization has the same number of runs as before the re-import (game or team)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE is_external$$), '1', 'the outside club was found and reused, not made again');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '15', 'and the games are still fifteen');
SELECT is(pg_temp.val($$SELECT status FROM public.import_jobs WHERE id = pg_temp.j('j1b')$$), 'completed', 'the job finishes cleanly: nothing was refused in this file');

-- ── 8. ensure_game_slot: an admin RPC, audited when it creates ─────────────
SELECT is(pg_temp.val($$SELECT (public.ensure_game_slot('a1111111-1111-1111-1111-111111111111', pg_temp.u(32), '2026-06-20', '08:00', '09:00', 8::smallint, NULL, NULL)) ->> 'created'$$), 'true',
    'ensure_game_slot creates a slot that is not there');
SELECT is(pg_temp.val($$SELECT (public.ensure_game_slot('a1111111-1111-1111-1111-111111111111', pg_temp.u(32), '2026-06-20', '08:00', '09:00', 8::smallint, NULL, NULL)) ->> 'created'$$), 'false',
    'and finds it the second time (the field import''s lookup: organization, field, date and start)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_slots WHERE field_id = pg_temp.u(32) AND slot_date = '2026-06-20'$$), '1', 'one slot, not two');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE action = 'game.slot_created' AND organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '1',
    'it audited game.slot_created once, on creation only (a find writes no audit row)');
SELECT is(pg_temp.errx($$SELECT public.ensure_game_slot('a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-0000000f00f1', '2026-06-20', '08:00', '09:00', 8::smallint, NULL, NULL)$$) ~ '^(42501|23503|22023):', 'true',
    'a field of another organization is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.errx($$SELECT public.ensure_game_slot('a1111111-1111-1111-1111-111111111111', pg_temp.u(32), '2026-06-21', '08:00', '09:00', 8::smallint, NULL, NULL)$$), '42501:', 'an admin of another organization is refused');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx($$SELECT public.ensure_game_slot('a1111111-1111-1111-1111-111111111111', pg_temp.u(32), '2026-06-21', '08:00', '09:00', 8::smallint, NULL, NULL)$$), '42501:', 'and so is a caller with no signed-in user (it audits, and an audit row needs an actor)');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 9. The Published guard's rollback exemption (3.3, 4.7) ─────────────────
-- Published games of J1, deleted directly by a signed-in caller: refused unless the transaction-local setting names the
-- job that wrote the row AND the row is as the apply left it.
SELECT is(pg_temp.errx($$DELETE FROM public.game_assignments WHERE external_ref = 'G-100'$$) ~ '^22023:game_published', 'true',
    'control: a Published imported game cannot be deleted by a signed-in caller (the guard)');
SELECT is(pg_temp.errx($$SELECT set_config('squadlogic.import_rollback', pg_temp.j('j1b')::text, true); DELETE FROM public.game_assignments WHERE external_ref = 'G-100'$$) ~ '^22023:game_published', 'true',
    'naming a different job lifts nothing: the exemption is for the rows of THAT job');
SELECT is(pg_temp.errx($$SELECT set_config('squadlogic.import_rollback', pg_temp.j('j1')::text, true); DELETE FROM public.game_assignments WHERE id = pg_temp.u(51)$$) ~ '^22023:game_published', 'true',
    'naming the job lifts nothing for a row it did not write (a Published game the import only skipped and carried)');
SELECT is(pg_temp.errx($$SELECT set_config('squadlogic.import_rollback', pg_temp.j('j1')::text, true);
        UPDATE public.game_assignments SET week_index = 9 WHERE external_ref = 'G-100'$$) ~ '^22023:game_published', 'true',
    'and it lifts nothing for a move');
SELECT is(pg_temp.errx($$SELECT set_config('squadlogic.import_rollback', pg_temp.j('j1')::text, true);
        UPDATE public.game_assignments SET published = false WHERE external_ref = 'G-100';
        UPDATE public.game_assignments SET week_index = 9 WHERE external_ref = 'G-100'$$), 'no error',
    'control: once changes were allowed (not held), the same move is an ordinary edit (nothing to lift)');
SELECT is(pg_temp.errx($$SELECT set_config('squadlogic.import_rollback', pg_temp.j('j1')::text, true);
        DELETE FROM public.game_assignments WHERE external_ref = 'G-101'$$), 'no error',
    'the exemption: with the job named, an imported Published game as the apply left it can be deleted (what the rollback does)');
SELECT is(pg_temp.val($$SELECT COALESCE(NULLIF(current_setting('squadlogic.import_rollback', true), ''), 'unset')$$), 'unset',
    'and the setting is transaction-local (an errx probe is a sub-transaction; nothing leaks into the next statement)');

-- ── 10. A job with two new games: refused a rollback after a change, then rolled back whole ─
INSERT INTO jobs SELECT 'j3', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'two.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('j3'), 1, 'ok', 'G-300', 'Org A U10', 'Park One', 'Field 2', 'Bears', 'Tigers', '2026-07-04', '09:00', '10:00', 9);
SELECT pg_temp.stage(pg_temp.j('j3'), 2, 'ok', 'G-301', 'Org A U10', 'Park Three', 'Field Z', 'Wolves', 'Gulls FC', '2026-07-04', '10:00', '11:00', 9);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_j3', (public.map_game_import_job(pg_temp.j('j3'), jsonb_build_object(
    'divisions', jsonb_build_object('org a u10', jsonb_build_object('action', 'map', 'id', 'a1111111-1111-1111-1111-11111111abcd')),
    'venues', jsonb_build_object('park one', jsonb_build_object('action', 'map', 'id', pg_temp.u(30)), 'park three', jsonb_build_object('action', 'create', 'name', 'Park Three')),
    'fields', jsonb_build_object(pg_temp.k2('Park One', 'Field 2'), jsonb_build_object('action', 'map', 'id', pg_temp.u(32)), pg_temp.k2('Park Three', 'Field Z'), jsonb_build_object('action', 'create', 'name', 'Field Z')),
    'teams', jsonb_build_object(
        pg_temp.k2('Org A U10', 'Bears'), jsonb_build_object('action', 'map', 'id', pg_temp.u(3)),
        pg_temp.k2('Org A U10', 'Tigers'), jsonb_build_object('action', 'map', 'id', pg_temp.u(2)),
        pg_temp.k2('Org A U10', 'Wolves'), jsonb_build_object('action', 'map', 'id', pg_temp.u(4)),
        pg_temp.k2('Org A U10', 'Gulls FC'), jsonb_build_object('action', 'outside')))))::text);
INSERT INTO marks VALUES ('fps_before_j3', pg_temp.fps()), ('games_before_j3', (SELECT count(*)::text FROM public.game_assignments));
INSERT INTO marks VALUES ('apply3', (public.apply_game_import_job(pg_temp.j('j3'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply3'), 'games,inserted'), '2', 'J3 inserted two games (one against a new outside club, in a new venue and field)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE is_external$$), '2', 'there are two outside clubs now');
UPDATE public.game_assignments SET published = false WHERE external_ref = 'G-300';
SELECT is(pg_temp.errx($$SELECT public.rollback_game_import_job(pg_temp.j('j3'))$$) ~ '^22023:game_import_changed', 'true',
    'a rollback after a change (a game had changes allowed) is refused');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE import_job_id = pg_temp.j('j3')$$), '2', 'and it deleted nothing');
SELECT is(pg_temp.errx($$SELECT public.rollback_game_import_job(pg_temp.j('j3'))$$) LIKE '%' || (SELECT id::text FROM public.game_assignments WHERE external_ref = 'G-300') || '%', 'true',
    'the refusal names the game that changed');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.import_application_records WHERE import_job_id = pg_temp.j('j3') AND rolled_back_at IS NOT NULL$$), '0',
    'no record was marked rolled back by the refusal');
UPDATE public.game_assignments SET published = true WHERE external_ref = 'G-300';
INSERT INTO marks VALUES ('rb3', (public.rollback_game_import_job(pg_temp.j('j3')))::text);
SELECT is(pg_temp.fps(), (SELECT v FROM marks WHERE name = 'fps_before_j3'),
    'and before a change it succeeds and restores the schedule exactly (games, slots, runs, teams, divisions, venues, fields and TIME TBD, to the last column but the clock)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments$$), (SELECT v FROM marks WHERE name = 'games_before_j3'), 'the two games are gone and the rest are as they were');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE is_external$$), '1', 'the outside club only J3 used is gone (the one J1 made stays: games still use it)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.import_application_records WHERE import_job_id = pg_temp.j('j3') AND rolled_back_at IS NULL$$), '0', 'every record of the job is marked rolled back');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE resource_id = pg_temp.j('j3') AND action = 'import.rolled_back'$$), '1', 'import.rolled_back is audited once');
SELECT is(pg_temp.errx($$SELECT public.rollback_game_import_job(pg_temp.j('j3'))$$) ~ '^22023:', 'true', 'a second rollback has nothing to do and says so');
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('j3'), false)$$) ~ '^22023:', 'true', 'and a rolled-back job is not applied again (a new file is a new job)');
-- The first job: refused while a game it wrote has had changes allowed, then rolled back whole when it is as the apply left it.
UPDATE public.game_assignments SET published = false WHERE external_ref = 'G-102';
SELECT is(pg_temp.errx($$SELECT public.rollback_game_import_job(pg_temp.j('j1'))$$) ~ '^22023:game_import_changed count=1 ids=', 'true',
    'rolling back J1 is refused while one of the games it wrote has had changes allowed (counted and named)');
UPDATE public.game_assignments SET published = true WHERE external_ref = 'G-102';
INSERT INTO marks VALUES ('rb1', (public.rollback_game_import_job(pg_temp.j('j1')))::text);
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '7',
    'the first import rolls back too: the eight new games are gone, Published as they were, through the guard''s exemption');
SELECT is(pg_temp.gj(pg_temp.u(52)), '02>04@20/2026-05-16/09:00 w3 pub=false ref=G-901', 'the game it moved is back where it was');
SELECT is(pg_temp.gj(pg_temp.u(57)), '01>04@1f/2026-05-23/10:00 w4 pub=false ref=G-903', 'and so is the hidden game it moved');
SELECT is(pg_temp.val($$SELECT string_agg(right(id::text, 2) || '=' || right(run_id::text, 2), ',' ORDER BY id) FROM public.game_assignments$$),
    '33=3d,34=3d,35=3c,36=3d,37=3d,38=3d,39=3c', 'every game is in the run it was in before the import (the two hidden ones in the older run)');
SELECT is(pg_temp.gj(pg_temp.u(51)), (SELECT v FROM marks WHERE name = 'e1'), 'the Published game is as it was, still Published');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scheduler_runs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), (SELECT v FROM marks WHERE name = 'runs0'),
    'the import''s game run and its two team runs are gone: the organization has the runs it had');
SELECT is(pg_temp.val($$SELECT (SELECT count(*) FROM public.teams WHERE is_external) || ' ' || (SELECT count(*) FROM public.divisions WHERE name = 'U14 Boys')
        || ' ' || (SELECT count(*) FROM public.locations WHERE name = 'Park Two') || ' ' || (SELECT count(*) FROM public.teams WHERE name IN ('New Shell FC', 'Sharks', 'Rays'))$$), '0 0 0 0',
    'the outside club, the division, the venue and the three shells it created are gone (nothing else referenced them)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_slots WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$), '8',
    'and so are the nine slots it made: eight remain, the seven it had and the one ensure_game_slot made by hand');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE resource_id = pg_temp.j('j1') AND action = 'import.rolled_back'$$), '1', 'import.rolled_back is audited for the first import too');

-- ── 11. Row-count meta-assertion: the file reached every outcome ───────────
SELECT ok((SELECT bool_and(n > 0) FROM (VALUES
        ((SELECT (v::jsonb #>> '{games,inserted}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{games,updated}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{games,unchanged}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{games,repointed}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{games,skipped,skipped-published}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{time_tbd,inserted}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{rows,refused}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{rows,skipped}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{created,outside_teams}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{created,teams}')::int FROM marks WHERE name = 'apply')),
        ((SELECT (v::jsonb #>> '{not_in_file,count}')::int FROM marks WHERE name = 'apply'))) AS t(n)),
    'meta: the file reaches every outcome the counts name (a file that reached half of them would compare half)');

-- ── 12. Fix round 1 (the reviews of 87b696a) ───────────────────────────────
-- A division of its own for this block, so what the earlier jobs left does not matter.
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, practices_per_week) VALUES
    (pg_temp.u(300), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Fix U9', 1);
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    (pg_temp.u(301), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'Fix Lions'),
    (pg_temp.u(302), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(300), 'Fix Tigers');

-- 12.1 (Codex 1) The rollback never deletes what an admin attached after the import: a permit scope or a blackout on
-- a field or a venue it created, a subunit of a field it created. Six venues, each with a field.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jk', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'estate.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('jk'), 1, 'ok', 'G-K1', 'Fix U9', 'Perm One',   'Field K1', 'Fix Lions', 'Fix Tigers', '2026-09-05', '09:00', '10:00', 1);
SELECT pg_temp.stage(pg_temp.j('jk'), 2, 'ok', 'G-K2', 'Fix U9', 'Perm Two',   'Field K2', 'Fix Lions', 'Fix Tigers', '2026-09-12', '09:00', '10:00', 2);
SELECT pg_temp.stage(pg_temp.j('jk'), 3, 'ok', 'G-K3', 'Fix U9', 'Perm Three', 'Field K3', 'Fix Lions', 'Fix Tigers', '2026-09-19', '09:00', '10:00', 3);
SELECT pg_temp.stage(pg_temp.j('jk'), 4, 'ok', 'G-K4', 'Fix U9', 'Perm Four',  'Field K4', 'Fix Lions', 'Fix Tigers', '2026-09-26', '09:00', '10:00', 4);
SELECT pg_temp.stage(pg_temp.j('jk'), 5, 'ok', 'G-K5', 'Fix U9', 'Perm Five',  'Field K5', 'Fix Lions', 'Fix Tigers', '2026-10-03', '09:00', '10:00', 5);
SELECT pg_temp.stage(pg_temp.j('jk'), 6, 'ok', 'G-K6', 'Fix U9', 'Perm Six',   'Field K6', 'Fix Lions', 'Fix Tigers', '2026-10-10', '09:00', '10:00', 6);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_jk', (public.map_game_import_job(pg_temp.j('jk'), jsonb_build_object(
    'divisions', jsonb_build_object('fix u9', jsonb_build_object('action', 'map', 'id', pg_temp.u(300))),
    'venues', jsonb_build_object('perm one', jsonb_build_object('action', 'create'), 'perm two', jsonb_build_object('action', 'create'),
        'perm three', jsonb_build_object('action', 'create'), 'perm four', jsonb_build_object('action', 'create'),
        'perm five', jsonb_build_object('action', 'create'), 'perm six', jsonb_build_object('action', 'create')),
    'fields', jsonb_build_object(pg_temp.k2('Perm One', 'Field K1'), jsonb_build_object('action', 'create'), pg_temp.k2('Perm Two', 'Field K2'), jsonb_build_object('action', 'create'),
        pg_temp.k2('Perm Three', 'Field K3'), jsonb_build_object('action', 'create'), pg_temp.k2('Perm Four', 'Field K4'), jsonb_build_object('action', 'create'),
        pg_temp.k2('Perm Five', 'Field K5'), jsonb_build_object('action', 'create'), pg_temp.k2('Perm Six', 'Field K6'), jsonb_build_object('action', 'create')),
    'teams', jsonb_build_object(pg_temp.k2('Fix U9', 'Fix Lions'), jsonb_build_object('action', 'map', 'id', pg_temp.u(301)),
        pg_temp.k2('Fix U9', 'Fix Tigers'), jsonb_build_object('action', 'map', 'id', pg_temp.u(302))))))::text);
INSERT INTO marks VALUES ('apply_jk', (public.apply_game_import_job(pg_temp.j('jk'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jk'), 'created,fields') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jk'), 'created,venues'), '6 6',
    'control: the import made six venues and six fields');
-- What an admin attached afterwards (no signed-in user: the seed).
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.facility_permits (id, organization_id, issuer, valid_from, valid_to) VALUES
    (pg_temp.u(310), 'a1111111-1111-1111-1111-111111111111', 'City Parks', '2026-01-01', '2026-12-31');
INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id)
    SELECT pg_temp.u(310), organization_id, id FROM public.fields WHERE name = 'Field K1';
INSERT INTO public.facility_permit_scopes (permit_id, organization_id, location_id)
    SELECT pg_temp.u(310), organization_id, id FROM public.locations WHERE name = 'Perm Two';
INSERT INTO public.field_blackouts (organization_id, field_id, blackout_from, blackout_until)
    SELECT organization_id, id, '2026-09-19', '2026-09-19' FROM public.fields WHERE name = 'Field K3';
INSERT INTO public.field_subunits (organization_id, field_id, label)
    SELECT organization_id, id, 'Half A' FROM public.fields WHERE name = 'Field K4';
INSERT INTO public.field_blackouts (organization_id, location_id, blackout_from, blackout_until)
    SELECT organization_id, id, '2026-10-03', '2026-10-03' FROM public.locations WHERE name = 'Perm Five';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('rb_jk', (public.rollback_game_import_job(pg_temp.j('jk')))::text);
SELECT is(pg_temp.val($$SELECT string_agg(name, ',' ORDER BY name) FROM public.fields WHERE name LIKE 'Field K%'$$), 'Field K1,Field K3,Field K4',
    'the fields a permit scope, a blackout and a subunit were attached to stay; the three nothing names are gone');
SELECT is(pg_temp.val($$SELECT string_agg(name, ',' ORDER BY name) FROM public.locations WHERE name LIKE 'Perm %'$$), 'Perm Five,Perm Four,Perm One,Perm Three,Perm Two',
    'the venues stay too (a field stands in four; a permit scope and a blackout name the other two); the venue nothing names is gone');
SELECT is(pg_temp.val($$SELECT (SELECT count(*) FROM public.facility_permit_scopes WHERE permit_id = pg_temp.u(310))
                              || ' ' || (SELECT count(*) FROM public.field_blackouts WHERE field_id IN (SELECT id FROM public.fields WHERE name = 'Field K3')
                                                                                      OR location_id IN (SELECT id FROM public.locations WHERE name = 'Perm Five'))
                              || ' ' || (SELECT count(*) FROM public.field_subunits WHERE label = 'Half A')$$), '2 2 1',
    'and what was attached is intact: both permit scopes, both blackouts, the subunit (a cascade would have taken them)');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_jk'), 'fields_deleted') || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_jk'), 'venues_deleted'), '3 1',
    'the rollback says it deleted three fields and one venue');
SELECT is(jsonb_array_length((SELECT v::jsonb -> 'kept' FROM marks WHERE name = 'rb_jk'))::text, '8', 'and names the eight it kept (three fields, five venues), never silently');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE import_job_id = pg_temp.j('jk')$$), '0', 'the six games are gone either way');

-- 12.2 (Codex 1, the class) Every foreign key that cascades or sets null onto what the rollback deletes is guarded by a
-- NOT EXISTS in its DELETE (or by the shared field producer, whose own source names the table) or is on this list. The
-- subject set is the CATALOGUE, never the rollback's own text (lessons 46 and 92).
CREATE FUNCTION pg_temp.rb_pairs() RETURNS text LANGUAGE sql AS $f$
    SELECT string_agg(par.relname || '<-' || ch.relname, ', ' ORDER BY par.relname, ch.relname)
      FROM (SELECT DISTINCT k.confrelid, k.conrelid FROM pg_constraint k
             WHERE k.contype = 'f' AND k.confdeltype IN ('c', 'n')) k
      JOIN pg_class par ON par.oid = k.confrelid AND par.relnamespace = 'public'::regnamespace
      JOIN pg_class ch ON ch.oid = k.conrelid
     WHERE par.relname IN ('teams', 'fields', 'locations', 'divisions', 'game_slots')
$f$;
CREATE FUNCTION pg_temp.rb_unguarded(p_src text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
    r record; v_seg text; v_i int; v_out text[] := '{}';
    -- Allowed without a guard, each for a stated reason:
    --   teams<-team_calendar_tokens   a trigger makes one token for EVERY team row, so every shell has one: derived by design;
    --   teams<-games, game_slots<-games   the legacy `games` table: the F11 plan forbids this import to read, write or
    --                                 reference it, and nothing in the repository writes it (the product only reads it), so
    --                                 no row of it can name a team or a slot this import made.
    v_allowed constant text[] := ARRAY['teams<-team_calendar_tokens', 'teams<-games', 'game_slots<-games'];
    v_bookings text := (SELECT p.prosrc FROM pg_proc p WHERE p.proname = 'field_bookings' AND p.pronamespace = 'public'::regnamespace LIMIT 1);
BEGIN
    FOR r IN SELECT DISTINCT par.relname AS parent, ch.relname AS child
               FROM pg_constraint k JOIN pg_class par ON par.oid = k.confrelid JOIN pg_class ch ON ch.oid = k.conrelid
              WHERE k.contype = 'f' AND par.relnamespace = 'public'::regnamespace
                AND par.relname IN ('teams', 'fields', 'locations', 'divisions', 'game_slots') AND k.confdeltype IN ('c', 'n')
              ORDER BY 1, 2 LOOP
        v_i := position('DELETE FROM public.' || r.parent || ' ' IN p_src);
        IF v_i = 0 THEN v_out := v_out || (r.parent || '<-' || r.child || ' (no DELETE of the parent)'); CONTINUE; END IF;
        v_seg := substr(p_src, v_i);
        v_seg := substr(v_seg, 1, position('GET DIAGNOSTICS' IN v_seg));
        IF v_seg ~ ('NOT EXISTS \(SELECT 1 FROM public\.' || r.child || '\M') THEN CONTINUE; END IF;
        IF v_seg LIKE '%public.field_bookings(%' AND v_bookings ~ ('public\.' || r.child || '\M') THEN CONTINUE; END IF;
        IF (r.parent || '<-' || r.child) = ANY (v_allowed) THEN CONTINUE; END IF;
        v_out := v_out || (r.parent || '<-' || r.child);
    END LOOP;
    RETURN COALESCE(array_to_string(v_out, ', '), '');
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.rb_pairs(), pg_temp.rb_unguarded(text) TO PUBLIC;
SELECT ok(array_length(string_to_array(pg_temp.rb_pairs(), ', '), 1) >= 25,
    'meta: the catalogue gives at least 25 foreign keys that cascade or set null onto the five tables (a census over nothing would pass)');
SELECT is(pg_temp.rb_unguarded((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.rollback_game_import_job(uuid)'::regprocedure)), '',
    'every such foreign key is guarded in the rollback or allowed above with its reason');
CREATE TABLE public.zz_fk_plant (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    field_id uuid REFERENCES public.fields(id) ON DELETE CASCADE, team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL);
SELECT is(pg_temp.rb_unguarded((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.rollback_game_import_job(uuid)'::regprocedure)),
    'fields<-zz_fk_plant, teams<-zz_fk_plant', 'PLANT: a new table with a cascade onto fields and a set null onto teams is reported by the census');
DROP TABLE public.zz_fk_plant;
SELECT is(pg_temp.rb_unguarded(replace((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.rollback_game_import_job(uuid)'::regprocedure),
        'NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes', 'NOT EXISTS (SELECT 1 FROM public.nothing')),
    'fields<-facility_permit_scopes, locations<-facility_permit_scopes', 'PLANT: the permit-scope guard taken out of the rollback is reported (the migration without this round''s fix)');

-- 12.3 (Codex 2) Two labels of the file that resolve to one record the import would create are ONE creation: one team per
-- (division, name), one division per name, one venue per name, one field per (venue, name), one outside club. The dry run
-- says so and the apply writes it; neither used to, and the apply aborted on UNIQUE (division_id, name).
-- (a) two source divisions that map to the SAME existing division, each with a new team of the same name.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'je', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'twice.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('je'), 1, 'ok', 'G-E1', 'Fix U9',     'Park One', 'Field 1', 'Dupe FC', 'Fix Lions',  '2026-11-07', '09:00', '10:00', 40);
SELECT pg_temp.stage(pg_temp.j('je'), 2, 'ok', 'G-E2', 'Fix U9 Alt', 'Park One', 'Field 1', 'Dupe FC', 'Fix Tigers', '2026-11-14', '09:00', '10:00', 41);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_je', (public.map_game_import_job(pg_temp.j('je'), jsonb_build_object(
    'divisions', jsonb_build_object('fix u9', jsonb_build_object('action', 'map', 'id', pg_temp.u(300)), 'fix u9 alt', jsonb_build_object('action', 'map', 'id', pg_temp.u(300))),
    'venues', jsonb_build_object('park one', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
    'fields', jsonb_build_object(pg_temp.k2('Park One', 'Field 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31))),
    'teams', jsonb_build_object(pg_temp.k2('Fix U9', 'Dupe FC'), jsonb_build_object('action', 'create'), pg_temp.k2('Fix U9 Alt', 'Dupe FC'), jsonb_build_object('action', 'create'),
        pg_temp.k2('Fix U9', 'Fix Lions'), jsonb_build_object('action', 'map', 'id', pg_temp.u(301)),
        pg_temp.k2('Fix U9 Alt', 'Fix Tigers'), jsonb_build_object('action', 'map', 'id', pg_temp.u(302))))))::text);
INSERT INTO marks VALUES ('dry_je', (public.apply_game_import_job(pg_temp.j('je'), true))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'dry_je'), 'created,teams'), '1', 'the dry run counts ONE new team for the two labels (not two)');
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('je'), false)$$), 'no error', 'and the apply is not refused by UNIQUE (division_id, name): it writes what the dry run said');
INSERT INTO marks VALUES ('apply_je', (public.apply_game_import_job(pg_temp.j('je'), false))::text);
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE division_id = pg_temp.u(300) AND name = 'Dupe FC'$$), '1', 'exactly one team named Dupe FC stands in the division');
SELECT is(pg_temp.val($$SELECT count(DISTINCT home_team_id) FROM public.game_assignments WHERE import_job_id = pg_temp.j('je')$$) || ' ' || pg_temp.val($$SELECT count(*) FROM public.game_assignments WHERE import_job_id = pg_temp.j('je')$$), '1 2',
    'and both games name it');
SELECT is(pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'apply_je')), pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'dry_je')), 'the apply''s result is the dry run''s in every count, list and warning');
-- 12.5 (Code review 2) A shell that a later team run names is kept (the rollback's check of the other runs), with its run. This
-- rolls job je back at once: a rollback after a later job has carried its games into a newer run is refused, as it should be.
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, results, completed_at) VALUES
    (pg_temp.u(320), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'a1111111-1111-1111-1111-111111111aaa', 'team', 'completed',
     '{}'::jsonb, jsonb_build_object('teams', jsonb_build_array(jsonb_build_object('id', (SELECT id FROM public.teams WHERE name = 'Dupe FC' AND division_id = pg_temp.u(300)), 'name', 'Dupe FC'))), '2026-12-30T00:00:00Z');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('rb_je', (public.rollback_game_import_job(pg_temp.j('je')))::text);
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE division_id = pg_temp.u(300) AND name = 'Dupe FC'$$), '1', 'a shell a later team run names is kept by the rollback');
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'rb_je'), 'teams_deleted'), '0', 'and the result says no team was deleted');
SELECT is(pg_temp.val($$SELECT count(*) FROM jsonb_array_elements((SELECT v::jsonb -> 'kept' FROM marks WHERE name = 'rb_je')) e WHERE e ->> 'table' = 'teams'$$), '1', 'and names it in kept');

-- (b) the same for a new division, venue and field named by two labels (the same name), and for a new team and an outside club
-- named by two labels with names that differ only in case (the key is the lower-cased, trimmed name, as core's is).
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jf', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'zeta.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('jf'), 1, 'ok', 'G-F1', 'Zeta A', 'Venue X', 'Field 1', 'Alpha',     'Club A',     '2026-11-21', '09:00', '10:00', 42);
SELECT pg_temp.stage(pg_temp.j('jf'), 2, 'ok', 'G-F2', 'Zeta B', 'Venue Y', 'Field 9', 'Alpha Two', 'Club A Alt', '2026-11-28', '09:00', '10:00', 43);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_jf', (public.map_game_import_job(pg_temp.j('jf'), jsonb_build_object(
    'divisions', jsonb_build_object('zeta a', jsonb_build_object('action', 'create', 'name', 'Zeta U9'), 'zeta b', jsonb_build_object('action', 'create', 'name', 'Zeta U9')),
    'venues', jsonb_build_object('venue x', jsonb_build_object('action', 'create', 'name', 'Park Zeta'), 'venue y', jsonb_build_object('action', 'create', 'name', 'Park Zeta')),
    'fields', jsonb_build_object(pg_temp.k2('Venue X', 'Field 1'), jsonb_build_object('action', 'create', 'name', 'Field Z'), pg_temp.k2('Venue Y', 'Field 9'), jsonb_build_object('action', 'create', 'name', 'Field Z')),
    'teams', jsonb_build_object(pg_temp.k2('Zeta A', 'Alpha'), jsonb_build_object('action', 'create', 'name', 'Alpha FC'), pg_temp.k2('Zeta B', 'Alpha Two'), jsonb_build_object('action', 'create', 'name', 'alpha fc'),
        pg_temp.k2('Zeta A', 'Club A'), jsonb_build_object('action', 'outside', 'name', 'Gulls'), pg_temp.k2('Zeta B', 'Club A Alt'), jsonb_build_object('action', 'outside', 'name', 'gulls')))))::text);
INSERT INTO marks VALUES ('dry_jf', (public.apply_game_import_job(pg_temp.j('jf'), true))::text);
SELECT is((SELECT v::jsonb -> 'created' FROM marks WHERE name = 'dry_jf'), '{"divisions": 1, "venues": 1, "fields": 1, "teams": 1, "outside_teams": 1, "slots": 2}'::jsonb,
    'the dry run counts one division, one venue, one field, one team, one outside club (and two slots)');
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('jf'), false)$$), 'no error', 'and the apply writes them without a unique violation');
INSERT INTO marks VALUES ('apply_jf', (public.apply_game_import_job(pg_temp.j('jf'), false))::text);
SELECT is(pg_temp.val($$SELECT (SELECT count(*) FROM public.divisions WHERE lower(name) = 'zeta u9') || ' ' || (SELECT count(*) FROM public.locations WHERE lower(name) = 'park zeta')
        || ' ' || (SELECT count(*) FROM public.fields WHERE lower(name) = 'field z') || ' ' || (SELECT count(*) FROM public.teams WHERE lower(name) = 'alpha fc' AND NOT is_external)
        || ' ' || (SELECT count(*) FROM public.teams WHERE lower(name) = 'gulls' AND is_external)$$), '1 1 1 1 1', 'one of each stands in the database');
SELECT is(pg_temp.val($$SELECT string_agg(DISTINCT t.name, ',') FROM public.game_assignments ga JOIN public.teams t ON t.id IN (ga.home_team_id, ga.away_team_id) WHERE ga.import_job_id = pg_temp.j('jf')$$), 'Alpha FC,Gulls',
    'both games are between the same two sides, named by the first label of each (the key order decides which spelling)');
SELECT is(pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'apply_jf')), pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'dry_jf')), 'and the apply is the dry run again');
-- (c) a team created and a club marked outside under one name in one division are two sides for one name: the outside club
-- is refused as the own team it would collide with (the same refusal as a club named like an own team).
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jg', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'pelican.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('jg'), 1, 'ok', 'G-G1', 'Fix U9', 'Park One', 'Field 1', 'Gull Shell',   'Fix Lions',  '2026-12-12', '09:00', '10:00', 44);
SELECT pg_temp.stage(pg_temp.j('jg'), 2, 'ok', 'G-G2', 'Fix U9', 'Park One', 'Field 1', 'Pelican Club', 'Fix Tigers', '2026-12-19', '09:00', '10:00', 45);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_jg', (public.map_game_import_job(pg_temp.j('jg'), jsonb_build_object(
    'divisions', jsonb_build_object('fix u9', jsonb_build_object('action', 'map', 'id', pg_temp.u(300))),
    'venues', jsonb_build_object('park one', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
    'fields', jsonb_build_object(pg_temp.k2('Park One', 'Field 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31))),
    'teams', jsonb_build_object(pg_temp.k2('Fix U9', 'Gull Shell'), jsonb_build_object('action', 'create', 'name', 'Pelicans'),
        pg_temp.k2('Fix U9', 'Pelican Club'), jsonb_build_object('action', 'outside', 'name', 'Pelicans'),
        pg_temp.k2('Fix U9', 'Fix Lions'), jsonb_build_object('action', 'map', 'id', pg_temp.u(301)),
        pg_temp.k2('Fix U9', 'Fix Tigers'), jsonb_build_object('action', 'map', 'id', pg_temp.u(302))))))::text);
INSERT INTO marks VALUES ('dry_jg', (public.apply_game_import_job(pg_temp.j('jg'), true))::text);
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('jg'), false)$$), 'no error', 'the apply is not aborted by the two creations of one name');
INSERT INTO marks VALUES ('apply_jg', (public.apply_game_import_job(pg_temp.j('jg'), false))::text);
SELECT is((SELECT v::jsonb -> 'refused_by_reason' FROM marks WHERE name = 'apply_jg'), '{"label-is-own-team": 1}'::jsonb, 'the club row is refused, listed under that reason');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.teams WHERE division_id = pg_temp.u(300) AND name = 'Pelicans'$$) || ' ' || pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jg'), 'games,inserted'), '1 1',
    'one Pelicans team (the own shell) and one game written');
SELECT is(pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'apply_jg')), pg_temp.same((SELECT v::jsonb FROM marks WHERE name = 'dry_jg')), 'and the dry run said the same');

-- 12.4 (Code review 1) A row with a time and no field is a TIME TBD game, and core stages it with no instants: the apply
-- takes it. A row that says tbd and still carries instants is not one core stages, and the SQL stays strict about it.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'jh', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'tbd.csv')).id;
INSERT INTO jobs SELECT 'ji', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'tbd-bad.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('jh'), 1, 'tbd', 'G-H1', 'Fix U9', '', '', 'Fix Lions', 'Fix Tigers', '2027-01-09', NULL, NULL, 46);
SELECT pg_temp.stage(pg_temp.j('ji'), 1, 'tbd', 'G-I1', 'Fix U9', '', '', 'Fix Lions', 'Fix Tigers', '2027-01-16', '09:00', '10:00', 47);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_jh', (public.map_game_import_job(pg_temp.j('jh'), jsonb_build_object(
    'divisions', jsonb_build_object('fix u9', jsonb_build_object('action', 'map', 'id', pg_temp.u(300))),
    'teams', jsonb_build_object(pg_temp.k2('Fix U9', 'Fix Lions'), jsonb_build_object('action', 'map', 'id', pg_temp.u(301)),
        pg_temp.k2('Fix U9', 'Fix Tigers'), jsonb_build_object('action', 'map', 'id', pg_temp.u(302))))))::text);
INSERT INTO marks VALUES ('map_ji', (public.map_game_import_job(pg_temp.j('ji'), (SELECT v::jsonb FROM (SELECT warning_summary -> 'game_mapping' AS v FROM public.import_jobs WHERE id = pg_temp.j('jh')) q)))::text);
INSERT INTO marks VALUES ('apply_jh', (public.apply_game_import_job(pg_temp.j('jh'), false))::text);
SELECT is(pg_temp.num((SELECT v::jsonb FROM marks WHERE name = 'apply_jh'), 'time_tbd,inserted'), '1', 'a staged tbd row with no instants becomes one TIME TBD game');
SELECT is(pg_temp.val($$SELECT reason || ' w' || week_index FROM public.schedule_tbd WHERE kind = 'game' AND home_team_id = pg_temp.u(301) AND week_index = 46$$), 'imported-without-time w46',
    'with the import''s reason and its week');
SELECT is(pg_temp.errx($$SELECT public.apply_game_import_job(pg_temp.j('ji'), false)$$), '22023:game_import_staged_invalid',
    'a tbd row that still carries instants is refused whole as not a games row (the SQL stays strict)');

-- 12.6 (Code review 4) The limitation, pinned: two games of one pair in one week that the file swaps by Game ID are both
-- refused, because the place each moves to still holds the other until the import has run. The words say so.
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
    (pg_temp.u(330), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2027-02-06T09:00:00-08:00', '2027-02-06T10:00:00-08:00', '2027-02-06', '09:00', '10:00', 50, 1),
    (pg_temp.u(331), 'a1111111-1111-1111-1111-111111111111', pg_temp.u(31), '2027-02-06T10:00:00-08:00', '2027-02-06T11:00:00-08:00', '2027-02-06', '10:00', '11:00', 50, 1);
INSERT INTO public.game_assignments (id, organization_id, season_settings_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id, division, week_index, start, "end", assignment_source, external_ref) VALUES
    (pg_temp.u(332), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(330), pg_temp.u(330), pg_temp.u(31), pg_temp.u(301), pg_temp.u(302), 'Fix U9', 50, '2027-02-06T09:00:00-08:00', '2027-02-06T10:00:00-08:00', 'auto', 'SW-1'),
    (pg_temp.u(333), 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', pg_temp.u(331), pg_temp.u(331), pg_temp.u(31), pg_temp.u(301), pg_temp.u(302), 'Fix U9', 50, '2027-02-06T10:00:00-08:00', '2027-02-06T11:00:00-08:00', 'auto', 'SW-2');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO jobs SELECT 'js', (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'games', 'swap.csv')).id;
SET LOCAL "request.jwt.claims" TO '{}';
SELECT pg_temp.stage(pg_temp.j('js'), 1, 'ok', 'SW-1', 'Fix U9', 'Park One', 'Field 1', 'Fix Lions', 'Fix Tigers', '2027-02-06', '10:00', '11:00', 50);
SELECT pg_temp.stage(pg_temp.j('js'), 2, 'ok', 'SW-2', 'Fix U9', 'Park One', 'Field 1', 'Fix Lions', 'Fix Tigers', '2027-02-06', '09:00', '10:00', 50);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO marks VALUES ('map_js', (public.map_game_import_job(pg_temp.j('js'), jsonb_build_object(
    'divisions', jsonb_build_object('fix u9', jsonb_build_object('action', 'map', 'id', pg_temp.u(300))),
    'venues', jsonb_build_object('park one', jsonb_build_object('action', 'map', 'id', pg_temp.u(30))),
    'fields', jsonb_build_object(pg_temp.k2('Park One', 'Field 1'), jsonb_build_object('action', 'map', 'id', pg_temp.u(31))),
    'teams', jsonb_build_object(pg_temp.k2('Fix U9', 'Fix Lions'), jsonb_build_object('action', 'map', 'id', pg_temp.u(301)),
        pg_temp.k2('Fix U9', 'Fix Tigers'), jsonb_build_object('action', 'map', 'id', pg_temp.u(302))))))::text);
INSERT INTO marks VALUES ('apply_js', (public.apply_game_import_job(pg_temp.j('js'), false))::text);
SELECT is((SELECT v::jsonb -> 'refused_by_reason' FROM marks WHERE name = 'apply_js'), '{"duplicate-row": 2}'::jsonb, 'the swap of two games of one pair in one week by Game ID is refused (known limitation): both rows');
SELECT is(pg_temp.gj(pg_temp.u(332)) || ' | ' || pg_temp.gj(pg_temp.u(333)), '2d>2e@1f/2027-02-06/09:00 w50 pub=false ref=SW-1 | 2d>2e@1f/2027-02-06/10:00 w50 pub=false ref=SW-2',
    'and neither game moved');
SELECT is(((SELECT v::jsonb #>> '{listed,refused,0,message}' FROM marks WHERE name = 'apply_js')) ~ 'moves away', 'true',
    'the words name the case: a game the file moves away from a place still holds it until the import has run');

-- 12.7 (Code review 6) The mapping is the sole input of the apply, and storing it is audited: import.mapped, with the
-- number of decisions per group and action and the Published default. No label is written to the audit row.
SELECT is(pg_temp.val($$SELECT count(*) FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = pg_temp.j('je')$$), '1', 'storing a mapping writes one import.mapped audit row');
SELECT is(pg_temp.val($$SELECT (metadata #>> '{decisions,teams,create}') || ' ' || (metadata #>> '{decisions,teams,map}') || ' ' || (metadata #>> '{decisions,divisions,map}') || ' ' || (metadata ->> 'arrive_published')
        FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = pg_temp.j('je')$$), '2 2 2 true', 'carrying the counts per group and action and the Published default');
SELECT is(pg_temp.val($$SELECT (metadata::text ~* 'Dupe FC|Fix U9')::text FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = pg_temp.j('je')$$), 'false', 'and no label of the file');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.errx($$SELECT public.map_game_import_job(pg_temp.j('je'), '{}'::jsonb)$$), '42501:', 'a caller with no signed-in user cannot store a mapping, so there is never an audit row without an actor');

SELECT * FROM finish();
ROLLBACK;
