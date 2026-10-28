-- Smoke checks for 20261014000000_register_scheduler_auto_refused.sql
--
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub` and
-- `auth.role()` from `request.jwt.claim.role`, so `record_audit_event` runs as
-- a real organisation member, and then as the service role.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_member uuid := gen_random_uuid();
    v_org uuid;
    v_id uuid;
    v_row public.audit_log%ROWTYPE;
    v_code text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'scheduler.auto_refused') THEN
        RAISE EXCEPTION 'the scheduler.auto_refused audit action is not registered';
    END IF;

    INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (v_member, 'refused-member@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_member, 'refused-member@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Refused', 'smoke-org-refused')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
        VALUES (v_org, v_member, 'staff');

    -- (a) As the caller -- what the Edge Functions now do -- the row lands and
    --     is attributed to the caller.
    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    v_id := public.record_audit_event(v_org, 'scheduler.auto_refused', 'practice_schedule', NULL,
                                      '{"reason": "SMOKE"}'::jsonb);
    SELECT * INTO v_row FROM public.audit_log WHERE id = v_id;
    IF v_row.id IS NULL OR v_row.user_id <> v_member OR v_row.organization_id <> v_org
       OR v_row.action <> 'scheduler.auto_refused' THEN
        RAISE EXCEPTION 'the caller''s scheduler.auto_refused row was not written as the caller: %', row_to_json(v_row);
    END IF;
    RAISE NOTICE 'a scheduler.auto_refused row written as the caller lands, attributed to the caller';

    -- (b) As the service role -- what the Edge Functions used to do -- the
    --     insert is refused on audit_log.user_id NOT NULL, whatever the action.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    BEGIN
        PERFORM public.record_audit_event(v_org, 'scheduler.auto_refused', 'practice_schedule', NULL, '{}'::jsonb);
        RAISE EXCEPTION 'a service-role audit write SUCCEEDED; the Edge Functions'' reason to write as the caller has changed';
    EXCEPTION WHEN not_null_violation THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM '23502' THEN
        RAISE EXCEPTION 'the service-role audit write was not refused with 23502';
    END IF;
    RAISE NOTICE 'a service-role audit write is refused with 23502 (no auth.uid() to attribute it to)';
END;
$$;

ROLLBACK;
