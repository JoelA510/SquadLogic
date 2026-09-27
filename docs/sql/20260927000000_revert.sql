-- Revert for 20260927000000_coach_practice_preferences.sql
--
-- **This revert DESTROYS every coach practice preference**: requested,
-- decided and superseded alike. No other table records them, so the figures
-- are printed BEFORE the drop and the transcript of a revert says what it
-- cost. `scripts/dbharness/run.sh` plants 3 rows across 2 coaches, 1 of them
-- approved, and checks this warning prints exactly those figures.
--
-- Removes the three RPCs and the table. The four coach_preference.* audit
-- actions and the audit rows written under them stay: audit history is not
-- this revert's to erase.

BEGIN;

DO $warn$
DECLARE
    v_rows integer;
    v_coaches integer;
    v_approved integer;
BEGIN
    SELECT count(*), count(DISTINCT coach_id), count(*) FILTER (WHERE status = 'approved')
      INTO v_rows, v_coaches, v_approved
      FROM public.coach_practice_preferences;
    RAISE WARNING 'this revert DESTROYS % coach practice preference row(s) across % coach(es); % of them are APPROVED and in force',
        v_rows, v_coaches, v_approved;
END;
$warn$;

DROP FUNCTION IF EXISTS public.admin_set_coach_practice_preference(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.admin_decide_coach_practice_preference(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.request_coach_practice_preference(uuid, text, text, jsonb);
DROP TABLE IF EXISTS public.coach_practice_preferences;

DO $verify$
BEGIN
    IF to_regclass('public.coach_practice_preferences') IS NOT NULL THEN
        RAISE EXCEPTION 'coach_practice_preferences survived its own revert';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname IN ('request_coach_practice_preference',
                                    'admin_decide_coach_practice_preference',
                                    'admin_set_coach_practice_preference')) THEN
        RAISE EXCEPTION 'a coach practice preference RPC survived its own revert';
    END IF;
    RAISE NOTICE 'revert verified: coach_practice_preferences and its three RPCs are gone; the coach_preference.* audit actions stay registered.';
END;
$verify$;

COMMIT;
