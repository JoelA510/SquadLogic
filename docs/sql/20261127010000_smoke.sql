-- Verify the resolver and grants on the migrated schema. The behavioral gate and setter use pgTAP fixtures.
\set ON_ERROR_STOP on
BEGIN;
DO $smoke$
DECLARE
    v_div public.divisions;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.scoped_setting_keys WHERE key = 'practice_pairs' AND
                   value_type = 'text_set' AND allowed_values = '["mon-wed","tue-thu","wed-fri"]'::jsonb AND default_value = '[]'::jsonb) THEN
        RAISE EXCEPTION 'Missing paired practice days registry or defaults';
    END IF;
    IF public.division_practice_pairs(v_div) IS DISTINCT FROM '[]'::jsonb OR
       has_function_privilege('anon', 'public.division_practice_pairs(public.divisions)', 'EXECUTE') OR
       NOT has_function_privilege('authenticated', 'public.division_practice_pairs(public.divisions)', 'EXECUTE') OR
       NOT has_function_privilege('service_role', 'public.division_practice_pairs(public.divisions)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Unexpected resolver default or access';
    END IF;
END
$smoke$;
DO $pair$
DECLARE
    v_admin uuid := gen_random_uuid(); v_org uuid; v_season uuid; v_div uuid;
    v_loc uuid; v_field uuid; v_team uuid; v_wed uuid;
    v_assignment uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (v_admin, 'pair-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'pair-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke PPW Org', 'smoke-pairs-org') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'PPW 2026', 'active', 2026) RETURNING id INTO v_season;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'PPW Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
        VALUES (v_org, v_loc, 'PPW Pitch', true) RETURNING id INTO v_field;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;

    v_div := (public.admin_upsert_division_settings(v_org,v_season,NULL,'Pair division',12,8,10,2,1,3,true,2,60)->>'id')::uuid;
    PERFORM public.admin_set_scoped_setting('practice_pairs','division',v_div,'["mon-wed"]');
    RESET ROLE;
    INSERT INTO public.teams (organization_id,division_id,name) VALUES (v_org,v_div,'Pair team') RETURNING id INTO v_team;
    INSERT INTO public.practice_slots (organization_id,field_id,day_of_week,start_time,end_time,capacity,valid_from,valid_until)
        SELECT v_org,v_field,day,'17:00','18:00',2,'2026-09-07','2026-10-30'
        FROM unnest(ARRAY['mon','thu']::public.day_of_week[]) day;
    INSERT INTO public.practice_assignments (organization_id,team_id,practice_slot_id,slot_id,day_of_week,start_time,end_time,field_id,source,assigned_via,effective_date_range)
        SELECT v_org,v_team,id,id,day_of_week,start_time,end_time,v_field,'manual','manual','[2026-09-07,2026-10-30]'
        FROM public.practice_slots WHERE field_id = v_field;
    SELECT id,practice_slot_id INTO STRICT v_assignment,v_wed FROM public.practice_assignments WHERE team_id=v_team AND day_of_week='thu';
    IF (SELECT count(*) FROM public.practice_new_auto_row_refusals(v_org,ARRAY[v_assignment]) WHERE rule='pairing') <> 1 THEN
        RAISE EXCEPTION 'Monday/Thursday should violate the stored Monday/Wednesday pair';
    END IF;
    UPDATE public.practice_slots SET day_of_week='wed' WHERE id=v_wed;
    IF EXISTS (SELECT FROM public.practice_new_auto_row_refusals(v_org,ARRAY[v_assignment]) WHERE rule='pairing') THEN
        RAISE EXCEPTION 'Monday/Wednesday at the same ground and time should pass';
    END IF;
END
$pair$;
ROLLBACK;
