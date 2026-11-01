-- Smoke checks for 20261113010000_evaluations_import.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   * the finalizer, as an admin, on rows staged directly: it only updates (an unmatched id is
--     listed and creates nobody), a blank cell leaves the stored value alone, a zero is a value,
--     a repeated import changes nothing, a registration id another season holds (a draft's) is
--     never read or written, `007` is not `7`, a bad cell makes its row invalid and unapplied;
--   * the dry run answers with the counts the apply then produces and writes nothing;
--   * a season completed after the job was made is refused 22023 `season_completed`, apply and dry
--     run alike, and nothing is written; a stranger is refused 42501; a registration job is not an
--     evaluations job;
--   * it is audited as `import.completed` with the counts and no registration ids; a finished job
--     answers a second call with its stored result;
--   * the lifecycle accepts the type (create, ready to apply, cancel), the SQL allowlist holds it,
--     and the retention job exists.
--
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_stranger uuid := gen_random_uuid();
    v_org uuid;
    v_active uuid;
    v_draft uuid;
    v_past uuid;
    v_job uuid;
    v_again uuid;
    v_past_job uuid;
    v_reg_job uuid;
    v_dry jsonb;
    v_result jsonb;
    v_got text;
    v_n bigint;
    v_state text;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'ev-admin@example.test', '{"password_length": 16}'),
        (v_stranger, 'ev-stranger@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'ev-admin@example.test'), (v_stranger, 'ev-stranger@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Evaluations', 'smoke-org-evaluations')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'EV Active', 'active')
        RETURNING id INTO v_active;
    INSERT INTO public.season_settings (organization_id, name, status, season_year) VALUES (v_org, 'EV Draft', 'draft', 2027)
        RETURNING id INTO v_draft;
    INSERT INTO public.season_settings (organization_id, name, status, season_year) VALUES (v_org, 'EV Past', 'draft', 2025)
        RETURNING id INTO v_past;

    INSERT INTO public.players (organization_id, season_settings_id, first_name, last_name, external_registration_id, years_played, skill_tier, rating, updated_at) VALUES
        (v_org, v_active, 'Zero', 'Ev', '007', NULL, NULL, NULL, '2020-01-01'),
        (v_org, v_active, 'Seven', 'Ev', '7', NULL, NULL, NULL, '2020-01-01'),
        (v_org, v_active, 'Blank', 'Ev', 'EV-2', 4, 'advanced', 5, '2020-01-01'),
        (v_org, v_active, 'Same', 'Ev', 'EV-3', 2, 'novice', 1, '2020-01-01'),
        (v_org, v_active, 'Bad', 'Ev', 'EV-5', 8, 'novice', 2, '2020-01-01'),
        (v_org, v_active, 'Zeroyears', 'Ev', 'EV-7', 5, NULL, NULL, '2020-01-01'),
        (v_org, v_draft, 'Draft', 'Ev', '007', 9, 'advanced', 4, '2020-01-01'),
        (v_org, v_past, 'Past', 'Ev', 'EV-2', 7, 'developing', 3, '2020-01-01');

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    v_job := (public.create_import_job(v_org, 'evaluations', 'smoke-ev.csv')).id;
    v_again := (public.create_import_job(v_org, 'evaluations', 'smoke-ev-again.csv')).id;
    v_past_job := (public.create_import_job(v_org, 'evaluations', 'smoke-ev-past.csv', v_past)).id;
    v_reg_job := (public.create_import_job(v_org, 'players', 'smoke-reg.csv')).id;
    IF (SELECT job_type FROM public.import_jobs WHERE id = v_job) <> 'evaluations'
       OR (SELECT season_settings_id FROM public.import_jobs WHERE id = v_job) <> v_active THEN
        RAISE EXCEPTION 'an evaluations job did not get its own job type and the active season';
    END IF;

    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload)
    SELECT v_org, j, 'evaluations', r.n, '{}'::jsonb, r.p
      FROM unnest(ARRAY[v_job, v_again]) AS j,
           (VALUES
            (1, '{"external_registration_id":"007","years_played":"3","skill_tier":"developing","rating":"4"}'::jsonb),
            (2, '{"external_registration_id":"EV-2","years_played":"6","skill_tier":"","rating":""}'::jsonb),
            (3, '{"external_registration_id":"EV-3","years_played":"2","skill_tier":"NOVICE","rating":"1"}'::jsonb),
            (4, '{"external_registration_id":"NOBODY-1","years_played":"2","skill_tier":"","rating":""}'::jsonb),
            (5, '{"external_registration_id":"EV-5","years_played":"31","skill_tier":"advanced","rating":"4"}'::jsonb),
            (6, '{"years_played":"2","skill_tier":"","rating":""}'::jsonb),
            (7, '{"external_registration_id":"EV-7","years_played":"0","skill_tier":"","rating":""}'::jsonb)
           ) AS r(n, p);

    SELECT string_agg(external_registration_id || '=' || COALESCE(years_played::text, '-') || '/' || COALESCE(skill_tier, '-') || '/' || COALESCE(rating::text, '-'),
                      ',' ORDER BY season_settings_id, external_registration_id)
      INTO v_state FROM public.players WHERE organization_id = v_org;

    -- The dry run: the counts, and not one write.
    v_dry := public.finalize_evaluation_import_job(v_job, '[]'::jsonb, true);
    IF (v_dry ->> 'status') <> 'preview' OR (v_dry ->> 'updated_players')::int <> 3
       OR (v_dry ->> 'unmatched_rows')::int <> 1 OR (v_dry ->> 'invalid_rows')::int <> 2
       OR (v_dry ->> 'unchanged_players')::int <> 1 THEN
        RAISE EXCEPTION 'the dry run did not count 3 to update, 1 up to date, 1 unmatched, 2 invalid: %', v_dry;
    END IF;
    SELECT string_agg(external_registration_id || '=' || COALESCE(years_played::text, '-') || '/' || COALESCE(skill_tier, '-') || '/' || COALESCE(rating::text, '-'),
                      ',' ORDER BY season_settings_id, external_registration_id)
      INTO v_got FROM public.players WHERE organization_id = v_org;
    IF v_got IS DISTINCT FROM v_state
       OR EXISTS (SELECT 1 FROM public.staging_import_rows WHERE import_job_id = v_job AND applied_at IS NOT NULL)
       OR (SELECT status FROM public.import_jobs WHERE id = v_job) <> 'importing' THEN
        RAISE EXCEPTION 'the dry run wrote something';
    END IF;
    RAISE NOTICE 'dry run: 3 players to update, 1 up to date, 1 unmatched, 2 invalid, and nothing written';

    -- The apply.
    v_result := public.finalize_evaluation_import_job(v_job);
    IF (v_result - 'status' - 'dry_run') IS DISTINCT FROM (v_dry - 'status' - 'dry_run') THEN
        RAISE EXCEPTION 'the apply''s counts are not the dry run''s: % vs %', v_result, v_dry;
    END IF;
    SELECT string_agg(external_registration_id || '=' || COALESCE(years_played::text, '-') || '/' || COALESCE(skill_tier, '-') || '/' || COALESCE(rating::text, '-'),
                      ',' ORDER BY external_registration_id)
      INTO v_got FROM public.players WHERE organization_id = v_org AND season_settings_id = v_active;
    IF v_got IS DISTINCT FROM '007=3/developing/4,7=-/-/-,EV-2=6/advanced/5,EV-3=2/novice/1,EV-5=8/novice/2,EV-7=0/-/-' THEN
        RAISE EXCEPTION 'the active season''s players are not as the file leaves them: %', v_got;
    END IF;
    RAISE NOTICE 'apply: 007 takes all three, a blank tier and rating leave EV-2''s alone, EV-3 stays, EV-5''s invalid row applied nothing, a zero is a value, 7 is not 007';

    IF (SELECT years_played::text || skill_tier || rating::text FROM public.players WHERE season_settings_id = v_draft AND external_registration_id = '007') <> '9advanced4'
       OR (SELECT years_played FROM public.players WHERE season_settings_id = v_past) <> 7 THEN
        RAISE EXCEPTION 'a registration id another season holds was read or written';
    END IF;
    IF (SELECT count(*) FROM public.players WHERE organization_id = v_org) <> 8
       OR EXISTS (SELECT 1 FROM public.players WHERE external_registration_id = 'NOBODY-1') THEN
        RAISE EXCEPTION 'the unmatched row created a player';
    END IF;
    IF (v_result -> 'unmatched') IS DISTINCT FROM '[{"source_row_number":4,"registration_id":"NOBODY-1"}]'::jsonb THEN
        RAISE EXCEPTION 'the unmatched row is not listed: %', v_result -> 'unmatched';
    END IF;
    RAISE NOTICE 'another season''s players untouched; the unmatched id is listed and created nobody';

    -- Audited, counts only.
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE resource_id = v_job AND action = 'import.completed' AND metadata ->> 'import_type' = 'evaluations'
       AND (metadata ->> 'updated_players')::int = 3 AND NOT (metadata ?| ARRAY['unmatched', 'invalid', 'duplicates'])
       AND metadata::text NOT LIKE '%NOBODY%';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'the apply was not audited once with counts and no ids (% rows)', v_n;
    END IF;
    IF (public.finalize_evaluation_import_job(v_job) ->> 'replayed') IS DISTINCT FROM 'true'
       OR (SELECT count(*) FROM public.audit_log WHERE resource_id = v_job AND action = 'import.completed') <> 1 THEN
        RAISE EXCEPTION 'a finished job did not answer with its stored result';
    END IF;
    RAISE NOTICE 'audited as import.completed with the counts and no registration ids; a second call replays the stored result';

    -- The same file again changes nothing, updated_at included.
    SELECT string_agg(p.id::text || p.updated_at::text, ',' ORDER BY p.id) INTO v_state FROM public.players p WHERE organization_id = v_org;
    v_result := public.finalize_evaluation_import_job(v_again);
    SELECT string_agg(p.id::text || p.updated_at::text, ',' ORDER BY p.id) INTO v_got FROM public.players p WHERE organization_id = v_org;
    IF (v_result ->> 'updated_players')::int <> 0 OR v_got IS DISTINCT FROM v_state THEN
        RAISE EXCEPTION 'importing the same file again changed something: %', v_result;
    END IF;
    RAISE NOTICE 're-import: no player to update, nothing rewritten';

    -- A season completed after its job was made is refused before anything is read or written.
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload)
    VALUES (v_org, v_past_job, 'evaluations', 1, '{}'::jsonb, '{"external_registration_id":"EV-2","years_played":"20"}'::jsonb);
    UPDATE public.season_settings SET status = 'completed' WHERE id = v_past;
    v_n := 0;
    BEGIN PERFORM public.finalize_evaluation_import_job(v_past_job, '[]'::jsonb, true);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_n := v_n + 1; END;
    BEGIN PERFORM public.finalize_evaluation_import_job(v_past_job);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_n := v_n + 1; END;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'only % of 2 calls on a completed season were refused 22023 (the dry run and the apply)', v_n;
    END IF;
    IF (SELECT years_played FROM public.players WHERE season_settings_id = v_past) <> 7
       OR (SELECT status FROM public.import_jobs WHERE id = v_past_job) <> 'importing' THEN
        RAISE EXCEPTION 'a refused call on a completed season wrote something';
    END IF;
    RAISE NOTICE 'a completed season is refused 22023, dry run and apply alike, and nothing is written';

    -- A stranger, and a job of another type.
    PERFORM set_config('request.jwt.claim.sub', v_stranger::text, true);
    v_n := 0;
    BEGIN PERFORM public.finalize_evaluation_import_job(v_again);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_n := v_n + 1; END;
    BEGIN PERFORM public.finalize_evaluation_import_job(v_again, '[]'::jsonb, true);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_n := v_n + 1; END;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    BEGIN PERFORM public.finalize_evaluation_import_job(v_reg_job);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_n := v_n + 1; END;
    IF v_n <> 3 THEN
        RAISE EXCEPTION 'only % of 3 refusals held (a stranger twice, a registration job once)', v_n;
    END IF;
    RAISE NOTICE 'a stranger is refused 42501; a registration job is not an evaluations job';

    -- The lifecycle accepts the type; the allowlist and retention exist.
    v_job := (public.create_import_job(v_org, 'evaluations', 'smoke-ev-cancel.csv')).id;
    IF (public.mark_import_job_ready_to_apply(v_job, 'evaluations') ->> 'status') <> 'ready_to_apply'
       OR (public.cancel_ready_import_job(v_job, 'evaluations') ->> 'status') <> 'canceled' THEN
        RAISE EXCEPTION 'an evaluations job could not be marked ready and cancelled';
    END IF;
    IF public.import_allowed_keys('evaluations') IS DISTINCT FROM ARRAY[
           'external_registration_id', 'gotsport_id', 'registration_id', 'player_id',
           'years_played', 'skill_tier', 'skill_level', 'rating']::text[] THEN
        RAISE EXCEPTION 'the SQL allowlist does not hold the evaluations keys';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-staging-evaluation-rows'
                    AND command LIKE '%import_type = ''evaluations''%' AND command LIKE '%30 days%') THEN
        RAISE EXCEPTION 'the evaluations retention job is missing';
    END IF;
    IF has_function_privilege('anon', 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.finalize_evaluation_import_job(uuid,jsonb,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the finalizer is not for signed-in callers only';
    END IF;
    RAISE NOTICE 'lifecycle: created, marked ready and cancelled as evaluations; allowlist and retention job present; signed-in callers only';
END;
$$;

ROLLBACK;
