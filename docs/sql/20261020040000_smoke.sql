-- Smoke checks for 20261020040000_identity_guards.sql
--
-- What it proves, with prelude.sql's `auth.uid()` stub:
--   * link_my_coach_record links the caller to the coach row matching their
--     verified email (case-insensitively) and audits it once; a second call is
--     'already_linked' and writes nothing;
--   * an unverified email is 'email_not_verified', a coach row in an
--     organization the caller does not belong to and an 'interested' lead are
--     'no_match', and a row linked to another account is 'linked_to_another';
--     none changes a row;
--   * profiles: authenticated may update first_name, last_name, full_name and
--     avatar_url and no other column; anon may update nothing;
--   * the function's posture: SECURITY DEFINER, search_path=public, EXECUTE for
--     authenticated and not anon.
--
-- Wrapped in BEGIN ... ROLLBACK. Every id is generated; every email is
-- `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_a uuid := gen_random_uuid();   -- verified, member, has a coach row
    v_b uuid := gen_random_uuid();   -- unverified, member, has a coach row
    v_c uuid := gen_random_uuid();   -- verified, member of org 1 only; coach row in org 2
    v_d uuid := gen_random_uuid();   -- verified, member; coach row linked to v_a2
    v_a2 uuid := gen_random_uuid();
    v_e uuid := gen_random_uuid();   -- verified, member; coach row is an 'interested' lead
    v_org uuid;
    v_org2 uuid;
    v_coach_a uuid;
    v_r jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_a,  'Link-A@Example.test', '{"password_length": 16}', now()),
        (v_b,  'link-b@example.test', '{"password_length": 16}', NULL),
        (v_c,  'link-c@example.test', '{"password_length": 16}', now()),
        (v_d,  'link-d@example.test', '{"password_length": 16}', now()),
        (v_a2, 'link-a2@example.test', '{"password_length": 16}', now()),
        (v_e,  'link-e@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email) VALUES
        (v_a, 'link-a@example.test'), (v_b, 'link-b@example.test'), (v_c, 'link-c@example.test'),
        (v_d, 'link-d@example.test'), (v_a2, 'link-a2@example.test'), (v_e, 'link-e@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Link', 'smoke-org-link')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Link Two', 'smoke-org-link-two')
        RETURNING id INTO v_org2;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_a, 'coach'), (v_org, v_b, 'coach'), (v_org, v_c, 'coach'), (v_org, v_d, 'coach'),
        (v_org, v_e, 'coach');
    INSERT INTO public.coaches (organization_id, full_name, email) VALUES
        (v_org, 'Coach A', 'link-a@EXAMPLE.test') RETURNING id INTO v_coach_a;
    INSERT INTO public.coaches (organization_id, full_name, email) VALUES
        (v_org, 'Coach B', 'link-b@example.test'),
        (v_org2, 'Coach C', 'link-c@example.test');
    INSERT INTO public.coaches (organization_id, full_name, email, user_id) VALUES
        (v_org, 'Coach D', 'link-d@example.test', v_a2);
    INSERT INTO public.coaches (organization_id, full_name, email, status) VALUES
        (v_org, 'Lead E', 'link-e@example.test', 'interested');

    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    v_r := public.link_my_coach_record();
    IF v_r->>'status' <> 'linked' OR (v_r->>'coach_id')::uuid <> v_coach_a
       OR (SELECT user_id FROM public.coaches WHERE id = v_coach_a) IS DISTINCT FROM v_a THEN
        RAISE EXCEPTION 'a verified member was not linked to their coach row: %', v_r;
    END IF;
    v_r := public.link_my_coach_record();
    IF v_r->>'status' <> 'already_linked' THEN
        RAISE EXCEPTION 'a second call was not already_linked: %', v_r;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE action = 'coach.linked' AND resource_id = v_coach_a) <> 1 THEN
        RAISE EXCEPTION 'the link was not audited exactly once';
    END IF;
    RAISE NOTICE 'a verified member was linked once, case-insensitively, and audited once; a second call changed nothing';

    PERFORM set_config('request.jwt.claim.sub', v_b::text, true);
    v_r := public.link_my_coach_record();
    IF v_r->>'status' <> 'email_not_verified' THEN
        RAISE EXCEPTION 'an unverified email was not refused: %', v_r;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_c::text, true);
    v_r := public.link_my_coach_record();
    IF v_r->>'status' <> 'no_match' THEN
        RAISE EXCEPTION 'a coach row in an organization the caller does not belong to was matched: %', v_r;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_d::text, true);
    v_r := public.link_my_coach_record();
    IF v_r->>'status' <> 'linked_to_another' THEN
        RAISE EXCEPTION 'a row linked to another account was not refused: %', v_r;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_e::text, true);
    v_r := public.link_my_coach_record();
    IF v_r->>'status' <> 'no_match' THEN
        RAISE EXCEPTION 'an interested lead was linked as a coach: %', v_r;
    END IF;
    IF EXISTS (SELECT 1 FROM public.coaches WHERE user_id IN (v_b, v_c, v_d, v_e)) THEN
        RAISE EXCEPTION 'a refused call linked a row';
    END IF;
    RAISE NOTICE 'unverified, other-organization, linked-to-another and interested-lead callers were refused, 4 of 4; nothing linked';

    IF NOT (has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE')
            AND has_column_privilege('authenticated', 'public.profiles', 'first_name', 'UPDATE')
            AND has_column_privilege('authenticated', 'public.profiles', 'last_name', 'UPDATE')
            AND has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE')) THEN
        RAISE EXCEPTION 'authenticated lost UPDATE on a profile column it should keep';
    END IF;
    IF has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
       OR has_column_privilege('authenticated', 'public.profiles', 'organization_id', 'UPDATE')
       OR has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE')
       OR has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
       OR has_table_privilege('anon', 'public.profiles', 'UPDATE')
       OR has_column_privilege('anon', 'public.profiles', 'full_name', 'UPDATE') THEN
        RAISE EXCEPTION 'a profile column other than the four, or any for anon, is still updatable';
    END IF;
    RAISE NOTICE 'profiles: authenticated updates the four account-page columns and no other; anon updates nothing';

    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public']
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              FROM pg_proc p WHERE p.oid = 'public.link_my_coach_record()'::regprocedure) THEN
        RAISE EXCEPTION 'link_my_coach_record has the wrong posture';
    END IF;
    RAISE NOTICE 'posture: SECURITY DEFINER, search_path=public, EXECUTE for authenticated and not anon';
END;
$$;

ROLLBACK;
