-- Smoke test for 20260613000005_crud_review_fixes.sql

-- Exactly one create-form overload, now with p_waiver_text
-- `pg_proc.oid`, not a bare `oid`: pg_namespace is joined in, both catalogues
-- have an `oid` column, and the unqualified reference made this file raise
-- 42702 on its very first statement. Nothing ran it -- `run.sh` scoped smoke
-- execution to a hand-maintained list this id was not on -- so a smoke that
-- could not execute at all read as a smoke that passed.
SELECT proname, pg_get_function_identity_arguments(pg_proc.oid) AS args
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public' AND proname = 'admin_create_registration_form';
-- Expected: 1 row, args include "p_waiver_text text"

-- Members read path exists and is SECURITY DEFINER
SELECT proname, prosecdef
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public' AND proname = 'get_organization_members';
-- Expected: prosecdef = true

-- tenant_admin guard present in member RPCs
SELECT proname
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public'
  AND proname IN ('admin_remove_member', 'admin_change_member_role')
  AND prosrc LIKE '%tenant_admin%';
-- Expected: 2 rows

-- season org check present in form update RPC
SELECT proname
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public'
  AND proname = 'admin_update_registration_form'
  AND prosrc LIKE '%Season settings do not belong%';
-- Expected: 1 row
