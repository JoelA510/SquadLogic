-- Smoke checks for 20260603120000_revoke_anon_execute_on_definer_functions.sql

-- 1. After the migration, the ONLY anon-executable SECURITY DEFINER function in
--    `public` is the intentionally excluded public-registration RPC. Since
--    20261022020000 dropped it (no in-app registration), expect zero rows.
select 'anon-executable SECURITY DEFINER functions (expect none since 20261022020000)' as check,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and has_function_privilege('anon', p.oid, 'EXECUTE')
order by p.proname;

-- 2. RLS helpers remain executable by `authenticated` (RLS policies scoped to
--    authenticated reference them). Expect both columns true.
select 'authenticated retains RLS helpers' as check,
       has_function_privilege('authenticated', 'public.is_org_admin(uuid)', 'EXECUTE')  as is_org_admin,
       has_function_privilege('authenticated', 'public.is_org_member(uuid)', 'EXECUTE') as is_org_member;

-- 3. Trigger functions are not directly executable by any client role
--    (sample: handle_new_user). Expect both columns false.
select 'trigger fn not client-executable' as check,
       has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE') as authenticated_exec;

-- 4. service_role is unaffected, so server-side / Edge Function paths keep
--    working (sample: create_import_job). Expect true.
select 'service_role retained' as check,
       has_function_privilege('service_role', 'public.create_import_job(uuid, text, text, uuid)', 'EXECUTE') as create_import_job;
