BEGIN;
\set squadlogic_fixture_include 1
\ir _fixtures.sql
SELECT plan(6);

INSERT INTO public.season_settings (id, organization_id, name, status, season_year)
VALUES ('34000000-1111-4111-8111-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Next test season', 'draft', 2027);
INSERT INTO public.divisions (organization_id, season_settings_id, name)
VALUES ('a1111111-1111-1111-1111-111111111111', '34000000-1111-4111-8111-000000000001', 'New Rec');
-- A registration left without a division by the older finalizer. Its identity must survive reimport.
INSERT INTO public.players (id, organization_id, season_settings_id, first_name, last_name, external_registration_id)
VALUES ('34000000-1111-4111-8111-000000000003', 'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa', 'Test', 'Player', 'named-1');
INSERT INTO public.import_jobs (id, organization_id, season_settings_id, job_type, storage_path, status, created_by)
VALUES ('34000000-1111-4111-8111-000000000002','a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa','registration','fixture/players.csv','processing','11111111-1111-1111-1111-111111111111');
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111', '34000000-1111-4111-8111-000000000002',
       n, '{}'::jsonb, jsonb_build_object('first_name','Test','last_name','Player',
         'external_registration_id','named-' || n,'division',label)
FROM (VALUES (1,'New Rec'), (2,'new rec')) t(n,label);
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT public.finalize_import_job('34000000-1111-4111-8111-000000000002');
RESET ROLE;

SELECT is((SELECT count(*) FROM public.divisions WHERE season_settings_id='a1111111-1111-1111-1111-111111111aaa' AND lower(name)='new rec'), 1::bigint, 'creates one case-insensitive division in the destination season');
SELECT is((SELECT count(*) FROM public.players p JOIN public.divisions d ON d.id=p.division_id
   WHERE p.external_registration_id IN ('named-1','named-2') AND d.name='New Rec'
     AND d.season_settings_id='a1111111-1111-1111-1111-111111111aaa'), 2::bigint, 'both registered players have the intended division on first apply');
SELECT is((SELECT count(*) FROM public.players WHERE season_settings_id='34000000-1111-4111-8111-000000000001'
    AND external_registration_id IN ('named-1','named-2')), 0::bigint, 'the other season receives no registrations');
SELECT is((SELECT count(*) FROM public.divisions WHERE season_settings_id='34000000-1111-4111-8111-000000000001' AND name='New Rec'),1::bigint,'the existing division in the other season is retained');
SELECT is((SELECT count(*) FROM public.players p JOIN public.divisions d ON d.id=p.division_id
           WHERE p.id='34000000-1111-4111-8111-000000000003' AND d.name='New Rec'
             AND d.season_settings_id='a1111111-1111-1111-1111-111111111aaa'),
          1::bigint, 'reimport repairs an earlier registration in place');
SELECT is((SELECT count(*) FROM public.players WHERE season_settings_id='a1111111-1111-1111-1111-111111111aaa' AND external_registration_id IN ('named-1','named-2')), 2::bigint,
          'the corrected import updates the existing player and inserts the other exactly once');
SELECT * FROM finish();
ROLLBACK;
