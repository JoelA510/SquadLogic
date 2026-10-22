-- Smoke test for 20260613000001_form_mutation_rpcs.sql
-- Since 20261022020000 dropped both RPCs with the in-app registration flow,
-- the two RPC queries return 0 rows; the audit actions stay (audit_log
-- references them).
-- Verify the RPCs are accessible to authenticated role.
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('admin_update_registration_form', 'admin_delete_registration_form');
-- Expected: 2 rows (0 since 20261022020000)

-- Verify SECURITY DEFINER
SELECT proname, prosecdef
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE pg_namespace.nspname = 'public'
  AND proname IN ('admin_update_registration_form', 'admin_delete_registration_form');
-- Expected: both prosecdef = true (no rows since 20261022020000)

-- Verify audit actions are registered (audit_actions lookup table replaced
-- the CHECK constraint in 20260613000006_audit_actions_lookup.sql)
SELECT action FROM public.audit_actions
WHERE action IN ('registration.form_updated', 'registration.form_deleted');
-- Expected: 2 rows
