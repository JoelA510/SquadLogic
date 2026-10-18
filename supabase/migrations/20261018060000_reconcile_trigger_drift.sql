-- Reconcile the trigger and function drift between a fresh build and
-- production (docs/operations/schema-drift-2026-10.md, section 5; approved by
-- the owner on 2026-10-18 with every recommendation as written: Q1 to Q5).
--
-- **Why.** Production's early schema was applied through the MCP connector
-- and its ledger re-keyed afterwards; a fresh build replays the repository,
-- where 20260331000000_definitive_schema's fresh-replay reset drops the
-- interim tables CASCADE and silently loses every trigger the earlier files
-- had put on them. So the two sides were never the same schema:
--
--   * only on a fresh build: `set_updated_at()`, `ensure_assistant_coach_ids_valid()`
--     and `ensure_game_team_consistency()`, three functions nothing calls;
--   * only in production: 15 `set_org_id_*` triggers, `set_scheduler_runs_created_by`,
--     `trigger_manage_field_subunits` (which hard-deletes a field's
--     sub-surfaces, their practice slots and those slots' assignments whenever
--     a field is saved with halves off, with no audit row and past the
--     retirement and booking guards), and a second `persist_evaluation_run`
--     overload whose argument names collide with the real one's (PGRST203).
--
-- **One file, right on both sides.** Every statement is a no-op wherever its
-- side already matches the target: `DROP ... IF EXISTS` for what only one
-- side has, and the two field RPCs replaced wholesale (lesson 11, copied from
-- 20260504060000, the only migration that defines them; production's bodies
-- read back identical, md5 of prosrc, 2026-10-18).
--
-- **Function drops carry no CASCADE.** If anything still depended on one of
-- them (a trigger this file does not know about), the drop fails and the
-- deploy stops, rather than taking the dependant with it. Function BODIES do
-- not record a dependency in pg_depend, so the block before the drops searches
-- every `public` function body for the names and refuses if one mentions them. Read back from production on 2026-10-18 (read-only): the
-- only users of `propagate_org_id_from_*`, `handle_field_subunits` and
-- `set_created_by_to_auth_uid` are the 17 triggers dropped here; no function
-- body, view, policy or event trigger names them. The same on a fresh build.
--
-- **`set_created_by_to_auth_uid()` goes too.** The plan keeps a function only
-- if something still uses it; after `set_scheduler_runs_created_by` nothing
-- does, on either side. Both Edge writers set `scheduler_runs.created_by`
-- themselves (auto-scheduler, fairness-scoring).
--
-- **Sub-surfaces: insert-only (Q1).** `admin_create_field` and
-- `admin_update_field` now ensure sub-surfaces `A` and `B` exist whenever the
-- saved field has halves on (`ON CONFLICT (field_id, label) DO NOTHING`, so a
-- retired one stays retired), and say which they created in the audit row.
-- Switching halves off deletes nothing: a sub-surface leaves through
-- `admin_retire_field_subunit`, which refuses while it has bookings.
--
-- Not in this file: the field import apply (20260909000000) writes
-- `supports_halves` and, in production only, relied on the trigger for `A` and
-- `B`; a field imported with halves now gets none until an admin saves it
-- (recorded in the remediation plan, "Discovered during execution").
--
-- Reversible: docs/sql/20261018060000_revert.sql (recreates production's
-- objects exactly as read back). Smoke: docs/sql/20261018060000_smoke.sql.
-- The drift check that keeps this closed: supabase/catalog-snapshot.json,
-- regenerated and compared by scripts/dbharness/run.sh.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nothing but the triggers dropped below may use the functions dropped below
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    v_users text;
BEGIN
    -- `public` only: it is the schema these functions live in and the only one
    -- this repository writes; Supabase's own schemas are not ours to judge. The
    -- names are matched as text (strpos, no LIKE wildcards), and only the
    -- functions being dropped are exempt from mentioning them.
    SELECT string_agg(DISTINCT format('%I.%I mentions %s', n.nspname, p.proname, m.name), '; ')
      INTO v_users
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN (VALUES ('propagate_org_id_from_'), ('handle_field_subunits'),
                        ('set_created_by_to_auth_uid'), ('set_updated_at'),
                        ('ensure_assistant_coach_ids_valid'), ('ensure_game_team_consistency')) AS m(name)
     WHERE n.nspname = 'public'
       AND strpos(p.prosrc, m.name) > 0
       AND p.proname NOT IN ('propagate_org_id_from_field', 'propagate_org_id_from_team',
                             'propagate_org_id_from_home_team', 'propagate_org_id_from_import_job',
                             'propagate_org_id_from_player', 'propagate_org_id_from_season_settings',
                             'propagate_org_id_from_scheduler_run', 'propagate_org_id_from_evaluation_run',
                             'propagate_org_id_from_export_job', 'handle_field_subunits',
                             'set_created_by_to_auth_uid', 'set_updated_at',
                             'ensure_assistant_coach_ids_valid', 'ensure_game_team_consistency');
    IF v_users IS NOT NULL THEN
        RAISE EXCEPTION 'reconcile_trigger_drift: a function body still uses a function this migration drops: %', v_users;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The three orphans only a fresh build has (production has none of them)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_updated_at();
DROP FUNCTION IF EXISTS public.ensure_assistant_coach_ids_valid();
DROP FUNCTION IF EXISTS public.ensure_game_team_consistency();

-- ---------------------------------------------------------------------------
-- 2. The persist_evaluation_run overload only production has (Q3)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.persist_evaluation_run(jsonb, jsonb[], jsonb[]);

-- ---------------------------------------------------------------------------
-- 3. The sub-surface trigger only production has (Q1); its insert half moves
--    into the two field RPCs below, its delete half is gone
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_manage_field_subunits ON public.fields;
DROP FUNCTION IF EXISTS public.handle_field_subunits();

-- ---------------------------------------------------------------------------
-- 4. The fill-a-null triggers only production has (Q2), then their functions
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS set_org_id_field_subunits ON public.field_subunits;
DROP TRIGGER IF EXISTS set_org_id_practice_slots ON public.practice_slots;
DROP TRIGGER IF EXISTS set_org_id_game_slots ON public.game_slots;
DROP TRIGGER IF EXISTS set_org_id_team_players ON public.team_players;
DROP TRIGGER IF EXISTS set_org_id_practice_assignments ON public.practice_assignments;
DROP TRIGGER IF EXISTS set_org_id_games ON public.games;
DROP TRIGGER IF EXISTS set_org_id_staging_players ON public.staging_players;
DROP TRIGGER IF EXISTS set_org_id_player_buddies ON public.player_buddies;
DROP TRIGGER IF EXISTS set_org_id_scheduler_runs ON public.scheduler_runs;
DROP TRIGGER IF EXISTS set_org_id_export_jobs ON public.export_jobs;
DROP TRIGGER IF EXISTS set_org_id_evaluation_runs ON public.evaluation_runs;
DROP TRIGGER IF EXISTS set_org_id_evaluation_findings ON public.evaluation_findings;
DROP TRIGGER IF EXISTS set_org_id_evaluation_metrics ON public.evaluation_metrics;
DROP TRIGGER IF EXISTS set_org_id_evaluation_run_events ON public.evaluation_run_events;
DROP TRIGGER IF EXISTS set_org_id_email_log ON public.email_log;
DROP TRIGGER IF EXISTS set_scheduler_runs_created_by ON public.scheduler_runs;

DROP FUNCTION IF EXISTS public.propagate_org_id_from_field();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_team();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_home_team();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_import_job();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_player();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_season_settings();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_scheduler_run();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_evaluation_run();
DROP FUNCTION IF EXISTS public.propagate_org_id_from_export_job();
DROP FUNCTION IF EXISTS public.set_created_by_to_auth_uid();

-- ---------------------------------------------------------------------------
-- 5. admin_create_field and admin_update_field, replaced wholesale from
--    20260504060000. The only change in each is the sub-surface step and the
--    `subunits_created` key in its audit row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_field(
    p_organization_id uuid,
    p_location_id uuid,
    p_name text,
    p_surface_type text DEFAULT NULL,
    p_size text DEFAULT NULL,
    p_supports_halves boolean DEFAULT false,
    p_priority_rating integer DEFAULT 1,
    p_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_location_org uuid;
    v_field public.fields%ROWTYPE;
    v_subunits_created jsonb := '[]'::jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'p_location_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT organization_id
      INTO v_location_org
      FROM public.locations
     WHERE id = p_location_id;

    IF v_location_org IS NULL OR v_location_org <> p_organization_id THEN
        RAISE EXCEPTION 'Access denied: location is outside organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'field name is required'
            USING ERRCODE = '22023';
    END IF;

    IF COALESCE(p_priority_rating, 1) < 1 THEN
        RAISE EXCEPTION 'priority_rating must be at least 1'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.fields (
        organization_id,
        location_id,
        name,
        surface_type,
        size,
        supports_halves,
        priority_rating,
        active
    )
    VALUES (
        p_organization_id,
        p_location_id,
        v_name,
        NULLIF(btrim(COALESCE(p_surface_type, '')), ''),
        NULLIF(btrim(COALESCE(p_size, '')), ''),
        COALESCE(p_supports_halves, false),
        COALESCE(p_priority_rating, 1),
        COALESCE(p_active, true)
    )
    RETURNING * INTO v_field;

    -- Halves on: sub-surfaces A and B exist. Insert-only; never deletes.
    IF v_field.supports_halves THEN
        WITH created AS (
            INSERT INTO public.field_subunits (organization_id, field_id, label)
            VALUES (v_field.organization_id, v_field.id, 'A'),
                   (v_field.organization_id, v_field.id, 'B')
            ON CONFLICT (field_id, label) DO NOTHING
            RETURNING label
        )
        SELECT COALESCE(jsonb_agg(label ORDER BY label), '[]'::jsonb)
          INTO v_subunits_created
          FROM created;
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_field.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'created',
            'current', to_jsonb(v_field),
            'subunits_created', v_subunits_created
        )
    );

    RETURN to_jsonb(v_field);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_field(
    p_organization_id uuid,
    p_field_id uuid,
    p_location_id uuid,
    p_name text,
    p_surface_type text DEFAULT NULL,
    p_size text DEFAULT NULL,
    p_supports_halves boolean DEFAULT false,
    p_priority_rating integer DEFAULT 1,
    p_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_location_org uuid;
    v_existing public.fields%ROWTYPE;
    v_field public.fields%ROWTYPE;
    v_subunits_created jsonb := '[]'::jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_field_id IS NULL THEN
        RAISE EXCEPTION 'p_field_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id
     FOR UPDATE;

    IF v_existing.id IS NULL THEN
        RAISE EXCEPTION 'field % was not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'p_location_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT organization_id
      INTO v_location_org
      FROM public.locations
     WHERE id = p_location_id;

    IF v_location_org IS NULL OR v_location_org <> p_organization_id THEN
        RAISE EXCEPTION 'Access denied: location is outside organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'field name is required'
            USING ERRCODE = '22023';
    END IF;

    IF COALESCE(p_priority_rating, 1) < 1 THEN
        RAISE EXCEPTION 'priority_rating must be at least 1'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.fields
       SET location_id = p_location_id,
           name = v_name,
           surface_type = NULLIF(btrim(COALESCE(p_surface_type, '')), ''),
           size = NULLIF(btrim(COALESCE(p_size, '')), ''),
           supports_halves = COALESCE(p_supports_halves, false),
           priority_rating = COALESCE(p_priority_rating, 1),
           active = COALESCE(p_active, true),
           updated_at = timezone('utc', now())
     WHERE id = p_field_id
       AND organization_id = p_organization_id
    RETURNING * INTO v_field;

    -- Halves on: sub-surfaces A and B exist (a retired one stays retired).
    -- Halves off: nothing is deleted. A sub-surface leaves only through
    -- admin_retire_field_subunit, which refuses while it has bookings.
    IF v_field.supports_halves THEN
        WITH created AS (
            INSERT INTO public.field_subunits (organization_id, field_id, label)
            VALUES (v_field.organization_id, v_field.id, 'A'),
                   (v_field.organization_id, v_field.id, 'B')
            ON CONFLICT (field_id, label) DO NOTHING
            RETURNING label
        )
        SELECT COALESCE(jsonb_agg(label ORDER BY label), '[]'::jsonb)
          INTO v_subunits_created
          FROM created;
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_field.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'updated',
            'previous', to_jsonb(v_existing),
            'current', to_jsonb(v_field),
            'subunits_created', v_subunits_created
        )
    );

    RETURN to_jsonb(v_field);
END;
$$;

COMMENT ON FUNCTION public.admin_create_field(uuid, uuid, text, text, text, boolean, integer, boolean) IS
  'Admin-only org-scoped field creation with location scoping checks and settings.updated audit logging. With halves on it creates sub-surfaces A and B (insert-only, named in the audit row).';
COMMENT ON FUNCTION public.admin_update_field(uuid, uuid, uuid, text, text, text, boolean, integer, boolean) IS
  'Admin-only org-scoped field update with location scoping checks and settings.updated audit logging. With halves on it ensures sub-surfaces A and B exist (insert-only, named in the audit row); switching halves off deletes nothing.';

COMMIT;
