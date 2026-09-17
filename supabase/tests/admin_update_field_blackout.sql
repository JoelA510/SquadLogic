-- `admin_update_field_blackout`: an edit is an edit, under a real session.
--
-- **What only this file can settle.** `docs/sql/20260910000000_smoke.sql` runs
-- under the local harness as the cluster superuser, for whom RLS does not
-- apply and `auth.uid()` is a stub. It can prove the body behaves; it cannot
-- prove that a coach is refused, that an admin of the wrong organisation is
-- refused, or that the `SECURITY DEFINER` grant does not hand the edit to
-- somebody the policy would never have let read the row in the first place.
-- Those need a real role and a real JWT claim, which is what this file has.
--
-- Five things:
--
--   1. The edit is IN PLACE -- same id, same row count, and the payload is
--      never believed about either.
--   2. It writes exactly ONE audit row, carrying before and after.
--   3. NULL means NULL: a timed window edited to all day really loses its
--      times. A COALESCE-partial body would pass every other assertion here.
--   4. A coach is refused 42501, and an admin of the other organisation is
--      refused 42501 for their own org and P0002 for this one's window.
--   5. An import-owned window is refused 0A000 by name -- and another
--      organisation's import window is refused P0002, so the refusal cannot be
--      used to confirm that an id exists.
--
-- Exercises: `admin_update_field_blackout` authz, org re-check, import-owned
-- refusal, audit shape.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

-- Ground for both orgs, seeded as the superuser before any role is assumed.
INSERT INTO public.locations (id, organization_id, name)
VALUES
    ('c1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111', 'Park A'),
    ('c2222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222', 'Park B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES
    ('d1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
     'c1111111-1111-1111-1111-1111111111aa', 'Pitch A'),
    ('d2222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222',
     'c2222222-2222-2222-2222-2222222222bb', 'Pitch B')
ON CONFLICT (id) DO NOTHING;

-- One admin-authored window per org, TIMED, so the all-day edit below has
-- something real to clear. Written as the superuser: this file is about who may
-- EDIT them, not about who managed to write them.
INSERT INTO public.field_blackouts
    (id, organization_id, location_id, field_id, blackout_from, blackout_until,
     start_minutes, end_minutes, reason, note)
VALUES
    ('e1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
     NULL, 'd1111111-1111-1111-1111-1111111111aa', '2026-08-01', '2026-08-02',
     540, 720, 'maintenance', 'resurfacing'),
    ('e2222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222',
     NULL, 'd2222222-2222-2222-2222-2222222222bb', '2026-08-01', '2026-08-02',
     540, 720, 'weather', NULL);

-- An import-owned window on Org A's ground, and one on Org B's. Both go in
-- `field_blackout_windows`, which is FROZEN -- these are what the 0A000 branch
-- exists to refuse, and the Org B one is what proves the refusal is org-scoped.
INSERT INTO public.field_availability_profiles
    (id, organization_id, season_label, field_id, location, field_name, available_from, available_until)
VALUES
    ('f1111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
     'Fall 2026', 'd1111111-1111-1111-1111-1111111111aa', 'Park A', 'Pitch A', '2026-08-01', '2026-11-30'),
    ('f2222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222',
     'Fall 2026', 'd2222222-2222-2222-2222-2222222222bb', 'Park B', 'Pitch B', '2026-08-01', '2026-11-30');

INSERT INTO public.field_blackout_windows
    (id, organization_id, profile_id, blackout_from, blackout_until, reason)
VALUES
    ('aa111111-1111-1111-1111-1111111111aa', 'a1111111-1111-1111-1111-111111111111',
     'f1111111-1111-1111-1111-1111111111aa', '2026-09-01', '2026-09-30', 'blackout_months'),
    ('bb222222-2222-2222-2222-2222222222bb', 'b2222222-2222-2222-2222-222222222222',
     'f2222222-2222-2222-2222-2222222222bb', '2026-09-01', '2026-09-30', 'blackout_months');

SELECT plan(15);

-- ── Meta: the subjects exist, so every count below is about behaviour rather
--    than about an empty table. LIVE-2's suite asserted the outcome of a broken
--    resolution over fixtures that seeded nothing to resolve to.
SELECT is(
    (SELECT COUNT(*) FROM public.field_blackouts)::int,
    2,
    'the fixture wrote two admin-authored blackouts, one per org'
);
SELECT is(
    (SELECT COUNT(*) FROM public.field_blackout_windows)::int,
    2,
    'the fixture wrote two import-owned windows, one per org'
);

-- ── 1. Alice, admin of Org A, edits her own window ────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (SELECT public.admin_update_field_blackout(
        p_organization_id => 'a1111111-1111-1111-1111-111111111111',
        p_blackout_id     => 'e1111111-1111-1111-1111-1111111111aa',
        p_blackout_from   => '2026-08-10',
        p_blackout_until  => '2026-08-12',
        p_start_minutes   => NULL,
        p_end_minutes     => NULL,
        p_reason          => 'weather',
        p_note            => NULL) ->> 'id'),
    'e1111111-1111-1111-1111-1111111111aa',
    'the edit returns the SAME id -- the window was edited, not replaced'
);

-- The payload is what a broken RPC would get wrong, so the table is read
-- directly for everything that follows.
SELECT is(
    (SELECT COUNT(*) FROM public.field_blackouts
       WHERE organization_id = 'a1111111-1111-1111-1111-111111111111')::int,
    1,
    'Org A still holds exactly one admin-authored window: no delete-and-re-add'
);

SELECT is(
    (SELECT blackout_from::text || '..' || blackout_until::text FROM public.field_blackouts
       WHERE id = 'e1111111-1111-1111-1111-1111111111aa'),
    '2026-08-10..2026-08-12',
    'the edit moved the date range'
);

-- **The COALESCE trap.** A partial update reading NULL as "leave unchanged"
-- passes every assertion above and fails this one: the window would still be
-- 09:00-12:00 while the operator was told it is now closed all day.
SELECT is(
    (SELECT num_nonnulls(start_minutes, end_minutes) FROM public.field_blackouts
       WHERE id = 'e1111111-1111-1111-1111-1111111111aa'),
    0,
    'a timed window edited to all day really lost both times'
);
SELECT is(
    (SELECT note FROM public.field_blackouts
       WHERE id = 'e1111111-1111-1111-1111-1111111111aa'),
    NULL,
    'a cleared note really is NULL rather than left as it was'
);

-- ── 2. One audit row, carrying both halves ────────────────────────────────
SELECT is(
    (SELECT COUNT(*) FROM public.audit_log
       WHERE resource_id = 'e1111111-1111-1111-1111-1111111111aa'
         AND metadata->>'operation' = 'admin_update_field_blackout')::int,
    1,
    'an edit is ONE audit event, not a delete followed by an insert'
);
SELECT is(
    (SELECT (metadata->>'phase')
          || CASE WHEN metadata ? 'before' AND metadata ? 'after' THEN '+diff' ELSE '+half' END
       FROM public.audit_log
      WHERE resource_id = 'e1111111-1111-1111-1111-1111111111aa'
        AND metadata->>'operation' = 'admin_update_field_blackout'),
    'update+diff',
    'that one row is phase=update and carries before AND after'
);

-- ── 3. A coach cannot edit ────────────────────────────────────────────────
--
-- Charlie is a genuine member of Org A, so the SELECT policy lets him READ the
-- window. Only `is_org_admin` stops him changing it, and the function is
-- SECURITY DEFINER so RLS is not what would.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$SELECT public.admin_update_field_blackout(
        p_organization_id => 'a1111111-1111-1111-1111-111111111111',
        p_blackout_id     => 'e1111111-1111-1111-1111-1111111111aa',
        p_blackout_from   => '2026-12-01',
        p_blackout_until  => '2026-12-02',
        p_reason          => 'closed')$$,
    '42501',
    NULL,
    'a coach of the same org cannot edit a blackout'
);

-- ── 4. An admin of the WRONG org ──────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$SELECT public.admin_update_field_blackout(
        p_organization_id => 'a1111111-1111-1111-1111-111111111111',
        p_blackout_id     => 'e1111111-1111-1111-1111-1111111111aa',
        p_blackout_from   => '2026-12-01',
        p_blackout_until  => '2026-12-02',
        p_reason          => 'closed')$$,
    '42501',
    NULL,
    'Bob (admin of Org B) cannot edit Org A''s window by naming Org A'
);
-- ... and he cannot reach it through his OWN organisation either, which is the
-- gate that has to hold when `is_org_admin` passes.
SELECT throws_ok(
    $$SELECT public.admin_update_field_blackout(
        p_organization_id => 'b2222222-2222-2222-2222-222222222222',
        p_blackout_id     => 'e1111111-1111-1111-1111-1111111111aa',
        p_blackout_from   => '2026-12-01',
        p_blackout_until  => '2026-12-02',
        p_reason          => 'closed')$$,
    'P0002',
    NULL,
    'Bob cannot reach Org A''s window through his own organisation'
);

-- ── 5. Import-owned, refused by name ──────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    $$SELECT public.admin_update_field_blackout(
        p_organization_id => 'a1111111-1111-1111-1111-111111111111',
        p_blackout_id     => 'aa111111-1111-1111-1111-1111111111aa',
        p_blackout_from   => '2026-12-01',
        p_blackout_until  => '2026-12-02',
        p_reason          => 'closed')$$,
    '0A000',
    NULL,
    'an import-owned window is refused as frozen, not as missing'
);
-- ... and the same call against ANOTHER org's import window is "not found", so
-- the frozen answer cannot be used to confirm an id exists elsewhere.
SELECT throws_ok(
    $$SELECT public.admin_update_field_blackout(
        p_organization_id => 'a1111111-1111-1111-1111-111111111111',
        p_blackout_id     => 'bb222222-2222-2222-2222-2222222222bb',
        p_blackout_from   => '2026-12-01',
        p_blackout_until  => '2026-12-02',
        p_reason          => 'closed')$$,
    'P0002',
    NULL,
    'another organisation''s import window is NOT FOUND, so the refusal leaks nothing'
);

-- ── The positive control for all five refusals: none of them wrote anything.
-- Without this, every `throws_ok` above is satisfied by a body that raises and
-- then edits the row anyway, or by one that had already edited it.
SELECT is(
    (SELECT reason || ' ' || blackout_from::text FROM public.field_blackouts
       WHERE id = 'e1111111-1111-1111-1111-1111111111aa'),
    'weather 2026-08-10',
    'five refused edits left the window exactly as Alice''s accepted edit left it'
);

SELECT * FROM finish();
ROLLBACK;
