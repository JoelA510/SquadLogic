-- Smoke checks for 20260614000000_advisor_hardening_followups.sql

-- 1. The only anon-executable SECURITY DEFINER function in `public` is the
--    intentionally excluded public-registration RPC. Since 20261022020000
--    dropped it (no in-app registration), expect zero rows.
select 'anon-executable SECURITY DEFINER functions (expect none since 20261022020000)' as check,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and has_function_privilege('anon', p.oid, 'EXECUTE')
order by p.proname;

-- 2. Every plain function flagged by the advisor now pins search_path. Expect
--    zero rows.
select 'flagged functions still missing search_path (expect zero rows)' as check,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in (
    'handle_field_subunits',
    'import_normalize_capacity_basis',
    'import_normalize_field_availability_approval_status',
    'import_normalize_field_availability_record_status',
    'import_normalize_format_code',
    'import_normalize_requirement_status',
    'import_payload_text',
    'import_text_to_bool',
    'import_text_to_date',
    'import_text_to_day_of_week',
    'import_text_to_jsonb_array',
    'import_text_to_positive_int',
    'import_text_to_time',
    'persist_evaluation_run',
    'prune_old_evaluation_runs',
    'set_created_by_to_auth_uid'
  )
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
    where cfg like 'search_path=%'
  );

-- 2b. Exhaustive variant of check 3: NO non-trigger SECURITY DEFINER function
--     lost authenticated EXECUTE (authenticated holds its own ACL entry from
--     Supabase's default privileges, independent of the revoked PUBLIC grant).
--     Expect zero rows.
select 'non-trigger definers not executable by authenticated (expect zero rows)' as check,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
  and not has_function_privilege('authenticated', p.oid, 'EXECUTE');

-- 3. Authenticated RPC surface is intact (samples from the recent CRUD wave).
--    Expect all columns true.
select 'authenticated retains RPC surface' as check,
       has_function_privilege('authenticated', 'public.update_game_score(uuid, uuid, smallint, smallint, jsonb)', 'EXECUTE') as update_game_score,
       has_function_privilege('authenticated', 'public.is_org_admin(uuid)', 'EXECUTE') as is_org_admin,
       has_function_privilege('authenticated', 'public.is_org_member(uuid)', 'EXECUTE') as is_org_member;

-- 4. Default privileges now exclude PUBLIC/anon and include
--    authenticated/service_role for future postgres-created functions in
--    `public`. Expect one row with defaclacl listing authenticated and
--    service_role but NOT anon and no empty-grantee (PUBLIC) entry.
select 'default function privileges (expect authenticated+service_role only)' as check,
       d.defaclacl
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace
join pg_roles r on r.oid = d.defaclrole
where n.nspname = 'public'
  and d.defaclobjtype = 'f'
  and r.rolname = 'postgres';

-- 5. Drift canary: a throwaway SECURITY DEFINER function created after the
--    migration must NOT be executable by anon. Expect anon_exec = false,
--    authenticated_exec = true.
create or replace function public.__smoke_default_priv_canary()
returns boolean
language sql
security definer
set search_path = public
as $$ select true; $$;

select 'new definer function default grants' as check,
       has_function_privilege('anon', 'public.__smoke_default_priv_canary()', 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', 'public.__smoke_default_priv_canary()', 'EXECUTE') as authenticated_exec;

drop function public.__smoke_default_priv_canary();
