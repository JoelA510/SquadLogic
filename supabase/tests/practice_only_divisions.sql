-- pgTAP: practice-only divisions and reserved practice slots (plan
-- docs/changes/2026-10-22-demo-mode.md, D2; migration 20261029010000).
--
-- The writers: `admin_upsert_division_settings` takes `plays_games`;
-- `admin_set_practice_slot_division` sets or clears a slot's reservation; the
-- fields CSV's Division reserves a practice slot, named within the season.
-- Overlap is refused at write, per surface and window (the turnover defaults
-- to 0): an overlapping slot is refused, one starting as another ends or 15
-- minutes after it is not; the two halves of one field run at once;
-- slots whose effective windows do not meet never clash; a whole field
-- clashes with its halves. An unknown division fails its row before anything
-- is written. Each write is audited.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(24);

INSERT INTO public.import_jobs (
    id, organization_id, job_type, storage_path, status, created_by, total_rows
)
VALUES (
    'd2d2d2d2-0000-4000-8000-000000000001',
    'a1111111-1111-1111-1111-111111111111',
    'fields',
    'orga/d2-fields.csv',
    'importing',
    '11111111-1111-1111-1111-111111111111',
    8
);

-- Eight practice rows on one pitch with two halves (A and B), Saturdays
-- 2026-09-05 to 2026-11-28 unless a row says otherwise.
INSERT INTO public.staging_import_rows (
    organization_id, import_job_id, import_type, source_row_number,
    raw_payload, normalized_payload, validation_errors
)
SELECT 'a1111111-1111-1111-1111-111111111111',
       'd2d2d2d2-0000-4000-8000-000000000001',
       'fields',
       r.n,
       '{}'::jsonb,
       jsonb_strip_nulls(jsonb_build_object(
           'location', r.location,
           'name', r.field,
           'subunit', r.subunit,
           'type', 'practice',
           'day', 'Sat',
           'start', r.s,
           'end', r.e,
           'capacity', '1',
           'valid_from', r.f,
           'valid_until', r.u,
           'division_name', r.division
       )),
       '[]'::jsonb
  FROM (VALUES
      -- 1: reserved to U4.
      (1, 'D2 Park', 'Pitch 1', 'A', '09:00', '09:30', '2026-09-05', '2026-11-28', 'org a u4'),
      -- 2: overlaps 1 on the same half.
      (2, 'D2 Park', 'Pitch 1', 'A', '09:15', '09:45', '2026-09-05', '2026-11-28', NULL),
      -- 3: starts as 1 ends (back to back).
      (3, 'D2 Park', 'Pitch 1', 'A', '09:30', '10:00', '2026-09-05', '2026-11-28', NULL),
      -- 4: starts 15 minutes after 3 ends.
      (4, 'D2 Park', 'Pitch 1', 'A', '10:15', '10:45', '2026-09-05', '2026-11-28', NULL),
      -- 5: the other half, at the same time as 1.
      (5, 'D2 Park', 'Pitch 1', 'B', '09:00', '09:30', '2026-09-05', '2026-11-28', NULL),
      -- 6: the same half and time as 1, in December only.
      (6, 'D2 Park', 'Pitch 1', 'A', '09:00', '09:30', '2026-12-05', '2026-12-19', NULL),
      -- 7: an unknown division, on ground that does not exist yet.
      (7, 'D2 Elsewhere', 'Pitch X', NULL, '09:00', '09:30', '2026-09-05', '2026-11-28', 'Org A U99'),
      -- 8: the whole pitch, at the time of 1 and 5.
      (8, 'D2 Park', 'Pitch 1', NULL, '09:00', '09:30', '2026-09-05', '2026-11-28', NULL)
  ) AS r(n, location, field, subunit, s, e, f, u, division);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ---- plays_games through the division settings writer ----------------------

SELECT is(
    (SELECT plays_games FROM public.divisions WHERE id = 'a1111111-1111-1111-1111-11111111abcd'),
    true,
    'a division plays games unless told otherwise'
);

SELECT is(
    (public.admin_upsert_division_settings(
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa',
        NULL, 'Org A U4', 15, 12, 14, 4, NULL, NULL, false
    )->>'plays_games'),
    'false',
    'an admin creates a practice-only division through the settings writer'
);

SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action = 'settings.updated'
        AND resource_type = 'division'
        AND metadata->>'name' = 'Org A U4'
        AND metadata->'current'->>'plays_games' = 'false'),
    1,
    'creating it writes one settings.updated audit row carrying plays_games'
);

SELECT results_eq(
    $$ SELECT (r->>'changed')::boolean, (r->>'plays_games')::boolean
         FROM public.admin_upsert_division_settings(
             'a1111111-1111-1111-1111-111111111111',
             'a1111111-1111-1111-1111-111111111aaa',
             NULL, 'Org A U4', 15, 12, 14, 4, NULL, NULL) AS r $$,
    $$ VALUES (false, false) $$,
    'a save that leaves plays_games out keeps it, and changes nothing'
);

SELECT is(
    (public.admin_upsert_division_settings(
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa',
        'a1111111-1111-1111-1111-11111111abcd', NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, false)->>'changed'),
    'true',
    'an admin turns an existing division practice-only'
);

SELECT results_eq(
    $$ SELECT metadata->'previous'->>'plays_games', metadata->'current'->>'plays_games'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND action = 'settings.updated'
          AND metadata->>'division_id' = 'a1111111-1111-1111-1111-11111111abcd' $$,
    $$ VALUES ('true'::text, 'false'::text) $$,
    'the change is audited with the division''s previous and current plays_games'
);

-- Put U10 back: the rest of this suite reserves a slot to it.
SELECT is(
    (public.admin_upsert_division_settings(
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa',
        'a1111111-1111-1111-1111-11111111abcd', NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, true)->>'plays_games'),
    'true',
    'an admin turns games back on'
);

-- ---- the fields CSV: reservations, and clashes refused per surface --------

SELECT results_eq(
    $$ SELECT (r->>'inserted_practice_slots')::int, (r->>'invalid_rows')::int
         FROM public.finalize_field_import_job('d2d2d2d2-0000-4000-8000-000000000001', '[]'::jsonb) AS r $$,
    $$ VALUES (5, 3) $$,
    'the import applies rows 1, 3, 4, 5 and 6 and fails rows 2, 7 and 8'
);

SELECT is(
    (SELECT d.name FROM public.practice_slots ps
       JOIN public.divisions d ON d.id = ps.division_id
       JOIN public.field_subunits fs ON fs.id = ps.field_subunit_id
      WHERE ps.organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND fs.label = 'A' AND ps.start_time = '09:00' AND ps.valid_from = '2026-09-05'),
    'Org A U4',
    'a practice row''s Division reserves its slot, named within the season (any case)'
);

SELECT is(
    (SELECT validation_errors->0->>'reason' FROM public.staging_import_rows
      WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 2),
    'practice_slot_conflict',
    'a slot overlapping another on the same half is refused'
);

SELECT ok(
    (SELECT applied_at IS NOT NULL FROM public.staging_import_rows
      WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 3),
    'a slot starting as another ends on the same half is applied (back to back)'
);

SELECT ok(
    (SELECT applied_at IS NOT NULL FROM public.staging_import_rows
      WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 4),
    'a slot starting 15 minutes after another ends is applied'
);

SELECT ok(
    (SELECT applied_at IS NOT NULL FROM public.staging_import_rows
      WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 5),
    'the two halves of one field run at once'
);

SELECT ok(
    (SELECT applied_at IS NOT NULL FROM public.staging_import_rows
      WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 6),
    'slots whose effective windows do not meet never clash'
);

SELECT is(
    (SELECT validation_errors->0->>'reason' FROM public.staging_import_rows
      WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 8),
    'practice_slot_conflict',
    'a slot on the whole field clashes with a slot on one of its halves'
);

SELECT results_eq(
    $$ SELECT validation_errors->0->>'reason', validation_errors->0->>'division', applied_at IS NULL
         FROM public.staging_import_rows
        WHERE import_job_id = 'd2d2d2d2-0000-4000-8000-000000000001' AND source_row_number = 7 $$,
    $$ VALUES ('division_unknown'::text, 'Org A U99'::text, true) $$,
    'an unknown division in the CSV fails its row with its reason'
);

SELECT is(
    (SELECT count(*)::int FROM public.locations
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND name = 'D2 Elsewhere'),
    0,
    'a refused row writes nothing, not even its new location'
);

-- ---- admin_set_practice_slot_division -------------------------------------

-- The slots by name, read once as Org A's admin: another organization's
-- admin reads none of them through row security.
CREATE TEMP TABLE d2_slots ON COMMIT DROP AS
SELECT fs.label, ps.start_time, ps.valid_from, ps.id
  FROM public.practice_slots ps
  JOIN public.field_subunits fs ON fs.id = ps.field_subunit_id
 WHERE ps.organization_id = 'a1111111-1111-1111-1111-111111111111';

SELECT results_eq(
    $$ SELECT (r->>'changed')::boolean, r->>'division_id'
         FROM public.admin_set_practice_slot_division(
             (SELECT id FROM d2_slots WHERE label = 'B' AND start_time = '09:00'),
             'a1111111-1111-1111-1111-11111111abcd') AS r $$,
    $$ VALUES (true, 'a1111111-1111-1111-1111-11111111abcd'::text) $$,
    'an admin reserves a slot to a division'
);

SELECT results_eq(
    $$ SELECT metadata->'previous'->>'division_id', metadata->'current'->>'name'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND action = 'practice_slot.division_set'
          AND metadata->>'practice_slot_id' = (SELECT id::text FROM d2_slots WHERE label = 'B') $$,
    $$ VALUES (NULL::text, 'Org A U10'::text) $$,
    'the reservation writes one practice_slot.division_set audit row with its before and after'
);

SELECT results_eq(
    $$ SELECT (r->>'changed')::boolean, r->>'division_id'
         FROM public.admin_set_practice_slot_division(
             (SELECT id FROM d2_slots WHERE label = 'A' AND start_time = '09:00' AND valid_from = '2026-09-05'),
             NULL) AS r $$,
    $$ VALUES (true, NULL::text) $$,
    'an admin clears a reservation'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_practice_slot_division(
           (SELECT id FROM d2_slots WHERE label = 'B'),
           'b2222222-2222-2222-2222-22222222bcde') $$,
    '22023',
    NULL,
    'a division of another organization cannot reserve the slot'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$ SELECT public.admin_set_practice_slot_division(
           (SELECT id FROM d2_slots WHERE label = 'B'),
           NULL) $$,
    '42501',
    NULL,
    'a coach cannot reserve a slot'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$ SELECT public.admin_set_practice_slot_division(
           (SELECT id FROM d2_slots WHERE label = 'B'),
           NULL) $$,
    '42501',
    NULL,
    'another organization''s admin cannot reserve the slot'
);

SELECT ok(
    NOT has_function_privilege('authenticated',
        'public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer)',
        'EXECUTE'),
    'the clash rule is internal: no client role calls it'
);

SELECT * FROM finish();

ROLLBACK;
