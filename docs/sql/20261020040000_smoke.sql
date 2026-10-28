-- Smoke checks for 20261020040000_identity_guards.sql
--
-- What it proves, with prelude.sql's `auth.uid()` stub:
--   * profiles: authenticated may update first_name, last_name, full_name and
--     avatar_url and no other column; anon may update nothing;
--   * link_my_coach_record, which that migration added, stays dropped: no coach
--     signs in, so nobody links a sign-in account to a coach record
--     (20261104010000 dropped it, and 20261104020000 the `coaches.user_id`
--     column it wrote). Its linking, audit and refusal cases went with it.
--
-- Wrapped in BEGIN ... ROLLBACK. There is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
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

    IF to_regprocedure('public.link_my_coach_record()') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'link_my_coach_record') THEN
        RAISE EXCEPTION 'link_my_coach_record is back: no coach signs in (20261104010000)';
    END IF;
    RAISE NOTICE 'link_my_coach_record stays dropped (20261104010000)';
END;
$$;

ROLLBACK;
