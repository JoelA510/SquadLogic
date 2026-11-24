-- Pairing applies to two weekly practices and can be inherited or cleared.
BEGIN;
\set squadlogic_fixture_include 1
\ir _fixtures.sql
SELECT plan(13);
\set org 'a1111111-1111-1111-1111-111111111111'
\set division 'a1111111-1111-1111-1111-11111111abcd'
\set team 'aaaaaaaa-0000-0000-0000-000000000001'
CREATE FUNCTION pg_temp.set_pair(p_id uuid, p_value jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE d text;
BEGIN
    PERFORM public.admin_set_scoped_setting('practice_pairs','division',p_id,p_value);
    RETURN 'ok';
EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
    RETURN d;
END $$;
SELECT is((SELECT default_value FROM public.scoped_setting_keys WHERE key='practice_pairs'), '[]'::jsonb, 'pairing defaults to an empty set');
UPDATE public.divisions SET practices_per_week=1 WHERE id=:'division';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT is(pg_temp.set_pair(:'division','["mon-wed"]'),'practice_pairing_count','a nonempty division override requires two practices');
UPDATE public.divisions SET practices_per_week=2 WHERE id=:'division';
SELECT is(pg_temp.set_pair(:'division','["mon-wed"]'),'ok','a two-practice division accepts a pair');
INSERT INTO public.locations (id,organization_id,name) VALUES ('ba000000-0000-4000-8000-000000000001',:'org','Pair venue');
INSERT INTO public.fields (id,organization_id,location_id,name) VALUES ('ba000000-0000-4000-8000-000000000002',:'org','ba000000-0000-4000-8000-000000000001','Pair pitch');
INSERT INTO public.practice_slots (id,organization_id,field_id,day_of_week,start_time,end_time,capacity,valid_from,valid_until)
SELECT id, :'org','ba000000-0000-4000-8000-000000000002',day,'16:00','17:00',2,'2026-09-07','2026-11-20'
FROM (VALUES ('ba000000-0000-4000-8000-000000000003'::uuid,'mon'::public.day_of_week),('ba000000-0000-4000-8000-000000000004','thu')) s(id,day);
INSERT INTO public.practice_assignments (id,organization_id,team_id,practice_slot_id,slot_id,day_of_week,start_time,end_time,field_id,source,assigned_via,effective_date_range)
SELECT id,organization_id,:'team',id,id,day_of_week,start_time,end_time,field_id,'manual','manual','[2026-09-07,2026-11-20]' FROM public.practice_slots WHERE id='ba000000-0000-4000-8000-000000000003';
CREATE FUNCTION pg_temp.bad() RETURNS bigint LANGUAGE sql AS $$
 SELECT count(*) FROM public.practice_new_auto_row_refusals('a1111111-1111-1111-1111-111111111111',ARRAY['ba000000-0000-4000-8000-000000000003'::uuid]) WHERE rule='pairing'
$$;
SELECT is(pg_temp.bad(),0::bigint,'a first row can be saved alone');
INSERT INTO public.practice_assignments (id,organization_id,team_id,practice_slot_id,slot_id,day_of_week,start_time,end_time,field_id,source,assigned_via,effective_date_range)
SELECT id,organization_id,:'team',id,id,day_of_week,start_time,end_time,field_id,'manual','manual','[2026-09-07,2026-11-20]' FROM public.practice_slots WHERE id='ba000000-0000-4000-8000-000000000004';
SELECT is(pg_temp.bad(),1::bigint,'a new row with a Thursday partner violates Mon/Wed');
SELECT is(pg_temp.set_pair(:'division','[]'),'ok','an explicit empty setting clears pairing');
SELECT is(pg_temp.bad(),0::bigint,'the same Thursday is accepted when pairs are off');
SELECT is(pg_temp.set_pair(:'division','["mon-wed"]'),'ok','the division restores the selected pair');
UPDATE public.practice_assignments SET effective_date_range='[2026-12-01,2026-12-31]' WHERE practice_slot_id='ba000000-0000-4000-8000-000000000004';
SELECT is(pg_temp.bad(),0::bigint,'rows without a shared live week do not need to pair');
UPDATE public.practice_assignments SET effective_date_range='[2026-09-07,2026-11-20]' WHERE practice_slot_id='ba000000-0000-4000-8000-000000000004';
UPDATE public.practice_slots SET day_of_week='wed' WHERE id='ba000000-0000-4000-8000-000000000004';
SELECT is(pg_temp.bad(),0::bigint,'Wednesday on the same pitch and clock satisfies the pair');
UPDATE public.divisions SET practices_per_week=3 WHERE id=:'division';
SELECT is((SELECT value FROM public.scoped_settings WHERE division_id=:'division' AND key='practice_pairs'),'["mon-wed"]'::jsonb,'changing count retains the stored pair');
SELECT is(pg_temp.set_pair(:'division',NULL),'ok','an inapplicable division can still return to inheritance');
SELECT is((SELECT public.division_practice_pairs(d) FROM public.divisions d WHERE d.id=:'division'),'[]'::jsonb,'a dormant setting does not reach the solver');
SELECT * FROM finish();
ROLLBACK;
