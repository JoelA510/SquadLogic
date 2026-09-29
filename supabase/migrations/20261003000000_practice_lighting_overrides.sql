-- 8.9 D14 PR B: portable-lighting overrides -- the store and its four writers.
--
-- Plan of record: docs/PHASE_8_9_D14_PLAN.md, "Override design" and PR split
-- row B (operator, 2026-09-29).
--
-- **What this adds.** A window of dates on one practice slot over which
-- portable lighting is on site, so those dates are not judged against sunset
-- (core `lightingOverrideCovers`, 8.9 D14 PR A). Coaches REQUEST; only an
-- organisation admin approves or rejects; an admin may also set one directly.
-- A decision is written onto the request row, never a row deleted.
--
-- **The copied pattern** is 20260927000000_coach_practice_preferences.sql:
-- RLS on with a single SELECT policy and NO write policy, definer RPCs as the
-- only writers, each auditing through record_audit_event, a coach refused at
-- decide, and no free text (the BLACKOUT_REASON stance: there is no note or
-- reason column). Where this differs, it says why at the point of difference.
--
-- **Who "coaches the slot".** 20260927000000 identifies a coach as
-- `coaches.user_id = auth.uid()` and never needed a team. Here the coach must
-- coach a team the slot is assigned to, so the team link is read from
-- `team_coach_assignments` (20260923000000, the source of truth for who
-- coaches which team) for rows current TODAY, joined to `practice_assignments`
-- on the slot. `practice_assignments` carries the slot under two columns and
-- the writer sets both; `COALESCE(practice_slot_id, slot_id)` is the
-- persist_practice_schedule reading, adopted rather than a third. ONE function,
-- `caller_coaches_practice_slot`, is that enumerator, and both the request RPC
-- and the read policy call it, so the two cannot disagree about who a coach is.
-- The assignment's own date range is not consulted: a slot a team was ever
-- placed on counts. Declared, not enforced.
--
-- **The window** is a `daterange`, stored canonical `[from, until + 1)`. The
-- RPCs take INCLUSIVE `p_from` / `p_until`, the reading of
-- `team_coach_assignments` and of core's `PracticeLightingOverrideSchema`
-- (`{ slotId, from, until }`, both inclusive), so a row maps to core's input as
-- `from = lower(window)`, `until = upper(window) - 1`.
--
-- **Self-approval is refused.** 20260927000000 refuses a coach at decide
-- (only an admin decides); this also refuses the admin who REQUESTED the row
-- (an admin may request, as there): one person requesting and approving would
-- read in the audit log as a two-person review. An admin who wants an override
-- without review uses admin_set_practice_lighting_override, audited as such.
--
-- **Withdraw** is new (20260927000000 supersedes instead). The requester
-- withdraws their own requested or approved row while they could still
-- request it (they still coach the slot); an admin withdraws any row of the
-- organisation in those states (the only way to end an approved window).
-- Withdrawing only ever REMOVES an exemption, so it fails safe.
--
-- **No cascade.** `practice_slot_id` is a plain (NO ACTION) foreign key, the
-- practice_exceptions -> practice_slots contract (20260929000000) adopted
-- rather than a third: deleting a slot that holds an override -- by
-- admin_delete_field, a subunit delete or rollback_field_import_job -- fails
-- 23503 instead of destroying approved windows unreported and unaudited. The
-- table still joins the closures from `fields` and `field_subunits` (through
-- practice_slots), which docs/sql/20260907000000_smoke.sql and
-- 20260909000000_smoke.sql now declare.
--
-- **Declared, not enforced.** An override has no lights-off time (plan
-- default 4). "Current today" for a coach is the database's `current_date`
-- (UTC on Supabase), the reading team_coach_assignments' writers use, not the
-- organisation's local date. The window is not checked against the slot's valid_from /
-- valid_until. Nothing reads approved rows yet: the Edge read is PR C, the UI
-- PR D.
--
-- Reversible: see docs/sql/20261003000000_revert.sql.
-- Smoke checks: see docs/sql/20261003000000_smoke.sql.

BEGIN;

-- The exclusion constraint compares uuids with `=` under GiST, which needs
-- btree_gist. 20260929000000 already creates it in `extensions`; repeated here
-- IF NOT EXISTS so this file does not depend on that one's placement.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

INSERT INTO public.audit_actions (action) VALUES
    ('practice_lighting_override.requested'),
    ('practice_lighting_override.approved'),
    ('practice_lighting_override.rejected'),
    ('practice_lighting_override.withdrawn'),
    ('practice_lighting_override.set')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. The store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.practice_lighting_overrides (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    practice_slot_id uuid NOT NULL REFERENCES public.practice_slots(id),
    "window"         daterange NOT NULL,
    kind             text NOT NULL DEFAULT 'portable-lighting',
    status           text NOT NULL DEFAULT 'requested',
    requested_by     uuid NOT NULL,
    requested_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    decided_by       uuid,
    decided_at       timestamptz,
    withdrawn_by     uuid,
    withdrawn_at     timestamptz,
    CONSTRAINT practice_lighting_overrides_kind_known
        CHECK (kind = 'portable-lighting'),
    CONSTRAINT practice_lighting_overrides_status_known
        CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
    CONSTRAINT practice_lighting_overrides_window_bounded
        CHECK (NOT isempty("window") AND NOT lower_inf("window") AND NOT upper_inf("window")),
    -- requested: undecided. approved / rejected: decided. withdrawn: either,
    -- because a requested row and an approved row may both be withdrawn.
    CONSTRAINT practice_lighting_overrides_decision_recorded
        CHECK (CASE status
                   WHEN 'requested' THEN decided_at IS NULL AND decided_by IS NULL
                   WHEN 'withdrawn' THEN (decided_at IS NULL) = (decided_by IS NULL)
                   ELSE decided_at IS NOT NULL AND decided_by IS NOT NULL END),
    CONSTRAINT practice_lighting_overrides_withdrawal_recorded
        CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)
               AND (withdrawn_at IS NULL) = (withdrawn_by IS NULL)),
    -- Two approved windows on one slot may not overlap. Requested, rejected
    -- and withdrawn rows may: only an approval is in force.
    CONSTRAINT practice_lighting_overrides_no_overlap
        EXCLUDE USING gist (practice_slot_id WITH =, "window" WITH &&)
        WHERE (status = 'approved')
);

COMMENT ON TABLE public.practice_lighting_overrides IS
  'Portable-lighting windows on a practice slot (8.9 D14): an approved row exempts the slot''s dates in its window from the sunset judgement. Coaches request; only org admins decide. Written only by request_practice_lighting_override, admin_decide_practice_lighting_override, withdraw_practice_lighting_override and admin_set_practice_lighting_override. No free text.';
COMMENT ON COLUMN public.practice_lighting_overrides."window" IS
  'Canonical [from, until + 1): the RPCs take inclusive dates. Core''s PracticeLightingOverrideSchema reads it as from = lower(window), until = upper(window) - 1.';
COMMENT ON COLUMN public.practice_lighting_overrides.requested_by IS
  'The auth uid of the caller who requested (or, for an admin set, wrote) the row. No foreign key: the history keeps an opaque id.';

CREATE INDEX IF NOT EXISTS practice_lighting_overrides_org_slot
    ON public.practice_lighting_overrides (organization_id, practice_slot_id);

-- ---------------------------------------------------------------------------
-- 2. Who coaches a slot: the one enumerator the request RPC and the read
--    policy share
-- ---------------------------------------------------------------------------
--
-- True when the CALLER is a coach (coaches.user_id, the 20260927000000
-- identity) currently assigned (team_coach_assignments, today inclusive) to a
-- team with a practice_assignments row on this slot, all in the slot's
-- organisation. Definer, so a policy calling it does not depend on the RLS of
-- four other tables; it takes no user id, so it answers only about the caller.
CREATE OR REPLACE FUNCTION public.caller_coaches_practice_slot(p_practice_slot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.practice_slots ps
          JOIN public.practice_assignments pa
            ON COALESCE(pa.practice_slot_id, pa.slot_id) = ps.id
           AND pa.organization_id = ps.organization_id
          JOIN public.team_coach_assignments tca
            ON tca.team_id = pa.team_id
           AND tca.organization_id = ps.organization_id
          JOIN public.coaches c
            ON c.id = tca.coach_id
           AND c.organization_id = ps.organization_id
         WHERE ps.id = p_practice_slot_id
           AND c.user_id = auth.uid()
           AND tca.effective_from <= current_date
           AND (tca.effective_to IS NULL OR tca.effective_to >= current_date)
    );
$$;

REVOKE ALL ON FUNCTION public.caller_coaches_practice_slot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_coaches_practice_slot(uuid) TO authenticated, service_role;

ALTER TABLE public.practice_lighting_overrides ENABLE ROW LEVEL SECURITY;

-- Admins read every row of their organisation; a coach reads the rows of the
-- slots their teams use. There is no write policy: the four definer RPCs below
-- are the only writers.
DROP POLICY IF EXISTS "Practice lighting overrides: admins and the slot's coaches read"
    ON public.practice_lighting_overrides;
CREATE POLICY "Practice lighting overrides: admins and the slot's coaches read"
    ON public.practice_lighting_overrides
    FOR SELECT TO authenticated
    USING (
        public.is_org_member(organization_id)
        AND (
            public.is_org_admin(organization_id)
            OR public.caller_coaches_practice_slot(practice_slot_id)
        )
    );

-- Default privileges hand new tables to authenticated and service_role with
-- every privilege, so the revoke names them too (the 20260923000000 reasoning).
REVOKE ALL ON public.practice_lighting_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.practice_lighting_overrides TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. request: a coach of the slot, or an admin of its organisation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_practice_lighting_override(
    p_practice_slot_id uuid,
    p_from date,
    p_until date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_org uuid;
    v_by_coach boolean;
    v_id uuid;
BEGIN
    IF p_practice_slot_id IS NULL OR p_from IS NULL OR p_until IS NULL THEN
        RAISE EXCEPTION 'p_practice_slot_id, p_from and p_until are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT ps.organization_id INTO v_org FROM public.practice_slots ps WHERE ps.id = p_practice_slot_id;

    -- An unknown slot and a slot the caller does not coach refuse alike, so
    -- the RPC cannot be used to probe which slot ids exist.
    v_by_coach := public.caller_coaches_practice_slot(p_practice_slot_id);
    IF v_uid IS NULL OR v_org IS NULL
       OR NOT ((v_by_coach AND public.is_org_member(v_org)) OR public.is_org_admin(v_org)) THEN
        RAISE EXCEPTION 'Access denied: only a coach of a team on the slot or an admin of its organization requests a lighting override'
            USING ERRCODE = '42501';
    END IF;

    IF p_until < p_from THEN
        RAISE EXCEPTION 'a lighting override''s p_until (%) precedes its p_from (%)', p_until, p_from
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.practice_lighting_overrides
        (organization_id, practice_slot_id, "window", status, requested_by)
    VALUES (v_org, p_practice_slot_id, daterange(p_from, p_until, '[]'), 'requested', v_uid)
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'practice_lighting_override.requested',
        'practice_lighting_override',
        v_id,
        jsonb_build_object(
            'practice_slot_id', p_practice_slot_id, 'from', p_from, 'until', p_until,
            'kind', 'portable-lighting', 'status', 'requested', 'by_coach', v_by_coach
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'organization_id', v_org, 'practice_slot_id', p_practice_slot_id,
        'from', p_from, 'until', p_until, 'kind', 'portable-lighting', 'status', 'requested'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.request_practice_lighting_override(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_practice_lighting_override(uuid, date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. decide: approve or reject a request -- admins only, never the requester
-- ---------------------------------------------------------------------------
--
-- An approval that overlaps an approved window on the slot is refused by the
-- exclusion constraint (23P01) and changes nothing.
CREATE OR REPLACE FUNCTION public.admin_decide_practice_lighting_override(
    p_override_id uuid,
    p_decision text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.practice_lighting_overrides%ROWTYPE;
    v_status text;
BEGIN
    IF p_override_id IS NULL OR p_decision IS NULL THEN
        RAISE EXCEPTION 'p_override_id and p_decision are required'
            USING ERRCODE = '23502';
    END IF;
    IF p_decision NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'p_decision must be approve or reject, not %', p_decision
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row
      FROM public.practice_lighting_overrides
     WHERE id = p_override_id
       FOR UPDATE;

    -- Only an admin of the row's organisation decides; a coach is refused
    -- (the 20260927000000 ruling).
    IF NOT FOUND OR NOT public.is_org_admin(v_row.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin decides a lighting override'
            USING ERRCODE = '42501';
    END IF;
    -- ...and never the admin who asked for it.
    IF v_uid IS NULL OR v_uid = v_row.requested_by THEN
        RAISE EXCEPTION 'Access denied: the requester of lighting override % may not decide it; withdraw it, or have another admin decide',
            p_override_id
            USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'requested' THEN
        RAISE EXCEPTION 'lighting override % is already %; only a requested row is decided',
            p_override_id, v_row.status
            USING ERRCODE = '22023';
    END IF;

    v_status := CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
    UPDATE public.practice_lighting_overrides
       SET status = v_status, decided_by = v_uid, decided_at = clock_timestamp()
     WHERE id = p_override_id;

    PERFORM public.record_audit_event(
        v_row.organization_id,
        'practice_lighting_override.' || v_status,
        'practice_lighting_override',
        p_override_id,
        jsonb_build_object(
            'practice_slot_id', v_row.practice_slot_id,
            'from', lower(v_row."window"), 'until', upper(v_row."window") - 1,
            'kind', v_row.kind, 'before_status', v_row.status, 'status', v_status,
            'requested_by', v_row.requested_by
        )
    );

    RETURN jsonb_build_object(
        'id', p_override_id, 'status', v_status, 'practice_slot_id', v_row.practice_slot_id,
        'from', lower(v_row."window"), 'until', upper(v_row."window") - 1
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_decide_practice_lighting_override(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_practice_lighting_override(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. withdraw: the requester, or an admin of the organisation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_practice_lighting_override(
    p_override_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.practice_lighting_overrides%ROWTYPE;
BEGIN
    IF p_override_id IS NULL THEN
        RAISE EXCEPTION 'p_override_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_row
      FROM public.practice_lighting_overrides
     WHERE id = p_override_id
       FOR UPDATE;

    -- The requester only while they still coach the slot: a lapsed coach
    -- cannot read the row (the policy), so cannot end it either.
    IF NOT FOUND OR v_uid IS NULL
       OR NOT ((v_uid = v_row.requested_by
                AND public.caller_coaches_practice_slot(v_row.practice_slot_id)
                AND public.is_org_member(v_row.organization_id))
               OR public.is_org_admin(v_row.organization_id)) THEN
        RAISE EXCEPTION 'Access denied: only the requester or an organization admin withdraws a lighting override'
            USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('requested', 'approved') THEN
        RAISE EXCEPTION 'lighting override % is already %; only a requested or approved row is withdrawn',
            p_override_id, v_row.status
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.practice_lighting_overrides
       SET status = 'withdrawn', withdrawn_by = v_uid, withdrawn_at = clock_timestamp()
     WHERE id = p_override_id;

    PERFORM public.record_audit_event(
        v_row.organization_id,
        'practice_lighting_override.withdrawn',
        'practice_lighting_override',
        p_override_id,
        jsonb_build_object(
            'practice_slot_id', v_row.practice_slot_id,
            'from', lower(v_row."window"), 'until', upper(v_row."window") - 1,
            'kind', v_row.kind, 'before_status', v_row.status, 'status', 'withdrawn',
            'requested_by', v_row.requested_by, 'by_requester', v_uid = v_row.requested_by
        )
    );

    RETURN jsonb_build_object(
        'id', p_override_id, 'status', 'withdrawn', 'before_status', v_row.status,
        'practice_slot_id', v_row.practice_slot_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.withdraw_practice_lighting_override(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_practice_lighting_override(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. set: an admin writes an approved override directly -- admins only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_practice_lighting_override(
    p_practice_slot_id uuid,
    p_from date,
    p_until date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_org uuid;
    v_id uuid;
BEGIN
    IF p_practice_slot_id IS NULL OR p_from IS NULL OR p_until IS NULL THEN
        RAISE EXCEPTION 'p_practice_slot_id, p_from and p_until are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT ps.organization_id INTO v_org FROM public.practice_slots ps WHERE ps.id = p_practice_slot_id;
    IF v_uid IS NULL OR v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin sets a lighting override'
            USING ERRCODE = '42501';
    END IF;
    IF p_until < p_from THEN
        RAISE EXCEPTION 'a lighting override''s p_until (%) precedes its p_from (%)', p_until, p_from
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.practice_lighting_overrides
        (organization_id, practice_slot_id, "window", status,
         requested_by, decided_by, decided_at)
    VALUES (v_org, p_practice_slot_id, daterange(p_from, p_until, '[]'), 'approved',
            v_uid, v_uid, clock_timestamp())
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'practice_lighting_override.set',
        'practice_lighting_override',
        v_id,
        jsonb_build_object(
            'practice_slot_id', p_practice_slot_id, 'from', p_from, 'until', p_until,
            'kind', 'portable-lighting', 'status', 'approved'
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'organization_id', v_org, 'practice_slot_id', p_practice_slot_id,
        'from', p_from, 'until', p_until, 'kind', 'portable-lighting', 'status', 'approved'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_practice_lighting_override(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_practice_lighting_override(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.caller_coaches_practice_slot(uuid) IS
  'True when the caller coaches (team_coach_assignments, current today) a team with a practice_assignments row on the slot. The one enumerator the lighting-override request RPC and read policy share.';
COMMENT ON FUNCTION public.request_practice_lighting_override(uuid, date, date) IS
  'A coach of a team on the slot, or an org admin, requests a portable-lighting window (inclusive dates). Never in force until decided. Audited as practice_lighting_override.requested.';
COMMENT ON FUNCTION public.admin_decide_practice_lighting_override(uuid, text) IS
  'Org admins only, never the requester: approve or reject a requested lighting override. An approval overlapping an approved window on the slot is refused (23P01). Audited as practice_lighting_override.approved / .rejected.';
COMMENT ON FUNCTION public.withdraw_practice_lighting_override(uuid) IS
  'The requester while they still coach the slot, or an org admin: withdraw a requested or approved lighting override. Audited as practice_lighting_override.withdrawn.';
COMMENT ON FUNCTION public.admin_set_practice_lighting_override(uuid, date, date) IS
  'Org admins only: write a lighting override directly as approved (inclusive dates). Refused (23P01) when it overlaps an approved window on the slot. Audited as practice_lighting_override.set.';

COMMIT;
