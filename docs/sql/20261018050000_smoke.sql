-- Smoke checks for 20261018050000_create_import_job_no_file_name.sql
--
-- What it proves, as an administrator of the organization (prelude.sql stubs
-- `auth.uid()` from `request.jwt.claim.sub`):
--   * `create_import_job` writes exactly one `import.started` row for the job
--     it creates, attributed to the caller, and that row's metadata has no
--     `file_name` key; it still carries import_type, job_type and status, so a
--     check that only looked for an absent key cannot pass on an empty row;
--   * the file name still forms the job's `storage_path`, sanitised as before
--     (`/`, `\` and `:` become `_`), because the import reads that path back;
--   * a coach of the organization (a member, not an admin) is still refused
--     with 42501 and no job is created;
--   * the function is still SECURITY DEFINER with search_path=public, callable
--     by `authenticated` and not by `anon`.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_org uuid;
    v_job public.import_jobs%ROWTYPE;
    v_rows integer;
    v_meta jsonb;
    v_user uuid;
    v_code text;
    v_jobs_before integer;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'import-admin@example.test', '{"password_length": 16}'),
        (v_coach, 'import-coach@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'import-admin@example.test'),
        (v_coach, 'import-coach@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Import', 'smoke-org-import')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'),
        (v_org, v_coach, 'coach');

    -- (a) The admin's import: one import.started row, no file name in it.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    v_job := public.create_import_job(v_org, 'players', '../spring:players.csv');

    SELECT count(*), max(metadata::text)::jsonb, max(user_id::text)::uuid
      INTO v_rows, v_meta, v_user
      FROM public.audit_log
     WHERE action = 'import.started' AND resource_type = 'import_job' AND resource_id = v_job.id;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'create_import_job wrote % import.started row(s) for its job, expected 1', v_rows;
    END IF;
    IF v_user IS DISTINCT FROM v_admin THEN
        RAISE EXCEPTION 'the import.started row is not attributed to the caller: %', v_user;
    END IF;
    IF v_meta ? 'file_name' THEN
        RAISE EXCEPTION 'the import.started row still stores the file name: %', v_meta;
    END IF;
    IF v_meta IS DISTINCT FROM jsonb_build_object(
           'import_type', 'players', 'job_type', 'registration', 'status', 'importing') THEN
        RAISE EXCEPTION 'the import.started metadata is not import_type, job_type and status: %', v_meta;
    END IF;
    RAISE NOTICE 'an admin''s import writes 1 import.started row, attributed to the caller, with import_type, job_type and status and no file_name';

    -- (b) The file name still forms the storage path, sanitised as before.
    IF v_job.storage_path IS DISTINCT FROM format('imports/%s/.._spring_players.csv', v_admin) THEN
        RAISE EXCEPTION 'the job''s storage_path is not the sanitised file name under the caller: %', v_job.storage_path;
    END IF;
    RAISE NOTICE 'the job''s storage_path still carries the sanitised file name (imports/<caller>/.._spring_players.csv)';

    -- (c) A coach is still refused, and nothing is created.
    SELECT count(*) INTO v_jobs_before FROM public.import_jobs WHERE organization_id = v_org;
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    v_code := NULL;
    BEGIN
        PERFORM public.create_import_job(v_org, 'players', 'coach.csv');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION 'a coach''s create_import_job was not refused 42501 (got %)', coalesce(v_code, 'success');
    END IF;
    IF (SELECT count(*) FROM public.import_jobs WHERE organization_id = v_org) <> v_jobs_before THEN
        RAISE EXCEPTION 'a refused coach import still created a job';
    END IF;
    RAISE NOTICE 'a coach''s create_import_job is refused 42501 and creates no job';

    -- (d) The posture is unchanged.
    IF NOT (SELECT p.prosecdef AND COALESCE(p.proconfig, '{}') <@ ARRAY['search_path=public','TimeZone=UTC'] AND 'search_path=public' = ANY (COALESCE(p.proconfig, '{}'))
              FROM pg_proc p
             WHERE p.oid = 'public.create_import_job(uuid, text, text)'::regprocedure) THEN
        RAISE EXCEPTION 'create_import_job lost SECURITY DEFINER or search_path=public';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.create_import_job(uuid, text, text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.create_import_job(uuid, text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'create_import_job''s grants changed: authenticated must execute it and anon must not';
    END IF;
    RAISE NOTICE 'create_import_job is SECURITY DEFINER with search_path=public, executable by authenticated and not by anon';
END;
$$;

ROLLBACK;
