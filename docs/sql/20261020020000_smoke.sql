-- Smoke checks for 20261020020000_drop_player_medical_columns.sql
--
-- What it proves, as an organization admin (prelude.sql stubs `auth.uid()` from
-- `request.jwt.claim.sub`):
--   * `players.medical_info` and `players.emergency_contacts` are gone;
--   * `finalize_import_job` still imports: a staged row carrying `medical_info`
--     and `medical` keys (as a direct insert into `staging_players` could)
--     becomes a player, its other custom attribute kept and neither medical
--     key stored anywhere on the row;
--   * a re-import of the same player (the UPDATE branch) does the same;
--   * the posture is unchanged: SECURITY DEFINER, search_path=public, EXECUTE
--     for authenticated and not anon.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_job1 uuid := gen_random_uuid();
    v_job2 uuid := gen_random_uuid();
    v_result jsonb;
    v_player public.players%ROWTYPE;
    v_payload jsonb := jsonb_build_object(
        'first_name', 'Smoke', 'last_name', 'Nomedical', 'date_of_birth', '2016-04-01',
        'external_registration_id', 'SMOKE-NOMED-1', 'shirt_size', 'YM',
        'medical_info', 'smoke medical text', 'medical', 'smoke medical text');
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'public.players'::regclass
                  AND attname IN ('medical_info', 'emergency_contacts') AND NOT attisdropped) THEN
        RAISE EXCEPTION 'players still has a medical_info or emergency_contacts column';
    END IF;
    RAISE NOTICE 'players has no medical_info or emergency_contacts column';

    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'nomed-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'nomed-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Nomed', 'smoke-org-nomed')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin');
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
        (v_job1, v_org, 'registration', 'smoke/nomed-1.csv', 'processing', v_admin),
        (v_job2, v_org, 'registration', 'smoke/nomed-2.csv', 'processing', v_admin);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job1, 1, '{}'::jsonb, v_payload),
        (v_org, v_job2, 1, '{}'::jsonb, v_payload || '{"shirt_size": "YL"}'::jsonb);

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- (a) The INSERT branch.
    v_result := public.finalize_import_job(v_job1);
    IF (v_result->>'inserted_players')::int <> 1 THEN
        RAISE EXCEPTION 'the first import did not insert its player: %', v_result;
    END IF;
    SELECT * INTO v_player FROM public.players
     WHERE organization_id = v_org AND external_registration_id = 'SMOKE-NOMED-1';
    IF v_player.custom_attributes->>'shirt_size' IS DISTINCT FROM 'YM' THEN
        RAISE EXCEPTION 'the first import lost its other custom attribute: %', v_player.custom_attributes;
    END IF;
    IF to_jsonb(v_player)::text LIKE '%smoke medical text%' THEN
        RAISE EXCEPTION 'the first import stored the medical text on the player: %', to_jsonb(v_player);
    END IF;
    RAISE NOTICE 'the INSERT branch imported the player, kept its other attribute and stored no medical key';

    -- (b) The UPDATE branch.
    v_result := public.finalize_import_job(v_job2);
    IF (v_result->>'updated_players')::int <> 1 THEN
        RAISE EXCEPTION 'the re-import did not update its player: %', v_result;
    END IF;
    SELECT * INTO v_player FROM public.players
     WHERE organization_id = v_org AND external_registration_id = 'SMOKE-NOMED-1';
    IF v_player.custom_attributes->>'shirt_size' IS DISTINCT FROM 'YL' THEN
        RAISE EXCEPTION 'the re-import did not update the other custom attribute: %', v_player.custom_attributes;
    END IF;
    IF to_jsonb(v_player)::text LIKE '%smoke medical text%' THEN
        RAISE EXCEPTION 'the re-import stored the medical text on the player: %', to_jsonb(v_player);
    END IF;
    RAISE NOTICE 'the UPDATE branch updated the player and stored no medical key';

    -- (c) Posture.
    IF NOT (SELECT p.prosecdef AND p.proconfig <@ ARRAY['search_path=public','TimeZone=UTC'] AND 'search_path=public' = ANY (p.proconfig)
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              FROM pg_proc p
             WHERE p.oid = 'public.finalize_import_job(uuid, jsonb)'::regprocedure) THEN
        RAISE EXCEPTION 'finalize_import_job lost its posture (definer, search_path, grants)';
    END IF;
    RAISE NOTICE 'posture unchanged: SECURITY DEFINER, search_path=public, EXECUTE for authenticated and not anon';
END;
$$;

ROLLBACK;
