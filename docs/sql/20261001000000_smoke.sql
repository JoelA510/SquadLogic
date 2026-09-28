-- Smoke checks for 20261001000000_drop_coach_preferred_practice_columns.sql
--
-- Assertions RAISE; the NOTICE is the evidence `scripts/dbharness/run.sh`
-- turns into a (checked) claim, proven by plants in
-- `scripts/dbharness/prove.sh` (8.6 PR 3b plan §4 "Retire dead fields").
--
-- A column dropped while something still reads it is a live break, so the
-- catalogue is searched for any reader: function bodies, views, materialised
-- views, policies, constraints, column defaults and index expressions.
--
-- **Each search proves it read something.** A scan of function bodies that
-- matched zero rows because it scanned zero rows would pass for the wrong
-- reason, so the same scan must find the functions that name a sibling column
-- still on the table (`can_coach_multiple_teams`, read by the coach
-- assignment RPCs), and the column lookup must find that sibling.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_remaining int;
    v_sibling int;
    v_functions int;
    v_sibling_readers int;
    v_readers int;
BEGIN
    SELECT count(*) FILTER (WHERE column_name IN ('preferred_practice_days', 'preferred_practice_window')),
           count(*) FILTER (WHERE column_name = 'can_coach_multiple_teams')
      INTO v_remaining, v_sibling
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'coaches';
    IF v_sibling <> 1 THEN
        RAISE EXCEPTION 'the column lookup did not find coaches.can_coach_multiple_teams (found %), so it proves nothing about the dropped columns', v_sibling;
    END IF;
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'coaches still carries % of the 2 preferred_practice columns', v_remaining;
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE p.prosrc ~* 'can_coach_multiple_teams')
      INTO v_functions, v_sibling_readers
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public';
    IF v_sibling_readers = 0 THEN
        RAISE EXCEPTION 'the function-body scan read % public function(s) and found none naming can_coach_multiple_teams, so it cannot be trusted to find a reader', v_functions;
    END IF;

    SELECT (SELECT count(*)
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prosrc ~* 'preferred_practice')
         + (SELECT count(*) FROM pg_views
             WHERE schemaname = 'public' AND definition ~* 'preferred_practice')
         + (SELECT count(*) FROM pg_matviews
             WHERE schemaname = 'public' AND definition ~* 'preferred_practice')
         + (SELECT count(*) FROM pg_policies
             WHERE coalesce(qual, '') || coalesce(with_check, '') ~* 'preferred_practice')
         + (SELECT count(*) FROM pg_constraint c
             WHERE c.connamespace = 'public'::regnamespace
               AND pg_get_constraintdef(c.oid) ~* 'preferred_practice')
         + (SELECT count(*) FROM pg_attrdef d
             JOIN pg_class k ON k.oid = d.adrelid
             WHERE k.relnamespace = 'public'::regnamespace
               AND pg_get_expr(d.adbin, d.adrelid) ~* 'preferred_practice')
         + (SELECT count(*) FROM pg_indexes
             WHERE schemaname = 'public' AND indexdef ~* 'preferred_practice')
      INTO v_readers;
    IF v_readers <> 0 THEN
        RAISE EXCEPTION '% catalogue object(s) in public still name a preferred_practice column', v_readers;
    END IF;

    RAISE NOTICE 'preferred_practice columns: 0 of 2 remain on coaches, and 0 catalogue objects name them (scanned % public function bodies, % of which name can_coach_multiple_teams)',
        v_functions, v_sibling_readers;
END;
$$;

ROLLBACK;
