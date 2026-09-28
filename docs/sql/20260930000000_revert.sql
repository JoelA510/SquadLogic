-- Revert for 20260930000000_location_coordinates.sql
--
-- **This revert DESTROYS every venue's coordinates.** An admin typed each
-- pair and nothing else records them except the audit log, so the figures are
-- printed BEFORE the drop and the transcript of a revert says what it cost.
-- `scripts/dbharness/run.sh` plants 3 venues with coordinates across 2
-- organisations, and 1 without, and checks this warning prints exactly those
-- figures.
--
-- Removes the RPC, the two CHECKs and the four columns. The
-- location.coordinates_set audit action and the audit rows written under it
-- stay: audit history is not this revert's to erase.

BEGIN;

DO $warn$
DECLARE
    v_venues integer;
    v_orgs integer;
BEGIN
    SELECT count(*), count(DISTINCT organization_id)
      INTO v_venues, v_orgs
      FROM public.locations
     WHERE latitude IS NOT NULL;
    RAISE WARNING 'this revert DESTROYS the coordinates of % venue(s) across % organisation(s)',
        v_venues, v_orgs;
END;
$warn$;

DROP FUNCTION IF EXISTS public.admin_set_location_coordinates(uuid, numeric, numeric);

ALTER TABLE public.locations
    DROP CONSTRAINT IF EXISTS locations_coordinates_both_or_neither,
    DROP CONSTRAINT IF EXISTS locations_coordinates_in_range,
    DROP COLUMN IF EXISTS latitude,
    DROP COLUMN IF EXISTS longitude,
    DROP COLUMN IF EXISTS coordinates_set_at,
    DROP COLUMN IF EXISTS coordinates_set_by;

DO $verify$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'locations'
                  AND column_name IN ('latitude', 'longitude', 'coordinates_set_at', 'coordinates_set_by')) THEN
        RAISE EXCEPTION 'a coordinates column survived its own revert';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname = 'admin_set_location_coordinates') THEN
        RAISE EXCEPTION 'admin_set_location_coordinates survived its own revert';
    END IF;
    RAISE NOTICE 'revert verified: the four coordinates columns, their two CHECKs and admin_set_location_coordinates are gone; the location.coordinates_set audit action stays registered.';
END;
$verify$;

COMMIT;
