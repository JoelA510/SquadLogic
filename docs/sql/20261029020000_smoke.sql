-- Smoke checks for 20261029020000_register_invite_redeemed_audit_action.sql
--
-- Run on the database built to head: an admin mints an invite and a second
-- person redeems it, the way the app does. `prelude.sql` stubs `auth.uid()`
-- from `request.jwt.claim.sub`, so `create_org_invite` and `redeem_org_invite`
-- run as real organisation members. Before the migration the redeem failed on
-- the `audit_log.action` foreign key (23503) and rolled back whole; now it
-- joins the caller, consumes the invite and leaves one audit row.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_joiner uuid := gen_random_uuid();
    v_org uuid;
    v_code text;
    v_returned uuid;
    v_invite public.organization_invites%ROWTYPE;
    v_role text;
    v_rows integer;
    v_row public.audit_log%ROWTYPE;
    v_state text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'members.invited_joined') THEN
        RAISE EXCEPTION 'the members.invited_joined audit action is not registered';
    END IF;

    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'invite-admin@example.test', '{"password_length": 16}'),
        (v_joiner, 'invite-joiner@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'invite-admin@example.test'),
        (v_joiner, 'invite-joiner@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Invite', 'smoke-org-invite')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
        VALUES (v_org, v_admin, 'admin');

    -- The admin mints a single-use coach invite.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SELECT i.code INTO v_code FROM public.create_org_invite(v_org, 'coach') i;
    IF v_code IS NULL THEN
        RAISE EXCEPTION 'create_org_invite returned no code';
    END IF;

    -- (a) The joiner redeems it (lower case: codes are case-insensitive).
    PERFORM set_config('request.jwt.claim.sub', v_joiner::text, true);
    v_returned := public.redeem_org_invite(lower(v_code));
    IF v_returned IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'redeem_org_invite returned % instead of the invited organization %', v_returned, v_org;
    END IF;

    SELECT role INTO v_role FROM public.organization_members
     WHERE organization_id = v_org AND profile_id = v_joiner;
    IF v_role IS DISTINCT FROM 'coach' THEN
        RAISE EXCEPTION 'the redeemer was not added as a coach (found %)', v_role;
    END IF;

    SELECT * INTO v_invite FROM public.organization_invites WHERE code = v_code;
    IF v_invite.used_at IS NULL OR v_invite.used_by IS DISTINCT FROM v_joiner THEN
        RAISE EXCEPTION 'the invite was not consumed by the redeemer: %', row_to_json(v_invite);
    END IF;
    RAISE NOTICE 'an invite redeems: the caller joins as the invited role and the invite is consumed';

    -- (b) Exactly one audit row, attributed to the redeemer, carrying the
    --     role and the invite.
    SELECT count(*) INTO v_rows FROM public.audit_log
     WHERE organization_id = v_org AND action = 'members.invited_joined';
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'expected one members.invited_joined audit row for the redemption, found %', v_rows;
    END IF;
    SELECT * INTO v_row FROM public.audit_log
     WHERE organization_id = v_org AND action = 'members.invited_joined';
    IF v_row.user_id IS DISTINCT FROM v_joiner
       OR v_row.resource_type IS DISTINCT FROM 'organization_member'
       OR v_row.resource_id IS DISTINCT FROM v_joiner
       OR v_row.metadata->>'role' IS DISTINCT FROM 'coach'
       OR (v_row.metadata->>'invite_id')::uuid IS DISTINCT FROM v_invite.id THEN
        RAISE EXCEPTION 'the members.invited_joined row is not as redeem_org_invite writes it: %', row_to_json(v_row);
    END IF;
    RAISE NOTICE 'the redemption left one members.invited_joined audit row, attributed to the redeemer';

    -- (c) The invite is single-use: a second redemption is refused with the
    --     documented message, and writes no second audit row.
    BEGIN
        PERFORM public.redeem_org_invite(v_code);
        RAISE EXCEPTION 'a used invite was redeemed a second time';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        GET STACKED DIAGNOSTICS v_state = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM 'Invite code has already been used' THEN
        RAISE EXCEPTION 'the second redemption was refused with an unexpected message: %', v_state;
    END IF;
    SELECT count(*) INTO v_rows FROM public.audit_log
     WHERE organization_id = v_org AND action = 'members.invited_joined';
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'a refused redemption changed the audit trail: % rows', v_rows;
    END IF;
    RAISE NOTICE 'a used invite is refused and leaves the audit trail as it was';
END;
$$;

ROLLBACK;
