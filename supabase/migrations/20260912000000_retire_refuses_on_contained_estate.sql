-- 8.4 gap B part 2: a venue retirement refuses on its CONTAINED ESTATE too,
-- not only on the bookings.
--
-- ===========================================================================
-- 1. THE DEFECT THIS CLOSES
-- ===========================================================================
--
-- `20260911000000` gave `admin_retire_location` two halves of a consequence and
-- gated on one of them.
--
--   * it COMPUTES `contained` and `contained_count` -- every field and
--     sub-surface the venue holds, each flagged `already_retired` where its own
--     window already ends no later than this date;
--   * it AUDITS them on the refused, before and after phases;
--   * it RETURNS them on both the refusal and the commit;
--   * and it refused on `v_affected_count > 0` alone.
--
-- So a venue with four live pitches and nothing booked after the date COMMITTED
-- ON THE FIRST CALL. The containment report was computed, written to the audit
-- log, returned -- and the four pitches stopped being offerable without the
-- operator ever being shown a preview. Half the consequence was enforced and
-- half was merely described, which is "declared is not enforced" with a date on
-- it.
--
-- It was found by building the screen. Part 1 shipped no `useFields` wrapper
-- deliberately, on the grounds that a hook with no screen is
-- declared-not-enforced one level up; the same reasoning is what surfaced this,
-- because the UI had nowhere honest to put a consequence the RPC had already
-- decided not to gate on.
--
-- ===========================================================================
-- 2. WHY THE GATE AND NOT A NEW CONCEPT
-- ===========================================================================
--
-- **`p_confirm` already exists on this function.** `admin_retire_location`,
-- `admin_retire_field_subunit` and `admin_retire_field` all take
-- `(..., p_confirm boolean DEFAULT false)`, and `admin_delete_field`'s COMMENT
-- states the family contract as refusing "with everything the delete would
-- take ... unless p_confirm is true". For a venue retirement, everything it
-- would take includes the estate it closes.
--
-- So this is the existing two-phase contract applied to all of what the
-- function computes, not a third disposition invented beside it. CLAUDE.md:
-- when a sibling function already handles an edge case, adopt its contract
-- rather than inventing a third one.
--
-- **Only the gate changes. No data changes.** The `contained` payload, its
-- ordering, `already_retired`, the audit phases and every other returned key
-- are byte-for-byte what `20260911000000` produced. This file recreates the
-- function in full because PostgreSQL has no way to replace a branch, and the
-- diff against `20260911000000` is the gate, the reason expression and the one
-- new DECLARE.
--
-- ===========================================================================
-- 3. THE EMPTY CASE, ADOPTED RATHER THAN RULED ON
-- ===========================================================================
--
-- `admin_delete_field` refuses on `v_affected_count > 0`: with nothing to take
-- it commits on the first call and never makes the caller confirm a refusal
-- about nothing. The same reading applies here, and it falls out of the
-- counter that already exists:
--
--   * `v_contained_count` counts only the nodes NOT `already_retired`. A venue
--     whose every child already ends on or before this date has nothing this
--     call newly closes, so it commits unconfirmed.
--   * A venue that holds nothing at all counts 0 and commits unconfirmed.
--
-- `contained` is still RETURNED in both of those cases -- what changes is
-- whether it forces a confirmation, not whether it is reported. An empty
-- estate and an estate already closed are still described rather than passed
-- over in silence, which is the same distinction `contained: []` versus an
-- absent key carries at sub-surface depth.
--
-- ===========================================================================
-- 4. THE TWO REFUSAL REASONS STAY TWO
-- ===========================================================================
--
-- `bookings_after_effective_to` keeps meaning exactly what it has always meant:
-- bookings stand after this date. `contained_estate_after_effective_to` is
-- reached ONLY when the bookings half is empty and the containment half is not.
--
-- Collapsing them into one literal would have made an audit trail in which
-- "this venue has games on it" and "this venue holds live pitches" read
-- identically -- the conflation `20260910000000`'s 0A000 branch exists to
-- remove, arriving in a different family. Callers that branch on
-- `reason === 'bookings_after_effective_to'` keep their meaning; callers that
-- branch only on `retired === false` (which is every caller in the app) are
-- unaffected.
--
-- ===========================================================================
-- 5. WHAT THIS FILE DOES NOT TOUCH
-- ===========================================================================
--
--   * `admin_retire_field_subunit` -- a sub-surface is the leaf of the estate
--     and produces no `contained` at all. A gate on a value it never computes
--     would be a branch nothing can reach.
--   * `admin_retire_field` -- `estate_contained_nodes` is keyed on a LOCATION,
--     and part 1 scoped containment to the venue deliberately. Extending it to
--     a field's sub-surfaces is a real question and it is NOT answered here;
--     answering it quietly inside a migration about the venue gate is how one
--     arm of a family gets a rule its siblings do not have.
--   * `admin_unretire_location` -- it applies no date, so `already_retired` is
--     false for every row and there is no "what this closes" to confirm.
--   * `estate_contained_nodes`, `field_bookings`, `estate_scope_covers` --
--     unchanged, and this migration adds no producer. The containment set has
--     exactly one producer and still does.

CREATE OR REPLACE FUNCTION public.admin_retire_location(
    p_organization_id uuid,
    p_location_id uuid,
    p_effective_to date,
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.locations%ROWTYPE;
    v_after  public.locations%ROWTYPE;
    v_affected jsonb;
    v_affected_count integer;
    v_contained jsonb;
    v_contained_count integer;
    v_reason text;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'p_location_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_effective_to IS NULL THEN
        RAISE EXCEPTION 'p_effective_to is required; retiring with no end date is a deletion, not a retirement'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_before
    FROM public.locations
    WHERE id = p_location_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % not found in organization %', p_location_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    -- **The venue's fields are locked although nothing writes them.** The
    -- guard's answer is about bookings on those pitches and the containment
    -- report is about the pitches themselves; a field inserted at this venue
    -- between the enumeration and the commit would be absent from both while
    -- being closed by the date. `rollback_field_import_job` takes the same
    -- precaution for the same reason (20260909000000:1038).
    PERFORM 1 FROM public.fields f
     WHERE f.organization_id = p_organization_id AND f.location_id = p_location_id
     FOR UPDATE;

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', b.kind, 'id', b.booking_id, 'on_date', b.on_date,
            'week_index', b.week_index, 'undated', b.undated,
            'unbounded', b.unbounded, 'field_id', b.field_id
          )
          ORDER BY b.on_date NULLS FIRST, b.kind, b.booking_id
        ),
        '[]'::jsonb
      ),
      COUNT(*)
    INTO v_affected, v_affected_count
    FROM public.field_bookings(p_organization_id, p_location_id, p_effective_to, 'location') b;

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', c.kind, 'id', c.node_id, 'name', c.node_name,
            'own_effective_to', c.own_effective_to,
            'already_retired', c.already_retired
          )
          ORDER BY c.kind, c.node_name, c.node_id
        ),
        '[]'::jsonb
      ),
      COUNT(*) FILTER (WHERE NOT c.already_retired)
    INTO v_contained, v_contained_count
    FROM public.estate_contained_nodes(p_organization_id, p_location_id, p_effective_to) c;

    -- **THE ONE BEHAVIOURAL CHANGE IN THIS MIGRATION.** The gate was
    -- `v_affected_count > 0`: it refused on the bookings half of the
    -- consequence and committed silently on the containment half, although it
    -- had already computed and audited both. See section 1 of the header.
    --
    -- `v_contained_count` counts only the nodes NOT already retired, so a venue
    -- whose children all end on or before this date -- and a venue that holds
    -- nothing at all -- still commits on the first call. That is
    -- `admin_delete_field`'s empty case adopted, not a new rule: it refuses
    -- when there is something to take, and an estate with nothing live left to
    -- close has nothing to take.
    IF (v_affected_count > 0 OR v_contained_count > 0) AND NOT COALESCE(p_confirm, false) THEN
        v_reason := CASE
            WHEN v_affected_count > 0 THEN 'bookings_after_effective_to'
            ELSE 'contained_estate_after_effective_to'
        END;
        PERFORM public.record_audit_event(
            p_organization_id, 'settings.updated', 'location', p_location_id,
            jsonb_build_object(
                'setting', 'facility.location',
                'operation', 'admin_retire_location',
                'phase', 'refused',
                -- **The existing literal keeps meaning exactly what it meant.**
                -- `bookings_after_effective_to` still means "bookings stand
                -- after this date"; the new literal is reached only when the
                -- bookings half is empty and the containment half is not. A
                -- single reason for both would have made the two refusals
                -- indistinguishable in the audit trail, which is the
                -- conflation 20260910000000's 0A000 branch exists to remove.
                'reason', v_reason,
                'effective_to', p_effective_to,
                'affected_count', v_affected_count,
                'affected', public.field_bookings_digest(v_affected),
                'contained_count', v_contained_count,
                'contained', v_contained,
                'before', to_jsonb(v_before)
            )
        );
        RETURN jsonb_build_object(
            'retired', false,
            'reason', v_reason,
            'affected_count', v_affected_count,
            'affected', v_affected,
            'contained_count', v_contained_count,
            'contained', v_contained
        );
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'location', p_location_id,
        jsonb_build_object(
            'setting', 'facility.location',
            'operation', 'admin_retire_location',
            'phase', 'before',
            'effective_to', p_effective_to,
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected),
            'contained_count', v_contained_count,
            'contained', v_contained,
            'before', to_jsonb(v_before)
        )
    );

    -- **Only the venue's own row is written.** No date is copied down and no
    -- child flag is flipped; section 2 of the header is the argument.
    UPDATE public.locations
    SET effective_to = p_effective_to,
        updated_at = timezone('utc', now())
    WHERE id = p_location_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'location', p_location_id,
        jsonb_build_object(
            'setting', 'facility.location',
            'operation', 'admin_retire_location',
            'phase', 'after',
            'effective_to', p_effective_to,
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'contained_count', v_contained_count,
            'contained', v_contained,
            'after', to_jsonb(v_after)
        )
    );

    RETURN jsonb_build_object(
        'retired', true,
        'affected_count', v_affected_count,
        'affected', v_affected,
        'contained_count', v_contained_count,
        'contained', v_contained,
        'location', to_jsonb(v_after)
    );
END;
$$;

COMMENT ON FUNCTION public.admin_retire_location(uuid, uuid, date, boolean) IS
  'Org-admin venue retirement: writes locations.effective_to and copies nothing down. Refuses with BOTH halves of the consequence unless p_confirm -- the bookings that stand after the date (reason bookings_after_effective_to) and the contained estate this newly closes (reason contained_estate_after_effective_to, reached only when the bookings half is empty). contained lists every field and sub-surface the venue holds, flagged already_retired where its own window already ends no later than the date; contained_count counts only the ones this call newly closes, so a venue that holds nothing, or whose children all already end by then, commits on the first call as admin_delete_field does with nothing to take. Returns a refusal object rather than raising, and audits refused/before/after. Superseded the 20260911000000 definition, which gated on the bookings half alone.';
