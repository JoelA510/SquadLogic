-- Revert for 20261030010000_demo_sessions.sql
--
-- In this order (the plan's rollback, D3): the purge job is unscheduled first; then every demo
-- organization is deleted (with the anonymous users who owned them and belong to nothing else), while
-- the fences are still in place to let the cascade through; then the objects go: the three demo
-- RPCs, the fence triggers and their functions, the two helpers, `demo_purge_log`, `demo_seed`, the
-- unique index and the trigger on `organizations`, and its two columns.
--
-- What it restores, as it stood after 20261029010000: `is_org_member` and `is_org_admin` without the
-- expiry join (`is_org_member` with production's body, which is the build's without its carriage
-- returns: the harness build kept them, production never had them), the `exports` and
-- `raw-imports` insert policies without the demo conjunct, and `prune_old_audit_logs` and
-- `prune_old_evaluation_runs` callable by `authenticated` again (ungated definers: see the
-- migration; reverting reopens that).
--
-- **It destroys data**, counted first: every demo organization (live or expired) and the anonymous
-- visitors it removes. The `demo.started` audit action is deregistered once no audit row uses it.
--
-- **Revert the frontend with it.** The app deployed with D4 calls `start_demo_session`, which then
-- fails; set `VITE_DEMO_ENABLED` unset first, and disable anonymous sign-in on the project
-- (the plan's rollback steps 1 and 2).
--
-- Verified: the harness compares a fingerprint of every restored object with the one read off a build
-- at 20261029010000 (the two helpers' bodies, the prune functions' client grants, the two policies,
-- and the absence of everything added).

BEGIN;

DO $$
DECLARE
    v_demos bigint;
    v_live bigint;
    v_owners bigint;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE demo_expires_at > now()), count(DISTINCT demo_owner)
      INTO v_demos, v_live, v_owners FROM public.organizations WHERE demo_expires_at IS NOT NULL;
    RAISE NOTICE 'this revert DESTROYS % demo organization(s), % of them live, and removes the % anonymous visitor(s) who own them',
        v_demos, v_live, v_owners;
END;
$$;

-- 1. The job first, so nothing runs while the rest comes down.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-demos') THEN
        PERFORM cron.unschedule('purge-expired-demos');
    END IF;
END;
$$;

-- 2. The demo organizations, and the anonymous users who owned them. The fence triggers still stand:
--    an organization's own delete takes its rows through them (the organization is gone by then).
DO $$
DECLARE
    v_owners uuid[];
    v_user uuid;
    v_skipped integer := 0;
BEGIN
    WITH gone AS (
        DELETE FROM public.organizations WHERE demo_expires_at IS NOT NULL RETURNING demo_owner
    )
    SELECT COALESCE(array_agg(demo_owner) FILTER (WHERE demo_owner IS NOT NULL), ARRAY[]::uuid[])
      INTO v_owners FROM gone;
    FOR v_user IN
        SELECT u.id FROM auth.users u
         WHERE u.is_anonymous AND u.id = ANY (v_owners)
           AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.profile_id = u.id)
    LOOP
        BEGIN
            DELETE FROM auth.users WHERE id = v_user;
        EXCEPTION WHEN foreign_key_violation THEN
            v_skipped := v_skipped + 1;
        END;
    END LOOP;
    RAISE NOTICE 'anonymous user(s) left because something still names them: %', v_skipped;
END;
$$;

-- 3. The demo RPCs and the purge's record.
DROP FUNCTION public.start_demo_session();
DROP FUNCTION public.purge_expired_demos();
DROP FUNCTION public.demo_health();
DROP TABLE public.demo_purge_log;

-- 4. The fences.
DROP TRIGGER demo_fence_players ON public.players;
DROP TRIGGER demo_fence_coaches ON public.coaches;
DROP TRIGGER demo_fence_import_jobs ON public.import_jobs;
DROP TRIGGER demo_fence_staging_players ON public.staging_players;
DROP TRIGGER demo_fence_staging_import_rows ON public.staging_import_rows;
DROP TRIGGER demo_fence_organization_members ON public.organization_members;
DROP TRIGGER demo_fence_organization_invites ON public.organization_invites;
DROP FUNCTION public.demo_fence_player_write();
DROP FUNCTION public.demo_fence_coach_write();
DROP FUNCTION public.demo_fence_import_write();
DROP FUNCTION public.demo_fence_membership();
DROP FUNCTION public.demo_fence_invite();

-- 5. The bucket policies, as at 20261029010000, so `is_demo_org` has no dependent.
ALTER POLICY "exports org-admin insert" ON storage.objects
    WITH CHECK (
        bucket_id = 'exports'
        AND CASE
            WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

ALTER POLICY "raw-imports org-member insert" ON storage.objects
    WITH CHECK (
        bucket_id = 'raw-imports'
        AND auth.role() = 'authenticated'
        AND ((storage.foldername(name))[1])::uuid IN (
            SELECT organization_id FROM public.organization_members WHERE profile_id = auth.uid()
        )
    );

DROP FUNCTION public.is_demo_org(uuid);
DROP FUNCTION public.caller_is_anonymous();

-- 6. The helpers, without the expiry join. is_org_member's body is production's (LF line endings).
CREATE OR REPLACE FUNCTION public.is_org_member(org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.organization_members
        WHERE organization_id = org_id
          AND profile_id = auth.uid()
    );
END;
$function$;

-- is_org_admin's body is 20261020030000's byte for byte (it carries trailing spaces, which a source
-- file here would lose), so it is built from a string.
DO $revert$
BEGIN
    EXECUTE 'CREATE OR REPLACE FUNCTION public.is_org_admin(p_org_id uuid) RETURNS boolean '
         || 'LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS '
         || quote_literal(E'\nBEGIN\n    RETURN EXISTS (\n        SELECT 1 \n        FROM public.organization_members \n'
                          || E'        WHERE organization_id = p_org_id \n          AND profile_id = auth.uid() \n'
                          || E'          AND role IN (\'admin\', \'tenant_admin\', \'staff\')\n    );\nEND;\n');
END;
$revert$;

-- 7. The retention sweeps are callable by a signed-in user again, as they were.
GRANT EXECUTE ON FUNCTION public.prune_old_audit_logs() TO authenticated;
GRANT EXECUTE ON FUNCTION public.prune_old_evaluation_runs() TO authenticated;

-- 8. The league, the columns and the trigger.
DROP TABLE demo_seed.team_coaches;
DROP TABLE demo_seed.practice_slots;
DROP TABLE demo_seed.field_subunits;
DROP TABLE demo_seed.fields;
DROP TABLE demo_seed.locations;
DROP TABLE demo_seed.players;
DROP TABLE demo_seed.coaches;
DROP TABLE demo_seed.teams;
DROP TABLE demo_seed.divisions;
DROP TABLE demo_seed.league;
DROP SCHEMA demo_seed;

DROP TRIGGER organizations_guard_demo_columns ON public.organizations;
DROP FUNCTION public.organizations_guard_demo_columns();
DROP INDEX public.organizations_demo_owner_live_key;
DROP INDEX public.organizations_demo_expires_at_idx;
ALTER TABLE public.organizations DROP COLUMN demo_owner, DROP COLUMN demo_expires_at;

DELETE FROM public.audit_actions a
 WHERE a.action = 'demo.started'
   AND NOT EXISTS (SELECT 1 FROM public.audit_log l WHERE l.action = 'demo.started');

DO $$
BEGIN
    IF to_regprocedure('public.start_demo_session()') IS NOT NULL
       OR to_regclass('demo_seed.players') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.organizations'::regclass
                   AND attname IN ('demo_expires_at', 'demo_owner') AND NOT attisdropped) THEN
        RAISE EXCEPTION 'the demo objects are not all gone';
    END IF;
END;
$$;

COMMIT;
