-- pgTAP: venue coordinates are written only through admin_set_location_coordinates
-- (20260930000000), by an admin of the location's own organization.
--
-- Every coordinate here is synthetic (40.00/-75.00, 41.50/-73.50 and the
-- range boundaries). No venue's real position is in this file.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(12);

INSERT INTO public.locations (id, organization_id, name)
VALUES
    ('a0000000-0000-0000-0000-000000000901', 'a1111111-1111-1111-1111-111111111111', 'Org A Coordinate Park'),
    ('b0000000-0000-0000-0000-000000000902', 'b2222222-2222-2222-2222-222222222222', 'Org B Coordinate Park')
ON CONFLICT (id) DO NOTHING;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (
        SELECT (r->>'latitude')::numeric || '/' || (r->>'longitude')::numeric
          FROM public.admin_set_location_coordinates(
                   'a0000000-0000-0000-0000-000000000901', 40.125, -75.125) AS r
    ),
    '40.1300/-75.1300',
    'Org A admin sets its venue''s coordinates, rounded to 2 decimals'
);

SELECT is(
    (
        SELECT count(*)::int FROM public.audit_log
         WHERE resource_id = 'a0000000-0000-0000-0000-000000000901'
           AND action = 'location.coordinates_set'
           AND metadata->'before' = jsonb_build_object('latitude', NULL, 'longitude', NULL)
           AND metadata->'after' = jsonb_build_object('latitude', 40.13, 'longitude', -75.13)
    ),
    1,
    'the write is audited as location.coordinates_set with before and after'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_location_coordinates('a0000000-0000-0000-0000-000000000901', 41.50, NULL) $$,
    '22023',
    NULL,
    'a half pair is refused'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_location_coordinates('a0000000-0000-0000-0000-000000000901', 90.01, -75.00) $$,
    '22023',
    NULL,
    'a latitude past 90 is refused'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_location_coordinates('a0000000-0000-0000-0000-000000000901', 40.00, -180.01) $$,
    '22023',
    NULL,
    'a longitude past -180 is refused'
);

SELECT lives_ok(
    $$ SELECT public.admin_set_location_coordinates('a0000000-0000-0000-0000-000000000901', -90, 180) $$,
    'the range boundaries are accepted'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_location_coordinates('b0000000-0000-0000-0000-000000000902', 41.50, -73.50) $$,
    '42501',
    NULL,
    'Org A admin cannot set Org B''s venue'
);

SELECT is(
    (
        SELECT count(*)::int
          FROM public.locations
         WHERE id = 'a0000000-0000-0000-0000-000000000901'
    ),
    1,
    'members still read the location (no new policy)'
);

-- No UPDATE policy on locations, so RLS lets this reach no row.
UPDATE public.locations SET latitude = 41.50, longitude = -73.50
 WHERE id = 'a0000000-0000-0000-0000-000000000901';

SELECT is(
    (
        SELECT latitude::text || '/' || longitude::text
          FROM public.locations
         WHERE id = 'a0000000-0000-0000-0000-000000000901'
    ),
    '-90.0000/180.0000',
    'a direct UPDATE by the admin changes nothing; the RPC is the only writer'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$ SELECT public.admin_set_location_coordinates('a0000000-0000-0000-0000-000000000901', 41.50, -73.50) $$,
    '42501',
    NULL,
    'Org A coach cannot set coordinates'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (
        SELECT (r->>'latitude') IS NULL AND (r->>'longitude') IS NULL
          FROM public.admin_set_location_coordinates(
                   'a0000000-0000-0000-0000-000000000901', NULL, NULL) AS r
    ),
    true,
    'NULL, NULL clears the pair'
);

RESET role;

SELECT is(
    (
        SELECT count(*)::int FROM public.audit_log
         WHERE resource_id = 'a0000000-0000-0000-0000-000000000901'
           AND action = 'location.coordinates_set'
    ),
    3,
    'three accepted writes (set, boundary, clear) left three audit rows; refusals left none'
);

SELECT * FROM finish();
ROLLBACK;
