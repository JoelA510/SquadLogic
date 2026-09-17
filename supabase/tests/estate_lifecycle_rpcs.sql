-- 8.4 gap B: retiring a venue and a sub-surface, under a real session.
--
-- **What only this file can settle.** `docs/sql/20260911000000_smoke.sql` runs
-- under the local harness as the cluster superuser, for whom RLS does not
-- apply and `auth.uid()` is a stub. It can prove the bodies behave; it cannot
-- prove that a coach is refused, that an admin of the wrong organisation is
-- refused, or that a `SECURITY DEFINER` grant does not hand a venue retirement
-- to somebody the policy would never have let read the row. Those need a real
-- role and a real JWT claim.
--
-- Six things:
--
--   1. A venue retirement asks a VENUE-SCOPED question. Org A's site holds two
--      pitches with a booking each; the refusal must name both. This is the
--      defect the whole migration exists to prevent, and a field-scoped
--      implementation fails here under a real session as well as under the
--      harness.
--   2. CONTAINMENT, not copy-down: a confirmed venue retirement writes one
--      date on one row and leaves every child's `effective_to` NULL.
--   3. A sub-surface retirement is NARROWER than its pitch: only rows that
--      name the sub-surface, not the game on the full pitch.
--   4. Charlie the coach is refused 42501 at both depths.
--   5. Bob, admin of Org B, is refused 42501 for Org A and P0002 for Org A's
--      venue passed under his own organisation -- so the refusal cannot be
--      used to confirm that an id exists.
--   6. The refusal is a RETURN, not a raise, and it writes a `refused` audit
--      row while changing no state.
--
-- Exercises: `admin_retire_location`, `admin_unretire_location`,
-- `admin_retire_field_subunit`, `admin_unretire_field_subunit` authz, scope,
-- containment and audit shape.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

-- Ground for both orgs, seeded as the superuser before any role is assumed.
INSERT INTO public.locations (id, organization_id, name)
VALUES
    ('c1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111', 'Estate Park A'),
    ('c2222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222', 'Estate Park B')
ON CONFLICT (id) DO NOTHING;

-- **TWO pitches at Org A's site**, which is the whole point: a venue-scoped
-- question has to reach both, and a field-scoped one cannot.
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES
    ('d1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
     'c1111111-1111-1111-1111-1111111111aa', 'Estate Pitch A1', true),
    ('d1111111-1111-1111-1111-1111111111ab', 'a1111111-1111-1111-1111-111111111111',
     'c1111111-1111-1111-1111-1111111111aa', 'Estate Pitch A2', true),
    ('d2222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222',
     'c2222222-2222-2222-2222-2222222222bb', 'Estate Pitch B1', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.field_subunits (id, organization_id, field_id, label)
VALUES
    ('e1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
     'd1111111-1111-1111-1111-1111111111aa', 'Estate Pitch A1 North')
ON CONFLICT (id) DO NOTHING;

-- One booking on each of Org A's pitches, plus one naming the sub-surface.
-- The sub-surface slot also carries pitch A1's field_id, because
-- `practice_slots.field_id` is NOT NULL -- which is exactly why the venue
-- scope and the sub-surface scope disagree about the game on the full pitch.
INSERT INTO public.game_slots (id, organization_id, field_id, slot_date, week_index)
VALUES ('ff111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
        'd1111111-1111-1111-1111-1111111111aa', '2026-10-10', 1);

INSERT INTO public.practice_slots
    (id, organization_id, field_id, day_of_week, start_time, end_time, valid_until)
VALUES ('ff222222-2222-2222-2222-2222222222aa', 'a1111111-1111-1111-1111-111111111111',
        'd1111111-1111-1111-1111-1111111111ab', 'tue', '18:00', '19:30', '2026-10-20');

INSERT INTO public.practice_slots
    (id, organization_id, field_id, field_subunit_id, day_of_week, start_time, end_time, valid_until)
VALUES ('ff333333-3333-3333-3333-3333333333aa', 'a1111111-1111-1111-1111-111111111111',
        'd1111111-1111-1111-1111-1111111111aa', 'e1111111-1111-1111-1111-1111111111aa',
        'wed', '17:00', '18:30', '2026-10-30');

SELECT plan(21);

-- ── Meta: the subjects exist, so every count below is about behaviour rather
--    than about an empty table. LIVE-2's suite asserted the outcome of a broken
--    resolution over fixtures that seeded nothing to resolve to.
SELECT is(
    (SELECT COUNT(*) FROM public.fields
      WHERE location_id = 'c1111111-1111-1111-1111-1111111111aa')::int,
    2,
    'the fixture put TWO pitches at Org A''s site, which is what a venue scope must reach'
);
SELECT is(
    (SELECT COUNT(*) FROM public.practice_slots
      WHERE field_subunit_id = 'e1111111-1111-1111-1111-1111111111aa')::int,
    1,
    'the fixture wrote exactly one booking that NAMES the sub-surface'
);

-- ── 1. Alice, admin of Org A, attempts an unconfirmed venue retirement ────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (SELECT public.admin_retire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa',
        '2026-09-01', false) ->> 'retired'),
    'false',
    'an unconfirmed venue retirement over live bookings is REFUSED, not raised'
);

-- **THE assertion.** Three bookings across TWO pitches. A field-scoped
-- implementation names one pitch and one or two bookings.
SELECT is(
    (SELECT (public.admin_retire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa',
        '2026-09-01', false) ->> 'affected_count')::int),
    3,
    'the venue refusal counts every booking at the site, not one pitch worth'
);
SELECT is(
    (SELECT COUNT(DISTINCT x->>'field_id')::int
       FROM jsonb_array_elements(
              public.admin_retire_location(
                'a1111111-1111-1111-1111-111111111111',
                'c1111111-1111-1111-1111-1111111111aa',
                '2026-09-01', false) -> 'affected') x),
    2,
    'the venue refusal spans BOTH pitches: a venue-scoped question, not a field-scoped one'
);

-- A retirement destroys nothing, so no row may carry a disposition.
SELECT is(
    (SELECT COUNT(*)::int
       FROM jsonb_array_elements(
              public.admin_retire_location(
                'a1111111-1111-1111-1111-111111111111',
                'c1111111-1111-1111-1111-1111111111aa',
                '2026-09-01', false) -> 'affected') x
      WHERE x ? 'disposition'),
    0,
    'a retirement reports no disposition: it writes a date and destroys nothing'
);

-- Containment is reported with the refusal: two pitches and one sub-surface.
SELECT is(
    (SELECT (public.admin_retire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa',
        '2026-09-01', false) ->> 'contained_count')::int),
    3,
    'the refusal names the three nodes the retirement would take out of service'
);

-- And it wrote NOTHING to the venue.
SELECT is(
    (SELECT effective_to FROM public.locations
      WHERE id = 'c1111111-1111-1111-1111-1111111111aa'),
    NULL::date,
    'a refused venue retirement leaves the date unwritten'
);
SELECT cmp_ok(
    (SELECT COUNT(*)::int FROM public.audit_log
      WHERE resource_id = 'c1111111-1111-1111-1111-1111111111aa'
        AND metadata->>'operation' = 'admin_retire_location'
        AND metadata->>'phase' = 'refused'),
    '>=', 1,
    'the refusal is recorded: the world the operator decided against is in the trail'
);

-- ── 2. Confirmed: one date on one row, and CONTAINMENT rather than copy-down
SELECT is(
    (SELECT public.admin_retire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa',
        '2026-09-01', true) ->> 'retired'),
    'true',
    'a confirmed venue retirement proceeds'
);
SELECT is(
    (SELECT effective_to FROM public.locations
      WHERE id = 'c1111111-1111-1111-1111-1111111111aa'),
    '2026-09-01'::date,
    'the venue''s own date is written'
);
-- **The containment decision, made falsifiable.** An implementation that
-- pushed the date onto its children passes every assertion above and fails
-- this one and the next.
SELECT is(
    (SELECT COUNT(*)::int FROM public.fields
      WHERE location_id = 'c1111111-1111-1111-1111-1111111111aa'
        AND effective_to IS NOT NULL),
    0,
    'no date was copied onto a field: containment is resolved on read, never written down'
);
SELECT is(
    (SELECT COUNT(*)::int FROM public.field_subunits
      WHERE id = 'e1111111-1111-1111-1111-1111111111aa'
        AND effective_to IS NOT NULL),
    0,
    'nor onto a sub-surface'
);
-- `fields.active` means "deactivated on its own account", and a venue
-- retirement is not that decision.
SELECT is(
    (SELECT COUNT(*)::int FROM public.fields
      WHERE location_id = 'c1111111-1111-1111-1111-1111111111aa'
        AND active IS DISTINCT FROM true),
    0,
    'the venue retirement deactivated nothing'
);

SELECT is(
    (SELECT public.admin_unretire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa') -> 'location' ->> 'effective_to'),
    NULL,
    'unretiring clears the venue date'
);

-- ── 3. The sub-surface scope is NARROWER than its pitch ───────────────────
SELECT is(
    (SELECT (public.admin_retire_field_subunit(
        'a1111111-1111-1111-1111-111111111111',
        'e1111111-1111-1111-1111-1111111111aa',
        '2026-09-01', false) ->> 'affected_count')::int),
    1,
    'only the booking that NAMES the sub-surface counts: a half is not the whole pitch'
);
SELECT is(
    (SELECT public.admin_retire_field_subunit(
        'a1111111-1111-1111-1111-111111111111',
        'e1111111-1111-1111-1111-1111111111aa',
        '2026-09-01', false) -> 'affected' -> 0 ->> 'id'),
    'ff333333-3333-3333-3333-3333333333aa',
    'and it is that booking by id, not the game on the full pitch'
);

-- ── 4. Charlie the coach is refused at both depths ────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$SELECT public.admin_retire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa', '2026-09-01', true)$$,
    '42501',
    NULL,
    'a coach of the organisation cannot retire a venue'
);
SELECT throws_ok(
    $$SELECT public.admin_unretire_field_subunit(
        'a1111111-1111-1111-1111-111111111111',
        'e1111111-1111-1111-1111-1111111111aa')$$,
    '42501',
    NULL,
    'nor unretire a sub-surface'
);

-- ── 5. Bob, admin of Org B, gets 42501 for Org A and P0002 for his own ────
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$SELECT public.admin_retire_location(
        'a1111111-1111-1111-1111-111111111111',
        'c1111111-1111-1111-1111-1111111111aa', '2026-09-01', true)$$,
    '42501',
    NULL,
    'an admin of another organisation is refused before the venue is ever looked up'
);
-- **The org-scoped lookup, which is what stops the refusal being an oracle.**
-- Bob passes his OWN organisation with Org A's venue id: he is an admin there,
-- so the authz gate lets him through, and the lookup must then answer NOT
-- FOUND rather than retiring somebody else's site.
SELECT throws_ok(
    $$SELECT public.admin_retire_location(
        'b2222222-2222-2222-2222-222222222222',
        'c1111111-1111-1111-1111-1111111111aa', '2026-09-01', true)$$,
    'P0002',
    NULL,
    'another organisation''s venue id is NOT FOUND, not retired'
);

ROLLBACK;
