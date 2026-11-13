-- Smoke checks for 20261123010000_practice_import.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK. Synthetic organization, users, teams
-- and practices; no real data.
--
--   1. Shape: practice_schedule in the four lists, the three client RPCs (definer, pinned, open to authenticated and
--      closed to anon and PUBLIC) and the two internal helpers (closed to every client role), the allowlist's SQL copy.
--   2. A five-row file: a dry run writes nothing and its result is the apply's; the apply makes a location, a field and
--      four slots (an open one too), inserts two MANUAL practices with no run, and flags the team that is on one weekday twice (the gate's
--      weekday rule, judged for manual rows); a team whose saved practice the file does not hold has its new row held
--      back as a probable move.
--   3. The same file again inserts nothing and reports the same flags.
--   4. The rollback refuses after a change (naming the practice) and, before one, restores the schedule exactly, keeping
--      the field an admin has given a blackout since.
--
-- The pgTAP file (supabase/tests/practice_import_apply_rollback.sql) holds the full table over the shipped fixture; this
-- is the part the migration harness can run without pgTAP, and the part its plants are shown to turn red
-- (scripts/dbharness/prove.sh, M80).

\set ON_ERROR_STOP on

BEGIN;

-- stage: one staged row of a practice job, as core's toStagedPracticeRow builds it.
CREATE FUNCTION pg_temp.stage(p_org uuid, p_job uuid, p_row int, p_team text, p_day text, p_start text, p_end text, p_field text)
RETURNS void LANGUAGE sql AS $f$
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (p_org, p_job, 'practice_schedule', p_row, '{}'::jsonb,
            jsonb_build_object('row_key', 'row-' || p_row, 'status', CASE WHEN p_team IS NULL THEN 'open' ELSE 'placement' END,
                'day', p_day, 'start_time', p_start, 'end_time', p_end, 'valid_from', '2026-09-07', 'valid_until', '2026-11-20',
                'capacity', 1, 'flags', '[]'::jsonb,
                'division', CASE WHEN p_team IS NULL THEN '' ELSE 'Smoke U10' END,
                'division_key', CASE WHEN p_team IS NULL THEN '' ELSE 'smoke u10' END,
                'location', 'Smoke Park', 'location_key', 'smoke park',
                'field', p_field, 'field_key', '["smoke park",' || to_json(lower(p_field))::text || ']',
                'subunit', '', 'subunit_key', '',
                'team', COALESCE(p_team, ''),
                'team_key', CASE WHEN p_team IS NULL THEN '' ELSE '["smoke u10",' || to_json(lower(p_team))::text || ']' END),
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
-- fps: the practice side's own tables (the TIME TBD list aside: it is rebuilt from the truth, and reads the date).
CREATE FUNCTION pg_temp.fps() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record; acc text := ''; h text;
BEGIN
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                AND c.relname IN ('practice_assignments', 'practice_slots', 'teams', 'divisions', 'locations', 'fields', 'field_subunits', 'scheduler_runs')
              ORDER BY c.relname LOOP
        EXECUTE format('SELECT md5(COALESCE(string_agg((to_jsonb(t) - ''updated_at'')::text, E''\n'' ORDER BY (to_jsonb(t) - ''updated_at'')::text), '''')) FROM public.%I t', r.relname) INTO h;
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
    v_a       uuid := gen_random_uuid();   -- Alpha: on Monday twice in the file
    v_m       uuid := gen_random_uuid();   -- Mover: saved on Saturday, placed on Wednesday by the file
    v_loc0    uuid := gen_random_uuid();
    v_f0      uuid := gen_random_uuid();
    v_slot0   uuid := gen_random_uuid();
    v_pa0     uuid := gen_random_uuid();
    v_job     uuid;
    v_job2    uuid;
    v_job3    uuid;
    v_map     jsonb;
    v_dry     jsonb;
    v_apply   jsonb;
    v_again   jsonb;
    v_fp      text;
    v_fps     text;
    v_n       integer;
    v_msg     text;
    v_state   text;
    v_checks  integer := 0;
    v_bad     text;
BEGIN
    -- ---- 1. shape ------------------------------------------------------------------------------------
    SELECT string_agg(c.conname, ', ') INTO v_bad FROM (VALUES
        ('import_jobs_job_type_check'), ('staging_import_rows_import_type_check'), ('import_application_records_import_type_check'),
        ('import_application_records_target_table_check')) AS c(conname)
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = c.conname AND k.convalidated
                        AND pg_get_constraintdef(k.oid) ~ $re$'(practice_schedule|practice_assignments)'$re$);
    IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'a list does not take the practice import: %', v_bad; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('apply_practice_import_job', 'rollback_practice_import_job', 'map_practice_import_job')
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0);
    IF v_n <> 3 THEN RAISE EXCEPTION '% of the 3 client RPCs are definer functions with a pinned search path, open to authenticated and closed to anon and PUBLIC', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('ensure_practice_slot', 'practice_import_referenced_ids')
       AND NOT p.prosecdef AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 2 THEN RAISE EXCEPTION '% of the 2 internal helpers are closed to every client role', v_n; END IF;
    IF cardinality(public.import_allowed_keys('practice_schedule')) <> 19 THEN RAISE EXCEPTION 'import_allowed_keys(practice_schedule) is not the 19 staged keys'; END IF;
    v_checks := v_checks + 4;
    RAISE NOTICE 'shape: practice_schedule in four lists, 3 client RPCs pinned and closed to anon and PUBLIC, 2 internal helpers, 19 allowlisted keys';

    -- ---- seed (no signed-in user) --------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'practice-import-smoke@example.test', '{"password_length": 12, "full_name": "Practice Import Admin"}');
    INSERT INTO public.profiles (id, email, full_name) VALUES (v_admin, 'practice-import-smoke@example.test', 'Practice Import Admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Practice Smoke Org', 'practice-smoke-' || replace(v_org::text, '-', ''));
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin')
    ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'admin';
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year, season_start, season_end)
    VALUES (v_season, v_org, 'Practice Smoke Season', 'active', 2026, '2026-09-07', '2026-11-20');
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name, practices_per_week) VALUES (v_div, v_org, v_season, 'Smoke U10', 2);
    INSERT INTO public.teams (id, organization_id, division_id, name) VALUES (v_a, v_org, v_div, 'Alpha'), (v_m, v_org, v_div, 'Mover');
    INSERT INTO public.locations (id, organization_id, name) VALUES (v_loc0, v_org, 'Old Park');
    INSERT INTO public.fields (id, organization_id, location_id, name) VALUES (v_f0, v_org, v_loc0, 'Old Field');
    INSERT INTO public.practice_slots (id, organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
    VALUES (v_slot0, v_org, v_f0, 'sat', '09:00', '10:00', 1, '2026-09-07', '2026-11-20');
    INSERT INTO public.practice_assignments (id, organization_id, team_id, slot_id, practice_slot_id, day_of_week, start_time, end_time, field_id,
                                             effective_date_range, source, assigned_via)
    VALUES (v_pa0, v_org, v_m, v_slot0, v_slot0, 'sat', '09:00:00', '10:00:00', v_f0, '[2026-09-07,2026-11-20]', 'manual', 'manual');
    v_fps := pg_temp.fps();

    -- ---- 2. a dry run, then the apply ----------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_job := (public.create_import_job(v_org, 'practice_schedule', 'smoke.csv')).id;
    PERFORM pg_temp.stage(v_org, v_job, 1, 'Alpha', 'mon', '17:00', '18:00', 'Field A');
    PERFORM pg_temp.stage(v_org, v_job, 2, 'Alpha', 'mon', '17:00', '18:00', 'Field B');
    PERFORM pg_temp.stage(v_org, v_job, 3, NULL, 'mon', '18:00', '19:00', 'Field A');
    PERFORM pg_temp.stage(v_org, v_job, 4, 'Mover', 'wed', '17:00', '18:00', 'Field A');
    v_map := jsonb_build_object(
        'divisions', jsonb_build_object('smoke u10', jsonb_build_object('action', 'map', 'id', v_div)),
        'locations', jsonb_build_object('smoke park', jsonb_build_object('action', 'create')),
        'fields', jsonb_build_object('["smoke park","field a"]', jsonb_build_object('action', 'create'),
                                     '["smoke park","field b"]', jsonb_build_object('action', 'create')),
        'teams', jsonb_build_object('["smoke u10","alpha"]', jsonb_build_object('action', 'map', 'id', v_a),
                                    '["smoke u10","mover"]', jsonb_build_object('action', 'map', 'id', v_m)));
    PERFORM public.map_practice_import_job(v_job, v_map);
    -- Only a job whose staging finished is applied.
    BEGIN
        PERFORM public.apply_practice_import_job(v_job, true);
        v_state := 'no error';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_DETAIL;
    END;
    IF v_state IS DISTINCT FROM 'import_not_ready_to_apply' THEN
        RAISE EXCEPTION 'a job still importing was not refused: %', v_state;
    END IF;
    PERFORM public.mark_import_job_ready_to_apply(v_job, 'practice_schedule');
    v_fp := pg_temp.fp();
    v_dry := public.apply_practice_import_job(v_job, true);
    IF pg_temp.fp() IS DISTINCT FROM v_fp THEN
        RAISE EXCEPTION 'a dry run wrote: the public schema changed';
    END IF;
    v_apply := public.apply_practice_import_job(v_job, false);
    IF (v_dry - 'dry_run' - 'ids') IS DISTINCT FROM (v_apply - 'dry_run' - 'ids') THEN
        RAISE EXCEPTION 'the preview is not the apply: % against %', v_dry -> 'counts', v_apply -> 'counts';
    END IF;
    v_checks := v_checks + 2;
    IF (v_apply #>> '{counts,inserted}', v_apply #>> '{counts,slots_created}', v_apply #>> '{counts,locations_created}',
        v_apply #>> '{counts,fields_created}', v_apply #>> '{counts,held_back}')
       IS DISTINCT FROM ('2', '4', '1', '2', '1') THEN
        RAISE EXCEPTION 'the apply did not insert 2 practices on 4 new slots of 1 new location and 2 new fields with 1 row held back: %', v_apply -> 'counts';
    END IF;
    SELECT count(*) INTO v_n FROM public.practice_assignments
     WHERE team_id = v_a AND source = 'manual' AND assigned_via = 'manual' AND run_id IS NULL;
    IF v_n <> 2 THEN RAISE EXCEPTION 'Alpha holds % manual practices in no run, not 2', v_n; END IF;
    IF v_apply #>> '{flags,weekday,rows}' IS DISTINCT FROM '2' THEN
        RAISE EXCEPTION 'the gate''s weekday rule was not reported for the two manual Monday rows of Alpha: %', v_apply -> 'flags';
    END IF;
    IF v_apply #>> '{arriving,2,probable_move}' IS DISTINCT FROM 'true' OR v_apply #>> '{arriving,2,added}' IS DISTINCT FROM 'false'
       OR EXISTS (SELECT 1 FROM public.practice_assignments WHERE team_id = v_m AND id <> v_pa0) THEN
        RAISE EXCEPTION 'Mover''s new row was not held back as a probable move: %', v_apply -> 'arriving';
    END IF;
    -- The second caller: it finds the job completed (judged after the locks) and replays it; nothing is written again.
    SELECT md5(warning_summary::text) INTO v_msg FROM public.import_jobs WHERE id = v_job;
    SELECT count(*) INTO v_n FROM public.audit_log WHERE action = 'import.completed' AND resource_id = v_job;
    IF (public.apply_practice_import_job(v_job, false) ->> 'replayed') IS DISTINCT FROM 'true'
       OR (SELECT md5(warning_summary::text) FROM public.import_jobs WHERE id = v_job) IS DISTINCT FROM v_msg
       OR (SELECT count(*) FROM public.audit_log WHERE action = 'import.completed' AND resource_id = v_job) <> v_n OR v_n <> 1 THEN
        RAISE EXCEPTION 'a second apply of a completed job was not a replay that writes nothing';
    END IF;
    v_checks := v_checks + 6;
    RAISE NOTICE 'apply: an importing job is refused; a dry run writes nothing and is the apply; a second apply replays and writes nothing; 2 manual practices in no run, 4 slots (an open one too), a location and 2 fields made; the weekday rule flagged for manual rows; a probable move held back';

    -- ---- 3. the same file again ---------------------------------------------------------------------------
    v_job2 := (public.create_import_job(v_org, 'practice_schedule', 'smoke-again.csv')).id;
    PERFORM pg_temp.stage(v_org, v_job2, 1, 'Alpha', 'mon', '17:00', '18:00', 'Field A');
    PERFORM pg_temp.stage(v_org, v_job2, 2, 'Alpha', 'mon', '17:00', '18:00', 'Field B');
    PERFORM pg_temp.stage(v_org, v_job2, 3, NULL, 'mon', '18:00', '19:00', 'Field A');
    PERFORM pg_temp.stage(v_org, v_job2, 4, 'Mover', 'wed', '17:00', '18:00', 'Field A');
    PERFORM public.mark_import_job_ready_to_apply(v_job2, 'practice_schedule');
    PERFORM public.map_practice_import_job(v_job2, jsonb_set(jsonb_set(v_map, '{locations,smoke park}',
        jsonb_build_object('action', 'map', 'id', (SELECT id FROM public.locations WHERE organization_id = v_org AND name = 'Smoke Park'))),
        '{fields}', jsonb_build_object(
            '["smoke park","field a"]', jsonb_build_object('action', 'map', 'id', (SELECT f.id FROM public.fields f WHERE f.organization_id = v_org AND f.name = 'Field A')),
            '["smoke park","field b"]', jsonb_build_object('action', 'map', 'id', (SELECT f.id FROM public.fields f WHERE f.organization_id = v_org AND f.name = 'Field B')))));
    v_again := public.apply_practice_import_job(v_job2, false);
    IF (v_again #>> '{counts,inserted}', v_again #>> '{counts,unchanged}', v_again #>> '{counts,slots_found}') IS DISTINCT FROM ('0', '2', '4') THEN
        RAISE EXCEPTION 'a re-import was not nothing: %', v_again -> 'counts';
    END IF;
    IF (v_again -> 'flags') IS DISTINCT FROM (v_apply -> 'flags') THEN
        RAISE EXCEPTION 'a re-import reported other flags: % against %', v_again -> 'flags', v_apply -> 'flags';
    END IF;
    v_job3 := (public.create_import_job(v_org, 'practice_schedule', 'smoke-differs.csv')).id;
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (v_org, v_job3, 'practice_schedule', 1, '{}'::jsonb,
            jsonb_build_object('row_key', 'row-1', 'status', 'open', 'day', 'sat', 'start_time', '09:00', 'end_time', '10:30',
                'valid_from', '2026-09-07', 'valid_until', '2026-11-20', 'capacity', 1, 'flags', '[]'::jsonb, 'division', '', 'division_key', '',
                'location', 'Old Park', 'location_key', 'old park', 'field', 'Old Field', 'field_key', '["old park","old field"]',
                'subunit', '', 'subunit_key', '', 'team', '', 'team_key', ''), '[]'::jsonb);
    PERFORM public.mark_import_job_ready_to_apply(v_job3, 'practice_schedule');
    PERFORM public.map_practice_import_job(v_job3, jsonb_build_object(
        'locations', jsonb_build_object('old park', jsonb_build_object('action', 'map', 'id', v_loc0)),
        'fields', jsonb_build_object('["old park","old field"]', jsonb_build_object('action', 'map', 'id', v_f0))));
    v_again := public.apply_practice_import_job(v_job3, true);
    IF v_again #>> '{refused,0,reason}' IS DISTINCT FROM 'slot-differs' OR v_again #>> '{counts,slots_found}' IS DISTINCT FROM '0' THEN
        RAISE EXCEPTION 'a row naming a saved slot with another end was not refused slot-differs: %', v_again -> 'refused';
    END IF;
    v_checks := v_checks + 3;
    RAISE NOTICE 're-import: nothing inserted, 2 unchanged, 4 slots found, the same flags; a row naming a saved slot with another end is refused slot-differs';

    -- ---- 4. the rollback --------------------------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.practice_assignments SET source = 'auto' WHERE team_id = v_a AND field_id = (SELECT id FROM public.fields WHERE organization_id = v_org AND name = 'Field A');
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    BEGIN
        PERFORM public.rollback_practice_import_job(v_job);
        v_state := 'no error';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        v_state := v_msg;
    END;
    IF v_state !~ '^practice_import_changed count=1 ids=' THEN
        RAISE EXCEPTION 'the rollback did not refuse after a change, naming it: %', v_state;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.practice_assignments SET source = 'manual' WHERE team_id = v_a AND field_id = (SELECT id FROM public.fields WHERE organization_id = v_org AND name = 'Field A');
    INSERT INTO public.field_blackouts (organization_id, field_id, blackout_from, blackout_until, reason)
    SELECT v_org, f.id, '2026-10-01', '2026-10-02', 'maintenance' FROM public.fields f WHERE f.organization_id = v_org AND f.name = 'Field B';
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.rollback_practice_import_job(v_job);
    IF NOT EXISTS (SELECT 1 FROM public.fields WHERE organization_id = v_org AND name = 'Field B')
       OR NOT EXISTS (SELECT 1 FROM public.field_blackouts fb JOIN public.fields f ON f.id = fb.field_id WHERE f.name = 'Field B' AND f.organization_id = v_org) THEN
        RAISE EXCEPTION 'the rollback deleted a field an admin had given a blackout since (and the blackout with it)';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    DELETE FROM public.field_blackouts WHERE organization_id = v_org;
    DELETE FROM public.fields WHERE organization_id = v_org AND name = 'Field B';
    DELETE FROM public.locations WHERE organization_id = v_org AND name = 'Smoke Park';
    IF pg_temp.fps() IS DISTINCT FROM v_fps THEN
        RAISE EXCEPTION 'the rollback did not restore the practice side exactly (the kept field aside)';
    END IF;
    v_checks := v_checks + 3;
    RAISE NOTICE 'rollback: refused after a change, naming it; before one it restores every practice, slot, team and run, and keeps the field given a blackout since';

    RAISE NOTICE 'practice_import smoke: % checks', v_checks;
END
$$;

ROLLBACK;
