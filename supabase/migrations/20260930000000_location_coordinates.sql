-- 8.9 PR 3: venue coordinates -- the columns, their CHECKs and their one writer.
--
-- Plan of record: docs/PHASE_8_9_PLAN.md §2 "Coordinates", §4 W14, §6 row 3,
-- §7 D4 and D9.
--
-- **What this adds.** A nullable latitude/longitude pair on public.locations,
-- so the sunset computation (8.9 PR 4) can run per venue. The pair is both or
-- neither and in range, enforced by CHECK. Its only client writer is
-- admin_set_location_coordinates: locations carries a single SELECT policy
-- ("Locations: members select", 20260504060000) and no write policy, so an
-- authenticated caller cannot UPDATE the row directly.
--
-- **Data minimisation (D9).** The RPC rounds to 2 decimals (~1.1 km; sunset
-- error under 0.05 min). The column is numeric(7,4) as the plan specifies, so
-- the 2-decimal rule is the RPC's and not a CHECK's: a table-owner write is not
-- rounded. The smoke proves the RPC rounds.
--
-- **Nothing geocodes and nothing is fetched.** An admin types the pair. No
-- venue's real coordinates are in this repository; every value in the smoke,
-- the revert check and the tests is synthetic.
--
-- **No new RLS policy.** Members already read locations, address included,
-- and a rounded coordinate pair says less than an address does.
--
-- **Nothing reads these columns yet.** The daylight provider is PR 4. Until
-- then a venue without coordinates changes nothing, and at the Edge it is
-- flagged rather than refused (D4) -- that is PR 6's to implement, not this
-- migration's.

BEGIN;

INSERT INTO public.audit_actions (action) VALUES ('location.coordinates_set')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. The columns and their CHECKs
-- ---------------------------------------------------------------------------
ALTER TABLE public.locations
    ADD COLUMN IF NOT EXISTS latitude numeric(7,4),
    ADD COLUMN IF NOT EXISTS longitude numeric(7,4),
    ADD COLUMN IF NOT EXISTS coordinates_set_at timestamptz,
    ADD COLUMN IF NOT EXISTS coordinates_set_by uuid;

ALTER TABLE public.locations
    DROP CONSTRAINT IF EXISTS locations_coordinates_both_or_neither;
ALTER TABLE public.locations
    ADD CONSTRAINT locations_coordinates_both_or_neither
    CHECK ((latitude IS NULL) = (longitude IS NULL));

-- NaN is refused too: numeric NaN sorts above every number, so it fails the
-- upper bound.
ALTER TABLE public.locations
    DROP CONSTRAINT IF EXISTS locations_coordinates_in_range;
ALTER TABLE public.locations
    ADD CONSTRAINT locations_coordinates_in_range
    CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

COMMENT ON COLUMN public.locations.latitude IS
  'Venue latitude in degrees, -90..90, rounded to 2 decimals by admin_set_location_coordinates (D9). NULL with longitude NULL means not yet entered. Both or neither, by CHECK. Never geocoded.';
COMMENT ON COLUMN public.locations.longitude IS
  'Venue longitude in degrees, -180..180, rounded to 2 decimals by admin_set_location_coordinates (D9). Both or neither with latitude, by CHECK.';
COMMENT ON COLUMN public.locations.coordinates_set_at IS
  'When admin_set_location_coordinates last wrote the pair, a clear included.';
COMMENT ON COLUMN public.locations.coordinates_set_by IS
  'auth.uid() of the admin who last wrote the pair, a clear included. No FK, as coach_practice_preferences.requested_by: deleting the user leaves an opaque id.';

-- ---------------------------------------------------------------------------
-- 2. The writer
-- ---------------------------------------------------------------------------
--
-- Follows admin_create_location (20260504060000:39, 353-363): SECURITY
-- DEFINER, search_path pinned, org-admin check, REVOKE PUBLIC, GRANT
-- authenticated. The organisation is the LOCATION's own, read from the row,
-- so an admin of one organisation cannot write another's venue.
--
-- The range is checked on the value AS GIVEN, before rounding, which is the
-- contract LocationCoordinatesSchema (packages/core/src/facility/schemas.js)
-- states: 90.004 is refused by both, rather than accepted here as 90.00.
CREATE OR REPLACE FUNCTION public.admin_set_location_coordinates(
    p_location_id uuid,
    p_latitude numeric,
    p_longitude numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.locations%ROWTYPE;
    v_after public.locations%ROWTYPE;
    v_latitude numeric := round(p_latitude, 2);
    v_longitude numeric := round(p_longitude, 2);
BEGIN
    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'p_location_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_before
      FROM public.locations
     WHERE id = p_location_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'location % not found', p_location_id
            USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_before.organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the organization that owns location %', p_location_id
            USING ERRCODE = '42501';
    END IF;

    IF (p_latitude IS NULL) <> (p_longitude IS NULL) THEN
        RAISE EXCEPTION 'latitude and longitude are both given or both NULL (NULL, NULL clears them)'
            USING ERRCODE = '22023';
    END IF;

    IF p_latitude IS NOT NULL
       AND NOT (p_latitude BETWEEN -90 AND 90 AND p_longitude BETWEEN -180 AND 180) THEN
        RAISE EXCEPTION 'coordinates out of range: latitude must be -90..90 and longitude -180..180'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.locations
       SET latitude = v_latitude,
           longitude = v_longitude,
           coordinates_set_at = timezone('utc', now()),
           coordinates_set_by = auth.uid(),
           updated_at = timezone('utc', now())
     WHERE id = p_location_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        v_before.organization_id,
        'location.coordinates_set',
        'location',
        p_location_id,
        jsonb_build_object(
            'operation', CASE WHEN v_latitude IS NULL THEN 'cleared' ELSE 'set' END,
            'before', jsonb_build_object('latitude', v_before.latitude, 'longitude', v_before.longitude),
            'after', jsonb_build_object('latitude', v_after.latitude, 'longitude', v_after.longitude)
        )
    );

    RETURN jsonb_build_object(
        'id', v_after.id,
        'organization_id', v_after.organization_id,
        'latitude', v_after.latitude,
        'longitude', v_after.longitude,
        'coordinates_set_at', v_after.coordinates_set_at,
        'coordinates_set_by', v_after.coordinates_set_by
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_location_coordinates(uuid, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_location_coordinates(uuid, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_location_coordinates(uuid, numeric, numeric) TO authenticated;

COMMENT ON FUNCTION public.admin_set_location_coordinates(uuid, numeric, numeric) IS
  'Admin-only write of a venue''s latitude/longitude, for the admin of the organization that owns the location. Both or neither (NULL, NULL clears); out of range is 22023; rounds to 2 decimals (D9); audited as location.coordinates_set with before/after. Nothing geocodes.';

COMMIT;
