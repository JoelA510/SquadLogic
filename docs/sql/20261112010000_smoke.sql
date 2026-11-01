-- Smoke checks for 20261112010000_practice_preference_rules.sql (Phase D, C1)
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined, and
-- `scripts/dbharness/run.sh` turns five of them into (checked) claims, each proven by a plant in
-- `scripts/dbharness/prove.sh`. `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the
-- round trip runs the REAL RPCs as a real admin; the RLS reads run under `SET LOCAL ROLE authenticated`.
--
-- The backfill of the old scalar rows is not here (the migration has already run when a smoke does): the
-- harness builds to the previous migration, plants old-shape rows and applies this one
-- (`run.sh`, "the preference backfill").
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages. Every id is generated and
-- every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The posture, read from the catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_fn text;
    v_checks int;
BEGIN
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.coach_practice_preferences'::regclass) THEN
        RAISE EXCEPTION 'coach_practice_preferences does not have ROW LEVEL SECURITY enabled';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.coach_practice_preferences'::regclass AND polcmd <> 'r') THEN
        RAISE EXCEPTION 'coach_practice_preferences carries a write policy; its only writers are the definer RPCs';
    END IF;
    IF has_table_privilege('authenticated', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'DELETE')
       OR has_table_privilege('service_role', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('anon', 'public.coach_practice_preferences', 'SELECT') THEN
        RAISE EXCEPTION 'a client role holds a write (or anon a read) privilege on coach_practice_preferences';
    END IF;
    SELECT count(*) INTO v_checks FROM pg_constraint
     WHERE conrelid = 'public.coach_practice_preferences'::regclass AND contype = 'c';
    IF v_checks <> 16 THEN
        RAISE EXCEPTION 'expected 16 CHECK constraints on coach_practice_preferences, found %', v_checks;
    END IF;
    FOREACH v_fn IN ARRAY ARRAY[
        'admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)',
        'admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)',
        'admin_remove_practice_preference(uuid)',
        'admin_decide_must_preference(uuid, text)',
        'admin_accept_all_musts(uuid, integer)',
        'finalize_practice_preference_import_job(uuid, jsonb)'
    ] LOOP
        IF NOT (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
                  FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn))
           OR NOT has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE') THEN
            RAISE EXCEPTION '% is not a definer with search_path and UTC pinned, for authenticated and not anon', v_fn;
        END IF;
    END LOOP;
    IF has_function_privilege('authenticated', 'public.practice_preference_set_ok(anyarray)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.practice_preference_minutes_ok(integer[])', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.coach_practice_preferences_enforce_tenancy()', 'EXECUTE') THEN
        RAISE EXCEPTION 'a client role can execute a preference CHECK helper or the tenancy trigger function';
    END IF;
    IF to_regprocedure('public.admin_decide_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.admin_set_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.request_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL THEN
        RAISE EXCEPTION 'an old (scalar) practice preference RPC is still there';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'coach_practice_preferences' AND column_name IN ('dimension', 'value')) THEN
        RAISE EXCEPTION 'coach_practice_preferences still has the scalar dimension or value column';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-staging-import-rows'
                    AND command LIKE '%practice_preferences%' AND command LIKE '%import_type = ''coaches''%') THEN
        RAISE EXCEPTION 'the staged-row retention job does not take practice_preferences rows';
    END IF;
    RAISE NOTICE 'posture: RLS on, no write policy or client write grant, 16 CHECKs, the six RPCs definers with search_path and UTC pinned for authenticated only, the helpers closed to clients, the old scalar RPCs and columns gone, the retention job takes preference rows';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The round trip, as real users
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();   -- an admin of another organization
    v_stranger uuid := gen_random_uuid();   -- signed in, no membership
    v_org uuid;
    v_other_org uuid;
    v_season uuid;
    v_division uuid;
    v_t1 uuid; v_t2 uuid;
    v_c1 uuid; v_c2 uuid;
    v_loc uuid; v_foreign_loc uuid;
    v_job uuid; v_job2 uuid;
    v_r1 uuid; v_r2 uuid; v_rb uuid; v_rb2 uuid;
    v_res jsonb;
    v_refused int := 0;
    v_n int;
    v_bad int := 0;
    v_audited int;
    v_total int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'rules-admin@example.test', '{"password_length": 16}'),
        (v_outsider, 'rules-outsider@example.test', '{"password_length": 16}'),
        (v_stranger, 'rules-stranger@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'rules-admin@example.test'), (v_outsider, 'rules-outsider@example.test'),
        (v_stranger, 'rules-stranger@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Rules', 'smoke-org-rules') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Rules other', 'smoke-org-rules-other') RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_other_org, v_outsider, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Rules Season', 'active')
        RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'Rules U10')
        RETURNING id INTO v_division;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Rules Team 1') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Rules Team 2') RETURNING id INTO v_t2;
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
        VALUES (v_org, v_season, 'Rules Coach 1', 'rules-c1@example.test', 'active') RETURNING id INTO v_c1;
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
        VALUES (v_org, v_season, 'Rules Coach 2', 'rules-c2@example.test', 'active') RETURNING id INTO v_c2;
    INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via) VALUES
        (v_org, v_t1, v_c1, 'lead', current_date - 30, 'smoke'),
        (v_org, v_t2, v_c1, 'lead', current_date - 30, 'smoke'),
        (v_org, v_t2, v_c2, 'assistant', current_date - 30, 'smoke');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Rules Park') RETURNING id INTO v_loc;
    INSERT INTO public.locations (organization_id, name) VALUES (v_other_org, 'Elsewhere Rules Park') RETURNING id INTO v_foreign_loc;
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, season_settings_id)
        VALUES (v_org, 'registration', 'imports/smoke/rules.csv', 'importing', v_season) RETURNING id INTO v_job;
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, season_settings_id)
        VALUES (v_org, 'registration', 'imports/smoke/rules2.csv', 'importing', v_season) RETURNING id INTO v_job2;

    -- ---- (a) the admin writes; a non-member and another organization's admin are refused each RPC ----
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_res := public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY['TUE', 'THU']);
    v_r1 := (v_res ->> 'id')::uuid;
    v_res := public.admin_add_practice_preference(v_c1, v_t2, 'prefer', NULL, ARRAY[1020, 1080], ARRAY[v_loc]);
    v_r2 := (v_res ->> 'id')::uuid;
    -- A requested must, as an import writes one (inserted as the owner here; section 5 imports one).
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source, import_job_id)
        VALUES (v_org, v_c1, v_t1, ARRAY['WED'], 'prefer', 'must', 'pending', 'in_force', 'import', v_job)
        RETURNING id INTO v_rb;
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source, import_job_id)
        VALUES (v_org, v_c2, v_t2, ARRAY['FRI'], 'prefer', 'must', 'pending', 'in_force', 'import', v_job);
    FOR v_n IN 1..2 LOOP
        PERFORM set_config('request.jwt.claim.sub', (ARRAY[v_stranger, v_outsider])[v_n]::text, true);
        BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY['MON']);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
        BEGIN PERFORM public.admin_edit_practice_preference(v_r1, 'prefer', ARRAY['MON']);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
        BEGIN PERFORM public.admin_remove_practice_preference(v_r1);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
        BEGIN PERFORM public.admin_decide_must_preference(v_rb, 'accept');
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
        BEGIN PERFORM public.admin_accept_all_musts(v_job, 2);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
        BEGIN PERFORM public.finalize_practice_preference_import_job(v_job2);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    END LOOP;
    IF v_refused <> 12 THEN
        RAISE EXCEPTION '(a) only % of 12 refusals (6 RPCs x a non-member and another organization''s admin)', v_refused;
    END IF;
    IF (SELECT status FROM public.coach_practice_preferences WHERE id = v_r1) <> 'in_force'
       OR (SELECT must_decision FROM public.coach_practice_preferences WHERE id = v_rb) <> 'pending' THEN
        RAISE EXCEPTION '(a) a refused RPC changed a row';
    END IF;
    RAISE NOTICE 'as a user: an admin writes rules; a signed-in non-member and another organization''s admin are refused each of the 6 RPCs (42501), 12 of 12, and no row changed';

    -- ---- (b) a must is a rule an admin accepted -----------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    BEGIN
        -- Asked for and pending, yet in force as a must: only the "a must is a rule an admin accepted" CHECK refuses it.
        INSERT INTO public.coach_practice_preferences
            (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision)
            VALUES (v_org, v_c1, v_t1, ARRAY['MON'], 'must', 'must', 'pending');
        RAISE EXCEPTION '(b) a must nobody accepted was stored';
    EXCEPTION WHEN check_violation THEN
        IF SQLERRM NOT LIKE '%coach_practice_preferences_must_only_when_accepted%' THEN RAISE; END IF;
    END;
    BEGIN PERFORM public.admin_accept_all_musts(v_job, 3);
        RAISE EXCEPTION '(b) Accept all accepted with a count that was not the confirmation''s';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF SQLERRM NOT LIKE '%has 2 pending must(s), not the 3 the confirmation showed; nothing was accepted' THEN RAISE; END IF;
    END;
    IF (SELECT count(*) FROM public.coach_practice_preferences WHERE import_job_id = v_job AND must_decision = 'pending') <> 2 THEN
        RAISE EXCEPTION '(b) a refused Accept all accepted something';
    END IF;
    v_res := public.admin_accept_all_musts(v_job, 2);
    IF (v_res ->> 'accepted')::int <> 2
       OR (SELECT count(*) FROM public.coach_practice_preferences
            WHERE import_job_id = v_job AND level = 'must' AND must_decision = 'accepted') <> 2 THEN
        RAISE EXCEPTION '(b) Accept all did not accept exactly the file''s pending musts: %', v_res;
    END IF;
    RAISE NOTICE 'musts: a must nobody accepted is refused by the table (23514); Accept all refused a count that was not the confirmation''s (22023, nothing accepted) and, with the right count, accepted exactly the file''s 2 pending musts';

    -- ---- (c) malformed rules are refused; the boundaries are accepted ---------
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY[]::text[]);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY['TUE', 'TUE']);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY['TUESDAY']);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', NULL, ARRAY[1440]);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', NULL, ARRAY[-1]);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', NULL, NULL, ARRAY[v_foreign_loc]);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY['TUE'], NULL, NULL, true);
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.admin_add_practice_preference(v_c2, v_t1, 'prefer', ARRAY['TUE']);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_bad := v_bad + 1; END;
    IF v_bad <> 9 THEN
        RAISE EXCEPTION '(c) only % of 9 malformed rules were refused', v_bad;
    END IF;
    PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', NULL, ARRAY[0, 1439]);
    PERFORM public.admin_add_practice_preference(v_c1, v_t1, 'prefer', NULL, NULL, NULL, false, false, true);
    RAISE NOTICE 'rules: 9 of 9 malformed writes refused (an empty set, a duplicate, a weekday outside SUN..SAT, minutes 1440 and -1, another organization''s venue, no condition, values with keep-current, a coach who does not coach the team); minutes 0 and 1439 and keep-current accepted';

    -- ---- (d) every write is audited ---------------------------------------------
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source, import_job_id)
        VALUES (v_org, v_c1, v_t2, ARRAY['SAT'], 'prefer', 'must', 'pending', 'in_force', 'import', v_job2)
        RETURNING id INTO v_rb2;
    PERFORM public.admin_edit_practice_preference(v_r1, 'prefer', ARRAY['TUE']);
    PERFORM public.admin_decide_must_preference(v_rb2, 'keep_prefer');
    PERFORM public.admin_remove_practice_preference(v_r2);
    SELECT count(*) INTO v_audited FROM public.audit_log
     WHERE organization_id = v_org AND action LIKE 'practice_preference.%';
    BEGIN PERFORM public.admin_decide_must_preference(v_rb2, 'accept');
        RAISE EXCEPTION '(d) a decided must was decided again';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    SELECT count(*) INTO v_total FROM public.audit_log
     WHERE organization_id = v_org AND action LIKE 'practice_preference.%';
    IF v_total <> v_audited THEN RAISE EXCEPTION '(d) a refused write left an audit row'; END IF;
    -- 4 adds (2 rules and 2 boundary rules), 1 Accept all, 1 edit, 1 decision, 1 removal.
    IF v_audited <> 8 THEN
        RAISE EXCEPTION '(d) expected 8 audit rows, found %', v_audited;
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_log a
                WHERE a.organization_id = v_org AND a.action LIKE 'practice_preference.%'
                  AND a.action <> 'practice_preference.musts_accepted'
                  AND NOT EXISTS (SELECT 1 FROM public.coach_practice_preferences p WHERE p.id = a.resource_id)) THEN
        RAISE EXCEPTION '(d) an audit row names no rule';
    END IF;
    RAISE NOTICE 'every rule write audited -- 8 of 8 (4 added, 1 Accept all, 1 edited, 1 decided, 1 removed), each naming its row; a refused write left none';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The preference import
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_season uuid;
    v_completed uuid;
    v_division uuid;
    v_t1 uuid; v_t2 uuid; v_solo uuid;
    v_c1 uuid; v_c2 uuid;
    v_job uuid; v_job2 uuid; v_job3 uuid;
    v_res jsonb;
    v_admin_rule uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_admin, 'imp-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'imp-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Rules Import', 'smoke-org-rules-import') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Import Season', 'active') RETURNING id INTO v_season;
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Import Old Season', 'completed') RETURNING id INTO v_completed;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'Import U10') RETURNING id INTO v_division;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Import T1') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Import T2') RETURNING id INTO v_t2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Import Solo') RETURNING id INTO v_solo;
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
        VALUES (v_org, v_season, 'Import Coach 1', 'imp-c1@example.test', 'active') RETURNING id INTO v_c1;
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
        VALUES (v_org, v_season, 'Import Coach 2', 'imp-c2@example.test', 'active') RETURNING id INTO v_c2;
    INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via) VALUES
        (v_org, v_t1, v_c1, 'lead', current_date - 30, 'smoke'),
        (v_org, v_t2, v_c1, 'lead', current_date - 30, 'smoke'),
        (v_org, v_solo, v_c2, 'lead', current_date - 30, 'smoke');
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, season_settings_id)
        VALUES (v_org, 'registration', 'imports/smoke/p1.csv', 'importing', v_season) RETURNING id INTO v_job;
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, season_settings_id)
        VALUES (v_org, 'registration', 'imports/smoke/p2.csv', 'importing', v_season) RETURNING id INTO v_job2;
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, season_settings_id)
        VALUES (v_org, 'registration', 'imports/smoke/p3.csv', 'importing', v_completed) RETURNING id INTO v_job3;
    INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job, 'practice_preferences', 1, '{}', '{"email":"imp-c1@example.test","request_level":"must","weekdays":"Tue, Thu"}'),
        (v_org, v_job, 'practice_preferences', 2, '{}', '{"email":"nobody@example.test","weekdays":"Mon"}'),
        (v_org, v_job, 'practice_preferences', 3, '{}', '{"email":"imp-c2@example.test","team_name":"No Such Team","weekdays":"Mon"}'),
        (v_org, v_job, 'practice_preferences', 4, '{}', '{"email":"imp-c2@example.test","start_times":"5:00 PM"}'),
        (v_org, v_job2, 'practice_preferences', 1, '{}', '{"email":"imp-c1@example.test","team_name":"Import T1","weekdays":"Wed"}'),
        (v_org, v_job3, 'practice_preferences', 1, '{}', '{"email":"imp-c1@example.test","weekdays":"Mon"}');

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_admin_rule := (public.admin_add_practice_preference(v_c1, v_t1, 'prefer', ARRAY['FRI']) ->> 'id')::uuid;
    v_res := public.finalize_practice_preference_import_job(v_job);
    IF (SELECT count(*) FROM public.coach_practice_preferences WHERE import_job_id = v_job AND coach_id = v_c1) <> 2
       OR (SELECT count(DISTINCT team_id) FROM public.coach_practice_preferences WHERE import_job_id = v_job AND coach_id = v_c1) <> 2
       OR (v_res ->> 'inserted_rules')::int <> 3 OR (v_res ->> 'pending_musts')::int <> 2
       OR (v_res ->> 'unknown_coach_rows')::int <> 1 OR (v_res ->> 'unknown_team_rows')::int <> 1
       OR v_res -> 'unknown_coaches' -> 0 ->> 'email' <> 'nobody@example.test' THEN
        RAISE EXCEPTION 'the import did not write one rule per team, list the unknown coach and team, or count the pending musts: %', v_res;
    END IF;
    IF (SELECT count(*) FROM public.coaches WHERE organization_id = v_org) <> 2
       OR (SELECT count(*) FROM public.teams WHERE organization_id = v_org) <> 3
       OR (SELECT warning_summary::text FROM public.import_jobs WHERE id = v_job) LIKE '%nobody@example.test%' THEN
        RAISE EXCEPTION 'the import created a coach or team, or stored an unknown coach''s email on the job';
    END IF;
    RAISE NOTICE 'preference import: a blank team for a two-team coach made 2 rules; the unknown coach and the unknown team were listed (and the email is not on the job), nothing was created; 2 musts are pending';

    v_res := public.finalize_practice_preference_import_job(v_job2);
    IF (v_res ->> 'replaced_rules')::int <> 1
       OR (SELECT status FROM public.coach_practice_preferences WHERE id = v_admin_rule) <> 'in_force'
       OR (SELECT count(*) FROM public.coach_practice_preferences
            WHERE import_job_id = v_job AND status = 'in_force' AND team_id = v_t2) <> 1
       OR (SELECT count(*) FROM public.coach_practice_preferences
            WHERE import_job_id = v_job AND status = 'replaced' AND team_id = v_t1) <> 1 THEN
        RAISE EXCEPTION 'a re-import did not replace only the imported rules of the team it names: %', v_res;
    END IF;
    RAISE NOTICE 're-import: replaced the imported rule of the one team it named (1), left the admin rule and the imported rule of the team it did not name';

    BEGIN PERFORM public.finalize_practice_preference_import_job(v_job3);
        RAISE EXCEPTION 'a preference file was imported into a completed season';
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF SQLERRM NOT LIKE 'Season % is completed and takes no import' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'season: a preference import into a completed season was refused (22023 season_completed)';
END;
$$;

ROLLBACK;
