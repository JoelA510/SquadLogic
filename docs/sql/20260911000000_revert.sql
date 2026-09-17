-- Revert for 20260911000000_venue_subunit_effective_dating.sql
--
-- **Every behaviour this undoes, named.** A revert that lists only the objects
-- it drops leaves the reader to work out what stops being true, and this one
-- stops five things being true:
--
--   1. **Venues can no longer be retired.** `locations.effective_to` goes, and
--      with it every record that a site is closing. There is no second column
--      holding the effect -- unlike `fields`, where a past retirement also left
--      `active = false` -- so for venues this is a TOTAL loss of the decision,
--      whether the date is past or future. The block below names each one.
--   2. **Sub-surfaces can no longer be retired**, on the same terms.
--   3. **Containment stops being reported.** `estate_contained_nodes` goes, so
--      nothing tells an operator which pitches and half-pitches a venue
--      retirement takes out of service. The read-time rule in
--      `packages/core/src/facility/lifecycle.js` and
--      `frontend/src/utils/fieldLifecycle.js` is unaffected by SQL and will go
--      on resolving containment against a column that no longer exists --
--      i.e. against NULL, i.e. every venue unbounded. **Revert the frontend
--      with this file or the app claims every site is open forever.**
--   4. **`public.field_bookings` loses its scope** and goes back to the
--      three-argument field-scoped form, restored IN FULL below. Restoring it
--      is not optional housekeeping: `admin_retire_field`, `admin_delete_field`
--      and `rollback_field_import_job` call it positionally with three
--      arguments, so dropping the scoped form without putting the old one back
--      leaves all three raising 42883 on every call -- the three guards that
--      stand between an admin click and a destroyed schedule.
--   5. **The producer stops being able to answer a venue or sub-surface
--      question at all**, so anything built on top of it must go first. That
--      is why the RPCs are dropped before the function they call.
--
-- What this revert does NOT do, stated because the absence is deliberate: it
-- does not re-open anything. A venue retired last month simply stops being
-- recorded as retired; nothing writes a replacement state, because inventing
-- one would substitute a decision this file never made for the one it lost.
-- The counts below exist so the loss is in the transcript of the run rather
-- than discovered afterwards. Copy the list somewhere before you COMMIT.

BEGIN;

-- ---------------------------------------------------------------------------
-- What is about to be erased, printed while the columns still exist
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_loc int := 0; v_sub int := 0; v_contained int := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'effective_to'
  ) THEN
    RAISE NOTICE 'locations.effective_to is already gone; nothing to record';
  ELSE
    FOR r IN
      SELECT l.id, l.organization_id, l.name, l.effective_to
        FROM public.locations l
       WHERE l.effective_to IS NOT NULL
       ORDER BY l.effective_to, l.name
    LOOP
      v_loc := v_loc + 1;
      -- The children this venue's date was closing by containment. Counted
      -- from `fields`, not from anything the retirement touched -- a
      -- retirement writes nothing to a child, so deriving this from child
      -- state would count zero for every venue and report a total loss as no
      -- loss at all.
      SELECT count(*) INTO v_contained
        FROM public.fields f
       WHERE f.location_id = r.id AND f.organization_id = r.organization_id;
      RAISE NOTICE
        'LOSING venue retirement: % (%) org % closes %, and with it the containment closing % field(s)',
        r.name, r.id, r.organization_id, r.effective_to, v_contained;
    END LOOP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'field_subunits' AND column_name = 'effective_to'
  ) THEN
    RAISE NOTICE 'field_subunits.effective_to is already gone; nothing to record';
  ELSE
    FOR r IN
      SELECT su.id, su.organization_id, su.label, su.effective_to
        FROM public.field_subunits su
       WHERE su.effective_to IS NOT NULL
       ORDER BY su.effective_to, su.label
    LOOP
      v_sub := v_sub + 1;
      RAISE NOTICE 'LOSING sub-surface retirement: % (%) org % closes %',
        r.label, r.id, r.organization_id, r.effective_to;
    END LOOP;
  END IF;

  IF v_loc = 0 AND v_sub = 0 THEN
    RAISE NOTICE 'no venue or sub-surface carries an effective_to; this revert loses the capability but no recorded closure';
  ELSE
    RAISE WARNING
      'erasing % venue retirement(s) and % sub-surface retirement(s); every one of them will read as permanently open',
      v_loc, v_sub;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. The RPCs go before the producer they call
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_unretire_field_subunit(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_retire_field_subunit(uuid, uuid, date, boolean);
DROP FUNCTION IF EXISTS public.admin_unretire_location(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_retire_location(uuid, uuid, date, boolean);
DROP FUNCTION IF EXISTS public.estate_contained_nodes(uuid, uuid, date);

-- ---------------------------------------------------------------------------
-- 2. The scoped producer, then the scope rule
-- ---------------------------------------------------------------------------
--
-- Dropped BEFORE the three-argument form is recreated. The two would otherwise
-- coexist, and a three-argument call would then be ambiguous rather than
-- resolving to either -- 42725 on every guard, which is a worse failure than
-- the 42883 this whole section exists to prevent.
DROP FUNCTION IF EXISTS public.field_bookings(uuid, uuid, date, text);
DROP FUNCTION IF EXISTS public.estate_scope_covers(uuid, text, uuid, uuid, uuid);

-- ---------------------------------------------------------------------------
-- 3. 20260909000000's three-argument producer, restored verbatim
-- ---------------------------------------------------------------------------
--
-- Copied from `supabase/migrations/20260909000000_rollback_field_import_booking_guard.sql`
-- lines 341-513 rather than paraphrased, because the twelve paragraphs of
-- reasoning above each arm are the record of why that arm reads the way it
-- does, and a paraphrase is how a fourth answer to "what is booked here" gets
-- born inside the file whose job is to restore the third.
CREATE OR REPLACE FUNCTION public.field_bookings(
    p_organization_id uuid,
    p_field_id uuid,
    p_after date DEFAULT NULL
)
RETURNS TABLE (
    kind text,
    booking_id uuid,
    on_date date,
    week_index integer,
    undated boolean,
    unbounded boolean,
    cascades boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    -- Dates: a game slot's is `slot_date` falling back to `start` (the import
    -- writes slot_date and never start, 20260503070000:738); an assignment's is
    -- its own `start`; a practice slot's is `valid_until`; a practice
    -- assignment's is the upper bound of its `effective_date_range`; a game's
    -- is its slot's; a profile's is `available_until`.
    --
    -- `undated` means COULD NOT BE JUDGED. `unbounded` means runs forever and
    -- is therefore CERTAINLY affected -- a different answer, not a missing one.
    SELECT 'game_slot'::text, gs.id,
           COALESCE(gs.slot_date, gs.start::date),
           gs.week_index::integer,
           COALESCE(gs.slot_date, gs.start::date) IS NULL,
           false,
           true
    FROM public.game_slots gs
    WHERE gs.organization_id = p_organization_id AND gs.field_id = p_field_id
      AND (p_after IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) > p_after)
    UNION ALL
    -- **`games` carries no field_id and is reached anyway.** It hangs off
    -- game_slots ON DELETE CASCADE (20260331000000:585), so removing the ground
    -- takes the fixture and its recorded score. A census by COLUMN NAME cannot
    -- see it; this list comes from the cascade closure instead.
    SELECT 'game'::text, g.id,
           COALESCE(gs.slot_date, gs.start::date),
           gs.week_index::integer,
           COALESCE(gs.slot_date, gs.start::date) IS NULL,
           false,
           true
    FROM public.games g
    JOIN public.game_slots gs ON gs.id = g.game_slot_id
    WHERE gs.organization_id = p_organization_id AND gs.field_id = p_field_id
      AND (p_after IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) > p_after)
    UNION ALL
    -- **An assignment's fate depends on the ROW, not on its table.**
    -- `game_assignments.field_id` is SET NULL, but `game_slot_id` and `slot_id`
    -- are ON DELETE CASCADE to `game_slots` (20260503030000:39-56) and
    -- `persist_game_schedule` writes them on every row it produces -- so for a
    -- real persisted schedule the slot cascade destroys the assignment before
    -- the SET NULL can fire. Measured against a real delete, not reasoned about.
    --
    -- The row is caught when its SLOT is on this ground even if its own
    -- `field_id` is not, because the cascade does not consult `field_id`.
    SELECT 'game_assignment'::text, ga.id,
           ga.start::date,
           ga.week_index::integer,
           ga.start IS NULL,
           false,
           EXISTS (SELECT 1 FROM public.game_slots s
                    WHERE s.field_id = p_field_id
                      AND s.id IN (ga.game_slot_id, ga.slot_id))
    FROM public.game_assignments ga
    WHERE ga.organization_id = p_organization_id
      AND (ga.field_id = p_field_id
           OR EXISTS (SELECT 1 FROM public.game_slots s
                       WHERE s.field_id = p_field_id
                         AND s.id IN (ga.game_slot_id, ga.slot_id)))
      AND (p_after IS NULL OR ga.start IS NULL OR ga.start::date > p_after)
    UNION ALL
    SELECT 'practice_slot'::text, ps.id,
           ps.valid_until,
           NULL::integer,
           false,
           ps.valid_until IS NULL,
           true
    FROM public.practice_slots ps
    WHERE ps.organization_id = p_organization_id AND ps.field_id = p_field_id
      AND (p_after IS NULL OR ps.valid_until IS NULL OR ps.valid_until > p_after)
    UNION ALL
    -- The same, for practices. `practice_assignments.slot_id` and
    -- `.practice_slot_id` are both ON DELETE CASCADE to `practice_slots`
    -- (20260331000000:526-527) and `persist_practice_schedule` writes them.
    --
    -- **The boundary is INCLUSIVE, and this arm is the one that has to say so
    -- out loud.** `p_after` is the last day the ground is usable -- the same
    -- reading `field_is_live_on(effective_to, d) = effective_to >= d`
    -- (20260906000000:140) and `facility/lifecycle.js isLiveOn()` already give,
    -- so "retire this field on the 30th" leaves a booking ON the 30th alone and
    -- strands only what falls after it. The four arms above compare the
    -- booking's OWN date and get this right for free.
    --
    -- A daterange does not. Postgres canonicalises every daterange to `[)`, so
    -- `upper()` is the day AFTER the last one covered: a practice running
    -- through the 30th has `upper() = the 31st`, and `upper() > p_after` made it
    -- the one kind reported as stranded by a retirement it actually survives.
    -- The last covered day is `upper() - 1`, computed ONCE in the lateral below
    -- and used by both the projection and the filter -- the projection had the
    -- same defect, reporting the 31st to an operator as the date a practice
    -- ends.
    --
    -- `upper_inc` is always false for a canonical daterange, so no case
    -- distinction is needed; an empty range yields NULL and is excluded by the
    -- comparison exactly as it was before.
    SELECT 'practice_assignment'::text, pa.id,
           b.last_day,
           NULL::integer,
           false,
           pa.effective_date_range IS NULL OR upper_inf(pa.effective_date_range),
           EXISTS (SELECT 1 FROM public.practice_slots s
                    WHERE s.field_id = p_field_id
                      AND s.id IN (pa.practice_slot_id, pa.slot_id))
    FROM public.practice_assignments pa
    CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN pa.effective_date_range IS NULL
                   OR upper_inf(pa.effective_date_range)
                 THEN NULL::date
                 ELSE upper(pa.effective_date_range) - 1
               END
    ) AS b(last_day)
    WHERE pa.organization_id = p_organization_id
      AND (pa.field_id = p_field_id
           OR EXISTS (SELECT 1 FROM public.practice_slots s
                       WHERE s.field_id = p_field_id
                         AND s.id IN (pa.practice_slot_id, pa.slot_id)))
      AND (p_after IS NULL
           OR pa.effective_date_range IS NULL
           OR upper_inf(pa.effective_date_range)
           OR b.last_day > p_after)
    UNION ALL
    -- **The sixth kind, added by 20260909000000 (LIVE-3).** 20260907000000
    -- excluded this table on the reasoning "import metadata describing the
    -- ground, not a use of it, and NOTHING IS DESTROYED". The first half is
    -- still arguable; the second half was the load-bearing one and it was
    -- false in effect -- the SET NULL left a profile describing ground that no
    -- longer existed, with its blackout windows attached, and `field_closures`
    -- went on surfacing them with `closes_field_id` NULL. LIVE-2 measured that
    -- row: visible in the review list, absent from the answer to "is this
    -- ground closed". Now the FK CASCADES, so something IS destroyed, and a
    -- destroyed row that the operator is not shown is the defect this producer
    -- exists to prevent.
    --
    -- **What goes with it is larger than the row.** Four tables hang off
    -- `field_availability_profiles` ON DELETE CASCADE -- its formats, its
    -- scenario memberships, its blackout windows and its equipment
    -- requirements -- and they are its own parts rather than separate
    -- bookings, so they are reported through it rather than as five rows.
    -- `docs/sql/20260909000000_smoke.sql` section 3 asserts that set is
    -- exactly those four and that each reaches `fields` ONLY through the
    -- profile, so a fifth dependent, or one that gains an independent path,
    -- fails the run instead of being absorbed silently.
    SELECT 'availability_profile'::text, fap.id,
           fap.available_until,
           NULL::integer,
           false,
           false,
           true
    FROM public.field_availability_profiles fap
    WHERE fap.organization_id = p_organization_id AND fap.field_id = p_field_id
      AND (p_after IS NULL OR fap.available_until > p_after);
$$;

REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM service_role;

COMMENT ON FUNCTION public.field_bookings(uuid, uuid, date) IS
  'THE single reading of "what is booked on this ground", shared by admin_retire_field, admin_delete_field and rollback_field_import_job. SIX kinds as of 20260909000000, derived from the cascade closure from fields rather than from the field_id column name. p_after NULL means no date applies (a deletion takes everything); a date means "booked after this" (a retirement), inclusive on the last usable day. cascades says a CASCADE edge reaches the row, which is what decides a deletion disposition. Internal: EXECUTE revoked from PUBLIC, anon, authenticated and service_role, so only the owner may call it and all three callers reach it as SECURITY DEFINER. The revokes are explicit because 20260614000000 grants EXECUTE to authenticated by default privilege, which a revoke from PUBLIC does not remove.';

-- **The restore is proved, not assumed.** A body pasted from another file can
-- lose a line to an editor and still create a function; the three guards would
-- then run against a producer missing an arm, which is the LIVE-1 defect
-- reintroduced by its own repair. Six arms and all six tables, or this revert
-- fails and leaves the transaction to roll back.
DO $$
DECLARE v_def text; v_arms int; t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'field_bookings';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'the three-argument field_bookings was not restored; three guards now raise 42883';
  END IF;
  -- `oidvectortypes`, not `pg_get_function_identity_arguments`: the latter
  -- carries parameter names and would fail on a rename that changes nothing a
  -- positional caller can see.
  IF oidvectortypes(
       (SELECT p.proargtypes FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'field_bookings')
     ) <> 'uuid, uuid, date' THEN
    RAISE EXCEPTION 'field_bookings was restored with the wrong signature';
  END IF;
  v_arms := array_length(regexp_split_to_array(v_def, 'UNION ALL'), 1);
  IF v_arms <> 6 THEN
    RAISE EXCEPTION 'the restored producer has % arms, expected 6', v_arms;
  END IF;
  FOREACH t IN ARRAY ARRAY['game_slots','games','game_assignments','practice_slots',
                           'practice_assignments','field_availability_profiles'] LOOP
    IF v_def NOT LIKE '%public.' || t || '%' THEN
      RAISE EXCEPTION 'the restored producer does not enumerate %', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'the three-argument producer is restored with all 6 arms';
END $$;

-- ---------------------------------------------------------------------------
-- 4. The columns and their indexes
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_field_subunits_effective_to;
DROP INDEX IF EXISTS public.idx_locations_effective_to;

ALTER TABLE public.field_subunits DROP COLUMN IF EXISTS effective_to;
ALTER TABLE public.locations DROP COLUMN IF EXISTS effective_to;

COMMIT;
