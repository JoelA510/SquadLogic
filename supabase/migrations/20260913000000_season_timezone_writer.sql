-- ==========================================
-- GAP-30: give season_settings.timezone a writer
-- ==========================================
--
-- `season_settings.timezone` has existed since `20251214000002` and **nothing
-- has ever written it**. Enumerated from the writers rather than from the
-- readers, which is how it stayed invisible: the column is read by
-- `GameSchedulingPage`, `PracticeSchedulingPage` and `calendar-feed`, and every
-- one of them was reading a NULL that the browser's zone quietly stood in for.
--
-- `initialize_new_tenant()` takes `p_timezone`, the onboarding form requires it,
-- and the value lands in `organizations.contact_info` as jsonb that nothing
-- reads back. Settings -> Season -> Timezone wrote `localStorage` and an audit
-- row, never a column.
--
-- With GAP-30 a season without a clock refuses to place slots rather than
-- guessing an instant, so this is no longer a latent gap: without a writer,
-- every self-serve organization would get a disabled game scheduler and a
-- message telling the operator to set a field no UI persists.
--
-- Three parts:
--   1. `initialize_new_tenant()` writes the timezone it is already given.
--   2. A **one-time** backfill from `organizations.contact_info` for rows that
--      predate this. Deliberately once, in the migration: a read-time
--      `contact_info->>'timezone'` fallback would be a second answer to the
--      same question, and two sources of truth for a season's clock is the
--      drift this whole gap is made of.
--   3. `admin_set_season_timezone()` so the Settings control persists.
--
-- The zone is validated against `pg_timezone_names`, not merely non-empty.
-- Storing `Americas/New_York` would satisfy a NOT NULL check and then refuse
-- every slot at read time with a confusing reason; refusing it at the write is
-- the same "refuse, do not guess" rule one layer earlier.

BEGIN;

-- --------------------------------------------------------------------------
-- 0. The column has to exist first. On a fresh database it does not.
--
-- Found by pgTAP, not by reading: `20251214000002` added `timezone` and
-- `school_day_end` to `season_settings`, and `20260331000000_definitive_schema`
-- then DROPped the table (its guard at `:74-82` fires when `season_settings.id`
-- is still `bigint`, which `20251208000000` made it) and recreated it at
-- `:260-274` **without either column**. Nothing re-adds them. So on CI, on
-- pgTAP, on `test:db:local` and on any new Supabase project the columns are
-- absent, while a database already migrated to uuid ids before `20260331`
-- landed kept them.
--
-- `IF NOT EXISTS` is what makes this correct in both worlds, which matters
-- because which world production is in is not answerable from the repository.
--
-- **`school_day_end` comes back too, and that is not scope creep.** The two
-- were lost together by one accident, and `practice-persistence/index.ts:112`
-- does `.select('timezone, school_day_end')` — one query, both columns. Adding
-- only `timezone` would leave that select failing on the missing sibling, so
-- the column I am restoring still would not be readable there.
-- --------------------------------------------------------------------------
ALTER TABLE public.season_settings
    ADD COLUMN IF NOT EXISTS timezone text;

ALTER TABLE public.season_settings
    ADD COLUMN IF NOT EXISTS school_day_end time DEFAULT '16:00';

COMMENT ON COLUMN public.season_settings.timezone IS
    'IANA zone name. The season''s clock: the one zone a wall time is placed on (GAP-30). Null means the season has no clock and game scheduling refuses rather than guessing the host''s zone.';

-- --------------------------------------------------------------------------
-- 1. The onboarding RPC writes the timezone it already receives.
--
-- Replaced wholesale from the latest full revision (`20260416000001`) rather
-- than patched, per LESSONS_LEARNED #11.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.initialize_new_tenant(
    p_name text,
    p_slug text,
    p_timezone text,
    p_season_year integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
    v_user_id uuid;
    v_timezone text := btrim(COALESCE(p_timezone, ''));
BEGIN
    -- Get calling user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- A season with no clock cannot place a slot on one (GAP-30), so the
    -- timezone is required here rather than defaulted. The onboarding form
    -- already requires it; this is the database agreeing.
    IF v_timezone = '' THEN
        RAISE EXCEPTION 'p_timezone is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_timezone) THEN
        RAISE EXCEPTION 'Unknown IANA timezone: %', v_timezone
            USING ERRCODE = '22023';
    END IF;

    -- Create Organization
    INSERT INTO public.organizations (name, slug, contact_info)
    VALUES (
        p_name,
        p_slug,
        jsonb_build_object('timezone', v_timezone)
    )
    RETURNING id INTO v_org_id;

    -- Assign Caller as Admin
    INSERT INTO public.organization_members (organization_id, profile_id, role)
    VALUES (v_org_id, v_user_id, 'admin');

    -- Create Initial Season Settings
    -- Note: season_settings status is draft until confirmed by user usually,
    -- but we set to 'active' for immediate use in self-serve flow if intended.
    INSERT INTO public.season_settings (
        organization_id,
        name,
        status,
        season_year,
        season_label,
        timezone
    )
    VALUES (
        v_org_id,
        p_season_year::text || ' Season',
        'active',
        p_season_year,
        p_season_year::text || ' Season',
        v_timezone
    );

    -- record auditing
    -- Ensure record_audit_event exists before calling
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_audit_event') THEN
        PERFORM public.record_audit_event(
            v_org_id,
            'settings.updated',
            'organization',
            v_org_id,
            jsonb_build_object(
                'action', 'initialization',
                'creator', v_user_id,
                'timezone', v_timezone
            )
        );
    END IF;

    RETURN v_org_id;
END;
$$;

-- --------------------------------------------------------------------------
-- 2. One-time backfill, from the jsonb blob the value was being parked in.
--
-- Only rows that have no timezone and whose organization's stored value is a
-- zone this server recognises. A row that cannot be backfilled is left NULL on
-- purpose: the app surfaces SEASON_TIMEZONE_MISSING and an operator sets it,
-- which is the honest outcome. Inventing UTC here would put a wrong instant in
-- a timestamptz, which is the defect, not the fix.
-- --------------------------------------------------------------------------
UPDATE public.season_settings ss
   SET timezone = o.contact_info->>'timezone'
  FROM public.organizations o
 WHERE ss.organization_id = o.id
   AND ss.timezone IS NULL
   AND btrim(COALESCE(o.contact_info->>'timezone', '')) <> ''
   AND EXISTS (
       SELECT 1 FROM pg_timezone_names tzn
        WHERE tzn.name = o.contact_info->>'timezone'
   );

-- --------------------------------------------------------------------------
-- 3. The Settings control's writer.
--
-- Narrow and audited, like `admin_upsert_division_settings` beside it: the
-- browser does not UPDATE `season_settings` directly.
-- --------------------------------------------------------------------------
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

GRANT EXECUTE ON FUNCTION public.admin_set_season_timezone(uuid, uuid, text) TO authenticated;

COMMIT;
