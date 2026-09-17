-- Revert for 20260917000000_season_timezone_actor_context.sql
--
-- **What this undoes, named.**
--
--   1. **An impersonated timezone change stops being recorded as one.** The
--      four-argument `admin_set_season_timezone()` is dropped and the
--      three-argument `20260913000000` body is restored. From the moment this
--      runs, `settings.timezone_updated` carries only `timezone` and
--      `previous_timezone`; nothing in `audit_log` will say that an admin
--      viewing as another profile made the change. The rows already written
--      keep their context -- this is a revert of a writer, not of history.
--   2. **The frontend breaks unless it is reverted with this.**
--      `SeasonModule.jsx` sends `p_actor_context`, and PostgREST resolves an
--      RPC by its named arguments, so that call answers `404` /
--      `PGRST202` against the restored three-argument function. Deliberately
--      loud: the alternative is keeping a four-argument overload standing so
--      the call silently keeps working, which would make this revert a
--      no-op wearing a DROP.
--   3. **Nothing about the column, the backfill or `initialize_new_tenant` is
--      touched.** Those belong to `20260913000000` and its own revert.
--
-- Order matters: the DROP comes first, because CREATE OR REPLACE cannot change
-- a function's argument list and the two arities would otherwise both stand.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Report what the rollback costs, counted rather than asserted.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_context bigint;
BEGIN
    SELECT count(*)
      INTO v_context
      FROM public.audit_log
     WHERE action = 'settings.timezone_updated'
       AND metadata ? 'target_user_id';

    RAISE NOTICE 'LOSING impersonation context on future timezone changes. % existing settings.timezone_updated row(s) carry it and are left untouched; from now on none will.',
        v_context;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Drop the four-argument writer.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_set_season_timezone(uuid, uuid, text, jsonb);

-- ---------------------------------------------------------------------------
-- 3. Restore 20260913000000's three-argument definition, verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_season_timezone(
    p_organization_id uuid,
    p_season_settings_id uuid,
    p_timezone text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_season_org_id uuid;
    v_previous text;
    v_timezone text := btrim(COALESCE(p_timezone, ''));
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'p_season_settings_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_timezone = '' THEN
        RAISE EXCEPTION 'p_timezone is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_timezone) THEN
        RAISE EXCEPTION 'Unknown IANA timezone: %', v_timezone
            USING ERRCODE = '22023';
    END IF;

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT ss.organization_id, ss.timezone
      INTO v_season_org_id, v_previous
      FROM public.season_settings ss
     WHERE ss.id = p_season_settings_id;

    IF v_season_org_id IS NULL THEN
        RAISE EXCEPTION 'Season settings not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_org_id <> p_organization_id THEN
        RAISE EXCEPTION 'Season settings do not belong to organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.season_settings
       SET timezone = v_timezone
     WHERE id = p_season_settings_id;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.timezone_updated',
        'season_settings',
        p_season_settings_id,
        jsonb_build_object(
            'timezone', v_timezone,
            'previous_timezone', v_previous
        )
    );

    RETURN jsonb_build_object(
        'season_settings_id', p_season_settings_id,
        'timezone', v_timezone,
        'previous_timezone', v_previous,
        'changed', v_previous IS DISTINCT FROM v_timezone
    );
END;
$$;

COMMENT ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text) IS
    'Admin-only org-scoped writer for season_settings.timezone, validated against pg_timezone_names and audited as settings.timezone_updated (GAP-30).';

REVOKE ALL ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Prove the restore, from the catalogue rather than from the CREATE parsing.
--
-- Enumerated by the ways this can be wrong rather than the one way it can be
-- right, the shape `docs/sql/reverts/20260504060000` earned: GONE (the DROP
-- took the name with it), AMBIGUOUS (both arities standing, so a four-argument
-- call keeps working and this revert is a no-op wearing a DROP), or
-- STILL-CONTEXTUAL (the restored body still merges an actor context, which
-- means the CREATE OR REPLACE did nothing).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_count int;
    v_args text;
    v_ctx boolean;
BEGIN
    SELECT count(*),
           COALESCE(max(oidvectortypes(p.proargtypes)), ''),
           COALESCE(bool_or(p.prosrc LIKE '%p_actor_context%'), false)
      INTO v_count, v_args, v_ctx
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'admin_set_season_timezone';

    IF v_count = 0 THEN
        RAISE EXCEPTION 'admin_set_season_timezone is GONE after the revert; the Settings control has no writer at all';
    END IF;
    IF v_count > 1 THEN
        RAISE EXCEPTION 'admin_set_season_timezone is AMBIGUOUS after the revert (% overloads); the four-argument path is still callable', v_count;
    END IF;
    IF v_ctx THEN
        RAISE EXCEPTION 'admin_set_season_timezone still reads p_actor_context after the revert; the restore was a no-op';
    END IF;
    IF v_args <> 'uuid, uuid, text' THEN
        RAISE EXCEPTION 'admin_set_season_timezone came back as (%), wanted (uuid, uuid, text)', v_args;
    END IF;

    RAISE NOTICE 'admin_set_season_timezone restored as (%), with no actor context', v_args;
END;
$$;

COMMIT;
