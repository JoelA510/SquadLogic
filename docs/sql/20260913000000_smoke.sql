-- Smoke checks for 20260913000000_season_timezone_writer.sql
--
-- **These ASSERT rather than report.** A smoke made of bare SELECTs exits 0
-- whatever it prints. Invariants RAISE, so `scripts/dbharness/prove.sh` can
-- prove they fail when the defect is planted.
--
-- The one thing this file exists to prove: **`season_settings.timezone` has a
-- writer.** It had none from `20251214000002` until this migration — the column
-- was read by three surfaces and written by nothing, and the pre-migration
-- `initialize_new_tenant` fails section 2 rather than shipping.
--
-- Section 1 is the check that would have caught the original gap, and it is
-- written the way CLAUDE.md §3 asks: **the subject set is enumerated from the
-- writers, not from the readers or from the tests.** A check that asked "does
-- anything read this column" would have passed happily for nine months.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. The columns exist at all
-- ---------------------------------------------------------------------------
--
-- First, because everything below assumes it and because it was false: the
-- table was dropped and recreated by `20260331000000_definitive_schema` without
-- `timezone` or `school_day_end`, and nothing re-added them. pgTAP found this,
-- not a reading of the file.
DO $$
DECLARE
    v_missing text[];
BEGIN
    SELECT array_agg(c)
      INTO v_missing
      FROM unnest(ARRAY['timezone', 'school_day_end']) AS c
     WHERE NOT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'season_settings'
            AND column_name = c
     );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'season_settings is missing %; the app reads both and practice-persistence selects them in one query', v_missing;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. The column is written by at least one live function, read from prosrc
-- ---------------------------------------------------------------------------
--
-- `prosrc`, not `pg_get_functiondef`: a DEFAULT renders inside the SIGNATURE,
-- and a definition split on a body marker can put signature text where a guard
-- was expected, which makes the guard unable to fail at all.
DO $$
DECLARE
    v_writers int;
BEGIN
    SELECT count(*)
      INTO v_writers
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~* 'season_settings'
       AND p.prosrc ~* 'timezone'
       AND (p.prosrc ~* 'INSERT\s+INTO\s+public\.season_settings'
            OR p.prosrc ~* 'UPDATE\s+public\.season_settings');

    IF v_writers < 2 THEN
        RAISE EXCEPTION
            'season_settings.timezone has % writer(s); expected at least 2 (initialize_new_tenant, admin_set_season_timezone). A column three surfaces read and nothing writes is GAP-30 all over again.',
            v_writers;
    END IF;

    RAISE NOTICE 'season_settings.timezone writers found: %', v_writers;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. initialize_new_tenant names the column in its season_settings INSERT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_src text;
BEGIN
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'initialize_new_tenant';

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'initialize_new_tenant is missing';
    END IF;

    -- The INSERT column list must carry `timezone`. Before this migration the
    -- function took p_timezone, wrote it to organizations.contact_info, and
    -- omitted it here -- which is the whole defect.
    IF v_src !~* 'INSERT\s+INTO\s+public\.season_settings\s*\([^)]*timezone' THEN
        RAISE EXCEPTION
            'initialize_new_tenant does not write season_settings.timezone. Every self-serve org would be created with a null season clock and a disabled game scheduler.';
    END IF;

    IF v_src !~* 'pg_timezone_names' THEN
        RAISE EXCEPTION
            'initialize_new_tenant does not validate p_timezone against pg_timezone_names; a typo would store and then refuse every slot at read time.';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. admin_set_season_timezone exists, is locked down, and is admin-gated
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_src text;
    v_secdef boolean;
    v_config text[];
BEGIN
    SELECT p.prosrc, p.prosecdef, p.proconfig
      INTO v_src, v_secdef, v_config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'admin_set_season_timezone';

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'admin_set_season_timezone is missing; the Settings control has no writer';
    END IF;

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'admin_set_season_timezone must be SECURITY DEFINER';
    END IF;

    IF v_config IS NULL OR NOT (v_config && ARRAY['search_path=public']) THEN
        RAISE EXCEPTION
            'admin_set_season_timezone must SET search_path = public (LESSONS_LEARNED #1; check:advisors enforces this statically too)';
    END IF;

    IF v_src !~* 'is_org_admin' THEN
        RAISE EXCEPTION 'admin_set_season_timezone must gate on is_org_admin()';
    END IF;

    IF v_src !~* 'pg_timezone_names' THEN
        RAISE EXCEPTION 'admin_set_season_timezone must validate the zone against pg_timezone_names';
    END IF;

    IF v_src !~* 'record_audit_event' THEN
        RAISE EXCEPTION 'admin_set_season_timezone must audit (CLAUDE.md: audit immutability)';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. anon cannot execute the writer
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF has_function_privilege('anon', 'public.admin_set_season_timezone(uuid, uuid, text)', 'EXECUTE') THEN
        RAISE EXCEPTION
            'anon can EXECUTE admin_set_season_timezone; a definer function that writes org state must not be reachable anonymously (LESSONS_LEARNED #5)';
    END IF;

    IF NOT has_function_privilege('authenticated', 'public.admin_set_season_timezone(uuid, uuid, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated cannot EXECUTE admin_set_season_timezone; the Settings control would fail for every admin';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The backfill left no row whose organization knew its zone
-- ---------------------------------------------------------------------------
--
-- **Meta-assertion first.** A backfill check over an empty universe passes
-- while proving nothing, so this refuses to run silently on a database with no
-- organizations carrying a recognised zone.
DO $$
DECLARE
    v_universe bigint;
    v_missed bigint;
BEGIN
    SELECT count(*)
      INTO v_universe
      FROM public.season_settings ss
      JOIN public.organizations o ON o.id = ss.organization_id
     WHERE btrim(COALESCE(o.contact_info->>'timezone', '')) <> ''
       AND EXISTS (SELECT 1 FROM pg_timezone_names t WHERE t.name = o.contact_info->>'timezone');

    IF v_universe = 0 THEN
        RAISE NOTICE 'backfill check examined 0 rows: no organization carries a recognised contact_info timezone. Not a pass -- there was nothing to back-fill.';
        RETURN;
    END IF;

    SELECT count(*)
      INTO v_missed
      FROM public.season_settings ss
      JOIN public.organizations o ON o.id = ss.organization_id
     WHERE ss.timezone IS NULL
       AND btrim(COALESCE(o.contact_info->>'timezone', '')) <> ''
       AND EXISTS (SELECT 1 FROM pg_timezone_names t WHERE t.name = o.contact_info->>'timezone');

    IF v_missed > 0 THEN
        RAISE EXCEPTION
            'backfill left % of % season(s) null whose organization carries a recognised timezone', v_missed, v_universe;
    END IF;

    RAISE NOTICE 'backfill check examined % season(s); none left null with a recoverable zone', v_universe;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Every stored zone is one this server recognises
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_bad bigint;
BEGIN
    SELECT count(*)
      INTO v_bad
      FROM public.season_settings ss
     WHERE ss.timezone IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_timezone_names t WHERE t.name = ss.timezone);

    IF v_bad > 0 THEN
        RAISE EXCEPTION
            '% season(s) carry a timezone this server cannot resolve; those seasons will refuse every slot with SEASON_TIMEZONE_UNKNOWN', v_bad;
    END IF;
END;
$$;
