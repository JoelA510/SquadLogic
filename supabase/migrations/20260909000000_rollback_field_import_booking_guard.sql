-- LIVE-3: the third path that deletes a field, and the last producer of
-- field-less availability profiles.
--
-- Recorded as LIVE-3 at the foot of the LIVE-1 entry in
-- docs/PHASE_8_PROGRESS.md, carved out of PR #378 rather than absorbed, and
-- restated by LIVE-2 (#381) with a second reason. Its own PR.
--
-- ## Two defects, one mechanism, and five more found in the same family
--
-- ### 1. `rollback_field_import_job` guards a field delete with two tables
--
-- `20260503070000_field_import_apply_rollback.sql:1026-1040` deletes a field
-- the import inserted, behind an `EXISTS` over `practice_slots` and
-- `game_slots` and nothing else. That is the same "2 of 4" guard PR #376 fixed
-- in `admin_retire_field` and PR #378 fixed in `admin_delete_field`, still
-- standing in the third member of the family. What it misses is not two
-- tables, it is three kinds:
--
--   * a `game_assignment` or `practice_assignment` whose OWN `field_id` names
--     this field and which hangs off no slot -- nothing blocks, and the
--     assignment is silently unassigned by the SET NULL;
--   * `games`, which carries no `field_id` at all (it hangs off `game_slots`
--     ON DELETE CASCADE) -- blocked here only by accident, because its slot
--     blocks first;
--   * a `field_availability_profile`, which is defect 2 below.
--
-- **This branch does not write a third list.** The single most important
-- constraint on this change is that `public.field_bookings` -- introduced by
-- 20260907000000 as THE reading of "what is booked on this ground", already
-- shared by `admin_retire_field` and `admin_delete_field` -- becomes the
-- reading here too. Three hand-written lists guarantee the next correction
-- lands on two of them.
--
-- ### 2. `admin_delete_field` orphans `field_availability_profiles`
--
-- Measured by LIVE-2 and recorded in its progress entry: a CONFIRMED delete
-- leaves the profile with `field_id NULL`, its blackout windows still hanging
-- off it, and `affected_count: 0` -- because `field_availability_profiles` was
-- excluded from the booking guard and its FK to `fields` was ON DELETE SET
-- NULL. LIVE-2 closed the IMPORT as a producer of field-less profiles; the
-- DELETE was the other one, and it is why collapsing `field_blackouts` and
-- `field_blackout_windows` is still blocked.
--
-- Surfacing it is not closing it. A confirmed delete that warns and then
-- produces the orphan anyway still produces the orphan, so this migration does
-- both: the profile becomes a SIXTH booking kind (so the operator is refused
-- and must confirm), AND its FK becomes ON DELETE CASCADE (so a confirmation
-- destroys it rather than stranding it).
--
-- **The CASCADE is the sibling's contract, not an invention.**
-- `field_blackouts.field_id` -- the other half of the very union
-- `field_closures` reads -- is already ON DELETE CASCADE (20260906000100:53).
-- The two tables carry the same kind of statement about the same ground and
-- disagreed only because one of them was written by an importer. This makes
-- them agree, which is exactly what 20260907000000 did for
-- `practice_assignments.field_id` against `game_assignments.field_id`.
--
-- The alternatives were considered rather than skipped:
--
--   * SET NULL + report (the small change) leaves `admin_delete_field` a live
--     producer of a row `field_closures` surfaces and no field-scoped query
--     can attribute. LIVE-2 measured what that row costs: it is visible in the
--     review list and absent from the answer to "is this ground closed", which
--     reads as handled and is not.
--   * An explicit `DELETE FROM field_availability_profiles` inside
--     `admin_delete_field` would fix ONE deleter. There are three, and this
--     migration exists because a per-RPC list does not hold. A referential
--     action holds for every deleter, including a `psql` session.
--   * RESTRICT would make a genuine mistake undeletable, which is the reason
--     20260907000000 gave for not using it on the assignments.
--
-- **Pre-existing NULLs are counted and left.** Rows already field-less were
-- produced by the pre-20260908 import and deciding what becomes of them is the
-- collapse task's business, not this one's -- but a migration that leaves data
-- behind must say how much, so the count is printed and a zero says so
-- explicitly rather than passing in silence.
--
-- ### 3. Two silent arms in the same function, found while reading it
--
-- `rollback_field_import_job`'s loop is `IF / ELSIF x4` over `target_table`
-- with NO `ELSE`, on BOTH the `inserted` and the `updated` branch -- and the
-- record is marked rolled back regardless:
--
--   * an unrecognised `inserted` record is stamped
--     `rollback_payload = {"deleted": true}` having deleted nothing;
--   * an unrecognised `updated` record is stamped with its previous payload
--     and counted in `restored_records` having restored nothing.
--
-- `import_application_records.target_table` admits twelve values
-- (20260522120000:19) and this loop handles five. The arm is DEFENSIVE rather
-- than reachable through the apply path: `finalize_field_import_job` only ever
-- writes those five with `import_type = 'fields'`, so reaching the ELSE means
-- the ledger disagrees with its own import type -- which is why it RAISES
-- rather than joining `blocked`. A job whose record of what it did cannot be
-- trusted must not be half-rolled-back on the strength of it. `ORDER BY ...
-- ELSE 99` in the same statement already conceded the value can arrive, and
-- the smoke and the pgTAP suite construct such a record directly, which is the
-- only way to reach a defensive arm. This is the silent-`default:` class 8.3
-- recorded three instances of; nothing in the repo checks for it generally, so
-- it is fixed where it is found.
--
-- ### 4. A blocked record now says which record and why
--
-- The function returned `blocked_records` as a bare count. An operator told
-- "3 blocked" cannot act on it. Each refusal now appends
-- `{kind, id, reason, affected_count}` to a `blocked` array, in the shape
-- LIVE-2 established for a refused import row: refuse, report with a reason,
-- leave it replayable (`rolled_back_at` stays NULL, so re-running after
-- clearing the booking rolls the record back). The keys are `kind` and `id`
-- rather than `target_table` and `target_id` because that is what the affected
-- rows the other two RPCs return are called, and because it is what
-- `public.field_bookings_digest` counts by -- the CALLER gets the whole list
-- and the audit row gets that digest, so a rollback refused on a busy season
-- cannot write an unbounded array into `warning_summary` on every attempt.
--
-- ### 5. Two more asymmetries, found by walking the graph rather than the arms
--
-- Neither is the subject of this PR and both are in the function it rewrites,
-- so they are fixed here rather than recorded for a later one. Both were found
-- by deriving a set from `pg_constraint` instead of reading the code, which is
-- the rule PR #378 wrote down: a fix whose sibling set cannot be produced by a
-- command is a fix that is not finished.
--
--   * The `game_slots` arm consulted `game_assignments.game_slot_id` and not
--     `slot_id`. BOTH are ON DELETE CASCADE to `game_slots`
--     (20260503030000:39-56), and the `practice_slots` arm one branch down has
--     always read `slot_id OR practice_slot_id` -- so an assignment carrying
--     only `slot_id` was destroyed by a rollback with nothing refusing, while
--     its practice twin was protected. One arm corrected and not its sibling,
--     inside the function this migration exists to correct.
--   * The `locations` arm refuses while any field remains, which cuts that
--     table's closure at its only other edge -- but `field_blackouts` gained a
--     `location_id` in 20260906000100 and nothing noticed. The exclusion is
--     argued where the arm lives and re-derived by the smoke, so the third
--     referent cannot arrive in silence the way the second did.
--
-- ### 6. The fields arm counted bookings without locking the field
--
-- `admin_delete_field` takes `FOR UPDATE` on the `fields` row and then on that
-- field's `game_slots` and `practice_slots` rows before it counts anything
-- (20260907000000:493, :518, :521), and its comment says exactly why: a
-- `FOR UPDATE` on the parent blocks a concurrent INSERT into any table with a
-- foreign key to it, because such an insert takes a conflicting KEY SHARE
-- lock -- and locking the SLOTS as well is what covers `games` and an
-- assignment carrying only a slot id, neither of which references the field.
--
-- The rollback's fields arm locked nothing but the `import_jobs` row, so a
-- booking inserted between its count and its `DELETE FROM public.fields` was
-- destroyed by the cascade having been counted as nothing. That is one arm of
-- a pair adopting a documented contract and the other not, inside the
-- migration whose subject is exactly that. **And this migration made the
-- window worse**: a profile inserted in it is now CASCADED away rather than
-- merely unlinked.
--
-- The three statements are the sibling's, in the sibling's order, for the
-- reason the sibling gives: field first, then its slots, so the two functions
-- acquire in one order and cannot deadlock against each other.
--
-- **The other four arms are deliberately NOT locked, and that is a decision
-- rather than an omission.** Each of them has the same shape of race -- a
-- `games` row inserted on a game slot between its count and its delete, a
-- practice slot inserted on a subunit, a field inserted on a location -- and
-- closing them means taking a lock on a SLOT or a SUBUNIT before the loop
-- reaches the `fields` record, which is the opposite order to the one
-- `admin_delete_field` takes. That is a deadlock cycle, not a fix: the
-- rollback would hold a slot and want a field while the delete held the field
-- and wanted the slot. Closing those races needs the acquisition order
-- designed across both functions, which is a change of a different size and a
-- different subject. `docs/sql/20260909000000_smoke.sql` section 1b asserts
-- the fields arm holds all three locks and that NO other arm holds one, so the
-- next person to add one here is stopped and made to answer the ordering
-- question rather than discovering it in production.
--
-- **Not exercised, only asserted.** A lock is only observable from a second
-- session, and the harness runs one. The check is structural and its plant
-- removes the lock; the race itself is not reproduced, and saying so is the
-- point. `admin_delete_field`'s identical lock has the same limit.
--
-- ### 7. The cascade could leave a scenario with no members
--
-- Section 1 makes deleting a field destroy its availability profiles, which
-- cascades their `field_availability_scenario_members` rows -- and a scenario
-- whose last member goes that way is left behind holding nothing.
--
-- **The sibling already handles this and its contract is adopted rather than
-- reinvented.** `rollback_field_availability_import_job`
-- (20260522153000:214-226) deletes profiles and then deletes exactly those
-- scenarios that have no remaining members -- narrow, scoped to the scenarios
-- the deleted profiles belonged to, not every empty scenario in the
-- organisation. An org-wide sweep would take a scenario created empty by some
-- other path, which is a different decision nobody has made.
--
-- It is not cosmetic, and that was established rather than assumed:
-- `get_field_availability_scenarios` (20260603000000) LEFT JOINs the members
-- and reports `member_count`, so it RETURNS a zero-member scenario, and
-- `admin_select_field_availability_scenario` checks org, season, group and
-- nothing about membership, so it will ACTIVATE one -- an active scenario
-- yielding an empty availability set. Both are granted to `authenticated`.
-- Nothing in `frontend/src` calls either yet, so it is reachable through the
-- RPC and not through a screen; that bounds the severity and does not remove
-- it, and the UI that will consume them is the one this would surprise.
--
-- Two small helpers below carry the capture and the prune, and
-- `admin_delete_field` is recreated to call them with nothing else changed.
--
-- **Only that one deleter needs them, and the reason is worth stating because
-- the obvious answer is "both".** `rollback_field_import_job`'s fields arm
-- reaches its DELETE only when the producer returned NOTHING, and
-- `availability_profile` is one of the six kinds the producer returns -- so a
-- profile on that ground is unreachable at that line and a prune there would
-- be dead code wearing a guard's clothes. `admin_delete_field` has
-- `p_confirm => true`, which is exactly an override of that refusal, so it is
-- the one that can delete a field whose profiles are still attached. Section 4
-- of the smoke derives which deleters need a prune from the presence of a
-- confirmation override in their bodies rather than from a list.
--
-- **The reader is NOT changed here.** `admin_select_field_availability_scenario`
-- will still activate a zero-member scenario that became empty some other way.
-- With both field deleters and the availability rollback now pruning, no write
-- path in the repository produces one -- but that is a statement about the
-- repository rather than a check, and hardening the reader is a different
-- function with a different contract. Recorded, not absorbed.
--
-- ## `field_subunits` keeps a NARROWER check, and here is why
--
-- The sibling branch at :1012-1023 guards `DELETE FROM public.field_subunits`
-- on `practice_slots` alone, and it stays that way. This was checked against
-- `pg_constraint` on a database with every migration applied rather than
-- reasoned about: the cascade closure from `field_subunits` is
--
--     field_subunits -> practice_slots (field_subunit_id, CASCADE)
--                    -> practice_assignments (practice_slot_id, CASCADE)
--                    -> practice_assignments (slot_id, CASCADE)
--
-- -- three edges, two tables, and `practice_assignments` is reachable ONLY
-- through `practice_slots`. There is no `game_slots.field_subunit_id` and no
-- `practice_assignments.field_subunit_id`. So the existing single `EXISTS` is
-- not a narrower guard that happens to work; it is a COMPLETE cut of the
-- closure at its only edge: nothing downstream can be destroyed without a
-- `practice_slot` on the subunit existing, and that blocks.
--
-- `public.field_bookings` is keyed on a FIELD and cannot answer this question
-- without a second parameter and a second meaning, so adopting it here would
-- fork the enumerator rather than share it -- the opposite of the rule. What
-- is adopted instead is the DISCIPLINE: `docs/sql/20260909000000_smoke.sql`
-- section 2 re-derives the subunit closure on every run and fails if a table
-- joins it or if any member gains a path that does not pass through
-- `practice_slots`. The day a `game_slots.field_subunit_id` appears, the
-- argument above stops being true and the harness says so.
--
-- ## What this does NOT do
--
-- Collapsing `field_blackouts` and `field_blackout_windows` is not in scope.
-- Both producers of field-less profiles are now closed -- the IMPORT by
-- 20260908000000, the DELETE by this migration -- but the column is still
-- NULLABLE and may hold legacy rows from before either, and the shipped read
-- path
-- is still a nested PostgREST embed under profiles
-- (`frontend/src/hooks/useFields.js`) that a venue/surface-keyed table cannot
-- serve -- the SECOND blocker 20260906000100's header named, untouched here.
-- Both comments that name the obstacle are rewritten below to say what is left
-- rather than left reading as permission.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. field_availability_profiles.field_id: count what is already orphaned,
--    then constrain so nothing else can be
-- ---------------------------------------------------------------------------
--
-- **Enumerated from the profiles, not from the fields.** The rows at issue are
-- precisely the ones with no field, so deriving them from `fields` -- the side
-- a break empties -- finds none of them. Same reading 20260907000000 used for
-- the dangling `practice_assignments.field_id` values, for the same reason.
DO $$
DECLARE
  v_orphans integer;
  v_windows integer;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM public.field_availability_profiles p
   WHERE p.field_id IS NULL;

  SELECT count(*) INTO v_windows
    FROM public.field_blackout_windows w
    JOIN public.field_availability_profiles p ON p.id = w.profile_id
   WHERE p.field_id IS NULL;

  IF v_orphans > 0 THEN
    -- WARNING, not NOTICE: these are closures nothing can attribute to ground.
    -- They are LEFT, deliberately -- see the header -- and an operator running
    -- this migration should know the number they are left with.
    RAISE WARNING
      'LEAVING % field-less availability profile(s), carrying % blackout window(s), in place: they predate 20260908000000 and deciding their fate belongs to the blackout-collapse task, not to this migration',
      v_orphans, v_windows;
  ELSE
    RAISE NOTICE 'no field-less availability profiles to leave behind';
  END IF;
END $$;

ALTER TABLE public.field_availability_profiles
  DROP CONSTRAINT IF EXISTS field_availability_profiles_field_id_fkey;

ALTER TABLE public.field_availability_profiles
  ADD CONSTRAINT field_availability_profiles_field_id_fkey
  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE CASCADE;

COMMENT ON COLUMN public.field_availability_profiles.field_id IS
  'The pitch this availability record describes. ON DELETE CASCADE as of 20260909000000, matching field_blackouts.field_id: the two carry the same kind of statement about the same ground and disagreed only because one was written by an importer. NULL has NO live producer -- 20260908000000 stopped the import creating one (such a row is refused with reason=field_unresolved) and 20260909000000 stopped a field delete creating one. A NULL here is therefore a LEGACY row from before those two migrations, not a state any current write path can reach. The column stays nullable because those legacy rows may exist; making it NOT NULL means deciding what becomes of them, which belongs to the blackout-collapse task.';

-- ---------------------------------------------------------------------------
-- 2. The producer gains a SIXTH kind
-- ---------------------------------------------------------------------------
--
-- Everything except the new arm is 20260907000000's body verbatim. It is
-- recreated in full rather than patched because a function has no patch, and
-- because the twelve paragraphs of reasoning above each arm are the record of
-- why that arm reads the way it does -- carrying them forward is the point.
--
-- **The new arm needed no new parameter.** `field_availability_profiles`
-- carries `available_from` / `available_until`, both NOT NULL, so it is dated
-- exactly the way `practice_slots.valid_until` is and `p_after` judges it with
-- the same comparison. That is the test 20260907000000's header sets for
-- whether a kind belongs in this producer at all: what differs between the two
-- callers is the DATE and nothing else.
--
--   * for a DELETION (`p_after IS NULL`) every profile on the ground is taken;
--   * for a RETIREMENT it is stranded only if it claims availability AFTER the
--     last usable day, which is the same inclusive boundary every other arm
--     reads.
--
-- `cascades` is `true` and that is now a fact about the graph rather than a
-- hopeful literal: section 1 above made the FK CASCADE, and
-- `docs/sql/20260907000000_smoke.sql` section 5 reads every arm's disposition
-- back out of `pg_constraint`, so writing `true` here while the FK said SET
-- NULL would fail the harness.
--
-- `undated` and `unbounded` are both `false` and cannot be otherwise: both
-- date columns are NOT NULL, which is asserted in the smoke rather than
-- assumed here.
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

-- Re-asserted, not inherited: `CREATE OR REPLACE` keeps the existing ACL, but
-- a future `DROP`/`CREATE` of this function would pick the default privilege
-- 20260614000000 grants to `authenticated` back up. Section 5c of
-- 20260907000000's smoke fails if any role reappears on either ACL; these
-- statements are what keeps it green after this file runs.
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM service_role;

COMMENT ON FUNCTION public.field_bookings(uuid, uuid, date) IS
  'THE single reading of "what is booked on this ground", shared by admin_retire_field, admin_delete_field and rollback_field_import_job. SIX kinds as of 20260909000000, derived from the cascade closure from fields rather than from the field_id column name. p_after NULL means no date applies (a deletion takes everything); a date means "booked after this" (a retirement), inclusive on the last usable day. cascades says a CASCADE edge reaches the row, which is what decides a deletion disposition. Internal: EXECUTE revoked from PUBLIC, anon, authenticated and service_role, so only the owner may call it and all three callers reach it as SECURITY DEFINER. The revokes are explicit because 20260614000000 grants EXECUTE to authenticated by default privilege, which a revoke from PUBLIC does not remove.';

-- ---------------------------------------------------------------------------
-- 2c. admin_delete_field, recreated for two lines
-- ---------------------------------------------------------------------------
--
-- 20260907000000's body verbatim with the capture and the prune added around
-- its DELETE, and `deleted_availability_scenarios` in the returned payload and
-- the `after` audit row. Nothing else changes -- the guard, the refusal shape,
-- the `FOR UPDATE` trio and every audit phase are carried across, and that
-- migration's smoke still asserts all of it against whatever version is
-- installed.
--
-- It is recreated rather than left alone because THIS migration gave it the
-- consequence: before section 1 the profile was merely unlinked, so no
-- scenario could be emptied by a field delete. A fix for a consequence this
-- migration introduces belongs in this migration.

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
    v_scenario_ids uuid[];
    v_deleted_scenarios integer := 0;
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

    -- **Read BEFORE the delete.** 20260909000000 made the profile FK CASCADE,
    -- so the membership rows that answer "which scenarios did this field's
    -- profiles belong to" are gone by the time the DELETE returns.
    v_scenario_ids := public.field_availability_scenario_ids_on_field(
                        p_organization_id, p_field_id);

    DELETE FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id;

    -- ... and pruned after, on the contract
    -- `rollback_field_availability_import_job` already uses
    -- (20260522153000:214-226): narrow, so a scenario created empty by some
    -- other path is untouched. Without this a field delete could leave an
    -- active scenario holding nothing --
    -- `admin_select_field_availability_scenario` checks org, season and group
    -- and nothing about membership.
    v_deleted_scenarios := public.prune_empty_field_availability_scenarios(
                             p_organization_id, v_scenario_ids);

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
            'deleted_availability_scenarios', v_deleted_scenarios,
            'deleted', true,
            'previous', to_jsonb(v_existing)
        )
    );

    RETURN jsonb_build_object(
        'id', v_existing.id,
        'organization_id', v_existing.organization_id,
        'deleted', true,
        'affected_count', v_affected_count,
        'deleted_availability_scenarios', v_deleted_scenarios,
        'affected', v_affected
    );
END;
$$;

-- The RPC's own comment enumerated five kinds. A list of what a destructive
-- operation takes, one short, is the shape this phase keeps finding.
COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) IS
  'Admin-only org-scoped field deletion. Refuses with everything the delete would take -- game_slots, games, game_assignments, practice_slots, practice_assignments and (as of 20260909000000) field_availability_profiles -- unless p_confirm is true, mirroring admin_retire_field. Each affected row carries a disposition: deleted (a CASCADE reaches it) or unassigned (only its field_id is SET NULL); assignments report this per row, because a slot-linked assignment is destroyed while a free-standing one survives. An availability_profile reports deleted, and its formats, scenario memberships, blackout windows and equipment requirements go with it. Returns {deleted:false, reason:''bookings_exist'', affected_count, affected} on refusal rather than raising, and audits refused/before/after.';

-- ---------------------------------------------------------------------------
-- 2b. The scenario prune, as TWO helpers rather than two copies
-- ---------------------------------------------------------------------------
--
-- Both field deleters need the same two steps around their DELETE: read which
-- scenarios the field's profiles belong to BEFORE the rows are gone, and drop
-- the ones left with no members AFTER. A copy in each is what this migration
-- exists to stop, so the reading lives here once and both call it.
--
-- The contract is `rollback_field_availability_import_job`'s
-- (20260522153000:214-226): NARROW. Only scenarios the deleted profiles
-- belonged to are considered, and only those with no remaining members are
-- removed. An org-wide sweep would also take a scenario created empty by some
-- other path, which is a decision nobody has made.
--
-- SECURITY INVOKER and no grants: both callers are SECURITY DEFINER, so these
-- run as the definer through them, and nothing outside them may call them.
CREATE OR REPLACE FUNCTION public.field_availability_scenario_ids_on_field(
    p_organization_id uuid,
    p_field_id uuid
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT COALESCE(array_agg(DISTINCT m.scenario_id), ARRAY[]::uuid[])
      FROM public.field_availability_scenario_members m
      JOIN public.field_availability_profiles p ON p.id = m.profile_id
     WHERE p.organization_id = p_organization_id
       AND p.field_id = p_field_id;
$$;

REVOKE ALL ON FUNCTION public.field_availability_scenario_ids_on_field(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.field_availability_scenario_ids_on_field(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.field_availability_scenario_ids_on_field(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.field_availability_scenario_ids_on_field(uuid, uuid) FROM service_role;

COMMENT ON FUNCTION public.field_availability_scenario_ids_on_field(uuid, uuid) IS
  'The availability scenarios that any profile on this field belongs to, read BEFORE the field is deleted because the cascade removes the membership rows that answer the question. Paired with prune_empty_field_availability_scenarios, which is called after. Internal: EXECUTE revoked from every role, and both callers are SECURITY DEFINER.';

CREATE OR REPLACE FUNCTION public.prune_empty_field_availability_scenarios(
    p_organization_id uuid,
    p_scenario_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_removed integer;
BEGIN
    IF p_scenario_ids IS NULL OR array_length(p_scenario_ids, 1) IS NULL THEN
        RETURN 0;
    END IF;

    DELETE FROM public.field_availability_scenarios s
     WHERE s.organization_id = p_organization_id
       AND s.id = ANY(p_scenario_ids)
       AND NOT EXISTS (
         SELECT 1 FROM public.field_availability_scenario_members m
          WHERE m.scenario_id = s.id
       );
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_empty_field_availability_scenarios(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_empty_field_availability_scenarios(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.prune_empty_field_availability_scenarios(uuid, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.prune_empty_field_availability_scenarios(uuid, uuid[]) FROM service_role;

COMMENT ON FUNCTION public.prune_empty_field_availability_scenarios(uuid, uuid[]) IS
  'Removes the named scenarios that have no members left, org-scoped. The contract is rollback_field_availability_import_job''s (20260522153000): narrow, so only scenarios the deleted profiles belonged to are considered and a scenario created empty by some other path is untouched. Internal: EXECUTE revoked from every role, and both callers are SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- 3. rollback_field_import_job, on the same producer
-- ---------------------------------------------------------------------------
--
-- Recreated from 20260503070000:904. Four changes and nothing else:
--
--   1. the `fields` branch calls `public.field_bookings` instead of its own
--      two-table union;
--   2. a blocked record says which record, why, and how many bookings held it,
--      instead of incrementing a bare counter;
--   3. both `target_table` switches RAISE on a value they do not handle
--      instead of stamping the ledger as though they had done the work;
--   4. the CALLER gets every refusal and the audit row gets a bounded digest
--      of them.
--
-- The `field_subunits` and `locations` branches keep their own single-table
-- checks, and both are arguments about the referential graph rather than
-- about the code: each refuses on the one table through which everything else
-- in its closure must pass. Both are argued where the arm lives and re-derived
-- by sections 2 and 2b of the smoke, because the `locations` argument went
-- stale once already -- 20260906000100 gave that table a second referent and
-- nothing noticed.
CREATE OR REPLACE FUNCTION public.rollback_field_import_job(p_import_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_record public.import_application_records%ROWTYPE;
    v_previous jsonb;
    v_now timestamptz := timezone('utc', now());
    v_pending_record_count integer := 0;
    v_deleted_locations integer := 0;
    v_deleted_fields integer := 0;
    v_deleted_subunits integer := 0;
    v_deleted_practice_slots integer := 0;
    v_deleted_game_slots integer := 0;
    v_restored_records integer := 0;
    v_blocked_records integer := 0;
    v_blocked jsonb := '[]'::jsonb;
    v_affected_count integer;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*)
    INTO v_pending_record_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND organization_id = v_job.organization_id
      AND import_type = 'fields'
      AND rolled_back_at IS NULL;

    IF v_pending_record_count = 0 THEN
        RAISE EXCEPTION 'Import job % has no field application records to roll back', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    FOR v_record IN
        SELECT *
        FROM public.import_application_records
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'fields'
          AND rolled_back_at IS NULL
        ORDER BY
          CASE target_table
            WHEN 'game_slots' THEN 1
            WHEN 'practice_slots' THEN 2
            WHEN 'field_subunits' THEN 3
            WHEN 'fields' THEN 4
            WHEN 'locations' THEN 5
            ELSE 99
          END,
          applied_at DESC,
          id DESC
    LOOP
        IF v_record.operation = 'inserted' THEN
            IF v_record.target_table = 'game_slots' THEN
                -- **`ga.slot_id` was missing, and its twin one arm down had
                -- it.** `game_assignments` reaches a game slot through TWO
                -- CASCADE columns -- `game_slot_id` and `slot_id`
                -- (20260503030000:39-56) -- and `persist_game_schedule` writes
                -- both, but nothing requires a row to carry both, and this arm
                -- consulted only the first. The `practice_slots` arm below has
                -- always read `slot_id OR practice_slot_id`. Adopting the
                -- sibling's contract rather than inventing a third one is the
                -- rule that produced this migration; the asymmetry was found by
                -- walking the closure from `game_slots`, not by reading the arm.
                IF EXISTS (
                    SELECT 1 FROM public.games g
                    WHERE g.organization_id = v_job.organization_id
                      AND g.game_slot_id = v_record.target_id
                ) OR EXISTS (
                    SELECT 1 FROM public.game_assignments ga
                    WHERE ga.organization_id = v_job.organization_id
                      AND (
                        ga.game_slot_id = v_record.target_id
                        OR ga.slot_id = v_record.target_id
                      )
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'game_slot_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.game_slots gs
                WHERE gs.id = v_record.target_id
                  AND gs.organization_id = v_job.organization_id;
                v_deleted_game_slots := v_deleted_game_slots + 1;
            ELSIF v_record.target_table = 'practice_slots' THEN
                IF EXISTS (
                    SELECT 1 FROM public.practice_assignments pa
                    WHERE pa.organization_id = v_job.organization_id
                      AND (
                        pa.slot_id = v_record.target_id
                        OR pa.practice_slot_id = v_record.target_id
                      )
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'practice_slot_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.practice_slots ps
                WHERE ps.id = v_record.target_id
                  AND ps.organization_id = v_job.organization_id;
                v_deleted_practice_slots := v_deleted_practice_slots + 1;
            ELSIF v_record.target_table = 'field_subunits' THEN
                -- **A COMPLETE cut, not a narrower guard.** The cascade closure
                -- from `field_subunits` is `practice_slots` and, through it
                -- only, `practice_assignments`; there is no
                -- `game_slots.field_subunit_id` and no
                -- `practice_assignments.field_subunit_id`. So nothing
                -- downstream can be destroyed without a practice slot on this
                -- subunit existing, and that is what this refuses on.
                -- `docs/sql/20260909000000_smoke.sql` section 2 re-derives the
                -- closure every run, so the day a second edge appears this
                -- argument fails loudly instead of going quietly stale.
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps
                    WHERE ps.organization_id = v_job.organization_id
                      AND ps.field_subunit_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'subunit_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.field_subunits fs
                WHERE fs.id = v_record.target_id
                  AND fs.organization_id = v_job.organization_id;
                v_deleted_subunits := v_deleted_subunits + 1;
            ELSIF v_record.target_table = 'fields' THEN
                -- **LIVE-3.** This read `EXISTS practice_slots OR EXISTS
                -- game_slots` and nothing else -- two of the six kinds a field
                -- delete reaches. `public.field_bookings` is the shared
                -- reading, already used by `admin_retire_field` and
                -- `admin_delete_field`; a third hand-written list here is what
                -- guarantees the next correction lands on two of three.
                --
                -- `p_after => NULL` because a rollback removes the ground
                -- outright, exactly as a deletion does: no date applies and
                -- everything on it counts, dated or not.
                --
                -- **Locked before it is counted, in the sibling's form and the
                -- sibling's order.** Without this a booking inserted between
                -- the count and the DELETE below is destroyed by the cascade
                -- having been counted as nothing -- and section 1 of this
                -- migration made that worse, because an availability profile
                -- inserted in the window is now CASCADED rather than unlinked.
                -- `FOR UPDATE` on the field blocks a concurrent INSERT into
                -- anything with a foreign key to it; locking the field's SLOTS
                -- as well is what covers `games` and an assignment carrying
                -- only a slot id, neither of which references the field.
                -- Field first, then its slots, which is the order
                -- `admin_delete_field` takes, so the two cannot deadlock
                -- against each other. The header says why the OTHER arms are
                -- left unlocked and section 1b of the smoke holds them to it.
                PERFORM 1 FROM public.fields f
                 WHERE f.id = v_record.target_id
                   AND f.organization_id = v_job.organization_id
                 FOR UPDATE;
                PERFORM 1 FROM public.game_slots gs
                 WHERE gs.organization_id = v_job.organization_id
                   AND gs.field_id = v_record.target_id
                 FOR UPDATE;
                PERFORM 1 FROM public.practice_slots ps
                 WHERE ps.organization_id = v_job.organization_id
                   AND ps.field_id = v_record.target_id
                 FOR UPDATE;

                SELECT count(*) INTO v_affected_count
                  FROM public.field_bookings(
                         v_job.organization_id, v_record.target_id, NULL);

                IF v_affected_count > 0 THEN
                    v_blocked_records := v_blocked_records + 1;
                    -- **The reason and the count, not just the count.** An
                    -- operator told "3 blocked" cannot act; told which record
                    -- and what holds it, they can. The record keeps
                    -- `rolled_back_at IS NULL`, so clearing the booking and
                    -- re-running rolls it back -- refusal means deferral here
                    -- for the same reason it does in
                    -- finalize_field_availability_import_job.
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'bookings_exist',
                        'affected_count', v_affected_count);
                    CONTINUE;
                END IF;

                -- **No scenario prune here, and that is a consequence
                -- rather than an omission.** `admin_delete_field` needs one
                -- because `p_confirm => true` lets it delete a field that
                -- still carries an availability profile. This arm has no
                -- override: it reaches the DELETE only when the producer
                -- returned NOTHING, and `availability_profile` is one of the
                -- six kinds the producer returns, so a profile on this ground
                -- is unreachable at this line and a prune here would be dead
                -- code presented as a guard. Section 4 of the smoke derives
                -- that distinction from the bodies rather than keeping a list
                -- of which deleter needs one.
                DELETE FROM public.fields f
                WHERE f.id = v_record.target_id
                  AND f.organization_id = v_job.organization_id;
                v_deleted_fields := v_deleted_fields + 1;
            ELSIF v_record.target_table = 'locations' THEN
                -- **A complete cut, like the subunit arm, and for the same
                -- kind of reason.** `locations` is referenced directly by
                -- exactly two tables: `fields` (CASCADE), which this refuses
                -- on, and `field_blackouts` (CASCADE, added by
                -- 20260906000100). Everything else a location delete could
                -- reach is under `fields`, so refusing while any field remains
                -- cuts the whole closure at its only other edge.
                --
                -- `field_blackouts` is EXCLUDED, on 20260907000000's reasoning
                -- for excluding it from the booking family: a closure is not a
                -- booking, and removing a site cannot strand the statement that
                -- the site was already shut. Stated here rather than left
                -- implicit, and re-derived every harness run by
                -- docs/sql/20260909000000_smoke.sql section 2b -- that edge did
                -- not exist when this arm was written and nothing noticed when
                -- 20260906000100 added it.
                IF EXISTS (
                    SELECT 1 FROM public.fields f
                    WHERE f.organization_id = v_job.organization_id
                      AND f.location_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'location_has_fields');
                    CONTINUE;
                END IF;

                DELETE FROM public.locations l
                WHERE l.id = v_record.target_id
                  AND l.organization_id = v_job.organization_id;
                v_deleted_locations := v_deleted_locations + 1;
            ELSE
                -- **The arm that used to be missing.** With no ELSE, a record
                -- naming any of the other seven `target_table` values
                -- 20260522120000 admits fell straight through to the ledger
                -- UPDATE below and was stamped `{"deleted": true}` having
                -- deleted nothing -- a lie in the only record of what a
                -- rollback did. DEFENSIVE rather than reachable through the
                -- apply path, which only ever writes the five with
                -- `import_type = 'fields'`: arriving here means the ledger
                -- disagrees with its own import type, and a job whose record
                -- of what it did cannot be trusted must not be half rolled
                -- back on the strength of it. The `ELSE 99` in this
                -- statement's own ORDER BY already conceded the value can
                -- arrive.
                RAISE EXCEPTION
                  'rollback_field_import_job cannot undo an insert into %; the field import applies only locations, fields, field_subunits, practice_slots and game_slots (record %)',
                  v_record.target_table, v_record.id
                  USING ERRCODE = '22023';
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = jsonb_build_object('deleted', true)
            WHERE id = v_record.id;
        ELSIF v_record.operation = 'updated' THEN
            v_previous := v_record.previous_payload;

            IF v_record.target_table = 'locations' THEN
                UPDATE public.locations
                SET
                    name = v_previous->>'name',
                    address = v_previous->>'address',
                    lighting_available = COALESCE((v_previous->>'lighting_available')::boolean, false),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'fields' THEN
                UPDATE public.fields
                SET
                    location_id = (v_previous->>'location_id')::uuid,
                    name = v_previous->>'name',
                    surface_type = v_previous->>'surface_type',
                    size = v_previous->>'size',
                    supports_halves = COALESCE((v_previous->>'supports_halves')::boolean, false),
                    max_age = v_previous->>'max_age',
                    priority_rating = COALESCE((v_previous->>'priority_rating')::integer, 1),
                    active = COALESCE((v_previous->>'active')::boolean, true),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'practice_slots' THEN
                UPDATE public.practice_slots
                SET
                    field_id = (v_previous->>'field_id')::uuid,
                    field_subunit_id = NULLIF(v_previous->>'field_subunit_id', '')::uuid,
                    day_of_week = (v_previous->>'day_of_week')::public.day_of_week,
                    start_time = (v_previous->>'start_time')::time,
                    end_time = (v_previous->>'end_time')::time,
                    capacity = COALESCE((v_previous->>'capacity')::smallint, 1),
                    valid_from = NULLIF(v_previous->>'valid_from', '')::date,
                    valid_until = NULLIF(v_previous->>'valid_until', '')::date,
                    label = v_previous->>'label',
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'game_slots' THEN
                UPDATE public.game_slots
                SET
                    field_id = (v_previous->>'field_id')::uuid,
                    division_id = NULLIF(v_previous->>'division_id', '')::uuid,
                    slot_date = NULLIF(v_previous->>'slot_date', '')::date,
                    start_time = NULLIF(v_previous->>'start_time', '')::time,
                    end_time = NULLIF(v_previous->>'end_time', '')::time,
                    week_index = NULLIF(v_previous->>'week_index', '')::smallint,
                    capacity = COALESCE((v_previous->>'capacity')::smallint, 1),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSE
                -- **The same missing arm, one branch down, and worse.** An
                -- unhandled `updated` record was stamped with its previous
                -- payload AND counted in `restored_records` -- a counter
                -- testifying to a restore that never happened, which is the
                -- shape 8.4 PR 2 recorded when `lifecycleNodesJudged` reported
                -- work it had not done. `field_subunits` is genuinely absent
                -- from this list because the apply path never UPDATES one: it
                -- inserts subunits or leaves them, so there is nothing to
                -- restore. That is why the union here is four and the union
                -- above is five.
                RAISE EXCEPTION
                  'rollback_field_import_job cannot restore an update to %; the field import updates only locations, fields, practice_slots and game_slots (record %)',
                  v_record.target_table, v_record.id
                  USING ERRCODE = '22023';
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = v_previous
            WHERE id = v_record.id;

            v_restored_records := v_restored_records + 1;
        END IF;
    END LOOP;

    -- **The trail gets a BOUNDED rendering; the caller gets the whole list.**
    -- One job's ledger can hold a row per CSV line, so a rollback refused on a
    -- busy season would otherwise write an arbitrarily large `blocked` array
    -- into `import_jobs.warning_summary` AND into the audit row, on every
    -- attempt. `public.field_bookings_digest` is the helper 20260907000000
    -- built for exactly this on the refusal path, and its shape is why the
    -- entries above are keyed `kind`/`id` rather than
    -- `target_table`/`target_id`: it counts `by_kind`, so adopting the
    -- sibling's key names makes the per-table refusal counts fall out instead
    -- of needing a third convention.
    v_result := jsonb_build_object(
        'status', CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'rolled_back' END,
        'deleted_locations', v_deleted_locations,
        'deleted_fields', v_deleted_fields,
        'deleted_field_subunits', v_deleted_subunits,
        'deleted_practice_slots', v_deleted_practice_slots,
        'deleted_game_slots', v_deleted_game_slots,
        'restored_records', v_restored_records,
        'blocked_records', v_blocked_records,
        'blocked', public.field_bookings_digest(v_blocked)
    );

    UPDATE public.import_jobs
    SET
        status = CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'needs_fix' END,
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{field_rollback}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.rolled_back',
        'import_job',
        p_import_job_id,
        v_result
    );

    -- The caller renders every refusal, so it gets all of them.
    RETURN v_result || jsonb_build_object('blocked', v_blocked);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rollback_field_import_job(uuid) TO authenticated;

COMMENT ON FUNCTION public.rollback_field_import_job(uuid) IS
  'Admin-only rollback for a field-slot CSV apply. Deletes inserted slots, subunits, fields and empty locations, and restores updated rows from the ledger snapshot. As of 20260909000000 a field is refused unless public.field_bookings reports nothing on it -- the same reading admin_delete_field and admin_retire_field use, rather than this function''s former two-table union. A refused record is reported in `blocked` with its table, its id, a reason and, for a field, the booking count, and keeps rolled_back_at NULL so clearing the booking and re-running rolls it back. A target_table neither switch handles raises 22023 rather than stamping the ledger as rolled back.';

-- ---------------------------------------------------------------------------
-- 4. The two comments that name the obstacle to collapsing the blackout tables
-- ---------------------------------------------------------------------------
--
-- 20260908000000 rewrote both to say the import half was closed and the DELETE
-- half was not. This migration closes the delete half, so both would now read
-- as "the obstacle is gone" -- and the obstacle is not gone. What is left is
-- different in kind from what was there, which is exactly why leaving the old
-- wording would be worse than never having written it: the first place anyone
-- looks before touching a frozen table would be naming a condition that is now
-- satisfied.
--
-- LIVE-2's round 1 found this PR's ancestor committing this defect on one of
-- the two comments and not the other. Both are rewritten here, and
-- `docs/sql/20260909000000_smoke.sql` section 6 asserts that NEITHER of them
-- still names a closed producer as blocking.
COMMENT ON VIEW public.field_closures IS
  'THE reader for "is this ground closed on this date". Unions admin-authored field_blackouts with import-derived field_blackout_windows so the question has one answer. SCOPE is closes_location_id / closes_field_id -- what this row shuts. field_location_id is a different fact (the site the closed field sits on) and is never a scope; the two were one column in the first draft and a location filter therefore closed every other pitch on the site. closes_field_id is NULL for legacy import rows whose profile has no field -- surfaced, not filtered, because a closure nobody can attribute is what an inner join would hide. reason is NULL on the import arm because the import carries no structured reason, and its own words travel in source_reason_text rather than in note -- note is admin free text on both arms, so a privacy guard or an enum filter cannot silently mean two things. COLLAPSING THE UNION IS STILL BLOCKED, and the reason has CHANGED as of 20260909000000: both producers of field-less profiles are now closed (20260908000000 refuses an unresolvable import row; 20260909000000 makes field_availability_profiles.field_id ON DELETE CASCADE and reports the profile as a booking), so what remains is (1) the column is still NULLABLE and legacy rows from before those two migrations may hold NULL, and (2) the shipped read path is a nested PostgREST embed under profiles (frontend/src/hooks/useFields.js), which a venue/surface-keyed table cannot serve -- the second blocker 20260906000100 named, untouched. Neither is a producer; both are migrations of their own.';

-- `20260906000100`'s smoke asserts this comment begins 'FROZEN as of
-- 20260906000100' with a PREFIX match, which is why the rewrite keeps the
-- opening sentence verbatim. A prefix match is also how LIVE-2's round 1 found
-- this comment could go stale without any check noticing.
COMMENT ON TABLE public.field_blackout_windows IS
  'FROZEN as of 20260906000100. Owned solely by finalize_field_availability_import_job; no new code may write it. New blackouts go to public.field_blackouts. Read both through public.field_closures. COLLAPSING THE UNION IS STILL BLOCKED as of 20260909000000, but no longer because anything is still CREATING field-less profiles: the import half was closed by 20260908000000 (an unresolvable row is refused with reason=field_unresolved) and the delete half by 20260909000000 (field_availability_profiles.field_id is ON DELETE CASCADE and a profile is reported as a booking, so a field delete destroys the profile instead of stranding it). What still blocks the collapse is (1) legacy rows predating those two migrations, which may carry field_id NULL, so the column cannot yet be made NOT NULL, and (2) the nested PostgREST embed in frontend/src/hooks/useFields.js, which reads windows UNDER their profile and cannot be served by a venue/surface-keyed table. tests/fieldBlackoutFreeze.test.js holds the writer set to the import path by scanning the source tree.';

COMMIT;
