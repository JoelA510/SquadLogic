-- Revert for 20261029020000_register_invite_redeemed_audit_action.sql
--
-- Unregisters `members.invited_joined` only while no audit row uses it. Once
-- one does, the registration stays: removing it would fail the foreign key
-- from `audit_log.action`, and audit history is not this revert's to erase.
-- Either way the transcript says which happened. After an unregistering
-- revert every invite redemption fails on the foreign key again and rolls
-- back, as it did before the forward migration.

BEGIN;

DO $revert$
DECLARE
    v_rows integer;
BEGIN
    SELECT count(*) INTO v_rows FROM public.audit_log WHERE action = 'members.invited_joined';
    IF v_rows = 0 THEN
        DELETE FROM public.audit_actions WHERE action = 'members.invited_joined';
        IF EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'members.invited_joined') THEN
            RAISE EXCEPTION 'members.invited_joined survived its own revert';
        END IF;
        RAISE NOTICE 'revert verified: members.invited_joined is unregistered; no audit row used it';
    ELSE
        RAISE NOTICE 'members.invited_joined stays registered: % audit row(s) use it', v_rows;
    END IF;
END;
$revert$;

COMMIT;
