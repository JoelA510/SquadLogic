-- 8.4 gap A: editing an admin-authored blackout is an EDIT.
--
-- Follow-up to the 8.4 stack, taken before 8.5 by the operator's decision at
-- the wiring gate (`docs/BUILD_PLAN_STATUS.md` section 5).
--
-- ## What was missing
--
-- 20260906000100 shipped `admin_create_field_blackout` and
-- `admin_delete_field_blackout` and nothing between them, so changing a window
-- an operator had already entered meant deleting it and creating another. That
-- costs a new `id`, FOUR audit rows (delete before/after, create before/after)
-- and the window's identity: nothing joins the thing that existed on Tuesday to
-- the thing that exists on Wednesday, and an audit reader cannot tell an edit
-- from an unrelated removal followed by an unrelated addition.
--
-- ## Three deliberate divergences from the two siblings, each with its reason
--
-- 1. **ONE audit entry, not two.** The siblings write `phase => 'before'` and
--    `phase => 'after'` because neither has both halves to record: a create has
--    no before-row and a delete has no after-row. An update has both AT ONCE,
--    and splitting them across two rows would put the diff in two places and
--    leave a reader to pair them by timestamp. So: `phase => 'update'`,
--    carrying `before` and `after` in one metadata object. This is checked --
--    `docs/sql/20260910000000_smoke.sql` asserts exactly one audit row per
--    successful edit and that it carries both keys -- because an undeclared
--    divergence from a sibling contract is how the next maintainer invents a
--    third one.
--
-- 2. **Every editable column is passed, and NULL means NULL.** A partial
--    update taking `COALESCE(p_x, existing.x)` cannot express "this window is
--    now all day" or "the note is gone", because on that reading NULL means
--    "leave it alone". A parameter that cannot say what the operator can do is
--    a field parsed and never honoured, which CLAUDE.md names outright. The
--    caller therefore sends the whole editable shape, exactly as the create
--    sibling takes it.
--
-- 3. **SCOPE is NOT editable, and there is no parameter for it.** Moving a
--    closure from one pitch to another is not an edit of that closure; it is
--    the end of one closure and the start of another, and its consequence
--    preview is computed over different ground. Rather than accept a scope and
--    ignore it, this signature does not have one -- there is no field here to
--    leave unread. Scope changes stay delete-and-create, which is the operation
--    they are.
--
-- ## Import-owned windows are refused, by name
--
-- `field_blackout_windows` is FROZEN (20260906000100, re-stated 20260909000000)
-- and owned solely by `finalize_field_availability_import_job`. An id belonging
-- to it is refused with `0A000` (feature_not_supported) naming the table and
-- the recovery, NOT with the `P0002` an unknown id gets: "that window is not
-- yours to edit" and "there is no such window" are different answers and an
-- operator acts on them differently. The refusal is org-scoped first -- a
-- window belonging to another organisation falls through to `P0002` rather than
-- confirming to a stranger that the id exists.
--
-- This RPC therefore does NOT collapse the two blackout tables and does not
-- make the collapse any nearer: the blocker named on `public.field_closures`
-- and on `field_blackout_windows` is the nested PostgREST embed under profiles
-- in `frontend/src/hooks/useFields.js`, which this change does not touch. Both
-- comments still read correctly after this migration and are left alone.
--
-- ## What this does NOT do, stated rather than left to be inferred
--
-- `admin_delete_field_blackout` answers `P0002` for an import-owned id, so on
-- that path "frozen" and "absent" are still one answer. It is left alone: this
-- migration adds a function and changes none, and rewriting a shipped RPC's
-- error contract is a separate blast radius with its own revert. Recorded in
-- the PR body as the twin gap it is, rather than quietly half-fixed here.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_update_field_blackout(
    p_organization_id uuid,
    p_blackout_id uuid,
    p_blackout_from date,
    p_blackout_until date,
    p_start_minutes integer DEFAULT NULL,
    p_end_minutes integer DEFAULT NULL,
    p_reason text DEFAULT 'other',
    p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.field_blackouts%ROWTYPE;
    v_after  public.field_blackouts%ROWTYPE;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_blackout_id IS NULL THEN
        RAISE EXCEPTION 'p_blackout_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_before
    FROM public.field_blackouts
    WHERE id = p_blackout_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        -- **Refused by name, not by silence.** Before this branch existed the
        -- only possible answer for an import-owned id was "not found", which is
        -- true of `field_blackouts` and useless to the person holding a row the
        -- screen had just listed. Org-scoped, so a stranger learns nothing.
        IF EXISTS (
            SELECT 1 FROM public.field_blackout_windows
            WHERE id = p_blackout_id AND organization_id = p_organization_id
        ) THEN
            RAISE EXCEPTION 'Blackout % came from a field-availability import and is owned by public.field_blackout_windows, which is frozen; roll the import back or re-import to change it', p_blackout_id
                USING ERRCODE = '0A000';
        END IF;
        RAISE EXCEPTION 'Blackout % not found in organization %', p_blackout_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    -- The table's CHECK constraints judge the new shape, exactly as they judge
    -- a create: dates ordered, times both-or-neither, times ordered and in
    -- range, reason in the enum. Restating them here would be a second producer
    -- of the same verdict that could drift from the first, and the create
    -- sibling restates only the scope rule -- which this function cannot
    -- change at all.
    UPDATE public.field_blackouts
       SET blackout_from = p_blackout_from,
           blackout_until = p_blackout_until,
           start_minutes = p_start_minutes,
           end_minutes = p_end_minutes,
           reason = COALESCE(p_reason, 'other'),
           note = p_note
     WHERE id = p_blackout_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    -- One row, both halves. `resource_id` is the window's own id, which is the
    -- whole point: it is the SAME id before and after, so an audit reader can
    -- follow one window across every edit it ever receives.
    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field_blackout', v_after.id,
        jsonb_build_object(
            'operation', 'admin_update_field_blackout', 'phase', 'update',
            'before', to_jsonb(v_before),
            'after', to_jsonb(v_after)
        )
    );

    RETURN to_jsonb(v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text) TO authenticated;

COMMENT ON FUNCTION public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text) IS
  'Org-admin edit of an admin-authored blackout, IN PLACE: the id survives, so a window keeps its identity across an edit instead of becoming a new row. Takes the whole editable shape (dates, times or NULL for all day, reason, note) because a COALESCE-partial update cannot express "all day" or "no note". SCOPE is deliberately not a parameter: moving a closure to other ground is a different closure, not an edit of this one. Writes ONE audit entry carrying before and after, diverging from the create/delete siblings phase pair because an update has both halves at once. An id owned by the frozen field_blackout_windows is refused with 0A000 naming that table, not with the P0002 an unknown id gets.';

COMMIT;
