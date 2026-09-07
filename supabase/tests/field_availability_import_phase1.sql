BEGIN;
\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(21);

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, total_rows)
VALUES
('11111111-3333-3333-3333-777777777771','a1111111-1111-1111-1111-111111111111','field_availability','orga/fall2026.csv','importing','11111111-1111-1111-1111-111111111111',9),
('11111111-3333-3333-3333-777777777772','b2222222-2222-2222-2222-222222222222','field_availability','orgb/fall2026.csv','importing','22222222-2222-2222-2222-222222222222',1);

INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
VALUES
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',1,'{}',jsonb_build_object('season_label','Fall 2026','location','Stanton Elementary','field_name','Main','available_from','2026-08-01','available_until','2026-11-30','primary_format','7v7','secondary_format','9v9','teams_per_hour','2','goal_equipment','sturdy goals','goal_status','needs sturdy goals','restroom_potty','true'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',2,'{}',jsonb_build_object('season_label','Fall 2026','location','Jensen Ranch','field_name','Main','available_from','2026-08-01','available_until','2026-11-30','primary_format','7v7','secondary_format','9v9','teams_per_hour','2','goal_equipment','sturdy goals','goal_status','not approved','restroom_potty','true'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',3,'{}',jsonb_build_object('season_label','Fall 2026','location','Vannoy Back Field 7','field_name','Field 7','available_from','2026-08-01','available_until','2026-11-30','primary_format','5v5','teams_per_hour','4','goal_equipment','PUGG / Bownets / Forza','goal_status','available','use_context','Academy'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',4,'{}',jsonb_build_object('season_label','Fall 2026','location','Vannoy Front Field 1','field_name','Field 1','available_from','2026-08-01','available_until','2026-11-30','primary_format','7v7','teams_per_hour','1','goal_equipment','sturdy goals','goal_status','needs sturdy goals','restroom_potty','true'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',5,'{}',jsonb_build_object('season_label','Fall 2026','location','Independent Field 6','field_name','Field 6','available_from','2026-08-01','available_until','2026-11-30','primary_format','4v4','teams_per_hour','2','goal_equipment','PUGG or sturdy goals','goal_status','recommended','use_context','Boys & Girls','day_constraints','Sat/Sun','move_to_location','Vannoy'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',6,'{}',jsonb_build_object('season_label','Fall 2026','location','Five Canyons Upper','field_name','Upper','available_from','2026-09-01','available_until','2026-11-30','primary_format','9v9','secondary_format','7v7','teams_per_hour','2','blackout_months','Aug'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',7,'{}',jsonb_build_object('season_label','Fall 2026','location','Five Canyons Lower','field_name','Lower','available_from','2026-09-01','available_until','2026-11-30','primary_format','9v9','secondary_format','7v7','teams_per_hour','2','blackout_months','Aug'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',8,'{}',jsonb_build_object('season_label','Fall 2026','location','Bret Harte','field_name','Main','available_from','2026-09-01','available_until','2026-11-30','primary_format','11v11','teams_per_hour','2','lighted','true','blackout_months','Aug'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',9,'{}',jsonb_build_object('season_label','Fall 2026','location','San Lorenzo','field_name','Main','available_from','2026-08-01','available_until','2026-10-31','primary_format','11v11','teams_per_hour','2','blackout_months','Sep'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',10,'{}',jsonb_build_object('season_label','Fall 2026','location','Creekside','field_name','Field 1','available_from','2026-08-01','available_until','2026-11-30','record_status','excluded'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',11,'{}',jsonb_build_object('season_label','Fall 2026','location','Proctor','field_name','Field 1','available_from','2026-08-01','available_until','2026-11-30','record_status','excluded'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',12,'{}',jsonb_build_object('season_label','Fall 2026','location','Canyon','field_name','Turf 11v11 Pods','available_from','2026-08-01','available_until','2026-11-30','primary_format','11v11','format_quantity','4','aggregate_teams_per_hour','8','record_status','potential','approval_status','pending','scenario_name','Canyon Potential','scenario_group','canyon','goal_status','available'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',13,'{}',jsonb_build_object('season_label','Fall 2026','location','Canyon','field_name','Turf 9v9 Pods','available_from','2026-08-01','available_until','2026-11-30','primary_format','9v9','format_quantity','4','aggregate_teams_per_hour','8','record_status','potential','approval_status','pending','scenario_name','Canyon Potential','scenario_group','canyon','goal_equipment','sturdy 9v9 goals with wheels/locks','goal_status','required'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',14,'{}',jsonb_build_object('season_label','Fall 2026','location','Canyon','field_name','Turf Mixed Combination','available_from','2026-08-01','available_until','2026-11-30','primary_format','11v11','secondary_format','9v9','format_quantity','4','aggregate_teams_per_hour','8','record_status','potential','approval_status','pending','scenario_name','Canyon Potential','scenario_group','canyon','goal_equipment','sturdy 9v9 goals with wheels/locks','goal_status','required'),'[]'::jsonb),
('a1111111-1111-1111-1111-111111111111','11111111-3333-3333-3333-777777777771','field_availability',15,'{}',jsonb_build_object('season_label','Fall 2026','location','Canyon','field_name','Grass 11v11','available_from','2026-08-01','available_until','2026-11-30','primary_format','11v11','format_quantity','1','teams_per_hour','2','record_status','potential','approval_status','pending','scenario_name','Canyon Potential','scenario_group','canyon','goal_status','available'),'[]'::jsonb);

-- **The facility rows these staged rows name.**
--
-- Until 20260908000000 this file seeded none, and it did not need to: the
-- finalize path resolved each row to a field with no NOT FOUND guard and wrote
-- whatever it got, so all fifteen profiles below were created with
-- `field_id IS NULL` and the four blackout windows hung off them could not be
-- attributed to any ground. Every count this file asserts was correct and the
-- outcome it certified was not. The rows are seeded now, so the counts mean
-- what they say; `field_availability_profile_resolution.sql` covers the row
-- that resolves to nothing.
INSERT INTO public.locations (id, organization_id, name)
VALUES
('c1111111-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','Stanton Elementary'),
('c1111111-0000-0000-0000-000000000002','a1111111-1111-1111-1111-111111111111','Jensen Ranch'),
('c1111111-0000-0000-0000-000000000003','a1111111-1111-1111-1111-111111111111','Vannoy Back Field 7'),
('c1111111-0000-0000-0000-000000000004','a1111111-1111-1111-1111-111111111111','Vannoy Front Field 1'),
('c1111111-0000-0000-0000-000000000005','a1111111-1111-1111-1111-111111111111','Independent Field 6'),
('c1111111-0000-0000-0000-000000000006','a1111111-1111-1111-1111-111111111111','Five Canyons Upper'),
('c1111111-0000-0000-0000-000000000007','a1111111-1111-1111-1111-111111111111','Five Canyons Lower'),
('c1111111-0000-0000-0000-000000000008','a1111111-1111-1111-1111-111111111111','Bret Harte'),
('c1111111-0000-0000-0000-000000000009','a1111111-1111-1111-1111-111111111111','San Lorenzo'),
('c1111111-0000-0000-0000-00000000000a','a1111111-1111-1111-1111-111111111111','Creekside'),
('c1111111-0000-0000-0000-00000000000b','a1111111-1111-1111-1111-111111111111','Proctor'),
('c1111111-0000-0000-0000-00000000000c','a1111111-1111-1111-1111-111111111111','Canyon');

INSERT INTO public.fields (organization_id, location_id, name)
VALUES
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000001','Main'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000002','Main'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000003','Field 7'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000004','Field 1'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000005','Field 6'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000006','Upper'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000007','Lower'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000008','Main'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-000000000009','Main'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-00000000000a','Field 1'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-00000000000b','Field 1'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-00000000000c','Turf 11v11 Pods'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-00000000000c','Turf 9v9 Pods'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-00000000000c','Turf Mixed Combination'),
('a1111111-1111-1111-1111-111111111111','c1111111-0000-0000-0000-00000000000c','Grass 11v11');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is((public.finalize_field_availability_import_job('11111111-3333-3333-3333-777777777771','[]'::jsonb)->>'invalid_rows')::int,0,'fixture rows import without validation warnings');
SELECT is((SELECT status FROM public.import_jobs WHERE id='11111111-3333-3333-3333-777777777771'),'completed','job status completed');
SELECT is((SELECT count(*) FROM public.field_blackout_windows)::int,4,'expected blackout windows created (San Lorenzo Sep + Five Canyons/Bret Aug markers)');
SELECT is((SELECT count(*) FROM public.field_availability_profiles)::int,15,'expected profile count imported');
-- Every one of them points at a field, and every closure the import produced
-- can be attributed to ground through the one reader that answers that
-- question. Counted from the tables rather than from the staged rows, so a row
-- silently dropped by the resolution is absent here rather than unmentioned.
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE field_id IS NULL)::int,0,'no imported profile is field-less');
SELECT is((SELECT count(*) FROM public.field_closures WHERE source='field_blackout_windows' AND closes_field_id IS NULL)::int,0,'every import-derived closure names the ground it shuts');
SELECT is((SELECT count(*) FROM public.field_equipment_requirements)::int,9,'expected equipment requirement count (rows 1-5 and 12-15 carry goal_equipment/goal_status)');
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE location IN ('Creekside','Proctor') AND record_status='active')::int,0,'exclusions do not become active');
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE location='Canyon' AND record_status='potential' AND approval_status='pending')::int,4,'Canyon rows remain potential/pending');
SELECT is((SELECT requirement_status FROM public.field_equipment_requirements fer JOIN public.field_availability_profiles p ON p.id=fer.profile_id WHERE p.location='Jensen Ranch' AND p.field_name='Main' LIMIT 1),'not_approved','Jensen not approved goal normalizes');
SELECT is((SELECT requirement_status FROM public.field_equipment_requirements fer JOIN public.field_availability_profiles p ON p.id=fer.profile_id WHERE p.location='Stanton Elementary' AND p.field_name='Main' LIMIT 1),'needs_purchase','needs sturdy goals normalizes');

SELECT is((SELECT count(*) FROM public.field_blackout_windows bw JOIN public.field_availability_profiles p ON p.id=bw.profile_id WHERE p.location='San Lorenzo' AND bw.blackout_from='2026-09-01' AND bw.blackout_until='2026-09-30')::int,1,'San Lorenzo closed in September only');
SELECT is((SELECT count(*) FROM public.field_availability_profiles WHERE location IN ('Five Canyons Upper','Five Canyons Lower','Bret Harte') AND available_from='2026-09-01')::int,3,'Five Canyons and Bret Harte exclude August via September start');
SELECT is((SELECT count(*) FROM public.field_availability_scenarios s JOIN public.field_availability_scenario_members m ON m.scenario_id=s.id WHERE s.name='Canyon Potential' AND s.exclusivity_group='canyon')::int,4,'Canyon potential rows are scenario-grouped');

SELECT is((SELECT is_active FROM public.field_availability_scenarios WHERE name='Canyon Potential' AND organization_id='a1111111-1111-1111-1111-111111111111' LIMIT 1),false,'imported Canyon scenarios are inactive by default');
SELECT throws_ok($$ SELECT public.finalize_field_availability_import_job('11111111-3333-3333-3333-777777777772','[]'::jsonb) $$,'42501',NULL,'org isolation enforced for finalize');
SELECT throws_ok($$ SELECT public.finalize_field_import_job('11111111-3333-3333-3333-777777777771','[]'::jsonb) $$,'22023',NULL,'legacy finalizer rejects availability jobs');
SELECT is((SELECT count(*) FROM public.practice_slots WHERE organization_id='a1111111-1111-1111-1111-111111111111')::int,0,'no practice slot creation');
SELECT is((public.rollback_field_availability_import_job('11111111-3333-3333-3333-777777777771')->>'deleted_profiles')::int,15,'rollback deletes imported profiles');
SELECT is((SELECT count(*) FROM public.import_application_records WHERE import_job_id='11111111-3333-3333-3333-777777777771' AND rolled_back_at IS NOT NULL)::int > 0, true, 'rollback marks ledger rows');
SELECT is((SELECT count(*) FROM public.field_availability_scenario_members m JOIN public.field_availability_profiles p ON p.id=m.profile_id WHERE p.organization_id='a1111111-1111-1111-1111-111111111111')::int,0,'rollback leaves no orphan scenario memberships');

SELECT * FROM finish();
ROLLBACK;
