-- Smoke checks for 20261022020000_remove_registration_and_compliance.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * the dropped objects stay dropped: the seven functions, the view, both
--     tables and the three `players` columns; and no `public` function body,
--     view definition or policy names one of them (a catalogue scan, shown to
--     fire on a planted function first);
--   * the audit history stays readable: the retired actions' `audit_actions`
--     rows are still there;
--   * the kept player writers work without the flags: `admin_update_player`
--     applies an ordinary patch, and refuses (22023) a patch naming `paid`,
--     `waiver_received` or `medical_form_received` with the row unchanged; so
--     do `admin_bulk_update_players` and `admin_create_player`;
--   * `finalize_import_job` promotes a staged row that carries a payment
--     status, and the player it inserts stores nothing of it;
--   * the posture of the three replaced functions is what it was:
--     `sanitize_player_patch` IMMUTABLE with search_path=public,
--     `apply_player_patch` with search_path=public and timezone=UTC,
--     `finalize_import_job` SECURITY DEFINER with both, EXECUTE for
--     authenticated and not anon; and no SECURITY DEFINER function in
--     `public` is executable by anon.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every value a placeholder; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- The names the scan looks for in a function body, a view or a policy: the
-- dropped tables, view and columns, as whole words.
CREATE FUNCTION pg_temp.r1_names_dropped(src text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$
    SELECT src ~ '\m(registration_forms|registrations|view_compliance_stats|paid|waiver_received|medical_form_received|medical_cleared|waiver_signed)\M'
$f$;

CREATE FUNCTION pg_temp.r1_referrers() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(o, ', ' ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND pg_temp.r1_names_dropped(p.prosrc)
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_temp.r1_names_dropped(pg_get_viewdef(c.oid))
        UNION ALL
        SELECT format('policy %s on %s', policyname, tablename)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND pg_temp.r1_names_dropped(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
    ) s
$f$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(o, ', ') INTO v_left FROM (
        SELECT f AS o FROM unnest(ARRAY[
            'public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)',
            'public.admin_create_registration_form(uuid, text, text, uuid, jsonb, text, text, jsonb)',
            'public.admin_update_registration_form(uuid, jsonb)',
            'public.admin_delete_registration_form(uuid)',
            'public.admin_update_registration_medical_status(uuid, uuid, boolean, jsonb)',
            'public.get_team_portal_medical_status(uuid)',
            'public.coach_update_player_compliance(uuid, jsonb)'
        ]) f WHERE to_regprocedure(f) IS NOT NULL
        UNION ALL
        SELECT r FROM unnest(ARRAY[
            'public.registration_forms', 'public.registrations', 'public.view_compliance_stats'
        ]) r WHERE to_regclass(r) IS NOT NULL
        UNION ALL
        SELECT 'players.' || attname FROM pg_attribute
         WHERE attrelid = 'public.players'::regclass AND NOT attisdropped
           AND attname IN ('paid', 'waiver_received', 'medical_form_received')
    ) s;
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'objects 20261022020000 dropped are back: %', v_left;
    END IF;

    -- The scan must see a function that names a dropped column (planted and
    -- undone inside a block) before its silence means anything.
    v_left := NULL;
    BEGIN
        CREATE FUNCTION public.__r1_smoke_probe() RETURNS boolean
        LANGUAGE sql AS 'SELECT true AS paid';
        v_left := pg_temp.r1_referrers();
        RAISE EXCEPTION USING ERRCODE = 'P1022', MESSAGE = 'undo the planted probe';
    EXCEPTION WHEN SQLSTATE 'P1022' THEN NULL;
    END;
    IF v_left IS NULL OR v_left NOT LIKE '%function __r1_smoke_probe()%' THEN
        RAISE EXCEPTION 'control: the scan did not see a planted function naming paid (found: %)',
            coalesce(v_left, 'nothing');
    END IF;
    v_left := pg_temp.r1_referrers();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'these still name a dropped table, view or column: %', v_left;
    END IF;
    RAISE NOTICE 'dropped: 7 functions, view_compliance_stats, registration_forms, registrations and players.paid/waiver_received/medical_form_received; no function, view or policy names them (the scan shown to fire on a planted function)';

    SELECT string_agg(a, ', ') INTO v_left FROM unnest(ARRAY[
        'registration.form_created', 'registration.form_updated', 'registration.form_deleted',
        'registration.submitted', 'compliance.medical_update', 'player.compliance_updated'
    ]) a WHERE NOT EXISTS (SELECT 1 FROM public.audit_actions x WHERE x.action = a);
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'audit_actions lost the retired actions audit_log references: %', v_left;
    END IF;
    RAISE NOTICE 'the retired actions keep their audit_actions rows, so old audit_log rows stay valid';
END;
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_player uuid;
    v_job uuid := gen_random_uuid();
    v_before public.players%ROWTYPE;
    v_after public.players%ROWTYPE;
    v_code text;
    v_msg text;
    v_flag text;
    v_result jsonb;
    v_payload jsonb := jsonb_build_object(
        'first_name', 'Smoke', 'last_name', 'Rone', 'date_of_birth', '2016-04-01',
        'external_registration_id', 'SMOKE-R1-1', 'gender', 'F', 'age group', '9',
        'payment_status', 'PAID', 'payment status', 'PAID');
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'r1-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'r1-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org R1', 'smoke-org-r1')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin');
    -- A player belongs to a season (20261108010000).
    INSERT INTO public.season_settings (organization_id, name, status)
        VALUES (v_org, 'R1 Season', 'active');
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- (a) An ordinary patch through each kept writer.
    SELECT id INTO v_player FROM public.admin_create_player(v_org, '{"first_name": "Smoke", "last_name": "Rone"}');
    PERFORM public.admin_update_player(v_player, '{"status": "waitlist", "willing_to_coach": true}');
    SELECT * INTO v_before FROM public.players WHERE id = v_player;
    IF v_before.status <> 'waitlist' OR NOT v_before.willing_to_coach THEN
        RAISE EXCEPTION 'admin_update_player did not apply an ordinary patch: % %', v_before.status, v_before.willing_to_coach;
    END IF;
    IF public.admin_bulk_update_players(ARRAY[v_player], '{"status": "active"}') <> 1 THEN
        RAISE EXCEPTION 'admin_bulk_update_players did not apply an ordinary patch';
    END IF;
    SELECT * INTO v_before FROM public.players WHERE id = v_player;

    -- (b) Each dropped flag, through each kept writer, is refused and changes nothing.
    FOREACH v_flag IN ARRAY ARRAY['paid', 'waiver_received', 'medical_form_received'] LOOP
        v_code := NULL;
        BEGIN
            PERFORM public.admin_update_player(v_player, jsonb_build_object(v_flag, true, 'status', 'inactive'));
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        END;
        IF v_code IS DISTINCT FROM '22023' OR v_msg <> format('field %s is not editable', v_flag) THEN
            RAISE EXCEPTION 'admin_update_player with % answered % %, not 22023 "field % is not editable"',
                v_flag, coalesce(v_code, 'success'), v_msg, v_flag;
        END IF;
        v_code := NULL;
        BEGIN
            PERFORM public.admin_bulk_update_players(ARRAY[v_player], jsonb_build_object(v_flag, true));
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
        END;
        IF v_code IS DISTINCT FROM '22023' THEN
            RAISE EXCEPTION 'admin_bulk_update_players with % answered %, not 22023', v_flag, coalesce(v_code, 'success');
        END IF;
        v_code := NULL;
        BEGIN
            PERFORM public.admin_create_player(v_org, jsonb_build_object('first_name', 'Other', v_flag, true));
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
        END;
        IF v_code IS DISTINCT FROM '22023' THEN
            RAISE EXCEPTION 'admin_create_player with % answered %, not 22023', v_flag, coalesce(v_code, 'success');
        END IF;
    END LOOP;
    SELECT * INTO v_after FROM public.players WHERE id = v_player;
    IF to_jsonb(v_after) IS DISTINCT FROM to_jsonb(v_before)
       OR (SELECT count(*) FROM public.players WHERE organization_id = v_org) <> 1 THEN
        RAISE EXCEPTION 'a refused flag patch changed a player or created one: % -> %', to_jsonb(v_before), to_jsonb(v_after);
    END IF;
    RAISE NOTICE 'player writers: an ordinary patch applies; paid, waiver_received and medical_form_received are each refused 22023 by admin_update_player, admin_bulk_update_players and admin_create_player, 9 of 9, and nothing changed';

    -- (c) The import still promotes a row carrying a payment status.
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
        (v_job, v_org, 'registration', 'smoke/r1-p1.csv', 'processing', v_admin);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job, 1, v_payload, v_payload);
    v_result := public.finalize_import_job(v_job);
    IF (v_result->>'inserted_players')::int IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'finalize_import_job did not insert the staged player: %', v_result;
    END IF;
    SELECT * INTO v_after FROM public.players
     WHERE organization_id = v_org AND external_registration_id = 'SMOKE-R1-1';
    IF v_after.id IS NULL OR strpos(to_jsonb(v_after)::text, 'PAID') > 0 THEN
        RAISE EXCEPTION 'the imported player is missing or stores the payment status: %', to_jsonb(v_after);
    END IF;
    RAISE NOTICE 'finalize_import_job: a staged row with a payment status is promoted, and the player stores nothing of it';
END;
$$;

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
      FROM pg_proc p
     WHERE (p.oid = 'public.sanitize_player_patch(jsonb)'::regprocedure
            AND NOT (NOT p.prosecdef AND p.provolatile = 'i' AND p.proconfig = ARRAY['search_path=public']))
        OR (p.oid = 'public.apply_player_patch(uuid, jsonb)'::regprocedure
            AND NOT (NOT p.prosecdef AND p.proconfig = ARRAY['search_path=public', 'TimeZone=UTC']))
        OR (p.oid = 'public.finalize_import_job(uuid, jsonb)'::regprocedure
            AND NOT (p.prosecdef AND p.proconfig = ARRAY['search_path=public', 'TimeZone=UTC']
                     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a replaced function lost its posture: %', v_bad;
    END IF;
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'SECURITY DEFINER functions executable by anon: %', v_bad;
    END IF;
    RAISE NOTICE 'posture: the three replaced functions keep their security, volatility, SET clauses and grants; no SECURITY DEFINER function is executable by anon';
END;
$$;

ROLLBACK;
