-- Smoke checks for 20260611000100_player_admin_mutation_rpcs.sql

-- 1. All five public RPCs exist as SECURITY DEFINER with pinned search_path,
--    and anon cannot execute any of them (four since 20261022020000 dropped
--    coach_update_player_compliance).
select p.proname,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ',') as config,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute_expect_false,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_update_player', 'admin_bulk_update_players',
                    'admin_create_player', 'admin_delete_players',
                    'coach_update_player_compliance')
order by p.proname;

-- 2. Patch sanitizer rejects unknown fields (expect ERROR).
-- select public.sanitize_player_patch('{"hacker_field": true}'::jsonb);

-- 3. Patch sanitizer normalizes a representative patch. (`paid` left it in
--    20261022020000, which dropped the column; a patch naming it is refused.)
select public.sanitize_player_patch(
  '{"rating": 4, "status": "waitlist", "jersey_number": 12}'::jsonb
) as sanitized;
