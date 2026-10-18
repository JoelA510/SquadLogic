-- Smoke checks for 20260726000100_fix_organizations_write_policy.sql

-- 1. The old JWT-claim-trusting policy is gone. Expect zero rows.
select 'stale JWT-claim write policy (expect zero rows)' as check,
       policyname
from pg_policies
where schemaname = 'public'
  and tablename = 'organizations'
  and policyname = 'Admins can manage organizations';

-- 2. The new org-membership-gated policy exists and every clause it has
--    references is_org_admin (not a raw JWT claim). Since
--    20261018030000_rls_advisor_rewrite.sql it is three policies, one per
--    command ("Organizations: admins insert", "... update", "... delete"),
--    replacing the FOR ALL "Organizations: admins manage" with the same
--    expression. Expect three rows; INSERT has no USING and DELETE no WITH
--    CHECK, so those columns read NULL there and true everywhere else.
select 'new policy is is_org_admin-gated (expect 3 rows, every clause present mentions is_org_admin)' as check,
       policyname, cmd,
       qual like '%is_org_admin%' as using_gated,
       with_check like '%is_org_admin%' as with_check_gated
from pg_policies
where schemaname = 'public'
  and tablename = 'organizations'
  and policyname in ('Organizations: admins insert', 'Organizations: admins update',
                     'Organizations: admins delete')
order by policyname;

-- 3. The pre-existing read policy ("Organizations: members can access") is
--    untouched by this migration. Expect one row.
select 'read policy untouched (expect 1 row)' as check, count(*) as row_count
from pg_policies
where schemaname = 'public'
  and tablename = 'organizations'
  and policyname = 'Organizations: members can access';

-- 4. initialize_new_tenant (the only org-creation path) is SECURITY DEFINER,
--    so it bypasses this RLS policy entirely -- confirms the hardening does
--    not block onboarding. Expect security_type = 'DEFINER'.
select 'initialize_new_tenant remains SECURITY DEFINER (expect DEFINER)' as check,
       routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'initialize_new_tenant';

-- Behavioral (cross-org admin denied, in-org non-admin denied, in-org admin
-- still allowed) verification lives in the pgTAP suite:
-- supabase/tests/rls_organizations_admin_scoped_write.sql (run via
-- `npm run test:db`), since it needs a real authenticated-role session.
