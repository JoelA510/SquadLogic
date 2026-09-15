-- LIVE-2: an availability import row that resolves to no field is refused,
-- reported, and replayable -- pinned where CI can see it.
--
-- `finalize_field_availability_import_job` resolved each staged row to a field
-- with a `LIMIT 1` name match and no NOT FOUND guard, and
-- `field_availability_profiles.field_id` is nullable, so a row matching no
-- field produced a profile with no ground and blackout windows hung off it
-- that `public.field_closures` reports with `closes_field_id IS NULL` -- a
-- closure no field-scoped query can see. 20260908000000 refuses the row
-- instead.
--
-- This file exists because the disposition is the ARGUABLE half. The guard is
-- one `IF`; that a refused row is reported with a reason AND stays replayable
-- is a semantics contract, and a contract nobody executes is a sentence in a
-- comment.
BEGIN;
\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(15);

-- Org A gets one location with one pitch. The staged rows below ask for that
-- pitch (twice, once with the case the club's spreadsheet uses) and for one
-- that does not exist.
INSERT INTO public.locations (id, organization_id, name)
VALUES ('c2222222-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','Alder Park');
INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES ('d2222222-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','c2222222-0000-0000-0000-000000000001','Main');

-- **The cross-org decoy.** Org B has the exact location and field name the
-- unresolvable row asks for. A resolution that dropped its organization_id
-- filter attaches Org A's closure to Org B's ground, and the refusal below
-- turns into an acceptance.
INSERT INTO public.locations (id, organization_id, name)
VALUES ('c2222222-0000-0000-0000-000000000002','b2222222-2222-2222-2222-222222222222','Alder Park');
INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES ('d2222222-0000-0000-0000-000000000002','b2222222-2222-2222-2222-222222222222','c2222222-0000-0000-0000-000000000002','Ghost Pitch');

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, total_rows)
VALUES ('11111111-3333-3333-3333-77777777777a','a1111111-1111-1111-1111-111111111111','field_availability','orga/resolution.csv','importing','11111111-1111-1111-1111-111111111111',3);

-- The unresolvable row is source_row_number 3, so it is processed AFTER two
-- rows that resolve: `v_field_id` is one variable reused by every iteration,
-- and a row inheriting its predecessor's field would attach a closure to the
-- wrong ground rather than to none.
INSERT INTO public.staging_import_rows (id, organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
VALUES
('e2222222-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-77777777777a','field_availability',1,'{}',
 jsonb_build_object('season_label','Fall 2026','location','Alder Park','field_name','Main','available_from','2026-08-01','available_until','2026-11-30','primary_format','11v11','blackout_months','Sep'),'[]'::jsonb),
('e2222222-0000-0000-0000-000000000002','a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-77777777777a','field_availability',2,'{}',
 jsonb_build_object('season_label','Fall 2026','location','ALDER park','field_name','mAIn','available_from','2026-08-01','available_until','2026-11-30','primary_format','9v9'),'[]'::jsonb),
('e2222222-0000-0000-0000-000000000003','a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-77777777777a','field_availability',3,'{}',
 jsonb_build_object('season_label','Fall 2026','location','Alder Park','field_name','Ghost Pitch','available_from','2026-08-01','available_until','2026-11-30','primary_format','7v7','blackout_months','Aug'),'[]'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is((public.finalize_field_availability_import_job('11111111-3333-3333-3333-77777777777a','[]'::jsonb)->>'inserted_profiles')::int,2,'the two resolvable rows are applied');

-- The counters, from the JOB rather than from the RPC result, so an operator
-- reading the job learns of the refusal too.
SELECT is((SELECT (warning_summary->'availability_finalize'->>'unresolved_field_rows')::int FROM public.import_jobs WHERE id='11111111-3333-3333-3333-77777777777a'),1,'the job reports one unresolved row');
SELECT is((SELECT status FROM public.import_jobs WHERE id='11111111-3333-3333-3333-77777777777a'),'completed_with_warnings','a refused row finishes the job with warnings, not completed');

-- Nothing field-less was created, counted from the table.
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE organization_id='a1111111-1111-1111-1111-111111111111' AND field_id IS NULL)::int,0,'no field-less profile is created');
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE organization_id='a1111111-1111-1111-1111-111111111111')::int,2,'exactly the two resolvable rows became profiles');
-- **"In this organisation", and not more.** This runs as Alice under
-- `SET LOCAL role = 'authenticated'`, and RLS scopes
-- `field_availability_profiles` to org membership, so the query cannot see Org
-- B at all -- a claim about "either organisation" would have passed identically
-- had a profile been created there. The cross-org decoy is proved instead by
-- `inserted_profiles = 2` and `unresolved_field_rows = 1` above: had the tenant
-- filter been dropped, Org B's Ghost Pitch would have resolved and the row
-- would have been applied rather than refused.
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE field_name='Ghost Pitch')::int,0,'the refused row created nothing this caller can see');

-- Each resolved row points at the pitch its NAME asks for, including the one
-- whose case differs -- not at whichever pitch the loop happened to hold.
SELECT is((SELECT field_id FROM public.field_availability_profiles WHERE field_name='Main'),'d2222222-0000-0000-0000-000000000001'::uuid,'the exact-match row resolves to the Main pitch');
SELECT is((SELECT field_id FROM public.field_availability_profiles WHERE field_name='mAIn'),'d2222222-0000-0000-0000-000000000001'::uuid,'the case-differing row resolves to the same pitch');

-- The refusal is reported WITH A REASON a caller can branch on, and the row is
-- left replayable rather than discarded.
SELECT is((SELECT count(*) FROM public.staging_import_rows, jsonb_array_elements(validation_errors) e
            WHERE id='e2222222-0000-0000-0000-000000000003' AND e->>'reason'='field_unresolved'
              AND e->>'location'='Alder Park' AND e->>'field_name'='Ghost Pitch')::int,1,
          'the refusal names its reason and the location and field it could not resolve');
SELECT ok((SELECT applied_at IS NULL FROM public.staging_import_rows WHERE id='e2222222-0000-0000-0000-000000000003'),
          'the refused row is not marked applied, so re-running finalize retries it');

-- The closure from the resolvable row is attributable to ground through the one
-- reader for that question; the refused row contributed no unattributable one.
SELECT is((SELECT count(*) FROM public.field_closures
            WHERE organization_id='a1111111-1111-1111-1111-111111111111'
              AND source='field_blackout_windows' AND closes_field_id='d2222222-0000-0000-0000-000000000001')::int,1,
          'the September closure names the pitch it shuts');

-- **Refused means deferred.** Create the pitch the refused row asked for and
-- re-run the same job: it applies, and the two that already applied do not
-- apply twice.
--
-- Through `admin_create_field` rather than a direct INSERT: this test runs as
-- `authenticated`, and RLS on `public.fields` refuses a direct write -- which
-- is the point of the RPC-only rule. The first version of this file inserted
-- directly and died here, and only running it said so.
SELECT lives_ok(
  $$ SELECT public.admin_create_field(
       p_organization_id => 'a1111111-1111-1111-1111-111111111111',
       p_location_id     => 'c2222222-0000-0000-0000-000000000001',
       p_name            => 'Ghost Pitch') $$,
  'an admin can create the pitch the refused row named');
-- **Two assertions, not one sum.** The first version added the RPC's result to
-- a count of the table in one expression, and SQL does not promise which
-- subquery runs first -- so the number it compared was not the number it
-- described. Executing it is what said so.
SELECT is((public.finalize_field_availability_import_job('11111111-3333-3333-3333-77777777777a','[]'::jsonb)->>'inserted_profiles')::int,1,
          'the replay applies the refused row');
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE organization_id='a1111111-1111-1111-1111-111111111111')::int,3,
          'and only it: the two already-applied rows are not applied twice');
-- And the row that could not be attributed to ground now is.
SELECT is((SELECT count(*) FROM public.field_availability_profiles
            WHERE organization_id='a1111111-1111-1111-1111-111111111111' AND field_id IS NULL)::int,0,
          'the replay creates no field-less profile either');

SELECT * FROM finish();
ROLLBACK;
