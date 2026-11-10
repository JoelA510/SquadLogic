-- Smoke checks for 20261121010000_game_import.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK. Synthetic organization, users, teams
-- and games; no real data.
--
--   1. Shape: the three columns, the per-season Game ID index and the shape check, the games type in the five lists,
--      the five new functions (posture and grants), the guard's rollback exemption, the view and the practice sync
--      that leave an outside club out, and the SQL copy of the allowlist.
--   2. A seven-row file through every outcome: a dry run writes nothing and is the apply's counts; the apply updates a
--      game found by its Game ID in place by its id (hidden rows included), skips a Published game whose row changed,
--      inserts a new game against an outside club, records a row with no time as a TIME TBD game, lists a refused row,
--      and makes ONE new run that holds the whole schedule.
--   3. The same file again inserts nothing and makes no run.
--   4. The rollback refuses after a change (naming the game) and, before one, restores the schedule exactly.
--   5. Fix round 1: storing a mapping is audited (`import.mapped`, with the counts); and two source divisions that map to
--      one division, each with a new team of one name, are ONE team (the apply used to abort on the unique key).
--   6. Fix round 2: the team run the apply writes is in the shape the pages read (`teamsByDivision`, `teams`,
--      `team_players`); a name that differs from one that exists only by a run of spaces is the same name; a TIME TBD game
--      holds its DATE, is found by its Game ID and changed in place; a placed game the file now gives no time is
--      converted with a warning; two games that swap places are both written, with a warning, and the rollback puts every
--      game back.
--
-- The pgTAP file (supabase/tests/game_import_apply_rollback.sql) holds the full table; this is the part the migration
-- harness can run without pgTAP, and the part its plants are shown to turn red (scripts/dbharness/prove.sh).

\set ON_ERROR_STOP on

BEGIN;

-- stage: one staged row of a games job ('ok' has a time and a field; 'tbd' has neither).
CREATE FUNCTION pg_temp.stage(p_org uuid, p_job uuid, p_row int, p_status text, p_game_id text, p_division text, p_venue text, p_field text,
                              p_home text, p_away text, p_date text, p_start text, p_end text, p_week int)
RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (p_org, p_job, 'games', p_row, '{}'::jsonb,
            jsonb_build_object(
                'row_key', 'row-' || p_row, 'game_id', p_game_id, 'status', p_status,
                'tbd_reason', CASE WHEN p_status = 'tbd' THEN 'imported-without-time' END,
                'date', p_date, 'start_time', p_start, 'end_time', p_end,
                'start', CASE WHEN p_start IS NULL THEN NULL ELSE p_date || 'T' || p_start || ':00-07:00' END,
                'end', CASE WHEN p_end IS NULL THEN NULL ELSE p_date || 'T' || p_end || ':00-07:00' END,
                'week_index', p_week, 'flags', '[]'::jsonb,
                'division', p_division, 'division_key', lower(btrim(p_division)),
                'venue', p_venue, 'venue_key', lower(btrim(p_venue)),
                'field', p_field, 'field_key', '[' || to_json(lower(btrim(p_venue)))::text || ',' || to_json(lower(btrim(p_field)))::text || ']',
                'home_team', p_home, 'home_key', '[' || to_json(lower(btrim(p_division)))::text || ',' || to_json(lower(btrim(p_home)))::text || ']',
                'away_team', p_away, 'away_key', '[' || to_json(lower(btrim(p_division)))::text || ',' || to_json(lower(btrim(p_away)))::text || ']'),
            '[]'::jsonb)
$f$;
-- fp: a fingerprint of every table of the public schema (a dry run must write nothing, anywhere).
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
-- fps: the schedule's own tables without the clock (a rollback restores content, not the instant a row was touched).
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

DO $$
DECLARE
    v_org     uuid := gen_random_uuid();
    v_admin   uuid := gen_random_uuid();
    v_season  uuid := gen_random_uuid();
    v_div     uuid := gen_random_uuid();
    v_a       uuid := gen_random_uuid();
    v_b       uuid := gen_random_uuid();
    v_c       uuid := gen_random_uuid();
    v_loc     uuid := gen_random_uuid();
    v_f1      uuid := gen_random_uuid();
    v_s1      uuid := gen_random_uuid();   -- 2026-05-02 09:00, week 1
    v_s2      uuid := gen_random_uuid();   -- 2026-05-02 10:00, week 1
    v_s3      uuid := gen_random_uuid();   -- 2026-05-09 09:00, week 2
    v_run1    uuid := gen_random_uuid();   -- the saved run the page shows
    v_run0    uuid := gen_random_uuid();   -- an older run: where the hidden game sits
    v_g1      uuid := gen_random_uuid();   -- S-1 A>B s1, Published, in run1
    v_g2      uuid := gen_random_uuid();   -- S-2 A>C s2, in run1
    v_g3      uuid := gen_random_uuid();   -- S-3 B>C s3, HIDDEN in run0
    v_job     uuid;
    v_job2    uuid;
    v_job3    uuid;
    v_job4    uuid;
    v_job5    uuid;
    v_fps4    text;
    v_mapping jsonb;
    v_dry     jsonb;
    v_apply   jsonb;
    v_again   jsonb;
    v_n       integer;
    v_fp      text;
    v_fps     text;
    v_detail  text;
    v_runs0   integer;
    v_games0  integer;
    v_club    uuid;
    v_checks  integer := 0;
    v_bad     text;
BEGIN
    -- ---- 1. shape ------------------------------------------------------------------------------------
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.teams'::regclass AND a.attname = 'is_external'
                    AND a.attnotnull AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = 'boolean') THEN
        RAISE EXCEPTION 'teams.is_external is not a boolean NOT NULL';
    END IF;
    IF (SELECT array_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attname) FROM pg_attribute a
         WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname IN ('external_ref', 'import_job_id') AND NOT a.attisdropped AND NOT a.attnotnull)
       IS DISTINCT FROM ARRAY['external_ref text', 'import_job_id uuid'] THEN
        RAISE EXCEPTION 'game_assignments does not hold external_ref (text) and import_job_id (uuid), both nullable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.game_assignments'::regclass AND i.indisunique AND i.indpred IS NOT NULL
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ARRAY['season_settings_id', 'external_ref']) THEN
        RAISE EXCEPTION 'the Game ID is not unique on (season_settings_id, external_ref) for the rows that have one';
    END IF;
    SELECT string_agg(c.conname, ', ') INTO v_bad FROM (VALUES
        ('import_jobs_job_type_check'), ('staging_import_rows_import_type_check'), ('import_application_records_import_type_check'),
        ('import_application_records_target_table_check'), ('schedule_tbd_reason_check'), ('game_assignments_external_ref_shape')) AS c(conname)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = c.conname AND k.convalidated
                        AND (c.conname = 'game_assignments_external_ref_shape' OR pg_get_constraintdef(k.oid) ~ $re$'(games|game_assignments|imported-without-time)'$re$));
    IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'a list does not take the games import: %', v_bad; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('apply_game_import_job', 'rollback_game_import_job', 'map_game_import_job', 'ensure_game_slot')
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
    IF v_n <> 4 THEN RAISE EXCEPTION '% of the 4 client RPCs are definer functions with a pinned search path, open to authenticated and closed to anon and PUBLIC', v_n; END IF;
    IF has_function_privilege('authenticated', 'public.game_import_image(jsonb)'::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'game_import_image is internal and a client role may call it';
    END IF;
    IF has_function_privilege('authenticated', 'public.game_import_row_unchanged(jsonb,jsonb)'::regprocedure, 'EXECUTE')
       OR public.game_import_row_unchanged('{"a": 1, "updated_at": "x"}'::jsonb, '{"a": 1, "updated_at": "y"}'::jsonb) IS NOT TRUE
       OR public.game_import_row_unchanged('{"a": 2}'::jsonb, '{"a": 1}'::jsonb) IS NOT FALSE
       OR public.game_import_row_unchanged('{"a": 1}'::jsonb, '{}'::jsonb) IS NOT FALSE THEN
        RAISE EXCEPTION 'game_import_row_unchanged is open to a client role, or does not compare the stored image (an empty image must match nothing)';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.game_assignments_published_guard()'::regprocedure) !~ 'squadlogic\.import_rollback'
       OR pg_get_viewdef('public.view_org_metrics'::regclass) !~ 'is_external'
       OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb)'::regprocedure) !~ 'NOT t\.is_external' THEN
        RAISE EXCEPTION 'the guard, the metrics view or the practice sync does not carry its change';
    END IF;
    IF cardinality(public.import_allowed_keys('games')) <> 21 THEN RAISE EXCEPTION 'import_allowed_keys(games) is not the 21 keys the apply reads'; END IF;
    IF (SELECT array_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attname) FROM pg_attribute a
         WHERE a.attrelid = 'public.schedule_tbd'::regclass AND a.attname IN ('external_ref', 'game_date') AND NOT a.attisdropped AND NOT a.attnotnull)
       IS DISTINCT FROM ARRAY['external_ref text', 'game_date date'] THEN
        RAISE EXCEPTION 'schedule_tbd does not hold external_ref (text) and game_date (date), both nullable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.schedule_tbd'::regclass AND i.indisunique AND i.indpred IS NOT NULL
                    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = ARRAY['season_settings_id', 'external_ref']) THEN
        RAISE EXCEPTION 'a TIME TBD game''s Game ID is not unique on (season_settings_id, external_ref) for the rows that have one';
    END IF;
    IF has_function_privilege('authenticated', 'public.normalise_external_label(text)'::regprocedure, 'EXECUTE')
       OR public.normalise_external_label('  Blue ' || chr(160) || E'\t' || 'Jays ') IS DISTINCT FROM 'blue jays' THEN
        RAISE EXCEPTION 'normalise_external_label is open to a client role, or is not core''s trim, collapse and lower-case';
    END IF;
    v_checks := v_checks + 12;
    RAISE NOTICE 'shape: is_external, external_ref and import_job_id, the per-season Game ID index, six lists that take games, 4 client RPCs pinned and closed to anon and PUBLIC, the guard exemption, the view and the sync';

    -- ---- seed (no signed-in user) --------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'import-smoke-admin@example.test', '{"password_length": 12, "full_name": "Import Admin"}');
    INSERT INTO public.profiles (id, email, full_name) VALUES (v_admin, 'import-smoke-admin@example.test', 'Import Admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Import Smoke Org', 'import-smoke-' || replace(v_org::text, '-', ''));
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin')
    ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'admin';
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES (v_season, v_org, 'Import Season', 'active', 2026);
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_div, v_org, v_season, 'Smoke U10');
    INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
        (v_a, v_org, v_div, 'Alpha'), (v_b, v_org, v_div, 'Bravo'), (v_c, v_org, v_div, 'Charlie');
    INSERT INTO public.locations (id, organization_id, name) VALUES (v_loc, v_org, 'Smoke Park');
    INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (v_f1, v_org, v_loc, 'Smoke Field');
    INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
        (v_s1, v_org, v_f1, '2026-05-02T09:00:00-07:00', '2026-05-02T10:00:00-07:00', '2026-05-02', '09:00', '10:00', 1, 1),
        (v_s2, v_org, v_f1, '2026-05-02T10:00:00-07:00', '2026-05-02T11:00:00-07:00', '2026-05-02', '10:00', '11:00', 1, 1),
        (v_s3, v_org, v_f1, '2026-05-09T09:00:00-07:00', '2026-05-09T10:00:00-07:00', '2026-05-09', '09:00', '10:00', 2, 1);
    INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, completed_at) VALUES
        (v_run0, v_org, v_season, v_season, 'game', 'completed', '2026-04-01T00:00:00Z'),
        (v_run1, v_org, v_season, v_season, 'game', 'completed', '2026-04-02T00:00:00Z');
    INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id, away_team_id,
                                         division, week_index, start, "end", assignment_source, external_ref) VALUES
        (v_g1, v_org, v_season, v_run1, v_s1, v_s1, v_f1, v_a, v_b, 'Smoke U10', 1, '2026-05-02T09:00:00-07:00', '2026-05-02T10:00:00-07:00', 'auto', 'S-1'),
        (v_g2, v_org, v_season, v_run1, v_s2, v_s2, v_f1, v_a, v_c, 'Smoke U10', 1, '2026-05-02T10:00:00-07:00', '2026-05-02T11:00:00-07:00', 'auto', 'S-2'),
        (v_g3, v_org, v_season, v_run0, v_s3, v_s3, v_f1, v_b, v_c, 'Smoke U10', 2, '2026-05-09T09:00:00-07:00', '2026-05-09T10:00:00-07:00', 'auto', 'S-3');
    UPDATE public.game_assignments SET published = true WHERE id = v_g1;
    SELECT count(*) INTO v_runs0 FROM public.scheduler_runs WHERE organization_id = v_org;
    SELECT count(*) INTO v_games0 FROM public.game_assignments WHERE organization_id = v_org;
    v_fps := pg_temp.fps();

    -- ---- 2. the first file: a dry run, then the apply --------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_job := (public.create_import_job(v_org, 'games', 'schedule.csv')).id;
    IF (SELECT job_type || ' ' || status FROM public.import_jobs WHERE id = v_job) <> 'games importing' THEN
        RAISE EXCEPTION 'create_import_job did not make a games job that is importing';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    -- S-1 moved (a Published game: skipped), S-2 moved to a new place (updated in place), S-3 as it is (a hidden row: unchanged),
    -- S-4 new, against an outside club, S-5 with no time (TIME TBD), and a refused row.
    PERFORM pg_temp.stage(v_org, v_job, 1, 'ok',  'S-1', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Bravo',          '2026-05-02', '11:00', '12:00', 1);
    PERFORM pg_temp.stage(v_org, v_job, 2, 'ok',  'S-2', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Charlie',        '2026-05-09', '10:00', '11:00', 2);
    PERFORM pg_temp.stage(v_org, v_job, 3, 'ok',  'S-3', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Bravo',   'Charlie',        '2026-05-09', '09:00', '10:00', 2);
    PERFORM pg_temp.stage(v_org, v_job, 4, 'ok',  'S-4', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Charlie', 'Visiting Club',  '2026-05-16', '09:00', '10:00', 3);
    PERFORM pg_temp.stage(v_org, v_job, 5, 'tbd', 'S-5', 'Smoke U10', '',           '',            'Bravo',   'Alpha',          '2026-05-16', NULL,    NULL,    3);
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (v_org, v_job, 'games', 6, '{}'::jsonb, NULL, jsonb_build_array(jsonb_build_object('code', 'bad-date', 'message', 'planted')));
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_mapping := jsonb_build_object(
        'options', jsonb_build_object('arrive_published', true),
        'divisions', jsonb_build_object('smoke u10', jsonb_build_object('action', 'map', 'id', v_div)),
        'venues', jsonb_build_object('smoke park', jsonb_build_object('action', 'map', 'id', v_loc)),
        'fields', jsonb_build_object('["smoke park","smoke field"]', jsonb_build_object('action', 'map', 'id', v_f1)),
        'teams', jsonb_build_object(
            '["smoke u10","alpha"]', jsonb_build_object('action', 'map', 'id', v_a),
            '["smoke u10","bravo"]', jsonb_build_object('action', 'map', 'id', v_b),
            '["smoke u10","charlie"]', jsonb_build_object('action', 'map', 'id', v_c),
            '["smoke u10","visiting club"]', jsonb_build_object('action', 'outside')));
    PERFORM public.map_game_import_job(v_job, v_mapping);
    IF (SELECT count(*) FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = v_job) <> 1
       OR (SELECT metadata #>> '{decisions,teams,outside}' FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = v_job) IS DISTINCT FROM '1'
       OR (SELECT metadata::text ~ 'Visiting Club' FROM public.audit_log WHERE action = 'import.mapped' AND resource_id = v_job) THEN
        RAISE EXCEPTION 'storing a mapping did not write one import.mapped audit row carrying the counts and no label';
    END IF;
    v_checks := v_checks + 1;

    v_fp := pg_temp.fp();
    v_dry := public.apply_game_import_job(v_job, true);
    IF pg_temp.fp() IS DISTINCT FROM v_fp THEN RAISE EXCEPTION 'a dry run wrote something (a table of the public schema changed)'; END IF;
    IF (v_dry ->> 'dry_run') <> 'true' OR (v_dry #>> '{ids,run_id}') IS NOT NULL THEN RAISE EXCEPTION 'a dry run says it was not one, or made a run'; END IF;
    v_apply := public.apply_game_import_job(v_job, false);
    IF (v_apply #>> '{rows,staged}') <> '6' OR (v_apply #>> '{rows,refused}') <> '1'
       OR (v_apply #>> '{games,inserted}') <> '1' OR (v_apply #>> '{games,updated}') <> '1' OR (v_apply #>> '{games,unchanged}') <> '1'
       OR (v_apply #>> '{games,skipped,skipped-published}') <> '1' OR (v_apply #>> '{games,repointed}') <> '2'
       OR (v_apply #>> '{time_tbd,inserted}') <> '1' OR (v_apply #>> '{created,outside_teams}') <> '1' OR (v_apply ->> 'nothing_to_apply') <> 'false' THEN
        RAISE EXCEPTION 'the apply did not do what the file says: %', v_apply;
    END IF;
    IF (v_dry - 'dry_run' - 'ids') IS DISTINCT FROM (v_apply - 'dry_run' - 'ids') THEN
        RAISE EXCEPTION 'the preview was not the apply: % against %', v_dry - 'dry_run' - 'ids', v_apply - 'dry_run' - 'ids';
    END IF;
    v_checks := v_checks + 4;
    RAISE NOTICE 'apply: a dry run wrote nothing and is the apply''s result; 1 inserted, 1 updated in place, 1 unchanged (hidden), 1 skipped-published, 2 repointed, 1 TIME TBD, 1 refused row, 1 outside club';

    -- In place, by id: the game found by its Game ID is the same row, in the new run; the Published game is untouched; no second row.
    IF (SELECT count(*) FROM public.game_assignments WHERE external_ref = 'S-2') <> 1
       OR NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_g2 AND week_index = 2 AND start = '2026-05-09T10:00:00-07:00'::timestamptz
                         AND run_id = (v_apply #>> '{ids,run_id}')::uuid AND import_job_id = v_job AND season_settings_id = v_season) THEN
        RAISE EXCEPTION 'the game found by its Game ID was not updated in place by its id';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_g1 AND start = '2026-05-02T09:00:00-07:00'::timestamptz AND published) THEN
        RAISE EXCEPTION 'a Published game whose row changed was moved';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_g3 AND run_id = (v_apply #>> '{ids,run_id}')::uuid) THEN
        RAISE EXCEPTION 'the hidden game the file found was not carried into the new run';
    END IF;
    IF (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org) <> v_games0 + 1
       OR (SELECT count(*) FROM public.game_assignments WHERE run_id = (v_apply #>> '{ids,run_id}')::uuid) <> 4
       OR (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = v_org) <> v_runs0 + 1 THEN
        RAISE EXCEPTION 'the import did not make one run holding the whole schedule (4 games) and add one game';
    END IF;
    SELECT id INTO v_club FROM public.teams WHERE organization_id = v_org AND is_external;
    IF v_club IS NULL OR (SELECT count(*) FROM public.teams WHERE is_external) <> 1
       OR EXISTS (SELECT 1 FROM public.scheduler_runs r WHERE r.organization_id = v_org AND r.results::text LIKE '%' || v_club::text || '%') THEN
        RAISE EXCEPTION 'the outside club is not exactly one team row in no run';
    END IF;
    IF (SELECT total_teams FROM public.view_org_metrics WHERE organization_id = v_org AND season_settings_id = v_season) <> 3 THEN
        RAISE EXCEPTION 'the metrics count the outside club as one of the organization''s teams';
    END IF;
    IF (SELECT count(*) FROM public.schedule_tbd WHERE organization_id = v_org AND kind = 'game' AND reason = 'imported-without-time') <> 1 THEN
        RAISE EXCEPTION 'the row with no time is not one TIME TBD game';
    END IF;
    v_checks := v_checks + 6;
    RAISE NOTICE 'in place: S-2 kept its id and moved into the new run, the Published S-1 did not move, the hidden S-3 came into the run, one run holds 4 games, the outside club is one team row in no run and outside the metrics';

    -- ---- 3. the same file again ------------------------------------------------------------------------
    v_job2 := (public.create_import_job(v_org, 'games', 'schedule-again.csv')).id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM pg_temp.stage(v_org, v_job2, 1, 'ok',  'S-1', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Bravo',          '2026-05-02', '11:00', '12:00', 1);
    PERFORM pg_temp.stage(v_org, v_job2, 2, 'ok',  'S-2', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Charlie',        '2026-05-09', '10:00', '11:00', 2);
    PERFORM pg_temp.stage(v_org, v_job2, 3, 'ok',  'S-3', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Bravo',   'Charlie',        '2026-05-09', '09:00', '10:00', 2);
    PERFORM pg_temp.stage(v_org, v_job2, 4, 'ok',  'S-4', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Charlie', 'Visiting Club',  '2026-05-16', '09:00', '10:00', 3);
    PERFORM pg_temp.stage(v_org, v_job2, 5, 'tbd', 'S-5', 'Smoke U10', '',           '',            'Bravo',   'Alpha',          '2026-05-16', NULL,    NULL,    3);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.map_game_import_job(v_job2, jsonb_set(v_mapping, ARRAY['teams', '["smoke u10","visiting club"]'], jsonb_build_object('action', 'map', 'id', v_club)));
    SELECT count(*) INTO v_n FROM public.scheduler_runs WHERE organization_id = v_org;
    v_again := public.apply_game_import_job(v_job2, false);
    IF (v_again ->> 'nothing_to_apply') <> 'true' OR (v_again #>> '{games,inserted}') <> '0' OR (v_again #>> '{games,updated}') <> '0'
       OR (v_again #>> '{games,unchanged}') <> '3' OR (v_again #>> '{games,skipped,skipped-published}') <> '1' OR (v_again #>> '{games,repointed}') <> '0'
       OR (v_again #>> '{time_tbd,unchanged}') <> '1'
       OR (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = v_org) <> v_n
       OR (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org) <> v_games0 + 1 THEN
        RAISE EXCEPTION 'a re-import inserted, updated or made a run: %', v_again;
    END IF;
    v_checks := v_checks + 1;
    RAISE NOTICE 're-import: the same file inserts nothing, updates nothing and makes no run';

    -- ---- 4. the rollback ---------------------------------------------------------------------------------
    UPDATE public.game_assignments SET published = false WHERE external_ref = 'S-4';
    BEGIN
        PERFORM public.rollback_game_import_job(v_job);
        RAISE EXCEPTION 'a rollback after a change was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail NOT LIKE 'game_import_changed count=1 ids=%' OR position((SELECT id::text FROM public.game_assignments WHERE external_ref = 'S-4') IN v_detail) = 0 THEN
            RAISE EXCEPTION 'the rollback refused with the wrong detail (%)', v_detail;
        END IF;
    END;
    IF (SELECT count(*) FROM public.game_assignments WHERE organization_id = v_org) <> v_games0 + 1 THEN
        RAISE EXCEPTION 'a refused rollback deleted a game';
    END IF;
    UPDATE public.game_assignments SET published = true WHERE external_ref = 'S-4';
    -- The same for a TIME TBD game of the job (fix round 3): a later correction of S-5's date refuses the rollback and the
    -- detail names the TIME TBD row in tbd_ids; nothing is deleted.
    UPDATE public.schedule_tbd SET game_date = game_date + 1 WHERE external_ref = 'S-5';
    BEGIN
        PERFORM public.rollback_game_import_job(v_job);
        RAISE EXCEPTION 'a rollback after a TIME TBD game was changed was accepted' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail NOT LIKE 'game_import_changed count=1 ids= tbd_ids=%' OR position((SELECT id::text FROM public.schedule_tbd WHERE external_ref = 'S-5') IN v_detail) = 0 THEN
            RAISE EXCEPTION 'the rollback refused with the wrong detail for a changed TIME TBD game (%)', v_detail;
        END IF;
    END;
    IF NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE external_ref = 'S-5') THEN
        RAISE EXCEPTION 'a refused rollback deleted a TIME TBD game';
    END IF;
    UPDATE public.schedule_tbd SET game_date = game_date - 1 WHERE external_ref = 'S-5';
    PERFORM public.rollback_game_import_job(v_job);
    IF pg_temp.fps() IS DISTINCT FROM v_fps THEN
        RAISE EXCEPTION 'the rollback did not restore the schedule exactly (games, slots, runs, teams, divisions, venues, fields, TIME TBD)';
    END IF;
    IF (SELECT count(*) FROM public.teams WHERE is_external) <> 0 OR (SELECT count(*) FROM public.import_application_records WHERE import_job_id = v_job AND rolled_back_at IS NULL) <> 0 THEN
        RAISE EXCEPTION 'the rollback left the outside club or an unmarked record';
    END IF;
    v_checks := v_checks + 4;
    RAISE NOTICE 'rollback: refused after a change (the game, or the TIME TBD game, named, nothing deleted), and before one it restored the schedule exactly';

    -- ---- 5. two labels, one creation -----------------------------------------------------------------------
    v_job3 := (public.create_import_job(v_org, 'games', 'twice.csv')).id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM pg_temp.stage(v_org, v_job3, 1, 'ok', 'S-6', 'Smoke U10',   'Smoke Park', 'Smoke Field', 'Zed FC', 'Alpha', '2026-05-23', '09:00', '10:00', 4);
    PERFORM pg_temp.stage(v_org, v_job3, 2, 'ok', 'S-7', 'Smoke U10 B', 'Smoke Park', 'Smoke Field', 'Zed FC', 'Bravo', '2026-05-23', '10:00', '11:00', 4);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.map_game_import_job(v_job3, jsonb_build_object(
        'divisions', jsonb_build_object('smoke u10', jsonb_build_object('action', 'map', 'id', v_div), 'smoke u10 b', jsonb_build_object('action', 'map', 'id', v_div)),
        'venues', jsonb_build_object('smoke park', jsonb_build_object('action', 'map', 'id', v_loc)),
        'fields', jsonb_build_object('["smoke park","smoke field"]', jsonb_build_object('action', 'map', 'id', v_f1)),
        'teams', jsonb_build_object('["smoke u10","alpha"]', jsonb_build_object('action', 'map', 'id', v_a),
                                    '["smoke u10 b","bravo"]', jsonb_build_object('action', 'map', 'id', v_b),
                                    '["smoke u10","zed fc"]', jsonb_build_object('action', 'create'),
                                    '["smoke u10 b","zed fc"]', jsonb_build_object('action', 'create'))));
    v_dry := public.apply_game_import_job(v_job3, true);
    IF (v_dry #>> '{created,teams}') <> '1' THEN RAISE EXCEPTION 'the preview counts % new teams for two labels of one name, not 1', v_dry #>> '{created,teams}'; END IF;
    v_apply := public.apply_game_import_job(v_job3, false);
    IF (SELECT count(*) FROM public.teams WHERE division_id = v_div AND name = 'Zed FC') <> 1
       OR (v_apply #>> '{games,inserted}') <> '2' OR (v_apply -> 'created') IS DISTINCT FROM (v_dry -> 'created') THEN
        RAISE EXCEPTION 'two labels of one new team were not written as one team the preview counted: %', v_apply;
    END IF;
    v_checks := v_checks + 2;
    RAISE NOTICE 'coalescing: two source divisions mapped to one division, each with a new team of one name, are one team, as previewed';
    -- The team run is in the shape the pages read: the latest run's results carried (here none: the division's own teams), the new
    -- shell in its division's group, the flat list and the players, in ONE run.
    IF (SELECT count(*) FROM public.scheduler_runs WHERE organization_id = v_org AND run_type = 'team' AND parameters ->> 'import_job_id' = v_job3::text) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.scheduler_runs r
                       WHERE r.organization_id = v_org AND r.run_type = 'team' AND r.parameters ->> 'import_job_id' = v_job3::text
                         AND jsonb_typeof(r.results -> 'teamsByDivision') = 'object'
                         AND jsonb_array_length(r.results -> 'teamsByDivision' -> 'Smoke U10') = 4
                         AND (SELECT string_agg(t ->> 'name', ',' ORDER BY t ->> 'name') FROM jsonb_array_elements(r.results -> 'teamsByDivision' -> 'Smoke U10') t) = 'Alpha,Bravo,Charlie,Zed FC'
                         AND jsonb_array_length(r.results -> 'teams') = 4 AND jsonb_typeof(r.results -> 'team_players') = 'array') THEN
        RAISE EXCEPTION 'the shells are not in ONE team run in the shape the pages read (teamsByDivision, teams, team_players)';
    END IF;
    v_checks := v_checks + 1;
    RAISE NOTICE 'team run: one run, teamsByDivision lists the carried teams and the shell, teams and team_players beside it';

    -- ---- 6. fix round 2: TIME TBD with a date, a swap, a conversion, a name with a run of spaces ------------------------
    -- First file (the games arrive unplaced-as-published: not Published, so they can be changed): two games of one pair in one
    -- week, a game that will lose its time, and a TIME TBD game with a date.
    v_job4 := (public.create_import_job(v_org, 'games', 'round2-a.csv')).id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM pg_temp.stage(v_org, v_job4, 1, 'ok',  'G-SW1', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Bravo', '2026-06-06', '08:00', '09:00', 6);
    PERFORM pg_temp.stage(v_org, v_job4, 2, 'ok',  'G-SW2', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Bravo', '2026-06-06', '09:00', '10:00', 6);
    PERFORM pg_temp.stage(v_org, v_job4, 3, 'ok',  'G-CV1', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Charlie', 'Alpha', '2026-06-06', '10:00', '11:00', 6);
    PERFORM pg_temp.stage(v_org, v_job4, 4, 'tbd', 'G-TB1', 'Smoke U10', '',           '',            'Bravo',   'Charlie', '2026-06-13', NULL, NULL, 7);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.map_game_import_job(v_job4, jsonb_set(v_mapping, '{options,arrive_published}', 'false'));
    v_apply := public.apply_game_import_job(v_job4, false);
    IF (v_apply #>> '{games,inserted}') <> '3' OR (v_apply #>> '{time_tbd,inserted}') <> '1'
       OR NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE organization_id = v_org AND external_ref = 'G-TB1' AND game_date = '2026-06-13' AND week_index = 7) THEN
        RAISE EXCEPTION 'the first round-2 file did not write 3 games and a dated TIME TBD game: %', v_apply;
    END IF;
    v_fps4 := pg_temp.fps();
    -- Second file: the two games swap places by Game ID, one game now has no time, the TIME TBD game is moved a week (found by its
    -- Game ID, not by its old week), and a team is created under a name that differs from an existing team's only by a run of spaces.
    v_job5 := (public.create_import_job(v_org, 'games', 'round2-b.csv')).id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM pg_temp.stage(v_org, v_job5, 1, 'ok',  'G-SW1', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Bravo',   '2026-06-06', '09:00', '10:00', 6);
    PERFORM pg_temp.stage(v_org, v_job5, 2, 'ok',  'G-SW2', 'Smoke U10', 'Smoke Park', 'Smoke Field', 'Alpha',   'Bravo',   '2026-06-06', '08:00', '09:00', 6);
    PERFORM pg_temp.stage(v_org, v_job5, 3, 'tbd', 'G-CV1', 'Smoke U10', '',           '',            'Charlie', 'Alpha',   '2026-06-06', NULL, NULL, 6);
    PERFORM pg_temp.stage(v_org, v_job5, 4, 'tbd', 'G-TB1', 'Smoke U10', '',           '',            'Bravo',   'Charlie', '2026-06-20', NULL, NULL, 8);
    PERFORM pg_temp.stage(v_org, v_job5, 5, 'ok',  'G-Z1',  'Smoke U10', 'Smoke Park', 'Smoke Field', 'Dupe',    'Alpha',   '2026-06-20', '09:00', '10:00', 8);
    -- A Published game the file now gives no time: not converted (a held game is never taken out); the row is skipped.
    PERFORM pg_temp.stage(v_org, v_job5, 6, 'tbd', 'S-1',   'Smoke U10', '',           '',            'Alpha',   'Bravo',   '2026-05-02', NULL, NULL, 1);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.map_game_import_job(v_job5, jsonb_set(jsonb_set(v_mapping, '{options,arrive_published}', 'false'),
        ARRAY['teams', '["smoke u10","dupe"]'], jsonb_build_object('action', 'create', 'name', 'Zed  FC')));
    v_fp := pg_temp.fp();
    v_dry := public.apply_game_import_job(v_job5, true);
    IF pg_temp.fp() IS DISTINCT FROM v_fp THEN RAISE EXCEPTION 'the preview of the second round-2 file wrote something'; END IF;
    v_apply := public.apply_game_import_job(v_job5, false);
    IF (v_dry - 'dry_run' - 'ids') IS DISTINCT FROM (v_apply - 'dry_run' - 'ids') THEN
        RAISE EXCEPTION 'the second round-2 file: the preview was not the apply: % against %', v_dry - 'dry_run' - 'ids', v_apply - 'dry_run' - 'ids';
    END IF;
    IF (v_apply #>> '{games,updated}') <> '2' OR (v_apply -> 'time_tbd') IS DISTINCT FROM '{"inserted": 1, "updated": 1, "unchanged": 0, "removed": 0, "converted": 1}'::jsonb THEN
        RAISE EXCEPTION 'the swap and the TIME TBD changes were not counted as the file says: %', v_apply;
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(v_apply -> 'warnings') w WHERE w ->> 'type' = 'games-swapped') <> 2
       OR (SELECT count(*) FROM jsonb_array_elements(v_apply -> 'warnings') w WHERE w ->> 'type' = 'game-made-time-tbd') <> 1 THEN
        RAISE EXCEPTION 'a swap and a conversion are warnings: expected 2 games-swapped and 1 game-made-time-tbd in %', v_apply -> 'warnings';
    END IF;
    IF (SELECT to_char(gs.start_time, 'HH24:MI') FROM public.game_assignments ga JOIN public.game_slots gs ON gs.id = ga.game_slot_id WHERE ga.external_ref = 'G-SW1') <> '09:00'
       OR (SELECT to_char(gs.start_time, 'HH24:MI') FROM public.game_assignments ga JOIN public.game_slots gs ON gs.id = ga.game_slot_id WHERE ga.external_ref = 'G-SW2') <> '08:00' THEN
        RAISE EXCEPTION 'the two games did not swap places';
    END IF;
    IF (SELECT count(*) FROM public.schedule_tbd WHERE organization_id = v_org AND external_ref = 'G-TB1') <> 1
       OR NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE organization_id = v_org AND external_ref = 'G-TB1' AND game_date = '2026-06-20' AND week_index = 8)
       OR NOT EXISTS (SELECT 1 FROM public.schedule_tbd WHERE organization_id = v_org AND external_ref = 'G-CV1' AND game_date = '2026-06-06')
       OR EXISTS (SELECT 1 FROM public.game_assignments WHERE organization_id = v_org AND external_ref = 'G-CV1') THEN
        RAISE EXCEPTION 'the TIME TBD game was not found by its Game ID and changed in place, or the converted game stands as well as its TIME TBD row';
    END IF;
    IF (v_apply #>> '{games,skipped,skipped-published}') <> '1' OR NOT EXISTS (SELECT 1 FROM public.game_assignments WHERE id = v_g1 AND published)
       OR EXISTS (SELECT 1 FROM public.schedule_tbd WHERE organization_id = v_org AND external_ref = 'S-1') THEN
        RAISE EXCEPTION 'a Published game the file gives no time was taken out, or its row was written: %', v_apply;
    END IF;
    IF (v_apply #>> '{refused_by_reason,unknown-team}') <> '1' OR EXISTS (SELECT 1 FROM public.teams WHERE division_id = v_div AND name = 'Zed  FC') THEN
        RAISE EXCEPTION 'a name that differs from an existing team''s only by a run of spaces was created beside it: %', v_apply -> 'refused_by_reason';
    END IF;
    v_checks := v_checks + 7;
    RAISE NOTICE 'round 2: the swap is two updates and a warning, the dated TIME TBD game changed in place by its Game ID, the game with no time converted with a warning, a name with a run of spaces is the existing name';
    PERFORM public.rollback_game_import_job(v_job5);
    IF pg_temp.fps() IS DISTINCT FROM v_fps4 THEN
        RAISE EXCEPTION 'the rollback did not put the swapped games, the converted game and the TIME TBD game back exactly';
    END IF;
    v_checks := v_checks + 1;
    RAISE NOTICE 'round 2 rollback: the swapped pair, the converted game and the TIME TBD game are back as they were';

    RAISE NOTICE 'game_import smoke: % checks', v_checks;
END
$$;

ROLLBACK;
