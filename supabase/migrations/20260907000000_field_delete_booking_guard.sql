-- LIVE-1: give admin_delete_field the booking guard it never had, and give
-- practice_assignments.field_id the foreign key it never had.
--
-- Recorded as LIVE-1 at the foot of docs/PHASE_8_PROGRESS.md after 8.4 PR 2.
-- Its own PR, not part of the 8.4 three-PR stack.
--
-- ## The defect
--
-- `admin_delete_field` (20260504060000_admin_facility_mutation_rpcs.sql:296)
-- runs `DELETE FROM public.fields` behind an `is_org_admin` gate and a
-- not-found check and NOTHING else. One admin action loses schedule data three
-- different ways, silently, and the three are different from each other:
--
--   * `game_slots.field_id` and `practice_slots.field_id` are NOT NULL FKs
--     `ON DELETE CASCADE`, so the slots are DELETED with the field.
--   * `game_assignments.field_id` is `ON DELETE SET NULL` (added by
--     20260503030000_repair_game_persistence_rpc.sql), so a scheduled game
--     SURVIVES having silently lost its venue.
--   * `practice_assignments.field_id` had NO FOREIGN KEY AT ALL -- a bare
--     `uuid` column since 20260331000000_definitive_schema.sql -- so the value
--     was left DANGLING at a row that no longer exists. Worse than the SET NULL
--     case: the column still reads as set, so nothing downstream can tell
--     "assigned to this pitch" from "assigned to a pitch that was deleted".
--
-- All three were verified against the applied schema before this file was
-- written, by querying `pg_constraint` on a database with every migration
-- applied, rather than by grepping the migrations -- a grep for
-- `field_id ... ON DELETE CASCADE` returns `field_subunits`, `practice_slots`
-- and `game_slots`, none of which is an assignment table, and reading that as
-- confirmation of the assignment-table claims would have confirmed the wrong
-- thing.
--
-- ## The contract, taken from the sibling rather than invented
--
-- `admin_retire_field` (20260906000000) already answers "what happens when you
-- remove ground that is booked": with `p_confirm = false` and at least one
-- affected booking it RETURNS `{retired: false, reason, affected_count,
-- affected}` -- no exception -- writes a `phase: 'refused'` audit row, and
-- changes no field state. A third answer to the same question is the defect
-- class this phase keeps finding, so this adopts that shape exactly:
-- `{deleted: false, reason: 'bookings_exist', affected_count, affected}`, a
-- refused audit row, and no DELETE.
--
-- Two details of that contract are worth stating because a reading of the
-- sibling that was not executed got both backwards: it RETURNS rather than
-- RAISES, and it DOES write (the refusal audit row). A caller that only checks
-- PostgREST's `error` sees a refusal as success -- which is exactly what
-- `frontend/src/hooks/useFields.js` did before this PR, discarding `data`
-- entirely and then removing the field from the list it had not deleted.
--
-- The reason literal differs because the question does: a retirement has a
-- date and asks "what is booked AFTER it", so its reason is
-- `bookings_after_effective_to`. A deletion has no date and takes everything,
-- so its reason is `bookings_exist` and its enumeration has no date filter.
--
-- `admin_delete_field` KEEPS EXISTING. The UI surfaces Retire, but a genuine
-- mistake -- a field created twice, a typo -- still needs a delete, and
-- `p_confirm => true` is that path.
--
-- ## The family, derived from the REFERENTIAL GRAPH rather than a column name
--
-- The first version of this header enumerated the seven tables that carry a
-- `field_id` and called that the family. It is not the family: what a delete
-- destroys is the CASCADE CLOSURE from `fields`, and that closure was computed
-- from `pg_constraint` only after a review asked. It has fifteen edges over
-- three levels, and two of the things it reaches were invisible to a
-- column-name census:
--
--   * `games` -- no `field_id` at all. It hangs off `game_slots` ON DELETE
--     CASCADE (20260331000000:585), so deleting the ground destroys the
--     fixture AND the recorded score. A column-name census cannot see it.
--   * `game_assignments` and `practice_assignments` reach the field a SECOND
--     way, through their slot columns, and those edges are CASCADE where the
--     `field_id` edge is SET NULL. The CASCADE wins: an assignment produced by
--     the scheduler is destroyed, not unassigned. Both halves of that were
--     measured against a real delete before this was written.
--
-- FIVE kinds are read as bookings: game_slot, game (via its slot),
-- game_assignment, practice_slot, practice_assignment -- the last two of which
-- report their disposition PER ROW, because it depends on whether that row has
-- a slot behind it.
--
-- Three tables in the closure are excluded, each for a stated reason:
--   * field_subunits              CASCADE. The estate's own structure: a
--     subunit is part of the field, not a use of it. A practice slot scoped to
--     a HALF pitch still carries the parent's field_id (NOT NULL), so it is
--     caught by the practice_slots arm.
--   * field_availability_profiles SET NULL. Import metadata describing the
--     ground, not a use of it, and nothing is destroyed. (Its nullable
--     field_id is the subject of LIVE-2 and is not touched here.)
--   * field_blackouts             CASCADE. A closure, not a booking: deleting
--     a field cannot strand the statement that it was already shut.
--
-- `docs/sql/20260907000000_smoke.sql` re-derives the closure on every harness
-- run and fails if a table joins or leaves it, so the next `games` cannot
-- arrive unnoticed.
--
-- ## The retirement boundary is INCLUSIVE, and every arm reads it that way
--
-- `p_after` is the LAST DAY THE GROUND IS USABLE, not the first day it is shut.
-- "Retire this field on the 30th" leaves a booking on the 30th alone and
-- strands only what falls after it. That is not a new decision here: it is the
-- reading `public.field_is_live_on(effective_to, d)` already ships
-- (`effective_to >= d`, 20260906000000:140) and the one
-- `packages/core/src/facility/lifecycle.js isLiveOn()` gives the frontend, so
-- choosing the other way would have made the guard disagree with the predicate
-- the scheduler uses to decide the same question.
--
-- Four of the five arms compare the booking's OWN date and get it right for
-- free. `practice_assignments` carries a daterange, which Postgres canonicalises
-- to `[)` -- so `upper()` is the day AFTER the last one covered, and comparing
-- it to `p_after` reported a practice ending exactly ON the retirement date as
-- stranded while a game slot the same day was not. The arm now compares
-- `upper() - 1`, computed once and used by both the projection and the filter.
--
-- This is the shape two agreeing implementations cannot catch: the mock had the
-- same off-by-one, so the shared scenario table saw two answers that matched.
-- The table now states the boundary as DATA -- `retire-*-on-boundary` proceeds,
-- `retire-*-day-after-boundary` refuses, one pair per arm -- so both runners are
-- measured against the fixture rather than against each other.
--
-- ## Why practice_assignments.field_id becomes ON DELETE SET NULL
--
-- Its twin `game_assignments.field_id` is already SET NULL, and the two
-- currently DISAGREE only because one of them has no constraint at all. This
-- makes them AGREE, deliberately, and the alternatives were considered rather
-- than skipped:
--
--   * CASCADE would delete the assignment row -- the persisted schedule entry
--     naming a team, a day and a time. The field is one attribute of that row;
--     destroying the whole booking to remove one attribute loses more than the
--     operator asked to lose, and it would also make the two assignment tables
--     disagree in the other direction.
--   * RESTRICT / NO ACTION would make the delete impossible even with
--     `p_confirm => true`, which contradicts keeping a genuine mistake
--     deletable. The refusal belongs in the RPC, where it can be confirmed,
--     not in a constraint that cannot.
--   * SET NULL leaves the assignment intact and its venue VISIBLY absent,
--     which is the state a downstream reader can surface as TBD. A dangling
--     uuid cannot be surfaced as anything, because nothing can tell it from a
--     live one.
--
-- Rows already dangling are repaired to NULL below, loudly: the count is
-- printed, and a repair that touched nothing says so rather than passing in
-- silence.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. practice_assignments.field_id: repair, then constrain
-- ---------------------------------------------------------------------------

-- **The cleanup is enumerated from practice_assignments, not from fields.**
-- The rows at issue are precisely the ones whose field is already gone, so
-- deriving them from `fields` -- the data the break corrupted -- would find
-- none of them. `NOT EXISTS` against `fields` is the reading that survives.
DO $$
DECLARE v_repaired integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'practice_assignments_field_id_fkey'
          AND conrelid = 'public.practice_assignments'::regclass
    ) THEN
        RAISE NOTICE 'practice_assignments.field_id already constrained; no repair needed';
        RETURN;
    END IF;

    UPDATE public.practice_assignments pa
       SET field_id = NULL,
           updated_at = timezone('utc', now())
     WHERE pa.field_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.id = pa.field_id);
    GET DIAGNOSTICS v_repaired = ROW_COUNT;

    IF v_repaired > 0 THEN
        -- WARNING, not NOTICE: these are practices whose venue was lost by an
        -- earlier unguarded delete, and the operator should know how many.
        RAISE WARNING
          'repaired % practice_assignment(s) whose field_id pointed at a deleted field', v_repaired;
    ELSE
        RAISE NOTICE 'no dangling practice_assignments.field_id values to repair';
    END IF;
END $$;

ALTER TABLE public.practice_assignments
  DROP CONSTRAINT IF EXISTS practice_assignments_field_id_fkey;

ALTER TABLE public.practice_assignments
  ADD CONSTRAINT practice_assignments_field_id_fkey
  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.practice_assignments.field_id IS
  'The pitch this practice is assigned to. ON DELETE SET NULL, matching game_assignments.field_id: deleting a field must not destroy the booking, and must not leave a uuid pointing at nothing either. NULL here means the venue is gone and the practice needs one.';

-- ---------------------------------------------------------------------------
-- 2. ONE producer of "what is booked on this ground"
-- ---------------------------------------------------------------------------
--
-- **Two enumerators is the defect, not two copies of one.** The first draft of
-- this migration wrote the union out again inside `admin_delete_field` and left
-- `admin_retire_field`'s four-arm copy alone. That is not "a second copy" -- it
-- is a SECOND ANSWER: retire's copy has no `games` arm and does not see an
-- assignment reached through its slot, so a retirement under-reports what it
-- affects and the operator confirms against an incomplete list. Less
-- destructive than the delete path, because a retirement writes a date rather
-- than removing rows, but it is still a wrong answer given to a human at the
-- moment they decide.
--
-- So there is one producer and both RPCs call it. `docs/sql/20260907000000_smoke.sql`
-- requires each of them to reference this function and to contain no union of
-- its own, so re-inlining fails the run rather than quietly reintroducing the
-- divergence.
--
-- `p_after` is the only thing the two callers differ by:
--   * a RETIREMENT has an effective date and asks what is booked AFTER it;
--   * a DELETION has no date and takes everything, so it passes NULL.
-- NULL is "no date applies", which is a different answer from an empty filter.
--
-- `cascades` says whether a CASCADE edge reaches the row, which is what decides
-- a deletion's disposition. It is computed here rather than by the caller
-- because it is a fact about the referential graph, not about the operation:
-- retire simply ignores it, since a retirement destroys nothing.
--
-- SECURITY INVOKER and no grants: both callers are SECURITY DEFINER, so this
-- runs as the definer through them, and nothing outside them may call it.
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
    -- is its slot's.
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
           OR b.last_day > p_after);
$$;

REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM PUBLIC;

COMMENT ON FUNCTION public.field_bookings(uuid, uuid, date) IS
  'THE single reading of "what is booked on this ground", shared by admin_retire_field and admin_delete_field. Five kinds, derived from the cascade closure from fields rather than from the field_id column name. p_after NULL means no date applies (a deletion takes everything); a date means "booked after this" (a retirement). cascades says a CASCADE edge reaches the row, which is what decides a deletion disposition. Internal: no EXECUTE grant, both callers are SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- 3. A refusal must not embed an unbounded list in the audit row
-- ---------------------------------------------------------------------------
--
-- Every refusal writes the affected list into `audit_log.metadata`, and a
-- delete refused on a busy field would write an arbitrarily large row on every
-- attempt. The trail needs enough to review the decision, not a copy of the
-- schedule: a bounded sample, the total, and the counts the sample is a sample
-- of.
CREATE OR REPLACE FUNCTION public.field_bookings_digest(p_affected jsonb, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'total', jsonb_array_length(COALESCE(p_affected, '[]'::jsonb)),
        'omitted', GREATEST(jsonb_array_length(COALESCE(p_affected, '[]'::jsonb)) - p_limit, 0),
        'by_kind', COALESCE(
            (SELECT jsonb_object_agg(k, n)
               FROM (SELECT x->>'kind' AS k, count(*) AS n
                       FROM jsonb_array_elements(COALESCE(p_affected, '[]'::jsonb)) x
                      GROUP BY 1) c),
            '{}'::jsonb),
        'sample', COALESCE(
            (SELECT jsonb_agg(x)
               FROM (SELECT x FROM jsonb_array_elements(COALESCE(p_affected, '[]'::jsonb)) x
                      LIMIT p_limit) t),
            '[]'::jsonb)
    );
$$;

REVOKE ALL ON FUNCTION public.field_bookings_digest(jsonb, integer) FROM PUBLIC;

COMMENT ON FUNCTION public.field_bookings_digest(jsonb, integer) IS
  'A bounded audit-log rendering of an affected-booking list: total, omitted, per-kind counts and a capped sample. The RPCs return the full list to the caller and record this, so a refusal on a busy field cannot write an arbitrarily large audit row on every attempt.';

-- ---------------------------------------------------------------------------
-- 4. admin_delete_field, with the refusal shape admin_retire_field already has
-- ---------------------------------------------------------------------------
--
-- **The two-argument function is DROPPED, not left beside the new one.**
-- Adding `p_confirm boolean DEFAULT false` creates an OVERLOAD that no
-- two-argument call can resolve. Measured rather than reasoned about, because
-- the first draft of this comment got the consequence backwards: with both
-- signatures present, BOTH a named call and a positional one raise
-- `42725 function ... is not unique`. So the hazard is not "a caller quietly
-- reaches the unguarded body" -- it is that every existing two-argument caller
-- (`useFields.deleteField`, `supabase/tests/facility_admin_rpcs.sql`) stops
-- working at all, and the fix someone reaches for under that pressure is to
-- call the old signature explicitly, which IS the unguarded body. Dropping it
-- removes both outcomes.
DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid);

CREATE OR REPLACE FUNCTION public.admin_delete_field(
    p_organization_id uuid,
    p_field_id uuid,
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing public.fields%ROWTYPE;
    v_affected jsonb;
    v_affected_count integer;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_field_id IS NULL THEN
        RAISE EXCEPTION 'p_field_id is required'
            USING ERRCODE = '23502';
    END IF;

    -- **Locked and read BEFORE the delete, not returned by it.** The original
    -- deleted first and inferred not-found from the RETURNING being empty, so
    -- there was no window in which the field existed and the bookings could be
    -- counted.
    SELECT *
      INTO v_existing
      FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id
     FOR UPDATE;

    IF v_existing.id IS NULL THEN
        RAISE EXCEPTION 'field % was not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    -- **Locking the field is not enough, because not everything the cascade
    -- reaches has a key to the field.**
    --
    -- `FOR UPDATE` on the `fields` row blocks a concurrent INSERT into any
    -- table with a foreign key TO that row, because such an insert takes a
    -- conflicting KEY SHARE lock on it. That covers the slot tables and the
    -- assignments' own `field_id`. It does NOT cover a `games` row, which
    -- references a game_slot and never the field, nor an assignment carrying
    -- only a slot id -- and both of those are destroyed by the cascade. So the
    -- guard would read one set while the delete removed a larger one: the exact
    -- defect this migration exists to fix, returning as a race.
    --
    -- Locking the field's SLOTS closes it: an insert that hangs a game or an
    -- assignment off one of them takes KEY SHARE on the slot row, which
    -- conflicts with this. Taken after the field, so the two RPCs acquire in
    -- one order and cannot deadlock against each other.
    PERFORM 1 FROM public.game_slots
     WHERE organization_id = p_organization_id AND field_id = p_field_id
     FOR UPDATE;
    PERFORM 1 FROM public.practice_slots
     WHERE organization_id = p_organization_id AND field_id = p_field_id
     FOR UPDATE;

    -- **Every booking the deletion would take -- all FIVE kinds**, and what
    -- it would do to each. The enumeration itself is `public.field_bookings`,
    -- shared with `admin_retire_field`, so "who is affected" has one answer.
    -- `p_after => NULL` means no date applies: a deletion takes everything on
    -- the ground, dated or not.
    --
    -- `disposition` turns the producer's `cascades` into the word the operator
    -- reads. It is decided PER ROW because it differs per row: a slot-linked
    -- assignment is destroyed by the slot cascade while a free-standing one
    -- keeps its row and loses its venue.
    --   'deleted'    -- a CASCADE reaches it; the row goes with the field
    --   'unassigned' -- only field_id is SET NULL; the row survives, venueless
    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', b.kind, 'id', b.booking_id, 'on_date', b.on_date,
            'week_index', b.week_index, 'undated', b.undated,
            'unbounded', b.unbounded,
            'disposition', CASE WHEN b.cascades THEN 'deleted' ELSE 'unassigned' END
          )
          ORDER BY b.on_date NULLS FIRST, b.kind, b.booking_id
        ),
        '[]'::jsonb
      ),
      COUNT(*)
    INTO v_affected, v_affected_count
    FROM public.field_bookings(p_organization_id, p_field_id, NULL) b;

    -- **The refusal lives here, not in the UI.** A confirmation prompt a
    -- caller can skip by calling the RPC directly is not a guard. Same shape as
    -- admin_retire_field: RETURN, do not RAISE, and record the refusal.
    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'setting', 'facility.field',
                'operation', 'admin_delete_field',
                'phase', 'refused',
                'reason', 'bookings_exist',
                'affected_count', v_affected_count,
                -- A bounded rendering: the full list goes back to the CALLER,
                -- a sample and the per-kind counts go into the trail. A delete
                -- refused on a busy field would otherwise write an arbitrarily
                -- large audit row on every attempt.
                'affected', public.field_bookings_digest(v_affected),
                'previous', to_jsonb(v_existing)
            )
        );
        RETURN jsonb_build_object(
            'deleted', false,
            'reason', 'bookings_exist',
            'affected_count', v_affected_count,
            'affected', v_affected
        );
    END IF;

    -- Audit BEFORE the delete, so the world the operator decided against is in
    -- the trail next to the decision. This runs in one transaction, so it does
    -- NOT survive a failure of the DELETE below -- the refusal above does,
    -- because that path RETURNs.
    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        p_field_id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'admin_delete_field',
            'phase', 'before',
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected),
            'previous', to_jsonb(v_existing)
        )
    );

    DELETE FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_existing.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'admin_delete_field',
            'phase', 'after',
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'deleted', true,
            'previous', to_jsonb(v_existing)
        )
    );

    RETURN jsonb_build_object(
        'id', v_existing.id,
        'organization_id', v_existing.organization_id,
        'deleted', true,
        'affected_count', v_affected_count,
        'affected', v_affected
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) IS
  'Admin-only org-scoped field deletion. Refuses with everything the delete would take -- game_slots, games, game_assignments, practice_slots, practice_assignments -- unless p_confirm is true, mirroring admin_retire_field. Each affected row carries a disposition: deleted (a CASCADE reaches it) or unassigned (only its field_id is SET NULL); assignments report this per row, because a slot-linked assignment is destroyed while a free-standing one survives. Returns {deleted:false, reason:''bookings_exist'', affected_count, affected} on refusal rather than raising, and audits refused/before/after.';

-- ---------------------------------------------------------------------------
-- 5. admin_retire_field, moved onto the same producer
-- ---------------------------------------------------------------------------
--
-- **Recreated here, and that is the point.** 20260906000000 shipped it with its
-- own four-arm union, which is why a retirement under-reported: no `games` arm,
-- and no sight of an assignment reached through its slot. The body below is
-- that function with two changes and nothing else:
--
--   1. it enumerates through `public.field_bookings`, so retire and delete give
--      one answer to "what is booked here";
--   2. `NOT COALESCE(p_confirm, false)` where it read `NOT p_confirm`.
--
-- **`p_confirm => NULL` retired booked ground unconfirmed.** `NULL` is not
-- false: `v_affected_count > 0 AND NOT NULL` is NULL, the IF does not fire, and
-- the retirement proceeds without the operator ever confirming. A three-valued
-- flag guarding a destructive action must read unknown as NO, and the mock read
-- it that way (`!p.p_confirm`) while the database did not -- so the two arms
-- disagreed on the one input that turns the guard off.
--
-- Everything else -- the one-directional `active` write, the audit phases, the
-- refusal reason literal -- is carried across unchanged, and 20260906000000's
-- smoke still asserts all of it against whatever version is installed.
--
-- The affected list keeps retire's SIX keys and no `disposition`: a retirement
-- writes a date and destroys nothing, so "what would happen to this row" has no
-- answer to give. The producer computes `cascades` for the deletion's benefit
-- and this arm ignores it.
CREATE OR REPLACE FUNCTION public.admin_retire_field(
    p_organization_id uuid,
    p_field_id uuid,
    p_effective_to date,
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.fields%ROWTYPE;
    v_after  public.fields%ROWTYPE;
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
    IF p_field_id IS NULL THEN
        RAISE EXCEPTION 'p_field_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_effective_to IS NULL THEN
        RAISE EXCEPTION 'p_effective_to is required; retiring with no end date is a deletion, not a retirement'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_before
    FROM public.fields
    WHERE id = p_field_id AND organization_id = p_organization_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Field % not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', b.kind, 'id', b.booking_id, 'on_date', b.on_date,
            'week_index', b.week_index, 'undated', b.undated, 'unbounded', b.unbounded
          )
          ORDER BY b.on_date NULLS FIRST, b.kind, b.booking_id
        ),
        '[]'::jsonb
      ),
      COUNT(*)
    INTO v_affected, v_affected_count
    FROM public.field_bookings(p_organization_id, p_field_id, p_effective_to) b;

    -- **The refusal lives here, not in the UI.** A confirmation prompt a
    -- caller can skip by calling the RPC directly is not a guard.
    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'operation', 'admin_retire_field',
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
        p_organization_id,
        'settings.updated',
        'field',
        p_field_id,
        jsonb_build_object(
            'operation', 'admin_retire_field',
            'phase', 'before',
            'effective_to', p_effective_to,
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected),
            'before', to_jsonb(v_before)
        )
    );

    -- `v_before.active AND live` is the only reading that is one-directional in
    -- the same sense the trigger is: it can turn activity off and never on.
    UPDATE public.fields
    SET effective_to = p_effective_to,
        active = v_before.active AND public.field_is_live_on(p_effective_to),
        updated_at = timezone('utc', now())
    WHERE id = p_field_id AND organization_id = p_organization_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        p_field_id,
        jsonb_build_object(
            'operation', 'admin_retire_field',
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
        'field', to_jsonb(v_after)
    );
END;
$$;

COMMENT ON FUNCTION public.admin_retire_field(uuid, uuid, date, boolean) IS
  'Org-admin retirement: writes fields.effective_to and keeps fields.active in step, refusing with the affected bookings unless p_confirm. Enumerates through public.field_bookings, the reading it shares with admin_delete_field. p_confirm NULL reads as false.';

COMMIT;
