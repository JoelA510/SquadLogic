-- Smoke checks for 20261021040000_utc_now_idiom.sql
--
-- Run against the fully migrated database, so they hold for every migration
-- after this one too:
--   * every public function whose body uses `timezone('utc', now())` (or the
--     same with clock_timestamp(), statement_timestamp(), transaction_timestamp()
--     or current_timestamp, or 'Etc/UTC', or `<clock> AT TIME ZONE 'utc'`) as a
--     timestamp is pinned `timezone=UTC`;
--     the deliberate UTC calendar date (`...)::date`) is exempt;
--   * no column default and no function argument default uses the idiom;
--   * under a session at UTC+14, a column default and trigger_set_timestamp
--     store the instant (within a minute of now()), and
--     fail_stale_import_jobs' default cutoff is five minutes before now at
--     UTC+14 and UTC-12 alike.
-- Wrapped in BEGIN ... ROLLBACK; every id is generated; no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_unpinned text;
    v_defaults text;
    v_args text;
    v_n integer;
BEGIN
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
      INTO v_unpinned
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosrc ~* '(timezone\s*\(\s*''(etc/)?utc''(\s*::\s*text)?\s*,\s*(now\s*\(\s*\)|clock_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\)|current_timestamp)\s*\)|(now\s*\(\s*\)|clock_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\)|current_timestamp)\s+at\s+time\s+zone\s+''(etc/)?utc'')(?!\)?\s*::\s*date)'
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c
                        WHERE lower(c) = 'timezone=utc');
    IF v_unpinned IS NOT NULL THEN
        RAISE EXCEPTION 'functions use timezone(''utc'', now()) as a timestamp without SET timezone = ''UTC'': %', v_unpinned;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c WHERE lower(c) = 'timezone=utc');
    IF v_n < 40 THEN
        RAISE EXCEPTION 'only % functions are pinned to UTC; the scan examined less than the migration pinned', v_n;
    END IF;
    RAISE NOTICE 'idiom: no function uses it as a timestamp unpinned (% pinned)', v_n;

    SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname) INTO v_defaults
      FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE c.relnamespace = 'public'::regnamespace
       AND pg_get_expr(d.adbin, d.adrelid) ~* 'timezone\(''(etc/)?utc''|at time zone ''(etc/)?utc''';
    IF v_defaults IS NOT NULL THEN
        RAISE EXCEPTION 'column defaults still use the idiom: %', v_defaults;
    END IF;
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_args FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND pg_get_function_arguments(p.oid) ~* 'timezone\(''(etc/)?utc''|at time zone ''(etc/)?utc''';
    IF v_args IS NOT NULL THEN
        RAISE EXCEPTION 'argument defaults still use the idiom: %', v_args;
    END IF;
    RAISE NOTICE 'idiom: no column default and no argument default uses it';
END;
$$;

SET LOCAL timezone = 'Pacific/Kiritimati';

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_fresh uuid := gen_random_uuid();
    v_stale uuid := gen_random_uuid();
    v_r jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
        VALUES (v_admin, 'utc-admin@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email, full_name) VALUES (v_admin, 'utc-admin@example.test', 'UTC Admin')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org UTC', 'smoke-org-utc') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    IF abs(extract(epoch FROM (SELECT created_at FROM public.organizations WHERE id = v_org) - now())) >= 60 THEN
        RAISE EXCEPTION 'a column default at UTC+14 stored %, not the instant %',
            (SELECT created_at FROM public.organizations WHERE id = v_org), now();
    END IF;
    UPDATE public.organizations SET updated_at = '2000-01-01' WHERE id = v_org;
    UPDATE public.organizations SET name = 'Smoke Org UTC 2' WHERE id = v_org;
    IF abs(extract(epoch FROM (SELECT updated_at FROM public.organizations WHERE id = v_org) - now())) >= 60 THEN
        RAISE EXCEPTION 'trigger_set_timestamp at UTC+14 stored %, not the instant', (SELECT updated_at FROM public.organizations WHERE id = v_org);
    END IF;
    RAISE NOTICE 'at UTC+14: a column default and trigger_set_timestamp store the instant';

    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, last_heartbeat_at) VALUES
        (v_fresh, v_org, 'registration', 'utc/fresh.csv', 'processing', v_admin, now() - interval '3 minutes'),
        (v_stale, v_org, 'registration', 'utc/stale.csv', 'processing', v_admin, now() - interval '10 minutes');
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('timezone', 'Etc/GMT+12', true);
    v_r := public.fail_stale_import_jobs(v_org);
    IF v_r->'job_ids' IS DISTINCT FROM jsonb_build_array(v_stale) THEN
        RAISE EXCEPTION 'at UTC-12 the default cutoff failed % (want only the 10-minute-old job)', v_r->'job_ids';
    END IF;
    UPDATE public.import_jobs SET status = 'processing', completed_at = NULL WHERE id = v_stale;
    PERFORM set_config('timezone', 'Pacific/Kiritimati', true);
    v_r := public.fail_stale_import_jobs(v_org);
    IF v_r->'job_ids' IS DISTINCT FROM jsonb_build_array(v_stale) THEN
        RAISE EXCEPTION 'at UTC+14 the default cutoff failed % (want only the 10-minute-old job)', v_r->'job_ids';
    END IF;
    RAISE NOTICE 'fail_stale_import_jobs: the default cutoff is five minutes before now at UTC-12 and UTC+14';
END;
$$;

ROLLBACK;
