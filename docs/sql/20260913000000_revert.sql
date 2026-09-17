-- Revert for 20260913000000_season_timezone_writer.sql
--
-- **Every behaviour this undoes, named.** This migration gave
-- `season_settings.timezone` its first writer, so the revert takes the writer
-- away again. What that costs is not abstract, because GAP-30 made a season
-- without a clock refuse to place slots rather than guess an instant.
--
--   1. **New organizations stop getting a season timezone.**
--      `initialize_new_tenant()` goes back to omitting the column from its
--      `season_settings` INSERT, and to accepting any `p_timezone` string
--      without validating it against `pg_timezone_names`. From the moment this
--      runs, every self-serve organization is created with a NULL season
--      timezone, which means a **disabled game scheduler** and a readiness
--      banner naming `SEASON_TIMEZONE_MISSING` with no UI able to fix it. The
--      value the admin typed still lands in `organizations.contact_info` and is
--      still read by nothing.
--   2. **The Settings timezone control stops persisting.**
--      `admin_set_season_timezone()` is dropped. `SeasonModule.jsx` calls it, so
--      after this revert that select raises `42883 undefined_function` on every
--      change unless the frontend is reverted with it. This is deliberate: a
--      silent no-op is what the control did before GAP-30, and re-creating a
--      silent no-op is what made the gap invisible for as long as it was.
--   3. **The restored columns are NOT dropped.** `20260913000000` re-added
--      `season_settings.timezone` and `school_day_end`, which
--      `20260331000000_definitive_schema` had dropped along with the table and
--      never re-created. Dropping them here would take the app's readers down
--      with them -- `practice-persistence` selects both in one statement -- and
--      would destroy operator data. A revert of a *writer* does not get to
--      delete a column.
--   4. **The backfill is NOT undone.** Rows this migration filled from
--      `organizations.contact_info` keep their timezone. Nothing rewrites
--      history, and blanking them would turn a revert of a *writer* into a
--      destruction of operator data — those values are correct and are the
--      only copy in a column anything reads. The count is printed below so the
--      operator knows how many rows stay populated with no live writer behind
--      them. To undo the backfill as well, see the commented statement at the
--      foot of this file; it is not run by default and it is not reversible.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop the Settings writer.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_set_season_timezone(uuid, uuid, text);
-- **Both arities.** `20260917000000` re-created this function with a fourth
-- `p_actor_context jsonb` argument, so on a database migrated past that point
-- the DROP above matches nothing and this revert would report success over a
-- writer still standing -- the silent-no-op shape
-- `docs/sql/reverts/20260504060000` was fixed for. Naming the later signature
-- here keeps this revert correct at head as well as at its own migration.
DROP FUNCTION IF EXISTS public.admin_set_season_timezone(uuid, uuid, text, jsonb);

-- ---------------------------------------------------------------------------
-- 2. Restore `initialize_new_tenant` to its 20260416000001 definition, verbatim.
-- ---------------------------------------------------------------------------
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
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    INSERT INTO public.organizations (name, slug, contact_info)
    VALUES (
        p_name,
        p_slug,
        jsonb_build_object('timezone', p_timezone)
    )
    RETURNING id INTO v_org_id;

    INSERT INTO public.organization_members (organization_id, profile_id, role)
    VALUES (v_org_id, v_user_id, 'admin');

    INSERT INTO public.season_settings (
        organization_id,
        name,
        status,
        season_year,
        season_label
    )
    VALUES (
        v_org_id,
        p_season_year::text || ' Season',
        'active',
        p_season_year,
        p_season_year::text || ' Season'
    );

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_audit_event') THEN
        PERFORM public.record_audit_event(
            v_org_id,
            'settings.updated',
            'organization',
            v_org_id,
            jsonb_build_object('action', 'initialization', 'creator', v_user_id)
        );
    END IF;

    RETURN v_org_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Report what stays behind.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_populated bigint;
    v_null bigint;
BEGIN
    SELECT count(*) FILTER (WHERE timezone IS NOT NULL),
           count(*) FILTER (WHERE timezone IS NULL)
      INTO v_populated, v_null
      FROM public.season_settings;

    RAISE NOTICE 'season_settings.timezone after revert: % populated (no live writer), % null (game scheduling disabled for those seasons)',
        v_populated, v_null;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- NOT RUN. Undoing the backfill as well is destructive and one-way: the jsonb
-- source may itself have been edited since, so this cannot be replayed to get
-- the same values back. Uncomment only with the operator's explicit say-so.
--
--   UPDATE public.season_settings SET timezone = NULL;
-- ---------------------------------------------------------------------------
