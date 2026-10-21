-- Smoke checks for 20261019010000_submit_registration_throttle.sql
--
-- What it proves, as members of an organization (prelude.sql stubs
-- `auth.uid()` from `request.jwt.claim.sub`):
--   * a member's first ten registrations to one form in the window succeed,
--     and the eleventh is refused with PT429 and writes no registration, no
--     player and no link; the refusal carries the limit in its hint;
--   * the refusal is per caller and per form: a second member of the same
--     organization and the same member on a second form still register;
--   * the window is 60 seconds: with the ten registrations back-dated 61 s the
--     same caller registers again, and with them back-dated 59 s is refused;
--   * the throttle does not depend on the session time zone (a PostgREST caller sets it):
--     under +14 and -12 ten succeed and the eleventh is refused PT429;
--   * a call that fails validation (a form that is not open) is refused with its
--     own code (22023), not PT429, and a refused call does not extend the window;
--   * the rows it counts are not the caller's to edit: as the member, an UPDATE
--     that back-dates them and a DELETE change nothing, a direct INSERT is refused
--     by RLS, and the eleventh call is still refused PT429; an organization admin
--     still updates and deletes; the table has exactly the four split policies;
--   * the posture is unchanged: SECURITY DEFINER, search_path=public, EXECUTE for
--     authenticated and anon (the public registration route), and the index the
--     count uses exists on (profile_id, form_id, created_at).
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_a uuid := gen_random_uuid();
    v_b uuid := gen_random_uuid();
    v_org uuid;
    v_season uuid;
    v_div uuid;
    v_form uuid;
    v_form2 uuid;
    v_closed uuid;
    v_code text;
    v_hint text;
    v_i integer;
    v_before_regs integer;
    v_before_players integer;
    v_before_links integer;
    v_id uuid;
    v_tz text;
    v_extra uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_a, 'reg-a@example.test', '{"password_length": 16}'),
        (v_b, 'reg-b@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_a, 'reg-a@example.test'), (v_b, 'reg-b@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Throttle', 'smoke-org-throttle')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_a, 'parent'), (v_org, v_b, 'parent');
    INSERT INTO public.season_settings (organization_id, name)
        VALUES (v_org, 'Throttle Season') RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_season, 'Throttle Division') RETURNING id INTO v_div;
    INSERT INTO public.registration_forms (organization_id, title, status, division_id) VALUES
        (v_org, 'Open form', 'open', v_div) RETURNING id INTO v_form;
    INSERT INTO public.registration_forms (organization_id, title, status, division_id) VALUES
        (v_org, 'Second open form', 'open', v_div) RETURNING id INTO v_form2;
    INSERT INTO public.registration_forms (organization_id, title, status, division_id) VALUES
        (v_org, 'Closed form', 'closed', v_div) RETURNING id INTO v_closed;

    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- (a) Ten succeed, the eleventh is refused and writes nothing.
    FOR v_i IN 1..10 LOOP
        PERFORM public.submit_registration(v_org, v_form, v_a, '{}'::jsonb, NULL, 'Child' || v_i, 'Throttle');
    END LOOP;
    IF (SELECT count(*) FROM public.registrations WHERE profile_id = v_a AND form_id = v_form) <> 10 THEN
        RAISE EXCEPTION 'the first ten registrations were not all written';
    END IF;
    SELECT count(*) INTO v_before_regs FROM public.registrations WHERE organization_id = v_org;
    SELECT count(*) INTO v_before_players FROM public.players WHERE organization_id = v_org;
    SELECT count(*) INTO v_before_links FROM public.profile_players WHERE organization_id = v_org;
    v_code := NULL;
    BEGIN
        PERFORM public.submit_registration(v_org, v_form, v_a, '{}'::jsonb, NULL, 'Child11', 'Throttle');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_code IS DISTINCT FROM 'PT429' THEN
        RAISE EXCEPTION 'the eleventh registration was not refused PT429 (got %)', coalesce(v_code, 'success');
    END IF;
    IF v_hint IS NULL OR v_hint NOT LIKE 'At most 10 registrations per form per%' THEN
        RAISE EXCEPTION 'the refusal does not name the limit in its hint: %', v_hint;
    END IF;
    IF (SELECT count(*) FROM public.registrations WHERE organization_id = v_org) <> v_before_regs
       OR (SELECT count(*) FROM public.players WHERE organization_id = v_org) <> v_before_players
       OR (SELECT count(*) FROM public.profile_players WHERE organization_id = v_org) <> v_before_links THEN
        RAISE EXCEPTION 'the refused eleventh call still wrote a registration, a player or a link';
    END IF;
    RAISE NOTICE 'ten registrations to one form succeed; the eleventh is refused PT429 with the limit in its hint and writes nothing';

    -- (b) Per caller and per form.
    PERFORM set_config('request.jwt.claim.sub', v_b::text, true);
    PERFORM public.submit_registration(v_org, v_form, v_b, '{}'::jsonb, NULL, 'Other', 'Member');
    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    PERFORM public.submit_registration(v_org, v_form2, v_a, '{}'::jsonb, NULL, 'Second', 'Form');
    RAISE NOTICE 'a second member on the same form, and the same member on a second form, still register';

    -- (c) The window is 60 seconds.
    UPDATE public.registrations SET created_at = now() - interval '59 seconds'
     WHERE profile_id = v_a AND form_id = v_form;
    v_code := NULL;
    BEGIN
        PERFORM public.submit_registration(v_org, v_form, v_a, '{}'::jsonb, NULL, 'Edge', 'Inside');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM 'PT429' THEN
        RAISE EXCEPTION 'ten registrations 59 seconds old did not still throttle (got %)', coalesce(v_code, 'success');
    END IF;
    UPDATE public.registrations SET created_at = now() - interval '61 seconds'
     WHERE profile_id = v_a AND form_id = v_form;
    v_id := public.submit_registration(v_org, v_form, v_a, '{}'::jsonb, NULL, 'After', 'Window');
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'a registration after the window returned no id';
    END IF;
    RAISE NOTICE 'the window is 60 seconds: ten registrations 59 s old still throttle, 61 s old do not';

    -- (d) Validation failures keep their own code and are not throttled.
    v_code := NULL;
    BEGIN
        PERFORM public.submit_registration(v_org, v_closed, v_a, '{}'::jsonb, NULL, 'Closed', 'Form');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM '22023' THEN
        RAISE EXCEPTION 'a closed form was not refused 22023 (got %)', coalesce(v_code, 'success');
    END IF;
    RAISE NOTICE 'a closed form is still refused 22023, not PT429';

    -- (d2) The window does not depend on the session time zone, which a
    --      PostgREST caller sets (Prefer: timezone=...). The column default
    --      timezone('utc', now()) is zone-less, so under +14 it would date a row
    --      14 hours back and under -12 in the future; the RPC sets created_at
    --      itself. Ten succeed and the eleventh is refused under each zone.
    FOR v_tz IN SELECT unnest(ARRAY['+14', '-12']) LOOP
        v_extra := gen_random_uuid();
        INSERT INTO auth.users (id, email, raw_user_meta_data)
            VALUES (v_extra, 'reg-tz' || v_tz || '@example.test', '{"password_length": 16}');
        INSERT INTO public.profiles (id, email) VALUES (v_extra, 'reg-tz' || v_tz || '@example.test')
            ON CONFLICT DO NOTHING;
        INSERT INTO public.organization_members (organization_id, profile_id, role)
            VALUES (v_org, v_extra, 'parent');
        PERFORM set_config('request.jwt.claim.sub', v_extra::text, true);
        PERFORM set_config('timezone', v_tz, true);
        FOR v_i IN 1..10 LOOP
            PERFORM public.submit_registration(v_org, v_form, v_extra, '{}'::jsonb, NULL, 'Zone' || v_i, 'Throttle');
        END LOOP;
        v_code := NULL;
        BEGIN
            PERFORM public.submit_registration(v_org, v_form, v_extra, '{}'::jsonb, NULL, 'Zone11', 'Throttle');
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
        END;
        IF v_code IS DISTINCT FROM 'PT429' THEN
            RAISE EXCEPTION 'under session time zone % the eleventh registration was not refused PT429 (got %)', v_tz, coalesce(v_code, 'success');
        END IF;
        IF (SELECT count(*) FROM public.registrations WHERE profile_id = v_extra AND created_at <> now()) <> 0 THEN
            RAISE EXCEPTION 'under session time zone % a registration was not dated now()', v_tz;
        END IF;
        PERFORM set_config('timezone', 'UTC', true);
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    RAISE NOTICE 'the throttle holds under session time zones +14 and -12: ten succeed, the eleventh is refused PT429, rows are dated now()';

    -- (e) Posture and index.
    IF NOT (SELECT p.prosecdef AND p.proconfig <@ ARRAY['search_path=public','TimeZone=UTC'] AND 'search_path=public' = ANY (p.proconfig)
              FROM pg_proc p
             WHERE p.oid = 'public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)'::regprocedure) THEN
        RAISE EXCEPTION 'submit_registration lost SECURITY DEFINER or search_path=public';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)', 'EXECUTE')
       OR NOT has_function_privilege('anon', 'public.submit_registration(uuid, uuid, uuid, jsonb, uuid, text, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'submit_registration must stay executable by authenticated and anon (the public registration route)';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
         WHERE c.relname = 'registrations_profile_form_created_idx'
           AND i.indrelid = 'public.registrations'::regclass
           AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
               = ARRAY['profile_id', 'form_id', 'created_at']) THEN
        RAISE EXCEPTION 'registrations_profile_form_created_idx is missing or not on (profile_id, form_id, created_at)';
    END IF;
    RAISE NOTICE 'submit_registration is SECURITY DEFINER with search_path=public, executable by authenticated and anon, and the count is indexed';
END;
$$;

-- (f) The rows the throttle counts are not the caller's to edit (Codex on #609).
DO $$
DECLARE
    v_parent uuid := gen_random_uuid();
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_season uuid;
    v_div uuid;
    v_form uuid;
    v_form2 uuid;
    v_player uuid;
    v_reg uuid;
    v_i integer;
    v_n integer;
    v_rows integer;
    v_err text;
    v_code text;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_parent, 'reg-edit-parent@example.test', '{"password_length": 16}'),
        (v_admin, 'reg-edit-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_parent, 'reg-edit-parent@example.test'), (v_admin, 'reg-edit-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Throttle Edit', 'smoke-org-throttle-edit')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_parent, 'parent'), (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name)
        VALUES (v_org, 'Throttle Edit Season') RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_season, 'Throttle Edit Division') RETURNING id INTO v_div;
    INSERT INTO public.registration_forms (organization_id, title, status, division_id) VALUES
        (v_org, 'Edit form', 'open', v_div) RETURNING id INTO v_form;
    INSERT INTO public.registration_forms (organization_id, title, status, division_id) VALUES
        (v_org, 'Edit second form', 'open', v_div) RETURNING id INTO v_form2;

    PERFORM set_config('request.jwt.claim.sub', v_parent::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
    FOR v_i IN 1..10 LOOP
        PERFORM public.submit_registration(v_org, v_form, v_parent, '{}'::jsonb, NULL, 'Edit' || v_i, 'Throttle');
    END LOOP;

    -- The member reads their ten, and can neither back-date nor delete them.
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.registrations WHERE profile_id = v_parent;
    UPDATE public.registrations SET created_at = now() - interval '1 day' WHERE profile_id = v_parent;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 10 OR v_rows <> 0 THEN
        RAISE EXCEPTION 'registrations as the member: read % (want 10), back-dated % (want 0)', v_n, v_rows;
    END IF;
    SET LOCAL ROLE authenticated;
    DELETE FROM public.registrations WHERE profile_id = v_parent;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'registrations as the member: deleted % (want 0)', v_rows;
    END IF;

    -- A direct INSERT, past the RPC, is refused by RLS.
    SELECT player_id INTO v_player FROM public.registrations WHERE profile_id = v_parent LIMIT 1;
    v_err := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        INSERT INTO public.registrations (organization_id, form_id, player_id, profile_id)
            VALUES (v_org, v_form2, v_player, v_parent);
    EXCEPTION WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_err IS NULL OR v_err NOT LIKE 'new row violates row-level security policy%' THEN
        RAISE EXCEPTION 'registrations as the member: the direct insert was not refused by RLS (error: %)', COALESCE(v_err, 'none -- it succeeded');
    END IF;

    -- So the eleventh call is still refused.
    v_code := NULL;
    BEGIN
        PERFORM public.submit_registration(v_org, v_form, v_parent, '{}'::jsonb, NULL, 'Edit11', 'Throttle');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM 'PT429' THEN
        RAISE EXCEPTION 'after the member''s edits the eleventh registration was not refused PT429 (got %)', coalesce(v_code, 'success');
    END IF;
    RAISE NOTICE 'the member cannot back-date, delete or directly insert registrations, and the eleventh is still refused PT429';

    -- The organization admin still writes directly.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SELECT id INTO v_reg FROM public.registrations WHERE profile_id = v_parent LIMIT 1;
    SET LOCAL ROLE authenticated;
    UPDATE public.registrations SET medical_cleared = true WHERE profile_id = v_parent;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    DELETE FROM public.registrations WHERE id = v_reg;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 10 OR v_rows <> 1 THEN
        RAISE EXCEPTION 'registrations as the admin: updated % (want 10), deleted % (want 1)', v_n, v_rows;
    END IF;

    IF (SELECT array_agg(polname::text || ':' || polcmd::text ORDER BY polname)
          FROM pg_policy WHERE polrelid = 'public.registrations'::regclass)
       IS DISTINCT FROM ARRAY['registrations_admin_delete:d', 'registrations_admin_insert:a',
                              'registrations_admin_update:w', 'registrations_select_own_or_admin:r'] THEN
        RAISE EXCEPTION 'registrations does not have exactly the four split policies';
    END IF;
    RAISE NOTICE 'an organization admin still updates and deletes registrations; the table has the four split policies';
END;
$$;

ROLLBACK;
