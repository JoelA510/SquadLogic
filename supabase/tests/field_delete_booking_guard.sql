-- pgTAP: admin_delete_field refuses booked ground, and practice_assignments
-- cannot be left dangling.
--
-- LIVE-1, pinned where CI can see it. `docs/sql/20260907000000_smoke.sql`
-- exercises the same guard in the local migration harness, which runs as
-- cluster superuser; this runs it through an authenticated session in
-- `pgtap.yml`, so the SECURITY DEFINER path and the org gate are exercised
-- rather than bypassed.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(17);

-- ──────────────────────────────────────────────────────────────
-- Seed, as superuser, before any SET LOCAL role: one field with one booking
-- of EACH of the five kinds the delete reaches -- including `games`, which
-- carries no field_id -- so an arm dropped from the
-- RPC's union changes the count rather than being absorbed by the others.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.locations (id, organization_id, name)
VALUES ('c0000000-0000-0000-0000-0000000000c1',
        'a1111111-1111-1111-1111-111111111111', 'Guard Park')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('c0000000-0000-0000-0000-0000000000c2',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c1', 'Guard Pitch', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.game_slots (id, organization_id, field_id, slot_date, week_index)
VALUES ('c0000000-0000-0000-0000-0000000000c3',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c2', current_date + 7, 1);

-- **Two shapes of assignment, deliberately.** A FREE-STANDING one (no slot
-- behind it) is unassigned by the field_id SET NULL. The SLOT-LINKED shape --
-- which is what persist_game_schedule writes on every row -- is DESTROYED,
-- because game_slot_id and slot_id are ON DELETE CASCADE to game_slots and the
-- cascade reaches the row before the SET NULL can. Seeding only the first, as
-- this file did originally, asserts the survival of a shape production never
-- produces.
INSERT INTO public.game_assignments (id, organization_id, field_id, "start", week_index)
VALUES ('c0000000-0000-0000-0000-0000000000c4',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c2',
        timezone('utc', now()) + interval '7 days', 1);

INSERT INTO public.game_assignments (
    id, organization_id, field_id, game_slot_id, slot_id, "start", week_index
)
VALUES ('c0000000-0000-0000-0000-0000000000d4',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c2',
        'c0000000-0000-0000-0000-0000000000c3',
        'c0000000-0000-0000-0000-0000000000c3',
        timezone('utc', now()) + interval '7 days', 1);

INSERT INTO public.practice_slots (
    id, organization_id, field_id, day_of_week, start_time, end_time, valid_until
)
VALUES ('c0000000-0000-0000-0000-0000000000c5',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c2', 'mon', '18:00', '19:30', current_date + 60);

INSERT INTO public.practice_assignments (
    id, organization_id, team_id, field_id, effective_date_range
)
VALUES ('c0000000-0000-0000-0000-0000000000c6',
        'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-0000000000c2',
        daterange(current_date, current_date + 60, '[]'));

INSERT INTO public.practice_assignments (
    id, organization_id, team_id, field_id, practice_slot_id, slot_id, effective_date_range
)
VALUES ('c0000000-0000-0000-0000-0000000000d6',
        'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-0000000000c2',
        'c0000000-0000-0000-0000-0000000000c5',
        'c0000000-0000-0000-0000-0000000000c5',
        daterange(current_date, current_date + 60, '[]'));

-- `games` carries no field_id and dies with the slot, recorded score included.
-- A census by column name cannot see it; the cascade closure can.
INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES ('c0000000-0000-0000-0000-0000000000c8',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd', 'Guard Opponent')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.games (id, organization_id, game_slot_id, home_team_id, away_team_id)
VALUES ('c0000000-0000-0000-0000-0000000000c9',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c3',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-0000000000c8');

-- The unguarded two-argument overload must not exist. Argument TYPES, not
-- pg_get_function_identity_arguments, which carries parameter names and would
-- match nothing whatever the database held.
SELECT is(
    (
        SELECT count(*)::integer
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'admin_delete_field'
           AND array_to_string(p.proargtypes::oid[]::regtype[], ', ') = 'uuid, uuid'
    ),
    0,
    'the unguarded admin_delete_field(uuid, uuid) is gone; nothing can route round the guard'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ──────────────────────────────────────────────────────────────
-- 1. Unconfirmed delete of booked ground is refused, and says why.
-- ──────────────────────────────────────────────────────────────
SELECT is(
    (
        public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'c0000000-0000-0000-0000-0000000000c2'
        )->>'deleted'
    ),
    'false',
    'an unconfirmed delete of booked ground is refused'
);

SELECT is(
    (
        public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'c0000000-0000-0000-0000-0000000000c2'
        )->>'reason'
    ),
    'bookings_exist',
    'the refusal names its reason rather than only failing'
);

SELECT is(
    (
        public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'c0000000-0000-0000-0000-0000000000c2'
        )->>'affected_count'
    ),
    '7',
    'the refusal counts every row the delete reaches: 2 slots, 2 games-side rows, 2 assignments, 1 fixture'
);

SELECT is(
    (
        SELECT array_agg(DISTINCT x->>'kind' ORDER BY x->>'kind')
          FROM jsonb_array_elements(
                 public.admin_delete_field(
                     'a1111111-1111-1111-1111-111111111111',
                     'c0000000-0000-0000-0000-0000000000c2'
                 )->'affected'
               ) x
    ),
    ARRAY['game','game_assignment','game_slot','practice_assignment','practice_slot'],
    'the refusal names all five kinds, including games, which carries no field_id'
);

SELECT is(
    (
        SELECT array_agg(DISTINCT x->>'disposition' ORDER BY x->>'disposition')
          FROM jsonb_array_elements(
                 public.admin_delete_field(
                     'a1111111-1111-1111-1111-111111111111',
                     'c0000000-0000-0000-0000-0000000000c2'
                 )->'affected'
               ) x
    ),
    ARRAY['deleted','unassigned'],
    'the refusal says what would happen to each booking, both outcomes present'
);

-- ──────────────────────────────────────────────────────────────
-- 2. A refusal writes nothing. Counted from the BOOKING tables and from
--    `fields` by id -- never derived from the field row a break would remove.
-- ──────────────────────────────────────────────────────────────
RESET ROLE;

SELECT is(
    (
        SELECT count(*)::integer FROM public.fields
         WHERE id = 'c0000000-0000-0000-0000-0000000000c2'
    ),
    1,
    'a refused delete leaves the field in place'
);

SELECT is(
    (
        (SELECT count(*) FROM public.game_slots WHERE id = 'c0000000-0000-0000-0000-0000000000c3')
      + (SELECT count(*) FROM public.game_assignments
          WHERE id IN ('c0000000-0000-0000-0000-0000000000c4','c0000000-0000-0000-0000-0000000000d4'))
      + (SELECT count(*) FROM public.practice_slots WHERE id = 'c0000000-0000-0000-0000-0000000000c5')
      + (SELECT count(*) FROM public.practice_assignments
          WHERE id IN ('c0000000-0000-0000-0000-0000000000c6','c0000000-0000-0000-0000-0000000000d6'))
      + (SELECT count(*) FROM public.games WHERE id = 'c0000000-0000-0000-0000-0000000000c9')
    )::integer,
    7,
    'a refused delete destroys none of the seven rows it named'
);

-- **The per-row disposition, on two rows of one table.** A version reporting
-- one word per table can satisfy either row alone; it cannot satisfy both.
SELECT is(
    (
        SELECT x->>'disposition'
          FROM jsonb_array_elements(
                 public.admin_delete_field(
                     'a1111111-1111-1111-1111-111111111111',
                     'c0000000-0000-0000-0000-0000000000c2'
                 )->'affected'
               ) x
         WHERE x->>'id' = 'c0000000-0000-0000-0000-0000000000d4'
    ),
    'deleted',
    'a slot-linked game assignment is reported as destroyed, not unassigned'
);

SELECT is(
    (
        SELECT x->>'disposition'
          FROM jsonb_array_elements(
                 public.admin_delete_field(
                     'a1111111-1111-1111-1111-111111111111',
                     'c0000000-0000-0000-0000-0000000000c2'
                 )->'affected'
               ) x
         WHERE x->>'id' = 'c0000000-0000-0000-0000-0000000000c4'
    ),
    'unassigned',
    'a free-standing game assignment is reported as unassigned'
);

SELECT isnt(
    (
        SELECT count(*)::integer FROM public.audit_log
         WHERE resource_id = 'c0000000-0000-0000-0000-0000000000c2'
           AND metadata->>'operation' = 'admin_delete_field'
           AND metadata->>'phase' = 'refused'
    ),
    0,
    'the refusal is recorded in the audit log'
);

-- ──────────────────────────────────────────────────────────────
-- 3. A confirmed delete proceeds, and each booking meets the disposition the
--    refusal declared for it.
-- ──────────────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (
        public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'c0000000-0000-0000-0000-0000000000c2',
            true
        )->>'deleted'
    ),
    'true',
    'a confirmed delete proceeds -- the guard is a confirmation, not a prohibition'
);

RESET ROLE;

SELECT is(
    (
        (SELECT count(*) FROM public.game_slots WHERE id = 'c0000000-0000-0000-0000-0000000000c3')
      + (SELECT count(*) FROM public.practice_slots WHERE id = 'c0000000-0000-0000-0000-0000000000c5')
      + (SELECT count(*) FROM public.games WHERE id = 'c0000000-0000-0000-0000-0000000000c9')
    )::integer,
    0,
    'the slot tables and the fixture hanging off them cascade with the field'
);

-- **The rows the RPC promised to destroy really are destroyed.** This is the
-- half the first version got wrong in the operator's favour.
SELECT is(
    (
        (SELECT count(*) FROM public.game_assignments WHERE id = 'c0000000-0000-0000-0000-0000000000d4')
      + (SELECT count(*) FROM public.practice_assignments WHERE id = 'c0000000-0000-0000-0000-0000000000d6')
    )::integer,
    0,
    'slot-linked assignments are destroyed by the slot cascade, exactly as reported'
);

SELECT is(
    (
        SELECT field_id FROM public.game_assignments
         WHERE id = 'c0000000-0000-0000-0000-0000000000c4'
    ),
    NULL::uuid,
    'the game assignment survives with its venue visibly gone, not destroyed'
);

-- **The defect this migration exists for.** Before the foreign key this column
-- kept the deleted field''s uuid, and nothing downstream could tell it from a
-- live venue.
SELECT is(
    (
        SELECT field_id FROM public.practice_assignments
         WHERE id = 'c0000000-0000-0000-0000-0000000000c6'
    ),
    NULL::uuid,
    'the practice assignment is unassigned rather than left dangling at a deleted field'
);

-- ──────────────────────────────────────────────────────────────
-- 4. The org gate still stands in front of all of it.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('c0000000-0000-0000-0000-0000000000c7',
        'a1111111-1111-1111-1111-111111111111',
        'c0000000-0000-0000-0000-0000000000c1', 'Other Org Cannot Touch', true);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'c0000000-0000-0000-0000-0000000000c7',
            true
        )
    $$,
    '42501',
    NULL,
    'an admin of another organization cannot delete this org''s ground, confirmed or not'
);

SELECT * FROM finish();
ROLLBACK;
