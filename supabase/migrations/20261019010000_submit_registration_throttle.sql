-- A throttle on `submit_registration`: one caller, one form, ten submissions a
-- minute (July audit DS-5; plan docs/changes/2026-10-19-b2-hardening.md).
--
-- **Why.** `submit_registration` is the one SECURITY DEFINER RPC left open to
-- `anon` (the public /register/:formId route). The body already refuses a caller
-- with no `auth.uid()` or no membership, but nothing capped how many rows an
-- authenticated member could create by repeating the call.
--
-- **The change.** The function is replaced wholesale from its latest revision
-- (20260602010000; production's body is that text minus its comment lines, read
-- back 2026-10-19) with one step added after the form check: count the caller's
-- registrations to this form in the last 60 seconds and refuse the eleventh
-- with SQLSTATE PT429 (HTTP 429 through PostgREST). Signature, RETURNS, SECURITY
-- DEFINER, search_path, grants and comment are unchanged. The registrations
-- policy is narrowed (below) so the caller cannot rewrite what is counted.
--
-- **The index.** `registrations` had only its primary key and (form_id,
-- player_id); the count filters on profile_id, which was also an unindexed
-- foreign key. `registrations_profile_form_created_idx` serves the count and
-- that FK. The table is empty in production (read 2026-10-19), so it builds at once.
--
-- **The rows it counts are not the caller's to edit** (Codex on #609).
-- `registrations_user_own_or_admin` was FOR ALL: a member could UPDATE their own
-- rows' created_at out of the window, or DELETE them, and call again (the players
-- the RPC created stay); they could also INSERT a registration directly, past the
-- RPC's checks, and set medical_cleared on their own row. The policy is split:
-- members read their own rows (unchanged), and only an organization admin
-- (is_org_admin: admin or tenant_admin, unchanged) writes directly. A member's
-- one write path is this SECURITY DEFINER RPC, which RLS does not bind; the
-- medical toggle is admin_update_registration_medical_status (also DEFINER).
-- Nothing in frontend/src writes registrations directly (searched 2026-10-19:
-- the one direct use is AdminComplianceDashboard's SELECT).
--
-- **Not covered** (plan, risks): a flood of calls that all fail validation
-- inserts nothing and so is not counted; connection load is bounded by the
-- platform, not here. A per-organization cap is not added.
--
-- Reversible: see docs/sql/20261019010000_revert.sql.
-- Smoke checks: see docs/sql/20261019010000_smoke.sql.

BEGIN;

CREATE INDEX IF NOT EXISTS registrations_profile_form_created_idx
  ON public.registrations (profile_id, form_id, created_at DESC);

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
    -- DS-5: the most registrations one caller may submit to one form in the
    -- window. Ten covers a family registering several children in one sitting;
    -- tests/submitRegistrationThrottle.test.js ties the mock client to this number.
    v_limit           constant integer := 10;
    v_window          constant interval := interval '60 seconds';
    v_recent          integer;
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

    -- DS-5 throttle. Counted from the registrations the caller already holds
    -- for this form (every successful call inserts exactly one), so there is no
    -- log table to grow or prune. A refused call inserts nothing, so it does not
    -- extend its own window. The advisory lock serialises one caller's calls to
    -- one form, so two concurrent calls cannot both read nine and both insert.
    -- PT429 is PostgREST's own convention: the HTTP response is 429.
    -- The window is absolute timestamptz arithmetic (now() - v_window), and the
    -- INSERT below sets created_at to now() itself. The column default is
    -- timezone('utc', now()), a zone-less timestamp that the SESSION time zone
    -- reinterprets, and a PostgREST caller sets that zone (Prefer: timezone=...):
    -- with +14 the default dates a row 14 hours in the past, outside every window.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_caller::text || ':' || p_form_id::text, 0));

    SELECT count(*) INTO v_recent
    FROM public.registrations r
    WHERE r.profile_id = v_caller
      AND r.form_id = p_form_id
      AND r.created_at > now() - v_window;

    IF v_recent >= v_limit THEN
        RAISE EXCEPTION 'Too many registrations submitted for this form. Wait a minute and try again.'
          USING ERRCODE = 'PT429',
                HINT = format('At most %s registrations per form per %s.', v_limit, v_window);
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
        organization_id, form_id, player_id, profile_id, responses, waiver_signed, waiver_signed_at,
        created_at
    )
    VALUES (
        p_organization_id, p_form_id, v_player_id, p_profile_id, p_responses, true, now(),
        now()
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

DROP POLICY IF EXISTS "registrations_user_own_or_admin" ON public.registrations;

CREATE POLICY "registrations_select_own_or_admin"
    ON public.registrations FOR SELECT TO authenticated
    USING (
        (profile_id = (select auth.uid()) AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    );

CREATE POLICY "registrations_admin_insert"
    ON public.registrations FOR INSERT TO authenticated
    WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY "registrations_admin_update"
    ON public.registrations FOR UPDATE TO authenticated
    USING (public.is_org_admin(organization_id))
    WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY "registrations_admin_delete"
    ON public.registrations FOR DELETE TO authenticated
    USING (public.is_org_admin(organization_id));

COMMIT;
