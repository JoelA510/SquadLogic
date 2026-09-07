-- pgTAP: facility management writes go through admin-only RPCs.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(16);

INSERT INTO public.locations (id, organization_id, name)
VALUES
    ('a0000000-0000-0000-0000-000000000101', 'a1111111-1111-1111-1111-111111111111', 'Org A Existing Park'),
    ('b0000000-0000-0000-0000-000000000202', 'b2222222-2222-2222-2222-222222222222', 'Org B Existing Park')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (
    id,
    organization_id,
    location_id,
    name,
    surface_type,
    size,
    supports_halves,
    priority_rating,
    active
)
VALUES (
    'a0000000-0000-0000-0000-000000000303',
    'a1111111-1111-1111-1111-111111111111',
    'a0000000-0000-0000-0000-000000000101',
    'Org A Existing Field',
    'Grass',
    '11v11',
    false,
    1,
    true
)
ON CONFLICT (id) DO NOTHING;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (
        public.admin_create_location(
            'a1111111-1111-1111-1111-111111111111',
            '  New Admin Park  '
        )->>'name'
    ),
    'New Admin Park',
    'Org A admin can create a trimmed location through the RPC'
);

SELECT results_eq(
    $$
        SELECT organization_id, name
          FROM public.locations
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND name = 'New Admin Park'
    $$,
    $$
        VALUES (
            'a1111111-1111-1111-1111-111111111111'::uuid,
            'New Admin Park'::text
        )
    $$,
    'created location is stored under Org A'
);

SELECT is(
    (
        public.admin_create_field(
            'a1111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-000000000101',
            '  North Field  ',
            'Turf',
            '7v7',
            true,
            3,
            true
        )->>'size'
    ),
    '7v7',
    'Org A admin can create a field through the RPC'
);

SELECT results_eq(
    $$
        SELECT organization_id, location_id, name, surface_type, size, supports_halves, priority_rating, active
          FROM public.fields
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND name = 'North Field'
    $$,
    $$
        VALUES (
            'a1111111-1111-1111-1111-111111111111'::uuid,
            'a0000000-0000-0000-0000-000000000101'::uuid,
            'North Field'::text,
            'Turf'::text,
            '7v7'::text,
            true,
            3,
            true
        )
    $$,
    'created field is stored with Org A facility attributes'
);

SELECT is(
    (
        public.admin_update_field(
            'a1111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-000000000303',
            'a0000000-0000-0000-0000-000000000101',
            'Renamed Field',
            'Grass',
            '9v9',
            false,
            2,
            false
        )->>'name'
    ),
    'Renamed Field',
    'Org A admin can update an existing field through the RPC'
);

SELECT results_eq(
    $$
        SELECT name, size, priority_rating, active
          FROM public.fields
         WHERE id = 'a0000000-0000-0000-0000-000000000303'
    $$,
    $$
        VALUES ('Renamed Field'::text, '9v9'::text, 2, false)
    $$,
    'field update is durable'
);

SELECT is(
    (
        public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-000000000303'
        )->>'deleted'
    ),
    'true',
    'Org A admin can delete an org field through the RPC'
);

SELECT is(
    (
        SELECT count(*)
          FROM public.fields
         WHERE id = 'a0000000-0000-0000-0000-000000000303'
    )::integer,
    0,
    'deleted field is removed'
);

-- create_location, create_field, update_field, then admin_delete_field's
-- BEFORE and AFTER phases -- five, not four. 20260907000000 gave the delete
-- the same audit-both-phases shape admin_retire_field has, because "what did
-- it look like before" is the half that makes a destructive decision
-- reviewable.
SELECT is(
    (
        SELECT count(*)
          FROM public.audit_log
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND action = 'settings.updated'
           AND resource_type IN ('location', 'field')
    )::integer,
    5,
    'facility RPC mutations write settings audit events'
);

SELECT is(
    (
        SELECT count(*)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND policyname IN (
               'Strict org access on locations',
               'Strict org access on fields',
               'Unified org access on field_subunits',
               'Unified org access on practice_slots'
           )
    )::integer,
    0,
    'old broad facility write policies are removed'
);

SELECT is(
    (
        SELECT count(*)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND policyname IN (
               'Locations: members select',
               'Fields: members select',
               'Field Subunits: members select',
               'Practice Slots: members select'
           )
    )::integer,
    4,
    'facility member read policies remain available'
);

SELECT throws_ok(
    $$
        INSERT INTO public.locations (organization_id, name)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'Direct Admin Insert')
    $$,
    '42501',
    NULL,
    'direct location inserts are blocked even for org admins'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$
        SELECT public.admin_create_location(
            'a1111111-1111-1111-1111-111111111111',
            'Coach Park'
        )
    $$,
    '42501',
    NULL,
    'Org A coach cannot create facility locations'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.admin_create_field(
            'a1111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-000000000101',
            'Cross Org Field',
            'Grass',
            '11v11',
            false,
            1,
            true
        )
    $$,
    '42501',
    NULL,
    'Org B admin cannot create fields for Org A'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$
        SELECT public.admin_create_field(
            'a1111111-1111-1111-1111-111111111111',
            'b0000000-0000-0000-0000-000000000202',
            'Bad Location Field',
            'Grass',
            '11v11',
            false,
            1,
            true
        )
    $$,
    '42501',
    NULL,
    'Org A admin cannot create a field in an Org B location'
);

SELECT throws_ok(
    $$
        SELECT public.admin_create_field(
            'a1111111-1111-1111-1111-111111111111',
            'a0000000-0000-0000-0000-000000000101',
            '   ',
            'Grass',
            '11v11',
            false,
            1,
            true
        )
    $$,
    '22023',
    NULL,
    'blank field names are rejected'
);

SELECT * FROM finish();
ROLLBACK;
