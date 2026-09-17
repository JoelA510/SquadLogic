-- Revert for 20260912000000_retire_refuses_on_contained_estate.sql
--
-- **Every behaviour this undoes, named.** This migration changed exactly one
-- thing, so this revert un-changes exactly one thing -- and the one thing is a
-- guard, which makes the loss worth stating precisely rather than briefly.
--
--   1. **A venue retirement stops refusing on its contained estate.**
--      `admin_retire_location` goes back to gating on `v_affected_count > 0`
--      alone. From the moment this runs, retiring a venue that holds live
--      pitches and has nothing booked after the date COMMITS ON THE FIRST CALL.
--      The operator is shown no preview, is asked for no confirmation, and the
--      fields and sub-surfaces at that site stop being offerable. This is a
--      guard being removed, not a feature: the effect is silent.
--   2. **`contained_estate_after_effective_to` stops being produced.** No
--      `admin_retire_location` result and no audit row can carry it again. Rows
--      ALREADY written with that reason stay in `audit_log` and stay readable --
--      nothing rewrites history -- so a reader after this revert will find a
--      reason literal that the live function can no longer emit. That is
--      correct and it is why the count below is printed: those rows record
--      refusals that would not happen under the restored definition.
--   3. **Nothing else.** `contained`, `contained_count`, `already_retired`,
--      `estate_contained_nodes`, `field_bookings`, the audit phases, the
--      sub-surface arm and the unretire arms are untouched by the migration and
--      untouched by this revert. `contained` is still computed, still audited
--      and still returned after this runs -- it simply stops gating, which is
--      precisely the defect 20260912000000 exists to close.
--
-- **What this revert does NOT do.** It does not re-open a venue, and it does
-- not re-refuse a retirement that was confirmed past the containment gate while
-- the migration was live. Those decisions were made; inventing a reversal for
-- them would substitute a decision this file never made.
--
-- **The frontend must go back with it.** `RetireEstateNodeDialog` renders the
-- containment through the refusal path and has no post-commit state, so against
-- the restored definition a quiet venue retirement closes the dialog with the
-- containment never shown. Revert the frontend with this file, or the app
-- silently closes an estate it told the operator nothing about.
--
-- The count below exists so the loss is in the transcript of the run rather
-- than discovered afterwards. **It counts against whatever is in the database,
-- and it FAILS LOUDLY on an empty one**: a revert rehearsed against a seed with
-- no retired venue in it proves only that the script parses.

-- **`ON_ERROR_STOP`, and the guard below is exactly why.** Without it, an
-- operator running this file by hand gets: the "examined ZERO venues" exception
-- fires, the transaction aborts, every later statement fails with 25P02, COMMIT
-- degrades to ROLLBACK -- and **psql exits 0**. A guard whose whole premise is
-- "fail loudly on an empty estate" would report SUCCESS to any script reading
-- the exit code, with nothing reverted. The harness passes `-v ON_ERROR_STOP=1`
-- itself, so this line is for the hand-run path, which is the one an operator
-- actually takes. Its siblings 20260908000000, 20260909000000 and
-- 20260910000000 all carry it; this file was the odd one out.
\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- What stops being guarded, counted while the guarded definition is still live
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_reasoned int := 0;
  v_exposed int := 0;
  v_venues int := 0;
BEGIN
  -- Refusals that ONLY the migration being reverted could have produced.
  SELECT count(*) INTO v_reasoned
    FROM public.audit_log a
   WHERE a.metadata->>'operation' = 'admin_retire_location'
     AND a.metadata->>'reason' = 'contained_estate_after_effective_to';
  RAISE NOTICE 'audit rows recording a containment-only refusal: %', v_reasoned;
  RAISE NOTICE '  (these stay readable; the restored definition can no longer emit them)';

  -- **The exposure this revert creates, measured rather than described.** Every
  -- live venue that holds at least one node with no end date of its own is a
  -- venue whose retirement will, from now on, commit unconfirmed whenever
  -- nothing is booked after the date.
  FOR r IN
    SELECT l.id, l.organization_id, l.name,
           (SELECT count(*)
              FROM public.estate_contained_nodes(l.organization_id, l.id, NULL) c
             WHERE c.own_effective_to IS NULL) AS live_nodes
      FROM public.locations l
     WHERE l.effective_to IS NULL
     ORDER BY l.name
  LOOP
    v_venues := v_venues + 1;
    IF r.live_nodes > 0 THEN
      v_exposed := v_exposed + 1;
      RAISE NOTICE 'venue % (%) holds % undated node(s) and loses its containment gate',
        r.name, r.id, r.live_nodes;
    END IF;
  END LOOP;
  RAISE NOTICE 'live venues examined: %, of which % lose a gate', v_venues, v_exposed;

  -- **A count that matches zero records is a loud failure, never a silent
  -- pass.** A revert rehearsed on a database with no live venue in it printed
  -- reassuring zeroes and proved nothing about what it strands. Set
  -- `revert.allow_empty` to 'on' only when reverting a genuinely empty estate,
  -- and then the zero is a claim someone made rather than one nobody noticed.
  IF v_venues = 0 AND COALESCE(current_setting('revert.allow_empty', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      'This revert examined ZERO venues, so it has measured nothing it strands. '
      'Rehearse it against a non-empty estate, or SET revert.allow_empty = ''on'' '
      'to state deliberately that this database holds no venues.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The 20260911000000 definition, restored verbatim
-- ---------------------------------------------------------------------------
--
-- Recreated in full rather than patched, for the reason PostgreSQL leaves no
-- choice about: there is no way to replace a branch inside a function body. The
-- text below is the 20260911000000 definition, and the ONLY differences from
-- the reverted one are the gate, the reason expression and the `v_reason`
-- DECLARE.

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

    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id, 'settings.updated', 'location', p_location_id,
            jsonb_build_object(
                'setting', 'facility.location',
                'operation', 'admin_retire_location',
                'phase', 'refused',
                'reason', 'bookings_after_effective_to',
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
            'reason', 'bookings_after_effective_to',
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
  'Org-admin venue retirement: writes locations.effective_to and copies nothing down. Refuses with the affected bookings unless p_confirm, and reports contained (every field and sub-surface the venue holds, flagged already_retired) WITHOUT gating on it. Returns a refusal object rather than raising, and audits refused/before/after. Restored by docs/sql/20260912000000_revert.sql; see that file for what stops being guarded.';

-- ---------------------------------------------------------------------------
-- The restore really happened, asserted in the same transaction
-- ---------------------------------------------------------------------------
--
-- **This assertion is NOT a catalogue verdict copied from a sibling stage.**
-- Part 1's review found exactly that in `run.sh` -- a check whose every failure
-- mode raised earlier, so nothing could reach it. This one reads `prosrc`,
-- which is the thing the restore actually rewrites, and it can fail: a
-- CREATE OR REPLACE that silently created an OVERLOAD instead of replacing, or
-- a copy-paste that kept the new gate, both land here.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_retire_location';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'admin_retire_location is not present after the restore';
  END IF;
  IF v_src LIKE '%contained_estate_after_effective_to%' THEN
    RAISE EXCEPTION 'the restore kept the containment gate; admin_retire_location was not reverted';
  END IF;
  IF v_src NOT LIKE '%v_affected_count > 0 AND NOT COALESCE(p_confirm, false)%' THEN
    RAISE EXCEPTION 'the restored admin_retire_location does not carry the 20260911000000 gate';
  END IF;
  -- And the halves that this migration never touched are still there, so a
  -- revert that also dropped them cannot print reassurance and exit green.
  IF v_src NOT LIKE '%contained_count%' OR v_src NOT LIKE '%estate_contained_nodes%' THEN
    RAISE EXCEPTION 'the restored admin_retire_location lost its containment REPORT, which this revert does not touch';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'admin_retire_location') <> 1 THEN
    RAISE EXCEPTION 'admin_retire_location has an overload; the restore created rather than replaced';
  END IF;
END $$;

COMMIT;
