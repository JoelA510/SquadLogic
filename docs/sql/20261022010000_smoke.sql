-- Smoke checks for 20261022010000_import_allowlist_and_purge.sql
--
-- What it proves, as an organization admin (prelude.sql stubs `auth.uid()` from
-- `request.jwt.claim.sub`):
--   * a coach import whose staged row carries a phone, guardian names, emails,
--     phones and addresses, a child's name and birth date and a payment
--     status stores none of them on the coach row or in the import's
--     application record, and keeps the fields the organization declared,
--     typed as declared: a declared date is stored and passes the
--     custom-attributes trigger;
--   * a re-import of that coach (the UPDATE branch) drops a phone the row's
--     contact_info held, drops a declared date that does not parse instead of
--     failing, and keeps the stored one;
--   * a player import stores no contact, guardian or payment value (it wrote
--     '{}' and '[]' for contact_info and guardian_contacts until
--     20261025010000 dropped both, and false for paid until 20261022020000
--     dropped it), and keeps team placement,
--     play-up and the declared fields; a re-import drops an undeclared key
--     the player already held;
--   * `minimise_import_people_data()`: a planted coach reduced to its declared
--     attributes with no phone, its import snapshot scrubbed; a planted
--     player's undeclared keys cleared (its contacts and guardians since
--     20261025010000 have no column to be planted in); the staged
--     people rows of a completed and a failed job deleted, a finished field
--     job's rows kept, a ready job's coach row kept and reduced to the
--     allowlist; emails and a player patch's name redacted in `audit_log`
--     with no row deleted; a quoted value removed from a row error;
--   * the custom-attributes trigger refuses a declared date that is not one;
--   * the posture: both finalizers SECURITY DEFINER with search_path=public
--     and timezone=UTC, EXECUTE for authenticated and not anon; no new
--     function executable by anon or authenticated; both retention jobs
--     scoped to finished jobs.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every value a placeholder (`@example.test`,
-- `555-0100`); there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_coach_job1 uuid := gen_random_uuid();
    v_coach_job2 uuid := gen_random_uuid();
    v_player_job uuid := gen_random_uuid();
    v_player_job2 uuid := gen_random_uuid();
    v_ready_job uuid := gen_random_uuid();
    v_failed_job uuid := gen_random_uuid();
    v_field_job uuid := gen_random_uuid();
    v_result jsonb;
    v_coach public.coaches%ROWTYPE;
    v_player public.players%ROWTYPE;
    v_text text;
    v_n integer;
    v_audit_id uuid;
    v_secrets text[] := ARRAY[
        '555-0100', '555-0101', '555-0102', 'guardian-one@example.test',
        'guardian-two@example.test', '1 Placeholder Way', 'Childfirst', '2016-02-03',
        '1980-01-01', 'PAID', 'Guardianname'
    ];
    v_coach_payload jsonb := jsonb_build_object(
        'full_name', 'Smoke Coach', 'email', 'smoke-coach@example.test',
        'phone', '555-0100',
        'guardian 1 first name', 'Guardianname', 'guardian 1 address', '1 Placeholder Way',
        'guardian 1 mobile phone number', '555-0101',
        'guardian 1 email address', 'guardian-one@example.test',
        'guardian 2 email address', 'guardian-two@example.test',
        'player first name', 'Childfirst',
        'what is your player''s birth date?', '2016-02-03',
        'date_of_birth', '1980-01-01', 'payment status', 'PAID',
        'shirt size', 'YM', 'years coached', '4', 'cert date', '2024-05-06');
    v_player_payload jsonb := jsonb_build_object(
        'first_name', 'Smoke', 'last_name', 'Player', 'date_of_birth', '2016-04-01',
        'external_registration_id', 'SMOKE-R0-1', 'gender', 'F', 'age group', '9',
        'email', 'guardian-one@example.test', 'phone', '555-0100',
        'guardian_1_first_name', 'Guardianname', 'guardian_1_email', 'guardian-one@example.test',
        'guardian_2_email', 'guardian-two@example.test', 'guardian_phone', '555-0102',
        'guardian 1 address', '1 Placeholder Way', 'payment_status', 'PAID',
        'team name', 'Smoke Team', 'team age', 'U10', 'team gender', 'Girls',
        'play_up', 'yes', 'shirt size', 'YM', 'joined on', '2024-01-02',
        'undeclared column', 'Childfirst');
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'r0-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'r0-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org R0', 'smoke-org-r0')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin');
    -- Declared fields of every type the import parses: string, number, date.
    INSERT INTO public.organization_schemas (organization_id, entity_type, schema_definition) VALUES
        (v_org, 'coach', '{"shirt_size": "string", "years_coached": "number", "cert_date": "date"}'::jsonb),
        (v_org, 'player', '{"shirt_size": "string", "joined_on": "date"}'::jsonb);
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
        (v_coach_job1, v_org, 'registration', 'smoke/r0-c1.csv', 'processing', v_admin),
        (v_coach_job2, v_org, 'registration', 'smoke/r0-c2.csv', 'processing', v_admin),
        (v_player_job, v_org, 'registration', 'smoke/r0-p1.csv', 'processing', v_admin),
        (v_player_job2, v_org, 'registration', 'smoke/r0-p2.csv', 'processing', v_admin);
    INSERT INTO public.staging_import_rows
        (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_coach_job1, 'coaches', 1, v_coach_payload, v_coach_payload),
        (v_org, v_coach_job2, 'coaches', 1, '{}'::jsonb,
         v_coach_payload || '{"shirt size": "YL", "cert date": "not a date"}'::jsonb);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_player_job, 1, v_player_payload, v_player_payload),
        (v_org, v_player_job2, 1, '{}'::jsonb, v_player_payload);

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- (a) Coach, INSERT branch.
    v_result := public.finalize_coach_import_job(v_coach_job1);
    IF (v_result->>'inserted_coaches')::int <> 1 THEN
        RAISE EXCEPTION 'the coach import did not insert its coach: %', v_result;
    END IF;
    SELECT * INTO v_coach FROM public.coaches WHERE organization_id = v_org;
    SELECT to_jsonb(v_coach)::text || COALESCE(string_agg(r.applied_payload::text, ''), '')
      INTO v_text
      FROM public.import_application_records r WHERE r.import_job_id = v_coach_job1;
    IF EXISTS (SELECT 1 FROM unnest(v_secrets) s WHERE strpos(v_text, s) > 0) THEN
        RAISE EXCEPTION 'the coach import stored a value outside the allowlist: %', v_text;
    END IF;
    IF v_coach.custom_attributes IS DISTINCT FROM
           '{"shirt_size": "YM", "years_coached": 4, "cert_date": "2024-05-06"}'::jsonb
       OR v_coach.phone IS NOT NULL
       OR v_coach.contact_info IS DISTINCT FROM '{"email": "smoke-coach@example.test"}'::jsonb THEN
        RAISE EXCEPTION 'the coach import kept the wrong attributes or a phone: % % %',
            v_coach.custom_attributes, v_coach.phone, v_coach.contact_info;
    END IF;
    RAISE NOTICE 'coach INSERT: no phone, guardian, address, child or payment value stored; the declared fields kept and typed, a date included';

    -- (b) Coach, UPDATE branch, over a row that already holds a phone.
    UPDATE public.coaches
       SET phone = '555-0100',
           contact_info = '{"email": "smoke-coach@example.test", "phone": "555-0100"}'::jsonb
     WHERE id = v_coach.id;
    v_result := public.finalize_coach_import_job(v_coach_job2);
    IF (v_result->>'updated_coaches')::int <> 1 THEN
        RAISE EXCEPTION 'the coach re-import did not update its coach: %', v_result;
    END IF;
    SELECT * INTO v_coach FROM public.coaches WHERE id = v_coach.id;
    IF v_coach.custom_attributes IS DISTINCT FROM
           '{"shirt_size": "YL", "years_coached": 4, "cert_date": "2024-05-06"}'::jsonb
       OR v_coach.contact_info ? 'phone'
       OR EXISTS (SELECT 1 FROM unnest(v_secrets) s
                   WHERE s <> '555-0100' AND strpos(to_jsonb(v_coach)::text, s) > 0) THEN
        RAISE EXCEPTION 'the coach re-import kept a phone in contact_info or an undeclared value: %', to_jsonb(v_coach);
    END IF;
    RAISE NOTICE 'coach UPDATE: contact_info lost its phone, an unparseable declared date dropped, the stored one kept';

    -- (c) Player, INSERT branch.
    v_result := public.finalize_import_job(v_player_job);
    IF (v_result->>'inserted_players')::int <> 1 THEN
        RAISE EXCEPTION 'the player import did not insert its player: %', v_result;
    END IF;
    SELECT * INTO v_player FROM public.players
     WHERE organization_id = v_org AND external_registration_id = 'SMOKE-R0-1';
    v_text := to_jsonb(v_player)::text;
    IF EXISTS (SELECT 1 FROM unnest(v_secrets) s WHERE strpos(v_text, s) > 0) THEN
        RAISE EXCEPTION 'the player import stored a contact, guardian, payment or undeclared value: %', v_text;
    END IF;
    -- `paid` is not checked since 20261022020000 dropped the column, nor
    -- `contact_info` and `guardian_contacts` since 20261025010000 dropped
    -- them; the payment, contact and guardian values are still in v_secrets
    -- above, which the whole row is searched for.
    IF v_player.custom_attributes IS DISTINCT FROM jsonb_build_object(
            'shirt_size', 'YM', 'joined_on', '2024-01-02', 'team_name', 'Smoke Team',
            'team_age', 'U10', 'team_gender', 'Girls', 'play_up', 'yes') THEN
        RAISE EXCEPTION 'the player import wrote the wrong attributes: %', v_player.custom_attributes;
    END IF;
    RAISE NOTICE 'player INSERT: no contact, guardian, payment or undeclared value stored; team placement, play-up and the declared fields kept';

    -- (d) Player, UPDATE branch, over a row that already holds an undeclared key.
    UPDATE public.players
       SET custom_attributes = custom_attributes || '{"guardian 1 address": "1 Placeholder Way"}'::jsonb
     WHERE id = v_player.id;
    v_result := public.finalize_import_job(v_player_job2);
    IF (v_result->>'updated_players')::int <> 1 THEN
        RAISE EXCEPTION 'the player re-import did not update its player: %', v_result;
    END IF;
    SELECT * INTO v_player FROM public.players WHERE id = v_player.id;
    IF v_player.custom_attributes ? 'guardian 1 address'
       OR v_player.custom_attributes ->> 'team_name' IS DISTINCT FROM 'Smoke Team' THEN
        RAISE EXCEPTION 'the player re-import kept an undeclared key or lost the import''s own: %', v_player.custom_attributes;
    END IF;
    RAISE NOTICE 'player UPDATE: an undeclared key the player held dropped, the import''s own keys kept';

    -- (e) The purge, as the database owner.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.import_jobs SET status = 'completed'
     WHERE id IN (v_coach_job1, v_coach_job2, v_player_job, v_player_job2);
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, error_summary) VALUES
        (v_ready_job, v_org, 'registration', 'smoke/r0-ready.csv', 'ready_to_apply', v_admin, NULL),
        (v_failed_job, v_org, 'registration', 'smoke/r0-failed.csv', 'failed', v_admin,
         jsonb_build_object('rowErrors', jsonb_build_array(
             jsonb_build_object('row', 2, 'field', 'email',
                                'message', 'Invalid email format: guardian-one@example.test')))),
        (v_field_job, v_org, 'fields', 'smoke/r0-fields.csv', 'completed', v_admin, NULL);
    INSERT INTO public.staging_import_rows
        (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_ready_job, 'coaches', 1, v_coach_payload, v_coach_payload),
        (v_org, v_failed_job, 'coaches', 1, v_coach_payload, v_coach_payload),
        (v_org, v_field_job, 'fields', 1, '{"name": "Field 1"}'::jsonb, '{"name": "Field 1"}'::jsonb);
    -- A coach and a player as production could hold them.
    UPDATE public.coaches
       SET phone = '555-0100',
           contact_info = '{"email": "smoke-coach@example.test", "phone": "555-0100"}'::jsonb,
           custom_attributes = v_coach_payload - 'full_name' - 'email' - 'phone' - 'cert date'
     WHERE id = v_coach.id;
    UPDATE public.players
       SET custom_attributes = custom_attributes || '{"undeclared column": "Childfirst"}'::jsonb
     WHERE id = v_player.id;
    UPDATE public.import_application_records
       SET previous_payload = to_jsonb(v_coach) || jsonb_build_object(
               'phone', '555-0100', 'custom_attributes', v_coach_payload)
     WHERE import_job_id = v_coach_job2;
    INSERT INTO public.audit_log (user_id, organization_id, action, resource_type, resource_id, metadata)
    VALUES (v_admin, v_org, 'player.updated', 'players', v_player.id,
            jsonb_build_object('patch', jsonb_build_object(
                'first_name', 'Childfirst', 'date_of_birth', '2016-02-03', 'division_id', NULL)))
    RETURNING id INTO v_audit_id;
    INSERT INTO public.audit_log (user_id, organization_id, action, resource_type, resource_id, metadata)
    VALUES (v_admin, v_org, 'settings.updated', 'coaches', v_coach.id,
            jsonb_build_object('matched_email', 'guardian-one@example.test',
                               'coach_email', 'guardian-two@example.test', 'user_id', v_admin)),
           (v_admin, v_org, 'settings.updated', 'season_settings', NULL,
            jsonb_build_object('timezone', 'UTC', 'admin_email', 'guardian-one@example.test',
                               'has_email', true));
    SELECT count(*) INTO v_n FROM public.audit_log WHERE organization_id = v_org;

    v_result := public.minimise_import_people_data();
    RAISE NOTICE 'purge result: %', v_result;

    SELECT * INTO v_coach FROM public.coaches WHERE id = v_coach.id;
    IF v_coach.custom_attributes IS DISTINCT FROM '{"shirt_size": "YM", "years_coached": 4}'::jsonb
       OR v_coach.phone IS NOT NULL OR v_coach.contact_info ? 'phone' THEN
        RAISE EXCEPTION 'the purge left an undeclared attribute or a phone on the coach: %', to_jsonb(v_coach);
    END IF;
    SELECT * INTO v_player FROM public.players WHERE id = v_player.id;
    IF v_player.custom_attributes IS DISTINCT FROM jsonb_build_object(
            'shirt_size', 'YM', 'joined_on', '2024-01-02', 'team_name', 'Smoke Team',
            'team_age', 'U10', 'team_gender', 'Girls', 'play_up', 'yes') THEN
        RAISE EXCEPTION 'the purge left an undeclared player attribute: %', to_jsonb(v_player);
    END IF;
    SELECT string_agg(COALESCE(r.previous_payload::text, '') || r.applied_payload::text
                      || COALESCE(r.rollback_payload::text, ''), '')
      INTO v_text FROM public.import_application_records r
     WHERE r.import_job_id IN (v_coach_job1, v_coach_job2);
    IF EXISTS (SELECT 1 FROM unnest(v_secrets) s WHERE strpos(v_text, s) > 0) THEN
        RAISE EXCEPTION 'the purge left a value in a coach import snapshot: %', v_text;
    END IF;
    IF EXISTS (SELECT 1 FROM public.staging_import_rows
                WHERE import_job_id IN (v_coach_job1, v_coach_job2, v_failed_job))
       OR EXISTS (SELECT 1 FROM public.staging_players
                   WHERE import_job_id IN (v_player_job, v_player_job2))
       OR NOT EXISTS (SELECT 1 FROM public.staging_import_rows WHERE import_job_id = v_ready_job)
       OR NOT EXISTS (SELECT 1 FROM public.staging_import_rows WHERE import_job_id = v_field_job) THEN
        RAISE EXCEPTION 'the purge kept a finished job''s people rows, or deleted a ready job''s or a field job''s';
    END IF;
    SELECT raw_payload::text || normalized_payload::text INTO v_text
      FROM public.staging_import_rows WHERE import_job_id = v_ready_job;
    IF EXISTS (SELECT 1 FROM unnest(v_secrets) s WHERE strpos(v_text, s) > 0)
       OR (SELECT normalized_payload FROM public.staging_import_rows WHERE import_job_id = v_ready_job)
          IS DISTINCT FROM jsonb_build_object(
              'full_name', 'Smoke Coach', 'email', 'smoke-coach@example.test',
              'shirt size', 'YM', 'years coached', '4', 'cert date', '2024-05-06') THEN
        RAISE EXCEPTION 'the purge left a ready job''s staged row unreduced: %', v_text;
    END IF;
    SELECT string_agg(metadata::text, '') INTO v_text FROM public.audit_log WHERE organization_id = v_org;
    IF EXISTS (SELECT 1 FROM unnest(v_secrets) s WHERE strpos(v_text, s) > 0)
       OR (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org) <> v_n
       OR (SELECT metadata FROM public.audit_log WHERE id = v_audit_id)
          IS DISTINCT FROM '{"patch": {"first_name": "[redacted]", "date_of_birth": "[redacted]", "division_id": null}}'::jsonb
       OR (SELECT metadata FROM public.audit_log
            WHERE organization_id = v_org AND resource_type = 'season_settings')
          IS DISTINCT FROM '{"timezone": "UTC", "admin_email": "[redacted]", "has_email": true}'::jsonb THEN
        RAISE EXCEPTION 'the purge left a personal value in audit_log, deleted a row, or redacted the wrong key: %', v_text;
    END IF;
    IF (SELECT error_summary FROM public.import_jobs WHERE id = v_failed_job) IS DISTINCT FROM
       '{"rowErrors": [{"row": 2, "field": "email", "message": "Invalid email format"}]}'::jsonb THEN
        RAISE EXCEPTION 'the purge left the value in a row error: %',
            (SELECT error_summary FROM public.import_jobs WHERE id = v_failed_job);
    END IF;
    RAISE NOTICE 'purge: coach and player reduced, snapshots scrubbed, finished jobs'' people rows deleted, a field job''s and a ready job''s kept (the ready one reduced), audit values redacted with no row deleted, a row error''s value removed';

    -- (f) The custom-attributes trigger refuses a declared date that is not a
    --     calendar date written exactly YYYY-MM-DD.
    FOREACH v_text IN ARRAY ARRAY['soon', '2025-02-03junk', '2025-02-30'] LOOP
        BEGIN
            UPDATE public.players
               SET custom_attributes = custom_attributes || jsonb_build_object('joined_on', v_text)
             WHERE id = v_player.id;
            RAISE EXCEPTION 'the trigger accepted % as a declared date', v_text;
        EXCEPTION WHEN raise_exception THEN
            IF SQLERRM NOT LIKE 'Validation Failed: Key joined_on expected date%' THEN
                RAISE;
            END IF;
        END;
    END LOOP;
    RAISE NOTICE 'trigger: a declared YYYY-MM-DD date passes; "soon", "2025-02-03junk" and "2025-02-30" are refused';

    -- (g) Posture.
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.oid IN ('public.finalize_import_job(uuid, jsonb)'::regprocedure,
                         'public.finalize_coach_import_job(uuid, jsonb)'::regprocedure)
           AND p.prosecdef
           AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) <> 2 THEN
        RAISE EXCEPTION 'a finalizer lost its posture (definer, search_path, timezone, grants)';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(ARRAY[
                   'public.minimise_import_people_data()',
                   'public.import_allowed_keys(text)',
                   'public.import_declared_fields(uuid, text)',
                   'public.import_declared_attributes(jsonb, jsonb)',
                   'public.import_kept_player_attributes(jsonb, jsonb)',
                   'public.import_allowed_payload(text, jsonb, jsonb)']) f
                WHERE has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
                   OR has_function_privilege('anon', f::regprocedure, 'EXECUTE')) THEN
        RAISE EXCEPTION 'a client role can execute the purge or an import helper';
    END IF;
    IF (SELECT count(*) FROM cron.job
         WHERE jobname IN ('cleanup-staging-import-rows', 'cleanup-staging-players')
           AND command LIKE '%j.status IN (''completed'', ''completed_with_warnings'', ''failed'')%30 days%') <> 2
       OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-staging-import-rows'
                       AND command LIKE '%import_type = ''coaches''%') THEN
        RAISE EXCEPTION 'a staging retention job is missing or not scoped to finished jobs'' people rows';
    END IF;
    RAISE NOTICE 'posture: finalizers definer with search_path and UTC pinned, authenticated only; purge and helpers closed to clients; both retention jobs scoped to finished jobs';
END;
$$;

ROLLBACK;
