-- Smoke checks for 20261102010000_facility_permits.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. Posture: both tables have row level security and one read policy, are read-only to a client
--      and closed to anon; the five RPCs are pinned definers for signed-in users; the internal
--      helpers are no client's; the bucket is private with its limits and its three policies; the
--      CHECK constraints are there.
--   2. The writer, as an admin: a permit is recorded with its scopes and one audit row; each
--      refusal (dates, no scope, another organization's field) writes none; a coach, and another
--      organization's admin, are refused.
--   3. The coach read: a coach of a team with a game at the field reads the permit through the RPC
--      and the tables; a coach of a team scheduled elsewhere reads none; a direct write by a
--      signed-in user is refused.
--   4. The file: an object that was never uploaded is refused, a recorded one is attached, a second
--      replaces it and returns the first; the bucket's policies let an admin upload, refuse a coach,
--      and show a coach the live file and not the replaced one.
--   5. admin_delete_field lists the permit it unlinks, and the permit stays when the delete is
--      confirmed; deleting a permit returns its file path.
--
-- **The harness's storage stand-in.** scripts/dbharness/prelude.sql creates `storage.objects`
-- without RLS and without table grants, where Supabase has both. Inside this transaction only, and
-- only when they are missing, this smoke turns RLS on and grants the API roles what Supabase grants
-- them, so the policies are judged as Supabase judges them. On a Supabase database nothing is
-- changed. Its NOTICE says which.
--
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        RAISE NOTICE 'storage.objects had RLS off (the harness stand-in); turned on for this transaction';
    END IF;
    IF NOT has_table_privilege('authenticated', 'storage.objects', 'INSERT')
       OR NOT has_table_privilege('anon', 'storage.objects', 'INSERT') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
        RAISE NOTICE 'storage.objects had no API-role grants (the harness stand-in); granted for this transaction';
    END IF;
END;
$$;

-- Act as a user ('postgres' for the owner, with no session).
CREATE FUNCTION pg_temp.act(p_user uuid, p_role text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', coalesce(p_role, 'authenticated'), true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', coalesce(p_role, 'authenticated'))::text, true);
    IF p_role = 'authenticated' THEN SET LOCAL ROLE authenticated;
    ELSIF p_role = 'anon' THEN SET LOCAL ROLE anon; END IF;
END;
$$;

-- One object upload as p_user: 'ok' or the SQLSTATE it raised.
CREATE FUNCTION pg_temp.upload(p_user uuid, p_name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
BEGIN
    PERFORM pg_temp.act(p_user, 'authenticated');
    BEGIN
        INSERT INTO storage.objects (bucket_id, name) VALUES ('facility-permits', p_name);
        RESET ROLE;
        RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    RESET ROLE;
    RETURN v_state;
END;
$$;

-- How many bucket objects p_user can read under p_prefix.
CREATE FUNCTION pg_temp.visible(p_user uuid, p_prefix text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
    v integer;
BEGIN
    PERFORM pg_temp.act(p_user, 'authenticated');
    SELECT count(*) INTO v FROM storage.objects WHERE bucket_id = 'facility-permits' AND name LIKE p_prefix || '%';
    RESET ROLE;
    RETURN v;
END;
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_cora uuid := gen_random_uuid();
    v_quin uuid := gen_random_uuid();
    v_other uuid := gen_random_uuid();
    v_org uuid;
    v_other_org uuid;
    v_season uuid;
    v_division uuid;
    v_team_c uuid;
    v_team_q uuid;
    v_team_x uuid;
    v_venue uuid;
    v_other_venue uuid;
    v_f1 uuid;
    v_f2 uuid;
    v_f_other uuid;
    v_coach_c uuid;
    v_coach_q uuid;
    v_slot uuid;
    v_permit uuid;
    v_res jsonb;
    v_n integer;
    v_audit integer;
    v_state text;
    v_def text;
    v_path1 text;
    v_path2 text;
    v_today date;
BEGIN
    -- ---- 1. posture ----------------------------------------------------------
    FOREACH v_def IN ARRAY ARRAY['facility_permits', 'facility_permit_scopes'] LOOP
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_def)::regclass) THEN
            RAISE EXCEPTION '% has row level security off', v_def;
        END IF;
        IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_def AND cmd = 'SELECT' AND roles = '{authenticated}') <> 1
           OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_def) <> 1 THEN
            RAISE EXCEPTION '% does not have exactly its one SELECT policy for authenticated', v_def;
        END IF;
        IF has_table_privilege('anon', 'public.' || v_def, 'SELECT')
           OR has_table_privilege('authenticated', 'public.' || v_def, 'INSERT')
           OR has_table_privilege('authenticated', 'public.' || v_def, 'UPDATE')
           OR has_table_privilege('authenticated', 'public.' || v_def, 'DELETE') THEN
            RAISE EXCEPTION '% is open to a client write or to anon', v_def;
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('admin_create_facility_permit', 'admin_update_facility_permit', 'admin_set_facility_permit_file',
                             'admin_delete_facility_permit', 'get_facility_permits')
           AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 5 THEN
        RAISE EXCEPTION 'a permit RPC is not a pinned definer for authenticated only';
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('org_local_today', 'coach_field_ids_of', 'facility_permit_json', 'facility_permit_status', 'facility_permit_check')
           AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))) <> 0 THEN
        RAISE EXCEPTION 'an internal permit helper is callable by a client role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'facility-permits' AND public IS NOT TRUE AND file_size_limit = 10485760
                    AND allowed_mime_types @> ARRAY['application/pdf', 'image/jpeg', 'image/png'] AND cardinality(allowed_mime_types) = 3) THEN
        RAISE EXCEPTION 'the facility-permits bucket is not private with a 10 MiB limit and PDF, JPEG and PNG only';
    END IF;
    SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' ' ORDER BY policyname) INTO v_def
      FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
       AND (policyname LIKE 'facility-permits%' OR qual LIKE '%''facility-permits''%' OR with_check LIKE '%''facility-permits''%');
    IF v_def IS DISTINCT FROM 'facility-permits org-admin delete:DELETE:authenticated facility-permits org-admin insert:INSERT:authenticated facility-permits select:SELECT:authenticated' THEN
        RAISE EXCEPTION 'the facility-permits policies are not exactly an admin INSERT and DELETE and a SELECT for authenticated: %', v_def;
    END IF;
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.facility_permits'::regclass
         AND conname IN ('facility_permits_dates', 'facility_permits_file_together', 'facility_permits_file_path_in_folder',
                         'facility_permits_file_mime_allowed', 'facility_permits_file_size_limit', 'facility_permits_issuer_shape')) <> 6 THEN
        RAISE EXCEPTION 'a permit CHECK constraint is missing';
    END IF;
    RAISE NOTICE 'posture: both tables read-only to clients and closed to anon, the five RPCs pinned definers for signed-in users, the helpers closed, the bucket private with its limits and exactly its three policies';

    -- ---- seed ----------------------------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'permit-admin@example.test', '{"password_length": 16}'),
        (v_cora, 'permit-cora@example.test', '{"password_length": 16}'),
        (v_quin, 'permit-quin@example.test', '{"password_length": 16}'),
        (v_other, 'permit-other@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'permit-admin@example.test'), (v_cora, 'permit-cora@example.test'),
        (v_quin, 'permit-quin@example.test'), (v_other, 'permit-other@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Permit Org', 'smoke-permit-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Permit Other', 'smoke-permit-other') RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_cora, 'coach'), (v_org, v_quin, 'coach'), (v_other_org, v_other, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Permit 2026', 'active') RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'Permit U10') RETURNING id INTO v_division;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Permit Cora') RETURNING id INTO v_team_c;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Permit Quin') RETURNING id INTO v_team_q;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Permit Rival') RETURNING id INTO v_team_x;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status) VALUES
        (v_org, v_cora, 'Smoke Cora', 'permit-cora@example.test', 'active') RETURNING id INTO v_coach_c;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status) VALUES
        (v_org, v_quin, 'Smoke Quin', 'permit-quin@example.test', 'active') RETURNING id INTO v_coach_q;
    INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via) VALUES
        (v_org, v_team_c, v_coach_c, 'lead', public.team_local_today(v_team_c) - 30, NULL, 'smoke', NULL),
        (v_org, v_team_q, v_coach_q, 'lead', public.team_local_today(v_team_q) - 30, NULL, 'smoke', NULL);
    INSERT INTO public.locations (organization_id, name, lighting_available) VALUES (v_org, 'Smoke Permit Park', false) RETURNING id INTO v_venue;
    INSERT INTO public.locations (organization_id, name, lighting_available) VALUES (v_other_org, 'Smoke Other Park', false) RETURNING id INTO v_other_venue;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_org, v_venue, 'Smoke Pitch 1', true) RETURNING id INTO v_f1;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_org, v_venue, 'Smoke Pitch 2', true) RETURNING id INTO v_f2;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_other_org, v_other_venue, 'Smoke Other Pitch', true) RETURNING id INTO v_f_other;
    -- Cora's team plays at Pitch 1; Quin's at Pitch 2.
    INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index) VALUES (v_org, v_f1, current_date + 7, 1) RETURNING id INTO v_slot;
    INSERT INTO public.games (organization_id, game_slot_id, home_team_id, away_team_id) VALUES (v_org, v_slot, v_team_c, v_team_x);
    INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index) VALUES (v_org, v_f2, current_date + 7, 1) RETURNING id INTO v_slot;
    INSERT INTO public.games (organization_id, game_slot_id, home_team_id, away_team_id) VALUES (v_org, v_slot, v_team_q, v_team_x);
    v_today := public.org_local_today(v_org);

    -- ---- 2. the writer -------------------------------------------------------
    PERFORM pg_temp.act(v_admin, 'authenticated');
    v_res := public.admin_create_facility_permit(v_org, ' Smoke Parks ', ' 007 ', v_today - 5, v_today + 10, 'smoke', ARRAY[]::uuid[], ARRAY[v_f1]);
    v_permit := (v_res ->> 'id')::uuid;
    IF v_res ->> 'permit_number' <> '007' OR v_res ->> 'status' <> 'expiring' OR (v_res ->> 'days_left')::int <> 10 THEN
        RAISE EXCEPTION 'the permit came back as %', v_res;
    END IF;
    RESET ROLE;
    SELECT count(*) INTO v_audit FROM public.audit_log WHERE resource_id = v_permit AND metadata ->> 'operation' = 'created';
    IF v_audit <> 1 THEN RAISE EXCEPTION 'expected one audit row for the created permit, found %', v_audit; END IF;

    PERFORM pg_temp.act(v_admin, 'authenticated');
    FOR v_state IN SELECT unnest(ARRAY['dates', 'noscope', 'otherorg']) LOOP
        BEGIN
            IF v_state = 'dates' THEN
                PERFORM public.admin_create_facility_permit(v_org, 'X', NULL, v_today, v_today - 1, NULL, ARRAY[]::uuid[], ARRAY[v_f1]);
            ELSIF v_state = 'noscope' THEN
                PERFORM public.admin_create_facility_permit(v_org, 'X', NULL, v_today, v_today, NULL, ARRAY[]::uuid[], ARRAY[]::uuid[]);
            ELSE
                PERFORM public.admin_create_facility_permit(v_org, 'X', NULL, v_today, v_today, NULL, ARRAY[]::uuid[], ARRAY[v_f_other]);
            END IF;
            RAISE EXCEPTION 'the % refusal did not fire', v_state;
        EXCEPTION WHEN invalid_parameter_value THEN NULL;
        END;
    END LOOP;
    RESET ROLE;
    SELECT count(*) INTO v_audit FROM public.audit_log WHERE organization_id = v_org AND metadata ->> 'setting' = 'facility.permit';
    IF v_audit <> 1 OR (SELECT count(*) FROM public.facility_permits WHERE organization_id = v_org) <> 1 THEN
        RAISE EXCEPTION 'a refusal wrote a permit or an audit row';
    END IF;

    FOREACH v_def IN ARRAY ARRAY['coach', 'other'] LOOP
        PERFORM pg_temp.act(CASE v_def WHEN 'coach' THEN v_cora ELSE v_other END, 'authenticated');
        BEGIN
            PERFORM public.admin_create_facility_permit(v_org, 'X', NULL, v_today, v_today, NULL, ARRAY[]::uuid[], ARRAY[v_f1]);
            RAISE EXCEPTION 'the % was allowed to create a permit', v_def;
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
    END LOOP;
    RESET ROLE;
    RAISE NOTICE 'writer: a permit is recorded trimmed with its status and one audit row; wrong dates, no scope and another organization''s field are refused (22023) and write nothing; a coach and another organization''s admin are refused (42501)';

    -- ---- 3. the coach read ---------------------------------------------------
    PERFORM pg_temp.act(v_cora, 'authenticated');
    IF jsonb_array_length(public.get_facility_permits(v_org) -> 'permits') <> 1
       OR (SELECT count(*) FROM public.facility_permits) <> 1 THEN
        RAISE EXCEPTION 'the coach whose team plays at the field did not read its permit';
    END IF;
    BEGIN
        INSERT INTO public.facility_permits (organization_id, issuer, valid_from, valid_to) VALUES (v_org, 'Direct', v_today, v_today);
        RAISE EXCEPTION 'a direct insert was allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    PERFORM pg_temp.act(v_quin, 'authenticated');
    IF jsonb_array_length(public.get_facility_permits(v_org) -> 'permits') <> 0
       OR (SELECT count(*) FROM public.facility_permits) <> 0
       OR (SELECT count(*) FROM public.facility_permit_scopes) <> 0 THEN
        RAISE EXCEPTION 'the coach whose team is scheduled elsewhere read a permit';
    END IF;
    PERFORM pg_temp.act(v_other, 'authenticated');
    BEGIN
        PERFORM public.get_facility_permits(v_org);
        RAISE EXCEPTION 'another organization''s admin read the permits';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    RAISE NOTICE 'coach read: the coach of a team with a game at the field reads the permit, the coach of a team scheduled elsewhere reads none, another organization''s admin is refused, and a direct insert is refused';

    -- ---- 4. the file ---------------------------------------------------------
    v_path1 := v_org || '/' || v_permit || '/' || gen_random_uuid() || '.pdf';
    v_path2 := v_org || '/' || v_permit || '/' || gen_random_uuid() || '.png';
    PERFORM pg_temp.act(v_admin, 'authenticated');
    BEGIN
        PERFORM public.admin_set_facility_permit_file(v_org, v_permit, v_path1, 'smoke.pdf');
        RAISE EXCEPTION 'a file that was never uploaded was attached';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    RESET ROLE;
    IF pg_temp.upload(v_cora, v_path1) <> '42501' THEN RAISE EXCEPTION 'a coach was allowed to upload'; END IF;
    IF pg_temp.upload(v_other, v_path1) <> '42501' THEN RAISE EXCEPTION 'another organization''s admin was allowed to upload'; END IF;
    IF pg_temp.upload(v_admin, v_path1) <> 'ok' OR pg_temp.upload(v_admin, v_path2) <> 'ok' THEN
        RAISE EXCEPTION 'an admin was refused an upload under a real permit''s folder';
    END IF;
    IF pg_temp.upload(v_admin, v_org || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.pdf') <> '42501' THEN
        RAISE EXCEPTION 'an upload under a folder holding no permit was allowed';
    END IF;
    -- The Storage API records the type and size; the harness's stand-in records nothing, so say it.
    UPDATE storage.objects SET metadata = '{"size": 4096, "mimetype": "application/pdf"}' WHERE bucket_id = 'facility-permits' AND name = v_path1;
    UPDATE storage.objects SET metadata = '{"size": 8192, "mimetype": "image/png"}' WHERE bucket_id = 'facility-permits' AND name = v_path2;
    PERFORM pg_temp.act(v_admin, 'authenticated');
    v_res := public.admin_set_facility_permit_file(v_org, v_permit, v_path1, 'smoke.pdf');
    IF v_res ->> 'previous_path' IS NOT NULL OR v_res -> 'permit' -> 'file' ->> 'mime' <> 'application/pdf' THEN
        RAISE EXCEPTION 'the first file came back as %', v_res;
    END IF;
    v_res := public.admin_set_facility_permit_file(v_org, v_permit, v_path2, 'smoke.png');
    IF v_res ->> 'previous_path' IS DISTINCT FROM v_path1 THEN RAISE EXCEPTION 'the replace did not return the first path: %', v_res; END IF;
    RESET ROLE;
    IF pg_temp.visible(v_admin, v_org::text) <> 2 THEN RAISE EXCEPTION 'an admin did not read both objects'; END IF;
    IF pg_temp.visible(v_cora, v_org::text) <> 1 THEN RAISE EXCEPTION 'the coach did not read exactly the live file'; END IF;
    IF pg_temp.visible(v_quin, v_org::text) <> 0 OR pg_temp.visible(v_other, v_org::text) <> 0 THEN
        RAISE EXCEPTION 'a coach scheduled elsewhere, or another organization''s admin, read an object';
    END IF;
    PERFORM pg_temp.act(NULL, 'anon');
    IF (SELECT count(*) FROM storage.objects WHERE bucket_id = 'facility-permits') <> 0 THEN RAISE EXCEPTION 'anon read an object'; END IF;
    RESET ROLE;
    RAISE NOTICE 'file: a missing object is refused, an admin uploads and attaches, a replace returns the first path, the coach reads the live file and not the replaced one, and a coach, another organization''s admin and anon are refused';

    -- ---- 5. delete -----------------------------------------------------------
    PERFORM pg_temp.act(v_admin, 'authenticated');
    v_res := public.admin_delete_field(v_org, v_f1);
    IF v_res ->> 'deleted' <> 'false' OR v_res ->> 'reason' <> 'bookings_exist'
       OR NOT jsonb_path_exists(v_res -> 'affected', '$[*] ? (@.kind == "permit" && @.disposition == "unlinked")') THEN
        RAISE EXCEPTION 'the field with a permit and a game was not refused listing the permit: %', v_res;
    END IF;
    v_res := public.admin_delete_field(v_org, v_f1, true);
    IF v_res ->> 'deleted' <> 'true' THEN RAISE EXCEPTION 'the confirmed delete did not proceed: %', v_res; END IF;
    RESET ROLE;
    IF (SELECT count(*) FROM public.facility_permits WHERE id = v_permit) <> 1
       OR (SELECT count(*) FROM public.facility_permit_scopes WHERE permit_id = v_permit) <> 0 THEN
        RAISE EXCEPTION 'deleting the field did not leave the permit with no scope';
    END IF;
    PERFORM pg_temp.act(v_admin, 'authenticated');
    v_res := public.admin_delete_facility_permit(v_org, v_permit);
    IF v_res ->> 'file_path' IS DISTINCT FROM v_path2 THEN RAISE EXCEPTION 'the delete did not return the live file path: %', v_res; END IF;
    RESET ROLE;
    IF (SELECT count(*) FROM public.facility_permits WHERE id = v_permit) <> 0 THEN RAISE EXCEPTION 'the permit was not deleted'; END IF;
    RAISE NOTICE 'delete: the field delete lists the permit as unlinked and, confirmed, leaves it with no scope; deleting the permit returns its file path';
END;
$$;

ROLLBACK;
