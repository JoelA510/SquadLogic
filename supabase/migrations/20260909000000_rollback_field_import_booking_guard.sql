-- LIVE-3: the third path that deletes a field, and the last producer of
-- field-less availability profiles.
--
-- Recorded as LIVE-3 at the foot of the LIVE-1 entry in
-- docs/PHASE_8_PROGRESS.md, carved out of PR #378 rather than absorbed, and
-- restated by LIVE-2 (#381) with a second reason. Its own PR.
--
-- ## Two defects, one mechanism
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
-- (20260522120000:19) and this loop handles five, so the arm is reachable by
-- data rather than only by a future edit -- and `ORDER BY ... ELSE 99` in the
-- same statement already concedes that. Both now RAISE, naming the union they
-- belong to. This is the silent-`default:` class 8.3 recorded three instances
-- of; nothing in the repo checks for it generally, so it is fixed where it is
-- found.
--
-- ### 4. A blocked record now says which record and why
--
-- The function returned `blocked_records` as a bare count. An operator told
-- "3 blocked" cannot act on it. Each refusal now appends
-- `{target_table, target_id, reason, affected_count}` to a `blocked` array in
-- the result and the audit row, in the shape LIVE-2 established for a refused
-- import row: refuse, report with a reason, leave it replayable
-- (`rolled_back_at` stays NULL, so re-running after clearing the booking rolls
-- the record back).
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
-- Both producers of field-less profiles are closed by this migration, but the
-- column is still NULLABLE and may hold legacy rows, and the shipped read path
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

-- The RPC's own comment enumerated five kinds. A list of what a destructive
-- operation takes, one short, is the shape this phase keeps finding.
COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) IS
  'Admin-only org-scoped field deletion. Refuses with everything the delete would take -- game_slots, games, game_assignments, practice_slots, practice_assignments and (as of 20260909000000) field_availability_profiles -- unless p_confirm is true, mirroring admin_retire_field. Each affected row carries a disposition: deleted (a CASCADE reaches it) or unassigned (only its field_id is SET NULL); assignments report this per row, because a slot-linked assignment is destroyed while a free-standing one survives. An availability_profile reports deleted, and its formats, scenario memberships, blackout windows and equipment requirements go with it. Returns {deleted:false, reason:''bookings_exist'', affected_count, affected} on refusal rather than raising, and audits refused/before/after.';

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
--   4. the blocked list travels in the result and the audit row.
--
-- The `field_subunits` and `locations` branches keep their own single-table
-- checks. `locations` is not a field and has no booking notion: the only thing
-- that can hold a location is a field on it, which is what it checks.
-- `field_subunits` is argued in the header and re-derived by the smoke.
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
                IF EXISTS (
                    SELECT 1 FROM public.games g
                    WHERE g.organization_id = v_job.organization_id
                      AND g.game_slot_id = v_record.target_id
                ) OR EXISTS (
                    SELECT 1 FROM public.game_assignments ga
                    WHERE ga.organization_id = v_job.organization_id
                      AND ga.game_slot_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'target_table', v_record.target_table,
                        'target_id', v_record.target_id,
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
                        'target_table', v_record.target_table,
                        'target_id', v_record.target_id,
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
                        'target_table', v_record.target_table,
                        'target_id', v_record.target_id,
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
                        'target_table', v_record.target_table,
                        'target_id', v_record.target_id,
                        'reason', 'bookings_exist',
                        'affected_count', v_affected_count);
                    CONTINUE;
                END IF;

                DELETE FROM public.fields f
                WHERE f.id = v_record.target_id
                  AND f.organization_id = v_job.organization_id;
                v_deleted_fields := v_deleted_fields + 1;
            ELSIF v_record.target_table = 'locations' THEN
                IF EXISTS (
                    SELECT 1 FROM public.fields f
                    WHERE f.organization_id = v_job.organization_id
                      AND f.location_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'target_table', v_record.target_table,
                        'target_id', v_record.target_id,
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
                -- rollback did. The `ELSE 99` in this statement's own ORDER BY
                -- already conceded the value is reachable.
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

    v_result := jsonb_build_object(
        'status', CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'rolled_back' END,
        'deleted_locations', v_deleted_locations,
        'deleted_fields', v_deleted_fields,
        'deleted_field_subunits', v_deleted_subunits,
        'deleted_practice_slots', v_deleted_practice_slots,
        'deleted_game_slots', v_deleted_game_slots,
        'restored_records', v_restored_records,
        'blocked_records', v_blocked_records,
        'blocked', v_blocked
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

    RETURN v_result;
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
