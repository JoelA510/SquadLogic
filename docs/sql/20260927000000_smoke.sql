-- Smoke checks for 20260927000000_coach_practice_preferences.sql
--
-- This migration made the store and its three scalar RPCs. Since then 20261104010000 dropped the
-- request RPC (no coach signs in) and 20261112010000 replaced the scalar rows with rules per team and
-- dropped `admin_decide_coach_practice_preference` and `admin_set_coach_practice_preference`; the
-- round trips this file used to run against them are the new migration's
-- (`docs/sql/20261112010000_smoke.sql`). What stays true of THIS migration at HEAD, and is checked
-- here: the store is closed to clients (RLS on, one SELECT policy, no write policy or grant), its four
-- audit actions are still registered (the history it wrote still names them), and none of its three
-- RPCs is left.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_select int;
    v_actions int;
BEGIN
    IF NOT (SELECT c.relrowsecurity FROM pg_class c
             WHERE c.oid = 'public.coach_practice_preferences'::regclass) THEN
        RAISE EXCEPTION 'coach_practice_preferences does not have ROW LEVEL SECURITY enabled';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy
                WHERE polrelid = 'public.coach_practice_preferences'::regclass AND polcmd <> 'r') THEN
        RAISE EXCEPTION 'coach_practice_preferences carries a write policy; its only writers are the definer RPCs';
    END IF;
    SELECT count(*) INTO v_select
      FROM pg_policy
     WHERE polrelid = 'public.coach_practice_preferences'::regclass AND polcmd = 'r';
    IF v_select <> 1 THEN
        RAISE EXCEPTION 'expected exactly one SELECT policy on coach_practice_preferences, found %', v_select;
    END IF;
    IF has_table_privilege('authenticated', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'DELETE')
       OR has_table_privilege('service_role', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('anon', 'public.coach_practice_preferences', 'SELECT') THEN
        RAISE EXCEPTION 'a client role holds a write (or anon a read) privilege on coach_practice_preferences';
    END IF;
    SELECT count(*) INTO v_actions FROM public.audit_actions
     WHERE action IN ('coach_preference.requested', 'coach_preference.approved',
                      'coach_preference.rejected', 'coach_preference.changed');
    IF v_actions <> 4 THEN
        RAISE EXCEPTION 'expected the 4 coach_preference.* audit actions to stay registered, found %', v_actions;
    END IF;
    IF to_regprocedure('public.request_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.admin_decide_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.admin_set_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL THEN
        RAISE EXCEPTION 'one of the three scalar preference RPCs is still there';
    END IF;
    RAISE NOTICE 'coach preferences (20260927000000): RLS on, 1 SELECT policy, 0 write policies, no client write grant; the 4 coach_preference.* audit actions registered; the 3 scalar RPCs gone';
END;
$$;

ROLLBACK;
