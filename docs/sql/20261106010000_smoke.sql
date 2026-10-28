-- Smoke checks for 20261106010000_play_up_requested.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   * the finalizer, as an admin, on rows staged directly: the play-up column is stored as
--     `players.play_up_requested` (yes, true, y, t, 1 and x, in any case, are a request; no,
--     maybe and a blank are none), under each accepted key (`play_up`, `play up`, the GotSport
--     question); a re-import row without the column leaves the player's request alone, one with
--     it rewrites the request, and one with it BLANK withdraws it (a blank cell is a present
--     column, not an absent one); the text copy `custom_attributes.play_up` is not written;
--   * the player writers set and clear the request, alone and in bulk, and refuse a non-boolean
--     22023; a player's other fields are left as they were by a patch that names only the flag.
--
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_job1 uuid := gen_random_uuid();
    v_job2 uuid := gen_random_uuid();
    v_result jsonb;
    v_got text;
    v_p uuid;
    v_denied integer := 0;
    v_base jsonb := '{"last_name": "Pu"}'::jsonb;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'pu-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'pu-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Play Up', 'smoke-org-play-up')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin');
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
        (v_job1, v_org, 'registration', 'smoke/pu-1.csv', 'processing', v_admin),
        (v_job2, v_org, 'registration', 'smoke/pu-2.csv', 'processing', v_admin);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job1, 1, '{}'::jsonb, v_base || '{"first_name": "Yes", "external_registration_id": "PU-1", "play_up": "Yes"}'::jsonb),
        (v_org, v_job1, 2, '{}'::jsonb, v_base || '{"first_name": "True", "external_registration_id": "PU-2", "play up": "TRUE"}'::jsonb),
        (v_org, v_job1, 3, '{}'::jsonb, v_base || '{"first_name": "One", "external_registration_id": "PU-3", "play_up": "1"}'::jsonb),
        (v_org, v_job1, 4, '{}'::jsonb, v_base || '{"first_name": "Ex", "external_registration_id": "PU-4", "play_up": " x "}'::jsonb),
        (v_org, v_job1, 5, '{}'::jsonb, v_base || '{"first_name": "Question", "external_registration_id": "PU-5",
             "are you coaching so this player can play up a division?": "y"}'::jsonb),
        (v_org, v_job1, 6, '{}'::jsonb, v_base || '{"first_name": "No", "external_registration_id": "PU-6", "play_up": "no"}'::jsonb),
        (v_org, v_job1, 7, '{}'::jsonb, v_base || '{"first_name": "Maybe", "external_registration_id": "PU-7", "play_up": "maybe"}'::jsonb),
        (v_org, v_job1, 8, '{}'::jsonb, v_base || '{"first_name": "Absent", "external_registration_id": "PU-8"}'::jsonb),
        (v_org, v_job2, 1, '{}'::jsonb, v_base || '{"first_name": "Yes", "external_registration_id": "PU-1"}'::jsonb),
        (v_org, v_job2, 2, '{}'::jsonb, v_base || '{"first_name": "True", "external_registration_id": "PU-2", "play_up": "no"}'::jsonb),
        (v_org, v_job2, 3, '{}'::jsonb, v_base || '{"first_name": "No", "external_registration_id": "PU-6", "play_up": "yes"}'::jsonb),
        (v_org, v_job2, 4, '{}'::jsonb, v_base || '{"first_name": "Question", "external_registration_id": "PU-5", "play_up": ""}'::jsonb);

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    v_result := public.finalize_import_job(v_job1);
    IF (v_result->>'inserted_players')::int <> 8 THEN
        RAISE EXCEPTION 'the finalizer did not insert all 8 rows: %', v_result;
    END IF;
    SELECT string_agg(first_name || ':' || play_up_requested::text, ',' ORDER BY first_name)
      INTO v_got FROM public.players WHERE organization_id = v_org;
    IF v_got IS DISTINCT FROM 'Absent:false,Ex:true,Maybe:false,No:false,One:true,Question:true,True:true,Yes:true' THEN
        RAISE EXCEPTION 'the stored requests are not what each spelling reads as: %', v_got;
    END IF;
    IF EXISTS (SELECT 1 FROM public.players WHERE organization_id = v_org AND custom_attributes ? 'play_up') THEN
        RAISE EXCEPTION 'the play-up column is still written as text in custom_attributes';
    END IF;
    RAISE NOTICE 'finalize: yes, true, 1, x and y (under play_up, play up and the GotSport question) are a request; no, maybe and an absent column are none; no text copy kept';

    v_result := public.finalize_import_job(v_job2);
    IF (v_result->>'updated_players')::int <> 4 THEN
        RAISE EXCEPTION 'the re-import did not update its 4 players: %', v_result;
    END IF;
    SELECT string_agg(first_name || ':' || play_up_requested::text, ',' ORDER BY first_name)
      INTO v_got FROM public.players WHERE organization_id = v_org AND first_name IN ('Yes', 'True', 'No', 'Question');
    IF v_got IS DISTINCT FROM 'No:true,Question:false,True:false,Yes:true' THEN
        RAISE EXCEPTION 'a re-import did not keep an absent column and rewrite a present one: %', v_got;
    END IF;
    RAISE NOTICE 're-import: an absent column leaves the request (Yes), a present one rewrites it (True to none, No to a request), a blank one withdraws it (Question)';

    SELECT id INTO v_p FROM public.players WHERE organization_id = v_org AND first_name = 'Absent';
    SET LOCAL ROLE authenticated;
    PERFORM public.admin_update_player(v_p, '{"play_up_requested": true}');
    IF NOT (SELECT play_up_requested FROM public.players WHERE id = v_p) THEN
        RAISE EXCEPTION 'the patch did not set the request';
    END IF;
    PERFORM public.admin_update_player(v_p, '{"play_up_requested": false}');
    IF (SELECT play_up_requested FROM public.players WHERE id = v_p) THEN
        RAISE EXCEPTION 'the patch did not clear the request';
    END IF;
    PERFORM public.admin_bulk_update_players(ARRAY[v_p], '{"play_up_requested": true}');
    IF NOT (SELECT play_up_requested FROM public.players WHERE id = v_p) THEN
        RAISE EXCEPTION 'the bulk patch did not set the request';
    END IF;
    PERFORM public.admin_update_player(v_p, '{"jersey_number": 4}');
    IF NOT (SELECT play_up_requested FROM public.players WHERE id = v_p) THEN
        RAISE EXCEPTION 'a patch that does not name the request cleared it';
    END IF;
    BEGIN
        PERFORM public.admin_update_player(v_p, '{"play_up_requested": "yes"}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM public.admin_update_player(v_p, '{"play_up_requested": null}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
    IF v_denied <> 2 THEN
        RAISE EXCEPTION 'only % of 2 non-boolean requests were refused 22023', v_denied;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log
                    WHERE organization_id = v_org AND metadata::text LIKE '%play_up_requested%') THEN
        RAISE EXCEPTION 'the patch left no audit row naming the request';
    END IF;
    RAISE NOTICE 'player writers: the request is set and cleared (alone and in bulk), left alone by a patch that does not name it, a non-boolean refused 22023, and audited';
END;
$$;

ROLLBACK;
