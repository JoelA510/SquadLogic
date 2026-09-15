-- pgTAP: the import rollback refuses booked ground, and a field delete no
-- longer leaves an availability profile behind.
--
-- LIVE-3, pinned where CI can see it. `docs/sql/20260909000000_smoke.sql`
-- exercises the same two guards in the local migration harness, which runs as
-- cluster superuser; this runs them through an authenticated session in
-- `pgtap.yml`, so the SECURITY DEFINER path and the org gate are exercised
-- rather than bypassed.
--
-- **Every row this file asserts on is seeded here.** LIVE-2's existing suite
-- passed while seeding no fields at all, so it certified the OUTCOME of a
-- broken resolution rather than the behaviour of a working one. A corpus for a
-- booking-guard test has to contain bookings.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(28);

-- ──────────────────────────────────────────────────────────────
-- Seed, as superuser, before any SET LOCAL role.
--
-- TWO fields, both recorded as inserted by one field-import job:
--   * `…e2` carries a FREE-STANDING practice assignment -- a field_id and no
--     slot. That is precisely the shape the pre-LIVE-3 guard could not see:
--     `EXISTS practice_slots OR EXISTS game_slots` matches nothing, so the
--     rollback deleted the field and the assignment lost its venue in
--     silence. Seeding a slot instead would pass against the old body too and
--     prove nothing.
--   * `…e3` carries nothing and must still roll back, so a guard that refused
--     everything would fail here rather than looking careful.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.locations (id, organization_id, name)
VALUES ('e0000000-0000-0000-0000-0000000000e1',
        'a1111111-1111-1111-1111-111111111111', 'Rollback Park')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('e0000000-0000-0000-0000-0000000000e2',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e1', 'Imported Booked Pitch', true),
       ('e0000000-0000-0000-0000-0000000000e3',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e1', 'Imported Free Pitch', true);

INSERT INTO public.practice_assignments (
    id, organization_id, team_id, field_id, effective_date_range
)
VALUES ('e0000000-0000-0000-0000-0000000000e4',
        'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'e0000000-0000-0000-0000-0000000000e2',
        daterange(current_date, current_date + 60, '[]'));

INSERT INTO public.import_jobs (
    id, organization_id, job_type, storage_path, status, created_by
)
VALUES ('e0000000-0000-0000-0000-0000000000e5',
        'a1111111-1111-1111-1111-111111111111', 'fields',
        'imports/pgtap/fields.csv', 'completed',
        '11111111-1111-1111-1111-111111111111');

INSERT INTO public.import_application_records (
    id, organization_id, import_job_id, import_type, target_table, target_id,
    operation, applied_by
)
VALUES ('e0000000-0000-0000-0000-0000000000e6',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e5', 'fields', 'fields',
        'e0000000-0000-0000-0000-0000000000e2', 'inserted',
        '11111111-1111-1111-1111-111111111111'),
       ('e0000000-0000-0000-0000-0000000000e7',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e5', 'fields', 'fields',
        'e0000000-0000-0000-0000-0000000000e3', 'inserted',
        '11111111-1111-1111-1111-111111111111');

-- The other half of the PR: a field with an availability profile and a
-- blackout window on it, and a profile on a NEIGHBOURING field that must
-- survive, so the zero-counts below are a targeted destruction rather than an
-- emptied table.
INSERT INTO public.fields (id, organization_id, location_id, name, active)
VALUES ('e0000000-0000-0000-0000-0000000000f1',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e1', 'Profiled Pitch', true),
       ('e0000000-0000-0000-0000-0000000000f2',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e1', 'Neighbouring Pitch', true);

INSERT INTO public.field_availability_profiles (
    id, organization_id, field_id, season_label, location, field_name,
    available_from, available_until
)
VALUES ('e0000000-0000-0000-0000-0000000000f3',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000f1', '2099', 'Rollback Park',
        'Profiled Pitch', current_date, current_date + 200),
       ('e0000000-0000-0000-0000-0000000000f4',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000f2', '2099', 'Rollback Park',
        'Neighbouring Pitch', current_date, current_date + 200);

INSERT INTO public.field_blackout_windows (
    id, organization_id, profile_id, blackout_from, blackout_until, reason
)
VALUES ('e0000000-0000-0000-0000-0000000000f5',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000f3',
        current_date + 10, current_date + 20, 'resurfacing');

-- ──────────────────────────────────────────────────────────────
-- 0. The constraint the `availability_profile` arm's disposition rests on.
--    A literal saying "deleted" over a SET NULL foreign key is the stale
--    hand-written fact this whole family keeps producing.
-- ──────────────────────────────────────────────────────────────
SELECT is(
    (
        SELECT con.confdeltype::text
          FROM pg_constraint con
          JOIN pg_class src ON src.oid = con.conrelid
          JOIN pg_class tgt ON tgt.oid = con.confrelid
         WHERE con.contype = 'f' AND src.relname = 'field_availability_profiles'
           AND tgt.relname = 'fields'
    ),
    'c',
    'field_availability_profiles.field_id is ON DELETE CASCADE, so a delete destroys the profile rather than stranding it'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ──────────────────────────────────────────────────────────────
-- 1. The rollback: one field refused by name, one rolled back.
--
--    The RPC is called ONCE and its result held, because it MUTATES: calling
--    it again the way `field_delete_booking_guard.sql` calls its refusal
--    would be a second rollback against a ledger the first one changed.
-- ──────────────────────────────────────────────────────────────
-- **The call is wrapped so a failure is a FAILED ASSERTION, not an aborted
-- transaction.** A bare `SELECT rpc(...)` that raises abandons the whole file
-- at that line: psql reports an error, `finish()` never prints its
-- planned-versus-ran line, and every assertion after it is silently not run.
-- Measured, not guessed -- running this file against the pre-LIVE-3 body did
-- exactly that at the replay below, and the delete half never executed.
-- `lives_ok` catches the exception, so the rest of the file still reports.
CREATE TEMP TABLE rollback_result (r jsonb);
SELECT lives_ok(
    $$
        INSERT INTO rollback_result
        SELECT public.rollback_field_import_job('e0000000-0000-0000-0000-0000000000e5')
    $$,
    'the rollback runs rather than raising'
);

SELECT is(
    (SELECT r->>'blocked_records' FROM rollback_result),
    '1',
    'the booked field is refused'
);

SELECT is(
    (SELECT r->>'deleted_fields' FROM rollback_result),
    '1',
    'the unbooked field still rolls back; the guard refuses a field, not the job'
);

SELECT is(
    (SELECT r->>'status' FROM rollback_result),
    'completed_with_warnings',
    'a partly blocked rollback says so in its status'
);

SELECT is(
    (
        SELECT x->>'id'
          FROM rollback_result, jsonb_array_elements(r->'blocked') x
    ),
    'e0000000-0000-0000-0000-0000000000e2',
    'the blocked entry names WHICH record was refused, not just how many'
);

SELECT is(
    (
        SELECT x->>'kind'
          FROM rollback_result, jsonb_array_elements(r->'blocked') x
    ),
    'fields',
    'the blocked entry names what KIND of record it was, in the key the other two field RPCs use'
);

-- **The trail is bounded and the caller's list is not.** The RETURN above
-- carries every refusal; `warning_summary.field_rollback.blocked` carries
-- `field_bookings_digest` of it, so a rollback refused on a busy season cannot
-- write an unbounded array on every attempt.
SELECT is(
    (
        SELECT (warning_summary->'field_rollback'->'blocked'->>'total')
          FROM public.import_jobs WHERE id = 'e0000000-0000-0000-0000-0000000000e5'
    ),
    '1',
    'the stored summary carries a bounded digest of the refusals rather than the raw list'
);

SELECT is(
    (
        SELECT x->>'reason'
          FROM rollback_result, jsonb_array_elements(r->'blocked') x
    ),
    'bookings_exist',
    'the blocked entry gives a reason an operator can act on'
);

SELECT is(
    (
        SELECT x->>'affected_count'
          FROM rollback_result, jsonb_array_elements(r->'blocked') x
    ),
    '1',
    'the blocked entry counts the bookings that held it -- the free-standing practice assignment the old two-table guard could not see'
);

-- ──────────────────────────────────────────────────────────────
-- 2. The refusal wrote nothing, and left the record replayable.
--    Counted from the booking table and from `fields` by id, never derived
--    from the field row a break would remove.
-- ──────────────────────────────────────────────────────────────
RESET ROLE;

SELECT is(
    (SELECT count(*)::integer FROM public.fields
      WHERE id = 'e0000000-0000-0000-0000-0000000000e2'),
    1,
    'the refused field is still there'
);

SELECT is(
    (SELECT count(*)::integer FROM public.fields
      WHERE id = 'e0000000-0000-0000-0000-0000000000e3'),
    0,
    'the unbooked field was really removed, so the count above is a refusal and not an inert rollback'
);

SELECT is(
    (SELECT field_id::text FROM public.practice_assignments
      WHERE id = 'e0000000-0000-0000-0000-0000000000e4'),
    'e0000000-0000-0000-0000-0000000000e2',
    'the booking the refusal was about kept its venue'
);

SELECT is(
    (SELECT count(*)::integer FROM public.import_application_records
      WHERE id = 'e0000000-0000-0000-0000-0000000000e6' AND rolled_back_at IS NULL),
    1,
    'the refused record is left replayable rather than stamped as rolled back'
);

-- ──────────────────────────────────────────────────────────────
-- 3. Refusal means DEFERRAL: clear the booking, re-run, and it rolls back.
--    Without this the guard would be indistinguishable from a permanent
--    refusal, which is the disposition LIVE-2 argued against.
-- ──────────────────────────────────────────────────────────────
DELETE FROM public.practice_assignments
 WHERE id = 'e0000000-0000-0000-0000-0000000000e4';

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- Same wrapping, and here it is not hypothetical: under the pre-LIVE-3 body
-- the first call rolled the booked field back too, so by now there is nothing
-- left to roll back and the RPC raises 22023.
CREATE TEMP TABLE replay_result (r jsonb);
SELECT lives_ok(
    $$
        INSERT INTO replay_result
        SELECT public.rollback_field_import_job('e0000000-0000-0000-0000-0000000000e5')
    $$,
    'the replay runs rather than raising; a guard that had already rolled the booked field back would leave nothing to replay'
);

SELECT is(
    (SELECT r->>'deleted_fields' FROM replay_result),
    '1',
    'the replay rolls back the field that was blocked'
);

SELECT is(
    (SELECT r->>'status' FROM replay_result),
    'rolled_back',
    'a replay with nothing left to block reports a clean rollback'
);

RESET ROLE;

SELECT is(
    (SELECT count(*)::integer FROM public.fields
      WHERE id = 'e0000000-0000-0000-0000-0000000000e2'),
    0,
    'the previously blocked field is gone after the replay'
);

-- ──────────────────────────────────────────────────────────────
-- 4. A target_table neither switch handles RAISES rather than stamping the
--    ledger as rolled back. `field_availability_profiles` is a legal value of
--    the column (20260522120000) that this rollback cannot undo, so the arm
--    is reachable by data rather than only by a future edit.
-- ──────────────────────────────────────────────────────────────
INSERT INTO public.import_application_records (
    id, organization_id, import_job_id, import_type, target_table, target_id,
    operation, applied_by
)
VALUES ('e0000000-0000-0000-0000-0000000000e8',
        'a1111111-1111-1111-1111-111111111111',
        'e0000000-0000-0000-0000-0000000000e5', 'fields',
        'field_availability_profiles', 'e0000000-0000-0000-0000-0000000000f4',
        'inserted', '11111111-1111-1111-1111-111111111111');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$
        SELECT public.rollback_field_import_job('e0000000-0000-0000-0000-0000000000e5')
    $$,
    '22023',
    NULL,
    'a target_table neither switch handles raises instead of reporting a rollback that did not happen'
);

-- ──────────────────────────────────────────────────────────────
-- 5. The delete half: an availability profile alone makes the delete refuse,
--    and a confirmed delete takes the profile and its window.
--
--    LIVE-2 measured the pre-fix state as `field_id NULL`, the window still
--    attached, and `affected_count: 0`. All three are pinned.
-- ──────────────────────────────────────────────────────────────
-- **Each RPC is called ONCE and its result held.** `admin_delete_field`
-- MUTATES when it does not refuse, so three independent calls are three
-- independent deletes -- which only looks harmless while the guard is
-- working. Run against the pre-LIVE-3 body the first call deleted the field
-- and the second raised P0002, aborting the file before the assertions that
-- matter most. A test that only survives when the code is right is not a test
-- of whether the code is right.
CREATE TEMP TABLE profile_refusal (r jsonb);
SELECT lives_ok(
    $$
        INSERT INTO profile_refusal
        SELECT public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-0000000000f1'
        )
    $$,
    'the unconfirmed delete runs rather than raising'
);

SELECT is(
    (SELECT r->>'deleted' FROM profile_refusal),
    'false',
    'a field carrying only an availability profile is REFUSED; before LIVE-3 it deleted'
);

SELECT is(
    (SELECT r->>'affected_count' FROM profile_refusal),
    '1',
    'it reports one affected row rather than the zero LIVE-2 measured'
);

SELECT is(
    (
        SELECT x->>'disposition'
          FROM profile_refusal, jsonb_array_elements(r->'affected') x
         WHERE x->>'kind' = 'availability_profile'
    ),
    'deleted',
    'the profile is reported as destroyed, which is what the CASCADE does'
);

CREATE TEMP TABLE profile_delete (r jsonb);
SELECT lives_ok(
    $$
        INSERT INTO profile_delete
        SELECT public.admin_delete_field(
            'a1111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-0000000000f1',
            true
        )
    $$,
    'the confirmed delete runs rather than raising'
);

SELECT is(
    (SELECT r->>'deleted' FROM profile_delete),
    'true',
    'a confirmed delete proceeds'
);

-- ──────────────────────────────────────────────────────────────
-- 6. The org gate still stands in front of the rollback.
-- ──────────────────────────────────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.rollback_field_import_job('e0000000-0000-0000-0000-0000000000e5')
    $$,
    '42501',
    NULL,
    'an admin of another organization cannot roll back this org''s import'
);

RESET ROLE;

SELECT is(
    (SELECT count(*)::integer FROM public.field_availability_profiles
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND field_id IS NULL),
    0,
    'the confirmed delete produced no field-less profile; admin_delete_field is no longer the second producer'
);

-- **The positive anchor for the zero above.** The neighbouring pitch's
-- profile is untouched and its window count is unchanged, so a delete that
-- had simply emptied both tables would fail here rather than satisfying the
-- assertion above.
SELECT is(
    (
        SELECT count(*)::integer FROM public.field_availability_profiles
         WHERE id = 'e0000000-0000-0000-0000-0000000000f4'
    ) * 10 + (
        SELECT count(*)::integer FROM public.field_blackout_windows
         WHERE id = 'e0000000-0000-0000-0000-0000000000f5'
    ),
    10,
    'the neighbour''s profile survives (1) while the deleted field''s blackout window is gone (0)'
);

SELECT * FROM finish();
ROLLBACK;
