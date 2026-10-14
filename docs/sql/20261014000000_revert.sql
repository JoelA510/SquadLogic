-- Revert for 20261014000000_register_scheduler_auto_refused.sql
--
-- Unregisters `scheduler.auto_refused` only while no audit row uses it. Once
-- one does, the registration stays: removing it would fail the foreign key
-- from `audit_log.action`, and audit history is not this revert's to erase.
-- Either way the transcript says which happened. After an unregistering
-- revert the auto-scheduler's refusal audits fail again (logged, never a 500).

BEGIN;

DO $revert$
DECLARE
    v_rows integer;
BEGIN
    SELECT count(*) INTO v_rows FROM public.audit_log WHERE action = 'scheduler.auto_refused';
    IF v_rows = 0 THEN
        DELETE FROM public.audit_actions WHERE action = 'scheduler.auto_refused';
        IF EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'scheduler.auto_refused') THEN
            RAISE EXCEPTION 'scheduler.auto_refused survived its own revert';
        END IF;
        RAISE NOTICE 'revert verified: scheduler.auto_refused is unregistered; no audit row used it';
    ELSE
        RAISE NOTICE 'scheduler.auto_refused stays registered: % audit row(s) use it', v_rows;
    END IF;
END;
$revert$;

COMMIT;
