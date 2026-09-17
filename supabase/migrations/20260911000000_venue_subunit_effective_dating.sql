-- 8.4 gap B: effective dating for VENUES and SUB-SURFACES, and one scoped
-- reading of "what is booked on this ground".
--
-- Second of the two follow-ups the operator asked for at the 8.4/8.5 gate
-- (docs/BUILD_PLAN_STATUS.md section 5). 8.4's capability 3 asks to add, edit
-- and retire venues, surfaces AND sub-surfaces, and says retire is an END DATE
-- rather than a delete. 20260906000000 gave that to `fields` only. This closes
-- the other two depths.
--
-- ===========================================================================
-- 1. THE ENUMERATOR: generalised, not duplicated
-- ===========================================================================
--
-- `public.field_bookings` was FIELD-SCOPED. Retiring a venue is a different
-- question -- every field at the site -- and retiring a sub-surface is a third
-- one again. Writing a venue-scoped count next to the field-scoped one is
-- exactly how this repository produced LIVE-1, LIVE-2 and LIVE-3, each of
-- which was one arm of a guard corrected while its sibling was not.
--
-- So the producer GAINS A SCOPE rather than gaining siblings:
--
--     field_bookings(p_organization_id, p_scope_id, p_after, p_scope)
--
-- **Why the signature changed this way, and not another way.** Three
-- functions already call `field_bookings(org, field_id, after)` positionally:
-- `admin_retire_field` (20260907000000), `admin_delete_field` and
-- `rollback_field_import_job` (both 20260909000000). Their bodies run to 619
-- lines between them. A change that moved, renamed or required a new positional
-- argument would have forced all three to be recreated verbatim in this file
-- for the sake of appending one literal -- 619 lines of transcription in the
-- one family where a transcription slip is the recurring defect. Appending
-- `p_scope text DEFAULT 'field'` leaves every existing call site meaning
-- exactly what it meant, which is the field-scoped question all three ask.
--
-- The default is not a silent hazard, and the two things that would make it one
-- are closed:
--
--   * an UNKNOWN scope RAISES (22023) rather than matching nothing. A scope
--     typo that returned an empty set would be a guard reporting "nothing is
--     booked here" -- the loudest possible version of the silent pass this
--     repository keeps finding. That is why this function is now plpgsql: SQL
--     has no way to refuse.
--   * `docs/sql/20260911000000_smoke.sql` asserts that the three pre-existing
--     callers pass no scope AND that each of the three new scopes is reachable,
--     so "field" cannot become the only scope anything ever asks for.
--
-- The second parameter is renamed `p_field_id` -> `p_scope_id` because it is no
-- longer a field id in two of three scopes. PostgreSQL cannot rename an input
-- parameter under CREATE OR REPLACE, so the function is dropped and recreated;
-- plpgsql call sites bind late and by position, so the three callers are
-- unaffected. `docs/sql/20260911000000_revert.sql` restores the three-argument
-- form in full for the same reason -- dropping this one without restoring that
-- one would leave all three callers raising 42883.
--
-- The NAME is kept. Every row this returns is still a booking on a field; what
-- changed is how the ground is named. Renaming it would have imposed the same
-- 619-line recreation the signature choice above exists to avoid.
--
-- ### The scope predicate is a function, and that is load-bearing
--
-- `public.estate_scope_covers` holds the three-way rule once. Inlining it into
-- the six arms would have put `EXISTS (SELECT 1 FROM public.fields ...)` inside
-- every arm -- and `docs/sql/20260907000000_smoke.sql` section 5a reads each
-- arm's `EXISTS (SELECT 1 FROM public.<table>` to decide whether the arm claims
-- a per-row disposition. Six arms would have started claiming they route
-- through `fields`, and that smoke would have begun checking the wrong
-- constraint on every one of them. A helper keeps the arm text saying what it
-- has always said.
--
-- ### What each scope reaches, and why four arms are empty at subunit scope
--
--   * `field`    -- rows whose field is this one. Unchanged.
--   * `location` -- rows whose field sits at this venue. `locations` cascades
--     to `fields` (20260331000000:328), so a venue reaches everything each of
--     its fields reaches.
--   * `subunit`  -- rows that NAME this sub-surface. This is NOT everything on
--     the parent pitch: a game on the full pitch is not booked on its half.
--     `practice_slots.field_subunit_id` (20260331000000:500, ON DELETE CASCADE)
--     is the ONLY column in the schema that names a sub-surface, so the four
--     arms that cannot carry one match nothing at this scope.
--
-- **Four arms matching nothing is a claim, not an accident**, and the smoke
-- proves it from `information_schema` rather than from this comment: if
-- `game_slots` ever gains a `field_subunit_id`, section 4 of
-- `docs/sql/20260911000000_smoke.sql` fails and this arm has to be revisited.
-- That is the "a check that matches zero records is a loud failure" rule
-- applied to an arm rather than to a row.
--
-- ### `cascades` still means what it meant
--
-- It is a fact about the referential graph, and it is true in every scope for
-- every arm that matches: a location cascades to its fields, a field to its
-- slots, a sub-surface to the practice slots that name it. The per-row arms
-- keep deciding per row, with the scope predicate substituted for the bare
-- `s.field_id = p_field_id` inside their EXISTS.
--
-- ### One new output column
--
-- `field_id` joins the result. At field scope the caller already knows it; at
-- venue scope an affected list with no field on it is unattributable -- the
-- operator is shown "4 game slots" with no way to tell which pitch. The three
-- existing callers select by name and ignore it.
--
-- ===========================================================================
-- 2. WHAT RETIRING A PARENT MEANS FOR ITS CHILDREN -- decided here
-- ===========================================================================
--
-- The plan does not say, so it is decided, argued and made testable rather than
-- left to fall out of the implementation.
--
-- **Decision: containment. A venue retirement retires its fields and their
-- sub-surfaces by CONTAINMENT, evaluated where the estate is read. It writes
-- no date onto a child and flips no child flag, and it does not refuse while a
-- child is live.**
--
-- Three candidate answers were considered:
--
--   * **Refuse while any field is live.** Rejected. Every venue has live
--     pitches, so this makes retiring a venue impossible in the ordinary case,
--     and it substitutes a rule ("retire the pitches first") for the operator's
--     decision. It also gives the two depths different contracts for no reason
--     a user could state.
--   * **Copy the date down.** Rejected, and the argument is `admin_unretire_-
--     field`'s own (20260906000000): a reversal cannot know which children the
--     operator had already retired on their own account, so restoring them
--     would discard a decision this RPC never made, and leaving them retired
--     would make unretire not the inverse of retire. The failure is silent
--     either way.
--   * **Containment.** Adopted. It is ALREADY this codebase's contract:
--     `packages/core/src/facility/lifecycle.js` `surfaceIsLiveOn()` walks a
--     surface's whole lineage plus its venue, and its header records two rounds
--     of review spent getting exactly that right. CLAUDE.md's rule is to adopt
--     a sibling's contract rather than invent a third, and this is that sibling.
--     It also makes unretire exactly reversible: clearing the venue's date
--     restores every child that has no date of its own, and no others.
--
-- Containment is only a promise if the operator can see it, so
-- `admin_retire_location` RETURNS and AUDITS the set of children it takes out
-- of service -- `contained`, produced by `public.estate_contained_nodes`, which
-- is the one producer of that set and is shared with `admin_unretire_location`.
-- A child that already carries its own earlier date is reported as
-- `already_retired` rather than counted as newly affected, because a
-- retirement that claims credit for closing something already closed is a
-- wrong number in front of a decision.
--
-- **Containment has no SQL WRITER and therefore gets no SQL predicate.** The
-- authoritative "is this pitch offerable today" read is
-- `frontend/src/utils/fieldLifecycle.js`, which this PR extends to take the
-- venue's window; the SQL side writes dates and never resolves them. Adding
-- `location_is_live_on()` here would be a function with no caller -- the
-- honour-it-or-delete-it rule, applied before the fact. `field_is_live_on(date,
-- date)` is already scope-free (it takes two dates and knows nothing about
-- fields), so the existing single reading is reused rather than twinned.
--
-- ===========================================================================
-- 3. NO `active` COLUMN, AND THEREFORE NO TRIGGER
-- ===========================================================================
--
-- 20260906000000 spends eighty lines bounding the hazard of `fields.active`
-- and `fields.effective_to` both saying a field is out of use, and it keeps
-- `active` only because the shipped scheduler filtered on it. `locations` and
-- `field_subunits` have no such column and no such reader, so giving them one
-- would be manufacturing that hazard on purpose. The `fields_retirement_-
-- deactivates` trigger exists solely to hold the two columns in step; with one
-- column there is nothing for a trigger to enforce, so none is added. This is a
-- deliberate divergence from the pattern of 20260906000000 rather than an
-- omission, and the smoke asserts the absence of both.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
--
-- `effective_to` only, for the reason 20260906000000 gives: nothing in this
-- repository writes or reads an `effective_from`, and a column with an index
-- and no writer reads as load-bearing while being decoration.

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS effective_to date;

ALTER TABLE public.field_subunits
  ADD COLUMN IF NOT EXISTS effective_to date;

COMMENT ON COLUMN public.locations.effective_to IS
  'Inclusive last date this venue is part of the estate. NULL means unbounded. Written only by admin_retire_location/admin_unretire_location. There is deliberately no locations.active: see 20260911000000 section 3. A field at a retired venue is not offerable whatever its own window says -- containment, resolved on read by frontend/src/utils/fieldLifecycle.js and packages/core/src/facility/lifecycle.js, never by a date copied onto the child.';

-- **Its readers, named, and the one kind of reader it deliberately has not
-- got.** This column is asymmetric with locations.effective_to and the
-- asymmetry is a decision, so it is stated where the next person meets it
-- rather than left to be rediscovered.
COMMENT ON COLUMN public.field_subunits.effective_to IS
  'Inclusive last date this sub-surface is part of the estate. NULL means unbounded. Written only by admin_retire_field_subunit/admin_unretire_field_subunit. Retiring it strands only bookings that NAME it -- practice_slots.field_subunit_id is the one column in the schema that does -- not everything on the parent pitch. READERS: its own RPC pair, and estate_contained_nodes, which reports it and decides already_retired when a venue above it is retired. There is deliberately NO SCHEDULER reader, unlike locations.effective_to, which frontend/src/utils/fieldLifecycle.js consults before offering a pitch: nothing in the app offers a sub-surface to book onto, so an offerability read would be speculative work justified by symmetry alone. When sub-surfaces become bookable -- 8.8 is the likely home -- enforcing this window is that task, and it should adopt the containment reading in packages/core/src/facility/lifecycle.js rather than inventing a second one.';

CREATE INDEX IF NOT EXISTS idx_locations_effective_to
  ON public.locations (organization_id, effective_to)
  WHERE effective_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_field_subunits_effective_to
  ON public.field_subunits (organization_id, effective_to)
  WHERE effective_to IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The scope predicate -- one rule, three scopes, six arms
-- ---------------------------------------------------------------------------
--
-- Every arm of the producer passes the two facts a booking row can carry about
-- WHERE it is: the field it sits on, and the sub-surface it names (NULL for the
-- five kinds that cannot name one). This function turns those into "is it in
-- scope", once.
--
-- `p_field_subunit_id = p_scope_id` is NULL rather than false when the row
-- names no sub-surface, and a NULL in a WHERE excludes the row -- which is the
-- wanted answer, arrived at by three-valued logic rather than by intent. It is
-- written out as an explicit IS NOT NULL so a reader does not have to derive it
-- and so a future `COALESCE` somewhere cannot change the meaning silently.
CREATE OR REPLACE FUNCTION public.estate_scope_covers(
    p_organization_id uuid,
    p_scope text,
    p_scope_id uuid,
    p_field_id uuid,
    p_field_subunit_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE p_scope
    WHEN 'field' THEN p_field_id IS NOT NULL AND p_field_id = p_scope_id
    WHEN 'location' THEN EXISTS (
      SELECT 1 FROM public.fields f
       WHERE f.id = p_field_id
         AND f.location_id = p_scope_id
         AND f.organization_id = p_organization_id
    )
    WHEN 'subunit' THEN p_field_subunit_id IS NOT NULL AND p_field_subunit_id = p_scope_id
    -- No ELSE. An unrecognised scope yields NULL here, which would silently
    -- match nothing -- so the PRODUCER refuses the scope before any arm runs,
    -- and this branch is unreachable. Stated rather than defended twice.
  END;
$$;

COMMENT ON FUNCTION public.estate_scope_covers(uuid, text, uuid, uuid, uuid) IS
  'The one rule for "is this booking row inside the piece of estate being retired". field: the row is on this pitch. location: the row is on a pitch at this venue. subunit: the row NAMES this sub-surface, which is narrower than the parent pitch. Called once per arm of public.field_bookings rather than inlined, so that each arm''s text keeps saying what docs/sql/20260907000000_smoke.sql section 5a parses it for.';

REVOKE ALL ON FUNCTION public.estate_scope_covers(uuid, text, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.estate_scope_covers(uuid, text, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.estate_scope_covers(uuid, text, uuid, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.estate_scope_covers(uuid, text, uuid, uuid, uuid) FROM service_role;

-- ---------------------------------------------------------------------------
-- 3. The producer, scoped
-- ---------------------------------------------------------------------------
--
-- Dropped and recreated: the second parameter is renamed and the result gains a
-- column, neither of which CREATE OR REPLACE can do. The three callers bind by
-- position at run time and are untouched.
DROP FUNCTION IF EXISTS public.field_bookings(uuid, uuid, date);

CREATE FUNCTION public.field_bookings(
    p_organization_id uuid,
    p_scope_id uuid,
    p_after date DEFAULT NULL,
    p_scope text DEFAULT 'field'
)
RETURNS TABLE (
    kind text,
    booking_id uuid,
    on_date date,
    week_index integer,
    undated boolean,
    unbounded boolean,
    cascades boolean,
    field_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    -- **An unknown scope is refused, never answered with an empty set.** This
    -- is the whole reason the function is no longer LANGUAGE sql.
    IF p_scope IS NULL OR p_scope NOT IN ('field', 'location', 'subunit') THEN
        RAISE EXCEPTION 'unknown booking scope %; expected field, location or subunit', p_scope
            USING ERRCODE = '22023';
    END IF;
    IF p_organization_id IS NULL OR p_scope_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_scope_id are both required'
            USING ERRCODE = '22023';
    END IF;

    -- Dates: a game slot's is `slot_date` falling back to `start` (the import
    -- writes slot_date and never start, 20260503070000:738); an assignment's is
    -- its own `start`; a practice slot's is `valid_until`; a practice
    -- assignment's is the last day of its `effective_date_range`; a game's is
    -- its slot's; a profile's is `available_until`.
    --
    -- `undated` means COULD NOT BE JUDGED. `unbounded` means runs forever and
    -- is therefore CERTAINLY affected -- a different answer, not a missing one.
    RETURN QUERY
    SELECT 'game_slot'::text, gs.id,
           COALESCE(gs.slot_date, gs.start::date),
           gs.week_index::integer,
           COALESCE(gs.slot_date, gs.start::date) IS NULL,
           false,
           true,
           gs.field_id
    FROM public.game_slots gs
    WHERE gs.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, gs.field_id, NULL)
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
           true,
           gs.field_id
    FROM public.games g
    JOIN public.game_slots gs ON gs.id = g.game_slot_id
    WHERE gs.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, gs.field_id, NULL)
      AND (p_after IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) > p_after)
    UNION ALL
    -- **An assignment's fate depends on the ROW, not on its table.**
    -- `game_assignments.field_id` is SET NULL, but `game_slot_id` and `slot_id`
    -- are ON DELETE CASCADE to `game_slots` (20260503030000:39-56), so for a
    -- real persisted schedule the slot cascade destroys the assignment before
    -- the SET NULL can fire.
    SELECT 'game_assignment'::text, ga.id,
           ga.start::date,
           ga.week_index::integer,
           ga.start IS NULL,
           false,
           EXISTS (SELECT 1 FROM public.game_slots s
                    WHERE s.id IN (ga.game_slot_id, ga.slot_id)
                      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, NULL)),
           ga.field_id
    FROM public.game_assignments ga
    WHERE ga.organization_id = p_organization_id
      AND (public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, ga.field_id, NULL)
           OR EXISTS (SELECT 1 FROM public.game_slots s
                       WHERE s.id IN (ga.game_slot_id, ga.slot_id)
                         AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, NULL)))
      AND (p_after IS NULL OR ga.start IS NULL OR ga.start::date > p_after)
    UNION ALL
    -- **The one arm that a sub-surface scope can reach directly.**
    -- `practice_slots.field_subunit_id` is the only column in the schema that
    -- names a sub-surface, so it is the only arm passing a non-NULL fifth
    -- argument. At field and location scope it is judged by its `field_id`
    -- exactly as before -- a slot scoped to a HALF pitch still carries the
    -- parent's field_id, which is NOT NULL.
    SELECT 'practice_slot'::text, ps.id,
           ps.valid_until,
           NULL::integer,
           false,
           ps.valid_until IS NULL,
           true,
           ps.field_id
    FROM public.practice_slots ps
    WHERE ps.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, ps.field_id, ps.field_subunit_id)
      AND (p_after IS NULL OR ps.valid_until IS NULL OR ps.valid_until > p_after)
    UNION ALL
    -- The same, for practices. `practice_assignments.slot_id` and
    -- `.practice_slot_id` are both ON DELETE CASCADE to `practice_slots`
    -- (20260331000000:526-527).
    --
    -- **The boundary is INCLUSIVE.** `p_after` is the last day the ground is
    -- usable -- the reading `field_is_live_on(effective_to, d)` and
    -- `facility/lifecycle.js isLiveOn()` already give. A daterange is
    -- canonicalised to `[)`, so `upper()` is the day AFTER the last covered
    -- one; the last covered day is `upper() - 1`, computed once in the lateral
    -- and used by both the projection and the filter.
    SELECT 'practice_assignment'::text, pa.id,
           b.last_day,
           NULL::integer,
           false,
           pa.effective_date_range IS NULL OR upper_inf(pa.effective_date_range),
           EXISTS (SELECT 1 FROM public.practice_slots s
                    WHERE s.id IN (pa.practice_slot_id, pa.slot_id)
                      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, s.field_subunit_id)),
           pa.field_id
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
      AND (public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, pa.field_id, NULL)
           OR EXISTS (SELECT 1 FROM public.practice_slots s
                       WHERE s.id IN (pa.practice_slot_id, pa.slot_id)
                         AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, s.field_subunit_id)))
      AND (p_after IS NULL
           OR pa.effective_date_range IS NULL
           OR upper_inf(pa.effective_date_range)
           OR b.last_day > p_after)
    UNION ALL
    -- The sixth kind, added by 20260909000000 (LIVE-3). Dated by
    -- `available_until`, which is NOT NULL, so this arm can be neither undated
    -- nor unbounded, and the comparison is written out rather than routed
    -- through a nullable reading.
    SELECT 'availability_profile'::text, fap.id,
           fap.available_until,
           NULL::integer,
           false,
           false,
           true,
           fap.field_id
    FROM public.field_availability_profiles fap
    WHERE fap.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, fap.field_id, NULL)
      AND (p_after IS NULL OR fap.available_until > p_after);
END;
$$;

-- The ACL is destroyed with the function, so it is re-established rather than
-- inherited. 20260614000000 grants EXECUTE to `authenticated` by default
-- privilege on every function created in this schema, which a revoke from
-- PUBLIC does not remove; section 5c of 20260907000000's smoke fails if any
-- role reappears here.
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date, text) FROM anon;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date, text) FROM service_role;

COMMENT ON FUNCTION public.field_bookings(uuid, uuid, date, text) IS
  'THE single reading of "what is booked on this ground", shared by admin_retire_field, admin_delete_field, rollback_field_import_job, admin_retire_location and admin_retire_field_subunit. SIX kinds, derived from the cascade closure rather than from a column name. SCOPED as of 20260911000000: p_scope is field (this pitch), location (every pitch at this venue) or subunit (only rows naming this sub-surface, which is narrower than the parent pitch). An unknown scope RAISES 22023 rather than matching nothing. p_after NULL means no date applies (a deletion takes everything); a date means "booked after this", inclusive on the last usable day. cascades says a CASCADE edge reaches the row. Internal: EXECUTE revoked from PUBLIC, anon, authenticated and service_role.';

-- ---------------------------------------------------------------------------
-- 4. The containment set: what a venue retirement takes out of service
-- ---------------------------------------------------------------------------
--
-- Section 2 of the header decides that a venue retirement reaches its children
-- by containment rather than by writing dates onto them. This is the one
-- producer of that set, so that the retire and unretire arms cannot report
-- different children -- the twin-arm failure this phase keeps recording.
--
-- `already_retired` is the row's own window ending no later than the venue's:
-- such a child is closed by its own decision and this retirement changes
-- nothing for it. Counting it as newly affected would put a number in front of
-- an operator that overstates what they are about to do.
CREATE OR REPLACE FUNCTION public.estate_contained_nodes(
    p_organization_id uuid,
    p_location_id uuid,
    p_effective_to date DEFAULT NULL
)
RETURNS TABLE (
    kind text,
    node_id uuid,
    node_name text,
    own_effective_to date,
    already_retired boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT 'field'::text, f.id, f.name, f.effective_to,
           f.effective_to IS NOT NULL AND p_effective_to IS NOT NULL
             AND f.effective_to <= p_effective_to
    FROM public.fields f
    WHERE f.organization_id = p_organization_id
      AND f.location_id = p_location_id
    UNION ALL
    SELECT 'field_subunit'::text, su.id, su.label, su.effective_to,
           su.effective_to IS NOT NULL AND p_effective_to IS NOT NULL
             AND su.effective_to <= p_effective_to
    FROM public.field_subunits su
    JOIN public.fields f2 ON f2.id = su.field_id
    WHERE su.organization_id = p_organization_id
      AND f2.location_id = p_location_id;
$$;

COMMENT ON FUNCTION public.estate_contained_nodes(uuid, uuid, date) IS
  'Every field and sub-surface a venue contains, with whether its own window already ends no later than the date being applied. The one producer of the containment set, shared by admin_retire_location and admin_unretire_location so the two arms cannot report different children. It resolves NOTHING about liveness -- containment is a read-time rule (frontend/src/utils/fieldLifecycle.js), and this function only says which nodes it will apply to.';

REVOKE ALL ON FUNCTION public.estate_contained_nodes(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.estate_contained_nodes(uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.estate_contained_nodes(uuid, uuid, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.estate_contained_nodes(uuid, uuid, date) FROM service_role;

-- ---------------------------------------------------------------------------
-- 5. admin_retire_location
-- ---------------------------------------------------------------------------
--
-- The contract is 20260906000000's, adopted rather than re-invented:
--
--   * it RETURNS a refusal object and writes a `phase: 'refused'` audit row
--     rather than raising, because a caller checking only PostgREST's `error`
--     must not read a refusal as success;
--   * the affected list carries NO `disposition`. A retirement writes a date
--     and destroys nothing, so "what would happen to this row" has no answer to
--     give (20260907000000:663-666), and rendering one would put a claim the
--     database never made in front of the person deciding;
--   * the row is taken FOR UPDATE before anything is enumerated, so a booking
--     inserted during the read cannot be missed by the guard and destroyed by
--     the decision;
--   * `p_confirm` NULL reads as UNCONFIRMED. A bare `NOT p_confirm` let
--     `p_confirm => NULL` through, which was one of the two live defects folded
--     into LIVE-1.
--
-- **The one thing it adds is `contained`**, for the reason section 2 of the
-- header gives: containment is only a promise the operator can act on if they
-- are shown which pitches and half-pitches stop being offerable. It is
-- reported on the refusal, on the commit and in both audit phases.
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

-- ---------------------------------------------------------------------------
-- 6. admin_unretire_location
-- ---------------------------------------------------------------------------
--
-- **Exactly the inverse, which is only possible because retire wrote nothing
-- to a child.** `admin_unretire_field` cannot restore `fields.active` because
-- it cannot know whether the inactivity came from the retirement or from an
-- earlier decision. A venue retirement has no such ambiguity to create: it
-- wrote one date on one row, so clearing that date restores every child that
-- has no date of its own and leaves alone every child that has.
--
-- `contained` is reported here too, from the same producer, so the operator
-- sees what comes back. `p_effective_to => NULL` is passed to the producer
-- because no date is being applied, which makes `already_retired` false for
-- every row -- a child with its own window stays retired by that window and
-- this call does not claim to have restored it.
CREATE OR REPLACE FUNCTION public.admin_unretire_location(
    p_organization_id uuid,
    p_location_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.locations%ROWTYPE;
    v_after  public.locations%ROWTYPE;
    v_contained jsonb;
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

    SELECT * INTO v_before
    FROM public.locations
    WHERE id = p_location_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % not found in organization %', p_location_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'kind', c.kind, 'id', c.node_id, 'name', c.node_name,
                 'own_effective_to', c.own_effective_to,
                 'already_retired', c.already_retired
               )
               ORDER BY c.kind, c.node_name, c.node_id
             ),
             '[]'::jsonb
           )
    INTO v_contained
    FROM public.estate_contained_nodes(p_organization_id, p_location_id, NULL) c;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'location', p_location_id,
        jsonb_build_object(
            'setting', 'facility.location',
            'operation', 'admin_unretire_location',
            'phase', 'before',
            'contained', v_contained,
            'before', to_jsonb(v_before)
        )
    );

    UPDATE public.locations
    SET effective_to = NULL,
        updated_at = timezone('utc', now())
    WHERE id = p_location_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'location', p_location_id,
        jsonb_build_object(
            'setting', 'facility.location',
            'operation', 'admin_unretire_location',
            'phase', 'after',
            'contained', v_contained,
            'after', to_jsonb(v_after)
        )
    );

    RETURN jsonb_build_object(
        'retired', false,
        'contained', v_contained,
        'location', to_jsonb(v_after)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. admin_retire_field_subunit
-- ---------------------------------------------------------------------------
--
-- Same contract, third scope. **What differs is only what "booked here"
-- means**, and that difference lives in the producer rather than here: a
-- sub-surface strands the practice slots that NAME it and the assignments
-- those slots carry, and nothing else. A game on the full pitch is not a
-- booking on its half, and reporting it as one would refuse a retirement that
-- strands nothing.
--
-- There is no `contained` arm because a sub-surface contains nothing --
-- `field_subunits` is the leaf of the estate. Returning an empty `contained`
-- key would be a promise with no producer; the key is absent and the smoke
-- asserts it is absent, which is the difference between "nothing below" and
-- "nobody looked".
CREATE OR REPLACE FUNCTION public.admin_retire_field_subunit(
    p_organization_id uuid,
    p_field_subunit_id uuid,
    p_effective_to date,
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.field_subunits%ROWTYPE;
    v_after  public.field_subunits%ROWTYPE;
    v_affected jsonb;
    v_affected_count integer;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_field_subunit_id IS NULL THEN
        RAISE EXCEPTION 'p_field_subunit_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_effective_to IS NULL THEN
        RAISE EXCEPTION 'p_effective_to is required; retiring with no end date is a deletion, not a retirement'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_before
    FROM public.field_subunits
    WHERE id = p_field_subunit_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sub-surface % not found in organization %', p_field_subunit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

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
    FROM public.field_bookings(p_organization_id, p_field_subunit_id, p_effective_to, 'subunit') b;

    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id, 'settings.updated', 'field_subunit', p_field_subunit_id,
            jsonb_build_object(
                'setting', 'facility.field_subunit',
                'operation', 'admin_retire_field_subunit',
                'phase', 'refused',
                'reason', 'bookings_after_effective_to',
                'effective_to', p_effective_to,
                'affected_count', v_affected_count,
                'affected', public.field_bookings_digest(v_affected),
                'before', to_jsonb(v_before)
            )
        );
        RETURN jsonb_build_object(
            'retired', false,
            'reason', 'bookings_after_effective_to',
            'affected_count', v_affected_count,
            'affected', v_affected
        );
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field_subunit', p_field_subunit_id,
        jsonb_build_object(
            'setting', 'facility.field_subunit',
            'operation', 'admin_retire_field_subunit',
            'phase', 'before',
            'effective_to', p_effective_to,
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected),
            'before', to_jsonb(v_before)
        )
    );

    UPDATE public.field_subunits
    SET effective_to = p_effective_to,
        updated_at = timezone('utc', now())
    WHERE id = p_field_subunit_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field_subunit', p_field_subunit_id,
        jsonb_build_object(
            'setting', 'facility.field_subunit',
            'operation', 'admin_retire_field_subunit',
            'phase', 'after',
            'effective_to', p_effective_to,
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'after', to_jsonb(v_after)
        )
    );

    RETURN jsonb_build_object(
        'retired', true,
        'affected_count', v_affected_count,
        'affected', v_affected,
        'field_subunit', to_jsonb(v_after)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. admin_unretire_field_subunit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_unretire_field_subunit(
    p_organization_id uuid,
    p_field_subunit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.field_subunits%ROWTYPE;
    v_after  public.field_subunits%ROWTYPE;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_field_subunit_id IS NULL THEN
        RAISE EXCEPTION 'p_field_subunit_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_before
    FROM public.field_subunits
    WHERE id = p_field_subunit_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sub-surface % not found in organization %', p_field_subunit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field_subunit', p_field_subunit_id,
        jsonb_build_object(
            'setting', 'facility.field_subunit',
            'operation', 'admin_unretire_field_subunit',
            'phase', 'before',
            'before', to_jsonb(v_before)
        )
    );

    UPDATE public.field_subunits
    SET effective_to = NULL,
        updated_at = timezone('utc', now())
    WHERE id = p_field_subunit_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'field_subunit', p_field_subunit_id,
        jsonb_build_object(
            'setting', 'facility.field_subunit',
            'operation', 'admin_unretire_field_subunit',
            'phase', 'after',
            'after', to_jsonb(v_after)
        )
    );

    RETURN jsonb_build_object(
        'retired', false,
        'field_subunit', to_jsonb(v_after)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_retire_location(uuid, uuid, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unretire_location(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_retire_field_subunit(uuid, uuid, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unretire_field_subunit(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_retire_location(uuid, uuid, date, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unretire_location(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_retire_field_subunit(uuid, uuid, date, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unretire_field_subunit(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_retire_location(uuid, uuid, date, boolean) IS
  'Org-admin retirement of a venue. Writes locations.effective_to and NOTHING ELSE -- no date is copied to a field or a sub-surface. Refuses with the affected booking list, enumerated across every pitch at the venue through public.field_bookings at location scope, unless p_confirm; p_confirm NULL reads as false. Reports `contained`: every field and sub-surface the venue holds, with already_retired for those whose own window already ends no later than this date. Audits refused/before/after.';
COMMENT ON FUNCTION public.admin_unretire_location(uuid, uuid) IS
  'Org-admin reversal of admin_retire_location. Clears locations.effective_to. It IS the exact inverse, unlike admin_unretire_field, and only because the retirement wrote no child state to guess at: every child with no window of its own comes back, every child with one stays retired by it. Audits before and after.';
COMMENT ON FUNCTION public.admin_retire_field_subunit(uuid, uuid, date, boolean) IS
  'Org-admin retirement of a sub-surface. Writes field_subunits.effective_to. Refuses with the bookings that NAME this sub-surface -- practice_slots.field_subunit_id and the assignments on those slots -- not with everything on the parent pitch. No contained key: a sub-surface is the leaf of the estate. Audits refused/before/after.';
COMMENT ON FUNCTION public.admin_unretire_field_subunit(uuid, uuid) IS
  'Org-admin reversal of admin_retire_field_subunit. Clears field_subunits.effective_to. Audits before and after.';

COMMIT;
