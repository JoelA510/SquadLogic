-- Smoke checks for 20261006000000_org_heat_settings.sql
--
-- Assertions RAISE; the NOTICEs are evidence of what each one examined, and
-- `scripts/dbharness/run.sh` turns six of them into (checked) claims, each
-- proven by a plant in `scripts/dbharness/prove.sh`.
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the RPC
-- runs as a real admin, a real coach and another organisation's real admin.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email is `@example.test`, every URL is under
-- example.org; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The table, its CHECKs, its policies and the writer, from the catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_checks int;
    v_write text[];
    v_select int;
    v_definer int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class
                    WHERE oid = 'public.organization_heat_settings'::regclass AND relrowsecurity) THEN
        RAISE EXCEPTION 'organization_heat_settings does not have row level security enabled';
    END IF;

    SELECT count(*) INTO v_checks
      FROM pg_constraint
     WHERE conrelid = 'public.organization_heat_settings'::regclass AND contype = 'c'
       AND conname IN ('organization_heat_settings_category_range', 'organization_heat_settings_links_shape');
    IF v_checks <> 2 THEN
        RAISE EXCEPTION 'expected the category and links CHECKs on organization_heat_settings; found % of 2', v_checks;
    END IF;

    SELECT array_agg(polname ORDER BY polname) INTO v_write
      FROM pg_policy WHERE polrelid = 'public.organization_heat_settings'::regclass AND polcmd <> 'r';
    IF v_write IS NOT NULL THEN
        RAISE EXCEPTION 'organization_heat_settings carries write policies %; its writer is the definer RPC', v_write;
    END IF;
    SELECT count(*) INTO v_select
      FROM pg_policy WHERE polrelid = 'public.organization_heat_settings'::regclass AND polcmd = 'r';
    IF v_select <> 1 THEN
        RAISE EXCEPTION 'expected exactly one SELECT policy on organization_heat_settings, found %', v_select;
    END IF;

    IF has_table_privilege('authenticated', 'public.organization_heat_settings', 'INSERT')
       OR has_table_privilege('authenticated', 'public.organization_heat_settings', 'UPDATE')
       OR has_table_privilege('anon', 'public.organization_heat_settings', 'SELECT') THEN
        RAISE EXCEPTION 'organization_heat_settings grants a write to authenticated or a read to anon';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'settings.heat_updated') THEN
        RAISE EXCEPTION 'the settings.heat_updated audit action is not registered';
    END IF;

    SELECT count(*) INTO v_definer
      FROM pg_proc p
     WHERE p.oid = 'public.admin_set_org_heat_settings(uuid, integer, jsonb)'::regprocedure
       AND p.prosecdef
       AND 'search_path=public' = ANY (p.proconfig)
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_definer <> 1 THEN
        RAISE EXCEPTION 'admin_set_org_heat_settings is not a definer RPC with a pinned search_path, executable by authenticated and not anon';
    END IF;

    RAISE NOTICE 'heat settings store: RLS on; 2 CHECKs; 1 SELECT policy and 0 write policies; no INSERT/UPDATE grant to authenticated, no anon read; audit action registered; RPC definer, search_path pinned, authenticated yes, anon no';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The writer, as an admin, a coach and another organisation's admin
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_org uuid;
    v_other_org uuid;
    v_res jsonb;
    v_caller uuid;
    v_code text;
    v_refused int;
    v_row public.organization_heat_settings%ROWTYPE;
    v_n int;
    v_audit public.audit_log%ROWTYPE;
    v_bad jsonb;
    v_bad_cases jsonb[] := ARRAY[
        '{"links": "not an array"}'::jsonb,
        '{"links": [1]}'::jsonb,
        '{"links": [{"label": "x"}]}'::jsonb,
        '{"links": [{"label": "x", "url": "https://example.org", "extra": 1}]}'::jsonb,
        '{"links": [{"label": "   ", "url": "https://example.org"}]}'::jsonb,
        '{"links": [{"label": "x", "url": "http://example.org"}]}'::jsonb,
        '{"links": [{"label": "x", "url": "https://localhost"}]}'::jsonb,
        '{"links": [{"label": "x", "url": "https://exa mple.org"}]}'::jsonb,
        '{"links": [{"label": 5, "url": "https://example.org"}]}'::jsonb
    ];
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'heat-admin@example.test', '{"password_length": 16}'),
        (v_coach, 'heat-coach@example.test', '{"password_length": 16}'),
        (v_outsider, 'heat-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'heat-admin@example.test'), (v_coach, 'heat-coach@example.test'),
        (v_outsider, 'heat-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Heat', 'smoke-org-heat')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Heat other', 'smoke-org-heat-other')
        RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach'), (v_other_org, v_outsider, 'admin');

    -- ---- (a) the admin writes; label and url are stored trimmed ------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_res := public.admin_set_org_heat_settings(
        v_org, 2,
        '[{"label": "  League health and safety ", "url": " https://example.org/health "}]'::jsonb);
    SELECT * INTO v_row FROM public.organization_heat_settings WHERE organization_id = v_org;
    IF v_row.threshold_category <> 2
       OR v_row.guidance_links <> '[{"label": "League health and safety", "url": "https://example.org/health"}]'::jsonb
       OR v_row.updated_by <> v_admin THEN
        RAISE EXCEPTION 'the admin write stored %/% by %, not category 2 with the trimmed link by the admin',
            v_row.threshold_category, v_row.guidance_links, v_row.updated_by;
    END IF;
    RAISE NOTICE 'the admin set category 2 with one link, stored trimmed, updated_by the admin';

    -- ---- (b) a coach and another organisation's admin are refused ----------
    v_refused := 0;
    FOREACH v_caller IN ARRAY ARRAY[v_coach, v_outsider] LOOP
        PERFORM set_config('request.jwt.claim.sub', v_caller::text, true);
        BEGIN
            PERFORM public.admin_set_org_heat_settings(v_org, 3, '[]'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
            IF v_code = '42501' THEN v_refused := v_refused + 1; END IF;
        END;
    END LOOP;
    SELECT * INTO v_row FROM public.organization_heat_settings WHERE organization_id = v_org;
    IF v_refused <> 2 OR v_row.threshold_category <> 2 THEN
        RAISE EXCEPTION 'a coach and another organisation''s admin: % of 2 refused 42501, category now %', v_refused, v_row.threshold_category;
    END IF;
    RAISE NOTICE 'a coach and another organisation''s admin were each refused 42501, 2 of 2, and the settings are unchanged';

    -- ---- (c) invalid categories are refused 22023 --------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_refused := 0;
    FOR v_n IN SELECT unnest(ARRAY[0, 4, -1]) LOOP
        BEGIN
            PERFORM public.admin_set_org_heat_settings(v_org, v_n, '[]'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
            IF v_code = '22023' THEN v_refused := v_refused + 1; END IF;
        END;
    END LOOP;
    BEGIN
        PERFORM public.admin_set_org_heat_settings(v_org, NULL, '[]'::jsonb);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
        IF v_code = '22023' THEN v_refused := v_refused + 1; END IF;
    END;
    IF v_refused <> 4 THEN
        RAISE EXCEPTION 'the RPC refused % of 4 invalid categories 22023', v_refused;
    END IF;
    RAISE NOTICE 'the RPC refused 4 of 4 invalid categories 22023 (0, 4, -1, NULL)';

    -- ---- (d) invalid link lists are refused 22023 --------------------------
    v_refused := 0;
    FOREACH v_bad IN ARRAY v_bad_cases LOOP
        BEGIN
            PERFORM public.admin_set_org_heat_settings(v_org, 1, v_bad -> 'links');
        EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
            IF v_code = '22023' THEN v_refused := v_refused + 1; END IF;
        END;
    END LOOP;
    BEGIN
        PERFORM public.admin_set_org_heat_settings(v_org, 1, (
            SELECT jsonb_agg(jsonb_build_object('label', 'L' || g, 'url', 'https://example.org/' || g))
              FROM generate_series(1, 11) g));
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
        IF v_code = '22023' THEN v_refused := v_refused + 1; END IF;
    END;
    SELECT * INTO v_row FROM public.organization_heat_settings WHERE organization_id = v_org;
    IF v_refused <> 10 OR v_row.threshold_category <> 2 THEN
        RAISE EXCEPTION 'the RPC refused % of 10 invalid link lists 22023; category now %', v_refused, v_row.threshold_category;
    END IF;
    RAISE NOTICE 'the RPC refused 10 of 10 invalid link lists 22023 (not an array, non-object, missing url, extra key, blank label, http, no dotted host, whitespace, non-string label, 11 links)';

    -- ---- (e) the CHECKs refuse a write that bypasses the RPC ---------------
    v_refused := 0;
    BEGIN
        UPDATE public.organization_heat_settings SET threshold_category = 5 WHERE organization_id = v_org;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
    END;
    BEGIN
        UPDATE public.organization_heat_settings SET guidance_links = '{"a": 1}'::jsonb WHERE organization_id = v_org;
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
    END;
    IF v_refused <> 2 THEN
        RAISE EXCEPTION 'the CHECKs refused % of 2 owner writes 23514', v_refused;
    END IF;
    RAISE NOTICE 'the category and links CHECKs refused both owner writes 23514, 2 of 2';

    -- ---- (f) an empty list clears the links; every accepted write audited --
    v_res := public.admin_set_org_heat_settings(v_org, 1, '[]'::jsonb);
    SELECT * INTO v_row FROM public.organization_heat_settings WHERE organization_id = v_org;
    IF v_row.threshold_category <> 1 OR v_row.guidance_links <> '[]'::jsonb THEN
        RAISE EXCEPTION 'the clear stored %/%', v_row.threshold_category, v_row.guidance_links;
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_org AND action = 'settings.heat_updated';
    SELECT * INTO v_audit FROM public.audit_log
     WHERE organization_id = v_org AND action = 'settings.heat_updated'
     ORDER BY created_at, id LIMIT 1;
    IF v_n <> 2
       OR v_audit.metadata ->> 'operation' <> 'created'
       OR v_audit.metadata -> 'before' <> 'null'::jsonb
       OR (v_audit.metadata #>> '{after,threshold_category}')::int <> 2 THEN
        RAISE EXCEPTION 'expected 2 settings.heat_updated audit rows, the first created/before null/after category 2; found % (%)', v_n, v_audit.metadata;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log
                    WHERE organization_id = v_org AND action = 'settings.heat_updated'
                      AND metadata ->> 'operation' = 'updated'
                      AND (metadata #>> '{before,threshold_category}')::int = 2
                      AND (metadata #>> '{after,threshold_category}')::int = 1
                      AND metadata #> '{after,guidance_links}' = '[]'::jsonb) THEN
        RAISE EXCEPTION 'the clear left no updated audit row with before category 2 and after category 1, no links';
    END IF;
    RAISE NOTICE 'every accepted heat settings write audited -- 2 of 2, the first created with before null and after category 2, the clear updated from category 2 to 1 with no links';

    -- ---- (g) members read their own organisation only ----------------------
    PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
    PERFORM public.admin_set_org_heat_settings(v_other_org, 3, '[]'::jsonb);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    SELECT count(*) INTO v_n FROM public.organization_heat_settings;
    RESET ROLE;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'a coach of one organisation reads % heat settings rows; expected only their own (1)', v_n;
    END IF;
    RAISE NOTICE 'a coach reads their own organisation''s heat settings and not the other organisation''s (1 of 2 rows visible)';
END;
$$;

ROLLBACK;
