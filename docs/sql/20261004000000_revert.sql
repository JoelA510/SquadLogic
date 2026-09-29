-- Revert for 20261004000000_enact_practice_recommendation.sql
--
-- Drops the enact wrapper `enact_practice_recommendation`. Nothing else: the
-- migration created no table and changed no other function, and
-- `persist_practice_schedule` was never touched, so it stays exactly as
-- 20261002000000 left it.
--
-- What an enact wrote stays: its rows are ordinary `practice_assignments`
-- rows (`assigned_via = 'recommendation'`), its tail exceptions ordinary
-- `practice_exceptions`, and its runs ordinary `scheduler_runs`. The
-- `practice.recommendation_enacted` audit action and every audit row written
-- under it stay registered: audit history is not this revert's to erase. The
-- count is printed so the transcript of a revert says what it leaves behind.

BEGIN;

DO $warn$
DECLARE
    v_enacts integer;
BEGIN
    SELECT count(*) INTO v_enacts
      FROM public.audit_log
     WHERE action = 'practice.recommendation_enacted';
    RAISE NOTICE 'this revert removes the enact wrapper; % practice.recommendation_enacted audit row(s) and the rows they enacted stay', v_enacts;
END;
$warn$;

DROP FUNCTION IF EXISTS public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb);

DO $verify$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname = 'enact_practice_recommendation') THEN
        RAISE EXCEPTION 'enact_practice_recommendation survived its own revert';
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname = 'persist_practice_schedule') <> 1 THEN
        RAISE EXCEPTION 'the revert left other than exactly one persist_practice_schedule';
    END IF;
    RAISE NOTICE 'revert verified: enact_practice_recommendation is gone; persist_practice_schedule is untouched; the practice.recommendation_enacted audit action stays registered.';
END;
$verify$;

COMMIT;
