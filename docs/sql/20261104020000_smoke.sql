-- Smoke checks for 20261104020000_drop_coach_user_link.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   * `public.coaches` has neither `user_id` nor `profile_id`, and neither of their constraints
--     (`coaches_user_id_fkey`, `coaches_user_id_key`, `coaches_profile_id_fkey`);
--   * no foreign key from `coaches` reaches `auth.users` or `public.profiles`, and no index of it
--     names either column;
--   * no function body in `public` reads `coaches.user_id` or `coaches.profile_id`, and no policy
--     expression on `coaches` names `user_id`;
--   * a coach is still written, and read by its organization's admin, without either column, and the
--     per-organization coach key of 20261104010000 stands.
--
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_org uuid;
    v_admin uuid := gen_random_uuid();
    v_n integer;
    v_def text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'public.coaches'::regclass AND attnum > 0 AND NOT attisdropped
                  AND attname IN ('user_id', 'profile_id')) THEN
        RAISE EXCEPTION 'public.coaches still has user_id or profile_id';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.coaches'::regclass
                  AND conname IN ('coaches_user_id_fkey', 'coaches_user_id_key', 'coaches_profile_id_fkey')) THEN
        RAISE EXCEPTION 'a constraint of the dropped columns survived';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.coaches'::regclass AND contype = 'f'
                  AND confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)) THEN
        RAISE EXCEPTION 'a foreign key from coaches still reaches auth.users or profiles';
    END IF;
    -- Not vacuous: the table keeps its organization foreign key.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.coaches'::regclass AND contype = 'f'
                      AND confrelid = 'public.organizations'::regclass) THEN
        RAISE EXCEPTION 'coaches lost its organization foreign key (the scan above would pass on an empty table)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                WHERE i.indrelid = 'public.coaches'::regclass AND c.relname IN ('coaches_user_id_key', 'idx_coaches_user_id', 'idx_coaches_profile_id')) THEN
        RAISE EXCEPTION 'an index of the dropped columns survived';
    END IF;
    -- Many functions name user_id for audit_log or auth.uid(); the pattern that matters is a column
    -- reference through the coaches table or one of its usual aliases.
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_def
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(\mcoaches\M\.|\mc\.|\mco\.)(user_id|profile_id)\M';
    IF v_def IS NOT NULL THEN RAISE EXCEPTION 'a function reads coaches.user_id or coaches.profile_id: %', v_def; END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'coaches'
                AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'user_id') THEN
        RAISE EXCEPTION 'a policy on coaches names user_id';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.coaches'::regclass AND conname = 'coaches_organization_id_email_key') THEN
        RAISE EXCEPTION 'the per-organization coach key is missing';
    END IF;

    -- A coach is written and read without either column.
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_admin, 'dl-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'dl-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Drop Link', 'smoke-drop-link') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.coaches (organization_id, full_name, email, status) VALUES (v_org, 'DL Coach', 'dl-coach@example.test', 'active');
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.coaches WHERE organization_id = v_org;
    RESET ROLE;
    IF v_n <> 1 THEN RAISE EXCEPTION 'the admin reads % coaches of their organization, expected 1', v_n; END IF;
    RAISE NOTICE 'coaches has no user_id and no profile_id; no foreign key reaches auth.users; a coach is written and read without them';
END;
$$;

ROLLBACK;
