-- Revert for 20261102010000_facility_permits.sql
--
-- Drops the bucket's policies, the two permit tables with their policies, the five permit RPCs and
-- every helper, and restores `admin_delete_field(uuid, uuid, boolean)` to its 20260909000000 body
-- (checked by md5 at the end). The `facility-permits` bucket row is dropped only while it holds no
-- object: Supabase's storage.protect_delete() refuses SQL deletes of objects, so a bucket that
-- still holds files is left in place (with no policy, only the service role reaches it) and the
-- NOTICE says how many objects stay. Remove them through the Storage API first to drop the bucket.
-- The audit rows the permit RPCs wrote stay: an audit row's history is not this revert's to erase.
--
-- **What it destroys.** Every permit, its scopes and its record of a file (the NOTICE counts the
-- permits, the ones with a file, and the scopes). The files themselves are not touched here.

BEGIN;

DO $revert$
DECLARE
    v_permits bigint;
    v_files bigint;
    v_scopes bigint;
BEGIN
    SELECT count(*), count(file_path) INTO v_permits, v_files FROM public.facility_permits;
    SELECT count(*) INTO v_scopes FROM public.facility_permit_scopes;
    RAISE NOTICE 'this revert DESTROYS % permit(s), % of them with a file, and % scope(s)', v_permits, v_files, v_scopes;
END;
$revert$;

-- ---------------------------------------------------------------------------
-- 1. The bucket's policies, and the bucket when it is empty.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "facility-permits select" ON storage.objects;
DROP POLICY IF EXISTS "facility-permits org-admin insert" ON storage.objects;
DROP POLICY IF EXISTS "facility-permits org-admin delete" ON storage.objects;

DO $bucket$
DECLARE
    v_objects bigint;
BEGIN
    SELECT count(*) INTO v_objects FROM storage.objects WHERE bucket_id = 'facility-permits';
    IF v_objects = 0 THEN
        DELETE FROM storage.buckets WHERE id = 'facility-permits';
        RAISE NOTICE 'the facility-permits bucket was empty and is dropped';
    ELSE
        RAISE NOTICE 'the facility-permits bucket still holds % object(s) and is LEFT IN PLACE, with no policy', v_objects;
    END IF;
END;
$bucket$;

-- ---------------------------------------------------------------------------
-- 2. The tables (their policies go with them), then the functions the policies named.
-- ---------------------------------------------------------------------------

DROP TABLE public.facility_permit_scopes;
DROP TABLE public.facility_permits;

DROP FUNCTION public.admin_create_facility_permit(uuid, text, text, date, date, text, uuid[], uuid[]);
DROP FUNCTION public.admin_update_facility_permit(uuid, uuid, text, text, date, date, text, uuid[], uuid[]);
DROP FUNCTION public.admin_set_facility_permit_file(uuid, uuid, text, text);
DROP FUNCTION public.admin_delete_facility_permit(uuid, uuid);
DROP FUNCTION public.get_facility_permits(uuid);
DROP FUNCTION public.facility_permit_check(text, text, text, date, date, uuid[], uuid[], uuid);
DROP FUNCTION public.facility_permit_json(uuid, date, boolean);
DROP FUNCTION public.coach_reads_facility_permit_file(uuid, text);
DROP FUNCTION public.coach_reads_facility_permit(uuid);
DROP FUNCTION public.coach_covers_permit_scope(uuid, uuid, uuid);
DROP FUNCTION public.coach_field_ids_of(uuid, uuid);
DROP FUNCTION public.org_local_today(uuid);
DROP FUNCTION public.facility_permit_status(date, date, date);

-- ---------------------------------------------------------------------------
-- 3. admin_delete_field, as 20260909000000 left it.
-- ---------------------------------------------------------------------------

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

COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) IS
  'Admin-only org-scoped field deletion. Refuses with everything the delete would take -- game_slots, games, game_assignments, practice_slots, practice_assignments and (as of 20260909000000) field_availability_profiles -- unless p_confirm is true, mirroring admin_retire_field. Each affected row carries a disposition: deleted (a CASCADE reaches it) or unassigned (only its field_id is SET NULL); assignments report this per row, because a slot-linked assignment is destroyed while a free-standing one survives. An availability_profile reports deleted, and its formats, scenario memberships, blackout windows and equipment requirements go with it. Returns {deleted:false, reason:''bookings_exist'', affected_count, affected} on refusal rather than raising, and audits refused/before/after.';

DO $check$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.admin_delete_field(uuid, uuid, boolean)');
    IF v_md5 IS DISTINCT FROM '51c2d435c860594feba15f00d18c708a' THEN
        RAISE EXCEPTION 'admin_delete_field is not its 20260909000000 body after the revert (md5 %)', v_md5;
    END IF;
    IF to_regclass('public.facility_permits') IS NOT NULL OR to_regclass('public.facility_permit_scopes') IS NOT NULL THEN
        RAISE EXCEPTION 'a permit table survived the revert';
    END IF;
END;
$check$;

COMMIT;
