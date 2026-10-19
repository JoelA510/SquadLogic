-- Revert for 20261019010000_submit_registration_throttle.sql
--
-- Restores `submit_registration` as 20260602010000 defines it (the text is
-- copied from that migration, not retyped) and drops the index the throttle
-- added, and restores the single FOR ALL `registrations_user_own_or_admin`
-- policy in its 20261018030000 form (the (select auth.uid()) rewrite) in place
-- of the four the throttle split it into. Nothing else changed: the signature,
-- the grants (anon and authenticated keep EXECUTE) and the comment were never touched.
--
-- Verified: the revert fails unless the restored body has no throttle and keeps
-- its posture (SECURITY DEFINER, search_path=public); the harness also compares
-- the body's md5 with 20260602010000's.

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_registration(
  p_organization_id uuid,
  p_form_id uuid,
  p_profile_id uuid,
  p_responses jsonb,
  p_player_id uuid DEFAULT NULL::uuid,
  p_first_name text DEFAULT NULL::text,
  p_last_name text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_caller          uuid := auth.uid();
    v_player_id       uuid := p_player_id;
    v_registration_id uuid;
    v_division_id     uuid;
BEGIN
    -- Caller may only submit on their own behalf.
    IF v_caller IS NULL OR p_profile_id <> v_caller THEN
        RAISE EXCEPTION 'Access denied: profile mismatch.'
          USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_member(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: User is not a member of organization %', p_organization_id
          USING ERRCODE = '42501';
    END IF;

    -- Form must belong to the org and be open. Decide existence via FOUND, not
    -- the nullable division_id (org-level forms legitimately have NULL division).
    SELECT rf.division_id INTO v_division_id
    FROM public.registration_forms rf
    WHERE rf.id = p_form_id
      AND rf.organization_id = p_organization_id
      AND rf.status = 'open';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or closed registration form for organization %', p_organization_id
          USING ERRCODE = '22023';
    END IF;

    IF v_player_id IS NULL THEN
        IF p_first_name IS NULL OR btrim(p_first_name) = ''
           OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
            RAISE EXCEPTION 'New player registration requires first and last name.'
              USING ERRCODE = '22023';
        END IF;

        -- Creating a new player requires a division; only division-bound forms can.
        IF v_division_id IS NULL THEN
            RAISE EXCEPTION 'Cannot register a new player: form % is not bound to a division. Ask an admin to set the form''s division.', p_form_id
              USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.players (organization_id, first_name, last_name, division_id)
        VALUES (p_organization_id, btrim(p_first_name), btrim(p_last_name), v_division_id)
        RETURNING id INTO v_player_id;
    ELSE
        -- Existing player must belong to the org and already be linked to the caller.
        IF NOT EXISTS (
            SELECT 1 FROM public.players p
            WHERE p.id = v_player_id AND p.organization_id = p_organization_id
        ) THEN
            RAISE EXCEPTION 'Invalid player for organization %', p_organization_id
              USING ERRCODE = '42501';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.profile_players pp
            WHERE pp.profile_id = v_caller
              AND pp.player_id = v_player_id
              AND pp.organization_id = p_organization_id
        ) THEN
            RAISE EXCEPTION 'Access denied: player is not linked to caller profile.'
              USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.profile_players (organization_id, profile_id, player_id)
    VALUES (p_organization_id, p_profile_id, v_player_id)
    ON CONFLICT (profile_id, player_id) DO NOTHING;

    INSERT INTO public.registrations (
        organization_id, form_id, player_id, profile_id, responses, waiver_signed, waiver_signed_at
    )
    VALUES (
        p_organization_id, p_form_id, v_player_id, p_profile_id, p_responses, true, now()
    )
    RETURNING id INTO v_registration_id;

    -- Best-effort audit (do not fail the registration if the helper is absent).
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_audit_event') THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'registration.submitted',
            'registration',
            v_registration_id,
            jsonb_build_object('form_id', p_form_id, 'player_id', v_player_id)
        );
    END IF;

    RETURN v_registration_id;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'This player is already registered for this form.'
          USING ERRCODE = '23505';
END;
$function$;

DROP INDEX IF EXISTS public.registrations_profile_form_created_idx;

DROP POLICY IF EXISTS "registrations_select_own_or_admin" ON public.registrations;
DROP POLICY IF EXISTS "registrations_admin_insert" ON public.registrations;
DROP POLICY IF EXISTS "registrations_admin_update" ON public.registrations;
DROP POLICY IF EXISTS "registrations_admin_delete" ON public.registrations;
DROP POLICY IF EXISTS "registrations_user_own_or_admin" ON public.registrations;

CREATE POLICY "registrations_user_own_or_admin"
    ON public.registrations FOR ALL TO authenticated
    USING (
        (profile_id = (select auth.uid()) AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    )
    WITH CHECK (
        (profile_id = (select auth.uid()) AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    );

DO $revert$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
         WHERE p.oid = 'public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)'::regprocedure
           AND p.prosecdef
           AND p.proconfig = ARRAY['search_path=public']
           AND p.prosrc NOT LIKE '%PT429%') THEN
        RAISE EXCEPTION 'submit_registration was not restored to its 20260602010000 body and posture';
    END IF;
    IF to_regclass('public.registrations_profile_form_created_idx') IS NOT NULL THEN
        RAISE EXCEPTION 'the throttle index is still there';
    END IF;
    IF (SELECT array_agg(polname::text || ':' || polcmd::text ORDER BY polname)
          FROM pg_policy WHERE polrelid = 'public.registrations'::regclass)
       IS DISTINCT FROM ARRAY['registrations_user_own_or_admin:*'] THEN
        RAISE EXCEPTION 'registrations does not have exactly its one FOR ALL policy back';
    END IF;
    RAISE NOTICE 'revert verified: submit_registration has no throttle, SECURITY DEFINER with search_path=public, the throttle index is gone, and registrations has its one FOR ALL policy back';
END;
$revert$;

COMMIT;
