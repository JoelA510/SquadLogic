-- Smoke for 20261018030000_rls_advisor_rewrite.sql
--
-- Runs on the harness's head build, where the migration has already applied,
-- inside one transaction that is ROLLED BACK.
--
-- 1. What the two advisor lints test, on the catalogue: no policy in `public`
--    calls auth.uid() (or auth.jwt(), auth.role(), auth.email(),
--    current_setting()) outside `(select ...)`, and no table, role and
--    command in `public` has more than
--    one permissive policy. The migration's own closing block checks the same
--    before it commits; this repeats it on every later build, so a later
--    migration that brings either back fails here, by name.
-- 2. The 26 tables carry exactly the policies the rewrite leaves: 85 (48
--    before it), plus the 3 that 20261019010000 added when it split
--    registrations' FOR ALL policy into a SELECT and three admin writes: 88.
--    And on each of the 19 split tables an INSERT, an UPDATE and a DELETE
--    admin policy and no FOR ALL one. Counted on the 26 tables, not on
--    all of `public` (119), so a migration on another table does not move it.
--    Since 20261022020000 dropped `registration_forms` and `registrations`
--    (with their 4 + 4 policies), it is 24 tables, 80 policies and 18 split
--    tables, and both dropped tables are checked to be gone. Since
--    20261024010000 dropped `profile_players` (and its one policy) with the
--    guardian view, it is 23 tables and 79 policies, and that table is checked
--    to be gone too.
-- 3. A member and an admin of one organization, on `players` (a split
--    admin table): the member reads no row (since 20261021020000 a non-admin
--    reads a player only through the roster read; until 20261024010000 a
--    guardian read their own child), and its
--    INSERT is refused by RLS and its UPDATE and DELETE reach no row; the admin
--    reads, inserts, updates and deletes. And on `season_settings`, the
--    narrower one (plan Q5): a tenant_admin reads but writes nothing, while an
--    admin updates. Each write is undone by raising inside its own block.
--
-- The full behaviour, seven personas on all 26 tables, is the pgTAP suite's
-- supabase/tests/rls_policy_matrix.sql, which needs Supabase's own auth and
-- grants; this smoke is the harness's share of it.

BEGIN;

-- The two advisor checks, as functions so the controls below exercise the
-- code the checks run (temporary: they go with the session).
--
-- Per-row auth calls: a call that opens its own SELECT is the InitPlan form
-- (`( SELECT auth.uid() AS uid)`, `( SELECT (auth.jwt() ->> 'role'::text))`)
-- and is removed; any call left is evaluated per row. Returns the expression
-- with the wrapped calls removed if a direct call is left, else NULL.
CREATE FUNCTION pg_temp.smoke_per_row_calls(expr text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
    SELECT s FROM (
        SELECT regexp_replace(expr, 'SELECT \(*(auth\.(uid|jwt|role|email)\(\)|current_setting\()', 'SELECT ', 'g') AS s
    ) x WHERE s ~ '(auth\.(uid|jwt|role|email)\(\)|current_setting\()'
$f$;

-- More than one permissive policy for one public table, role and command:
-- FOR ALL counts for every command, a PUBLIC policy for every role RLS
-- applies to, less the Supabase admin roles, which the advisor leaves out.
CREATE FUNCTION pg_temp.smoke_duplicate_policies() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(format('%s %s %s (%s)', tbl, rol, act, n), ', ' ORDER BY tbl, rol, act)
      FROM (
        SELECT c.relname AS tbl, r.rolname AS rol, a.act, count(*) AS n
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
          JOIN pg_roles r ON (p.polroles = ARRAY[0::oid] OR r.oid = ANY (p.polroles))
                         AND NOT r.rolsuper AND NOT r.rolbypassrls
                         AND r.rolname !~ '^pg_' AND r.rolname !~ '^supabase.*admin$'
          CROSS JOIN (VALUES ('r', 'SELECT'), ('a', 'INSERT'), ('w', 'UPDATE'), ('d', 'DELETE')) AS a(cmd, act)
         WHERE ns.nspname = 'public' AND p.polpermissive AND p.polcmd IN (a.cmd, '*')
         GROUP BY 1, 2, 3
        HAVING count(*) > 1
      ) dup
$f$;

DO $smoke$
DECLARE
    -- Stated, not read back from the catalogue.
    c_tables text[] := ARRAY[
        'audit_log', 'email_log', 'evaluation_findings', 'evaluation_metrics', 'evaluation_run_events',
        'evaluation_runs', 'export_jobs', 'game_slots', 'games', 'import_jobs', 'organization_members',
        'organization_schema_history', 'organizations', 'player_buddies', 'players',
        'practice_assignments', 'practice_exceptions', 'profiles',
        'scheduler_runs', 'season_settings',
        'staging_players', 'team_players', 'telemetry_log'
    ];
    -- table, its split-policy name prefix (insert/update/delete follow), suffix
    c_split text[][] := ARRAY[
        ['email_log', 'email_log_', '_admin'],
        ['evaluation_findings', 'evaluation_findings_', '_admin'],
        ['evaluation_metrics', 'evaluation_metrics_', '_admin'],
        ['evaluation_run_events', 'evaluation_run_events_', '_admin'],
        ['evaluation_runs', 'evaluation_runs_', '_admin'],
        ['export_jobs', 'export_jobs_', '_admin'],
        ['game_slots', 'game_slots_', '_admin'],
        ['games', 'games_', '_admin'],
        ['player_buddies', 'player_buddies_', '_admin'],
        ['players', 'players_', '_admin'],
        ['practice_assignments', 'practice_assignments_', '_admin'],
        ['scheduler_runs', 'scheduler_runs_', '_admin'],
        ['staging_players', 'staging_players_', '_admin'],
        ['team_players', 'team_players_', '_admin'],
        ['practice_exceptions', 'Practice exceptions: admins ', ''],
        ['organization_members', 'Org Members: admins ', ''],
        ['organizations', 'Organizations: admins ', ''],
        ['season_settings', 'Season Settings: admins ', '']
    ];
    v_member uuid := 'a0a0a0a0-0000-4000-8000-000000001018';
    v_admin uuid := 'a0a0a0a0-0000-4000-8000-000000001019';
    v_tenant uuid := 'a0a0a0a0-0000-4000-8000-000000001020';
    v_org uuid;
    v_player uuid;
    v_season uuid;
    v_bad text;
    v_n int;
    v_rows int;
    v_err text;
    i int;
    c text;
BEGIN
    -- ---- 1. what the advisors check -----------------------------------------
    -- Each check is one function, called by its control and by the check, so
    -- the control proves the code that runs (both defined above the DO block).
    v_bad := pg_temp.smoke_per_row_calls(
        '(( SELECT auth.uid() AS uid) = id) OR (( SELECT (auth.jwt() ->> ''role''::text)) = ''x''::text)');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'control: the per-row call check flagged wrapped calls: %', v_bad;
    END IF;
    FOREACH c IN ARRAY ARRAY[
        '(( SELECT auth.uid() AS uid) = id) OR (auth.uid() = owner)',
        '(EXISTS ( SELECT 1 FROM organization_members om WHERE (om.profile_id = auth.uid())))',
        '(((current_setting(''request.jwt.claims''::text, true))::jsonb ->> ''sub''::text) = ''x''::text)'
    ] LOOP
        IF pg_temp.smoke_per_row_calls(c) IS NULL THEN
            RAISE EXCEPTION 'control: the per-row call check did not see the direct call in %', c;
        END IF;
    END LOOP;
    SELECT string_agg(format('%s: "%s"', tablename, policyname), ', ' ORDER BY tablename, policyname)
      INTO v_bad
      FROM pg_policies
     WHERE schemaname = 'public'
       AND pg_temp.smoke_per_row_calls(coalesce(qual, '') || ' ' || coalesce(with_check, '')) IS NOT NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'auth_rls_initplan: policies call an auth function per row: %', v_bad;
    END IF;

    -- The duplicate check must see a planted second permissive SELECT policy
    -- on players (planted and undone inside a block).
    v_bad := NULL;
    BEGIN
        CREATE POLICY "__smoke duplicate select" ON public.players FOR SELECT TO authenticated
            USING (public.is_org_member(organization_id));
        v_bad := pg_temp.smoke_duplicate_policies();
        RAISE EXCEPTION USING ERRCODE = 'P1018', MESSAGE = 'undo the planted duplicate';
    EXCEPTION WHEN SQLSTATE 'P1018' THEN NULL;
    END;
    IF v_bad IS NULL OR ', ' || v_bad || ', ' NOT LIKE '%, players authenticated SELECT (2), %' THEN
        RAISE EXCEPTION 'control: the duplicate-policy check did not see a planted second SELECT policy on players (found: %)', coalesce(v_bad, 'nothing');
    END IF;
    v_bad := pg_temp.smoke_duplicate_policies();
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'multiple_permissive_policies: more than one permissive policy for: %', v_bad;
    END IF;
    RAISE NOTICE 'advisors on the catalogue: no public policy calls an auth function per row, and no public table, role and command has two permissive policies (each check shown to fire on a planted case)';

    -- ---- 2. the policies the rewrite leaves ---------------------------------
    SELECT count(*) INTO v_n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY (c_tables);
    IF v_n <> 23 THEN
        RAISE EXCEPTION 'expected the 23 tables of the advisor findings still standing, found %', v_n;
    END IF;
    IF to_regclass('public.registration_forms') IS NOT NULL OR to_regclass('public.registrations') IS NOT NULL THEN
        RAISE EXCEPTION 'registration_forms or registrations is back; 20261022020000 dropped both';
    END IF;
    IF to_regclass('public.profile_players') IS NOT NULL THEN
        RAISE EXCEPTION 'profile_players is back; 20261024010000 dropped it';
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (c_tables);
    IF v_n <> 79 THEN
        RAISE EXCEPTION 'the 23 tables carry % policies; the rewrite leaves 85, 20261019010000 adds 3, 20261022020000 drops 8 with two tables and 20261024010000 1 with one: 79', v_n;
    END IF;
    v_bad := NULL;
    FOR i IN 1 .. array_length(c_split, 1) LOOP
        FOREACH c IN ARRAY ARRAY['insert', 'update', 'delete'] LOOP
            IF NOT EXISTS (SELECT 1 FROM pg_policies
                            WHERE schemaname = 'public' AND tablename = c_split[i][1]
                              AND policyname = c_split[i][2] || c || c_split[i][3]
                              AND cmd = upper(c) AND roles = ARRAY['authenticated']::name[]) THEN
                v_bad := concat_ws(', ', v_bad, format('%s: "%s"', c_split[i][1], c_split[i][2] || c || c_split[i][3]));
            END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = c_split[i][1] AND cmd = 'ALL') THEN
            v_bad := concat_ws(', ', v_bad, format('%s still has a FOR ALL policy', c_split[i][1]));
        END IF;
    END LOOP;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'the admin policies are not split by command: %', v_bad;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_jobs'
                AND policyname = 'Users can view their organization''s import jobs') THEN
        RAISE EXCEPTION 'the legacy import_jobs SELECT survived the rewrite';
    END IF;
    RAISE NOTICE 'the 23 tables carry 79 policies (85 from the rewrite, 3 from 20261019010000, less the 8 of the two tables 20261022020000 dropped and the 1 of the table 20261024010000 dropped): on each of the 18 split tables an admin INSERT, UPDATE and DELETE policy and no FOR ALL';

    -- ---- seed: one organization, a member, an admin and a tenant_admin ------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_member, 'rls-rewrite-coach@example.test', jsonb_build_object('password_length', 16)),
        (v_admin, 'rls-rewrite-admin@example.test', jsonb_build_object('password_length', 16)),
        (v_tenant, 'rls-rewrite-tenant@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES
        (v_member, 'rls-rewrite-coach@example.test'),
        (v_admin, 'rls-rewrite-admin@example.test'),
        (v_tenant, 'rls-rewrite-tenant@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('RLS Rewrite Org', 'rls-rewrite-org') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_member, 'coach'), (v_org, v_admin, 'admin'), (v_org, v_tenant, 'tenant_admin');
    INSERT INTO public.players (organization_id, first_name, last_name)
        VALUES (v_org, 'Rewrite', 'Smoke') RETURNING id INTO v_player;
    INSERT INTO public.season_settings (organization_id, name)
        VALUES (v_org, 'Rewrite Season') RETURNING id INTO v_season;

    -- ---- 3a. players, as the member -----------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_member, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.players WHERE id = v_player;
    UPDATE public.players SET last_name = 'Renamed' WHERE id = v_player;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 0 OR v_rows <> 0 THEN
        RAISE EXCEPTION 'players as a member: read % (want 0), updated % (want 0)', v_n, v_rows;
    END IF;
    SET LOCAL ROLE authenticated;
    DELETE FROM public.players WHERE id = v_player;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'players as a member: deleted % (want 0)', v_rows;
    END IF;
    v_err := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        INSERT INTO public.players (organization_id, first_name, last_name) VALUES (v_org, 'Member', 'Insert');
    EXCEPTION WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_err IS NULL OR v_err NOT LIKE 'new row violates row-level security policy%' THEN
        RAISE EXCEPTION 'players as a member: the insert was not refused by RLS (error: %)', COALESCE(v_err, 'none -- it succeeded');
    END IF;

    -- ---- 3b. players, as the admin ------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_n := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        SELECT count(*) INTO v_n FROM public.players WHERE id = v_player;
        INSERT INTO public.players (organization_id, first_name, last_name) VALUES (v_org, 'Admin', 'Insert');
        UPDATE public.players SET last_name = 'Renamed' WHERE id = v_player;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_n <> 1 OR v_rows <> 1 THEN
            RAISE EXCEPTION 'players as an admin: read % (want 1), updated % (want 1)', v_n, v_rows;
        END IF;
        DELETE FROM public.players WHERE id = v_player;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
            RAISE EXCEPTION 'players as an admin: deleted % (want 1)', v_rows;
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'P1018', MESSAGE = 'undo admin writes';
    EXCEPTION WHEN SQLSTATE 'P1018' THEN NULL;
    END;
    RESET ROLE;
    IF v_n IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'players as an admin: the probe did not run (read %)', v_n;
    END IF;

    -- ---- 3c. season_settings: a tenant_admin reads, writes nothing (Q5) -----
    PERFORM set_config('request.jwt.claim.sub', v_tenant::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_tenant, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.season_settings WHERE id = v_season;
    UPDATE public.season_settings SET name = 'Tenant Renamed' WHERE id = v_season;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 1 OR v_rows <> 0 THEN
        RAISE EXCEPTION 'season_settings as a tenant_admin: read % (want 1), updated % (want 0)', v_n, v_rows;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_rows := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        UPDATE public.season_settings SET name = 'Admin Renamed' WHERE id = v_season;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        RAISE EXCEPTION USING ERRCODE = 'P1018', MESSAGE = 'undo admin update';
    EXCEPTION WHEN SQLSTATE 'P1018' THEN NULL;
    END;
    RESET ROLE;
    IF v_rows IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'season_settings as an admin: updated % (want 1)', v_rows;
    END IF;

    RAISE NOTICE 'players: a member reads nothing and cannot insert, update or delete; an admin reads, inserts, updates and deletes';
    RAISE NOTICE 'season_settings: a tenant_admin reads and updates nothing; an admin updates (role = ''admin'', kept)';
END;
$smoke$;

ROLLBACK;
