-- ==========================================
-- GAP-30 follow-up: one complete audit row for a timezone change
-- ==========================================
--
-- `20260913000000` moved the timezone audit row **inside**
-- `admin_set_season_timezone()`, atomically with the column, which was right.
-- What it did not do was remove the `record_audit_event` that `SeasonModule.jsx`
-- fired beside the RPC under impersonation -- so an impersonated change wrote
-- TWO rows of the SAME action, and neither of them was complete:
--
--   * the RPC's row carried `previous_timezone` and said nothing about the
--     impersonation;
--   * the client's row carried `target_user_id` / `impersonated_by` /
--     `admin_email` and said nothing about what the value had been.
--
-- An auditor reading either one alone gets a true statement and an incomplete
-- one, and there is nothing in `audit_log` tying the pair together. CLAUDE.md
-- calls for state-altering actions to be captured "with full metadata"; two
-- half-rows is not that.
--
-- ## What this changes
--
-- `admin_set_season_timezone()` gains a fourth argument, `p_actor_context`, and
-- the client stops writing its own row. The signature change is why the
-- three-argument function is DROPped rather than replaced: a defaulted fourth
-- argument alongside the old arity makes a three-argument call ambiguous
-- (42725), and leaving the old one callable would leave the un-audited path
-- standing next to the audited one.
--
-- ## Why the client sends only `target_user_id`
--
-- Impersonation in this app is client-side "view as": `auth.uid()` stays the
-- ADMIN throughout (`AuthContext.jsx` swaps `user.profile`, never the session),
-- so the server already knows who is acting -- it is `audit_log.user_id`. The
-- one fact it cannot know is **whose account was on screen**. So that is the
-- only key accepted, `impersonated_by` is taken from `auth.uid()` and the
-- admin's email is read from `profiles`. A client-asserted actor in an audit
-- row is decoration; these two are derived where they can be derived, which is
-- also why a caller cannot use this argument to write arbitrary metadata.
--
-- Reversible: see docs/sql/20260917000000_revert.sql.
-- Smoke checks: see docs/sql/20260917000000_smoke.sql.

BEGIN;

-- --------------------------------------------------------------------------
-- 1. Drop the three-argument writer.
--
-- `IF EXISTS` because a database reverted to before `20260913000000` and then
-- re-migrated has already lost it; this must not be the statement that fails.
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_set_season_timezone(uuid, uuid, text);

-- --------------------------------------------------------------------------
-- 2. Recreate it with the actor context.
--
-- The body is `20260913000000`'s, unchanged except for the metadata it audits:
-- the same validation order, the same error codes, the same return shape. It
-- is repeated in full rather than patched because a function body cannot be
-- patched -- and repeating it is what makes the diff of what actually changed
-- readable.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_season_timezone(
    p_organization_id uuid,
    p_season_settings_id uuid,
    p_timezone text,
    p_actor_context jsonb DEFAULT '{}'::jsonb
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
    v_context jsonb := COALESCE(p_actor_context, '{}'::jsonb);
    v_target uuid;
    v_admin_email text;
    v_actor jsonb := '{}'::jsonb;
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

    IF jsonb_typeof(v_context) <> 'object' THEN
        RAISE EXCEPTION 'p_actor_context must be a JSON object'
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

    -- **Refuse a malformed target rather than dropping it.** A `target_user_id`
    -- that is not a uuid is a caller bug, and silently writing the audit row
    -- without it is how an impersonated change comes to look like a direct one.
    IF btrim(COALESCE(v_context->>'target_user_id', '')) <> '' THEN
        BEGIN
            v_target := (v_context->>'target_user_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'p_actor_context.target_user_id is not a uuid: %',
                v_context->>'target_user_id'
                USING ERRCODE = '22023';
        END;
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

    IF v_target IS NOT NULL THEN
        SELECT p.email INTO v_admin_email FROM public.profiles p WHERE p.id = auth.uid();
        v_actor := jsonb_strip_nulls(jsonb_build_object(
            'target_user_id', v_target,
            'impersonated_by', auth.uid(),
            'admin_email', v_admin_email
        ));
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.timezone_updated',
        'season_settings',
        p_season_settings_id,
        jsonb_build_object(
            'timezone', v_timezone,
            'previous_timezone', v_previous
        ) || v_actor
    );

    RETURN jsonb_build_object(
        'season_settings_id', p_season_settings_id,
        'timezone', v_timezone,
        'previous_timezone', v_previous,
        'changed', v_previous IS DISTINCT FROM v_timezone
    );
END;
$$;

COMMENT ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text, jsonb) IS
    'Admin-only org-scoped writer for season_settings.timezone, validated against pg_timezone_names and audited as settings.timezone_updated in ONE row carrying both the previous value and, when the caller is viewing as another profile, the impersonation context (GAP-30 follow-up).';

-- **Explicit, not inherited** -- the same reasoning `20260913000000` records:
-- `20260614000000` sets ALTER DEFAULT PRIVILEGES `FOR ROLE postgres`, so a
-- function created by any other role still lands with PUBLIC EXECUTE. The
-- dropped three-argument function's grants went with it, so these are not
-- inherited from it either.
REVOKE ALL ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text, jsonb) TO authenticated;

COMMIT;
