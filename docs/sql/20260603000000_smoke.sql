-- Smoke checks for 20260603000000_field_availability_scenario_selection_rpc.sql

-- 1. Selection RPC exists, is SECURITY DEFINER, and pins search_path.
select 'admin_select_field_availability_scenario defined' as check,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ',') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_select_field_availability_scenario';

-- 2. Listing helper exists, is SECURITY DEFINER, and pins search_path.
select 'get_field_availability_scenarios defined' as check,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ',') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_field_availability_scenarios';

-- 3. The partial unique index that enforces one active scenario per
--    (organization_id, season_label, exclusivity_group) is present, unique,
--    and partial (has a WHERE predicate). Expect is_unique = true and a
--    non-null partial_predicate.
select 'uq_field_availability_one_active_per_group present' as check,
       i.indisunique as is_unique,
       pg_get_expr(i.indpred, i.indrelid) as partial_predicate
from pg_class c
join pg_index i on i.indexrelid = c.oid
where c.relname = 'uq_field_availability_one_active_per_group';

-- 4. Admin guard fires for a non-member caller (run without an authenticated
--    org-admin context). Expect: ERROR "Access denied" (SQLSTATE 42501),
--    confirming the function compiles and the permission check is wired before
--    any row is touched.
select public.admin_select_field_availability_scenario(
  gen_random_uuid(), 'Fall 2026', 'venue_j', gen_random_uuid()
);
