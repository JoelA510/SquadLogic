-- Revert for 20261020040000_identity_guards.sql
--
-- Drops link_my_coach_record() and restores the table-level UPDATE grant on
-- profiles to anon and authenticated, as production had it before the change
-- (read 2026-10-20), so users can again update every column of their own row,
-- role and organization_id included.
--
-- What it keeps: every `coaches.user_id` link the function made, and the
-- `coach.linked` audit rows (and so the action's registration, if any exist). They are
-- correct links, and other code reads them; unlinking is a separate decision
-- (`UPDATE public.coaches SET user_id = NULL WHERE ...`).
--
-- Verified: the harness checks the function is gone and that authenticated
-- holds table-level UPDATE on profiles again.

BEGIN;

DROP FUNCTION IF EXISTS public.link_my_coach_record();

-- The action stays registered while any audit row names it (the foreign key
-- would refuse the delete); otherwise it goes.
DELETE FROM public.audit_actions a
 WHERE a.action = 'coach.linked'
   AND NOT EXISTS (SELECT 1 FROM public.audit_log l WHERE l.action = a.action);

REVOKE UPDATE (first_name, last_name, full_name, avatar_url) ON public.profiles FROM authenticated;
GRANT UPDATE ON public.profiles TO anon, authenticated;

COMMIT;
