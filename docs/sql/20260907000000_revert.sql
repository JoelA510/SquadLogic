-- Revert for 20260907000000_field_delete_booking_guard.sql
--
-- Puts back the two-argument, UNGUARDED `admin_delete_field` exactly as
-- 20260504060000_admin_facility_mutation_rpcs.sql shipped it, and drops the
-- foreign key on practice_assignments.field_id.
--
-- **This revert re-opens a live data-integrity defect, and it is not made
-- harmless here.** After it runs:
--
--   * deleting a field CASCADEs its game_slots and practice_slots away,
--     SET NULLs game_assignments.field_id, and leaves
--     practice_assignments.field_id DANGLING again -- with no warning and no
--     list of what was lost;
--   * every practice_assignment currently carrying a field_id loses the only
--     thing that keeps that value pointing at a real row.
--
-- The second of those is silent by nature, so the block below COUNTS the rows
-- that are about to lose their protection before the constraint goes. A count
-- of zero is reported as such rather than passing quietly: if it is zero, this
-- revert is cheap; if it is not, that number is what you are exposing.
--
-- Rows that were repaired to NULL by the forward migration are NOT restored.
-- Their previous values pointed at fields that no longer exist, so there is
-- nothing to restore them to.

BEGIN;

-- What this revert is about to expose, counted while the constraint still exists.
DO $$
DECLARE v_protected integer; v_has_fk boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'practice_assignments_field_id_fkey'
      AND conrelid = 'public.practice_assignments'::regclass
  ) INTO v_has_fk;

  IF NOT v_has_fk THEN
    RAISE NOTICE 'practice_assignments.field_id is already unconstrained; nothing to record';
  ELSE
    SELECT count(*) INTO v_protected
      FROM public.practice_assignments
     WHERE field_id IS NOT NULL;
    IF v_protected > 0 THEN
      RAISE WARNING
        'EXPOSING % practice_assignment(s) with a field_id: after this revert a field delete leaves them dangling',
        v_protected;
    ELSE
      RAISE NOTICE
        'no practice_assignments currently carry a field_id; this revert exposes no existing row';
    END IF;
  END IF;
END $$;

ALTER TABLE public.practice_assignments
  DROP CONSTRAINT IF EXISTS practice_assignments_field_id_fkey;

COMMENT ON COLUMN public.practice_assignments.field_id IS NULL;

-- **admin_retire_field must be put back before the producer goes.** This
-- migration moved it onto `public.field_bookings`; dropping that function while
-- retire still calls it leaves the RPC raising `undefined_function` on every
-- call -- a revert that silently breaks a path it never claimed to touch. So
-- retire is restored to its 20260906000000 body first, and the two defects that
-- body carries are named rather than reintroduced quietly.
DO $$
BEGIN
  RAISE WARNING 'RESTORING admin_retire_field to its pre-20260907000000 body: it enumerates four kinds, so a retirement will again under-report (no games, no slot-reached assignments), and p_confirm => NULL will again read as confirmed';
END $$;

CREATE OR REPLACE FUNCTION public.admin_retire_field(
    p_organization_id uuid,
    p_field_id uuid,
    p_effective_to date,
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.fields%ROWTYPE;
    v_after  public.fields%ROWTYPE;
    v_affected jsonb;
    v_affected_count integer;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_field_id IS NULL THEN
        RAISE EXCEPTION 'p_field_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_effective_to IS NULL THEN
        RAISE EXCEPTION 'p_effective_to is required; retiring with no end date is a deletion, not a retirement'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_before
    FROM public.fields
    WHERE id = p_field_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Field % not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    WITH affected AS (
      SELECT 'game_slot'::text AS kind, gs.id,
             COALESCE(gs.slot_date, gs.start::date) AS on_date,
             gs.week_index::integer AS week_index,
             COALESCE(gs.slot_date, gs.start::date) IS NULL AS undated,
             false AS unbounded
      FROM public.game_slots gs
      WHERE gs.organization_id = p_organization_id AND gs.field_id = p_field_id
        AND (COALESCE(gs.slot_date, gs.start::date) IS NULL
             OR COALESCE(gs.slot_date, gs.start::date) > p_effective_to)
      UNION ALL
      SELECT 'game_assignment'::text, ga.id,
             ga.start::date, ga.week_index::integer,
             ga.start IS NULL, false
      FROM public.game_assignments ga
      WHERE ga.organization_id = p_organization_id AND ga.field_id = p_field_id
        AND (ga.start IS NULL OR ga.start::date > p_effective_to)
      UNION ALL
      SELECT 'practice_slot'::text, ps.id,
             ps.valid_until, NULL::integer,
             false, ps.valid_until IS NULL
      FROM public.practice_slots ps
      WHERE ps.organization_id = p_organization_id AND ps.field_id = p_field_id
        AND (ps.valid_until IS NULL OR ps.valid_until > p_effective_to)
      UNION ALL
      SELECT 'practice_assignment'::text, pa.id,
             upper(pa.effective_date_range), NULL::integer,
             false,
             pa.effective_date_range IS NULL OR upper_inf(pa.effective_date_range)
      FROM public.practice_assignments pa
      WHERE pa.organization_id = p_organization_id AND pa.field_id = p_field_id
        AND (pa.effective_date_range IS NULL
             OR upper_inf(pa.effective_date_range)
             OR upper(pa.effective_date_range) > p_effective_to)
    )
    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', a.kind, 'id', a.id, 'on_date', a.on_date,
            'week_index', a.week_index, 'undated', a.undated, 'unbounded', a.unbounded
          )
          ORDER BY a.on_date NULLS FIRST, a.kind, a.id
        ),
        '[]'::jsonb
      ),
      COUNT(*)
    INTO v_affected, v_affected_count
    FROM affected a;

    IF v_affected_count > 0 AND NOT p_confirm THEN
        PERFORM public.record_audit_event(
            p_organization_id, 'settings.updated', 'field', p_field_id,
            jsonb_build_object(
                'operation', 'admin_retire_field',
                'phase', 'refused',
                'reason', 'bookings_after_effective_to',
                'effective_to', p_effective_to,
                'affected_count', v_affected_count,
                'affected', v_affected,
                'before', to_jsonb(v_before)
            )
        );
        RETURN jsonb_build_object(
            'retired', false,
            'reason', 'bookings_after_effective_to',
            'affected_count', v_affected_count,
            'affected', v_affected
        );
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field', p_field_id,
        jsonb_build_object(
            'operation', 'admin_retire_field',
            'phase', 'before',
            'effective_to', p_effective_to,
            'confirmed', p_confirm,
            'affected_count', v_affected_count,
            'affected', v_affected,
            'before', to_jsonb(v_before)
        )
    );

    UPDATE public.fields
    SET effective_to = p_effective_to,
        active = v_before.active AND public.field_is_live_on(p_effective_to),
        updated_at = timezone('utc', now())
    WHERE id = p_field_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field', p_field_id,
        jsonb_build_object(
            'operation', 'admin_retire_field',
            'phase', 'after',
            'effective_to', p_effective_to,
            'confirmed', p_confirm,
            'affected_count', v_affected_count,
            'after', to_jsonb(v_after)
        )
    );

    RETURN jsonb_build_object(
        'retired', true,
        'affected_count', v_affected_count,
        'affected', v_affected,
        'field', to_jsonb(v_after)
    );
END;
$$;

COMMENT ON FUNCTION public.admin_retire_field(uuid, uuid, date, boolean) IS
  'Org-admin field retirement: writes effective_to and keeps active in step, refusing with the affected bookings unless p_confirm. Audits before and after.';

DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.field_bookings_digest(jsonb, integer);
DROP FUNCTION IF EXISTS public.field_bookings(uuid, uuid, date);

-- Restored verbatim from 20260504060000_admin_facility_mutation_rpcs.sql.
CREATE OR REPLACE FUNCTION public.admin_delete_field(
    p_organization_id uuid,
    p_field_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing public.fields%ROWTYPE;
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

    DELETE FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id
    RETURNING * INTO v_existing;

    IF v_existing.id IS NULL THEN
        RAISE EXCEPTION 'field % was not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_existing.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'deleted',
            'previous', to_jsonb(v_existing)
        )
    );

    RETURN jsonb_build_object(
        'id', v_existing.id,
        'organization_id', v_existing.organization_id,
        'deleted', true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_field(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_field(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid) IS
  'Admin-only org-scoped field deletion with settings.updated audit logging.';

COMMIT;
