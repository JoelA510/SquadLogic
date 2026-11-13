-- Smoke checks for 20261124010000_settings_scope.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK. Synthetic organization, user, season,
-- program and divisions; no real data.
--
--   1. Shape: the two tables (RLS, one SELECT policy, no client write grant), the registry's standings row, the
--      resolver closed to client roles, the seam reading the resolver.
--   2. Precedence through the one setter: an organization value, a program value, a division value; an explicit false
--      beats an inherited true and the reverse; unset inherits again; each change audited once, an unchanged write not.
--   3. The setter's refusals: the default program, a string for a boolean; a direct write as the role authenticated.
--   4. The seam, standings_counts_outside, follows the cascade for a signed-in member.
--   5. The rollover copies a program's and a division's value and counts them.
--   6. admin_set_division_practice_settings changes the practice columns and leaves the roster rules.
--
-- The pgTAP file (supabase/tests/scoped_settings.sql) holds the full table; this is the part the migration harness can
-- run without pgTAP, and the part its plants are shown to turn red (scripts/dbharness/prove.sh).

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_org     uuid := gen_random_uuid();
    v_admin   uuid := gen_random_uuid();
    v_season  uuid := gen_random_uuid();
    v_prog    uuid := gen_random_uuid();
    v_d1      uuid := gen_random_uuid();   -- in the program
    v_d2      uuid := gen_random_uuid();   -- in the program, with no value of its own
    v_d3      uuid := gen_random_uuid();   -- in no program
    v_default uuid;
    v_res     jsonb;
    v_next    uuid;
    v_text    text;
    v_checks  integer := 0;
    v_key     constant text := 'standings_count_outside_results';
BEGIN
    -- ---- 1. shape ------------------------------------------------------------------------------------
    IF NOT (SELECT bool_and(c.relrowsecurity) FROM pg_class c
             WHERE c.oid IN ('public.scoped_settings'::regclass, 'public.scoped_setting_keys'::regclass))
       OR (SELECT string_agg(p.polcmd::text, ',') FROM pg_policy p WHERE p.polrelid = 'public.scoped_settings'::regclass) IS DISTINCT FROM 'r'
       OR (SELECT string_agg(p.polcmd::text, ',') FROM pg_policy p WHERE p.polrelid = 'public.scoped_setting_keys'::regclass) IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'the settings tables do not have row level security with exactly one SELECT policy each';
    END IF;
    IF has_table_privilege('authenticated', 'public.scoped_settings', 'INSERT') OR has_table_privilege('authenticated', 'public.scoped_settings', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.scoped_settings', 'DELETE') OR has_table_privilege('anon', 'public.scoped_settings', 'SELECT') THEN
        RAISE EXCEPTION 'a client role can write scoped_settings, or anon can read it';
    END IF;
    IF (SELECT value_type || ' ' || default_value::text FROM public.scoped_setting_keys WHERE key = v_key) IS DISTINCT FROM 'boolean false' THEN
        RAISE EXCEPTION 'the standings key is not registered as a boolean that defaults to false';
    END IF;
    IF has_function_privilege('authenticated', 'public.scoped_setting_value(uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the resolver is open to a client role';
    END IF;
    v_checks := v_checks + 4;
    RAISE NOTICE 'shape: scoped_settings and scoped_setting_keys (RLS, one SELECT policy each, no client write), the standings key registered, the resolver internal';

    -- ---- seed ----------------------------------------------------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'scope-smoke-admin@example.test', '{"password_length": 12, "full_name": "Scope Admin"}');
    INSERT INTO public.profiles (id, email, full_name) VALUES (v_admin, 'scope-smoke-admin@example.test', 'Scope Admin')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Scope Smoke Org', 'scope-smoke-' || replace(v_org::text, '-', ''));
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin')
    ON CONFLICT (organization_id, profile_id) DO UPDATE SET role = 'admin';
    INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES (v_season, v_org, 'Scope Season', 'active', 2026);
    INSERT INTO public.programs (id, organization_id, season_settings_id, name) VALUES (v_prog, v_org, v_season, 'Scope Juniors');
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name, program_id, max_roster_size, min_roster_size) VALUES
        (v_d1, v_org, v_season, 'Scope U9', v_prog, 14, 9),
        (v_d2, v_org, v_season, 'Scope U11', v_prog, NULL, NULL);
    INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES (v_d3, v_org, v_season, 'Scope U8');
    SELECT p.id INTO v_default FROM public.programs p WHERE p.season_settings_id = v_season AND p.is_default;

    -- ---- 2. precedence through the setter ------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    IF public.scoped_setting_value(v_d1, v_key) IS DISTINCT FROM 'false'::jsonb THEN
        RAISE EXCEPTION 'with nothing set a division does not get the default (false)';
    END IF;
    PERFORM public.admin_set_scoped_setting(v_key, 'organization', v_org, 'true');
    PERFORM public.admin_set_scoped_setting(v_key, 'program', v_prog, 'false');
    v_text := public.scoped_setting_value(v_d1, v_key)::text || ' ' || public.scoped_setting_value(v_d3, v_key)::text;
    IF v_text IS DISTINCT FROM 'false true' THEN
        RAISE EXCEPTION 'organization true, program false: a division in the program and one in none give %, not "false true" (an explicit false must beat an inherited true)', v_text;
    END IF;
    -- A division's own false under the organization's true (no program between them): the explicit false wins.
    PERFORM public.admin_set_scoped_setting(v_key, 'division', v_d3, 'false');
    IF public.scoped_setting_value(v_d3, v_key) IS DISTINCT FROM 'false'::jsonb THEN
        RAISE EXCEPTION 'a division''s own false under the organization''s true gives %, not false (an explicit false must beat an inherited true)',
            public.scoped_setting_value(v_d3, v_key);
    END IF;
    PERFORM public.admin_set_scoped_setting(v_key, 'division', v_d3, NULL);
    PERFORM public.admin_set_scoped_setting(v_key, 'division', v_d1, 'true');
    v_text := public.scoped_setting_value(v_d1, v_key)::text || ' ' || public.scoped_setting_value(v_d2, v_key)::text;
    IF v_text IS DISTINCT FROM 'true false' THEN
        RAISE EXCEPTION 'a division''s own true under its program''s false: the two divisions give %, not "true false"', v_text;
    END IF;
    v_res := public.admin_set_scoped_setting(v_key, 'division', v_d1, 'true');
    IF (v_res ->> 'changed') IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'the same value again reported a change';
    END IF;
    PERFORM public.admin_set_scoped_setting(v_key, 'division', v_d1, NULL);
    IF public.scoped_setting_value(v_d1, v_key) IS DISTINCT FROM 'false'::jsonb
       OR EXISTS (SELECT 1 FROM public.scoped_settings WHERE division_id = v_d1) THEN
        RAISE EXCEPTION 'an unset division value left a row, or the division did not inherit its program''s false';
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action = 'settings.updated' AND resource_type = 'scoped_setting') <> 6 THEN
        RAISE EXCEPTION 'expected six audit rows (organization, program, a division set and unset twice), found %',
            (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action = 'settings.updated' AND resource_type = 'scoped_setting');
    END IF;
    v_checks := v_checks + 7;
    RAISE NOTICE 'precedence: a division''s own value, else its program''s, else the organization''s, else false; an explicit false beats an inherited true and the reverse; unset inherits again; six changes, six audit rows, the unchanged write none';

    -- ---- 3. refusals ---------------------------------------------------------------------------------
    BEGIN
        PERFORM public.admin_set_scoped_setting(v_key, 'program', v_default, 'true');
        RAISE EXCEPTION 'the default program took a value' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_set_scoped_setting(v_key, 'division', v_d1, '"yes"');
        RAISE EXCEPTION 'a string was stored for a boolean setting' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    SET LOCAL ROLE authenticated;
    BEGIN
        INSERT INTO public.scoped_settings (organization_id, division_id, key, value) VALUES (v_org, v_d3, v_key, 'false');
        RAISE EXCEPTION 'an admin wrote scoped_settings directly' USING ERRCODE = 'XX000';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    v_checks := v_checks + 3;
    RAISE NOTICE 'refusals: the default program (22023), a string for a boolean (22023), a direct write as the role authenticated (42501)';

    -- ---- 4. the seam ---------------------------------------------------------------------------------
    -- Now: organization true, program false, nothing on the divisions.
    SET LOCAL ROLE authenticated;
    v_text := public.standings_counts_outside(v_d1)::text || ' ' || public.standings_counts_outside(v_d3)::text;
    RESET ROLE;
    IF v_text IS DISTINCT FROM 'false true' THEN
        RAISE EXCEPTION 'standings_counts_outside does not follow the cascade for a signed-in member: %', v_text;
    END IF;
    v_checks := v_checks + 1;
    RAISE NOTICE 'seam: standings_counts_outside, read as the role authenticated, follows the cascade';

    -- ---- 5. rollover ---------------------------------------------------------------------------------
    PERFORM public.admin_set_scoped_setting(v_key, 'division', v_d3, 'false');
    v_res := public.admin_create_season_from(v_season, 'Scope Season Next', 2027);
    v_next := (v_res ->> 'id')::uuid;
    IF (v_res ->> 'scoped_settings_copied') IS DISTINCT FROM '2' THEN
        RAISE EXCEPTION 'the rollover copied % scoped settings, not 2 (the program''s and one division''s)', v_res ->> 'scoped_settings_copied';
    END IF;
    IF (SELECT s.value FROM public.scoped_settings s JOIN public.programs p ON p.id = s.program_id
         WHERE p.season_settings_id = v_next AND p.copied_from_program_id = v_prog) IS DISTINCT FROM 'false'::jsonb
       OR (SELECT s.value FROM public.scoped_settings s JOIN public.divisions d ON d.id = s.division_id
            WHERE d.season_settings_id = v_next AND d.name = 'Scope U8') IS DISTINCT FROM 'false'::jsonb THEN
        RAISE EXCEPTION 'the next season''s program or division does not carry its value';
    END IF;
    v_checks := v_checks + 2;
    RAISE NOTICE 'rollover: the program''s and the division''s values go to their copies, counted';

    -- ---- 6. the practice setter ----------------------------------------------------------------------
    UPDATE public.divisions SET min_teams = 2, max_teams = 4 WHERE id = v_d1;
    v_res := public.admin_set_division_practice_settings(v_d1, 2, 60);
    IF (SELECT practices_per_week || ' ' || practice_minutes || ' ' || max_roster_size || ' ' || min_roster_size || ' ' || min_teams || ' ' || max_teams
          FROM public.divisions WHERE id = v_d1) IS DISTINCT FROM '2 60 14 9 2 4' THEN
        RAISE EXCEPTION 'the practice setter changed more than the practice columns, or not them';
    END IF;
    v_checks := v_checks + 1;
    RAISE NOTICE 'practice setter: practices a week and length changed, the roster rules as they were';

    RAISE NOTICE 'settings scope smoke: % checks', v_checks;
END
$$;

ROLLBACK;
