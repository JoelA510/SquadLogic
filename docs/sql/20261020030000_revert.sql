-- Revert for 20261020030000_staff_is_admin.sql
--
-- Restores `is_org_admin`, `admin_remove_member` and `admin_change_member_role`
-- to the bodies production ran before the change (20260404100000 and
-- 20260613000005, byte for byte; md5 3ea7674ca3cd4876d38129798d1f98d4,
-- 75a16391fa48fcc6b045ede4f482a634 and 4ea420746df7e9f34a01614999811b5f, read
-- 2026-10-20), and the nine policies to their 20261018030000 expressions.
--
-- What it does to people: every `staff` member loses admin access again at once.
-- No row is lost, but an organization whose only admin-equivalent members are
-- staff (possible after the change: the last-admin guards count staff) is left
-- with no admin at all. The revert counts those organizations first and
-- refuses while there are any: promote a member to admin in each, then run it.
--
-- Verified: the harness checks the three bodies by md5 and that no policy in
-- `public` names `staff` afterwards.

BEGIN;

-- Hold membership writes until the revert commits, so no demotion can slip in
-- between the guard's count and the functions' replacement (a demotion the
-- forward guards allow because staff count). SHARE ROW EXCLUSIVE blocks
-- INSERT, UPDATE and DELETE on the table and still lets everyone read it.
LOCK TABLE public.organization_members IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
DECLARE
    v_orphans integer;
BEGIN
    SELECT count(DISTINCT s.organization_id) INTO v_orphans
      FROM public.organization_members s
     WHERE s.role = 'staff'
       AND NOT EXISTS (SELECT 1 FROM public.organization_members a
                        WHERE a.organization_id = s.organization_id
                          AND a.role IN ('admin', 'tenant_admin'));
    IF v_orphans > 0 THEN
        RAISE EXCEPTION 'refusing to revert: % organization(s) have staff but no admin or tenant_admin, and would be left with no admin; promote one member of each to admin first', v_orphans
            USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'revert guard: no organization depends on staff for its admin';
END;
$guard$;

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
          AND role IN ('admin', 'tenant_admin')
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
    IF v_member_role IN ('admin', 'tenant_admin') THEN
        SELECT count(*) INTO v_admin_count
        FROM public.organization_members
        WHERE organization_id = p_organization_id AND role IN ('admin', 'tenant_admin');
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
    IF v_old_role IN ('admin', 'tenant_admin') AND p_role NOT IN ('admin', 'tenant_admin') THEN
        SELECT count(*) INTO v_admin_count
        FROM public.organization_members
        WHERE organization_id = p_organization_id AND role IN ('admin', 'tenant_admin');
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
              AND om.role = 'admin'
        )
    );

ALTER POLICY "Schema History: Admins Only" ON public.organization_schema_history
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_members
            WHERE organization_id = public.organization_schema_history.organization_id
            AND profile_id = (select auth.uid())
            AND role = 'admin'
        )
    );

ALTER POLICY "View telemetry for own organization" ON public.telemetry_log
    USING (
        org_id IN (
            SELECT organization_id
            FROM public.organization_members
            WHERE profile_id = (select auth.uid())
              AND role IN ('admin', 'tenant_admin')
        )
    );

ALTER POLICY "registration_forms_admin_insert" ON public.registration_forms
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );

ALTER POLICY "registration_forms_admin_update" ON public.registration_forms
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    )
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );

ALTER POLICY "registration_forms_admin_delete" ON public.registration_forms
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );

ALTER POLICY "Season Settings: admins insert" ON public.season_settings
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );

ALTER POLICY "Season Settings: admins update" ON public.season_settings
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    )
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );

ALTER POLICY "Season Settings: admins delete" ON public.season_settings
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );

COMMIT;
