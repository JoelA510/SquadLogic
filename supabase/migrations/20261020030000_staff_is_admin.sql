-- Staff are admins (owner decision 2026-10-20: "Staff should be treated like an
-- admin"; plan docs/changes/2026-10-20-phase-a-privacy.md, A2 item 3).
--
-- **Why.** `staff` is an organization role an admin can assign and invite, but
-- the database refused staff everything an admin is let do: `is_org_admin`
-- named only admin and tenant_admin, and nine policies tested the role by name.
-- The one exception was `update_game_score`, which already admits staff.
--
-- **The change** (every object below read back from production 2026-10-20 and
-- found identical to its latest repo definition):
--   * `is_org_admin(uuid)` admits `staff` (20260404100000's body, one line
--     changed). Every policy and RPC gated on it follows.
--   * `admin_remove_member` and `admin_change_member_role` (20260613000005's
--     bodies) count staff as admin-equivalent in their last-admin guards, so an
--     organization whose only admin-equivalent member is staff cannot lose it.
--   * The nine policies that test the role by name (20261018030000) admit
--     `staff` beside the role they named: `audit_log` and
--     `organization_schema_history` SELECT, `telemetry_log` SELECT, and
--     `registration_forms` and `season_settings` INSERT, UPDATE and DELETE.
--     Their expressions are otherwise unchanged.
--
-- **Not changed.** `tenant_admin` keeps exactly the access it had: it is still
-- refused the five policies that name only `admin` (remediation plan, RLS Q5,
-- an open product question this does not answer). No role, grant, signature or
-- security posture changes; CREATE OR REPLACE and ALTER POLICY keep grants,
-- owners and policy names. `reconcile_prod_rls_drift()` needs no change: none of
-- these policies is in its spec, and its admin-gate test still matches the new
-- expressions (they still contain `'admin'::text`).
--
-- Revert: docs/sql/20261020030000_revert.sql. Smoke: docs/sql/20261020030000_smoke.sql.
-- pgTAP: supabase/tests/rls_policy_matrix.sql gains a staff persona whose every
-- cell equals the admin's; supabase/tests/staff_is_admin.sql covers the RPCs.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_org_admin(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM public.organization_members 
        WHERE organization_id = p_org_id 
          AND profile_id = auth.uid() 
          AND role IN ('admin', 'tenant_admin', 'staff')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_remove_member(
    p_organization_id uuid,
    p_profile_id      uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_id  uuid := auth.uid();
    v_member_role text;
    v_admin_count integer;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_profile_id IS NULL THEN
        RAISE EXCEPTION 'p_profile_id is required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF v_caller_id = p_profile_id THEN
        RAISE EXCEPTION 'You cannot remove yourself from the organization'
            USING ERRCODE = '22023';
    END IF;

    SELECT role INTO v_member_role
    FROM public.organization_members
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found in organization' USING ERRCODE = 'P0002';
    END IF;

    -- Block removing the last admin-equivalent member.
    IF v_member_role IN ('admin', 'tenant_admin', 'staff') THEN
        SELECT count(*) INTO v_admin_count
        FROM public.organization_members
        WHERE organization_id = p_organization_id AND role IN ('admin', 'tenant_admin', 'staff');
        IF v_admin_count <= 1 THEN
            RAISE EXCEPTION 'Cannot remove the last admin from the organization'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    DELETE FROM public.organization_members
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;

    PERFORM public.record_audit_event(
        p_organization_id,
        'member.removed',
        'organization_members',
        p_profile_id,
        jsonb_build_object('role', v_member_role)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_change_member_role(
    p_organization_id uuid,
    p_profile_id      uuid,
    p_role            text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_id   uuid := auth.uid();
    v_old_role    text;
    v_admin_count integer;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_profile_id IS NULL THEN
        RAISE EXCEPTION 'p_profile_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_role IS NULL OR p_role NOT IN ('admin', 'coach', 'player', 'parent', 'staff') THEN
        RAISE EXCEPTION 'invalid role: %', p_role USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT role INTO v_old_role
    FROM public.organization_members
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found in organization' USING ERRCODE = 'P0002';
    END IF;

    -- Block demoting the last admin-equivalent member (including yourself).
    IF v_old_role IN ('admin', 'tenant_admin', 'staff') AND p_role NOT IN ('admin', 'tenant_admin', 'staff') THEN
        SELECT count(*) INTO v_admin_count
        FROM public.organization_members
        WHERE organization_id = p_organization_id AND role IN ('admin', 'tenant_admin', 'staff');
        IF v_admin_count <= 1 THEN
            RAISE EXCEPTION 'Cannot demote the last admin of the organization'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    UPDATE public.organization_members
    SET role = p_role
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;

    IF v_old_role IS DISTINCT FROM p_role THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'member.role_changed',
            'organization_members',
            p_profile_id,
            jsonb_build_object('previous_role', v_old_role, 'role', p_role)
        );
    END IF;
END;
$$;

ALTER POLICY "Audit Log: admins view" ON public.audit_log
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = audit_log.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

ALTER POLICY "Schema History: Admins Only" ON public.organization_schema_history
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_members
            WHERE organization_id = public.organization_schema_history.organization_id
            AND profile_id = (select auth.uid())
            AND role IN ('admin', 'staff')
        )
    );

ALTER POLICY "View telemetry for own organization" ON public.telemetry_log
    USING (
        org_id IN (
            SELECT organization_id
            FROM public.organization_members
            WHERE profile_id = (select auth.uid())
              AND role IN ('admin', 'tenant_admin', 'staff')
        )
    );

ALTER POLICY "registration_forms_admin_insert" ON public.registration_forms
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

ALTER POLICY "registration_forms_admin_update" ON public.registration_forms
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role IN ('admin', 'staff')
        )
    )
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

ALTER POLICY "registration_forms_admin_delete" ON public.registration_forms
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

ALTER POLICY "Season Settings: admins insert" ON public.season_settings
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

ALTER POLICY "Season Settings: admins update" ON public.season_settings
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role IN ('admin', 'staff')
        )
    )
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

ALTER POLICY "Season Settings: admins delete" ON public.season_settings
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role IN ('admin', 'staff')
        )
    );

COMMIT;
