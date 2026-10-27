-- Smoke checks for 20261104010000_admin_only.sql
--
-- Run on the database built to head (so 20261104020000 has dropped coaches.user_id and profile_id),
-- inside one transaction that is ROLLED BACK.
--
--   1. Posture: the role checks admit exactly admin, staff and tenant_admin (members) and admin and
--      staff (invites); the 14 coach-only functions are gone and no function body names one; the
--      permit view has one signature and no client may call it; the six narrowed read policies are
--      exactly is_org_admin(organization_id), the calendar-token and permit-object policies are admin
--      reads, and `coaches` has the one read policy; the replaced definers keep their pins and
--      grants; the coach key is the per-organization pair; the coach import takes
--      child_registration_id and the player import does not; reconcile_prod_rls_drift() runs clean.
--   2. As a user: an admin reads the coach, the assignment, the permit and the roster; a signed-in
--      non-member and another organization's admin read none and are refused each RPC with 42501;
--      create_org_invite and admin_change_member_role refuse `coach` with 22023.
--   3. Defence in depth: with the role check lifted for this transaction only (and the member
--      written past it), a member holding the retired `coach` role still reads none of the coach
--      data and is refused the permit and roster RPCs, because no policy or function has a coach arm
--      any more.
--   4. The coach key: one email in two organizations is two rows; the same email twice in one
--      organization is refused (23505); a mixed-case or padded email is refused (23514).
--   5. The coach import (S7): finalize_coach_import_job imports an address another organization
--      already holds as a new coach of this one (and leaves the other's alone), links the children
--      named by registration id that are this organization's players, in file order, and reports
--      the ids that match none (an unknown one and another organization's) without writing them.
--
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

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

-- Runs a statement as the current role and returns 'ok' or the SQLSTATE it raised.
CREATE FUNCTION pg_temp.state_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
BEGIN
    BEGIN
        EXECUTE p_sql;
        RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    RETURN v_state;
END;
$$;

-- What the current role reads of the coach data in one organization: coaches/assignments/permits/scopes.
CREATE FUNCTION pg_temp.reads(p_org uuid) RETURNS text LANGUAGE sql AS $$
    SELECT (SELECT count(*) FROM public.coaches WHERE organization_id = p_org)::text || '/'
        || (SELECT count(*) FROM public.team_coach_assignments WHERE organization_id = p_org)::text || '/'
        || (SELECT count(*) FROM public.facility_permits WHERE organization_id = p_org)::text || '/'
        || (SELECT count(*) FROM public.facility_permit_scopes WHERE organization_id = p_org)::text
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_user uuid := gen_random_uuid();     -- signed in, a member of nothing
    v_other uuid := gen_random_uuid();    -- admin of the other organization
    v_org uuid;
    v_other_org uuid;
    v_season uuid;
    v_division uuid;
    v_team uuid;
    v_venue uuid;
    v_field uuid;
    v_coach uuid;
    v_permit uuid;
    v_n integer;
    v_def text;
    v_state text;
    v_res jsonb;
BEGIN
    -- ---- 1. posture ----------------------------------------------------------
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'organization_members_role_check';
    IF v_def IS DISTINCT FROM $d$CHECK ((role = ANY (ARRAY['admin'::text, 'staff'::text, 'tenant_admin'::text])))$d$ THEN
        RAISE EXCEPTION 'organization_members_role_check is %', v_def;
    END IF;
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'organization_invites_role_check';
    IF v_def IS DISTINCT FROM $d$CHECK ((role = ANY (ARRAY['admin'::text, 'staff'::text])))$d$ THEN
        RAISE EXCEPTION 'organization_invites_role_check is %', v_def;
    END IF;

    SELECT count(*) INTO v_n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('link_my_coach_record', 'get_my_division_teams', 'admin_get_division_teams', 'division_teams_of',
                       'get_my_coached_team_ids', 'admin_get_coached_team_ids', 'request_coach_practice_preference',
                       'caller_coaches_practice_slot', 'coach_reads_facility_permit_file', 'coach_reads_facility_permit',
                       'coach_covers_permit_scope', 'coach_field_ids_of', 'coached_team_ids_of', 'is_current_team_coach');
    IF v_n <> 0 THEN RAISE EXCEPTION '% coach-only function(s) are back', v_n; END IF;
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_def
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
              ~ '(link_my_coach_record|coached_team_ids_of|get_my_coached_team_ids|admin_get_coached_team_ids|is_current_team_coach|division_teams_of|get_my_division_teams|admin_get_division_teams|request_coach_practice_preference|caller_coaches_practice_slot|coach_field_ids_of|coach_covers_permit_scope|coach_reads_facility_permit|p_coach_only)');
    IF v_def IS NOT NULL THEN RAISE EXCEPTION 'a function still names a dropped coach object: %', v_def; END IF;

    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'facility_permit_json') <> 1
       OR to_regprocedure('public.facility_permit_json(uuid, date)') IS NULL
       OR has_function_privilege('authenticated', 'public.facility_permit_json(uuid, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.facility_permit_json(uuid, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'facility_permit_json is not the one two-argument function closed to clients';
    END IF;

    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND cmd = 'SELECT' AND qual = 'is_org_admin(organization_id)'
       AND (tablename, policyname) IN (('coaches', 'coaches_select_admin'),
                                       ('team_coach_assignments', 'team_coach_assignments_select_admin'),
                                       ('coach_practice_preferences', 'Coach practice preferences: admins read'),
                                       ('practice_lighting_overrides', 'Practice lighting overrides: admins read'),
                                       ('facility_permits', 'Facility permits: admins select'),
                                       ('facility_permit_scopes', 'Facility permit scopes: admins select'));
    IF v_n <> 6 THEN RAISE EXCEPTION 'only % of the 6 narrowed read policies are exactly the admin expression', v_n; END IF;
    SELECT qual INTO v_def FROM pg_policies WHERE schemaname = 'public' AND tablename = 'team_calendar_tokens' AND policyname = 'team_calendar_tokens_select';
    IF v_def IS NULL OR v_def !~ 'is_org_admin' OR v_def ~* 'coach' THEN RAISE EXCEPTION 'the calendar token read is %', v_def; END IF;
    SELECT qual INTO v_def FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'facility-permits select';
    IF v_def IS NULL OR v_def !~ 'is_org_admin' OR v_def ~* 'coach' THEN RAISE EXCEPTION 'the permit object read is %', v_def; END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'coaches' AND cmd IN ('SELECT', 'ALL')) <> 1 THEN
        RAISE EXCEPTION 'coaches does not have exactly one read policy';
    END IF;

    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.get_team_roster(uuid)'::regprocedure, 'public.get_team_staff(uuid)'::regprocedure,
                     'public.rotate_calendar_token(uuid)'::regprocedure, 'public.create_org_invite(uuid, text, interval)'::regprocedure,
                     'public.admin_change_member_role(uuid, uuid, text)'::regprocedure, 'public.get_facility_permits(uuid)'::regprocedure,
                     'public.finalize_coach_import_job(uuid, jsonb)'::regprocedure, 'public.rollback_coach_import_job(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 8 THEN RAISE EXCEPTION 'only % of the 8 replaced definers kept their pin and grants', v_n; END IF;

    SELECT string_agg(conname, ',' ORDER BY conname) INTO v_def FROM pg_constraint
     WHERE conrelid = 'public.coaches'::regclass AND contype IN ('u', 'c')
       AND conname IN ('coaches_email_key', 'coaches_organization_id_email_key', 'coaches_email_normalised');
    IF v_def IS DISTINCT FROM 'coaches_email_normalised,coaches_organization_id_email_key' THEN
        RAISE EXCEPTION 'the coach email keys are %', v_def;
    END IF;
    IF NOT ('child_registration_id' = ANY (public.import_allowed_keys('coaches')))
       OR 'child_registration_id' = ANY (public.import_allowed_keys('players')) THEN
        RAISE EXCEPTION 'child_registration_id is not exactly a coach import key';
    END IF;
    v_res := public.reconcile_prod_rls_drift();
    IF jsonb_array_length(v_res -> 'created') <> 0 OR jsonb_array_length(v_res -> 'dropped') <> 0 THEN
        RAISE EXCEPTION 'reconcile_prod_rls_drift changed something at head: %', v_res;
    END IF;
    RAISE NOTICE 'posture: roles, dropped functions, policies, pins, the coach key and the reconcile spec are as designed';

    -- ---- seed ----------------------------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'ao-admin@example.test', '{"password_length": 16}'),
        (v_user, 'ao-user@example.test', '{"password_length": 16}'),
        (v_other, 'ao-other@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'ao-admin@example.test'), (v_user, 'ao-user@example.test'),
        (v_other, 'ao-other@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Admin Only', 'smoke-admin-only') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Admin Only Other', 'smoke-admin-only-other') RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_other_org, v_other, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'AO 2026', 'active') RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'AO U10') RETURNING id INTO v_division;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'AO Team') RETURNING id INTO v_team;
    INSERT INTO public.locations (organization_id, name, lighting_available) VALUES (v_org, 'AO Park', false) RETURNING id INTO v_venue;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_org, v_venue, 'AO Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_org, 'AO Coach', 'ao-coach@example.test', 'active') RETURNING id INTO v_coach;
    INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via)
        VALUES (v_org, v_team, v_coach, 'lead', public.team_local_today(v_team) - 2, 'smoke');
    INSERT INTO public.facility_permits (organization_id, issuer, valid_from, valid_to)
        VALUES (v_org, 'AO Permit', current_date - 2, current_date + 30) RETURNING id INTO v_permit;
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id) VALUES (v_permit, v_org, v_field);

    -- ---- 2. as a user --------------------------------------------------------
    PERFORM pg_temp.act(v_admin, 'authenticated');
    IF pg_temp.reads(v_org) <> '1/1/1/1' THEN RAISE EXCEPTION 'the admin reads %', pg_temp.reads(v_org); END IF;
    IF jsonb_array_length(public.get_facility_permits(v_org) -> 'permits') <> 1 THEN
        RAISE EXCEPTION 'get_facility_permits did not return the admin the permit';
    END IF;
    PERFORM public.get_team_roster(v_team);
    PERFORM public.get_team_staff(v_team);
    IF public.rotate_calendar_token(v_team) ->> 'status' <> 'success' THEN
        RAISE EXCEPTION 'the admin could not rotate the team''s calendar token';
    END IF;
    IF pg_temp.state_of(format('SELECT * FROM public.create_org_invite(%L, ''coach'')', v_org)) <> '22023' THEN
        RAISE EXCEPTION 'create_org_invite did not refuse the coach role with 22023';
    END IF;
    IF pg_temp.state_of(format('SELECT public.admin_change_member_role(%L, %L, ''coach'')', v_org, v_admin)) <> '22023' THEN
        RAISE EXCEPTION 'admin_change_member_role did not refuse the coach role with 22023';
    END IF;
    RESET ROLE;

    FOREACH v_def IN ARRAY ARRAY['non-member', 'other-admin'] LOOP
        PERFORM pg_temp.act(CASE v_def WHEN 'non-member' THEN v_user ELSE v_other END, 'authenticated');
        IF pg_temp.reads(v_org) <> '0/0/0/0' THEN RAISE EXCEPTION 'the % reads %', v_def, pg_temp.reads(v_org); END IF;
        FOR v_state IN SELECT format(q, v_org, v_team) FROM unnest(ARRAY[
            'SELECT public.get_facility_permits(%1$L)',
            'SELECT * FROM public.get_team_roster(%2$L)',
            'SELECT * FROM public.get_team_staff(%2$L)']) q LOOP
            IF pg_temp.state_of(v_state) <> '42501' THEN
                RAISE EXCEPTION 'the % was not refused with 42501: %', v_def, v_state;
            END IF;
        END LOOP;
        -- rotate_calendar_token reports a refusal in its result rather than raising.
        IF public.rotate_calendar_token(v_team) ->> 'status' <> 'error' THEN
            RAISE EXCEPTION 'the % rotated the team''s calendar token', v_def;
        END IF;
        RESET ROLE;
    END LOOP;
    RAISE NOTICE 'as a user: an admin reads and writes; a non-member and another organization''s admin are refused with 42501';

    -- ---- 3. the coach key ----------------------------------------------------
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_other_org, 'AO Coach Elsewhere', 'ao-coach@example.test', 'active');
    IF (SELECT count(*) FROM public.coaches WHERE email = 'ao-coach@example.test') <> 2 THEN
        RAISE EXCEPTION 'one email in two organizations is not two rows';
    END IF;
    IF pg_temp.state_of(format($q$INSERT INTO public.coaches (organization_id, full_name, email, status) VALUES (%L, 'Twice', 'ao-coach@example.test', 'active')$q$, v_org)) <> '23505' THEN
        RAISE EXCEPTION 'the same email twice in one organization was not refused with 23505';
    END IF;
    FOREACH v_def IN ARRAY ARRAY['AO-Mixed@example.test', ' ao-padded@example.test'] LOOP
        IF pg_temp.state_of(format($q$INSERT INTO public.coaches (organization_id, full_name, email, status) VALUES (%L, 'Shape', %L, 'active')$q$, v_org, v_def)) <> '23514' THEN
            RAISE EXCEPTION 'the email "%" was not refused with 23514', v_def;
        END IF;
    END LOOP;
    RAISE NOTICE 'the coach key: one row per organization and email, stored lower-case and trimmed';

    -- ---- 4. the coach import (S7): an email scoped to the organization, and the coach's children ----
    -- The other organization already has a coach with the address the file brings; two players of
    -- this organization and one of the other carry registration ids the file names.
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_other_org, 'AO Other Org Coach', 'ao-shared@example.test', 'active');
    INSERT INTO public.players (organization_id, first_name, last_name, external_registration_id) VALUES
        (v_org, 'Kid', 'One', 'AO-1'), (v_org, 'Kid', 'Two', 'AO-2'), (v_other_org, 'Kid', 'Elsewhere', 'AO-X');
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, total_rows)
        VALUES ('a0a0a0a0-0000-4000-8000-0000000000b1', v_org, 'registration', 'ao/coaches.csv', 'importing', v_admin, 2);
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number,
                                            raw_payload, normalized_payload, validation_errors) VALUES
        (v_org, 'a0a0a0a0-0000-4000-8000-0000000000b1', 'coaches', 1, '{}'::jsonb,
         jsonb_build_object('full_name', 'AO Shared Coach', 'email', 'ao-shared@example.test',
                            'child_registration_id', 'AO-1; AO-2, AO-9, AO-X, AO-1'), '[]'::jsonb),
        (v_org, 'a0a0a0a0-0000-4000-8000-0000000000b1', 'coaches', 2, '{}'::jsonb,
         jsonb_build_object('full_name', 'AO Plain Coach', 'email', 'ao-plain@example.test'), '[]'::jsonb);
    PERFORM pg_temp.act(v_admin, 'authenticated');
    v_res := public.finalize_coach_import_job('a0a0a0a0-0000-4000-8000-0000000000b1', '[]'::jsonb);
    RESET ROLE;
    IF (v_res ->> 'inserted_coaches')::int <> 2 OR (v_res ->> 'updated_coaches')::int <> 0
       OR (v_res ->> 'invalid_rows')::int <> 0 THEN
        RAISE EXCEPTION 'the same email in another organization was not imported as a new coach: %', v_res;
    END IF;
    IF (v_res ->> 'linked_children')::int <> 2 OR (v_res ->> 'unmatched_child_id_count')::int <> 2
       OR v_res ->> 'status' <> 'completed_with_warnings'
       OR (SELECT array_agg(x ->> 'registration_id' ORDER BY x ->> 'registration_id')
             FROM jsonb_array_elements(v_res -> 'unmatched_child_ids') x) IS DISTINCT FROM ARRAY['AO-9', 'AO-X'] THEN
        RAISE EXCEPTION 'the child links or the unmatched ids are not as designed: %', v_res;
    END IF;
    IF (SELECT array_agg(p.external_registration_id ORDER BY r.slot)
          FROM public.coach_team_requests r
          JOIN public.players p ON p.id = r.player_id
          JOIN public.coaches c ON c.id = r.coach_id
         WHERE c.email = 'ao-shared@example.test' AND c.organization_id = v_org) IS DISTINCT FROM ARRAY['AO-1', 'AO-2']
       OR (SELECT count(*) FROM public.coach_team_requests WHERE organization_id = v_other_org) <> 0 THEN
        RAISE EXCEPTION 'the coach''s links are not exactly this organization''s AO-1 and AO-2, in order';
    END IF;
    IF (SELECT full_name FROM public.coaches WHERE organization_id = v_other_org AND email = 'ao-shared@example.test')
       IS DISTINCT FROM 'AO Other Org Coach' THEN
        RAISE EXCEPTION 'the import touched the other organization''s coach';
    END IF;
    RAISE NOTICE 'coach import: one email in two organizations imported as two coaches; 2 of 4 child ids linked in file order, the unknown one and another organization''s reported, nothing written for them';
END;
$$;

ROLLBACK;
