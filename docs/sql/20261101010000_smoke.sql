-- Smoke checks for 20261101010000_one_active_season.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the import RPCs run
-- as a real organization admin.
--
--   1. Posture: no organization has two active seasons and no status is NULL. (That an
--      organization with seasons has one active is the migration's own end-state check, made when
--      it applies: a later insert may legitimately leave an organization with only drafts, as the
--      seeds earlier smokes commit do.)
--   2. The database refuses what the readers no longer have to: a second active season (23505), a
--      season name that differs only in case or padding (23505), a NULL status (23502), and a
--      client's direct write (insert refused, update and delete reach nothing).
--   3. `create_import_job` fixes the season: none named is the active one, the active one named is
--      that, another organization's season is refused (42501), and a completed one (22023,
--      `season_completed`); a draft takes a player import since E3b (20261109010000: players belong
--      to one season) and a field import for it is refused (`season_not_active`).
--   4. `finalize_import_job` finalizes a job whose season is a draft into the draft; refuses a job
--      whose season is completed and promotes nobody; keeps a job made for a season on that season
--      once another season is the active one (the old rule would have poured it into the new active
--      season); and puts a legacy job with no season into the active one.
--      `finalize_field_import_job` refuses a draft season.
--   5. The two division writers refuse a completed season.
--
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_other uuid := gen_random_uuid();
    v_org uuid;
    v_other_org uuid;
    v_active uuid;
    v_draft uuid;
    v_done uuid;
    v_other_season uuid;
    v_job public.import_jobs%ROWTYPE;
    v_state text;
    v_n integer;
    v_rows integer;
    v_list text;
BEGIN
    -- ---- 1. posture -------------------------------------------------------
    SELECT count(*) INTO v_n FROM (
        SELECT organization_id FROM public.season_settings WHERE status = 'active'
         GROUP BY organization_id HAVING count(*) > 1) x;
    IF v_n <> 0 THEN RAISE EXCEPTION '% organization(s) have more than one active season', v_n; END IF;
    IF EXISTS (SELECT 1 FROM public.season_settings WHERE status IS NULL) THEN
        RAISE EXCEPTION 'a season has no status';
    END IF;
    SELECT count(DISTINCT organization_id), count(*) INTO v_n, v_rows FROM public.season_settings;
    RAISE NOTICE 'posture: % season(s) in % organization(s), no organization with two active seasons and every status set', v_rows, v_n;

    -- ---- seed: two organizations ------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'season-admin@example.test', '{"password_length": 16}'),
        (v_other, 'season-other@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'season-admin@example.test'), (v_other, 'season-other@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Season Org', 'smoke-season-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Season Other', 'smoke-season-other') RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_other_org, v_other, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'Smoke 2026', 'active', 2026) RETURNING id INTO v_active;
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'Smoke 2027', 'draft', 2027) RETURNING id INTO v_draft;
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'Smoke 2025', 'completed', 2025) RETURNING id INTO v_done;
    INSERT INTO public.season_settings (organization_id, name, status)
        VALUES (v_other_org, 'Other 2026', 'active') RETURNING id INTO v_other_season;

    -- ---- 2. the database refuses --------------------------------------------
    BEGIN
        INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Smoke Second Active', 'active');
        RAISE EXCEPTION 'a second active season was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, '  smoke 2027 ');
        RAISE EXCEPTION 'a season name differing in case and padding was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Smoke No Status', NULL);
        RAISE EXCEPTION 'a NULL status was accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_other_org, 'Smoke 2027');
    IF (SELECT status FROM public.season_settings WHERE organization_id = v_other_org AND name = 'Smoke 2027') <> 'draft' THEN
        RAISE EXCEPTION 'a season inserted with no status is not a draft';
    END IF;
    RAISE NOTICE 'the database refuses a second active season, a name differing in case or padding and a NULL status; the same name in another organization is fine and a new season is a draft';

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
        INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Smoke Direct', 'draft');
        RESET ROLE;
        RAISE EXCEPTION 'a client inserted a season directly';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    SET LOCAL ROLE authenticated;
    UPDATE public.season_settings SET name = 'Smoke Direct Rename' WHERE id = v_draft;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    DELETE FROM public.season_settings WHERE id = v_done;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_rows <> 0 OR v_n <> 0 THEN
        RAISE EXCEPTION 'a client''s direct update reached % season(s) and its delete %', v_rows, v_n;
    END IF;
    RAISE NOTICE 'a client''s direct insert is refused, and its update and delete reach no season: the season RPCs are the writers';

    -- ---- 3. create_import_job fixes the season ---------------------------------
    SELECT * INTO v_job FROM public.create_import_job(v_org, 'players', 'a.csv');
    IF v_job.season_settings_id IS DISTINCT FROM v_active THEN
        RAISE EXCEPTION 'a job with no season named was made for % instead of the active season', v_job.season_settings_id;
    END IF;
    SELECT * INTO v_job FROM public.create_import_job(v_org, 'players', 'b.csv', v_active);
    IF v_job.season_settings_id IS DISTINCT FROM v_active THEN
        RAISE EXCEPTION 'a job naming the active season was made for %', v_job.season_settings_id;
    END IF;
    -- 20261109010000 (E3b): a draft takes a player import, since players belong to one season; a
    -- field import still goes to the active season only.
    SELECT * INTO v_job FROM public.create_import_job(v_org, 'players', 'f.csv', v_draft);
    IF v_job.season_settings_id IS DISTINCT FROM v_draft THEN
        RAISE EXCEPTION 'a job naming a draft season was made for %', v_job.season_settings_id;
    END IF;
    v_state := NULL;
    BEGIN
        PERFORM public.create_import_job(v_org, 'fields', 'g.csv', v_draft);
        RAISE EXCEPTION 'a field import for a draft season was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_DETAIL;
    END;
    IF v_state IS DISTINCT FROM 'season_not_active' THEN
        RAISE EXCEPTION 'the field-import refusal for a draft carried detail [%]', v_state;
    END IF;
    BEGIN
        PERFORM public.create_import_job(v_org, 'players', 'c.csv', v_other_season);
        RAISE EXCEPTION 'another organization''s season was accepted';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    BEGIN
        PERFORM public.create_import_job(v_org, 'players', 'd.csv', v_done);
        RAISE EXCEPTION 'a completed season was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    SELECT count(*) INTO v_n FROM public.import_jobs
     WHERE organization_id = v_org AND storage_path IN (format('imports/%s/c.csv', v_admin), format('imports/%s/d.csv', v_admin), format('imports/%s/g.csv', v_admin));
    IF v_n <> 0 THEN RAISE EXCEPTION 'a refused create_import_job left % job(s)', v_n; END IF;
    RAISE NOTICE 'create_import_job: no season named is the active season, a draft takes a player import, another organization''s season (42501), a completed one and a field import for a draft (22023) are refused and leave no job';

    -- ---- 4. the finalizers read the job's season --------------------------------
    RESET ROLE;
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by, season_settings_id)
    VALUES (v_org, 'registration', 'orga/draft.csv', 'importing', v_admin, v_draft) RETURNING * INTO v_job;
    INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
    VALUES (v_org, v_job.id, 1, '{}'::jsonb,
            '{"first_name": "Dee", "last_name": "Smoke", "external_registration_id": "SM-D", "age group": "9", "gender": "M"}'::jsonb);
    -- 20261109010000 (E3b): a job whose season is a draft finalizes into the draft.
    PERFORM public.finalize_import_job(v_job.id);
    IF NOT EXISTS (SELECT 1 FROM public.players p WHERE p.external_registration_id = 'SM-D' AND p.season_settings_id = v_draft)
       OR NOT EXISTS (SELECT 1 FROM public.divisions WHERE season_settings_id = v_draft AND name = 'U10B')
       OR EXISTS (SELECT 1 FROM public.divisions WHERE season_settings_id = v_active AND name = 'U10B') THEN
        RAISE EXCEPTION 'the draft import did not land, with its division, in the draft alone';
    END IF;
    RAISE NOTICE 'a job whose season is a draft finalizes into the draft (its player and derived division), and the active season gains neither';

    -- A job made for a season stays on it: when another season becomes the active one the job
    -- still finalizes into the season it was made for (a draft now, 20261109010000), not into the
    -- new active season.
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by, season_settings_id)
    VALUES (v_org, 'registration', 'orga/moved.csv', 'importing', v_admin, v_active) RETURNING * INTO v_job;
    INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
    VALUES (v_org, v_job.id, 1, '{}'::jsonb,
            '{"first_name": "Moe", "last_name": "Smoke", "external_registration_id": "SM-M", "age group": "13", "gender": "M"}'::jsonb);
    UPDATE public.season_settings SET status = 'draft' WHERE id = v_active;
    UPDATE public.season_settings SET status = 'active' WHERE id = v_draft;
    PERFORM public.finalize_import_job(v_job.id);
    UPDATE public.season_settings SET status = 'draft' WHERE id = v_draft;
    UPDATE public.season_settings SET status = 'active' WHERE id = v_active;
    IF NOT EXISTS (SELECT 1 FROM public.players p WHERE p.external_registration_id = 'SM-M' AND p.season_settings_id = v_active) THEN
        RAISE EXCEPTION 'the job made for a season that stopped being the active one did not stay on its season';
    END IF;
    IF EXISTS (SELECT 1 FROM public.players p WHERE p.external_registration_id = 'SM-M' AND p.season_settings_id = v_draft) THEN
        RAISE EXCEPTION 'the job was poured into the new active season';
    END IF;
    RAISE NOTICE 'a job made for a season that has stopped being the active one stays on its own season';

    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by)
    VALUES (v_org, 'registration', 'orga/legacy.csv', 'importing', v_admin) RETURNING * INTO v_job;
    INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
    VALUES (v_org, v_job.id, 1, '{}'::jsonb,
            '{"first_name": "Lee", "last_name": "Smoke", "external_registration_id": "SM-L", "age group": "11", "gender": "F"}'::jsonb);
    PERFORM public.finalize_import_job(v_job.id);
    SELECT string_agg(d.name, ',' ORDER BY d.name) INTO v_list FROM public.divisions d WHERE d.season_settings_id = v_active;
    IF v_list IS DISTINCT FROM 'U12G,U14B' THEN
        RAISE EXCEPTION 'a legacy job (no season) created divisions [%] in the active season, expected U12G,U14B (the moved job''s U14B and its own U12G)', v_list;
    END IF;
    RAISE NOTICE 'a legacy job with no season finalizes into the active season';

    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by, season_settings_id)
    VALUES (v_org, 'registration', 'orga/done.csv', 'importing', v_admin, v_done) RETURNING * INTO v_job;
    INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
    VALUES (v_org, v_job.id, 1, '{}'::jsonb,
            '{"first_name": "Cee", "last_name": "Smoke", "external_registration_id": "SM-C", "age group": "7", "gender": "M"}'::jsonb);
    BEGIN
        PERFORM public.finalize_import_job(v_job.id);
        RAISE EXCEPTION 'a completed season took an import';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_DETAIL;
    END;
    IF v_state IS DISTINCT FROM 'season_completed' THEN
        RAISE EXCEPTION 'the completed-season refusal carried detail [%]', v_state;
    END IF;
    IF EXISTS (SELECT 1 FROM public.players WHERE external_registration_id = 'SM-C') THEN
        RAISE EXCEPTION 'the refused finalize promoted a player';
    END IF;
    RAISE NOTICE 'a job whose season has been completed is refused (22023, season_completed) and promotes nobody';

    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_draft, 'Smoke Draft Only U8');
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by, season_settings_id)
    VALUES (v_org, 'fields', 'orga/fields.csv', 'importing', v_admin, v_draft) RETURNING * INTO v_job;
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (v_org, v_job.id, 'fields', 1, '{}'::jsonb,
            '{"location": "Smoke Park", "name": "Smoke Pitch", "type": "practice", "day": "Sat", "start": "09:00", "end": "09:30",
              "capacity": "1", "valid_from": "2027-09-04", "valid_until": "2027-11-27", "division_name": "smoke draft only u8"}'::jsonb,
            '[]'::jsonb);
    v_state := NULL;
    BEGIN
        PERFORM public.finalize_field_import_job(v_job.id);
        RAISE EXCEPTION 'a fields job for a draft season was finalized';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_DETAIL;
    END;
    IF v_state IS DISTINCT FROM 'season_not_active' THEN
        RAISE EXCEPTION 'the fields refusal carried detail [%]', v_state;
    END IF;
    IF EXISTS (SELECT 1 FROM public.practice_slots ps WHERE ps.organization_id = v_org AND ps.valid_from = DATE '2027-09-04') THEN
        RAISE EXCEPTION 'the refused fields job wrote a practice slot';
    END IF;
    RAISE NOTICE 'a fields job for a draft season is refused (22023, season_not_active) and writes no slot';

    -- ---- 5. the two division writers refuse a completed season ----------------------
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.upsert_division_for_import(v_org, v_done, 'U9B');
        RESET ROLE;
        RAISE EXCEPTION 'upsert_division_for_import accepted a completed season';
    EXCEPTION WHEN SQLSTATE '22023' THEN RESET ROLE;
    END;
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.admin_upsert_division_settings(v_org, v_done, NULL, 'U9B', 12, NULL, NULL, NULL, NULL, NULL, NULL);
        RESET ROLE;
        RAISE EXCEPTION 'admin_upsert_division_settings accepted a completed season';
    EXCEPTION WHEN SQLSTATE '22023' THEN RESET ROLE;
    END;
    RAISE NOTICE 'upsert_division_for_import and admin_upsert_division_settings refuse a completed season (22023)';
END;
$$;

ROLLBACK;
