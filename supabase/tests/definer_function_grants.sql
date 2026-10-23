-- pgTAP: SECURITY DEFINER function EXECUTE grants are hardened against anon.
--
-- Asserts the end state of
-- supabase/migrations/20260603120000_revoke_anon_execute_on_definer_functions.sql:
--   * anon cannot execute admin RPCs, RLS helpers, or trigger functions;
--   * authenticated keeps admin RPCs + RLS helpers but loses trigger functions;
--   * anon retains the intentionally-excluded public registration RPC;
--   * the import finalizers stay authenticated-only, and the import allowlist's
--     helpers and the purge (20261022010000) are executable by no client role.
-- Grant checks need no fixtures, so this suite seeds nothing.

BEGIN;

SELECT plan(12);

-- anon EXECUTE is revoked across admin RPCs, RLS helpers and trigger functions.
SELECT ok(
  NOT has_function_privilege('anon', 'public.admin_select_field_availability_scenario(uuid,text,text,uuid)', 'EXECUTE'),
  'anon cannot execute admin_select_field_availability_scenario'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.create_import_job(uuid,text,text)', 'EXECUTE'),
  'anon cannot execute create_import_job'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.is_org_admin(uuid)', 'EXECUTE'),
  'anon cannot execute is_org_admin (RLS helper)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE'),
  'anon cannot execute trigger fn handle_new_user'
);

-- authenticated keeps RLS helpers and admin RPCs (no behavior change for admins).
SELECT ok(
  has_function_privilege('authenticated', 'public.is_org_member(uuid)', 'EXECUTE'),
  'authenticated retains is_org_member (referenced by RLS policies)'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.admin_select_field_availability_scenario(uuid,text,text,uuid)', 'EXECUTE'),
  'authenticated retains admin_select_field_availability_scenario'
);

-- Trigger functions need no direct grant, so authenticated loses EXECUTE too.
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE'),
  'authenticated cannot execute trigger fn handle_new_user'
);

-- Intentional exclusion: the public /register route runs submit_registration as anon.
SELECT ok(
  has_function_privilege('anon', 'public.submit_registration(uuid,uuid,uuid,jsonb,uuid,text,text)', 'EXECUTE'),
  'anon retains submit_registration (public registration route)'
);

-- The import finalizers (replaced by 20261022010000) keep their grants.
SELECT ok(
  has_function_privilege('authenticated', 'public.finalize_coach_import_job(uuid,jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.finalize_import_job(uuid,jsonb)', 'EXECUTE'),
  'authenticated retains both import finalizers'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.finalize_coach_import_job(uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.finalize_import_job(uuid,jsonb)', 'EXECUTE'),
  'anon cannot execute either import finalizer'
);

-- The allowlist helper and the purge run only inside the finalizers and the
-- migration, as their owner.
SELECT is(
  ARRAY(
    SELECT f FROM unnest(ARRAY[
      'public.import_allowed_keys(text)',
      'public.import_declared_fields(uuid,text)',
      'public.import_declared_attributes(jsonb,jsonb)',
      'public.import_kept_player_attributes(jsonb,jsonb)',
      'public.import_allowed_payload(text,jsonb,jsonb)'
    ]) f
    WHERE has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
  ),
  ARRAY[]::text[],
  'no client role can execute any of the five import allowlist helpers'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.minimise_import_people_data()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.minimise_import_people_data()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.minimise_import_people_data()', 'EXECUTE'),
  'no client role, service_role included, can execute minimise_import_people_data'
);

SELECT * FROM finish();

ROLLBACK;
