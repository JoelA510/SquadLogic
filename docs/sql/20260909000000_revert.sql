-- Revert for 20260909000000_rollback_field_import_booking_guard.sql
--
-- Restores FOUR things, and every one of them is a behaviour change rather
-- than a cosmetic one. LIVE-2's round 1 found a revert naming one cost of
-- three; the warnings below name all four, and the two that can be counted
-- are counted against what the database actually holds rather than asserted
-- against an empty table.
--
--   1. `field_availability_profiles.field_id` goes back to ON DELETE SET
--      NULL, so a confirmed `admin_delete_field` again leaves the profile
--      behind with no field, its blackout windows attached, and
--      `field_closures` reporting a closure with a NULL scope. This is
--      LIVE-2's "visible in the review list and absent from the answer to
--      'is this ground closed'" state, restored.
--   2. `public.field_bookings` goes back to FIVE kinds, so both
--      `admin_delete_field` and `admin_retire_field` stop telling the
--      operator that a profile is affected -- a smaller `affected_count` and
--      a delete that stops refusing over a profile.
--   3. `rollback_field_import_job` goes back to its own two-table guard, so
--      the import rollback again deletes a field that carries a
--      free-standing game or practice assignment, or an availability
--      profile, without refusing -- LIVE-3 itself.
--   4. Two silent switch arms come back: an `import_application_record`
--      naming a `target_table` neither switch handles is again stamped
--      `rolled_back_at` with `{"deleted": true}` (insert) or counted in
--      `restored_records` (update) having done nothing. And `blocked` leaves
--      the result and the audit row, so a refusal is a bare count again.
--
-- **Pre-existing field-less profiles are NOT recreated and NOT repaired.**
-- The forward migration left them; this leaves them too. What changes is that
-- a delete can make more.
--
-- Revert only if 20260909000000 is itself implicated in an incident.
\set ON_ERROR_STOP on

BEGIN;

-- What this is about to expose, counted from the tables themselves.
DO $revert$
DECLARE
  v_attached bigint;
  v_windows bigint;
  v_already bigint;
  v_blocked_jobs bigint;
BEGIN
  -- **Enumerated from the profiles, which is the side that survives.** Every
  -- profile currently ATTACHED to a field is one that a future confirmed
  -- delete will strand once the FK is SET NULL again -- so that, not the
  -- already-orphaned count, is the number this revert exposes. Both are
  -- printed, because they are different facts and a reader during an incident
  -- should not have to infer either.
  SELECT count(*) INTO v_attached
    FROM public.field_availability_profiles WHERE field_id IS NOT NULL;
  SELECT count(*) INTO v_windows
    FROM public.field_blackout_windows w
    JOIN public.field_availability_profiles p ON p.id = w.profile_id
   WHERE p.field_id IS NOT NULL;
  SELECT count(*) INTO v_already
    FROM public.field_availability_profiles WHERE field_id IS NULL;

  RAISE WARNING 'EXPOSING % availability profile(s) currently attached to a field, carrying % blackout window(s): once field_id is ON DELETE SET NULL again, deleting their field strands them instead of destroying them, and % profile(s) in this database are already in that state', v_attached, v_windows, v_already;
  RAISE WARNING 'RESTORING public.field_bookings to five kinds: admin_delete_field and admin_retire_field stop reporting availability profiles, so a field carrying only a profile deletes without refusing and affected_count drops by the number of profiles on the ground';
  RAISE WARNING 'RESTORING rollback_field_import_job to its two-table guard: an import rollback again deletes a field carrying a free-standing game or practice assignment, or an availability profile, without refusing -- which is LIVE-3';

  -- **The fourth cost, and the one a count can reach.** Any job already
  -- rolled back under 20260909000000 carries `blocked` in its warning_summary
  -- and any consumer reading it will find the key gone from every later
  -- rollback. Counted rather than described, for the same reason as the
  -- profiles.
  SELECT count(*) INTO v_blocked_jobs
    FROM public.import_jobs
   WHERE warning_summary -> 'field_rollback' ? 'blocked';
  RAISE WARNING 'ALSO REVERTING two silent switch arms and the blocked list: an import_application_record naming a target_table neither switch handles is again stamped as rolled back having done nothing, and a refusal reports a bare blocked_records count with no table, id or reason -- % existing import job(s) carry a field_rollback.blocked list that nothing will write again', v_blocked_jobs;
END $revert$;

-- ---------------------------------------------------------------------------
-- 1. The foreign key, back to SET NULL
-- ---------------------------------------------------------------------------

ALTER TABLE public.field_availability_profiles
  DROP CONSTRAINT IF EXISTS field_availability_profiles_field_id_fkey;

ALTER TABLE public.field_availability_profiles
  ADD CONSTRAINT field_availability_profiles_field_id_fkey
  FOREIGN KEY (field_id) REFERENCES public.fields (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.field_availability_profiles.field_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. public.field_bookings, back to 20260907000000's five arms
-- ---------------------------------------------------------------------------
--
-- The body below is 20260907000000's verbatim. The revokes are re-issued
-- because `CREATE OR REPLACE` keeps the ACL but section 5c of that
-- migration's smoke checks it, and a revert that left the helper reachable
-- would trade one defect for another.

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
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.field_bookings(uuid, uuid, date) FROM service_role;

COMMENT ON FUNCTION public.field_bookings(uuid, uuid, date) IS
  'THE single reading of "what is booked on this ground", shared by admin_retire_field and admin_delete_field. Five kinds, derived from the cascade closure from fields rather than from the field_id column name. p_after NULL means no date applies (a deletion takes everything); a date means "booked after this" (a retirement). cascades says a CASCADE edge reaches the row, which is what decides a deletion disposition. Internal: EXECUTE revoked from PUBLIC, anon, authenticated and service_role, so only the owner may call it and both callers reach it as SECURITY DEFINER. The revokes are explicit because 20260614000000 grants EXECUTE to authenticated by default privilege, which a revoke from PUBLIC does not remove.';

COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) IS
  'Admin-only org-scoped field deletion. Refuses with everything the delete would take -- game_slots, games, game_assignments, practice_slots, practice_assignments -- unless p_confirm is true, mirroring admin_retire_field. Each affected row carries a disposition: deleted (a CASCADE reaches it) or unassigned (only its field_id is SET NULL); assignments report this per row, because a slot-linked assignment is destroyed while a free-standing one survives. Returns {deleted:false, reason:''bookings_exist'', affected_count, affected} on refusal rather than raising, and audits refused/before/after.';

-- ---------------------------------------------------------------------------
-- 3. rollback_field_import_job, back to 20260503070000's body
-- ---------------------------------------------------------------------------
--
-- Two-table guard, no blocked list, and no ELSE on either switch. Verbatim,
-- which is why warning 4 above exists: restoring a body restores everything
-- that body did not do.

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
                    CONTINUE;
                END IF;

                DELETE FROM public.practice_slots ps
                WHERE ps.id = v_record.target_id
                  AND ps.organization_id = v_job.organization_id;
                v_deleted_practice_slots := v_deleted_practice_slots + 1;
            ELSIF v_record.target_table = 'field_subunits' THEN
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps
                    WHERE ps.organization_id = v_job.organization_id
                      AND ps.field_subunit_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    CONTINUE;
                END IF;

                DELETE FROM public.field_subunits fs
                WHERE fs.id = v_record.target_id
                  AND fs.organization_id = v_job.organization_id;
                v_deleted_subunits := v_deleted_subunits + 1;
            ELSIF v_record.target_table = 'fields' THEN
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps
                    WHERE ps.organization_id = v_job.organization_id
                      AND ps.field_id = v_record.target_id
                ) OR EXISTS (
                    SELECT 1 FROM public.game_slots gs
                    WHERE gs.organization_id = v_job.organization_id
                      AND gs.field_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
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
                    CONTINUE;
                END IF;

                DELETE FROM public.locations l
                WHERE l.id = v_record.target_id
                  AND l.organization_id = v_job.organization_id;
                v_deleted_locations := v_deleted_locations + 1;
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
        'blocked_records', v_blocked_records
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

-- 20260503070000 set no COMMENT on this function; 20260909000000 added one.
COMMENT ON FUNCTION public.rollback_field_import_job(uuid) IS NULL;

-- ---------------------------------------------------------------------------
-- 4. The two collapse-blocker comments, back to 20260908000000's wording
-- ---------------------------------------------------------------------------
--
-- They named the delete path as the remaining producer, which is true again
-- the moment section 1 above runs. Leaving 20260909000000's wording in place
-- would tell the next reader that both producers are closed while the FK says
-- otherwise -- the exact stale-comment defect LIVE-2's round 1 found.

COMMENT ON VIEW public.field_closures IS
  'THE reader for "is this ground closed on this date". Unions admin-authored field_blackouts with import-derived field_blackout_windows so the question has one answer. SCOPE is closes_location_id / closes_field_id -- what this row shuts. field_location_id is a different fact (the site the closed field sits on) and is never a scope; the two were one column in the first draft and a location filter therefore closed every other pitch on the site. closes_field_id is NULL for import rows whose profile has no field -- surfaced, not filtered, because a closure nobody can attribute is what an inner join would hide. reason is NULL on the import arm because the import carries no structured reason, and its own words travel in source_reason_text rather than in note -- note is admin free text on both arms, so a privacy guard or an enum filter cannot silently mean two things. COLLAPSING THE UNION IS STILL BLOCKED, and only half the obstacle is gone: as of 20260908000000 the IMPORT can no longer create a profile with no field (such a row is refused and reported), but fields.id is referenced ON DELETE SET NULL and field_availability_profiles is deliberately excluded from admin_delete_field''s booking guard, so deleting a field still orphans every profile pointing at it. Until that second producer is closed, a profile-scoped blackout still cannot be expressed in a scope-bearing table.';

COMMENT ON TABLE public.field_blackout_windows IS
  'FROZEN as of 20260906000100. Owned solely by finalize_field_availability_import_job; no new code may write it. New blackouts go to public.field_blackouts. Read both through public.field_closures. COLLAPSING THE UNION IS STILL BLOCKED as of 20260908000000, and the condition this comment used to name -- that the import stops attaching blackouts to profiles whose field_id can be NULL -- is now only HALF of it. The import half is closed: a row matching no field is refused and reported. The DELETE half is not: fields.id is referenced ON DELETE SET NULL and field_availability_profiles is excluded from admin_delete_field''s booking guard, so deleting a field still orphans every profile pointing at it, and a profile-scoped blackout still cannot be expressed in a scope-bearing table. tests/fieldBlackoutFreeze.test.js holds the writer set to the import path by scanning the source tree.';

COMMIT;
