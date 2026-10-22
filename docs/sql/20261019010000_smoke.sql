-- Smoke checks for 20261019010000_submit_registration_throttle.sql
--
-- The harness runs every smoke on the database built to head. Since
-- 20261022020000 removed the in-app registration flow (plan
-- docs/changes/2026-10-22-admin-focus.md, R1), nothing this migration made is
-- left there: `submit_registration`, its throttle index and the four split
-- `registrations` policies went with the `registrations` table. The behaviour
-- this smoke used to exercise (ten registrations to one form per caller per
-- 60 seconds, refused PT429 after; the rows not the caller's to edit) is in
-- git history at 6a22d29; the revert check for this migration still runs on a
-- database built only up to it (scripts/dbharness/run.sh).
--
-- What it proves now: none of the throttle's objects came back -- the
-- function, the index, the four policies and the table they sit on are
-- absent -- and no SECURITY DEFINER function in `public` is executable by
-- anon (submit_registration was the one exception the 20260603120000 revoke
-- left).
--
-- Wrapped in BEGIN ... ROLLBACK; it reads the catalogue and writes nothing.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(o, ', ') INTO v_left FROM (
        SELECT 'submit_registration' AS o
         WHERE to_regprocedure('public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)') IS NOT NULL
        UNION ALL
        SELECT 'registrations' WHERE to_regclass('public.registrations') IS NOT NULL
        UNION ALL
        SELECT 'registrations_profile_form_created_idx'
         WHERE to_regclass('public.registrations_profile_form_created_idx') IS NOT NULL
        UNION ALL
        SELECT format('policy %s', policyname) FROM pg_policies
         WHERE schemaname = 'public' AND policyname LIKE 'registrations\_%'
    ) s;
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'the throttle''s objects are back after 20261022020000 dropped them: %', v_left;
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'SECURITY DEFINER functions executable by anon: %', v_left;
    END IF;
    RAISE NOTICE 'submit_registration, its throttle index and its registrations policies are gone (20261022020000), and no SECURITY DEFINER function is executable by anon';
END;
$$;

ROLLBACK;
