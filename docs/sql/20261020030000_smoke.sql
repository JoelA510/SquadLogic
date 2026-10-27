-- Smoke checks for 20261020030000_staff_is_admin.sql
--
-- What it proves, with prelude.sql's `auth.uid()` stub:
--   * a staff member is an admin of their own organization and of no other;
--   * a staff member passes admin_change_member_role's gate; no role but admin
--     and staff can be given (a coach, before 20261104010000: refused 22023);
--   * no policy in `public` names 'admin' as a role without 'staff';
--   * the three functions keep their posture: SECURITY DEFINER,
--     search_path=public.
--
-- Wrapped in BEGIN ... ROLLBACK. Every id is generated; every email is
-- `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_staff uuid := gen_random_uuid();
    v_peer uuid := gen_random_uuid();
    v_org uuid;
    v_org2 uuid;
    v_msg text;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_staff, 'staffadmin-staff@example.test', '{"password_length": 16}'),
        (v_peer, 'staffadmin-peer@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_staff, 'staffadmin-staff@example.test'), (v_peer, 'staffadmin-peer@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Staff', 'smoke-org-staff')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Staff Two', 'smoke-org-staff-two')
        RETURNING id INTO v_org2;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_staff, 'staff'), (v_org, v_peer, 'staff');

    PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'a staff member is not an admin of their own organization';
    END IF;
    IF public.is_org_admin(v_org2) THEN
        RAISE EXCEPTION 'a staff member is an admin of another organization';
    END IF;
    RAISE NOTICE 'a staff member is an admin of their own organization and of no other';

    -- A staff member passes the gate and changes a peer's role; the roles that can be given
    -- are admin and staff (20261104010000), so 'coach' is refused 22023 and the peer stays staff.
    PERFORM public.admin_change_member_role(v_org, v_peer, 'admin');
    PERFORM public.admin_change_member_role(v_org, v_peer, 'staff');
    BEGIN
        PERFORM public.admin_change_member_role(v_org, v_peer, 'coach');
        RAISE EXCEPTION 'a staff member gave a member the coach role';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg <> 'invalid role: coach' THEN
            RAISE EXCEPTION 'unexpected refusal: %', v_msg;
        END IF;
    END;
    IF (SELECT role FROM public.organization_members WHERE organization_id = v_org AND profile_id = v_peer) <> 'staff' THEN
        RAISE EXCEPTION 'a refused role change moved the member';
    END IF;
    RAISE NOTICE 'a staff member passed the member RPC gate and changed a peer''s role; the coach role was refused 22023 and the peer is still staff';

    -- Each expression on its own: a USING that admits staff must not hide a
    -- WITH CHECK that does not.
    IF EXISTS (SELECT 1 FROM pg_policies p, LATERAL (VALUES (p.qual), (p.with_check)) e(expr)
                WHERE p.schemaname = 'public'
                  AND e.expr LIKE '%''admin''::text%'
                  AND e.expr NOT LIKE '%''staff''::text%') THEN
        RAISE EXCEPTION 'a policy in public still names ''admin'' as a role without ''staff''';
    END IF;
    RAISE NOTICE 'no policy in public names ''admin'' as a role without ''staff''';

    IF (SELECT count(*) FROM pg_proc p
         WHERE p.oid IN ('public.is_org_admin(uuid)'::regprocedure,
                         'public.admin_remove_member(uuid, uuid)'::regprocedure,
                         'public.admin_change_member_role(uuid, uuid, text)'::regprocedure)
           AND p.prosecdef AND p.proconfig = ARRAY['search_path=public']) <> 3 THEN
        RAISE EXCEPTION 'a changed function lost its posture (definer, search_path)';
    END IF;
    RAISE NOTICE 'posture unchanged: the three functions are SECURITY DEFINER with search_path=public';
END;
$$;

ROLLBACK;
