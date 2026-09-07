-- Emergency rollback for 20260504060000_admin_facility_mutation_rpcs.sql.
--
-- Pair with an app rollback if the frontend still calls the admin facility
-- RPCs. This restores the previous broad org-member facility write policies.
--
-- **A `DROP FUNCTION IF EXISTS` names a SIGNATURE, and a signature can move.**
-- 20260907000000 replaced `admin_delete_field(uuid, uuid)` with
-- `(uuid, uuid, boolean)` and dropped the two-argument form, so the line below
-- became a silent no-op: run against a current database, this script left the
-- guarded delete standing, COMMITTED, and reported success. That is the file
-- someone runs at 2am with production broken, and it was lying to them.
--
-- Both signatures are now dropped, so the script works whichever side of
-- 20260907000000 the database is on, and the block at the end refuses to
-- commit a rollback that removed nothing -- the next signature to move fails
-- loudly here instead of being reported as done.
--
-- `public.field_bookings` and `public.field_bookings_digest` are deliberately
-- LEFT IN PLACE: they arrived with 20260907000000 and `admin_retire_field`
-- (20260906000000, which this script is not about) calls the first of them.
-- Dropping them here would break a function this rollback does not own. Roll
-- 20260907000000 back with `docs/sql/20260907000000_revert.sql`, which does.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_delete_field(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.admin_update_field(uuid, uuid, uuid, text, text, text, boolean, integer, boolean);
DROP FUNCTION IF EXISTS public.admin_create_field(uuid, uuid, text, text, text, boolean, integer, boolean);
DROP FUNCTION IF EXISTS public.admin_create_location(uuid, text, text, boolean);

-- Every overload, by NAME rather than by signature: a rollback that reports
-- success must have removed the thing it names, and only a name survives a
-- signature change.
DO $rollback_check$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(n.nspname || '.' || p.proname || '(' ||
                      pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY p.proname)
      INTO v_left
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('admin_delete_field', 'admin_update_field',
                         'admin_create_field', 'admin_create_location');
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'ROLLBACK INCOMPLETE: these admin facility RPCs survived and this script would have reported success: %', v_left;
    END IF;
    RAISE NOTICE 'all four admin facility RPCs are gone, every overload';
END
$rollback_check$;

DROP POLICY IF EXISTS "Locations: members select" ON public.locations;
DROP POLICY IF EXISTS "Fields: members select" ON public.fields;
DROP POLICY IF EXISTS "Field Subunits: members select" ON public.field_subunits;
DROP POLICY IF EXISTS "Practice Slots: members select" ON public.practice_slots;

DROP POLICY IF EXISTS "Locations: members access" ON public.locations;
CREATE POLICY "Locations: members access"
  ON public.locations FOR SELECT
  TO authenticated
  USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "Strict org access on locations" ON public.locations;
CREATE POLICY "Strict org access on locations"
  ON public.locations FOR ALL
  TO authenticated
  USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "Fields: members access" ON public.fields;
CREATE POLICY "Fields: members access"
  ON public.fields FOR SELECT
  TO authenticated
  USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "Strict org access on fields" ON public.fields;
CREATE POLICY "Strict org access on fields"
  ON public.fields FOR ALL
  TO authenticated
  USING (public.is_org_member((SELECT organization_id FROM public.locations WHERE id = location_id)))
  WITH CHECK (public.is_org_member((SELECT organization_id FROM public.locations WHERE id = location_id)));

DROP POLICY IF EXISTS "Field Subunits: members access" ON public.field_subunits;
CREATE POLICY "Field Subunits: members access"
  ON public.field_subunits FOR SELECT
  TO authenticated
  USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "Unified org access on field_subunits" ON public.field_subunits;
CREATE POLICY "Unified org access on field_subunits"
  ON public.field_subunits FOR ALL
  TO authenticated
  USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "Practice Slots: members access" ON public.practice_slots;
CREATE POLICY "Practice Slots: members access"
  ON public.practice_slots FOR SELECT
  TO authenticated
  USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "Unified org access on practice_slots" ON public.practice_slots;
CREATE POLICY "Unified org access on practice_slots"
  ON public.practice_slots FOR ALL
  TO authenticated
  USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));

COMMIT;
